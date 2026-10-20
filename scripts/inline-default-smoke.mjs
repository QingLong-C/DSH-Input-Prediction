#!/usr/bin/env node
/**
 * `inlineDelayMs` 默认值一致性冒烟。
 *
 * ## 为什么需要它
 *
 * 这个默认值**散在 5 处**（宿主 schema、宿主两处 readVolatile、客户端默认、客户端解析兜底），
 * 各自独立写死。改默认值时只改一处，就会出现「设置页显示 A、实际生效 B」或
 * 「设置还没下发时客户端用旧值」这类不一致 —— 而且**没有任何测试会发现**：
 * 每一处单独看都合法。
 *
 * 本冒烟不测"默认值应该是几"（那是产品决定），只测**这几处彼此一致**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

run('宿主 schema 与两处 readVolatile 的默认值一致', () => {
  const host = read('src/index.ts');
  const gen = read('src/generate.ts');
  const schema = /inlineDelayMs:\s*z\.natural\(\)\.min\((\d+)\)\.default\((\d+)\)/.exec(host);
  assert.ok(schema !== null, 'src/index.ts 里找不到 inlineDelayMs 的 schema 定义（形态变了？）');
  const [, min, dflt] = schema;
  const reads = [...gen.matchAll(/readVolatile\((?:config|raw)\.inlineDelayMs,\s*(\d+)\)/g)].map((m) => m[1]);
  assert.equal(reads.length, 2, `src/generate.ts 里应有 2 处 readVolatile，实得 ${reads.length}`);
  for (const r of reads) assert.equal(r, dflt, `readVolatile 默认值 ${r} 与 schema 默认值 ${dflt} 不一致`);
  // 默认值必须 ≥ schema 的下界，否则 schema 会把默认值判为非法
  assert.ok(Number(dflt) >= Number(min), `默认值 ${dflt} 低于 schema 下界 ${min}`);
});

run('客户端两处兜底默认值与宿主一致', () => {
  const client = read('src/client/index.ts');
  const host = read('src/index.ts');
  const dflt = /\.default\((\d+)\)/.exec(/inlineDelayMs:\s*z\.natural\(\)[\s\S]{0,40}?\.default\((\d+)\)/.exec(host)?.[0] ?? '')?.[1];
  assert.ok(dflt !== undefined, '无法从宿主 schema 取到默认值');
  // 客户端字面量默认（settings 未下发时的初值）
  const literal = /inlineDelayMs:\s*(\d+),/.exec(client);
  assert.ok(literal !== null, 'src/client/index.ts 里找不到 inlineDelayMs 字面量默认值');
  assert.equal(literal[1], dflt, `客户端字面量 ${literal[1]} 与宿主默认值 ${dflt} 不一致`);
  // 客户端解析兜底（宿主值缺失/类型错时的回落）
  const fallback = /inlineDelayMs:\s*typeof v\.inlineDelayMs === 'number'\s*\?\s*v\.inlineDelayMs\s*:\s*(\d+)/.exec(client);
  assert.ok(fallback !== null, 'src/client/index.ts 里找不到 inlineDelayMs 的解析兜底');
  assert.equal(fallback[1], dflt, `客户端兜底 ${fallback[1]} 与宿主默认值 ${dflt} 不一致`);
});

run('文档里写的默认值与源码一致（中英各一处）', () => {
  const host = read('src/index.ts');
  const dflt = /\.default\((\d+)\)/.exec(/inlineDelayMs:\s*z\.natural\(\)[\s\S]{0,40}?\.default\((\d+)\)/.exec(host)?.[0] ?? '')?.[1];
  assert.ok(dflt !== undefined, '无法取到宿主默认值');
  for (const [file, re, label] of [
    ['README.md', /`inlineDelayMs`（默认 (\d+)ms）/, '中文'],
    ['README.en.md', /`inlineDelayMs` \(default (\d+)ms\)/, '英文'],
  ]) {
    const m = re.exec(read(file));
    assert.ok(m !== null, `${file} 里找不到默认值表述（${label}）`);
    assert.equal(m[1], dflt, `${file} 写的是 ${m[1]}ms，源码是 ${dflt}ms`);
  }
});

console.log('');
if (failed > 0) {
  console.error(`❌ inline-default-smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log('✅ inline-default-smoke: 3 组用例全部通过');
