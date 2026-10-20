#!/usr/bin/env node
/**
 * 停顿续写流水线的冒烟测试（`src/completion-gate.ts`）。
 *
 * ## 它保什么
 * live 实测到「用户停顿 >5s，幽灵不出，`ops consumed: complete` 之后日志一片空白」，
 * 30 次消费只产出 5 次续写。根因是 `handleComplete` 里五个静默 `return` 加上生成链
 * 根本没有上界。本文件把这两件事变成**离线可断言、且可被反向证伪**的东西：
 *
 *  1. 五条出口（开关关 / 草稿太短 / 会话不存在 / 被抢先 / 被中止）各自必须返回
 *     `action:'trace'` 且带非空 kind；
 *  2. 七条出口报文必须落进**七个不同的节流桶**（否则某条出口的第一次会被别人的
 *     计数器吞掉，等于又造一次静默）；
 *  3. 高频出口（被抢先 / 被中止）的阈值必须比默认 50 更紧，配置态异常第一次必报；
 *  4. 永不 settle 的生成会被墙钟上界判死：**留 `completion-timeout` 痕、清掉
 *     `pending` 里属于本次 controller 的条目、中止底层 controller**，且**下一次
 *     正常生成照样交付**（残留状态不影响后续）；
 *  5. 超时之后迟到的 reject 不得再报第二条、不得交付；
 *  6. 上游抢先中止（新草稿 / 卸载）绝不会被误记成超时；
 *  7. 报文里不得出现草稿正文（对报文构造器做「塞了正文也不许吐出来」的反证，
 *     再对 `src/index.ts` 的接线做静态守卫）；
 *  8. `src/index.ts` 的接线静态守卫：五个出口真的走 `traceFault`、真的清 pending、
 *     既有旧串一个字没改。
 *
 * 后半段的**反向验证**（把某条出口改回静默、断言必须红）见本文件末尾的说明与
 * `reverse` 一节：改坏 completion-gate 里那条 `traceOf('...')` 就会红，改法写在里面。
 *
 * 用法：node --experimental-strip-types scripts/completion-pipeline-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMPLETION_DEADLINE_CODE,
  COMPLETION_DEADLINE_MS,
  COMPLETION_EXIT_REASONS,
  armCompletionDeadline,
  completionExitTrace,
  completionFaultMessage,
  decideCompletionEntry,
  decideCompletionSettle,
  startBoundedCompletion,
} from '../src/completion-gate.ts';
import { faultSignature } from '../src/fault-signature.ts';

let cases = 0;
const run = (name, fn) => {
  cases += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n      ${String(error).split('\n').slice(0, 4).join('\n      ')}`);
    process.exitCode = 1;
  }
};
/** 异步版（超时那几条要真等定时器）。 */
const runAsync = async (name, fn) => {
  cases += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n      ${String(error).split('\n').slice(0, 4).join('\n      ')}`);
    process.exitCode = 1;
  }
};

const SESSION = 'session-95ff1532-3eab-4543-8cd8-d8aaeccdc44c';
/** 冒烟里一律用小上界，别真等 20s；生产值另有一组不变量断言。 */
const FAST_DEADLINE_MS = 25;
/** 假装是用户输入的东西：任何一条报文里出现它都算泄漏。 */
const SENTINEL = 'npm run deploy --force SECRET-DRAFT-TEXT';

// ── 1. 五个静默出口：逐个都必须变成 trace ──────────────────────────────────────
// 每条输入的注释标的是它在 `handleComplete` 里对应的那一行判据，改动那边要同步这边。
const FIVE_EXITS = [
  {
    name: '出口1 inlineEnabled === false',
    reason: 'inline-disabled',
    entry: { inlineEnabled: false, trimmedChars: 999, inlineMinChars: 4, sessionExists: true },
  },
  {
    name: '出口2 draft.trim().length < inlineMinChars',
    reason: 'draft-too-short',
    entry: { inlineEnabled: true, trimmedChars: 3, inlineMinChars: 4, sessionExists: true },
  },
  {
    name: '出口3 ctx.sessions.get(sessionId) === undefined',
    reason: 'session-missing',
    entry: { inlineEnabled: true, trimmedChars: 999, inlineMinChars: 4, sessionExists: false },
  },
];

for (const exit of FIVE_EXITS) {
  run(`${exit.name} → action:'trace' 且带 kind`, () => {
    const decision = decideCompletionEntry(exit.entry);
    assert.equal(decision.action, 'trace', `${exit.name} 又变回静默 return 了（action=${decision.action}）`);
    assert.equal(decision.reason, exit.reason);
    assert.ok(typeof decision.kind === 'string' && decision.kind.length > 0, 'kind 不能为空：空 kind 等于没有留痕');
    assert.ok(Number.isInteger(decision.every) && decision.every >= 1, `every=${decision.every} 非法（必须 ≥1 才是节流而不是静音）`);
  });
}

// 出口 4（then/catch 两处）与出口 5（catch 里被 abort 的那一支）。
run('出口4 then 侧：结果不属于当前 controller → trace', () => {
  const decision = decideCompletionSettle({
    phase: 'resolve', ownsSlot: false, aborted: true, timedOut: false, reported: undefined,
  });
  assert.equal(decision.action, 'trace', 'then 侧的被抢先又静默了——这正是 30 次消费里最像「没生成」的那一支');
  assert.equal(decision.reason, 'superseded');
});

run('出口4 catch 侧：同一判据 → 同一 kind（两处共用一个桶，不各报一份）', () => {
  const then = decideCompletionSettle({ phase: 'resolve', ownsSlot: false, aborted: true, timedOut: false, reported: undefined });
  const catchSide = decideCompletionSettle({ phase: 'reject', ownsSlot: false, aborted: true, timedOut: false, reported: undefined });
  assert.equal(catchSide.action, 'trace', 'catch 侧的被抢先又静默了');
  assert.equal(catchSide.kind, then.kind);
  assert.equal(catchSide.reason, 'superseded');
});

run('出口5 catch 里 controller.signal.aborted → trace（历史上这一支一个字都不打）', () => {
  const decision = decideCompletionSettle({
    phase: 'reject', ownsSlot: true, aborted: true, timedOut: false, reported: undefined,
  });
  assert.equal(decision.action, 'trace', '被 abort 的那次又永久静默了');
  assert.equal(decision.reason, 'aborted');
  assert.notEqual(decision.kind, 'completion-failed', '中止不是失败，混进 completion-failed 就把两种原因压成一种');
});

run('正常路径仍不留痕：resolve 且占槽且没被中止 → proceed', () => {
  const decision = decideCompletionSettle({
    phase: 'resolve', ownsSlot: true, aborted: false, timedOut: false, reported: undefined,
  });
  assert.deepEqual(decision, { action: 'proceed', reason: 'deliver' });
});

// ── 2. 七条出口必须落进七个不同的节流桶 ────────────────────────────────────────
// `traceFault` 按 kind + faultSignature(message) 计数。两条出口若撞进同一个桶，
// 后到的那条的第一次就会被前者的计数器吞掉——那是把本次故障换个写法再犯一遍。
run('七条出口的报文两两签名不同（每条的第一次都会独立报出）', () => {
  const messages = Object.fromEntries(COMPLETION_EXIT_REASONS.map((reason) => [
    reason,
    completionFaultMessage(reason, {
      sessionId: SESSION,
      draftChars: 12,
      inlineMinChars: 4,
      elapsedMs: 7000,
      deadlineMs: COMPLETION_DEADLINE_MS,
      errorText: 'Error: no logged request route is available',
    }),
  ]));
  const signatures = Object.entries(messages).map(([reason, text]) => `${completionExitTrace(reason).kind}|${faultSignature(text)}`);
  const distinct = new Set(signatures);
  assert.equal(distinct.size, COMPLETION_EXIT_REASONS.length, `出口应各占一桶，实得 ${distinct.size}/${COMPLETION_EXIT_REASONS.length}：${signatures.join(' , ')}`);
});

run('超时与失败是两条不同的痕（挂住了 ≠ 报错了）', () => {
  const timeout = completionFaultMessage('timeout', { sessionId: SESSION, draftChars: 8, elapsedMs: 20_000, deadlineMs: COMPLETION_DEADLINE_MS });
  const failed = completionFaultMessage('failed', { sessionId: SESSION, draftChars: 8, elapsedMs: 120, errorText: 'Error: 500' });
  assert.match(timeout, /^completion timeout\b/);
  assert.match(failed, /^completion failed for session /);
  assert.notEqual(timeout, failed);
});

// ── 3. 节流阈值的取值约束 ──────────────────────────────────────────────────────
run('高频出口（被抢先 / 被中止）阈值比默认 50 更紧', () => {
  for (const reason of ['superseded', 'aborted']) {
    const { every } = completionExitTrace(reason);
    assert.ok(every < 50, `${reason} 的 every=${every}：默认 50 比一次观测窗口的总消费数（实测 30）还大，整窗只剩第一条，量又变回不可知`);
    assert.ok(every >= 5, `${reason} 的 every=${every}：太接近 1 就是在重新制造 #21 那种洪水`);
  }
});

