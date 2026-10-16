// 真实会话回放：从 DSH 会话日志（jsonl 或 jsonl.zstd）重放历史补全管线。
// 用法：npm run replay -- <session.jsonl[.zstd]> [草稿1] [草稿2] ...
// 展示：热表过滤前后对比（系统注入垃圾 vs 仅真实用户输入）+ 指定草稿的匹配结果。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { HotnessTable } from '../src/hotness.ts';
import { extractHistory, historySuggestion } from '../src/client/history.ts';

const file = process.argv[2];
if (file === undefined) {
  console.error('用法：node scripts/replay-history.mjs <session.jsonl[.zstd]> [草稿...]');
  process.exit(1);
}
const drafts = process.argv.slice(3);
const raw = file.endsWith('.zstd')
  ? execFileSync('unzstd', ['-c', file], { maxBuffer: 1 << 28 })
  : readFileSync(file);
const events = raw.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const textOf = blocks => Array.isArray(blocks)
  ? blocks.filter(b => b?.type === 'text').map(b => b.text).join('')
  : '';

// —— 旧逻辑模拟：所有 user/message 全部计数（含系统注入）——
const oldCounts = new Map();
let pluginInjected = 0;
for (const e of events) {
  if (e.type !== 'user/message') continue;
  const text = textOf(e.data?.content).trim();
  if (text === '') continue;
  if (e.data?.source?.kind !== 'user') pluginInjected += 1;
  oldCounts.set(text, (oldCounts.get(text) ?? 0) + 1);
}
const clip = s => s.length > 56 ? `${s.slice(0, 56).replaceAll('\n', '⏎')}…` : s.replaceAll('\n', '⏎');
const topOld = [...oldCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

// —— 新逻辑：直接用源码 HotnessTable（source.kind==='user' 白名单 + 长度上限）——
const hot = new HotnessTable();
for (const e of events) hot.consume(e);

console.log(`事件 ${events.length} 条；user/message 全量 ${oldCounts.size} 种文本，其中非真实用户注入 ${pluginInjected} 条`);
console.log('\n—— 旧热表 top-3（会被系统注入污染）：');
for (const [t, c] of topOld) console.log(`  ×${c}  ${clip(t)}`);
console.log('\n—— 新热表 top-5（仅真实用户输入）：');
const clean = hot.snapshot(5);
if (clean.length === 0) console.log('  （空——该会话暂无符合条件的真实用户消息）');
for (const { text, count } of clean) console.log(`  ×${count}  ${clip(text)}`);

// —— 历史匹配回放：用真实用户消息构造候选，跑打分匹配 ——
const history = extractHistory(
  [...oldCounts.keys()].map(text => ({ kind: 'user', content: [{ type: 'text', text }] })),
);
console.log(`\nextractHistory：${oldCounts.size} 条 user 消息 → ${history.length} 条有效候选`);
const probes = drafts.length > 0 ? drafts : history.slice(-3).map(h => h.slice(0, Math.min(4, h.length)));
for (const draft of probes) {
  const hit = historySuggestion(history, draft, { minChars: 1, maxEntries: 50 });
  console.log(`  草稿「${draft}」→ ${hit === undefined ? '(无建议)' : `「${clip(hit)}」`}`);
}
