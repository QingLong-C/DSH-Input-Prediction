// Real suggestion-filter regression cases for questions, actions and confirmations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanSuggestion, shouldFilterSuggestion } from '../src/sanitize.ts';

for (const text of [
  '可以解释一下这个功能是怎么实现的吗？',
  '这两种方案有什么区别？',
  '下一步应该怎么做？',
  '为什么选择插件而不是直接修改客户端？',
  'What is the difference between these options?',
  '请继续实现这个功能',
  'run the tests',
  '好的',
  '可以',
  '继续',
]) {
  test(`keeps a useful user follow-up: ${text}`, () => {
    assert.equal(shouldFilterSuggestion(cleanSuggestion(text)), false);
  });
}

for (const text of [
  '',
  'no suggestion',
  'stay silent',
  'Let me implement this for you',
  '我来帮你实现这个功能',
  '谢谢',
  'looks good',
]) {
  test(`rejects empty, meta, assistant voice or feedback: ${text}`, () => {
    assert.equal(shouldFilterSuggestion(cleanSuggestion(text)), true);
  });
}
