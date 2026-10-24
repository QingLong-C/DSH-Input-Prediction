// Test the built package's real schema and prompt; run after rebuilding for GREEN.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '../lib/index.js';
import { flattenConfig, resolveConfig, systemPrompt } from '../lib/generate.js';

test('defaults enable completed-turn suggestions only', () => {
  const parsed = flattenConfig(resolveConfig(Config({})));
  assert.equal(parsed.llmEnabled, true);
  assert.equal(parsed.historyEnabled, false);
  assert.equal(parsed.inlineEnabled, false);
  assert.equal(parsed.wordAccept, false);
  assert.equal(parsed.acceptKey, 'Tab');
  for (const key of ['maxInputBytes', 'maxOutputTokens', 'timeoutMs', 'maxRecentTurns', 'maxTranscriptChars', 'maxSuggestionChars']) {
    assert.equal(typeof parsed[key], 'number', `${key} must be unwrapped`);
  }
});

test('prediction prompt supports explanation, comparison, next steps and confirmation in the user language', () => {
  const prompt = systemPrompt(240, '简体中文');
  assert.match(prompt, /OUTPUT LANGUAGE: 简体中文/);
  assert.match(prompt, /可以解释一下/);
  assert.match(prompt, /有什么区别/);
  assert.match(prompt, /下一步/);
  assert.match(prompt, /好的/);
  assert.doesNotMatch(prompt, /- Questions \(/);
  assert.match(prompt, /reply with nothing/i);
});
