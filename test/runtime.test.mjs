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

const run=promisify(execFile);
const cli=fileURLToPath(new URL('../server/cli.mjs',import.meta.url));
const template=JSON.parse(await readFile(new URL('../config/runtime.example.json',import.meta.url),'utf8'));
const policy=JSON.parse(await readFile(new URL('../config/policy.example.json',import.meta.url),'utf8'));
const fakeEnv={ALPHA_X_BEARER_TOKEN:'fixture-x',ALPHA_MODEL_API_KEY:'fixture-model'};
const liveEnv={...fakeEnv,ALPHA_TELEGRAM_BOT_TOKEN:'1:fixture-telegram',ALPHA_TELEGRAM_CHAT_ID:'-123',ALPHA_ENABLE_LIVE_DELIVERY:'1'};
const post=(id)=>({id,authorId:'9',text:'Fictional project ships a feature.'});
const verdict={decision:'QUALIFIED',projectKey:'test-project',factKey:'feature-1',title:'Feature',summary:'Test quote',confidence:0.92,evidenceIds:['source']};
function setup() { const raw=structuredClone(template); raw.model.name='fixture-model'; raw.watch=[{username:'demo_account',posts:true,following:true,official:true}]; return raw; }

test('config: checked settings are local, live Telegram requires two switches, local model can omit Key',()=>{
  const raw=setup(); assert.equal(validateRuntime(raw,{env:fakeEnv,policy}).delivery.mode,'disabled');
  const bad=structuredClone(raw); bad.delivery.mode='telegram';
  assert.throws(()=>validateRuntime(bad,{env:{...liveEnv,ALPHA_ENABLE_LIVE_DELIVERY:'0'},policy}),/ALPHA_ENABLE_LIVE_DELIVERY/u);
  assert.equal(validateRuntime(bad,{env:liveEnv,policy}).delivery.mode,'telegram');
  const localhost=structuredClone(raw); localhost.model.baseUrl='http://127.0.0.1:8080/v1';
  assert.equal(validateRuntime(localhost,{env:{ALPHA_X_BEARER_TOKEN:'fixture'},policy}).model.apiKey,'');
  raw.watch[0].username='@not_valid_input'; assert.throws(()=>validateRuntime(raw,{env:fakeEnv,policy}),/watch.username/u);
});

test('cycle: initial baseline, partial snapshots do not advance, repeat does not duplicate',async()=>{
  const config=validateRuntime(setup(),{env:fakeEnv,policy});
  const store=openStore(':memory:');
  let phase=0; const checked=[];
  const runner=createRunner(config,{store,model:{analyze:async({event})=>{checked.push(event.kind);return event.kind==='post' ? verdict : {...verdict,decision:'UNRESOLVED',projectKey:'',factKey:''};}},telegram:{send:()=>assert.fail('disabled')},x:{
    resolveUser:async()=>({id:'9',username:'demo_account'}),
    readPosts:async(_,{sinceId,baseline})=>{assert.equal(baseline,phase===0);assert.equal(sinceId,phase===0 ? null : phase>2 ? '11' : '10');return {items:phase===0 ? [post('10')] : [post('11')],complete:phase!==1};},
    readFollowing:async()=>({items:phase===1 ? [] : [{id:'19',username:'fictitious_a'},...(phase>1 ? [{id:'20',username:'fictitious_b'}] : [])],complete:phase!==1}),
  }});
  try {
    assert.equal((await runner.runCycle()).baselines,2);
    assert.equal(store.status().events.total,0);
    phase=1;const partial=await runner.runCycle();assert.equal(partial.partial,2);assert.equal(store.getCursor('posts:9').sinceId,'10');assert.deepEqual(store.getCursor('following:9').ids,['19']);
    phase=2;const found=await runner.runCycle();assert.equal(found.ingested,2);assert.equal(found.analyzed,2);assert.equal(found.queued,1);assert.equal(found.sent,0);assert.deepEqual(checked.sort(),['follow','post']);
    phase=3;assert.equal((await runner.runCycle()).ingested,0);assert.equal(store.status().outbox.pending,1);
  }finally{store.close();}
});

