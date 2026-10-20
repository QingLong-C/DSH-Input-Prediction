#!/usr/bin/env node
/**
 * isRealUserMessage 注入消息过滤回归测试（`src/transcript.ts`）。
 *
 * 钉住 #24 修复的性质：注入的 user/message 事件（source.kind !== 'user'）
 * 必须被 isRealUserMessage 判定为 false，以便在构建转录前过滤。
 *
 * 注入消息类型：
 * - time-context: 时间上下文（"Current date: ..."）
 * - skill-catalog: 技能目录
 * - runtime-context: 运行时上下文
 * - system-prompt: 系统提示
 *
 * 只有 source.kind === 'user' 的真实用户消息应该返回 true。
 *
 * 用法：node --experimental-strip-types scripts/inject-filter-smoke.mjs
 */
import assert from 'node:assert/strict';
import { isRealUserMessage } from '../src/transcript.ts';

console.log('【注入消息过滤冒烟测试】\n');

// ─── 1. 真实用户消息 → true ──────────────────────────────────────────────
{
  const event = {
    type: 'user/message',
    data: {
      text: '你好，请帮我写一个函数',
      source: { kind: 'user' },
    },
  };
  assert.equal(isRealUserMessage(event), true, '真实用户消息应返回 true');
  console.log('✅ 真实用户消息 → true');
}

// ─── 2. time-context 注入 → false ────────────────────────────────────────
{
  const event = {
    type: 'user/message',
    data: {
      text: 'Current date: 2026-10-20',
      source: { kind: 'time-context' },
    },
  };
  assert.equal(isRealUserMessage(event), false, 'time-context 注入应返回 false');
  console.log('✅ time-context 注入 → false');
}

// ─── 3. skill-catalog 注入 → false ───────────────────────────────────────
{
  const event = {
    type: 'user/message',
    data: {
      text: 'Available skills: ...',
      source: { kind: 'skill-catalog' },
    },
  };
  assert.equal(isRealUserMessage(event), false, 'skill-catalog 注入应返回 false');
  console.log('✅ skill-catalog 注入 → false');
}

// ─── 4. runtime-context 注入 → false ─────────────────────────────────────
{
  const event = {
    type: 'user/message',
    data: {
      text: 'Runtime context: ...',
      source: { kind: 'runtime-context' },
    },
  };
  assert.equal(isRealUserMessage(event), false, 'runtime-context 注入应返回 false');
  console.log('✅ runtime-context 注入 → false');
}

// ─── 5. system-prompt 注入 → false ───────────────────────────────────────
{
  const event = {
    type: 'user/message',
    data: {
      text: 'System prompt: ...',
      source: { kind: 'system-prompt' },
    },
  };
  assert.equal(isRealUserMessage(event), false, 'system-prompt 注入应返回 false');
  console.log('✅ system-prompt 注入 → false');
}

// ─── 6. source 字段缺失 → false（保守策略）───────────────────────────────
{
  const event = {
    type: 'user/message',
    data: {
      text: 'No source field',
    },
  };
  assert.equal(isRealUserMessage(event), false, 'source 字段缺失应返回 false');
  console.log('✅ source 字段缺失 → false');
}

// ─── 7. source.kind 缺失 → false ─────────────────────────────────────────
{
  const event = {
    type: 'user/message',
    data: {
      text: 'No kind field',
      source: {},
    },
  };
  assert.equal(isRealUserMessage(event), false, 'source.kind 缺失应返回 false');
  console.log('✅ source.kind 缺失 → false');
}

// ─── 8. 非 user/message 事件 → false ─────────────────────────────────────
{
  const event = {
    type: 'assistant/message',
    data: {
      text: '好的',
    },
  };
  assert.equal(isRealUserMessage(event), false, 'assistant/message 应返回 false');
  console.log('✅ assistant/message → false');
}

// ─── 9. turn/start 事件 → false ──────────────────────────────────────────
{
  const event = {
    type: 'turn/start',
    data: { turn: 1 },
  };
  assert.equal(isRealUserMessage(event), false, 'turn/start 应返回 false');
  console.log('✅ turn/start → false');
}

// ─── 10. data 字段缺失 → false ───────────────────────────────────────────
{
  const event = {
    type: 'user/message',
  };
  assert.equal(isRealUserMessage(event), false, 'data 字段缺失应返回 false');
  console.log('✅ data 字段缺失 → false');
}

console.log('\n✅ isRealUserMessage 10 组用例全部通过');
