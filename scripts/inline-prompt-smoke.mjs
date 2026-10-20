#!/usr/bin/env node
/**
 * `inlinePrompt()` 的**指令契约**冒烟测试。
 *
 * ## 它保什么
 *
 * 线上回归「续写有时候怎么变成回答了」：`generateCompletion` 把「最近几轮对话 +
 * 当前草稿」一起喂给模型，而 user 消息里的草稿被读成「轮到我回应了」，
 * 模型于是去**回答草稿里的问题**；下游 `shouldFilterCompletion` 又刻意放行
 * 问句/助手口吻（续写场景不过滤），回答因此畅通到 UI。
 * 线上 42 次生成里 12 次「输出 > 草稿 3 倍」，最极端 draft=5 → out=94（18.8x）。
 *
 * 修法在 `src/inline.ts` 的 system prompt。本文件把「那条修法不许被无声删掉」
 * 变成**离线可断言、且可被反向证伪**的东西：
 *
 *  1. 生命周期三件事必须显式命名（草稿是用户未发出的文字 / 上下文只用于对齐
 *     术语与语气 / 上下文不是要回应的对话）——它们现在是独立句子，所以能断言；
 *  2. 三条「反回答化」禁令（C6 不许回答・回应・满足草稿里的问题与请求，
 *     C7 不许加草稿没开始的解释/建议，C8 空输出优于回答）必须各自带关键短语；
 *  3. 既有五条约束（C1 语言 / C2 单行 / C3 不复述草稿 / C4 slash 命令 /
 *     C5 字符上限）**一条都不许消失**——用条款编号集合比较，删一条即红；
 *  4. `maxChars` / `language` 参数必须真的被插进指令（参数接线，不是常量）；
 *  5. **反向验证**：把每条禁令依次从 prompt 里删掉，断言**必须**变红，
 *     再放回去必须变绿；一条删不红就退出非 0。即断言本身被证明可证伪。
 *
 * ## 为什么这样读源码
 *
 * `src/inline.ts` 顶部有 `import { ... } from './sanitize.js'`。在
 * `--experimental-strip-types` 下 Node 不会把 `./sanitize.js` 解析回
 * `./sanitize.ts`（与 `scripts/inline-smoke.mjs` 注释里记的是同一个坑，
 * 它因此从 `lib/inline.js` 导入）。于是本文件不 import 模块，只**读源码**、
 * 剥掉注释后取出 `inlinePrompt` 的函数体，再 `new Function(...)` 求值。
 * 这样即使 `lib/` 是旧的，断言的对象也始终是当前工作区的源码。
 *
 * ## 已知边界（不假装覆盖）
 *
 * 纯文本断言**证不了**「模型真的不再回答」。它只证「那条修法还在 prompt 里」。
 * 真实效果只有对 provider 发请求才能验（见文件末尾的说明）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE_PATH = fileURLToPath(new URL('../src/inline.ts', import.meta.url));
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

// —— 源码求值：剥注释 → 取函数体 → new Function ——
//
// 剥注释是为了让断言查的是「指令内容」而不是「注释里提到过这些词」：本文件的
// 测试意图（草稿是未发出的文字、不许回答…）在源码注释里全都出现过，
// 不剥注释的话，把整段 prompt 全删光、只留注释，断言照样绿——那就不是证伪。

/** 去掉块注释与行注释（对 TS 源码足够；正文里没有 `//` 字面量）。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 截出 `export function inlinePrompt(...) { ... }` 的函数体（按大括号配平）。 */
function extractFunctionBody(code, name) {
  const signature = new RegExp(`export\\s+function\\s+${name}\\s*\\(`);
  const match = signature.exec(code);
  assert.ok(match, `在源码里找不到 export function ${name}`);
  const open = code.indexOf('{', match.index + match[0].length);
  assert.ok(open >= 0, `${name} 的函数体起点定位失败`);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error(`${name} 的函数体不闭合`);
}

const INLINE_CODE = stripComments(SOURCE);

/** 用当前源码里的 `inlinePrompt` 求值；`transforms` 供反向验证先破坏再断言。 */
function renderPrompt(maxChars, language, transforms = []) {
  const body = transforms.reduce((code, transform) => transform(code), extractFunctionBody(INLINE_CODE, 'inlinePrompt'));
  // eslint-disable-next-line no-new-func -- 源码是本地仓库文件，非外部输入
  const fn = new Function('maxChars', 'language', body);
  const value = fn(maxChars, language);
  assert.equal(typeof value, 'string', 'inlinePrompt 必须返回字符串');
  return value;
}

const PROMPT = renderPrompt(160, '简体中文');
const PROMPT_EN = renderPrompt(80, 'English');

