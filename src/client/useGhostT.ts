/**
 * 跟随宿主 DSH 界面语言的文案 hook（设置卡片用）。
 *
 * 宿主的 `@deepseek-ai/dsh-client-locale` 在 client context 上暴露 `locale`
 * 服务：`getSnapshot()` 返回携带 `active`/`revision` 的不可变快照，
 * `subscribe(fn)` 返回退订函数。本 hook 以 `useSyncExternalStore` 订阅其
 * active locale，宿主「设置 → General → Language」切换时组件无刷新重渲染。
 * locale 服务缺失（旧宿主组合）或 id 未收录时回退中文，行为与改造前一致。
 * 采用最小结构化接口（LocaleFaceLike）而非包类型，保持零运行时依赖。
 * @module dsh-suggest-ghost/client/useGhostT
 */
import { useCallback, useSyncExternalStore } from 'react';

/** 宿主 locale 服务的结构化子集（避免引入运行时包类型依赖）。 */
export interface LocaleFaceLike {
  /** 当前不可变快照（变更前引用稳定；`active` 为语言 id）。 */
  getSnapshot(): { active: string; revision: number };
  /** 订阅快照变化；返回退订函数。 */
  subscribe(fn: () => void): () => void;
}

/** 本插件支持的界面语言 id（zh 为源语言，en 为翻译目标）。 */
export type GhostLang = 'zh' | 'en';

const noopSubscribe = (): (() => void) => () => {};

/**
 * 返回当前应使用的语言 id；宿主语言切换时组件自动重渲染。
 * @param locale 宿主 locale 服务（经槽位 inject 注入；可为 undefined）。
 */
export function useGhostT(locale: LocaleFaceLike | undefined): GhostLang {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      locale === undefined ? noopSubscribe() : locale.subscribe(onStoreChange),
    [locale],
  );
  const getActive = useCallback(
    () => (locale === undefined ? 'zh' : locale.getSnapshot().active),
    [locale],
  );
  const active = useSyncExternalStore(subscribe, getActive, getActive);
  if (active === 'en') return 'en';
  if (active?.startsWith('zh')) return 'zh';
  return 'zh';
}
