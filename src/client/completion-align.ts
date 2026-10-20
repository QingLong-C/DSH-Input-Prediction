/**
 * 续写载荷与当前草稿的对齐判定（纯函数，便于离线断言）。
 *
 * ## 背景：为什么不能再要求「逐字全等」
 *
 * 原判据是 `completion.draft === draft`。而续写是**接在草稿后面**的半句，用户在生成期间
 * （实测中位 4.9 秒、最慢 17 秒）继续打字是**最常见**的用法。线上实测一次会话的 46 次停顿里
 * **45 次草稿长度都不同** —— 全等判据把主路径判成了失效，用户看到的现象就是「等很久也不出东西」。
 *
 * ## 判据：只接受「你没改前面」的两种形态
 *
 * 设 `payload` = 生成这份续写时客户端提交的草稿，`cur` = 当前草稿：
 *
 * | 关系 | 含义 | 处理 |
 * |---|---|---|
 * | `cur === payload` | 草稿未变 | 照常显示（原行为） |
 * | `cur` 以 `payload` 开头 | 你在末尾继续打了字 | **显示**，并裁掉已打出的重叠部分 |
 * | 其他 | 改了中间 / 换了内容 / 删了字 | 丢弃（贴上去会错位） |
 *
 * 为什么**不**接受「`payload` 以 `cur` 开头」（即你删了末尾的字）：删字后光标位置无从得知，
 * 续写直接接在当前草稿后面可能落在错误的位置。这种形态保持丢弃 —— 宁可少显示，不可显错。
 *
 * ## 重叠裁剪
 *
 * 「你在末尾继续打字」时，`payload + completion.text` 的前若干字符可能**已经被你打出来**了。
 * 例如载荷续写是「测试了」，而你已经打出「测」，那幽灵只该补「试了」。
 *
 * 裁剪点取**两个候选的对齐结果中更靠后**的一个，且限定在续写文本内：
 *  - `cur` 与 `payload+text` 的公共前缀（你已经照着续写打下去了）；
 *  - `cur` 长于 `payload` 的那一段（你新打的内容）与 `text` 的公共前缀。
 *
 * 取更靠后者是为了避免"你打的字与续写开头不重合"时把整段续写重复显示。
 *
 * 全为 UTF-16 码元比较（与 `commonPrefixLength` 同款），不做语言相关的归一化：
 * 幽灵渲染按字符对齐，越界或错位比"少显示一个字符"更糟。
 *
 * @module dsh-suggest-ghost/completion-align
 */

/** 判定的三种结果。`ok` 为 true 时给出对齐后的幽灵后缀。 */
export type CompletionAlignResult =
  | { readonly ok: true; readonly kind: 'exact' | 'extended'; readonly suffix: string; readonly full: string }
  | { readonly ok: false; readonly reason: 'draft-mismatch' | 'empty-text' | 'empty-draft' };

/** 两串按 UTF-16 码元的公共前缀长度。 */
function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i += 1;
  return i;
}

/**
 * 判定一份续写载荷能否对齐到当前草稿。
 *
 * @param cur 当前草稿（渲染这一帧时输入机的值）
 * @param payloadDraft 生成这份续写时客户端提交的草稿
 * @param completionText 宿主生成的续写文本（接在 `payloadDraft` 之后的半句）
 */
export function alignCompletion(
  cur: string,
  payloadDraft: string,
  completionText: string,
): CompletionAlignResult {
  if (completionText === '') return { ok: false, reason: 'empty-text' };
  if (cur.trim() === '') return { ok: false, reason: 'empty-draft' };
  // 草稿未变：原行为，整段续写都是幽灵。
  if (cur === payloadDraft) {
    return { ok: true, kind: 'exact', suffix: completionText, full: cur + completionText };
  }
  // 只在「你在末尾继续打字」时显示；其余（改中间/换内容/删字）一律丢弃。
  if (!cur.startsWith(payloadDraft)) return { ok: false, reason: 'draft-mismatch' };

  // 你新打的那一段（可能已与续写开头重合）。
  const typedSince = cur.slice(payloadDraft.length);
  // 裁剪点 = 你新打的内容与续写开头的公共前缀，且**不超过续写长度**
  // （否则会把整段续写吃掉、显示空白）。
  //
  // 为什么只用这一维：早先还叠加了「cur 与 cur+text 的公共前缀」那一维，想覆盖
  // "你已经照着续写打下去了"。但那维在两种情况下会**误裁**（冒烟当场抓到）：
  //   - 你打的字与续写无关（`前面ABC` vs 续写 `构建流程`）却被算成重合；
  //   - 载荷草稿为空时 `typedSince` 等于整个 `cur`，直接裁空。
  // 而 `typedSince` 这一维本身就够：它能命中的正是"你打出的东西与续写开头一致"的场景。
  const overlap = Math.min(completionText.length, commonPrefixLength(typedSince, completionText));
  const suffix = completionText.slice(overlap);
  // 裁完为空 = 你已经把整段续写打完了，此时没有幽灵可显示（不是错误）。
  if (suffix === '') return { ok: false, reason: 'empty-text' };
  return { ok: true, kind: 'extended', suffix, full: cur + suffix };
}
