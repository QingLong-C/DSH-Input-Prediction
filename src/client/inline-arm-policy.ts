/**
 * 停顿续写的 armed 调度策略（issue #21）——**纯函数状态机，无 DOM / 无定时器**。
 *
 * ## 为什么要有这个文件
 *
 * 0.5.1 之前，`scheduleInlineTrigger()` 挂在 `render()` 首行，且每次调用都
 * `clearTimeout` + `setTimeout` 重来。于是 debounce 的真实语义是「**距离上一次
 * render 多久**」，而不是「**距离用户最后一次改草稿多久**」。render 的来源远不止
 * 按键：`settings/document-updated`（其他命名空间的写入也算）、`connection/reset`、
 * 会话列表变化、投影面变化、host `_push` 落地后的补渲染……一次 40 字符的输入实测
 * 打出 **1127 次 `inline armed`**，停顿计时器被无限推到重来，续写触发点被拖离用户
 * 真实停顿点，CPU 与日志一起遭殃（见 Gitea #21）。
 *
 * 本模块把判据从「render 次数」换成「**观察值是否变化**」：只有 draft / session /
 * ghostKind / 配置签名中的任一项真的变了，才允许重新计时。
 *
 * ## 状态机的三条不变量
 *
 * 1. **同键不重置**：ticket 与本次观察同键 → `skip`，既有到期时刻 `dueAt` 一字不动。
 * 2. **发过不再发**：同一 (session, draft) 已经发出过 `complete` → `skip`，直到草稿
 *    再变化。这条同时掐断了「fire→写 `_ops`→revision 变→事件回来→render→再 fire」
 *    的自循环。
 * 3. **幽灵已就位就不问**：当前已经在显示这个草稿的续写（ghostKind==='inline'）
 *    → `cancel`，续写都显示出来了，没有再问一次的理由。
 *
 * 调用方只负责执行决策（建/清真实的 setTimeout）并把 `settleInlineTimer` 用在定时器
 * 回调里；所有「该不该重新计时」的判断都在这里，因此可以被 node 直接测（见
 * `scripts/render-storm-smoke.mjs`）。
 */

/** 幽灵形态（与 client 的 `GhostContent.kind` 同字面量；null = 当前无幽灵）。 */
export type InlineArmGhostKind = 'llm' | 'history' | 'inline' | null;

/** 一次 render 向策略提供的观察值（全部为不可变快照，策略不读外部状态）。 */
export type InlineArmObservation = {
  /** 观察时刻（ms，来自 `Date.now()`）。 */
  now: number;
  /** 当前草稿（原样，不做 trim；阈值判断才 trim）。 */
  draft: string;
  /** 当前会话 id；null = 未绑定会话（无 bound 时也传 null）。 */
  sessionId: string | null;
  /** 当前幽灵形态；决定「是否已经有续写可看」。 */
  ghostKind: InlineArmGhostKind;
  /** 停顿续写开关。 */
  enabled: boolean;
  /** 触发所需的最小草稿字符数。 */
  minChars: number;
  /** 停顿时长（ms）。 */
  delayMs: number;
  /** IME 组词中：组合文本还不是最终意图，不提问。 */
  composing: boolean;
};

/** 一次「有效 armed」：一个待发送的 complete 请求及其身份。 */
export type InlineArmTicket = {
  sessionId: string;
  draft: string;
  ghostKind: InlineArmGhostKind;
  minChars: number;
  delayMs: number;
  /** 绝对到期时刻（ms）。同键重复观察时该值必须保持不变。 */
  dueAt: number;
};

/** 策略状态（可序列化，无函数）。 */
export type InlineArmState = {
  /** 当前在跑的计时器；null = 无计时器。 */
  ticket: InlineArmTicket | null;
  /** 最近一次实际发出 `complete` 的会话；与 {@link firedDraft} 一起构成去重键。 */
  firedSessionId: string | null;
  /** 最近一次实际发出 `complete` 的草稿。 */
  firedDraft: string | null;
  /** 被判定为「同键」而抑制的 render 次数（诊断用，不参与决策）。 */
  suppressed: number;
};