run('配置/状态异常三条的阈值既不为 1 也不超过 50', () => {
  for (const reason of ['inline-disabled', 'draft-too-short', 'session-missing']) {
    const { every } = completionExitTrace(reason);
    assert.ok(every >= 2 && every <= 50, `${reason} 的 every=${every}`);
  }
  // 桶内第一条必报是 traceFault 的行为，这里钉住「阈值不是 0 / 不是 Infinity」这个前提。
  assert.ok(Number.isFinite(completionExitTrace('session-missing').every));
});

run('failed 沿用既有 kind 与既有阈值 50（本次修复不许动它）', () => {
  const trace = completionExitTrace('failed');
  assert.equal(trace.kind, 'completion-failed');
  assert.equal(trace.every, 50);
});

run('每个出口类别都有登记的 kind（漏登记会在下面这条红）', () => {
  const kinds = new Map();
  for (const reason of COMPLETION_EXIT_REASONS) {
    const trace = completionExitTrace(reason);
    assert.ok(trace.kind.length > 0, `${reason} 没有 kind`);
    kinds.set(reason, trace.kind);
  }
  assert.equal(kinds.size, COMPLETION_EXIT_REASONS.length, 'kind 与出口必须一一对应');
});

// ── 4. 入口判定的优先级与穷尽性 ────────────────────────────────────────────────
run('三条异常同时成立时按 开关→阈值→会话 的顺序归因（顺序换了现场语义就变了）', () => {
  const all = { inlineEnabled: false, trimmedChars: 0, inlineMinChars: 4, sessionExists: false };
  assert.equal(decideCompletionEntry(all).reason, 'inline-disabled');
  assert.equal(decideCompletionEntry({ ...all, inlineEnabled: true }).reason, 'draft-too-short');
  assert.equal(decideCompletionEntry({ ...all, inlineEnabled: true, trimmedChars: 40 }).reason, 'session-missing');
});