test('qualification requires sufficient cited independent and official evidence, not merely present evidence',()=>{
  const strict=structuredClone(policy); strict.post.minIndependentSources=2;
  const event={id:'test',kind:'post',sourceAccount:'demo',text:'Fictional',evidence:[{id:'source',url:'https://a.example.invalid/',kind:'post',origin:'a',official:true},{id:'link',url:'https://a.example.invalid/link',kind:'link',origin:'a',official:false},{id:'other',url:'https://b.example.invalid/',kind:'post',origin:'b',official:false}]};
  assert.equal(applyPolicy(strict,event,{...verdict,evidenceIds:['source','link']}).push,false);
  assert.equal(applyPolicy(policy,event,{...verdict,evidenceIds:['other']}).push,false);
  assert.equal(applyPolicy(strict,event,{...verdict,evidenceIds:['source','other']}).push,true);
});

test('real CLI and HTTP adapters integrate over loopback, no real provider credentials',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'alpha-runtime-test-'));
  const raw=setup();raw.delivery.mode='telegram';
  let round=0;let modelCalls=0;let sent=0; const caught=[];const env={...process.env,...liveEnv};
  const server=createServer(async(req,res)=>{
    try {
      const route=new URL(req.url,'http://localhost');
      const ans=(value)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
      if(route.pathname==='/2/users/by/username/demo_account'){ assert.equal(req.headers.authorization,'Bearer fixture-x');return ans({data:{id:'9',username:'demo_account'}}); }
      if(route.pathname==='/2/users/9/tweets'){
        assert.equal(req.headers.authorization,'Bearer fixture-x');
        assert.equal(route.searchParams.get('since_id'),round===0 ? null : round===1 ? '10' : '11');
        return ans({data:round<2 ? [{id:round===0 ? '10' : '11',author_id:'9',text:'Fictional feature.'}] : [], meta:{result_count:round<2 ? 1 : 0}});
      }
      if(route.pathname==='/2/users/9/following')return ans({data:[{id:'12',username:'first_demo'},...(round>0 ? [{id:'13',username:'second_demo'}] : [])],meta:{result_count:round>0 ? 2 : 1}});
      let body='';for await(const chunk of req)body+=chunk;
      const payload=JSON.parse(body);
      if(route.pathname==='/v1/chat/completions'){
        modelCalls++;assert.equal(req.headers.authorization,'Bearer fixture-model');
        assert.match(payload.messages[0].content,/Operator policy:/u);
        const {event}=JSON.parse(payload.messages[1].content);
        assert.ok(['post','follow'].includes(event.kind));
        return ans({choices:[{message:{content:JSON.stringify(event.kind==='follow' ? {...verdict,decision:'UNRESOLVED',projectKey:'',factKey:''} : verdict)}}]});
      }
      if(route.pathname==='/bot1:fixture-telegram/sendMessage'){
        sent++;assert.equal(payload.chat_id,'-123');assert.equal(payload.parse_mode,undefined);assert.match(payload.text,/Feature/u);return ans({ok:true,result:{message_id:17}});
      }
      assert.fail('unexpected route');
    } catch (error) { caught.push(error);res.writeHead(500);res.end('{}'); }
  }).listen(0,'127.0.0.1');
  try {
    await once(server,'listening');
    const host=`http://127.0.0.1:${server.address().port}`;raw.x.baseUrl=host;raw.model.baseUrl=host+'/v1';raw.delivery.baseUrl=host;
    const conf=path.join(temp,'config','local');await mkdir(conf,{recursive:true});
    await writeFile(path.join(conf,'runtime.json'),JSON.stringify(raw));await writeFile(path.join(conf,'policy.json'),JSON.stringify(policy));
    const cliRun=async(command)=>JSON.parse((await run(process.execPath,[cli,command],{cwd:temp,env,timeout:8000})).stdout);
    assert.equal((await cliRun('check')).configuration,'ok');
    assert.equal((await cliRun('once')).cycle.baselines,2);assert.equal(modelCalls,0);
    round=1;const activated=await cliRun('once');assert.equal(activated.cycle.ingested,2);assert.equal(activated.cycle.analyzed,2);assert.equal(activated.cycle.sent,1);assert.equal(activated.status.outbox.sent,1);assert.equal(modelCalls,2);assert.equal(sent,1);
    round=2;assert.equal((await cliRun('once')).cycle.ingested,0);assert.equal(sent,1);assert.equal((await cliRun('status')).status.outbox.sent,1);
    const {decisions}=await cliRun('decisions'); assert.deepEqual(decisions.map(d=>d.status).sort(),['QUALIFIED','UNRESOLVED']);
    assert.deepEqual(caught,[]);
    const db=await readFile(path.join(temp,'data','alpha.sqlite'));
    for(const value of ['fixture-x','fixture-model','fixture-telegram']) assert.ok(!db.includes(value));
  } finally { await new Promise(resolve=>server.close(resolve)); await rm(temp,{recursive:true,force:true}); }
});
