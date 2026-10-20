#!/usr/bin/env node
/**
 * 「续写变成回答」形态兜底判据的冒烟（Gitea 侧用户报：续写有时候变成回答了）。
 *
 * 只测纯函数 `shouldFilterCompletionFor(text, draft)`。断言分三组：
 *  1. **正例**（必须放行）：真实续写形态，特别是中文里带"你/吗/？"的短续写 ——
 *     这正是"用语义正则去拦"会误杀的那批，本判据用形态特征就是为了放过它们。
 *  2. **反例**（必须拦下）：线上实测到的极端形态（5 字草稿 → 94 字输出等）。
 *  3. **边界**：既有语义过滤仍然生效；空草稿的成段输出按可疑处理。
 *
 * 阈值取值的实测依据写在 `src/sanitize.ts` 的 `shouldFilterCompletionFor` 注释里。
 */
import assert from 'node:assert/strict';
import {
  shouldFilterCompletionFor,
  shouldFilterCompletion,
} from '../src/sanitize.ts';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

// ── 1. 正例：真实续写形态必须放行 ────────────────────────────────────────────
run('短续写照常放行（英文）', () => {
  assert.equal(shouldFilterCompletionFor(' and run the tests', 'npm run build'), false);
});

run('中文短续写带"你/吗/？"不被误杀（这是拒绝语义正则的理由）', () => {
  // 若改用 ASSISTANT_VOICE_RE / QUESTION_RE 去拦，下面这些会被全部误杀。
  for (const t of ['你的意思是', '这样可以吗？', '我来测试一下', '让我想想']) {
    assert.equal(shouldFilterCompletionFor(t, '我打算把这段改一下'), false, `被误杀：${t}`);
  }
});

run('明确以助手口吻开头的短续写仍放行（既有 inline-smoke 的决定必须保留）', () => {
  // 这三条同时是 scripts/inline-smoke.mjs 的既有断言，语义不能被本判据推翻。
  assert.equal(shouldFilterCompletion('What about the tests?'), false);
  assert.equal(shouldFilterCompletion('thanks for asking!'), false);
  assert.equal(shouldFilterCompletion('Let me look into that for you'), false);
  for (const t of ['What about the tests?', 'thanks for asking!', 'Let me look into that for you']) {
    assert.equal(shouldFilterCompletionFor(t, '帮我看看'), false, `被误杀：${t}`);
  }
});

run('长草稿 + 合理长度的续写不被误杀（实测 174→125 那种）', () => {
  const draft = 'x'.repeat(174);
  assert.equal(shouldFilterCompletionFor('y'.repeat(125), draft), false);
});

run('slash 命令的续写放行', () => {
  assert.equal(shouldFilterCompletionFor(' +3m 我重新部署了', '/later'), false);
});

// ── 2. 反例：线上实测的极端形态必须拦下 ──────────────────────────────────────
run('5 字草稿 → 94 字输出被拦（实测 18.8x，最极端一次）', () => {
  assert.equal(shouldFilterCompletionFor('答'.repeat(94), '看看这个'), true);
});

run('实测高比值形态被拦（18.8x / 7.7x / 6.0x / 5.8x）', () => {
  const cases = [
    ['看看这个', '答'.repeat(94)],          // 18.8x —— 最极端一次
    ['草'.repeat(6), '输'.repeat(46)],      // 7.7x
    ['草'.repeat(9), '输'.repeat(54)],      // 6.0x
    ['草'.repeat(8), '输'.repeat(46)],      // 5.8x（恰好过 5x 线，钉住边界）
  ];
  for (const [draft, out] of cases) {
    assert.equal(shouldFilterCompletionFor(out, draft), true, `未拦下：${draft.length}→${out.length}`);
  }
});

run('已知放过：4.2x 的边界形态（宁可漏拦也不误杀，理由见下）', () => {
  // 16 字草稿 → 67 字输出 = 4.2x。它**可能**是回答，也**可能**是"接着半句话写完一个长句"，
  // 而正文受隐私约束不落盘，无法从长度区分。这里明确选择**放过**：
  //   漏拦的代价 = 偶尔看到一次回答（用户一眼可见、可再报）；
  //   误杀的代价 = 功能静默失效，与"没生成"同形（正是本仓库反复踩过的那类难查问题）。
  // 真正治本的是 prompt 侧（见 src/inline.ts 的 inlinePrompt）；本判据只是兜底。
  assert.equal(shouldFilterCompletionFor('输'.repeat(67), '草'.repeat(16)), false);
});

// ── 3. 边界 ──────────────────────────────────────────────────────────────────
run('两个条件必须同时满足：够长但比值不高 → 放行', () => {
  // 50 字输出 / 20 字草稿 = 2.5x，虽然 ≥40 字但没超 8x
  assert.equal(shouldFilterCompletionFor('输'.repeat(50), '草'.repeat(20)), false);
});

run('两个条件必须同时满足：比值高但绝对量不足 → 放行', () => {
  // 30 字输出 / 2 字草稿 = 15x，超 8x 但不到 40 字
  assert.equal(shouldFilterCompletionFor('输'.repeat(30), '草草'), false);
});

run('既有语义过滤仍然生效（META / ERROR_ECHO / 超 200 字）', () => {
  assert.equal(shouldFilterCompletionFor('no suggestion for now', '草稿开'), true);
  assert.equal(shouldFilterCompletionFor('An error occurred during the build.', '草稿开'), true);
  assert.equal(shouldFilterCompletionFor('长'.repeat(201), '草'.repeat(5)), true);
});

run('空草稿 + 成段输出按可疑拦下（续写本不该出现在空草稿上）', () => {
  assert.equal(shouldFilterCompletionFor('输'.repeat(60), ''), true);
  assert.equal(shouldFilterCompletionFor('输'.repeat(60), '   '), true);
});

run('短输出在空草稿上不受影响（不制造新的静默）', () => {
  assert.equal(shouldFilterCompletionFor('继续', ''), false);
});

console.log('');
if (failed > 0) {
  console.error(`❌ completion-answer-filter-smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log('✅ completion-answer-filter-smoke: 12 组用例全部通过');
