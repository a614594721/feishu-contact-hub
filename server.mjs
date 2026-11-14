import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import * as lark from "@larksuiteoapi/node-sdk";

const host = process.env.HOST;
const port = Number(process.env.PORT);

if (!host) {
  throw new Error("HOST is required");
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

// SECTION: database client (lazy, dual-mode broker/legacy)

const BROKER_URL = "http://127.0.0.1:9001";
const BROKER_PLACEHOLDER_KEY = "qwenwork-runtime-broker";

const SAFE_DATABASE_OPERATIONS = new Set([
  "get_config",
  "save_config",
  "upsert_departments",
  "upsert_users",
  "insert_event",
  "list_departments",
  "list_users",
  "list_events",
  "count_stats",
]);

class DatabaseUnavailableError extends Error {
  constructor() {
    super("Database service is unavailable");
    this.code = "DATABASE_UNAVAILABLE";
  }
}

class DatabaseOperationError extends Error {
  constructor(rawError, operation) {
    super("Database operation failed");
    this.code = "DATABASE_OPERATION_FAILED";
    this.diagnostic = Object.freeze(buildSafeDatabaseDiagnostic(rawError, operation));
  }
}

const SAFE_DATABASE_CODE = /^[A-Z0-9_]{1,32}$/;

function safeDatabaseCode(value) {
  if (typeof value !== "string") return "UNKNOWN";
  const code = value.toUpperCase();
  return SAFE_DATABASE_CODE.test(code) ? code : "UNKNOWN";
}

function safeHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

function classifyDatabaseError(code, status, errorName) {
  if (status === 401) return "authentication_failed";
  if (status === 403 || code === "42501") return "permission_denied";
  if (code === "42P01" || code === "42703" || code === "PGRST205") return "schema_mismatch";
  if (status === 409 || code === "23503" || code === "23505") return "conflict";
  if (status === 429) return "rate_limited";
  if (code === "57014" || errorName === "AbortError") return "timeout";
  if (status >= 500 || errorName === "TypeError") return "upstream_unavailable";
  return "operation_failed";
}

function buildSafeDatabaseDiagnostic(rawError, operation) {
  const code = safeDatabaseCode(rawError?.code);
  const status = safeHttpStatus(rawError?.status);
  const diagnostic = {
    category: classifyDatabaseError(code, status, rawError?.name),
    code,
    operation: SAFE_DATABASE_OPERATIONS.has(operation) ? operation : "unknown",
  };
  if (status !== undefined) diagnostic.status = status;
  return diagnostic;
}

// SECTION: local file store (fallback when the platform database is unreachable)
//
// 原始实现假设运行在 QW Pages 平台内，数据库请求经 127.0.0.1:9001 的 Broker 转发到
// 平台 Supabase。脱离该平台（自托管 / 独立部署）时 Broker 不存在，所有业务接口都会
// 失败。这里提供一个纯 Node 的本地文件实现：对外暴露与 supabase-js 相同的链式查询
// 接口（from().select()/insert()/upsert()/eq()/or()/contains()/order()/limit()），
// 数据持久化到 <app>/data/app-data.json。检测到真实数据库时仍走原逻辑。

const LOCAL_STORE_DIR = fileURLToPath(new URL("./data/", import.meta.url));
const LOCAL_STORE_FILE = resolve(LOCAL_STORE_DIR, "app-data.json");
const LOCAL_TABLES = new Set(["app_config", "feishu_departments", "feishu_users", "feishu_events"]);

function createEmptyStore() {
  return {
    seq: 1,
    tables: { app_config: [], feishu_departments: [], feishu_users: [], feishu_events: [] },
  };
}

let localStore = null;

function getLocalStore() {
  if (localStore) return localStore;
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_STORE_FILE, "utf8"));
    localStore = parsed && parsed.tables ? parsed : createEmptyStore();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`local store read failed: ${error?.code ?? "unknown"}`);
    }
    localStore = createEmptyStore();
  }
  for (const table of LOCAL_TABLES) {
    if (!Array.isArray(localStore.tables[table])) localStore.tables[table] = [];
  }
  if (!Number.isInteger(localStore.seq)) localStore.seq = 1;
  return localStore;
}

function persistLocalStore() {
  const store = getLocalStore();
  mkdirSync(LOCAL_STORE_DIR, { recursive: true });
  const tempFile = `${LOCAL_STORE_FILE}.tmp`;
  writeFileSync(tempFile, JSON.stringify(store), "utf8");
  renameSync(tempFile, LOCAL_STORE_FILE);
}

function localTable(name) {
  const store = getLocalStore();
  return store.tables[name];
}

function cloneRow(row) {
  return JSON.parse(JSON.stringify(row));
}

function likeToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function compareValues(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""), "zh-Hans-CN");
}

function matchesCondition(row, condition) {
  const value = row[condition.column];
  if (condition.type === "eq") return String(value ?? "") === String(condition.value ?? "");
  if (condition.type === "ilike") {
    return typeof value === "string" && likeToRegExp(condition.value).test(value);
  }
  if (condition.type === "contains") {
    const targets = Array.isArray(condition.value) ? condition.value : [condition.value];
    const haystack = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
    return targets.every((target) => haystack.includes(String(target)));
  }
  if (condition.type === "or") {
    return condition.group.some((nested) => matchesCondition(row, nested));
  }
  return true;
}

