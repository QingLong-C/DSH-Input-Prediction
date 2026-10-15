// dsh-suggest-ghost 长会话摘要纯函数冒烟测试。
import assert from 'node:assert/strict';
import { extractContextSummary } from '../src/transcript.ts';

console.log('【长会话摘要冒烟测试】\n');

// ① 空输入返回空串
{
  const result = extractContextSummary([], 1500);
  assert.equal(result, '', '空输入应返回空串');
  console.log('✅ 空输入 → 空串');
}

// ② 预算过小返回空串
{
  const pairs = [{ role: 'user', text: 'hello world' }];
  const result = extractContextSummary(pairs, 30);
  assert.equal(result, '', '预算 < 50 应返回空串');
  console.log('✅ 预算过小（30）→ 空串');
}

// ③ 只取用户消息，忽略 assistant
{
  const pairs = [
    { role: 'user', text: 'I prefer TypeScript.' },
    { role: 'assistant', text: 'Sure, I will use TypeScript for everything.' },
    { role: 'user', text: 'Use functional style.' },
  ];
  const result = extractContextSummary(pairs, 1500);
  assert.ok(result.startsWith('[Earlier context summary] '), '应有前缀');
  assert.ok(result.includes('I prefer TypeScript'), '应包含第一条用户消息');
  assert.ok(result.includes('Use functional style'), '应包含第二条用户消息');
  assert.ok(!result.includes('Sure, I will use'), '不应包含 assistant 消息');
  console.log('✅ 只提取用户消息，忽略 assistant');
}

// ④ 每条消息取第一句
{
  const pairs = [
    { role: 'user', text: 'Use pnpm. It is faster than npm.' },
    { role: 'user', text: 'Prefer React over Vue. Vue is also good.' },
  ];
  const result = extractContextSummary(pairs, 1500);
  assert.ok(result.includes('Use pnpm'), '应取第一句');
  assert.ok(!result.includes('It is faster'), '不应取第二句');
  assert.ok(result.includes('Prefer React over Vue'), '应取第一句');
  assert.ok(!result.includes('Vue is also good'), '不应取第二句');
  console.log('✅ 每条消息只取第一句');
}

// ⑤ 按字符预算截断
{
  const pairs = [];
  for (let i = 0; i < 20; i++) {
    pairs.push({ role: 'user', text: `Message number ${i} with some content.` });
  }
  const result = extractContextSummary(pairs, 200);
  assert.ok(result.length <= 200, `摘要长度 ${result.length} 应 <= 200`);
  assert.ok(result.startsWith('[Earlier context summary] '), '应有前缀');
  console.log(`✅ 字符预算截断：20 条消息 → ${result.length} 字符（预算 200）`);
}

// ⑥ 中文消息正确处理
{
  const pairs = [
    { role: 'user', text: '我用 TypeScript。偏好函数式风格。' },
    { role: 'user', text: '项目用 pnpm，不要用 npm。' },
  ];
  const result = extractContextSummary(pairs, 1500);
  assert.ok(result.includes('我用 TypeScript'), '应包含中文第一句');
  assert.ok(result.includes('项目用 pnpm'), '应包含中文第一句');
  assert.ok(!result.includes('偏好函数式风格'), '不应包含第二句');
  console.log('✅ 中文消息按句号截断正确');
}

// ⑦ 超长句子被跳过（> 200 字符）
{
  const longSentence = 'A'.repeat(250) + '. Short one.';
  const pairs = [{ role: 'user', text: longSentence }];
  const result = extractContextSummary(pairs, 1500);
  assert.equal(result, '', '超长句子应被跳过，无有效内容返回空串');
  console.log('✅ 超长句子（> 200 字符）被跳过');
}

// ⑧ 分号拼接多条
{
  const pairs = [
    { role: 'user', text: 'First goal.' },
    { role: 'user', text: 'Second preference.' },
    { role: 'user', text: 'Third constraint.' },
  ];
  const result = extractContextSummary(pairs, 1500);
  assert.ok(result.includes('; '), '多条应用分号拼接');
  const content = result.replace('[Earlier context summary] ', '');
  const parts = content.split('; ');
  assert.equal(parts.length, 3, '应有 3 条');
  console.log('✅ 多条消息用分号拼接');
}

console.log('\n结果：8 通过, 0 失败');
