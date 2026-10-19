/**
 * 热度表持久化：经宿主 `ctx.storageDomain`（dsh-storage-domain）把 HotnessTable
 * 的跨会话频次落到 storage backend（随宿主 json backend 落在 `~/.dsh/storages/`），
 * 重启后恢复，频次信号（打分公式里的 hotFreq）不再从零累积。
 *
 * 设计（与宿主 `dsh-session-projection-cache` 同一模式）：
 *  - 域声明 `suggest_ghost_hotness`，单表 `entries`，一条记录一个去重文本的频次；
 *  - 写路径 fail-soft：写失败只告警，热表照常工作（损失的是重启后的频次）；
 *  - 写合并在内存标脏（HotnessChangeHook），flush 时机：回合结束 + 卸载兜底，
 *    不逐条 user/message 写盘；恢复合并在 domain open 后一次性完成；
 *  - 恢复条目的 lastSeq 取 -∞（seq 是会话内单调号，跨会话不可比——恢复条目
 *    排到最近性最末，真实再次出现时自然被 live seq 推进），只持久化 count。
 *
 * 装配是可选的：宿主未挂 `storageDomain`（如极简 headless 组合）时回调不触发，
 * 热表行为与纯内存版完全一致（与 settings 注入同一防御模式）。
 * @module dsh-suggest-ghost/hotness-store
 */
import { defineDomain, domainTable, } from '@deepseek-ai/dsh-storage-domain';
import z from 'zod';
import { HOT_TABLE_MAX_ENTRIES, HotnessTable } from './hotness.js';
/** 恢复时防御性截断：与 recordUserText 的上限一致，异常大记录直接跳过。 */
const RECORD_TEXT_MAX_CHARS = 2000;
/** 域声明：名字须匹配 UNIT_NAME_RE（小写字母开头的 [a-z0-9_]）。
 * `pinned` 为可选字段（v1 内演进，不 bump 版本——旧介质照常打开）。 */
const hotnessDomainSpec = defineDomain({
    name: 'suggest_ghost_hotness',
    version: 1,
    tables: { entries: domainTable(z.object({
            text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS),
            count: z.number().int().positive(),
            pinned: z.boolean().optional(),
        })) },
});
/**
 * 装配热度表 + 持久化：构造带脏标记回调的热表，并（可选地）经 storageDomain
 * 打开持久域、恢复历史频次、注册卸载兜底。
 * @returns hotness 供 index.ts 消费事件 / 取快照；persistence 供回合结束 flush。
 */