class LocalQuery {
  constructor(tableName) {
    this.tableName = tableName;
    this.mode = "select";
    this.conditions = [];
    this.orderBy = [];
    this.limitValue = null;
    this.countOnly = false;
    this.rows = null;
    this.conflictKey = null;
  }

  select(_columns, options) {
    this.mode = "select";
    if (options && options.count === "exact") this.countOnly = true;
    return this;
  }

  insert(rows) {
    this.mode = "insert";
    this.rows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  upsert(rows, options) {
    this.mode = "upsert";
    this.rows = Array.isArray(rows) ? rows : [rows];
    this.conflictKey = options?.onConflict ?? "id";
    return this;
  }

  eq(column, value) {
    this.conditions.push({ type: "eq", column, value });
    return this;
  }

  contains(column, value) {
    this.conditions.push({ type: "contains", column, value });
    return this;
  }

  // 支持 "name.ilike.%x%,email.ilike.%y%" 这类 PostgREST 或表达式
  // 注意：or 内部的字段之间是「或」关系，不能混进 conditions 的「与」序列
  or(expression) {
    const parts = String(expression).split(/,(?=[A-Za-z_][A-Za-z0-9_]*\.(?:ilike|eq)\.)/);
    const group = [];
    for (const part of parts) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\.(ilike|eq)\.([\s\S]*)$/.exec(part.trim());
      if (!match) continue;
      group.push({
        type: match[2] === "ilike" ? "ilike" : "eq",
        column: match[1],
        value: match[3],
      });
    }
    if (group.length > 0) this.conditions.push({ type: "or", group });
    return this;
  }

