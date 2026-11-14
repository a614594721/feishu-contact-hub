# 飞书通讯录同步与消息订阅管理台

## Project background

使用者是飞书企业的管理员/开发者，需要一个开箱即用的管理界面：

1. 用自己的飞书自建应用（App ID / App Secret）调用飞书开放平台接口，
   遍历企业全部部门并拉取人员信息，保存到数据库；
2. 接收飞书消息事件（`im.message.receive_v1` 等），把消息事件持久化并在前端实时查看；
3. 全部操作通过浏览器界面完成，无需命令行。

## Product shape

- 类别：QW Pages 动态页（Node.js 22 单入口 `server.mjs` + Vite/React/TS 客户端）。
- 飞书对接全部基于官方 SDK `@larksuiteoapi/node-sdk`：
  - **API 调用**：`lark.Client`（tenant_access_token 获取/缓存/续期由 SDK 自动处理），
    通讯录同步走 `contact.v3.department.children`（fetch_child 分页）与
    `contact.v3.user.findByDepartment`（分页）。
  - **消息订阅（默认）**：`lark.WSClient` WebSocket 长连接，配置凭证后自动建立，
    无需公网回调地址；凭证变更或保存配置时自动重建连接，断线自动重连。
  - **消息订阅（备选）**：`lark.EventDispatcher` + `lark.adaptDefault('/webhook/feishu')`
    Webhook 回调，URL 验证 challenge、Encrypt Key AES 解密、Verification Token
    验签全部由 SDK 处理；凭证通过 `webhookCredentialsProvider` 每次请求从数据库
    动态读取。两种模式可同时开启，事件按 event_id 去重。
  - 连通性测试仍直调 `tenant_access_token` 接口（不依赖通讯录权限即可验证凭证）。
- 视觉：深空墨蓝控制台风格（深色底 + 网格纹理背景、电光蓝/青色点缀、玻璃质感
  卡片、渐变标题、入场 fadeUp 动画，`prefers-reduced-motion` 下禁用动画）。
- 三个功能页签：
  - **通讯录**：一键同步按钮（SDK 遍历部门 → 按部门分页拉取人员 → upsert 入库，
    多部门用户合并 department_ids）、统计卡片（部门数/人员数/最近同步时间）、
    关键字搜索与部门筛选、人员表格。
  - **消息订阅**：长连接状态卡片（连接状态/最近连接时间/错误信息，随事件列表
    每 5 秒轮询 `/api/subscription`）、长连接模式配置指引、Webhook 备选指引
    （回调 URL + SDK 自动解密/验签说明）、实时轮询消息事件列表。
  - **设置**：录入/更新飞书 App ID、App Secret、Encrypt Key、Verification Token
    （存于 `app_config` 表，接口只回传脱敏值），并可测试连通性。
- 服务端（全部在 `server.mjs`）：
  - `GET /healthz`、`GET /api/health`：无依赖健康检查；
  - `GET/POST /api/config`：配置读取（脱敏）/写入（写入后自动重建长连接）；
  - `GET /api/subscription`：长连接订阅状态（state/appId 脱敏/最近连接/错误）；
  - `POST /api/config/test`：连通性测试；
  - `POST /api/sync`：执行通讯录同步；
  - `GET /api/departments`、`GET /api/users`、`GET /api/events`、`GET /api/stats`；
  - `POST /webhook/feishu`：飞书事件回调（SDK 适配器处理 challenge/解密/验签，
    事件入库、快速 200）。
- 数据库：平台 Supabase 兼容库（仅服务端访问，浏览器不持有任何密钥），
  表：`app_config`、`feishu_departments`、`feishu_users`、`feishu_events`。
  DDL 由平台 migrate 接口执行，应用不自建表。

## Constraints

- 服务端逻辑必须全部在 `server.mjs`（发布目录顶层只允许 dist/package.json/
  package-lock.json/server.mjs，runtime 测试会校验）。
- Supabase 客户端按 qw-pages-supabase 双模式懒加载（Broker v2 / legacy env），
  缺少数据库变量时服务必须可启动、`/healthz` 必须健康；长连接订阅在数据库
  不可用时保持 disabled，不阻塞服务。
- 飞书凭证只存 `app_config` 表，任何接口不得回传明文 Secret（订阅状态里的
  App ID 也只回传脱敏值）。
- 长连接事件与 Webhook 事件共用同一入库函数，按 event_id 去重（飞书对未确认
  事件会重试；双模式并行时也会重复投递）。
- 无应用内账号体系（内部工具）；如需限制访问，可用平台 SSO 发布选项。
