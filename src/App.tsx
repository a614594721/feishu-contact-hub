import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ---------- types ---------- */

interface ConfigField {
  configured: boolean;
  masked: string;
}

interface ConfigSummary {
  app_id: ConfigField;
  app_secret: ConfigField;
  encrypt_key: ConfigField;
  verification_token: ConfigField;
}

interface ConfigResponse {
  config: ConfigSummary;
  lastSyncAt: string | null;
}

interface Department {
  department_id: string;
  name: string;
  parent_id: string;
  member_count: number;
  synced_at: string;
}

interface User {
  open_id: string;
  name: string;
  user_id: string;
  email: string;
  mobile: string;
  avatar: string;
  job_title: string;
  department_ids: string[];
  active: boolean;
  synced_at: string;
}

interface FeishuEvent {
  id: number;
  event_id: string;
  event_type: string;
  chat_id: string;
  chat_type: string;
  sender_id: string;
  sender_name: string;
  message_type: string;
  content_text: string;
  event_time: string | null;
  received_at: string;
}

interface Stats {
  departments: number;
  users: number;
  events: number;
}

interface Subscription {
  mode: "websocket";
  state: "disabled" | "connecting" | "connected" | "reconnecting" | "failed";
  appId: string;
  lastConnectedAt: string | null;
  error: string;
  webhookPath: string;
}

type TabKey = "contacts" | "events" | "settings";

/* ---------- api helpers ---------- */

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `请求失败 (${response.status})`);
  }
  return payload as T;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `请求失败 (${response.status})`);
  }
  return payload as T;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

/* ---------- app shell ---------- */

