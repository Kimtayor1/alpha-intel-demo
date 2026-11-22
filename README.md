# ALPHA 情报流水线 · 离线演示（alpha-intel-demo）

一个可以独立公开的静态小项目：把 ALPHA 情报流水线的**判定与投递逻辑**摊开给人看。
事件全是虚构的，审核是本地规则 mock，推送只写进页面里的模拟发件箱。**全程不联网。**

> 离线模拟，非实时数据，不发真实通知。

## 它做什么

一条 pipeline，CLI 与网页共用同一份代码（`docs/lib/pipeline.js`）：

1. **采集与归一化**：把一条事件压成「项目键 + 事实指纹 + 证据」。
2. **本地规则审核（mock）**：按事件类型分支给出决策草案，确定性规则，**不是 AI 模型**。
3. **去重与变更判定**：同项目同事实 → 抑制；同项目新事实 → `MATERIAL_UPDATE`。
4. **严格校验**：调用生产原版验证器 `validateAlphaDecision(card, { requireCurrentFields: true })`，
   37 个字段一个不少，字段未知、缺 X 来源、change_type 不匹配都会抛错并阻断投递。
5. **推送决策（模拟）**：`PUSH` 只写进内存里的模拟发件箱，`delivered` 永远是 `false`。

## 它不做什么

- 不抓取任何平台、不调任何 API、不订阅消息、不监控联网。
- 不发通知、不接 webhook、不连钱包、不读环境变量。
- 不加载 CDN、外部字体或追踪脚本；页面只用相对路径的本仓库文件，并带 CSP（`default-src 'none'` 起步）。
- 不包含任何生产列表 ID、真实账号/推文 ID、生产域名与服务器路径、聊天 ID、API Key、Cookie 或 token。
- 证据里的域名只有两类：`.invalid` 保留域（浏览器永不解析），以及 `x.com` 下带 `fictitious_` 前缀的虚构句柄；不含真实账号、真实项目或生产域名。

## 目录

```
alpha-intel-demo/
├── docs/                     ← GitHub Pages 根目录
│   ├── index.html            页面入口（相对路径引用资源，带 CSP）
│   ├── favicon.svg           本地图标，不请求任何外站
│   ├── app.js                页面交互：场景切换 / 单步 / 重放
│   ├── styles.css            样式（系统字体，无外链）
│   ├── .nojekyll             让 Pages 原样发布，不过 Jekyll
│   ├── lib/
│   │   ├── pipeline.js       流程本体（CLI 与浏览器共用，无 Node API）
│   │   ├── fixtures.js       纯合成事件与证据
│   │   └── decision-schema.js  生产原版验证器，逐字复制
│   └── reference/
│       └── alpha-v0.9.7.schema.json  生产策略 schema，逐字复制，仅作对照阅读
├── scripts/
│   ├── demo.mjs              CLI：跑场景、打印步骤与模拟发件箱
│   └── preview.mjs           本地静态预览，只绑 127.0.0.1，只服务 docs/
├── test/demo.test.mjs        自动化测试（node:test，无依赖）
├── package.json
└── .gitignore
```

## 本地运行

需要 Node 22+（用到的特性：ESM、`structuredClone`、`node:test`）。

```bash
node scripts/demo.mjs                       # 全部场景
node scripts/demo.mjs --scenario S2-duplicate
node scripts/demo.mjs --json                # 机器可读
node scripts/demo.mjs --list                # 场景清单
node --test "test/**/*.test.mjs"            # 测试
```

`package.json` 里也备了同样的入口：`npm run demo` / `npm test` / `npm run preview`。

如果本机 PATH 里没有 Node，用绝对路径调同一个可执行文件即可，例如：

```powershell
& "C:\path\to\node.exe" scripts/demo.mjs
```

**不要**在仓库里放任何 `.env`、账号池、真实数据或导出文件；`.gitignore` 已挡住常见形态。

## 在浏览器里看

页面是纯静态站点，但**别用 `file://` 直接双击打开** `docs/index.html`：`app.js` 是 ES 模块，
多数浏览器在 `file://` 下会因为来源限制把模块脚本拦掉，页面会一片空白。
用下面两种方式之一：

```bash
node scripts/preview.mjs          # 本地：http://127.0.0.1:4173/
node scripts/preview.mjs 8080     # 换端口（只收 1-65535 的十进制数字）
```

或者发布到 GitHub Pages 后访问（见下一节）。

预览服务只监听 `127.0.0.1`、只服务 `docs/` 目录、只接受 `GET`/`HEAD`（其它方法 405），
只发白名单静态资产（`.env`、备份、隐藏文件与未知扩展名一律 404），
并按**物理路径**判界（指向 `docs/` 之外的软链接或 Windows junction 直接 403）；
所有响应带 `cache-control: no-store` 与 `x-content-type-options: nosniff`，
前台运行，Ctrl+C 结束，不会常驻。

