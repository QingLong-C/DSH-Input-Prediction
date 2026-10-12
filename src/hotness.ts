/**
 * 跨会话历史热度表：增量统计所有会话 `user/message` 的去重文本频次。
 * host 端全局一份，供历史补全打分取 top-K 快照（经 settings `_push` 送达 client）。
 * 纯内存、无持久化；重启后从零累积。条目数有上限（最久未用者淘汰），长驻内存有界。
 *
 * 淘汰用 lazy-deletion 最小堆（按 lastSeq）：新条目入堆，条目 lastSeq 更新时
 * 旧堆项自然过期，evict 时从堆顶跳过过期项——O(log n) 淘汰，替代全表线性扫描。
 *
 * 持久化（可选）：构造时传入 {@link HotnessChangeHook}，表在每次记账/淘汰时
 * 上报变更，由 `hotness-store` 合并落盘；重启后经 {@link restoreEntry} 恢复频次。
 * @module dsh-suggest-ghost/hotness
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { SuggestGhostHotEntry } from './domain.js';

/** 单条候选文本最大长度：超过视为系统注入/超大粘贴，不进热表。 */
export const HOT_TEXT_MAX_CHARS = 2000;

/** 热表条目数上限：超过后淘汰最近性最差的条目，防止长驻进程内存无限增长。
 * 取 2000 与设置页「最大历史条目」可配置的上限对齐（避免用户配大值被静默砍半）。 */
export const HOT_TABLE_MAX_ENTRIES = 2000;

/** 单条用户文本的热度记账。 */
interface HotEntry {
  /** 累计跨会话出现频次。 */
  count: number;
  /** 最近一次出现的事件 seq（跨会话越大越新）。 */
  lastSeq: number;
  /** 用户固定：不参与最近性淘汰，snapshot 恒置顶（热度管理 UI 可切换）。 */
  pinned: boolean;
}

/**
 * 热度变更回调（持久化的脏标记来源）：entry 非空为记账/频次更新（携带最新
 * 记账值），null 为淘汰删除。恢复路径（restoreEntry 的插入）不上报——数据本
 * 就来自持久层，回写是纯浪费。
 */
export type HotnessChangeHook = (
  text: string,
  entry: Readonly<{ count: number; lastSeq: number; pinned: boolean }> | null,
) => void;

/** 单条热度管理操作（管理面板经 `_ops` 反向通道送达 host）；定义在 domain.ts（client 共享）。 */
export type { HotnessOp } from './domain.js';

/**
 * 按 `(seq, count)` 字典序升序的最小堆（lazy-deletion）：
 *  - 第一优先级：`seq` 升序（老的先淘汰）
 *  - 第二优先级：`count` 升序（同 `seq` 时，低频次先淘汰）
 *
 * 恢复条目全部 `seq = -∞`，但按 `count` 升序排列——低频旧消息先走，高频
 * （如 ×21）保留更久。pop 时由调用方校验条目是否仍是当前值（seq 与表内
 * 一致），过期的旧版本堆项被丢弃后继续弹。仅用于找「淘汰优先级最高」的
 * 候选，不需要 decrease-key。
 */
class MinSeqHeap {
  private readonly heap: Array<{ readonly text: string; readonly seq: number; readonly count: number }> = [];

  /** 压入一条（可重复压入同 text 的新版本；旧版本在 pop 时惰性跳过）。 */
  push(text: string, seq: number, count: number): void {
    const node = { text, seq, count };
    this.heap.push(node);
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[parent]!, node) <= 0) break;
      const parentNode = this.heap[parent]!;
      const childNode = this.heap[i]!;
      this.heap[parent] = childNode;
      this.heap[i] = parentNode;
      i = parent;
    }
  }

  /**
   * 弹出淘汰优先级最高（(seq, count) 最小）的堆项；跳过已被 {@link validator}
   * 判为过期的项。
   * @param validator - (text, seq) => boolean；返回 false 的堆项视为陈旧版本，
   * 直接丢弃（它对应的条目要么已删除、要么 lastSeq 已推进到更新的值）。
   */
  popValid(validator: (text: string, seq: number) => boolean): { readonly text: string; readonly seq: number } | undefined {
    while (this.heap.length > 0) {
      const top = this.heap[0]!;
      const last = this.heap.pop()!;
      if (this.heap.length > 0) {
        this.heap[0] = last;
        let i = 0;
        const n = this.heap.length;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let smallest = i;
          if (l < n && this.compare(this.heap[l]!, this.heap[smallest]!) < 0) smallest = l;
          if (r < n && this.compare(this.heap[r]!, this.heap[smallest]!) < 0) smallest = r;
          if (smallest === i) break;
          const smallestNode = this.heap[smallest]!;
          const node = this.heap[i]!;
          this.heap[smallest] = node;
          this.heap[i] = smallestNode;
          i = smallest;
        }
      }
      if (validator(top.text, top.seq)) return top;
    }
    return undefined;
  }

  /** 复合比较：先按 seq 升序，同 seq 按 count 升序（低频次优先淘汰）。 */
  private compare(a: { readonly seq: number; readonly count: number }, b: { readonly seq: number; readonly count: number }): number {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.count - b.count;
  }

  get size(): number {
    return this.heap.length;
  }
}

