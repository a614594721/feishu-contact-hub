# 飞书通讯录同步与消息订阅管理台

## Project background

使用者是飞书企业的管理员/开发者，需要一个开箱即用的管理界面：

1. 用自己的飞书自建应用（App ID / App Secret）调用飞书开放平台接口，
   遍历企业全部部门并拉取人员信息，保存到数据库；
2. **通道一**：接收发给机器人的消息事件（`im.message.receive_v1`），实时持久化；
3. **通道二**：用本人账号授权，每 5 秒轮询「私聊给我本人」的新消息，补齐飞书不开放的事件盲区；
4. 两类消息统一在前端界面展示、按来源筛选，全部操作通过浏览器完成。

## Product shape

- 类别：QW Pages 动态页（Node.js 22 单入口 `server.mjs` + Vite/React/TS 客户端）。
- 飞书对接分两套身份，互不混淆：
  - **tenant 侧（SDK `@larksuiteoapi/node-sdk`）**：`lark.Client` 处理 tenant_access_token
    的获取/缓存/续期，通讯录同步走 `contact.v3.department.children` 与
    `contact.v3.user.findByDepartment`；`lark.WSClient` 长连接 +
    `lark.EventDispatcher`/`lark.adaptDefault('/webhook/feishu')` 收实时事件。
  - **user 侧（原生 `fetch` 直连 OpenAPI）**：设备流拿到 `user_access_token`，
    调 `GET /im/v1/chats?types=p2p` 枚举本人全部单聊、
    `GET /im/v1/messages` 按时间窗增量拉取。tenant token 无法读取用户私聊，必须单独授权。
- 消息采集双通道，共用同一张 `feishu_events` 表：
  | 通道 | 触发方式 | 来源标识 |
  |---|---|---|
  | 机器人实时 | WebSocket 长连接 / Webhook，秒级 | `bot_realtime` |
  | 我的私聊 | `setInterval` 每 5 秒，user 身份增量轮询 | `user_poll` |
  | 历史补拉（旧版兜底） | tenant 身份补拉已知会话 | `history_poll` |
  - **来源不新增列**：由 `event_id` 前缀推导（飞书原生 event_id / `user_poll:<message_id>` /
    `poll:<message_id>`），避免改动平台固定表结构。
  - 去重按 `message_id`：轮询事件与实时事件共用 `knownMessageIds()`，
    从 `event_id` 与 `raw.message.message_id` 双向比对。
  - 轮询位点（epoch 秒）与 OAuth token 存 `app_config` 表，90 秒重叠窗口防边界丢消息；
    只保留别人发来的消息（排除自己的 open_id、已删除消息）。
- OAuth 设备流：`POST accounts.feishu.cn/oauth/v1/device_authorization`（Basic Auth，
  scope `im:chat:read im:message.p2p_msg:get_as_user offline_access`）→ 用户扫码 →
  后端轮询 `POST accounts.feishu.cn/oauth/v3/token`（device_code grant）；
  刷新走同端点 `refresh_token` grant（JSON body），提前 5 分钟刷新、滚动续期。
  refresh_token 剩余寿命 < 72h 时通过 `ALERT_WEBHOOK`（可选）与前端醒目告警提醒重新扫码。
- 视觉：深空墨蓝控制台风格（深色底 + 网格纹理、电光蓝/青色点缀、玻璃质感卡片）。
- 三个功能页签：
  - **通讯录**：一键同步、统计卡片、搜索与部门筛选、人员表格。
  - **消息订阅**：四张状态卡（采集通道 / 机器人长连接 / 我的私聊轮询 / 授权寿命）、
    user 授权引导（链接 + 授权码，后端自动等待扫码）、长连接与 Webhook 配置指引、
    来源筛选（全部 / 机器人实时 / 我的私聊 / 历史补拉）、统一消息时间线（来源徽标）、
    每 5 秒自动刷新。
  - **设置**：录入 App ID / App Secret / Encrypt Key / Verification Token（脱敏回传）、连通性测试。
- 服务端全部在 `server.mjs`：
  - `GET /healthz`（含 database 诊断）、`GET /api/health`（仅 `{status:"ok"}`）；
  - `GET/POST /api/config`、`POST /api/config/test`、`POST /api/sync`；
  - `GET /api/subscription`（长连接状态 + `poll` 轮询状态 + `userAuth` 授权状态）；
  - `GET /api/user-auth`、`POST /api/user-auth/start`（设备流授权）；
  - `POST /api/poll`（手动触发一次 5 秒轮询）；
  - `GET /api/events?limit=&source=&event_type=`、`GET /api/stats`、
    `GET /api/departments`、`GET /api/users`；
  - `POST /webhook/feishu`（SDK 适配器处理 challenge / 解密 / 验签）。
- 数据库：平台 Supabase 兼容库（仅服务端访问），表：`app_config`、
  `feishu_departments`、`feishu_users`、`feishu_events`。DDL 由平台 migrate 执行，
  应用不自建表、不加列。

## watcher-go/（可选：独立部署的生产级采集器）

同一套「本人私聊 5 秒轮询」能力的 Go 静态二进制实现，零第三方依赖：

- `cmd/watcher`：三种模式 `auth`（设备流授权）/ 默认 serve / `status`（查 token 寿命）；
- `internal/lark`：OAuth 设备流 + 滚动刷新 + chats/messages API；
- `internal/poller`：固定节奏 Ticker、有界并发、崩溃安全（先落 seen 再推游标）；
- `internal/sdnotify`：自实现 systemd notify 协议（`READY=1` + `WATCHDOG=1`）；
- `internal/notify`：token 寿命告警；`internal/store`：原子落盘状态；
- `Dockerfile` 多阶段构建 scratch 镜像；`deploy/` 含 systemd 单元、compose、env 模板。

它与主应用是**二选一**关系，不要同时对同一账号运行（会重复拉取）。
主应用（Node）自包含，开箱即用；`watcher-go` 适合需要 systemd watchdog、
token 告警、纯静态二进制部署的服务器场景。

## Constraints

- 服务端逻辑必须全部在 `server.mjs`（发布目录顶层只允许 `dist/`、`package.json`、
  `package-lock.json`、`server.mjs` 四项，runtime 测试会严格断言）；
  **不要新建 `server/` 目录**，`prepare-publish.mjs` 会把它拷进发布目录导致断言失败。
- Supabase 客户端按 qw-pages-supabase 双模式懒加载，并带本地文件存储兜底；
  缺少数据库变量时服务必须可启动、`/api/health` 必须只返回 `{status:"ok"}`；
  长连接订阅在数据库不可用时保持 disabled，不阻塞服务。
- 飞书凭证只存 `app_config` 表，任何接口不得回传明文 Secret 或 token；
  `/api/user-auth*` 只回授权状态与验证链接，不回 `device_code` / `access_token`。
- 长连接事件、Webhook 事件与轮询消息共用同一入库函数并按 `event_id`/`message_id` 去重
  （飞书对未确认事件会重试；双通道并行时也会重复投递）。
- 5 秒轮询必须轻量：无消息时不写库、单会话失败不中断整轮、
  并发上限 6，避免撞 IM 接口 QPS。
- 无应用内账号体系（内部工具）；如需限制访问，可用平台 SSO 发布选项。
