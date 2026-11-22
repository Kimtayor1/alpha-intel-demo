# ALPHA 情报系统

ALPHA 是一套可自部署的 X 情报系统。它轮询指定账号的推文和新增关注，调用你配置的模型整理线索，再按你的准则校验证据。符合规则的新情报可以发送到 Telegram。SQLite 保存采集进度、判定和发件箱，已入队的同一项目事实不会重复入队。

[下载源码 ZIP](https://github.com/weizhiqiang1005/alpha-intel-demo/archive/refs/heads/main.zip) · [部署指南](#快速开始) · [在线交互预览](https://weizhiqiang1005.github.io/alpha-intel-demo/)

- **监控来源**。SocialData 搜索推文，ScraperTech 读取关注和列表成员，也可补充被关注账号的近期推文。无需 X 官方 API Key。
- **判定准则**。推文和关注可以各设门槛，例如至少引用两个来源，或关注线索只记录、暂不推送。
- **模型与通知**。支持 OpenAI 兼容的 Chat Completions 和 Responses。Telegram 真推送默认关闭。

```text
推文 / 新增关注 → 模型整理 → 按自定义准则复核 → SQLite 去重 → Telegram（可选）
```

在线预览用五组虚构事件演示审核、证据校验和去重。打开网页即可看效果。

## 快速开始

需要 **Node.js 22.13+**，SQLite 已内置。准备所启用功能对应的服务商 Key，并确认接口权限、余额和限额。远程模型需填自己的 Key。本机回环地址上的兼容模型可把模型 Key 留空。[SocialData 接口](https://docs.socialdata.tools/reference/get-search-results/) · [ScraperTech](https://scraper.tech/)

### 1. 复制配置模板

下载并解压后，在仓库目录运行以下命令。已有本地配置时直接编辑现有文件。

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

### 2. 填写自己的配置

| 文件 | 改什么 |
|---|---|
| [`.env`](.env.example) | 填你启用的采集服务对应的 Key，以及远程模型的 `ALPHA_MODEL_API_KEY`。保持 `ALPHA_ENABLE_LIVE_DELIVERY=0`，先看判定结果。 |
| [`config/local/runtime.json`](config/runtime.example.json) | 把 `replace_me` 换成你的监控账号，或填写 `lists`。把 `SET_YOUR_MODEL` 换成实际模型名。模型基础地址通常以 `/v1` 结尾，接口类型选 `chat_completions` 或 `responses`。 |
| [`config/local/policy.json`](config/policy.example.json) | 先用示例准则跑一轮，或按需要修改推文和关注的证据门槛。 |

### 3. 验证并启动

`check` 只检查本地配置。`once` 会请求启用的采集服务，首次只记当前推文和关注名单。后续发现新动态才调用模型。

```bash
npm run check     # 仅验证配置，不联网
npm run once      # 运行一轮采集、分析、投递检查
npm start         # 定时运行，Ctrl+C 停止
npm run status    # 查看本地 SQLite 汇总
npm run decisions # 查看最近 10 条本地判定与证据；不要作为公开日志分享
```

首次运行看到 `baselines` 增加、`ingested: 0` 属于正常情况。等有新动态后，用 `npm run decisions` 看标题、摘要、证据和判定理由。若样例准则要求官方证据，请在 `watch` 里把已核实的官方来源设为 `official: true`。

没有 npm 时，用 `node --env-file-if-exists=.env server/cli.mjs <命令>`，将 `<命令>` 换成 `check`、`once`、`start`、`status` 或 `decisions`。运行 `status` 或 `decisions` 前，先停止正在使用同一数据库的实例。长期运行时，把服务工作目录设为仓库根目录。异常退出留下 `.lock` 时，先确认没有进程在用该库，再手动移除锁文件。

## 配置采集来源

| 功能 | 接口 | 所需 Key |
|---|---|---|
| 搜索账号发布的新推文 | SocialData 搜索 | `SOCIALDATA_API_KEY` |
| 按用户名查询账号 ID | SocialData 用户资料 | `SOCIALDATA_API_KEY` |
| 读取关注快照和 X 列表成员 | ScraperTech `following` / `list_members` | `SCRAPERTECH_API_KEY` |
| 补充被关注账号的近期推文 | ScraperTech `timeline` | `SCRAPERTECH_API_KEY` |

只监控推文且不订阅列表时，可以不填 ScraperTech Key。只看关注且目标都有 `restId`，或来自 ScraperTech 列表时，可以不填 SocialData Key。列表配置示例见下方，`12345` 仅是占位 ID。纯列表模式把 `watch` 改成 `[]`。同一账号在多个列表内只采集一次，账号是否算官方来源由 `watch` 明确设置。

```json
{
  "lists": [{ "listId": "12345", "posts": true, "following": true }]
}
```

`collection.followTimelineLimit` 默认是 `0`。设为正整数后，每轮最多补拉这么多个新增关注目标的一页时间线。时间线会增加 API 费用。`collection.maxAccounts` 限制监控规模，配置从小名单开始。

从 `0.2.0` 升级时，将旧 `x` 块换成模板里的 `collection`，加上 `lists`，并更新 `.env`。原数据库可保留，同一账号数字 ID 对应的游标和去重记录会继续使用。

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

例如，让推文至少引用两条证据、来自两个不同账号：把 `post.minEvidence` 和 `post.minIndependentSources` 都改成 `2`。普通单条帖子往往只有一个来源，会被标为待核实。当前版本可使用 SocialData 返回的被引用帖子作为原始证据；一条帖子里的多个外链不会凭空变成多个来源，也不会被自动访问。两个账号不等同于事实已独立证实；请按自己的核查标准使用。新增关注不等于背书，示例规则把关注推送关闭。

模型只能引用这次事件已经提供的证据，不能自行添加 ID 或标成官方。只有模型判合格、已引用证据满足硬门槛，才可能出队；相同项目和事实键入队一次。事实键由模型生成，不保证识别所有语义改写。

## 开启 Telegram 投递

先用自己的测试群确认结果。按 [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage) 准备机器人和目标聊天，让机器人具备发消息权限。填 `.env` 的 `ALPHA_TELEGRAM_BOT_TOKEN` 和 `ALPHA_TELEGRAM_CHAT_ID`。同时把 `.env` 的 `ALPHA_ENABLE_LIVE_DELIVERY` 设成 `1`，并把运行配置 `delivery.mode` 改为 `telegram`，再重启。

**关闭投递时，符合规则的条目可以留在本地待发队列。** 开启后会处理之前待发的条目。如果不要补发，请在 `runtime.json` 更换 `databaseFile`（例如 `live.sqlite`）重新建基线。遇到 Telegram `429` 按其重试时间延后，且限制重试次数。如果服务超时、结果不明或发送中进程被终止，该条标为 `uncertain`，不自动重发。

## 运行与数据边界

- 数据库默认在 `data/alpha.sqlite`，保存采集游标、事件、判定和发件箱。不要上传 `.env`、`config/local/`、`data/` 或数据库备份。公开仓库里只有空白模板与合成测试数据，不带私人名单、凭证或生产提示词。
- `partial` 表示收到的分页不完整，本轮不更新对应游标。检查供应商权限、额度和各自的 `maxPages`。帖子首次取一页建基线。关注和列表成员需要读到最后一页。轮询无法补回超出供应商范围的数据。
- X 帖子和来源信息会发给你配置的模型，合格情报会发给你配置的群。选择可信的供应商；模型请求不含采集或 Telegram 凭证。
- `docs/` 是独立的无钥展示页，使用合成事件。保留了先前公开的只读校验示例，自部署版不会用它覆盖你的准则。

```bash
npm run preview  # 本地展示：http://127.0.0.1:4173/
npm test         # 自动化测试与回环 HTTP 联调；不会调用供应商或发真实通知
```

## 许可

本仓库不附开源许可证。