  order(column, options) {
    this.orderBy.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  writeRows() {
    const table = localTable(this.tableName);
    const store = getLocalStore();
    const written = [];
    for (const raw of this.rows ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const row = { ...raw };
      if (this.conflictKey && row[this.conflictKey] != null) {
        const index = table.findIndex(
          (item) => String(item[this.conflictKey]) === String(row[this.conflictKey]),
        );
        if (index >= 0) {
          if (this.mode !== "upsert") continue;
          table[index] = { ...table[index], ...row };
          written.push(table[index]);
          continue;
        }
      }
      row.id = store.seq++;
      if (this.tableName === "feishu_events" && !row.received_at) {
        row.received_at = new Date().toISOString();
      }
      table.push(row);
      written.push(row);
    }
    persistLocalStore();
    return { data: written.map(cloneRow), error: null };
  }

  execute() {
    if (this.mode === "insert" || this.mode === "upsert") return this.writeRows();

    const table = localTable(this.tableName);
    let rows = table.filter((row) => this.conditions.every((c) => matchesCondition(row, c)));

    // 多字段排序：从最后一个排序键开始做稳定排序
    for (let index = this.orderBy.length - 1; index >= 0; index -= 1) {
      const { column, ascending } = this.orderBy[index];
      rows = [...rows].sort((left, right) => {
        const result = compareValues(left[column], right[column]);
        return ascending ? result : -result;
      });
    }

    if (this.countOnly) return { count: rows.length, error: null };
    if (this.limitValue != null) rows = rows.slice(0, this.limitValue);
    return { data: rows.map(cloneRow), error: null };
  }

  // 让 LocalQuery 可以直接被 await
  then(onFulfilled, onRejected) {
    try {
      return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
    } catch (error) {
      return Promise.reject(error).then(onFulfilled, onRejected);
    }
  }
}

const localClient = { from: (tableName) => new LocalQuery(tableName) };

function canReachBroker(timeoutMs = 500) {
  return new Promise((resolveValue) => {
    const socket = connect({ host: "127.0.0.1", port: 9001 });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveValue(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

// broker: 平台内置数据库代理；legacy: 外部 Supabase 三件套；local: 本地文件存储
let databaseMode = "local";

async function detectDatabaseMode() {
  const legacyValues = [
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    process.env.SUPABASE_INSTANCE_ID,
  ].filter(Boolean).length;
  if (legacyValues === 3) return "legacy";
  if (await canReachBroker()) return "broker";
  return "local";
}

let supabaseClient;

function getSupabaseClient() {
  if (databaseMode === "local") return localClient;
  if (supabaseClient) return supabaseClient;

  const legacy = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_ANON_KEY,
    instanceId: process.env.SUPABASE_INSTANCE_ID,
  };
  const legacyValueCount = Object.values(legacy).filter(Boolean).length;
  if (legacyValueCount !== 0 && legacyValueCount !== 3) {
    throw new DatabaseUnavailableError();
  }

  const useLegacyExternalView = legacyValueCount === 3;
  const url = useLegacyExternalView ? legacy.url : BROKER_URL;
  const key = useLegacyExternalView ? legacy.key : BROKER_PLACEHOLDER_KEY;
  const headers = useLegacyExternalView ? { "X-Instance-ID": legacy.instanceId } : {};

  supabaseClient = createClient(url, key, {
    global: { headers },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseClient;
}

async function runDatabaseOperation(operation, execute) {
  try {
    const { data, error } = await execute();
    if (error) throw new DatabaseOperationError(error, operation);
    return data;
  } catch (error) {
    if (error instanceof DatabaseOperationError) throw error;
    throw new DatabaseOperationError(error, operation);
  }
}

async function runDatabaseCount(operation, execute) {
  try {
    const { count, error } = await execute();
    if (error) throw new DatabaseOperationError(error, operation);
    return count ?? 0;
  } catch (error) {
    if (error instanceof DatabaseOperationError) throw error;
    throw new DatabaseOperationError(error, operation);
  }
}

// SECTION: app config helpers

const CONFIG_KEYS = ["app_id", "app_secret", "encrypt_key", "verification_token"];

async function loadConfig() {
  const rows = await runDatabaseOperation("get_config", () =>
    getSupabaseClient().from("app_config").select("key, value"),
  );
  const config = {};
  for (const key of CONFIG_KEYS) config[key] = "";
  for (const row of rows ?? []) {
    if (CONFIG_KEYS.includes(row.key) && typeof row.value === "string") {
      config[row.key] = row.value;
    }
  }
  return config;
}

async function saveConfig(partial) {
  const entries = Object.entries(partial).filter(
    ([key, value]) =>
      CONFIG_KEYS.includes(key) && typeof value === "string" && value.length > 0,
  );
  if (entries.length === 0) {
    throw new BadRequestError("没有可保存的配置项");
  }
  for (const [key, value] of entries) {
    if (value.length > 512) {
      throw new BadRequestError("配置值过长");
    }
    await runDatabaseOperation("save_config", () =>
      getSupabaseClient()
        .from("app_config")
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" }),
    );
  }
}

function maskValue(value) {
  if (!value) return { configured: false, masked: "" };
  if (value.length <= 8) return { configured: true, masked: "••••••••" };
  return { configured: true, masked: `${value.slice(0, 4)}••••••••${value.slice(-4)}` };
}

function configSummary(config) {
  return {
    app_id: maskValue(config.app_id),
    app_secret: maskValue(config.app_secret),
    encrypt_key: maskValue(config.encrypt_key),
    verification_token: maskValue(config.verification_token),
  };
}

// SECTION: feishu api client (official SDK)

const FEISHU_ERROR_MESSAGES = {
  40004: "应用没有该部门的通讯录数据权限，请在飞书开放平台「权限管理 → 数据权限」中把部门加入可见范围，并发布版本后重试",
  40006: "应用没有该接口的调用权限，请在飞书开放平台开通对应权限并发布版本",
  99992402: "请求参数校验失败，请检查分页大小等参数是否超出接口上限",
  99991661: "App ID 不存在，请检查飞书应用凭证",
  99991663: "App Secret 不正确，请检查飞书应用凭证",
  99991668: "App ID 或 App Secret 缺失",
  99991672: "应用被停用或未开启相关能力",
  230002: "应用缺少通讯录读取权限（contact:department.base:readonly / contact:user.base:readonly），请在飞书开放平台开通并发布版本",
  230001: "无权限访问该部门数据，请检查通讯录权限范围",
};

class FeishuApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = "FEISHU_API_ERROR";
    this.feishuCode = code;
  }
  clientMessage() {
    return `${FEISHU_ERROR_MESSAGES[this.feishuCode] ?? "飞书接口调用失败"}（code ${this.feishuCode}）`;
  }
}

function unwrapSdkResponse(response) {
  if (!response || response.code !== 0) {
    const code = response?.code ?? -1;
    throw new FeishuApiError(code, response?.msg ?? "飞书接口调用失败");
  }
  return response.data ?? {};
}

// SDK 内部的 token 缓存是模块级单例、无法清理。这里改用可清空的托管缓存：
// 飞书 tenant_access_token 在签发时固化权限快照，改完权限后旧 token 仍会被判 40004，
// 若不能清缓存就只能重启进程或等 2 小时。托管后可在权限类错误时自动重取。
class MemoryTokenCache {
  constructor() {
    this.values = new Map();
  }
  keyOf(key, options) {
    const name = String(key);
    return options?.namespace ? `${options.namespace}/${name}` : name;
  }
  async get(key, options) {
    const cacheKey = this.keyOf(key, options);
    const entry = this.values.get(cacheKey);
    if (!entry) return undefined;
    if (entry.expiredTime && entry.expiredTime - Date.now() <= 0) {
      this.values.delete(cacheKey);
      return undefined;
    }
    return entry.value;
  }
  async set(key, value, expiredTime, options) {
    this.values.set(this.keyOf(key, options), { value, expiredTime });
    return true;
  }
  clear() {
    this.values.clear();
  }
}

// 这些错误码意味着凭证/权限刚刚变更，旧 token 已失效，值得清缓存重试一次
const RETRYABLE_CREDENTIAL_CODES = new Set([40004, 40006, 99991661, 99991663, 99991668, 99991672]);

// SDK Client 缓存：同一凭证复用实例，token 获取/续期由 SDK 自动处理
let sdkClientCache = { key: "", client: null, cache: null };

function getSdkClient(config) {
  const key = `${config.app_id}\n${config.app_secret}`;
  if (sdkClientCache.key === key && sdkClientCache.client) {
    return sdkClientCache.client;
  }
  const cache = new MemoryTokenCache();
  const client = new lark.Client({
    appId: config.app_id,
    appSecret: config.app_secret,
    loggerLevel: lark.LoggerLevel.warn,
    cache,
  });
  sdkClientCache = { key, client, cache };
  return client;
}

// 遍历企业全部部门（含根部门 0）
async function listAllDepartments(client) {
  const departments = [
    { department_id: "0", name: "根部门", parent_id: "", member_count: 0 },
  ];
  let pageToken;
  do {
    const data = unwrapSdkResponse(
      await client.contact.v3.department.children({
        path: { department_id: "0" },
        params: {
          department_id_type: "department_id",
          fetch_child: true,
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
    );
    for (const item of data.items ?? []) {
      departments.push({
        department_id: item.department_id ?? "",
        name: item.name ?? "",
        parent_id: item.parent_department_id ?? "0",
        member_count: item.member_count ?? 0,
      });
    }
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return departments;
}

// 按部门分页拉取人员
async function listUsersByDepartment(client, departmentId) {
  const users = [];
  let pageToken;
  do {
    const data = unwrapSdkResponse(
      await client.contact.v3.user.findByDepartment({
        params: {
          department_id: departmentId,
          department_id_type: "department_id",
          page_size: 50,
          user_id_type: "open_id",
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
    );
    for (const item of data.items ?? []) {
      users.push(item);
    }
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return users;
}

// SECTION: contact sync

async function syncContactsOnce() {
  const config = await loadConfig();
  if (!config.app_id || !config.app_secret) {
    throw new BadRequestError("请先在「设置」中填写飞书 App ID 与 App Secret");
  }
  const client = getSdkClient(config);

  const departments = await listAllDepartments(client);
  await runDatabaseOperation("upsert_departments", () =>
    getSupabaseClient()
      .from("feishu_departments")
      .upsert(
        departments.map((d) => ({ ...d, synced_at: new Date().toISOString() })),
        { onConflict: "department_id" },
      ),
  );

  const userMap = new Map();
  for (const department of departments) {
    const members = await listUsersByDepartment(client, department.department_id);
    for (const member of members) {
      if (!member.open_id) continue;
      const existing = userMap.get(member.open_id);
      if (existing) {
        // 同一用户属于多个部门：合并部门列表
        const merged = new Set([...(existing.department_ids ?? []), department.department_id]);
        existing.department_ids = [...merged];
      } else {
        userMap.set(member.open_id, {
          open_id: member.open_id,
          name: member.name ?? "",
          user_id: member.user_id ?? "",
          email: member.email ?? "",
          mobile: member.mobile ?? "",
          avatar: member.avatar?.avatar_72 ?? member.avatar?.avatar_origin ?? "",
          job_title: member.job_title ?? "",
          department_ids: [department.department_id],
          active: member.status?.is_frozen === true ? false : true,
          synced_at: new Date().toISOString(),
        });
      }
    }
  }

  const users = [...userMap.values()];
  if (users.length > 0) {
    await runDatabaseOperation("upsert_users", () =>
      getSupabaseClient().from("feishu_users").upsert(users, { onConflict: "open_id" }),
    );
  }

  const now = new Date().toISOString();
  await runDatabaseOperation("save_config", () =>
    getSupabaseClient()
      .from("app_config")
      .upsert({ key: "last_sync_at", value: now, updated_at: now }, { onConflict: "key" }),
  );

  return {
    departmentCount: departments.length,
    userCount: users.length,
    syncedAt: now,
  };
}

// 权限/凭证类失败时清掉 token 缓存重试一次：飞书改完权限后旧 token 仍带旧权限快照，
// 不清缓存就只能重启进程或等 2 小时，这里让它在一次请求内自愈。
async function syncContacts() {
  try {
    return await syncContactsOnce();
  } catch (error) {
    const normalized = normalizeFeishuError(error);
    if (
      normalized instanceof FeishuApiError &&
      RETRYABLE_CREDENTIAL_CODES.has(normalized.feishuCode)
    ) {
      console.warn(
        `feishu api ${normalized.feishuCode} on sync: clearing token cache and retrying once`,
      );
      sdkClientCache.cache?.clear();
      return await syncContactsOnce();
    }
    throw error;
  }
}

async function testFeishuConnection() {
  const config = await loadConfig();
  if (!config.app_id || !config.app_secret) {
    throw new BadRequestError("请先在「设置」中填写飞书 App ID 与 App Secret");
  }
  // 直接用凭证换取 tenant_access_token：不依赖通讯录权限即可验证凭证是否有效
  const response = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: config.app_id, app_secret: config.app_secret }),
  });
  const payload = await response.json().catch(() => null);
  if (!payload || payload.code !== 0 || !payload.tenant_access_token) {
    const code = payload?.code ?? -1;
    throw new FeishuApiError(code, payload?.msg ?? "获取 tenant_access_token 失败");
  }
  return { ok: true };
}

// SECTION: event subscription (official SDK: webhook adapter + websocket client)

function extractMessageText(messageType, rawContent) {
  if (typeof rawContent !== "string" || rawContent.length === 0) return "";
  try {
    const parsed = JSON.parse(rawContent);
    if (messageType === "text") return typeof parsed.text === "string" ? parsed.text : "";
    if (messageType === "post") {
      const lines = [];
      const walk = (node) => {
        if (Array.isArray(node)) {
          for (const child of node) walk(child);
        } else if (node && typeof node === "object" && typeof node.text === "string") {
          lines.push(node.text);
        }
      };
      const root = parsed.content ?? parsed;
      if (root && typeof root === "object") walk(Object.values(root));
      return lines.join(" ");
    }
    if (messageType === "image") return "[图片]";
    if (messageType === "file") return `[文件] ${parsed.file_name ?? ""}`.trim();
    if (messageType === "audio") return "[语音]";
    if (messageType === "media") return "[视频]";
    if (messageType === "share_chat") return "[群名片]";
    if (messageType === "share_user") return "[个人名片]";
    return "";
  } catch {
    return "";
  }
}

// 事件入库：webhook 与长连接共用（SDK 已完成解密/验签，data 为扁平化后的事件对象，
// header 的 event_id / create_time 与 event 的 message / sender 均在顶层可取）
async function persistMessageEvent(data) {
  const eventId = data?.event_id ?? "";
  if (!eventId) return;
  const event = data;

  // 去重（飞书会对未确认事件重试；webhook 与长连接双开时也可能重复投递）
  const existing = await runDatabaseOperation("list_events", () =>
    getSupabaseClient()
      .from("feishu_events")
      .select("id")
      .eq("event_id", eventId)
      .limit(1),
  );
  if (existing && existing.length > 0) {
    return;
  }

  const message = event.message ?? {};
  const sender = event.sender ?? {};

  const createTimeMs = Number(event.create_time);
  const eventTime = Number.isInteger(createTimeMs) && createTimeMs > 0
    ? new Date(createTimeMs).toISOString()
    : null;

  await runDatabaseOperation("insert_event", () =>
    getSupabaseClient().from("feishu_events").insert({
      event_id: eventId,
      event_type: event.event_type ?? "im.message.receive_v1",
      chat_id: message.chat_id ?? "",
      chat_type: message.chat_type ?? "",
      sender_id: sender.sender_id?.open_id ?? "",
      sender_name: sender.sender_name ?? "",
      message_type: message.message_type ?? "",
      content: typeof message.content === "string" ? message.content.slice(0, 4000) : "",
      content_text: extractMessageText(
        message.message_type ?? "",
        typeof message.content === "string" ? message.content : "",
      ).slice(0, 1000),
      event_time: eventTime,
      raw: event,
    }),
  );
}

// SECTION: private chat history polling
// 长连接/Webhook 只推送「实时」事件，进程重启或断线期间飞书不会补发。
// 这里对已出现过的私聊会话定时调用 im/v1/messages 补拉历史消息，
// 以 message_id 为幂等键，与实时事件共用同一张表，不重复入库。

const POLL_INTERVAL_MS = 60_000;
let pollTimer = null;
let pollRunning = false;
const pollStatus = {
  enabled: true,
  intervalMs: POLL_INTERVAL_MS,
  lastRunAt: null,
  chats: 0,
  scanned: 0,
  inserted: 0,
  error: "",
};

async function pollPrivateChatsOnce() {
  if (pollRunning) return pollStatus;
  pollRunning = true;
  const runAt = new Date().toISOString();
  try {
    const config = await loadConfig();
    if (!config.app_id || !config.app_secret) {
      // 未配置凭证：保持静默，不算失败
      return pollStatus;
    }

    // 1) 从已入库事件里收集已知私聊会话（飞书没有"枚举私聊会话"的接口）
    const rows = await runDatabaseOperation("list_known_chats", () =>
      getSupabaseClient().from("feishu_events").select("chat_id, chat_type").limit(500),
    );
    const chatIds = [
      ...new Set(
        (rows ?? [])
          .filter((row) => row.chat_id && row.chat_type === "p2p")
          .map((row) => row.chat_id),
      ),
    ];

    const client = getSdkClient(config);
    let scanned = 0;
    let inserted = 0;

    for (const chatId of chatIds) {
      const data = unwrapSdkResponse(
        await client.im.v1.message.list({
          params: {
            container_id_type: "chat",
            container_id: chatId,
            page_size: 20,
            // 默认按创建时间正序（返回最早的一批），会漏掉断线期间的最新消息
            sort_type: "ByCreateTimeDesc",
          },
        }),
      );
      const items = data.items ?? [];
      scanned += items.length;

      // 2) 该会话已入库的标识集合：既含实时事件的 message_id，也含此前补拉的 event_id
      const known = await runDatabaseOperation("list_chat_events", () =>
        getSupabaseClient()
          .from("feishu_events")
          .select("id, event_id, raw")
          .eq("chat_id", chatId)
          .limit(200),
      );
      const knownIds = new Set();
      for (const row of known ?? []) {
        if (row.event_id) knownIds.add(row.event_id);
        const mid = row.raw?.message?.message_id;
        if (mid) knownIds.add(mid);
      }

      for (const msg of items) {
        const messageId = msg.message_id;
        if (!messageId || msg.deleted) continue;
        if (knownIds.has(messageId) || knownIds.has(`poll:${messageId}`)) continue;

        const content = typeof msg.body?.content === "string" ? msg.body.content : "";
        const createTime = Number(msg.create_time);
        await runDatabaseOperation("insert_polled_event", () =>
          getSupabaseClient().from("feishu_events").insert({
            event_id: `poll:${messageId}`,
            event_type: "im.message.receive_v1",
            chat_id: msg.chat_id ?? chatId,
            chat_type: msg.chat_type ?? "p2p",
            sender_id: msg.sender?.id ?? "",
            sender_name: "",
            message_type: msg.msg_type ?? "",
            content: content.slice(0, 4000),
            content_text: extractMessageText(msg.msg_type ?? "", content).slice(0, 1000),
            event_time:
              Number.isFinite(createTime) && createTime > 0
                ? new Date(createTime).toISOString()
                : null,
            raw: { source: "history_poll", message: msg },
          }),
        );
        knownIds.add(messageId);
        inserted += 1;
      }
    }

    Object.assign(pollStatus, {
      lastRunAt: runAt,
      chats: chatIds.length,
      scanned,
      inserted,
      error: "",
    });
  } catch (error) {
    pollStatus.lastRunAt = runAt;
    pollStatus.error = String(error?.message ?? error).slice(0, 200);
    console.error("private chat poll failed:", pollStatus.error);
  } finally {
    pollRunning = false;
  }
  return pollStatus;
}

function startPrivateChatPolling() {
  if (pollTimer) clearInterval(pollTimer);
  // 启动 15 秒后先补拉一次，之后按固定间隔执行
  setTimeout(() => void pollPrivateChatsOnce(), 15_000);
  pollTimer = setInterval(() => void pollPrivateChatsOnce(), POLL_INTERVAL_MS);
}

// Webhook 事件分发器：Encrypt Key 解密、Verification Token 验签、
// URL verification challenge 全部由官方 SDK 处理，凭证每次请求从数据库动态读取
const eventDispatcher = new lark.EventDispatcher({
  webhookCredentialsProvider: async () => {
    const config = await loadConfig();
    return {
      encryptKey: config.encrypt_key,
      verificationToken: config.verification_token,
    };
  },
  loggerLevel: lark.LoggerLevel.warn,
}).register({
  "im.message.receive_v1": async (data) => {
    await persistMessageEvent(data).catch((error) => {
      console.error("persist webhook event failed", error?.code ?? error?.message);
    });
  },
});

// Webhook 处理器：挂在 POST /webhook/feishu（备选订阅方式，兼容原有配置）
const webhookHandler = lark.adaptDefault("/webhook/feishu", eventDispatcher, {
  autoChallenge: true,
});

// WebSocket 长连接订阅：配置凭证后自动建立，无需公网回调地址
let wsClient = null;
let subscriptionStatus = {
  state: "disabled", // disabled | connecting | connected | reconnecting | failed
  appId: "",
  lastConnectedAt: null,
  error: "",
};

async function closeWsClient() {
  if (!wsClient) return;
  const client = wsClient;
  wsClient = null;
  try {
    await client.close();
  } catch {
    /* ignore close errors */
  }
}

async function restartEventSubscription() {
  await closeWsClient();
  let config;
  try {
    config = await loadConfig();
  } catch {
    // 数据库不可用（如无数据库环境的健康检查启动）：保持未启用，不阻塞服务
    subscriptionStatus = { state: "disabled", appId: "", lastConnectedAt: null, error: "" };
    return;
  }
  if (!config.app_id || !config.app_secret) {
    subscriptionStatus = { state: "disabled", appId: "", lastConnectedAt: null, error: "" };
    return;
  }

  const client = new lark.WSClient({
    appId: config.app_id,
    appSecret: config.app_secret,
    loggerLevel: lark.LoggerLevel.warn,
    onReady: () => {
      subscriptionStatus = {
        state: "connected",
        appId: config.app_id,
        lastConnectedAt: new Date().toISOString(),
        error: "",
      };
      console.log("feishu websocket subscription connected");
    },
    onError: (error) => {
      subscriptionStatus = {
        state: "failed",
        appId: config.app_id,
        lastConnectedAt: null,
        error: error?.message ?? "连接失败",
      };
    },
    onReconnecting: () => {
      subscriptionStatus = { ...subscriptionStatus, state: "reconnecting" };
    },
    onReconnected: () => {
      subscriptionStatus = {
        state: "connected",
        appId: config.app_id,
        lastConnectedAt: new Date().toISOString(),
        error: "",
      };
    },
  });
  wsClient = client;
  subscriptionStatus = {
    state: "connecting",
    appId: config.app_id,
    lastConnectedAt: null,
    error: "",
  };
  try {
    await client.start({ eventDispatcher });
  } catch (error) {
    if (wsClient === client) {
      subscriptionStatus = {
        state: "failed",
        appId: config.app_id,
        lastConnectedAt: null,
        error: error?.message ?? "启动失败",
      };
    }
  }
}

// SECTION: http helpers

class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.code = "BAD_REQUEST";
  }
}

const clientRoot = fileURLToPath(new URL("./dist/", import.meta.url));
const clientRootPrefix = clientRoot.endsWith(sep) ? clientRoot : `${clientRoot}${sep}`;
const indexPath = resolve(clientRoot, "index.html");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function send(response, status, body, contentType) {
  response.writeHead(status, {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendJson(response, status, body) {
  send(response, status, JSON.stringify(body), "application/json; charset=utf-8");
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new BadRequestError("请求体过大");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequestError("请求体不是合法 JSON");
  }
}

// SDK 在 HTTP 4xx/5xx 时抛的是 AxiosError，飞书业务码在 response.data.code 里。
// 不转换的话会落到兜底的 500 internal_error，前端只能看到「内部错误」，
// 这里统一归一化成 FeishuApiError，让真实业务码透出到界面。
function normalizeFeishuError(error) {
  if (error instanceof FeishuApiError) return error;
  const payload = error?.response?.data;
  if (payload && typeof payload.code === "number" && payload.code !== 0) {
    return new FeishuApiError(payload.code, payload.msg ?? "飞书接口调用失败");
  }
  if (error?.code === "ERR_BAD_REQUEST" || error?.code === "ERR_BAD_RESPONSE") {
    return new FeishuApiError(-1, error.message ?? "飞书接口调用失败");
  }
  return error;
}

function handleRouteError(response, error) {
  const failure = normalizeFeishuError(error);
  const traceId = `t-${Math.random().toString(36).slice(2, 10)}`;
  if (failure instanceof DatabaseUnavailableError) {
    sendJson(response, 503, { error: "database_unavailable", traceId });
    return;
  }
  if (failure instanceof DatabaseOperationError) {
    console.error(
      `traceId=${traceId} category=${failure.diagnostic.category} code=${failure.diagnostic.code} operation=${failure.diagnostic.operation}`,
    );
    sendJson(response, 500, { error: "operation_failed", traceId });
    return;
  }
  if (failure instanceof BadRequestError) {
    sendJson(response, 400, { error: "bad_request", message: failure.message, traceId });
    return;
  }
  if (failure instanceof FeishuApiError) {
    console.error(`traceId=${traceId} feishu_code=${failure.feishuCode} ${failure.message}`);
    sendJson(response, 502, {
      error: "feishu_api_error",
      message: failure.clientMessage(),
      feishuCode: failure.feishuCode,
      traceId,
    });
    return;
  }
  console.error(`traceId=${traceId} unexpected route error`);
  sendJson(response, 500, { error: "internal_error", traceId });
}

function isInsideClientRoot(path) {
  return path === clientRoot || path.startsWith(clientRootPrefix);
}

async function existingFile(path) {
  try {
    const details = await stat(path);
    return details.isFile() ? path : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

async function resolveClientFile(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath.replace(/^\/+/, "") || "index.html";
  const candidate = resolve(clientRoot, relativePath);
  if (!isInsideClientRoot(candidate)) {
    return null;
  }

  const file = await existingFile(candidate);
  if (file) {
    return file;
  }

  return extname(decodedPath) ? null : existingFile(indexPath);
}

// SECTION: api routes

async function handleApiRoute(request, response, url) {
  const { pathname } = url;
  const method = request.method ?? "GET";

  if (pathname === "/api/config" && method === "GET") {
    const config = await loadConfig();
    const lastSyncRow = await runDatabaseOperation("get_config", () =>
      getSupabaseClient().from("app_config").select("value").eq("key", "last_sync_at").limit(1),
    );
    sendJson(response, 200, {
      config: configSummary(config),
      lastSyncAt: lastSyncRow?.[0]?.value ?? null,
    });
    return;
  }

  if (pathname === "/api/config" && method === "POST") {
    const body = await readJsonBody(request);
    await saveConfig(body ?? {});
    const config = await loadConfig();
    // 凭证可能已变更：重建长连接订阅
    void restartEventSubscription().catch(() => {});
    sendJson(response, 200, { ok: true, config: configSummary(config) });
    return;
  }

  if (pathname === "/api/subscription" && method === "GET") {
    sendJson(response, 200, {
      mode: "websocket",
      state: subscriptionStatus.state,
      appId: subscriptionStatus.appId
        ? maskValue(subscriptionStatus.appId).masked
        : "",
      lastConnectedAt: subscriptionStatus.lastConnectedAt,
      error: subscriptionStatus.error,
      webhookPath: "/webhook/feishu",
      poll: { ...pollStatus },
    });
    return;
  }

  // 手动触发一次私聊历史消息补拉（便于排查与即时回填）
  if (pathname === "/api/poll" && method === "POST") {
    const result = await pollPrivateChatsOnce();
    sendJson(response, 200, { ok: !result.error, poll: { ...result } });
    return;
  }

  if (pathname === "/api/config/test" && method === "POST") {
    const result = await testFeishuConnection();
    sendJson(response, 200, result);
    return;
  }

  if (pathname === "/api/sync" && method === "POST") {
    const result = await syncContacts();
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (pathname === "/api/departments" && method === "GET") {
    const rows = await runDatabaseOperation("list_departments", () =>
      getSupabaseClient()
        .from("feishu_departments")
        .select("department_id, name, parent_id, member_count, synced_at")
        .order("department_id", { ascending: true }),
    );
    sendJson(response, 200, { departments: rows ?? [] });
    return;
  }

  if (pathname === "/api/users" && method === "GET") {
    const search = (url.searchParams.get("search") ?? "").trim();
    const department = url.searchParams.get("department") ?? "";

    let query = getSupabaseClient()
      .from("feishu_users")
      .select("open_id, name, user_id, email, mobile, avatar, job_title, department_ids, active, synced_at")
      .order("name", { ascending: true })
      .limit(500);

    if (search) {
      const kw = escapeLike(search);
      query = query.or(`name.ilike.%${kw}%,email.ilike.%${kw}%,job_title.ilike.%${kw}%,user_id.ilike.%${kw}%,open_id.ilike.%${kw}%`);
    }
    if (department) {
      query = query.contains("department_ids", [department]);
    }
    const rows = await runDatabaseOperation("list_users", () => query);
    sendJson(response, 200, { users: rows ?? [] });
    return;
  }

  if (pathname === "/api/events" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
    const eventType = url.searchParams.get("event_type") ?? "";
    let query = getSupabaseClient()
      .from("feishu_events")
      .select("id, event_id, event_type, chat_id, chat_type, sender_id, sender_name, message_type, content_text, event_time, received_at")
      // 按消息发生时间倒序（补拉的历史消息可能晚于实时事件入库），
      // 时间相同则按入库 id 倒序，保证列表始终呈现真实的时间线
      .order("event_time", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (eventType) {
      query = query.eq("event_type", eventType);
    }
    const rows = await runDatabaseOperation("list_events", () => query);
    sendJson(response, 200, { events: rows ?? [] });
    return;
  }

  if (pathname === "/api/stats" && method === "GET") {
    const [deptCount, userCount, eventCount] = await Promise.all([
      runDatabaseCount("count_stats", () =>
        getSupabaseClient().from("feishu_departments").select("id", { count: "exact" })),
      runDatabaseCount("count_stats", () =>
        getSupabaseClient().from("feishu_users").select("id", { count: "exact" })),
      runDatabaseCount("count_stats", () =>
        getSupabaseClient().from("feishu_events").select("id", { count: "exact" })),
    ]);
    sendJson(response, 200, {
      departments: deptCount,
      users: userCount,
      events: eventCount,
    });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function escapeLike(value) {
  return value.replace(/[%_,()]/g, " ");
}

// SECTION: static file serving + server bootstrap

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://qwenwork.local");
    const method = request.method ?? "GET";

    if (url.pathname === "/healthz" || url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok", database: databaseMode });
      return;
    }

    if (url.pathname === "/webhook/feishu" && method === "POST") {
      // 官方 SDK 适配器：自动处理 URL 验证 challenge、Encrypt Key 解密、
      // Verification Token 验签，事件分发到 eventDispatcher
      try {
        await webhookHandler(request, response);
      } catch (error) {
        console.error(`webhook handler failed: ${error?.message ?? error}`);
        if (!response.headersSent) {
          sendJson(response, 500, { error: "webhook_failed" });
        }
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (method !== "GET" && method !== "POST") {
        response.setHeader("allow", "GET, POST");
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      try {
        await handleApiRoute(request, response, url);
      } catch (error) {
        handleRouteError(response, error);
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      send(response, 405, "Method Not Allowed", "text/plain; charset=utf-8");
      return;
    }

    const file = await resolveClientFile(url.pathname);
    if (!file) {
      send(response, 404, "Not Found", "text/plain; charset=utf-8");
      return;
    }

    const body = request.method === "HEAD" ? undefined : await readFile(file);
    // 缓存策略：带内容哈希的 /assets/* 可以长期缓存；入口 HTML 必须每次回源校验，
    // 否则重新发布会换掉 JS 的文件名，旧 HTML 会去请求已不存在的资源而白屏
    const hashedAsset = url.pathname.startsWith("/assets/");
    response.writeHead(200, {
      "content-type": contentTypes.get(extname(file).toLowerCase()) ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": hashedAsset
        ? "public, max-age=31536000, immutable"
        : "no-cache, must-revalidate",
    });
    response.end(body);
  } catch (error) {
    console.error("Request failed");
    send(response, 500, "Internal Server Error", "text/plain; charset=utf-8");
  }
});

databaseMode = await detectDatabaseMode();
console.log(
  `database mode: ${databaseMode}${databaseMode === "local" ? ` -> ${LOCAL_STORE_FILE}` : ""}`,
);

server.listen(port, host, () => {
  console.log(`QW Page server listening on http://${host}:${port}`);
  // 启动时若已配置凭证，自动建立飞书长连接订阅（失败不影响 HTTP 服务）
  void restartEventSubscription().catch(() => {});
  // 私聊历史消息定时补拉：覆盖长连接断线期间漏收的消息
  startPrivateChatPolling();
});
