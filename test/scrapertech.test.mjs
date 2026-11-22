// scraper.tech adapter tests: synthetic fixtures only.
// No real vendor is called, no credential is read from the environment.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createScraperTechAdapter } from "../server/adapters/scrapertech.mjs";
import { AdapterError } from "../server/adapters/_shared.mjs";

const BASE = "https://scraper.example.invalid";
const KEY = "scraper-test-key-SECRET";

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

const asUrl = (call) => new URL(call.url);

function make(fetchImpl, overrides = {}) {
  return createScraperTechAdapter({
    apiKey: KEY,
    baseUrl: BASE,
    timeoutMs: 1000,
    ...overrides,
  }, { fetchImpl });
}

function user(id, screenName, extra = {}) {
  return { user_id: id, screen_name: screenName, ...extra };
}

test("following: 续页用 cursor，Scraper-Key 只放头，跨页重复身份只保留一次", async () => {
  const pages = [
    {
      following: [user("101", "alice"), user("102", "bob")],
      next_cursor: "c-2",
      more_users: true,
      status: "ok",
    },
    {
      following: [user("102", "bob"), user("103", "carol")],
      next_cursor: "0",
      more_users: false,
      status: "ok",
    },
  ];
  const { calls, fetchImpl } = fakeFetch((_url, _init, n) => jsonResponse(200, pages[n - 1]));
  const adapter = make(fetchImpl);

  assert.deepEqual(await adapter.readFollowing("77"), {
    items: [
      { id: "101", username: "alice" },
      { id: "102", username: "bob" },
      { id: "103", username: "carol" },
    ],
    complete: true,
  });

  assert.equal(calls.length, 2);
  const first = asUrl(calls[0]);
  assert.equal(first.origin, BASE);
  assert.equal(first.pathname, "/following.php");
  assert.equal(first.searchParams.get("rest_id"), "77");
  assert.equal(first.searchParams.has("cursor"), false);
  assert.equal(asUrl(calls[1]).searchParams.get("cursor"), "c-2");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["Scraper-Key"], KEY);
  assert.equal("x-rapidapi-key" in calls[0].init.headers, false);
  assert.ok(!calls[0].url.includes(KEY), "the key must never appear in a URL");
});

test("following: 相同 cursor 重复出现 -> 抛错，不无限翻页", async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, {
    following: [user("1", "a")],
    next_cursor: "same",
    more_users: true,
    status: "ok",
  }));
  const adapter = make(fetchImpl);

  await assert.rejects(adapter.readFollowing("77"), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, "invalid_response");
    return true;
  });
  assert.equal(calls.length, 2, "the loop must stop on the first repeat");
});

test("following: 空页却声明 more_users=true -> 抛错，不当成空名单", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, {
    following: [],
    next_cursor: "c-2",
    more_users: true,
    status: "ok",
  }));
  await assert.rejects(make(fetchImpl).readFollowing("77"), (err) => {
    assert.equal(err.code, "invalid_response");
    return true;
  });
});

test("following: 显式 more_users=false 的空数组是合法空快照", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, {
    following: [],
    next_cursor: "0",
    more_users: false,
    status: "ok",
  }));
  assert.deepEqual(await make(fetchImpl).readFollowing("77"), { items: [], complete: true });
});

test("following: 空数组但没有任何结束标记 -> 抛错，不编造空快照", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { following: [], status: "ok" }));
  await assert.rejects(make(fetchImpl).readFollowing("77"), (err) => {
    assert.equal(err.code, "invalid_response");
    return true;
  });
});

test("following: 无 screen_name 的账号保留 id、username 为 null，不丢位置", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, {
    following: [user("201", "live"), { user_id: "202", screen_name: null }],
    more_users: false,
    status: "ok",
  }));
  assert.deepEqual(await make(fetchImpl).readFollowing("77"), {
    items: [{ id: "201", username: "live" }, { id: "202", username: null }],
    complete: true,
  });
});

