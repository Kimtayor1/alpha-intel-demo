// 公开版判定准则模块测试：纯本地、无网络、无依赖。
// 运行：node --test test/policy.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validatePolicy,
  buildPolicyPrompt,
  applyPolicy,
  POLICY_INVALID,
  EVENT_INVALID,
  MODEL_RESULT_INVALID,
} from "../server/policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(ROOT,'config','policy.example.json'),'utf8'));
const EXAMPLE = { ...TEMPLATE, post:{...TEMPLATE.post,minEvidence:2,minIndependentSources:2} };
test('开箱示例允许一条明确标记为正式来源的推文',()=>{
  const result=applyPolicy(TEMPLATE,makeEvent({evidence:[makeEvent().evidence[0]]}),makeResult({evidenceIds:['e1']}));
  assert.equal(result.push,true);
});

const clone = (value) => JSON.parse(JSON.stringify(value));

function makeEvent(overrides = {}) {
  return {
    id: "evt-demo-1",
    kind: "post",
    sourceAccount: "fictitious_watch",
    text: "虚构项目 X 发布测试网任务",
    evidence: [
      {
        id: "e1",
        url: "https://x.com/fictitious_a/status/1",
        kind: "post",
        origin: "x:fictitious_a",
        official: true,
      },
      {
        id: "e2",
        url: "https://docs.example.invalid/x",
        kind: "doc",
        origin: "docs.example.invalid",
        official: false,
      },
    ],
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    decision: "QUALIFIED",
    projectKey: "proj-x",
    title: "虚构项目 X 测试网",
    summary: "测试网任务开放，规则写清楚了参与方式。",
    factKey: "fact-x-testnet",
    confidence: 0.82,
    evidenceIds: ["e1", "e2"],
    ...overrides,
  };
}

test("示例政策通过严格校验，并且返回冻结对象", () => {
  const validated = validatePolicy(EXAMPLE);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.post));
  assert.ok(Object.isFrozen(validated.follow));
  assert.equal(validated.version, 1);
  assert.equal(validated.post.minEvidence, 2);
  assert.equal(validated.follow.allowPush, false);
});

test("两套不同规则对同一事件给出不同结果", () => {
  const strict = clone(EXAMPLE);
  strict.post.minIndependentSources = 3;

  const relaxed = clone(EXAMPLE);

  const strictResult = applyPolicy(strict, makeEvent(), makeResult());
  const relaxedResult = applyPolicy(relaxed, makeEvent(), makeResult());

  assert.equal(strictResult.status, "UNRESOLVED");
  assert.equal(strictResult.push, false);
  assert.ok(strictResult.reasons.join(" ").includes("独立来源"));

  assert.equal(relaxedResult.status, "QUALIFIED");
  assert.equal(relaxedResult.push, true);
  assert.equal(relaxedResult.evidence.length, 2);
});

test("follow 规则可以标合格，但默认禁推送", () => {
  const result = applyPolicy(EXAMPLE, makeEvent({ kind: "follow" }), makeResult());

  assert.equal(result.status, "QUALIFIED");
  assert.equal(result.push, false);
  assert.ok(result.reasons.join(" ").includes("禁止推送"));
});

test("证据不足：模型给 QUALIFIED 也不能 push", () => {
  const event = makeEvent({
    evidence: [
      {
        id: "e1",
        url: "https://x.com/fictitious_a/status/1",
        kind: "post",
        origin: "x:fictitious_a",
        official: true,
      },
    ],
  });
  const result = applyPolicy(EXAMPLE, event, makeResult({ evidenceIds: ["e1"] }));

  assert.equal(result.status, "UNRESOLVED");
  assert.equal(result.push, false);
  assert.ok(result.reasons.join(" ").includes("证据条数"));
});

test("伪造 evidenceIds 不能补足证据，也不会出现在结果里", () => {
  const result = applyPolicy(
    EXAMPLE,
    makeEvent(),
    makeResult({ evidenceIds: ["e1", "e2", "ghost-1"] }),
  );

  assert.equal(result.status, "UNRESOLVED");
  assert.equal(result.push, false);
  assert.deepEqual(result.evidence.map((item) => item.id), ["e1", "e2"]);
  assert.match(result.reasons.join(' '), /不存在的证据/u);
  assert.doesNotMatch(result.reasons.join(' '), /ghost-1/u);
});

