export const POLICY_VERSION = "alpha-v0.9.7";

export const DECISIONS = Object.freeze([
  "QUALIFIED_ALPHA",
  "UNRESOLVED",
  "HOLDING_RISK_ALERT",
  "SECURITY_QUARANTINE",
  "REJECTED",
]);

export const DELIVERY_ACTIONS = Object.freeze(["PUSH", "NO_PUSH"]);
export const CHANGE_TYPES = Object.freeze([
  "NEW_PROJECT",
  "NEW_FACT",
  "NEW_OPPORTUNITY",
  "NEW_ATTENTION_SIGNAL",
  "MATERIAL_UPDATE",
  "REOPENED_OR_UPDATED",
  "DIFFERENT_PROJECT",
  "SAME_PROJECT_SAME_FACT",
  "SAME_EVENT_REPHRASED",
  "NO_MATERIAL_CHANGE",
  "NOT_APPLICABLE",
]);
export const PUSH_CHANGE_TYPES = Object.freeze([
  "NEW_PROJECT",
  "NEW_FACT",
  "NEW_OPPORTUNITY",
  "NEW_ATTENTION_SIGNAL",
  "MATERIAL_UPDATE",
  "REOPENED_OR_UPDATED",
  "DIFFERENT_PROJECT",
]);
export const NO_PUSH_CHANGE_TYPES = Object.freeze([
  "SAME_PROJECT_SAME_FACT",
  "SAME_EVENT_REPHRASED",
  "NO_MATERIAL_CHANGE",
]);

export const OPPORTUNITY_TYPES = Object.freeze([
  "claim", "mint", "waitlist", "early_discovery", "background_backed_early_discovery",
  "attention_signal", "arbitrage", "qualification", "developer_reward", "early_trade", "participation",
]);
export const QUALIFICATION_PATHS = Object.freeze([
  "innovation", "strong_background", "notable_attention",
]);
export const INNOVATION_TYPES = Object.freeze([
  "new_narrative", "new_mechanism", "new_technology", "new_product_capability",
  "new_economic_structure", "new_opportunity_structure", "new_protocol", "new_model",
  "new_chain", "new_project",
]);
export const BACKGROUND_RELATIONSHIPS = Object.freeze([
  "founded_by", "launched_by", "incubated_by", "invested_by",
  "officially_backed_by", "core_team", "advisor",
]);
export const ATTENTION_TYPES = Object.freeze([
  "follow", "mention", "quote", "retweet", "reply", "official_interaction",
]);
export const SOURCE_CONFIDENCE = Object.freeze(["CONFIRMED", "SUPPORTED", "UNVERIFIED"]);
export const OPPORTUNITY_STATUSES = Object.freeze(["OPEN", "NOT_STARTED", "ENDED", "UNKNOWN"]);

const QUALIFICATION_DETAIL_KEYS = Object.freeze([
  "qualification_path", "innovation_type", "innovation_summary", "differentiation",
  "opportunity_basis", "background_entity", "background_relationship",
  "background_strength", "background_evidence", "attention_actor", "attention_type",
  "attention_summary", "attention_evidence",
]);
const DEDUP_KEYS = Object.freeze([
  "delivery_action", "change_type", "matched_prior_push_ids", "same_project",
  "same_fact", "material_difference",
]);
const REQUIRED_KEYS = Object.freeze([
  "decision", "qualified", "project_key", "project_name", "opportunity_type",
  "opportunity_delta", "opportunity_status", "user_action", "why_now", "executable", "source_confidence",
  ...QUALIFICATION_DETAIL_KEYS,
  "chain_candidates", "contract_addresses", "evidence", "expires_at", "reject_reason",
  "research_required", ...DEDUP_KEYS, "policy_version",
]);
const X_URL_PATTERN = /https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s<>"']+/iu;
const URL_PATTERN = /https:\/\/[^\s<>"']+/iu;

function fail(message) {
  throw new Error(`Invalid ${POLICY_VERSION} decision: ${message}`);
}

function nullableString(value, name, maximum = 2000) {
  if (value === null) return;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    fail(`${name} must be null or a non-empty string up to ${maximum} characters`);
  }
}

function stringArray(value, name, { maximumItems = 20, allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.length > maximumItems || (!allowEmpty && value.length === 0)) {
    fail(`${name} must be an array with ${allowEmpty ? "0" : "1"}-${maximumItems} items`);
  }
  if (value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 3000)) {
    fail(`${name} items must be non-empty strings`);
  }
  if (new Set(value).size !== value.length) fail(`${name} must not contain duplicates`);
}

function integerArray(value, name, maximumItems = 20) {
  if (!Array.isArray(value) || value.length > maximumItems
    || value.some((item) => !Number.isInteger(item) || item <= 0)) {
    fail(`${name} must be an array of positive integers with at most ${maximumItems} items`);
  }
  if (new Set(value).size !== value.length) fail(`${name} must not contain duplicates`);
}

