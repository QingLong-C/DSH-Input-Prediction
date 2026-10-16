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
import {
  defineDomain,
  domainTable,
  type Domain,
  type DomainFacility,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain';
import z from 'zod';
import type { HotnessChangeHook, HotnessOp } from './hotness.js';
import { HOT_TABLE_MAX_ENTRIES, HotnessTable } from './hotness.js';

/** 持久层一条记录：一个去重用户文本的累计频次（lastSeq 不持久化，见模块注释）。
 * `pinned` 仅在 true 时携带（可选字段保持与 v1 介质双向兼容）。 */
interface HotEntryRecord {
  text: string;
  count: number;
  pinned?: boolean;
}

/** 恢复时防御性截断：与 recordUserText 的上限一致，异常大记录直接跳过。 */
const RECORD_TEXT_MAX_CHARS = 2000;

/** 域声明：名字须匹配 UNIT_NAME_RE（小写字母开头的 [a-z0-9_]）。
 * `pinned` 为可选字段（v1 内演进，不 bump 版本——旧介质照常打开）。 */
const hotnessDomainSpec = defineDomain({
  name: 'suggest_ghost_hotness',
  version: 1,
  tables: { entries: domainTable(
    z.object({
      text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS),
      count: z.number().int().positive(),
      pinned: z.boolean().optional(),
    }),
  ) },
});

type HotnessDomain = Domain<typeof hotnessDomainSpec>;
type EntriesTable = KvTable<string, HotEntryRecord>;

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
export function setupHotnessPersistence(ctx: Context): {
  hotness: HotnessTable;
  persistence: HotnessPersistence;
} {
  /** 脏标记：text → 最新记账值（null = 待删除）。flush 前累积，flush 取快照清空。 */
  const dirty = new Map<string, Readonly<{ count: number; lastSeq: number; pinned: boolean }> | null>();
  let entries: EntriesTable | null = null;
  let domain: HotnessDomain | null = null;
  /** 恢复合并完成前的脏标记先攒着（否则 live 计数会以「缺历史频次」的值抢先落盘）。 */
  let ready = false;
  /** whenReady 的兑现柄：恢复阶段（成功或降级）结束时调用一次。 */
  let settleReady: () => void = () => {};
  const whenReady = new Promise<void>((resolve) => {
    settleReady = resolve;
  });

  const onChange: HotnessChangeHook = (text, entry) => {
    // 护栏：持久层未就绪（宿主无 storageDomain / open 失败）时脏标记永远不会被
    // flush 消费——超硬上限直接清空，防长驻进程内存泄漏。已就绪后 flush 每回合
    // 都会消费，到不了这个量级。即使 open 稍后成功，恢复合并（restoreEntry 的
    // merge 分支）会重新标记脏值，清空不丢正确性；最多损失 open 前的删除标记
    // （已淘汰条目下次重启多活一轮，有界churn，无害）。
    if (!ready && dirty.size >= HOT_TABLE_MAX_ENTRIES * 2) dirty.clear();
    dirty.set(text, entry);
  };
  const hotness = new HotnessTable(onChange);

  const flush = async (): Promise<void> => {
    const table = entries;
    if (table === null || !ready || dirty.size === 0) return;
    const batch = [...dirty];
    dirty.clear();
    const results = await Promise.allSettled(batch.map(([text, entry]) =>
      entry === null
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

  const close = async (): Promise<void> => {
    try {
      await flush();
    } finally {
      const closing = domain;
      domain = null;
      entries = null;
      ready = false;
      try {
        await closing?.close(); // 排空已在域写链上的写入；幂等
      } catch (error) {
        ctx.logger.warn(`dsh-suggest-ghost: hotness domain close failed: ${String(error)}`);
      }
    }
  };

  ctx.inject(['storageDomain'], (sctx) => {
    void (async () => {
      try {
        // 注入回调的 ctx 类型来自 dsh-storage-domain 的 Context augmentation；
        // 与 settings 注入一致地防御式取用，未挂载则静默降级为纯内存。
        const facility = (sctx as { storageDomain?: DomainFacility }).storageDomain;
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
        for (const record of records) hotness.restoreEntry(record.text, record.count, record.pinned === true);
        entries = table;
        domain = opened;
        ready = true;
        ctx.logger.info(
          `dsh-suggest-ghost: hotness persistence ready (${records.length} records restored, table size ${hotness.size})`,
        );
        // 卸载兜底挂在注入派生 fiber 上：storageDomain 卸载或插件卸载都会触发。
        ctx.effect(() => () => void close());
        void flush(); // 补写 open 窗口期累积的 live 记账与恢复合并值
        settleReady(); // 恢复合并已完成：消费方（index.ts）据此补推完整快照
      } catch (error) {
        ctx.logger.warn(`dsh-suggest-ghost: hotness persistence unavailable, staying in-memory: ${String(error)}`);
        settleReady(); // 降级同样终结恢复阶段：内存态即权威，消费方无需再等
      }
    })();
  });

  return {
    hotness,
    persistence: {
      get ready(): boolean {
        return ready;
      },
      whenReady,
      flush,
      close,
      applyOps(ops: readonly HotnessOp[]): number {
        let changed = 0;
        for (const op of ops) {
          switch (op.op) {
            case 'delete':
              if (hotness.deleteEntry(op.text)) changed += 1;
              break;
            case 'pin':
              if (hotness.setPinned(op.text, op.pinned === true)) changed += 1;
              break;
            case 'add':
              if (hotness.addEntry(op.text, op.pinned === true)) changed += 1;
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
  ops: z.array(
    z.discriminatedUnion('op', [
      z.object({ op: z.literal('delete'), text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS) }),
      z.object({ op: z.literal('pin'), text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS), pinned: z.boolean() }),
      z.object({ op: z.literal('add'), text: z.string().min(1).max(RECORD_TEXT_MAX_CHARS), pinned: z.boolean().optional() }),
      z.object({ op: z.literal('clear') }),
      z.object({ op: z.literal('pull'), sessionId: z.string().min(1) }),
    ]),
  ),
  /** client UI 语言（'zh' | 'en'）；可选，捎带在每次 _ops 写入中。 */
  locale: z.string().optional(),
});

/** `_ops` 解析结果：操作批 + 可选的 UI 语言。 */
export interface ParsedOpsResult {
  readonly ops: readonly HotnessOp[];
  readonly locale?: string;
}

/**
 * 解析 client 写入 `_ops` 的 JSON 载荷：非法/空载荷返回空结果（调用方据此
 * 跳过消费）。上限防御：单批操作数最多 1000（防畸形巨载荷拖住写链）。
 */
export function parseHotnessOps(raw: string | undefined): ParsedOpsResult {
  if (typeof raw !== 'string' || raw === '' || raw === EMPTY_OPS) return { ops: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ops: [] };
  }
  const result = opsPayloadSchema.safeParse(parsed);
  if (!result.success) return { ops: [] };
  return {
    ops: result.data.ops.slice(0, 1000),
    locale: result.data.locale,
  };
}

/** `_ops` 的空载荷（JSON 字符串的 null 表示；与 settings.EMPTY_PUSH 同值）。 */
const EMPTY_OPS = 'null';
