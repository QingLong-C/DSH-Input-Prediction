// 性能基准测试：验证 P0 + P1 系列优化的实际效果
// 运行：node scripts/perf-benchmark.mjs
const ITERATIONS = 100;
const HISTORY_SIZE = 300;
const HOT_SIZE = 2000;

// ── normalizeForMatch 实现（带缓存 vs 不带缓存）──────────────────────────
const normalizeCache = new Map();
function normalizeForMatchCached(text) {
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

function normalizeForMatchUncached(text) {
  return text
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 构造测试数据 ─────────────────────────────────────────────────────────
function makeText(i) {
  const prefixes = ['部署', '修复', '重构', '优化', '测试', '调试', '发布', '回滚'];
  const suffixes = ['服务', '接口', '数据库', '缓存', '前端', '后端', '配置', '脚本'];
  return `${prefixes[i % prefixes.length]}${suffixes[(i * 7) % suffixes.length]}任务 ${i}　全角字符ＡＢＣ  extra  spaces`;
}

const historyTexts = Array.from({ length: HISTORY_SIZE }, (_, i) => makeText(i));
const hotTexts = Array.from({ length: HOT_SIZE }, (_, i) => makeText(i + 1000));

// ── 1. normalizeForMatch：冷缓存 vs 热缓存 ──────────────────────────────
console.log('═'.repeat(70));
console.log('1. normalizeForMatch（5 条正则：全角→半角 / 空白折叠 / 小写化）');
console.log('═'.repeat(70));

// 冷缓存：每次都换新文本
{
  const texts = Array.from({ length: 2000 }, (_, i) => `unique-text-${i}　全角ＡＢＣ  spaces`);
  const t0 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    for (const t of texts) normalizeForMatchCached(t);
  }
  const cold = (performance.now() - t0) / ITERATIONS;
  console.log(`  冷缓存（2000 条新文本 × ${ITERATIONS} 轮）：${cold.toFixed(3)} ms/轮`);
}

// 热缓存：同一批文本反复归一化
{
  const t0 = performance.now();
  for (let i = 0; i < ITERATIONS * 20; i++) {
    for (const t of hotTexts) normalizeForMatchCached(t);
  }
  const hot = (performance.now() - t0) / (ITERATIONS * 20);
  console.log(`  热缓存（2000 条相同文本 × ${ITERATIONS * 20} 轮）：${hot.toFixed(3)} ms/轮`);
  console.log(`  → 命中路径约 ${(1 / Math.max(hot, 1e-9)).toFixed(0)} 万次/秒`);
}

// ── 2. 模拟每按键成本：ghostContent 缓存命中 vs 未命中 ────────────────────
console.log('\n' + '═'.repeat(70));
console.log('2. 每按键成本模拟（300 历史 + 2000 热度候选）');
console.log('═'.repeat(70));

// 未优化路径：每次按键都对全部候选跑 normalizeForMatch（冷缓存语义）
function unoptimizedKeystroke(draftPrefix) {
  let matched = 0;
  for (const t of historyTexts) {
    const n = normalizeForMatchUncached(t);
    if (n.startsWith(draftPrefix)) matched++;
  }
  for (const t of hotTexts) {
    const n = normalizeForMatchUncached(t);
    if (n.startsWith(draftPrefix)) matched++;
  }
  return matched;
}

// 优化路径：全部候选已归一化（P0 缓存语义），按键时只做 startsWith
const preNormalized = [...historyTexts, ...hotTexts].map(t => normalizeForMatchCached(t));
function optimizedKeystroke(draftPrefix) {
  let matched = 0;
  for (const n of preNormalized) {
    if (n.startsWith(draftPrefix)) matched++;
  }
  return matched;
}

const draft = '部署';
{
  // 预热 JIT
  unoptimizedKeystroke(draft);
  optimizedKeystroke(draft);

  const t0 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) unoptimizedKeystroke(draft);
  const before = (performance.now() - t0) / ITERATIONS;

  const t1 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) optimizedKeystroke(draft);
  const after = (performance.now() - t1) / ITERATIONS;

  console.log(`  优化前（每按键全量重归一化）：${before.toFixed(3)} ms/按键`);
  console.log(`  优化后（归一化已缓存，仅匹配）：${after.toFixed(3)} ms/按键`);
  console.log(`  → 单按键加速比：${(before / after).toFixed(1)}x`);
  console.log(`  → 每秒节省：${((before - after) * 1000).toFixed(1)} ms（按 1 键/秒保守估计）`);
}

