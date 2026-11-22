// 纯合成事件与证据。全部虚构，不含任何生产列表 ID、真实账号/推文 ID、域名、路径或凭据。
// 其中的 x.com 链接只用于满足生产验证器的"原始 X 来源"字符串校验：
// 句柄带 fictitious 字样，ID 用 fictitious-000N，页面一律按纯文本渲染，不做可点链接，也不发起请求。
// evidence.demo.invalid / signals.demo.invalid 属保留的 .invalid 顶级域，永远不会解析。

export const DEMO_NOTICE = "离线模拟，非实时数据，不发真实通知";

export const FICTITIOUS_SOURCE_URLS = Object.freeze([
  "https://x.com/fictitious_nebulasand/status/fictitious-0001",
  "https://x.com/fictitious_nebulasand/status/fictitious-0002",
  "https://x.com/fictitious_watchlist_org/status/fictitious-0003",
]);

const LEAD_EVIDENCE_V1 = Object.freeze([
  `虚构推文：主网候补名单开放，前 2000 个地址可参与铸造 | ${FICTITIOUS_SOURCE_URLS[0]}`,
  "虚构公告页快照（演示域名，浏览器不解析） | https://evidence.demo.invalid/nebulassand/waitlist",
]);

const LEAD_EVIDENCE_V2 = Object.freeze([
  `虚构推文（同一事件换了措辞）：候补名单已开，限额 2000 | ${FICTITIOUS_SOURCE_URLS[0]}`,
]);

const ATTENTION_EVIDENCE = Object.freeze([
  `虚构关注变动记录：demo 账号新关注了演示项目 | ${FICTITIOUS_SOURCE_URLS[2]}`,
]);

const LEAD_V1 = {
  id: "E1",
  kind: "lead",
  label: "虚构推文：候补名单开放",
  project: { key: "nebulassand-demo", name: "星砂协议 NebulaSand（虚构）" },
  fact: "waitlist_open",
  sourceConfidence: "SUPPORTED",
  opportunityType: "waitlist",
  opportunityStatus: "OPEN",
  delta: "虚构推文称主网候补名单刚开放，前 2000 个地址可参与铸造。",
  userAction: "只做资料核对：读公告、记下时间窗，不连接任何钱包。",
  whyNow: "名单刚开放，演示里只用来展示推送节拍。",
  innovationType: "new_project",
  innovationSummary: "虚构演示用的新协议叙事，仅作流程样例。",
  differentiation: "演示数据，不描述任何真实项目差异。",
  chainCandidates: ["demo-chain"],
  expiresAt: "2026-11-25T00:00:00Z",
  evidence: LEAD_EVIDENCE_V1,
};

const LEAD_V2 = {
  ...LEAD_V1,
  id: "E2",
  rephrased: true,
  label: "虚构推文：同一件事换了说法",
  delta: "同一条消息的改写版：候补名单已开放，限额 2000 个地址。",
  evidence: LEAD_EVIDENCE_V2,
};

export const SCENARIOS = Object.freeze([
  {
    id: "S1-new-lead",
    title: "新情报：候补名单开放",
    badge: "PUSH",
    summary: "虚构推文 + 公告页 → innovation 路径 → 推送",
    events: [LEAD_V1],
  },
  {
    id: "S2-duplicate",
    title: "重复线索：同一事件重述",
    badge: "NO_PUSH",
    summary: "同项目同事实二次出现 → 去重抑制，不重复推送",
    events: [LEAD_V1, LEAD_V2],
  },
  {
    id: "S3-attention-signal",
    title: "独立关注信号",
    badge: "PUSH",
    summary: "关注变动单独触发 → notable_attention 路径 → 推送",
    events: [
      {
        id: "E3",
        kind: "attention",
        label: "虚构关注变动：demo 账号新增关注",
        project: { key: "nebulassand-demo", name: "星砂协议 NebulaSand（虚构）" },
        fact: "attention_follow",
        sourceConfidence: "SUPPORTED",
        opportunityType: "attention_signal",
        opportunityStatus: "OPEN",
        delta: "一个演示用观察账号新增关注了该虚构项目账号，属独立关注信号。",
        userAction: "只把它当线索优先级，不据此做任何链上动作。",
        whyNow: "关注变动刚发生，演示用来说明信号可以单独成情报。",
        attention: {
          actor: "demo_watchlist_org（虚构账号，非真实主体）",
          type: "follow",
          summary: "该账号的关注列表出现变动，目标为虚构项目账号。",
          evidence: `关注变动快照（演示域名） | ${FICTITIOUS_SOURCE_URLS[2]}`,
        },
        evidence: ATTENTION_EVIDENCE,
      },
    ],
  },
  {
    id: "S4-thin-evidence",
    title: "证据不足：只有截图",
    badge: "待核实",
    summary: "无可核验来源 → UNRESOLVED，research_required=true，不推送",
    events: [
      {
        id: "E4",
        kind: "thin",
        label: "虚构群聊截图转述（无原始来源）",
        project: { key: null, name: null },
        fact: null,
        evidence: ["只有一张群聊截图转述，没有可核验的原始来源（虚构）"],
      },
    ],
  },
  {
    id: "S5-rejected",
    title: "线索被拒：完全匿名",
    badge: "REJECTED",
    summary: "无可核验主体、无链上动作 → REJECTED，不推送",
    events: [
      {
        id: "E5",
        kind: "rejected",
        label: "虚构线索：匿名团队、零动作",
        project: { key: null, name: null },
        fact: null,
        rejectReason: "团队完全匿名、没有任何链上动作、也无可核验来源（虚构演示）。",
        evidence: ["线索来自一段无从核对的转述（虚构）"],
      },
    ],
  },
]);

export function scenarioById(id) {
  return SCENARIOS.find((item) => item.id === id) ?? null;
}
