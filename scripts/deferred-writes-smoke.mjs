#!/usr/bin/env node
/**
 * 事务外补写槽队列的冒烟测试（`src/deferred-writes.ts`）。
 *
 * 保的是四条会咬人的性质，全部离线可证（假时钟，不需要宿主）：
 *  1. 同类入队只留最新一份（与现有 `pendingPushPayload` 的尾合并同语义），且空队列
 *     必须是 `isEmpty()` 一条布尔快路径就能返回 —— pump 每 500ms 跑一次，常年空转，
 *     空转时若还去 `describe()` / 读盘就是白加的负载。
 *  2. 过期淘汰**真的会淘汰**：带续写的 push 载荷超过 8s 就不再补写（续写是「此刻这份
 *     草稿」的产物，把陈年续写推进去比没幽灵更糟），而不带续写的载荷不受这条约束。
 *  3. `_ops` 清空前的 CAS：盘上已出现新载荷时必须放弃清空，否则会把 client 刚写、
 *     还没消费的 op 吃掉（安全约束二，判据来自 `readOps()` 与入队时的 `consumedPayload`）。
 *  4. push 补写与指纹/盘上已落载荷/宿主已知最新草稿三者协调，绝不把被更新载荷取代的
 *     旧载荷写回去。
 *
 * 后半段是 `src/index.ts` 接线的**静态守卫**：pump 建在哪、卸载有没有清、CAS 依据
 * 有没有在同步段捕获。位置错了上面那些断言全绿，端到端却静默退回今天的失败。
 *
 * 用法：node --experimental-strip-types scripts/deferred-writes-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DeferredWriteQueue,
  DEFERRED_MAX_ATTEMPTS,
  DEFERRED_PUSH_MAX_AGE_MS,
  DEFERRED_PUMP_MS,
  decideClearOpsDrain,
  decidePushDrain,
  pushPayloadCompletionMeta,
} from '../src/deferred-writes.ts';

let cases = 0;
const run = (name, fn) => {
  cases += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n      ${String(error).split('\n').slice(0, 4).join('\n      ')}`);
    process.exitCode = 1;
  }
};

/** 造一份与宿主写盘结构同形的 `_push` 载荷（rev/completion/completionSessionId）。 */
const pushPayload = (rev, completion = null) => JSON.stringify({
  rev,
  suggestion: null,
  suggestionSessionId: null,
  hot: [['hello', 3]],
  total: 1,
  ...(completion === null ? { completion: null, completionSessionId: null } : {
    completion: { draft: completion.draft, text: completion.text },
    completionSessionId: completion.sessionId,
  }),
});

/** 入队一份 push（默认带续写，指纹与 rev 一一对应，便于断言协调规则）。 */
const enqueuePush = (queue, { rev, payload = pushPayload(rev, { draft: 'hello wor', text: 'ld, and goodbye', sessionId: 's1' }), carriesCompletion = true, fingerprint = `fp${rev}`, now = 1000 }) => {
  queue.enqueuePush({ payload, fingerprint, carriesCompletion }, now);
  return { payload, fingerprint, rev };
};

// ── 1. 空队列快路径：pump 的常年状态 ─────────────────────────────────────────────
run('空队列 isEmpty()=true，take()=null，size=0（pump 空转只做布尔判断）', () => {
  const q = new DeferredWriteQueue();
  assert.equal(q.isEmpty(), true);
  assert.equal(q.size, 0);
  assert.equal(q.take(), null);
  assert.deepEqual(q.evict(9_999_999), []);
});

run('入队一项后 isEmpty()=false；两槽都在时 size=2（上界就是 2，无积压）', () => {
  const q = new DeferredWriteQueue();
  enqueuePush(q, { rev: 1 });
  assert.equal(q.isEmpty(), false);
  q.enqueueClearOps('{"ops":[]}', 1000);
  assert.equal(q.size, 2, `两槽应有 2 项，实得 ${q.size}`);
});

// ── 2. 同类覆盖（尾合并语义）─────────────────────────────────────────────────────
run('同类 push 入队只留最新一份，且 enqueuedAt 随之刷新（计龄重新起算）', () => {
  const q = new DeferredWriteQueue();
  enqueuePush(q, { rev: 1, payload: pushPayload(1), now: 1000 });
  enqueuePush(q, { rev: 2, payload: pushPayload(2), now: 4000 });
  assert.equal(q.size, 1, `同类覆盖后应只剩 1 项，实得 ${q.size}`);
  const taken = q.take();
  assert.equal(taken.kind, 'push');
  assert.equal(taken.rev, 2, '槽里必须是最新那份载荷');
  assert.equal(taken.enqueuedAt, 4000, '新入队要刷新时刻，否则会被旧入队的时间误判超龄');
});

