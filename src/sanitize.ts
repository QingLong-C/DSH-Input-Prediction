/**
 * 输出安全管线：转录脱敏、输出净化、语义过滤与截断。
 * 参考 @studyzy/dsh-suggest-prompt（MIT 许可）的安全设计，重写为精简实现。
 * @module dsh-suggest-ghost/sanitize
 */

/** 密钥形状脱敏：发送给建议模型前掩蔽常见凭据，避免泄漏到辅助请求与日志。 */
const SECRET_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'AWS_KEY', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'OPENAI_KEY', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: 'GITHUB_TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: 'SLACK_TOKEN', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'STRIPE_KEY', re: /\bsk_live_[0-9A-Za-z]{24,}\b/g },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'BEARER', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
];

/** 把文本中的密钥形状替换为占位标签。 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { label, re } of SECRET_PATTERNS) {
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  return out;
}

/** ANSI/OSC/CSI/DCS 转义序列与 C0/C1 控制符。 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const ESCAPE_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
/** Unicode 双向覆盖符。 */
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * 净化模型输出：剥离控制序列与覆盖符、去除引号与围栏、压缩为单行。
 * 注意顺序：**先剥围栏再删控制符**——若先删 `\n`（属于 C0 控制符），围栏标记
 * 与正文会连成无空白的一串，`\S*` 会一路吞到底（```json\n{...}\n``` 变空串）。
 * @returns 净化后的单行文本（不截断）。
 */
