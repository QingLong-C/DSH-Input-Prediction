/**
 * 转录纯逻辑（零 DSH / DOM 依赖，可被 strip-types 冒烟直接 import）：
 * 消息对提取的辅助、字符/UTF-8 字节双预算裁剪、带标签框架化、语言推断。
 * 字节预算的动机：中文字符的 UTF-8 字节数（每字 3 字节）远超其字符数，
 * 仅按字符预算截断会让框架化后的实际字节数轻易突破 `maxInputBytes`——
 * 默认 12000 字符 vs 4096 字节即典型必触发组合；此处负责优雅裁剪，而非
 * 把超预算留给调用方硬抛错（超长中文回复不应让整轮建议静默失败）。
 * @module dsh-suggest-ghost/transcript
 */

/** 一条脱敏后的对话交换。 */
export interface TranscriptPair {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** 双预算裁剪后的转录对与同步裁剪的源消息 seq。 */
export interface TrimmedTranscript {
  readonly pairs: readonly TranscriptPair[];
  readonly sourceMessageSeqs: readonly number[];
}

/** 有界转录及其日志归因。 */
export interface Transcript {
  readonly pairs: readonly TranscriptPair[];
  readonly sourceMessageSeqs: readonly number[];
  readonly baseSeq: number;
}

/** 把字符串截断到不超过 `maxBytes` 个 UTF-8 字节；按码点遍历，不劈裂多字节字符。 */
export function truncateToUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const cb = Buffer.byteLength(ch, 'utf8');
    if (bytes + cb > maxBytes) break;
    out += ch;
    bytes += cb;
  }
  return out;
}

/** 组装带标签块供模型阅读。 */
export function frameTranscript(pairs: readonly TranscriptPair[]): string {
  const blocks: string[] = [];
  for (const pair of pairs) {
    blocks.push(pair.role === 'user' ? `[User Message]\n${pair.text}` : `[Assistant Response]\n${pair.text}`);
  }
  return blocks.join('\n\n');
}

/** Preserve user intent before older assistant prose; clip long text at both ends. */
export function trimTranscript(
  pairs: readonly TranscriptPair[],
  sourceMessageSeqs: readonly number[],
  maxTranscriptChars: number,
  maxInputBytes: number,
): TrimmedTranscript {
  const rows = pairs.map((pair, index) => ({ ...pair, seq: sourceMessageSeqs[index] ?? 0 }));
  const byteLimit = Math.max(1, maxInputBytes);
  const charLimit = Math.max(1, maxTranscriptChars);
  const fits = () => {
    const framed = frameTranscript(rows);
    return framed.length <= charLimit && Buffer.byteLength(framed, 'utf8') <= byteLimit;
  };
  // Keep the latest reply and user messages; discard older assistant detail first.
  while (!fits()) {
    const index = rows.findIndex((row, i) => i < rows.length - 1 && row.role === 'assistant');
    if (index < 0) break;
    rows.splice(index, 1);
  }
  if (!fits()) {
    // Summaries are secondary to actual user messages, and are marked with seq 0.
    const summary = rows.findIndex(row => row.seq === 0);
    if (summary >= 0 && rows.length > 1) rows.splice(summary, 1);
  }
  while (!fits() && rows.length > 0) {
    const framed = frameTranscript(rows);
    const excess = Math.max(Buffer.byteLength(framed, 'utf8') - byteLimit, framed.length - charLimit);
    let index = 0;
    for (let i = 1; i < rows.length; i++) {
      if (Buffer.byteLength(rows[i]!.text, 'utf8') > Buffer.byteLength(rows[index]!.text, 'utf8')) index = i;
    }
    const row = rows[index]!;
    const current = Buffer.byteLength(row.text, 'utf8');
    if (current === 0) { rows.shift(); continue; }
    const budget = Math.max(0, current - Math.max(excess, Math.ceil(current / 4)));
    const marker = '\n[…]\n';
    if (budget < 32) {
      row.text = truncateToUtf8(row.text, budget);
    } else {
      const left = Math.floor((budget - Buffer.byteLength(marker)) / 2);
      const head = truncateToUtf8(row.text, left);
      const tail = Array.from(truncateToUtf8(Array.from(row.text).reverse().join(''), budget - Buffer.byteLength(marker) - Buffer.byteLength(head))).reverse().join('');
      row.text = head + marker + tail;
    }
  }
  return { pairs: rows.map(({ role, text }) => ({ role, text })), sourceMessageSeqs: rows.map(row => row.seq) };
}

/**
 * 去噪：移除代码块、行内代码、URL、常见路径与文件名，保留自然语言文本。
 * 语言推断前调用，避免代码/路径里的 CJK 字符误导判断。
 */
