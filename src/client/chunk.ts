/**
 * 逐词采纳的片段切分纯逻辑：从幽灵后缀里取下一个采纳片段。
 *
 * 首选 Intl.Segmenter（zh 词典分词，中英混排都适用：「提交一下代码」→
 * 提交/一下/代码）；环境缺失时退化为字符类切分（CJK 连写每片 ≤2 字）。
 * 规则：
 * - 词尾紧随的空白/标点跟随该词（光标落在空格或句号之后更自然）；
 * - 前导空白并入下一片段（不产生纯空格片段）；
 * - 全部由标点/空白组成的后缀一次性整段采纳。
 * 无状态：每次按键从当前草稿实时推导，用户中途打字不会错位。
 * @module dsh-suggest-ghost/client/chunk
 */

/** 与 TS lib 版本解耦的最小结构类型（避免依赖 lib.es2022.intl）。 */
interface SegmentDataLike {
  readonly segment: string;
  readonly isWordLike?: boolean;
}
interface SegmenterLike {
  segment(input: string): Iterable<SegmentDataLike>;
}

let segmenter: SegmenterLike | undefined;
try {
  const ctor = (Intl as unknown as {
    Segmenter?: new (locale: string, options: { granularity: 'word' }) => SegmenterLike;
  }).Segmenter;
  segmenter = typeof ctor === 'function' ? new ctor('zh', { granularity: 'word' }) : undefined;
} catch {
  segmenter = undefined;
}

/** 字符类：空白 / CJK / 词（字母数字下划线）/ 其余视为标点。 */
function charClassOf(ch: string): 'space' | 'cjk' | 'word' | 'punct' {
  if (/\s/.test(ch)) return 'space';
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) return 'cjk';
  if (/[\w]/.test(ch)) return 'word';
  return 'punct';
}

/**
 * 回退切分（无 Intl.Segmenter 时）：按字符类取首个片段；
 * CJK 无词界，连写每片最多 2 字；词尾空白跟随词。
 */
export function nextAcceptChunkFallback(text: string): string {
  if (text === '') return '';
  let i = 0;
  while (i < text.length && charClassOf(text[i]!) === 'space') i++; // 前导空白并入本片
  if (i < text.length) {
    const cls = charClassOf(text[i]!);
    let run = 0;
    while (i < text.length && charClassOf(text[i]!) === cls) {
      i++;
      run++;
      if (cls === 'cjk' && run >= 2) break; // CJK 连写限长
    }
    while (i < text.length && charClassOf(text[i]!) === 'space') i++; // 词尾空白跟随
  }
  return text.slice(0, Math.max(i, 1));
}

/** 返回后缀的下一个逐词采纳片段；空串原样返回。 */
export function nextAcceptChunk(text: string): string {
  if (text === '') return '';
  if (segmenter === undefined) return nextAcceptChunkFallback(text);
  const parts = [...segmenter.segment(text)];
  let firstWord = 0;
  while (firstWord < parts.length && !parts[firstWord].isWordLike) firstWord++;
  if (firstWord >= parts.length) return text; // 全为标点/空白：整段收尾
  let end = firstWord + 1; // 至少含第一个词段整体
  while (end < parts.length && !parts[end].isWordLike) end++; // 尾随非词段（空格/标点）跟随
  return parts.slice(0, end).map(p => p.segment).join('');
}
