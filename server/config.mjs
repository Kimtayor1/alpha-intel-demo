import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { validatePolicy } from './policy.mjs';

function invalid(name) { throw new Error(`Invalid configuration: ${name}`); }
function object(v, fields, name) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))) invalid(name);
  return v;
}
function integer(v, min, max, name) { if (!Number.isInteger(v) || v < min || v > max) invalid(name); return v; }
function bool(v, name) { if (typeof v !== 'boolean') invalid(name); return v; }
function url(v, name) {
  let parsed;
  try { parsed = new URL(v); } catch { invalid(name); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)))) invalid(name);
  return parsed.href.replace(/\/$/u, '');
}
function readJson(file, label) {
  try { return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/u, '')); } catch { invalid(label); }
}
function localName(v, name, suffix) {
  if (typeof v !== 'string' || !new RegExp(`^[a-zA-Z0-9_-]+\\.${suffix}$`, 'u').test(v)) invalid(name);
  return v;
}
function credentials(env, name, required) {
  const v = String(env[name] ?? '').trim();
  if (required && (!v || v.length > 4096 || /[\r\n]/u.test(v))) invalid(`set ${name}`);
  return v;
}
export function validateRuntime(raw, { cwd = process.cwd(), env = process.env, policy } = {}) {
  object(raw, ['policyFile','databaseFile','pollSeconds','analysisBatchSize','watch','x','model','delivery'], 'runtime');
  const { policyFile, databaseFile } = raw;
  localName(policyFile,'policyFile','json'); localName(databaseFile,'databaseFile','sqlite');
  const x = object(raw.x,['baseUrl','maxPages','timeoutMs'],'x');
  const model = object(raw.model,['baseUrl','name','apiStyle','timeoutMs'],'model');
  const delivery = object(raw.delivery,['mode','baseUrl','timeoutMs','batchSize'],'delivery');
  if (!['disabled','telegram'].includes(delivery.mode)) invalid('delivery.mode');
  const sending = delivery.mode === 'telegram';
  if (!['chat_completions','responses'].includes(model.apiStyle)) invalid('model.apiStyle');
  if (typeof model.name !== 'string' || model.name==='SET_YOUR_MODEL' || !/^[\w.\/:@+-]{1,128}$/u.test(model.name)) invalid('model.name (set your model)');
  if (!Array.isArray(raw.watch) || raw.watch.length < 1 || raw.watch.length > 100) invalid('watch (1–100 entries)');
  const watch = raw.watch.map(w => {
    object(w,['username','posts','following','official'],'watch entry');
    if (typeof w.username !== 'string' || w.username.toLowerCase()==='replace_me' || !/^[A-Za-z0-9_]{1,15}$/u.test(w.username)) invalid('watch.username (replace the example with your account)');
    if (!bool(w.posts,'watch.posts') && !bool(w.following,'watch.following')) invalid('watch: enable posts or following');
    return Object.freeze({ username:w.username.toLowerCase(), posts:bool(w.posts,'watch.posts'), following:bool(w.following,'watch.following'), official:bool(w.official,'watch.official') });
  });
  if (new Set(watch.map(w=>w.username)).size!==watch.length) invalid('watch.username duplicate');
  const modelUrl=url(model.baseUrl,'model.baseUrl');
  const localModel=new URL(modelUrl).protocol==='http:';
  const modelKey=credentials(env,'ALPHA_MODEL_API_KEY',!localModel);
  const xToken=credentials(env,'ALPHA_X_BEARER_TOKEN',true);
  const botToken=sending ? credentials(env,'ALPHA_TELEGRAM_BOT_TOKEN',true) : '';
  const chatId=sending ? credentials(env,'ALPHA_TELEGRAM_CHAT_ID',true) : '';
  if (sending && (!/^\d+:[A-Za-z0-9_-]+$/u.test(botToken) || !/^(?:-?\d+|@[A-Za-z0-9_]+)$/u.test(chatId))) invalid('Telegram credentials');
  if (sending && env.ALPHA_ENABLE_LIVE_DELIVERY !== '1') invalid('set ALPHA_ENABLE_LIVE_DELIVERY=1 to enable live delivery');
  return Object.freeze({ databasePath:path.resolve(cwd,'data',databaseFile), pollSeconds:integer(raw.pollSeconds,30,86400,'pollSeconds'), analysisBatchSize:integer(raw.analysisBatchSize,1,100,'analysisBatchSize'), watch:Object.freeze(watch), x:Object.freeze({bearerToken:xToken,baseUrl:url(x.baseUrl,'x.baseUrl'),maxPages:integer(x.maxPages,1,100,'x.maxPages'),timeoutMs:integer(x.timeoutMs,1000,120000,'x.timeoutMs')}), model:Object.freeze({apiKey:modelKey,baseUrl:url(model.baseUrl,'model.baseUrl'),model:model.name,apiStyle:model.apiStyle,timeoutMs:integer(model.timeoutMs,1000,240000,'model.timeoutMs')}), delivery:Object.freeze({mode:delivery.mode,botToken,chatId,baseUrl:url(delivery.baseUrl,'delivery.baseUrl'),timeoutMs:integer(delivery.timeoutMs,1000,120000,'delivery.timeoutMs'),batchSize:integer(delivery.batchSize,1,100,'delivery.batchSize')}), policy:validatePolicy(policy) });
}
export function loadRuntime(configDir, { cwd = process.cwd(), env = process.env } = {}) {
  let dir;
  try { dir=realpathSync(configDir); } catch { invalid('configuration directory missing'); }
  const raw=readJson(path.join(dir,'runtime.json'),'runtime.json');
  const policyFile=localName(raw?.policyFile,'policyFile','json');
  return validateRuntime(raw,{cwd,env,policy:readJson(path.join(dir,policyFile),'policy JSON')});
}
