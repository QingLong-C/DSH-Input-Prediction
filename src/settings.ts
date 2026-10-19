/**
 * `suggest-ghost` 的 settings 传输形状与配置合并。
 *
 * ## 0.1.7 的机制变化
 *
 * 内核移除了 `settings.yaml` 体系：`SettingsProvider.register()` 与
 * `SettingsScope<T>` 都不复存在，`ctx.settings` 变为 `SettingsForms`。命名空间
 * 不再由插件注册——内核把**插件自己的 Config schema**（其中 `.volatile()` 的
 * 字段）投影成 WebUI 表单，ns 即 Loader 条目 id（`suggest-ghost`）。所以：
 *
 *  - 用户可调项声明在 `index.ts` 的 `Config` 里（见那里的 `EditableFields`）；
 *  - host 写入经 `ctx.settings.update(ns, patch)`；
 *  - client 读取经 `ctx.remote.settings.describe()`；
 *  - 变更通知经 `settings/document-updated(ns, revision)` 事件。
 *
 * 本文件因此只保留两件事：`_push` / `_ops` 两个 JSON 载荷的**传输形状**，
 * 以及把 live 值合并回生成配置。schema 本身在 `Config` 里。
 * @module dsh-suggest-ghost/settings
 */

import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import type { FlatConfig } from './generate.js';

/**
 * 命名空间名：等于 Loader 条目 id（见 cordis.patch.yml 的 `- id: suggest-ghost`）。
 * 不用官方 `settingsNamespace()` helper——它在 DSH 0.1.2 内核已被删除，运行时
 * 导入会让本模块链接失败；该 helper 仅是校验后原样返回同样的字符串。
 */
export const SUGGEST_GHOST_NAMESPACE = 'suggest-ghost' as SettingsNamespace;

/** `_push` / `_ops` 的空载荷（JSON 字符串的 null 表示）。 */
export const EMPTY_PUSH = 'null';

/**
 * host → client 推送载荷（`_push` 字段的 JSON 形态）。
 *
 * 跨会话单份载荷 + `*SessionId` 归属字段：client 据此只在同会话显示建议 /
 * 使用历史环。0.1.7 里字段载体从 `SettingsScope` 换成 volatile 配置字段，
 * **载荷结构不变**，故 client 的守卫逻辑也无需改动。
 */
export interface GhostPushPayload {
  /** 递增标识新值。 */
  readonly rev: number;
  /** 最新 LLM 建议；null = 无建议。 */
  readonly suggestion: {
    readonly turn: number;
    readonly baseSeq: number;
    readonly text: string;
    readonly truncated: boolean;
    readonly acceptKey: string;
  } | null;
  /** 建议所属会话（null = 无有效建议）。 */
  readonly suggestionSessionId: string | null;
  /** 跨会话热度快照（top-K）。 */
  readonly hot: readonly { text: string; count: number; pinned?: boolean }[] | null;
  /** 热表总条目数（管理面板「共 N 条」展示）。 */
  readonly total: number;
  /** 本会话历史环；缺省表示不携带（client 保留现值）。 */
  readonly history?: readonly string[];
  /** history 所属会话。 */
  readonly historySessionId?: string;
  /** 最近一次生成失败的摘要（可诊断）。 */
  readonly error?: string;
}

/** `_push` / `_ops` 在 settings 里的传输形状（两个 JSON 字符串）。 */
export interface SuggestGhostSettings {
  /** host → client 的实时推送载荷（见 `GhostPushPayload`）。 */
  _push: string;
  /** client → host 的热度管理操作队列（见 `parseHotnessOps`）。 */
  _ops: string;
}

/**
 * 把 live 值合并回生成配置：路由对为空串时回退到插件配置的继承语义
 * （不显式传 provider/model → generateSuggestion 继承主请求路由）。
 *
 * **第一入参 = 默认层，第二入参 = 覆盖层**（`{...plugin, ...live, ...route}`）。
 * #19 之后 `live` 允许是**部分**视图：实时值由 `live-settings.pickLiveSettings()`
 * 从 `settings.describe()` 的 `row.value` 提炼，只有「内核这一行里确实有、且校验
 * 通过」的键才在对象上，缺席的键由 `{ ...plugin }` 兜底（= 回落到插件配置 / 默认值）。
 * 路由判据写成 `live.provider ?? ''` 本来就得容忍未覆盖。
 * @param plugin - 默认层：boot 解析 + 拍平后的插件配置。
 * @param live - 覆盖层：实时读到的用户可调项（可以是部分键）。
 */
export function effectiveConfig(plugin: FlatConfig, live: Partial<FlatConfig>): FlatConfig {
  const liveProvider = live.provider ?? '';
  const liveModel = live.model ?? '';
  const route = liveProvider.trim() !== '' && liveModel.trim() !== ''
    ? { provider: liveProvider.trim(), model: liveModel.trim() }
    : ((plugin.provider ?? '').trim() !== '' && (plugin.model ?? '').trim() !== ''
      ? { provider: plugin.provider, model: plugin.model }
      : {});
  return {
    ...plugin,
    ...live,
    ...route,
  };
}

/**
 * host 的实时合并策略：`effectiveConfig` 的包装，专门处理「路由对被**清空**」。
 *
 * `bootSettings` 只是同一个 volatile 字段的**旧读取结果**（#19 的失效快照），不是一个
 * 独立的配置层。所以实时行里 provider/model 在场时它才是权威值——包括空串（= 继承
 * 主请求路由，见 generate.routeOf 的判据）。若仍然让 boot 当回退层，用户在设置页
 * **清空** provider/model 会被 boot 里的旧路由复活，正好复刻 #19 那个「改了不生效」。
 * 这里在实时值带上这一对时把回退层的路由置空；实时行没给这一对（describe 不可用 /
 * 老代次未渲染）时按原样回落到 boot，保持迁移前的行为。
 * @param boot - 默认层（boot 快照）。
 * @param live - 覆盖层（describe() 提炼的实时值）。
 */
export function mergeLiveConfig(boot: FlatConfig, live: Partial<FlatConfig>): FlatConfig {
  const routeIsLive = Object.hasOwn(live, 'provider') && Object.hasOwn(live, 'model');
  return effectiveConfig(routeIsLive ? { ...boot, provider: '', model: '' } : boot, live);
}
