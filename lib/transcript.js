/**
 * 转录纯逻辑（零 DSH / DOM 依赖，可被 strip-types 冒烟直接 import）：
 * 消息对提取的辅助、字符/UTF-8 字节双预算裁剪、带标签框架化、语言推断。
 * 字节预算的动机：中文字符的 UTF-8 字节数（每字 3 字节）远超其字符数，
 * 仅按字符预算截断会让框架化后的实际字节数轻易突破 `maxInputBytes`——
 * 默认 12000 字符 vs 4096 字节即典型必触发组合；此处负责优雅裁剪，而非
 * 把超预算留给调用方硬抛错（超长中文回复不应让整轮建议静默失败）。
 * @module dsh-suggest-ghost/transcript
 */
/** 预算内保留最新若干对；至少保留最新一对。 */
function keepTail(pairs, budget) {
    let remaining = budget;
    let kept = 0;
    for (const pair of [...pairs].reverse()) {
        const cost = pair.role.length + pair.text.length + 2;
        if (cost > remaining && kept > 0)
            break;
        kept += 1;
        remaining -= cost;
    }
    return Math.max(1, kept);
}
/** 把字符串截断到不超过 `maxBytes` 个 UTF-8 字节；按码点遍历，不劈裂多字节字符。 */
export function truncateToUtf8(text, maxBytes) {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes)
        return text;
    let out = '';
    let bytes = 0;
    for (const ch of text) {
        const cb = Buffer.byteLength(ch, 'utf8');
        if (bytes + cb > maxBytes)
            break;
        out += ch;
        bytes += cb;
    }
    return out;
}
/** 组装带标签块供模型阅读。 */
export function frameTranscript(pairs) {
    const blocks = [];
    for (const pair of pairs) {
        blocks.push(pair.role === 'user' ? `[User Message]\n${pair.text}` : `[Assistant Response]\n${pair.text}`);
    }
    return blocks.join('\n\n');
}
/**
 * 转录双预算裁剪（纯函数，可单测）：
 * ① 字符预算（`maxTranscriptChars`）：从最新往回保留，至少最新一对；
 * ② UTF-8 字节预算（`maxInputBytes`）：从最老一对开始丢弃（至少保留最新一对），
 *    单对本身超限时对文本做字节级截断（不劈裂多字节字符）。
 * 源消息 seq 与 pairs 同步裁剪。
 */
export function trimTranscript(pairs, sourceMessageSeqs, maxTranscriptChars, maxInputBytes) {
    if (pairs.length === 0)
        return { pairs: [], sourceMessageSeqs: [] };
    // ① 字符预算截尾（原语义）。
    const keptCount = keepTail(pairs, Math.max(1, maxTranscriptChars));
    const charKept = pairs.slice(pairs.length - keptCount);
    const charSeqs = sourceMessageSeqs.slice(sourceMessageSeqs.length - keptCount);
    // ② 字节预算截尾：防中文长内容突破 maxInputBytes 后整轮失败。
    const sizeOf = (ps) => Buffer.byteLength(frameTranscript(ps), 'utf8');
    let kept = charKept.length;
    while (kept > 1 && sizeOf(charKept.slice(charKept.length - kept)) > Math.max(1, maxInputBytes)) {
        kept -= 1;
    }
    const clipped = charKept.slice(charKept.length - kept);
    const seqs = charSeqs.slice(charSeqs.length - kept);
    if (sizeOf(clipped) <= Math.max(1, maxInputBytes)) {
        return { pairs: clipped, sourceMessageSeqs: seqs };
    }
    // 仅剩的最新一对都超限 → 对最新文本按字节截断（预算先扣掉其余对的字节开销，
    // 再扣角色名与分隔标签的近似开销）。
    const last = clipped[clipped.length - 1];
    const rest = clipped.slice(0, -1);
    const restBytes = sizeOf(rest);
    const textBudget = Math.max(1, maxInputBytes - restBytes - Buffer.byteLength(last.role, 'utf8') - 16);
    return {
        pairs: [...rest, { role: last.role, text: truncateToUtf8(last.text, textBudget) }],
        sourceMessageSeqs: seqs,
    };
}
/** 建议回复语言跟随会话（最后一条用户消息的文字系统）。 */
export function suggestionLanguage(pairs) {
    for (const pair of [...pairs].reverse()) {
        if (pair.role !== 'user')
            continue;
        if (hasCJK(pair.text))
            return '简体中文';
        if (hasCyrillic(pair.text))
            return 'Russian';
        return 'the same language the user wrote their last message in';
    }
    return 'English';
}
/** 检测文本是否含中日韩字符（决定建议回复语言）。 */
export function hasCJK(text) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}
/** 检测文本是否含西里尔字母（俄语等）。 */
export function hasCyrillic(text) {
    return /[\u0400-\u04ff]/.test(text);
}
