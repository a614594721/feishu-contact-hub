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

// SECTION: user OAuth (device flow) + 5s private-chat polling
//
// 飞书只对「机器人」推实时事件；私聊给「我本人」的消息没有事件通道，
// 必须用 user_access_token 主动读取。这里用设备流拿到用户授权，之后每 5 秒
// 枚举我的全部单聊会话并增量拉取，与长连接事件写入同一张 feishu_events 表。
// 来源不新增列（平台表结构固定），由 event_id 前缀推导：
//   bot_realtime = 飞书原始 event_id（长连接/Webhook）
//   user_poll    = user_poll:<message_id>（本段 5 秒轮询）
//   history_poll = poll:<message_id>（旧版 tenant 兜底补拉）

const ACCOUNTS_BASE = "https://accounts.feishu.cn";
const USER_OAUTH_SCOPE = "im:chat:read im:message.p2p_msg:get_as_user offline_access";
const USER_POLL_INTERVAL_MS = 5_000;
const USER_POLL_OVERLAP_SEC = 90;
const USER_POLL_CONCURRENCY = 6;
const TOKEN_ALERT_HOURS = 72;

const STATE_KEYS = {
  token: "user_oauth_token",
  device: "user_oauth_device",
  cursor: "user_poll_cursor",
  lastAlert: "user_token_last_alert",
};

