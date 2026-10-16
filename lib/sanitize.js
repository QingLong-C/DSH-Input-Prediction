/**
 * 输出安全管线：转录脱敏、输出净化、语义过滤与截断。
 * 参考 @studyzy/dsh-suggest-prompt（MIT 许可）的安全设计，重写为精简实现。
 * @module dsh-suggest-ghost/sanitize
 */
/** 密钥形状脱敏：发送给建议模型前掩蔽常见凭据，避免泄漏到辅助请求与日志。 */
const SECRET_PATTERNS = [
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
export function redactSecrets(text) {
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
export function cleanSuggestion(text) {
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
export function sanitizeSuggestion(text, maxChars) {
    if (text.length <= maxChars)
        return { text, truncated: false };
    // 优先在词边界截断，避免半截单词。
    const cut = text.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    const end = lastSpace > Math.floor(maxChars * 0.6) ? lastSpace : maxChars;
    return { text: cut.slice(0, end).trimEnd(), truncated: true };
}
/** 检测文本是否含中日韩字符（决定建议回复语言）。 */
export function hasCJK(text) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}
/** 检测文本是否含西里尔字母（俄语等）。 */
export function hasCyrillic(text) {
    return /[\u0400-\u04ff]/.test(text);
}
/** 语义过滤：这些回复被当作「无建议」丢弃。 */
const META_RE = /\b(?:no suggestion|nothing|stay silent|no response|n\/a)\b/i;
const ERROR_ECHO_RE = /\b(?:error|exception|failed)\b.*\b(?:occurred|thrown|raised)\b/i;
// 只过滤整条评价/致谢；「好的」「可以」是用户的有效确认，
// 「可以解释…吗」等追问也不能被子串规则误杀。
const THANKS_RE = /\b(?:thanks|thank you|looks good|looks great|great job|well done)\b|^(?:不错|谢谢)[!！。.\s]*$/i;
const ASSISTANT_VOICE_RE = /\b(?:let me|i'?ll|i will|here'?s|i can)\b|^(?:我来|我帮你|我来帮你|让我)/i;
/** 判定净化后的输出是否应丢弃（返回 true = 无建议）。 */
export function shouldFilterSuggestion(text) {
    if (text.length === 0)
        return true;
    if (text.length > 200)
        return true; // 多句/过长回复
    if (META_RE.test(text))
        return true;
    if (ERROR_ECHO_RE.test(text))
        return true;
    if (THANKS_RE.test(text))
        return true;
    if (ASSISTANT_VOICE_RE.test(text))
        return true;
    // 孤立单词：单个字符或纯标点/符号无信息量；2 字起保留——
    // 中文里「继续」「好的」「开始」是常见且有用的确认式建议，不超过滤。
    const words = text.split(/\s+/);
    if (words.length === 1) {
        const word = words[0];
        if (word.length <= 1)
            return true;
        if (/^[\p{P}\p{S}]+$/u.test(word))
            return true;
    }
    return false;
}
/** 续写场景的过滤：比建议场景更宽松，问句/感谢/助手口吻在续写语境下是合理续写。 */
export function shouldFilterCompletion(text) {
    if (text.length === 0)
        return true;
    if (text.length > 200)
        return true; // 多句/过长回复
    if (META_RE.test(text))
        return true;
    if (ERROR_ECHO_RE.test(text))
        return true;
    // 续写场景不过滤 THANKS_RE / ASSISTANT_VOICE_RE
    // 孤立单词：单个字符或纯标点/符号无信息量；2 字起保留
    const words = text.split(/\s+/);
    if (words.length === 1) {
        const word = words[0];
        if (word.length <= 1)
            return true;
        if (/^[\p{P}\p{S}]+$/u.test(word))
            return true;
    }
    return false;
}
/** 剥离续写输出中对草稿的回显（避免重复用户已输入的内容）。 */
export function stripDraftEcho(completion, draft) {
    if (completion.length === 0 || draft.length === 0)
        return completion;
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
