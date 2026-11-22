// scraper.tech (twitter-api45) read-only adapter.
//
// ScraperTech read endpoints:
//   GET /following.php?rest_id=<id>[&cursor=<c>]     -> { following: [...], next_cursor, more_users, status }
//   GET /list_members.php?list_id=<id>[&cursor=<c>]  -> { members: [...], next_cursor, more_users, status }
//   GET /timeline.php?rest_id=<id>                   -> { timeline: [...], pinned, status, user }
//   Auth: `Scraper-Key` header (the key never goes into a URL).
//
// Three rules this file keeps:
//   1. A page is either fully usable or the call fails: no silent drop, no
//      placeholder account invented for a broken record.
//   2. `complete` is never faked. A walk that hits maxPages, announces more
//      without a cursor, repeats a cursor or returns an empty page mid-walk
//      reports a real failure / real incompleteness.
//   3. An empty result is only a snapshot when the response says so explicitly
//      (`more_users: false`), not merely because an array came back empty.
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

const FAILURE = "scraper.tech request failed";
const DEFAULT_BASE = "https://api.scraper.tech";
const FOLLOWING_PATH = "/following.php";
const LIST_MEMBERS_PATH = "/list_members.php";
const TIMELINE_PATH = "/timeline.php";
const DEFAULT_MAX_PAGES = 12;
const MAX_PAGES_CAP = 100;
const MAX_ID_DIGITS = 30;
const MAX_LINKS = 10;

function invalid(status = null) {
  return new AdapterError(FAILURE, { code: "invalid_response", status });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boolish(value) {
  if (value === true || value === 1 || value === "true" || value === "1") return true;
  if (value === false || value === 0 || value === "false" || value === "0") return false;
  return null;
}

// Ids stay strings. A JSON number past the safe-integer range has already lost
// its low digits, so it is not an id: keeping it would invent a wrong account.
function idOf(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_ID_DIGITS) return null;
  return /^\d+$/u.test(trimmed) ? trimmed : null;
}

// "0", "-1" and "0|<...>" are terminal markers the supplier uses instead of a
// cursor. Treating one as a real next page walks the same page forever.
function cursorOf(value) {
  const cursor = text(value);
  if (cursor === "" || cursor === "0" || cursor === "-1" || cursor.startsWith("0|")) return null;
  return cursor;
}

function assertBusinessOk(data, status) {
  if (!isObject(data)) throw invalid(status);
  const raw = data.status;
  if (raw === undefined || raw === null) return;
  const value = String(raw).trim().toLowerCase();
  // A non-"ok" business status is a provider failure, never an empty page.
  if (value !== "" && value !== "ok") throw invalid(status);
}

/**
 * Pagination is trusted only when the supplier is consistent. `more_users: true`
 * beside a missing/terminal cursor is a contradiction, so it throws instead of
 * collapsing into "end of list" — that collapse is exactly how a knowingly
 * partial roster gets stored as the whole roster.
 */
function paginationOf(data, status) {
  const nextCursor = cursorOf(data.next_cursor);
  const moreUsers = data.more_users === undefined || data.more_users === null
    ? null
    : boolish(data.more_users);
  if (moreUsers === true && nextCursor === null) throw invalid(status);
  return {
    nextCursor,
    moreUsers,
    hasMore: moreUsers === false ? false : nextCursor !== null,
  };
}

function arrayOf(data, key, status) {
  if (key === "members") {
    if (Array.isArray(data.members)) return data.members;
    if (Array.isArray(data.users)) return data.users;
    throw invalid(status);
  }
  if (!Array.isArray(data[key])) throw invalid(status);
  return data[key];
}

function mapUser(value, status, { requireUsername }) {
  if (!isObject(value)) throw invalid(status);
  const id = idOf(value.user_id ?? value.rest_id ?? value.user_id_str ?? value.id_str ?? value.id);
  if (id === null) throw invalid(status);
  const username = text(value.screen_name ?? value.userName ?? value.username ?? value.profile);
  if (username === "") {
    // The supplier sometimes knows the id but returns no profile (a deleted or
    // suspended account). The id is real, so on a following page the entry keeps
    // its slot with `username: null` instead of being dropped or invented. A list
    // member without a handle is unusable for watching and stays a hard reject.
    if (requireUsername) throw invalid(status);
    return { id, username: null };
  }
  return { id, username };
}

