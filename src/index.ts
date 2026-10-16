/**
 * dsh-suggest-ghost host 端：监听已完成回合，有界生成下一条建议，经
 * `suggest-ghost/state` 会话事件 + `suggestGhost` 投影实时推给 client。
 * 零核心改动，纯插件挂载。
 *
 * 0.1.7 适配：内核移除了 `settings.yaml` 体系，本插件的
 *  - **用户可调项** → `Config` 里的 `.volatile()` 字段（内核把插件 Config 投影成
 *    WebUI 表单，ns = Loader 条目 id = `suggest-ghost`）；
 *  - **热数据（建议/热度/历史环）** → ignorable 会话事件 + 投影 fold
 *    （取代已不存在的 settings `_push`）。
 *
 * 冷启动语义见 ./coldstart.ts：历史环按需从会话日志物化、建议按「回合是否仍是
 * 最后一个已完成回合」语义校验，因此重启后打开页面即可用，无需等新回合。
 * @module dsh-suggest-ghost
 */

import z from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cosmokit';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import {
  appendToRing,
  HISTORY_PUSH_CAP,
  nextTrackedSuggestion,
  seedRingFromLog,
  SUGGESTION_CACHE_CAP,
  suggestionFieldsFor,
  suggestionIsCurrent,
  userTextOfEvent,
} from './coldstart.js';
import { SUGGEST_EVENT } from './domain.js';
import type { HotnessOp, SuggestGhostHotEntry, SuggestGhostSuggested } from './domain.js';
import { flattenConfig, resolveConfig } from './generate.js';
import type { Config as GenerateConfig, FlatConfig, ResolvedPluginConfig } from './generate.js';
import { generateSuggestion, generateCompletion, sessionEvents } from './generate.js';
import { sanitizeCompletion } from './inline.js';
import { parseHotnessOps, setupHotnessPersistence } from './hotness-store.js';
import { applySuggestGhostProjection, initSuggestGhostProjection, suggestGhostSchema } from './projection.js';
import { EMPTY_PUSH, effectiveConfig, SUGGEST_GHOST_NAMESPACE } from './settings.js';
import { PROJECTION_KEY } from './domain.js';
import type { SuggestGhostProjection } from './domain.js';

/**
 * 用户可调项：逐字段标 `.volatile()`。0.1.7 让字段出现在 WebUI 设置页的开关
 * 就是它 —— `dsh-settings` 的 `volatileForm()` 递归下探、只收 `meta.volatile`
 * 的节点（`Config` 这层对象本身不能标：标了会让整棵子树都变成表单，策略参数
 * 一并暴露；也不能把 `z.object({...}).volatile().dict` 摊平再 spread ——
 * 摊平会丢掉每个字段自己的 `meta`，实测直接导致整张表单不可见）。
 *
 * 语义与 `dsh-client-ui-theme` 的 `preference` / `fontSize` 完全一致：解析后拿到的
 * 不是裸值而是一个**引用**（cosmokit 的 `Volatile<T>`），读值必须走 `.get()`。
 * 内核写盘时用同一判据 `isVolatilePath()` 把这些字段从 profile 文档里剔除，
 * 所以它们只活在 Loader 条目的内存 config 里，不污染手改的补丁文件。
 *
 * 这些字段**取代** 0.1.5/0.1.2 时代的 `suggest-ghost` settings 命名空间：
 * 0.1.7 删除了 `ctx.settings.register()`，命名空间不再由插件注册，而是内核把
 * 插件自己的 Config schema 投影成表单（ns = Loader 条目 id = `suggest-ghost`）。
 *
 * **依赖下限是 `@deepseek-ai/schemastery@^3.18.3`，不是 `^3.18.1`。**
 * `.volatile()` 是 3.18.3 才加入 schemastery 的；3.18.1 / 3.18.2 上调用它得到
 * `TypeError: ....volatile is not a function`。这**不是运行期异常，而是模块求值
 * 期的硬失败**——整个插件条目加载不了，0.1.7 会在 Web 启动时报
 * `1 entry did not activate` 并挡住界面。所以 peer 范围必须卡在 3.18.3 起，
 * 放宽到 `^3.18.1` 会让 pnpm 解析出旧版并直接炸掉。
 */
