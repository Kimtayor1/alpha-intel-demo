// SocialData adapter contract tests: synthetic payloads and a fake fetch only.
// No network, no real credential, no vendor data.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSocialDataAdapter } from "../server/adapters/socialdata.mjs";
import { AdapterError } from "../server/adapters/_shared.mjs";

const BASE = "https://socialdata.example.invalid";
const KEY = "sd-test-key-SECRET";

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return { calls, fetchImpl };
}

function asUrl(call) {
  return new URL(call.url);
}

// Minimal synthetic tweet in the documented shape.
function tweet(id, authorId = "44196397", extras = {}) {
  return {
    tweet_created_at: "2026-11-20T10:00:00.000000Z",
    id_str: String(id),
    text: null,
    full_text: "synthetic post " + id,
    user: { id_str: String(authorId), screen_name: "fictitious_alice", name: "Alice" },
    quoted_status: null,
    retweeted_status: null,
    entities: { urls: [] },
    ...extras,
  };
}

test("socialdata: resolveUser 走 /twitter/user/{handle}，密钥只放 Authorization", async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, {
    id: 1234567890123456789,
    id_str: "1234567890123456789",
    name: "Alice",
    screen_name: "fictitious_alice",
  }));
  const adapter = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, { fetchImpl });

  assert.deepEqual(await adapter.resolveUser("@fictitious_alice"), {
    id: "1234567890123456789",
    username: "fictitious_alice",
  });

  assert.equal(calls.length, 1);
  const url = asUrl(calls[0]);
  assert.equal(url.origin, BASE);
  assert.equal(url.pathname, "/twitter/user/fictitious_alice");
  assert.equal(url.search, "");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!calls[0].url.includes(KEY), "key must not appear in the URL");
});

test("socialdata: resolveUser 接受安全整数 id，拒绝会被舍入的超大数字 id", async () => {
  const safe = fakeFetch(() => jsonResponse(200, { id: 44196397, screen_name: "fictitious_bob" }));
  const adapterA = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, safe);
  assert.deepEqual(await adapterA.resolveUser("fictitious_bob"), {
    id: "44196397",
    username: "fictitious_bob",
  });

  const unsafe = fakeFetch(() => jsonResponse(200, { id: 9007199254740993, screen_name: "fictitious_bob" }));
  const adapterB = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, unsafe);
  await assert.rejects(adapterB.resolveUser("fictitious_bob"), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, "invalid_response");
    return true;
  });
});

test("socialdata: 身份查询 429 走共享错误，不带 URL 与密钥", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(429, { status: "error", message: "Too many requests" }, {
    "retry-after": "30",
  }));
  const adapter = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, { fetchImpl });

  await assert.rejects(adapter.resolveUser("fictitious_alice"), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, "http_error");
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterSeconds, 30);
    assert.equal(err.message, "socialdata api request failed");
    assert.ok(!err.message.includes("socialdata.example.invalid"));
    assert.ok(!err.message.includes(KEY));
    assert.equal(err.cause, undefined);
    return true;
  });
});

test("socialdata: baseline 只取一页并标 complete", async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, {
    next_cursor: "page-2",
    tweets: [tweet(101), tweet(102)],
  }));
  const adapter = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, { fetchImpl });

  const result = await adapter.readPosts("fictitious_alice", { baseline: true });

  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map((item) => item.id), ["101", "102"]);
  assert.equal(calls.length, 1, "baseline must not paginate");

  const url = asUrl(calls[0]);
  assert.equal(url.pathname, "/twitter/search");
  assert.equal(url.searchParams.get("query"), "from:fictitious_alice");
  assert.equal(url.searchParams.get("type"), "Latest");
  assert.equal(url.searchParams.has("cursor"), false);
  assert.equal(url.searchParams.has("since_id"), false);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
});

test("socialdata: since_id 进 query，cursor 续页，同 id 去重", async () => {
  const pages = [
    { next_cursor: "page-2", tweets: [tweet(205), tweet(204)] },
    { tweets: [tweet(204), tweet(203)] },
  ];
  const { calls, fetchImpl } = fakeFetch((_url, _init, n) => jsonResponse(200, pages[n - 1]));
  const adapter = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, { fetchImpl });

  const result = await adapter.readPosts("fictitious_alice", { sinceId: "200" });

  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map((item) => item.id), ["205", "204", "203"], "no duplicate ids");
  assert.equal(calls.length, 2);

  assert.equal(asUrl(calls[0]).searchParams.get("query"), "from:fictitious_alice since_id:200");
  assert.equal(asUrl(calls[0]).searchParams.has("cursor"), false);
  assert.equal(asUrl(calls[1]).searchParams.get("query"), "from:fictitious_alice since_id:200");
  assert.equal(asUrl(calls[1]).searchParams.get("cursor"), "page-2");
  assert.equal(asUrl(calls[1]).searchParams.get("type"), "Latest");
});

