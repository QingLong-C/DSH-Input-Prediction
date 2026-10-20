#!/usr/bin/env node
/**
 * HotnessTable.consume 事件过滤回归测试。
 *
 * 钉住 consume 方法的过滤性质：
 * 1. 只处理 user/message 事件
 * 2. 过滤注入消息（source.kind !== 'user'）
 * 3. 过滤空文本
 * 4. 过滤超长文本（> HOT_TEXT_MAX_CHARS）
 *
 * 用法：node --experimental-strip-types scripts/hotness-consume-smoke.mjs
 */
import assert from 'node:assert/strict';
import { HOT_TEXT_MAX_CHARS, HotnessTable } from '../src/hotness.ts';

console.log('【HotnessTable.consume 事件过滤冒烟测试】\n');

// ─── 1. 正常 user/message → 记录 ─────────────────────────────────────────
{
  const hotness = new HotnessTable();
  const event = {
    type: 'user/message',
    seq: 10,
    data: {
      content: [{ type: 'text', text: '你好世界' }],
      source: { kind: 'user' },
    },
  };
  hotness.consume(event, 's1');
  assert.equal(hotness.size, 1, '应记录 1 条');
  const snap = hotness.snapshot(10);
  assert.equal(snap[0].text, '你好世界');
  assert.equal(snap[0].count, 1);
  console.log('✅ 正常 user/message → 记录');
}

// ─── 2. 非 user/message 事件 → 忽略 ──────────────────────────────────────
{
  const hotness = new HotnessTable();
  const event = {
    type: 'assistant/message',
    seq: 10,
    data: {
      content: [{ type: 'text', text: '好的' }],
    },
  };
  hotness.consume(event, 's1');
  assert.equal(hotness.size, 0, 'assistant/message 应忽略');
  console.log('✅ assistant/message → 忽略');
}

// ─── 3. 注入消息（source.kind !== 'user'）→ 忽略 ─────────────────────────
{
  const hotness = new HotnessTable();
  const event = {
    type: 'user/message',
    seq: 10,
    data: {
      content: [{ type: 'text', text: 'Current date: 2026-10-20' }],
      source: { kind: 'time-context' },
    },
  };
  hotness.consume(event, 's1');
  assert.equal(hotness.size, 0, 'time-context 注入应忽略');
  console.log('✅ time-context 注入 → 忽略');
}

// ─── 4. source 缺失 → 忽略 ───────────────────────────────────────────────
{
  const hotness = new HotnessTable();
  const event = {
    type: 'user/message',
    seq: 10,
    data: {
      content: [{ type: 'text', text: '无 source 字段' }],
    },
  };
  hotness.consume(event, 's1');
  assert.equal(hotness.size, 0, 'source 缺失应忽略');
  console.log('✅ source 缺失 → 忽略');
}

// ─── 5. 空文本 → 忽略 ────────────────────────────────────────────────────
{
  const hotness = new HotnessTable();
  const event = {
    type: 'user/message',
    seq: 10,
    data: {
      content: [{ type: 'text', text: '' }],
      source: { kind: 'user' },
    },
  };
  hotness.consume(event, 's1');
  assert.equal(hotness.size, 0, '空文本应忽略');
  console.log('✅ 空文本 → 忽略');
}

// ─── 6. 超长文本（> HOT_TEXT_MAX_CHARS）→ 忽略 ───────────────────────────
{
  const hotness = new HotnessTable();
  const longText = 'a'.repeat(HOT_TEXT_MAX_CHARS + 1);
  const event = {
    type: 'user/message',
    seq: 10,
    data: {
      content: [{ type: 'text', text: longText }],
      source: { kind: 'user' },
    },
  };
  hotness.consume(event, 's1');
  assert.equal(hotness.size, 0, '超长文本应忽略');
  console.log('✅ 超长文本 → 忽略');
}

// ─── 7. 边界：恰好 HOT_TEXT_MAX_CHARS → 记录 ─────────────────────────────
{
  const hotness = new HotnessTable();
  const exactText = 'a'.repeat(HOT_TEXT_MAX_CHARS);
  const event = {
    type: 'user/message',
    seq: 10,
    data: {
      content: [{ type: 'text', text: exactText }],
      source: { kind: 'user' },
    },
  };
  hotness.consume(event, 's1');
  assert.equal(hotness.size, 1, '恰好 HOT_TEXT_MAX_CHARS 应记录');
  console.log('✅ 恰好 HOT_TEXT_MAX_CHARS → 记录');
}

// ─── 8. 多文本块拼接 → 记录完整文本 ──────────────────────────────────────
{
  const hotness = new HotnessTable();
  const event = {
    type: 'user/message',
    seq: 10,
    data: {
      content: [
        { type: 'text', text: '你好' },
        { type: 'text', text: ' ' },
        { type: 'text', text: '世界' },
      ],
      source: { kind: 'user' },
    },
  };
  hotness.consume(event, 's1');
  assert.equal(hotness.size, 1, '应记录 1 条');
  const snap = hotness.snapshot(10);
  assert.equal(snap[0].text, '你好 世界');
  console.log('✅ 多文本块拼接 → 记录完整文本');
}

// ─── 9. 重复消息（同会话）→ 不计频次 ─────────────────────────────────────
{
  const hotness = new HotnessTable();
  const event1 = {
    type: 'user/message',
    seq: 10,
    data: {
      content: [{ type: 'text', text: '重复' }],
      source: { kind: 'user' },
    },
  };
  const event2 = {
    type: 'user/message',
    seq: 11,
    data: {
      content: [{ type: 'text', text: '重复' }],
      source: { kind: 'user' },
    },
  };
  hotness.consume(event1, 's1');
  hotness.consume(event2, 's1'); // 同会话相邻重复
  assert.equal(hotness.size, 1, '应记录 1 条');
  const snap = hotness.snapshot(10);
  assert.equal(snap[0].count, 1, '同会话相邻重复不计频次');
  console.log('✅ 重复消息（同会话）→ 不计频次');
}

// ─── 10. 重复消息（跨会话）→ 计频次 ──────────────────────────────────────
{
  const hotness = new HotnessTable();
  const event1 = {
    type: 'user/message',
    seq: 10,
    data: {
      content: [{ type: 'text', text: '跨会话' }],
      source: { kind: 'user' },
    },
  };
  const event2 = {
    type: 'user/message',
    seq: 20,
    data: {
      content: [{ type: 'text', text: '跨会话' }],
      source: { kind: 'user' },
    },
  };
  hotness.consume(event1, 's1');
  hotness.consume(event2, 's2'); // 跨会话
  assert.equal(hotness.size, 1, '应记录 1 条');
  const snap = hotness.snapshot(10);
  assert.equal(snap[0].count, 2, '跨会话重复应计频次');
  console.log('✅ 重复消息（跨会话）→ 计频次');
}

console.log('\n✅ HotnessTable.consume 10 组用例全部通过');
