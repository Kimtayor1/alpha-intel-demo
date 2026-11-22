// server/store.mjs 的正向模拟测试：node --test test/store.test.mjs
// 全部用 :memory: 或系统临时目录，不碰生产库、不写 docs/、不联网、不装包。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  StoreError,
  MAX_DELIVERY_ATTEMPTS,
  MAX_DEFER_ATTEMPTS,
} from '../server/store.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-store-test-'));
test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function tempDb(name) {
  return path.join(tempRoot, `${name}.sqlite`);
}

// 纯合成事件：与 docs/lib/fixtures.js 同形，但测试内联，互不依赖。
function leadEvent(id, overrides = {}) {
  return {
    id,
    kind: 'lead',
    label: `合成事件 ${id}`,
    project: { key: 'nebulassand-demo', name: '星砂协议 NebulaSand（虚构）' },
    fact: 'waitlist_open',
    delta: '虚构推文称主网候补名单刚开放。',
    evidence: ['虚构证据 | https://evidence.demo.invalid/waitlist'],
    ...overrides,
  };
}

function pushDecision(overrides = {}) {
  return {
    decision: 'QUALIFIED_ALPHA',
    push: true,
    project_key: 'nebulassand-demo',
    fact_key: 'waitlist_open',
    ...overrides,
  };
}

test('cursor 与 events 同事务落盘，坏事件整批回滚', () => {
  const store = openStore(':memory:');
  assert.equal(store.getCursor('s:watchlist'), null);

  assert.equal(store.ingest('s:watchlist', { since: 'c2' }, [leadEvent('E1'), leadEvent('E2')]), 2);
  assert.deepEqual(store.getCursor('s:watchlist'), { since: 'c2' });

  // 同 id 事件不重复入库，但游标照常前进
  assert.equal(store.ingest('s:watchlist', { since: 'c3' }, [leadEvent('E1'), leadEvent('E3')]), 1);
  assert.deepEqual(store.getCursor('s:watchlist'), { since: 'c3' });
  assert.equal(store.status().events.total, 3);

  // 第二个事件缺 id：整批回滚，游标停在 c3，E4 不入库
  assert.throws(
    () => store.ingest('s:watchlist', { since: 'c4' }, [leadEvent('E4'), { kind: 'lead' }]),
    (error) => error instanceof StoreError && error.code === 'INVALID_EVENT_ID',
  );
  assert.deepEqual(store.getCursor('s:watchlist'), { since: 'c3' });
  assert.equal(store.readyEvents(10).filter((item) => item.id === 'E4').length, 0);
  assert.equal(store.status().events.total, 3);
  store.close();
});

test('同事件重复与同 project+fact 重复只进一条 outbox', () => {
  const store = openStore(':memory:');
  store.ingest('stream', 1, [leadEvent('E1')]);

  assert.deepEqual(store.recordDecision('E1', pushDecision()), { queued: true, duplicate: false });
  assert.deepEqual(store.recordDecision('E1', pushDecision()), { queued: false, duplicate: true });

  // 同项目同事实的改写事件：结论写入，但不重复排队
  store.ingest('stream', 2, [leadEvent('E2', { label: '同事实改写' })]);
  assert.deepEqual(
    store.recordDecision('E2', pushDecision({ projectKey: 'nebulassand-demo', factKey: 'waitlist_open' })),
    { queued: false, duplicate: true },
  );

  const status = store.status();
  assert.equal(status.outbox.total, 1);
  assert.equal(status.outbox.pending, 1);
  assert.equal(status.events.decided, 2);

  // 非 push 结论不排队
  store.ingest('stream', 3, [leadEvent('E3', { fact: 'attention_follow' })]);
  assert.deepEqual(store.recordDecision('E3', { decision: 'UNRESOLVED', push: false }), {
    queued: false,
    duplicate: false,
  });
  assert.equal(store.status().outbox.total, 1);
  store.close();
});

test('重启后游标/决策/outbox 持久，遗留 sending 进 uncertain 且不重放', () => {
  const dbPath = tempDb('persist');
  let store = openStore(dbPath);
  store.ingest('stream', { page: 3 }, [leadEvent('E1')]);
  assert.deepEqual(store.recordDecision('E1', pushDecision()), { queued: true, duplicate: false });

  const claim = store.claimDelivery();
  assert.equal(claim.id, 1);
  assert.equal(claim.attempts, 1);
  assert.equal(claim.decision.push, true);

  // 不调 finishDelivery 直接关库 = 模拟进程崩溃
  store.close();

  store = openStore(dbPath);
  assert.equal(store.recoveredFromRestart, 1);
  assert.deepEqual(store.getCursor('stream'), { page: 3 });
  assert.equal(store.status().outbox.uncertain, 1);
  assert.equal(store.claimDelivery(), null); // 不确定的不重发
  assert.equal(store.status().outbox.total, 1);
  assert.equal(store.recoverStaleSending(), 0); // 已无 sending
  store.close();
});