export function setupHotnessPersistence(ctx) {
    /** 脏标记：text → 最新记账值（null = 待删除）。flush 前累积，flush 取快照清空。 */
    const dirty = new Map();
    let entries = null;
    let domain = null;
    /** 恢复合并完成前的脏标记先攒着（否则 live 计数会以「缺历史频次」的值抢先落盘）。 */
    let ready = false;
    /** whenReady 的兑现柄：恢复阶段（成功或降级）结束时调用一次。 */
    let settleReady = () => { };
    const whenReady = new Promise((resolve) => {
        settleReady = resolve;
    });
    const onChange = (text, entry) => {
        // 护栏：持久层未就绪（宿主无 storageDomain / open 失败）时脏标记永远不会被
        // flush 消费——超硬上限直接清空，防长驻进程内存泄漏。已就绪后 flush 每回合
        // 都会消费，到不了这个量级。即使 open 稍后成功，恢复合并（restoreEntry 的
        // merge 分支）会重新标记脏值，清空不丢正确性；最多损失 open 前的删除标记
        // （已淘汰条目下次重启多活一轮，有界churn，无害）。
        if (!ready && dirty.size >= HOT_TABLE_MAX_ENTRIES * 2)
            dirty.clear();
        dirty.set(text, entry);
    };
    const hotness = new HotnessTable(onChange);
    const flush = async () => {
        const table = entries;
        if (table === null || !ready || dirty.size === 0)
            return;
        const batch = [...dirty];
        dirty.clear();
        const results = await Promise.allSettled(batch.map(([text, entry]) => entry === null
            ? table.delete(text)
            // pinned 仅 true 时落盘（可选字段，与 v1 介质兼容；false 省略）
            : entry.pinned
                ? table.put(text, { text, count: entry.count, pinned: true })
                : table.put(text, { text, count: entry.count })));
        for (const result of results) {
            if (result.status === 'rejected') {
                ctx.logger.warn(`dsh-suggest-ghost: hotness persist write failed: ${String(result.reason)}`);
            }
        }
    };
    const close = async () => {
        try {
            await flush();
        }
        finally {
            const closing = domain;
            domain = null;
            entries = null;
            ready = false;
            try {
                await closing?.close(); // 排空已在域写链上的写入；幂等
            }
            catch (error) {
                ctx.logger.warn(`dsh-suggest-ghost: hotness domain close failed: ${String(error)}`);
            }
        }
    };
    ctx.inject(['storageDomain'], (sctx) => {
        void (async () => {
            try {
                // 注入回调的 ctx 类型来自 dsh-storage-domain 的 Context augmentation；
                // 与 settings 注入一致地防御式取用，未挂载则静默降级为纯内存。
                const facility = sctx.storageDomain;
                // 服务在但域不可用：同样是「不会再被异步改写」的终局，兑现信号。
                if (facility === undefined) {
                    settleReady();
                    return;
                }
                const opened = await facility.open(hotnessDomainSpec);
                const table = opened.table('entries');
                // 恢复：count 降序截断到容量上限（防御历史超限 / 未来上限调小），合并进活表。
                const records = [...table.entries()]
                    .map(([, record]) => record)
                    .sort((a, b) => b.count - a.count)
                    .slice(0, HOT_TABLE_MAX_ENTRIES);
                for (const record of records)
                    hotness.restoreEntry(record.text, record.count, record.pinned === true);
                entries = table;
                domain = opened;
                ready = true;
                // 卸载兜底挂在注入派生 fiber 上：storageDomain 卸载或插件卸载都会触发。
                ctx.effect(() => () => void close());
                void flush(); // 补写 open 窗口期累积的 live 记账与恢复合并值
                settleReady(); // 恢复合并已完成：消费方（index.ts）据此补推完整快照
            }
            catch (error) {
                ctx.logger.warn(`dsh-suggest-ghost: hotness persistence unavailable, staying in-memory: ${String(error)}`);
                settleReady(); // 降级同样终结恢复阶段：内存态即权威，消费方无需再等
            }
        })();
    });
    return {
        hotness,
        persistence: {
            get ready() {
                return ready;
            },
            whenReady,
            flush,
            close,
            applyOps(ops) {
                let changed = 0;
                for (const op of ops) {
                    switch (op.op) {
                        case 'delete':
                            if (hotness.deleteEntry(op.text))
                                changed += 1;
                            break;
                        case 'pin':
                            if (hotness.setPinned(op.text, op.pinned === true))
                                changed += 1;
                            break;
                        case 'add':
                            if (hotness.addEntry(op.text, op.pinned === true))
                                changed += 1;
                            break;
                        case 'clear':
                            changed += hotness.clearAll();
                            break;
                        default:
                            break; // 未知操作忽略（前后版本协议差异下保持宽容）
                    }
                }
                return changed;
            },
        },
    };
}
/** `_ops` 载荷的单条操作校验 schema（与 HotnessOp 对齐；非法载荷整体拒绝）。 */
const opsPayloadSchema = z.object({
    rev: z.number(),
    ops: z.array(z.discriminatedUnion('op', [
        z.object({ op: z.literal('delete'), text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS) }),
        z.object({ op: z.literal('pin'), text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS), pinned: z.boolean() }),
        z.object({ op: z.literal('add'), text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS), pinned: z.boolean().optional() }),
        z.object({ op: z.literal('clear') }),
        z.object({ op: z.literal('pull'), sessionId: z.string().min(1) }),
        z.object({ op: z.literal('complete'), sessionId: z.string().min(1), draft: z.string().min(1) }),
    ])),
    /** client UI 语言（'zh' | 'en'）；可选，捎带在每次 _ops 写入中。 */
    locale: z.string().optional(),
});
/**
 * 从 `opsPayloadSchema` **现推导**「schema 这一侧认得哪些 op 变体、各自要求哪些字段」。
 *
 * 存在的唯一理由：#17 是「`domain.ts` 的 TS 类型有 `complete`、schema 没有」这种
 * 两份真相互不约束的漂移，而编译器不会报错。漂移断言（`scripts/ops-schema-coverage-smoke.mjs`）
 * 要拿这一侧的清单去和 TS 那一侧比，所以这份清单**必须**从真正在跑的 schema 推导，
 * 不能手抄——手抄的名单自己就会变成第三份会漂移的真相。
 *
 * 推导失败（zod 换大版本、`discriminatedUnion` 内部形状变了）时**直接抛**：
 * 静默返回空数组会让漂移断言「全都对」，那比没有断言更坏。
 */
