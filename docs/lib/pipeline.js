// 同一条流水线，CLI（scripts/demo.mjs）与浏览器（docs/app.js）共用。
// 只依赖 docs/lib/decision-schema.js（生产原版，逐字复制）与本目录 fixtures.js（纯合成数据）。
// 不引入任何 Node API、不发起网络请求、不读写环境变量。

import { POLICY_VERSION, validateAlphaDecision } from "./decision-schema.js";
import { SCENARIOS, DEMO_NOTICE } from "./fixtures.js";

export { POLICY_VERSION, SCENARIOS, DEMO_NOTICE };

export const MOCK_JUDGE_NOTE = "本地规则 mock：按事件类型分支的确定性规则，不是 AI 模型，不联网";

export const STAGE_TITLES = Object.freeze({
  ingest: "① 采集与归一化",
  review: "② 本地规则审核（mock）",
  dedup: "③ 去重与变更判定",
  validate: "④ 生产验证器严格校验",
  deliver: "⑤ 推送决策（模拟）",
});

export const STAGE_ORDER = Object.freeze(["ingest", "review", "dedup", "validate", "deliver"]);

function step(stage, lines, ok = true, data = null) {
  return { stage, title: STAGE_TITLES[stage], lines, ok, data };
}

export function createState() {
  return { pushes: [], outbox: [], nextPushId: 1, blocked: [] };
}

// 字段全集：与生产验证器 REQUIRED_KEYS 对齐，全部给 null/[]/false 兜底。
function blankCard(event) {
  return {
    decision: "UNRESOLVED",
    qualified: false,
    project_key: event.project?.key ?? null,
    project_name: event.project?.name ?? null,
    opportunity_type: null,
    opportunity_delta: null,
    opportunity_status: "UNKNOWN",
    user_action: null,
    why_now: null,
    executable: false,
    source_confidence: null,
    qualification_path: null,
    innovation_type: null,
    innovation_summary: null,
    differentiation: null,
    opportunity_basis: null,
    background_entity: null,
    background_relationship: null,
    background_strength: null,
    background_evidence: null,
    attention_actor: null,
    attention_type: null,
    attention_summary: null,
    attention_evidence: null,
    chain_candidates: [],
    contract_addresses: [],
    evidence: [...(event.evidence ?? [])],
    expires_at: null,
    reject_reason: null,
    research_required: true,
    delivery_action: "NO_PUSH",
    change_type: "NOT_APPLICABLE",
    matched_prior_push_ids: [],
    same_project: false,
    same_fact: false,
    material_difference: null,
    policy_version: POLICY_VERSION,
  };
}

// 规则分支表（mock 的全部智能）：
//   lead      → QUALIFIED_ALPHA / innovation
//   attention → QUALIFIED_ALPHA / notable_attention（opportunity_type=attention_signal）
//   thin      → UNRESOLVED（research_required=true）
//   rejected  → REJECTED
export function reviewEvent(event) {
  const card = blankCard(event);
  if (event.kind === "lead") {
    Object.assign(card, {
      decision: "QUALIFIED_ALPHA",
      qualified: true,
      research_required: false,
      opportunity_type: event.opportunityType,
      opportunity_delta: event.delta,
      opportunity_status: event.opportunityStatus,
      user_action: event.userAction,
      why_now: event.whyNow,
      source_confidence: event.sourceConfidence,
      qualification_path: "innovation",
      innovation_type: event.innovationType,
      innovation_summary: event.innovationSummary,
      differentiation: event.differentiation ?? null,
      chain_candidates: [...(event.chainCandidates ?? [])],
      expires_at: event.expiresAt ?? null,
    });
    return card;
  }
  if (event.kind === "attention") {
    Object.assign(card, {
      decision: "QUALIFIED_ALPHA",
      qualified: true,
      research_required: false,
      opportunity_type: "attention_signal",
      opportunity_delta: event.delta,
      opportunity_status: event.opportunityStatus,
      user_action: event.userAction,
      why_now: event.whyNow,
      source_confidence: event.sourceConfidence,
      qualification_path: "notable_attention",
      attention_actor: event.attention.actor,
      attention_type: event.attention.type,
      attention_summary: event.attention.summary,
      attention_evidence: event.attention.evidence,
      expires_at: event.expiresAt ?? null,
    });
    return card;
  }
  if (event.kind === "rejected") {
    Object.assign(card, {
      decision: "REJECTED",
      qualified: false,
      research_required: false,
      opportunity_status: null,
      reject_reason: event.rejectReason,
    });
    return card;
  }
  // thin（默认）：UNRESOLVED，等人工核实。
  Object.assign(card, {
    decision: "UNRESOLVED",
    qualified: false,
    research_required: true,
    opportunity_status: "UNKNOWN",
  });
  return card;
}

