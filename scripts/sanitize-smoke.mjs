// dsh-suggest-ghost 安全管线纯函数冒烟测试（node --experimental-strip-types 直接跑 TS 源）。
import assert from 'node:assert/strict';
import {
  cleanSuggestion,
  redactSecrets,
  sanitizeSuggestion,
  shouldFilterSuggestion,
  hasCJK,
  hasCyrillic,
} from '../src/sanitize.ts';
import { suggestionLanguage } from '../src/transcript.ts';

// —— 转录脱敏：发送前掩蔽常见凭据 ——
assert.ok(!redactSecrets('AKIA1234567890ABCDEF is a key').includes('AKIA'));
assert.equal(redactSecrets('token sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 end'), 'token [REDACTED:OPENAI_KEY] end');
assert.equal(redactSecrets('Bearer abcdefghijklmnopqrstuvwxyz0123456789'),
  '[REDACTED:BEARER]');
assert.ok(redactSecrets('ghp_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH').includes('REDACTED'));
assert.ok(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
  .includes('REDACTED:JWT'));
assert.equal(redactSecrets('plain text 无敏感信息'), 'plain text 无敏感信息');
// 私钥块整体替换（跨行）
{
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIB\nwuE=\n-----END PRIVATE KEY-----';
  assert.ok(redactSecrets(`prefix ${pem} suffix`).includes('[REDACTED:PRIVATE_KEY]'));
}

// —— 输出净化：剥离控制符/双向覆盖符、去引号围栏、单行化 ——
assert.equal(cleanSuggestion('\x1b[31m红色\x1b[0m 建议'), '红色 建议');
assert.equal(cleanSuggestion('a\u202eb\u202cc'), 'abc');
assert.equal(cleanSuggestion('```json\n{"a":1}\n```'), '{"a":1}');
assert.equal(cleanSuggestion('“继续运行”'), '继续运行');
// 换行作为控制符被移除 → 词间不留空（既有单行化语义）；空白折叠仍生效。
assert.equal(cleanSuggestion('  多   行\n文本  '), '多 行文本');

// —— 截断：词边界优先、语义截断位 ——
assert.equal(sanitizeSuggestion('short', 100).truncated, false);
{
  const { text, truncated } = sanitizeSuggestion('run the tests now and then commit', 14);
  assert.equal(truncated, true);
  assert.ok(text.length <= 14);
  assert.ok(!text.endsWith(' '));
}

// —— 语义过滤：质量低的回复应判为「无建议」 ——
assert.equal(shouldFilterSuggestion(''), true); // 空
assert.equal(shouldFilterSuggestion('a'), true); // 单字符
assert.equal(shouldFilterSuggestion('。'), true); // 纯标点
assert.equal(shouldFilterSuggestion('no suggestion for now'), true); // 套话
assert.equal(shouldFilterSuggestion('An error occurred during the build.'), true); // 错误复述
assert.equal(shouldFilterSuggestion('thanks for asking!'), true); // 感谢
assert.equal(shouldFilterSuggestion('Let me look into that for you'), true); // 助手口吻
assert.equal(shouldFilterSuggestion('What about the tests?'), true); // 提问
assert.equal(shouldFilterSuggestion('x'.repeat(300)), true); // 过长
// 有用建议应保留：2 字中文确认、短英文动作词
assert.equal(shouldFilterSuggestion('继续'), false); // 2 字中文（不在 THANKS_RE，原单字规则会误杀）
assert.equal(shouldFilterSuggestion('好的'), true); // THANKS_RE 明确过滤（作者反套话取舍），保持
assert.equal(shouldFilterSuggestion('run the tests'), false);
assert.equal(shouldFilterSuggestion('yes'), false);
assert.equal(shouldFilterSuggestion('commit this'), false);

// —— CJK 检测 ——
assert.equal(hasCJK('hello world'), false);
assert.equal(hasCJK('帮我处理一下'), true);
assert.equal(hasCJK('日本語テスト'), true);
assert.equal(hasCJK('한국어 테스트'), false); // 韩文 Hangul 不在覆盖范围（插件仅映射中/英语言）
assert.equal(hasCJK('hello 中文混排'), true);

// —— 西里尔检测（俄语等） ——
assert.equal(hasCyrillic('hello world'), false);
assert.equal(hasCyrillic('Создай файл'), true); // 俄语
assert.equal(hasCyrillic('Привет мир'), true); // 俄语
assert.equal(hasCyrillic('hello 中文'), false);

