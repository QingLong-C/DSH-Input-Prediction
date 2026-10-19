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
import type { Context } from '@deepseek-ai/cordis';
import type { HotnessOp } from './hotness.js';
import { HotnessTable } from './hotness.js';
/** `_ops` 反向通道载荷（client 管理面板写入 settings 的 JSON）。 */
export interface HotnessOpsPayload {
    readonly rev: number;
    readonly ops: readonly HotnessOp[];
    /** client 的 UI 语言（'zh' | 'en'）；捎带在每次 _ops 写入中，host 据此做语言先验。 */
    readonly locale?: string;
}
/** 持久化句柄：index.ts 在回合结束时调用 flush，卸载时 close 兜底。 */
export interface HotnessPersistence {
    /** 持久域是否已就绪（open + 恢复合并完成）；未就绪时 flush 只保留脏标记。 */
    readonly ready: boolean;
    /**
     * 恢复阶段结束的信号：domain open + 恢复合并完成时兑现，open 失败（降级为
     * 纯内存）时同样兑现——两种结局都意味着「热度表已不会再被异步改写」。宿主
     * 未挂 storageDomain 时永不兑现：那种组合下没有异步恢复可等，启动瞬间的
     * 内存态即权威，消费方无需补推。
     */
    readonly whenReady: Promise<void>;
    /** 合并把脏条目落盘（fail-soft；domain 未就绪时只保留脏标记，恢复后补写）。 */
    flush(): Promise<void>;
    /** 卸载兜底：最终 flush（排空脏标记）再关闭 domain（排空在途写）。 */
    close(): Promise<void>;
    /**
     * 管理面板操作（`_ops` 通道）应用：同步改热表并标脏；调用方随后 flush
     * （index.ts 消费 `_ops` 后统一 flush + 回推 `_push`）。
     * @returns 实际产生变化的条数（0 = 全部为 no-op）。
     */
    applyOps(ops: readonly HotnessOp[]): number;
}
/**
 * 装配热度表 + 持久化：构造带脏标记回调的热表，并（可选地）经 storageDomain
 * 打开持久域、恢复历史频次、注册卸载兜底。
 * @returns hotness 供 index.ts 消费事件 / 取快照；persistence 供回合结束 flush。
 */
export declare function setupHotnessPersistence(ctx: Context): {
    hotness: HotnessTable;
    persistence: HotnessPersistence;
};
/**
 * `_ops` 载荷被丢弃的原因（`parseHotnessOps` 的留痕载荷）。
 *
 * **为什么用返回值而不是日志回调**：`parseHotnessOps` 是纯函数（无 ctx、无 I/O），
 * 它跑在 host 的 settings 事件回调里，也在 smoke 里被直接驱动。留痕走两条完全不同的
 * 通道（host 要 `ctx.logger.warn`、smoke 要断言「未知 op 被拒且有留痕」），所以这里
 * 把**原因作为数据返回**，由调用方决定怎么落地：
 *  - `index.ts` 的 `consumeOps` 统一打印（两个调用点共用同一个消费者，漏打印的可能
 *    性只存在于一个函数里，新增第三个调用点也自动带上留痕）；
 *  - `scripts/ops-schema-coverage-smoke.mjs` 直接断言这个字段。
 * 传回调（`onReject`）也能work，但它把「打什么级别」这个决策塞进了纯函数，且 smoke
 * 要造假 ctx 才能观察；返回数据两者都不付。
 */
export interface OpsRejectInfo {
    /** `json` = 载荷不是合法 JSON；`schema` = JSON 合法但被 `opsPayloadSchema` 整批拒绝。 */
    readonly kind: 'json' | 'schema';
    /** 可直接进日志的单行摘要（已截断，含 zod issues——#17 的直接教训）。 */
    readonly summary: string;
    /** 载荷字节数（判断是不是被截断/塞了巨载荷；不含正文，避免把用户草稿抄进日志）。 */
    readonly bytes: number;
}
/**
 * schema 侧实际放行的 op 变体清单（`hotnessSchemaVariants` 的返回元素）。
 */
export interface OpsSchemaVariant {
    /** 判别式字面量（`op` 的取值）。 */
    readonly op: string;
    /** 必填的其余字段名（不含 `op`）。 */
    readonly required: readonly string[];
    /** 可选的其余字段名。 */
    readonly optional: readonly string[];
}
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
export declare function hotnessSchemaVariants(): readonly OpsSchemaVariant[];
/** `_ops` 解析结果：操作批 + 可选的 UI 语言 + 可选的丢弃原因。 */
export interface ParsedOpsResult {
    readonly ops: readonly HotnessOp[];
    readonly locale?: string;
    /** 有值 = 这份载荷被整批丢弃了，**调用方必须留痕**（空载荷不算，见下）。 */
    readonly rejected?: OpsRejectInfo;
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
export declare function parseHotnessOps(raw: string | undefined): ParsedOpsResult;