test("重复 origin 只算一个独立来源，不补证据条数", () => {
  const event = makeEvent({
    evidence: [
      {
        id: "e1",
        url: "https://x.com/fictitious_a/status/1",
        kind: "post",
        origin: "x:fictitious_a",
        official: true,
      },
      {
        id: "e2",
        url: "https://mirror.example.invalid/x",
        kind: "repost",
        origin: " X:Fictitious_A ",
        official: false,
      },
    ],
  });
  const result = applyPolicy(EXAMPLE, event, makeResult({ evidenceIds: ["e1", "e2"] }));

  assert.equal(result.status, "UNRESOLVED");
  assert.equal(result.push, false);
  assert.equal(result.evidence.length, 2);
  assert.ok(result.reasons.join(" ").includes("独立来源"));
});

test("提示词拼接：带入自由文字与两套机器规则，且可重复生成", () => {
  const prompt = buildPolicyPrompt(EXAMPLE);

  assert.ok(prompt.startsWith("你是 ALPHA 情报判定模型"));
  assert.ok(prompt.includes(EXAMPLE.instructions));
  assert.ok(prompt.includes("证据 ≥ 2 条"));
  assert.ok(prompt.includes("独立来源 ≥ 2 个"));
  assert.ok(prompt.includes("至少一条证据必须有 official 标记"));
  assert.ok(prompt.includes("即使合格也不推送"));
  assert.ok(prompt.includes('"evidenceIds"'));
  assert.ok(!prompt.includes("undefined"));
  assert.equal(prompt, buildPolicyPrompt(clone(EXAMPLE)));
});

