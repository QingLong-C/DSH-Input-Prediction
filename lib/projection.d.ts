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
import type { SuggestGhostProjection } from './domain.js';
/** wire payload 校验 schema（注册时传给 sessionProjections.register）。 */
export declare const suggestGhostSchema: z.ZodObject<{
    suggestion: z.ZodNullable<z.ZodObject<{
        version: z.ZodLiteral<1>;
        turn: z.ZodNumber;
        baseSeq: z.ZodNumber;
        text: z.ZodString;
        truncated: z.ZodBoolean;
        acceptKey: z.ZodString;
    }, z.core.$strip>>;
    hot: z.ZodNullable<z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        count: z.ZodNumber;
    }, z.core.$strip>>>;
}, z.core.$strip>;
/** 空日志初始状态：无建议、无热度。 */
export declare function initSuggestGhostProjection(): SuggestGhostProjection;
/**
 * 纯 fold：last-wins。
 *  - `suggest-ghost/suggested` 替换 `suggestion`（忽略旧 turn 的乱序事件）；
 *  - `suggest-ghost/hot-index` 替换 `hot`（忽略旧 turn）。
 */
export declare function applySuggestGhostProjection(state: SuggestGhostProjection, event: SessionEvent): SuggestGhostProjection;
