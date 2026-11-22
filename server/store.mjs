// ALPHA 自部署 · SQLite 状态模块（单进程单实例，Node >= 22.13，node:sqlite DatabaseSync）
//
// 契约（与任务书一致）：
//   openStore(dbPath, options?) -> store   // ':memory:' 或本地文件路径
//   close()
//   getCursor(key) -> JSON 值 | null
//   ingest(key, nextCursor, events) -> number inserted   // 一个事务：事件 + 游标
//   readyEvents(limit) -> event[]                        // 到期的 deferred 会在此刻转回 ready
//   recordDecision(eventId, decision) -> { queued, duplicate }
//   deferEvent(eventId, delaySeconds, reason) -> { state, attempts, deferUntilAt }
//   claimDelivery() -> { id, decision, attempts } | null  // 原子 pending -> sending，先到期
//   finishDelivery(id, outcome)
//   status() -> { events, outbox, observations }
//
// 硬约束：
//   1) 只用 Node 内置模块，不联网、不装包。
//   2) 落库前先脱敏：token / cookie / authorization / apikey / secret / private key 一律 [REDACTED]。
//   3) 不打印事件正文；抛错只带 code + id，不带 payload。
//   4) 单写者：文件库用 `<db>.lock` 进程锁；重启遗留的 sending 一律置 uncertain，不自动重放。
//   5) 数据目录由调用方给（本地路径 / 临时目录），本模块不写 docs/。
//
// 状态机：
//   events : ready <-> deferred -> decided；deferred 超过上限 -> dead
//   outbox : pending -> sending -> sent | rejected | uncertain | (retryable -> pending)* -> dead
//   uncertain 终态：投递结果未知，永不重发（要重发必须人工重建 outbox 记录）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const REDACTED = '[REDACTED]';
export const MAX_DELIVERY_ATTEMPTS = 5;
export const MAX_DEFER_ATTEMPTS = 5;
export const DEFAULT_RETRY_DELAY_SECONDS = 30;

export const EVENT_STATES = Object.freeze(['ready', 'deferred', 'decided', 'dead']);
export const OUTBOX_STATES = Object.freeze(['pending', 'sending', 'sent', 'rejected', 'uncertain', 'dead']);
export const DELIVERY_OUTCOMES = Object.freeze(['sent', 'retryable', 'rejected', 'uncertain']);

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_CURSOR_BYTES = 512 * 1024;
const MAX_MESSAGE_ID_LENGTH = 256;

// 脱敏词表：按标识符词法拆分后逐词比对，避免误伤 projectKey / factKey / key。
const SECRET_WORDS = new Set([
  'token', 'tokens', 'refreshtoken', 'accesstoken', 'secret', 'secrets', 'clientsecret',
  'webhooksecret', 'password', 'passwd', 'passphrase', 'cookie', 'cookies',
  'authorization', 'auth', 'bearer', 'apikey', 'apikeys', 'accesskey', 'secretkey',
  'privatekey', 'privatekeys', 'mnemonic', 'seed', 'seedphrase', 'session', 'sessionid',
  'credential', 'credentials', 'signature', 'sig', 'jwt',
]);

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function isSecretKey(rawKey) {
  if (typeof rawKey !== 'string' || rawKey.length === 0) return false;
  const squashed = rawKey.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (SECRET_WORDS.has(squashed)) return true;
  const spaced = rawKey
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .trim();
  if (spaced === '') return false;
  const words = spaced.split(' ').filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    if (SECRET_WORDS.has(words[index])) return true;
    if (index + 1 < words.length && SECRET_WORDS.has(words[index] + words[index + 1])) return true;
  }
  return false;
}

// 深拷贝 + 脱敏。只处理 JSON 可序列化的结构，超过 8 层截断。
export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value.slice(0, 500)) out.push(redact(item, depth + 1));
    return out;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redact(item, depth + 1);
  }
  return out;
}

// 只接受运行时代码（大写下划线），挡住自由文本 / 正文 / 凭据误入库。
function normalizeReason(reason) {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string' || !REASON_CODE.test(reason)) {
    throw new StoreError('INVALID_REASON', 'reason 只接受大写下划线运行时代码，例如 RATE_LIMITED');
  }
  return reason;
}

