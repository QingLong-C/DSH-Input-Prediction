// 热度持久化端到端 smoke：真实 storage 栈（dsh-storage hub + json backend +
// storage-domain form）在临时目录跑通 记账 → flush 落盘 → 关闭 → 重新装配恢复。
// 注意：测的是编译产物（src 内部用 .js 推导导入，strip-types 无法直接加载），
// 先 pnpm build 再跑。用法：node scripts/hotness-persist-e2e.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Storage } from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { setupHotnessPersistence } from '../lib/hotness-store.js';

const root = new Context();
if (root.logger === undefined) root.logger = console;
const mediumRoot = mkdtempSync(join(tmpdir(), 'dsh-hotness-e2e-'));

// —— 最小宿主组合：storage hub → json backend → domain form（与真实 host 同构）——
new Storage(root); // Service 构造时自动以 "storage" 注册到 context
storageJson.apply(root, { root: mediumRoot });
await storageDomain.apply(root, { backend: 'json' });
const mediumFile = join(mediumRoot, 'suggest_ghost_hotness.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// —— 第一轮「进程」：恢复（空表）→ 记账 → flush 落盘 ——
{
  const { hotness, persistence } = setupHotnessPersistence(root);
  for (let i = 0; !persistence.ready && i < 100; i += 1) await sleep(20);
  assert.equal(persistence.ready, true, 'storageDomain 未在预期时间内就绪');
  hotness.recordUserText('部署服务', 1, 's1');
  hotness.recordUserText('部署服务', 2, 's2'); // 同会话相邻重复不计
  hotness.recordUserText('部署服务', 3, 's2'); // 跨会话再出现 → count 2
  hotness.recordUserText('查日志', 3, 's1');
  await persistence.flush();
  const medium = JSON.parse(readFileSync(mediumFile, 'utf8'));
  assert.equal(medium.unit.name, 'suggest_ghost_hotness');
  assert.equal(medium.unit.version, 1);
  assert.deepEqual(medium.tables.entries, {
    部署服务: { text: '部署服务', count: 2 },
    查日志: { text: '查日志', count: 1 },
  });
  console.log('✅ e2e：第一轮落盘内容正确', JSON.stringify(medium.tables.entries));
  await persistence.close();
}

// —— 第二轮「进程」：重新装配 → 频次恢复 → 恢复条目再出现合并 → 再落盘 ——
{
  const { hotness, persistence } = setupHotnessPersistence(root);
  for (let i = 0; !persistence.ready && i < 100; i += 1) await sleep(20);
  assert.equal(persistence.ready, true);
  assert.deepEqual(hotness.snapshot(10).map(({ text, count }) => ({ text, count })), [
    { text: '部署服务', count: 2 },
    { text: '查日志', count: 1 },
  ]);
  // 恢复条目在新会话里再次出现 → live + 持久频次合并，lastSeq 推进到 live 轨道。
  hotness.recordUserText('部署服务', 5, 's3');
  assert.deepEqual(hotness.snapshot(10), [
    { text: '部署服务', count: 3 },
    { text: '查日志', count: 1 },
  ]);
  await persistence.flush();
  const medium = JSON.parse(readFileSync(mediumFile, 'utf8'));
  assert.equal(medium.tables.entries['部署服务'].count, 3);
  console.log('✅ e2e：重启后频次恢复 + 合并 + 再落盘全部正确');
  await persistence.close();
}

// —— 第三轮「进程」：管理面板 ops（固定/删除/新增/清空）经 applyOps → 持久层往返 ——
{
  const { hotness, persistence } = setupHotnessPersistence(root);
  for (let i = 0; !persistence.ready && i < 100; i += 1) await sleep(20);
  // 固定「查日志」+ 删除「部署服务」+ 新增手工候选（默认固定）。
  assert.equal(persistence.applyOps([
    { op: 'pin', text: '查日志', pinned: true },
    { op: 'delete', text: '部署服务' },
    { op: 'add', text: '手工候选', pinned: true },
  ]), 3);
  // 两条都固定（组内次序属实现细节，不判定）；pinned 恒置顶于未固定者。
  assert.deepEqual(
    hotness.snapshot(10).map((e) => ({ t: e.text, c: e.count, p: e.pinned === true })).sort((a, b) => a.t.localeCompare(b.t)),
    [
      { t: '手工候选', c: 1, p: true },
      { t: '查日志', c: 1, p: true },
    ],
  );
  await persistence.flush();
  let medium = JSON.parse(readFileSync(mediumFile, 'utf8'));
  assert.equal(medium.tables.entries['查日志'].pinned, true, '固定标记应落盘');
  assert.equal(medium.tables.entries['手工候选'].pinned, true);
  assert.equal(medium.tables.entries['部署服务'], undefined, '删除应同步到持久层');
  await persistence.close();

  // 重启后恢复：固定条目回到置顶位（组内次序属实现细节，只判集合与标记）。
  const second = setupHotnessPersistence(root);
  for (let i = 0; !second.persistence.ready && i < 100; i += 1) await sleep(20);
  assert.deepEqual(second.hotness.snapshot(10).map((e) => e.text).sort(), ['手工候选', '查日志']);
  assert.deepEqual(second.hotness.snapshot(10).map((e) => e.pinned === true), [true, true]);
  // 非法 ops 载荷解析：畸形 JSON / 未知 op / 空载荷都安全返回空数组。
  const { parseHotnessOps } = await import('../lib/hotness-store.js');
  assert.deepEqual(parseHotnessOps('not-json'), []);
  assert.deepEqual(parseHotnessOps('null'), []);
  assert.deepEqual(parseHotnessOps(JSON.stringify({ rev: 1, ops: [{ op: 'deploy' }] })), []);
  assert.equal(second.persistence.applyOps([{ op: 'pin', text: '不存在的条目', pinned: true }]), 0);
  // 清空全部 → 持久层同步删除。
  assert.equal(second.persistence.applyOps([{ op: 'clear' }]), 2);
  await second.persistence.flush();
  medium = JSON.parse(readFileSync(mediumFile, 'utf8'));
  assert.deepEqual(medium.tables.entries, {});
  await second.persistence.close();
  console.log('✅ e2e：管理 ops（固定/删除/新增/清空）+ 重启恢复 + 载荷防御全部正确');
}

console.log('✅ hotness persist e2e：真实 storage 栈端到端通过，介质在', mediumFile);
