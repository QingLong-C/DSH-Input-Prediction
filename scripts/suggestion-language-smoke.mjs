#!/usr/bin/env node
/**
 * suggestionLanguage 回归测试（`src/transcript.ts`）。
 *
 * 钉住 #24 修复的两条性质：
 *  1. UI 先验阈值：当 UI locale 是中文，但转录里拉丁字符证据超过 `uiLocaleWeight`
 *     时，返回 English；否则返回简体中文。
 *  2. 注入消息过滤：调用方（generate.ts）必须在构建 pairs 前过滤掉 source.kind !== 'user'
 *     的注入消息（time-context, skill-catalog 等），否则英文注入会污染语言判定。
 *     本测试验证纯函数侧的行为，注入过滤在 generate.ts 的集成测试里覆盖。
 *
 * 用法：node --experimental-strip-types scripts/suggestion-language-smoke.mjs
 */
import assert from 'node:assert/strict';
import { suggestionLanguage } from '../src/transcript.ts';

/** 构造一对。 */
const pair = (role, text) => ({ role, text });

// ─── 1. 纯中文转录，UI locale 中文 → 简体中文 ─────────────────────────────
{
  const pairs = [
    pair('user', '你好，请帮我写一个函数'),
    pair('assistant', '好的，这是一个示例函数...'),
    pair('user', '再加一个参数校验'),
  ];
  const result = suggestionLanguage(pairs, 'zh');
  assert.equal(result, '简体中文', `纯中文 + zh locale 应返回简体中文，实际: ${result}`);
}

// ─── 2. 纯英文转录，UI locale 中文 → English ──────────────────────────────
{
  const pairs = [
    pair('user', 'Hello, can you help me write a function'),
    pair('assistant', 'Sure, here is an example function...'),
    pair('user', 'Please add parameter validation'),
  ];
  const result = suggestionLanguage(pairs, 'zh');
  assert.equal(result, 'English', `纯英文 + zh locale 应返回 English，实际: ${result}`);
}

// ─── 3. 中文为主 + 少量英文，UI locale 中文 → 简体中文（UI 先验生效）────────
{
  const pairs = [
    pair('user', '你好，请帮我写一个 function'),
    pair('assistant', '好的，这是一个示例 function...'),
    pair('user', '再加一个 parameter validation'),
  ];
  // CJK 字符约 20+，Latin 约 30，latinScore < uiLocaleWeight(100)
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, '简体中文', `中文为主 + 少量英文 + zh locale 应返回简体中文，实际: ${result}`);
}

// ─── 4. 中文为主 + 大量英文，UI locale 中文，latinScore > uiLocaleWeight → English
{
  const pairs = [
    pair('user', '你好'),
    pair('assistant', '好的'),
    pair('user', 'Please help me write a comprehensive function with parameter validation, error handling, and proper documentation including examples and edge cases'),
  ];
  // CJK 约 4，Latin 约 150+，latinScore(150) > uiLocaleWeight(100)
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, 'English', `中文少 + 英文多 + latinScore > uiLocaleWeight 应返回 English，实际: ${result}`);
}

// ─── 5. UI 先验阈值：latinScore 略低于 uiLocaleWeight → 简体中文 ──────────
{
  const pairs = [
    pair('user', '你好世界'), // CJK 4
    pair('user', 'abc'), // Latin 3
  ];
  // 粗略：cjkScore ≈ 8 + 100 = 108, latinScore ≈ 12
  // latinScore(12) < uiLocaleWeight(100)，返回简体中文
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, '简体中文', `latinScore < uiLocaleWeight 应返回简体中文，实际: ${result}`);
}

// ─── 6. 俄语转录，UI locale 英文 → Russian（Cyrillic 主导，无视 UI）────────
{
  const pairs = [
    pair('user', 'Привет, помоги мне написать функцию'),
    pair('assistant', 'Хорошо, вот пример функции...'),
  ];
  const result = suggestionLanguage(pairs, 'en-US');
  // Cyrillic 主导，hasUiPrior=false（en-US 不算 UI prior），直接返回 Russian
  assert.equal(result, 'Russian', `俄语 + en-US locale 应返回 Russian，实际: ${result}`);
}

// ─── 7. 空转录 → 默认 English ─────────────────────────────────────────────
{
  const pairs = [];
  const result = suggestionLanguage(pairs, 'zh');
  assert.equal(result, 'English', `空转录应返回 English（无消息可分析），实际: ${result}`);
}

// ─── 8. 只有 assistant 消息，无 user 消息 → 回退到 assistant 语言 ─────────
{
  const pairs = [
    pair('assistant', '这是一个回复'),
    pair('assistant', '这是另一个回复'),
  ];
  const result = suggestionLanguage(pairs, 'zh');
  // 无 user 消息，回退到最近一条 assistant 消息（中文），应返回简体中文
  assert.equal(result, '简体中文', `无 user 消息 + assistant 中文 + zh locale 应返回简体中文，实际: ${result}`);
}

// ─── 9. 混合 CJK + Cyrillic + Latin，CJK + UI 先验主导 → 简体中文 ────────
{
  const pairs = [
    pair('user', '你好 Привет Hello'),
    pair('user', '世界 World Мир'),
  ];
  // 粗略计算：CJK ~12, Cyrillic ~9, Latin ~10
  // 加上 zh UI prior (+100 to cjkScore)，cjkScore 远超 cyrillicScore
  // 走 CJK 分支，latinScore < uiLocaleWeight，返回简体中文
  // 注意：hasUiPrior 只匹配 'zh' 或 'ru'，不匹配 'zh-CN'
  const result = suggestionLanguage(pairs, 'zh', 100);
  assert.equal(result, '简体中文', `混合语言 + CJK + UI 先验主导 + zh locale 应返回简体中文，实际: ${result}`);
}

// ─── 10. uiLocaleWeight 调低：少量英文就触发 English ─────────────────────
{
  const pairs = [
    pair('user', '你好'),
    pair('user', 'hello world'),
  ];
  // CJK 2, Latin 11, latinScore(11) > uiLocaleWeight(5)
  const result = suggestionLanguage(pairs, 'zh', 5);
  assert.equal(result, 'English', `latinScore(11) > uiLocaleWeight(5) 应返回 English，实际: ${result}`);
}

console.log('✅ suggestionLanguage 10 组用例全部通过');
