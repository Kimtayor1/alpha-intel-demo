# ALPHA 情报系统

**把你关心的 X 动态，变成可核查、可推送的情报。** ALPHA 监控指定账号发布的帖子和新增关注，把原始事件交给你选的模型审核，再用你定义的准则复核。新情报可投递到 Telegram；相同事件和已经入队的项目事实不会重复推送。

[在线交互预览](https://weizhiqiang1005.github.io/alpha-intel-demo/) · [下载源码 ZIP](https://github.com/weizhiqiang1005/alpha-intel-demo/archive/refs/heads/main.zip)

| | 自部署版 | 网页预览 |
|---|---|---|
| 数据 | 你设置的 X 监控账号 | 五组虚构案例 |
| 判定 | 你的模型 + 你的合格准则 | 用示例展示审核、校验和去重 |
| 投递 | 默认关闭，可开启 Telegram | 只演示发件箱，不发通知 |

## 快速开始

需要 **Node.js 22.13+**，用内置 SQLite，不需要安装 npm 依赖。准备可访问用户查询、时间线、关注列表的 [X API](https://docs.x.com/x-api) Bearer Token。远程模型需要你自己的 Key；本机回环地址的 OpenAI 兼容服务可不填 Key。对照自己的 API 权限、额度和计费再启动。

```bash
# 从仓库目录运行；或下载 ZIP 解压后进入目录
mkdir -p config/local
cp .env.example .env
cp config/runtime.example.json config/local/runtime.json
cp config/policy.example.json config/local/policy.json
```

PowerShell 对应命令：

```powershell
New-Item -ItemType Directory -Force config/local | Out-Null
Copy-Item .env.example .env
Copy-Item config/runtime.example.json config/local/runtime.json
Copy-Item config/policy.example.json config/local/policy.json
```

1. 在 `.env` 填 `ALPHA_X_BEARER_TOKEN`、`ALPHA_MODEL_API_KEY`，先保持 `ALPHA_ENABLE_LIVE_DELIVERY=0`。
2. 在 `config/local/runtime.json` 的 `watch` 填自己的监控名单。`username` 不带 `@`，`posts` / `following` 分别开启帖子与关注。只有你核实是官方信息源的账号才标 `official: true`。在 `model` 填地址、模型名和接口类型：`chat_completions` 或 `responses`。例如 `baseUrl` 以 `/v1` 结尾，不要再填 `/chat/completions` 或 `/responses`。
3. 在 `config/local/policy.json` 编辑判定准则。先执行 `check`，再 `once` 建基线。基线只记当前帖子游标和关注名单，不回推旧动态。以后有新动态才进入分析。

```bash
npm run check     # 仅验证配置，不联网
npm run once      # 运行一轮采集、分析、投递检查
npm start         # 定时运行，Ctrl+C 停止
npm run status    # 查看本地 SQLite 汇总
npm run decisions # 查看最近 10 条本地判定与证据；不要作为公开日志分享
```

没有 npm 时，等价入口：`node --env-file-if-exists=.env server/cli.mjs check`，将 `check` 换成 `once`、`start`、`status` 或 `decisions`。`status` / `decisions` 前先停止同一数据库的运行进程。长期运行时，让服务的工作目录指向仓库；不要让两个进程共用同一个数据库。异常退出留下 `.lock` 时，确认没有实例在用该数据库，再手动移除对应的 `.lock`。

## 自定义「什么算合格 ALPHA」

帖子（`post`）和关注变化（`follow`）有各自的规则。修改配置后重启，不用改代码。顶层 `instructions` 可写你的业务偏好，例如「只看有明确开放时间的活动」「没有实质变化的公告不算新线索」。文字指令交给模型判断；下表字段还会由程序硬性校验。

| 字段 | 作用 |
|---|---|
| `allowQualify` | 这一类事件是否允许判为合格 |
| `allowPush` | 合格后是否允许入推送队列 |
| `minEvidence` | 模型至少要引用多少条不同 URL 的已采集证据 |
| `minIndependentSources` | 上述引用至少覆盖多少个不同来源 |
| `requireOfficialEvidence` | 是否必须引用至少一条被你标为官方的证据 |
| `minConfidence` | 最低模型评分，范围 `0` 至 `1`；不是事实真伪保证 |

例如，让推文至少引用两条证据、来自两个不同账号：把 `post.minEvidence` 和 `post.minIndependentSources` 都改成 `2`。普通单条帖子往往只有一个来源，会被标为待核实。当前版本可使用 X 附带的被引用或被回复帖子作为原始证据；一条帖子里的多个外链不会凭空变成多个来源，也不会被自动访问。两个账号不等同于事实已独立证实；请按自己的核查标准使用。新增关注不等于背书，示例规则把关注推送关闭。

模型只能引用这次事件已经提供的证据，不能自行添加 ID 或标成官方。只有模型判合格、已引用证据满足硬门槛，才可能出队；相同项目和事实键入队一次。事实键由模型生成，不保证识别所有语义改写。

## 开启 Telegram 投递

先用自己的测试群确认结果。按 [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage) 准备机器人和目标聊天，让机器人具备发消息权限。填 `.env` 的 `ALPHA_TELEGRAM_BOT_TOKEN` 和 `ALPHA_TELEGRAM_CHAT_ID`。同时把 `.env` 的 `ALPHA_ENABLE_LIVE_DELIVERY` 设成 `1`，并把运行配置 `delivery.mode` 改为 `telegram`，再重启。

**关闭投递时，符合规则的条目可以留在本地待发队列。** 开启后会处理之前待发的条目。如果不要补发，请在 `runtime.json` 更换 `databaseFile`（例如 `live.sqlite`）重新建基线。遇到 Telegram `429` 按其重试时间延后，且限制重试次数。如果服务超时、结果不明或发送中进程被终止，该条标为 `uncertain`，不自动重发。

## 运行与数据边界

- 数据库默认在 `data/alpha.sqlite`，保存采集游标、事件、判定和发件箱。不要上传 `.env`、`config/local/`、`data/` 或数据库备份。公开仓库里只有空白模板与合成测试数据，不带私人名单、凭证或生产提示词。
- `partial` 表示收到的分页不完整，本轮不更新对应游标。检查 X API 权限、额度以及 `x.maxPages`。第一次只取帖子首页建立基线，但关注比较需要完整列表；轮询不是实时流，也不能补回超出供应商范围的数据。
- X 帖子和来源信息会发给你配置的模型，合格情报会发给你配置的群。选择可信的供应商；模型不会收到 X 或 Telegram 凭证。
- `docs/` 是独立的无钥展示页，使用合成事件。保留了先前公开的只读校验示例，自部署版不会用它覆盖你的准则。

```bash
npm run preview  # 本地展示：http://127.0.0.1:4173/
npm test         # 自动化测试与回环 HTTP 联调；不会调用供应商或发真实通知
```

## 许可

本仓库不附开源许可证。