test("following: 同页重复身份/无 id 记录都是畸形页", async () => {
  const duplicated = fakeFetch(() => jsonResponse(200, {
    following: [user("1", "a"), user("1", "a")],
    more_users: false,
    status: "ok",
  }));
  await assert.rejects(make(duplicated.fetchImpl).readFollowing("77"), (err) => {
    assert.equal(err.code, "invalid_response");
    return true;
  });

  const noId = fakeFetch(() => jsonResponse(200, {
    following: [{ screen_name: "ghost" }],
    more_users: false,
    status: "ok",
  }));
  await assert.rejects(make(noId.fetchImpl).readFollowing("77"), (err) => {
    assert.equal(err.code, "invalid_response");
    return true;
  });
});

test("following: 到 maxPages 仍未完时 complete=false 并停止请求", async () => {
  const { calls, fetchImpl } = fakeFetch((_url, _init, n) => jsonResponse(200, {
    following: [user(String(300 + n), `u${n}`)],
    next_cursor: `c-${n + 1}`,
    more_users: true,
    status: "ok",
  }));
  const result = await make(fetchImpl, { maxPages: 2 }).readFollowing("77");

  assert.equal(result.complete, false);
  assert.equal(result.items.length, 2);
  assert.equal(calls.length, 2, "must not walk past maxPages");
});

test("list_members: list_id 参数、members 形状、需要 following 计数以外的最小字段", async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, {
    members: [user("900", "watch_a"), user("901", "watch_b")],
    next_cursor: null,
    more_users: false,
    status: "ok",
  }));
  const result = await make(fetchImpl).readListMembers("555");

  assert.deepEqual(result, {
    items: [{ id: "900", username: "watch_a" }, { id: "901", username: "watch_b" }],
    complete: true,
  });
  const url = asUrl(calls[0]);
  assert.equal(url.pathname, "/list_members.php");
  assert.equal(url.searchParams.get("list_id"), "555");
  assert.equal(url.searchParams.has("rest_id"), false);
});

test("list_members: 成员缺 screen_name 直接失败，不产生不可用成员", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, {
    members: [{ user_id: "1", screen_name: null }],
    more_users: false,
    status: "ok",
  }));
  await assert.rejects(make(fetchImpl).readListMembers("555"), (err) => {
    assert.equal(err.code, "invalid_response");
    return true;
  });
});

test("401: 抛 http_error、带 status、只请求一次、消息不含正文或 key", async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(401, {
    error: "SECRET_BODY invalid key",
  }));
  await assert.rejects(make(fetchImpl).readFollowing("77"), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, "http_error");
    assert.equal(err.status, 401);
    assert.ok(!err.message.includes("SECRET_BODY"));
    assert.ok(!err.message.includes(KEY));
    return true;
  });
  assert.equal(calls.length, 1);
});

test("429: 暴露 status 与 retryAfterSeconds，且不自动重试", async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(429, { error: "slow down" }, {
    "retry-after": "13",
  }));
  await assert.rejects(make(fetchImpl).readTimeline("77"), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterSeconds, 13);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("业务 status 非 ok：200 也当失败", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, {
    status: "error",
    message: "SECRET_DETAIL",
  }));
  await assert.rejects(make(fetchImpl).readFollowing("77"), (err) => {
    assert.equal(err.code, "invalid_response");
    assert.equal(err.status, 200);
    assert.ok(!err.message.includes("SECRET_DETAIL"));
    return true;
  });
});

test("timeline: 一页、作者回退到请求账号、抽出链接与转推标记", async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, {
    status: "ok",
    user: { screen_name: "candidate" },
    timeline: [
      {
        tweet_id: "1001",
        text: "launching soon https://t.co/x",
        created_at: "2026-11-20T10:00:00.000Z",
        author: { rest_id: "77", screen_name: "candidate" },
        entities: { urls: [{ url: "https://t.co/x", expanded_url: "https://project.example/docs" }] },
      },
      {
        tweet_id: "1002",
        text: "RT @other: signal",
        created_at: "2026-11-19T09:00:00.000Z",
      },
      {
        tweet_id: "1003",
        text: "hello",
        created_at: "2026-11-18T08:00:00.000Z",
        retweeted_tweet: { tweet_id: "999" },
      },
    ],
    next_cursor: null,
    more_users: false,
  }));

  assert.deepEqual(await make(fetchImpl).readTimeline("77"), {
    items: [
      {
        id: "1001",
        authorId: "77",
        text: "launching soon https://t.co/x",
        createdAt: "2026-11-20T10:00:00.000Z",
        urls: ["https://project.example/docs"],
      },
      {
        id: "1002",
        authorId: "77",
        text: "RT @other: signal",
        createdAt: "2026-11-19T09:00:00.000Z",
        repost: true,
      },
      {
        id: "1003",
        authorId: "77",
        text: "hello",
        createdAt: "2026-11-18T08:00:00.000Z",
        repost: true,
      },
    ],
    complete: true,
  });

  assert.equal(calls.length, 1);
  const url = asUrl(calls[0]);
  assert.equal(url.pathname, "/timeline.php");
  assert.equal(url.searchParams.get("rest_id"), "77");
  assert.equal(url.searchParams.has("cursor"), false);
});