run('clearOps 同类覆盖只留最新那份已消费载荷（CAS 依据必须是「最后消费的那一份」）', () => {
  const q = new DeferredWriteQueue();
  q.enqueueClearOps('OLD', 1000);
  q.enqueueClearOps('NEW', 2000);
  assert.equal(q.size, 1);
  assert.equal(q.take().consumedPayload, 'NEW');
});

run('两槽互不覆盖：push 与 clearOps 各存一份，取完一个另一个还在', () => {
  const q = new DeferredWriteQueue();
  enqueuePush(q, { rev: 7 });
  q.enqueueClearOps('OPS', 1000);
  const first = q.take();
  assert.equal(first.kind, 'push');
  assert.equal(q.isEmpty(), false, 'clearOps 槽不应被 push 的取用带走');
  assert.equal(q.take().kind, 'clearOps');
  assert.equal(q.isEmpty(), true);
});

run('take() 等时长时 push 优先；clearOps 更早入队时它优先（用户在等的是幽灵）', () => {
  const tie = new DeferredWriteQueue();
  enqueuePush(tie, { rev: 1, now: 2000 });
  tie.enqueueClearOps('OPS', 2000);
  assert.equal(tie.take().kind, 'push', '同一时刻入队应优先补 push');
  const older = new DeferredWriteQueue();
  older.enqueueClearOps('OPS', 1000);
  enqueuePush(older, { rev: 1, now: 5000 });
  assert.equal(older.take().kind, 'clearOps', '等更久的槽先补，push 不能插队');
});

// ── 3. 过期淘汰 ─────────────────────────────────────────────────────────────────
run('带续写的 push 超过上限才淘汰：8000ms 整不淘汰，8001ms 淘汰并给出原因', () => {
  const boundary = new DeferredWriteQueue();
  enqueuePush(boundary, { rev: 1, now: 0 });
  assert.deepEqual(boundary.evict(DEFERRED_PUSH_MAX_AGE_MS), [], '刚好到上限不该淘汰（还该给一次机会）');
  const out = boundary.evict(DEFERRED_PUSH_MAX_AGE_MS + 1);
  assert.equal(out.length, 1, '超上限一项都没淘汰');
  assert.equal(out[0].reason, 'completion-too-old');
  assert.equal(out[0].ageMs, DEFERRED_PUSH_MAX_AGE_MS + 1);
  assert.equal(out[0].item.rev, 1);
  assert.equal(boundary.isEmpty(), true, '淘汰必须真的离槽，否则下一 tick 又把陈旧载荷写回去');
});

run('不带续写的 push **不按时间**淘汰（幂等状态快照，晚写仍正确）', () => {
  const q = new DeferredWriteQueue();
  enqueuePush(q, { rev: 1, payload: pushPayload(1), carriesCompletion: false, now: 0 });
  assert.deepEqual(q.evict(DEFERRED_PUSH_MAX_AGE_MS * 100), [], '纯热度/对账刷新不该被时间上限误杀');
  assert.equal(q.size, 1);
});

run('显式作废（completion: null）不算「带续写」，不因时间淘汰', () => {
  const q = new DeferredWriteQueue();
  enqueuePush(q, { rev: 3, payload: pushPayload(3), carriesCompletion: false, now: 0 });
  assert.equal(pushPayloadCompletionMeta(pushPayload(3)).completionDraft, null);
  assert.deepEqual(q.evict(DEFERRED_PUSH_MAX_AGE_MS * 10), []);
});

run('补写次数到达上限 → attempts-exhausted（HMR 事务内重建 pump 时不会无限烧日志）', () => {
  const q = new DeferredWriteQueue();
  const item = enqueuePush(q, { rev: 1, payload: pushPayload(1), carriesCompletion: false, now: 0 });
  for (let i = 0; i < DEFERRED_MAX_ATTEMPTS; i += 1) {
    const taken = q.take();
    assert.notEqual(taken, null, `第 ${i + 1} 次取不到槽项`);
    assert.equal(q.retry(taken), true, `第 ${i + 1} 次 retry 应该放得回（同种槽空着）`);
  }
  const out = q.evict(DEFERRED_PUMP_MS);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'attempts-exhausted');
  assert.equal(out[0].attempts, DEFERRED_MAX_ATTEMPTS);
  assert.equal(q.isEmpty(), true);
  void item;
});

