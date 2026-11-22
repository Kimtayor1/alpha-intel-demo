// 浏览器入口：只做渲染与交互，流程逻辑全在 ./lib/pipeline.js。
// 无网络请求、无外部资源、无追踪。证据里的 URL 一律当纯文本渲染（textContent），不做可点链接。

import { SCENARIOS, scenarioById } from "./lib/fixtures.js";
import { POLICY_VERSION, runAll, runScenario, createState, tallyShownSteps } from "./lib/pipeline.js";

const tabsBox = document.getElementById("scenario-tabs");
const eventsBox = document.getElementById("events");
const stepsBox = document.getElementById("steps");
const cardsBox = document.getElementById("cards");
const outboxBox = document.getElementById("outbox");
const progressBox = document.getElementById("progress");
const summaryBox = document.getElementById("summary");
const btnStep = document.getElementById("btn-step");
const btnAll = document.getElementById("btn-all");
const btnReplay = document.getElementById("btn-replay");
const btnSummary = document.getElementById("btn-summary");

const view = {
  scenarioId: SCENARIOS[0].id,
  run: null,
  cursor: 0,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function splitEvidence(item) {
  const marker = item.lastIndexOf(" | ");
  if (marker === -1) return { summary: item, url: null };
  return { summary: item.slice(0, marker), url: item.slice(marker + 3) };
}

function renderTabs() {
  tabsBox.replaceChildren();
  for (const scenario of SCENARIOS) {
    const button = el("button", "tab");
    button.type = "button";
    button.append(el("span", null, scenario.title));
    button.append(el("span", "pill", scenario.badge));
    button.setAttribute("aria-pressed", String(scenario.id === view.scenarioId));
    button.addEventListener("click", () => {
      view.scenarioId = scenario.id;
      startScenario();
    });
    tabsBox.append(button);
  }
}

function renderEvents() {
  const scenario = scenarioById(view.scenarioId);
  eventsBox.replaceChildren();
  for (const event of scenario.events) {
    const box = el("article", "event");
    box.append(el("div", "title", `${event.id} · ${event.label}`));
    const meta = el("div", "meta");
    meta.textContent = `项目：${event.project?.name ?? "（未识别）"} · 事实指纹：${event.fact ?? "（无）"} · 类型：${event.kind}`;
    box.append(meta);
    const evidence = event.evidence ?? [];
    if (evidence.length > 0) {
      const list = el("ul", "evidence");
      for (const item of evidence) {
        const { summary, url } = splitEvidence(item);
        const li = el("li", null, summary);
        if (url) {
          li.append(document.createTextNode(" · "));
          li.append(el("code", null, url));
        }
        list.append(li);
      }
      box.append(list);
    }
    eventsBox.append(box);
  }
}

function renderSteps() {
  stepsBox.replaceChildren();
  view.run.steps.forEach((step, index) => {
    const done = index < view.cursor;
    const row = el("div", `step ${done ? (step.ok ? "ok" : "bad") : "pending"}`);
    row.append(el("div", "step-title", `${index + 1}. ${step.title}`));
    const list = el("ul");
    const lines = done ? step.lines : ["待执行"];
    for (const line of lines) list.append(el("li", null, line));
    row.append(list);
    stepsBox.append(row);
  });
}

function renderCards() {
  const cardIndexByStep = new Map();
  let counter = 0;
  view.run.steps.forEach((step, index) => {
    if (step.stage === "validate" && step.ok) {
      cardIndexByStep.set(index, counter);
      counter += 1;
    }
  });

  cardsBox.replaceChildren();
  let shown = 0;
  view.run.steps.forEach((step, index) => {
    if (!cardIndexByStep.has(index) || index >= view.cursor) return;
    const card = view.run.cards[cardIndexByStep.get(index)];
    if (!card) return;
    shown += 1;
    const cls = card.delivery_action === "PUSH"
      ? "push"
      : card.decision === "QUALIFIED_ALPHA"
        ? "nopush"
        : card.decision === "UNRESOLVED"
          ? "pending-card"
          : "bad";
    const box = el("article", `card ${cls}`);
    box.append(el("h3", null, card.project_name ?? "（未命名线索）"));

    const badges = el("div", "badges");
    badges.append(el("span", `badge ${cls}`, card.decision));
    badges.append(el("span", "badge", `delivery=${card.delivery_action}`));
    badges.append(el("span", "badge", `change_type=${card.change_type}`));
    if (card.qualification_path) badges.append(el("span", "badge", `path=${card.qualification_path}`));
    box.append(badges);

    const dl = el("dl", "kv");
    const rows = [
      ["机会类型", card.opportunity_type ?? "null"],
      ["机会状态", card.opportunity_status ?? "null"],
      ["来源置信", card.source_confidence ?? "null"],
      ["变化摘要", card.opportunity_delta ?? "null"],
      ["建议动作", card.user_action ?? "null"],
      ["为何现在", card.why_now ?? "null"],
      ["需研究", String(card.research_required)],
      ["命中历史推送", JSON.stringify(card.matched_prior_push_ids)],
      ["拒绝原因", card.reject_reason ?? "null"],
      ["过期时间", card.expires_at ?? "null"],
    ];
    for (const [key, value] of rows) {
      dl.append(el("dt", null, key));
      dl.append(el("dd", null, value));
    }
    box.append(dl);

    if (card.evidence.length > 0) {
      box.append(el("div", "meta", `证据（${card.evidence.length} 条，纯文本展示，不可点击）`));
      const list = el("ul", "evidence");
      for (const item of card.evidence) {
        const { summary, url } = splitEvidence(item);
        const li = el("li", null, summary);
        if (url) {
          li.append(document.createTextNode(" · "));
          li.append(el("code", null, url));
        }
        list.append(li);
      }
      box.append(list);
    }
    cardsBox.append(box);
  });

  if (shown === 0) cardsBox.append(el("p", "empty", "还没有卡片：点「单步」推进到校验阶段。"));
}

function renderOutbox() {
  const visible = [];
  view.run.steps.forEach((step, index) => {
    if (step.stage !== "deliver" || index >= view.cursor || !step.data?.pushId) return;
    const push = view.run.pushes.find((item) => item.id === step.data.pushId);
    if (push) visible.push(push);
  });
  outboxBox.replaceChildren();
  if (visible.length === 0) {
    outboxBox.append(el("p", "empty", "模拟发件箱为空：还没有允许推送的卡片。"));
    return;
  }
  for (const push of visible) {
    const row = el("div", "push-row");
    row.append(el("span", "id", `#${push.id}`));
    row.append(el("span", null, push.project_name ?? "（未命名）"));
    row.append(el("span", null, push.change_type));
    row.append(el("span", null, `${push.evidence_count} 条证据`));
    row.append(el("span", "state", "未投递（模拟）"));
    outboxBox.append(row);
  }
}

function renderProgress() {
  const total = view.run.steps.length;
  const shown = Math.min(view.cursor, total);
  // 只算已经展示的步骤：单步推进时不会提前亮出整场结果。
  const counts = tallyShownSteps(view.run.steps, shown);
  progressBox.textContent = `步骤 ${counts.steps}/${total} · 推送 ${counts.pushes}`
    + ` · 抑制 ${counts.suppressed} · 待核实 ${counts.pending}`
    + ` · 拒绝 ${counts.rejected}`
    + (counts.blocked > 0 ? ` · 校验阻断 ${counts.blocked}` : "");
  btnStep.disabled = shown >= total;
  btnAll.disabled = shown >= total;
}

function render() {
  renderProgress();
  renderSteps();
  renderCards();
  renderOutbox();
}

function startScenario() {
  const scenario = scenarioById(view.scenarioId);
  view.run = runScenario(scenario, createState());
  view.cursor = 0;
  summaryBox.hidden = true;
  renderTabs();
  renderEvents();
  render();
}

btnStep.addEventListener("click", () => {
  view.cursor = Math.min(view.cursor + 1, view.run.steps.length);
  render();
});

btnAll.addEventListener("click", () => {
  view.cursor = view.run.steps.length;
  render();
});

btnReplay.addEventListener("click", () => {
  startScenario();
});

btnSummary.addEventListener("click", () => {
  if (!summaryBox.hidden) {
    summaryBox.hidden = true;
    return;
  }
  const { results, summary } = runAll();
  summaryBox.replaceChildren();
  const table = el("table");
  const head = el("thead");
  const headRow = el("tr");
  for (const label of ["场景", "推送", "抑制", "待核实", "拒绝", "校验阻断"]) {
    headRow.append(el("th", null, label));
  }
  head.append(headRow);
  table.append(head);
  const body = el("tbody");
  for (const result of results) {
    const row = el("tr");
    row.append(el("td", null, result.title));
    row.append(el("td", null, result.pushes.length));
    row.append(el("td", null, result.suppressed.length));
    row.append(el("td", null, result.pending.length));
    row.append(el("td", null, result.rejected.length));
    row.append(el("td", null, result.blocked.length));
    body.append(row);
  }
  const totalRow = el("tr");
  totalRow.append(el("td", null, `合计（${POLICY_VERSION}）`));
  totalRow.append(el("td", null, summary.pushes));
  totalRow.append(el("td", null, summary.suppressed));
  totalRow.append(el("td", null, summary.pending));
  totalRow.append(el("td", null, summary.rejected));
  totalRow.append(el("td", null, summary.blocked));
  body.append(totalRow);
  table.append(body);
  summaryBox.append(table);
  summaryBox.hidden = false;
});

startScenario();