function requireFields(input, fields, path) {
  for (const field of fields) {
    if (input[field] === null) fail(`${path} requires ${field}`);
  }
}

function requireNullFields(input, fields, path) {
  for (const field of fields) {
    if (input[field] !== null) fail(`${path} requires ${field}=null`);
  }
}

function validateQualificationPath(input) {
  if (!QUALIFICATION_PATHS.includes(input.qualification_path)) {
    fail("QUALIFIED_ALPHA requires a supported qualification_path");
  }
  if (input.qualification_path === "innovation") {
    requireFields(input, ["innovation_type", "innovation_summary"], "innovation path");
    requireNullFields(input, [
      "opportunity_basis", "background_entity", "background_relationship", "background_strength",
      "background_evidence", "attention_actor", "attention_type", "attention_summary", "attention_evidence",
    ], "innovation path");
  } else if (input.qualification_path === "strong_background") {
    requireFields(input, [
      "background_entity", "background_relationship", "background_strength", "background_evidence",
    ], "strong_background path");
    requireNullFields(input, [
      "innovation_type", "innovation_summary", "differentiation", "opportunity_basis",
      "attention_actor", "attention_type", "attention_summary", "attention_evidence",
    ], "strong_background path");
  } else {
    requireFields(input, ["attention_actor", "attention_type", "attention_summary", "attention_evidence"], "notable_attention path");
    requireNullFields(input, [
      "innovation_type", "innovation_summary", "differentiation", "opportunity_basis",
      "background_entity", "background_relationship", "background_strength", "background_evidence",
    ], "notable_attention path");
    if (input.opportunity_type !== "attention_signal") {
      fail("notable_attention path requires opportunity_type=attention_signal");
    }
  }
}

function requireChinese(value, field) {
  if (!/\p{Script=Han}/u.test(String(value ?? ""))) {
    fail(`QUALIFIED_ALPHA ${field} must contain Chinese`);
  }
}

function validateEvidence(input) {
  stringArray(input.evidence, "evidence", {
    maximumItems: 3,
    allowEmpty: new Set(["UNRESOLVED", "REJECTED"]).has(input.decision),
  });
  if (input.decision !== "QUALIFIED_ALPHA") return;
  if (input.evidence.length < 1 || input.evidence.length > 3) {
    fail("QUALIFIED_ALPHA requires 1-3 evidence items");
  }
  for (const item of input.evidence) {
    if (!/\p{Script=Han}/u.test(item)) fail("each QUALIFIED_ALPHA evidence item requires a Chinese summary");
    if (!URL_PATTERN.test(item)) fail("each QUALIFIED_ALPHA evidence item requires a source URL");
  }
  if (!X_URL_PATTERN.test(input.evidence[0])) {
    fail("the primary QUALIFIED_ALPHA evidence item requires its original X source URL");
  }
}

function validateDelivery(input) {
  if (!DELIVERY_ACTIONS.includes(input.delivery_action)) fail("delivery_action is unsupported");
  if (!CHANGE_TYPES.includes(input.change_type)) fail("change_type is unsupported");
  integerArray(input.matched_prior_push_ids, "matched_prior_push_ids");
  if (typeof input.same_project !== "boolean") fail("same_project must be boolean");
  if (typeof input.same_fact !== "boolean") fail("same_fact must be boolean");
  nullableString(input.material_difference, "material_difference");

  if (input.delivery_action === "PUSH") {
    if (input.decision !== "QUALIFIED_ALPHA" || !input.qualified) {
      fail("PUSH requires decision=QUALIFIED_ALPHA and qualified=true");
    }
    if (!PUSH_CHANGE_TYPES.includes(input.change_type)) {
      fail("PUSH requires a push-capable change_type");
    }
  } else if (input.decision === "QUALIFIED_ALPHA") {
    if (!NO_PUSH_CHANGE_TYPES.includes(input.change_type)) {
      fail("qualified NO_PUSH requires a duplicate/no-change change_type");
    }
    if (input.matched_prior_push_ids.length === 0) {
      fail("qualified NO_PUSH requires matched_prior_push_ids");
    }
  } else if (input.change_type !== "NOT_APPLICABLE") {
    fail("non-qualified NO_PUSH requires change_type=NOT_APPLICABLE");
  }
}

function withCompatibilityDefaults(input, requireCurrentFields) {
  if (requireCurrentFields) return input;
  const qualified = input?.decision === "QUALIFIED_ALPHA";
  return {
    attention_actor: null,
    attention_type: null,
    attention_summary: null,
    attention_evidence: null,
    delivery_action: qualified ? "PUSH" : "NO_PUSH",
    change_type: qualified ? "NEW_PROJECT" : "NOT_APPLICABLE",
    matched_prior_push_ids: [],
    same_project: false,
    same_fact: false,
    material_difference: qualified ? (input?.opportunity_delta ?? "legacy current-policy fixture") : null,
    ...input,
  };
}

