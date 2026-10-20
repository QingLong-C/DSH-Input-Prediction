/**
 * 事务外补写的槽队列（纯函数模块，零 runtime import，可离线驱动断言）。
 *
 * **它解决的问题**：宿主写 `_push` / `_ops` 会被内核按 `HMR transactions cannot be
 * nested` 拒绝。判据是 `@deepseek-ai/dsh-hmr` 里 `runExclusive` 的
 * `if (this.executing.getStore()) return Promise.reject(...)`，而 `executing` 是一个
 * `AsyncLocalStorage`（同文件 :270），事务由 :284 的 `executing.run(true, operation)`
 * 建立。ALS 上下文沿 `await`、microtask、以及**在事务内创建的 timer** 继续传播，所以
 * 「排到下一个 tick」根本逃不出去（issue #16 的取证注释就是这个结论）。
 *
 * **为什么定时器能逃出去**：lead 在同一构建上用 `DSH_GHOST_ALSPROBE` 探针在五种上下文
 * 各写一次（被修的就是这套写入），实测五行：
 *
 * ```
 * PROBE boot-now:              OK  in 1437ms
 * PROBE handler-sync:          OK  in 1463ms
 * PROBE handler-microtask:     OK  in 1722ms
 * PROBE boot-setTimeout-5s:    OK  in  146ms     ← apply() 期建的定时器：能写
 * PROBE boot-setInterval-8s:   OK  in  147ms     ← apply() 期建的 interval：能写
 * ```
 *
 * 而在 LLM `await` 之后的续体里写（也就是 `completion` 生成完成后那一次推送）实测
 * FAIL = `HMR transactions cannot be nested`。差别不在「等了多久」，在**上下文在哪儿
 * 建立的**：`apply()` 期建定时器时 store 是 undefined，于是它以后每次触发都在事务外。
 * 本模块就是这个「事务外锚点」要排的队：被拒的写入不再丢，稍后由 `src/index.ts` 里的
 * pump 补写。
 *
 * **槽语义**：最多两个槽（push / clearOps），同类入队只保留最新一份。这与 `pushToClient`
 * 现有的尾写合并（`pendingPushPayload` 新载荷覆盖旧载荷）是同一条语义，所以排队不会改变
 * 载荷的可见顺序，只是将「注定被拒的即时写」换成「一次可成的延后写」。
 *
 * 本模块只管**排、取、淘汰、判定**；真正的写与留痕在 `src/index.ts`，因为那需要 settings
 * 服务与 `traceOps`。判定函数把风险最高的两条安全约束放在这里，是为了让它们能被
 * `scripts/deferred-writes-smoke.mjs` 离线证伪（见那两个函数的注释）。
 *
 * @module dsh-suggest-ghost/deferred-writes
 */
/**
 * pump 间隔：500ms。
 *
 * 依据（两头都要给理由）：
 *  - **上限那头**：续写是用户停下来正等的东西，补写延迟必须显著小于它跟在后面的生成
 *    耗时（`completion generated … in Xms` 常见 1.5~3s）。500ms 的最坏额外等待 ≈
 *    典型生成耗时的 1/4~1/3，用户感知的仍是「模型在想要慢一点」，不是「插件卡住了」。
 *    取 2s 以上就等于没修：那时 client 早就在下一次输入了。
 *  - **下限那头**：空转成本。队列空时回调必须立刻 return（一次 `isEmpty()` 布尔判断），
 *    不做 `describe()`、不做读盘，所以 500ms 的代价是每秒 2 次布尔判断。再密下去只换来
 *    零点几秒的收益，不值。
 *  - 两个槽，每 tick 至多补写一个，所以最坏情况是两个 tick（1s）排空一批。
 */
export const DEFERRED_PUMP_MS = 500;
/**
 * 带续写的 push 载荷在槽里的最长存活时间：8000ms。
 *
 * 理由：`completion` 是**「此刻这份草稿」**的产物。补写成功时用户早已改了草稿，把一条
 * 陈年续写推进去会在光标位置显示一段不对题的幽灵文本（比「没幽灵」更糟，因为用户会
 * Tab 接受它）。8s 是这么定的：
 *  - 触发一次续写的输入停顿本身在 0.5~1.5s 量级，8s 相当于「用户又往下打了好几轮」；
 *  - 它是 `DEFERRED_PUMP_MS` 的 16 倍，也就是排在槽里的续写至少有 16 次机会落盘，
 *    淘汰不会被当成「根本没试过」；
 *  - lead 给的反例（30 秒前的续写推进去是错的）在这个上限之上，本上限比它保守 4 倍。
 *
 * 不带 completion 的 push（纯热度/历史/对账刷新）**不按时间淘汰**：那些载荷是幂等的
 * 当前状态快照，晚一点写进去仍然正确，而且同类入队只会留最新一份，不存在积压陈旧。
 */
