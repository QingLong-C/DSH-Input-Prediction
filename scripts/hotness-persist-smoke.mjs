// 热度表持久化语义 smoke：变更回调 / 恢复合并 / 淘汰同步 / 容量上限。
// 纯内存断言，不依赖宿主 storage 服务。用法：node --experimental-strip-types scripts/hotness-persist-smoke.mjs
import assert from 'node:assert/strict';
import { HOT_TABLE_MAX_ENTRIES, HotnessTable } from '../src/hotness.ts';

/** 造一个带变更日志的热表。 */
function makeTable() {
  const changes = [];
  const hotness = new HotnessTable((text, entry) => changes.push([text, entry && { ...entry }]));
  return { hotness, changes };
}

// —— 1. 记账回调：新条目与频次更新都上报最新记账值 ——
{
  const { hotness, changes } = makeTable();
  hotness.recordUserText('部署', 10, 's1');
  hotness.recordUserText('部署', 20, 's1'); // 同会话相邻重复：不计频次、不上报
  hotness.recordUserText('部署', 30, 's2'); // 跨会话：频次 +1、lastSeq 推进
  assert.equal(hotness.size, 1);
  assert.deepEqual(changes, [
    ['部署', { count: 1, lastSeq: 10, pinned: false }],
    ['部署', { count: 2, lastSeq: 30, pinned: false }],
  ]);
  assert.deepEqual(hotness.snapshot(10), [{ text: '部署', count: 2 }]);
}

// —— 1b. 固定语义：evict 豁免 + snapshot 恒置顶 ——
{
  const { hotness, changes } = makeTable();
  for (let i = 0; i < HOT_TABLE_MAX_ENTRIES; i += 1) hotness.recordUserText(`词-${i}`, i + 1, 's1');
  // 固定 msg-5（lastSeq=6，比新条目旧）；继续灌入 3 条新词，淘汰跳过固定者。
  assert.equal(hotness.setPinned('词-5', true), true);
  assert.equal(hotness.setPinned('词-5', true), false); // 幂等：无变化不上报
  for (let i = 0; i < 3; i += 1) hotness.recordUserText(`新词-${i}`, 10_000 + i, 's1');
  assert.equal(hotness.size, HOT_TABLE_MAX_ENTRIES, '每条新词挤掉一名最旧者，固定者豁免');
  const deleted = changes.filter(([, e]) => e === null).map(([t]) => t);
  assert.deepEqual(deleted, ['词-0', '词-1', '词-2']); // 3 条新词 → 3 次淘汰，跳过固定的 词-5
  assert.equal(hotness.snapshot(HOT_TABLE_MAX_ENTRIES).some((e) => e.text === '词-5'), true, '固定条目应存活');
  // snapshot：固定恒置顶（其余按频次/最近性排序）；pinned 仅 true 时携带。
  const snap = hotness.snapshot(HOT_TABLE_MAX_ENTRIES);
  assert.equal(snap[0].text, '词-5');
  assert.equal(snap[0].pinned, true);
  assert.equal(snap[1].pinned, undefined);
}

// —— 1c. 管理 API：add / delete / clearAll ——
{
  const { hotness, changes } = makeTable();
  assert.equal(hotness.addEntry('手工候选', true), true); // 新增（默认固定）
  assert.equal(hotness.addEntry('手工候选', true), false); // 幂等：已存在且已固定
  assert.equal(hotness.addEntry('手工候选'), false); // 已固定时不因 add 而取消固定
  assert.deepEqual(hotness.snapshot(10), [{ text: '手工候选', count: 1, pinned: true }]);
  assert.equal(hotness.deleteEntry('手工候选'), true);
  assert.equal(hotness.deleteEntry('手工候选'), false); // 幂等
  assert.equal(hotness.size, 0);
  assert.equal(hotness.clearAll(), 0); // 空表清空为 no-op
  hotness.addEntry('a', true);
  hotness.addEntry('b');
  assert.equal(hotness.clearAll(), 2);
  assert.equal(hotness.size, 0);
  const deleted = changes.filter(([, e]) => e === null).map(([t]) => t);
  assert.deepEqual(deleted, ['手工候选', 'a', 'b']); // 删除/清空都上报 null → 持久层同步
}