function nullableString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeDelaySeconds(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new StoreError('INVALID_DELAY', 'delaySeconds 需要非负数字');
  }
  return Math.min(Math.floor(seconds), 7 * 24 * 3600);
}

function normalizeLimit(limit) {
  if (limit === undefined || limit === null) return 50;
  const value = Math.floor(Number(limit));
  if (!Number.isFinite(value)) throw new StoreError('INVALID_LIMIT', 'limit 需要整数');
  if (value <= 0) return 0;
  return Math.min(value, 1000);
}

function serializeCursor(nextCursor) {
  if (nextCursor === undefined) return 'null';
  const text = JSON.stringify(nextCursor);
  if (typeof text !== 'string') throw new StoreError('INVALID_CURSOR', 'cursor 需要可 JSON 序列化');
  if (Buffer.byteLength(text, 'utf8') > MAX_CURSOR_BYTES) {
    throw new StoreError('CURSOR_TOO_LARGE', 'cursor 过大');
  }
  return text;
}

function normalizeEventRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StoreError('INVALID_EVENT', 'event 必须是对象');
  }
  if (typeof raw.id !== 'string' || raw.id.trim() === '') {
    throw new StoreError('INVALID_EVENT_ID', 'event.id 需要非空字符串');
  }
  const payload = redact(raw);
  const payloadText = JSON.stringify(payload);
  if (Buffer.byteLength(payloadText, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new StoreError('EVENT_TOO_LARGE', 'event 序列化后超过上限');
  }
  return {
    id: raw.id,
    projectKey: nullableString(raw.project?.key ?? raw.projectKey ?? null),
    factKey: nullableString(raw.fact ?? raw.factKey ?? null),
    payloadText,
  };
}

function acquireLock(dbPath) {
  const lockPath = `${dbPath}.lock`;
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), tool: 'alpha-store' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      return lockPath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readLockPid(lockPath);
      // Fail closed even for stale or partially written locks. Two processes
      // must not race to unlink a stale lock and both become writers.
      throw new StoreError('STORE_LOCKED', holder !== null && isProcessAlive(holder)
        ? '数据库已被另一个进程占用（单写者）'
        : '数据库存在遗留锁；确认无进程运行后手动移除');
    }
  }
  throw new StoreError('STORE_LOCKED', '无法获得数据库写锁');
}

