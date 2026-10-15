/**
 * 历史补全纯逻辑：从会话快照 nodes 提取用户历史消息，做前缀匹配。
 * 无 DOM / 无运行时依赖，可独立单测。
 *
 * 匹配机制（v0.2 起）：
 * 1. **归一化**（B）：比较前把草稿与历史条目统一为半角、小写、折叠空白、
 *    去首尾空白——IME 全/半角标点差异、尾部空格不再导致失配；展示仍用原文。
 * 2. **打分制排名**（A）：对全部前缀命中项计算
 *    `score = W.recency·新近度 + W.localFreq·会话内频次 + W.hotFreq·全局热度 + W.suffixLen·后缀长度`
 *    取最高分（同分取更新者）。新近度权重占主导，保留 zsh autosuggestions
 *    的「最近优先」体感；频次与热度作为次级信号纠正「一次性旧短语压过高频短语」。
 * 3. **跨会话热度合并**（C）：host 端 HotnessTable 的 top-K 频次（经 settings
 *    `_push` 送达）始终参与打分；`extraCandidates`（跨会话候选文本）仅在用户
 *    开启「跨会话搜索」时由调用方传入，作为 recency=0 的额外候补参与竞争。
 * @module dsh-suggest-ghost/client/history
 */

/** 提取消息文本块（结构无关：任何数组都能处理，不依赖 LLM ContentBlock 类型）。 */
export function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  let text = '';
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === 'text' && typeof record.text === 'string') text += record.text;
  }
  return text;
}

/** 单条候选文本最大长度：超过视为系统注入/超大粘贴，不进历史候选。 */
export const HISTORY_TEXT_MAX_CHARS = 2000;

/** 从会话快照 nodes 提取可补全的历史用户消息（去相邻重复、跳过空白与系统注入块）。
 * 兼容两种节点形态：legacy 节点把 content/source 放在顶层；装配后的 chat 视图
 * 节点把它们包在 `node.data` 里。 */
export function extractHistory(nodes: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const record = node as {
      kind?: unknown;
      data?: { content?: unknown; source?: { kind?: unknown } };
      content?: unknown;
      source?: { kind?: unknown };
    };
    if (record.kind !== 'user' && record.kind !== 'user/message') continue;
    // 载荷优先取 chat 视图包裹层 node.data，回退 legacy 顶层。
    const payload = (record.data ?? record) as { content?: unknown; source?: { kind?: unknown } };
    // 节点若带 source，非真实用户输入的注入消息直接跳过。
    const srcKind = payload.source?.kind;
    if (typeof srcKind === 'string' && srcKind !== 'user') continue;
    const text = textOf(payload.content).trim();
    // 空白 / 系统提醒包装块 / 超长文本（无法成为有效补全，且污染频次统计）。
    if (text === '' || text.startsWith('<system-reminder>') || text.length > HISTORY_TEXT_MAX_CHARS) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last === text) continue;
    out.push(text);
  }
  return out;
}

/**
 * 归一化缓存：同一文本只跑一次 5 条正则。
 * 缓存在 settings 变更时由调用方通过 {@link clearNormalizeCache} 清空，
 * 避免跨推送的旧条目泄漏内存。
 */
const normalizeCache = new Map<string, string>();

/** 清空归一化缓存（settings 变更时调用）。 */
export function clearNormalizeCache(): void {
  normalizeCache.clear();
}

/**
 * 匹配用归一化：全角 ASCII（U+FF01–U+FF5E，含 ，？！等）→ 半角、表意空格 →
 * 空格、小写化、连续空白折叠、去首尾。只用于比较与打分，不改动展示文本。
 */
export function normalizeForMatch(text: string): string {
  const cached = normalizeCache.get(text);
  if (cached !== undefined) return cached;
  const result = text
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  normalizeCache.set(text, result);
  return result;
}

/** 两串按 UTF-16 码元的公共前缀长度（渲染幽灵时对齐已输入部分用）。 */
export function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}

