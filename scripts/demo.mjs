// CLI：跑同一条 pipeline，打印步骤、卡片与模拟发件箱。
// 用法：
//   node scripts/demo.mjs               全部场景
//   node scripts/demo.mjs --scenario S2-duplicate
//   node scripts/demo.mjs --json        机器可读
// 不联网、不读环境变量、不写任何文件。

import { runAll, runScenario, createState, DEMO_NOTICE, POLICY_VERSION } from "../docs/lib/pipeline.js";
import { SCENARIOS, scenarioById } from "../docs/lib/fixtures.js";

const argv = process.argv.slice(2);
const jsonMode = argv.includes("--json");
const scenarioArg = argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1]
  ?? (argv.includes("--scenario") ? argv[argv.indexOf("--scenario") + 1] : null);

const flag = (text) => `[${text}]`;

function printScenarioText(result) {
  const lines = [];
  lines.push(`== ${result.scenarioId} ${result.title}`);
  lines.push(`   ${result.summary}`);
  for (const item of result.steps) {
    lines.push(`   ${item.title}`);
    for (const line of item.lines) {
      lines.push(`     ${item.ok ? "-" : "×"} ${line}`);
    }
  }
  for (const card of result.cards) {
    const bits = [
      `decision=${card.decision}`,
      `qualified=${card.qualified}`,
      `delivery=${card.delivery_action}`,
      `change_type=${card.change_type}`,
      `matched=${JSON.stringify(card.matched_prior_push_ids)}`,
      `evidence=${card.evidence.length}`,
    ];
    lines.push(`   ${flag("卡片")} ${bits.join(" ")}`);
  }
  for (const push of result.pushes) {
    lines.push(`   ${flag("模拟推送")} #${push.id} ${push.project_name ?? "（未命名）"} / ${push.change_type}`);
  }
  if (result.suppressed.length > 0) {
    lines.push(`   ${flag("已抑制")} ${result.suppressed.map((s) => s.change_type).join(", ")}`);
  }
  if (result.pending.length > 0) {
    lines.push(`   ${flag("待核实")} ${result.pending.length} 条`);
  }
  if (result.rejected.length > 0) {
    lines.push(`   ${flag("已拒绝")} ${result.rejected.length} 条`);
  }
  if (result.blocked.length > 0) {
    lines.push(`   ${flag("被严格校验阻断")} ${result.blocked.map((b) => b.message).join(" | ")}`);
  }
  return lines;
}

function main() {
  if (argv.includes("--list")) {
    for (const scenario of SCENARIOS) console.log(`${scenario.id}\t${scenario.title}`);
    return 0;
  }

  if (scenarioArg) {
    const scenario = scenarioById(scenarioArg);
    if (!scenario) {
      console.error(`未知场景：${scenarioArg}。可用：${SCENARIOS.map((s) => s.id).join(", ")}`);
      return 2;
    }
    const result = runScenario(scenario, createState());
    if (jsonMode) {
      console.log(JSON.stringify({ policy_version: POLICY_VERSION, notice: DEMO_NOTICE, results: [result] }, null, 2));
    } else {
      console.log(`ALPHA 情报流水线 · 离线演示（${POLICY_VERSION}）`);
      console.log(`注意：${DEMO_NOTICE}`);
      for (const line of printScenarioText(result)) console.log(line);
    }
    return result.blocked.length > 0 ? 1 : 0;
  }

  const { results, summary } = runAll();
  if (jsonMode) {
    console.log(JSON.stringify({ policy_version: POLICY_VERSION, notice: DEMO_NOTICE, summary, results }, null, 2));
  } else {
    console.log(`ALPHA 情报流水线 · 离线演示（${POLICY_VERSION}）`);
    console.log(`注意：${DEMO_NOTICE}`);
    console.log("数据：纯合成事件；审核为本地规则 mock，不是 AI 模型；无网络、无接口、无外部 CDN。");
    for (const result of results) {
      console.log("");
      for (const line of printScenarioText(result)) console.log(line);
    }
    console.log("");
    console.log(`模拟发件箱：${summary.pushes} 条（全部未投递，delivered=false）`);
    console.log(
      `汇总：场景 ${summary.scenarios} · 推送 ${summary.pushes} · 抑制 ${summary.suppressed}`
      + ` · 待核实 ${summary.pending} · 拒绝 ${summary.rejected} · 校验阻断 ${summary.blocked} · 步骤 ${summary.steps}`,
    );
  }
  return summary.blocked > 0 ? 1 : 0;
}

process.exitCode = main();