run('retry 保留 enqueuedAt（计龄不因重试停表），只加 attempts', () => {
  const q = new DeferredWriteQueue();
  enqueuePush(q, { rev: 1, now: 500 });
  const taken = q.take();
  q.retry(taken);
  const again = q.take();
  assert.equal(again.enqueuedAt, 500, '重试不能刷新入队时刻');
  assert.equal(again.attempts, 1);
});

run('在途期间同种槽已被更新入队占住 → retry 返回 false（旧项不得盖掉新载荷）', () => {
  const q = new DeferredWriteQueue();
  enqueuePush(q, { rev: 1, payload: pushPayload(1), fingerprint: 'fp1', now: 0 });
  const inFlight = q.take(); // 取走补写中
  enqueuePush(q, { rev: 2, payload: pushPayload(2), fingerprint: 'fp2', now: 10 }); // 期间又来一份
  assert.equal(q.retry(inFlight), false, '被取代的旧项不能放回槽里盖掉新载荷');
  assert.equal(q.take().rev, 2, '槽里必须还是那份新载荷');
});

// ── 4. 安全约束二：clearOps 的盘上 CAS ───────────────────────────────────────────
run('盘上 _ops 仍等于本次已消费载荷 → 允许清空', () => {
  const item = { kind: 'clearOps', consumedPayload: '{"seq":9}', enqueuedAt: 0, attempts: 0 };
  assert.deepEqual(decideClearOpsDrain(item, '{"seq":9}'), { action: 'clear' });
});

run('盘上已有 client 新写的载荷 → 放弃清空，新载荷不被吃掉', () => {
  const item = { kind: 'clearOps', consumedPayload: '{"seq":9}', enqueuedAt: 0, attempts: 0 };
  const onDisk = '{"seq":10,"op":"complete"}';
  const decision = decideClearOpsDrain(item, onDisk);
  assert.equal(decision.action, 'skip', '盘上换了新载荷还清空 = 吃掉未消费的 op');
  assert.equal(decision.reason, 'newer-ops-on-disk');
  assert.notEqual(item.consumedPayload, onDisk, '判据本身：两份载荷必须不同');
});

run('同值重写也算新载荷（载荷带单调 seq，引用身份不可信）→ 仍放弃清空', () => {
  const item = { kind: 'clearOps', consumedPayload: '{"seq":9}', enqueuedAt: 0, attempts: 0 };
  assert.equal(decideClearOpsDrain(item, '{"seq":10}').action, 'skip');
});

run('放弃清空 = 丢弃槽不重试（新载荷会排自己的清空；不留一份注定不等值的 CAS）', () => {
  const q = new DeferredWriteQueue();
  q.enqueueClearOps('CONSUMED', 0);
  const item = q.take();
  assert.equal(decideClearOpsDrain(item, 'DIFFERENT').action, 'skip');
  assert.equal(q.isEmpty(), true, 'skip 之后队列应是空的（该项已作废）');
});

// ── 5. 安全约束二：push 与指纹/已落载荷/最新草稿协调 ─────────────────────────────
const pushItem = (over = {}) => ({
  kind: 'push',
  payload: pushPayload(1, { draft: 'hello wor', text: 'ld', sessionId: 's1' }),
  fingerprint: 'fp1',
  rev: 1,
  carriesCompletion: true,
  completionDraft: 'hello wor',
  completionSessionId: 's1',
  enqueuedAt: 0,
  attempts: 0,
  ...over,
});

run('指纹仍是自己（没被新载荷取代）→ 允许补写', () => {
  assert.deepEqual(decidePushDrain(pushItem(), {
    lastPushFingerprint: 'fp1',
    lastLandedPayload: null,
    latestCompletionDraft: 'hello wor',
  }), { action: 'write' });
});

run('指纹已变成更新的载荷 → skip superseded（绝不把旧载荷写回盘上）', () => {
  const decision = decidePushDrain(pushItem(), {
    lastPushFingerprint: 'fp2',
    lastLandedPayload: null,
    latestCompletionDraft: 'hello wor',
  });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'superseded');
});

run('同一份字节已经落过盘 → skip already-landed（别白推 revision）', () => {
  const landed = pushPayload(1, { draft: 'hello wor', text: 'ld', sessionId: 's1' });
  const decision = decidePushDrain(pushItem(), {
    lastPushFingerprint: 'fp1',
    lastLandedPayload: landed,
    latestCompletionDraft: 'hello wor',
  });
  assert.equal(decision.action, 'skip', '已落盘的同一份载荷不该再补一次');
  assert.equal(decision.reason, 'already-landed');
});

