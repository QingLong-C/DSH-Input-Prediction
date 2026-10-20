/**
 * 停顿续写（ghost inline completion）的**出口判定**与**有界超时**。
 * 零 cordis / 零宿主依赖：给定输入就返回判定，所以在 node 里可以直接断言。
 * `src/index.ts` 只做接线（读配置、拿会话、调 `generateCompletion`、落留痕）。
 *
 * ## 为什么存在（线上故障，别删这个文件里的任何一条留痕）
 * live 实测：用户停顿超过 5s，幽灵不出现，宿主日志里 `ops consumed: complete`
 * 之后**一个字都没有**。30 次消费只产出 5 次续写，另外 25 次静默消失。
 * 消失的原因是 `handleComplete` 的五个分支直接 `return`：
 *
 *  1. `inlineEnabled === false`          —— 开关被关（或被实时视图覆盖层关掉）
 *  2. `draft.trim().length < minChars`   —— 草稿短于阈值
 *  3. `ctx.sessions.get(id) === undefined` —— client 报的会话 host 不认
 *  4. then/catch 里 `pending.get(id) !== controller` —— 被更新的草稿抢先
 *  5. catch 里 `if (!controller.signal.aborted)` 才留痕 —— 被 abort 的那次永久静默
 *
 * 这五条合起来让「**根本没生成** / **被抢先** / **挂住了**」三种情况在观测上完全同形，
 * 于是任何一次「幽灵不出」都查不动。本模块把出口判定收拢成一张表：**每条出口都必须
 * 带 kind + reason**，并且类型里没有「静默 return」这个取值——想新增一条静默出口必须
 * 先改这里的联合类型，而 `scripts/completion-pipeline-smoke.mjs` 的穷尽断言会立刻红。
 *
 * ## 隐私约束
 * 出口报文只许出现**字符数**，绝不允许出现草稿正文：续写的输入是用户还没按下去的
 * 字，日志走 `console.log → stdout → tee ~/.dsh/dsh-web.log`，抄正文等于把用户输入
 * 的第二份副本落到盘上。报文在这里拼装（`completionFaultMessage`），入参类型里根本没有
 * `draft` 这个键——只有 `draftChars`。
 *
 * @module dsh-suggest-ghost/completion-gate
 */
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout';
/**
 * 续写整条调用链的**墙钟上界**（毫秒）。
 *
 * 为什么 `generateCompletion` 内部已有的 `deadline(signal, config.timeoutMs, …)` 不算数：
 * `deadline()` 只**通知**（abort 那个 signal），终止动作仍归调用方。若 provider 的异步
 * 迭代器一个 chunk 都不吐、`next()` 永不返回，`for await` 就卡在 `next()` 上，循环体里
 * 那句 `throwIfAborted()` 永远执行不到 —— 于是 `generateCompletion` 这个 promise
 * **永不 settle**，`completionPending` 里那个 controller 一直挂着，用户看到的是「永远
 * 不出东西」，日志里是「什么都没有」。这正是本次故障的第三种不可区分情况。
 * 所以必须有一道**从外部把 promise 判死**的上界，而不是又一个只会通知的 signal。
 *
 * 取值依据（算术写在明处，方便后来人重算）：
 *  - 实测成功耗时 1.5 ~ 7s ⇒ 正常生成有 ~2.9 倍余量；
 *  - `generateCompletion` 自带 maxAttempts=2 + 800ms 退避 ⇒ 一次完整的合法重试是
 *    「attempt1 + 800ms + attempt2」；7s 的最坏实测两次重试 ≈ 14.8s，仍在上界内，
 *    **不会误杀正常重试**；
 *  - 大上下文会话显著更久：单 attempt 到 14s 时，两次重试 ≈ 28.8s 才会撞上界，
 *    也就是允许每条 attempt 比最坏实测慢一倍；
 *  - 再慢就没意义了：续写只对「此刻这份草稿」有效，20s 后用户早就改了草稿，
 *    结果即便到达也会被出口 4（被抢先）丢掉。上界的价值是**释放 pending 并留痕**，
 *    不是等一个迟到的答案。
 *
 * 刻意**不做成 volatile 配置项**：新增可调字段要同时改 `EditableFields` schema、
 * WebUI 表单、`live-settings.SETTING_SPECS` 键表三处，牵动正在被反复重载的 live
 * profile。要调它改这一个常量即可（一次构建的事），语义上也确实不是用户策略。
 */
