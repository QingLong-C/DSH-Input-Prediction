#!/usr/bin/env node
/**
 * 续写载荷与当前草稿的对齐判定冒烟（纯函数 `alignCompletion`）。
 *
 * 覆盖三组：
 *  1. **主路径**（这是本次修复的动机）：用户在生成期间继续打字 —— 线上实测 46 次停顿里
 *     45 次草稿长度都不同，全等判据把这些全判成失效。
 *  2. **必须丢弃的形态**：改中间 / 换内容 / 删字（删字后光标位置未知，贴上可能错位）。
 *  3. **重叠裁剪**：你已经照着续写打下去了，幽灵只该补剩下的部分。
 */
import assert from 'node:assert/strict';
import { alignCompletion } from '../src/client/completion-align.ts';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

// ── 1. 主路径：草稿未变 / 末尾继续打字 ──────────────────────────────────────
run('草稿未变：整段续写都是幽灵（原行为不变）', () => {
  const r = alignCompletion('帮我看一下', '帮我看一下', '这个插件的构建流程');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'exact');
  assert.equal(r.suffix, '这个插件的构建流程');
  assert.equal(r.full, '帮我看一下这个插件的构建流程');
});

run('末尾多打一个不相干的字：续写整段保留，接在当前草稿后', () => {
  // 实测形态：draft=18 / payload=17（用户多打 1 字，且与续写开头不重合）
  const r = alignCompletion('帮我看一下这个插件X', '帮我看一下这个插件', '的构建流程');
  assert.equal(r.ok, true, '这正是"边打边等"的主路径，不该被丢弃');
  assert.equal(r.kind, 'extended');
  assert.equal(r.suffix, '的构建流程', 'X 与续写不重合，一个字符都不该裁');
  assert.equal(r.full, '帮我看一下这个插件X' + '的构建流程', 'full 必须是当前草稿 + 裁剪后的后缀');
});

run('末尾多打 5 个字（实测 draft=20 / payload=15）', () => {
  const r = alignCompletion('abcdefghijklmnopqrst', 'abcdefghijklmno', 'XYZ 后半句');
  assert.equal(r.ok, true);
  assert.equal(r.suffix, 'XYZ 后半句');
});

// ── 2. 重叠裁剪：你已经照着续写打下去 ───────────────────────────────────────
run('已打出续写开头 1 字：幽灵只补剩下的', () => {
  // typedSince='构' 与续写 '构建流程是什么' 的公共前缀 = 1 → 裁掉「构」，幽灵补「建流程是什么」。
  const r = alignCompletion('帮我看看这个插件的构构', '帮我看看这个插件的构', '构建流程是什么');
  assert.equal(r.ok, true);
  assert.equal(r.suffix, '建流程是什么', '已打出的「构」必须被裁掉，否则重复显示');
  assert.equal(r.full, '帮我看看这个插件的构构' + '建流程是什么', 'full 必须与 suffix 一致');
});

run('已打出续写开头 3 字：裁掉 3 个', () => {
  const r = alignCompletion('前面构建流', '前面', '构建流程是什么');
  assert.equal(r.suffix, '程是什么', '「构建流」已打出，应从「程」开始补');
});

run('已把整段续写打完：无幽灵可显示（不是错误）', () => {
  const r = alignCompletion('前面构建流程', '前面', '构建流程');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty-text');
});

run('你打的字与续写开头不重合：整段续写保留（不误裁）', () => {
  const r = alignCompletion('前面ABC', '前面', '构建流程');
  assert.equal(r.ok, true);
  assert.equal(r.suffix, '构建流程', '不重合时不能裁任何字符');
});

// ── 3. 必须丢弃的形态 ───────────────────────────────────────────────────────
run('改了中间：丢弃（贴合上去会错位）', () => {
  const r = alignCompletion('帮我XX一下', '帮我看看一下', '这个插件');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'draft-mismatch');
});

run('删了末尾：丢弃（删字后光标位置未知，宁可少显示不可显错）', () => {
  // 实测形态：draft=27 / payload=28
  const r = alignCompletion('帮我看看这个插件的构', '帮我看看这个插件的构建', '流程是什么');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'draft-mismatch');
});

run('换了内容（当前远短于载荷）：丢弃（实测 draft=3 / payload=48）', () => {
  const r = alignCompletion('看看', 'x'.repeat(48), '后半句');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'draft-mismatch');
});

run('空续写 / 空草稿：丢弃并给出可区分的原因', () => {
  assert.equal(alignCompletion('草稿', '草稿', '').reason, 'empty-text');
  assert.equal(alignCompletion('', '', '后半句').reason, 'empty-draft');
  assert.equal(alignCompletion('   ', '   ', '后半句').reason, 'empty-draft');
});

run('载荷草稿为空且当前草稿非空：整段续写作为幽灵（前缀恒成立）', () => {
  const r = alignCompletion('新打的字', '', '后半句');
  assert.equal(r.ok, true);
  assert.equal(r.suffix, '后半句');
});

console.log('');
if (failed > 0) {
  console.error(`❌ completion-align-smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log('✅ completion-align-smoke: 11 组用例全部通过');