/**
 * 草稿是斜杠命令整行（如 `/later +3m 我重新部署了…`）时，返回命令名之后的
 * 「内容」部分；否则原样返回。用于在历史前缀补全时跳过 `/xxx` 与命令参数前缀。
 *
 * 背景：DSH 命令总线对 `recordInput: false` 的命令（如 `/later`、`/schedule`）
 * 不把原始整行写入会话日志，历史里只有到点注入的「内容」部分（不带命令前缀
 * 与时间参数）。如果用户键入 `/later +3m 我重新部署了…` 时直接拿整段去做
 * 前缀匹配，必然无候选——内容部分的归一化文本不以 `/later` 开头，时间参数
 * `+3m` 又是噪声。
 *
 * 语义：
 *  1. 只对**首段** `/<name>` 做剥离（`<name>` 须以字母开头、后跟字母数字下划线
 *     连字符；与命令名规范一致）。
 *  2. 紧跟命令名的第一个 token 如果看起来是「时间参数」（不含中文、不含句读
 *     标点、不含拉丁/汉字字面量；见 {@link TIME_TOKEN_RE}），再剥离一段。
 *     这样 `/later +3m 我` → `我`、`/schedule 明天9点 检查构建` → `检查构建`。
 *     只剥第一段是因为命令参数通常只有「时间」一项；后续 token 视为内容。
 *  3. 命令名后无内容时（仍在「等待补全」态光标在 hint 后）返回空串，让调用方
 *     决定是否显示幽灵。
 *
 * 注意：本函数**只**用于历史前缀补全的匹配与采纳判断；渲染幽灵时 prefix
 * 仍用原始草稿，保证幽灵对齐到用户已输入字符处。
 */
const TIME_TOKEN_RE = /^[+\d].*|^[a-z]+\d+.*|^\d{1,2}:\d{2}.*|^\d+月.*|^\d{1,2}日.*|^[上下]周.*|^今天.*|^明天.*|^后天.*|^今.*|^明.*|^后.*/i;

export function stripCommandPrefix(draft: string): string {
  const head = /^\/([A-Za-z][\w-]*)((?:\s+[\s\S]*)?)$/.exec(draft);
  if (head === null) return draft;
  const rest = (head[2] ?? '').replace(/^\s+/, '');
  if (rest === '') return '';
  const firstToken = /^\S+/.exec(rest);
  if (firstToken === null) return rest;
  if (TIME_TOKEN_RE.test(firstToken[0])) {
    return rest.slice(firstToken[0].length).replace(/^\s+/, '');
  }
  return rest;
}

/** 打分权重：新近度主导，频次次之，热度再次，长度仅做微调。 */
export const HISTORY_WEIGHTS = {
  /** 新近度（0–1，最新≈1）；跨会话候选固定 0。 */
  recency: 1.0,
  /** 会话内出现次数 / 候选内最大次数（0–1）。 */
  localFreq: 0.45,
  /** 全局热度频次 / 热度表最大频次（0–1；无热度信号时为 0）。 */
  hotFreq: 0.3,
  /** 后缀信息量：min(后缀长, 60) / 60，偏好有内容的补全而非 1 字符碎片。 */
  suffixLen: 0.1,
} as const;

/** 后缀长度打分的截断值：超过此长度的后缀不再获得更多加分。 */
export const SUFFIX_LEN_CAP = 60;

/** 历史前缀匹配选项。 */
export interface HistoryOptions {
  /** 草稿（归一化后）至少多少字符才触发（避免过早弹框）。 */
  minChars: number;
  /** 最多参考的历史条目数（0 = 不限；截尾保留最近 N 条）。 */
  maxEntries: number;
  /** 归一化文本 → 全局热度频次（host HotnessTable top-K 快照）；缺省则无热度项。 */
  hotCounts?: ReadonlyMap<string, number>;
  /**
   * 跨会话候选（热度快照条目）。仅在用户开启「跨会话搜索」时传入；
   * 与会话历史重复的文本自动去重（其热度经 hotCounts 生效）。
   */
  extraCandidates?: readonly { text: string; count: number }[];
}