run('入口输入空间穷尽：不存在 action:skip（入口段一条静默 return 都不许有）', () => {
  for (const inlineEnabled of [true, false]) {
    for (const sessionExists of [true, false]) {
      for (const trimmedChars of [0, 1, 3, 4, 5, 200]) {
        for (const inlineMinChars of [1, 4, 10]) {
          const decision = decideCompletionEntry({ inlineEnabled, trimmedChars, inlineMinChars, sessionExists });
          assert.notEqual(decision.action, 'skip', '入口段返回 skip 就是第六个静默出口');
          if (decision.action === 'trace') {
            assert.ok(decision.kind.length > 0 && decision.every >= 1, 'trace 判定必须带 kind 与合法阈值');
          }
        }
      }
    }
  }
});

run('settle 输入空间穷尽：既不静默也不重复报', () => {
  let traces = 0;
  let proceeds = 0;
  let skips = 0;
  for (const phase of ['resolve', 'reject']) {
    for (const ownsSlot of [true, false]) {
      for (const aborted of [true, false]) {
        for (const timedOut of [true, false]) {
          for (const reported of [undefined, 'timeout']) {
            const decision = decideCompletionSettle({ phase, ownsSlot, aborted, timedOut, reported });
            if (decision.action === 'trace') traces += 1;
            if (decision.action === 'proceed') proceeds += 1;
            if (decision.action === 'skip') skips += 1;
            if (decision.action === 'skip') {
              // skip 必须指名它在跳过哪条已报的出口——无解释的 skip 就是新的静默出口。
              assert.ok(decision.reportedAs === 'timeout' || decision.reportedAs === 'aborted', `skip 没指名先前那条出口：${JSON.stringify(decision)}`);
              assert.equal(reported, decision.reportedAs, 'skip 只能出现在先前确实报过的输入上');
            }
            if (decision.action === 'proceed') {
              assert.equal(phase, 'resolve', 'reject 不可能交付');
              assert.equal(ownsSlot, true, '被抢先的结果不可能交付');
              assert.equal(timedOut, false, '判死过的结果不可能交付');
              assert.equal(reported, undefined, '报过的结果不可能再交付');
            }
          }
        }
      }
    }
  }
  assert.ok(traces > 0 && proceeds > 0 && skips > 0, `三类判定都该出现（trace=${traces} proceed=${proceeds} skip=${skips}）`);
});