// 状态统一存 app_config 表（key/value），不新增表或列，兼容 broker/legacy/local 三种数据库模式
async function readState(key) {
  const rows = await runDatabaseOperation("get_config", () =>
    getSupabaseClient().from("app_config").select("value").eq("key", key).limit(1),
  );
  const raw = rows?.[0]?.value;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeState(key, value) {
  const now = new Date().toISOString();
  await runDatabaseOperation("save_config", () =>
    getSupabaseClient()
      .from("app_config")
      .upsert({ key, value: JSON.stringify(value), updated_at: now }, { onConflict: "key" }),
  );
}

function basicAuthHeader(config) {
  return `Basic ${Buffer.from(`${config.app_id}:${config.app_secret}`).toString("base64")}`;
}

async function postOauthForm(path, form, config) {
  const response = await fetch(`${ACCOUNTS_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuthHeader(config),
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  return { status: response.status, data };
}

async function postOauthJson(path, body, config) {
  const response = await fetch(`${ACCOUNTS_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: basicAuthHeader(config),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  return { status: response.status, data };
}

function tokenFromResponse(data, previous) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || previous?.refresh_token || "",
    access_expires_at: Date.now() + Number(data.expires_in ?? 7200) * 1000,
    refresh_expires_at: data.refresh_token_expires_in
      ? Date.now() + Number(data.refresh_token_expires_in) * 1000
      : previous?.refresh_expires_at ?? Date.now(),
    scope: data.scope || previous?.scope || "",
    open_id: previous?.open_id ?? "",
    name: previous?.name ?? "",
  };
}

let userTokenCache;
let userAuthState = {
  status: "idle", // idle | pending | authorized | error | expired
  error: "",
  verificationUri: "",
  userCode: "",
  expiresAt: null,
};

async function loadUserToken() {
  if (userTokenCache !== undefined) return userTokenCache;
  userTokenCache = await readState(STATE_KEYS.token);
  return userTokenCache;
}

async function saveUserToken(token) {
  userTokenCache = token;
  await writeState(STATE_KEYS.token, token);
}

async function fetchUserInfo(accessToken) {
  const response = await fetch(`${FEISHU_BASE}/authen/v1/user_info`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => null);
  return {
    open_id: payload?.data?.open_id ?? "",
    name: payload?.data?.name ?? "",
  };
}

// 提前 5 分钟刷新；refresh_token 滚动续期，正常轮询下不会过期
async function ensureUserAccessToken(force = false) {
  const token = await loadUserToken();
  if (!token?.access_token) return "";
  if (!force && token.access_expires_at - Date.now() > 5 * 60 * 1000) {
    return token.access_token;
  }
  if (!token.refresh_token) {
    throw new Error("无 refresh_token：请在开放平台开启「刷新 user_access_token」并发布版本");
  }
  const config = await loadConfig();
  const { status, data } = await postOauthJson(
    "/oauth/v3/token",
    { grant_type: "refresh_token", refresh_token: token.refresh_token },
    config,
  );
  if (!data.access_token) {
    throw new Error(
      `刷新 user token 失败（HTTP ${status}）：${data.error_description ?? data.error ?? "无 access_token"}`,
    );
  }
  const next = tokenFromResponse(data, token);
  await saveUserToken(next);
  return next.access_token;
}

async function userApiGet(path, params, accessToken, allowRefresh = true) {
  const url = new URL(`${FEISHU_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => null);
  if (
    allowRefresh &&
    (response.status === 401 || payload?.code === 99991661 || payload?.code === 99991663)
  ) {
    const fresh = await ensureUserAccessToken(true);
    if (fresh) return userApiGet(path, params, fresh, false);
  }
  if (payload?.code !== 0) {
    throw new FeishuApiError(payload?.code ?? -1, payload?.msg ?? "飞书接口调用失败");
  }
  return payload?.data ?? {};
}

async function listUserP2PChats(accessToken) {
  const chats = [];
  let pageToken = "";
  for (let page = 0; page < 20; page += 1) {
    const params = {
      user_id_type: "open_id",
      sort_type: "ByActiveTimeDesc",
      types: "p2p",
      page_size: "100",
    };
    if (pageToken) params.page_token = pageToken;
    const data = await userApiGet("/im/v1/chats", params, accessToken);
    for (const item of data.items ?? []) {
      if (item.chat_id) chats.push({ chat_id: item.chat_id, name: item.name ?? "" });
    }
    if (!data.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  return chats;
}

async function listUserChatMessages(accessToken, chatId, startUnix, endUnix) {
  const items = [];
  let pageToken = "";
  for (let page = 0; page < 10; page += 1) {
    const params = {
      container_id_type: "chat",
      container_id: chatId,
      sort_type: "ByCreateTimeAsc",
      page_size: "50",
      start_time: String(startUnix),
      end_time: String(endUnix),
      card_msg_content_type: "raw_card_content",
      with_sender_name: "true",
    };
    if (pageToken) params.page_token = pageToken;
    const data = await userApiGet("/im/v1/messages", params, accessToken);
    items.push(...(data.items ?? []));
    if (!data.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  return items;
}

// 设备流授权：前端点一次「开始授权」，后端自动轮询到用户扫码完成
async function startUserAuth() {
  const config = await loadConfig();
  if (!config.app_id || !config.app_secret) {
    throw new BadRequestError("请先在「设置」中填写飞书 App ID 与 App Secret");
  }
  const { status, data } = await postOauthForm(
    "/oauth/v1/device_authorization",
    { client_id: config.app_id, scope: USER_OAUTH_SCOPE },
    config,
  );
  if (status >= 400 || !data.device_code) {
    throw new FeishuApiError(
      data?.code ?? -1,
      data?.error_description ?? data?.error ?? `设备授权失败（HTTP ${status}）`,
    );
  }
  const device = {
    device_code: data.device_code,
    verification_uri: data.verification_uri ?? `${ACCOUNTS_BASE}/oauth/v1/device/verify`,
    user_code: data.user_code ?? "",
    expires_at: Date.now() + Number(data.expires_in ?? 600) * 1000,
    interval_ms: Math.max(Number(data.interval ?? 5), 3) * 1000,
  };
  await writeState(STATE_KEYS.device, device);
  userAuthState = {
    status: "pending",
    error: "",
    verificationUri: device.verification_uri,
    userCode: device.user_code,
    expiresAt: new Date(device.expires_at).toISOString(),
  };
  void waitForUserAuth(device, config).catch((error) => {
    userAuthState = { ...userAuthState, status: "error", error: String(error?.message ?? error) };
  });
  return userAuthState;
}

async function waitForUserAuth(device, config) {
  while (Date.now() < device.expires_at) {
    await new Promise((resolve) => setTimeout(resolve, device.interval_ms));
    const { data } = await postOauthForm(
      "/oauth/v3/token",
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: config.app_id,
      },
      config,
    );
    if (data.access_token) {
      const token = tokenFromResponse(data, null);
      const info = await fetchUserInfo(token.access_token).catch(() => ({ open_id: "", name: "" }));
      token.open_id = info.open_id;
      token.name = info.name;
      await saveUserToken(token);
      await writeState(STATE_KEYS.device, null);
      // 首次授权建立当前时间基线，不回溯历史消息
      await writeState(STATE_KEYS.cursor, Math.floor(Date.now() / 1000));
      userAuthState = {
        status: "authorized",
        error: "",
        verificationUri: "",
        userCode: "",
        expiresAt: null,
      };
      return;
    }
    if (data.error === "slow_down") {
      device.interval_ms += 5_000;
    } else if (data.error && data.error !== "authorization_pending") {
      userAuthState = {
        ...userAuthState,
        status: "error",
        error: `${data.error} ${data.error_description ?? ""}`.trim(),
      };
      return;
    }
  }
  userAuthState = { ...userAuthState, status: "expired", error: "授权已过期，请重新发起" };
}

function userAuthSummary() {
  const token = userTokenCache;
  const authorized = Boolean(token?.access_token);
  const hoursLeft = authorized
    ? Math.max(0, (token.refresh_expires_at - Date.now()) / 3_600_000)
    : 0;
  return {
    ...userAuthState,
    status: authorized && userAuthState.status === "idle" ? "authorized" : userAuthState.status,
    authorized,
    openId: token?.open_id ?? "",
    userName: token?.name ?? "",
    accessExpiresAt: authorized ? new Date(token.access_expires_at).toISOString() : null,
    refreshExpiresAt: authorized ? new Date(token.refresh_expires_at).toISOString() : null,
    refreshHoursLeft: Math.round(hoursLeft * 10) / 10,
    needAlert: authorized && hoursLeft < TOKEN_ALERT_HOURS,
  };
}

async function alertTokenExpiry(summary) {
  if (!summary.needAlert) return;
  const last = Number(await readState(STATE_KEYS.lastAlert)) || 0;
  if (Date.now() - last < 12 * 3_600_000) return;
  await writeState(STATE_KEYS.lastAlert, Date.now());
  const text = `[飞书消息台] user refresh_token 剩余 ${summary.refreshHoursLeft} 小时，请到「消息订阅」页重新扫码授权，否则 5 秒私聊轮询会静默停止。`;
  console.warn(text);
  const webhook = process.env.ALERT_WEBHOOK ?? "";
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
      });
    } catch (error) {
      console.error("token alert webhook failed:", error?.message ?? error);
    }
  }
}

// SECTION: 5s private-chat polling (user identity)

const POLL_INTERVAL_MS = USER_POLL_INTERVAL_MS;
let pollTimer = null;
let pollRunning = false;
const pollStatus = {
  enabled: true,
  intervalMs: POLL_INTERVAL_MS,
  mode: "idle", // idle | user_oauth
  lastRunAt: null,
  chats: 0,
  scanned: 0,
  inserted: 0,
  error: "",
  userAuthorized: false,
  userName: "",
  refreshHoursLeft: 0,
  tokenAlert: "",
};

async function knownMessageIds(chatId) {
  const rows = await runDatabaseOperation("list_events", () =>
    getSupabaseClient()
      .from("feishu_events")
      .select("event_id, raw")
      .eq("chat_id", chatId)
      .limit(500),
  );
  const ids = new Set();
  for (const row of rows ?? []) {
    if (row.event_id) {
      ids.add(row.event_id);
      const match = /^(?:user_poll|poll):(.+)$/.exec(row.event_id);
      if (match) ids.add(match[1]);
    }
    const mid = row.raw?.message?.message_id;
    if (mid) ids.add(mid);
  }
  return ids;
}

async function persistUserMessage(msg, chat, myOpenId) {
  const messageId = msg.message_id;
  if (!messageId || msg.deleted) return false;
  if (myOpenId && msg.sender?.id === myOpenId) return false; // 只收别人发给我的
  const eventId = `user_poll:${messageId}`;
  const raw = typeof msg.body?.content === "string" ? msg.body.content : "";
  const createTime = Number(msg.create_time);
  await runDatabaseOperation("insert_event", () =>
    getSupabaseClient().from("feishu_events").insert({
      event_id: eventId,
      event_type: "im.message.receive_v1",
      chat_id: msg.chat_id ?? chat.chat_id,
      chat_type: "p2p",
      sender_id: msg.sender?.id ?? "",
      sender_name: msg.sender_name ?? msg.sender?.name ?? "",
      message_type: msg.msg_type ?? "",
      content: raw.slice(0, 4000),
      content_text: extractMessageText(msg.msg_type ?? "", raw).slice(0, 1000),
      event_time:
        Number.isFinite(createTime) && createTime > 0
          ? new Date(createTime).toISOString()
          : null,
      raw: { source: "user_poll", chat_name: chat.name, message: msg },
    }),
  );
  return true;
}

async function pollPrivateChatsOnce() {
  if (pollRunning) return pollStatus;
  pollRunning = true;
  const runAt = new Date().toISOString();
  try {
    const token = await loadUserToken();
    if (!token?.access_token) {
      Object.assign(pollStatus, {
        mode: "idle",
        lastRunAt: runAt,
        chats: 0,
        scanned: 0,
        inserted: 0,
        error: "",
        userAuthorized: false,
      });
      return pollStatus;
    }

    const summary = userAuthSummary();
    void alertTokenExpiry(summary);
    const accessToken = await ensureUserAccessToken();
    const chats = await listUserP2PChats(accessToken);

    const cursor = Number(await readState(STATE_KEYS.cursor)) || Math.floor(Date.now() / 1000);
    const startUnix = Math.max(0, cursor - USER_POLL_OVERLAP_SEC);
    const endUnix = Math.floor(Date.now() / 1000) + 60;

    let scanned = 0;
    let inserted = 0;
    const queue = [...chats];
    const workerCount = Math.min(USER_POLL_CONCURRENCY, Math.max(queue.length, 1));
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const chat = queue.shift();
        if (!chat) break;
        try {
          const messages = await listUserChatMessages(accessToken, chat.chat_id, startUnix, endUnix);
          scanned += messages.length;
          if (messages.length === 0) continue;
          const known = await knownMessageIds(chat.chat_id);
          for (const msg of messages) {
            if (known.has(msg.message_id) || known.has(`user_poll:${msg.message_id}`)) continue;
            if (await persistUserMessage(msg, chat, token.open_id)) {
              known.add(msg.message_id);
              inserted += 1;
            }
          }
        } catch (error) {
          console.error(`poll chat ${chat.chat_id} failed:`, error?.message ?? error);
        }
      }
    });
    await Promise.all(workers);

    await writeState(STATE_KEYS.cursor, Math.floor(Date.now() / 1000));
    Object.assign(pollStatus, {
      mode: "user_oauth",
      lastRunAt: runAt,
      chats: chats.length,
      scanned,
      inserted,
      error: "",
      userAuthorized: true,
      userName: token.name ?? "",
      refreshHoursLeft: summary.refreshHoursLeft,
      tokenAlert: summary.needAlert
        ? `refresh_token 仅剩 ${summary.refreshHoursLeft} 小时，请重新扫码授权`
        : "",
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
  // 启动时加载已有 token，让状态卡片立即显示授权情况
  void loadUserToken().catch(() => null);
  setTimeout(() => void pollPrivateChatsOnce(), 3_000);
  pollTimer = setInterval(() => void pollPrivateChatsOnce(), POLL_INTERVAL_MS);
}

function deriveEventSource(eventId) {
  if (typeof eventId === "string" && eventId.startsWith("user_poll:")) return "user_poll";
  if (typeof eventId === "string" && eventId.startsWith("poll:")) return "history_poll";
  return "bot_realtime";
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
      userAuth: userAuthSummary(),
    });
    return;
  }

  // user 身份设备流授权：拿到 user_access_token 后即可 5 秒轮询「私聊给我本人」的消息
  if (pathname === "/api/user-auth" && method === "GET") {
    sendJson(response, 200, userAuthSummary());
    return;
  }

  if (pathname === "/api/user-auth/start" && method === "POST") {
    const auth = await startUserAuth();
    sendJson(response, 200, { ok: true, auth });
    return;
  }

  // 手动触发一次私聊消息轮询（便于排查与即时回填）
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
    const source = url.searchParams.get("source") ?? "";
    // 按来源筛选时先多取一些再过滤，避免结果被 limit 截断
    const queryLimit = source && source !== "all" ? 200 : limit;
    let query = getSupabaseClient()
      .from("feishu_events")
      .select("id, event_id, event_type, chat_id, chat_type, sender_id, sender_name, message_type, content_text, event_time, received_at")
      // 按消息发生时间倒序（补拉的历史消息可能晚于实时事件入库），
      // 时间相同则按入库 id 倒序，保证列表始终呈现真实的时间线
      .order("event_time", { ascending: false })
      .order("id", { ascending: false })
      .limit(queryLimit);
    if (eventType) {
      query = query.eq("event_type", eventType);
    }
    const rows = await runDatabaseOperation("list_events", () => query);
    const events = (rows ?? [])
      .map((row) => ({ ...row, source: deriveEventSource(row.event_id) }))
      .filter((row) => !source || source === "all" || row.source === source)
      .slice(0, limit);
    sendJson(response, 200, { events });
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

    if (url.pathname === "/healthz") {
      sendJson(response, 200, { status: "ok", database: databaseMode });
      return;
    }

    // runtime 契约：/api/health 只回状态字段，诊断信息放 /healthz
    if (url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok" });
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
  // 私聊消息 5 秒轮询（user 身份，需在「消息订阅」页完成一次扫码授权）
  startPrivateChatPolling();
});
