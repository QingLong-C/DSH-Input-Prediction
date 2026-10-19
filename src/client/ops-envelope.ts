/**
 * `_ops` 载荷的信封构造（Gitea issue #16/#17 的连带缺陷）。
 *
 * ## 要解决的问题
 *
 * 宿主用**载荷字符串全等**给 `_ops` 去重（`src/index.ts` 的
 * `if (payload === lastOpsPayload) return;`），而「消费后清空 `_ops`」在
 * `settings/document-updated` 回调里是**结构性不可能**的：那次写入落在内核 HMR 的
 * `AsyncLocalStorage` 事务内，`runExclusive` 直接拒（`dsh-hmr/lib/index.js:279-281`），
 * 本机一个进程里实测失败 372/373 次（`Error: HMR transactions cannot be nested`）。
 *
 * 两件事叠起来的结果：**同一份载荷只能被消费一次，永久如此**。`pull` 侥幸躲过了
 * （它的 `rev` 每次自增），`complete` 没有——它的载荷是
 * `{rev: 0, ops:[{op:'complete', sessionId, draft}]}`，逐字节由草稿决定。于是
 * 「输入 A → 停顿（已问过一次）→ 改成 B → 删回 A → 再停顿」这条真实操作序列里，
 * 客户端合法地重新发起请求，宿主却因为载荷与上次完全相同而静默丢弃，且清空也失败，
 * 没有任何补偿。用户看到的是「同一个草稿再停多少次都不出续写」。
 *
 * ## 做法
 *
 * 让每次写入自带一个**进程内单调序号**，载荷就不再逐字节相同，去重回到它本来的职责
 * （拦住同一次写入的事件回声），不再顺带拦住语义上的新请求。
 *
 * 只加字段、不改宿主判据，是因为：
 * - zod 的对象 schema 默认非 strict（`src/hotness-store.ts:226`），新增顶层键不会让
 *   整批载荷被拒，老宿主读不懂 `seq` 也照旧工作；
 * - 宿主重启后 `lastOpsPayload` 从盘上现值初始化，此时任何一次写入都必须能被消费，
 *   唯一序号天然满足；
 * - 反过来改宿主判据（比如按 op 语义判重）要动消费幂等语义，风险面大得多。
 *
 * 序号是**页面级**的（刷新后从 1 重来）。跨刷新的序号碰撞在实践中打不开那个洞：
 * 刷新后客户端必然先写一次冷启动 `pull`，`lastOpsPayload` 随之改变，等 `complete`
 * 再写时已不可能与「上次消费的载荷」全等。
 *
 * @module dsh-suggest-ghost/client/ops-envelope
 */

/** 序号发生器：每次调用返回递增的正整数。 */
export interface SeqSource {
  next(): number;
}

/**
 * 造一个从 1 开始的单调序号源。
 * @returns 序号源
 */
export function createSeqSource(): SeqSource {
  let last = 0;
  return {
    next(): number {
      last += 1;
      return last;
    },
  };
}

/**
 * 给 `_ops` 载荷套上信封：注入单调 `seq`，并在有值时捎带 UI 语言 `locale`。
 *
 * 三种输入的行为：
 * - JSON 对象 → 注入 `seq`（覆盖已有值，保证「每次写入都不同」这条不变量成立）
 *   与可选 `locale`，其余键原样保留；
 * - 非 JSON（解析失败）→ 原样返回，与旧行为一致，不替调用方伪造结构；
 * - JSON 数组或 `null` → 原样返回：信封只对「带 ops 的对象载荷」有意义。
 *
 * @param payload - 调用方构造的载荷字符串。
 * @param locale - 当前 UI 语言；空字符串或 undefined 不写入。
 * @param seq - 本次写入的单调序号（`createSeqSource().next()`）。
 * @returns 可直接提交的载荷字符串
 */
export function buildOpsPayload(payload: string, locale: string | undefined, seq: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return payload;
  const base = parsed as Record<string, unknown>;
  const enriched: Record<string, unknown> = { ...base, seq };
  if (typeof locale === 'string' && locale.length > 0) enriched.locale = locale;
  return JSON.stringify(enriched);
}
