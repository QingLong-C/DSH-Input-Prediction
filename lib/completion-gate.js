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
import { deadline } from '@deepseek-ai/dsh-timeout';
/**
 * 续写整条调用链的**墙钟上界**（毫秒）。
 *
 * ## 为什么 `generateCompletion` 内部已有的 `deadline(signal, config.timeoutMs, …)` 不算数
 * `deadline()` 只**通知**（abort 那个 signal），终止动作仍归调用方。若 provider 的异步
 * 迭代器一个 chunk 都不吐、`next()` 永不返回，`for await` 就卡在 `next()` 上，循环体里
 * 那句 `throwIfAborted()` 永远执行不到 —— 于是 `generateCompletion` 这个 promise
 * **永不 settle**，`completionPending` 里那个 controller 一直挂着，用户看到的是「永远
 * 不出东西」，日志里是「什么都没有」。这正是本次故障的第三种不可区分情况。
 * 所以必须有一道**从外部把 promise 判死**的上界，而不是又一个只会通知的 signal。
 *
 * ## 取值依据：真实宿主的实测分布，不是快样本的算术
 * 上一版这里写的是「实测 1.5~7s，两次重试 ≈14.8s，所以取 20s」，那是照着最快的样本推的，
 * 而**真宿主直接把一次合法生成判死了**。隔离沙箱（同一台机器、同一 provider、模型
 * Qwen3.8-Flash、同一个会话）实测 `completion generated … in Nms`：
 *  - `chars=39  in 18971ms`
 *  - `chars=132 in 24217ms`
 *  - `chars=109 in 27793ms`
 *  - 以及一次 `completion timeout: no settle within 20000ms … after 20001ms` —— 那就是
 *    被 20s 界**误杀**的那次：它完全可能在 20s 之后正常返回。
 * 三点结论：① 合法时长在 19~28s，比「1.5~7s」那个说法慢一个量级；② 它与输出字数**不**
 * 成正比（132 字比 109 字还快），说明固定开销（建转录、首令牌延迟、网络）主导，所以
 * 「按吞吐外推到 160 字上限」那种模型不成立，别拿它当依据；③ 因此按「实测最慢一次 ×1.5」
 * 取 45s，覆盖单次慢生成 plus 抖动，同时仍紧于内层单 attempt 预算。
 *
 * 明确接受的代价：一条合法的**两次重试链**（慢 attempt1 + 800ms 退避 + attempt2）会超过
 * 45s 而被判死。这是有意的——>45s 才到达的续写，对着的早就不是用户此刻的草稿（他继续
 * 打字时出口 4「被抢先」本来就会把结果丢掉），等它没有价值；这道界的职责是**释放 pending
 * 并留下痕迹**，不是把一个迟到的答案送上门。
 *
 * 45s 仍然**紧于**内层单 attempt 预算 `timeoutMs`（默认 60s），所以这条交互链的有效上界
 * 是这一个；否则内层那个 60s 才是真正生效的界，这次修复等于没做。
 *
 * 刻意**不做成 volatile 配置项**：新增可调字段要同时改 `EditableFields` schema、WebUI
 * 表单、`live-settings.SETTING_SPECS` 键表三处，牵动正在被反复重载的 live profile。
 * 要调它改这一个常量即可（一次构建的事）。
 */