/** Links inside one timeline entry, already dereferenced to expanded URLs. */
function linksOf(tweet) {
  const out = [];
  const push = (value) => {
    const link = text(value);
    if (link === "" || !/^https?:\/\//iu.test(link)) return;
    if (!out.includes(link)) out.push(link);
  };
  const entities = isObject(tweet.entities) ? tweet.entities : {};
  const urls = Array.isArray(entities.urls) ? entities.urls : Array.isArray(tweet.urls) ? tweet.urls : [];
  for (const entry of urls) {
    if (typeof entry === "string") push(entry);
    else if (isObject(entry)) push(entry.unwound_url ?? entry.expanded_url ?? entry.url);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

function mapTimelineItem(value, tweetId, fallbackAuthorId, status) {
  const author = isObject(value.author) ? value.author : isObject(value.user) ? value.user : {};
  const authorId = idOf(author.rest_id ?? author.user_id ?? author.id_str ?? author.id)
    ?? fallbackAuthorId;
  const rawText = value.text ?? value.full_text;
  const body = typeof rawText === "string" ? rawText : "";
  const createdAt = text(value.created_at ?? value.createdAt) || null;
  const urls = linksOf(value);
  const repost = boolish(value.is_retweet ?? value.isRetweet) === true
    || isObject(value.retweeted_tweet)
    || isObject(value.retweeted_status)
    || /^RT\s+@/u.test(body);
  return {
    id: tweetId,
    authorId,
    text: body,
    createdAt,
    ...(urls.length ? { urls } : {}),
    ...(repost ? { repost: true } : {}),
  };
}

export function createScraperTechAdapter(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw configError("config");
  if (typeof fetchImpl !== "function") throw configError("fetchImpl");

  const apiKey = requireSecret(config.apiKey, "apiKey");
  const baseUrl = assertBaseUrl(config.baseUrl, { field: "baseUrl", fallback: DEFAULT_BASE });
  const maxPages = parsePositiveInt(config.maxPages, "maxPages", DEFAULT_MAX_PAGES, MAX_PAGES_CAP);
  const timeoutMs = parseTimeout(config.timeoutMs);
  const headers = { "Scraper-Key": apiKey, accept: "application/json" };

  async function get(path, params) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, value);
    }
    // Non-2xx becomes AdapterError with status/retryAfterSeconds; transport
    // failures become network/timeout. Neither carries the URL or the key.
    const { data, status } = await requestJson(fetchImpl, url.href, {
      method: "GET",
      headers,
      timeoutMs,
      failureMessage: FAILURE,
    });
    return { data, status };
  }

  function numericId(value, field) {
    const id = requireId(value, field);
    if (!/^\d{1,30}$/u.test(id)) {
      throw new AdapterError("invalid input", { code: "invalid_input" });
    }
    return id;
  }

  /**
   * Walks one cursor-paged account endpoint. Returns `complete: false` when the
   * page cap, not the provider, ended the walk — a partial roster is reported as
   * partial and is never dressed up as a full one.
   */
  async function walkUsers({ path, key, param, value, requireUsername = true }) {
    const items = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let cursor = null;

    for (let page = 1; page <= maxPages; page += 1) {
      const { data, status } = await get(path, { [param]: value, cursor });
      assertBusinessOk(data, status);
      const values = arrayOf(data, key, status);

      const pageIds = new Set();
      const pageItems = values.map((entry) => mapUser(entry, status, { requireUsername }));
      for (const item of pageItems) {
        // A repeated identity inside one page is a broken page, not a duplicate
        // to swallow: dropping it would shorten the roster silently.
        if (pageIds.has(item.id)) throw invalid(status);
        pageIds.add(item.id);
      }
      const pagination = paginationOf(data, status);

      for (const item of pageItems) {
        if (seenIds.has(item.id)) continue; // legitimate overlap between pages
        seenIds.add(item.id);
        items.push(item);
      }

      if (!pagination.hasMore) {
        // Explicit end only. An empty page with no `more_users: false` is an
        // unreadable answer, not an empty account list.
        const explicitEnd = pagination.moreUsers === false;
        if (items.length === 0 && !explicitEnd) throw invalid(status);
        return { items, complete: true };
      }
      if (pageItems.length === 0) throw invalid(status); // empty page while more announced
      const next = pagination.nextCursor; // non-null: hasMore with a terminal cursor already threw
      if (next === null || seenCursors.has(next)) throw invalid(status); // looped cursor
      seenCursors.add(next);
      cursor = next;
      if (page >= maxPages) return { items, complete: false };
    }
    return { items, complete: false };
  }

  async function readFollowing(userId) {
    const id = numericId(userId, "userId");
    return walkUsers({
      path: FOLLOWING_PATH,
      key: "following",
      param: "rest_id",
      value: id,
      requireUsername: false,
    });
  }

  async function readListMembers(listId) {
    const id = numericId(listId, "listId");
    return walkUsers({
      path: LIST_MEMBERS_PATH,
      key: "members",
      param: "list_id",
      value: id,
      requireUsername: true,
    });
  }

  /**
   * One recent-timeline page, used to add context around a candidate account.
   * `complete: false` means the page announced older pages we did not fetch —
   * honest incompleteness, not a cursor this adapter maintains.
   */
  async function readTimeline(userId) {
    const id = numericId(userId, "userId");
    const { data, status } = await get(TIMELINE_PATH, { rest_id: id });
    assertBusinessOk(data, status);
    if (!Array.isArray(data.timeline)) throw invalid(status);

    const items = [];
    const seen = new Set();
    for (const value of data.timeline) {
      if (!isObject(value)) throw invalid(status);
      const tweetId = idOf(value.tweet_id ?? value.id_str ?? value.id);
      // A timeline entry without a usable id cannot be cited as context.
      if (tweetId === null) throw invalid(status);
      if (seen.has(tweetId)) continue;
      seen.add(tweetId);
      items.push(mapTimelineItem(value, tweetId, id, status));
    }

    const moreUsers = data.more_users === undefined || data.more_users === null
      ? null
      : boolish(data.more_users);
    const announcedMore = moreUsers === true || cursorOf(data.next_cursor) !== null;
    return { items, complete: !announcedMore };
  }

  return { readFollowing, readListMembers, readTimeline };
}
