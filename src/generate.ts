/**
 * 有界辅助建议生成：转录提取、脱敏、路由解析、截止时间熔断的 LLM 调用、输出净化。
 * 与 session-title-llm 调用策略一致（字节上限、输出上限、截止时间、派发前记录）。
 * @module dsh-suggest-ghost/generate
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Volatile } from '@deepseek-ai/cosmokit';
import {
  BlockAssembler,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface';
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { PROJECTION_KEY } from './domain.js';
import type { SuggestGhostSuggested } from './domain.js';
import {
  cleanSuggestion,
  redactSecrets,
  sanitizeSuggestion,
  shouldFilterSuggestion,
} from './sanitize.js';
import {
  frameTranscript,
  suggestionLanguage,
  trimTranscript,
} from './transcript.js';
import type { Transcript, TranscriptPair } from './transcript.js';

// 日志读取助手与冷启动语义同源（纯函数、无运行时依赖），此处转发保持既有公开面。
import { sessionEvents } from './coldstart.js';
export { sessionEvents } from './coldstart.js';

/** 本能力所属的辅助请求超时错误码。 */
export const SUGGEST_TIMEOUT_CODE = 'SUGGEST_GHOST_TIMEOUT';

/**
 * 就地深冻结：迭代遍历，循环引用安全，不受调用栈深度限制。
 * 本地实现而非从内核导入——DSH 0.1.1 由 dsh-llm 导出该 helper，0.1.2 把它搬到新增的
 * dsh-util-values 并停止转发，而 dsh-util-values 在 0.1.1 内核里不存在，两个导入源在
 * 对方那一代都会让整个模块链接失败。跳过 AbortSignal 是必须的：它是请求的实时取消
 * 通道，冻结会让 abort 失效。
 */