export function cleanSuggestion(text: string): string {
  // ① 趁换行还在先剥围栏：` ```lang` 头行与 ` ``` ` 尾行逐行识别。
  let out = text
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```[^\n]*$/, '')
    .replace(/^~~~[^\n]*\n?/, '')
    .replace(/\n?~~~[^\n]*$/, '');
  // ② 再删控制序列/控制符/双向覆盖符，压缩为单行。
  out = out
    .replace(ESCAPE_RE, '')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  // ③ 去掉外层引号（单/双/弯引号）。
  out = out.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '');
  return out.trim();
}

/** 建议可见字符上限截断；返回截断标记。 */
export function sanitizeSuggestion(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  // 优先在词边界截断，避免半截单词。
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const end = lastSpace > Math.floor(maxChars * 0.6) ? lastSpace : maxChars;
  return { text: cut.slice(0, end).trimEnd(), truncated: true };
}

/** 检测文本是否含中日韩字符（决定建议回复语言）。 */
export function hasCJK(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

/** 检测文本是否含西里尔字母（俄语等）。 */
export function hasCyrillic(text: string): boolean {
  return /[\u0400-\u04ff]/.test(text);
}

/** 语义过滤：这些回复被当作「无建议」丢弃。 */
const META_RE = /\b(?:no suggestion|nothing|stay silent|no response|n\/a)\b/i;
const ERROR_ECHO_RE = /\b(?:error|exception|failed)\b.*\b(?:occurred|thrown|raised)\b/i;
// `\b` 只认识 ASCII \w：中文词不会有词边界，若把 CJK 备选也包进 \b…\b 会永远
// 不命中（既有 bug：好的/可以/不错/谢谢 从未被过滤）。故拆分：
// 英文词用词边界，中文词不锚定（短文本内子串匹配足够）。
const THANKS_RE = /\b(?:thanks|thank you|looks good|looks great|great job|well done)\b|(?:不错|谢谢|好的|可以)/i;
const ASSISTANT_VOICE_RE = /\b(?:let me|i'?ll|i will|here'?s|i can|我来|我帮你|我来帮你|让我)\b/i;
const QUESTION_RE = /^[¿?？]|(?:[?？]\s*$)/;

/**
 * 判为「对话式回答」的形态阈值（续写专用，取值理由见 `shouldFilterCompletionFor`）。
 * 两个条件**同时**满足才算回答：输出够长（绝对量）且远超草稿（相对量）。
 */
const CONVERSATION_MIN_CHARS = 40;
const CONVERSATION_RATIO_TRIGGER = 3;

/** 判定净化后的输出是否应丢弃（返回 true = 无建议）。 */
export function shouldFilterSuggestion(text: string): boolean {
  if (text.length === 0) return true;
  if (text.length > 200) return true; // 多句/过长回复
  if (META_RE.test(text)) return true;
  if (ERROR_ECHO_RE.test(text)) return true;
  if (THANKS_RE.test(text)) return true;
  if (ASSISTANT_VOICE_RE.test(text)) return true;
  if (QUESTION_RE.test(text)) return true;
  // 孤立单词：单个字符或纯标点/符号无信息量；2 字起保留——
  // 中文里「继续」「好的」「开始」是常见且有用的确认式建议，不超过滤。
  const words = text.split(/\s+/);
  if (words.length === 1) {
    const word = words[0]!;
    if (word.length <= 1) return true;
    if (/^[\p{P}\p{S}]+$/u.test(word)) return true;
  }
  return false;
}

/** 续写场景的过滤：比建议场景更宽松，问句/感谢/助手口吻在续写语境下是合理续写。 */
export function shouldFilterCompletion(text: string): boolean {
  if (text.length === 0) return true;
  if (text.length > 200) return true; // 多句/过长回复
  if (META_RE.test(text)) return true;
  if (ERROR_ECHO_RE.test(text)) return true;
  // 续写场景不过滤 THANKS_RE / ASSISTANT_VOICE_RE / QUESTION_RE
  // 孤立单词：单个字符或纯标点/符号无信息量；2 字起保留
  const words = text.split(/\s+/);
  if (words.length === 1) {
    const word = words[0]!;
    if (word.length <= 1) return true;
    if (/^[\p{P}\p{S}]+$/u.test(word)) return true;
  }
  return false;
}

/**
 * "续写变成了回答"的形态兜底判据。
 *
 * ## 为什么需要它
 *
 * `shouldFilterCompletion` 只做语义过滤，且**故意**放行助手口吻与问句（见上一行的注释，
 * `scripts/inline-smoke.mjs` 有断言钉着这个决定）。于是当模型把「用户正在输入的草稿」
 * 当成「发给它的消息」去**回答**时，链路上没有任何拦截 —— 用户看到的就是幽灵位置冒出一段
 * 回复而不是下半句。
 *
 * ## 为什么用形态而不是语义正则
 *
 * 想靠 `ASSISTANT_VOICE_RE` / `QUESTION_RE` 拦，就会误杀中文正常续写：这两个正则里有
 * `我来|我帮你|让我` 和 `？`，而中文草稿的续写里"你""吗""？"极其常见 —— 拦掉它们等于把
 * 这个功能的常用场景一起砍掉。所以改用**与语言无关的形态特征**：真正的续写是"接着你的话
 * 往下写半句"，而回答是"成段、且相对草稿显著更长"。
 *
 * ## 阈值怎么来的（线上实测，非拍脑袋）
 *
 * 数据源：`/tmp/dsh-web-now.log` 单次会话的 42 次 `completion generated`，字段只有长度
 * （正文受隐私约束不落盘），分布：
 *
 * ```
 * 输出长度  min=2  中位=31.5  p90=67  max=135
 * 12/42 次 输出 > 草稿 3 倍；最极端 5 字草稿 → 94 字输出（18.8x）
 * ```
 *
 * - `>200` 的绝对上限已由 `shouldFilterCompletion` 承担，这里不重复。
 * - 取 **输出 > 草稿 × 5**（`CONVERSATION_RATIO_TRIGGER`）并叠加 **输出 ≥ 40 字**
 *   （`CONVERSATION_MIN_CHARS`）：两个条件同时满足才判为对话式回答。
 *   比值取 3 的经过（两次都靠冒烟/复核抓出来，不是拍的）：
 *   首版写 8x → 冒烟当场漏掉实测的 6→46（7.7x）；改 5x 后复核发现仍有 3.0~4.2x 那批
 *   （16→67、34→135、22→79、18→54）会被放过，而 9→54 恰好卡在等号上被 `>` 漏掉。
 *   取 3x 后拦下 8/42（5x 时 5/42），且正例全安全。
 *   不再往下压到 2.5x（能到 10/42）：2.5x 已经进入"短草稿正常续写"的常见区间，
 *   继续压会开始误杀；而下面的绝对量门限保证短输出不参与判定。
 *   - 既有正例（`What about the tests?` 21 字、`thanks for asking!` 18 字、
 *     `Let me look into that for you` 29 字）都**不到 40 字**，绝对安全；
 *   - 实测里 `174 字草稿 → 125 字输出`（0.7x）这类**长草稿正常续写**也不会被拦（0.7x，远小于 3）。
 *
 * 用**字符数**而非词数：中文没有空格，`text.split(/\s+/)` 对中文几乎无效（既有实现里那句
 * 孤立词判定对中文基本是空转），比值必须按字符算。
 *
 * @param text 净化后的续写输出
 * @param draft 生成这份续写时客户端提交的草稿
 * @returns true = 判为对话式回答，应当丢弃
 */
export function shouldFilterCompletionFor(text: string, draft: string): boolean {
  if (shouldFilterCompletion(text)) return true;
  if (text.length < CONVERSATION_MIN_CHARS) return false;
  const draftChars = draft.trim().length;
  // 空草稿不该走到这里（续写要求草稿非空），但真出现时一律按"可疑"处理：
  // 没有任何草稿还输出成段文本，只可能是回答。
  if (draftChars === 0) return true;
  return text.length > draftChars * CONVERSATION_RATIO_TRIGGER;
}

/** 剥离续写输出中对草稿的回显（避免重复用户已输入的内容）。 */
export function stripDraftEcho(completion: string, draft: string): string {
  if (completion.length === 0 || draft.length === 0) return completion;
  // 如果续写以草稿开头，剥离它
  const lowerCompletion = completion.toLowerCase();
  const lowerDraft = draft.toLowerCase();
  if (lowerCompletion.startsWith(lowerDraft)) {
    return completion.slice(draft.length).trim();
  }
  // 如果续写包含草稿（部分回显），尝试剥离
  const idx = lowerCompletion.indexOf(lowerDraft);
  if (idx >= 0 && idx < completion.length * 0.3) {
    return (completion.slice(0, idx) + completion.slice(idx + draft.length)).trim();
  }
  return completion;
}