run('宿主已知该会话有更新草稿 → skip stale-draft（陈旧续写不往光标上推）', () => {
  const decision = decidePushDrain(pushItem(), {
    lastPushFingerprint: 'fp1',
    lastLandedPayload: null,
    latestCompletionDraft: 'hello world, and then some more',
  });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'stale-draft');
});

run('宿主拿不到最新草稿时**不猜**：退回 write（由时间上限兜底）', () => {
  assert.deepEqual(decidePushDrain(pushItem(), {
    lastPushFingerprint: 'fp1',
    lastLandedPayload: null,
    latestCompletionDraft: null,
  }), { action: 'write' }, '无草稿源不等于「草稿变了」，不能凭猜测丢载荷');
  assert.deepEqual(decidePushDrain(pushItem({ completionDraft: null }), {
    lastPushFingerprint: 'fp1',
    lastLandedPayload: null,
    latestCompletionDraft: 'anything',
  }), { action: 'write' }, '载荷读不出草稿时同样不得凭空判陈旧');
});

run('三条跳过规则的优先级：已落盘 > 被取代 > 陈旧草稿 > 写', () => {
  const landed = pushPayload(1, { draft: 'hello wor', text: 'ld', sessionId: 's1' });
  assert.equal(decidePushDrain(pushItem(), { lastPushFingerprint: 'fp9', lastLandedPayload: landed, latestCompletionDraft: 'other' }).reason, 'already-landed');
  assert.equal(decidePushDrain(pushItem(), { lastPushFingerprint: 'fp9', lastLandedPayload: null, latestCompletionDraft: 'other' }).reason, 'superseded');
  assert.equal(decidePushDrain(pushItem(), { lastPushFingerprint: 'fp1', lastLandedPayload: null, latestCompletionDraft: 'other' }).reason, 'stale-draft');
});

// ── 6. 载荷自述信息只用已有字段（不编造能力）─────────────────────────────────────
run('pushPayloadCompletionMeta：从载荷读 rev/draft/session', () => {
  const meta = pushPayloadCompletionMeta(pushPayload(42, { draft: 'abc', text: 'def', sessionId: 's9' }));
  assert.deepEqual(meta, { rev: 42, completionDraft: 'abc', completionSessionId: 's9' });
});

run('pushPayloadCompletionMeta：非 JSON / 无 completion 一律 null，不抛', () => {
  assert.deepEqual(pushPayloadCompletionMeta('not json'), { rev: null, completionDraft: null, completionSessionId: null });
  assert.deepEqual(pushPayloadCompletionMeta('null'), { rev: null, completionDraft: null, completionSessionId: null });
  assert.equal(pushPayloadCompletionMeta(pushPayload(5)).completionDraft, null);
});

// ── 7. 常量之间的不变量（改动要过这三条）────────────────────────────────────────
run('取值不变量：补写最坏延迟够小、淘汰前够多次机会、重试窗口不超时间上限', () => {
  assert.ok(DEFERRED_PUMP_MS <= 500, `pump 间隔 ${DEFERRED_PUMP_MS}ms 会让续写等太久（用户在等的东西）`);
  const chances = Math.floor(DEFERRED_PUSH_MAX_AGE_MS / DEFERRED_PUMP_MS);
  assert.ok(chances >= 8, `超龄前只有 ${chances} 次补写机会，淘汰会被当成「根本没试过」`);
  assert.ok(DEFERRED_MAX_ATTEMPTS * DEFERRED_PUMP_MS <= DEFERRED_PUSH_MAX_AGE_MS, '重试窗口不该超过时间上限，否则先撞哪个说不清');
  assert.ok(DEFERRED_PUSH_MAX_AGE_MS <= 10_000, `带续写的载荷活 ${DEFERRED_PUSH_MAX_AGE_MS}ms 太久：那时用户早已改草稿`);
});

// ── 8. host 接线的静态守卫 ──────────────────────────────────────────────────────
// 本模块只管排、取、判定；「补上去那次写到底写得进盘吗」取决于 `src/index.ts` 那侧的
// **接线位置**：pump 建在 apply() 的同步续体里 = 事务外（写得进），建在 handler / await
// 续体里 = 捕获到 store=true（永远写不进，而这在本模块的断言里完全看不出来）。位置错了
// 不会让上面任何一条变红，所以必须静态钉住 —— 与 `scripts/live-settings-smoke.mjs`
// 第 12 段同一手法：只查代码，注释里出现旧写法是文档，不算回归。
// 这几条是**结构**守卫，不是「幽灵出现了」的证明（那要真实浏览器）。
const hostSource = (() => {
  const raw = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
})();