// —— 1d. 恢复合并的固定标记：任一侧固定即保持固定 ——
{
  const { hotness, changes } = makeTable();
  hotness.recordUserText('合并固定', 3, 's1'); // live 未固定
  hotness.restoreEntry('合并固定', 42, true); // 持久层固定 → 合并后仍固定
  assert.equal(hotness.snapshot(10)[0].pinned, true);
  hotness.recordUserText('只活侧', 1, 's1');
  hotness.restoreEntry('只活侧', 5, false); // 两侧都未固定 → 保持未固定
  assert.deepEqual(hotness.snapshot(10).map((e) => e.pinned === true), [true, false]);
  assert.equal(changes[changes.length - 1][1].pinned, false);
}

// —— 2. 恢复插入：lastSeq 取 -∞，真实再出现时被 live seq 推进 ——
{
  const { hotness, changes } = makeTable();
  hotness.restoreEntry('旧短语', 7);
  assert.deepEqual(hotness.snapshot(10), [{ text: '旧短语', count: 7 }]);
  assert.equal(changes.length, 0); // 恢复插入不上报（数据来自持久层）
  hotness.recordUserText('旧短语', 5, 's1'); // live seq 5 > -∞ → lastSeq 推进 + 频次 +1
  assert.deepEqual(hotness.snapshot(10), [{ text: '旧短语', count: 8 }]);
  assert.deepEqual(changes, [['旧短语', { count: 8, lastSeq: 5, pinned: false }]]);
}

// —— 3. 恢复合并：open 窗口期 live 事件先到 → 频次相加、lastSeq 保持 live 值 ——
{
  const { hotness, changes } = makeTable();
  hotness.recordUserText('重启期间打过的话', 3, 's1');
  hotness.restoreEntry('重启期间打过的话', 42);
  assert.deepEqual(hotness.snapshot(10), [{ text: '重启期间打过的话', count: 43 }]);
  assert.deepEqual(changes, [
    ['重启期间打过的话', { count: 1, lastSeq: 3, pinned: false }], // live 记账（open 窗口期先到）
    ['重启期间打过的话', { count: 43, lastSeq: 3, pinned: false }], // 恢复合并（live + 持久）
  ]);
}

// —— 4. 淘汰同步：超上限时淘汰最久未出现者，并上报 null（持久层删记录）——
{
  const { hotness, changes } = makeTable();
  for (let i = 0; i < HOT_TABLE_MAX_ENTRIES; i += 1) hotness.recordUserText(`msg-${i}`, i + 1, 's1');
  assert.equal(hotness.size, HOT_TABLE_MAX_ENTRIES);
  // 恢复条目 lastSeq=-∞，淘汰序在最前：表已满时插入恢复条目会立即挤掉一名
  // 最近性最差者（这里就是它自己），随后新来的 live 条目再挤掉最老的 msg-0。
  hotness.restoreEntry('最老的恢复条目', 1);
  hotness.recordUserText('新来的', 99_999, 's1');
  assert.equal(hotness.size, HOT_TABLE_MAX_ENTRIES);
  const deleted = changes.filter(([, e]) => e === null).map(([t]) => t);
  assert.deepEqual(deleted, ['最老的恢复条目', 'msg-0']);
  assert.equal(hotness.snapshot(HOT_TABLE_MAX_ENTRIES).some((e) => e.text === '新来的'), true);
}

// —— 5. 恢复防御：空白 / 非法频次 / 超长文本直接跳过 ——
{
  const { hotness, changes } = makeTable();
  hotness.restoreEntry('  ', 1);
  hotness.restoreEntry('零频次', 0);
  hotness.restoreEntry('负频次', -3);
  hotness.restoreEntry('x'.repeat(2001), 1);
  hotness.restoreEntry('正常', 2);
  assert.equal(hotness.size, 1);
  assert.equal(changes.length, 0);
  assert.deepEqual(hotness.snapshot(10), [{ text: '正常', count: 2 }]);
}

// —— 6. 无回调构造（纯内存用法）不炸 ——
{
  const hotness = new HotnessTable();
  hotness.recordUserText('无回调', 1, 's1');
  hotness.restoreEntry('恢复', 3);
  hotness.recordUserText('恢复', 2, 's1');
  assert.deepEqual(hotness.snapshot(10), [
    { text: '恢复', count: 4 },
    { text: '无回调', count: 1 },
  ]);
}

console.log('✅ hotness persist smoke：全部断言通过（记账/固定/管理API/恢复合并/淘汰同步/防御）');
