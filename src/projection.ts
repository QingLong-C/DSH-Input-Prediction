/**
 * `suggestGhost` 投影单元：last-wins fold 纯函数 + wire schema。
 * 框架对每个已提交会话事件驱动 `apply`；不相关事件必须返回同一引用。
 * 投影携带两块数据：
 *  - `suggestion`：最新 `suggest-ghost/suggested` 的下一条建议（last-wins）；
 *  - `hot`：跨会话历史热度快照（`suggest-ghost/hot-index`，last-wins）。
 * @module dsh-suggest-ghost/projection
 */

import { z } from 'zod';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { HOT_INDEX_EVENT, SUGGEST_EVENT } from './domain.js';
import type { SuggestGhostHotIndex, SuggestGhostProjection, SuggestGhostSuggested } from './domain.js';

/** Suggestion 块的 wire schema。 */
const suggestionSchema = z.object({
  version: z.literal(1),
  turn: z.number().int().nonnegative(),
  baseSeq: z.number().int().nonnegative(),
  text: z.string(),
  truncated: z.boolean(),
  acceptKey: z.string(),
});

/** 单个热度条目的 wire schema。 */
const hotEntrySchema = z.object({
  text: z.string(),
  count: z.number().int().nonnegative(),
});

/** wire payload 校验 schema（注册时传给 sessionProjections.register）。 */
export const suggestGhostSchema = z
  .object({
    suggestion: suggestionSchema.nullable(),
    hot: z.array(hotEntrySchema).nullable(),
  });

/** 空日志初始状态：无建议、无热度。 */
export function initSuggestGhostProjection(): SuggestGhostProjection {
  return { suggestion: null, hot: null };
}

/**
 * 纯 fold：last-wins。
 *  - `suggest-ghost/suggested` 替换 `suggestion`（忽略旧 turn 的乱序事件）；
 *  - `suggest-ghost/hot-index` 替换 `hot`（忽略旧 turn）。
 */
export function applySuggestGhostProjection(
  state: SuggestGhostProjection,
  event: SessionEvent,
): SuggestGhostProjection {
  if (event.type === HOT_INDEX_EVENT) {
    const hot = event.data as unknown as SuggestGhostHotIndex;
    const currentTurn = state.suggestion?.turn ?? -1;
    if (hot.turn < currentTurn) return state;
    return { suggestion: state.suggestion, hot: hot.entries };
  }
  if (event.type !== SUGGEST_EVENT) return state;
  const suggested = event.data as unknown as SuggestGhostSuggested;
  const current = state.suggestion;
  // 忽略旧于当前建议的乱序事件（last-wins）。
  if (current !== null && suggested.turn <= current.turn) return state;
  return {
    suggestion: {
      version: 1,
      turn: suggested.turn,
      baseSeq: suggested.baseSeq,
      text: suggested.text,
      truncated: suggested.truncated,
      acceptKey: suggested.acceptKey,
    },
    hot: state.hot,
  };
}