/** 跨会话频次与最近性都保留（按 count 降序、lastSeq 降序取 top-K）。 */
export class HotnessTable {
  private readonly table = new Map<string, HotEntry>();
  /** 每个会话最近一条已入表文本（trim 后）：同会话相邻重复不再计入频次。 */
  private readonly lastTextBySession = new Map<string, string>();
  /** 按 lastSeq 的最小堆：evict 时取最近性最差的条目（lazy-deletion）。 */
  private heap = new MinSeqHeap();

  /** 变更回调（持久化脏标记来源）；缺省为纯内存用法。 */
  private readonly onChange: HotnessChangeHook | undefined;

  constructor(onChange?: HotnessChangeHook) {
    this.onChange = onChange;
  }

  /**
   * 记账一次出现：同一会话内与上一条相邻重复的文本不再累计频次
   * （同一时刻重发 / 回放重复派发不应虚增热度）；跨会话的再次出现正常累计。
   */
  recordUserText(text: string, seq: number, sessionId?: string): void {
    const clean = text.trim();
    if (clean === '') return;
    const sessionKey = sessionId ?? '';
    // 同会话相邻重复（同一时刻重发）只计一次频次，也不推进最近性。
    if (this.lastTextBySession.get(sessionKey) === clean) return;
    this.lastTextBySession.set(sessionKey, clean);
    const prev = this.table.get(clean);
    if (prev === undefined) {
      const entry: HotEntry = { count: 1, lastSeq: seq, pinned: false };
      this.table.set(clean, entry);
      this.heap.push(clean, seq, 1);
      // 内存界限：淘汰最近性最差的条目（长驻进程不至于无限增长）。
      if (this.table.size > HOT_TABLE_MAX_ENTRIES) this.evictLeastRecent();
      this.onChange?.(clean, entry);
      return;
    }
    prev.count += 1;
    if (seq > prev.lastSeq) {
      prev.lastSeq = seq;
      // lazy 更新：新 seq 版本入堆；旧版本在 evict 时经 validator 判过期
      // 惰性丢弃（只保留「seq 与表内当前 lastSeq 一致」的有效版本）。
      this.heap.push(clean, seq, prev.count);
    }
    this.onChange?.(clean, prev);
  }

  /**
   * 恢复一条持久化条目（重启后由 `hotness-store` 回放持久层记录时调用）：
   *  - 表内尚无该文本 → 以恢复频次插入；lastSeq 取 -∞（「比任何活事件都旧」）：
   *    seq 是会话内单调号，跨会话本就不可比；恢复条目排到最近性最末，
   *    下一次真实出现（live seq > -∞）自然把 lastSeq 推进到正常轨道。
   *  - 表内已有（open 异步窗口内 live 事件先到）→ 频次合并（live + 持久），
   *    lastSeq 保持 live 值，并上报变更（合并值待落盘）。
   * 插入不触发 onChange（数据来自持久层，回写纯浪费）；容量溢出走常规淘汰。
   */
  restoreEntry(text: string, count: number, pinned = false): void {
    const clean = text.trim();
    if (clean === '' || !Number.isInteger(count) || count < 1 || clean.length > HOT_TEXT_MAX_CHARS) return;
    const prev = this.table.get(clean);
    if (prev === undefined) {
      this.table.set(clean, { count, lastSeq: Number.NEGATIVE_INFINITY, pinned });
      this.heap.push(clean, Number.NEGATIVE_INFINITY, count);
      if (this.table.size > HOT_TABLE_MAX_ENTRIES) this.evictLeastRecent();
      return;
    }
    prev.count += count;
    // 持久层的固定标记以「或」合并：任一侧固定即保持固定（用户显式操作不因合并丢失）。
    if (pinned && !prev.pinned) prev.pinned = true;
    this.onChange?.(clean, prev);
  }

  /**
   * 管理操作：设置固定标记。仅固定状态变化时上报变更并返回 true；
   * 文本不在表内为 no-op（固定的对象必须是已存在的热度条目）。
   */
  setPinned(text: string, pinned: boolean): boolean {
    const entry = this.table.get(text.trim());
    if (entry === undefined || entry.pinned === pinned) return false;
    entry.pinned = pinned;
    this.onChange?.(text.trim(), entry);
    return true;
  }

  /** 管理操作：删除条目（含持久层经 onChange(null) 同步）。文本不在表内为 no-op。 */
  deleteEntry(text: string): boolean {
    const clean = text.trim();
    if (!this.table.delete(clean)) return false;
    this.onChange?.(clean, null);
    return true;
  }

