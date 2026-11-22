// Official X API v2 adapter.
// Docs: GET /2/users/by/username/:username, GET /2/users/:id/tweets,
//       GET /2/users/:id/following — pagination with pagination_token.
import {
  AdapterError,
  assertBaseUrl,
  configError,
  parsePositiveInt,
  parseTimeout,
  requestJson,
  requireId,
  requireSecret,
} from "./_shared.mjs";

const FAILURE = "x api request failed";
const PAGE_SIZE = 100;
const TWEET_FIELDS = "created_at,author_id,entities,referenced_tweets";
const USER_FIELDS = "description,name";

function invalidPayload() {
  return new AdapterError(FAILURE, { code: "invalid_response" });
}

function pageItems(data) {
  const items = data?.data;
  if (items === undefined || items === null) {
    if (data?.meta?.result_count !== 0) throw invalidPayload();
    return [];
  }
  if (!Array.isArray(items)) throw invalidPayload();
  return items;
}

function nextToken(data) {
  const meta = data?.meta;
  if (meta === undefined || meta === null) return null;
  if (typeof meta !== "object" || Array.isArray(meta)) throw invalidPayload();
  const next = meta.next_token;
  if (next === undefined || next === null) return null;
  if (typeof next !== "string" || next === "") throw invalidPayload();
  return next;
}

function mapPost(item, fallbackAuthorId, expanded = []) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidPayload();
  if (typeof item.id !== "string" || item.id === "") throw invalidPayload();
  if (item.text !== undefined && typeof item.text !== "string") throw invalidPayload();
  if (item.author_id !== undefined && typeof item.author_id !== "string") throw invalidPayload();

  return {
    id: item.id,
    authorId: typeof item.author_id === "string" && item.author_id !== ""
      ? item.author_id
      : fallbackAuthorId,
    text: typeof item.text === "string" ? item.text : "",
    createdAt: typeof item.created_at === "string" ? item.created_at : null,
    url: `https://x.com/i/web/status/${encodeURIComponent(item.id)}`,
    ...(Array.isArray(item.entities?.urls) ? { urls: item.entities.urls.map(link=>link?.unwound_url || link?.expanded_url || link?.url).filter(link=>typeof link==='string') } : {}),
    ...(Array.isArray(item.referenced_tweets) && item.referenced_tweets.some(ref=>ref?.type==='retweeted') ? { repost:true } : {}),
    ...(expanded.length ? { referenced:expanded } : {}),
  };
}

function mapUser(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidPayload();
  if (typeof item.id !== "string" || item.id === "") throw invalidPayload();
  if (typeof item.username !== "string" || item.username === "") throw invalidPayload();

  const user = { id: item.id, username: item.username };
  if (typeof item.name === "string" && item.name !== "") user.name = item.name;
  if (typeof item.description === "string") user.description = item.description;
  return user;
}

export function createXAdapter(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw configError("config");
  if (typeof fetchImpl !== "function") throw configError("fetchImpl");

  const bearerToken = requireSecret(config.bearerToken, "bearerToken");
  const baseUrl = assertBaseUrl(config.baseUrl, {
    field: "baseUrl",
    fallback: "https://api.x.com",
  });
  const maxPages = parsePositiveInt(config.maxPages, "maxPages", 5, 100);
  const timeoutMs = parseTimeout(config.timeoutMs);
  const headers = {
    authorization: `Bearer ${bearerToken}`,
    accept: "application/json",
  };

  async function get(path) {
    const { data, status } = await requestJson(fetchImpl, `${baseUrl}${path}`, {
      method: "GET",
      headers,
      timeoutMs,
      failureMessage: FAILURE,
    });
    // X v2 can answer 200 with a non-empty errors[] beside (or instead of)
    // data. Never turn that into an empty successful snapshot.
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      throw new AdapterError(FAILURE, { code: "partial_response", status });
    }
    return data;
  }

  async function resolveUser(username) {
    const clean = typeof username === "string" ? username.trim().replace(/^@+/u, "") : "";
    if (clean === "") throw new AdapterError("invalid input", { code: "invalid_input" });

    const data = await get(`/2/users/by/username/${encodeURIComponent(clean)}`);
    const user = data?.data;
    if (!user || typeof user !== "object" || Array.isArray(user)) throw invalidPayload();
    if (typeof user.id !== "string" || user.id === "") throw invalidPayload();
    if (typeof user.username !== "string" || user.username === "") throw invalidPayload();

    return { id: user.id, username: user.username };
  }

  async function readPosts(userId, { sinceId = null, baseline = false } = {}) {
    const id = requireId(userId, "userId");
    const since = sinceId === null || sinceId === undefined ? null : requireId(sinceId, "sinceId");

    const items = [];
    let token = null;
    let pages = 0;

    while (true) {
      const query = new URLSearchParams({
        max_results: String(PAGE_SIZE),
        "tweet.fields": TWEET_FIELDS,
        expansions: 'referenced_tweets.id',
      });
      // Keep the same time range for every page.
      if (since !== null) query.set("since_id", since);
      if (token !== null) query.set("pagination_token", token);

      const data = await get(`/2/users/${encodeURIComponent(id)}/tweets?${query}`);
      pages += 1;

      const expansions = new Map((Array.isArray(data.includes?.tweets) ? data.includes.tweets : []).map(item=>[item?.id,item]));
      for (const item of pageItems(data)) {
        const ids = (Array.isArray(item?.referenced_tweets) ? item.referenced_tweets : []).filter(ref=>ref?.type==='quoted' || ref?.type==='replied_to').map(ref=>ref.id);
        const referenced = ids.map(key=>expansions.get(key)).filter(post=>typeof post?.id==='string' && typeof post?.author_id==='string' && typeof post?.text==='string').map(post=>({id:post.id,authorId:post.author_id,text:post.text}));
        items.push(mapPost(item, id, referenced));
      }
      if (baseline) return { items, complete: true };

      token = nextToken(data);
      if (token === null) return { items, complete: true };
      if (pages >= maxPages) return { items, complete: false };
    }
  }

  async function readFollowing(userId) {
    const id = requireId(userId, "userId");

    const items = [];
    let token = null;
    let pages = 0;

    while (true) {
      const query = new URLSearchParams({
        max_results: String(PAGE_SIZE),
        "user.fields": USER_FIELDS,
      });
      if (token !== null) query.set("pagination_token", token);

      const data = await get(`/2/users/${encodeURIComponent(id)}/following?${query}`);
      pages += 1;

      for (const item of pageItems(data)) items.push(mapUser(item));

      token = nextToken(data);
      if (token === null) return { items, complete: true };
      if (pages >= maxPages) return { items, complete: false };
    }
  }

  return { resolveUser, readPosts, readFollowing };
}