const EditableFields = {
  /** 最终框架化用户提示的最大 UTF-8 字节数。 */
  maxInputBytes: z.natural().min(1).default(4096).volatile(),
  /** 建议生成输出令牌上限（推理模型需留足预算，如 512）。 */
  maxOutputTokens: z.natural().min(1).default(512).volatile(),
  /** 辅助请求端到端截止时间（毫秒）。 */
  timeoutMs: z.natural().min(1).default(60_000).volatile(),
  /** 转录尾部保留的最近完成回合数（默认 3：保留近期上下文）。 */
  maxRecentTurns: z.natural().min(1).default(3).volatile(),
  /** 转录字符预算。 */
  maxTranscriptChars: z.natural().min(1).default(12_000).volatile(),
  /** 是否启用长会话上下文摘要（默认开）：旧消息被裁剪时提取摘要保留关键信息。 */
  contextSummaryEnabled: z.boolean().default(true).volatile(),
  /** 上下文摘要最大字符数（仅 contextSummaryEnabled 时生效）。 */
  contextSummaryChars: z.natural().min(100).default(1500).volatile(),
  /** 建议可见字符上限。 */
  maxSuggestionChars: z.natural().min(1).default(240).volatile(),
  /**
   * 显式路由对；`z.string().default('')` 而非 `min(1)`：留空表示「继承主请求
   * 最近记录的路由」。若保持必填，volatile 表单会把插件逼成「不填就不能启动」，
   * 而继承语义恰恰要求它是可选的。
   */
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
  llmEnabled: z.boolean().default(true).volatile(),
  /** 是否启用历史前缀补全。 */
  historyEnabled: z.boolean().default(true).volatile(),
  /** 是否跨会话搜索历史（false = 仅当前会话）。 */
  historyCrossSession: z.boolean().default(false).volatile(),
  /** 历史补全最多参考的历史条目数（0 = 不限）。 */
  historyMaxEntries: z.natural().min(0).default(50).volatile(),
  /** 草稿至少输入多少字符才触发历史补全。 */
  historyMinChars: z.natural().min(1).default(1).volatile(),
  /** 停顿续写开关（默认开）；草稿非空且历史未命中时，停顿后由 LLM 续写。 */
  inlineEnabled: z.boolean().default(true).volatile(),
  /** 停顿多久后触发续写（毫秒）。 */
  inlineDelayMs: z.natural().min(100).default(800).volatile(),
  /** 草稿至少输入多少字符才触发续写。 */
  inlineMinChars: z.natural().min(1).default(4).volatile(),
  /** 续写可见字符上限。 */
  inlineMaxChars: z.natural().min(1).default(160).volatile(),
  /** 幽灵显示时允许 → 逐词采纳。 */
  wordAccept: z.boolean().default(true).volatile(),
  /** 采纳建议的输入框快捷键（默认 Tab）。 */
  acceptKey: z.string().min(1).default('Tab').volatile(),
  /**
   * 建议语言模式：'auto' = 自动推断（结合 UI 语言 + 用户消息文字分布）；
   * 'zh' / 'zh-TW' / 'en' / 'ja' / 'ko' / 'ru' / 'fr' / 'de' / 'es' = 强制指定语言。
   * 未知代码在 host 端回退 English（见 generate.ts 的 LANGUAGE_NAMES）。
   */
  languageMode: z.string().default('auto').volatile(),
  /**
   * UI 语言先验权重（仅 auto 模式生效）：值越大越倾向 UI 语言。
   * 默认 100 ≈ 2-3 条中等长度消息的置信度。
   */
  uiLocaleWeight: z.natural().min(0).default(100).volatile(),
  /**
   * client → host 的热度管理操作队列（JSON 字符串）。
   *
   * 0.1.7 的 `SettingsForms.write()` 只接受 volatile 路径（`isVolatilePath`
   * 校验，非 volatile 直接抛错），所以这个反向通道字段本身也必须标 volatile。
   * 消费后立即写回空串：清空既是「已消费」信号，也防陈旧操作在重启后重放
   * （如陈旧的 clear 把新数据清掉）。操作幂等，host 不依赖 rev 去重。
   */
  _ops: z.string().default(EMPTY_PUSH).volatile(),
  /**
   * host → client 的实时推送载荷（JSON 字符串），同上必须标 volatile 才能写入。
   * 结构与 0.1.5 时代完全一致（见 settings.ts 的 `GhostPushPayload`），故 client
   * 侧的解析与 `*SessionId` 归属守卫无需改动——变的只是字段载体。
   */
  _push: z.string().default(EMPTY_PUSH).volatile(),
};

/**
 * `Config` 解析后的取值形状。
 *
 * 显式标注的原因：两个字段组用 spread 组合时，TS 推断出的类型引用了
 * `.pnpm/...` 下的具体路径，`.d.ts` 产物无法命名（TS2742 要求可命名的标注）。
 * 标注成这个接口既让产物可命名，也让 Config 的输入/输出类型对上层可见。
 *
 * **可调项的类型是 `Volatile<T>` 而不是裸值。** `.volatile()` 把 schema 的
 * Mode 提升为 `'volatile'`，`SchemaOutput` 随之把输出映射成 `Volatile<T | undefined>`
 * （`@deepseek-ai/schemastery` 的 `SchemaOutput` / `SetRequired`）。所以这里必须
 * 逐字段写 `Volatile<...>`——否则 `z<PluginConfigValues>` 的标注与实际推断不符，
 * 报 `Type 'Volatile<boolean>' is not assignable to type 'boolean'`。
 * 读值一律走 `flattenConfig()` 的 `readVolatile()`，拿到的才是裸值。
 */
export interface PluginConfigValues {
  maxInputBytes: Volatile<number>;
  maxOutputTokens: Volatile<number>;
  timeoutMs: Volatile<number>;
  maxRecentTurns: Volatile<number>;
  maxTranscriptChars: Volatile<number>;
  contextSummaryEnabled: Volatile<boolean>;
  contextSummaryChars: Volatile<number>;
  maxSuggestionChars: Volatile<number>;
  provider: Volatile<string>;
  model: Volatile<string>;
  llmEnabled: Volatile<boolean>;
  historyEnabled: Volatile<boolean>;
  historyCrossSession: Volatile<boolean>;
  historyMaxEntries: Volatile<number>;
  historyMinChars: Volatile<number>;
  inlineEnabled: Volatile<boolean>;
  inlineDelayMs: Volatile<number>;
  inlineMinChars: Volatile<number>;
  inlineMaxChars: Volatile<number>;
  wordAccept: Volatile<boolean>;
  acceptKey: Volatile<string>;
  languageMode: Volatile<string>;
  uiLocaleWeight: Volatile<number>;
  _ops: Volatile<string>;
  _push: Volatile<string>;
}

/**
 * 配置 schema（cordis 插件约定，config catalog 会原样粘贴声明）。
 *
 * 标注必须写成 `z<输入, 输出>` 两参形式，不能用 `z<PluginConfigValues>` 单参：
 * `.volatile()` 字段的**输入**是裸值、**输出**是 `Volatile<T>`（见 `ObjectS` /
 * `ObjectT`），单参标注会让两侧都被当成 `Volatile<T>`，`default()` 的入参随之
 * 对不上而报 TS2322。输入形状用 `Schemastery.TypeS<typeof ConfigSchema>` 取回。
 */
