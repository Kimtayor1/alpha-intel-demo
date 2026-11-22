import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateRuntime } from '../server/config.mjs';
import { createRunner } from '../server/runner.mjs';
import { openStore } from '../server/store.mjs';
import { applyPolicy } from '../server/policy.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../server/cli.mjs', import.meta.url));
const template = JSON.parse(await readFile(new URL('../config/runtime.example.json', import.meta.url), 'utf8'));
const policy = JSON.parse(await readFile(new URL('../config/policy.example.json', import.meta.url), 'utf8'));
const fakeEnv = { SOCIALDATA_API_KEY:'fixture-social', SCRAPERTECH_API_KEY:'fixture-scraper', ALPHA_MODEL_API_KEY:'fixture-model' };
const liveEnv = { ...fakeEnv, ALPHA_TELEGRAM_BOT_TOKEN:'1:fixture-telegram', ALPHA_TELEGRAM_CHAT_ID:'-123', ALPHA_ENABLE_LIVE_DELIVERY:'1' };
const post = id => ({ id, authorId:'9', text:'Fictional project ships a feature.' });
const verdict = { decision:'QUALIFIED', projectKey:'test-project', factKey:'feature-1', title:'Feature', summary:'Test result', confidence:0.92, evidenceIds:['source'] };
const unresolved = { ...verdict, decision:'UNRESOLVED', projectKey:'', factKey:'' };
function setup() {
  const raw = structuredClone(template);
  raw.model.name = 'fixture-model';
  raw.watch = [{ username:'demo_account', posts:true, following:true, official:true }];
  return raw;
}

test('configuration requires only the providers used by the enabled streams', () => {
  const raw = setup();
  assert.equal(validateRuntime(raw, { env:fakeEnv, policy }).delivery.mode, 'disabled');
  assert.throws(() => validateRuntime(raw, { env:{ ALPHA_MODEL_API_KEY:'fixture' }, policy }), /SOCIALDATA_API_KEY/u);
  assert.throws(() => validateRuntime(raw, { env:{ ...fakeEnv, SCRAPERTECH_API_KEY:'' }, policy }), /SCRAPERTECH_API_KEY/u);
  const postOnly = setup();
  postOnly.watch[0].following = false;
  assert.equal(validateRuntime(postOnly, { env:{ ...fakeEnv, SCRAPERTECH_API_KEY:'' }, policy }).scrapertech.apiKey, '');
  const followOnly = setup();
  followOnly.watch = [];
  followOnly.lists = [{ listId:'51', posts:false, following:true }];
  assert.equal(validateRuntime(followOnly, { env:{ ...fakeEnv, SOCIALDATA_API_KEY:'' }, policy }).socialdata.apiKey, '');
  followOnly.watch = [{ username:'demo_account', restId:'9', posts:false, following:true, official:false }];
  followOnly.lists = [];
  assert.equal(validateRuntime(followOnly, { env:{ ...fakeEnv, SOCIALDATA_API_KEY:'' }, policy }).watch[0].restId, '9');
  const bad = setup();
  bad.delivery.mode = 'telegram';
  assert.throws(() => validateRuntime(bad, { env:{ ...liveEnv, ALPHA_ENABLE_LIVE_DELIVERY:'0' }, policy }), /ALPHA_ENABLE_LIVE_DELIVERY/u);
  assert.equal(validateRuntime(bad, { env:liveEnv, policy }).delivery.mode, 'telegram');
  const localhost = setup();
  localhost.model.baseUrl = 'http://127.0.0.1:8080/v1';
  assert.equal(validateRuntime(localhost, { env:{ ...fakeEnv, ALPHA_MODEL_API_KEY:'' }, policy }).model.apiKey, '');
  raw.watch[0].username = '@not_valid_input';
  assert.throws(() => validateRuntime(raw, { env:fakeEnv, policy }), /watch.username/u);
});