export const DEFERRED_PUSH_MAX_AGE_MS = 8000;
/**
 * 单个槽的最长补写次数：8 次（≈4s 的补写窗口）。
 *
 * 理由：事务外的 pump 建立时上下文才是「事务外」的。若插件在 HMR 事务**内**被重新
 * `apply()`（partialReload 会重跑 apply），那这个定时器就继承了 store=true，补写会
 * 永远被拒。没有界的重试会把每个 tick 变成「一次写 + 一条留痕」，而下一次自然写点
 * （回合结束、pull 应答）本来就会把最新状态补出去。所以到达上限就丢弃并留痕，
 * 让「补不上」这件事可见而不是一把烧日志。
 */
export const DEFERRED_MAX_ATTEMPTS = 8;
/**
 * 从 `_push` 载荷里读出续写草稿与会话。
 *
 * 只用**载荷里已有的信息**：`completion.draft` 与 `completionSessionId`。读不出来（不
 * 是 JSON、无该键、值不是字符串）一律返回 null，调用方据此退回时间上限那一道门；这里
 * 绝不「猜一个草稿出来」，也不声称能拿当前草稿（宿主没有草稿源，草稿在 client 输入框里）。
 */
export function pushPayloadCompletionMeta(payload) {
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch {
        return { rev: null, completionDraft: null, completionSessionId: null };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { rev: null, completionDraft: null, completionSessionId: null };
    }
    const row = parsed;
    const rev = typeof row.rev === 'number' ? row.rev : null;
    const completion = row.completion;
    if (typeof completion !== 'object' || completion === null) {
        // `completion: null` = 显式作废，本来就不带续写，没有什么陈旧可担忧。
        return { rev, completionDraft: null, completionSessionId: null };
    }
    const draft = completion.draft;
    const sessionId = row.completionSessionId;
    return {
        rev,
        completionDraft: typeof draft === 'string' ? draft : null,
        completionSessionId: typeof sessionId === 'string' ? sessionId : null,
    };
}
/**
 * 补写 push 前的判定（安全约束二的 `_push` 那一半）。
 *
 * 「补写不得覆盖更新的盘上状态」在这里落实为三条跳过规则，按代价从便宜到贵排：
 *  1. `already-landed`：同一份字节已经在盘上（刚才有别的写点把它写成功了），再写一次
 *     只是白推一个 revision。
 *  2. `superseded`：指纹已不是入队时那一份 ⇒ 期间有人推了**更新的载荷**。那份新载荷要么
 *     已经落盘，要么覆盖了本槽（同类只留最新）。两种情形下再把旧载荷写回去都会用陈旧
 *     状态盖掉新状态（续写通道是单槽 last-wins，陈旧一份就把新鲜一份吃了）。
 *  3. `stale-draft`：载荷自带的 `completion.draft` 与宿主已知的该会话最新草稿不一致 ⇒
 *     用户早就换了草稿，这条续写推进去是错的。宿主草稿源 = `completionCache`（上一次
 *     成功生成的那份）；拿不到（null）时**不猜**，由时间上限兜底。
 *
 * @param item - 槽里的 push 项。
 * @param ctx - 调用方现读的最新状态（三个值都必须是**取槽之后**的当前值）。
 * @returns `write` 或 `skip` + 可留痕的原因。
 */
export function decidePushDrain(item, ctx) {
    if (ctx.lastLandedPayload === item.payload) {
        return { action: 'skip', reason: 'already-landed' };
    }
    if (item.fingerprint !== ctx.lastPushFingerprint) {
        return { action: 'skip', reason: 'superseded' };
    }
    if (item.completionDraft !== null
        && ctx.latestCompletionDraft !== null
        && ctx.latestCompletionDraft !== item.completionDraft) {
        return { action: 'skip', reason: 'stale-draft' };
    }
    return { action: 'write' };
}
/**
 * 补写 `_ops` 清空前的 CAS（安全约束二）。
 *
 * 判据来自 `src/index.ts` 的 `readOps()`：它走 settings 服务的 `describe()` 现读盘上的
 * `_ops` 值，是插件内唯一权威源。**相等才清**：相等说明盘上躺着的仍是「我们刚消费掉的
 * 那一份」，清空吃掉的是已消费的 op。不相等说明期间 client 又写了新载荷（载荷里带单调
 * `seq`，同值重写也会变），此时清空会**吃掉未消费的 op**：那是把用户输入弄丢，比留一
 * 份陈旧载荷在盘上严重得多。所以放弃这次清空（丢弃槽，不重试）：新载荷会走它自己的
 * `document-updated` → `consumeOps` → 入队自己的清空。
 *
 * @param item - 槽里的 clearOps 项。
 * @param onDiskPayload - 取槽**之后**现读的 `readOps()` 结果。
 */
