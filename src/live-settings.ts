/**
 * 用户可调项的实时读值（Gitea #19 遗留段）。
 *
 * ## 为什么需要这一层
 *
 * host 的 `apply(ctx, config)` 里 `resolved = resolveConfig(config)` 是**首次解析
 * 产物的深冻结快照**：`resolveConfig` 当场用 `readVolatile` 把 volatile 引用读成
 * 裸值再 `deepFreeze`。内核之后每次配置写入走
 * `configEditor.edit → mergeLayers → 重解析`，替换的是 fiber 持有的**新** config
 * （新引用），旧引用不回填——于是用户在设置页改 `inlineEnabled` / 阈值，运行中的
 * 进程读 `flattenConfig(resolved)` 仍是 boot 值，重启才生效（#19 现象）。
 *
 * `settings` 服务的 `describe()` 每次现读 `entry.fiber.config` 并用 `plainConfig`
 * 展开 volatile，是插件内唯一可靠的实时值来源（与已修的 `readOps` 同一依据，
 * commit 8d5918e）。本模块把「`describe()` 的 `row.value` → `FlatConfig` 覆盖值」
 * 与「缓存 / 失效」两件事抽成纯函数 + 纯状态机，host 只做接线，smoke 可直接驱动。
 *
 * ## `_ops` / `_push` 不是设置项
 *
 * 这两个字段是 volatile **传输载体**（`_ops`：client→host 热度操作队列；
 * `_push`：host→client 推送载荷——见 settings.ts 的 `SuggestGhostSettings` 与
 * domain.ts 的 `HotnessOp`）。它们和真设置项一样标了 `.volatile()`，所以
 * `describe()` 的 `row.value` 里**必然混着**它们。若整份 spread 进 effective()，
 * JSON 字符串会被当成配置值读走。这里用**白名单**挡在外面：覆盖值只按
 * `SETTING_SPECS`（= `keyof FlatConfig` 全集）逐键取，而 `_ops` / `_push` 不是
 * `FlatConfig` 的键——类型层成立，另加一条加载期不变量兜住绕过类型的改法。
 *
 * ## 依赖形状
 *
 * 只有 `import type`：`generate.ts` 用了 `using` 声明，
 * `node --experimental-strip-types` 剥不动它（smoke 直接导会在加载期炸），
 * 所以本模块不 import 它的运行时代码，合并策略由调用方注入。
 * @module dsh-suggest-ghost/live-settings
 */

import type { FlatConfig } from './generate.js';

/**
 * volatile 载体里**不属于设置项**的传输字段。见模块头「`_ops` / `_push` 不是设置项」。
 * `readOps` 继续按它自己的路径读这两个字段；本模块只保证它们不进 effective()。
 */
export const TRANSPORT_KEYS: readonly string[] = Object.freeze(['_ops', '_push']);

/**
 * 单字段取值校验，与 `index.ts` 的 `EditableFields` schema 逐条对应：
 * `z.boolean()` → boolean；`z.string()` → string（`allowEmpty` 标记「空串合法」：
 * provider / model 的空串是「继承」语义，`acceptKey` 的 `min(1)` 则拒绝空串）；
 * `z.natural().min(n)` → 整数 + 区间。
 */
type FieldSpec =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'string'; readonly allowEmpty: boolean }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number };

/**
 * 区间上界：`MAX_TIMER_DELAY_MS`（dsh-timeout，2147483647）。超时字段必须卡在
 * 同一上限，否则 `deadline()` 自己抛。其他数值字段用它当「足够大的正整数上界」，
 * 顺带挡住 `Infinity` / 溢出值把生成逻辑带偏。
 */
const MAX_INT = 2_147_483_647;

const BOOL: FieldSpec = { kind: 'boolean' };
const STR = (allowEmpty: boolean): FieldSpec => ({ kind: 'string', allowEmpty });
/** 正整数（含 min）。 */
const POS = (min: number): FieldSpec => ({ kind: 'integer', min, max: MAX_INT });
/** 非负整数（0 合法 = 「不限 / 关闭该维度」）。 */
const NAT = (min: number): FieldSpec => ({ kind: 'integer', min, max: MAX_INT });

/**
 * 设置键表 = 「可以从 `describe().value` 读进 effective() 的字段」全集。
 *
 * 标注直接落在对象字面量上（不让它先过 `Object.freeze` 的泛型推理），于是 TS 的
 * 多余属性检查生效，两侧都卡住：
 *  - **漏键**（加了可调项没加校验）→ 报缺属性，不会静默读不到；
 *  - **多键**（把 `_ops` / `_push` 这类传输载体写进来）→ 报「不在
 *    `keyof FlatConfig` 中」——它们不是 `FlatConfig` 的键。
 * 白名单因此在类型层成立；下面另有一条同义的加载期不变量，防住绕过类型的改法。
 */
