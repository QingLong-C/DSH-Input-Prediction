/**
 * 远程 settings 写面的**兑现值判定**（纯函数，无 DOM、无 I/O）。
 *
 * 单独成模块的理由有二：
 *  1. #16 的实质（「日志 mutate OK、宿主侧 `_ops` 永远停在 boot 初值」）就发生在
 *     这一层判定上——它必须是可测的，否则只能等宿主重启后现场看日志；
 *     `scripts/ops-write-verify-smoke.mjs` 用假兑现值直接驱动它。
 *  2. 与 `accept-guard.ts` / `inline-arm-policy.ts` 同一HOUSE 约定：client 里
 *     凡是「决策」而不是「接线」的部分都抽成纯模块，node 能直接 import 源文件
 *     （本模块没有 `.js` 说明符依赖，裸 node 可解析）。
 *
 * ## 为什么「兑现」不等于「写成功」
 *
 * 内核 `SettingsForms.write()` 遇 revision 过期抛 `SettingsConflictError`
 * （`@deepseek-ai/dsh-settings/lib/index.js:511`，`code = "SETTINGS_CONFLICT"`，
 * 同文件 :165/:177）。但 `ctx.remote.settings.mutate` 的调用方**看不到那次抛错**：
 *
 *  - `@deepseek-ai/dsh-api-settings-controller/lib/index.js:489,501-507`：控制器
 *    捕获内核错误并**重新分类**成 `RemoteError`——冲突的码是 `settings/conflict`
 *    （不是内核那个码！），details 带 `{ns, expected, actual}`，message 保留内核原文；
 *  - `@deepseek-ai/dsh-api-gateway/lib/index.js:1425-1437`：`rpcFailure` 把
 *    `code`/`message`/`details` 原样编码上线；
 *  - `@deepseek-ai/dsh-api-gateway/lib/client.js:1795-1802,2124-2126`：客户端面
 *    用 `rebuiltFailure` 原样重建 `RemoteError`，然后**折进 `RemoteResult` 的 error
 *    分支照常兑现**；
 *  - `@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts:60-73`：契约写明「只有
 *    装配故障（参数元数、方法未挂载、缺 Context 适配器）才 reject」。
 *
 * 所以：**Promise 兑现状态不含任何写入信息**，成功与否只存在于兑现值的 `ok` 判别式里。
 * 内核侧 `SettingsConflictError.code` 跨远程层被**重映射**成 `settings/conflict`——
 * 码是保留的，值换了 taxonomy（对照：内核自己的设置页也按
 * `response.error.code === 'settings/conflict'` 分支，
 * `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:2795-2805`）。
 * 本模块因此**两个码都认**：远程形态 `settings/conflict`，以及本地 `SettingsForms`
 * /不经那次重分类的老代次给出的 `SETTINGS_CONFLICT`。
 *
 * 成功分支的兑现值是写后的 `SettingsNamespaceView`（`revision: z.number()` + 整份
 * `value`，`@deepseek-ai/dsh-api-settings-controller/lib/typert.remote-client.js:69-82`），
 * 它就是现成的写后凭证，**不需要再发一次 describe()**（浏览器侧热路径）。
 * @module dsh-suggest-ghost/client/settings-result
 */

/** 认得出的写后命名空间视图（只用到这两个字段）。 */
export interface NamespaceViewLike {
  readonly revision?: unknown;
  readonly value?: unknown;
}

/** `unwrapMutateResult` 的分类结果。 */
export interface MutateOutcome {
  /**
   * 远程面的业务结论。
   * `undefined` = 这一代的返回值里认不出 `ok` 判别式，也认不出命名空间视图。
   */
  readonly ok: boolean | undefined;
  /** 失败时的稳定机器码（远程 taxonomy：`settings/conflict`）。 */
  readonly code: string | undefined;
  /** 失败时的诊断文本（内核原文，含 "revision" 一词）。 */
  readonly message: string | undefined;
  /** 成功时的写后视图（认不出来时 undefined）。 */
  readonly view: NamespaceViewLike | undefined;
}

/** 一次 `_ops` 写入的最终判定（`settleWriteVerdict` 的返回值）。 */
export type WriteVerdict =
  /** 有证据表明载荷进了文档。 */
  | 'landed'
  /** 版本冲突（可重取 revision 重试）。 */
  | 'refused-conflict'
  /** 其它拒绝（字段不可写 / 条目不存在 / 传输失败）。 */
  | 'refused-other'
  /** 远程说成功了，但写后视图既没有我们的载荷、revision 也没动——#16 的签名。 */
  | 'unsettled'
  /** 这一代给不出可判读的返回值：调用方自己补一次读回。 */
  | 'unreadable';

/** 从任意一层封装里认出一个命名空间视图。 */
function looksLikeNamespaceView(node: Record<string, unknown>): boolean {
  const hasIdentity = typeof node.ns === 'string' || typeof node.revision === 'number';
  return hasIdentity && ('value' in node || 'revision' in node);
}

/**
 * 解包 `mutate` 的兑现值，**不假设层数**（与 `unwrapSettingsDoc` 同一理由：
 * transport 是否已解一层在不同代次表现不一致，按固定层数写会在另一种形状下
 * 恒为 undefined，且静默失败）。
 */