export function decideClearOpsDrain(item, onDiskPayload) {
    if (onDiskPayload !== item.consumedPayload) {
        return { action: 'skip', reason: 'newer-ops-on-disk' };
    }
    return { action: 'clear' };
}
/**
 * 最多各存一项的槽队列。
 *
 * 不是无界队列：两个槽就是全部设计。`_push` 是单槽 last-wins 通道，`_ops` 是「全部消费完
 * 才清空」的批，两者都只需要最新一份，所以「同类覆盖」与现有 `pendingPushPayload` 的
 * 尾合并语义一致，且不存在无界内存。
 */
export class DeferredWriteQueue {
    pushSlot = null;
    clearSlot = null;
    /**
     * 入队一份被拒的 push 载荷（同类覆盖，新载荷取代旧载荷）。
     * 草稿/会话/rev 从载荷自身读出（见 `pushPayloadCompletionMeta`：不编造能力）。
     */
    enqueuePush(input, now) {
        const meta = pushPayloadCompletionMeta(input.payload);
        const item = {
            kind: 'push',
            payload: input.payload,
            fingerprint: input.fingerprint,
            rev: meta.rev,
            carriesCompletion: input.carriesCompletion,
            completionDraft: meta.completionDraft,
            completionSessionId: meta.completionSessionId,
            enqueuedAt: now,
            attempts: 0,
        };
        this.pushSlot = item;
        return item;
    }
    /** 入队一次被拒的 `_ops` 清空（同类覆盖，带**本次已消费**的载荷原文做 CAS 依据）。 */
    enqueueClearOps(consumedPayload, now) {
        const item = { kind: 'clearOps', consumedPayload, enqueuedAt: now, attempts: 0 };
        this.clearSlot = item;
        return item;
    }
    /**
     * 队列是否为空。pump 每 tick 都要调它，**必须便宜**（两个 null 比较，不碰盘、不
     * `describe()`）：队列常年是空的，空转成本完全由这个函数决定。
     */
    isEmpty() {
        return this.pushSlot === null && this.clearSlot === null;
    }
    /** 当前槽数（0~2，只为断言与留痕）。 */
    get size() {
        return (this.pushSlot === null ? 0 : 1) + (this.clearSlot === null ? 0 : 1);
    }
    /**
     * 淘汰「补了也没意义」的项，返回它们的留痕材料。
     *
     * 两条规则（都在 `take` 之前跑，所以陈旧载荷不会被写回去）：
     *  - `completion-too-old`：带续写的 push 超过 `DEFERRED_PUSH_MAX_AGE_MS`。
     *  - `attempts-exhausted`：任一槽补写满 `DEFERRED_MAX_ATTEMPTS` 次。
     */
    evict(now) {
        const out = [];
        const push = this.pushSlot;
        if (push !== null) {
            const ageMs = now - push.enqueuedAt;
            if (push.carriesCompletion && ageMs > DEFERRED_PUSH_MAX_AGE_MS) {
                out.push({ item: push, reason: 'completion-too-old', ageMs, attempts: push.attempts });
                this.pushSlot = null;
            }
            else if (push.attempts >= DEFERRED_MAX_ATTEMPTS) {
                out.push({ item: push, reason: 'attempts-exhausted', ageMs, attempts: push.attempts });
                this.pushSlot = null;
            }
        }
        const clear = this.clearSlot;
        if (clear !== null && clear.attempts >= DEFERRED_MAX_ATTEMPTS) {
            out.push({ item: clear, reason: 'attempts-exhausted', ageMs: now - clear.enqueuedAt, attempts: clear.attempts });
            this.clearSlot = null;
        }
        return out;
    }
    /**
     * 取一项执行（入队最早的那个槽优先，等时长时 push 优先：用户在等的是幽灵）。
     * 取即离槽：调用方失败后自己调 `retry` 放回来，避免「槽里还有一份正在写的」误读。
     */
    take() {
        const push = this.pushSlot;
        const clear = this.clearSlot;
        if (push === null && clear === null)
            return null;
        if (push === null) {
            this.clearSlot = null;
            return clear;
        }
        if (clear === null) {
            this.pushSlot = null;
            return push;
        }
        if (clear.enqueuedAt < push.enqueuedAt) {
            this.clearSlot = null;
            return clear;
        }
        this.pushSlot = null;
        return push;
    }
    /**
     * 补写被拒后放回原槽并计一次数（`enqueuedAt` 不变，所以时间淘汰仍在计时）。
     *
     * 放回前检查同种槽是否已被**更新的入队**占住（在途写期间可能发生）：那种情况下旧项
     * 已被取代，放回会把新载荷盖掉，所以直接丢弃并返回 false 让调用方留痕。
     */
    retry(item) {
        if (item.kind === 'push') {
            if (this.pushSlot !== null)
                return false;
            this.pushSlot = { ...item, attempts: item.attempts + 1 };
            // `enqueuedAt` 保持原值：计龄不能因重试而停表（否则每 4s 一轮的失败永不超龄）。
            return true;
        }
        if (this.clearSlot !== null)
            return false;
        this.clearSlot = { ...item, attempts: item.attempts + 1 };
        return true;
    }
}
