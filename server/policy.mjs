// 公开版「合格 ALPHA 判定准则」模块。
// 纯本地、无依赖、无网络。规则是严格 JSON；模型输出只能维持或降级，不能升级。
// 自由文字 instructions 只交给模型参考，机器条件一律在本地强校验。
//
// 导出：
//   validatePolicy(config) -> 冻结的规范化 policy（非法结构抛错）
//   buildPolicyPrompt(policy) -> 给同一模型的提示词字符串
//   applyPolicy(policy, event, result) -> 判定结果（含 status/push/evidence/reasons）

export const POLICY_INVALID = "POLICY_INVALID";
export const EVENT_INVALID = "EVENT_INVALID";
export const MODEL_RESULT_INVALID = "MODEL_RESULT_INVALID";

const DECISIONS = ["QUALIFIED", "UNRESOLVED", "REJECTED"];
const EVENT_KINDS = ["post", "follow"];

const POLICY_KEYS = ["version", "instructions", "post", "follow"];
const RULE_KEYS = [
  "minEvidence",
  "minIndependentSources",
  "requireOfficialEvidence",
  "minConfidence",
  "allowQualify",
  "allowPush",
];
const EVENT_KEYS = ["id", "kind", "sourceAccount", "text", "evidence"];
const EVIDENCE_KEYS = ["id", "url", "kind", "origin", "official"];
const MODEL_KEYS = [
  "decision",
  "projectKey",
  "title",
  "summary",
  "factKey",
  "confidence",
  "evidenceIds",
];

function fail(code, message) {
  const error = new Error(message);
  error.name =
    code === POLICY_INVALID
      ? "PolicyConfigError"
      : code === EVENT_INVALID
        ? "EventShapeError"
        : "ModelResultError";
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 只接受 JSON 能表达的值，并做深拷贝。不执行任何 getter，也不 eval。
function cloneJson(value, path, code) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    if (!Number.isFinite(value)) fail(code, `${path} 必须是有限数字`);
    return value;
  }
  if (type !== "object") fail(code, `${path} 只能是 JSON 值`);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail(code, `${path} 必须是普通数组`);
    }
    return value.map((item, index) => cloneJson(item, `${path}[${index}]`, code));
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(code, `${path} 必须是普通对象`);
  }
  const copy = {};
  for (const key of Object.keys(value)) {
    if (key === "__proto__") fail(code, `${path}.${key} 是保留键`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail(code, `${path}.${key} 不能是访问器属性`);
    }
    copy[key] = cloneJson(descriptor.value, `${path}.${key}`, code);
  }
  return copy;
}

function assertExactKeys(object, allowed, path, code) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(code, `${path} 不允许未知字段：${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(object, key)) fail(code, `${path} 缺少字段：${key}`);
  }
}

function requireString(value, path, code, { allowEmpty = false, maxLength = 4096 } = {}) {
  if (typeof value !== "string") fail(code, `${path} 必须是字符串`);
  if (!allowEmpty && value.trim() === "") fail(code, `${path} 不能为空`);
  if (value.length > maxLength) fail(code, `${path} 过长`);
  return value;
}

function requireBoolean(value, path, code) {
  if (typeof value !== "boolean") fail(code, `${path} 必须是布尔值`);
  return value;
}

function requireInteger(value, path, code, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(code, `${path} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

function requireConfidence(value, path, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(code, `${path} 必须是 0 到 1 之间的数字`);
  }
  return value;
}

function normalizeRule(value, path) {
  if (!isRecord(value)) fail(POLICY_INVALID, `${path} 必须是对象`);
  assertExactKeys(value, RULE_KEYS, path, POLICY_INVALID);
  return Object.freeze({
    minEvidence: requireInteger(value.minEvidence, `${path}.minEvidence`, POLICY_INVALID, 1, 50),
    minIndependentSources: requireInteger(
      value.minIndependentSources,
      `${path}.minIndependentSources`,
      POLICY_INVALID,
      1,
      50,
    ),
    requireOfficialEvidence: requireBoolean(
      value.requireOfficialEvidence,
      `${path}.requireOfficialEvidence`,
      POLICY_INVALID,
    ),
    minConfidence: requireConfidence(value.minConfidence, `${path}.minConfidence`, POLICY_INVALID),
    allowQualify: requireBoolean(value.allowQualify, `${path}.allowQualify`, POLICY_INVALID),
    allowPush: requireBoolean(value.allowPush, `${path}.allowPush`, POLICY_INVALID),
  });
}

export function validatePolicy(config) {
  const data = cloneJson(config, "policy", POLICY_INVALID);
  if (!isRecord(data)) fail(POLICY_INVALID, "policy 必须是对象");
  assertExactKeys(data, POLICY_KEYS, "policy", POLICY_INVALID);

  const version = requireInteger(data.version, "policy.version", POLICY_INVALID, 1, 1000000);
  const instructions = requireString(data.instructions, "policy.instructions", POLICY_INVALID, {
    allowEmpty: true,
    maxLength: 8000,
  });
  const post = normalizeRule(data.post, "policy.post");
  const follow = normalizeRule(data.follow, "policy.follow");

  return Object.freeze({ version, instructions, post, follow });
}

