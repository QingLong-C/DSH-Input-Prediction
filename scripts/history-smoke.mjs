// dsh-suggest-ghost 历史补全纯函数冒烟测试（node --experimental-strip-types 直接跑 TS 源）。
import assert from 'node:assert/strict';
import {
  extractHistory,
  historySuggestion,
  normalizeForMatch,
  commonPrefixLength,
  stripCommandPrefix,
} from '../src/client/history.ts';
import { HotnessTable } from '../src/hotness.ts';
import { nextAcceptChunk, nextAcceptChunkFallback } from '../src/client/chunk.ts';
import { trimTranscript } from '../src/transcript.ts';

const T = '帮我写个单元测试';
const R = '帮我看下这个日志';
const X = '帮我部署到预发环境';
const opts = { minChars: 1, maxEntries: 0 };

// —— B：归一化 ——
assert.equal(normalizeForMatch('Ｈello，Ｗorld！'), 'hello,world!');
assert.equal(normalizeForMatch('  a　b\t c '), 'a b c');
// 全角草稿 vs 半角历史
assert.equal(historySuggestion(['帮我,看下日志'], '帮我，', opts), '帮我,看下日志');
// 尾部空格草稿仍可匹配；渲染公共前缀按原文计算
assert.equal(commonPrefixLength('帮我 ', '帮我看下日志'), 2);
assert.equal(historySuggestion(['帮我看下日志'], '帮我 ', opts), '帮我看下日志');
// 归一化意义下与草稿完全相同 → 排除
assert.equal(historySuggestion(['你好世界'], '你好世界 ', opts), undefined);
assert.equal(historySuggestion(['你好世界！'], '你好世界!', opts), undefined);

// —— A：打分制 ——
// 新近度主导：一次性最新短语压过较旧的高频短语
assert.equal(
  historySuggestion([T, T, R], '帮我', opts),
  R,
  '新近度应占主导',
);
// 频次纠偏：高频旧短语压过一次性新短语
assert.equal(
  historySuggestion([T, T, T, T, T, R], '帮我', opts),
  T,
  '高频旧短语应在频次项下胜出',
);
// maxEntries 截尾保留最近 N 条
assert.equal(
  historySuggestion([T, T, T, R], '帮我', { minChars: 1, maxEntries: 1 }),
  R,
  '截尾后只剩最近一条',
);

// —— C：热度频次 ——
// 场景：R 在 idx7（recency .8），X 最新 idx9（recency 1.0）；无热度时 X 胜，
// R 有满额热度时反超（0.3 权重 > 0.2 的 recency 差）。
const arr2 = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', R, 'f8', X];
// 无热度：最新者胜
assert.equal(
  historySuggestion(arr2, '帮我', opts),
  X,
  '无热度信号时最近者胜',
);
// 有热度：次新条目凭频次反超
assert.equal(
  historySuggestion(arr2, '帮我', { ...opts, hotCounts: new Map([[normalizeForMatch(R), 99]]) }),
  R,
  '热度频次应让次新条目反超',
);
// extraCandidates：会话内没有的历史也能成为候选；重复文本不产生双候选
assert.equal(
  historySuggestion(['完全无关的消息'], '帮我', { ...opts, extraCandidates: [{ text: R, count: 5 }] }),
  R,
  '跨会话候选应参与竞争',
);
assert.equal(
  historySuggestion([R], '帮我', {
    ...opts,
    hotCounts: new Map([[normalizeForMatch(R), 5]]),
    extraCandidates: [{ text: R, count: 5 }],
  }),
  R,
  '会话内已有该文本时热度并入同一候选',
);

// —— extractHistory 回归：仅 user 节点、跳过空白、去相邻重复 ——
const nodes = [
  { kind: 'user', content: [{ type: 'text', text: '  第一条  ' }] },
  { kind: 'user', content: [{ type: 'text', text: '其他消息' }] }, // 隔开两条相同消息
  { kind: 'assistant', content: [{ type: 'text', text: 'AI 回复不算' }] },
  { kind: 'user', content: [{ type: 'text', text: '第一条' }] }, // 非相邻：不去重
  { kind: 'user', content: [{ type: 'text', text: '   ' }] }, // 空白跳过
];
assert.deepEqual(extractHistory(nodes), ['第一条', '其他消息', '第一条']);

// —— chat 视图节点形态回归：载荷包在 node.data 里（rc.7 装配视图）——
{
  const chatNodes = [
    { key: 'k1', kind: 'turn-tail' },
    {
      key: 'k2',
      kind: 'user',
      data: {
        kind: 'user', seq: 7,
        content: [{ type: 'text', text: '这个插件让输入框学会接话' }],
        source: { kind: 'user' },
      },
    },
    { key: 'k3', kind: 'context' },
    {
      key: 'k4',
      kind: 'user',
      data: {
        kind: 'user', seq: 9,
        content: [{ type: 'text', text: '<system-reminder>系统注入</system-reminder>' }],
        source: { kind: 'plugin' },
      },
    },
  ];
  assert.deepEqual(extractHistory(chatNodes), ['这个插件让输入框学会接话']);
}