test('失败重试有限，超限置 dead；uncertain 是终态', () => {
  const store = openStore(':memory:');
  store.ingest('stream', 1, [leadEvent('E1')]);
  store.recordDecision('E1', pushDecision());

  const seenAttempts = [];
  for (;;) {
    const claim = store.claimDelivery();
    if (!claim) break;
    seenAttempts.push(claim.attempts);
    const result = store.finishDelivery(claim.id, {
      state: 'retryable',
      delaySeconds: 0,
      reason: 'CHANNEL_TIMEOUT',
    });
    if (result.state === 'dead') {
      assert.equal(claim.attempts, MAX_DELIVERY_ATTEMPTS);
      break;
    }
    assert.equal(result.state, 'pending');
  }
  assert.deepEqual(seenAttempts, [1, 2, 3, 4, 5]);
  assert.equal(store.status().outbox.dead, 1);
  assert.equal(store.claimDelivery(), null);

  // uncertain：投递结果未知，既不重试也不当作成功
  const other = openStore(':memory:');
  other.ingest('stream', 1, [leadEvent('E2')]);
  other.recordDecision('E2', pushDecision());
  const claimed = other.claimDelivery();
  const uncertain = other.finishDelivery(claimed.id, { state: 'uncertain', reason: 'NO_FINAL_STATE' });
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(other.claimDelivery(), null);
  assert.equal(other.status().outbox.uncertain, 1);
  other.close();

  // sent 记录 messageId
  const third = openStore(':memory:');
  third.ingest('stream', 1, [leadEvent('E3')]);
  third.recordDecision('E3', pushDecision());
  const thirdClaim = third.claimDelivery();
  const sent = third.finishDelivery(thirdClaim.id, { state: 'sent', messageId: 'msg-0001' });
  assert.equal(sent.state, 'sent');
  assert.equal(third.claimDelivery(), null);
  assert.equal(third.status().outbox.sent, 1);
  third.close();
  store.close();
});

test('延后到期才 ready，重试上限后 dead，reason 只收运行时代码', () => {
  const store = openStore(':memory:');
  store.ingest('stream', 1, [leadEvent('E1')]);
  assert.deepEqual(store.readyEvents(5).map((item) => item.id), ['E1']);

  const deferred = store.deferEvent('E1', 3600, 'RATE_LIMITED');
  assert.equal(deferred.state, 'deferred');
  assert.equal(deferred.attempts, 1);
  assert.equal(store.readyEvents(5).length, 0);

  // 0 秒延后立刻到期
  assert.equal(store.deferEvent('E1', 0, 'JUDGE_RETRY').state, 'deferred');
  assert.deepEqual(store.readyEvents(5).map((item) => item.id), ['E1']);

  // 正文式 reason 直接拒绝
  assert.throws(
    () => store.deferEvent('E1', 5, '等待人工核实，这条是正文'),
    (error) => error instanceof StoreError && error.code === 'INVALID_REASON',
  );

  let last = null;
  for (let index = 0; index < MAX_DEFER_ATTEMPTS; index += 1) {
    last = store.deferEvent('E1', 0, 'JUDGE_UNAVAILABLE');
  }
  assert.equal(last.state, 'dead');
  assert.equal(store.readyEvents(5).length, 0);
  assert.equal(store.status().events.dead, 1);
  store.close();
});

test('凭据不落库：事件与决策里的 token/cookie/apikey 都被脱敏', () => {
  const store = openStore(':memory:');
  store.ingest('stream', 1, [
    leadEvent('E1', {
      source: { token: 'tok-live-abc', apiKey: 'sk-live-xyz', nested: { cookie: 'sess=abc' } },
      Authorization: 'Bearer abc',
      headers: { 'x-api-key': 'k-123' },
    }),
  ]);
  const [ready] = store.readyEvents(1);
  const readyText = JSON.stringify(ready);
  for (const secret of ['tok-live-abc', 'sk-live-xyz', 'sess=abc', 'Bearer abc', 'k-123']) {
    assert.equal(readyText.includes(secret), false, `事件里残留了 ${secret}`);
  }
  assert.equal(ready.event.source.token, '[REDACTED]');
  assert.equal(ready.event.headers['x-api-key'], '[REDACTED]');
  assert.equal(ready.event.projectKey, undefined);

  store.recordDecision(
    'E1',
    pushDecision({ notify: { webhookSecret: 'whsec-1', chatId: 'c-1' } }),
  );
  const claim = store.claimDelivery();
  assert.equal(JSON.stringify(claim).includes('whsec-1'), false);
  assert.equal(claim.decision.notify.webhookSecret, '[REDACTED]');

  // status 不带任何事件正文
  const statusText = JSON.stringify(store.status());
  assert.equal(statusText.includes('虚构推文称主网候补名单刚开放'), false);
  assert.equal(statusText.includes('NebulaSand'), false);
  store.close();
});