function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')          // fenced 代码块
    .replace(/`[^`\n]+`/g, ' ')                // 行内代码
    .replace(/https?:\/\/\S+/g, ' ')           // URL
    .replace(/\b[a-zA-Z]:[\\/][\w.\\/-]+/g, ' ') // Windows 绝对路径
    .replace(/\b(?:src|lib|test|tests|docs|node_modules|dist|build)[\\/][\w./-]+/g, ' ') // 常见项目路径
    .replace(/\b\w+\.\w{2,4}\b/g, ' ')         // 文件名（含扩展名）
    .replace(/\s+/g, ' ')
    .trim();
}

/** 统计文本中各文字系统的字符数（按码点遍历，代理对安全）。 */
function countScripts(text: string): { cjk: number; cyrillic: number; latin: number } {
  let cjk = 0;
  let cyrillic = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x3040 && code <= 0x30ff) ||   // 假名
        (code >= 0x3400 && code <= 0x4dbf) ||   // CJK 扩展 A
        (code >= 0x4e00 && code <= 0x9fff) ||   // CJK 基本
        (code >= 0xf900 && code <= 0xfaff)) {   // CJK 兼容
      cjk += 1;
    } else if (code >= 0x0400 && code <= 0x04ff) { // 西里尔
      cyrillic += 1;
    } else if ((code >= 0x0041 && code <= 0x005a) ||
               (code >= 0x0061 && code <= 0x007a)) { // 拉丁字母
      latin += 1;
    }
  }
  return { cjk, cyrillic, latin };
}

/**
 * 建议回复语言：结合 UI 界面语言与最近用户消息的文字系统分布加权推断。
 *
 * 设计要点：
 * 1. UI 语言作为先验加成（权重可配置，默认约等于 2-3 条中等长度消息）——界面语言是用户
 *    显式选择的交互语言，弱证据下优先遵循；
 * 2. 用户消息按「比例 × 长度 × 时间」加权，强证据可推翻 UI 先验；
 * 3. 取最近 20 条用户消息，去噪后再统计，避免代码/路径里的 CJK 字符误导；
 * 4. 用户消息全为代码时回退到最近一条 assistant 消息的语言。
 *
 * @param pairs - 转录对
 * @param uiLocale - client 捎带的 UI 语言（'zh' | 'en' | 'ru' 等）
 * @param uiLocaleWeight - UI 语言先验权重（默认 100；越大越倾向 UI 语言）
 * @param lastLanguage - 上次建议的语言（语言惯性：短消息无足够信号时回退）
 */
export function suggestionLanguage(
  pairs: readonly TranscriptPair[],
  uiLocale?: string,
  uiLocaleWeight: number = 100,
  lastLanguage?: string,
): string {
  // 收集最近 20 条用户消息
  const MAX_MESSAGES = 20;
  const recentUser: string[] = [];
  for (const pair of [...pairs].reverse()) {
    if (pair.role === 'user') {
      recentUser.push(pair.text);
      if (recentUser.length >= MAX_MESSAGES) break;
    }
  }

  // 无用户消息 → 回退到最近一条 assistant 消息
  if (recentUser.length === 0) {
    for (const pair of [...pairs].reverse()) {
      if (pair.role === 'assistant') {
        recentUser.push(pair.text);
        break;
      }
    }
  }

  if (recentUser.length === 0) return 'English';

  // 去噪后若所有用户消息都为空（全是代码/路径），回退到最近一条 assistant 消息
  const cleanedUser = recentUser.map(stripNoise).filter(s => s.length > 0);
  if (cleanedUser.length === 0) {
    recentUser.length = 0;
    for (const pair of [...pairs].reverse()) {
      if (pair.role === 'assistant') {
        recentUser.push(pair.text);
        break;
      }
    }
    if (recentUser.length === 0) return 'English';
  }

  // 加权累计各文字系统得分（比例 × 长度 × 时间）
  let cjkScore = 0;
  let cyrillicScore = 0;
  let latinScore = 0;

  const sources = recentUser.length > 0 && cleanedUser.length === 0
    ? recentUser  // 回退到 assistant，用原始文本
    : cleanedUser; // 正常情况用去噪后的文本

  const N = sources.length;
  // 归一化时间权重：总和恒为 6（与 3 条消息时的 (3,2,1) 一致），
  // 保证 UI 先验校准不随消息数量漂移。
  const totalRawWeight = N * (N + 1) / 2;
  const weightScale = 6 / totalRawWeight;

  for (let i = 0; i < N; i++) {
    const text = sources[i]!;
    // 时间权重：归一化后 newest ≈ 3×weightScale, oldest ≈ 1×weightScale
    const recencyWeight = (N - i) * weightScale;
    const { cjk, cyrillic, latin } = countScripts(text);
    const letters = cjk + cyrillic + latin;
    if (letters === 0) continue;
    // 长度权重：封顶 60 字母，避免单条主导
    const size = Math.min(letters, 60);
    // 比例权重：该文字系统占总字母数的比例
    const cjkRatio = cjk / letters;
    const cyrillicRatio = cyrillic / letters;
    const latinRatio = latin / letters;
    cjkScore += cjkRatio * size * recencyWeight;
    cyrillicScore += cyrillicRatio * size * recencyWeight;
    latinScore += latinRatio * size * recencyWeight;
  }

  // UI 语言先验加成：界面语言是用户显式选择的交互语言，
  // 权重可配置（默认 100 ≈ 2-3 条中等长度消息的置信度）；
  // 用户消息证据更强时可推翻。仅对非英语 UI 加成（英语是默认回退）。
  const hasUiPrior = uiLocale === 'zh' || uiLocale === 'ru';
  if (uiLocale === 'zh') {
    cjkScore += uiLocaleWeight;
  } else if (uiLocale === 'ru') {
    cyrillicScore += uiLocaleWeight;
  }

  // 语言判定：
  // - 无 UI 先验时：CJK/西里尔证据足够 → 对应语言；否则 → English
  // - 有 UI 先验时：CJK/西里尔证据领先拉丁 → 对应语言；
  //   拉丁证据超过 UI 先验 → English（用户持续使用英语推翻 UI）；
  //   否则 → UI 语言（先验压制短英文消息）
  if (cjkScore >= 6 && cjkScore >= cyrillicScore) {
    // CJK 证据足够；有 UI 先验时需同时领先拉丁（否则用户持续英文推翻）
    if (!hasUiPrior || cjkScore >= latinScore) return '简体中文';
  }
  if (cyrillicScore >= 6 && cyrillicScore > cjkScore) {
    if (!hasUiPrior || cyrillicScore >= latinScore) return 'Russian';
  }

  // 语言惯性：最近消息太短/无足够信号时，回退到上次建议的语言
  // （避免俄语用户 + en UI + 短消息 "ok"/"1" 被误判为 English）
  if (lastLanguage && lastLanguage !== 'English' && cjkScore < 6 && cyrillicScore < 6) {
    return lastLanguage;
  }

  return 'English';
}

/** 检测文本是否含中日韩字符（决定建议回复语言）。@deprecated 保留给外部调用者，内部已改用 countScripts。 */
export function hasCJK(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

/** 检测文本是否含西里尔字母（俄语等）。@deprecated 保留给外部调用者，内部已改用 countScripts。 */
export function hasCyrillic(text: string): boolean {
  return /[\u0400-\u04ff]/.test(text);
}

/**
 * 从旧转录对中提取摘要（零 LLM 成本的启发式方法）。
 *
 * 策略：
 * 1. 只取用户消息（assistant 回复通常是格式化输出，信息密度低）；
 * 2. 每条消息取第一句（句号/问号/感叹号/换行截断）；
 * 3. 按字符预算从旧到新拼接，超限则截断最后一条；
 * 4. 返回带前缀的摘要文本，供模型阅读。
 *
 * @param pairs - 将被裁剪掉的旧转录对
 * @param maxChars - 摘要最大字符数
 * @returns 摘要文本（空串表示无可提取内容）
 */
export function extractContextSummary(
  pairs: readonly TranscriptPair[],
  maxChars: number,
): string {
  if (pairs.length === 0 || maxChars < 50) return '';
  const PREFIX = '[Earlier context summary] ';
  const budget = maxChars - PREFIX.length;
  if (budget < 50) return '';

  // 只取用户消息，每条取第一句
  const sentences: string[] = [];
  for (const pair of pairs) {
    if (pair.role !== 'user') continue;
    // 取第一句：按句号/问号/感叹号/换行截断
    const firstSentence = pair.text.split(/[.。?？!！\n]/)[0]?.trim() ?? '';
    if (firstSentence.length > 0 && firstSentence.length < 200) {
      sentences.push(firstSentence);
    }
  }
  if (sentences.length === 0) return '';

  // 按字符预算拼接
  let summary = '';
  for (const sentence of sentences) {
    const candidate = summary.length === 0 ? sentence : `${summary}; ${sentence}`;
    if (candidate.length > budget) {
      // 超限：截断最后一条（预留 3 字符给 "..."）
      const remaining = budget - summary.length - 2 - 3; // -2 for "; ", -3 for "..."
      if (remaining > 20) {
        summary = `${summary}; ${sentence.slice(0, remaining)}...`;
      }
      break;
    }
    summary = candidate;
  }
  if (summary.length === 0) return '';
  return PREFIX + summary;
}