const ConfigSchema = z.object({
  ...EditableFields,
});

export const Config: z<Schemastery.TypeS<typeof ConfigSchema>, PluginConfigValues> = ConfigSchema;

/** 所需服务：LLM 路由 + 会话存储 + 设置服务。 */
export const inject = ['llm', 'sessions', 'settings'];

/** 插件名（与 cordis 条目 id 及 manifest 一致）。 */
export const name = 'dsh-suggest-ghost';

/** 每会话生成状态：防重入、可中止。 */
interface SessionState {
  /** 日志中已生成建议的最新回合号（重载/恢复后避免重复生成）。 */
  lastSuggestedTurn: number;
  /** 在途生成；新回合会中止旧生成。 */
  pending: { readonly turn: number; readonly controller: AbortController } | undefined;
  /** 上次建议的语言（语言惯性：短消息无足够信号时回退）。 */
  lastLanguage: string | undefined;
}

/** 从会话日志恢复已建议的最新回合号。 */
function lastSuggestedTurnInLog(session: Session): number {
  let last = 0;
  // 跨代读取：0.1.2 起没有 `session.events`（见 generate.sessionEvents）。
  for (const event of sessionEvents(session)) {
    if (event.type === SUGGEST_EVENT && typeof event.data.turn === 'number') {
      last = Math.max(last, event.data.turn);
    }
  }
  return last;
}

/**
 * 挂载插件：监听完成回合、按会话生成建议、注册投影单元，并把配置暴露
 * 到 WebUI 设置页（settings 命名空间，live 生效）。
 * @param ctx - 提供 LLM 与会话服务的 cordis 上下文。
 * @param config - 必填的有界生成策略。
 */