// —— 系统注入过滤（活实例测试发现的回归）——
// extractHistory：跳过 <system-reminder> 包装块与超长文本；带 source 的注入节点跳过。
{
  const nodes = [
    { kind: 'user', content: [{ type: 'text', text: '<system-reminder>\nA skill is...' }] },
    { kind: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Current runtime context...' }] },
    { kind: 'user', content: [{ type: 'text', text: 'x'.repeat(3000) }] },
    { kind: 'user', content: [{ type: 'text', text: '正常消息' }] },
  ];
  assert.deepEqual(extractHistory(nodes), ['正常消息']);
}
// HotnessTable：source.kind 非 user 不计数、超长不计；
// 同会话相邻重复只计一次（对齐 extractHistory 去重），跨会话再次出现才累计。
{
  const hot = new HotnessTable();
  const ev = (kind, text, seq) => ({
    type: 'user/message',
    seq,
    data: { content: [{ type: 'text', text }], ...(kind === null ? {} : { source: { kind } }) },
  });
  hot.consume(ev('user', '部署到测试环境', 1), 's1');
  hot.consume(ev('user', '部署到测试环境', 2), 's1'); // 同会话相邻重复：不虚增
  hot.consume(ev('user', '部署到测试环境', 3), 's2'); // 跨会话再次出现：计入
  hot.consume(ev('plugin', 'Current runtime context...', 4), 's1'); // 系统注入
  hot.consume(ev(null, '缺 source 的未知消息不计', 5), 's1'); // 严格白名单
  hot.consume(ev('user', 'y'.repeat(3000), 6), 's1'); // 超长防御
  const snap = hot.snapshot(0);
  assert.deepEqual(snap.map(e => e.text), ['部署到测试环境']);
  assert.equal(snap[0]?.count, 2);
}

// —— 逐词采纳切分 ——
// 英文：词 + 尾随空格
assert.equal(nextAcceptChunk('run the tests'), 'run ');
assert.equal(nextAcceptChunk('the tests'), 'the ');
assert.equal(nextAcceptChunk('tests'), 'tests');
// 中文词典分词；词尾标点跟随词
const zh = '提交一下代码，然后跑测试';
assert.equal(nextAcceptChunk(zh), '提交');
assert.equal(nextAcceptChunk(zh.slice(2)), '一下');
assert.equal(nextAcceptChunk(zh.slice(4)), '代码，');
// 前导标点/空白并入下一片段（不产生纯空片段）
assert.equal(nextAcceptChunk('，然后'), '，然后');
assert.equal(nextAcceptChunk(' world'), ' world');
// 全标点后缀整段收尾；空串原样
assert.equal(nextAcceptChunk('。！？'), '。！？');
assert.equal(nextAcceptChunk(''), '');
// 回退路径（无 Intl.Segmenter）：CJK 每片 ≤2 字、英文按空格、前导空格并入
assert.equal(nextAcceptChunkFallback('帮我看下日志'), '帮我');
assert.equal(nextAcceptChunkFallback('run the'), 'run ');
assert.equal(nextAcceptChunkFallback(' the'), ' the');

// —— 斜杠命令前缀剥离 ——
assert.equal(stripCommandPrefix('我重新部署了'), '我重新部署了', '普通消息原样返回');
assert.equal(stripCommandPrefix('/later 我重新部署了'), '我重新部署了', '基础命令剥前缀');
assert.equal(stripCommandPrefix('/later +3m 我重新部署了，你可以E2E测试了'), '我重新部署了，你可以E2E测试了', '带时间参数的 /later');
assert.equal(stripCommandPrefix('/schedule 1532 检查构建结果'), '检查构建结果');
assert.equal(stripCommandPrefix('/schedule +1h30m 检查构建结果'), '检查构建结果');
assert.equal(stripCommandPrefix('/schedule 明天9点 检查构建结果'), '检查构建结果');
assert.equal(stripCommandPrefix('/schedule 30分钟后 提醒构建结果'), '提醒构建结果');
assert.equal(stripCommandPrefix('/schedule 9点半 开会'), '开会');
assert.equal(stripCommandPrefix('/later '), '', '命令后无内容返回空串');
assert.equal(stripCommandPrefix('/later'), '', '无内容参数返回空串');
assert.equal(stripCommandPrefix('//not'), '//not', '双斜杠非命令，不剥');
assert.equal(stripCommandPrefix('/'), '/', '单斜杠非命令，不剥');
assert.equal(stripCommandPrefix('/123abc x'), '/123abc x', '数字开头非命令，不剥');
// 中文命令名后无内容：内容是「开会」（中文首 token 不是时间）
assert.equal(stripCommandPrefix('/later 开会'), '开会');
// 与 historySuggestion 联动：剥离后能命中历史里到点代发的「内容」段
assert.equal(
  historySuggestion(
    ['我重新部署了，你可以E2E测试了'],
    stripCommandPrefix('/later +3m 我重新部署了'),
    opts,
  ),
  '我重新部署了，你可以E2E测试了',
  '命令整行的内容部分应能命中历史候选',
);

// —— 转录双预算裁剪 trimTranscript ——
// 中文字符 UTF-8 每字 3 字节：仅按字符预算（12000）截断时实际字节可轻易
// 突破 maxInputBytes（4096）；字节裁剪应兜底，不抛错、不劈裂多字节字符。
{
  // 单条极长中文消息：字符预算内但字节超限 → 字节级截断到预算内（不劈裂字符）
  const longZh = '帮我'.repeat(3000); // 6000 字符 ≈ 18000 字节
  const t1 = trimTranscript([{ role: 'user', text: longZh }], [1], 12000, 4096);
  assert.equal(t1.pairs.length, 1, '单对场景至少保留最新一对');
  const framed1 = `[User Message]\n${t1.pairs[0].text}`;
  assert.ok(Buffer.byteLength(framed1, 'utf8') <= 4096 + 24, '截断后框架字节不超过预算（含少量分隔开销余量）');
  assert.ok(!t1.pairs[0].text.includes('�'), '不得产生半个多字节字符（替换符）');
  assert.ok(t1.pairs[0].text.endsWith('帮我') || t1.pairs[0].text === '', '截断应在完整码点边界');

  // 多对场景：老对先被丢弃，最新一对保留
  const older = '旧消息'.repeat(500);
  const newer = '新消息'.repeat(800);
  const t2 = trimTranscript(
    [{ role: 'user', text: older }, { role: 'assistant', text: '老回复'.repeat(500) }, { role: 'user', text: newer }],
    [10, 20, 30],
    12000,
    2048,
  );
  assert.ok(t2.pairs.length >= 1, '至少保留最新一对');
  assert.deepEqual(t2.sourceMessageSeqs.slice(-1), [30], '源 seq 与最新对同步保留');
  const framed2 = t2.pairs.map(p => `[${p.role === 'user' ? 'User Message' : 'Assistant Response'}]\n${p.text}`).join('\n\n');
  assert.ok(Buffer.byteLength(framed2, 'utf8') <= 2048 + 48, '多对裁剪后框架字节在预算内');
  assert.equal(t2.pairs[t2.pairs.length - 1].role, 'user', '最新一对（新消息）保留');

  // ASCII 内容：字符预算即字节近似，不受字节裁剪误伤（只做防御）
  const ascii = 'run the tests now and then commit'.repeat(20);
  const t3 = trimTranscript([{ role: 'user', text: ascii }], [1], 12000, 4096);
  assert.ok(Buffer.byteLength(`[User Message]\n${t3.pairs[0].text}`, 'utf8') <= 4096 + 24);

  // 空输入
  const t4 = trimTranscript([], [], 12000, 4096);
  assert.deepEqual(t4, { pairs: [], sourceMessageSeqs: [] });
}

// —— HotnessTable 堆淘汰回归：超上限时淘汰 lastSeq 最小的条目 ——
{
  const { HOT_TABLE_MAX_ENTRIES: CAP } = await import('../src/hotness.ts');
  const hot = new HotnessTable();
  // 灌入 CAP + 若干不同文本（各会话交替，避免同会话相邻去重吞掉插入）。
  for (let i = 0; i < CAP + 10; i++) {
    hot.consume({
      type: 'user/message',
      seq: i + 1,
      data: { content: [{ type: 'text', text: `消息${String(i).padStart(4, '0')}` }], source: { kind: 'user' } },
    }, `s${i}`);
  }
  assert.ok(hot.size <= CAP, '表大小不超过上限');
  // seq 最小（=1 最早插入）的「消息0000」应被淘汰出表。
  assert.ok(!hot.snapshot(0).some(e => e.text === '消息0000'), '最旧条目被淘汰');
  // lazy 更新：已被淘汰文本再次出现（seq 很大）→ 重新入表；不因陈旧堆项丢条目。
  hot.consume({
    type: 'user/message',
    seq: CAP + 500,
    data: { content: [{ type: 'text', text: '消息0000' }], source: { kind: 'user' } },
  }, 'other-session');
  assert.ok(hot.snapshot(0).some(e => e.text === '消息0000'), '重出现条目重新被跟踪');
  // 既有条目跨会话再次出现：count 累计、lastSeq 推进（lazy 新版本入堆不破坏淘汰）
  const fresh = hot.snapshot(0).find(e => e.text === '消息0001');
  const before = fresh?.count ?? 0;
  hot.consume({
    type: 'user/message',
    seq: CAP + 501,
    data: { content: [{ type: 'text', text: '消息0001' }], source: { kind: 'user' } },
  }, 'other-session-2');
  const after = hot.snapshot(0).find(e => e.text === '消息0001');
  assert.equal(after?.count, before + 1, '跨会话再次出现累计频次');
  // 继续灌到再次超限：不抛错、大小仍受控（堆内陈旧版本被惰性跳过）
  for (let i = 0; i < 5; i++) {
    hot.consume({
      type: 'user/message',
      seq: CAP + 600 + i,
      data: { content: [{ type: 'text', text: `压测文本${i}` }], source: { kind: 'user' } },
    }, `s-press-${i}`);
  }
  assert.ok(hot.size <= CAP, '连续触发淘汰后大小仍受控');
}

console.log('✅ 全部冒烟测试通过');