页面上的操作：

- **场景切换**：5 个场景（新情报 / 重复线索 / 独立关注信号 / 证据不足 / 线索被拒）。
- **单步**：一次推进一个阶段，看每一步的判定与拦截点；顶部统计只算已经展示的步骤，不提前给全场结果。
- **本场景全跑**：直接看到卡片与模拟发件箱。
- **重放本场景**：清空状态重新跑，便于观察去重是"会话内"生效的。
- **全部场景对照**：五场跑在同一会话里，能看出跨场景的重复也会被抑制。

## 用 GitHub Pages 发布（本文档不创建仓库、不上传）

前提：把 `alpha-intel-demo/` 整个目录**作为独立仓库的根**，`docs/` 才会落在仓库根下。

1. 仓库 Settings → Pages → Source 选 **Deploy from a branch**，分支选 `main`，
   目录选 **`/docs`**，保存。
2. 等 Pages 构建完成，访问 `https://<用户名>.github.io/<仓库名>/`。
3. `docs/.nojekyll` 保证原样发布，不需要 Jekyll 构建。

不推荐把这个 demo 塞进另一个仓库的子目录再照上面的办法发布：
`Deploy from a branch` 的 `/docs` 只能指仓库根下的目录，子目录不会被当成站点根，页面会 404。
确实要放子目录，就得改用 GitHub Actions 自己发构建产物，那是另一条路子。

首次发布前请确认公开的代码范围，再扫描实际提交，确保没有生产配置和个人数据。

## 演示与生产的差异

| 维度 | 本演示 | 生产流水线 |
| --- | --- | --- |
| 数据来源 | 手写虚构事件 | 真实平台采集 + 人工/模型审核 |
| 审核 | 按事件类型分支的本地规则 mock | 真实审核链路（模型 + 规则 + 人工兜底） |
| 决策校验 | **同一份** `decision-schema.js`，strict 模式 | 同左 |
| 去重 | 内存里的推送账本，跑完即弃 | 持久化账本 + 指纹库 |
| 投递 | 模拟发件箱，`delivered=false` | 真实推送渠道 |
| 联网 | 无 | 有 |
| 证据链接 | `.invalid` 保留域 + `x.com/fictitious_*` 虚构 ID，纯文本展示 | 真实原始来源 |

**没有放宽的**：`docs/lib/decision-schema.js` 是生产文件的逐字复制（SHA-256 与原件一致），
演示没有为"方便展示"修改任何一条校验规则，所以 `QUALIFIED_ALPHA` 的字段矩阵、
`PUSH/NO_PUSH` 的 `change_type` 约束、证据里必须带原始 X 来源等要求都保持原样。

## 测试覆盖

`node --test "test/**/*.test.mjs"`，24 项，全部本地、不装依赖：

- 流程汇总（单会话）：2 推送 / 2 抑制 / 1 待核实 / 1 拒绝 / 0 阻断。
- 新情报走 `innovation` 路径；关注信号走 `notable_attention` 路径，各自只推一次。
- 重复线索（同一事件换措辞）不会二次推送，命中历史推送 id。
- 证据不足判 `UNRESOLVED`、`research_required=true`、不推送。
- 线索被拒判 `REJECTED`、带拒绝原因、不推送。
- 验证器没有被放宽：缺 X 来源 / 空证据 / 未知字段 / 错 `change_type` / 错 `policy_version` 一律抛错。
- CLI 真跑（子进程）：`--json` 退出码 0，汇总与模块一致；错误场景名退出码 2。
- 网页资源齐全、路径全是相对路径、无外链、无 `<a>` 可点链接、无网络 API。
- 页面 CSP 八条指令齐全，favicon 是本地相对路径，除仓库内文件外零外部请求。
- 合成数据无长数字串（真实 ID 形态）、无合约地址、无凭据字样、无本机路径。
- 预览服务越界拦截（`..`、`%2e%2e`、反斜杠、空字节）与回环 200/403 实测。
- 预览服务只接受 `GET`/`HEAD`（其它方法 405 + `Allow`），响应带 `no-store`/`nosniff`。
- 预览服务只发白名单资产：临时写进 `docs/` 的 `.env`、`.bak`、`.md`、隐藏文件一律 404。
- 预览服务按物理路径判界：`docs/` 外的 junction / 目录软链接一律 403（平台不支持时自动 skip）。
- 端口只收严格十进制：`4173abc`、`0x10`、`1e3`、`+4173`、`0`、`65536` 全部拒绝。
- 单步进度按已展示步骤计数，走向投递步骤之前推送数保持 0。
- 页面脚本引用的 DOM id 都存在于 `index.html`。

## 许可

本仓库用于成果展示，不附开源许可证。