export function unwrapMutateResult(response: unknown): MutateOutcome {
  const none = (): MutateOutcome => ({ ok: undefined, code: undefined, message: undefined, view: undefined });
  let node: unknown = response;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof node !== 'object' || node === null) return none();
    const record = node as Record<string, unknown>;
    if (typeof record.ok === 'boolean') {
      if (record.ok === false) {
        const error = record.error;
        const box = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
        return {
          ok: false,
          code: typeof box?.code === 'string' ? box.code : undefined,
          // 老 host 可能把失败压成裸字符串 / 裸 Error：message 一律兜住，供文本判据用。
          message: typeof box?.message === 'string'
            ? box.message
            : typeof error === 'string'
              ? error
              : error instanceof Error
                ? error.message
                : undefined,
        };
      }
      node = record.value;
      continue;
    }
    if ('result' in record) { node = record.result; continue; }
    // 没有 ok 判别式：这一代的返回值本身就是视图。
    if (looksLikeNamespaceView(record)) {
      return { ok: true, code: undefined, message: undefined, view: record as NamespaceViewLike };
    }
    return none();
  }
  return none();
}

/**
 * 是否「版本冲突」。**有码就只按码判**，文本匹配降级为「这一代根本没给码」时的兜底：
 *  - `settings/conflict`：远程层重分类后的码（取证见模块头）；
 *  - `SETTINGS_CONFLICT`：内核本地码（本地 `SettingsForms` 或未经重分类的代次）；
 *  - 兜底文本：老 host 把错误压成裸字符串时 `code` 拿不到，而报文本身含
 *    "revision" 一词（`dsh-settings/lib/index.js:176`）。
 *
 * 「有码就不看文本」是刻意的：`settings/rejected` 的 message 可能也带 revision
 * （例如某条路径把内核原文塞进去），按文本判会把**不可重试**的拒绝误判成冲突，
 * 白重试两轮还把日志刷脏。
 */
export function isConflictRefusal(code: string | undefined, message: string | undefined): boolean {
  if (typeof code === 'string') return code === 'settings/conflict' || code === 'SETTINGS_CONFLICT';
  return /conflict|revision/i.test(message ?? '');
}

/**
 * 只看写后视图能得出什么结论。两个判据取或：
 *  1. **载荷仍在盘上**（`view.value._ops === sent`）——最强证据；host 消费完会把
 *     `_ops` 写回空值，所以这条可能因抢先清空而不成立，不能单独用。
 *  2. **revision 与提交时不同**——内核按内容指纹推导 revision
 *     （`dsh-settings/lib/index.js:428`），写进去的内容与现值相同时指纹不变、
 *     计数不动（那种情况判据 1 必然成立）；因此「计数没动 + 盘上不是我们那份」=
 *     这份写根本没进文档，正是 #16 的现象。
 *     取「不同」而不是「更大」：host 重启会让计数回到 0，用 `>` 会在那种时刻假报警。
 */
export function verdictFromView(
  view: NamespaceViewLike | undefined,
  expectedRevision: number,
  sentPayload: string,
): WriteVerdict {
  if (view === undefined) return 'unreadable';
  const revision = typeof view.revision === 'number' ? view.revision : undefined;
  const box = view.value;
  const landedOps = typeof box === 'object' && box !== null
    ? (box as Record<string, unknown>)._ops
    : undefined;
  if (landedOps === sentPayload) return 'landed';
  if (revision !== undefined && revision !== expectedRevision) return 'landed';
  if (revision !== undefined) return 'unsettled';
  return 'unreadable';
}

/**
 * 把 `mutate` 的兑现值折成一个判定。**这是 #16 的闭环点**：
 * `{ok:false, error:{code:'settings/conflict'}}` 以前被 `.then(() => true)` 读成
 * 成功，现在归 `refused-conflict`（调用方重取 revision 重试或留痕返回 false）。
 */
export function settleWriteVerdict(
  response: unknown,
  expectedRevision: number,
  sentPayload: string,
): WriteVerdict {
  const outcome = unwrapMutateResult(response);
  if (outcome.ok === false) {
    return isConflictRefusal(outcome.code, outcome.message) ? 'refused-conflict' : 'refused-other';
  }
  const verdict = verdictFromView(outcome.view, expectedRevision, sentPayload);
  if (verdict !== 'unreadable') return verdict;
  // `ok === true` 但视图读不出 revision/_ops：这一代的返回值没有可判别的写后凭证。
  return outcome.ok === true ? 'unreadable' : 'unreadable';
}

/** 从 reject 出来的错误值里取 code/message（装配故障走这条路：远程面确实会 reject）。 */
export function readRejection(error: unknown): { code: string | undefined; message: string | undefined } {
  if (typeof error === 'string') return { code: undefined, message: error };
  if (typeof error !== 'object' || error === null) return { code: undefined, message: undefined };
  const box = error as Record<string, unknown>;
  return {
    code: typeof box.code === 'string' ? box.code : undefined,
    message: typeof box.message === 'string' ? box.message : String(error),
  };
}