export function App() {
  const [tab, setTab] = useState<TabKey>("contacts");
  const [config, setConfig] = useState<ConfigSummary | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const refreshConfig = useCallback(async () => {
    try {
      const data = await apiGet<ConfigResponse>("/api/config");
      setConfig(data.config);
      setLastSyncAt(data.lastSyncAt);
    } catch {
      setConfig(null);
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  const configured = config?.app_id.configured && config?.app_secret.configured;

  const tabs = useMemo(
    () => [
      { key: "contacts" as TabKey, label: "通讯录同步" },
      { key: "events" as TabKey, label: "消息订阅" },
      { key: "settings" as TabKey, label: "设置" },
    ],
    [],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">飞</span>
          <div>
            <h1>通讯录同步 · 消息订阅台</h1>
            <p className="brand-sub">Feishu Contact Sync &amp; Event Console</p>
          </div>
        </div>
        <div className={`status-pill ${configured ? "ok" : "warn"}`}>
          <span className="dot" />
          {configured ? "应用已配置" : "待配置应用凭证"}
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.key}
            role="tab"
            aria-selected={tab === item.key}
            className={`tab ${tab === item.key ? "active" : ""}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === "contacts" && (
          <ContactsTab
            lastSyncAt={lastSyncAt}
            onSynced={() => void refreshConfig()}
            configured={Boolean(configured)}
          />
        )}
        {tab === "events" && <EventsTab />}
        {tab === "settings" && <SettingsTab onSaved={() => void refreshConfig()} config={config} />}
      </main>

      <footer className="app-footer">
        数据存储于应用数据库 · 飞书凭证仅保存在服务端，不会返回浏览器
      </footer>
    </div>
  );
}

/* SECTION: contacts tab */

/** 可点击复制的文本（用于 user_id 这类需要粘贴到别处的短标识） */
function CopyText({ value }: { value?: string }) {
  const [copied, setCopied] = useState(false);

  if (!value) return <span className="mono">—</span>;

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement("textarea");
        area.value = value;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className={`copy-cell mono${copied ? " copied" : ""}`}
      onClick={handleCopy}
      title={`点击复制：${value}`}
    >
      {copied ? "已复制" : value}
    </button>
  );
}

function ContactsTab({
  lastSyncAt,
  onSynced,
  configured,
}: {
  lastSyncAt: string | null;
  onSynced: () => void;
  configured: boolean;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setStats(await apiGet<Stats>("/api/stats"));
    } catch {
      /* ignore */
    }
  }, []);

  const loadDirectory = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (department) params.set("department", department);
      const data = await apiGet<{ users: User[] }>(`/api/users?${params.toString()}`);
      setUsers(data.users);
      const deptData = await apiGet<{ departments: Department[] }>("/api/departments");
      setDepartments(deptData.departments);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "加载失败" });
    }
  }, [search, department]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    const handle = setTimeout(() => void loadDirectory(), 300);
    return () => clearTimeout(handle);
  }, [loadDirectory]);

  const departmentName = useCallback(
    (id: string) => departments.find((d) => d.department_id === id)?.name ?? id,
    [departments],
  );

  async function handleSync() {
    setSyncing(true);
    setMessage(null);
    try {
      const result = await apiPost<{
        departmentCount: number;
        userCount: number;
        syncedAt: string;
      }>("/api/sync");
      setMessage({
        kind: "ok",
        text: `同步完成：${result.userCount} 名人员、${result.departmentCount} 个部门已入库。`,
      });
      onSynced();
      await loadStats();
      await loadDirectory();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "同步失败" });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section aria-label="通讯录同步">
      <div className="stat-row">
        <div className="stat-card">
          <span className="stat-label">部门</span>
          <span className="stat-value">{stats?.departments ?? "—"}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">人员</span>
          <span className="stat-value">{stats?.users ?? "—"}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">消息事件</span>
          <span className="stat-value">{stats?.events ?? "—"}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">最近同步</span>
          <span className="stat-value small">{formatTime(lastSyncAt)}</span>
        </div>
      </div>

      <div className="toolbar">
        <button
          className="primary-btn"
          onClick={() => void handleSync()}
          disabled={syncing || !configured}
        >
          {syncing ? "正在同步…" : "同步飞书通讯录"}
        </button>
        {!configured && <span className="hint">请先在「设置」中配置飞书应用凭证</span>}
        {message && (
          <span className={`inline-msg ${message.kind}`}>{message.text}</span>
        )}
      </div>

      <div className="filter-row">
        <input
          className="search-input"
          placeholder="搜索姓名 / 用户 ID / 邮箱 / 职位"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="dept-select"
          value={department}
          onChange={(event) => setDepartment(event.target.value)}
        >
          <option value="">全部部门</option>
          {departments.map((d) => (
            <option key={d.department_id} value={d.department_id}>
              {d.name}
            </option>
          ))}
        </select>
        <span className="count-tag">{users.length} 人</span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>姓名</th>
              <th>用户 ID</th>
              <th>职位</th>
              <th>部门</th>
              <th>邮箱</th>
              <th>手机号</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={7} className="empty-cell">
                  {configured ? "暂无数据，点击「同步飞书通讯录」拉取人员" : "请先完成应用配置"}
                </td>
              </tr>
            )}
            {users.map((user) => (
              <tr key={user.open_id}>
                <td className="name-cell">
                  {user.avatar ? (
                    <img className="avatar" src={user.avatar} alt="" loading="lazy" />
                  ) : (
                    <span className="avatar placeholder">
                      {(user.name || "?").slice(0, 1)}
                    </span>
                  )}
                  <span>{user.name || "（未命名）"}</span>
                </td>
                <td>
                  <CopyText value={user.user_id} />
                </td>
                <td>{user.job_title || "—"}</td>
                <td>
                  {user.department_ids?.map((id) => (
                    <span key={id} className="dept-chip">
                      {departmentName(id)}
                    </span>
                  )) ?? "—"}
                </td>
                <td className="mono">{user.email || "—"}</td>
                <td className="mono">{user.mobile || "—"}</td>
                <td>
                  <span className={`status-chip ${user.active ? "on" : "off"}`}>
                    {user.active ? "在职" : "冻结"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* SECTION: events tab */

function EventsTab() {
  const [events, setEvents] = useState<FeishuEvent[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const webhookUrl = `${window.location.origin}/webhook/feishu`;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadEvents = useCallback(async () => {
    try {
      const data = await apiGet<{ events: FeishuEvent[] }>("/api/events?limit=100");
      setEvents(data.events);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, []);

  const loadSubscription = useCallback(async () => {
    try {
      setSubscription(await apiGet<Subscription>("/api/subscription"));
    } catch {
      setSubscription(null);
    }
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    void loadSubscription();
  }, [loadSubscription]);

  useEffect(() => {
    if (!autoRefresh) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      void loadEvents();
      void loadSubscription();
    }, 5000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, loadEvents, loadSubscription]);

  async function copyWebhook() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制失败，请手动选择复制");
    }
  }

  const stateMeta: Record<Subscription["state"], { label: string; cls: string }> = {
    connected: { label: "长连接已建立", cls: "ok" },
    connecting: { label: "正在建立连接…", cls: "warn" },
    reconnecting: { label: "连接中断，自动重连中…", cls: "warn" },
    failed: { label: "连接失败", cls: "err" },
    disabled: { label: "未启用（未配置应用凭证）", cls: "warn" },
  };
  const state = subscription?.state ?? "disabled";
  const meta = stateMeta[state];

  return (
    <section aria-label="消息订阅">
      <div className="stat-row">
        <div className="stat-card">
          <span className="stat-label">订阅方式</span>
          <span className="stat-value small">飞书官方 SDK · WebSocket 长连接</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">连接状态</span>
          <span className={`status-pill ${meta.cls}`}>
            <span className="dot" />
            {meta.label}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">最近连接</span>
          <span className="stat-value small">{formatTime(subscription?.lastConnectedAt ?? null)}</span>
        </div>
      </div>

      <div className="callout">
        <h2>事件订阅配置（推荐：长连接模式）</h2>
        <p>
          在飞书开放平台的应用后台，进入「事件与回调 → 事件配置」，订阅方式选择
          <strong>「使用长连接接收事件」</strong>，然后添加事件
          <code className="inline-code">im.message.receive_v1</code>（接收消息）并发布应用版本。
        </p>
        <p>
          本服务检测到已保存的 App ID / App Secret 后会<strong>自动建立长连接</strong>，
          无需公网回调地址、无需内网穿透；连接中断时自动重连。收到的消息事件
          会自动去重并入库，在下方列表实时查看。
          {subscription?.error && (
            <span className="inline-msg error"> 连接错误：{subscription.error}</span>
          )}
        </p>
      </div>

      <div className="callout">
        <h2>备选：Webhook 回调模式</h2>
        <p>
          若订阅方式选择「将事件发送至开发者服务器」，请求地址填写：
        </p>
        <div className="url-row">
          <code className="mono url">{webhookUrl}</code>
          <button className="ghost-btn" onClick={() => void copyWebhook()}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <p>
          URL 验证、Encrypt Key 解密与 Verification Token 验签均由官方 SDK 自动处理：
          若应用开启了加密或校验，请在「设置」页填入对应密钥（未开启可不填，
          Token 配置后将进行严格校验）。两种模式可同时开启，事件按 ID 自动去重。
        </p>
      </div>

      <div className="toolbar">
        <label className="switch-label">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          每 5 秒自动刷新
        </label>
        <button className="ghost-btn" onClick={() => { void loadEvents(); void loadSubscription(); }}>
          立即刷新
        </button>
        <span className="count-tag">{events.length} 条事件</span>
        {error && <span className="inline-msg error">{error}</span>}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>事件类型</th>
              <th>会话</th>
              <th>发送者</th>
              <th>消息内容</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-cell">
                  暂无事件。完成事件订阅配置后，向应用机器人发送一条消息试试。
                </td>
              </tr>
            )}
            {events.map((event) => (
              <tr key={event.event_id}>
                <td className="mono nowrap">{formatTime(event.event_time ?? event.received_at)}</td>
                <td>
                  <span className="event-chip">{event.event_type}</span>
                </td>
                <td>
                  {event.chat_type === "p2p" ? "单聊" : event.chat_type === "group" ? "群聊" : "—"}
                  {event.chat_id && (
                    <div className="mono sub">{event.chat_id}</div>
                  )}
                </td>
                <td className="mono">{event.sender_id || "—"}</td>
                <td className="content-cell">{event.content_text || `（${event.message_type || "未知类型"}消息）`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* SECTION: settings tab */

const SETTING_FIELDS: Array<{
  key: "app_id" | "app_secret" | "encrypt_key" | "verification_token";
  label: string;
  placeholder: string;
  hint: string;
  required: boolean;
}> = [
  {
    key: "app_id",
    label: "App ID",
    placeholder: "cli_xxxxxxxxxxxxxxxx",
    hint: "飞书开放平台 → 应用详情页顶部的 App ID",
    required: true,
  },
  {
    key: "app_secret",
    label: "App Secret",
    placeholder: "留空表示不修改",
    hint: "与应用配套的密钥，仅保存在服务端数据库",
    required: true,
  },
  {
    key: "encrypt_key",
    label: "Encrypt Key",
    placeholder: "未开启回调加密可不填",
    hint: "仅 Webhook 模式需要（长连接模式免加密），SDK 会自动解密回调内容",
    required: false,
  },
  {
    key: "verification_token",
    label: "Verification Token",
    placeholder: "未开启校验可不填",
    hint: "仅 Webhook 模式需要；配置后 SDK 会对回调做严格校验，不配置则跳过",
    required: false,
  },
];

function SettingsTab({
  onSaved,
  config,
}: {
  onSaved: () => void;
  config: ConfigSummary | null;
}) {
  const [values, setValues] = useState<Record<string, string>>({
    app_id: "",
    app_secret: "",
    encrypt_key: "",
    verification_token: "",
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const filled: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        if (value.trim()) filled[key] = value.trim();
      }
      if (Object.keys(filled).length === 0) {
        throw new Error("请至少填写一项配置");
      }
      await apiPost("/api/config", filled);
      setValues({ app_id: "", app_secret: "", encrypt_key: "", verification_token: "" });
      setMessage({ kind: "ok", text: "配置已保存" });
      onSaved();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setMessage(null);
    try {
      await apiPost("/api/config/test");
      setMessage({ kind: "ok", text: "连通性测试通过：已成功获取飞书 tenant_access_token" });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "测试失败" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section aria-label="设置">
      <div className="callout">
        <h2>飞书自建应用凭证</h2>
        <p>
          前往飞书开放平台创建「企业自建应用」，开启
          <strong>通讯录只读权限</strong>（contact:department.base:readonly、
          contact:user.base:readonly 等）并发布版本后，将凭证填到此处。
          已经保存的字段显示为脱敏状态，留空提交即不修改。
        </p>
      </div>

      <div className="settings-form">
        {SETTING_FIELDS.map((field) => (
          <div className="field" key={field.key}>
            <label>
              <span className="field-label">
                {field.label}
                {field.required && <em className="req">*</em>}
                {config?.[field.key].configured && (
                  <span className="configured-tag">已配置 {config?.[field.key].masked}</span>
                )}
              </span>
              <input
                type="password"
                autoComplete="off"
                placeholder={field.placeholder}
                value={values[field.key]}
                onChange={(event) =>
                  setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                }
              />
            </label>
            <p className="field-hint">{field.hint}</p>
          </div>
        ))}
      </div>

      <div className="toolbar">
        <button className="primary-btn" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "保存中…" : "保存配置"}
        </button>
        <button className="ghost-btn" onClick={() => void handleTest()} disabled={testing}>
          {testing ? "测试中…" : "测试连通性"}
        </button>
        {message && <span className={`inline-msg ${message.kind}`}>{message.text}</span>}
      </div>
    </section>
  );
}
