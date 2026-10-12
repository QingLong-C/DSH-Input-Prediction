/**
 * 有界辅助建议生成：转录提取、脱敏、路由解析、截止时间熔断的 LLM 调用、输出净化。
 * 与 session-title-llm 调用策略一致（字节上限、输出上限、截止时间、派发前记录）。
 * @module dsh-suggest-ghost/generate
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Volatile } from '@deepseek-ai/cosmokit';
import type { Session } from '@deepseek-ai/dsh-session';
import { PROJECTION_KEY } from './domain.js';
import type { SuggestGhostSuggested } from './domain.js';
import type { Transcript } from './transcript.js';
export { sessionEvents } from './coldstart.js';
/** 本能力所属的辅助请求超时错误码。 */
export declare const SUGGEST_TIMEOUT_CODE = "SUGGEST_GHOST_TIMEOUT";
/** host 插件配置（未校验版本）。 */
export interface Config {
    maxInputBytes: number;
    maxOutputTokens: number;
    timeoutMs: number;
    maxRecentTurns?: number;
    maxTranscriptChars: number;
    maxSuggestionChars: number;
    provider?: string;
    model?: string;
    acceptKey?: string;
    /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
    llmEnabled?: boolean;
}
/**
 * 0.1.7 的用户可调项。
 *
 * 取 `Volatile<T> | T` 联合类型而非只取 `Volatile<T>`：0.1.7 把这些字段解析成
 * cosmokit 引用（读值走 `.get()`），而 0.1.5/0.1.2 时代它们是裸值。`readVolatile`
 * 同时认得两种形态，故类型层也必须同时容纳。
 */
export interface EditableConfig {
    llmEnabled?: Volatile<boolean> | boolean;
    historyEnabled?: Volatile<boolean> | boolean;
    historyCrossSession?: Volatile<boolean> | boolean;
    historyMaxEntries?: Volatile<number> | number;
    historyMinChars?: Volatile<number> | number;
    wordAccept?: Volatile<boolean> | boolean;
    acceptKey?: Volatile<string> | string;
    languageMode?: Volatile<string> | string;
    uiLocaleWeight?: Volatile<number> | number;
}
/** 内核解析后的插件配置：策略字段是裸值，可调字段是引用。 */
export type ResolvedPluginConfig = Config & EditableConfig;
/** 拍平后的配置：策略字段 + 可调字段，全部是裸值。 */
export type FlatConfig = Config & {
    llmEnabled: boolean;
    historyEnabled: boolean;
    historyCrossSession: boolean;
    historyMaxEntries: number;
    historyMinChars: number;
    wordAccept: boolean;
    acceptKey: string;
    languageMode: string;
    uiLocaleWeight: number;
};
/**
 * 把插件配置拍平成「策略 + 可调」的裸值视图。0.1.7 的可调项是引用，其余代码
 * （effective()、client 渲染、热度快照上限）都按裸值读，不必知道代次差异。
 */
export declare function flattenConfig(config: ResolvedPluginConfig): FlatConfig;
/** 校验并返回不可变配置。 */
export declare function resolveConfig(config: Config): Config;
/** 建议生成指令：只预测用户下一条提示词，禁止生成内容或元文本。 */
export declare function systemPrompt(maxSuggestionChars: number, language: string): string;
/**
 * 从会话日志构建模型可见转录：最近 `maxRecentTurns` 个已完成回合的
 * user/assistant 消息（默认 1 = 只取最后一轮），脱敏，依次按字符预算
 * （`maxTranscriptChars`）与 UTF-8 字节预算（`maxInputBytes`）截尾。
 */
export declare function buildTranscript(session: Session, maxRecentTurns: number, maxTranscriptChars: number, maxInputBytes: number): Transcript | undefined;
/**
 * 为一个已完成回合生成建议。模型产出空或不合格回复 = 无建议（静默返回
 * undefined），真实失败抛错。
 *
 * 辅助调用带**有界重试**（默认共 3 次尝试，1.2s/2.4s 退避）：主循环对
 * EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT 类瞬时错误有 5 次重试，
 * 而建议调用是单发——不稳定窗口里会整轮静默失败（实测发生过）。被外部
 * 中止（新回合取代/卸载）时不重试。
 */
export declare function generateSuggestion(ctx: Context, config: Config, session: Session, turn: number, signal: AbortSignal, uiLocale?: string, languageMode?: string, uiLocaleWeight?: number, lastLanguage?: string): Promise<{
    suggestion: SuggestGhostSuggested | undefined;
    language: string;
}>;
export { PROJECTION_KEY };