const SETTING_SPECS: Record<keyof FlatConfig, FieldSpec> = {
  // —— 生成策略（同样标了 .volatile()，设置页可改）——
  maxInputBytes: POS(1),
  maxOutputTokens: POS(1),
  timeoutMs: POS(1),
  maxRecentTurns: POS(1),
  maxTranscriptChars: POS(1),
  maxSuggestionChars: POS(1),
  contextSummaryEnabled: BOOL,
  contextSummaryChars: POS(100),
  provider: STR(true),
  model: STR(true),
  // —— 开关与阈值（#19 现象的主体）——
  llmEnabled: BOOL,
  inlineEnabled: BOOL,
  inlineDelayMs: POS(100),
  inlineMinChars: POS(1),
  inlineMaxChars: POS(1),
  historyEnabled: BOOL,
  historyCrossSession: BOOL,
  historyMaxEntries: NAT(0),
  historyMinChars: POS(1),
  wordAccept: BOOL,
  acceptKey: STR(false),
  languageMode: STR(true),
  uiLocaleWeight: NAT(0),
};
Object.freeze(SETTING_SPECS);

/** 本模块认得的全部设置键（诊断与测试用；等于 `keyof FlatConfig`）。 */
export const SETTING_KEYS: readonly (keyof FlatConfig)[] = Object.freeze(
  Reflect.ownKeys(SETTING_SPECS) as (keyof FlatConfig)[],
);

// 加载期不变量：传输载体绝不能出现在设置键表里。只有人绕过类型把 `_ops`/`_push`
// 塞进 SETTING_SPECS 才可能触发，那是必须立刻暴露的编码错误（它会把 JSON 载荷当
// 配置值读进 effective()），所以直接抛而不是等运行时发现。
for (const key of TRANSPORT_KEYS) {
  if (Object.hasOwn(SETTING_SPECS, key)) {
    throw new Error(`dsh-suggest-ghost: transport field "${key}" must not be a setting key`);
  }
}

/**
 * 展开一个可能仍是 volatile 引用的值。
 * `describe()` 内部的 `plainConfig()` 已经把引用展开成裸值，但回退路径（直接读
 * 插件自己的 config 对象）与不同内核代次可能仍给到 `{ get() }`，这里统一兜住。
 */
function plain(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    const getter = (value as { get?: unknown }).get;
    if (typeof getter === 'function') return (getter as () => unknown).call(value);
  }
  return value;
}

/** 按 spec 校验：通过返回裸值，否则 undefined（= 丢弃，交调用方回落）。 */
function coerce(value: unknown, spec: FieldSpec): unknown {
  const raw = plain(value);
  switch (spec.kind) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'string':
      if (typeof raw !== 'string') return undefined;
      // allowEmpty=false（acceptKey）：空串 = 未填 → 丢弃后回落 boot 值。
      return spec.allowEmpty || raw.trim().length > 0 ? raw : undefined;
    case 'integer': {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
        return undefined;
      }
      return raw >= spec.min && raw <= spec.max ? raw : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * 从 `describe()` 本 ns 行的 `value` 里提炼**设置覆盖值**。
 *
 * 只产出白名单内、且校验通过的键；其余一律缺席（合并时自然回落到 boot 快照）。
 * `_ops` / `_push` 以及任何非 `FlatConfig` 键上的东西不可能出现在返回值里——因为
 * 遍历的是**键表**而不是 `row.value` 的键，传输字段天然落不进配置。
 *
 * 校验失败**丢弃该键**而不是抛：本函数在读热路径上被调用，一个手改坏的 patch
 * 不该让 host 崩，也不该让建议功能整体失效。
 * @param rowValue - `row.value`（形状不可信：可能是 null / 数组 / 引用形态）。
 */
export function pickLiveSettings(rowValue: unknown): Partial<FlatConfig> {
  const source = plain(rowValue);
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return {};
  const box = source as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(SETTING_SPECS) as [keyof FlatConfig, FieldSpec][]) {
    // 键缺席 = 内核这行没给这一项（老代次 / 未渲染）：不覆盖，交合并回落 boot 值。
    if (!Object.hasOwn(box, key)) continue;
    const value = coerce(box[key], spec);
    if (value !== undefined) picked[key] = value;
  }
  return picked as Partial<FlatConfig>;
}

/**
 * 从 `describe()` 的返回值里取本 ns 的 `row.value`。
 * 容忍两种形状：直接数组（0.1.7 服务端 `describe(): SettingsNamespaceView[]`）与
 * `{ namespaces: [...] }` 包装（远端 / 代理层）。读不到返回 undefined。
 */
export function pickNamespaceValue(described: unknown, ns: string): unknown {
  return pickNamespaceRow(described, ns)?.value;
}