/** 把真源码里的条款 / 生命周期句 / 关键短语的措辞当作唯一事实来源。 */
const LIFECYCLE_MARKERS = {
  '草稿是用户仍在输入、尚未发出的文字':
    'you are looking at text the user is STILL TYPING and has NOT sent yet',
  '那不是发给你的消息，也没有人在问你':
    'It is not a message to you, and nobody has asked you anything',
  '上下文只用于对齐术语与语气':
    'provided ONLY so you can align terminology and tone',
  '上下文不是要你回应的对话，也不是开新回合的信号':
    'It is NOT a conversation for you to respond to, and NOT a cue to start a new turn',
};

/**
 * 条款锚点 → 该条款必须出现的关键短语。
 * 键就是 `inlinePrompt` 里的 `C<n>.` 编号；集合相等断言保证「一条都不能少」，
 * 短语断言保证「不能留个空壳编号」。
 */
const CLAUSE_MARKERS = {
  C1: ['OUTPUT LANGUAGE', 'MUST be in'],            // 既有：语言
  C2: ['single line'],                              // 既有：单行
  C3: ['MUST NOT echo the draft'],                  // 既有：不复述草稿
  C4: ['slash command'],                            // 既有：slash 命令续写参数
  C5: ['At most'],                                  // 既有：字符上限
  C6: ['NEVER answer, reply to, or respond to the draft'], // 新增：反回答化
  C7: ['NEVER add any explanation'],                // 新增：不许加解释/建议
  C8: ['output nothing at all', 'empty completion is always better'], // 新增：空优于回答
};

const RETAINED_CLAUSES = ['C1', 'C2', 'C3', 'C4', 'C5'];
const BAN_CLAUSES = ['C6', 'C7', 'C8'];

/** 抽出 prompt 里的条款编号（条款行形如 `C1. ...`）。 */
function clauseIds(prompt) {
  return [...prompt.matchAll(/^C(\d+)\. /gm)].map((m) => `C${m[1]}`);
}