test('partial results preserve both cursors, and an unavailable new follow resolves once', async () => {
  const config = validateRuntime(setup(), { env:fakeEnv, policy });
  const store = openStore(':memory:');
  let round = 0;
  const checked = [];
  const runner = createRunner(config, {
    store,
    model:{ analyze:async ({ event }) => { checked.push(event.kind); return event.kind === 'post' ? verdict : unresolved; } },
    telegram:{ send:() => assert.fail('delivery should remain disabled') },
    socialdata:{
      resolveUser:async () => ({ id:'9', username:'demo_account' }),
      readPosts:async (handle, { sinceId, baseline }) => {
        assert.equal(handle, 'demo_account');
        assert.equal(baseline, round === 0);
        assert.equal(sinceId, round === 0 ? null : round > 2 ? '11' : '10');
        return { items:round === 0 ? [post('10')] : [post('11')], complete:round !== 1 };
      },
    },
    scrapertech:{ readFollowing:async () => ({
      items:round === 1 ? [] : [{ id:'19', username:'fictitious_a' }, ...(round > 1 ? [{ id:'20', username:round === 2 ? null : 'fictitious_b' }] : [])],
      complete:round !== 1,
    }) },
  });
  try {
    assert.equal((await runner.runCycle()).baselines, 2);
    assert.equal(store.status().events.total, 0);
    round = 1;
    assert.equal((await runner.runCycle()).partial, 2);
    assert.equal(store.getCursor('posts:9').sinceId, '10');
    assert.deepEqual(store.getCursor('following:9').ids, ['19']);
    round = 2;
    assert.equal((await runner.runCycle()).ingested, 1);
    assert.deepEqual(store.getCursor('following:9').pending, ['20']);
    round = 3;
    assert.equal((await runner.runCycle()).ingested, 1);
    assert.deepEqual(store.getCursor('following:9').pending, []);
    round = 4;
    assert.equal((await runner.runCycle()).ingested, 0);
    assert.deepEqual(checked.sort(), ['follow', 'post']);
    assert.equal(store.status().outbox.pending, 1);
  } finally { store.close(); }
});

test('partial rosters do not activate members and SocialData rate limits do not stop ScraperTech', async () => {
  const raw = setup();
  raw.watch[0].restId = '9';
  raw.lists = [{ listId:'51', posts:true, following:true }];
  const config = validateRuntime(raw, { env:fakeEnv, policy });
  const store = openStore(':memory:');
  let partial = true;
  let calls = 0;
  const observed = [];
  const runner = createRunner(config, {
    store, model:{ analyze:() => assert.fail('no analysis before events') },
    socialdata:{ readPosts:async () => { calls++; throw Object.assign(new Error('rate limited'), { status:429, retryAfterSeconds:600 }); } },
    scrapertech:{
      readListMembers:async () => ({ items:[{ id:'19', username:'list_account' }], complete:!partial }),
      readFollowing:async id => { observed.push(id); return { items:[], complete:true }; },
    },
  });
  try {
    assert.equal((await runner.runCycle()).partial, 1);
    assert.deepEqual(observed, ['9']);
    partial = false;
    await runner.runCycle();
    assert.equal(calls, 1);
    assert.deepEqual(observed, ['9', '9', '19']);
  } finally { store.close(); }
});

test('qualification requires sufficient cited independent and official evidence', () => {
  const strict = structuredClone(policy);
  strict.post.minIndependentSources = 2;
  const event = { id:'test', kind:'post', sourceAccount:'demo', text:'Fictional', evidence:[
    { id:'source', url:'https://a.example.invalid/', kind:'post', origin:'a', official:true },
    { id:'link', url:'https://a.example.invalid/link', kind:'link', origin:'a', official:false },
    { id:'other', url:'https://b.example.invalid/', kind:'post', origin:'b', official:false },
  ] };
  assert.equal(applyPolicy(strict, event, { ...verdict, evidenceIds:['source', 'link'] }).push, false);
  assert.equal(applyPolicy(policy, event, { ...verdict, evidenceIds:['other'] }).push, false);
  assert.equal(applyPolicy(strict, event, { ...verdict, evidenceIds:['source', 'other'] }).push, true);
});