/** 同上，但返回整行（要看 `revision` 时用）。行不存在 → undefined。 */
export function pickNamespaceRow(
  described: unknown,
  ns: string,
): { readonly value?: unknown; readonly revision?: number } | undefined {
  const envelope = plain(described) as { readonly namespaces?: unknown } | unknown;
  const rows = Array.isArray(envelope)
    ? envelope
    : Array.isArray((envelope as { readonly namespaces?: unknown })?.namespaces)
      ? ((envelope as { readonly namespaces: readonly unknown[] }).namespaces)
      : [];
  for (const candidate of rows) {
    const row = plain(candidate);
    if (row !== null && typeof row === 'object' && (row as { ns?: unknown }).ns === ns) {
      return row as { value?: unknown; revision?: number };
    }
  }
  return undefined;
}

/** 一次刷新的诊断结果（host 接 console/logger；纯缓存本身不打日志，保持可单测）。 */
export interface LiveRefreshInfo {
  /** 本次是否拿到权威实时值。false = describe 未注入 / 抛异常 / 无本 ns 行。 */
  readonly ok: boolean;
  /** 应用了多少个键（0 也可能 ok=true：实时视图与 boot 无差异仍是权威值）。 */
  readonly applied: number;
  /** 本 ns 行的 revision（describe 未给出时 undefined）。 */
  readonly revision: number | undefined;
  /** 失败原因（仅 ok=false）。 */
  readonly reason?: 'describe-threw' | 'row-missing';
  /** describe 抛出的异常文本（仅 describe-threw）。 */
  readonly error?: string;
}

export interface LiveSettingsOptions {
  /** 本插件的 settings 命名空间（= Loader 条目 id）。 */
  readonly ns: string;
  /**
   * 现读 `settings.describe()` 的结果。返回 undefined（服务未注入）或抛异常都安全：
   * 读源把它降级成「没有权威实时值」，继续用上一次快照 / boot 默认层，绝不让 host 崩。
   */
  readonly readDescribe: () => unknown;
  /**
   * 合并策略：把覆盖值合进 boot 默认层。默认浅合并；host 注入
   * `settings.mergeLiveConfig`（内部走 `effectiveConfig`），以保留「provider/model
   * 留空 = 继承主请求路由」的既有语义，并让「实时清空路由对」生效。
   */
  readonly merge?: (boot: FlatConfig, override: Partial<FlatConfig>) => FlatConfig;
  /** 每次刷新的诊断回调（成功与失败都调）。 */
  readonly onRefresh?: (info: LiveRefreshInfo) => void;
  /** 时钟注入（smoke 用假时钟验证 TTL 兜底）。 */
  readonly now?: () => number;
  /**
   * 事件丢失兜底的 TTL（毫秒）：距上次刷新超过它，下一次读重新 describe 一次。
   * `Infinity` = 关掉兜底，完全依赖 `invalidate()`。默认 5000。
   */
  readonly staleAfterMs?: number;
}

export interface LiveSettingsReader {
  /**
   * 当前**覆盖值**（`describe()` 提炼结果；无权威实时值时为空对象）。
   * 命中缓存时零成本：不碰 describe()，且返回同一引用。
   */
  current(): Partial<FlatConfig>;
  /** 合并后的生效配置（按覆盖值身份记忆化：同值不重建，引用稳定）。 */
  snapshot(boot: FlatConfig): FlatConfig;
  /** 标脏：`settings/document-updated(ns)` 事件里调用，下一次读现取。 */
  invalidate(): void;
  /** 最后一次成功刷新的 revision（从未成功时 undefined）。 */
  revision(): number | undefined;
  /** 累计现读 describe() 的次数（smoke 用它验证热路径成本上界）。 */
  refreshCount(): number;
}

/** 空覆盖值常量：未注入 / 失败时返回它，调用方 `merge` 后等价于 boot 视图。 */
const NO_OVERRIDE: Partial<FlatConfig> = Object.freeze({});

/** 浅合并（调用方不给 merge 策略时用）。 */
function shallowMerge(boot: FlatConfig, override: Partial<FlatConfig>): FlatConfig {
  return { ...boot, ...override };
}

/** 两个覆盖值是否逐键全等（键集相同 + 每个值全等）。 */
function sameOverride(a: Partial<FlatConfig>, b: Partial<FlatConfig>): boolean {
  const keysA = Reflect.ownKeys(a) as string[];
  const keysB = Reflect.ownKeys(b) as string[];
  if (keysA.length !== keysB.length) return false;
  const boxB = b as Record<string, unknown>;
  const boxA = a as Record<string, unknown>;
  for (const key of keysA) {
    if (!Object.hasOwn(boxB, key) || boxA[key] !== boxB[key]) return false;
  }
  return true;
}

