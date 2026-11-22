import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { validatePolicy } from './policy.mjs';

function invalid(name) { throw new Error(`Invalid configuration: ${name}`); }
function object(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid(name);
  return value;
}
function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) invalid(name);
  return value;
}
function bool(value, name) {
  if (typeof value !== 'boolean') invalid(name);
  return value;
}
function url(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { invalid(name); }
  const loopback = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !loopback)) invalid(name);
  return parsed.href.replace(/\/+$/u, '');
}
function readJson(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')); } catch { invalid(label); }
}
function localName(value, name, suffix) {
  if (typeof value !== 'string' || !new RegExp(`^[a-zA-Z0-9_-]+\\.${suffix}$`, 'u').test(value)) invalid(name);
  return value;
}
function credentials(env, name, required = false) {
  if (!required) return '';
  const value = String(env[name] ?? '').trim();
  if (!value || value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) invalid(`set ${name}`);
  return value;
}
function streamSettings(value, name) {
  const posts = bool(value.posts, `${name}.posts`);
  const following = bool(value.following, `${name}.following`);
  if (!posts && !following) invalid(`${name}: enable posts or following`);
  return { posts, following };
}
function numericId(value, name) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,24}$/u.test(value)) invalid(name);
  return value;
}
function provider(raw, name, apiKey) {
  const source = object(raw, ['baseUrl', 'maxPages', 'timeoutMs'], name);
  return Object.freeze({
    apiKey,
    baseUrl: url(source.baseUrl, `${name}.baseUrl`),
    maxPages: integer(source.maxPages, 1, 100, `${name}.maxPages`),
    timeoutMs: integer(source.timeoutMs, 1000, 120000, `${name}.timeoutMs`),
  });
}
export function validateRuntime(raw, { cwd = process.cwd(), env = process.env, policy } = {}) {
  if (raw && Object.hasOwn(raw, 'x')) invalid('replace the old x block with the new collection template');
  object(raw, ['policyFile', 'databaseFile', 'pollSeconds', 'analysisBatchSize', 'watch', 'lists', 'collection', 'model', 'delivery'], 'runtime');
  const { policyFile, databaseFile } = raw;
  localName(policyFile, 'policyFile', 'json');
  localName(databaseFile, 'databaseFile', 'sqlite');
  const collection = object(raw.collection, ['socialdata', 'scrapertech', 'maxAccounts', 'followTimelineLimit'], 'collection');
  const model = object(raw.model, ['baseUrl', 'name', 'apiStyle', 'timeoutMs'], 'model');
  const delivery = object(raw.delivery, ['mode', 'baseUrl', 'timeoutMs', 'batchSize'], 'delivery');
  if (!['disabled', 'telegram'].includes(delivery.mode)) invalid('delivery.mode');
  if (!['chat_completions', 'responses'].includes(model.apiStyle)) invalid('model.apiStyle');
  if (typeof model.name !== 'string' || model.name === 'SET_YOUR_MODEL' || !/^[\w.\/:@+-]{1,128}$/u.test(model.name)) invalid('model.name (set your model)');
  if (!Array.isArray(raw.watch) || raw.watch.length > 500) invalid('watch');
  if (!Array.isArray(raw.lists) || raw.lists.length > 20) invalid('lists');
  if (!raw.watch.length && !raw.lists.length) invalid('add an account in watch or a list in lists');
  const watch = raw.watch.map(entry => {
    object(entry, ['username', 'restId', 'posts', 'following', 'official'], 'watch entry');
    if (typeof entry.username !== 'string' || entry.username.toLowerCase() === 'replace_me' || !/^[A-Za-z0-9_]{1,15}$/u.test(entry.username)) invalid('watch.username (replace the example with your account)');
    return Object.freeze({
      username: entry.username.toLowerCase(),
      restId: entry.restId == null ? null : numericId(entry.restId, 'watch.restId'),
      ...streamSettings(entry, 'watch'),
      official: bool(entry.official, 'watch.official'),
    });
  });
  if (new Set(watch.map(entry => entry.username)).size !== watch.length) invalid('watch.username duplicate');
  const lists = raw.lists.map(entry => {
    object(entry, ['listId', 'posts', 'following'], 'list entry');
    return Object.freeze({ listId: numericId(entry.listId, 'lists.listId'), ...streamSettings(entry, 'lists') });
  });
  if (new Set(lists.map(entry => entry.listId)).size !== lists.length) invalid('lists.listId duplicate');
  const maxAccounts = integer(collection.maxAccounts, 1, 500, 'collection.maxAccounts');
  if (watch.length > maxAccounts) invalid('watch exceeds collection.maxAccounts');
  const needsSocialData = watch.some(entry => entry.posts || !entry.restId) || lists.some(entry => entry.posts);
  const needsScraperTech = watch.some(entry => entry.following) || lists.length > 0;
  const modelUrl = url(model.baseUrl, 'model.baseUrl');
  const modelKey = new URL(modelUrl).protocol === 'http:' && !env.ALPHA_MODEL_API_KEY
    ? '' : credentials(env, 'ALPHA_MODEL_API_KEY', true);
  const sending = delivery.mode === 'telegram';
  const botToken = credentials(env, 'ALPHA_TELEGRAM_BOT_TOKEN', sending);
  const chatId = credentials(env, 'ALPHA_TELEGRAM_CHAT_ID', sending);
  if (sending && (!/^\d+:[A-Za-z0-9_-]+$/u.test(botToken) || !/^(?:-?\d+|@[A-Za-z0-9_]+)$/u.test(chatId))) invalid('Telegram credentials');
  if (sending && env.ALPHA_ENABLE_LIVE_DELIVERY !== '1') invalid('set ALPHA_ENABLE_LIVE_DELIVERY=1 to enable live delivery');
  return Object.freeze({
    databasePath: path.resolve(cwd, 'data', databaseFile),
    pollSeconds: integer(raw.pollSeconds, 30, 86400, 'pollSeconds'),
    analysisBatchSize: integer(raw.analysisBatchSize, 1, 100, 'analysisBatchSize'),
    watch: Object.freeze(watch),
    lists: Object.freeze(lists),
    maxAccounts,
    followTimelineLimit: integer(collection.followTimelineLimit, 0, 20, 'collection.followTimelineLimit'),
    socialdata: provider(collection.socialdata, 'collection.socialdata', credentials(env, 'SOCIALDATA_API_KEY', needsSocialData)),
    scrapertech: provider(collection.scrapertech, 'collection.scrapertech', credentials(env, 'SCRAPERTECH_API_KEY', needsScraperTech)),
    model: Object.freeze({ apiKey: modelKey, baseUrl: modelUrl, model: model.name, apiStyle: model.apiStyle, timeoutMs: integer(model.timeoutMs, 1000, 240000, 'model.timeoutMs') }),
    delivery: Object.freeze({ mode: delivery.mode, botToken, chatId, baseUrl: url(delivery.baseUrl, 'delivery.baseUrl'), timeoutMs: integer(delivery.timeoutMs, 1000, 120000, 'delivery.timeoutMs'), batchSize: integer(delivery.batchSize, 1, 100, 'delivery.batchSize') }),
    policy: validatePolicy(policy),
  });
}
export function loadRuntime(configDir, { cwd = process.cwd(), env = process.env } = {}) {
  let dir;
  try { dir = realpathSync(configDir); } catch { invalid('configuration directory missing'); }
  const raw = readJson(path.join(dir, 'runtime.json'), 'runtime.json');
  const policyFile = localName(raw?.policyFile, 'policyFile', 'json');
  return validateRuntime(raw, { cwd, env, policy: readJson(path.join(dir, policyFile), 'policy JSON') });
}
