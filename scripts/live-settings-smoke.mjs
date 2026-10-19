// Gitea #19 遗留段冒烟：host 用户可调项改走 settings.describe() 实时读值。
//
// 用一个**假 settings service**（`describe()` 返回本 ns 的 row）驱动
// `src/live-settings.ts` 的读源 + `src/settings.ts` 的合并策略，断言：
//  1. boot 时读到默认值（服务未注入 / 行缺失都安全回退，不抛）；
//  2. describe() 把 `inlineEnabled` 改成 false → `effective().inlineEnabled === false`
//     （= 「设置页改开关，运行中不重启即生效」；宿主不能重启，这条只能在 smoke 层证明）；
//  3. `_ops` / `_push` 这类 volatile 传输载体不污染设置值；
//  4. describe() 抛异常 / 未注入时回退不抛，且不做注定失败的重试；
//  5. 缓存与失效语义：命中缓存零 describe()，事件风暴合并成一次现读，TTL 兜底。
//
// 用法：node scripts/live-settings-smoke.mjs
// （依赖 node ≥22.18 的默认 type stripping，直接 import src/*.ts）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createLiveSettings,
  pickLiveSettings,
  pickNamespaceRow,
  pickNamespaceValue,
  SETTING_KEYS,
  TRANSPORT_KEYS,
} from '../src/live-settings.ts';
import { effectiveConfig, mergeLiveConfig, SUGGEST_GHOST_NAMESPACE as NS } from '../src/settings.ts';

/** 本 ns 的 row：`describe()` 里 `ns` 匹配的那一项。 */
const row = (value, revision = 1) => ({ ns: NS, revision, applies: 'live', schema: '{}', value });
const otherRow = (value = { inlineEnabled: false }, revision = 9) => ({ ns: 'some-other-plugin', revision, value });

/**
 * boot 默认层（= `flattenConfig(resolveConfig(...))` 的产物形状）。
 * 数值与 `generate.ts` 的 `resolveConfig` / `flattenConfig` 默认值逐条对齐；
 * `_ops` / `_push` 故意带上：`flattenConfig` 是 `{...config}` 展开，运行时这两个
 * 载体确实挂在对象上（类型里没有），正是「可能被当设置值读走」的那类脏来源。
 */
function makeBoot(over = {}) {
  return {
    maxInputBytes: 4096,
    maxOutputTokens: 512,
    timeoutMs: 60_000,
    maxRecentTurns: 3,
    maxTranscriptChars: 12_000,
    maxSuggestionChars: 240,
    provider: '',
    model: '',
    acceptKey: 'Tab',
    llmEnabled: true,
    inlineEnabled: true,
    inlineMaxChars: 160,
    contextSummaryEnabled: true,
    contextSummaryChars: 1500,
    historyEnabled: true,
    historyCrossSession: false,
    historyMaxEntries: 50,
    historyMinChars: 1,
    wordAccept: true,
    languageMode: 'auto',
    uiLocaleWeight: 100,
    inlineDelayMs: 800,
    inlineMinChars: 4,
    _ops: 'BOOT_OPS_REF',
    _push: 'BOOT_PUSH_REF',
    ...over,
  };
}

/**
 * 复刻 host 的接线（index.ts 里就是这几行），断言的是**真实生效路径**：
 * `boot` = flattenConfig(resolved) 默认层，`effective()` = 读源 snapshot(boot)，
 * 合并策略用 host 同一个 `mergeLiveConfig`。
 */
function makeHost({ boot = makeBoot(), describeValue = () => undefined, now = undefined, staleAfterMs } = {}) {
  let calls = 0;
  const info = [];
  const live = createLiveSettings({
    ns: NS,
    readDescribe: () => {
      calls += 1;
      return describeValue();
    },
    merge: mergeLiveConfig,
    onRefresh: (event) => info.push(event),
    ...(now === undefined ? {} : { now }),
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
  });
  const effective = () => live.snapshot(boot);
  return { live, effective, calls: () => calls, info };
}

// —— 1. boot：服务未注入（describe 不可用）→ 读到默认值，且不抛 ——
{
  const h = makeHost({ describeValue: () => undefined });
  assert.equal(h.effective().inlineEnabled, true, '未注入时应回落 boot 默认值');
  assert.equal(h.effective().historyMaxEntries, 50);
  assert.equal(h.effective().llmEnabled, true);
  assert.deepEqual(h.live.current(), {}, '未注入时覆盖值应为空对象');
  assert.equal(h.info.at(-1).ok, false);
  assert.equal(h.info.at(-1).reason, 'row-missing', '未注入应报 row-missing 而非抛异常');
}