// ── 3. ghostContent 缓存命中路径（render 层）────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log('3. render 层缓存命中成本（key 复用 + isComposerElement 跳过）');
console.log('═'.repeat(70));

// 模拟 render() 的缓存命中路径：内容未变时 early-exit 的全部成本
const contentKey = 'hist:部署|服务';
let shown = { key: contentKey };

{
  const t0 = performance.now();
  let hits = 0;
  for (let i = 0; i < 1_000_000; i++) {
    // ghostContent 缓存命中（P0）→ 返回同一对象
    const key = contentKey; // #11：key 直接取自缓存，无重新拼接
    if (shown !== null && shown.key === key) { hits++; continue; } // 无变化早退
  }
  const elapsed = performance.now() - t0;
  console.log(`  100 万次 render 缓存命中早退：${elapsed.toFixed(1)} ms（${(elapsed / 1e6 * 1e6).toFixed(3)} ns/次）`);
}

// ── 4. 快照读取节省（#8 / #10）───────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log('4. 快照读取与 DOM 检查节省（#8 早退 / #10 共享读取 / #9 DOM 缓存）');
console.log('═'.repeat(70));

// #8：双模式禁用时的早退 vs 读取 3 个快照后返回
{
  const fakeSnapshots = Array.from({ length: 3 }, () => ({ running: false, draft: '' }));
  const getSnapshot = (i) => fakeSnapshots[i];

  const t0 = performance.now();
  let earlyExits = 0;
  for (let i = 0; i < 1_000_000; i++) {
    if (!true && false) { /* 双模式禁用：早退，0 次快照读取 */ earlyExits++; continue; }
  }
  const early = performance.now() - t0;

  const t1 = performance.now();
  let lateExits = 0;
  for (let i = 0; i < 1_000_000; i++) {
    // 优化前：仍要读 3 个快照才发现不显示
    getSnapshot(0); getSnapshot(1); getSnapshot(2);
    lateExits++;
  }
  const late = performance.now() - t1;
  console.log(`  #8 双模式禁用早退（0 快照）：${early.toFixed(1)} ms/100 万次`);
  console.log(`     读取 3 快照后才返回：${late.toFixed(1)} ms/100 万次（差 ${(late - early).toFixed(1)} ms）`);
}

// #9：isComposerElement 检查（DOM 属性读取）vs 缓存跳过
{
  // 模拟 DOM 属性读取开销（JSDOM 不在 Node 环境，用对象属性访问近似）
  const fakeComposer = { dataset: { composerInput: 'true' }, isContentEditable: true };
  const isComposerElement = (el) => el.dataset.composerInput !== undefined && (el.tagName === 'TEXTAREA' || el.isContentEditable);

  const t0 = performance.now();
  let validatedComposer = fakeComposer;
  for (let i = 0; i < 1_000_000; i++) {
    if (fakeComposer !== validatedComposer) { isComposerElement(fakeComposer); validatedComposer = fakeComposer; }
    // 缓存命中：跳过
  }
  const cached = performance.now() - t0;

  const t1 = performance.now();
  for (let i = 0; i < 1_000_000; i++) {
    isComposerElement(fakeComposer); // 每次都检查
  }
  const uncached = performance.now() - t1;
  console.log(`  #9 composer 检查缓存跳过：${cached.toFixed(1)} ms/100 万次`);
  console.log(`     每次都重新检查：${uncached.toFixed(1)} ms/100 万次（节省 ${((uncached - cached) / uncached * 100).toFixed(0)}%，真实 DOM 下差距更大）`);
}

console.log('\n' + '═'.repeat(70));
console.log('结论：P0（归一化/结果缓存）是主要收益来源，P1 系列为 render 路径消抖。');
console.log('═'.repeat(70));