test('CLI connects both providers, model and Telegram over loopback with an empty X official configuration', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'alpha-runtime-test-'));
  const raw = setup();
  raw.delivery.mode = 'telegram';
  raw.lists = [{ listId:'51', posts:true, following:true }];
  raw.collection.followTimelineLimit = 1;
  let round = 0;
  let modelCalls = 0;
  let sent = 0;
  let timelineCalls = 0;
  let listCalls = 0;
  const caught = [];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ALPHA_|SOCIALDATA_API_KEY$|SCRAPERTECH_API_KEY$)/iu.test(key)));
  const server = createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://localhost');
      function answer(value) {
        res.writeHead(200, { 'Content-Type':'application/json' });
        res.end(JSON.stringify(value));
      }
      if (route.pathname === '/list_members.php') {
        listCalls++;
        assert.equal(req.headers['scraper-key'], 'fixture-scraper');
        assert.equal(route.searchParams.get('list_id'), '51');
        return answer({ status:'ok', members:[{ user_id:'9', screen_name:'demo_account' }], more_users:false });
      }
      if (route.pathname === '/twitter/search') {
        assert.equal(req.headers.authorization, 'Bearer fixture-social');
        const query = 'from:demo_account' + (round === 0 ? '' : ` since_id:${round === 1 ? '10' : '11'}`);
        assert.equal(route.searchParams.get('query'), query);
        return answer({ tweets:round < 2 ? [{ id_str:round === 0 ? '10' : '11', user:{ id_str:'9' }, full_text:'Fictional feature.', tweet_created_at:'2026-01-01T00:00:00Z' }] : [], next_cursor:null });
      }
      if (route.pathname === '/following.php') {
        assert.equal(req.headers['scraper-key'], 'fixture-scraper');
        assert.equal(route.searchParams.get('rest_id'), '9');
        return answer({ status:'ok', following:[{ user_id:'12', screen_name:'first_demo' }, ...(round > 0 ? [{ user_id:'13', screen_name:'second_demo' }] : [])], more_users:false });
      }
      if (route.pathname === '/timeline.php') {
        timelineCalls++;
        assert.equal(req.headers['scraper-key'], 'fixture-scraper');
        assert.equal(route.searchParams.get('rest_id'), '13');
        return answer({ status:'ok', timeline:[{ tweet_id:'15', text:'Fictional timeline context.', author:{ rest_id:'13' } }] });
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      if (route.pathname === '/v1/chat/completions') {
        modelCalls++;
        assert.equal(req.headers.authorization, 'Bearer fixture-model');
        assert.match(payload.messages[0].content, /Operator policy:/u);
        const { event } = JSON.parse(payload.messages[1].content);
        if (event.kind === 'follow') assert.match(event.text, /Fictional timeline context/u);
        return answer({ choices:[{ message:{ content:JSON.stringify(event.kind === 'follow' ? unresolved : verdict) } }] });
      }
      if (route.pathname === '/bot1:fixture-telegram/sendMessage') {
        sent++;
        assert.equal(payload.chat_id, '-123');
        assert.equal(payload.parse_mode, undefined);
        assert.match(payload.text, /Feature/u);
        return answer({ ok:true, result:{ message_id:17 } });
      }
      assert.fail('unexpected route');
    } catch (error) { caught.push(error); res.writeHead(500); res.end('{}'); }
  }).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const host = `http://127.0.0.1:${server.address().port}`;
    raw.collection.socialdata.baseUrl = host;
    raw.collection.scrapertech.baseUrl = host;
    raw.model.baseUrl = `${host}/v1`;
    raw.delivery.baseUrl = host;
    const conf = path.join(temp, 'config', 'local');
    await mkdir(conf, { recursive:true });
    await writeFile(path.join(conf, 'runtime.json'), JSON.stringify(raw));
    await writeFile(path.join(conf, 'policy.json'), JSON.stringify(policy));
    await writeFile(path.join(temp, '.env'), Object.entries(liveEnv).map(([key, value]) => `${key}=${value}`).join('\n'));
    const cliRun = async command => JSON.parse((await run(process.execPath, ['--env-file-if-exists=.env', cli, command], { cwd:temp, env, timeout:8000 })).stdout);
    assert.equal((await cliRun('check')).configuration, 'ok');
    assert.equal((await cliRun('once')).cycle.baselines, 2);
    assert.equal(modelCalls, 0);
    round = 1;
    const activated = await cliRun('once');
    assert.equal(activated.cycle.ingested, 2);
    assert.equal(activated.cycle.analyzed, 2);
    assert.equal(activated.cycle.sent, 1);
    assert.equal(activated.status.outbox.sent, 1);
    assert.equal(modelCalls, 2);
    assert.equal(sent, 1);
    assert.equal(timelineCalls, 1);
    round = 2;
    assert.equal((await cliRun('once')).cycle.ingested, 0);
    assert.equal(sent, 1);
    assert.equal(listCalls, 3);
    assert.equal((await cliRun('status')).status.outbox.sent, 1);
    const { decisions } = await cliRun('decisions');
    assert.deepEqual(decisions.map(decision => decision.status).sort(), ['QUALIFIED', 'UNRESOLVED']);
    assert.deepEqual(caught, []);
    const db = await readFile(path.join(temp, 'data', 'alpha.sqlite'));
    for (const value of ['fixture-social', 'fixture-scraper', 'fixture-model', 'fixture-telegram']) assert.ok(!db.includes(value));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive:true, force:true });
  }
});