// 去重：只看本项目历史推送。同事实 → 抑制；同项目新事实 → MATERIAL_UPDATE。
export function applyDelivery(card, event, state) {
  if (card.decision !== "QUALIFIED_ALPHA") {
    card.delivery_action = "NO_PUSH";
    card.change_type = "NOT_APPLICABLE";
    card.matched_prior_push_ids = [];
    card.same_project = false;
    card.same_fact = false;
    card.material_difference = null;
    return { suppressed: false, reason: "非合格决策，永远不推送" };
  }
  const prior = state.pushes.filter((item) => item.project_key === card.project_key);
  const dup = event.fact ? prior.find((item) => item.fact === event.fact) : undefined;
  card.matched_prior_push_ids = prior.map((item) => item.id);
  card.same_project = prior.length > 0;
  card.same_fact = Boolean(dup);
  if (dup) {
    card.delivery_action = "NO_PUSH";
    card.change_type = event.rephrased ? "SAME_EVENT_REPHRASED" : "SAME_PROJECT_SAME_FACT";
    card.material_difference = null;
    return { suppressed: true, reason: `命中历史推送 #${dup.id}，同一事实不再推` };
  }
  card.delivery_action = "PUSH";
  if (!card.same_project) {
    card.change_type = card.opportunity_type === "attention_signal"
      ? "NEW_ATTENTION_SIGNAL"
      : "NEW_PROJECT";
  } else {
    card.change_type = "MATERIAL_UPDATE";
  }
  card.material_difference = card.opportunity_delta;
  return { suppressed: false, reason: "新情报，允许推送" };
}

// 生产原版验证器，strict 模式（requireCurrentFields: true，不补兼容默认值）。
export function validateCard(card) {
  return validateAlphaDecision(card, { requireCurrentFields: true });
}

function ingestStep(event) {
  return step("ingest", [
    `事件 ${event.id}：${event.label}`,
    `项目：${event.project?.name ?? "（未识别）"}`,
    `事实指纹：${event.fact ?? "（无）"}`,
    `证据条数：${(event.evidence ?? []).length}`,
  ], true, { eventId: event.id });
}

function reviewStep(event, card) {
  const lines = [
    `decision=${card.decision}，qualified=${card.qualified}`,
    `qualification_path=${card.qualification_path ?? "null"}`,
    `research_required=${card.research_required}`,
    MOCK_JUDGE_NOTE,
  ];
  return step("review", lines, true, { eventId: event.id });
}

function dedupStep(dedup) {
  return step("dedup", [dedup.reason], !dedup.suppressed, dedup);
}

// 每步自带 outcome，页面才能"走到哪算到哪"，不提前亮出全场结果。
function outcomeOf(validated, push) {
  if (push) return "PUSH";
  if (validated.decision === "QUALIFIED_ALPHA") return "SUPPRESSED";
  if (validated.decision === "UNRESOLVED") return "PENDING";
  if (validated.decision === "REJECTED") return "REJECTED";
  return "NO_PUSH";
}

function deliverStep(validated, push) {
  const outcome = outcomeOf(validated, push);
  if (validated.delivery_action === "PUSH") {
    return step("deliver", [
      `PUSH #${push.id}（change_type=${validated.change_type}）`,
      "写入模拟发件箱；未连接任何真实渠道，未发出通知。",
    ], true, { pushId: push.id, outcome, decision: validated.decision });
  }
  return step("deliver", [
    `NO_PUSH（change_type=${validated.change_type}）`,
    validated.change_type === "NOT_APPLICABLE"
      ? "结论不合格，不进推送队列。"
      : `已抑制，命中历史推送 ${JSON.stringify(validated.matched_prior_push_ids)}。`,
  ], true, { pushId: null, outcome, decision: validated.decision });
}