// —— 2. 服务未注入但 readDescribe 直接抛（早期 ctx 未就绪）→ 同样安全 ——
{
  const h = makeHost({ describeValue: () => { throw new Error('settings fiber not ready'); } });
  assert.equal(h.effective().inlineEnabled, true, 'describe 抛异常时不得冒泡，须回落 boot');
  assert.equal(h.info.at(-1).reason, 'describe-threw');
  // 抛异常后清脏：下一次读不再重复付一次注定失败的 describe()。
  const before = h.calls();
  h.effective();
  h.effective();
  assert.equal(h.calls(), before, 'describe-threw 后不应每次读重试（靠 TTL / 事件再试）');
}

// —— 3. 行缺失（别的 ns / 服务未注入）→ 回落 boot，不抛，且不每次读重试 ——
{
  const h = makeHost({ describeValue: () => [otherRow()] });
  assert.equal(h.effective().inlineEnabled, true);
  assert.equal(h.info.at(-1).reason, 'row-missing');
  const afterFirst = h.calls();
  for (let i = 0; i < 10; i += 1) h.effective();
  assert.equal(h.calls(), afterFirst, '读不到行时不得每次读都付一次全量 describe() 遍历');
  // 注入就位时刻 host 显式 invalidate()（index.ts 的 ctx.inject 回调）。
  // 语义：**标脏不等于现读**——下一次读才付 describe()，风暴期多次标脏合并成一次。
  h.live.invalidate();
  assert.equal(h.calls(), afterFirst, 'invalidate 只标脏，不立刻 describe()');
  h.effective();
  assert.equal(h.calls(), afterFirst + 1, 'invalidate 后下一次读必须现取，不等 TTL');
  // 现取之后又落到「有行但值是非法的」这种边界：仍然不抛，仍是 boot 视图。
  assert.equal(typeof h.effective().inlineMinChars, 'number');
}

// —— 4. 核心断言：describe() 里把 inlineEnabled 关掉 → 不重启即生效 ——
{
  let value = { ...makeBoot() };
  const h = makeHost({ describeValue: () => [row(value)] });
  assert.equal(h.effective().inlineEnabled, true, 'boot 应读到默认开');
  value = { ...value, inlineEnabled: false };
  h.live.invalidate(); // = document-updated(ns) 事件到达
  assert.equal(h.effective().inlineEnabled, false, '设置页关开关后 effective() 必须翻成 false');
  // 事件没送达也要自愈（TTL 兜底）：假时钟推进过 staleAfterMs。
  let clock = 1_000;
  let value2 = { ...makeBoot(), llmEnabled: false };
  const h2 = makeHost({
    describeValue: () => [row(value2)],
    now: () => clock,
    staleAfterMs: 5_000,
  });
  assert.equal(h2.effective().llmEnabled, false, '首次读即取到实时值');
  value2 = { ...value2, llmEnabled: true };
  clock += 4_999;
  assert.equal(h2.effective().llmEnabled, false, 'TTL 未到不重复现读');
  clock += 1;
  assert.equal(h2.effective().llmEnabled, true, '事件丢失时 TTL 兜底应自愈');
}

// —— 5. 热路径成本：命中缓存零 describe()；风暴期间 N 次事件合并成 1 次现读 ——
{
  const boot = makeBoot();
  const h = makeHost({ boot, describeValue: () => [row({ ...boot })] });
  h.effective();
  const base = h.calls();
  for (let i = 0; i < 1_000; i += 1) h.effective();
  assert.equal(h.calls(), base, '未失效时 1000 次读不应新增任何 describe()');
  assert.equal(h.live.snapshot(boot), h.live.snapshot(boot), '缓存命中返回同一对象引用（不重建）');
  for (let i = 0; i < 200; i += 1) h.live.invalidate(); // 事件风暴
  h.effective();
  assert.equal(h.calls(), base + 1, '200 次标脏 + 1 次读 = 只现读一次');
  assert.equal(h.info.at(-1).ok, true);
  assert.equal(h.info.at(-1).revision, 1);
  // 诊断口径与真实 describe() 次数一致（host 日志就靠这两个读数）。
  assert.equal(h.live.refreshCount(), h.calls(), 'refreshCount 必须等于真实 describe() 调用次数');
  assert.equal(h.live.revision(), 1, 'revision() 暴露本 ns 行的 revision');
}