export const COMPLETION_DEADLINE_MS = 45_000;
/**
 * 本超时的归属码，盖在 `deadline()` 产出的 `TimeoutReason` 上。
 *
 * 现在**不再**用 `timeoutOf()` 事后判断归属（那要求监听挂在融合 signal 上，正是上一版
 * 把兜底关掉的原因）——权威已经拆成独立 timer signal，响了就是到点。保留这个码是让报文
 * 里的 `TimeoutReason` 仍能认出「这是续写的墙钟上界」，而不是别层的超时。
 */
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
    // 出口 4：每次用户改草稿都可能命中（在途实测 19~28s，远大于连续打字时两次停顿的间隔，
    // 所以「前一次还在飞、后一次已经到」是常态而不是例外），
    // 是全部出口里最高频的一条。默认 50 的问题不是吵，而是**看不见量**：本次故障一个
    // 观测窗口里总共才 30 次消费，阈值 50 意味着除了第一条之后整个窗口不再有任何一条，
    // 「被抢先发生了多少次」又变回不可知。取 10：一次 30 消费的窗口最多 3 行（#1/#10/#20），
    // 而真正的打字风暴（数百次）也只按 1/10 收敛，且每行都带累计计数。
    'superseded': { kind: 'completion-preempted', every: 10 },
    // 出口 5：与出口 4 同源（`existing.abort()` 与卸载清理），同样每 keystroke 级频率，
    // 同样取 10。历史上这一支**一个字都不打**，是本次故障最难查的那条。
    'aborted': { kind: 'completion-aborted', every: 10 },
    // 超时：**逐次必报（every 1）**。这不是风格选择，是沙箱实测逼出来的。上一版取 5，
    // 现场是：第一次停顿打出 `[completion-timeout #1]`，第二次停顿 20 秒内一行都没有——
    // 而判死调用确实发生了两次，第二次被同一个桶吞掉（`faultSignature` 把会话 id 折成
    // `session`，所以**所有会话共用这一个 timeout 桶**，别的会话早就把计数推过了）。
    // 本条留痕存在的全部理由就是把「挂住了」从「没生成 / 被抢先」里分出来；它按次被吞，
    // 等于把这次修复又写回静默——所以宁可逐次。
    // 量的风险有界：同一会话每个 `COMPLETION_DEADLINE_MS` 周期最多一条，且只在真的挂住时
    // 出现（一次超时至少要隔 `COMPLETION_DEADLINE_MS`＝45s 才可能再来一条）。逐次打印的
    // 先例就在同一条通道上：
    // `traceFault('push-nested', …, carriesCompletion ? 1 : 50)`——丢了用户正在等的那份
    // 续写就不节流。
    'timeout': { kind: 'completion-timeout', every: 1 },
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
 * 还要**把这次调用判死**（`onTimeout` 由调用方去清 pending + 留痕 + 中止底层请求）。
 *
 * ## 为什么超时权威与融合信号必须分成两个 signal
 * 上一版把监听挂在 `deadline(upstream, …)` 返回的**融合** signal 上，于是「上游先中止」
 * 和「我们判死」共用同一个事件面，只能靠 `timeoutOf(reason, code)` 事后分辨归属。
 * 那是错的，而且错得正好落在最难查的那条路上：
 *  - `upstream` 在 arm 时**已经** aborted（复用了上一轮被 abort 的 controller）→
 *    融合 signal 一出生就是 aborted → 按「这不是我们的超时」处理 → 顺手把 timer 撤了
 *    → 那次调用**再也没有界**。若它同时又不响应 abort（正是线上那种挂住），结果就是
 *    零痕迹 + pending 长挂：比原缺陷更糟，因为它把兜底也关掉了。
 *  - 融合 signal 一旦中止就**不再**发第二次 abort 事件，所以「上游先中止、底层随后卡死」
 *    的组合里，这道界同样失效。
 * 现在把权威拆成两个 signal：`deadline(undefined, …)` 只归我们的 timer 中止（上游怎么动
 * 都影响不到它），在它上面监听；交给生成链的 `signal` 才是 `AbortSignal.any([upstream,
 * timer])` 的融合结果。归属因此不再需要事后判断——timer 响了就是到点，别的事件不响。
 *
 * @param upstream - 本次生成的 controller signal（只作为中止来源参与融合）。
 * @param timeoutMs - 上界（生产取 `COMPLETION_DEADLINE_MS`，冒烟取几十毫秒）。刻意**不设默认值**：
 *   后面还跟着必填的 `onTimeout`，带默认值的参数排在前面只会让调用方被迫传 `undefined`。
 * @param onTimeout - 判死回调（只在**到点**时调用一次，与上游状态无关）。
 * @returns 融合信号与幂等 disposer。
 */
export function armCompletionDeadline(upstream, timeoutMs, onTimeout) {
    const startedAt = Date.now();
    /** 超时权威：没有上游参与，因此它只可能被下面那个 timer 中止。 */
    const timer = deadline(undefined, timeoutMs, COMPLETION_DEADLINE_CODE);
    /** 交给生成链的取消面：上游抢先中止与到点都从这里传下去。 */
    const signal = AbortSignal.any([upstream, timer.signal]);
    let disposed = false;
    function dispose() {
        if (disposed)
            return;
        disposed = true;
        timer.signal.removeEventListener('abort', onAbort);
        timer[Symbol.dispose]();
    }
    function onAbort() {
        if (disposed)
            return;
        // 到点即判死：先撤 timer 与监听，再把这次调用交给 settle 走 timeout 出口。
        dispose();
        onTimeout(Date.now() - startedAt);
    }
    // timer.signal 在 arm 时必然未中止（timer 刚起），所以没有「同步已到点」这条分支。
    timer.signal.addEventListener('abort', onAbort, { once: true });
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
     * 这道界**与 upstream 的当前状态无关**：上游在 arm 时已经中止、或随后中止，都不会撤掉
     * 它（`armCompletionDeadline` 的「为什么权威与融合信号要分成两个 signal」那段记的就是
     * 上一版在这里犯的错——它把兜底一起关掉了）。它只会在两种时刻消失：到点判死，或
     * `settle` 第一行的 `bound.dispose()`。
     *
     * `bound` 建在 `settle` 之后是可以的：`settle` 是函数声明（提升），而它真正被调用最早
     * 也要等这个 `const bound = ...` 执行完之后的那个事件。
     */
    const bound = armCompletionDeadline(controller.signal, deadlineMs, () => {
        settle({ phase: 'timeout' });
    });
    run.generate(bound.signal).then((value) => { settle({ phase: 'resolve', value }); }, (error) => { settle({ phase: 'reject', error }); });
}