/** 决策动作。 */
export type InlineArmAction =
  /** 无计时器在跑且本次合格 → 起新表。 */
  | 'arm'
  /** 已有计时器但观察键变了（真实输入/切换/配置变更）→ 重起。 */
  | 'reset'
  /** 观察键未变（或已为该草稿发过请求）→ **不动**现有计时器。 */
  | 'skip'
  /** 不合格（开关关闭/无会话/未达阈值/组词中/已有续写）→ 清掉现有计时器且不新建。 */
  | 'cancel';

/** 决策原因（诊断用；同时是日志里的 `reason=` 字段）。 */
export type InlineArmReason =
  | 'first-arm'
  | 'draft-changed'
  | 'session-changed'
  | 'kind-changed'
  | 'config-changed'
  | 'same-observation'
  | 'already-fired'
  | 'disabled'
  | 'no-session'
  | 'below-min-chars'
  | 'composing'
  | 'completion-visible';

export type InlineArmDecision = {
  action: InlineArmAction;
  reason: InlineArmReason;
  /** arm/reset 的绝对到期时刻；其余动作为 null。 */
  dueAt: number | null;
  /** arm/reset 采用的停顿时长（等于观察值 `delayMs`，便于调用方算剩余时间）。 */
  delayMs: number;
  /** 触发本次 armed 的草稿/会话（skip/cancel 时为上一次的或 null）。 */
  draft: string;
  sessionId: string | null;
};

export type InlineArmOutcome = {
  state: InlineArmState;
  decision: InlineArmDecision;
};

/** 初始状态（插件启动、解绑、effect 卸载时都回到这里）。 */
export const initialInlineArmState = (): InlineArmState => ({
  ticket: null,
  firedSessionId: null,
  firedDraft: null,
  suppressed: 0,
});

/** 请求身份：一次 complete 只对「某会话的某份草稿」提出。 */
const firedMatch = (state: InlineArmState, obs: InlineArmObservation): boolean =>
  state.firedDraft !== null
  && state.firedSessionId === obs.sessionId
  && state.firedDraft === obs.draft;

/** 观察键是否变化；返回变化维度（未变返回 null）。 */
const changedDimension = (ticket: InlineArmTicket, obs: InlineArmObservation): InlineArmReason | null => {
  if (ticket.draft !== obs.draft) return 'draft-changed';
  if (ticket.sessionId !== obs.sessionId) return 'session-changed';
  if (ticket.ghostKind !== obs.ghostKind) return 'kind-changed';
  if (ticket.delayMs !== obs.delayMs || ticket.minChars !== obs.minChars) return 'config-changed';
  return null;
};

const decide = (
  state: InlineArmState,
  obs: InlineArmObservation,
  action: InlineArmAction,
  reason: InlineArmReason,
  ticket: InlineArmTicket | null,
  suppressed: number,
  /** 一次新的 armed 意味着请求对象已经换了一份草稿/会话，去重键随之作废。 */
  clearFired = false,
): InlineArmOutcome => ({
  state: {
    ticket,
    firedSessionId: clearFired ? null : state.firedSessionId,
    firedDraft: clearFired ? null : state.firedDraft,
    suppressed,
  },
  decision: {
    action,
    reason,
    dueAt: ticket === null ? null : ticket.dueAt,
    delayMs: ticket === null ? obs.delayMs : ticket.delayMs,
    draft: ticket === null ? obs.draft : ticket.draft,
    sessionId: ticket === null ? obs.sessionId : ticket.sessionId,
  },
});

