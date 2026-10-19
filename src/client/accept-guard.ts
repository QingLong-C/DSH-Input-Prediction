/**
 * 采纳写入的草稿 CAS 守卫（Gitea #4）——纯逻辑，零 DOM、零宿主依赖。
 *
 * ## 要闭合的窗口
 *
 * 「采纳建议」（Tab 整条 / `→` 逐词）是一条**读-改-写**：读草稿 → 拼出
 * `accepted` → `setDraft(accepted)`。读与写之间只要有一次用户键击落到草稿
 * （原生 input 会先于 React 渲染到达，宿主 store 也在编辑器提交后才发布），
 * 写入就会把这段新输入**整段覆盖**——用户打的字无声消失。
 *
 * ## 判据（两条采纳路径共用这一份）
 *
 * 1. **首选版本号比对**：宿主 `InputState.draftRev` 是单调编辑器修订号
 *    （`@deepseek-ai/dsh-client-ui-conversation` 0.2.0-rc.2 已对外发布该字段；
 *    其自增条件是草稿投影 `clipboardText`/`detectText`/引用 chip 列表变化，
 *    **纯光标移动不推进**，所以可以安全地拿来 CAS）。计算 `accepted` 所用
 *    快照的 `base.rev` 与写入前重读的 `live.rev` 不等即放弃。
 * 2. **文本判据始终参与**：`base.draft !== live.draft` 一律放弃——老宿主或
 *    rev 语义漂移时，这是唯一可靠的「用户输入是否还在」的证据。
 * 3. **退化方案**：face 上没有 `draftRev`（宿主版本较旧 / 非 conversation
 *    实现）时，rev 记为 `null` 并退化为纯**内容等值**比对。残余风险必须
 *    知晓：内容等值只证明「store 投影未变」，不证明「编辑器实例未变」——
 *    若宿主把一次编辑器提交批处理在 store 发布之前，同一 tick 内读到的
 *    `draft` 与 `draftRev` 会一起是旧值，这个窗口就仍然敞着。真正闭合它需要
 *    宿主把原子插入 verbs（`captureInsertion()` + `insertText(text, span)`，
 *    捕获坐标与修订号同源于编辑器而非 store）交到插件手上。
 *
 * ## 为什么不用宿主的 `insertText(text, span)`
 *
 * 采纳写入是**整段草稿替换**（历史补全要回填斜杠命令前缀段、LLM 建议直接
 * 覆盖整段草稿），而 `insertText` 是 span 拼接语义：span 坐标取自编辑器
 * 文档（含引用 chip 的投影差异），与 `draft` 字符串的坐标系并不一致。用
 * 「整段 span」模拟替换会引入新的坐标假设，比版本号 CAS 更脆。故这里走
 * 「校验后 `setDraft`」，并在放弃时什么都不写。
 *
 * ## 放弃时的动作
 *
 * 本模块只给判定与「是否真的写了」。隐藏幽灵由调用方负责（复用既有的
 * `overlay.hide()` + `shown = null`），保持模块可单测。
 *
 * @module dsh-suggest-ghost/client/accept-guard
 */

import { stripCommandPrefix } from './history.ts';

/** 一次草稿快照读取中与采纳有关的两个量。 */
export interface DraftSnapshot {
  /** 草稿文本（宿主 `InputState.draft`，引用 chip 展开后的剪贴板投影）。 */
  readonly draft: string;
  /** 宿主编辑器修订号（`InputState.draftRev`）；face 未提供时为 `null`。 */
  readonly rev: number | null;
}

/** 放弃采纳的原因（诊断用）。 */
export type DraftAbandonReason =
  | 'draft-changed'
  | 'rev-changed';

/** 一次 CAS 提交的结果。 */
export interface DraftCasOutcome {
  /** 是否执行了 `write()`。 */
  readonly committed: boolean;
  /** 未提交时：放弃原因（版本号漂移 / 内容漂移）。 */
  readonly reason: DraftAbandonReason | null;
}

/**
 * 从宿主输入机快照里读采纳所需的两量。
 *
 * 只接受**同一个对象**上的 `draft` 与 `draftRev`——分两次读会把「文本」与
 * 「版本」取自不同帧，CAS 就失去意义。face 形态不完整时（缺字段 / 非对象）
 * 保守地返回空草稿 + `rev: null`，让判据退化为内容等值比对而不是抛错。
 */
export function readDraftSnapshot(raw: unknown): DraftSnapshot {
  if (raw === null || typeof raw !== 'object') return { draft: '', rev: null };
  const state = raw as { draft?: unknown; draftRev?: unknown };
  const draftValue = state.draft;
  const revValue = state.draftRev;
  return {
    draft: typeof draftValue === 'string' ? draftValue : '',
    rev: typeof revValue === 'number' && Number.isFinite(revValue) ? revValue : null,
  };
}

/**
 * 计算所用快照与写入前重读的快照是否仍指同一份草稿。
 *
 * 顺序：先看文本（必要条件，也是无 rev 时的唯一判据），再看版本号
 * （两边都有 rev 时额外要求一致，用于捕捉「文本巧合相同但编辑器已变」）。
 */