test("timeline: 一页就是全部，仍有下一页时 complete=false 且不多请求", async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, {
    status: "ok",
    timeline: [{ tweet_id: "1", text: "t", created_at: "2026-11-20T10:00:00.000Z" }],
    next_cursor: "older",
    more_users: true,
  }));
  const result = await make(fetchImpl).readTimeline("77");

  assert.equal(result.complete, false);
  assert.equal(result.items.length, 1);
  assert.equal(calls.length, 1, "context read stays a single page");
});

test("timeline: 显式空 timeline 数组是合法空结果，条目无 id 则失败", async () => {
  const empty = fakeFetch(() => jsonResponse(200, {
    status: "ok",
    timeline: [],
    more_users: false,
  }));
  assert.deepEqual(await make(empty.fetchImpl).readTimeline("77"), { items: [], complete: true });

  const broken = fakeFetch(() => jsonResponse(200, {
    status: "ok",
    timeline: [{ text: "no id here" }],
  }));
  await assert.rejects(make(broken.fetchImpl).readTimeline("77"), (err) => {
    assert.equal(err.code, "invalid_response");
    return true;
  });

  const noArray = fakeFetch(() => jsonResponse(200, { status: "ok" }));
  await assert.rejects(make(noArray.fetchImpl).readTimeline("77"), (err) => {
    assert.equal(err.code, "invalid_response");
    return true;
  });
});

test("输入: 非数字 userId/listId 直接拒绝，不发请求", async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, { status: "ok" }));
  const adapter = make(fetchImpl);

  await assert.rejects(adapter.readFollowing("alice"), (err) => {
    assert.equal(err.code, "invalid_input");
    return true;
  });
  await assert.rejects(adapter.readTimeline(""), (err) => {
    assert.equal(err.code, "invalid_input");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("配置: 只接受 HTTPS 或回环 HTTP，key 不能带空白，maxPages 有界", () => {
  const noFetch = { fetchImpl: async () => jsonResponse(200, {}) };

  assert.throws(
    () => createScraperTechAdapter({ apiKey: KEY, baseUrl: "http://scraper.example.com" }, noFetch),
    (err) => err.code === "invalid_config",
  );
  assert.throws(
    () => createScraperTechAdapter({ apiKey: "bad key", baseUrl: BASE }, noFetch),
    (err) => err.code === "invalid_config",
  );
  assert.throws(
    () => createScraperTechAdapter({ baseUrl: BASE }, noFetch),
    (err) => err.code === "invalid_config",
  );
  assert.throws(
    () => createScraperTechAdapter({ apiKey: KEY, baseUrl: BASE, maxPages: 0 }, noFetch),
    (err) => err.code === "invalid_config",
  );
  assert.throws(
    () => createScraperTechAdapter({ apiKey: KEY, baseUrl: BASE, timeoutMs: 0 }, noFetch),
    (err) => err.code === "invalid_config",
  );
  assert.doesNotThrow(() => createScraperTechAdapter({
    apiKey: KEY,
    baseUrl: "http://127.0.0.1:9",
  }, noFetch));
});

test("默认 baseUrl 是 scraper.tech 公开主机", async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, {
    status: "ok",
    timeline: [],
    more_users: false,
  }));
  await createScraperTechAdapter({ apiKey: KEY }, { fetchImpl }).readTimeline("77");
  assert.equal(asUrl(calls[0]).origin, "https://api.scraper.tech");
});
