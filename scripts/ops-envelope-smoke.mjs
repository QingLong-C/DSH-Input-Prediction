#!/usr/bin/env node
/**
 * `_ops` 信封（单调 seq）的冒烟测试。
 *
 * 它断言的是这条不变量：**同一份语义载荷写两次，落到盘上的字符串必须不同**，
 * 因而宿主「按载荷全等去重」只会拦住真正的回声，不会拦住语义上的新请求。
 * 宿主侧的清空失败不是偶发而是结构性拒绝（`HMR transactions cannot be nested`，
 * 实测 372/373 次），所以去重是唯一的拦截手段——它不能顺手误伤合法重发。
 *
 * 同时断言新增顶层键不会让载荷被宿主拒绝：opsPayloadSchema 非 strict，
 * `seq`/`locale` 都不在声明里，若哪天改成 strict，这里会先红。
 *
 * 用法：node scripts/ops-envelope-smoke.mjs
 */
import assert from 'node:assert/strict';
import { buildOpsPayload, createSeqSource } from '../src/client/ops-envelope.ts';
// 宿主侧解析器从 lib/ 取（与 ops-schema-coverage-smoke.mjs 同一惯例：src 下的 host
// 模块内部用 .js 相对 import，node 直跑源码解析不到；改过 src/ 记得先 node build.mjs）
import { parseHotnessOps } from '../lib/hotness-store.js';

let cases = 0;
const run = (name, fn) => {
  cases += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n      ${String(error).split('\n').slice(0, 3).join('\n      ')}`);
    process.exitCode = 1;
  }
};

/** 客户端 complete 的真实载荷形状（`rev` 固定为 0，逐字节由草稿决定）。 */
const COMPLETE = JSON.stringify({ rev: 0, ops: [{ op: 'complete', sessionId: 's1', draft: '感谢建议' }] });

// ── 1. 序号让重复写入不再是「回声」───────────────────────────────────────────────
run('同一份 complete 载荷写两次 → 序列化结果不同（宿主去重不会误伤）', () => {
  const seq = createSeqSource();
  const a = buildOpsPayload(COMPLETE, 'zh', seq.next());
  const b = buildOpsPayload(COMPLETE, 'zh', seq.next());
  assert.notEqual(a, b, '两次写入的载荷字符串必须不同，否则宿主会静默丢弃第二次');
  assert.equal(JSON.parse(a).seq, 1);
  assert.equal(JSON.parse(b).seq, 2);
});

// ── 2. seq 单调、locale 按需 ─────────────────────────────────────────────────────
run('seq 严格递增；locale 为空时不写入该键', () => {
  const seq = createSeqSource();
  const seen = [seq.next(), seq.next(), seq.next()];
  assert.deepEqual(seen, [1, 2, 3], `序号应连续递增，实得 ${JSON.stringify(seen)}`);
  assert.deepEqual(Object.keys(JSON.parse(buildOpsPayload(COMPLETE, undefined, 4))), ['rev', 'ops', 'seq']);
  assert.deepEqual(Object.keys(JSON.parse(buildOpsPayload(COMPLETE, '', 5))), ['rev', 'ops', 'seq']);
  assert.equal(JSON.parse(buildOpsPayload(COMPLETE, 'en', 6)).locale, 'en');
});

// ── 3. 原有语义必须一字不动 ──────────────────────────────────────────────────────
run('除新增键外，载荷内容逐字段保持', () => {
  const got = JSON.parse(buildOpsPayload(COMPLETE, 'zh', 7));
  assert.equal(got.rev, 0);
  assert.deepEqual(got.ops, JSON.parse(COMPLETE).ops, 'ops 数组不得被改写（draft/sessionId 是宿主判据的输入）');
});

// ── 4. 非对象载荷的行为与旧实现一致 ──────────────────────────────────────────────
run('非 JSON / 数组 / null 载荷原样返回', () => {
  for (const raw of ['not json', '[1,2]', 'null', '']) {
    assert.equal(buildOpsPayload(raw, 'zh', 8), raw, `${JSON.stringify(raw)} 应原样返回`);
  }
});

// ── 5. 宿主侧真的收得下带 seq 的载荷（schema 非 strict）──────────────────────────
run('带 seq/locale 的载荷仍被 parseHotnessOps 放行（改 strict 会先红）', () => {
  const wrapped = buildOpsPayload(COMPLETE, 'zh', 9);
  const parsed = parseHotnessOps(wrapped);
  assert.equal(parsed.ops.length, 1, `应解析出 1 个 op，实得 ${JSON.stringify(parsed)}`);
  assert.equal(parsed.ops[0].op, 'complete');
  assert.equal(parsed.ops[0].draft, '感谢建议');
  assert.equal(parsed.rejected, undefined, `新增键不应触发拒绝：${JSON.stringify(parsed.rejected)}`);
});

// ── 6. 端到端场景：A → B → 删回 A ───────────────────────────────────────────────
run('草稿 A 请求 → 改成 B → 删回 A：第三次写入必须能被宿主当作新请求消费', () => {
  const seq = createSeqSource();
  const payloadFor = (draft) => buildOpsPayload(
    JSON.stringify({ rev: 0, ops: [{ op: 'complete', sessionId: 's1', draft }] }),
    'zh',
    seq.next(),
  );
  const first = payloadFor('感谢建议');
  payloadFor('感谢建议。另外');           // B：中途的一次请求，会改变宿主侧 lastOpsPayload
  const again = payloadFor('感谢建议');   // 删回 A

  assert.notEqual(again, first, '与最初那次不同即可（宿主 lastOpsPayload 已被 B 更新）');
  assert.notEqual(again, payloadFor('感谢建议。另外'), '与上一次写入也不同');
  // 关键判据：假设宿主把 first 记为已消费，again 必须不等于它，否则被静默丢弃
  assert.equal(first === again, false, '同草稿重发不得与已消费载荷全等');
});

// ── 7. 序号回绕不影响正确性（页面刷新后 seq 从 1 重来）────────────────────────────
run('刷新后序号重来：靠「中间必有其它写入」而非序号本身避免全等', () => {
  const pageA = createSeqSource();
  const pageB = createSeqSource();
  const a = buildOpsPayload(COMPLETE, 'zh', pageA.next());
  const b = buildOpsPayload(COMPLETE, 'zh', pageB.next());
  // 这两个字符串相同——所以断言写清依赖：刷新后冷启动 pull 会先改变 lastOpsPayload，
  // complete 不可能与「上次消费的载荷」全等。此处固化「裸重放会被判等」这一事实本身。
  assert.equal(a, b, '页面级序号会重复，这是已知且被 pull 回声隔开的前提，不要误以为 seq 全局唯一');
  const pull = buildOpsPayload(JSON.stringify({ rev: 1, ops: [{ op: 'pull', sessionId: 's1' }] }), 'zh', pageB.next());
  assert.notEqual(pull, a, '中间的 pull 写入必然改变宿主记着的载荷');
  assert.notEqual(buildOpsPayload(COMPLETE, 'zh', pageB.next()), pull, 'pull 之后的 complete 也就不同于上次 complete');
});

console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} ops-envelope-smoke: ${cases} 组用例${process.exitCode === 1 ? '（有失败）' : '全部通过'}`);