// —— 6. `_ops` / `_push` 不污染设置值（#19 的关键陷阱）——
{
  const boot = makeBoot();
  const polluted = {
    ...boot,
    inlineMinChars: 7,
    _ops: JSON.stringify({ v: 1, ops: [{ op: 'clear' }] }),
    _push: JSON.stringify({ rev: 42, suggestion: null, hot: [] }),
    totallyUnknownKey: 'x',
  };
  const h = makeHost({ describeValue: () => [row(polluted)] });
  const cfg = h.effective();
  assert.equal(cfg.inlineMinChars, 7, '真设置项应被读到');
  for (const key of TRANSPORT_KEYS) {
    assert.ok(!(key in h.live.current()), `${key} 不得进入设置覆盖值`);
    assert.equal(cfg[key], boot[key], `${key} 必须保持 boot 载体，不能被 row.value 的 JSON 载荷覆盖`);
  }
  assert.ok(!('totallyUnknownKey' in h.live.current()), '未知键不得进入覆盖值（白名单）');
  assert.deepEqual(
    Object.keys(h.live.current()).sort(),
    [...SETTING_KEYS.filter((k) => k in polluted)].sort(),
    '覆盖值键集 = 白名单 ∩ row.value 键集',
  );
  // 键表与传输字段必须互斥（加载期不变量的测试侧对照）。
  assert.deepEqual(TRANSPORT_KEYS.filter((k) => SETTING_KEYS.includes(k)), []);
}

// —— 7. 校验失败逐键丢弃 → 回落 boot（不是把非法值带进生成路径）——
{
  // boot 用「一眼可辨」的自定义值：丢弃后必须落回这些值，而不是 schema 默认值，
  // 这样才能区分「没读到」与「读到但判非法丢弃」。
  const boot = makeBoot({
    inlineEnabled: true, inlineMinChars: 9, historyMaxEntries: 33, timeoutMs: 45_000,
    inlineDelayMs: 1200, acceptKey: 'Enter', contextSummaryChars: 2000,
  });
  const h = makeHost({
    boot,
    describeValue: () => [row({
      inlineEnabled: 'false',      // 类型错
      inlineMinChars: -3,          // 低于 min(1)
      historyMaxEntries: 1.5,      // 非整数
      timeoutMs: 2_147_483_648,    // 超 MAX_TIMER_DELAY_MS
      inlineDelayMs: 50,           // 低于 schema min(100)
      acceptKey: '   ',            // 非空串要求
      contextSummaryChars: 99,     // 低于 min(100)
      llmEnabled: false,           // 合法：同批次里应被读到
      unknownKeyForced: 0,         // 未知键
      _ops: 'x', _push: 'y',       // 传输载体
    })],
  });
  const cfg = h.effective();
  assert.equal(cfg.inlineEnabled, true, '非法值丢弃后回落 boot 值');
  assert.equal(cfg.inlineMinChars, 9);
  assert.equal(cfg.historyMaxEntries, 33);
  assert.equal(cfg.timeoutMs, 45_000);
  assert.equal(cfg.inlineDelayMs, 1200);
  assert.equal(cfg.acceptKey, 'Enter');
  assert.equal(cfg.contextSummaryChars, 2000);
  assert.equal(cfg.llmEnabled, false, '同批次里的合法值仍须生效');
  assert.deepEqual(h.live.current(), { llmEnabled: false }, '只有 1 个键通过校验');
  assert.equal(h.info.at(-1).applied, 1);
  // 0 合法（= 不限 / 关闭加成）：不能被 min(1) 的直觉误杀。
  const h0 = makeHost({ describeValue: () => [row({ ...makeBoot(), historyMaxEntries: 0, uiLocaleWeight: 0 })] });
  assert.equal(h0.effective().historyMaxEntries, 0);
  assert.equal(h0.effective().uiLocaleWeight, 0);
}

// —— 8. 引用形态（老代次 / 回退路径给到 Volatile）也要展开 ——
{
  const h = makeHost({
    describeValue: () => [row({ inlineEnabled: { get: () => false }, historyMaxEntries: { get: () => 7 } })],
  });
  assert.equal(h.effective().inlineEnabled, false);
  assert.equal(h.effective().historyMaxEntries, 7);
}