function validateEvent(event) {
  const data = cloneJson(event, "event", EVENT_INVALID);
  if (!isRecord(data)) fail(EVENT_INVALID, "event 必须是对象");
  assertExactKeys(data, EVENT_KEYS, "event", EVENT_INVALID);

  const kind = data.kind;
  if (!EVENT_KINDS.includes(kind)) fail(EVENT_INVALID, "event.kind 只能是 post 或 follow");
  if (!Array.isArray(data.evidence)) fail(EVENT_INVALID, "event.evidence 必须是数组");

  const seenIds = new Set();
  const evidence = data.evidence.map((item, index) => {
    const path = `event.evidence[${index}]`;
    if (!isRecord(item)) fail(EVENT_INVALID, `${path} 必须是对象`);
    assertExactKeys(item, EVIDENCE_KEYS, path, EVENT_INVALID);

    const id = requireString(item.id, `${path}.id`, EVENT_INVALID, { maxLength: 200 });
    if (seenIds.has(id)) fail(EVENT_INVALID, `${path}.id 重复`);
    seenIds.add(id);

    return Object.freeze({
      id,
      url: requireString(item.url, `${path}.url`, EVENT_INVALID, { maxLength: 2048 }),
      kind: requireString(item.kind, `${path}.kind`, EVENT_INVALID, { maxLength: 100 }),
      origin: requireString(item.origin, `${path}.origin`, EVENT_INVALID, { maxLength: 200 }),
      official: requireBoolean(item.official, `${path}.official`, EVENT_INVALID),
    });
  });

  return Object.freeze({
    id: requireString(data.id, "event.id", EVENT_INVALID, { maxLength: 200 }),
    kind,
    sourceAccount: requireString(data.sourceAccount, "event.sourceAccount", EVENT_INVALID, {
      maxLength: 200,
    }),
    text: requireString(data.text, "event.text", EVENT_INVALID, {
      allowEmpty: true,
      maxLength: 8000,
    }),
    evidence: Object.freeze(evidence),
  });
}

function validateModelResult(result) {
  const data = cloneJson(result, "result", MODEL_RESULT_INVALID);
  if (!isRecord(data)) fail(MODEL_RESULT_INVALID, "result 必须是对象");
  assertExactKeys(data, MODEL_KEYS, "result", MODEL_RESULT_INVALID);

  const decision = data.decision;
  if (!DECISIONS.includes(decision)) {
    fail(MODEL_RESULT_INVALID, "result.decision 只能是 QUALIFIED、UNRESOLVED 或 REJECTED");
  }
  if (!Array.isArray(data.evidenceIds)) {
    fail(MODEL_RESULT_INVALID, "result.evidenceIds 必须是数组");
  }

  const evidenceIds = [];
  data.evidenceIds.forEach((value, index) => {
    const id = requireString(value, `result.evidenceIds[${index}]`, MODEL_RESULT_INVALID, {
      maxLength: 200,
    });
    if (!evidenceIds.includes(id)) evidenceIds.push(id);
  });

  return Object.freeze({
    decision,
    projectKey: requireString(data.projectKey, "result.projectKey", MODEL_RESULT_INVALID, {
      allowEmpty: decision !== 'QUALIFIED', maxLength: 64,
    }),
    title: requireString(data.title, "result.title", MODEL_RESULT_INVALID, { maxLength: 300 }),
    summary: requireString(data.summary, "result.summary", MODEL_RESULT_INVALID, {
      allowEmpty: true,
      maxLength: 4000,
    }),
    factKey: requireString(data.factKey, "result.factKey", MODEL_RESULT_INVALID, { allowEmpty: decision !== 'QUALIFIED', maxLength: 64 }),
    confidence: requireConfidence(data.confidence, "result.confidence", MODEL_RESULT_INVALID),
    evidenceIds: Object.freeze(evidenceIds),
  });
}

