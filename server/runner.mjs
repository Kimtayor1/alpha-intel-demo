import { createHash } from 'node:crypto';
import { buildPolicyPrompt, applyPolicy } from './policy.mjs';

const accountId = (x) => typeof x === 'string' && /^\d{1,24}$/u.test(x);
function maxId(items) { return items.reduce((a, b) => BigInt(a) < BigInt(b) ? b : a, '0'); }
function compareId(a, b) { return BigInt(a) < BigInt(b) ? -1 : BigInt(a) === BigInt(b) ? 0 : 1; }
const retryDelay = (err, fallback = 60) => Number.isFinite(err?.retryAfterSeconds) && err.retryAfterSeconds >= 0 ? Math.max(1, Math.min(86400,Math.ceil(err.retryAfterSeconds))) : fallback;
const reason = (err, label) => (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600) ? `${label}_HTTP_${err.status}` : `${label}_FAILED`;
function asHttps(value) {
  try { const u = new URL(value); if (u.protocol === 'https:' && !u.username && !u.password) return u.href; } catch { /* Not evidence. */ }
  return null;
}
function postEvidence(item, actor) {
  const ownPost = { id: 'source', url: `https://x.com/${actor.username}/status/${item.id}`, kind: 'post', origin: `x-user:${actor.id}`, official: actor.official && item.repost !== true };
  // Links in a post are evidence leads, not independent corroboration. They share the post's origin.
  const links = Array.isArray(item.urls) ? item.urls : [];
  const urls = [...new Set(links.filter(v => typeof v === 'string').map(asHttps).filter(Boolean))].filter(v => v !== ownPost.url).slice(0,9);
  const refs=(Array.isArray(item.referenced) ? item.referenced : []).filter(ref=>accountId(ref?.id) && accountId(ref?.authorId) && ref.id!==item.id).slice(0,4);
  return [ownPost, ...refs.map((ref,i)=>({id:`related-${i+1}`,url:`https://x.com/i/web/status/${ref.id}`,kind:'post',origin:`x-user:${ref.authorId}`,official:false})), ...urls.map((url,i) => ({ id:`link-${i+1}`,url,kind:'link',origin:ownPost.origin,official:false }))];
}
function postEvent(item, actor) {
  const context=(Array.isArray(item.referenced) ? item.referenced : []).filter(ref=>accountId(ref?.id) && typeof ref.text==='string').slice(0,4).map(ref=>`Referenced post ${ref.id}: ${ref.text.slice(0,850)}`);
  return { id:`post:${item.id}`, kind:'post', sourceAccount:actor.username, text:[item.text.slice(0,4300), ...context].join('\n').slice(0,8000), evidence:postEvidence(item,actor) };
}
function followEvent(item, actor, epoch) {
  const fingerprint=createHash('sha256').update(`${actor.id}:${item.id}:${epoch}`).digest('hex').slice(0,24);
  return { id:`follow:${fingerprint}`, kind:'follow', sourceAccount:actor.username, text:`X account @${actor.username} now follows @${item.username}. This is an observed change, not an endorsement.`, evidence:[{id:'source',url:`https://x.com/${actor.username}/following`,kind:'follow',origin:`x-user:${actor.id}`,official:false},{id:'target',url:`https://x.com/${item.username}`,kind:'profile',origin:`x-user:${actor.id}`,official:false}] };
}
function resultById(items) { return new Map(items.map(item=>[item.id,item])); }
function validateRead(result, type) {
  if (!result || !Array.isArray(result.items) || typeof result.complete!=='boolean') throw new Error('invalid source result');
  const ok=result.items.every(item=>item && accountId(item.id) && (type==='post' ? typeof item.text==='string' : typeof item.username==='string' && /^[A-Za-z0-9_]{1,15}$/u.test(item.username)));
  if (!ok) throw new Error('invalid source item');
  return result;
}
async function posts(actor, deps, counters) {
  const key=`posts:${actor.id}`;
  const previous=deps.store.getCursor(key);
  const sinceId=previous?.sinceId && previous.sinceId!=='0' ? previous.sinceId : null;
  const result=validateRead(await deps.x.readPosts(actor.id,{sinceId,baseline:!previous}),'post');
  if (!result.complete) { counters.partial++; return; }
  const items=[...resultById(result.items).values()].filter(item=>item.authorId===actor.id);
  const newer=items.filter(item=>!previous || compareId(item.id,previous.sinceId)>0);
  const high=maxId(items.map(item=>item.id));
  const newCursor={sinceId:previous && compareId(previous.sinceId,high)>0 ? previous.sinceId : high};
  const events=previous ? newer.sort((a,b)=>compareId(a.id,b.id)).map(item=>postEvent(item,actor)) : [];
  counters.ingested+=deps.store.ingest(key,newCursor,events);
  if (!previous) counters.baselines++;
}
async function following(actor,deps,counters) {
  const key=`following:${actor.id}`;
  const previous=deps.store.getCursor(key);
  const result=validateRead(await deps.x.readFollowing(actor.id),'follow');
  if (!result.complete) { counters.partial++; return; }
  const current=resultById(result.items);
  const epoch=previous ? previous.epoch+1 : 0;
  const prior=new Set(previous?.ids ?? []);
  const events=previous ? [...current.values()].filter(item=>!prior.has(item.id)).map(item=>followEvent(item,actor,epoch)) : [];
  counters.ingested+=deps.store.ingest(key,{ids:[...current.keys()],epoch},events);
  if (!previous) counters.baselines++;
}
export function formatNotification(decision) {
  const clean=(v,n)=>String(v??'').replace(/[\u0000-\u001f\u007f]/gu,' ').slice(0,n);
  const proof=decision.evidence.slice(0,4).map(item=>asHttps(item.url)).filter(Boolean).map(v=>v.slice(0,200));
  return ['ALPHA · 新情报',clean(decision.title,140),clean(decision.summary,1400),`项目：${clean(decision.projectKey,100)}`, ...proof].join('\n').slice(0,3500);
}
export function createRunner(config, { x, model, telegram, store }) {
  const actorCache=new Map();
  const deps={x,store};
  const policyPrompt=buildPolicyPrompt(config.policy);
  let active=false;
  const limitedUntil={X:0,MODEL:0,TELEGRAM:0};
  const delayFor=(kind,err)=>{if(err?.status===429) limitedUntil[kind]=Date.now()+retryDelay(err,config.pollSeconds)*1000;};
  async function runCycle({ collect = true } = {}) {
    if (active) throw new Error('A cycle is already in progress');
    active=true;
    const counters={baselines:0,ingested:0,partial:0,sourceErrors:0,analyzed:0,analysisErrors:0,queued:0,suppressed:0,sent:0,deliveryErrors:0,problems:{}};
    const note=(label,err)=>{ const code=reason(err,label); counters.problems[code]=(counters.problems[code] ?? 0)+1; delayFor(label.split('_')[0],err); };
    try {
      if (collect && Date.now()>=limitedUntil.X) for (const target of config.watch) {
        let actor;
        try {
          actor=actorCache.get(target.username);
          if (!actor) {
            const selected=await x.resolveUser(target.username);
            if (!selected || !accountId(selected.id) || typeof selected.username!=='string' || selected.username.toLowerCase()!==target.username) throw new Error('X user mismatch');
            actor={id:selected.id,username:target.username,official:target.official}; actorCache.set(target.username,actor);
          }
        } catch (err) { counters.sourceErrors++; note('X_LOOKUP',err); if (err?.status===429) break; continue; }
        let rateLimited=false;
        if (target.posts) try { await posts(actor,deps,counters); } catch (err) { counters.sourceErrors++; note('X_POSTS',err); rateLimited=err?.status===429; }
        if (!rateLimited && target.following) try { await following(actor,deps,counters); } catch (err) { counters.sourceErrors++; note('X_FOLLOWING',err); rateLimited=err?.status===429; }
        if (rateLimited) break;
      }
      for (const { event } of Date.now()>=limitedUntil.MODEL ? store.readyEvents(config.analysisBatchSize) : []) {
        try {
          const result=await model.analyze({event,policyPrompt});
          const decision=applyPolicy(config.policy,event,result);
          const outcome=store.recordDecision(event.id,decision);
          counters.analyzed++;
          if (outcome.queued) counters.queued++;
          if (outcome.duplicate) counters.suppressed++;
        } catch (err) {
          counters.analysisErrors++; note('MODEL',err);
          store.deferEvent(event.id,retryDelay(err),reason(err,'MODEL'));
          if (err?.status===429) break;
        }
      }
      if (config.delivery.mode==='telegram' && Date.now()>=limitedUntil.TELEGRAM) {
        if (!telegram) throw new Error('Telegram adapter is not configured');
        for (let n=0;n<config.delivery.batchSize;n++) {
          const pending=store.claimDelivery();
          if (!pending) break;
          let sent;
          try {
            sent=await telegram.send(formatNotification(pending.decision));
          } catch (err) {
            const state=['retryable','rejected','uncertain'].includes(err?.deliveryState) ? err.deliveryState : 'uncertain';
            counters.deliveryErrors++; note('TELEGRAM',err);
            store.finishDelivery(pending.id,{state,delaySeconds:retryDelay(err),reason:reason(err,'TELEGRAM')});
            if (state==='retryable' || state==='uncertain') break;
            continue;
          }
          store.finishDelivery(pending.id,{state:'sent',messageId:String(sent.messageId)});
          counters.sent++;
        }
      }
      return counters;
    } finally { active=false; }
  }
  return { runCycle };
}
