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
export declare const COMPLETION_DEADLINE_MS = 20000;
/** 本超时的归属码：用它把「我们判的死」和「上游抢先中止」区分开（见 `timeoutOf`）。 */
export declare const COMPLETION_DEADLINE_CODE = "SUGGEST_GHOST_COMPLETION_DEADLINE";
/** 全部出口类别；`action:'trace'` 的判定一定落在这里，新增出口必须先加键。 */
export type CompletionExitReason = 'inline-disabled' | 'draft-too-short' | 'session-missing' | 'superseded' | 'aborted' | 'timeout' | 'failed';
/** 一条留痕的最小三要素：traceFault 的 kind、节流阈值 every，以及类别说明。 */
export interface CompletionTrace {
    /** 故障类别（进 `[<kind> #N]` 标记；新串，不复用既有 kind）。 */
    readonly kind: string;
    /** 节流阈值：第 1 次必报，之后每 `every` 次报一条带累计计数的。 */
    readonly every: number;
}
/** 全部出口类别的枚举（冒烟按它做穷尽断言，新增类别不出表就红）。 */
export declare const COMPLETION_EXIT_REASONS: readonly CompletionExitReason[];
/**
 * 取某个出口的留痕参数。
 *
 * 收成一个函数有两个实际作用：① 调用方（含冒烟）按 reason 查表，不必各处重复字面量，
 * 「阈值定在多少」这件事只有一个出处；② `TRACES` 用 `satisfies Record<CompletionExitReason, …>`
 * 声明，**漏登记任何一个出口类别就是编译错误**——这张表因此不可能悄悄少一条。
 */
export declare function completionExitTrace(reason: CompletionExitReason): CompletionTrace;
/** 判定结果：继续生成 / 停下并留痕（每条出口都带 kind）。 */
export type CompletionGateDecision = {
    readonly action: 'proceed';
    readonly reason: 'generate' | 'deliver';
} | {
    readonly action: 'trace';
    readonly reason: CompletionExitReason;
    readonly kind: string;
    readonly every: number;
} | {
    readonly action: 'skip';
    readonly reason: 'already-reported';
    readonly reportedAs: CompletionExitReason;
};
/** 入口段（还没发起生成）的判定输入。**只接受字符数**，不接受草稿正文。 */
export interface CompletionEntryInput {
    /** `cfg.inlineEnabled`：实时视图里的续写开关（`!== false` 才当开）。 */
    readonly inlineEnabled: boolean;
    /**
     * `draft.trim().length`：判定用的**就是这一个数**（与历史上的 `handleComplete`
     * 一致），非正文。刻意与报文里上报的 `draftChars`（未 trim 的长度，和既有
     * `ops consumed: complete … draftChars=N` 那行同口径）分开命名：两个数含义不同，
     * 混用一个名字会让现场对不上号。
     */
    readonly trimmedChars: number;
    /** `cfg.inlineMinChars`：触发阈值。 */
    readonly inlineMinChars: number;
    /** `ctx.sessions.get(sessionId) !== undefined`。 */
    readonly sessionExists: boolean;
}
/**
 * 出口 1/2/3 的判定，顺序与 `handleComplete` 里的原顺序严格一致
 * （开关 → 阈值 → 会话），换了顺序就等于换了现场语义：开关关着时不该再报
 * 「草稿太短」，会话不存在时不该再报「草稿太短」。
 */
