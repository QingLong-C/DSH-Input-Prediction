// Exercise the real host settings closure; no model, profile or network access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { flattenConfig, resolveConfig } from '../lib/generate.js';
import { effectiveConfig } from '../lib/settings.js';

const source = stripTypeScriptTypes(fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'));
const start = source.indexOf('  const resolved = resolveConfig(config);');
const end = source.indexOf('  // —— 每会话历史环', start);
assert.ok(start >= 0 && end > start);

function harness() {
  let inject;
  let document;
  let fails = false;
  const listeners = new Set();
  const cleanups = [];
  const consumed = [];
  const root = { on: (_event, listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const ctx = {
    root, logger: { info() {}, warn() {} },
    inject: (_services, callback) => { inject = callback; },
  };
  const settings = {
    describe: () => { if (fails) throw new Error('temporarily unavailable'); return document; },
    update: async () => {},
  };
  const injection = { settings, effect: (run) => { cleanups.push(run()); } };
  const config = {
    maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 60000,
    maxTranscriptChars: 12000, maxSuggestionChars: 240,
    languageMode: 'auto', llmEnabled: true,
  };
  const api = new Function('ctx', 'config', 'resolveConfig', 'flattenConfig', 'setupHotnessPersistence',
    'EMPTY_PUSH', 'SUGGEST_GHOST_NAMESPACE', 'parseHotnessOps', 'consumeOps', 'effectiveConfig', 'console',
    source.slice(start, end) + '\nreturn { effective, readOps };')(
      ctx, config, resolveConfig, flattenConfig,
      () => ({ hotness: {}, persistence: { whenReady: new Promise(() => {}) } }),
      'null', 'suggest-ghost', value => value, value => consumed.push(value), effectiveConfig,
      { log() {} },
    );
  return {
    api, consumed, listeners,
    set: (value, wrapped = false) => {
      const rows = [{ ns: 'unrelated', value: { languageMode: 'en' } }, { ns: 'suggest-ghost', value }];
      document = wrapped ? { namespaces: rows } : rows;
    },
    fail: value => { fails = value; },
    inject: () => inject(injection),
    notify: () => { for (const listener of listeners) listener('suggest-ghost'); },
    dispose: () => { for (const cleanup of cleanups.reverse()) cleanup(); },
  };
}

test('host reads changed language and live generation controls from the authoritative descriptor', () => {
  const h = harness();
  h.set({ languageMode: 'auto', _ops: 'null' });
  h.inject();
  h.set({ languageMode: 'zh', llmEnabled: false, maxOutputTokens: 96, _ops: 'null' });
  h.notify();
  const config = h.api.effective();
  assert.equal(config.languageMode, 'zh');
  assert.equal(config.llmEnabled, false);
  assert.equal(config.maxOutputTokens, 96);
  assert.equal(config.maxInputBytes, 4096, 'omitted strategy retains its base value');
});

test('host accepts namespace envelopes and Volatile fields without relying on an event', () => {
  const h = harness();
  h.set({ languageMode: 'auto', _ops: 'null' });
  h.inject();
  h.set({ languageMode: { get: () => 'zh' }, maxInputBytes: { get: () => 2048 } }, true);
  assert.equal(h.api.effective().languageMode, 'zh');
  assert.equal(h.api.effective().maxInputBytes, 2048);
});

test('unavailable or invalid settings retain the last valid configuration and startup has a base fallback', () => {
  const h = harness();
  assert.equal(h.api.effective().languageMode, 'auto');
  h.set({ languageMode: 'zh', maxOutputTokens: 96 });
  h.inject();
  assert.equal(h.api.effective().languageMode, 'zh');
  h.fail(true);
  assert.equal(h.api.effective().languageMode, 'zh');
  h.fail(false);
  h.set({ languageMode: 'en', maxOutputTokens: 0 });
  assert.equal(h.api.effective().languageMode, 'zh');
  assert.equal(h.api.effective().maxOutputTokens, 96);
});

test('authoritative ops still work and settings listener is removed with the injection lifecycle', () => {
  const h = harness();
  h.set({ languageMode: 'zh', _ops: '{"pull":1}' });
  h.inject();
  assert.equal(h.api.readOps(), '{"pull":1}');
  assert.equal(h.listeners.size, 1);
  h.dispose();
  assert.equal(h.listeners.size, 0);
  const count = h.consumed.length;
  h.notify();
  assert.equal(h.consumed.length, count);
});
