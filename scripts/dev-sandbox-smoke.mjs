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
import { readFileSync } from 'node:fs';
import {
  applyRewrites, declaredPorts, collect, findEntryId, parseRewrites, stripEntryVolatileKeys, stripKeyBlock,
} from './dev-sandbox.mjs';

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


// ── 通用化新增：条目作用域的易失载荷剥离 ──────────────────────────────────────
// 顺序有讲究：别人的条目**排在前面**。若实现忽略 entryId、从第一个条目就开删，
// "不碰别的条目"这条断言就会红。（反序写过一次，变异测试当场漏抓，就是这个原因。）
const TWO_ENTRIES = [
  '- id: other-plugin',
  '  name: dsh-other',
  '  config:',
  `    _ops: '{"keep":"me"}'`,                 // 别人条目里的同名键，绝不能被删
  '    _cacheTtl: 30',
  '- id: suggest-ghost',
  '  name: dsh-suggest-ghost',
  '  config:',
  '    inlineEnabled: true',
  "    _ops: '{\"ops\":[{\"op\":\"pull\"}],'",       // 键行：多行单引号标量的开头
  "      \"seq\":7}'",                               // 它的深缩进续行，必须一起删
  '    historyMinChars: 3',
].join('\n');

run('只剥本条目名下的 _ 键，别的条目一概不碰', () => {
  const { text, removed } = stripEntryVolatileKeys(TWO_ENTRIES, 'suggest-ghost');
  assert.deepEqual(removed.map((r) => r.key), ['_ops'], `应只剥本条目的 _ops，实得 ${JSON.stringify(removed)}`);
  assert.equal(removed[0].lines, 2, '键行 + 1 行深缩进续体');
  assert.ok(!text.includes('"ops"'), '本条目的载荷没删干净');
  assert.ok(text.includes(`_ops: '{"keep":"me"}'`), '⚠ 误删了 other-plugin 的同名键 —— 全局删就是这个后果');
  assert.ok(text.includes('_cacheTtl: 30'), '别人条目里非载荷的 _ 键也不该动');
});

run('本条目的非易失键（inlineEnabled / historyMinChars）全部保留', () => {
  const { text } = stripEntryVolatileKeys(TWO_ENTRIES, 'suggest-ghost');
  assert.ok(text.includes('inlineEnabled: true'), 'inlineEnabled 被误删');
  assert.ok(text.includes('historyMinChars: 3'), '紧随其后的键被续行污染或误删（当年就是这里报 ValidationError）');
});

run('条目 id 不存在时原样返回（不误删任何东西）', () => {
  const r = stripEntryVolatileKeys(TWO_ENTRIES, 'no-such-entry');
  assert.deepEqual(r.removed, []);
  assert.equal(r.text, TWO_ENTRIES);
});

run('findEntryId 按 name 反查条目 id', () => {
  assert.equal(findEntryId(TWO_ENTRIES, 'dsh-suggest-ghost'), 'suggest-ghost');
  assert.equal(findEntryId(TWO_ENTRIES, 'dsh-other'), 'other-plugin');
  assert.equal(findEntryId(TWO_ENTRIES, 'dsh-nonexistent'), null);
});

// ── 通用化新增：整行替换与端口扫描 ────────────────────────────────────────────
run('rewrite 按整行相等匹配，包含但不相等的行不误伤', () => {
  const lines = ['        port: 3081', '# port: 3081 是钉死的', 'webPort: 3081'];
  const r = applyRewrites(lines, parseRewrites(['port: 3081=port: 3983']));
  assert.deepEqual(r.hits, [1], `只该命中第一行，实得 ${JSON.stringify(r.hits)}`);
  assert.equal(r.lines[0], '        port: 3983');
  assert.equal(r.lines[1], '# port: 3081 是钉死的', '注释行被改了');
  assert.equal(r.lines[2], 'webPort: 3081', '另一个键被误改');
});

run('rewrite 零命中必须能被调用方发现（当年静默不生效 = 实例去抢 live 端口）', () => {
  const r = applyRewrites(['no: match here'], parseRewrites(['port: 3081=port: 3983']));
  assert.deepEqual(r.hits, [0]);
});

run('declaredPorts 扫出全部钉死端口（不靠硬编码端口号）', () => {
  const ports = declaredPorts(['  port: 3081', '    port: 8010', '  port: notanumber', 'listen: 3081']);
  assert.deepEqual(ports, [3081, 8010], `实得 ${JSON.stringify(ports)}`);
});

run('parseRewrites 拒绝畸形写法', () => {
  assert.throws(() => parseRewrites(['no-equals-here']), /旧行=新行/);
  assert.throws(() => parseRewrites(['=only-right']), /旧行=新行/);
});

// ── 可重复参数 ────────────────────────────────────────────────────────────────
run('collect 支持同一参数重复出现', () => {
  const list = ['--rewrite', 'a=b', '--watch', '--rewrite', 'c=d', '--grep', 'x'];
  assert.deepEqual(collect(list, 'rewrite'), ['a=b', 'c=d']);
  assert.deepEqual(collect(list, 'grep'), ['x']);
  assert.deepEqual(collect(list, 'disable'), []);
});


// ── 凭据与 pid 的真实缺口（都是实测踩出来的）──────────────────────────────────
run('脚本会复制 .credentials.yaml 进沙箱（否则 apiKeyEnv 路由全部解析不到凭据）', () => {
  const src = readFileSync(new URL('./dev-sandbox.mjs', import.meta.url), 'utf8');
  assert.ok(/\.credentials\.yaml/.test(src), '没有复制 .credentials.yaml —— 沙箱里所有 apiKeyEnv 路由都会报 no credential');
  assert.ok(/chmodSync\(credDst, 0o600\)/.test(src), '复制凭据后没把权限压回 0600');
  assert.ok(/dshHomePath\('\.credentials\.yaml'\)|dsh-credentials-local/.test(src), '没写清为什么必须复制（下一个维护者会当成多余代码删掉）');
});

run('URL 只取本次启动新增的日志行（追加日志里的旧 URL 会指向已停实例）', () => {
  const src = readFileSync(new URL('./dev-sandbox.mjs', import.meta.url), 'utf8');
  assert.ok(/logLinesBefore/.test(src), '没有记录启动前的行数');
  assert.ok(/all\.slice\(logLinesBefore\)/.test(src), '取 URL 时没有按新增行切片');
});

run('pidfile 写的是真实 node pid，而不是 spawn 的包装 pid', () => {
  const src = readFileSync(new URL('./dev-sandbox.mjs', import.meta.url), 'utf8');
  assert.ok(/DSH_HOME=\$\{HOME_\}|DSH_HOME=\$\{HOME_\}\)/.test(src) || /includes\(`DSH_HOME=\$\{HOME_\}`\)/.test(src),
    '没有按 DSH_HOME 反查真实进程');
  assert.ok(/settlePid/.test(src), '没有把真实 pid 写回 pidfile');
  assert.ok(/踩过三次/.test(src), '没记下 pkill -f 会打到调用方自己这条教训');
});

console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} dev-sandbox-smoke: ${cases} 组用例${process.exitCode === 1 ? '（有失败）' : '全部通过'}`);