/**
 * 唯一的决策入口：给定状态与本次观察，返回新状态与要执行的动作为一对。
 *
 * 判定顺序（前面的命中即返回，不再往下看）：
 *  1. 不合格条件（开关、会话、组词、阈值）→ `cancel`；
 *  2. 该草稿已有续写在显示（ghostKind==='inline'）→ `cancel`；
 *  3. 已有计时器且观察键未变 → `skip`（到期时刻保持不变，这是 #21 的核心）；
 *  4. 该 (会话, 草稿) 已发过请求 → `skip`（掐断写→推→render→再写的自循环）；
 *  5. 其余 → `arm`（无计时器）或 `reset`（有计时器但键变了）。
 */
export const decideInlineArm = (state: InlineArmState, obs: InlineArmObservation): InlineArmOutcome => {
  if (!obs.enabled) return decide(state, obs, 'cancel', 'disabled', null, state.suppressed);
  if (obs.sessionId === null) return decide(state, obs, 'cancel', 'no-session', null, state.suppressed);
  if (obs.composing) return decide(state, obs, 'cancel', 'composing', null, state.suppressed);
  if (obs.draft.trim().length < obs.minChars) {
    return decide(state, obs, 'cancel', 'below-min-chars', null, state.suppressed);
  }
  if (obs.ghostKind === 'inline') {
    return decide(state, obs, 'cancel', 'completion-visible', null, state.suppressed);
  }

  const { ticket } = state;
  if (ticket !== null && changedDimension(ticket, obs) === null) {
    // 同一次观察被重复送达（事件风暴、订阅多次通知）：**绝不**碰现有计时器。
    return decide(state, obs, 'skip', 'same-observation', ticket, state.suppressed + 1);
  }
  if (ticket === null && firedMatch(state, obs)) {
    return decide(state, obs, 'skip', 'already-fired', null, state.suppressed + 1);
  }

  const next: InlineArmTicket = {
    sessionId: obs.sessionId,
    draft: obs.draft,
    ghostKind: obs.ghostKind,
    minChars: obs.minChars,
    delayMs: obs.delayMs,
    dueAt: obs.now + obs.delayMs,
  };
  return decide(
    state,
    obs,
    ticket === null ? 'arm' : 'reset',
    ticket === null ? 'first-arm' : changedDimension(ticket, obs) ?? 'draft-changed',
    next,
    state.suppressed,
    // 一旦为新的 (会话, 草稿) 起表，上一份草稿的去重键即刻作废：否则「输入 A → 停顿
    // 发问 → 继续输入 B → 删回 A」这条再普通不过的路径会被永久锁死在 A 上。
    true,
  );
};

/**
 * 计时器回调开头必须调用：把 ticket 消费掉（本次 armed 已结束）。
 *
 * `sent` 非 null 表示真的发出了 `complete`（记下去重键，同草稿不再重复问）；
 * null 表示到期时草稿已不合格而什么都没发——**不**记去重键，用户继续输入或
 * 下一次 render 仍能为这份草稿重新计时。
 */
export const settleInlineTimer = (
  state: InlineArmState,
  sent: { sessionId: string; draft: string } | null,
): InlineArmState => ({
  ticket: null,
  firedSessionId: sent === null ? state.firedSessionId : sent.sessionId,
  firedDraft: sent === null ? state.firedDraft : sent.draft,
  suppressed: state.suppressed,
});

/**
 * 结构化等值比较（JSON 形状的值：原始值 / 数组 / 普通对象 / null / undefined）。
 *
 * 用于 `applySettings`：内核的事件只带 `(ns, revision)`，revision 变了**不代表**
 * 本插件关心的值变了（host 每次 `_push` 都推进 revision，而载荷里大部分字段常年
 * 不变）。值未变时若照样替换 `settings` 对象，就会 bump `settingsEpoch` → 缓存全废
 * → `render()` → 又一次 armed，把 #21 的风暴从「事件侧」放大到「渲染侧」。
 *
 * 先比引用（同一引用直接命中，host 省略 `history` 时保留的是旧数组引用），再递归。
 */
export const configValuesEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!configValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  const kb = Object.keys(rb);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(rb, k)) return false;
    if (!configValuesEqual(ra[k], rb[k])) return false;
  }
  return true;
};