test('首次观察：同项目同事实只记第一次，重复事件不刷新 firstSeen', () => {
  const store = openStore(':memory:');
  store.ingest('stream', 1, [leadEvent('E1')]);
  store.ingest('stream', 2, [leadEvent('E2'), leadEvent('E1')]);

  const ready = store.readyEvents(10);
  assert.deepEqual(ready.map((item) => item.id).sort(), ['E1', 'E2']);
  assert.equal(ready.find((item) => item.id === 'E1').firstSeen, true);
  assert.equal(ready.find((item) => item.id === 'E2').firstSeen, false);

  const obs = store.firstObservation('nebulassand-demo', 'waitlist_open');
  assert.equal(obs.firstEventId, 'E1');
  assert.equal(obs.seenCount, 2);
  assert.equal(store.status().events.firstObservations, 1);
  assert.equal(store.status().observations.tracked, 1);
  assert.equal(store.firstObservation('other-project', 'waitlist_open'), null);
  store.close();
});

test('单写者锁：同库第二个实例被拒，关闭后可重开', () => {
  const dbPath = tempDb('lock');
  const first = openStore(dbPath);
  assert.throws(
    () => openStore(dbPath),
    (error) => error instanceof StoreError && error.code === 'STORE_LOCKED',
  );
  first.close();
  assert.equal(fs.existsSync(`${dbPath}.lock`), false);

  const second = openStore(dbPath);
  second.ingest('stream', 1, [leadEvent('E1')]);
  assert.deepEqual(second.getCursor('stream'), 1);
  second.close();

  // 内存库不受文件锁限制
  const memoryA = openStore(':memory:');
  const memoryB = openStore(':memory:');
  memoryA.close();
  memoryB.close();

  if (process.platform !== 'win32') {
    const mode = fs.statSync(dbPath).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('claimDelivery 原子且优先到期，status 结构固定', () => {
  const store = openStore(':memory:');
  store.ingest('stream', 1, [
    leadEvent('E1'),
    leadEvent('E2', { fact: 'second_fact' }),
  ]);
  store.recordDecision('E1', pushDecision({ fact_key: 'waitlist_open' }));
  store.recordDecision('E2', pushDecision({ fact_key: 'second_fact' }));

  const status = store.status();
  assert.deepEqual(Object.keys(status.events).sort(), [
    'dead', 'decided', 'deferred', 'dueDeferred', 'firstObservations',
    'observations', 'ready', 'total',
  ].sort());
  assert.equal(status.events.ready, 0);
  assert.equal(status.events.decided, 2);
  assert.equal(status.outbox.pending, 2);
  assert.equal(status.outbox.duePending, 2);

  const firstClaim = store.claimDelivery();
  assert.equal(firstClaim.id, 1);
  // 同一条已被拿走：再次 claim 拿到的是另一条，不是重复发同一条
  const secondClaim = store.claimDelivery();
  assert.equal(secondClaim.id, 2);
  assert.equal(store.claimDelivery(), null);

  // 第一条推后一小时重试，第二条先发
  store.finishDelivery(firstClaim.id, { state: 'retryable', delaySeconds: 3600, reason: 'CHANNEL_TIMEOUT' });
  store.finishDelivery(secondClaim.id, { state: 'sent', messageId: 'msg-0002' });
  assert.equal(store.claimDelivery(), null); // 第一条还没到期
  assert.equal(store.status().outbox.pending, 1);

  // 状态不对的收尾被拒
  assert.throws(
    () => store.finishDelivery(secondClaim.id, { state: 'sent' }),
    (error) => error instanceof StoreError && error.code === 'NOT_SENDING',
  );
  assert.throws(
    () => store.finishDelivery(999, { state: 'sent' }),
    (error) => error instanceof StoreError && error.code === 'UNKNOWN_DELIVERY',
  );
  assert.throws(
    () => store.finishDelivery(firstClaim.id, { state: 'maybe' }),
    (error) => error instanceof StoreError && error.code === 'INVALID_OUTCOME_STATE',
  );
  store.close();
});

test('closed 之后所有操作抛 STORE_CLOSED，坏路径被拒', () => {
  const store = openStore(':memory:');
  store.close();
  assert.throws(() => store.status(), (error) => error.code === 'STORE_CLOSED');
  assert.throws(() => store.getCursor('x'), (error) => error.code === 'STORE_CLOSED');
  assert.throws(() => openStore(''), (error) => error.code === 'INVALID_PATH');
  assert.throws(() => openStore('https://example.invalid/db'), (error) => error.code === 'UNSUPPORTED_PATH');
});