export const COMPLETION_DEADLINE_MS = 20_000;
/** 本超时的归属码：用它把「我们判的死」和「上游抢先中止」区分开（见 `timeoutOf`）。 */
export const COMPLETION_DEADLINE_CODE = 'SUGGEST_GHOST_COMPLETION_DEADLINE';
/**
 * 节流阈值表。`traceFault` 的既有语义是「按 kind + 归一化签名分桶，**桶里第一条必报**，
 * 之后每 `every` 次报一条」，所以这里的数字只决定**重复**的密度，不影响可见性；
 * 每条打印都带 `[kind #累计次数]`，把阈值调大不会丢「一共发生了多少次」这个信息。
 *
 * 取值分三类，理由写在各自注释里：
 */
const TRACES = {
    // 配置态异常：正常运营下这个分支**不该**被走到（client 在开关关闭时不该再发 complete
    // op），走到了就是契约不符。但一旦开关真的被关掉，每一次停顿都会命中它，默认 50 太吵
    // 也太迟——20 次一条，既能在现场里被看见，又不会盖过别的留痕。
    'inline-disabled': { kind: 'completion-skip', every: 20 },
    // 阈值之下的短草稿是**正当**的不生成，但它是「25 次消失」里最可能的解释之一，
    // 必须能统计到。同样是每次停顿都可能命中，取 20。
    'draft-too-short': { kind: 'completion-skip', every: 20 },
    // client 报了一个 host 不认的会话：真异常，且一旦出现就是**成串**的（同一个失效
    // 会话 id 会被反复重放），所以阈值比上面两条更紧，取 10 条一次。
    'session-missing': { kind: 'completion-skip', every: 10 },
    // 出口 4：每次用户改草稿都可能命中（在途 1.5~7s ≫ 连续打字时两次停顿的间隔），
    // 是全部出口里最高频的一条。默认 50 的问题不是吵，而是**看不见量**：本次故障一个
    // 观测窗口里总共才 30 次消费，阈值 50 意味着除了第一条之后整个窗口不再有任何一条，
    // 「被抢先发生了多少次」又变回不可知。取 10：一次 30 消费的窗口最多 3 行（#1/#10/#20），
    // 而真正的打字风暴（数百次）也只按 1/10 收敛，且每行都带累计计数。
    'superseded': { kind: 'completion-preempted', every: 10 },
    // 出口 5：与出口 4 同源（`existing.abort()` 与卸载清理），同样每 keystroke 级频率，
    // 同样取 10。历史上这一支**一个字都不打**，是本次故障最难查的那条。
    'aborted': { kind: 'completion-aborted', every: 10 },
    // 超时：物理上不可能刷屏——同一会话每个 `COMPLETION_DEADLINE_MS` 周期最多判死一次，
    // 且每次都是用户真的白等了一轮。取 5 是为了让「同一个进程里超时在持续发生」这件事
    // 尽快在日志里显形。
    'timeout': { kind: 'completion-timeout', every: 5 },
    // 真实失败：**沿用既有 kind 与既有阈值（traceFault 默认 50）**，既有报文措辞也逐字
    // 保持不变——fault-signature-smoke 与现场 grep 都依赖 `completion failed for session`
    // 这条旧串。
    'failed': { kind: 'completion-failed', every: 50 },
};
/** 全部出口类别的枚举（冒烟按它做穷尽断言，新增类别不出表就红）。 */
export const COMPLETION_EXIT_REASONS = Object.freeze([
    'inline-disabled',
    'draft-too-short',
    'session-missing',
    'superseded',
    'aborted',
    'timeout',
    'failed',
]);
/**
 * 取某个出口的留痕参数。
 *
 * 收成一个函数有两个实际作用：① 调用方（含冒烟）按 reason 查表，不必各处重复字面量，
 * 「阈值定在多少」这件事只有一个出处；② `TRACES` 用 `satisfies Record<CompletionExitReason, …>`
 * 声明，**漏登记任何一个出口类别就是编译错误**——这张表因此不可能悄悄少一条。
 */
export function completionExitTrace(reason) {
    return TRACES[reason];
}
/**
 * 造一条「停下并留痕」的判定：kind 与阈值一律从 `TRACES` 取，判定处不再重复写字面量。
 * 只有这一条路径能产出 `action:'trace'`，所以「每个 trace 判定都带合法 kind/every」
 * 是由这个函数保证的，冒烟按出口枚举反查它。
 */
const traceOf = (reason) => ({
    action: 'trace',
    reason,
    kind: TRACES[reason].kind,
    every: TRACES[reason].every,
});
/**
 * 出口 1/2/3 的判定，顺序与 `handleComplete` 里的原顺序严格一致
 * （开关 → 阈值 → 会话），换了顺序就等于换了现场语义：开关关着时不该再报
 * 「草稿太短」，会话不存在时不该再报「草稿太短」。
 */
