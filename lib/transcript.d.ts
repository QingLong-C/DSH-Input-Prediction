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
/** 建议回复语言跟随会话（最后一条用户消息的文字系统）。 */
export declare function suggestionLanguage(pairs: readonly TranscriptPair[]): string;
/** 检测文本是否含中日韩字符（决定建议回复语言）。 */
export declare function hasCJK(text: string): boolean;
/** 检测文本是否含西里尔字母（俄语等）。 */
export declare function hasCyrillic(text: string): boolean;
