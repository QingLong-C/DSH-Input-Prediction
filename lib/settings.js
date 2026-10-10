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
/**
 * 命名空间名：等于 Loader 条目 id（见 cordis.patch.yml 的 `- id: suggest-ghost`）。
 * 不用官方 `settingsNamespace()` helper——它在 DSH 0.1.2 内核已被删除，运行时
 * 导入会让本模块链接失败；该 helper 仅是校验后原样返回同样的字符串。
 */
export const SUGGEST_GHOST_NAMESPACE = 'suggest-ghost';
/** `_push` / `_ops` 的空载荷（JSON 字符串的 null 表示）。 */
export const EMPTY_PUSH = 'null';
/**
 * 把 live 值合并回生成配置：路由对为空串时回退到插件配置的继承语义
 * （不显式传 provider/model → generateSuggestion 继承主请求路由）。
 */
export function effectiveConfig(plugin, live) {
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