export function decideCompletionEntry(input) {
    // 出口 1：开关关着。为什么这条必须有：关掉续写是**用户能改的状态**（设置页 / 实时
    // 覆盖层），改完之后幽灵不出，唯一正确的答案是「你关的」。没有这条留痕，
    // 「我关了但忘了」和「生成链坏了」在日志里长得一模一样。
    if (!input.inlineEnabled)
        return traceOf('inline-disabled');
    // 出口 2：短于阈值。为什么这条必须有：这是 25 次消失里最「正当」的一类，
    // 也正因为正当，过去没人怀疑它。它必须可统计，否则「阈值调错了」不可证伪。
    if (input.trimmedChars < input.inlineMinChars)
        return traceOf('draft-too-short');
    // 出口 3：会话不存在。为什么这条必须有：client 报的会话 id host 不认，是两端
    // 状态不一致（会话被销毁 / 冷启动遗留 op 重放），属于必须第一时间看见的异常，
    // 而不是可以归进「今天没生成」的正常噪声。
    if (!input.sessionExists)
        return traceOf('session-missing');
    return { action: 'proceed', reason: 'generate' };
}
/**
 * 出口 4/5 + 超时 + 既有 failed 的判定。
 *
 * 顺序即优先级，逐条不可调换：
 *  1. 已报过 → 跳过（不重复留痕，但必须指名先前那条）；
 *  2. 超时 → 报 timeout（**区别于 failed**：failed 是模型/路由给了错误，timeout 是
 *     整条链一个字都没回，两者的修法完全不同）；
 *  3. 槽位已不属于本次 controller → 报被抢先（出口 4，then/catch 两处共用同一条判定，
 *     所以两侧都留痕、且落进同一个节流桶）；
 *  4. rejected 且 aborted → 报 aborted（出口 5：卸载 / 抢占中止的那次，历史上永久静默）；
 *  5. rejected 其余 → 报 failed（沿用既有 kind 与措辞）；
 *  6. resolve 且仍占槽 → 交付。
 */
export function decideCompletionSettle(input) {
    // 1. 迟到的到达：超时分支已经报过了。为什么这条必须有（作为一条**显式**判定而不是
    // 一个裸 return）：它回答「为什么这里没有第二条」，删掉它同一次故障就会以两种说法
    // 出现在日志里，取证时会对不上号。
    if (input.reported !== undefined) {
        return { action: 'skip', reason: 'already-reported', reportedAs: input.reported };
    }
    // 2. 超时。为什么这条必须有：本次故障的第三种不可区分情况（「挂住了」）。没有它，
    // 一次永不 settle 的生成与一次根本没发起的生成完全同形，而 pending 里挂着的
    // controller 还会让后续行为掺进残留状态。
    if (input.timedOut)
        return traceOf('timeout');
    // 3. 被更新的草稿抢先（出口 4，then 与 catch 两处都走这里）。为什么这条必须有：
    // 它是 25 次消失的最大嫌疑——「生成了，但结果不属于当前草稿所以被丢」与「根本没
    // 生成」过去同形。留痕只报「槽位已被占」这一事实，不报正文。
    if (!input.ownsSlot)
        return traceOf('superseded');
    // 4. 被中止（出口 5）。为什么这条必须有：过去 `if (!controller.signal.aborted)`
    // 把这一支整个吞掉，卸载/partialReload 时中止的在途生成一个字都不留，而这恰好是
    // rc.2 反复重载 profile 期间最可能出现「幽灵不出」的窗口。
    if (input.phase === 'reject' && input.aborted)
        return traceOf('aborted');
    // 5. 真实失败（既有留痕，措辞与 kind 都不动）。
    if (input.phase === 'reject')
        return traceOf('failed');
    // 6. 正常交付。
    return { action: 'proceed', reason: 'deliver' };
}
/**
 * 拼装出口报文。集中在这里的唯一目的就是让「报文里有没有正文」变成**可断言**的：
 * 冒烟把一个含哨兵正文的上下文喂给调用侧，再断言产出串里不含该哨兵。
 *
 * `failed` 那一支**逐字保持既有措辞**（`completion failed for session … after …ms: …`），
 * 因为 `scripts/fault-signature-smoke.mjs` 与现场 grep 都以这条旧串为准。
 */