// —— 9. describe() 形状兼容：数组 / { namespaces } 包装 ——
{
  assert.deepEqual(pickNamespaceValue([row({ inlineEnabled: false })], NS), { inlineEnabled: false });
  assert.deepEqual(pickNamespaceValue({ namespaces: [row({ inlineEnabled: true })] }, NS), { inlineEnabled: true });
  assert.equal(pickNamespaceValue({ namespaces: [otherRow()] }, NS), undefined);
  assert.equal(pickNamespaceValue(null, NS), undefined);
  assert.equal(pickNamespaceValue(undefined, NS), undefined);
  assert.equal(pickNamespaceRow('nonsense', NS), undefined);
}

// —— 10. 纯函数单元：pickLiveSettings ——
{
  assert.deepEqual(pickLiveSettings(null), {}, 'value 为 null 应返回空覆盖');
  assert.deepEqual(pickLiveSettings([]), {}, '数组不是设置行');
  assert.deepEqual(pickLiveSettings({ _ops: 'x', _push: 'y' }), {}, '只有传输载体 → 零覆盖');
  assert.deepEqual(pickLiveSettings({ inlineEnabled: false }), { inlineEnabled: false });
  // 空串 provider/model 是「继承」语义，属合法值，必须留在覆盖值里。
  assert.deepEqual(pickLiveSettings({ provider: '', model: '' }), { provider: '', model: '' });
}

// —— 11. 路由对语义：覆盖 / 继承 / **实时清空**（迁移后才成立）——
{
  // 实时值给了成对路由 → 覆盖 boot。
  const h = makeHost({ describeValue: () => [row({ ...makeBoot(), provider: 'deepseek', model: 'chat' })] });
  assert.equal(h.effective().provider, 'deepseek');
  assert.equal(h.effective().model, 'chat');
  // 实时值缺路由对（老代次没渲染 / describe 不可用）→ 回落 boot 的路由对。
  const h2 = makeHost({ boot: makeBoot({ provider: 'bootp', model: 'bootm' }), describeValue: () => [row({ inlineEnabled: false })] });
  assert.equal(h2.effective().provider, 'bootp', 'row 未给路由对时回落 boot 路由');
  assert.equal(h2.effective().inlineEnabled, false);
  // 用户在设置页**清空** provider/model：实时行给的是空串（= 继承主请求路由），
  // 不得被 boot 快照里的旧路由复活——那正是 #19 那一类「改了不生效」。
  const h3 = makeHost({
    boot: makeBoot({ provider: 'bootp', model: 'bootm' }),
    describeValue: () => [row({ ...makeBoot(), provider: '', model: '' })],
  });
  assert.equal(h3.effective().provider, '', '清空路由对必须实时生效（空串 = 继承会话路由）');
  assert.equal(h3.effective().model, '');
  // effectiveConfig 自身的既有语义（默认层 / 覆盖层）也直接测一遍，防回归。
  const base = makeBoot({ provider: 'p0', model: 'm0' });
  assert.deepEqual(
    { p: effectiveConfig(base, {}).provider, q: effectiveConfig(base, { provider: 'p1', model: 'm1' }).provider },
    { p: 'p0', q: 'p1' },
    'effectiveConfig：第一入参 = 默认层，第二入参 = 覆盖层',
  );
}

// —— 12. host 接线静态守卫：不再重读冻结快照 ——
{
  const raw = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  // 只查**代码**：注释里出现旧写法是文档（解释修了什么），不该被当成回归。
  const host = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/liveSettings\s*=\s*flattenConfig\(resolved\)/.test(host),
    '#19 遗留：liveSettings 不得再被赋成 flattenConfig(resolved) 冻结快照');
  assert.ok(!/effectiveConfig\(flattenConfig\(resolved\)/.test(host),
    '#19 遗留：effective() 的默认层不得每次重新拍平冻结快照');
  assert.equal((host.match(/flattenConfig\(resolved\)/g) ?? []).length, 1,
    'flattenConfig(resolved) 只允许出现一次（bootSettings 默认层）');
  assert.match(host, /liveSettings\.invalidate\(\)/, '事件入口必须标脏实时视图');
  assert.match(host, /hotness\.snapshot\(historySnapshotCap\(\)\)/, '热度快照上限改读实时视图');
  assert.ok(!/liveSettings\.historyMaxEntries/.test(host), '不得再直接读 liveSettings 的冻结字段');
  assert.match(host, /merge: mergeLiveConfig/, 'host 必须用实时合并策略（路由对可被实时清空）');
  assert.ok(!/let liveSettings\s*[=:]/.test(host), '实时视图不应再是可重新赋值的 let 快照');
}

console.log('✅ live-settings 实时读值冒烟全部通过（#19 遗留段）');
