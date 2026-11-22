// 自动化测试：不发外网（只对本机回环自建的预览服务发请求）、不读任何产品环境变量、不装依赖。
// 运行：node --test "test/**/*.test.mjs"（Node 22+）

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createState,
  runScenario,
  runAll,
  validateCard,
  reviewEvent,
  tallyShownSteps,
  STAGE_ORDER,
} from "../docs/lib/pipeline.js";
import { SCENARIOS, scenarioById, DEMO_NOTICE } from "../docs/lib/fixtures.js";
import { validateAlphaDecision, POLICY_VERSION } from "../docs/lib/decision-schema.js";
import { resolveDocRequest, createPreviewServer, parsePort, DOCS_ROOT } from "../scripts/preview.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("流程汇总（单会话跑全部场景）：2 推送 / 2 抑制 / 1 待核实 / 1 拒绝 / 0 阻断", () => {
  const { summary } = runAll();
  assert.equal(summary.scenarios, SCENARIOS.length);
  assert.equal(summary.pushes, 2, "跨场景也不重复推同一条线索");
  assert.equal(summary.suppressed, 2);
  assert.equal(summary.pending, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.blocked, 0);
  assert.ok(summary.steps > 0);
});

test("新情报：走 innovation 路径，严格校验通过并进入模拟发件箱", () => {
  const result = runScenario(scenarioById("S1-new-lead"), createState());
  assert.equal(result.blocked.length, 0);
  assert.equal(result.pushes.length, 1);
  const card = result.cards[0];
  assert.equal(card.decision, "QUALIFIED_ALPHA");
  assert.equal(card.qualification_path, "innovation");
  assert.equal(card.delivery_action, "PUSH");
  assert.equal(card.change_type, "NEW_PROJECT");
  assert.equal(card.policy_version, POLICY_VERSION);
  assert.equal(card.evidence.length, 2);
  assert.ok(card.evidence[0].includes("x.com/"), "首条证据必须是原始 X 来源");
  assert.ok(Object.isFrozen(card), "验证器返回冻结对象");
});

test("独立关注信号：notable_attention 路径单独触发一次推送", () => {
  const result = runScenario(scenarioById("S3-attention-signal"), createState());
  const card = result.cards[0];
  assert.equal(card.qualification_path, "notable_attention");
  assert.equal(card.opportunity_type, "attention_signal");
  assert.equal(card.change_type, "NEW_ATTENTION_SIGNAL");
  assert.equal(card.delivery_action, "PUSH");
  assert.equal(result.pushes.length, 1);
});

test("重复线索不会二次推送", () => {
  const result = runScenario(scenarioById("S2-duplicate"), createState());
  assert.equal(result.pushes.length, 1, "同一事件重述只能推一次");
  assert.equal(result.cards.length, 2);
  const second = result.cards[1];
  assert.equal(second.delivery_action, "NO_PUSH");
  assert.equal(second.change_type, "SAME_EVENT_REPHRASED");
  assert.deepEqual(second.matched_prior_push_ids, [1]);
  assert.equal(second.same_project, true);
  assert.equal(second.same_fact, true);
  assert.equal(result.suppressed.length, 1);
});

test("证据不足：判为 UNRESOLVED、要求研究、不推送", () => {
  const result = runScenario(scenarioById("S4-thin-evidence"), createState());
  const card = result.cards[0];
  assert.equal(card.decision, "UNRESOLVED");
  assert.equal(card.research_required, true);
  assert.equal(card.qualified, false);
  assert.equal(card.opportunity_status, "UNKNOWN");
  assert.equal(card.delivery_action, "NO_PUSH");
  assert.equal(card.change_type, "NOT_APPLICABLE");
  assert.equal(result.pushes.length, 0);
  assert.equal(result.pending.length, 1);
});

test("线索被拒：REJECTED 且带拒绝原因，不推送", () => {
  const result = runScenario(scenarioById("S5-rejected"), createState());
  const card = result.cards[0];
  assert.equal(card.decision, "REJECTED");
  assert.equal(card.qualified, false);
  assert.equal(typeof card.reject_reason, "string");
  assert.equal(result.pushes.length, 0);
});