export function runScenario(scenario, state = createState()) {
  const steps = [];
  const cards = [];
  const pushes = [];
  const suppressed = [];
  const pending = [];
  const rejected = [];

  for (const event of scenario.events) {
    steps.push(ingestStep(event));
    const card = reviewEvent(event);
    steps.push(reviewStep(event, card));

    const dedup = applyDelivery(card, event, state);
    steps.push(dedupStep(dedup));

    let validated;
    try {
      validated = validateCard(card);
    } catch (error) {
      steps.push(step("validate", [
        "严格校验失败，已阻断，不推送。",
        String(error.message),
      ], false, { eventId: event.id, blocked: true }));
      state.blocked.push({ eventId: event.id, message: String(error.message) });
      continue;
    }
    steps.push(step("validate", [
      `通过 alpha-v0.9.7 严格校验（${Object.keys(validated).length} 个字段）`,
    ], true, { eventId: event.id }));

    let push = null;
    if (validated.delivery_action === "PUSH") {
      push = {
        id: state.nextPushId++,
        project_key: validated.project_key,
        project_name: validated.project_name,
        fact: event.fact,
        decision: validated.decision,
        change_type: validated.change_type,
        opportunity_type: validated.opportunity_type,
        evidence_count: validated.evidence.length,
        channel: "simulated-push",
      };
      state.pushes.push(push);
      state.outbox.push({ ...push, delivered: false });
      pushes.push(push);
    } else if (validated.decision === "QUALIFIED_ALPHA") {
      suppressed.push({ eventId: event.id, change_type: validated.change_type });
    } else if (validated.decision === "UNRESOLVED") {
      pending.push({ eventId: event.id, decision: validated.decision });
    } else {
      rejected.push({ eventId: event.id, decision: validated.decision });
    }
    steps.push(deliverStep(validated, push));
    cards.push(validated);
  }

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    summary: scenario.summary,
    steps,
    cards,
    pushes,
    suppressed,
    pending,
    rejected,
    blocked: state.blocked.filter((item) => scenario.events.some((e) => e.id === item.eventId)),
  };
}

// 只统计"已经展示到光标位置"的结果：单步推进时进度条不会提前亮出全场数字。
// 计数完全从步骤数据推出来，不读 run.pushes / run.suppressed 等整场汇总。
export function tallyShownSteps(steps, cursor) {
  const list = Array.isArray(steps) ? steps : [];
  const shown = Math.max(0, Math.min(Number(cursor) || 0, list.length));
  const counts = { steps: 0, pushes: 0, suppressed: 0, pending: 0, rejected: 0, blocked: 0 };
  for (let index = 0; index < shown; index += 1) {
    const item = list[index];
    counts.steps += 1;
    if (item.stage === "validate" && item.ok === false) counts.blocked += 1;
    if (item.stage !== "deliver") continue;
    const outcome = item.data?.outcome;
    if (outcome === "PUSH") counts.pushes += 1;
    else if (outcome === "SUPPRESSED") counts.suppressed += 1;
    else if (outcome === "PENDING") counts.pending += 1;
    else if (outcome === "REJECTED") counts.rejected += 1;
  }
  return counts;
}

// 全部场景共用一个会话：前一场已推过的事实，下一场再来就被抑制，
// 这样"全部场景"跑完能看到跨场景去重，而不是把同一条线索推两遍。
// 单场景入口（CLI --scenario / 页面切换）仍各自新建会话，便于单独演示。
export function runAll() {
  const shared = createState();
  const results = SCENARIOS.map((scenario) => runScenario(scenario, shared));
  const summary = {
    scenarios: results.length,
    pushes: results.reduce((sum, r) => sum + r.pushes.length, 0),
    suppressed: results.reduce((sum, r) => sum + r.suppressed.length, 0),
    pending: results.reduce((sum, r) => sum + r.pending.length, 0),
    rejected: results.reduce((sum, r) => sum + r.rejected.length, 0),
    blocked: results.reduce((sum, r) => sum + r.blocked.length, 0),
    steps: results.reduce((sum, r) => sum + r.steps.length, 0),
  };
  return { results, summary };
}