/** 打分候选（内部聚合形态）。 */
interface ScoredCandidate {
  /** 展示用原文（保留原始大小写与标点）。 */
  text: string;
  norm: string;
  /** 最近一次出现的数组下标（越大越新）；跨会话候选为 -1。 */
  bestIdx: number;
  /** 会话内（归一化意义下的）相同文本出现次数。 */
  localCount: number;
}

/**
 * 历史前缀匹配（打分制）：返回得分最高的、以草稿为前缀的完整条目原文；
 * 排除归一化后与草稿完全相同的条目。无可行候选返回 undefined。
 */
export function historySuggestion(
  history: readonly string[],
  draft: string,
  opts: HistoryOptions = { minChars: 1, maxEntries: 0 },
): string | undefined {
  const normDraft = normalizeForMatch(draft);
  if (normDraft === '' || normDraft.length < opts.minChars) return undefined;

  // 截尾保留最近 maxEntries 条（数组尾部 = 最新）。
  const entries = opts.maxEntries > 0 ? history.slice(-opts.maxEntries) : history;

  // 1) 聚合会话内候选：按归一化文本去重，记录最近位置与出现次数。
  const byNorm = new Map<string, ScoredCandidate>();
  entries.forEach((raw, idx) => {
    const norm = normalizeForMatch(raw);
    if (norm === '') return;
    const prev = byNorm.get(norm);
    if (prev === undefined) {
      byNorm.set(norm, { text: raw, norm, bestIdx: idx, localCount: 1 });
    } else {
      prev.localCount += 1;
      if (idx > prev.bestIdx) {
        prev.bestIdx = idx;
        prev.text = raw; // 展示最近一次的原文
      }
    }
  });

  // 2) 并入跨会话候选：已有的只靠 hotCounts 拿热度，不重复建候选。
  if (opts.extraCandidates !== undefined) {
    for (const item of opts.extraCandidates) {
      const norm = normalizeForMatch(item.text);
      if (norm === '' || byNorm.has(norm)) continue;
      byNorm.set(norm, { text: item.text, norm, bestIdx: -1, localCount: 0 });
    }
  }

  // 3) 归一化基准：会话内最大局部频次、热度表最大频次（全局，非仅候选命中）。
  let maxLocal = 0;
  for (const c of byNorm.values()) if (c.localCount > maxLocal) maxLocal = c.localCount;
  let maxHot = 0;
  if (opts.hotCounts !== undefined) {
    for (const h of opts.hotCounts.values()) if (h > maxHot) maxHot = h;
  }

  // 4) 打分取最优；同分时新近度更高者优先（迭代顺序无关，显式比较）。
  let best: ScoredCandidate | undefined;
  let bestScore = 0;
  let bestRecency = -1;
  for (const c of byNorm.values()) {
    if (c.norm === normDraft) continue; // 已输入完整内容（忽略宽度/空白/大小写差异）
    if (!c.norm.startsWith(normDraft)) continue;
    const recency = c.bestIdx < 0 ? 0 : (c.bestIdx + 1) / Math.max(entries.length, 1);
    const localFreq = maxLocal > 0 ? c.localCount / maxLocal : 0;
    const hotCount = opts.hotCounts?.get(c.norm) ?? 0;
    const hotFreq = maxHot > 0 ? hotCount / maxHot : 0;
    const suffixLen = Math.min(Math.max(c.norm.length - normDraft.length, 0), SUFFIX_LEN_CAP) / SUFFIX_LEN_CAP;
    const score = HISTORY_WEIGHTS.recency * recency
      + HISTORY_WEIGHTS.localFreq * localFreq
      + HISTORY_WEIGHTS.hotFreq * hotFreq
      + HISTORY_WEIGHTS.suffixLen * suffixLen;
    if (best === undefined || score > bestScore || (score === bestScore && recency > bestRecency)) {
      best = c;
      bestScore = score;
      bestRecency = recency;
    }
  }
  return best?.text;
}