test("自由文字不会被执行，模块源码不含 eval / new Function", () => {
  const injected = clone(EXAMPLE);
  injected.instructions = "globalThis.__ALPHA_PWNED__ = true;";

  const prompt = buildPolicyPrompt(injected);
  assert.ok(prompt.includes("globalThis.__ALPHA_PWNED__ = true;"));
  assert.equal(globalThis.__ALPHA_PWNED__, undefined);

  applyPolicy(injected, makeEvent(), makeResult());
  assert.equal(globalThis.__ALPHA_PWNED__, undefined);

  const source = fs.readFileSync(path.join(ROOT, "server", "policy.mjs"), "utf8");
  assert.ok(!/\beval\s*\(/.test(source));
  assert.ok(!/new\s+Function\s*\(/.test(source));
});

test("非法模型结构抛错，且错误信息不带模型内容", () => {
  const sentinel = "SECRET_SENTINEL_9f2";
  const missingSummary = makeResult();
  delete missingSummary.summary;

  const badCases = [
    makeResult({ decision: "MAYBE", title: sentinel }),
    makeResult({ extra: sentinel, title: sentinel }),
    makeResult({ confidence: 1.5, title: sentinel }),
    makeResult({ evidenceIds: "e1", title: sentinel }),
    missingSummary,
  ];

  for (const bad of badCases) {
    assert.throws(
      () => applyPolicy(EXAMPLE, makeEvent(), bad),
      (error) => {
        assert.equal(error.code, MODEL_RESULT_INVALID);
        assert.ok(!error.message.includes(sentinel));
        return true;
      },
    );
  }

  // 合法结构里的自由文字不参与校验，也不会被当成错误。
  const normal = applyPolicy(EXAMPLE, makeEvent(), makeResult({ title: sentinel }));
  assert.equal(normal.status, "QUALIFIED");
});

test("规则是严格 JSON：未知字段、缺字段、错类型、保留键一律拒绝", () => {
  const unknownTop = { ...clone(EXAMPLE), thresholds: {} };

  const missingField = clone(EXAMPLE);
  delete missingField.post.allowPush;

  const wrongType = clone(EXAMPLE);
  wrongType.post.allowPush = "yes";

  const zeroEvidence = clone(EXAMPLE);
  zeroEvidence.follow.minEvidence = 0;

  const badConfidence = clone(EXAMPLE);
  badConfidence.post.minConfidence = 1.1;

  const reservedKey = JSON.parse(
    '{"version":1,"instructions":"","post":{"minEvidence":2,"minIndependentSources":2,"requireOfficialEvidence":true,"minConfidence":0.5,"allowQualify":true,"allowPush":true,"__proto__":{"polluted":true}},"follow":{"minEvidence":1,"minIndependentSources":1,"requireOfficialEvidence":false,"minConfidence":0.5,"allowQualify":true,"allowPush":false}}',
  );

  for (const config of [unknownTop, missingField, wrongType, zeroEvidence, badConfidence, reservedKey]) {
    assert.throws(
      () => validatePolicy(config),
      (error) => error.code === POLICY_INVALID,
    );
  }
  assert.equal({}.polluted, undefined);
});

test("非法事件结构抛 EVENT_INVALID", () => {
  const duplicateIds = makeEvent({
    evidence: [
      {
        id: "e1",
        url: "https://x.com/fictitious_a/status/1",
        kind: "post",
        origin: "x:a",
        official: true,
      },
      {
        id: "e1",
        url: "https://x.com/fictitious_b/status/2",
        kind: "post",
        origin: "x:b",
        official: false,
      },
    ],
  });

  const badKind = makeEvent({ kind: "reply" });
  const badOfficial = makeEvent({
    evidence: [
      {
        id: "e1",
        url: "https://x.com/fictitious_a/status/1",
        kind: "post",
        origin: "x:a",
        official: "yes",
      },
    ],
  });

  for (const event of [duplicateIds, badKind, badOfficial]) {
    assert.throws(
      () => applyPolicy(EXAMPLE, event, makeResult()),
      (error) => error.code === EVENT_INVALID,
    );
  }
});

test("REJECTED 只维持不升级，即使机器条件全过", () => {
  const result = applyPolicy(EXAMPLE, makeEvent(), makeResult({ decision: "REJECTED" }));

  assert.equal(result.status, "REJECTED");
  assert.equal(result.push, false);
  assert.ok(result.reasons.join(" ").includes("不做升级"));
});

test("规则不允许合格时，模型 QUALIFIED 被降为 UNRESOLVED", () => {
  const policy = clone(EXAMPLE);
  policy.post.allowQualify = false;

  const result = applyPolicy(policy, makeEvent(), makeResult());

  assert.equal(result.status, "UNRESOLVED");
  assert.equal(result.push, false);
  assert.ok(result.reasons.join(" ").includes("不允许直接标为合格"));
});

test("allowPush 为 false 时保留 QUALIFIED 但不推送", () => {
  const policy = clone(EXAMPLE);
  policy.post.allowPush = false;

  const result = applyPolicy(policy, makeEvent(), makeResult());

  assert.equal(result.status, "QUALIFIED");
  assert.equal(result.push, false);
  assert.ok(result.reasons.join(" ").includes("禁止推送"));
});

test("置信度低于门槛不能合格", () => {
  const result = applyPolicy(EXAMPLE, makeEvent(), makeResult({ confidence: 0.5 }));

  assert.equal(result.status, "UNRESOLVED");
  assert.equal(result.push, false);
  assert.ok(result.reasons.join(" ").includes("置信度"));
});

test("official 只能来自事件，模型自报 official 会被拒绝", () => {
  const noOfficial = makeEvent({
    evidence: [
      {
        id: "e1",
        url: "https://x.com/fictitious_a/status/1",
        kind: "post",
        origin: "x:a",
        official: false,
      },
      {
        id: "e2",
        url: "https://docs.example.invalid/x",
        kind: "doc",
        origin: "docs.example.invalid",
        official: false,
      },
    ],
  });
  const gate = applyPolicy(EXAMPLE, noOfficial, makeResult());
  assert.equal(gate.status, "UNRESOLVED");
  assert.ok(gate.reasons.join(" ").includes("官方"));

  assert.throws(
    () => applyPolicy(EXAMPLE, makeEvent(), makeResult({ official: true })),
    (error) => error.code === MODEL_RESULT_INVALID,
  );
});

test("applyPolicy 不修改传入的 policy、event、result", () => {
  const policy = clone(EXAMPLE);
  const event = makeEvent();
  const result = makeResult();
  const before = JSON.stringify({ policy, event, result });

  applyPolicy(policy, event, result);

  assert.equal(JSON.stringify({ policy, event, result }), before);
});

test("合格结果字段齐全，证据保留事件里的 origin 与 official", () => {
  const result = applyPolicy(EXAMPLE, makeEvent(), makeResult());

  assert.deepEqual(Object.keys(result).sort(), [
    "confidence",
    "evidence",
    "factKey",
    "projectKey",
    "push",
    "reasons",
    "status",
    "summary",
    "title",
  ]);
  assert.equal(result.projectKey, "proj-x");
  assert.equal(result.factKey, "fact-x-testnet");
  assert.equal(result.confidence, 0.82);
  assert.equal(result.evidence[0].origin, "x:fictitious_a");
  assert.equal(result.evidence[0].official, true);
  assert.equal(result.evidence[1].official, false);
});
