// Official SocialData adapter (third-party API).
// Public docs:
//   GET https://api.socialdata.tools/twitter/search?query={query}&type=Latest&cursor={next_cursor}
//     -> { next_cursor, tweets: [{ id_str, full_text, text, tweet_created_at,
//          user: { id_str, screen_name, ... }, quoted_status, retweeted_status,
//          entities: { urls: [...] }, ... }] }
//   GET https://api.socialdata.tools/twitter/user/{username}
//     -> { id, id_str, name, screen_name, ... }
// Search operators (from:user, since_id:tweet_id) belong INSIDE `query`, never
// as separate endpoint parameters. `since_id` is documented as "After (NOT
// inclusive) a specified Tweet ID".
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

const FAILURE = "socialdata api request failed";
const API_PATH = "/twitter";
// Handles go into a search operator: refuse anything that could inject one.
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,30}$/u;
const ID_PATTERN = /^\d{1,30}$/u;

function invalidPayload() {
  return new AdapterError(FAILURE, { code: "invalid_response" });
}

function invalidInput() {
  return new AdapterError("invalid input", { code: "invalid_input" });
}

// Tweet ids and user ids are snowflakes: never coerce through Number when the
// payload carries a string. A numeric id is only accepted while it is a safe
// integer, so no digit is silently rounded away.
function readId(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!ID_PATTERN.test(text)) throw invalidPayload();
    return text;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw invalidPayload();
    return String(value);
  }
  throw invalidPayload();
}

function readHandle(value, { strip = true } = {}) {
  const raw = typeof value === "string" ? (strip ? value.trim().replace(/^@+/u, "") : value.trim()) : "";
  if (!HANDLE_PATTERN.test(raw)) throw invalidInput();
  return raw;
}

function compareIds(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function readTweets(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalidPayload();
  const tweets = data.tweets;
  if (data.error || (Array.isArray(data.errors) && data.errors.length) || !Array.isArray(tweets)) throw invalidPayload();
  return tweets;
}

function readCursor(data) {
  const next = data?.next_cursor;
  if (next === undefined || next === null || next === "") return null;
  if (typeof next !== "string") throw invalidPayload();
  return next;
}

function readText(tweet) {
  const full = tweet.full_text;
  const text = tweet.text;
  if (typeof full === "string") return full;
  if (typeof text === "string") return text;
  if (full === null && text === null) return "";
  throw invalidPayload();
}

function readCreatedAt(value) {
  if (typeof value !== "string" || value === "") throw invalidPayload();
  if (!Number.isFinite(Date.parse(value))) throw invalidPayload();
  return value;
}

// Only structurally observed link fields: entities.urls[].expanded_url / .url.
function readUrls(tweet) {
  const urls = tweet.entities?.urls;
  if (!Array.isArray(urls)) return [];
  const out = [];
  for (const link of urls) {
    if (typeof link === "string") {
      out.push(link);
      continue;
    }
    if (!link || typeof link !== "object") continue;
    const target = link.expanded_url ?? link.url;
    if (typeof target === "string" && target !== "") out.push(target);
  }
  return out;
}

// Quoted tweet context only when the provider actually embedded it.
function readQuoted(tweet) {
  const quoted = tweet.quoted_status;
  if (!quoted || typeof quoted !== "object" || Array.isArray(quoted)) return null;
  const entry = { id: readId(quoted.id_str ?? quoted.id) };
  try {
    entry.authorId = readId(quoted.user?.id_str ?? quoted.user?.id);
  } catch {
    // Author is optional context; the quoted id alone still identifies it.
  }
  const text = typeof quoted.full_text === "string" ? quoted.full_text : quoted.text;
  if (typeof text === "string") entry.text = text;
  return entry;
}

function mapTweet(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidPayload();
  const id = readId(raw.id_str ?? raw.id);
  const authorId = readId(raw.user?.id_str ?? raw.user?.id);
  const createdAt = readCreatedAt(raw.tweet_created_at);
  const text = readText(raw);

  const post = { id, authorId, text, createdAt };
  const urls = readUrls(raw);
  if (urls.length > 0) post.urls = urls;
  const quoted = readQuoted(raw);
  if (quoted !== null) post.referenced = [quoted];
  if (raw.retweeted_status && typeof raw.retweeted_status === "object") post.repost = true;
  return post;
}

export function createSocialDataAdapter(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw configError("config");
  if (typeof fetchImpl !== "function") throw configError("fetchImpl");

  const apiKey = requireSecret(config.apiKey, "apiKey");
  const baseUrl = assertBaseUrl(config.baseUrl, {
    field: "baseUrl",
    fallback: "https://api.socialdata.tools",
  });
  const maxPages = parsePositiveInt(config.maxPages, "maxPages", 5, 100);
  const timeoutMs = parseTimeout(config.timeoutMs);
  const headers = {
    authorization: `Bearer ${apiKey}`,
    accept: "application/json",
  };

  async function get(path) {
    const { data } = await requestJson(fetchImpl, `${baseUrl}${path}`, {
      method: "GET",
      headers,
      timeoutMs,
      failureMessage: FAILURE,
    });
    return data;
  }

  async function resolveUser(username) {
    const handle = readHandle(username);
    const data = await get(`${API_PATH}/user/${encodeURIComponent(handle)}`);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw invalidPayload();
    const id = readId(data.id_str ?? data.id);
    const screenName = data.screen_name;
    if (typeof screenName !== "string" || screenName.trim() === "") throw invalidPayload();
    return { id, username: screenName };
  }

  async function readPosts(username, { sinceId = null, baseline = false } = {}) {
    const handle = readHandle(username);
    const since = sinceId === null || sinceId === undefined ? null : requireId(sinceId, "sinceId");
    if (since !== null && !ID_PATTERN.test(since)) throw invalidInput();

    const boundary = since === null ? null : BigInt(since);
    const items = new Map();
    const seenCursors = new Set();
    let cursor = null;
    let pages = 0;

    while (true) {
      const params = new URLSearchParams({
        query: since === null ? `from:${handle}` : `from:${handle} since_id:${since}`,
        type: "Latest",
      });
      if (cursor !== null) params.set("cursor", cursor);

      const data = await get(`${API_PATH}/search?${params.toString()}`);
      pages += 1;

      let hitBoundary = false;
      for (const raw of readTweets(data)) {
        const post = mapTweet(raw);
        // since_id is documented exclusive; still guard locally so a provider
        // that echoes the boundary id can never re-deliver old posts.
        if (boundary !== null && compareIds(post.id, boundary) <= 0) {
          hitBoundary = true;
          continue;
        }
        if (!items.has(post.id)) items.set(post.id, post);
      }

      const collected = [...items.values()];
      // A baseline is one page by definition: it only anchors the next poll.
      if (baseline) return { items: collected, complete: true };
      if (hitBoundary) return { items: collected, complete: true };

      const next = readCursor(data);
      if (next === null) return { items: collected, complete: true };

      // A repeated cursor would re-read the same page; never report that as a
      // complete empty result.
      if (seenCursors.has(next) || next === cursor) {
        throw new AdapterError(FAILURE, { code: "invalid_response" });
      }
      seenCursors.add(next);

      if (pages >= maxPages) return { items: collected, complete: false };
      cursor = next;
    }
  }

  return { resolveUser, readPosts };
}