export function apply(ctx: Context, config: GenerateConfig): void {
  console.log('[dsh-suggest-ghost] apply() called, starting plugin initialization...');
  ctx.logger.info('dsh-suggest-ghost: apply() called, starting plugin initialization...');
  const resolved = resolveConfig(config);
  const states = new WeakMap<Session, SessionState>();
  const tracked = new Set<SessionState>();
  // 全局跨会话热度表（增量，随 user/message 事件累积），并经 storageDomain
  // 持久化频次（宿主未挂 storageDomain 时自动降级为纯内存）。
  const { hotness, persistence } = setupHotnessPersistence(ctx);

  // 读取生成配置的 live 值：Config 里的 volatile 引用（用户可调项）优先，
  // 未覆盖的字段回退到 schema 默认值。状态经 `_push` volatile 字段推给 client
  // （0.1.7 移除了 settings.yaml：字段载体从 SettingsScope 换成 volatile 配置
  // 字段，载荷结构不变）。
  let liveSettings: FlatConfig = flattenConfig(resolved);
  let settingsSvc: { update: (ns: unknown, patch: object) => Promise<void> } | null = null;
  /**
   * `_ops` 的最后一次已消费载荷。0.1.7 的 volatile 字段是**引用**（`Volatile<T>`），
   * 内核写入时替换引用而非改原对象；`settings/document-updated` 只带
   * (ns, revision)，故每次都重读引用比对载荷值（引用身份不可靠：同值重写也会
   * 换引用，载荷比对才是语义判重）。
   */
  let lastOpsPayload = EMPTY_PUSH;
  /**
   * client 最后一次 `_ops` 写入捎带的 UI 语言（'zh' | 'en'）。
   * host 重启后为空，client 下次 pull 会重新捎带；语言检测时作为先验加成。
   */
  let clientUiLocale: string | undefined;
  /**
   * 取当前 `_ops` 的载荷字符串。
   *
   * **必须走 settings 服务的 `describe()`**：内核每次配置写入会重新解析 config
   * 并替换 fiber 持有的对象，apply 参数里捕获的 volatile 引用会冻结在失效时刻的
   * 值（实测：client 写入 complete op 后，插件内的旧引用永远停在首次 pull 的
   * 载荷）。`describe()` 同步读取 `entry.fiber.config` 的展开值，是唯一权威源。
   * settings 服务尚未注入（启动早期）时回退到 volatile 引用读取。
   */
  const readOps = (): string => {
    const svc = settingsSvc as { describe?: () => unknown } | null;
    if (svc !== null && typeof svc.describe === 'function') {
      try {
        const listed = svc.describe();
        const rows = Array.isArray(listed)
          ? listed
          : Array.isArray((listed as { namespaces?: unknown[] })?.namespaces)
            ? (listed as { namespaces: unknown[] }).namespaces
            : [];
        for (const row of rows as Array<{ ns?: string; revision?: number; value?: Record<string, unknown> }>) {
          if (row?.ns !== SUGGEST_GHOST_NAMESPACE) continue;
          console.log(`[dsh-suggest-ghost] describe: revision=${row.revision}, _ops=${JSON.stringify(row.value?._ops).slice(0, 150)}`);
          const v = row.value?._ops;
          if (typeof v === 'string') return v;
        }
      } catch { /* describe 异常回退引用读取 */ }
    }
    const ref = (resolved as { _ops?: unknown })._ops;
    const payload = typeof ref === 'object' && ref !== null && typeof (ref as { get?: unknown }).get === 'function'
      ? (ref as { get: () => unknown }).get()
      : ref;
    return typeof payload === 'string' ? payload : EMPTY_PUSH;
  };
  ctx.inject(['settings'], (settingsCtx) => {
    console.log('[dsh-suggest-ghost] settings inject callback called');
    ctx.logger.info('dsh-suggest-ghost: settings inject callback called');
    try {
      const svc = (settingsCtx as { settings?: { update: (ns: unknown, patch: object) => Promise<void> } }).settings;
      if (svc === undefined) {
        console.log('[dsh-suggest-ghost] settings service is undefined!');
        ctx.logger.warn('dsh-suggest-ghost: settings service is undefined');
        return;
      }
      settingsSvc = svc;
      liveSettings = flattenConfig(resolved);
      // 重启/重载对账：`_push` 是建议（不可重建的 LLM 输出）唯一的持久载体。
      // volatile 字段不落盘（内核用同一判据把它从 profile 文档里剔除），故
      // 内存里没有跨进程残留——这里只需消化启动前 client 抢跑写入的 `_ops`。
      //
      // `_ops` 遗留补消费：client 冷启动的 pull 若抢跑在本注入之前，那次写入
      // 已被错过。消费幂等（热度 ops 幂等、消费后立即清空），先跑一次关掉这个
      // 时序窗口。
      lastOpsPayload = readOps();
      consumeOps(parseHotnessOps(lastOpsPayload), svc);
      // 热度恢复是异步的（storageDomain.open）：恢复完成后补推一次快照，修正
      // 恢复窗口内已推送的不完整热度。目标会话取自追踪的建议会话。
      void persistence.whenReady.then(() => {
        if (settingsSvc === null) return;
        const id = lastSuggestionSession;
        if (id !== null) pushToClient(statePushOf(id));
      });
      // `_ops` 反向通道：client 经 `ctx.remote.settings.mutate(ns, ops)` 写入，
      // 内核改 volatile 引用并 emit `settings/document-updated(ns, revision)`。
      // 该事件只带 (ns, revision)，故每次都重读引用比对载荷。
      // **关键**：cordis 事件只向父级传播、不向子级传播。该事件 emit 在 settings
      // 服务的 ownerContext 上，插件自己的 ctx 收不到——必须监听 root。
      const eventCtx = (ctx as unknown as { root?: typeof ctx }).root ?? ctx;
      console.log('[dsh-suggest-ghost] registering settings/document-updated on eventCtx');
      eventCtx.on('settings/document-updated', (ns: string, revision?: number) => {
        console.log(`[dsh-suggest-ghost] settings/document-updated received, ns = ${ns}, rev = ${revision}, expected = ${SUGGEST_GHOST_NAMESPACE}`);
        if (ns !== SUGGEST_GHOST_NAMESPACE) return;
        liveSettings = flattenConfig(resolved);
        const payload = readOps();
        console.log(`[dsh-suggest-ghost] payload = ${JSON.stringify(payload).slice(0, 300)}`);
        if (payload === lastOpsPayload) {
          return;
        }
        lastOpsPayload = payload;
        consumeOps(parseHotnessOps(payload), svc);
      });
      ctx.logger.info('dsh-suggest-ghost: settings wired (volatile config, ns=suggest-ghost)');
    } catch (error) {
      console.log(`[dsh-suggest-ghost] settings wiring failed: ${String(error)}`);
      ctx.logger.warn(`dsh-suggest-ghost: settings wiring failed: ${String(error)}`);
    }
  });
  const effective = (): FlatConfig => effectiveConfig(flattenConfig(resolved), liveSettings);

  // —— 每会话历史环：最近用户消息文本（时间序），供 client 历史前缀补全 ——
  // 0.1.2 起会话快照不再向插件暴露对话 nodes；历史文本改由 host 侧维护并经
  // `_push` 推送。host 本就逐事件扫 user/message 做热度记账，顺带成环零新增
  // 扫描。环是会话日志的按需物化缓存：pull 时未命中就从日志现种（日志持久化，
  // apply 时必然已在内存），「播种时机」与竞态窗口一并消失；会话活跃期间由
  // session/event 增量维护。筛选语义与 client extractHistory 对齐：只收
  // source.kind === 'user' 的文本块，跳过系统注入与超长文本，相邻重复只计
  // 一次。环容量 = HISTORY_PUSH_CAP × 2（推送窗口的两倍，硬上限防泄漏）。
  const historyRings = new Map<string, string[]>();
  /** 取会话历史环：缓存未命中且会话存活时从日志物化（幂等，每会话至多一次）。 */
  const ringFor = (sessionId: string): string[] | undefined => {
    const cached = historyRings.get(sessionId);
    if (cached !== undefined) return cached;
    const session = ctx.sessions.get(sessionId as SessionId);
    if (session === undefined) return undefined; // 会话不存在（已销毁）：无法回答
    const seed = seedRingFromLog(session);
    historyRings.set(sessionId, seed);
    return seed;
  };
  const ringPush = (sessionId: string, text: string): void => {
    // 先物化（未命中则从日志现种）：环是日志的缓存，绝不能凭空从单条文本起建
    // ——否则该会话的历史前缀会丢掉此前的所有轮次。
    const ring = ringFor(sessionId);
    if (ring === undefined) return; // 会话不存在（已销毁）：无环可维护
    appendToRing(ring, text);
  };

  /**
   * 每会话建议表（`sessionId -> 建议`），有界保留最近 {@link SUGGESTION_CACHE_CAP}
   * 个会话。
   *
   * **为什么不能是单槽。** 早先只用 `lastSuggestion` / `lastSuggestionSession` 两个
   * 变量存「最后一个产生建议的会话」，于是同时活跃的多个会话会互相覆盖：host 推的
   * `suggestionSessionId` 永远是最后结束回合的那个，client 端的会话归属守卫
   * （index.ts 的 `stale` 判据）就把其余会话的建议全部隐藏——表现为「插件没生效」。
   * 改为按会话索引后，pull 应答能取回**所问会话**自己的建议，多开互不干扰。
   *
   * 仍然保留「最近一次建议」作为跨会话兜底（见 {@link lastSuggestionOf}），供
   * 尚未 pull 的页面显示（切回时立即可见）。
   */
  const suggestionBySession = new Map<string, SuggestGhostSuggested>();
  /** 最近一次产出的建议及其会话（跨会话兜底用；勿用于判定本会话有效性）。 */
  let lastSuggestion: SuggestGhostSuggested | null = null;
  let lastSuggestionSession: string | null = null;

  /** 取某会话当前语义有效的建议（null = 无）。判据从「时间」换成「语义」：
   * 建议对应的回合是否仍是该会话最后一个已完成回合——不是就作废（防止
   * 重启后把旧回合的建议当新建议显示）。这是 `_push` 里建议状态的唯一
   * 权威来源：启动时从盘上回读、pull 时校验后重推，都走这里。
   */
  const currentSuggestionFor = (sessionId: string): SuggestGhostSuggested | null => {
    const session = ctx.sessions.get(sessionId as SessionId);
    // 本会话自己的建议优先；没有则回落到最近一次建议（仅当它正属于本会话）。
    const own = suggestionBySession.get(sessionId)
      ?? (lastSuggestionSession === sessionId ? lastSuggestion : null);
    if (own === null) return null;
    return suggestionIsCurrent(own, session) ? own : null;
  };

  /**
   * 跨会话兜底：最近一次产出的建议（可能属于别的会话，client 会按归属隐藏）。
   */
  const lastSuggestionOf = (): { suggestion: SuggestGhostSuggested | null; sessionId: string | null } =>
    lastSuggestion === null || lastSuggestionSession === null
      ? { suggestion: null, sessionId: null }
      : { suggestion: lastSuggestion, sessionId: lastSuggestionSession };

  /**
   * 更新追踪状态——建议的产出与作废只发生在生成路径，所以追踪也
   * 只在这里更新（载荷推送不改它，见 pushToClient）。
   */
  const trackSuggestion = (sessionId: string, suggestion: SuggestGhostSuggested | null): void => {
    if (suggestion === null) suggestionBySession.delete(sessionId);
    else {
      suggestionBySession.set(sessionId, suggestion);
      // 有界：超容量时逐出最久未更新的会话（Map 保持插入序）。
      while (suggestionBySession.size > SUGGESTION_CACHE_CAP) {
        const oldest = suggestionBySession.keys().next();
        if (oldest.done === true) break;
        suggestionBySession.delete(oldest.value);
      }
    }
    // 「最近一次」槽位保持原有语义：产出即占位；清空只在本会话时清。
    const next = nextTrackedSuggestion(
      { suggestion: lastSuggestion, sessionId: lastSuggestionSession },
      sessionId,
      suggestion,
    );
    lastSuggestion = next.suggestion;
    lastSuggestionSession = next.sessionId;
  };

  // —— 停顿续写状态 ——
  /** 续写结果缓存：sessionId → {draft, text}；LRU 上限 16。 */
  const COMPLETION_CACHE_CAP = 16;
  const completionCache = new Map<string, { draft: string; text: string }>();
  /** 在途续写生成：sessionId → AbortController（单飞：同会话只保留最新一次）。 */
  const completionPending = new Map<string, AbortController>();

  const cacheCompletion = (sessionId: string, draft: string, text: string): void => {
    completionCache.delete(sessionId);
    completionCache.set(sessionId, { draft, text });
    while (completionCache.size > COMPLETION_CACHE_CAP) {
      const oldest = completionCache.keys().next();
      if (oldest.done === true) break;
      completionCache.delete(oldest.value);
    }
  };

  /**
   * 为指定会话的当前草稿生成行内续写（停顿续写）。
   *
   * 与 handleTurnEnd 的关键差异：
   * 1. 输入是草稿文本而非回合边界
   * 2. 单飞：同会话只保留最新一次生成（新草稿到达时中止旧生成）
   * 3. 失败静默：不推送错误信息（续写是锦上添花，不应打扰用户）
   * 4. 缓存命中时直接重推（同 sessionId+draft 的缓存结果）
   */
  const handleComplete = (sessionId: string, draft: string): void => {
    console.log(`[dsh-suggest-ghost] handleComplete called, sessionId = ${sessionId}, draft = ${JSON.stringify(draft)}`);
    const cfg = effective();
    if (cfg.inlineEnabled === false) {
      console.log(`[dsh-suggest-ghost] inlineEnabled is false, skip`);
      return;
    }
    if (draft.trim().length < cfg.inlineMinChars) {
      console.log(`[dsh-suggest-ghost] draft too short, skip`);
      return;
    }
    const session = ctx.sessions.get(sessionId as SessionId);
    if (session === undefined) {
      console.log(`[dsh-suggest-ghost] session not found, skip`);
      return;
    }
    console.log(`[dsh-suggest-ghost] session found, generating completion...`);
    // 缓存命中：同 sessionId+draft → 直接重推。
    const cached = completionCache.get(sessionId);
    if (cached !== undefined && cached.draft === draft) {
      pushToClient({
        ...statePushOf(sessionId),
        completion: cached,
        completionSessionId: sessionId,
      });
      return;
    }
    // 单飞：中止同会话的在途生成。
    const existing = completionPending.get(sessionId);
    if (existing !== undefined) existing.abort();
    const controller = new AbortController();
    completionPending.set(sessionId, controller);
    const startedAt = Date.now();
    generateCompletion(
      ctx,
      cfg,
      session,
      draft,
      controller.signal,
      clientUiLocale || undefined,
      cfg.languageMode,
      cfg.uiLocaleWeight,
    ).then(
      (result) => {
        // 生成完成：检查是否仍为当前（未被新草稿中止）。
        if (completionPending.get(sessionId) !== controller) return;
        completionPending.delete(sessionId);
        if (result.text === undefined) {
          console.log(`[dsh-suggest-ghost] completion empty/filtered for session ${sessionId}, silent`);
          return; // 空/不合格 → 静默
        }
        console.log(`[dsh-suggest-ghost] completion generated for session ${sessionId}: ${JSON.stringify(result.text).slice(0, 120)} (${Date.now() - startedAt}ms)`);
        cacheCompletion(sessionId, draft, result.text);
        pushToClient({
          ...statePushOf(sessionId),
          completion: { draft, text: result.text },
          completionSessionId: sessionId,
        });
        ctx.logger.debug?.(`dsh-suggest-ghost: completion pushed for session ${sessionId} in ${Date.now() - startedAt}ms`);
      },
      (error: unknown) => {
        if (completionPending.get(sessionId) !== controller) return;
        completionPending.delete(sessionId);
        // 中止 = 被新草稿取代，不算失败；其他错误静默丢弃。
        if (!controller.signal.aborted) {
          console.log(`[dsh-suggest-ghost] completion FAILED for session ${sessionId}: ${String(error).slice(0, 300)}`);
          ctx.logger.debug?.(`dsh-suggest-ghost: completion failed for session ${sessionId}: ${String(error)}`);
        }
      },
    );
  };

  /** 推给 client 的 `_push` 载荷（结构化形态；写盘前序列化）。 */
  interface ClientPush {
    /** 最新 LLM 建议；null = 清空当前建议。 */
    readonly suggestion: SuggestGhostSuggested | null;
    /** 建议所属会话（client 据此只在同会话显示建议）。 */
    readonly suggestionSessionId: string | null;
    /** 跨会话热度快照。 */
    readonly hot: readonly SuggestGhostHotEntry[] | null;
    /** 热表总条目数（管理面板「共 N 条」展示；快照只是 top-K）。 */
    readonly total: number;
    /** 历史环推送：最近用户消息文本（时间序）；null = 不携带（保留 client 现值）。 */
    readonly history: readonly string[] | null;
    /** history 所属会话；null 同步 history 为 null。 */
    readonly historySessionId: string | null;
    /** 行内续写：null = 清空当前续写；undefined = 不携带（保留 client 现值）。 */
    readonly completion?: { readonly draft: string; readonly text: string } | null;
    /** completion 所属会话（归属守卫：切会话时清掉上一个会话的续写）。 */
    readonly completionSessionId?: string | null;
    /** 本次生成失败的摘要（可诊断；成功/无错误时缺省）。 */
    readonly error?: string;
  }

  const fingerprintOf = (p: ClientPush): string => {
    const sug = p.suggestion === null
      ? '\u2205'
      : `${p.suggestion.turn}:${p.suggestion.text}:${p.suggestion.truncated}:${p.suggestion.acceptKey}`;
    const hotKey = p.hot === null || p.hot.length === 0
      ? '\u2205'
      : p.hot.map(h => `${h.text}\u00d7${h.count}${h.pinned === true ? '!p' : ''}`).join('|');
    const historyKey = p.history === null || p.history.length === 0 || p.historySessionId === null
      ? '\u2205'
      : `${p.historySessionId}#${p.history.length}:${p.history[p.history.length - 1] ?? ''}`;
    const completionKey = p.completion === null
      ? '\u2205'
      : p.completion === undefined
        ? '\u2204' // 未携带（保留 client 现值）
        : `${p.completionSessionId ?? ''}#${p.completion.draft}=${p.completion.text}`;
    return `${sug}<HOT>${hotKey}<T>${p.total}<HIST>${historyKey}<CPL>${completionKey}<ERR>${p.error ?? ''}`;
  };
  /**
   * 经 `_push` volatile 字段把最新建议+热度+历史推给 client。
   *
   * 0.1.7 里字段载体从 `SettingsScope` 换成 `SettingsForms` 的 volatile 配置
   * 字段（`ctx.settings.update(ns, patch)`），**载荷结构不变**，故 client 侧的
   * 解析与 `*SessionId` 归属守卫都无需改动。
   *
   * 幂等优化：payload 与上次完全一致时直接跳过——避免重复写 + client 端
   * JSON 解析/重渲染。`history: null` 表示本次推送不携带历史（client 保留
   * 现值）——pull/turn-end 想更新历史时才携带。
   *
   * 尾写合并：`settings.update` 是异步的；同一时刻连续多次 push 会排成多次
   * 顺序写入。这里把最新载荷挂起，在途写入完成后只补写**最新一份**。
   */
  let pushRev = 0;
  let lastPushFingerprint: string | null = null;
  let pushInFlight: Promise<void> | null = null;
  let pendingPushPayload: string | null = null;
  const pushToClient = (p: ClientPush): void => {
    if (settingsSvc === null) return;
    const fingerprint = fingerprintOf(p);
    if (lastPushFingerprint === fingerprint) return; // 无变化，跳过写盘
    lastPushFingerprint = fingerprint;
    pushRev += 1;
    // 注意：这里**不**改 lastSuggestion/lastSuggestionSession。载荷里的
    // `suggestion: null` 有两种含义——「本会话没有建议」（如 pull 一个没有建议
    // 的会话）与「建议被作废」。若在这里按载荷清空追踪状态，pull 一次别的会话
    // 就会把仍在有效期的那条建议弄丢。追踪状态只在真正产出/作废建议的地方更新
    // （handleTurnEnd 的生成结果与启动对账）。
    const payload = {
      rev: pushRev,
      suggestion: p.suggestion === null ? null : {
        turn: p.suggestion.turn,
        baseSeq: p.suggestion.baseSeq,
        text: p.suggestion.text,
        truncated: p.suggestion.truncated,
        acceptKey: p.suggestion.acceptKey,
      },
      suggestionSessionId: p.suggestionSessionId,
      hot: p.hot !== null && p.hot.length > 0 ? [...p.hot] : null,
      total: p.total,
      ...(p.history !== null && p.historySessionId !== null
        ? { history: [...p.history], historySessionId: p.historySessionId }
        : {}),
      ...(p.completion === null
        ? { completion: null, completionSessionId: null }
        : p.completion !== undefined
          ? { completion: { draft: p.completion.draft, text: p.completion.text }, completionSessionId: p.completionSessionId ?? null }
          : {}),
      ...(p.error !== undefined ? { error: p.error } : {}),
    };
    // 合并缓冲：若已有在途写入，只更新「最新待写」；flush 在途完成后补写。
    pendingPushPayload = JSON.stringify(payload);
    flushPush();
  };
  /** 尾写合并：把挂起的最新载荷写入；写入期间再来新载荷则在完成后续写。 */
  const flushPush = (): void => {
    if (settingsSvc === null || pushInFlight !== null) return;
    const payload = pendingPushPayload;
    pendingPushPayload = null;
    if (payload === null) return;
    pushInFlight = settingsSvc.update(SUGGEST_GHOST_NAMESPACE, { _push: payload })
      .catch((error: unknown) => {
        ctx.logger.warn(`dsh-suggest-ghost: push to client failed: ${String(error)}`);
      })
      .finally(() => {
        pushInFlight = null;
        if (pendingPushPayload !== null) flushPush(); // 写入期间又有新载荷 → 续写最新
      });
  };

  /**
   * 组装某会话的**当前权威状态**并推给 client：历史环按需从日志物化（ringFor，
   * 无播种时机概念）、建议经语义校验（currentSuggestionFor）、热度取热表现照。
   * 启动对账、pull 应答、热度恢复补推三条路径共用这一份组装逻辑——它们此前
   * 各写各的，是冷启动竞态的根源。
   *
   * 建议字段的跨会话语义：本会话的建议按校验结果推（有效原样 / 陈旧清掉）；
   * 其他会话的有效建议原样保留——client 端按会话归属守卫隐藏，切回时仍在
   * 有效期，推 null 反而会把切回后的建议弄丢。
   * @param sessionId - 目标会话；null 表示无特定会话（仅刷新热度，历史不携带）。
   */
  const statePushOf = (sessionId: string | null): ClientPush => {
    const ring = sessionId === null ? undefined : ringFor(sessionId);
    // 建议字段：本会话按语义校验取用；不属于本会话但仍被追踪的那条原样带上
    // （client 按会话归属守卫隐藏，切回时立即可用）。
    const fields = suggestionFieldsFor(
      { suggestion: lastSuggestion, sessionId: lastSuggestionSession },
      sessionId,
      sessionId === null ? null : currentSuggestionFor(sessionId),
    );
    return {
      suggestion: fields.suggestion,
      suggestionSessionId: fields.sessionId,
      hot: hotness.snapshot(liveSettings.historyMaxEntries),
      total: hotness.size,
      history: ring === undefined ? null : ring.slice(-HISTORY_PUSH_CAP),
      historySessionId: ring === undefined ? null : sessionId,
      ...(sessionId !== null && completionCache.has(sessionId)
        ? { completion: completionCache.get(sessionId)!, completionSessionId: sessionId }
        : {}),
    };
  };

  /**
   * `_ops` 消费器（watch 触发与启动遗留补消费共用）：pull 走统一的状态组装应答，
   * 其余操作交热表层应用（幂等），最后 flush 并清空队列。捎带的 locale 更新到
   * 模块变量，供后续语言检测使用。
   * @param parsed - 已解析的操作批 + 可选 locale；空 ops 直接返回（不写盘）。
   * @param svc - settings 写面，用于消费后清空 `_ops`。
   */
  const consumeOps = (
    parsed: { readonly ops: readonly HotnessOp[]; readonly locale?: string },
    svc: { update: (ns: unknown, patch: object) => Promise<void> },
  ): void => {
    // 捎带的 UI 语言：有则更新（last-wins），无则保持上次值。
    if (parsed.locale !== undefined) clientUiLocale = parsed.locale;
    const ops = parsed.ops;
    if (ops.length === 0) return;
    for (const op of ops) {
      console.log(`[dsh-suggest-ghost] consumeOps op=${op.op}, sessionId = ${(op as { sessionId?: string }).sessionId ?? '-'}`);
      if (op.op === 'pull') {
        ctx.logger.info(`dsh-suggest-ghost: consumeOps pull, sessionId = ${op.sessionId}`);
        // 无论历史环可不可得都应答：环缺失（会话尚未进店/已销毁）时 statePushOf
        // 会省略 history（client 保留现值），但热度与对账后的建议照常送达——
        // 静默丢弃会让 client 永远等不到这一轮对账。
        pushToClient(statePushOf(op.sessionId));
      } else if (op.op === 'complete') {
        ctx.logger.info(`dsh-suggest-ghost: consumeOps complete, sessionId = ${op.sessionId}, draft = ${JSON.stringify(op.draft)}`);
        handleComplete(op.sessionId, op.draft);
      }
    }
    const changed = persistence.applyOps(ops);
    if (changed > 0) ctx.logger.info(`dsh-suggest-ghost: hotness ops applied (${changed} changed)`);
    void persistence.flush();
    // 消费完成：清空操作队列（下一次 watch 触发时 ops 为空，直接跳过）。
    void svc.update(SUGGEST_GHOST_NAMESPACE, { _ops: EMPTY_PUSH }).then(
      () => console.log('[dsh-suggest-ghost] _ops cleared OK'),
      (error: unknown) => console.log(`[dsh-suggest-ghost] _ops clear FAILED: ${String(error).slice(0, 300)}`),
    );
  };

  const handleTurnEnd = (session: Session, turn: number): void => {
    // 回合边界是热表持久化的天然写点：本回合累计的 user/message 频次合并落盘
    // （fail-soft，未就绪/无脏标记时空转；卸载另有 close 兜底）。
    void persistence.flush();
    let state = states.get(session);
    if (state === undefined) {
      state = { lastSuggestedTurn: lastSuggestedTurnInLog(session), pending: undefined, lastLanguage: undefined };
      states.set(session, state);
      tracked.add(state);
    }
    if (state.lastSuggestedTurn === turn) return;
    const pending = state.pending;
    if (pending !== undefined) {
      if (pending.turn === turn) return;
      pending.controller.abort();
    }
    // LLM 建议被用户关闭：跳过模型调用（省 token），但热度照常推进并推送，
    // 历史前缀补全不受影响；同时把残留建议清空，避免幽灵残留。
    if (effective().llmEnabled === false) {
      state.pending = undefined;
      state.lastSuggestedTurn = turn;
      trackSuggestion(session.id, null); // 关闭 LLM：本会话建议作废（其他会话不受影响）
      const hot = hotness.snapshot(liveSettings.historyMaxEntries);
      pushToClient({
        suggestion: null,
        suggestionSessionId: null,
        hot,
        total: hotness.size,
        history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
        historySessionId: session.id,
      });
      return;
    }
    const controller = new AbortController();
    state.pending = { turn, controller };
    void Promise.resolve()
      .then(() => {
        const cfg = effective();
        return generateSuggestion(
          ctx, cfg, session, turn, controller.signal,
          clientUiLocale, cfg.languageMode, cfg.uiLocaleWeight,
          state.lastLanguage,
        );
      })
      .then(
        (result) => {
          if (state?.pending?.controller !== controller) return;
          state.pending = undefined;
          state.lastSuggestedTurn = turn;
          state.lastLanguage = result.language;
          // 经 settings 实时推给 client（不写日志）。热度快照始终附带：
          // 其频次参与历史补全打分（新近度为主、频次为辅）；「跨会话搜索」
          // 开关仅在 client 端决定是否把这些文本并作候选。历史环随推：client
          // 端补全的文本源（0.1.2 会话快照已不对插件暴露对话 nodes）。
          const hot = hotness.snapshot(liveSettings.historyMaxEntries);
          trackSuggestion(session.id, result.suggestion ?? null);
          pushToClient({
            suggestion: result.suggestion ?? null,
            suggestionSessionId: session.id,
            hot,
            total: hotness.size,
            history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
            historySessionId: session.id,
          });
        },
        (error: unknown) => {
          if (state?.pending?.controller === controller) state.pending = undefined;
          if (controller.signal.aborted) return; // 被新回合取代，失败符合预期
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn(`dsh-suggest-ghost: suggestion generation failed: ${message}`);
          // 失败也推送：清掉残留幽灵 + 把错误摘要带给 client/设置页（可诊断）。
          trackSuggestion(session.id, null);
          const hot = hotness.snapshot(liveSettings.historyMaxEntries);
          pushToClient({
            suggestion: null,
            suggestionSessionId: null,
            hot,
            total: hotness.size,
            history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
            historySessionId: session.id,
            error: message.slice(0, 300),
          });
        },
      );
  };

  ctx.on('session/event', (session, event) => {
    // 传会话 id：同会话相邻重复的用户消息只计一次热度（对齐 extractHistory 的去重语义）。
    hotness.consume(event, session.id);
    const userText = userTextOfEvent(event);
    // ringPush 会先按需物化（含本事件之前的日志），无需任何「首见播种」步骤。
    if (userText !== null) ringPush(session.id, userText);
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
      handleTurnEnd(session, event.data.turn);
    }
  });

  // 插件卸载时中止所有在途生成（建议 + 续写）。
  ctx.effect(() => () => {
    for (const state of tracked) state.pending?.controller.abort();
    for (const controller of completionPending.values()) controller.abort();
  });

  // `suggestGhost` 投影单元：last-wins fold。仅当投影注册表已组合时激活
  // （headless 组装不受影响）。
  //
  // 跨代注册：0.1.2 改了单元形状——`schema` → `stateSchema`，顶层 `view` 挪进
  // `wire.view`（payload schema 随之改名 `wire.viewSchema`），`init` 额外接收
  // (header, inheritedEventCount)（本插件的无参 init 天然兼容）。两代形状在
  // 对方的类型里都不可见，按 0.1.2 独有的 `cachedSnapshot` 方法探测代际后
  // 分别构造；类型层以宽松结构视图对接，运行时行为两代各自验证。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const registry = (projectionCtx as unknown as {
      sessionProjections?: {
        register: (definition: Record<string, unknown>) => () => void;
        cachedSnapshot?: unknown;
      };
    }).sessionProjections;
    if (registry === undefined) return;
    const is02 = typeof registry.cachedSnapshot === 'function';
    const fold = {
      key: PROJECTION_KEY,
      init: initSuggestGhostProjection,
      apply: applySuggestGhostProjection,
      stateVersion: 2,
    };
    if (is02) {
      registry.register({
        ...fold,
        stateSchema: suggestGhostSchema,
        wire: {
          viewSchema: suggestGhostSchema,
          view: (state: SuggestGhostProjection) => state,
        },
      });
    } else {
      registry.register({
        ...fold,
        schema: suggestGhostSchema,
        view: (state: SuggestGhostProjection) => state,
      });
    }
  });
  console.log('[dsh-suggest-ghost] apply() completed successfully');
  ctx.logger.info('dsh-suggest-ghost: apply() completed successfully');
}