export declare function decideCompletionEntry(input: CompletionEntryInput): CompletionGateDecision;
/** 生成 settle 段的判定输入。 */
export interface CompletionSettleInput {
    /** 走到的是 fulfilled 还是 rejected。 */
    readonly phase: 'resolve' | 'reject';
    /** `completionPending.get(sessionId) === controller`：这个结果还属于当前槽位吗。 */
    readonly ownsSlot: boolean;
    /** 上游（新草稿抢占 / 卸载清理）已经中止过这个 controller。 */
    readonly aborted: boolean;
    /** 由本模块的墙钟上界判死的（reason 携带本模块的超时码）。 */
    readonly timedOut: boolean;
    /**
     * 同一次生成此前**已经**留过的痕（超时先到、迟到的 settle 再进来时非空）。
     * 传的就是那条已报的 reason——「跳过」必须指名它在跳过谁，类型上不给
     * 无解释的静默 return 留位置。
     */
    readonly reported: CompletionExitReason | undefined;
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
export declare function decideCompletionSettle(input: CompletionSettleInput): CompletionGateDecision;
/** 出口报文里允许出现的字段：**只有字符数、阈值、耗时、会话 id、错误摘要**。 */
export interface CompletionMessageContext {
    readonly sessionId: string;
    /** 只有字符数。类型里没有 `draft` 这个键，正文进不来。 */
    readonly draftChars: number;
    readonly inlineMinChars?: number;
    readonly elapsedMs?: number;
    readonly deadlineMs?: number;
    /** failed 用的错误摘要（调用方负责截断；本模块不碰任何用户输入）。 */
    readonly errorText?: string;
}
/**
 * 拼装出口报文。集中在这里的唯一目的就是让「报文里有没有正文」变成**可断言**的：
 * 冒烟把一个含哨兵正文的上下文喂给调用侧，再断言产出串里不含该哨兵。
 *
 * `failed` 那一支**逐字保持既有措辞**（`completion failed for session … after …ms: …`），
 * 因为 `scripts/fault-signature-smoke.mjs` 与现场 grep 都以这条旧串为准。
 */
export declare function completionFaultMessage(reason: CompletionExitReason, ctx: CompletionMessageContext): string;
/** 一道已建立的墙钟上界：融合信号 + 幂等清理。 */
export interface CompletionDeadline {
    /** 上游中止与到点融合后的信号，必须交给生成链当取消信号。 */
    readonly signal: AbortSignal;
    /** 清掉计时器；幂等。settle 时必调，否则进程白挂一个上界时长的 timer。 */
    dispose(): void;
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
export declare function armCompletionDeadline(upstream: AbortSignal, timeoutMs: number, onTimeout: (elapsedMs: number) => void): CompletionDeadline;
/** 交付回调拿到的上下文：**只有**字符数与耗时，没有正文（正文在调用方闭包里，本来也不需要进日志）。 */
export interface CompletionDelivery<T> {
    readonly sessionId: string;
    readonly draftChars: number;
    readonly elapsedMs: number;
    readonly value: T;
}
/** `startBoundedCompletion` 的依赖注入面——冒烟就是从这里塞进假时钟与假留痕的。 */
export interface CompletionRunDeps<T> {
    /**
     * `sessionId → 在途 controller`。**由调用方持有**（卸载清理与单飞都靠它），
     * 本模块只按「这条条目属不属于本次 controller」来清它，不接管它的生命周期。
     */
    readonly pending: Map<string, AbortController>;
    /** 留痕出口（`src/index.ts` 注入现成的 `traceFault`，所以节流/分桶语义与全场一致）。 */
    readonly trace: (kind: string, message: string, every: number) => void;
    /** 交付出口（缓存写入 + 推 client + 既有的 `completion generated` / `completion dropped` 留痕）。 */
    readonly deliver: (delivery: CompletionDelivery<T>) => void;
    /** 墙钟上界，默认 `COMPLETION_DEADLINE_MS`；冒烟注入几十毫秒即可离线跑到超时分支。 */
    readonly deadlineMs?: number;
}
/** 一次有界生成本身的入参。 */
export interface CompletionRun<T> {
    readonly sessionId: string;
    /** 本次生成的 controller（单飞已由调用方完成：进来时它应当已经占着 `pending` 的槽）。 */
    readonly controller: AbortController;
    /** 本次生成的起点（`Date.now()`），耗时只用于报文。 */
    readonly startedAt: number;
    /** 上报用的未 trim 字符数。 */
    readonly draftChars: number;
    /** 用融合信号发起生成；返回的 promise 允许**永不 settle**，那正是本模块存在的理由。 */
    readonly generate: (signal: AbortSignal) => Promise<T>;
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
export declare function startBoundedCompletion<T>(deps: CompletionRunDeps<T>, run: CompletionRun<T>): void;