/**
 * 建一个「boot 默认层 + describe() 实时覆盖值」的读源。
 *
 * **失效语义（读这段再改调用点）**：
 *  1. *事件驱动为主*：`settings/document-updated(ns)` → `invalidate()` 标脏；
 *     **下一次读**才调用 describe() 一次。事件风暴期间 N 次标脏合并成 1 次
 *     describe()，所以成本上界是「读次数」而不是「事件次数」。
 *  2. *命中缓存零成本*：未脏且未过 TTL 时直接返回缓存对象（同一引用），既不
 *     describe() 也不新建对象——`handleComplete` 每次去抖、`statePushOf` 每次推送
 *     都要读，这是热路径。
 *  3. *TTL 兜底*（默认 5s）：监听没挂上、或内核在别的 ownerContext 上 emit 时，
 *     最迟 5s 自愈；代价是最多每 TTL 一次 describe()。
 *  4. *失败不放大*：describe() **抛异常**或**没返回本 ns 行**（服务还没注入 / 条目
 *     不在活动 profile）都**清脏**并保留上一次权威快照（初值 = boot 默认层），永不抛。
 *     清脏是为了热路径：否则「describe 正常但读不到行」会让每次读都付一次全量
 *     describe() 遍历。服务注入就位的时刻 host 在 `ctx.inject` 回调里**显式**
 *     `invalidate()`，所以实时值仍然在就位后的第一次读就到了，不用等 TTL；
 *     其余失败靠 TTL 与下一次事件重试。
 *  5. *重入保护*：`describe()` 在内核里可能同步 emit `document-updated`，回调若
 *     又读同一个源，直接拿当前缓存，不做嵌套 describe()。
 * @param options - 见 {@link LiveSettingsOptions}。
 */
export function createLiveSettings(options: LiveSettingsOptions): LiveSettingsReader {
  const describe = options.readDescribe;
  const merge = options.merge ?? shallowMerge;
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 5_000;
  const emit = options.onRefresh;

  let override: Partial<FlatConfig> = NO_OVERRIDE;
  let lastRevision: number | undefined;
  /** 按 boot 引用记忆化的合并结果（同 boot + 同覆盖值身份 → 同一对象）。 */
  let mergedBoot: FlatConfig | undefined;
  let mergedOverride: Partial<FlatConfig> | undefined;
  let merged: FlatConfig | undefined;
  let dirty = true;
  let refreshing = false;
  let refreshes = 0;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;

  const refresh = (): void => {
    lastRefreshAt = now();
    refreshes += 1;
    let described: unknown;
    try {
      described = describe();
    } catch (error) {
      // 权威源不可用：保住现有快照，清脏停止每次读都重试（TTL / 事件会再试）。
      dirty = false;
      emit?.({
        ok: false,
        applied: 0,
        revision: lastRevision,
        reason: 'describe-threw',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const row = pickNamespaceRow(described, options.ns);
    if (row === undefined) {
      // 服务未注入（readDescribe 给回 undefined，没碰内核）/ 本条目不在活动 profile：
      // 没有权威实时值可用，清脏并保留现有快照。**注入就位的时刻 host 在 ctx.inject
      // 回调里显式 invalidate()**，所以不需要保持脏来等——反过来，若这里保持脏，
      // 「describe 正常但没有本 ns 行」会让每次读都付一次全量 describe() 遍历。
      dirty = false;
      emit?.({ ok: false, applied: 0, revision: lastRevision, reason: 'row-missing' });
      return;
    }
    const next = pickLiveSettings(row.value);
    lastRevision = typeof row.revision === 'number' ? row.revision : undefined;
    dirty = false;
    // 逐键等同时不换引用：同值重写（消费后清空 `_ops` 那类）不该让生效配置的
    // 身份变化，下游把它当缓存 key 用也无谓失效。
    if (!sameOverride(override, next)) override = next;
    emit?.({
      ok: true,
      applied: Reflect.ownKeys(next).length,
      revision: lastRevision,
    });
  };

  const current = (): Partial<FlatConfig> => {
    // 脏（事件驱动 / 首次 / 注入就位）或 TTL 到期才现读；重入时直接拿缓存。
    if (!refreshing && (dirty || now() - lastRefreshAt >= staleAfterMs)) {
      refreshing = true;
      try {
        refresh();
      } finally {
        refreshing = false;
      }
    }
    return override;
  };
  const snapshot = (boot: FlatConfig): FlatConfig => {
    const next = current();
    if (merged !== undefined && mergedBoot === boot && mergedOverride === next) return merged;
    merged = merge(boot, next);
    mergedBoot = boot;
    mergedOverride = next;
    return merged;
  };
  // 方法都是闭包而非 `this` 依赖：解构调用（`const { snapshot } = reader`）同样安全。
  return {
    current,
    snapshot,
    invalidate: () => {
      dirty = true;
    },
    revision: () => lastRevision,
    refreshCount: () => refreshes,
  };
}
