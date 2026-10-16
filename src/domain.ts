/**
 * dsh-suggest-ghost 领域类型：会话日志事件、投影与类型级模块扩展。
 * 事件/投影键通过 module augmentation 并入 DSH 官方类型图。
 * @module dsh-suggest-ghost/domain
 */

import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection/types';

/** `suggest-ghost/suggested` 事件的载荷——一条可用的下一条建议（whole-value）。 */
export interface SuggestGhostSuggested {
  /** 载荷结构版本。 */
  readonly version: 1;
  /** 建议对应的已完成回合号（turn/end 的 turn）。 */
  readonly turn: number;
  /** 转录中最新一条消息的事件 seq（用于归因）。 */
  readonly baseSeq: number;
  /** 建议文本（已脱敏、净化、单行、截断）。 */
  readonly text: string;
  /** 是否因 maxSuggestionChars 被截断。 */
  readonly truncated: boolean;
  /** 采纳快捷键（默认 "Tab"）。 */
  readonly acceptKey: string;
}

/** `suggest-ghost/request` 事件的载荷——辅助 LLM 调用前的记录（模型可见 ⟺ 日志可重建）。 */
export interface SuggestGhostRequested {
  readonly version: 1;
  readonly turn: number;
  readonly sourceMessageSeqs: readonly number[];
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
}

/** 跨会话热度索引里的一条：去重后的用户消息 + 出现频次。 */
export interface SuggestGhostHotEntry {
  /** 用户消息原文（去空白、去相邻重复后的净文本）。 */
  readonly text: string;
  /** 跨会话累计出现频次。 */
  readonly count: number;
  /** 用户固定（管理面板置顶，不参与最近性淘汰）；仅 true 时携带。 */
  readonly pinned?: boolean;
}

/**
 * 热度管理单条操作（client 管理面板经 settings `_ops` 通道送达 host）。
 * 所有操作幂等：重复执行无副作用（host 消费后立即清空 `_ops`，rev 仅用于
 * client 侧递增标识，host 不依赖它去重）。`pull` 不是热度变更：client 切换
 * 会话时请求 host 立即推送该会话的历史环（历史环只在事件到达时播种，
 * pull 关闭「切会话后无历史」的窗口）。
 */
export type HotnessOp =
  | { readonly op: 'delete'; readonly text: string }
  | { readonly op: 'pin'; readonly text: string; readonly pinned: boolean }
  | { readonly op: 'add'; readonly text: string; readonly pinned?: boolean }
  | { readonly op: 'clear' }
  | { readonly op: 'pull'; readonly sessionId: string }
  | { readonly op: 'complete'; readonly sessionId: string; readonly draft: string };

/**
 * `suggest-ghost/hot-index` 事件的载荷——跨会话历史热度快照。
 * host 在当前会话某回合结束时 append，携带除本会话外的 top-K 高频用户消息，
 * client 端用于历史前缀补全（代替逐会话枚举）。whole-value，last-wins。
 */
export interface SuggestGhostHotIndex {
  readonly version: 1;
  /** 快照对应的已完成回合号（归因/过期判断）。 */
  readonly turn: number;
  /** 热度覆盖的会话总数（含本会话，用于说明数据范围）。 */
  readonly sessionCount: number;
  /** 按热度（频次降序、最近优先）排列的条目。 */
  readonly entries: readonly SuggestGhostHotEntry[];
}

/** `suggestGhost` 会话投影的取值：整条建议或 null（无建议）。 */
export interface SuggestGhostProjection {
  /** 最新一条 LLM 下一条建议；尚未生成时为 null。 */
  readonly suggestion: SuggestGhostSuggested | null;
  /** 跨会话历史热度快照；未启用或尚无数据时为 null。 */
  readonly hot: readonly SuggestGhostHotEntry[] | null;
}

/** 会话日志事件名。 */
export const SUGGEST_EVENT = 'suggest-ghost/suggested' as const;
export const REQUEST_EVENT = 'suggest-ghost/request' as const;
export const HOT_INDEX_EVENT = 'suggest-ghost/hot-index' as const;

/** 投影单元名（client 通过 useProjection / faceOf 读取）。 */
export const PROJECTION_KEY = 'suggestGhost' as const;

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 只写日志的派发前记录：一次 suggest-ghost 模型请求。 */
    'suggest-ghost/request': SuggestGhostRequested;
    /**
     * 只写日志的成功建议：`suggestGhost` 投影 fold 的 whole-value 来源。
     * 每个事件携带完整的变更后建议，fold 为 last-wins。
     */
    'suggest-ghost/suggested': SuggestGhostSuggested;
    /**
     * 跨会话历史热度快照（host 回合结束时写入）。client 历史前缀补全的
     * 数据源，代替逐会话枚举；last-wins。
     */
    'suggest-ghost/hot-index': SuggestGhostHotIndex;
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * 会话的幽灵输入数据：最新 `suggest-ghost/suggested` 的下一条建议 +
     * 跨会话历史热度快照。client 幽灵文本读取它；过期建议按 `turn` 匹配。
     */
    suggestGhost: SuggestGhostProjection;
  }
}