test("生产验证器不被放宽：缺 X 来源 / 空证据 / 未知字段 / 错 change_type 一律抛错", () => {
  const scenario = deepClone(scenarioById("S1-new-lead"));
  scenario.events[0].evidence = [
    "虚构推文但没有原始 X 来源 | https://evidence.demo.invalid/x/1",
  ];
  const result = runScenario(scenario, createState());
  assert.equal(result.blocked.length, 1, "篡改证据后必须被严格校验阻断");
  assert.equal(result.pushes.length, 0);
  assert.match(result.blocked[0].message, /original X source URL/i);

  const base = runScenario(scenarioById("S1-new-lead"), createState()).cards[0];

  assert.throws(() => validateAlphaDecision({ ...base, evidence: [] }, { requireCurrentFields: true }), /evidence/i);
  assert.throws(() => validateAlphaDecision({ ...base, extra_field: "x" }, { requireCurrentFields: true }), /unknown fields/i);
  assert.throws(() => validateAlphaDecision({ ...base, change_type: "SAME_PROJECT_SAME_FACT" }, { requireCurrentFields: true }), /push-capable/i);
  assert.throws(() => validateAlphaDecision({ ...base, policy_version: "alpha-v0.9.6" }, { requireCurrentFields: true }), /policy_version/i);
  assert.throws(() => validateCard({ ...base, qualified: false }), /qualified=true/i);

  // 兼容默认（strict 之外的旧入口）也不会把不合格卡变成合格
  assert.throws(() => validateAlphaDecision({ ...base, evidence: [] }), /evidence/i);
});

test("每条步骤都在固定阶段序列内", () => {
  const result = runScenario(scenarioById("S2-duplicate"), createState());
  for (const step of result.steps) {
    assert.ok(STAGE_ORDER.includes(step.stage), `未知阶段 ${step.stage}`);
  }
  assert.deepEqual(result.steps.slice(0, 5).map((s) => s.stage), [...STAGE_ORDER]);
});