function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    if (node instanceof AbortSignal || seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) {
      pending.push((node as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** host 插件配置（未校验版本）。 */
export interface Config {
  maxInputBytes: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxRecentTurns?: number;
  maxTranscriptChars: number;
  maxSuggestionChars: number;
  provider?: string;
  model?: string;
  acceptKey?: string;
  /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
  llmEnabled?: boolean;
}

/**
 * 0.1.7 的用户可调项。
 *
 * 取 `Volatile<T> | T` 联合类型而非只取 `Volatile<T>`：0.1.7 把这些字段解析成
 * cosmokit 引用（读值走 `.get()`），而 0.1.5/0.1.2 时代它们是裸值。`readVolatile`
 * 同时认得两种形态，故类型层也必须同时容纳。
 */
export interface EditableConfig {
  llmEnabled?: Volatile<boolean> | boolean;
  historyEnabled?: Volatile<boolean> | boolean;
  historyCrossSession?: Volatile<boolean> | boolean;
  historyMaxEntries?: Volatile<number> | number;
  historyMinChars?: Volatile<number> | number;
  wordAccept?: Volatile<boolean> | boolean;
  acceptKey?: Volatile<string> | string;
}

/** 内核解析后的插件配置：策略字段是裸值，可调字段是引用。 */
export type ResolvedPluginConfig = Config & EditableConfig;

/**
 * 读取一个可能缺失的可调字段：先问引用（0.1.7 的 `Volatile<T>`），再回落到
 * 裸值（0.1.5/0.1.2 时代 Config 里的普通字段），最后用 schema 默认值。
 *
 * 这样上层（index.ts / client）拿到的永远是裸值，不必关心当前内核代次。
 */
function readVolatile<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    const inner = (value as { get: () => unknown }).get();
    return (inner === undefined || inner === null ? fallback : inner) as T;
  }
  return value as T;
}

/** 拍平后的配置：策略字段 + 可调字段，全部是裸值。 */
export type FlatConfig = Config & {
  llmEnabled: boolean;
  historyEnabled: boolean;
  historyCrossSession: boolean;
  historyMaxEntries: number;
  historyMinChars: number;
  wordAccept: boolean;
  acceptKey: string;
};

/**
 * 把插件配置拍平成「策略 + 可调」的裸值视图。0.1.7 的可调项是引用，其余代码
 * （effective()、client 渲染、热度快照上限）都按裸值读，不必知道代次差异。
 */
export function flattenConfig(config: ResolvedPluginConfig): FlatConfig {
  return {
    ...config,
    llmEnabled: readVolatile(config.llmEnabled, true),
    acceptKey: readVolatile(config.acceptKey, 'Tab'),
    historyEnabled: readVolatile(config.historyEnabled, true),
    historyCrossSession: readVolatile(config.historyCrossSession, false),
    historyMaxEntries: readVolatile(config.historyMaxEntries, 50),
    historyMinChars: readVolatile(config.historyMinChars, 1),
    wordAccept: readVolatile(config.wordAccept, true),
  } as FlatConfig;
}

/** 校验并返回不可变配置。 */
export function resolveConfig(config: Config): Config {
  if (config === null || typeof config !== 'object') {
    throw new Error('dsh-suggest-ghost: configuration is required');
  }
  const raw = config as unknown as Record<string, unknown>;
  // 0.1.7 的 Loader 把 volatile 字段解析成 cosmokit 引用（`{ get() }`），
  // 而不是裸值；0.1.5/0.1.2 是裸值。校验一律针对**裸值**，否则 `acceptKey`
  // 这类字符串字段会因为拿到对象而误判成「非法」。`readVolatile` 同时认两种形态。
  const value: Record<string, unknown> = {
    ...raw,
    provider: readVolatile(raw.provider, undefined),
    model: readVolatile(raw.model, undefined),
    acceptKey: readVolatile(raw.acceptKey, undefined),
    llmEnabled: readVolatile(raw.llmEnabled, undefined),
  };
  const int = (name: string): number => {
    const n = readVolatile<unknown>(value[name], undefined);
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      throw new Error(`dsh-suggest-ghost: ${name} must be a positive integer`);
    }
    return n;
  };
  int('maxInputBytes');
  int('maxOutputTokens');
  int('timeoutMs');
  if (value.maxRecentTurns !== undefined) int('maxRecentTurns');
  int('maxTranscriptChars');
  int('maxSuggestionChars');
  if (typeof value.timeoutMs === 'number' && value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-suggest-ghost: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`);
  }
  // provider/model 允许留空 = 继承会话最近一次请求的路由（见 routeOf）。
  // 因此这里只校验**成对**：两者要么都空（继承），要么都非空（覆盖）；
  // 一个空一个非空才是配置错误。空串本身合法，不能当成「非法覆盖」拒绝。
  const provider = value.provider;
  const model = value.model;
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('dsh-suggest-ghost: provider and model must be supplied together');
  }
  if (provider !== undefined && (typeof provider !== 'string' || typeof model !== 'string')) {
    throw new Error('dsh-suggest-ghost: provider and model must be strings');
  }
  const providerGiven = typeof provider === 'string' && provider.length > 0;
  const modelGiven = typeof model === 'string' && model.length > 0;
  if (providerGiven !== modelGiven) {
    throw new Error('dsh-suggest-ghost: provider and model must be supplied together');
  }
  if (value.acceptKey !== undefined
    && (typeof value.acceptKey !== 'string' || value.acceptKey.trim().length === 0)) {
    throw new Error('dsh-suggest-ghost: acceptKey must be a non-empty shortcut string');
  }
  if (value.llmEnabled !== undefined && typeof value.llmEnabled !== 'boolean') {
    throw new Error('dsh-suggest-ghost: llmEnabled must be a boolean');
  }
  return deepFreeze(Object.assign({}, value)) as unknown as Config;
}

/** 建议生成指令：只预测用户下一条提示词，禁止生成内容或元文本。 */
export function systemPrompt(maxSuggestionChars: number, language: string): string {
  return [
    'You are a prompt suggestion generator. Your ONLY purpose is to predict the user\'s next prompt in a coding-assistant chat — never to generate content.',
    '',
    'Your job:',
    '1. Read the user\'s most recent message and the assistant\'s final answer.',
    '2. Predict what the USER would naturally type next — not what the assistant should do.',
    '',
    'CRITICAL CONSTRAINTS:',
    '- You are NOT a code generator, writer, or task executor.',
    '- You MUST respond with ONLY the suggestion text, on a single line.',
    '- NEVER generate, implement, code, or produce any content.',
    '- NEVER provide explanations, reasoning, or extra text.',
    '- NEVER use quotes, labels, Markdown, XML, or formatting.',
    '- Be specific when you can — name files, functions, or actions.',
    '- If the next step is not obvious, reply with nothing at all.',
    '',
    'THE TEST: would the user think "I was just about to type that"?',
    '',
    'EXAMPLES:',
    'User asked "fix the bug and run tests", bug is fixed -> "run the tests"',
    'After code written -> "try it out"',
    'Assistant offers options -> pick the one the user would choose',
    'Assistant asks to continue -> "yes" or "go ahead"',
    'Task complete, obvious follow-up -> "commit this" or "push it"',
    'After an error or misunderstanding -> reply with nothing',
    '',
    'NEVER SUGGEST:',
    '- Evaluative feedback ("looks good", "thanks")',
    '- Questions ("what about...?")',
    '- Assistant-voice phrasing ("Let me...", "I\'ll...", "Here\'s...")',
    '- New ideas the user did not ask about',
    '- Multiple sentences',
    '',
    'Reply with ONLY the suggestion, 3-12 words, no quotes or explanation. If the next step is not obvious, reply with nothing.',
    '',
    `Language: ${language}`,
    `At most ${maxSuggestionChars} visible characters.`,
  ].join('\n');
}

/** 提取消息文本块。 */
function renderMessageText(message: Message): string {
  let out = '';
  for (const block of message.content) {
    if (block.type === 'text') out += block.text;
  }
  return out;
}

/**
 * 从会话日志构建模型可见转录：最近 `maxRecentTurns` 个已完成回合的
 * user/assistant 消息（默认 1 = 只取最后一轮），脱敏，依次按字符预算
 * （`maxTranscriptChars`）与 UTF-8 字节预算（`maxInputBytes`）截尾。
 */
export function buildTranscript(
  session: Session,
  maxRecentTurns: number,
  maxTranscriptChars: number,
  maxInputBytes: number,
): Transcript | undefined {
  const events = sessionEvents(session);
  let lastTurn = 0;
  const turnStarts: Array<{ readonly turn: number; readonly seq: number }> = [];
  for (const event of events) {
    if (event.type === 'turn/start') turnStarts.push({ turn: event.data.turn, seq: event.seq });
    else if (event.type === 'turn/end') lastTurn = event.data.turn;
  }
  if (lastTurn === 0) return undefined;
  const cutoffTurn = Math.max(1, lastTurn - Math.max(1, maxRecentTurns) + 1);
  const cutoffSeq = turnStarts.find(entry => entry.turn === cutoffTurn)?.seq ?? 0;
  const pairs: TranscriptPair[] = [];
  const sourceMessageSeqs: number[] = [];
  let baseSeq = 0;
  for (const event of events) {
    if (event.seq < cutoffSeq) continue;
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    const message = deriveEventMessage(event);
    if (message === null) continue;
    const text = renderMessageText(message).trim();
    if (text.length === 0) continue;
    pairs.push({ role: message.role === 'user' ? 'user' : 'assistant', text: redactSecrets(text) });
    sourceMessageSeqs.push(event.seq);
    baseSeq = event.seq;
  }
  if (pairs.length === 0) return undefined;
  // 双预算裁剪（字符 + UTF-8 字节）：中文长回复不再因突破 maxInputBytes
  // 而整轮失败——裁剪逻辑见 trimTranscript（纯函数，可单测）。
  const trimmed = trimTranscript(pairs, sourceMessageSeqs, maxTranscriptChars, maxInputBytes);
  return {
    pairs: trimmed.pairs,
    sourceMessageSeqs: trimmed.sourceMessageSeqs,
    baseSeq,
  };
}

/** 解析路由：显式配置优先，否则继承会话最近一次请求的路由。 */
function routeOf(
  session: Session,
  config: Config,
): { readonly provider: string; readonly model: string } {
  // 空串是「未配置」而非「显式覆盖」：schema 用 `.default('')` 表达「继承」
  // （volatile 表单不接受必填项，留空即继承）。所以这里必须连同长度一起判断，
  // 只看 `!== undefined` 会把 `''` 当成覆盖，解析出空路由并让插件启动失败。
  if (config.provider !== undefined && config.provider.length > 0
    && config.model !== undefined && config.model.length > 0) {
    return { provider: config.provider, model: config.model };
  }
  const route = session.requestHeader()?.config;
  if (route !== undefined && route.provider.length > 0 && route.model.length > 0) {
    return { provider: route.provider, model: route.model };
  }
  throw new Error('dsh-suggest-ghost: no logged request route is available; configure provider and model together');
}

/** 终止原因 → 失败信息。 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined;
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string };
      error.code = finish.failure.code;
      return error;
    }
    case 'max-tokens':
      return new Error('dsh-suggest-ghost: suggestion output reached maxOutputTokens');
    case 'tool-calls':
      return new Error('dsh-suggest-ghost: suggestion model unexpectedly requested a tool');
    /* v8 ignore next 2 -- FinishReason 是封闭五元联合，默认分支不可达 */
    default:
      return new Error(`dsh-suggest-ghost: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`);
  }
}

/** 可中止的退避等待；到点或被中止即返回（由调用方 throwIfAborted 兜底）。 */
async function backoff(signal: AbortSignal, ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  signal.throwIfAborted();
}

/**
 * 为一个已完成回合生成建议。模型产出空或不合格回复 = 无建议（静默返回
 * undefined），真实失败抛错。
 *
 * 辅助调用带**有界重试**（默认共 3 次尝试，1.2s/2.4s 退避）：主循环对
 * EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT 类瞬时错误有 5 次重试，
 * 而建议调用是单发——不稳定窗口里会整轮静默失败（实测发生过）。被外部
 * 中止（新回合取代/卸载）时不重试。
 */
export async function generateSuggestion(
  ctx: Context,
  config: Config,
  session: Session,
  turn: number,
  signal: AbortSignal,
): Promise<SuggestGhostSuggested | undefined> {
  signal.throwIfAborted();
  const startedAt = Date.now();
  // buildTranscript 已按 maxInputBytes 做 UTF-8 字节兜底截断，这里不再需要
  // 硬抛错：超预算的中文长回复会被优雅裁剪而非整轮静默失败。
  const transcript = buildTranscript(
    session,
    config.maxRecentTurns ?? 1,
    config.maxTranscriptChars,
    config.maxInputBytes,
  );
  if (transcript === undefined) {
    throw new Error('dsh-suggest-ghost: session has no model-visible transcript to suggest from');
  }
  const route = routeOf(session, config);
  const language = suggestionLanguage(transcript.pairs);
  const system = systemPrompt(config.maxSuggestionChars, language);
  const framed = frameTranscript(transcript.pairs);
  // source：0.1.7 删除了 `plugin` kind（0.1.5 有、0.1.7 无），且 0.1.7 新增的
  // `schedule` kind 在 0.1.5 不存在 —— 两代**无交集**，故取两代都有的 `user`。
  //
  // 这里 source 只用于构造一次性 LLM 请求载荷（见下方注释：请求细节不落会话日志），
  // 不参与持久化与投影，因此 `user` 的语义差异不影响任何读者。
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framed }],
    source: { kind: 'user' },
  })];
  // 请求细节（turn/seq/provider/model/maxTokens）不再写入会话日志：
  // rc.7 禁止未标记 ignorable 的自定义事件落日志，且建议经 settings `_push` 实时送达 client。

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 每次尝试独立截止时间：timeoutMs 是「单次调用」预算而非三次总和。
    using callDeadline = deadline(signal, config.timeoutMs, SUGGEST_TIMEOUT_CODE);
    const options: GenerateOptions = deepFreeze({
      provider: route.provider,
      model: route.model,
      messages,
      system,
      maxTokens: config.maxOutputTokens,
      sessionId: session.id,
      signal: callDeadline.signal,
    });
    try {
      callDeadline.signal.throwIfAborted();
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream(options)) {
        callDeadline.signal.throwIfAborted();
        assembler.push(chunk);
      }
      callDeadline.signal.throwIfAborted();
      const terminalError = finishError(assembler.finish);
      if (terminalError !== undefined) throw terminalError;
      const blocks = assembler.blocks();
      if (blocks.some(block => block.type === 'tool-call')) {
        throw new Error('dsh-suggest-ghost: suggestion output must contain text only');
      }
      const text = blocks
        .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join(' ');
      const cleaned = cleanSuggestion(text);
      if (cleaned.length === 0 || shouldFilterSuggestion(cleaned)) {
        // 空回复或不合格回复 = 正常「无建议」。归因日志：帮助诊断「这轮怎么没建议」。
        ctx.logger.debug?.(`dsh-suggest-ghost: no usable suggestion (empty/filtered) after ${Date.now() - startedAt}ms on attempt ${attempt}/${maxAttempts} (${route.provider}/${route.model})`);
        return undefined;
      }
      const { text: suggestion, truncated } = sanitizeSuggestion(cleaned, config.maxSuggestionChars);
      const suggested: SuggestGhostSuggested = {
        version: 1,
        turn,
        baseSeq: transcript.baseSeq,
        text: suggestion,
        truncated,
        acceptKey: config.acceptKey ?? 'Tab',
      };
      ctx.logger.debug?.(`dsh-suggest-ghost: suggestion ready in ${Date.now() - startedAt}ms on attempt ${attempt}/${maxAttempts} (${route.provider}/${route.model})`);
      return suggested;
    } catch (error) {
      // 外部中止（新回合取代 / 卸载）不重试；最后一次尝试失败则原样抛出。
      if (signal.aborted || attempt >= maxAttempts) throw error;
      ctx.logger.debug?.(`dsh-suggest-ghost: suggestion attempt ${attempt}/${maxAttempts} failed, retrying: ${String(error)}`);
      await backoff(signal, 1200 * attempt);
    }
  }
  /* v8 ignore next 2 -- 循环内必然 return 或 throw，此处仅满足类型收窄 */
  throw new Error('dsh-suggest-ghost: suggestion generation exhausted retries');
}

export { PROJECTION_KEY };