export function hotnessSchemaVariants() {
    const opsNode = opsPayloadSchema.shape.ops;
    const options = opsNode?.element?.options;
    if (!Array.isArray(options)) {
        throw new Error('dsh-suggest-ghost: cannot introspect opsPayloadSchema (zod internal shape changed?)');
    }
    return options.map((option) => {
        const shape = option.shape;
        if (shape === undefined) {
            throw new Error('dsh-suggest-ghost: opsPayloadSchema option has no .shape (zod internal shape changed?)');
        }
        // zod v4：`z.literal('x')` 的判别值在公开访问器 `.value` 上，内部 `def.values` 是数组。
        // 两种都认，是为了让这个「推导」本身不因 zod 小版本换内部形状而静默给出错的名单。
        const opNode = shape.op;
        const kind = opNode?.def?.type;
        const op = kind === 'literal'
            ? (typeof opNode?.value === 'string' ? opNode.value : opNode?.def?.values?.[0])
            : undefined;
        if (typeof op !== 'string') {
            throw new Error('dsh-suggest-ghost: opsPayloadSchema option has no literal `op` discriminator');
        }
        const required = [];
        const optional = [];
        for (const [key, child] of Object.entries(shape)) {
            if (key === 'op')
                continue;
            const kind = child.def?.type;
            if (kind === 'optional' || kind === 'default')
                optional.push(key);
            else
                required.push(key);
        }
        return { op, required, optional };
    });
}
/** 日志摘要里保留的 zod issues 条数上限（再多也没法看）。 */
const ISSUE_SUMMARY_MAX = 4;
/** 把 zod issues 收成一行摘要：`path:code(message)`。 */
function summarizeIssues(issues) {
    return issues
        .slice(0, ISSUE_SUMMARY_MAX)
        .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.code} (${issue.message})`)
        .join('; ')
        + (issues.length > ISSUE_SUMMARY_MAX ? `; …${issues.length - ISSUE_SUMMARY_MAX} more` : '');
}
/** 截断成单行日志片段（压掉换行，避免多行载荷污染日志）。 */
function headOf(raw, limit) {
    const flat = raw.replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
/**
 * 解析 client 写入 `_ops` 的 JSON 载荷：非法/空载荷返回空结果（调用方据此
 * 跳过消费）。上限防御：单批操作数最多 1000（防畸形巨载荷拖住写链）。
 *
 * **三条返回空 ops 的路径语义不同，留痕也不同**（Gitea #17 的教训：载荷被整批
 * 拒了却毫无线索）：
 *  1. 空载荷（`undefined` / `''` / `'null'`）：**正常态**，不是丢弃。host 每次消费
 *     完都把 `_ops` 写回空值，`document-updated` 必然再读到它，所以这里不打日志
 *     （打了就是每次推送一条噪声）。
 *  2. JSON 解析失败 → `rejected.kind = 'json'`，必须留痕。
 *  3. zod 拒绝 → `rejected.kind = 'schema'`，必须留痕并带 issues 摘要（整批丢弃的
 *     原因只有 issues 能说清）。
 * 2/3 由调用方（`index.ts` 的 `consumeOps`）经 `ctx.logger.warn` 打印——不用
 * console.log：main 的 `6dfcd78`（chore: remove all debug console.log statements）
 * 正是把 console 当调试噪声清掉的那次；走 logger 的留痕不会被下一轮清理顺手删。
 */
export function parseHotnessOps(raw) {
    if (typeof raw !== 'string' || raw === '' || raw === EMPTY_OPS)
        return { ops: [] };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        return {
            ops: [],
            rejected: {
                kind: 'json',
                summary: `JSON.parse failed: ${String(error instanceof Error ? error.message : error)}; head=${headOf(raw, 120)}`,
                bytes: raw.length,
            },
        };
    }
    const result = opsPayloadSchema.safeParse(parsed);
    if (!result.success) {
        // 静默丢弃会让「客户端写了、宿主没动」彻底不可诊断——必须留痕（见上面第 3 条）。
        return {
            ops: [],
            rejected: {
                kind: 'schema',
                summary: `opsPayloadSchema rejected the batch: ${summarizeIssues(result.error.issues)}`,
                bytes: raw.length,
            },
        };
    }
    return {
        ops: result.data.ops.slice(0, 1000),
        locale: result.data.locale,
    };
}
/** `_ops` 的空载荷（JSON 字符串的 null 表示；与 settings.EMPTY_PUSH 同值）。 */
const EMPTY_OPS = 'null';