function readLockPid(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Number.isInteger(parsed?.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function releaseLock(lockPath) {
  if (!lockPath) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // 已被清理或无权删除：不影响正确性
  }
}

function hardenPermissions(dbPath) {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.lock`]) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows 上 chmod 基本无效；尽力而为，不阻断
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  key        TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  project_key    TEXT NOT NULL,
  fact_key       TEXT NOT NULL,
  first_event_id TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  seen_count     INTEGER NOT NULL,
  PRIMARY KEY (project_key, fact_key)
);
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  stream       TEXT NOT NULL,
  project_key  TEXT,
  fact_key     TEXT,
  state        TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,
  observed_at  INTEGER NOT NULL,
  defer_until  INTEGER,
  defer_reason TEXT,
  defer_count  INTEGER NOT NULL DEFAULT 0,
  decision     TEXT,
  decided_at   INTEGER,
  payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ready ON events (state, observed_at);
CREATE TABLE IF NOT EXISTS pushed_facts (
  project_key TEXT NOT NULL,
  fact_key    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  outbox_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project_key, fact_key)
);
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  project_key     TEXT NOT NULL,
  fact_key        TEXT NOT NULL,
  decision        TEXT NOT NULL,
  state           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  message_id      TEXT,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (state, next_attempt_at);
`;

const EVENT_COLUMNS =
  'id, stream, project_key, fact_key, state, first_seen, observed_at, defer_until, ' +
  'defer_reason, defer_count, decision, decided_at, payload';

function rowToEvent(row) {
  return {
    id: row.id,
    stream: row.stream,
    projectKey: row.project_key ?? null,
    factKey: row.fact_key ?? null,
    state: row.state,
    firstSeen: row.first_seen === 1,
    observedAt: row.observed_at,
    deferUntilAt: row.defer_until ?? null,
    deferReason: row.defer_reason ?? null,
    deferCount: row.defer_count,
    decidedAt: row.decided_at ?? null,
    decision: row.decision ? JSON.parse(row.decision) : null,
    event: JSON.parse(row.payload),
  };
}

export function openStore(dbPath, options = {}) {
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new StoreError('INVALID_PATH', 'openStore(path) 需要非空路径');
  }
  if (dbPath.includes('://')) {
    throw new StoreError('UNSUPPORTED_PATH', '只支持 :memory: 或本地文件路径');
  }
  const inMemory = dbPath === ':memory:';
  const resolved = inMemory ? ':memory:' : path.resolve(dbPath);
  const writeLock = !inMemory && options.lock !== false;
  const maxDeliveryAttempts = Number.isInteger(options.maxDeliveryAttempts) && options.maxDeliveryAttempts > 0
    ? Math.min(options.maxDeliveryAttempts, 100)
    : MAX_DELIVERY_ATTEMPTS;
  const maxDeferAttempts = Number.isInteger(options.maxDeferAttempts) && options.maxDeferAttempts > 0
    ? Math.min(options.maxDeferAttempts, 100)
    : MAX_DEFER_ATTEMPTS;
  const busyTimeoutMs = Number.isInteger(options.busyTimeoutMs) && options.busyTimeoutMs >= 0
    ? options.busyTimeoutMs
    : 5000;

  let lockPath = null;
  let db;
  if (!inMemory) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    if (writeLock) lockPath = acquireLock(resolved);
  }

  try {
    db = new DatabaseSync(resolved);
    if (!inMemory) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      hardenPermissions(resolved);
    }
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  } catch (error) {
    try {
      db?.close();
    } catch {
      // 忽略
    }
    releaseLock(lockPath);
    throw error;
  }

  let closed = false;
  let txDepth = 0;

  function assertOpen() {
    if (closed) throw new StoreError('STORE_CLOSED', 'store 已关闭');
  }

  // 嵌套调用并入外层事务；BEGIN IMMEDIATE 保证单写者写锁。
  function tx(fn) {
    assertOpen();
    if (txDepth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    txDepth += 1;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败也要把原始错误抛出去
      }
      throw error;
    } finally {
      txDepth -= 1;
    }
  }

  function nowMs() {
    return Date.now();
  }

  // 启动时把上次进程遗留的 sending 全部落到 uncertain：结果未知，绝不默默重放。
  function recoverStaleSending() {
    const rows = db.prepare("SELECT id FROM outbox WHERE state = 'sending'").all();
    if (rows.length === 0) return 0;
    const at = nowMs();
    const update = db.prepare(
      "UPDATE outbox SET state = 'uncertain', last_error = COALESCE(last_error, 'RESTART_UNKNOWN_STATE'), updated_at = ? WHERE id = ?",
    );
    tx(() => {
      for (const row of rows) update.run(at, row.id);
    });
    return rows.length;
  }

  const recoveredFromRestart = recoverStaleSending();

  function getCursor(key) {
    if (typeof key !== 'string' || key === '') {
      throw new StoreError('INVALID_KEY', 'cursor key 需要非空字符串');
    }
    assertOpen();
    const row = db.prepare('SELECT cursor FROM cursors WHERE key = ?').get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.cursor);
    } catch {
      throw new StoreError('CORRUPT_CURSOR', 'cursor 不是合法 JSON');
    }
  }

  function ingest(key, nextCursor, events) {
    if (typeof key !== 'string' || key === '') {
      throw new StoreError('INVALID_KEY', 'ingest 需要非空游标 key');
    }
    if (!Array.isArray(events)) {
      throw new StoreError('INVALID_EVENTS', 'events 需要数组');
    }
    // 先校验再开事务，避免把半截数据带进 write lock 之外的地方。
    const cursorText = serializeCursor(nextCursor);
    const records = events.map((raw) => normalizeEventRecord(raw));
    const at = nowMs();
    return tx(() => {
      const exists = db.prepare('SELECT 1 AS hit FROM events WHERE id = ?');
      const insertEvent = db.prepare(
        `INSERT INTO events (id, stream, project_key, fact_key, state, first_seen, observed_at, decision, decided_at, payload)
         VALUES (?, ?, ?, ?, 'ready', ?, ?, NULL, NULL, ?)`,
      );
      const findObservation = db.prepare(
        'SELECT first_event_id FROM observations WHERE project_key = ? AND fact_key = ?',
      );
      const bumpObservation = db.prepare(
        'UPDATE observations SET last_seen_at = ?, seen_count = seen_count + 1 WHERE project_key = ? AND fact_key = ?',
      );
      const insertObservation = db.prepare(
        `INSERT INTO observations (project_key, fact_key, first_event_id, first_seen_at, last_seen_at, seen_count)
         VALUES (?, ?, ?, ?, ?, 1)`,
      );
      let inserted = 0;
      for (const record of records) {
        if (exists.get(record.id)) continue; // event.id 稳定唯一：同 id 只保留首份
        let firstSeen = 1;
        if (record.projectKey && record.factKey) {
          if (findObservation.get(record.projectKey, record.factKey)) {
            bumpObservation.run(at, record.projectKey, record.factKey);
            firstSeen = 0;
          } else {
            insertObservation.run(record.projectKey, record.factKey, record.id, at, at);
            firstSeen = 1;
          }
        }
        const result = insertEvent.run(
          record.id,
          key,
          record.projectKey,
          record.factKey,
          firstSeen,
          at,
          record.payloadText,
        );
        if (Number(result.changes) > 0) inserted += 1;
      }
      db.prepare(
        `INSERT INTO cursors (key, cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      ).run(key, cursorText, at);
      return inserted;
    });
  }

  function readyEvents(limit = 50) {
    assertOpen();
    const max = normalizeLimit(limit);
    if (max === 0) return [];
    const at = nowMs();
    return tx(() => {
      db.prepare(
        "UPDATE events SET state = 'ready' WHERE state = 'deferred' AND (defer_until IS NULL OR defer_until <= ?)",
      ).run(at);
      const rows = db.prepare(
        `SELECT ${EVENT_COLUMNS} FROM events WHERE state = 'ready' ORDER BY observed_at ASC, id ASC LIMIT ?`,
      ).all(max);
      return rows.map(rowToEvent);
    });
  }

  function recordDecision(eventId, decision) {
    if (typeof eventId !== 'string' || eventId === '') {
      throw new StoreError('INVALID_EVENT_ID', 'eventId 需要非空字符串');
    }
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new StoreError('INVALID_DECISION', 'decision 必须是对象');
    }
    let redacted;
    try {
      redacted = redact(decision);
      JSON.stringify(redacted);
    } catch {
      throw new StoreError('DECISION_NOT_SERIALIZABLE', 'decision 不是可序列化对象');
    }
    const decisionText = JSON.stringify(redacted);
    const projectKey = nullableString(redacted.projectKey ?? redacted.project_key ?? null);
    const factKey = nullableString(redacted.factKey ?? redacted.fact_key ?? redacted.fact ?? null);
    const shouldPush = redacted.push === true;
    const at = nowMs();

    return tx(() => {
      const row = db.prepare('SELECT id, state, decision FROM events WHERE id = ?').get(eventId);
      if (!row) throw new StoreError('UNKNOWN_EVENT', `事件不存在：${eventId}`);
      if (row.decision !== null && row.decision !== undefined) {
        // 幂等：同一事件重复出结论不覆盖，按首次结论回报
        const prior = JSON.parse(row.decision);
        return { queued: false, duplicate: prior?.push === true };
      }
      if (shouldPush && (projectKey === null || factKey === null)) {
        throw new StoreError('MISSING_DEDUPE_KEYS', 'push 决策必须带 projectKey + factKey');
      }
      db.prepare("UPDATE events SET state = 'decided', decision = ?, decided_at = ? WHERE id = ?")
        .run(decisionText, at, eventId);
      if (!shouldPush) return { queued: false, duplicate: false };

      const already = db.prepare(
        'SELECT outbox_id FROM pushed_facts WHERE project_key = ? AND fact_key = ?',
      ).get(projectKey, factKey);
      if (already) return { queued: false, duplicate: true };

      const outbox = db.prepare(
        `INSERT INTO outbox (event_id, project_key, fact_key, decision, state, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      ).run(eventId, projectKey, factKey, decisionText, at, at, at);
      db.prepare(
        'INSERT INTO pushed_facts (project_key, fact_key, event_id, outbox_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(projectKey, factKey, eventId, Number(outbox.lastInsertRowid), at);
      return { queued: true, duplicate: false };
    });
  }

  function deferEvent(eventId, delaySeconds = 0, reason = null) {
    if (typeof eventId !== 'string' || eventId === '') {
      throw new StoreError('INVALID_EVENT_ID', 'eventId 需要非空字符串');
    }
    const reasonCode = normalizeReason(reason);
    const delay = normalizeDelaySeconds(delaySeconds, 0);
    const at = nowMs();
    return tx(() => {
      const row = db.prepare('SELECT state, defer_count FROM events WHERE id = ?').get(eventId);
      if (!row) throw new StoreError('UNKNOWN_EVENT', `事件不存在：${eventId}`);
      if (row.state === 'decided') throw new StoreError('ALREADY_DECIDED', '事件已出结论，不能再延后');
      if (row.state === 'dead') {
        return { state: 'dead', attempts: row.defer_count, deferUntilAt: null };
      }
      const attempts = row.defer_count + 1;
      if (attempts >= maxDeferAttempts) {
        db.prepare(
          "UPDATE events SET state = 'dead', defer_count = ?, defer_until = NULL, defer_reason = ? WHERE id = ?",
        ).run(attempts, reasonCode, eventId);
        return { state: 'dead', attempts, deferUntilAt: null };
      }
      const deferUntilAt = at + delay * 1000;
      db.prepare(
        "UPDATE events SET state = 'deferred', defer_count = ?, defer_until = ?, defer_reason = ? WHERE id = ?",
      ).run(attempts, deferUntilAt, reasonCode, eventId);
      return { state: 'deferred', attempts, deferUntilAt };
    });
  }

  function claimDelivery() {
    assertOpen();
    const at = nowMs();
    return tx(() => {
      const row = db.prepare(
        `SELECT id, decision, attempts FROM outbox
         WHERE state = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, id ASC LIMIT 1`,
      ).get(at);
      if (!row) return null;
      const attempts = row.attempts + 1;
      const updated = db.prepare(
        "UPDATE outbox SET state = 'sending', attempts = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
      ).run(attempts, at, row.id);
      if (Number(updated.changes) !== 1) return null;
      return { id: row.id, decision: JSON.parse(row.decision), attempts };
    });
  }

  function finishDelivery(id, outcome) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new StoreError('INVALID_DELIVERY_ID', 'finishDelivery(id) 需要正整数 id');
    }
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
      throw new StoreError('INVALID_OUTCOME', 'outcome 必须是对象');
    }
    if (!DELIVERY_OUTCOMES.includes(outcome.state)) {
      throw new StoreError('INVALID_OUTCOME_STATE', `outcome.state 只接受 ${DELIVERY_OUTCOMES.join(' / ')}`);
    }
    const reason = normalizeReason(outcome.reason);
    const delay = normalizeDelaySeconds(outcome.delaySeconds, DEFAULT_RETRY_DELAY_SECONDS);
    const messageId = typeof outcome.messageId === 'string' && outcome.messageId !== ''
      ? outcome.messageId.slice(0, MAX_MESSAGE_ID_LENGTH)
      : null;
    const at = nowMs();

    return tx(() => {
      const row = db.prepare('SELECT id, state, attempts FROM outbox WHERE id = ?').get(id);
      if (!row) throw new StoreError('UNKNOWN_DELIVERY', `outbox 条目不存在：${id}`);
      if (row.state !== 'sending') {
        throw new StoreError('NOT_SENDING', `outbox 条目状态是 ${row.state}，不在 sending`);
      }
      if (outcome.state === 'sent') {
        db.prepare(
          "UPDATE outbox SET state = 'sent', message_id = ?, last_error = NULL, updated_at = ? WHERE id = ?",
        ).run(messageId, at, id);
        return { id, state: 'sent', attempts: row.attempts, nextAttemptAt: null };
      }
      if (outcome.state === 'rejected') {
        db.prepare("UPDATE outbox SET state = 'rejected', last_error = ?, updated_at = ? WHERE id = ?")
          .run(reason, at, id);
        return { id, state: 'rejected', attempts: row.attempts, nextAttemptAt: null };
      }
      if (outcome.state === 'uncertain') {
        // 结果未知：终态，不自动重发
        db.prepare(
          "UPDATE outbox SET state = 'uncertain', last_error = COALESCE(?, 'UNKNOWN_OUTCOME'), updated_at = ? WHERE id = ?",
        ).run(reason, at, id);
        return { id, state: 'uncertain', attempts: row.attempts, nextAttemptAt: null };
      }
      // retryable：有限重试，超限置 dead
      if (row.attempts >= maxDeliveryAttempts) {
        db.prepare(
          "UPDATE outbox SET state = 'dead', last_error = COALESCE(?, 'RETRY_LIMIT_REACHED'), updated_at = ? WHERE id = ?",
        ).run(reason, at, id);
        return { id, state: 'dead', attempts: row.attempts, nextAttemptAt: null };
      }
      const nextAttemptAt = at + delay * 1000;
      db.prepare(
        "UPDATE outbox SET state = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
      ).run(nextAttemptAt, reason, at, id);
      return { id, state: 'pending', attempts: row.attempts, nextAttemptAt };
    });
  }

  function firstObservation(projectKey, factKey) {
    const project = nullableString(projectKey);
    const fact = nullableString(factKey);
    if (project === null || fact === null) return null;
    assertOpen();
    const row = db.prepare(
      `SELECT first_event_id, first_seen_at, last_seen_at, seen_count
       FROM observations WHERE project_key = ? AND fact_key = ?`,
    ).get(project, fact);
    if (!row) return null;
    return {
      projectKey: project,
      factKey: fact,
      firstEventId: row.first_event_id,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      seenCount: row.seen_count,
    };
  }

  function countBy(table, column) {
    const counts = {};
    for (const value of column === 'state' ? EVENT_STATES : OUTBOX_STATES) counts[value] = 0;
    const rows = db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`).all();
    for (const row of rows) counts[row.k] = row.n;
    return counts;
  }

  function recentDecisions(limit = 10) {
    assertOpen();
    return db.prepare('SELECT decision, decided_at FROM events WHERE decision IS NOT NULL ORDER BY decided_at DESC, rowid DESC LIMIT ?')
      .all(Math.min(normalizeLimit(limit),100)).map(row=>({at:new Date(row.decided_at).toISOString(),...JSON.parse(row.decision)}));
  }

  function status() {
    assertOpen();
    const at = nowMs();
    const eventCounts = countBy('events', 'state');
    const outboxCounts = countBy('outbox', 'state');
    const dueDeferred = db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE state = 'deferred' AND (defer_until IS NULL OR defer_until <= ?)",
    ).get(at).n;
    const duePending = db.prepare(
      "SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending' AND next_attempt_at <= ?",
    ).get(at).n;
    const oldestDue = db.prepare(
      "SELECT MIN(next_attempt_at) AS at FROM outbox WHERE state = 'pending' AND next_attempt_at <= ?",
    ).get(at).at;
    const observationCount = db.prepare('SELECT COUNT(*) AS n FROM observations').get().n;
    const firstObservations = db.prepare('SELECT COUNT(*) AS n FROM events WHERE first_seen = 1').get().n;

    return {
      events: {
        total: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
        ...eventCounts,
        dueDeferred,
        firstObservations,
        observations: observationCount,
      },
      outbox: {
        total: db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,
        ...outboxCounts,
        duePending,
        oldestDueAt: oldestDue ?? null,
        maxAttempts: maxDeliveryAttempts,
      },
      observations: {
        tracked: observationCount,
        firstObservations,
      },
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      if (!inMemory) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // checkpoint 失败不影响关闭
    }
    try {
      db.close();
    } finally {
      releaseLock(lockPath);
      lockPath = null;
    }
  }

  return {
    path: resolved,
    inMemory,
    recoveredFromRestart,
    maxDeliveryAttempts,
    maxDeferAttempts,
    close,
    getCursor,
    ingest,
    readyEvents,
    recordDecision,
    deferEvent,
    claimDelivery,
    finishDelivery,
    recentDecisions,
    status,
    firstObservation,
    recoverStaleSending,
    redact,
  };
}

export default openStore;
