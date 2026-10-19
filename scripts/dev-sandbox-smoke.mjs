#!/usr/bin/env node
/**
 * dev-sandbox 的纯函数冒烟（Gitea issue #20 / #22 的测试台工具）。
 *
 * 只测 `stripKeyBlock`：它是脚本里唯一会**改写 profile** 的部件，写坏了整个隔离实例
 * 就起不来。实测踩过的形状：`_push` 的值是跨 16 行的单引号标量（建议正文自带换行），
 * 按行 `grep -v` 会把它的续体留给紧随的键，合成期报
 * `historyMinChars expected number but got 3 A","truncated":false,…` → 条目不挂载。
 *
 * 语义（与实现、与真实 profile 上的观测一致）：**删掉的行数 = 键行 + 比它更深缩进的续行**。
 * 单行的 `_ops` 删 1 行；跨 16 行的 `_push` 删 16 行。
 *
 * 导入 dev-sandbox.mjs 不启动实例（主流程被 invokedDirectly 收住），这条也在此断言。
 * 用法：node scripts/dev-sandbox-smoke.mjs
 */
import assert from 'node:assert/strict';
import { stripKeyBlock } from './dev-sandbox.mjs';

let cases = 0;
const run = (name, fn) => {
  cases += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n      ${String(error).split('\n').slice(0, 3).join('\n      ')}`);
    process.exitCode = 1;
  }
};

// 复刻真实形状：单引号标量自带换行，**每一行续体都比键更深**，紧随其后是同级兄弟键
// 续行是 6 空格缩进、键是 4 空格 —— 与真实 cordis.patch.yml 逐字符核对过（YAML 单引号标量
// 的续体必须比键更深，按行删就会把这些深缩进行留给下一个键）
const FIXTURE = [
  "    _push: '{\"rev\":7,\"suggestion\":{\"turn\":3,\"text\":\"第一行",
  "      第二行",
  "      第三行\",\"acceptKey\":\"Tab\"},\"total\":1}'",
  '    historyMinChars: 3',
  '    inlineEnabled: false',
].join('\n');

run('多行块整体剥除（键行 + 更深续行），不留残体污染下一个键', () => {
  const { text, removed } = stripKeyBlock(FIXTURE, '_push');
  assert.equal(removed, 3, `键行 + 2 行更深缩进 = 3，实得 ${removed}`);
  assert.ok(!text.includes('第二行') && !text.includes('第三行'), '续体残留 → 下一键的值会被污染成半截 JSON');
  assert.match(text, /^ {4}historyMinChars: 3$/m, '紧随其后的键必须完好');
  assert.match(text, /inlineEnabled: false/, '更后面的键不能受影响');
});

run('单行条目（_ops 形态）只删它自己那一行', () => {
  const src = `    _ops: '{"rev":1,"ops":[]}'\n    historyMinChars: 3\n`;
  const { text, removed } = stripKeyBlock(src, '_ops');
  assert.equal(removed, 1, `无更深续行时只删键行，实得 ${removed}`);
  assert.ok(text.includes('historyMinChars: 3'), '相邻键不能连带删掉');
});

run('同名键多次出现全部剥除，缩进相同的兄弟键不受影响', () => {
  const src = '_a: 1\n  x\n_b: 2\n_a: 3\n  y\n_c: 4\n';
  const { text, removed } = stripKeyBlock(src, '_a');
  assert.equal(text.includes('_a'), false, '两处 _a 都该删掉');
  assert.ok(text.includes('_b: 2') && text.includes('_c: 4'), `兄弟键被误删：${JSON.stringify(text)}`);
  assert.equal(removed, 2, `最后一块（_a + 1 行续体）的行数，实得 ${removed}`);
});

run('不存在的键原样返回；重复调用不再变形（幂等）', () => {
  assert.deepEqual(stripKeyBlock('', 'x'), { text: '', removed: 0 });
  const src = 'a: 1\nb: 2\n';
  const once = stripKeyBlock(src, 'a');
  assert.equal(once.text, 'b: 2\n', `首删：${JSON.stringify(once.text)}`);
  assert.equal(once.removed, 1);
  const twice = stripKeyBlock(once.text, 'a');
  assert.deepEqual(twice, { text: 'b: 2\n', removed: 0 }, '再删同一个键应无操作');
  assert.deepEqual(stripKeyBlock(src, 'nope'), { text: src, removed: 0 }, '不存在的键必须原样返回');
});

run('导入 dev-sandbox 不产生副作用（只导出纯函数）', () => {
  // 走到这里说明顶层主流程没被执行（否则本进程会去建沙箱、起实例）
  assert.equal(typeof stripKeyBlock, 'function');
});

console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} dev-sandbox-smoke: ${cases} 组用例${process.exitCode === 1 ? '（有失败）' : '全部通过'}`);
