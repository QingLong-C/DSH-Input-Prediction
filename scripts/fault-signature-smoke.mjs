#!/usr/bin/env node
/**
 * 故障签名归一化的冒烟测试。
 *
 * 它保的是节流的正确性前提：**同类塌成一个桶、新类绝不并进旧桶**。第二件事才是重点
 * ——按 kind 粗节流时，路由缺失报过第一条之后，同窗口内混进来的锁超时/模型 4xx 会被
 * 同一个计数器一起吞掉，等于重新犯 issue #17 的错。
 *
 * 用法：node scripts/fault-signature-smoke.mjs
 */
import assert from 'node:assert/strict';
import { faultSignature } from '../src/fault-signature.ts';

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

const ROUTE = (sid, ms) => `completion failed for session ${sid} after ${ms}ms: Error: no logged request route is available`;
const SID_A = 'session-95ff1532-3eab-4543-8cd8-d8aaeccdc44c';
const SID_B = 'session-0064ca6c-2d85-4f21-88af-cb82e3eabf65';

// ── 1. 同类必须同桶（否则节流形同不存在）────────────────────────────────────────
run('不同会话、不同耗时、同类原因 → 同一签名', () => {
  assert.equal(faultSignature(ROUTE(SID_A, 27)), faultSignature(ROUTE(SID_B, 4321)));
});

// ── 2. 新类绝不能并进旧桶（这条是节流改动的全部意义）────────────────────────────
run('不同故障原因 → 不同签名（新类会独立报出第一条）', () => {
  const route = faultSignature(ROUTE(SID_A, 27));
  const lock = faultSignature(`_ops clear failed: atomic-write: timed out waiting for the writer lock at /home/u/.dsh/profiles/web/package.json.lock`);
  const nested = faultSignature('push refused inside settings transaction (rev=2 dropped): HMR transactions cannot be nested');
  const http4xx = faultSignature('completion failed for session ' + SID_A + ' after 900ms: Error: 429 Too Many Requests');
  const keys = new Set([route, lock, nested, http4xx]);
  assert.equal(keys.size, 4, `四类故障应落在 4 个桶，实得 ${keys.size}`);
});

// ── 3. 数字归一（状态码/字节数不能把同类拆开）──────────────────────────────────
run('报文里的数字折成 N，同类不同数值仍同桶', () => {
  assert.equal(
    faultSignature('push landed rev=7 bytes=3098 withCompletion=1'),
    faultSignature('push landed rev=268 bytes=3179 withCompletion=1'),
  );
  assert.notEqual(
    faultSignature('Error: 429 Too Many Requests'),
    faultSignature('Error: 500 Internal Server Error'),
    '不同状态码是不同性质的故障，不该被折成同桶',
  );
});

// ── 4. 会话 id 归一但**不能**把整条报文抹平 ────────────────────────────────────
run('会话 id 折叠后仍保留原因文本（防止签名退化成常量）', () => {
  const sig = faultSignature(ROUTE(SID_A, 27));
  assert.ok(sig.includes('no logged request route'), `签名丢了原因：${sig}`);
  assert.ok(!sig.includes(SID_A.slice(0, 12)), '签名里不该还留着会话 id');
});

// ── 5. 长度有界（计数键会长期驻留在 Map 里）───────────────────────────────────
run('签名长度有界（≤160）', () => {
  const long = 'x'.repeat(5000) + ROUTE(SID_A, 1);
  assert.ok(faultSignature(long).length <= 160, `签名过长：${faultSignature(long).length}`);
});

// ── 6. 幂等：对已归一的值再算一次不应继续变形 ─────────────────────────────────
run('归一是幂等的（同一报文重复取签名稳定）', () => {
  const once = faultSignature(ROUTE(SID_A, 27));
  assert.equal(faultSignature(once), once);
});

console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} fault-signature-smoke: ${cases} 组用例${process.exitCode === 1 ? '（有失败）' : '全部通过'}`);