// ── 5. 报文隐私：不许出现草稿正文 ──────────────────────────────────────────────
run('报文只含字符数；把正文硬塞进入参也不会被吐出来', () => {
  for (const reason of COMPLETION_EXIT_REASONS) {
    // 结构上没有 `draft` 这个键；这里故意塞一个，验证构造器确实只读白名单字段。
    const text = completionFaultMessage(reason, {
      sessionId: SESSION,
      draftChars: SENTINEL.length,
      inlineMinChars: 4,
      elapsedMs: 10,
      deadlineMs: 20_000,
      errorText: 'Error: route missing',
      draft: SENTINEL,
    });
    assert.ok(!text.includes(SENTINEL), `${reason} 的报文里出现了草稿正文：${text}`);
    assert.ok(!text.includes('deploy'), `${reason} 的报文疑似带了正文片段：${text}`);
    assert.ok(/draftChars=\d+/.test(text) || reason === 'failed', `${reason} 的报文该有字符数却没有：${text}`);
  }
});

run('超时报文里的上界值取自传入值（不硬编码 20000，改了常量报文跟着走）', () => {
  const text = completionFaultMessage('timeout', { sessionId: SESSION, draftChars: 5, elapsedMs: 30, deadlineMs: 1234 });
  assert.match(text, /no settle within 1234ms/);
});

// ── 6. 墙钟上界的取值不变量（这条常量是本修复的全部风险所在）────────────────────
run('上界既不误杀正常重试，也不会慢到形同没有', () => {
  // 实测成功 1.5~7s；generateCompletion 自带 2 次尝试 + 800ms 退避。
  const observedWorst = 7_000;
  const legitRetryChain = observedWorst * 2 + 800;
  assert.ok(COMPLETION_DEADLINE_MS > legitRetryChain, `上界 ${COMPLETION_DEADLINE_MS}ms 会把一次合法的两次重试（≈${legitRetryChain}ms）判死`);
  // 大上下文允许每条 attempt 比最坏实测慢 1 倍以内仍不误杀。
  assert.ok(COMPLETION_DEADLINE_MS >= observedWorst * 2, `上界 ${COMPLETION_DEADLINE_MS}ms 连「大上下文慢一倍 ×2 次」都容不下`);
  assert.ok(COMPLETION_DEADLINE_MS <= 30_000, `上界 ${COMPLETION_DEADLINE_MS}ms 太久：那是用户已经忘了自己在等什么的时候`);
  assert.ok(COMPLETION_DEADLINE_MS < 60_000, '必须比内层单 attempt 预算（timeoutMs 默认 60s）更紧，否则这条链的有效上界还是内层那个 60s');
});

