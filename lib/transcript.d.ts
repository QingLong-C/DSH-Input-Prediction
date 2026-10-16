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
export declare function truncateToUtf8(text: string, maxBytes: number): string;
/** 组装带标签块供模型阅读。 */
export declare function frameTranscript(pairs: readonly TranscriptPair[]): string;
/**
 * 转录双预算裁剪（纯函数，可单测）：
 * ① 字符预算（`maxTranscriptChars`）：从最新往回保留，至少最新一对；
 * ② UTF-8 字节预算（`maxInputBytes`）：从最老一对开始丢弃（至少保留最新一对），
 *    单对本身超限时对文本做字节级截断（不劈裂多字节字符）。
 * 源消息 seq 与 pairs 同步裁剪。
 */
export declare function trimTranscript(pairs: readonly TranscriptPair[], sourceMessageSeqs: readonly number[], maxTranscriptChars: number, maxInputBytes: number): TrimmedTranscript;
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
export declare function suggestionLanguage(pairs: readonly TranscriptPair[], uiLocale?: string, uiLocaleWeight?: number, lastLanguage?: string): string;
/** 检测文本是否含中日韩字符（决定建议回复语言）。@deprecated 保留给外部调用者，内部已改用 countScripts。 */
export declare function hasCJK(text: string): boolean;
/** 检测文本是否含西里尔字母（俄语等）。@deprecated 保留给外部调用者，内部已改用 countScripts。 */
export declare function hasCyrillic(text: string): boolean;
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
export declare function extractContextSummary(pairs: readonly TranscriptPair[], maxChars: number): string;
