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
/** `_ops` 解析结果：操作批 + 可选的 UI 语言。 */
export interface ParsedOpsResult {
    readonly ops: readonly HotnessOp[];
    readonly locale?: string;
}
/**
 * 解析 client 写入 `_ops` 的 JSON 载荷：非法/空载荷返回空结果（调用方据此
 * 跳过消费）。上限防御：单批操作数最多 1000（防畸形巨载荷拖住写链）。
 */
export declare function parseHotnessOps(raw: string | undefined): ParsedOpsResult;