run('本次修复不新增 volatile 配置字段（上界是常量）', () => {
  const hostSource = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  // 只截 `const EditableFields = {` 这个对象字面量本身：从起始 brace 找到它自己的
  // `};`。上一版在这里用 indexOf('/** 配置 schema') 取右边界，而源码里那句写在
  // `/**\n * 配置 schema` 的第二行，indexOf 拿不到（返回 -1），slice 于是变成
  // 「从 EditableFields 一直切到文件末尾」——断言看着在查设置项，其实在查全文，
  // 接线处一句合法的 `deadlineMs: COMPLETION_DEADLINE_MS` 就把它绊红了。
  const fieldsStart = hostSource.indexOf('const EditableFields = {');
  assert.ok(fieldsStart >= 0, '找不到 EditableFields');
  const fieldsEnd = hostSource.indexOf('\n};', fieldsStart);
  assert.ok(fieldsEnd > fieldsStart, 'EditableFields 的右边界定位失败');
  const editableBlock = hostSource.slice(fieldsStart, fieldsEnd);
  // 只认**字段声明**形态（`名字: z.`），不认散文：这样它查的是「设置页有没有多一个开关」，
  // 而不是「注释里有没有出现过 deadline 这个词」。
  const fieldPattern = /^[ \t]*(\w+)[ \t]*:[ \t]*z\./gm;
  const editableFields = [...editableBlock.matchAll(fieldPattern)].map((m) => m[1]);
  // 基线：main=7e4fe13 的 EditableFields 共 25 个字段（含 _ops/_push 两个传输载体），
  // 逐字段 .volatile()。顺序按源码声明顺序断言，改顺序也会红——那是设置页的呈现顺序。
  // 这条断言是「不许新增」的正身：新增任何一个字段（不管叫什么）都会让这里红，
  // 而按名字猜（deadline/budget/timeout）会漏掉别名，也会误伤本来就存在的 timeoutMs。
  const BASELINE_FIELDS = [
    'maxInputBytes', 'maxOutputTokens', 'timeoutMs', 'maxRecentTurns', 'maxTranscriptChars',
    'contextSummaryEnabled', 'contextSummaryChars', 'maxSuggestionChars', 'provider', 'model',
    'llmEnabled', 'historyEnabled', 'historyCrossSession', 'historyMaxEntries', 'historyMinChars',
    'inlineEnabled', 'inlineDelayMs', 'inlineMinChars', 'inlineMaxChars', 'wordAccept',
    'acceptKey', 'languageMode', 'uiLocaleWeight', '_ops', '_push',
  ];
  assert.deepEqual(
    editableFields,
    BASELINE_FIELDS,
    `设置项字段与基线不一致（多出来的就是本次新增的 volatile 配置——那要同时牵动 schema、WebUI 表单与 live-settings 键表）：现 ${editableFields.join(',')} / 基线 ${BASELINE_FIELDS.join(',')}`,
  );
  assert.ok(hostSource.includes('COMPLETION_DEADLINE_MS'), '接线处没引用那个常量');
  // 上界必须是常量：如果它改从 cfg 读，上一条字段断言会先红，这条再钉一次反向证据。
  assert.match(hostSource, /export const COMPLETION_DEADLINE_MS|COMPLETION_DEADLINE_MS/);
  assert.ok(!/cfg\.(deadline|budget)/.test(hostSource), '上界改成了从配置读：那必须连带动 schema/表单/键表，本次明确不做');

  // live-settings 的键表也不许多一个键（同一个改动的另一半）。
  const lsSource = readFileSync(fileURLToPath(new URL('../src/live-settings.ts', import.meta.url)), 'utf8');
  const specsStart = lsSource.indexOf('const SETTING_SPECS');
  const specsEnd = lsSource.indexOf('\n};', specsStart);
  assert.ok(specsStart >= 0 && specsEnd > specsStart, 'SETTING_SPECS 定位失败');
  const specsBlock = lsSource.slice(specsStart, specsEnd);
  // 键表只比**集合**：它的声明顺序与 EditableFields 不同（历史上就不同），但键必须
  // 一个不多一个不少——`SETTING_SPECS` 是 `Record<keyof FlatConfig, FieldSpec>`，
  // 少一个键编译不过，多一个键就是本次偷偷加了个新设置项。
  const specKeys = [...specsBlock.matchAll(/^[ \t]*(\w+):[ \t]/gm)].map((m) => m[1]).sort();
  const baselineSpecKeys = BASELINE_FIELDS.filter((k) => !k.startsWith('_')).sort();
  assert.deepEqual(specKeys, baselineSpecKeys, `SETTING_SPECS 键表与基线不一致：现 ${specKeys.join(',')} / 基线 ${baselineSpecKeys.join(',')}`);
});