let cases = 0;
let failures = 0;
const run = (name, fn) => {
  cases += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}\n      ${String(error).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

console.log('inline-prompt-smoke: inlinePrompt() 指令契约');

// —— 1. 参数接线：maxChars / language 必须真的插进指令 ——
run('maxChars 被插进指令（160/80 两种取值都生效）', () => {
  assert.ok(PROMPT.includes('At most 160 visible characters'), 'C5 里没带上 maxChars=160');
  assert.ok(PROMPT_EN.includes('At most 80 visible characters'), 'C5 里没带上 maxChars=80');
  assert.ok(!PROMPT_EN.includes('160'), 'prompt 里残留了别的 maxChars 取值');
});

run('language 被插进指令（两种语言都生效）', () => {
  assert.ok(PROMPT.includes('MUST be in 简体中文'), 'C1 里没带上 language=简体中文');
  assert.ok(PROMPT_EN.includes('MUST be in English'), 'C1 里没带上 language=English');
});

// —— 2. 生命周期三件事必须显式命名（本次回归的根因修法）——
run('生命周期句必须显式命名（草稿未发出 / 上下文只对齐语气 / 不是要回应的对话）', () => {
  for (const [label, marker] of Object.entries(LIFECYCLE_MARKERS)) {
    assert.ok(PROMPT.includes(marker), `缺少生命周期句：${label}\n      期望短语：${marker}`);
  }
});

// —— 3. 既有五条约束一条都不能少，且不能留空壳编号 ——
run('既有五条约束（语言/单行/不复述草稿/slash/字符上限）全部保留', () => {
  const ids = clauseIds(PROMPT);
  for (const clause of RETAINED_CLAUSES) {
    assert.ok(ids.includes(clause), `既有条款 ${clause} 被删掉了（当前编号：${ids.join(',')}）`);
  }
});

run('每条条款都带实质关键短语（不是留个空壳编号）', () => {
  for (const [clause, markers] of Object.entries(CLAUSE_MARKERS)) {
    for (const marker of markers) {
      assert.ok(PROMPT.includes(marker), `条款 ${clause} 缺少关键短语：${marker}`);
    }
  }
});

// —— 4. 条款集合精确相等：删一条、加一条都会红 ——
run('条款集合精确等于 C1..C8（删一条或加一条都红）', () => {
  const expected = Object.keys(CLAUSE_MARKERS);
  assert.deepEqual(clauseIds(PROMPT), expected, '条款编号集合与冒烟登记的清单不一致');
});

// —— 5. 反向验证：断言必须可被证伪 ——
//
// 每条禁令依次从**函数体**里删掉，断言必须变红；加回去必须变绿。
// 这一步是本文件的骨架：只查「有没有」的断言，如果删掉也照样绿，等于没在查。

/**
 * 删掉某条款整行（以 `C<n>. ` 开头的数组元素）。
 *
 * ⚠ 条款是**数组里的字符串字面量**，源码行形如 `    'C6. NEVER answer...',`
 * ——不是以 `C6. ` 开头的裸行。早先这里用 `line.trimStart().startsWith('C6. ')`
 * 判定，永远匹配不到，整个删除是**静默 no-op**，于是「删掉 → 必须红」这条
 * 反向验证自己对任何输入都通过（等于没验）。现在按「行内含 `C<n>. `」判定，
 * 并且删完必须真的少一条——少不掉就直接抛出，不再让它装绿。
 */
const dropClause = (clause) => (code) => {
  const lines = code.split('\n');
  const kept = lines.filter((line) => !line.includes(`${clause}. `));
  assert.notEqual(kept.length, lines.length, `反向验证无效：${clause} 一行都没删掉（条款行形态变了？）`);
  return kept.join('\n');
};

/** 删掉某条生命周期句（按整行包含该措辞）。 */
const dropLifecycle = (marker) => (code) =>
  code.split('\n').filter((line) => !line.includes(marker)).join('\n');

console.log('  反向验证（删一条禁令 → 必须红）：');

for (const clause of BAN_CLAUSES) {
  const markers = CLAUSE_MARKERS[clause];
  run(`删掉 ${clause} → 断言变红`, () => {
    let broken = null;
    try {
      broken = renderPrompt(160, '简体中文', [dropClause(clause)]);
    } catch (error) {
      // 函数体被删空/语法坏掉也算「验证成立」——README 里记这种形态。
      if (/inlin.*不闭合|Unexpected|not defined/i.test(String(error))) return;
      throw error;
    }
    const ids = clauseIds(broken);
    assert.ok(!ids.includes(clause), `${clause} 仍在编号清单里：删失败了`);
    for (const marker of markers) {
      assert.ok(
        !broken.includes(marker),
        `反向验证失败：删掉 ${clause} 后关键短语「${marker}」仍在，说明这条断言查的不是它`,
      );
    }
  });
  run(`加回 ${clause} → 恢复绿`, () => {
    assert.equal(renderPrompt(160, '简体中文'), PROMPT, `${clause} 恢复后 prompt 与原文不一致`);
    for (const marker of markers) assert.ok(PROMPT.includes(marker), `${clause} 恢复后仍缺：${marker}`);
  });
}

for (const [label, marker] of Object.entries(LIFECYCLE_MARKERS)) {
  run(`删掉生命周期句「${label}」→ 断言变红`, () => {
    const broken = renderPrompt(160, '简体中文', [dropLifecycle(marker)]);
    assert.ok(!broken.includes(marker), `反向验证失败：删掉后「${marker}」仍在`);
  });
}

run('删掉 maxChars 插值 → C5 断言变红', () => {
  const broken = renderPrompt(160, '简体中文', [(code) => code.replace(/maxChars/g, '0')]);
  assert.ok(!broken.includes('At most 160 visible characters'), '删掉 maxChars 插值后仍匹配到上限');
  assert.ok(broken.includes('At most 0 visible characters'), 'maxChars 插值删不干净，反向验证无效');
});

// —— 6. 真源码的 prompt 必须与隔离求值一致（防断言对象漂移）——
run('隔离求值出的 prompt 与 lib/ 构建产物一致（源码即断言对象）', () => {
  let built;
  try {
    built = readFileSync(fileURLToPath(new URL('../lib/inline.js', import.meta.url)), 'utf8');
  } catch {
    console.log('      （lib/ 不存在，跳过——lib/ 是构建产物，不入库）');
    return;
  }
  // lib/inline.js 是 tsc 产物，prompt 正文以单引号字符串拼接形式出现；
  // 只验证「同样的条款编号 + 同样的关键短语」都在产物里，避免粘贴整段 prompt。
  for (const clause of Object.keys(CLAUSE_MARKERS)) {
    assert.ok(built.includes(`${clause}. `), `lib/inline.js 里缺少条款 ${clause}（跑过 node build.mjs 了吗）`);
  }
  for (const marker of Object.values(LIFECYCLE_MARKERS)) {
    assert.ok(built.includes(marker), `lib/inline.js 里缺少生命周期句：${marker}`);
  }
});

console.log(`inline-prompt-smoke: ${cases - failures}/${cases} 条断言通过`);

if (failures > 0) {
  console.error(`inline-prompt-smoke: ${failures} 条断言失败`);
  process.exit(1);
}
console.log('inline-prompt-smoke: all assertions passed');
