// dsh-suggest-ghost 停顿续写纯函数冒烟测试（从构建产物 lib/ 导入，避免 --experimental-strip-types 的 .js→.ts 解析问题）。
import assert from 'node:assert/strict';
import {
  cleanSuggestion,
  sanitizeSuggestion,
  shouldFilterCompletion,
} from '../src/sanitize.ts';
import { sanitizeCompletion, inlinePrompt } from '../lib/inline.js';

// —— 续写输出净化链（cleanSuggestion → stripDraftEcho → trim → filter → sanitizeSuggestion）——

// 1. 正常续写直接通过
assert.equal(sanitizeCompletion(' and run the tests', 'npm run build', 200), 'and run the tests');

// 2. 模型复述草稿再续写 → 回声被剥掉
assert.equal(
  sanitizeCompletion('npm run build && npm test', 'npm run build', 200),
  '&& npm test',
);

// 3. 回声剥完后剩空 → undefined（无续写）
assert.equal(sanitizeCompletion('npm run build', 'npm run build', 200), undefined);

// 4. 围栏包裹的续写 → 剥围栏
assert.equal(
  sanitizeCompletion('```\n--watch\n```', 'npm test', 200),
  '--watch',
);

// 5. 纯标点/单字符 → undefined（轻过滤器：不问 THANKS/QUESTION）
assert.equal(sanitizeCompletion('。', '写了一半', 200), undefined);
assert.equal(sanitizeCompletion('a', '写了一半', 200), undefined);
assert.equal(sanitizeCompletion('', '写了一半', 200), undefined);

// 6. 轻过滤器差异：续写语境下的问句/感谢/助手口吻是**合理续写**，不过滤
assert.equal(shouldFilterCompletion('What about the tests?'), false);
assert.equal(shouldFilterCompletion('thanks for asking!'), false);
assert.equal(shouldFilterCompletion('Let me look into that for you'), false);
// 与 shouldFilterSuggestion 的重合部分仍过滤
assert.equal(shouldFilterCompletion('no suggestion for now'), true);
assert.equal(shouldFilterCompletion('An error occurred during the build.'), true);

// 7. 词边界截断：不超上限、不以空白结尾
{
  const out = sanitizeCompletion('run the deployment pipeline now', 'deploy', 18);
  assert.ok(out !== undefined);
  assert.ok(out.length <= 18);
  assert.ok(!out.endsWith(' '));
}

// 8. 中文续写：保留原文（CJK 词边界按字符）
{
  const out = sanitizeCompletion('并且重新部署服务', '修好后再跑一遍测试', 200);
  assert.equal(out, '并且重新部署服务');
}

// —— 底层函数行为一致性 ——
// stripDraftEcho 内部语义经 sanitizeCompletion 间接覆盖（NFKC/空白折叠）。
assert.equal(cleanSuggestion('\x1b[31m红\x1b[0m色'), '红色');
assert.equal(sanitizeSuggestion('short', 100).truncated, false);

// —— 续写指令要点（约束模型只输出续写、禁复述、限长、限单行）——
{
  const p = inlinePrompt(160, '简体中文');
  assert.ok(p.includes('160'));
  assert.ok(p.includes('简体中文'));
  assert.ok(p.includes('MUST NOT echo'));
  assert.ok(p.includes('slash command'));
  assert.ok(p.includes('single line'));
  assert.ok(p.includes('At most 160'));
}
{
  const p = inlinePrompt(80, 'English');
  assert.ok(p.includes('80'));
  assert.ok(p.includes('English'));
}

console.log('inline-smoke: all assertions passed');