  /**
   * 管理操作：手工新增一条候选。表内已有该文本时只按需补固定标记（频次
   * 不虚增——它统计的是真实输入）；新条目 count=1、lastSeq=-∞（排到最近性
   * 最末，真实再出现时被 live seq 推进），命中常规容量淘汰。
   */
  addEntry(text: string, pinned = false): boolean {
    const clean = text.trim();
    if (clean === '' || clean.length > HOT_TEXT_MAX_CHARS) return false;
    const prev = this.table.get(clean);
    if (prev === undefined) {
      const entry: HotEntry = { count: 1, lastSeq: Number.NEGATIVE_INFINITY, pinned };
      this.table.set(clean, entry);
      this.heap.push(clean, Number.NEGATIVE_INFINITY, 1);
      if (this.table.size > HOT_TABLE_MAX_ENTRIES) this.evictLeastRecent();
      this.onChange?.(clean, entry);
      return true;
    }
    return this.setPinned(clean, pinned || prev.pinned);
  }

  /** 管理操作：清空全表（持久层经 onChange(null) 同步删除）。返回删除条数。 */
  clearAll(): number {
    const texts = [...this.table.keys()];
    for (const text of texts) {
      this.table.delete(text);
      this.onChange?.(text, null);
    }
    return texts.length;
  }

  /**
   * 淘汰优先级最高的条目（堆顶 = (seq, count) 最小）：
   *  - `seq` 最小 → 最久未出现的条目先走
   *  - 同 `seq`（如恢复条目全为 -∞）→ 低 `count` 先走
   * 固定条目豁免。
   */
  private evictLeastRecent(): void {
    const victim = this.heap.popValid((text, seq) => {
      const entry = this.table.get(text);
      // 固定条目不参与最近性淘汰（用户显式置顶的语义）；堆项跳过后继续弹。
      return entry !== undefined && entry.lastSeq === seq && !entry.pinned;
    });
    if (victim !== undefined) {
      this.table.delete(victim.text);
      this.onChange?.(victim.text, null); // 淘汰 → 持久层同步删除
    }
    // lazy 堆会随每次 lastSeq 更新累积陈旧版本；远超过表内条目数时压缩一次，
    // 防止同文本反复出现导致堆无限膨胀（长期驻留进程的内存保护）。
    if (this.heap.size > this.table.size * 4 + 64) this.compactHeap();
  }

  /** 重建堆，只保留与表内当前 lastSeq 一致的有效版本（O(表大小)）。 */
  private compactHeap(): void {
    const compact = new MinSeqHeap();
    for (const [text, entry] of this.table) compact.push(text, entry.lastSeq, entry.count);
    this.heap = compact;
  }

  /** 消费一条会话事件（仅处理真实用户发出的 user/message）；其余事件为空操作。
   * @param sessionId - 当前会话 id；传入以启用「同会话相邻去重」。 */
  consume(event: SessionEvent, sessionId?: string): void {
    if (event.type !== 'user/message') return;
    // `user/message` 事件是真 discriminated union：收窄后 event.data 即
    // UserMessage（content/source 必填）。只统计 source.kind === 'user' 的
    // 消息：系统注入（runtime 快照、system-reminder 等）虽以 user 角色入日志，
    // 但 source.kind 为 'plugin'，作为补全候选毫无意义，且巨型文本会挤占
    // top-K、撑大推送载荷。source 缺失的畸形载荷（旧日志/手写回放）直接跳过。
    const { source, content } = event.data;
    if (source === undefined || source.kind !== 'user') return;
    // 防御性长度上限：正常提示词远小于此；超长文本无法成为有效补全。
    const text = extractText(content);
    if (text === '' || text.length > HOT_TEXT_MAX_CHARS) return;
    this.recordUserText(text, event.seq, sessionId);
  }

  /**
   * 取 top-K（固定条目恒置顶，其余按频次降序、最近优先；K<=0 表示不限）。
   * 固定条目不计入排序竞争——管理面板与跨会话候选都保证先看到它们。
   */
  snapshot(limit: number): readonly SuggestGhostHotEntry[] {
    const entries = [...this.table.entries()]
      .map(([text, entry]) => ({ text, count: entry.count, lastSeq: entry.lastSeq, pinned: entry.pinned }));
    const pinned = entries.filter((e) => e.pinned);
    const rest = entries.filter((e) => !e.pinned)
      .sort((a, b) => b.count - a.count || b.lastSeq - a.lastSeq);
    const ranked = [...pinned, ...rest];
    const slice = limit > 0 ? ranked.slice(0, limit) : ranked;
    return slice.map(({ text, count, pinned: isPinned }) =>
      isPinned ? { text, count, pinned: true } : { text, count });
  }

  /** 当前跟踪的去重会话数（即不同用户消息数）。 */
  get size(): number {
    return this.table.size;
  }
}

/** 从内容块数组提取纯文本（与 client `textOf` 语义一致）。 */
function extractText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === 'text' && typeof record.text === 'string') out += record.text;
  }
  return out.trim();
}
