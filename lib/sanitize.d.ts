/**
 * 输出安全管线：转录脱敏、输出净化、语义过滤与截断。
 * 参考 @studyzy/dsh-suggest-prompt（MIT 许可）的安全设计，重写为精简实现。
 * @module dsh-suggest-ghost/sanitize
 */
/** 把文本中的密钥形状替换为占位标签。 */
export declare function redactSecrets(text: string): string;
/**
 * 净化模型输出：剥离控制序列与覆盖符、去除引号与围栏、压缩为单行。
 * 注意顺序：**先剥围栏再删控制符**——若先删 `\n`（属于 C0 控制符），围栏标记
 * 与正文会连成无空白的一串，`\S*` 会一路吞到底（```json\n{...}\n``` 变空串）。
 * @returns 净化后的单行文本（不截断）。
 */
export declare function cleanSuggestion(text: string): string;
/** 建议可见字符上限截断；返回截断标记。 */
export declare function sanitizeSuggestion(text: string, maxChars: number): {
    readonly text: string;
    readonly truncated: boolean;
};
/** 检测文本是否含中日韩字符（决定建议回复语言）。 */
export declare function hasCJK(text: string): boolean;
/** 检测文本是否含西里尔字母（俄语等）。 */
export declare function hasCyrillic(text: string): boolean;
/** 判定净化后的输出是否应丢弃（返回 true = 无建议）。 */
export declare function shouldFilterSuggestion(text: string): boolean;
/** 续写场景的过滤（与 shouldFilterSuggestion 相同逻辑）。 */
export declare const shouldFilterCompletion: typeof shouldFilterSuggestion;
/** 剥离续写输出中对草稿的回显（避免重复用户已输入的内容）。 */
export declare function stripDraftEcho(completion: string, draft: string): string;