export function applyPolicy(policy, event, result) {
  const validated = validatePolicy(policy);
  const ev = validateEvent(event);
  const model = validateModelResult(result);
  const rule = validated[ev.kind];
  const reasons = [];

  // 证据条数与独立来源是两个阈值。相同 URL 只算一次，相同 origin 只算一个来源。
  const unique = (items) => [...new Map(items.map(item => [item.url.trim(),item])).values()];
  const sourceCount = (items) => new Set(items.map(item => item.origin.trim().toLowerCase())).size;
  const eligible = unique(ev.evidence);
  const cited = new Set(model.evidenceIds);
  const citedEligible = unique(ev.evidence.filter((item) => cited.has(item.id)));
  const eventIds = new Set(ev.evidence.map((item) => item.id));
  const fabricated = model.evidenceIds.some((id) => !eventIds.has(id));
  const citedSources = sourceCount(citedEligible);

  const unmet = [];
  if (citedEligible.length < rule.minEvidence) {
    unmet.push(`引用的证据条数 ${citedEligible.length} 少于规则要求的 ${rule.minEvidence}`);
  }
  if (citedSources < rule.minIndependentSources) {
    unmet.push(`引用的独立来源 ${citedSources} 个，少于规则要求的 ${rule.minIndependentSources} 个（同 origin 只算一个）`);
  }
  if (rule.requireOfficialEvidence && !citedEligible.some(item=>item.official)) {
    unmet.push('规则要求至少引用一条经运营者认可的官方证据');
  }
  if (model.confidence < rule.minConfidence) {
    unmet.push(`模型置信度 ${model.confidence} 低于规则要求的 ${rule.minConfidence}`);
  }
  if (model.decision === "QUALIFIED" && !rule.allowQualify) {
    unmet.push("该事件类型规则不允许直接标为合格");
  }

  let status;
  if (model.decision === "REJECTED") {
    status = "REJECTED";
    reasons.push("模型判定 REJECTED；本地只维持或降级，不做升级");
  } else if (model.decision === "UNRESOLVED") {
    status = "UNRESOLVED";
    reasons.push("模型判定 UNRESOLVED；本地不会升级为合格");
  } else if (fabricated) {
    status = "UNRESOLVED";
    reasons.push('模型引用了事件中不存在的证据；按证据不足处理');
  } else if (unmet.length > 0) {
    status = "UNRESOLVED";
    reasons.push(...unmet);
  } else {
    status = "QUALIFIED";
    reasons.push("模型判定 QUALIFIED，且本地机器条件全部通过");
  }

  const push = status === "QUALIFIED" && rule.allowPush;
  if (status === "QUALIFIED" && !rule.allowPush) {
    reasons.push("规则禁止推送：保留合格判定，但不 push");
  }

  const chosen = status === "QUALIFIED" ? citedEligible : eligible;
  const evidence = chosen.map((item) => Object.freeze({ ...item }));

  return {
    status,
    push,
    projectKey: model.projectKey,
    factKey: model.factKey,
    title: model.title,
    summary: model.summary,
    reasons,
    evidence,
    confidence: model.confidence,
  };
}

function describeRule(kind, rule) {
  const official = rule.requireOfficialEvidence
    ? "至少一条证据必须有 official 标记"
    : "不要求 official 证据";
  const qualify = rule.allowQualify
    ? "允许给出 QUALIFIED"
    : "不允许给出 QUALIFIED，只能 UNRESOLVED 或 REJECTED";
  const push = rule.allowPush ? "允许推送" : "即使合格也不推送";
  return `- ${kind}：证据 ≥ ${rule.minEvidence} 条；独立来源 ≥ ${rule.minIndependentSources} 个（同 origin 只算一个）；${official}；confidence ≥ ${rule.minConfidence}；${qualify}；${push}。`;
}

export function buildPolicyPrompt(policy) {
  const validated = validatePolicy(policy);

  return [
    "你是 ALPHA 情报判定模型，正在判定一条事件是否够格成为合格 ALPHA。",
    "只输出一个 JSON 对象；不要输出解释、前后缀或 Markdown 代码块。",
    "",
    "## 运营者自由规则",
    validated.instructions.trim() === "" ? "（无额外规则）" : validated.instructions,
    "",
    "## 事件输入",
    "字段：id、kind（post 或 follow）、sourceAccount、text、evidence[]。",
    "evidence[] 每项含 id、url、kind、origin、official。",
    "origin 是采集器给的来源标识，用于独立来源去重；official 只由运营者或采集器认定，你不能自己声明。",
    "",
    "## 本地机器强校验（模型不能修改，也不由模型判断）",
    describeRule("post", validated.post),
    describeRule("follow", validated.follow),
    "",
    "## 输出合同",
    "{",
    '  "decision": "QUALIFIED 或 UNRESOLVED 或 REJECTED",',
    '  "projectKey": "稳定的项目键",',
    '  "title": "一句话标题",',
    '  "summary": "两三句摘要",',
    '  "factKey": "事实指纹，同项目同事实保持不变",',
    '  "confidence": 0.0,',
    '  "evidenceIds": ["只能取自事件 evidence[].id"]',
    "}",
    "",
    "## 硬性要求",
    "- evidenceIds 只能填事件 evidence[].id 里真实存在的值，不许编造。",
    "- 同一 origin 的多条证据只算一个独立来源；重复引用不会补足证据。",
    "- 证据条数、独立来源、official 或置信度不够时给 UNRESOLVED，不要硬凑合格。",
    "- 本地会用同一套规则复核；即使你给 QUALIFIED，也绕不过机器条件。",
    "- 规则不允许合格的事件类型，请直接给 UNRESOLVED 或 REJECTED。",
  ].join("\n");
}
