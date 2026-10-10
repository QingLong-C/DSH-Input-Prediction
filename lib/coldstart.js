/**
 * 冷启动语义（纯函数，无 host 服务依赖）：把「重启后怎么恢复」从插件装配里
 * 拆出来单独表达，便于单测。
 *
 * 这一层的存在理由：重启后「没有数据」并不是真的没数据——建议在 settings.yaml、
 * 历史在会话日志，两者都是持久的。所谓冷启动问题，本质是**判据选错了**：
 * 旧实现用「时间」（重启即作废、事件到达才播种）当判据，于是产生两个空窗；
 * 这里统一改成**语义**判据：
 *  - 历史环是会话日志的缓存 → 任何时候都能从日志现算，没有「播种时机」；
 *  - 建议是否可用，取决于它对应的回合是否仍是该会话最后一个已完成回合。
 * @module dsh-suggest-ghost/coldstart
 */
/**
 * 读取会话完整事件日志（跨代兼容）。
 * DSH 0.1.2 起 `Session.events` getter 被移除：公开面改为 `snapshotEvents()`
 * （无参调用返回全量冻结数组，语义与旧 `events` 一致）；≤0.1.1 内核只有
 * `events` getter、没有 `snapshotEvents`。两边的属性在对方那一代都不存在，
 * 类型上互不可见，这里按运行时能力探测读取。两者都缺失（不该出现的代际
 * 组合）时回退空数组——日志读取路径绝不能再因此崩掉。
 *
 * 放在本模块（而非 generate.ts）：本模块是纯语义层，不得依赖任何运行时模块，
 * 否则单测无法用 --experimental-strip-types 直接导入它。
 */
export function sessionEvents(session) {
    const reader = session;
    if (typeof reader.snapshotEvents === 'function')
        return reader.snapshotEvents();
    return reader.events ?? [];
}
/** `_push` 携带的历史文本条数上限（控制 settings 写盘体积；client 端再按
 * historyMaxEntries 做打分窗口截尾，取两者较小窗口）。 */
export const HISTORY_PUSH_CAP = 300;
/** 单条历史文本上限（与 client extractHistory 的 HISTORY_TEXT_MAX_CHARS 一致）。 */
export const HISTORY_TEXT_MAX_CHARS = 2000;
/** 环容量 = 推送窗口的两倍（硬上限防泄漏）。 */
export const RING_CAPACITY = HISTORY_PUSH_CAP * 2;
/** 每会话建议表的容量（同时活跃的会话数上限；超出逐出最久未更新者）。
 * 只存内存、不落盘（建议本就是可重建的 LLM 输出），故取小值即可。 */
export const SUGGESTION_CACHE_CAP = 16;
/**
 * 从一条会话事件提取可补全的用户输入文本（null = 跳过）。筛选语义与 client
 * `extractHistory` 对齐：只收 `source.kind === 'user'` 的 user/message 文本块，
 * 跳过空白、系统提醒包装块与超长文本。
 */
export function userTextOfEvent(event) {
    if (event.type !== 'user/message')
        return null;
    const data = event.data;
    const srcKind = data.source?.kind;
    if (typeof srcKind === 'string' && srcKind !== 'user')
        return null;
    let text = '';
    if (Array.isArray(data.content)) {
        for (const block of data.content) {
            const record = block;
            if (record.type === 'text' && typeof record.text === 'string')
                text += record.text;
        }
    }
    text = text.trim();
    if (text === '' || text.startsWith('<system-reminder>') || text.length > HISTORY_TEXT_MAX_CHARS)
        return null;
    return text;
}
/**
 * 从会话日志抽取历史环种子（时间序的可补全用户文本，相邻重复只计一次）。
 * 日志持久化，插件 apply 时必然已在内存——这是「按需物化」的数据基础：
 * 环只是缓存，命中与否都不影响正确性。
 */
export function seedRingFromLog(session) {
    const seed = [];
    for (const past of sessionEvents(session)) {
        const text = userTextOfEvent(past);
        if (text === null)
            continue;
        if (seed[seed.length - 1] === text)
            continue; // 相邻重复只计一次
        seed.push(text);
    }
    return seed;
}
/**
 * 会话日志里最后一个已完成回合号（0 = 无）。建议语义校验的判据：只有当建议
 * 的 turn 等于它时，那条建议才仍然是「针对当前状态的下一条预测」。
 */