// ── 7. 有界超时的真运行验证（永不 settle 的生成会被判死）───────────────────────
/** 造一套注入依赖：pending 槽、留痕收集器、交付收集器。 */
const harness = (deadlineMs = FAST_DEADLINE_MS) => {
  const pending = new Map();
  const traces = [];
  const delivered = [];
  const deps = {
    pending,
    trace: (kind, message, every) => { traces.push({ kind, message, every }); },
    deliver: (delivery) => { delivered.push(delivery); },
    deadlineMs,
  };
  return { pending, traces, delivered, deps };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await runAsync('永不 settle 的生成：到点留 completion-timeout、清 pending、abort 底层', async () => {
  const h = harness();
  const controller = new AbortController();
  h.pending.set(SESSION, controller);
  let sawSignal = null;
  startBoundedCompletion(h.deps, {
    sessionId: SESSION,
    controller,
    startedAt: Date.now(),
    draftChars: 12,
    // 永不 settle：既不 resolve 也不 reject，也不观察 signal —— 就是线上那种挂住。
    generate: (signal) => { sawSignal = signal; return new Promise(() => {}); },
  });
  await sleep(FAST_DEADLINE_MS * 3);
  assert.equal(h.traces.length, 1, `应当恰好留一条超时痕，实得 ${h.traces.length}：${JSON.stringify(h.traces)}`);
  assert.equal(h.traces[0].kind, 'completion-timeout');
  assert.match(h.traces[0].message, /^completion timeout:/);
  assert.equal(h.pending.size, 0, 'pending 里那条条目没被清掉：下一次停顿会踩在残留状态上');
  assert.equal(controller.signal.aborted, true, '底层 controller 没被 abort：那个挂住的请求还在占连接');
  assert.equal(sawSignal.aborted, true, '交给生成链的融合信号没中止');
  assert.equal(h.delivered.length, 0, '超时不该有任何交付');
});

await runAsync('超时之后下一次正常生成照常交付（残留不影响后续）', async () => {
  const h = harness();
  const first = new AbortController();
  h.pending.set(SESSION, first);
  startBoundedCompletion(h.deps, {
    sessionId: SESSION, controller: first, startedAt: Date.now(), draftChars: 12,
    generate: () => new Promise(() => {}),
  });
  await sleep(FAST_DEADLINE_MS * 3);
  assert.equal(h.traces.length, 1);
  // 第二次：用户又停顿了一次，这次 provider 正常返回。
  const second = new AbortController();
  h.pending.set(SESSION, second);
  startBoundedCompletion(h.deps, {
    sessionId: SESSION, controller: second, startedAt: Date.now(), draftChars: 14,
    generate: async () => ({ text: ' ok', language: 'English' }),
  });
  await sleep(FAST_DEADLINE_MS);
  assert.equal(h.traces.length, 1, `第二次不该有任何痕：${JSON.stringify(h.traces)}`);
  assert.equal(h.delivered.length, 1, '第二次没交付：超时把后续生成弄坏了');
  assert.equal(h.pending.size, 0, '成功后 pending 必须清空');
  assert.equal(second.signal.aborted, false, '成功那次不该被中止');
});

await runAsync('超时后迟到的 reject：只报一条，且不交付', async () => {
  const h = harness();
  const controller = new AbortController();
  h.pending.set(SESSION, controller);
  startBoundedCompletion(h.deps, {
    sessionId: SESSION, controller, startedAt: Date.now(), draftChars: 12,
    generate: (signal) => new Promise((_, reject) => {
      // 到点之后由 signal 驱动迟到 reject（真实 provider 就是这么反应的）。
      signal.addEventListener('abort', () => reject(new Error('aborted late')), { once: true });
    }),
  });
  await sleep(FAST_DEADLINE_MS * 4);
  assert.equal(h.traces.length, 1, `同一件事报了 ${h.traces.length} 条：${JSON.stringify(h.traces.map((t) => t.kind))}`);
  assert.equal(h.traces[0].kind, 'completion-timeout');
  assert.equal(h.delivered.length, 0);
});

await runAsync('超时后迟到的 resolve：不交付（那份草稿早就不是当前草稿了）', async () => {
  const h = harness();
  const controller = new AbortController();
  h.pending.set(SESSION, controller);
  let release = null;
  startBoundedCompletion(h.deps, {
    sessionId: SESSION, controller, startedAt: Date.now(), draftChars: 12,
    generate: () => new Promise((resolve) => { release = resolve; }),
  });
  await sleep(FAST_DEADLINE_MS * 2);
  release({ text: ' too late', language: 'English' });
  await sleep(FAST_DEADLINE_MS);
  assert.equal(h.delivered.length, 0, '判死之后迟到的结果被交付了');
  assert.equal(h.traces.length, 1);
  assert.equal(h.traces[0].kind, 'completion-timeout');
});

await runAsync('正常 settle 会把上界 timer 撤掉（成功之后不会再冒出超时痕）', async () => {
  const h = harness(FAST_DEADLINE_MS);
  const controller = new AbortController();
  h.pending.set(SESSION, controller);
  startBoundedCompletion(h.deps, {
    sessionId: SESSION, controller, startedAt: Date.now(), draftChars: 12,
    generate: async () => ({ text: ' done', language: 'English' }),
  });
  await sleep(FAST_DEADLINE_MS * 4);
  assert.equal(h.traces.length, 0, `成功之后还留了痕：${JSON.stringify(h.traces)}`);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].value.text, ' done');
});