export function completionFaultMessage(reason, ctx) {
    const session = `session=${ctx.sessionId}`;
    const chars = `draftChars=${ctx.draftChars}`;
    switch (reason) {
        case 'inline-disabled':
            return `completion skipped: inline disabled (${session} ${chars})`;
        case 'draft-too-short':
            return `completion skipped: draft below inlineMinChars (${session} ${chars} minChars=${ctx.inlineMinChars ?? '?'})`;
        case 'session-missing':
            return `completion skipped: session not found (${session} ${chars})`;
        case 'superseded':
            return `completion preempted: a newer draft took the slot (${session} ${chars} after ${ctx.elapsedMs ?? 0}ms)`;
        case 'aborted':
            return `completion aborted before settle (${session} ${chars} after ${ctx.elapsedMs ?? 0}ms)`;
        case 'timeout':
            return `completion timeout: no settle within ${ctx.deadlineMs ?? COMPLETION_DEADLINE_MS}ms (${session} ${chars} after ${ctx.elapsedMs ?? 0}ms)`;
        case 'failed':
            // 旧串，逐字不动。
            return `completion failed for session ${ctx.sessionId} after ${ctx.elapsedMs ?? 0}ms: ${ctx.errorText ?? ''}`;
        default:
            /* v8 ignore next 2 -- 全枚举已在 switch 覆盖，兜底只为类型收窄 */
            return `completion exit (${session} ${chars})`;
    }
}
/**
 * 挂一道**从外部判死**的墙钟上界（复用 `@deepseek-ai/dsh-timeout` 的 `deadline()`，
 * 与 `generateSuggestion` / `generateCompletion` 内部同一先例，不自建定时器体系）。
 *
 * 与 `deadline()` 的差别只有一个、也是这条修复的全部要点：`deadline()` 到点只是
 * **通知** signal，永不 settle 的 promise 不会因为被通知就 settle。所以这里在通知之外
 * 还要**把这次调用判死**（`onTimeout` 由调用方去清 pending + 留痕 + 中止底层请求），
 * 用 `AbortSignal` 的 `abort` 事件当那个「外部判死」的触发点——它是 `deadline()`
 * 自己暴露的公开面，不是另造的定时体系。
 *
 * 归属判定靠 `timeoutOf(signal, code)`：到点携带的是本模块的 `COMPLETION_DEADLINE_CODE`，
 * 上游抢先中止（新草稿抢占 / 卸载）携带的是别人的 reason，必须交回 settle 判定处理，
 * 否则「被抢先」会被误记成「超时」。
 *
 * @param upstream - 本次生成的 controller signal。
 * @param timeoutMs - 上界（生产取 `COMPLETION_DEADLINE_MS`，冒烟取几十毫秒）。刻意**不设默认值**：
 *   后面还跟着必填的 `onTimeout`，带默认值的参数排在前面只会让调用方被迫传 `undefined`。
 * @param onTimeout - 判死回调（只在**到点**时调用一次）。
 * @returns 融合信号与幂等 disposer。
 */
export function armCompletionDeadline(upstream, timeoutMs, onTimeout) {
    const startedAt = Date.now();
    const guard = deadline(upstream, timeoutMs, COMPLETION_DEADLINE_CODE);
    const signal = guard.signal;
    let disposed = false;
    /**
     * 幂等清理：撤 timer + 撤 abort 监听。settle（`dispose()`）与到点（`decide()`）
     * 两条路都会走到，且两者互相引用，所以都写成函数声明（提升）而不是 const 箭头。
     */
    function dispose() {
        if (disposed)
            return;
        disposed = true;
        signal.removeEventListener('abort', decide);
        guard[Symbol.dispose]();
    }
    function decide() {
        if (disposed)
            return;
        // 任何 abort 都让这道上界失去意义（要么我们判死了它，要么这次调用已经在收尾），
        // 先撤干净再分流，免得一个被抢占的在途生成白占一个上界时长的 timer、并在
        // AbortSignal.any 的引用图里多留一条边。
        const ours = timeoutOf(signal, COMPLETION_DEADLINE_CODE) !== undefined;
        dispose();
        // 只有携带本模块超时码的 abort 才算「我们判的死」；上游中止（新草稿抢占 / 卸载）
        // 必须交回 settle 判定，否则「被抢先」会被误记成「超时」。
        if (!ours)
            return;
        onTimeout(Date.now() - startedAt);
    }
    if (signal.aborted) {
        decide();
    }
    else {
        signal.addEventListener('abort', decide, { once: true });
    }
    return { signal, dispose };
}
/**
 * 跑一次**有界**的续写生成，并把它的每一种收口都变成留痕。
 *
 * 这是 `handleComplete` 的全部剩余逻辑，搬进纯模块的唯一理由：这些分支过去散在
 * async 闭包里，node 里一条都测不到，于是五条静默 `return` 和「没有上界」一起活了
 * 很久。搬进来之后它们是可断言的（见 `scripts/completion-pipeline-smoke.mjs`）。
 *
 * 收口的四种结果各走哪条出口，由 `decideCompletionSettle` 判定，本函数只做副作用：
 *  - `timeout`：清 `pending` 里属于本次 controller 的条目 + `abort()` 底层请求 + 留痕；
 *  - `superseded` / `aborted` / `failed`：留痕（只在仍占槽时清槽）；
 *  - `proceed`：交付；
 *  - `skip`：什么都不做（此前已报过，不重复）。
 *
 * 单飞与卸载时的 `controller.abort()` 仍归调用方：这里只消费「它被 abort 了」这个事实。
 */