export function lastCompletedTurnInLog(session) {
    let last = 0;
    for (const event of sessionEvents(session)) {
        if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
            last = Math.max(last, event.data.turn);
        }
    }
    return last;
}
/**
 * 从 settings 盘上残留的 `_push` 回读建议状态（重启复用）。字段逐个做结构校验，
 * 任一可疑即按「无建议」处理——盘上内容是上一次进程写的，可能被手改或来自旧版本。
 *
 * 这里只做**结构**校验；「是否仍有效」是语义问题，需要会话日志，由调用方用
 * {@link lastCompletedTurnInLog} 判定（会话尚未进店时不得据此清盘，见 index.ts）。
 * @param raw - `_push` 字段的 JSON 字符串（'null' = 无）。
 * @returns 结构合法的建议与其会话 id；无建议时 suggestion 为 null。
 */
export function parsePersistedPush(raw) {
    const noSuggestion = (sessionId) => ({ suggestion: null, sessionId });
    if (typeof raw !== 'string' || raw === '' || raw === 'null')
        return noSuggestion(null);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return noSuggestion(null);
    }
    if (typeof parsed !== 'object' || parsed === null)
        return noSuggestion(null);
    const record = parsed;
    const sessionId = typeof record.suggestionSessionId === 'string' && record.suggestionSessionId !== ''
        ? record.suggestionSessionId
        : null;
    const rawSuggestion = record.suggestion;
    if (sessionId === null || typeof rawSuggestion !== 'object' || rawSuggestion === null) {
        return noSuggestion(sessionId);
    }
    const s = rawSuggestion;
    const nonNegativeInt = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
    if (!nonNegativeInt(s.turn) || !nonNegativeInt(s.baseSeq))
        return noSuggestion(sessionId);
    if (typeof s.text !== 'string' || s.text === '')
        return noSuggestion(sessionId);
    if (typeof s.truncated !== 'boolean')
        return noSuggestion(sessionId);
    if (typeof s.acceptKey !== 'string' || s.acceptKey === '')
        return noSuggestion(sessionId);
    return {
        suggestion: {
            version: 1,
            turn: s.turn,
            baseSeq: s.baseSeq,
            text: s.text,
            truncated: s.truncated,
            acceptKey: s.acceptKey,
        },
        sessionId,
    };
}
/**
 * 就地追加一条历史文本（幂等：相邻重复不重复入环；超出容量从头截断）。
 * 会前先由调用方物化环——环绝不能凭空从单条文本起建，否则丢掉此前的轮次。
 * @returns 是否实际追加（false = 相邻重复，无变化）。
 */
export function appendToRing(ring, text) {
    if (ring[ring.length - 1] === text)
        return false;
    ring.push(text);
    if (ring.length > RING_CAPACITY)
        ring.splice(0, ring.length - RING_CAPACITY);
    return true;
}
/**
 * 建议是否仍对该会话有效：会话存在，且建议回合仍是其最后一个已完成回合。
 * 判定所需的一切都能从日志现算，因此不依赖任何「重启时机」或事件先后。
 */
export function suggestionIsCurrent(suggestion, session) {
    if (suggestion === null || session === undefined)
        return false;
    return suggestion.turn === lastCompletedTurnInLog(session);
}
/**
 * 计算建议产出/作废后的新追踪状态。
 *
 * 规则只有两条，但都是踩过的坑：
 *  - 产出新建议（非 null）→ 直接取代（last-wins，跨会话也取代：它才是「最新」）；
 *  - 作废（null）→ **仅当**被作废的正是该会话自己的建议时才清空——另一会话的
 *    生成失败不该抹掉本会话仍在有效期的那条，否则切回来就没有建议了。
 * @param current - 当前追踪状态。
 * @param sessionId - 本次产出/作废所属的会话。
 * @param suggestion - 新建议；null = 作废该会话的建议。
 */
export function nextTrackedSuggestion(current, sessionId, suggestion) {
    if (suggestion !== null)
        return { suggestion, sessionId };
    if (current.sessionId === sessionId)
        return { suggestion: null, sessionId: null };
    return current;
}
/**
 * 组装推给 client 的建议字段：本会话的建议按语义校验结果取用；不属于本会话、
 * 但仍被追踪的那条原样带上（client 端按 sessionId 守卫隐藏，切回时立即可用）。
 * 这正是「pull 一次别的会话不能把仍在有效期的建议弄丢」的落点。
 * @param tracked - 追踪状态。
 * @param sessionId - 目标会话；null = 无特定会话。
 * @param currentForSession - 该会话经语义校验后的有效建议（无则 null）。
 */
export function suggestionFieldsFor(tracked, sessionId, currentForSession) {
    if (currentForSession !== null)
        return { suggestion: currentForSession, sessionId };
    const elsewhere = tracked.sessionId !== null && tracked.sessionId !== sessionId
        ? tracked.suggestion
        : null;
    return elsewhere === null
        ? { suggestion: null, sessionId: null }
        : { suggestion: elsewhere, sessionId: tracked.sessionId };
}
