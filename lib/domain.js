/**
 * dsh-suggest-ghost 领域类型：会话日志事件、投影与类型级模块扩展。
 * 事件/投影键通过 module augmentation 并入 DSH 官方类型图。
 * @module dsh-suggest-ghost/domain
 */
/** 会话日志事件名。 */
export const SUGGEST_EVENT = 'suggest-ghost/suggested';
export const REQUEST_EVENT = 'suggest-ghost/request';
export const HOT_INDEX_EVENT = 'suggest-ghost/hot-index';
/** 投影单元名（client 通过 useProjection / faceOf 读取）。 */
export const PROJECTION_KEY = 'suggestGhost';