export function startBoundedCompletion(deps, run) {
    const { pending, trace, deliver } = deps;
    const { sessionId, controller, startedAt, draftChars } = run;
    const deadlineMs = deps.deadlineMs ?? COMPLETION_DEADLINE_MS;
    /** 本次已经报过的出口（超时先到时非空，迟到的 settle 因此不再报第二条）。 */
    let reported;
    const traceExit = (decision, errorText) => {
        trace(decision.kind, completionFaultMessage(decision.reason, {
            sessionId,
            draftChars,
            deadlineMs,
            elapsedMs: Date.now() - startedAt,
            ...(errorText === undefined ? {} : { errorText }),
        }), decision.every);
    };
    /**
     * 本次生成的唯一收口：判定 → 清槽 → 留痕 / 交付。
     *
     * 写成函数声明（而不是 const 箭头）是有意的：它要引用**在它之后**才初始化的 `bound`
     * （见下面那句 `const bound = ...`），而 `bound` 的到点回调又要引用它。声明提升让
     * `settle` 这个绑定在 `bound` 初始化之前就已就位，两侧都不存在 TDZ 路径；而 `settle`
     * 真正被调用只可能来自 timer 回调或 promise 回调，那时 `bound` 必然已经初始化完。
     */
    function settle(outcome) {
        // 正常收尾先撤上界 timer：不撤的话每次成功的续写都会白挂一个上界时长的定时器。
        bound.dispose();
        const ownsSlot = pending.get(sessionId) === controller;
        const decision = decideCompletionSettle({
            phase: outcome.phase === 'resolve' ? 'resolve' : 'reject',
            ownsSlot,
            aborted: controller.signal.aborted,
            timedOut: outcome.phase === 'timeout',
            reported,
        });
        // 迟到的到达（超时判死之后底层才 settle）：不再留痕，也不再交付。
        if (decision.action === 'skip')
            return;
        // 只有仍占着槽位时才清：槽已被更新草稿接管时，那份条目不属于这次。
        if (ownsSlot)
            pending.delete(sessionId);
        if (decision.action === 'trace') {
            if (outcome.phase === 'timeout') {
                // 超时后必须中止底层请求：只清 Map 不 abort，那个永不 settle 的 llm.stream
                // 会一直占着连接与令牌预算，而用户看到的仍然是「永远不出东西」。
                controller.abort();
            }
            reported = decision.reason;
            traceExit(decision, outcome.phase === 'reject' ? String(outcome.error).slice(0, 200) : undefined);
            // 被抢先 / 超时 / 失败的结果一律不交付：交付一份已经不属于当前草稿的续写，
            // 等于把「幽灵出现在错的草稿后面」这个更难查的问题造出来。
            return;
        }
        if (outcome.phase !== 'resolve')
            return;
        deliver({ sessionId, draftChars, elapsedMs: Date.now() - startedAt, value: outcome.value });
    }
    /**
     * 整条生成链的墙钟上界（取值理由见 `COMPLETION_DEADLINE_MS`）。到点即
     * `settle({phase:'timeout'})`：清 pending、中止底层请求、留 `completion-timeout`。
     *
     * 建在 `settle` 之前不是风格问题：`armCompletionDeadline` 在「上游已经中止」时会同步
     * 走一次判定，那条路只清 timer、不调 `onTimeout`（归属由超时码判定），但把 `bound`
     * 先干净初始化掉，`settle` 里那句 `bound.dispose()` 就没有任何 TDZ 路径可走。
     */
    const bound = armCompletionDeadline(controller.signal, deadlineMs, () => {
        settle({ phase: 'timeout' });
    });
    run.generate(bound.signal).then((value) => { settle({ phase: 'resolve', value }); }, (error) => { settle({ phase: 'reject', error }); });
}
