/**
 * 设置卡片依赖的 scope 最小面。
 *
 * 0.1.1/0.1.2/0.1.5 由内核 `settingsScope.bind({namespace})` 直接提供该形状；
 * 0.1.7 该服务随 settings.yaml 体系移除，改由 `remote.settings` 读写 volatile
 * 字段，故本类型在 client 侧本地声明，由 `remoteSettingsScope()` 适配器实现。
 *
 * **成员形状必须与 settings-card.tsx 的实际调用一致**（不是与 0.1.5 的旧 scope
 * 一致）：卡片按「store」消费——`getSnapshot()` 取当前值、`subscribe(fn)` 订阅、
 * `set(key, value)` 写入。早期这里声明的是 `get()` / `watch()` / `set()`，卡片却
 * 调 `getSnapshot()` / `subscribe()`，形状对不上会直接 `scope.getSnapshot is not
 * a function` 崩掉整张卡片。本文件以卡片的实际调用为准。
 *
 * 只声明卡片实际用到的成员，不照抄上游：一旦开始依赖别的成员会直接暴露为类型
 * 错误，逼迫去查新内核有没有对应能力，而不是静默拿到 undefined。
 */

/** 订阅者：收到变更通知（不传参数，调用方自行重读快照）。 */
export type ScopeListener = () => void;

export interface PluginSettingsScope<T> {
  /**
   * 当前解析值：schema 默认 → 插件 Config → 用户/volatile 覆盖。
   *
   * 必须是**引用稳定**的快照：卡片用它做 `useState` 初值，若每次返回新对象
   * 会让订阅回调每次都触发重渲染。
   */
  getSnapshot(): T;
  /**
   * 订阅快照变化（设置页轮询到新 revision 时触发）。
   * @param listener - 变更通知回调。
   * @returns 退订函数。
   */
  subscribe(listener: ScopeListener): () => void;
  /**
   * 写入单个字段（不经卡片的暂存/保存流程；热度管理面板等就地改写用）。
   * @param key - 字段名。
   * @param value - 字段值。
   * @returns 写入完成（卡片 `await` 它决定何时清暂存态）。
   */
  set(key: string, value: unknown): Promise<void>;
  /**
   * 停止轮询并释放资源（**只应由 scope 的所有者调用**，即槽位 disposer；
   * 卡片卸载绝不能调它——见 `remoteSettingsScope()` 的说明）。
   */
  dispose(): void;
}