await runAsync('上游抢先（新草稿接管槽位）→ 记 superseded，绝不误记 timeout', async () => {
  const h = harness(200);
  const oldController = new AbortController();
  const newController = new AbortController();
  h.pending.set(SESSION, newController); // 更新草稿已经接管槽位
  startBoundedCompletion(h.deps, {
    sessionId: SESSION, controller: oldController, startedAt: Date.now(), draftChars: 12,
    generate: (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  oldController.abort(); // 单飞：由调用方发起
  await sleep(30);
  assert.equal(h.traces.length, 1);
  assert.equal(h.traces[0].kind, 'completion-preempted');
  assert.equal(h.pending.get(SESSION), newController, '把新 controller 的条目清掉了——那会让下一次停顿丢掉在途标记');
  assert.equal(newController.signal.aborted, false, '不该顺手中止新生成');
});

await runAsync('卸载式中止（仍占槽）→ 记 completion-aborted', async () => {
  const h = harness(200);
  const controller = new AbortController();
  h.pending.set(SESSION, controller);
  startBoundedCompletion(h.deps, {
    sessionId: SESSION, controller, startedAt: Date.now(), draftChars: 12,
    generate: (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true });
    }),
  });
  controller.abort();
  await sleep(30);
  assert.equal(h.traces.length, 1);
  assert.equal(h.traces[0].kind, 'completion-aborted');
  assert.match(h.traces[0].message, /^completion aborted before settle/);
  assert.equal(h.pending.size, 0, '中止之后槽位要清空');
});

await runAsync('真实失败仍走既有 completion-failed 报文格式', async () => {
  const h = harness(200);
  const controller = new AbortController();
  h.pending.set(SESSION, controller);
  startBoundedCompletion(h.deps, {
    sessionId: SESSION, controller, startedAt: Date.now(), draftChars: 12,
    generate: async () => { throw new Error('no logged request route is available'); },
  });
  await sleep(30);
  assert.equal(h.traces.length, 1);
  assert.equal(h.traces[0].kind, 'completion-failed');
  assert.match(h.traces[0].message, new RegExp(`^completion failed for session ${SESSION} after \\d+ms: Error: no logged request route`));
  assert.equal(h.pending.size, 0);
});

await runAsync('armCompletionDeadline：上游中止不触发 onTimeout（归属由超时码判定）', async () => {
  const controller = new AbortController();
  let fired = 0;
  const bound = armCompletionDeadline(controller.signal, 20, () => { fired += 1; });
  controller.abort();
  await sleep(60);
  assert.equal(fired, 0, '上游中止被误记成超时：被抢先会显示成挂住');
  assert.equal(bound.signal.aborted, true);
  bound.dispose();
  bound.dispose(); // 幂等
});

// ── 8. host 接线的静态守卫 ─────────────────────────────────────────────────────
// 上面的断言全部只证 completion-gate 自己；「index.ts 真的把每条判定接成了 traceFault」
// 这一步如果接错（比如把 trace 判定写成了裸 return），那些断言一条都不会红。
// 手法与 `scripts/deferred-writes-smoke.mjs` 第 8 段一致：只查代码，注释里出现旧写法
// 不算回归，所以先把注释与块注释剥掉再匹配。
const hostRaw = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
const hostSource = hostRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const handleCompleteBody = (() => {
  const at = hostSource.indexOf('const handleComplete = (');
  assert.ok(at > 0, '找不到 handleComplete');
  const end = hostSource.indexOf('\n  };', at);
  assert.ok(end > at, 'handleComplete 的结尾定位失败');
  return hostSource.slice(at, end);
})();