test("CLI 真跑：--json 退出码 0，汇总与模块一致", () => {
  const cli = spawnSync(process.execPath, ["scripts/demo.mjs", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(cli.error, undefined, `spawn 失败：${cli.error?.message}`);
  assert.equal(cli.status, 0, `CLI 退出码 ${cli.status}，stderr=${cli.stderr}`);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.policy_version, POLICY_VERSION);
  assert.equal(parsed.summary.pushes, 2);
  assert.equal(parsed.summary.suppressed, 2);
  assert.equal(parsed.summary.blocked, 0);
  assert.equal(parsed.notice, DEMO_NOTICE);
});

test("CLI 文本模式带离线声明，单场景模式可用", () => {
  const all = spawnSync(process.execPath, ["scripts/demo.mjs"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  assert.equal(all.status, 0, all.stderr);
  assert.ok(all.stdout.includes(DEMO_NOTICE));
  assert.ok(all.stdout.includes("模拟发件箱"));

  const one = spawnSync(process.execPath, ["scripts/demo.mjs", "--scenario", "S4-thin-evidence"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(one.status, 0, one.stderr);
  assert.ok(one.stdout.includes("UNRESOLVED"));

  const bad = spawnSync(process.execPath, ["scripts/demo.mjs", "--scenario", "nope"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(bad.status, 2);
});

test("网页资源齐全且全是相对路径，页面有醒目的离线声明", () => {
  const indexPath = path.join(DOCS, "index.html");
  assert.ok(fs.existsSync(indexPath));
  const html = fs.readFileSync(indexPath, "utf8");
  assert.ok(html.includes("离线模拟，非实时数据，不发真实通知"), "页面必须有离线声明");
  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('name="viewport"'));
  assert.ok(html.includes('href="./styles.css"'));
  assert.ok(html.includes('src="./app.js"'));
  assert.ok(!/<link[^>]+href="https?:/i.test(html), '不许外链样式或字体');
  assert.ok(!/src="https?:/i.test(html), '不许外链脚本');
  assert.deepEqual([...html.matchAll(/<a\s+[^>]*href="([^"]+)"/gi)].map(m=>m[1]), ['https://github.com/weizhiqiang1005/alpha-intel-demo#快速开始'], '仅允许手动打开源码链接，不得将示例证据变成链接');
  assert.ok(!/<link[^>]+fonts\./i.test(html), "不许外部字体");

  for (const relative of ["styles.css", "app.js", "favicon.svg", "lib/pipeline.js", "lib/fixtures.js", "lib/decision-schema.js", ".nojekyll"]) {
    assert.ok(fs.existsSync(path.join(DOCS, relative)), `缺文件 docs/${relative}`);
  }
});

test("docs 内没有第三方资源与网络调用，证据 URL 只在虚构域名里", () => {
  const files = [
    "index.html", "styles.css", "app.js", "favicon.svg",
    "lib/pipeline.js", "lib/fixtures.js", "lib/decision-schema.js",
  ];
  const allow = [
    /^https:\/\/x\.com\/fictitious_[a-z_]+\/status\/fictitious-\d{4}$/,
    /^https:\/\/[a-z]+\.demo\.invalid\/[a-z0-9/_.-]*$/i,
    /^https:\/\/github\.com\/weizhiqiang1005\/alpha-intel-demo#快速开始$/u,
    // SVG 命名空间是标识符，不是网络请求
    /^http:\/\/www\.w3\.org\/2000\/svg$/,
  ];
  for (const relative of files) {
    const text = fs.readFileSync(path.join(DOCS, relative), "utf8");
    assert.ok(!/\bfetch\s*\(/.test(text), `${relative} 不得调用 fetch`);
    assert.ok(!/XMLHttpRequest|WebSocket|EventSource/.test(text), `${relative} 不得有网络 API`);
    const urls = text.match(/https?:\/\/[^\s"'`<>)]+/g) ?? [];
    for (const url of urls) {
      assert.ok(allow.some((rule) => rule.test(url)), `${relative} 出现非虚构域名：${url}`);
    }
  }
});

test("合成数据不含任何真实 ID 形态或凭据", () => {
  const text = fs.readFileSync(path.join(DOCS, "lib", "fixtures.js"), "utf8");
  assert.ok(!/\d{15,}/.test(text), "不得出现长数字串（真实推文/用户 ID 形态）");
  assert.ok(!/\b(0x[0-9a-fA-F]{40})\b/.test(text), "不得出现真实合约地址");
  assert.ok(!/(api[_-]?key|secret|token|cookie|bearer)/i.test(text), "不得出现凭据字样");
  assert.ok(!/[A-Z]:\\\\|\\\\Users\\\\|\/home\//.test(text), "不得出现本机路径");
  for (const scenario of SCENARIOS) {
    for (const event of scenario.events) {
      for (const item of event.evidence ?? []) {
        assert.ok(!/twitter\.com|t\.co|x\.com\/(?!fictitious_)/i.test(item), `证据里出现非虚构账号：${item}`);
      }
    }
  }
});

test("预览服务只服务 docs/，越界一律拒绝", () => {
  assert.equal(resolveDocRequest("/").status, 200);
  assert.equal(resolveDocRequest("/index.html").status, 200);
  assert.equal(resolveDocRequest("/lib/pipeline.js").status, 200);
  assert.equal(resolveDocRequest("/lib/pipeline.js?v=1").status, 200);
  assert.equal(resolveDocRequest("/../package.json").status, 403);
  assert.equal(resolveDocRequest("/%2e%2e/package.json").status, 403);
  assert.equal(resolveDocRequest("/lib/..%2f..%2fpackage.json").status, 403);
  assert.equal(resolveDocRequest("/..%5cpackage.json").status, 403);
  assert.equal(resolveDocRequest("/%00index.html").status, 400);
  assert.equal(resolveDocRequest("/no-such-file.txt").status, 404);
  assert.equal(DOCS_ROOT, DOCS);
});

test("预览服务真跑：回环 200，越界 403，随后关闭", async () => {
  const server = createPreviewServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const get = (urlPath) => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
  try {
    const home = await get("/");
    assert.equal(home.status, 200);
    assert.ok(home.body.includes("离线模拟，非实时数据，不发真实通知"));
    const asset = await get("/lib/decision-schema.js");
    assert.equal(asset.status, 200);
    assert.ok(asset.body.includes("alpha-v0.9.7"));
    const escaped = await get("/%2e%2e/package.json");
    assert.equal(escaped.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("参考 schema 是合法 JSON 且版本号一致", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(DOCS, "reference", "alpha-v0.9.7.schema.json"), "utf8"));
  assert.equal(schema.properties.policy_version.const, POLICY_VERSION);
  assert.deepEqual(schema.required.length, Object.keys(schema.properties).length);
});

test("mock 审核只做规则分支，不假装是模型输出", () => {
  const card = reviewEvent({ kind: "lead", project: { key: "k", name: "n" }, evidence: [] });
  assert.equal(card.decision, "QUALIFIED_ALPHA");
  assert.equal(card.delivery_action, "NO_PUSH", "reviewEvent 只给草案，不决定推送");
  assert.equal(card.attention_actor, null);
});

test("页面脚本引用的每个 DOM id 都真实存在", () => {
  const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const wanted = [...script.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(wanted.length >= 8, "页面脚本应绑定多个节点");
  for (const id of wanted) assert.ok(ids.has(id), `index.html 缺少 id="${id}"`);
});

// ---------- 预览服务加固 ----------

function httpRequest(port, { method = "GET", urlPath = "/" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function withServer(run) {
  const server = createPreviewServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("预览服务只接受 GET / HEAD，其余方法 405 且带 Allow", async () => {
  await withServer(async (port) => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await httpRequest(port, { method });
      assert.equal(res.status, 405, `${method} 必须 405`);
      assert.equal(res.headers.allow, "GET, HEAD");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
    }

    const get = await httpRequest(port, { method: "GET" });
    assert.equal(get.status, 200);
    assert.equal(get.headers["cache-control"], "no-store");
    assert.equal(get.headers["x-content-type-options"], "nosniff");
    assert.ok(get.body.includes("离线模拟，非实时数据，不发真实通知"));

    const head = await httpRequest(port, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "", "HEAD 不回正文");
    assert.ok(Number(head.headers["content-length"]) > 0, "HEAD 仍要带 content-length");

    const headMiss = await httpRequest(port, { method: "HEAD", urlPath: "/no-such-file.txt" });
    assert.equal(headMiss.status, 404);
    assert.equal(headMiss.body, "");
  });
});

test("预览服务只服务白名单资产，.env / 备份 / 隐藏文件一律 404", async () => {
  const samples = [
    ["preview-test.env", "SECRET=1\n"],
    [".env.preview-test", "SECRET=1\n"],
    ["backup-preview.bak", "backup\n"],
    ["notes-preview.md", "# not an asset\n"],
  ];
  const created = [];
  try {
    for (const [name, body] of samples) {
      const file = path.join(DOCS, name);
      fs.writeFileSync(file, body);
      created.push(file);
    }

    for (const [name] of samples) {
      assert.equal(resolveDocRequest(`/${name}`).status, 404, `${name} 不该被服务`);
    }
    assert.equal(resolveDocRequest("/.nojekyll").status, 404, "隐藏文件不对外");
    assert.equal(resolveDocRequest("/index.html").status, 200);

    await withServer(async (port) => {
      for (const [name] of samples) {
        const res = await httpRequest(port, { urlPath: `/${name}` });
        assert.equal(res.status, 404, `${name} 实际请求必须 404`);
        assert.ok(!res.body.includes("SECRET=1"), `不得回显 ${name} 内容`);
      }
      assert.equal((await httpRequest(port, { urlPath: "/favicon.svg" })).status, 200);
      assert.equal((await httpRequest(port, { urlPath: "/lib/pipeline.js" })).status, 200);
    });
  } finally {
    for (const file of created) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 清理失败不掩盖断言结果
      }
    }
  }
});

test("预览服务按物理路径判界：指向 docs 外的 junction / symlink 一律 403", async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-preview-outside-"));
  const linkName = `__outside_link_${process.pid}__`;
  const linkPath = path.join(DOCS, linkName);
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside-only\n");

  let linked = false;
  for (const type of ["junction", "dir"]) {
    try {
      if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { recursive: false, force: true });
      fs.symlinkSync(outside, linkPath, type);
      linked = true;
      break;
    } catch {
      // 平台或权限不允许，换下一种；两种都不行就跳过
    }
  }
  if (!linked) {
    fs.rmSync(outside, { recursive: true, force: true });
    t.skip("当前平台/权限无法创建 junction 或目录 symlink");
    return;
  }

  try {
    assert.equal(resolveDocRequest(`/${linkName}/secret.txt`).status, 403, "解析层必须拦住");
    assert.equal(resolveDocRequest(`/${linkName}/`).status, 403, "目录形态也要拦");
    await withServer(async (port) => {
      const res = await httpRequest(port, { urlPath: `/${linkName}/secret.txt` });
      assert.equal(res.status, 403);
      assert.ok(!res.body.includes("outside-only"), "不得泄露 docs 外内容");
    });
  } finally {
    try {
      fs.unlinkSync(linkPath);
    } catch {
      try {
        fs.rmSync(linkPath, { recursive: false, force: true });
      } catch {
        // 链接已不存在
      }
    }
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("预览端口只接受严格十进制", () => {
  for (const [raw, expected] of [["4173", 4173], ["80", 80], ["65535", 65535], ["08080", 8080]]) {
    assert.equal(parsePort(raw), expected, `${raw} 应被接受`);
  }
  for (const raw of ["", "0", "65536", "4173abc", "abc", "0x10", "1e3", " 4173", "+4173", "-1", "4 173", "4173.0", "1_000", "999999", null, undefined]) {
    assert.equal(parsePort(raw), null, `"${String(raw)}" 必须拒绝`);
  }
  assert.equal(parsePort(8080), 8080);
});

test("页面有 CSP 与本地相对路径 favicon，除本仓库文件外零外部请求", () => {
  const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(csp, "index.html 必须有 CSP");
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ]) {
    assert.ok(csp[1].includes(directive), `CSP 缺 ${directive}`);
  }
  assert.match(html, /<link rel="icon"[^>]*href="\.\/favicon\.svg"/, "favicon 必须是本地相对路径");
  assert.ok(fs.existsSync(path.join(DOCS, "favicon.svg")), "缺 docs/favicon.svg");

  const css = fs.readFileSync(path.join(DOCS, "styles.css"), "utf8");
  assert.ok(!/@import\s/i.test(css), "CSS 不得 @import");
  assert.ok(!/url\(\s*['"]?https?:/i.test(css), "CSS 不得引用远程资源");
  for (const text of [html, css]) {
    assert.ok(!/<link[^>]+href="(?:https?:)?\/\//i.test(text), "不得外链样式或图标");
    assert.ok(!/<script[^>]+src="(?:https?:)?\/\//i.test(text), "不得外链脚本");
  }
});

test("单步进度只按已展示步骤计数，不提前亮出整场结果", () => {
  const run = runScenario(scenarioById("S2-duplicate"), createState());
  assert.deepEqual(tallyShownSteps(run.steps, 0), {
    steps: 0, pushes: 0, suppressed: 0, pending: 0, rejected: 0, blocked: 0,
  });

  const full = tallyShownSteps(run.steps, run.steps.length);
  assert.equal(full.steps, run.steps.length);
  assert.equal(full.pushes, run.pushes.length);
  assert.equal(full.suppressed, run.suppressed.length);
  assert.equal(full.pending, run.pending.length);
  assert.equal(full.rejected, run.rejected.length);
  assert.equal(full.blocked, run.blocked.length);

  const firstDeliver = run.steps.findIndex((item) => item.stage === "deliver");
  assert.ok(firstDeliver > 0);
  assert.equal(tallyShownSteps(run.steps, firstDeliver).pushes, 0, "还没走到投递就不该显示推送数");
  assert.equal(tallyShownSteps(run.steps, firstDeliver + 1).pushes, 1);

  const tampered = deepClone(scenarioById("S1-new-lead"));
  tampered.events[0].evidence = ["虚构推文但没有原始 X 来源 | https://evidence.demo.invalid/x/1"];
  const blockedRun = runScenario(tampered, createState());
  assert.equal(tallyShownSteps(blockedRun.steps, blockedRun.steps.length).blocked, 1);

  const script = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");
  assert.ok(script.includes("tallyShownSteps("), "app.js 必须用 tallyShownSteps 计进度");
  const progressBody = script.slice(script.indexOf("function renderProgress"), script.indexOf("function render()"));
  assert.ok(!/run\.pushes\.length/.test(progressBody), "进度条不得读整场推送数");
});