export function isDraftPristine(base: DraftSnapshot, live: DraftSnapshot): boolean {
  if (base.draft !== live.draft) return false;
  if (base.rev !== null && live.rev !== null) return base.rev === live.rev;
  return true;
}

/** 放弃原因（`isDraftPristine` 已给出布尔，这里只为日志/单测取因）。 */
export function draftDriftReason(base: DraftSnapshot, live: DraftSnapshot): DraftAbandonReason | null {
  if (base.draft !== live.draft) return 'draft-changed';
  if (base.rev !== null && live.rev !== null && base.rev !== live.rev) return 'rev-changed';
  return null;
}

/**
 * 草稿未被外部改动时才执行写入；否则什么都不做并回报放弃。
 *
 * 调用方在**计算** `accepted` 时所用快照与**紧邻写入之前**重读的快照之间
 * 用它，`write` 里放 `setDraft`。返回值供调用方决定是否隐藏幽灵。
 */
export function commitDraftIfPristine(
  base: DraftSnapshot,
  live: DraftSnapshot,
  write: () => void,
): DraftCasOutcome {
  const reason = draftDriftReason(base, live);
  if (reason !== null) return { committed: false, reason };
  write();
  return { committed: true, reason: null };
}

/**
 * 可采纳的幽灵内容（与 index.ts 的 `GhostContent` 结构兼容：判别联合，
 * 成员按需携带 `text` / `full`）。本模块只读这几个字段，故声明得比宿主
 * 类型更松，避免与 index.ts 互相依赖。
 */
export type AcceptableContent =
  | { kind: 'llm'; text: string; acceptKey?: string }
  | { kind: 'inline'; prefix: string; suffix: string; full: string }
  | { kind: 'history'; prefix: string; suffix: string; full: string };

/** 采纳整段时的目标全文（逐词采纳的完成判定也用它）。 */
export function acceptTarget(content: AcceptableContent): string {
  return content.kind === 'llm' ? content.text : content.full;
}

/**
 * 整条采纳（Tab）的目标文本。
 *
 * - `llm`：直接覆盖草稿（幽灵本就出现在空草稿上，无前缀可接）。
 * - `inline`：停顿续写，`full` 已含命令前缀，整段替换。
 * - `history`：草稿若是斜杠命令整行（如 `/later +3m 我`），候选 `full` 是
 *   历史里的「内容」部分（命令 `recordInput:false`，不带命令名+参数），
 *   必须把命令前缀段回填，否则用户的命令意图被破坏、只剩内容部分。
 *
 * @param content - 幽灵内容（按**显示时**的草稿算出）。
 * @param draftAtCompute - 计算该幽灵内容所用的草稿（CAS 的 base.draft）。
 */
export function buildFullAccept(content: AcceptableContent, draftAtCompute: string): string {
  if (content.kind === 'llm') return content.text;
  if (content.kind === 'inline') return content.full;
  const contentDraft = stripCommandPrefix(draftAtCompute);
  // 命令整行：contentDraft 是「内容部分」，不含命令名+参数。还原时把
  // draft 头部到 contentDraft 之前的那段（命令名、时间参数、其间的空白）
  // 一并保留，再接 content.full。
  const head = contentDraft === ''
    ? draftAtCompute
    : draftAtCompute.slice(0, draftAtCompute.length - contentDraft.length);
  const tailJoiner = head.endsWith(' ') || head === '' ? '' : ' ';
  return `${head}${tailJoiner}${content.full}`;
}

/**
 * 逐词采纳的前缀匹配基准：命令整行要用剥掉命令前缀后的内容部分去匹配
 * 候选（候选里没有命令名+参数），其余形态直接用草稿本身。
 */
export function wordMatchBase(content: AcceptableContent, draftAtCompute: string): string {
  return content.kind === 'history' ? stripCommandPrefix(draftAtCompute) : draftAtCompute;
}

/**
 * 逐词采纳（`→`）前进一个片段后的目标草稿。
 *
 * 命令整行同样回填 head（含时间参数）段，与整条采纳保持一致。
 */
export function buildWordAccept(
  content: AcceptableContent,
  draftAtCompute: string,
  matchBase: string,
  chunk: string,
): string {
  if (content.kind !== 'history') return draftAtCompute + chunk;
  // draft 头部到 matchBase 之前是命令前缀段（含时间参数），随逐词采纳保留。
  const head = matchBase === ''
    ? draftAtCompute
    : draftAtCompute.slice(0, draftAtCompute.length - matchBase.length);
  const tailJoiner = head.endsWith(' ') || head === '' ? '' : ' ';
  return `${head}${tailJoiner}${matchBase}${chunk}`;
}

/**
 * 逐词采纳后建议是否已被吃干净（该收掉幽灵了）。
 *
 * 历史补全下 `accepted` 带着命令前缀段，比候选 `full` 长，故用后缀判定。
 */
export function wordAcceptSettled(content: AcceptableContent, accepted: string): boolean {
  const full = acceptTarget(content);
  return accepted === full || (content.kind === 'history' && accepted.endsWith(full));
}