export function validateAlphaDecision(value, { requireCurrentFields = false } = {}) {
  const input = withCompatibilityDefaults(value, requireCurrentFields);
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("result must be an object");
  const keys = Object.keys(input);
  const missing = REQUIRED_KEYS.filter((key) => !keys.includes(key));
  const unknown = keys.filter((key) => !REQUIRED_KEYS.includes(key));
  if (missing.length > 0) fail(`missing fields: ${missing.join(", ")}`);
  if (unknown.length > 0) fail(`unknown fields: ${unknown.join(", ")}`);
  if (!DECISIONS.includes(input.decision)) fail("decision is unsupported");
  if (typeof input.qualified !== "boolean") fail("qualified must be boolean");
  if (typeof input.executable !== "boolean") fail("executable must be boolean");
  if (typeof input.research_required !== "boolean") fail("research_required must be boolean");
  if (input.policy_version !== POLICY_VERSION) fail(`policy_version must be ${POLICY_VERSION}`);

  nullableString(input.project_key, "project_key", 300);
  nullableString(input.project_name, "project_name", 200);
  nullableString(input.opportunity_delta, "opportunity_delta");
  nullableString(input.user_action, "user_action");
  nullableString(input.why_now, "why_now");
  nullableString(input.reject_reason, "reject_reason");
  nullableString(input.innovation_summary, "innovation_summary");
  nullableString(input.differentiation, "differentiation");
  nullableString(input.opportunity_basis, "opportunity_basis");
  nullableString(input.background_entity, "background_entity", 300);
  nullableString(input.background_strength, "background_strength");
  nullableString(input.background_evidence, "background_evidence", 3000);
  nullableString(input.attention_actor, "attention_actor", 300);
  nullableString(input.attention_summary, "attention_summary");
  nullableString(input.attention_evidence, "attention_evidence", 3000);

  if (input.opportunity_status !== null && !OPPORTUNITY_STATUSES.includes(input.opportunity_status)) fail("opportunity_status is unsupported");
  if (input.opportunity_type !== null && !OPPORTUNITY_TYPES.includes(input.opportunity_type)) fail("opportunity_type is unsupported");
  if (input.qualification_path !== null && !QUALIFICATION_PATHS.includes(input.qualification_path)) fail("qualification_path is unsupported");
  if (input.innovation_type !== null && !INNOVATION_TYPES.includes(input.innovation_type)) fail("innovation_type is unsupported");
  if (input.background_relationship !== null && !BACKGROUND_RELATIONSHIPS.includes(input.background_relationship)) fail("background_relationship is unsupported");
  if (input.attention_type !== null && !ATTENTION_TYPES.includes(input.attention_type)) fail("attention_type is unsupported");
  if (input.source_confidence !== null && !SOURCE_CONFIDENCE.includes(input.source_confidence)) fail("source_confidence is unsupported");
  stringArray(input.chain_candidates, "chain_candidates");
  stringArray(input.contract_addresses, "contract_addresses");
  validateEvidence(input);
  validateDelivery(input);
  if (input.expires_at !== null && !Number.isFinite(new Date(input.expires_at).getTime())) fail("expires_at must be null or an ISO date-time");

  if (input.decision === "QUALIFIED_ALPHA") {
    if (!input.qualified) fail("QUALIFIED_ALPHA must set qualified=true");
    for (const field of [
      "project_key", "project_name", "opportunity_type", "opportunity_delta", "opportunity_status",
      "user_action", "why_now", "source_confidence",
    ]) {
      if (input[field] === null) fail(`QUALIFIED_ALPHA requires ${field}`);
    }
    if (input.opportunity_status === "ENDED") fail("QUALIFIED_ALPHA opportunity_status cannot be ENDED");
    if (input.research_required) fail("QUALIFIED_ALPHA cannot require research");
    if (input.reject_reason !== null) fail("QUALIFIED_ALPHA reject_reason must be null");
    requireChinese(input.opportunity_delta, "opportunity_delta");
    requireChinese(input.user_action, "user_action");
    requireChinese(input.why_now, "why_now");
    validateQualificationPath(input);
  } else {
    if (input.qualified) fail(`${input.decision} must set qualified=false`);
    requireNullFields(input, QUALIFICATION_DETAIL_KEYS, input.decision);
    if (input.decision === "UNRESOLVED") {
      if (!input.research_required) fail("UNRESOLVED must set research_required=true");
      if (input.opportunity_status !== "UNKNOWN") fail("UNRESOLVED opportunity_status must be UNKNOWN");
    } else {
      if (input.research_required) fail(`${input.decision} cannot require research`);
      if (input.reject_reason === null) fail(`${input.decision} requires reject_reason`);
    }
  }
  return Object.freeze(structuredClone(input));
}