run('pump 建在 apply() 的同步续体里（settingsSvc 就位之后，中间无 await/then/on/setTimeout）', () => {
  const injectAt = hostSource.indexOf("ctx.inject(['settings']");
  const svcAt = hostSource.indexOf('settingsSvc = svc;');
  const pumpAt = hostSource.indexOf('setInterval(drainDeferred');
  assert.ok(injectAt >= 0, '找不到 settings 注入回调');
  assert.ok(svcAt > injectAt, `settingsSvc 必须在注入回调里就位（svcAt=${svcAt} injectAt=${injectAt}）`);
  assert.ok(pumpAt > svcAt, `排水定时器必须在 settingsSvc 就位之后建立（pumpAt=${pumpAt} svcAt=${svcAt}）`);
  const between = hostSource.slice(svcAt, pumpAt);
  for (const forbidden of ['await ', '.then(', '.on(', 'setTimeout']) {
    assert.ok(!between.includes(forbidden), `建 pump 之前出现了「${forbidden.trim()}」：定时器会捕获事务上下文，补写退回今天的失败`);
  }
});

run('drainDeferred 第一句就是 isEmpty 快路径（空队列不得 describe / 读盘）', () => {
  assert.match(
    hostSource,
    /function drainDeferred\(\): void \{\s*\n\s*if \(deferred\.isEmpty\(\)\) return;/,
    '队列空时必须立刻 return：pump 每 500ms 跑一次且常年空转，空转成本必须是布尔判断',
  );
});

run('卸载时 clearInterval（跨 apply 不留无人认领的写入源）', () => {
  const effectAt = hostSource.indexOf('ctx.effect(');
  const clearAt = hostSource.indexOf('clearInterval(deferredPump)');
  assert.ok(clearAt > effectAt, `clearInterval 必须在 ctx.effect 的清理里（clearAt=${clearAt} effectAt=${effectAt}）`);
});

run('两个 nested 分支都排队：push → enqueuePush，_ops 清空 → enqueueClearOps', () => {
  assert.match(hostSource, /deferred\.enqueuePush\(\{ payload, fingerprint, carriesCompletion \}/, 'flushPush 的 nested 分支必须把载荷排进 push 槽');
  assert.match(hostSource, /deferred\.enqueueClearOps\(consumedPayload/, 'consumeOps 的 nested 分支必须把清空排进 clearOps 槽');
  // 排队之后不能再无条件放开指纹（那等于把主路径悄悄降级回旧兜底）。
  const from = hostSource.indexOf('/cannot be nested/i');
  const nestedPush = hostSource.slice(from, hostSource.indexOf("traceFault('push-failed'"));
  assert.ok(from >= 0 && nestedPush.length > 0, '找不到 push 的 nested 分支');
  assert.ok(!/lastPushFingerprint = null;/.test(nestedPush), 'nested 分支里不该再直接清指纹：载荷已在槽里，只有补写最终没成才放开（releaseDeferredPushFingerprint）');
});

run('CAS 依据在 consumeOps 同步段捕获（不能等回调里读会变的 lastOpsPayload）', () => {
  // 只在 consumeOps 函数体内定位：`drainDeferred` 里也有同一句清空写，扫全文会拿错位置。
  const fnAt = hostSource.indexOf('const consumeOps = (');
  assert.ok(fnAt > 0, '找不到 consumeOps');
  const captureAt = hostSource.indexOf('const consumedPayload = lastOpsPayload;', fnAt);
  const clearAt = hostSource.indexOf('update(SUGGEST_GHOST_NAMESPACE, { _ops: EMPTY_PUSH })', fnAt);
  assert.ok(captureAt > fnAt, 'consumeOps 必须同步捕获本次已消费的载荷原文');
  assert.ok(captureAt < clearAt, '捕获必须在发起清空之前：否则读到的已是下一次 document-updated 推进后的值，CAS 退化成无条件清空');
});

run('补写成功的留痕与正常路径不同名（验收要能区分这两条）', () => {
  assert.ok(hostSource.includes('deferred push landed rev='), '缺 `deferred push landed rev=…` 这条验收留痕');
  assert.ok(hostSource.includes('deferred _ops cleared after consume'), '缺 `_ops` 补清空的留痕');
  assert.ok(hostSource.includes('push landed rev='), '正常路径留痕不能被删：两条同时出现才证明「即时被拒 → 事务外补写成功」这条链走通了');
});

console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} deferred-writes-smoke: ${cases} 组用例${process.exitCode === 1 ? '（有失败）' : '全部通过'}`);