run('五个出口在 host 侧真的走 traceFault（不是裸 return）', () => {
  assert.match(handleCompleteBody, /decideCompletionEntry\(/, '入口判定没接 gate');
  assert.match(handleCompleteBody, /traceFault\('completion-gate-drift'/, '入口段的 skip 兜底留痕没了：那等于又开一个静默口子');
  assert.match(handleCompleteBody, /traceEntryExit\(entry\)/, '入口判定为 trace 时没落痕');
  assert.match(handleCompleteBody, /trace: traceFault/, 'startBoundedCompletion 的留痕通道没接 traceFault');
  assert.match(handleCompleteBody, /startBoundedCompletion/, '生成没走有界收口');
  assert.match(handleCompleteBody, /deadlineMs: COMPLETION_DEADLINE_MS/, '上界没在接线处显式传出来：现场读 handleComplete 看不见这条链有界');
});

run('gate 内部的四种收口都清 pending、超时还额外 abort', () => {
  const gateSource = readFileSync(fileURLToPath(new URL('../src/completion-gate.ts', import.meta.url)), 'utf8');
  assert.match(gateSource, /if \(ownsSlot\) pending\.delete\(sessionId\)/, 'settle 不清 pending');
  assert.match(gateSource, /outcome\.phase === 'timeout'[\s\S]{0,120}controller\.abort\(\)/, '超时没中止底层请求');
});

run('既有旧串逐字未改（别的脚本按这些串 grep 验收）', () => {
  const old = [
    '[dsh-suggest-ghost][ops-trace]',
    'ops consumed: complete',
    'completion generated session=',
    'completion dropped (empty or filtered) session=',
    'push landed rev=',
    'deferred push landed rev=',
  ];
  for (const needle of old) {
    assert.ok(hostRaw.includes(needle), `既有留痕串被改动或删掉了：${needle}`);
  }
  // failed 的报文改由 gate 生成（index.ts 里只剩引用），所以既要在 gate 源码里逐字保住旧串，
  // 也要证明产物字节不变。
  // failed 的报文改由 gate 生成（index.ts 里只剩引用），所以既要在 gate 源码里
  // 逐字保住旧串，也要证明产物字节不变。
  const gateText = readFileSync(fileURLToPath(new URL('../src/completion-gate.ts', import.meta.url)), 'utf8');
  assert.ok(
    gateText.includes('completion failed for session ${ctx.sessionId} after ${ctx.elapsedMs ?? 0}ms:'),
    'gate 里那条旧串被改写了',
  );
  assert.equal(
    completionFaultMessage('failed', { sessionId: SESSION, draftChars: 1, elapsedMs: 27, errorText: 'Error: no logged request route is available' }),
    `completion failed for session ${SESSION} after 27ms: Error: no logged request route is available`,
  );
});

run('续写链路上没有任何 traceOps/console.log 直接打印草稿', () => {
  const forbidden = [/\$\{draft\}/, /\bdraft\s*,(?!\s*\.\.\.)\s*\)/, /console\.log\([^)]*\bdraft\b/];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(handleCompleteBody), `handleComplete 里可能把草稿正文抄进日志：${pattern}`);
  }
  assert.match(handleCompleteBody, /const draftChars = draft\.length;/, '报文口径应是未 trim 的长度（与 ops consumed 那行同口径）');
  assert.match(handleCompleteBody, /trimmedChars: draft\.trim\(\)\.length/, '判定口径应是 trim 后的长度（与历史行为一致）');
});

run('卸载清理仍然中止所有在途续写', () => {
  const effectAt = hostSource.indexOf('ctx.effect(');
  const abortAllAt = hostSource.indexOf('for (const controller of completionPending.values()) controller.abort();');
  assert.ok(abortAllAt > effectAt, '卸载时不再中止在途续写：旧闭包的请求会跨 partialReload 活着');
});

// ── 9. 反向验证（改回静默必须红）见文件末尾注释 ────────────────────────────────
console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} completion-pipeline-smoke: ${cases} 组用例${process.exitCode === 1 ? '（有失败）' : '全部通过'}`);

/**
 * ## 怎么做反向验证（本机照做，三步各验一条）
 *
 *  R1 把出口 5 改回静默：`src/completion-gate.ts` 里
 *      `if (input.phase === 'reject' && input.aborted) return traceOf('aborted');`
 *      改成 `if (input.phase === 'reject' && input.aborted) return { action: 'proceed', reason: 'deliver' };`
 *      → 应红在「出口5 catch 里 controller.signal.aborted → trace」以及
 *        「settle 输入空间穷尽」（proceed 断言里 aborted 必须为 false）。
 *      改回来 → 绿。
 *
 *  R2 把出口 1 改回静默：`decideCompletionEntry` 第一行改成
 *      `if (!input.inlineEnabled) return { action: 'proceed', reason: 'generate' };`
 *      → 应红在「出口1 … → action:'trace'」和「三条异常同时成立时按顺序归因」。
 *
 *  R3 把上界撤掉：`startBoundedCompletion` 里 `armCompletionDeadline(...)` 换成
 *      直接 `const bound = { signal: controller.signal, dispose() {} }`，
 *      → 应红在「永不 settle 的生成：到点留 completion-timeout、清 pending、abort 底层」。
 *      这条是缺陷二的反向验证：没有上界时那个 promise 就永远挂着，与线上一致。
 */
