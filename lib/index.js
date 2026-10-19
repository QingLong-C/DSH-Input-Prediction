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
import { appendToRing, HISTORY_PUSH_CAP, nextTrackedSuggestion, seedRingFromLog, SUGGESTION_CACHE_CAP, suggestionFieldsFor, suggestionIsCurrent, userTextOfEvent, } from './coldstart.js';
import { SUGGEST_EVENT } from './domain.js';
import { flattenConfig, resolveConfig } from './generate.js';
import { generateSuggestion, generateCompletion, sessionEvents } from './generate.js';
import { createLiveSettings } from './live-settings.js';
import { parseHotnessOps, setupHotnessPersistence } from './hotness-store.js';
import { applySuggestGhostProjection, initSuggestGhostProjection, suggestGhostSchema } from './projection.js';
import { EMPTY_PUSH, mergeLiveConfig, SUGGEST_GHOST_NAMESPACE } from './settings.js';
import { PROJECTION_KEY } from './domain.js';
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
export const Config = ConfigSchema;
/** 所需服务：LLM 路由 + 会话存储 + 设置服务。 */
export const inject = ['llm', 'sessions', 'settings'];
/** 插件名（与 cordis 条目 id 及 manifest 一致）。 */
export const name = 'dsh-suggest-ghost';
/** 从会话日志恢复已建议的最新回合号。 */
function lastSuggestedTurnInLog(session) {
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
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const states = new WeakMap();
    const tracked = new Set();
    // 全局跨会话热度表（增量，随 user/message 事件累积），并经 storageDomain
    // 持久化频次（宿主未挂 storageDomain 时自动降级为纯内存）。
    const { hotness, persistence } = setupHotnessPersistence(ctx);
    // 读取生成配置的 live 值：状态经 `_push` volatile 字段推给 client
    // （0.1.7 移除了 settings.yaml：字段载体从 SettingsScope 换成 volatile 配置
    // 字段，载荷结构不变）。
    let settingsSvc = null;
    /**
     * **默认层**：boot 时 `resolveConfig` 产物的拍平视图。
     *
     * `resolved = resolveConfig(config)` 是**深冻结的首次解析快照**——内核每次配置
     * 写入走 `configEditor.edit → mergeLayers → 重解析`，替换 fiber 持有的新 config，
     * 旧引用不回填（issue #19 的根因）。所以这份只能当默认值 / describe() 不可用时的
     * 回退，**不能**当实时值：#19 遗留段正是 `liveSettings = flattenConfig(resolved)`
     * 与 `effective()` 的两个入参同源、都在重读这份冻结快照，导致设置页改开关在运行中
     * 不生效（boot 前改好才正常）。
     */
    const bootSettings = flattenConfig(resolved);
    /**
     * **覆盖层**：用户可调项的实时视图，源自 `settings.describe()`（每次现读
     * `entry.fiber.config` 并展开 volatile，是插件内唯一可靠的实时值来源——与已修的
     * `readOps` 同一依据，只是这次用整个 `row.value`，而不只是 `_ops`）。
     *
     * 失效语义（缓存策略；热路径必读这段）：
     *  - **事件驱动为主**：`settings/document-updated(ns)` 命中本 ns 时 `invalidate()`
     *    标脏，**下一次读**才现调用 describe() 一次。事件风暴期间 N 次标脏合并成 1 次
     *    describe()，成本上界 = 读次数（每次生成 / 推送至多一次）而非事件次数。
     *  - **命中缓存零成本**：未脏且未过 TTL 时 `effective()` 返回同一个对象引用，
     *    不碰 describe()、不新建对象（`handleComplete` 每次续写、`statePushOf` 每次
     *    推送都要读，属高频）。
     *  - **TTL 兜底（默认 5s）**：万一监听没挂上 / 内核在别的 ownerContext 上 emit，
     *    最迟 5s 后自愈；代价是最多每 5s 一次 describe()。
     *  - **安全回退**：`settingsSvc` 未注入（启动早期）或 describe() 抛异常时沿用
     *    上一次权威快照（初值即 boot 默认层），永不抛——host 不能因读设置崩。两条
     *    失败路径都**清脏**（不做注定失败的重试，见 `live-settings.createLiveSettings`
     *    第 4 条），所以本回调里注入就位时**显式** `invalidate()` 一次，实时值在就位后
     *    的第一次读就到，不必等 TTL。
     *  - `_ops` / `_push` 是 volatile **传输载体**而非设置项，由 `live-settings` 的
     *    `FlatConfig` 键白名单挡在外面，不会被当配置值读进 effective()。
     */
    let liveSettingsFailed = false;
    const liveSettings = createLiveSettings({
        ns: SUGGEST_GHOST_NAMESPACE,
        // 必须是 getter 形态：settingsSvc 在 ctx.inject 回调里才就位。
        readDescribe: () => {
            const svc = settingsSvc;
            if (svc === null || typeof svc.describe !== 'function')
                return undefined;
            return svc.describe();
        },
        // 合并策略：默认层 = bootSettings，覆盖层 = describe() 提炼的实时值；
        // mergeLiveConfig 保留「provider/model 留空 = 继承主请求路由」的既有语义，并让
        // 「在设置页清空路由对」这一动作实时生效（boot 是旧读取结果，不是独立配置层）。
        merge: mergeLiveConfig,
        // 诊断走 ctx.logger（不新增 console.log 债务）。注意 describe() 失败的 TTL 重试
        // 是每 5s 一次，所以只在「真异常」上打一次 warn，恢复时补一条 info。
        // ⚠️ 但只有下面那条 `warn` 真的能落到任何地方（且仅当启动失败时进崩溃转储）：
        // 本宿主唯一的 logger exporter 的回调只收 warn/error，`info` / `debug` 会被丢弃——
        // 取证见 `traceOps` 上方那段。**所以 #19 的「设置页改了有没有生效」不能靠这几行
        // 判定**，要看 `[dsh-suggest-ghost][ops-trace]` 那侧的通道留痕，或另加一次性断言。
        onRefresh: (info) => {
            if (info.ok) {
                if (liveSettingsFailed) {
                    liveSettingsFailed = false;
                    ctx.logger.info('dsh-suggest-ghost: live settings recovered');
                }
                ctx.logger.debug?.(`dsh-suggest-ghost: live settings refreshed (rev=${String(info.revision)}, applied=${info.applied})`);
                return;
            }
            if (info.reason === 'describe-threw') {
                if (!liveSettingsFailed) {
                    liveSettingsFailed = true;
                    ctx.logger.warn(`dsh-suggest-ghost: live settings describe() failed, falling back to boot snapshot: ${String(info.error)}`);
                }
                return;
            }
            // 服务还没注入：boot 早期属预期，静默降级成 boot 视图。
            ctx.logger.debug?.(`dsh-suggest-ghost: live settings not ready (${String(info.reason)})`);
        },
    });
    /**
     * 当前生效配置 = boot 默认层 + describe() 实时覆盖层（身份记忆化：未刷新时
     * 返回同一个对象，读它是免费的）。describe() 不可用时退化成 boot 视图。
     */
    const effective = () => liveSettings.snapshot(bootSettings);
    /** 热度快照的 top-K 上限：同属用户可调项，必须读实时视图而不是冻结快照。 */
    const historySnapshotCap = () => effective().historyMaxEntries;
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
    let clientUiLocale;
    /**
     * 取当前 `_ops` 的载荷字符串。
     *
     * **必须走 settings 服务的 `describe()`**：内核每次配置写入会重新解析 config
     * 并替换 fiber 持有的对象，apply 参数里捕获的 volatile 引用会冻结在失效时刻的
     * 值（实测：client 写入 complete op 后，插件内的旧引用永远停在首次 pull 的
     * 载荷）。`describe()` 同步读取 `entry.fiber.config` 的展开值，是唯一权威源。
     * settings 服务尚未注入（启动早期）时回退到 volatile 引用读取。
     */
    const readOps = () => {
        const svc = settingsSvc;
        if (svc !== null && typeof svc.describe === 'function') {
            try {
                const listed = svc.describe();
                const rows = Array.isArray(listed)
                    ? listed
                    : Array.isArray(listed?.namespaces)
                        ? listed.namespaces
                        : [];
                for (const row of rows) {
                    if (row?.ns !== SUGGEST_GHOST_NAMESPACE)
                        continue;
                    const v = row.value?._ops;
                    if (typeof v === 'string')
                        return v;
                }
            }
            catch { /* describe 异常回退引用读取 */ }
        }
        const ref = resolved._ops;
        const payload = typeof ref === 'object' && ref !== null && typeof ref.get === 'function'
            ? ref.get()
            : ref;
        return typeof payload === 'string' ? payload : EMPTY_PUSH;
    };
    ctx.inject(['settings'], (settingsCtx) => {
        try {
            const svc = settingsCtx.settings;
            if (svc === undefined) {
                ctx.logger.warn('dsh-suggest-ghost: settings service is undefined');
                return;
            }
            settingsSvc = svc;
            // 服务就位 → 标脏并立刻预热一次实时视图。#19 遗留段的旧写法是
            // `liveSettings = flattenConfig(resolved)`——重读的仍是冻结的 boot 快照，
            // 等于没刷新；现在改走 describe()，此后设置页的改动无需重启即生效。
            liveSettings.invalidate();
            effective();
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
                if (settingsSvc === null)
                    return;
                const id = lastSuggestionSession;
                if (id !== null)
                    pushToClient(statePushOf(id));
            });
            // `_ops` 反向通道：client 经 `ctx.remote.settings.mutate(ns, ops)` 写入，
            // 内核改 volatile 引用并 emit `settings/document-updated(ns, revision)`。
            // 该事件只带 (ns, revision)，故每次都重读引用比对载荷。
            // **关键**：cordis 事件只向父级传播、不向子级传播。该事件 emit 在 settings
            // 服务的 ownerContext 上，插件自己的 ctx 收不到——必须监听 root。
            const eventCtx = ctx.root ?? ctx;
            eventCtx.on('settings/document-updated', (ns, revision) => {
                if (ns !== SUGGEST_GHOST_NAMESPACE)
                    return;
                // 事件驱动失效：下一次 effective() 现读一次 describe()（风暴期间 N 次事件
                // 合并成 1 次读，见 live-settings.createLiveSettings 的失效语义）。
                liveSettings.invalidate();
                const payload = readOps();
                if (payload === lastOpsPayload) {
                    return;
                }
                lastOpsPayload = payload;
                consumeOps(parseHotnessOps(payload), svc);
            });
        }
        catch (error) {
            ctx.logger.warn(`dsh-suggest-ghost: settings wiring failed: ${String(error)}`);
        }
    });
    // —— 每会话历史环：最近用户消息文本（时间序），供 client 历史前缀补全 ——
    // 0.1.2 起会话快照不再向插件暴露对话 nodes；历史文本改由 host 侧维护并经
    // `_push` 推送。host 本就逐事件扫 user/message 做热度记账，顺带成环零新增
    // 扫描。环是会话日志的按需物化缓存：pull 时未命中就从日志现种（日志持久化，
    // apply 时必然已在内存），「播种时机」与竞态窗口一并消失；会话活跃期间由
    // session/event 增量维护。筛选语义与 client extractHistory 对齐：只收
    // source.kind === 'user' 的文本块，跳过系统注入与超长文本，相邻重复只计
    // 一次。环容量 = HISTORY_PUSH_CAP × 2（推送窗口的两倍，硬上限防泄漏）。
    const historyRings = new Map();
    /** 取会话历史环：缓存未命中且会话存活时从日志物化（幂等，每会话至多一次）。 */
    const ringFor = (sessionId) => {
        const cached = historyRings.get(sessionId);
        if (cached !== undefined)
            return cached;
        const session = ctx.sessions.get(sessionId);
        if (session === undefined)
            return undefined; // 会话不存在（已销毁）：无法回答
        const seed = seedRingFromLog(session);
        historyRings.set(sessionId, seed);
        return seed;
    };
    const ringPush = (sessionId, text) => {
        // 先物化（未命中则从日志现种）：环是日志的缓存，绝不能凭空从单条文本起建
        // ——否则该会话的历史前缀会丢掉此前的所有轮次。
        const ring = ringFor(sessionId);
        if (ring === undefined)
            return; // 会话不存在（已销毁）：无环可维护
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
    const suggestionBySession = new Map();
    /** 最近一次产出的建议及其会话（跨会话兜底用；勿用于判定本会话有效性）。 */
    let lastSuggestion = null;
    let lastSuggestionSession = null;
    /** 取某会话当前语义有效的建议（null = 无）。判据从「时间」换成「语义」：
     * 建议对应的回合是否仍是该会话最后一个已完成回合——不是就作废（防止
     * 重启后把旧回合的建议当新建议显示）。这是 `_push` 里建议状态的唯一
     * 权威来源：启动时从盘上回读、pull 时校验后重推，都走这里。
     */
    const currentSuggestionFor = (sessionId) => {
        const session = ctx.sessions.get(sessionId);
        // 本会话自己的建议优先；没有则回落到最近一次建议（仅当它正属于本会话）。
        const own = suggestionBySession.get(sessionId)
            ?? (lastSuggestionSession === sessionId ? lastSuggestion : null);
        if (own === null)
            return null;
        return suggestionIsCurrent(own, session) ? own : null;
    };
    /**
     * 跨会话兜底：最近一次产出的建议（可能属于别的会话，client 会按归属隐藏）。
     */
    const lastSuggestionOf = () => lastSuggestion === null || lastSuggestionSession === null
        ? { suggestion: null, sessionId: null }
        : { suggestion: lastSuggestion, sessionId: lastSuggestionSession };
    /**
     * 更新追踪状态——建议的产出与作废只发生在生成路径，所以追踪也
     * 只在这里更新（载荷推送不改它，见 pushToClient）。
     */
    const trackSuggestion = (sessionId, suggestion) => {
        if (suggestion === null)
            suggestionBySession.delete(sessionId);
        else {
            suggestionBySession.set(sessionId, suggestion);
            // 有界：超容量时逐出最久未更新的会话（Map 保持插入序）。
            while (suggestionBySession.size > SUGGESTION_CACHE_CAP) {
                const oldest = suggestionBySession.keys().next();
                if (oldest.done === true)
                    break;
                suggestionBySession.delete(oldest.value);
            }
        }
        // 「最近一次」槽位保持原有语义：产出即占位；清空只在本会话时清。
        const next = nextTrackedSuggestion({ suggestion: lastSuggestion, sessionId: lastSuggestionSession }, sessionId, suggestion);
        lastSuggestion = next.suggestion;
        lastSuggestionSession = next.sessionId;
    };
    // —— 停顿续写状态 ——
    /** 续写结果缓存：sessionId → {draft, text}；LRU 上限 16。 */
    const COMPLETION_CACHE_CAP = 16;
    const completionCache = new Map();
    /**
     * 全局最近一次续写（含所属会话）。`_push` 是单槽 last-wins 通道：续写载荷
     * 只出现一瞬间，随后其他会话的 pull 应答就会覆盖掉它——客户端 describe 是
     * 快照式读取，几乎必然错过。故 host 在此追踪最近续写，**所有**后续推送一律
     * 捎带；客户端按 completionSessionId + draft 全等自行过滤。
     */
    let lastCompletion = null;
    /** 在途续写生成：sessionId → AbortController（单飞：同会话只保留最新一次）。 */
    const completionPending = new Map();
    const cacheCompletion = (sessionId, draft, text) => {
        completionCache.delete(sessionId);
        completionCache.set(sessionId, { draft, text });
        lastCompletion = { sessionId, completion: { draft, text } };
        while (completionCache.size > COMPLETION_CACHE_CAP) {
            const oldest = completionCache.keys().next();
            if (oldest.done === true)
                break;
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
    const handleComplete = (sessionId, draft) => {
        const cfg = effective();
        if (cfg.inlineEnabled === false) {
            return;
        }
        if (draft.trim().length < cfg.inlineMinChars) {
            return;
        }
        const session = ctx.sessions.get(sessionId);
        if (session === undefined) {
            return;
        }
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
        if (existing !== undefined)
            existing.abort();
        const controller = new AbortController();
        completionPending.set(sessionId, controller);
        const startedAt = Date.now();
        generateCompletion(ctx, cfg, session, draft, controller.signal, clientUiLocale || undefined, cfg.languageMode, cfg.uiLocaleWeight).then((result) => {
            // 生成完成：检查是否仍为当前（未被新草稿中止）。
            if (completionPending.get(sessionId) !== controller)
                return;
            completionPending.delete(sessionId);
            if (result.text === undefined) {
                // 空/不合格：过去是 `return` 静默，于是「宿主生成了但被净化链丢弃」与
                // 「根本没生成」在观测上完全同形（#17 的教训正在这一支上被重新违反）。
                traceOps(`completion dropped (empty or filtered) session=${sessionId} draftChars=${draft.length} in ${Date.now() - startedAt}ms`);
                return;
            }
            cacheCompletion(sessionId, draft, result.text);
            pushToClient({
                ...statePushOf(sessionId),
                completion: { draft, text: result.text },
                completionSessionId: sessionId,
            });
            // 只打字符数：续写正文是模型对用户草稿的模仿，抄进 tee 日志等于把用户输入的第二份副本落到盘上。
            traceOps(`completion generated session=${sessionId} draftChars=${draft.length} chars=${result.text.length} in ${Date.now() - startedAt}ms`);
        }, (error) => {
            if (completionPending.get(sessionId) !== controller)
                return;
            completionPending.delete(sessionId);
            // 中止 = 被新草稿取代，不算失败；其余必须留痕。原先这里是
            // `ctx.logger.debug?.()`，而 debug 被 exporter 的级别门直接丢弃
            // （@deepseek-ai/dsh-app-boot/lib/index.js:4053-4066，levels.default=2），
            // 等于没有任何输出面——路由缺失、模型报错都曾因此查不出来。
            if (!controller.signal.aborted) {
                traceFault('completion-failed', `completion failed for session ${sessionId} after ${Date.now() - startedAt}ms: ${String(error).slice(0, 200)}`);
            }
        });
    };
    /**
     * `_ops` / `_push` 通道的**语义留痕**唯一落点。
     *
     * ⚠️ **这里必须是 `console.log`。改回 `ctx.logger` 单通道等于把留痕删掉**——三条
     * 本机 0.2.0-rc.2 产物里核对过的事实（issue #20 只记到了第 1 条的一半）：
     *  1. 宿主全局**只注册了一个 logger exporter**：
     *     `@deepseek-ai/dsh-app-boot/lib/index.js:4053-4066`。它 `levels: { default: 2 }`
     *     （cordis 级别 error0 / info1 / warn2 / debug3，见
     *     `@deepseek-ai/cordis/lib/index.js:459-463`）把 `debug` 挡在门外，回调体又是
     *     `if (type === "warn" || type === "error") startupLogs.push(...)` →
     *     **`ctx.logger.info` 过了级别门也被回调丢弃**。
     *  2. 那个 `startupLogs` 数组唯一的写盘机会是启动失败时的
     *     `@deepseek-ai/dsh/lib/bin.js:158 reportStartupFailure`——文件开头就是
     *     `WARNING: Raw diagnostics...` + `error: StartupError: dsh: startup failed`。
     *     所以 `~/.dsh/logs/startup-*.log` 是**崩溃转储**，不是运行日志：健康进程里
     *     ctx.logger 一个字都不落任何地方。
     *  3. 宿主 stdout 被 tee 进 `~/.dsh/dsh-web.log`，`console.log` 是运行期**唯一**
     *     可见面（本机历史证据：那文件里 3016 行 `[dsh-suggest-ghost]` 全是 console）。
     *
     * 于是 `6dfcd78`（删 console.log）和 `8e08e2e`（删 ctx.logger.info）连着两轮，
     * 前者删掉的是唯一的可观测面，后者删掉的是本来就不存在的可观测面。
     *
     * 本 seam 是双通道：语义事件走 console.log（固定标记 `[dsh-suggest-ghost][ops-trace]`，
     * grep 得到，见 docs/internals-cordis-settings-pitfalls.md），故障再补一份
     * `ctx.logger.warn`，好在**启动失败转储**里也留一份证据。
     *
     * 量：每条都对应一个真实发生的通道事件，不在 render / 空转的 document-updated 上打
     * （空载荷不留痕），同类故障另有节流，见 `traceFault`。
     */
    const traceOps = (message) => {
        console.log(`[dsh-suggest-ghost][ops-trace] ${message}`);
    };
    /** 同类故障的累计次数（节流用）。 */
    const faultCounts = new Map();
    /**
     * 故障留痕：console.log（运行期可见）+ `ctx.logger.warn`（崩溃转储里也留一份）。
     * @param kind - 故障类别。同类**第一次**完整打印，之后每 `every` 次打一条带计数的——
     *   历史上 `_ops` 清空的 nested-transaction 拒绝在一个进程里刷了 372 行同样的报文，
     *   那本身就是噪声；但一次都不打就又回到「静默失败」，所以是节流而不是静音。
     */
    const traceFault = (kind, message, every = 50) => {
        const seen = (faultCounts.get(kind) ?? 0) + 1;
        faultCounts.set(kind, seen);
        if (seen !== 1 && seen % every !== 0)
            return;
        traceOps(`${message} [${kind} #${seen}]`);
        ctx.logger.warn(`dsh-suggest-ghost: ${message}`);
    };
    const fingerprintOf = (p) => {
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
    let lastPushFingerprint = null;
    let pushInFlight = null;
    let pendingPushPayload = null;
    const pushToClient = (p) => {
        if (settingsSvc === null)
            return;
        const fingerprint = fingerprintOf(p);
        if (lastPushFingerprint === fingerprint)
            return; // 无变化，跳过写盘
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
    const flushPush = () => {
        if (settingsSvc === null || pushInFlight !== null)
            return;
        const payload = pendingPushPayload;
        pendingPushPayload = null;
        if (payload === null)
            return;
        const rev = pushRev;
        pushInFlight = settingsSvc.update(SUGGEST_GHOST_NAMESPACE, { _push: payload })
            .then(() => {
            // 成功也要留痕：#15/#18 的验收判据是「这份载荷到底落盘了没有」。历史数据里
            // 这条通道只留下 372 次 nested-transaction 拒绝、**一次成功都没记过**，
            // 于是「从没写」和「写了就失败」在日志里长得一模一样。
            traceOps(`push landed rev=${rev} bytes=${payload.length}`);
        }, (error) => {
            const text = error instanceof Error ? error.message : String(error);
            // 与 `_ops` 清空同一个结构性拒绝：由 handler 链上发起的写入跑在 HMR 事务的
            // AsyncLocalStorage 里（取证见 consumeOps 中 `_ops` 清空那段注释）。
            // ⚠️ 这一次写入是**真丢了**：`pushToClient` 在写前就把 lastPushFingerprint
            // 置成了本次指纹，所以同内容的下一次 push 会被「无变化」直接跳过，只有某个
            // 字段真的变了才会重新出盘。修法要动写入路径/合并缓冲，不在本轮范围。
            if (/cannot be nested/i.test(text)) {
                traceFault('push-nested', `push refused inside settings transaction (rev=${rev} dropped): ${text}`);
                return;
            }
            traceFault('push-failed', `push to client failed (rev=${rev} dropped): ${text}`);
        })
            .finally(() => {
            pushInFlight = null;
            if (pendingPushPayload !== null)
                flushPush(); // 写入期间又有新载荷 → 续写最新
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
    const statePushOf = (sessionId) => {
        const ring = sessionId === null ? undefined : ringFor(sessionId);
        // 建议字段：本会话按语义校验取用；不属于本会话但仍被追踪的那条原样带上
        // （client 按会话归属守卫隐藏，切回时立即可用）。
        const fields = suggestionFieldsFor({ suggestion: lastSuggestion, sessionId: lastSuggestionSession }, sessionId, sessionId === null ? null : currentSuggestionFor(sessionId));
        return {
            suggestion: fields.suggestion,
            suggestionSessionId: fields.sessionId,
            hot: hotness.snapshot(historySnapshotCap()),
            total: hotness.size,
            history: ring === undefined ? null : ring.slice(-HISTORY_PUSH_CAP),
            historySessionId: ring === undefined ? null : sessionId,
            ...(sessionId !== null && completionCache.has(sessionId)
                ? { completion: completionCache.get(sessionId), completionSessionId: sessionId }
                : lastCompletion !== null
                    ? { completion: lastCompletion.completion, completionSessionId: lastCompletion.sessionId }
                    : {}),
        };
    };
    /**
     * `_ops` 消费器（watch 触发与启动遗留补消费共用）：pull 走统一的状态组装应答，
     * 其余操作交热表层应用（幂等），最后 flush 并清空队列。捎带的 locale 更新到
     * 模块变量，供后续语言检测使用。
     *
     * **留痕归这里，不归 `parseHotnessOps`**：解析函数是纯函数（无 ctx，也要被 smoke
     * 直接驱动），它把丢弃原因当数据返回；本函数是两个调用点（启动补消费 +
     * `document-updated`）唯一的汇聚处，在这里打日志意味着「新增第三个调用点也自动
     * 带留痕」。通道选择见 `traceOps` 上方那段，**不要**改回 ctx.logger 单通道。
     * @param parsed - 已解析的操作批 + 可选 locale + 可选丢弃原因。
     * @param svc - settings 写面，用于消费后清空 `_ops`。
     */
    const consumeOps = (parsed, svc) => {
        // 捎带的 UI 语言：有则更新（last-wins），无则保持上次值。
        if (parsed.locale !== undefined)
            clientUiLocale = parsed.locale;
        // 整批丢弃必须可见（#17：客户端写了、宿主没动、日志一个字都没有）。
        // 空载荷不走这条：那是消费后的正常态，每次都打就成了噪声。
        const dropped = parsed.rejected;
        if (dropped !== undefined) {
            traceFault('ops-dropped', `_ops batch dropped (${dropped.kind}, ${dropped.bytes} bytes): ${dropped.summary}`, 20);
        }
        const ops = parsed.ops;
        if (ops.length === 0)
            return;
        // 一批一行 + 每个「会驱动外部动作」的 op 一行：
        //  - 管理面板一次可以提交几十条 delete/pin/add，逐条打会把 tee 日志刷爆，
        //    所以纯热表操作只进 kinds 直方图（消费结果由下面那行 applied 给出）；
        //  - pull / complete 各自会驱动推送或 LLM 调用，才是 #15/#16/#18 验收要追的
        //    那一次动作，逐条打（实际每批至多一条）。
        const kinds = new Map();
        for (const op of ops)
            kinds.set(op.op, (kinds.get(op.op) ?? 0) + 1);
        traceOps(`ops batch received: n=${ops.length} kinds=${[...kinds].map(([kind, count]) => (count > 1 ? `${kind}x${count}` : kind)).join(',')}${parsed.locale !== undefined ? ` locale=${parsed.locale}` : ''}`);
        for (const op of ops) {
            if (op.op === 'pull') {
                traceOps(`ops consumed: pull session=${op.sessionId} (应答走 pushToClient)`);
                // 无论历史环可不可得都应答：环缺失（会话尚未进店/已销毁）时 statePushOf
                // 会省略 history（client 保留现值），但热度与对账后的建议照常送达——
                // 静默丢弃会让 client 永远等不到这一轮对账。
                pushToClient(statePushOf(op.sessionId));
            }
            else if (op.op === 'complete') {
                // 草稿只打长度不打正文：留痕要能对上号，但不能把用户输入抄进 tee 日志。
                traceOps(`ops consumed: complete session=${op.sessionId} draftChars=${op.draft.length}`);
                handleComplete(op.sessionId, op.draft);
            }
        }
        const changed = persistence.applyOps(ops);
        traceOps(`hotness ops applied: batch=${ops.length} changed=${changed} tableSize=${hotness.size}`);
        void persistence.flush();
        // 消费完成：清空操作队列（下一次 watch 触发时 ops 为空，直接跳过）。
        //
        // ⚠️ **这次清空历史上几乎必然失败，而且失败是被静默吞掉的**（373 次里 372 次
        // `HMR transactions cannot be nested`）。机制：`SettingsForms.write()` 在
        // `configEditor.edit()` 的回调**内**调 `this.describe()`
        // （`@deepseek-ai/dsh-settings/lib/index.js:510`），而 `describe()` 就地
        // `emit("settings/document-updated")`（同文件 :435）→ 本回调跑在
        // `@deepseek-ai/dsh-hmr/lib/index.js:284` 的 `executing.run(true, ...)` 里 →
        // 这里的 `update` 再进 `runExclusive`，:280 的
        // `if (this.executing.getStore()) return Promise.reject(new Error("HMR transactions cannot be nested"))`
        // 直接拒绝。**排到下一个 tick 也逃不掉**：`executing` 是 AsyncLocalStorage，
        // 上下文沿 await/microtask/timer 继续传播（本机实测：事务内建的 setTimeout
        // 回调里 `getStore()` 仍是 true；只有事务外建立的上下文才是 undefined）。
        // 修法要动写入路径（可靠的事务外锚点），不在本轮范围——这里先把它**分诊**出来：
        // nested 拒绝按已知结构性失败节流，其他错误一次一打。
        void svc.update(SUGGEST_GHOST_NAMESPACE, { _ops: EMPTY_PUSH }).then(() => {
            traceOps('_ops cleared after consume');
        }, (error) => {
            const text = error instanceof Error ? error.message : String(error);
            if (/cannot be nested/i.test(text)) {
                traceFault('ops-clear-nested', `_ops clear refused inside settings transaction (payload stays on disk; re-consume is blocked only by the in-process payload guard): ${text}`);
                return;
            }
            traceFault('ops-clear-failed', `_ops clear failed (payload stays on disk and will be re-read on next update): ${text}`);
        });
    };
    const handleTurnEnd = (session, turn) => {
        // 回合边界是热表持久化的天然写点：本回合累计的 user/message 频次合并落盘
        // （fail-soft，未就绪/无脏标记时空转；卸载另有 close 兜底）。
        void persistence.flush();
        let state = states.get(session);
        if (state === undefined) {
            state = { lastSuggestedTurn: lastSuggestedTurnInLog(session), pending: undefined, lastLanguage: undefined };
            states.set(session, state);
            tracked.add(state);
        }
        if (state.lastSuggestedTurn === turn)
            return;
        const pending = state.pending;
        if (pending !== undefined) {
            if (pending.turn === turn)
                return;
            pending.controller.abort();
        }
        // 本回合的生效配置：只读一次，保证「是否关 LLM」与「热度 top-K」出自同一
        // 快照（两次读之间若有 document-updated，会拿到跨新旧的值对）。
        const turnCfg = effective();
        // LLM 建议被用户关闭：跳过模型调用（省 token），但热度照常推进并推送，
        // 历史前缀补全不受影响；同时把残留建议清空，避免幽灵残留。
        if (turnCfg.llmEnabled === false) {
            state.pending = undefined;
            state.lastSuggestedTurn = turn;
            trackSuggestion(session.id, null); // 关闭 LLM：本会话建议作废（其他会话不受影响）
            const hot = hotness.snapshot(turnCfg.historyMaxEntries);
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
            return generateSuggestion(ctx, cfg, session, turn, controller.signal, clientUiLocale, cfg.languageMode, cfg.uiLocaleWeight, state.lastLanguage);
        })
            .then((result) => {
            if (state?.pending?.controller !== controller)
                return;
            state.pending = undefined;
            state.lastSuggestedTurn = turn;
            state.lastLanguage = result.language;
            // 经 settings 实时推给 client（不写日志）。热度快照始终附带：
            // 其频次参与历史补全打分（新近度为主、频次为辅）；「跨会话搜索」
            // 开关仅在 client 端决定是否把这些文本并作候选。历史环随推：client
            // 端补全的文本源（0.1.2 会话快照已不对插件暴露对话 nodes）。
            const hot = hotness.snapshot(historySnapshotCap());
            trackSuggestion(session.id, result.suggestion ?? null);
            pushToClient({
                suggestion: result.suggestion ?? null,
                suggestionSessionId: session.id,
                hot,
                total: hotness.size,
                history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
                historySessionId: session.id,
            });
        }, (error) => {
            if (state?.pending?.controller === controller)
                state.pending = undefined;
            if (controller.signal.aborted)
                return; // 被新回合取代，失败符合预期
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.warn(`dsh-suggest-ghost: suggestion generation failed: ${message}`);
            // 失败也推送：清掉残留幽灵 + 把错误摘要带给 client/设置页（可诊断）。
            trackSuggestion(session.id, null);
            const hot = hotness.snapshot(historySnapshotCap());
            pushToClient({
                suggestion: null,
                suggestionSessionId: null,
                hot,
                total: hotness.size,
                history: (ringFor(session.id) ?? []).slice(-HISTORY_PUSH_CAP),
                historySessionId: session.id,
                error: message.slice(0, 300),
            });
        });
    };
    ctx.on('session/event', (session, event) => {
        // 传会话 id：同会话相邻重复的用户消息只计一次热度（对齐 extractHistory 的去重语义）。
        hotness.consume(event, session.id);
        const userText = userTextOfEvent(event);
        // ringPush 会先按需物化（含本事件之前的日志），无需任何「首见播种」步骤。
        if (userText !== null)
            ringPush(session.id, userText);
        if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
            handleTurnEnd(session, event.data.turn);
        }
    });
    // 插件卸载时中止所有在途生成（建议 + 续写）。
    ctx.effect(() => () => {
        for (const state of tracked)
            state.pending?.controller.abort();
        for (const controller of completionPending.values())
            controller.abort();
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
        const registry = projectionCtx.sessionProjections;
        if (registry === undefined)
            return;
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
                    view: (state) => state,
                },
            });
        }
        else {
            registry.register({
                ...fold,
                schema: suggestGhostSchema,
                view: (state) => state,
            });
        }
    });
}