test("socialdata: 遇到边界 id 立即收口，即使还有 next_cursor", async () => {
  const pages = [
    { next_cursor: "page-2", tweets: [tweet(305), tweet(304)] },
    { next_cursor: "page-3", tweets: [tweet(300), tweet(299)] },
  ];
  const { calls, fetchImpl } = fakeFetch((_url, _init, n) => jsonResponse(200, pages[n - 1]));
  const adapter = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, { fetchImpl });

  const result = await adapter.readPosts("fictitious_alice", { sinceId: "300" });

  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map((item) => item.id), ["305", "304"]);
  assert.equal(calls.length, 2, "must stop at the boundary page");
});

test("socialdata: 打到 maxPages 仍有游标则 complete=false，不谎报完成", async () => {
  const { calls, fetchImpl } = fakeFetch((_url, _init, n) => jsonResponse(200, {
    next_cursor: `still-more-${n}`,
    tweets: [tweet(401)],
  }));
  const adapter = createSocialDataAdapter(
    { apiKey: KEY, baseUrl: BASE, maxPages: 2, timeoutMs: 1000 },
    { fetchImpl },
  );

  const result = await adapter.readPosts("fictitious_alice");

  assert.equal(result.complete, false);
  assert.deepEqual(result.items.map((item) => item.id), ["401"], "same id deduped across pages");
  assert.equal(calls.length, 2);
});

test("socialdata: 缺 tweets 字段报错，不当成空成功", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { next_cursor: null }));
  const adapter = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, { fetchImpl });

  await assert.rejects(adapter.readPosts("fictitious_alice", { baseline: true }), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, "invalid_response");
    return true;
  });
});

test("socialdata: 缺 id_str / user.id_str 报错", async () => {
  const bad = tweet(501, "44196397");
  delete bad.id_str;
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { tweets: [bad] }));
  const adapter = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, { fetchImpl });

  await assert.rejects(adapter.readPosts("fictitious_alice"), (err) => {
    assert.equal(err.code, "invalid_response");
    return true;
  });

  const noAuthor = tweet(502);
  delete noAuthor.user;
  const second = fakeFetch(() => jsonResponse(200, { tweets: [noAuthor] }));
  const adapter2 = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, second);
  await assert.rejects(adapter2.readPosts("fictitious_alice"), (err) => {
    assert.equal(err.code, "invalid_response");
    return true;
  });
});

test("socialdata: 游标循环报错而不是假空", async () => {
  const pages = [
    { next_cursor: "loop", tweets: [tweet(601)] },
    { next_cursor: "loop", tweets: [tweet(600)] },
  ];
  const { fetchImpl } = fakeFetch((_url, _init, n) => jsonResponse(200, pages[n - 1]));
  const adapter = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, maxPages: 10, timeoutMs: 1000 }, { fetchImpl });

  await assert.rejects(adapter.readPosts("fictitious_alice"), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, "invalid_response");
    return true;
  });
});

test("socialdata: 引用/转推/链接只用已观察结构", async () => {
  const quoted = tweet(701, "44196397", {
    quoted_status: {
      id_str: "900",
      full_text: "quoted body",
      user: { id_str: "777", screen_name: "fictitious_bob" },
    },
    entities: { urls: [{ url: "https://t.co/x", expanded_url: "https://example.invalid/a" }] },
  });
  const reposted = tweet(702, "44196397", {
    retweeted_status: { id_str: "800", full_text: "original body", user: { id_str: "888" } },
  });
  const plain = tweet(703);

  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { tweets: [quoted, reposted, plain] }));
  const adapter = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, { fetchImpl });

  const { items } = await adapter.readPosts("fictitious_alice");

  assert.deepEqual(items[0], {
    id: "701",
    authorId: "44196397",
    text: "synthetic post 701",
    createdAt: "2026-11-20T10:00:00.000000Z",
    urls: ["https://example.invalid/a"],
    referenced: [{ id: "900", authorId: "777", text: "quoted body" }],
  });
  assert.equal(items[1].repost, true);
  assert.equal(items[1].urls, undefined);
  assert.equal(items[2].urls, undefined);
  assert.equal(items[2].referenced, undefined);
  assert.equal(items[2].repost, undefined);
});

test("socialdata: 配置校验与输入校验", async () => {
  assert.throws(() => createSocialDataAdapter({ baseUrl: BASE }, { fetchImpl: async () => {} }), (err) => {
    assert.equal(err.code, "invalid_config");
    return true;
  });
  assert.throws(() => createSocialDataAdapter({ apiKey: KEY, baseUrl: "http://api.example.invalid" }, {
    fetchImpl: async () => {},
  }), (err) => {
    assert.equal(err.code, "invalid_config");
    return true;
  });

  const adapter = createSocialDataAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1000 }, {
    fetchImpl: async () => jsonResponse(200, { tweets: [] }),
  });
  await assert.rejects(adapter.resolveUser("fictitious alice"), (err) => {
    assert.equal(err.code, "invalid_input");
    return true;
  });
  await assert.rejects(adapter.readPosts("fictitious_alice", { sinceId: "20 0" }), (err) => {
    assert.equal(err.code, "invalid_input");
    return true;
  });
});