// —— 建议语言推断（多消息加权 + 去噪 + 回退链） ——
// 基础：单条中文 → 简体中文
assert.equal(suggestionLanguage([{ role: 'user', text: '帮我写个函数' }]), '简体中文');
// 基础：单条俄语 → Russian
assert.equal(suggestionLanguage([{ role: 'user', text: 'Создай файл hello.txt' }]), 'Russian');
// 基础：纯英文 → English（旧版返回模糊描述，新版返回具体语言）
assert.equal(suggestionLanguage([{ role: 'user', text: 'write a function' }]), 'English');
// 去噪：代码块里的中文不计入
assert.equal(suggestionLanguage([{ role: 'user', text: 'fix this:\n```ts\nconst 中文变量 = 1\n```' }]), 'English');
// 去噪：URL / 路径里的中文不计入
assert.equal(suggestionLanguage([{ role: 'user', text: 'check https://example.com/中文路径 and src/utils.ts' }]), 'English');
// 混合：自然语言里有足够中文 → 简体中文
assert.equal(suggestionLanguage([{ role: 'user', text: 'check src/utils.ts 这个文件的逻辑' }]), '简体中文');
// 多轮：最近消息主导（最后一条中文权重最高）
assert.equal(suggestionLanguage([
  { role: 'user', text: 'write a function' },
  { role: 'assistant', text: 'sure' },
  { role: 'user', text: '帮我改一下' },
]), '简体中文');
// 多轮：最近消息是俄语 → Russian
assert.equal(suggestionLanguage([
  { role: 'user', text: 'write a function' },
  { role: 'assistant', text: 'sure' },
  { role: 'user', text: 'Создай файл' },
]), 'Russian');
// 回退：用户消息全是代码 → 看 assistant 消息
assert.equal(suggestionLanguage([
  { role: 'user', text: '```ts\nconst x = 1\n```' },
  { role: 'assistant', text: '好的，我来帮你看看这个函数' },
]), '简体中文');
// 空 pairs → English
assert.equal(suggestionLanguage([]), 'English');
// 短消息 "ok" 不足以覆盖后续中文消息
assert.equal(suggestionLanguage([
  { role: 'user', text: 'ok' },
  { role: 'assistant', text: 'done' },
  { role: 'user', text: '再帮我检查一下测试' },
]), '简体中文');

// —— UI 语言先验加成 ——
// zh UI + 单条英文消息 → 中文（UI 先验 150 压制单条英文 ~45 分）
assert.equal(suggestionLanguage([
  { role: 'user', text: 'restart dsh web' },
], 'zh'), '简体中文');
// zh UI + 两条强英文消息 → 英文（用户证据 ~240 推翻 UI 先验 150）
assert.equal(suggestionLanguage([
  { role: 'user', text: 'write a function that sorts the array' },
  { role: 'assistant', text: 'sure' },
  { role: 'user', text: 'also add unit tests for edge cases' },
], 'zh'), 'English');
// en UI + 中文消息 → 中文（无 UI 加成，用户证据直接胜出）
assert.equal(suggestionLanguage([
  { role: 'user', text: '帮我写个函数' },
], 'en'), '简体中文');
// en UI + 英文消息 → 英文（无 CJK 证据）
assert.equal(suggestionLanguage([
  { role: 'user', text: 'write a function' },
], 'en'), 'English');
// zh UI + 无用户消息（只有 assistant）→ 中文（UI 先验独立生效）
assert.equal(suggestionLanguage([
  { role: 'assistant', text: 'Hello, how can I help?' },
], 'zh'), '简体中文');
// 无 UI locale + 短中文 → 中文（纯用户证据）
assert.equal(suggestionLanguage([
  { role: 'user', text: '继续' },
]), '简体中文');
// zh UI + 短中文 → 中文（双重加成）
assert.equal(suggestionLanguage([
  { role: 'user', text: '继续' },
], 'zh'), '简体中文');

// —— 20 条消息采集 ——
// 20 条中文消息（即使每条很短）→ 中文（累积证据）
{
  const pairs = [];
  for (let i = 0; i < 20; i++) {
    pairs.push({ role: 'user', text: '继续' });
    if (i < 19) pairs.push({ role: 'assistant', text: 'ok' });
  }
  assert.equal(suggestionLanguage(pairs), '简体中文');
}
// 第 21 条英文消息不被采集（只看最近 20 条用户消息）
{
  const pairs = [];
  // 20 条中文（旧→新）
  for (let i = 0; i < 20; i++) {
    pairs.push({ role: 'user', text: '继续' });
    pairs.push({ role: 'assistant', text: 'ok' });
  }
  // 第 21 条英文（不会被采集）
  pairs.push({ role: 'user', text: 'write a function that does something important' });
  assert.equal(suggestionLanguage(pairs), '简体中文');
}

// —— UI 语言权重可调 ——
// zh UI + 权重 0 + 英文消息 → 英文（权重 0 = 无 UI 先验）
assert.equal(suggestionLanguage([
  { role: 'user', text: 'restart dsh web' },
], 'zh', 0), 'English');
// zh UI + 权重 300 + 两条英文消息 → 中文（高权重压制）
assert.equal(suggestionLanguage([
  { role: 'user', text: 'write a function that sorts the array' },
  { role: 'assistant', text: 'sure' },
  { role: 'user', text: 'also add unit tests for edge cases' },
], 'zh', 300), '简体中文');
// zh UI + 权重 50 + 单条英文消息 → 英文（低权重不够压制）
assert.equal(suggestionLanguage([
  { role: 'user', text: 'restart dsh web' },
], 'zh', 50), 'English');

console.log('✅ sanitize 冒烟测试通过');
