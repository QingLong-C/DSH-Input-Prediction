#!/usr/bin/env node
/**
 * scripts/gitignore-check.mjs 与 scripts/artifact-freshness.mjs 的冒烟测试
 * （Gitea issue #20：把「静默丢文件」变成可判 red 的断言）。
 *
 * 覆盖的不只是「工具能跑」，还包括**回归预言**：issue #20 里丢掉过 `src/inline.ts`
 * 的那条规则（`src/` 被 ignore 但 `src/inline.ts` 已跟踪）必须被 fatal 判红；
 * 「宿主加载的不是我正在改的副本」也必须被抓出来。
 *
 * 用法：node scripts/dev-loop-smoke.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, entryPaths, findIgnoredButTracked } from './gitignore-check.mjs';
import { inspect, newestFile } from './artifact-freshness.mjs';

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

/**
 * 建一个一次性 git 仓库。
 * @param {string[]} [gitignore]
 * @returns {string}
 */
function repo(gitignore = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ignore-'));
  const g = (/** @type {string[]} */ args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['config', 'advice.detachedHead', 'false']);
  if (gitignore.length > 0) writeFileSync(path.join(dir, '.gitignore'), `${gitignore.join('\n')}\n`);
  return dir;
}

/**
 * 往仓库里写文件并按需跟踪。
 * @param {string} dir
 * @param {string} rel
 * @param {string} content
 * @param {boolean} forceAdd
 */
function add(dir, rel, content, forceAdd = false) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  const g = (/** @type {string[]} */ args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g(['add', ...(forceAdd ? ['-f'] : []), rel]);
}

const PKG = JSON.stringify({ name: 'dsh-fixture', version: '1.0.0', main: './lib/index.js', files: ['lib'] });

// ── 1. 干净仓库：不该有任何 fatal ───────────────────────────────────────────────
run('干净仓库（lib 已跟踪、无覆盖规则）通过', () => {
  const dir = repo(['node_modules/']);
  try {
    add(dir, 'package.json', PKG);
    add(dir, 'lib/index.js', 'export const a = 1;\n');
    add(dir, 'src/index.ts', 'export const a = 1;\n');
    const r = check(dir);
    assert.equal(r.ok, true, `意外 fatal: ${JSON.stringify(r.findings)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. #20 的回归预言：src/ 被 ignore 但 src/inline.ts 已跟踪 ────────────────────
run('规则覆盖到已跟踪目录 → fatal（这正是丢掉 inline.ts 的那种状态）', () => {
  const dir = repo(['src/']);
  try {
    add(dir, 'package.json', PKG);
    add(dir, 'src/index.ts', 'x\n', true); // 规则后加，只能 -f 进来
    mkdirSync(path.join(dir, 'lib'), { recursive: true });
    writeFileSync(path.join(dir, 'lib', 'index.js'), 'x\n');
    execFileSync('git', ['-C', dir, 'add', '-f', 'lib/index.js'], { stdio: 'pipe' });
    const r = check(dir);
    assert.equal(r.ok, false, '应判 fatal');
    const f = r.findings.find((x) => x.id === 'ignored-but-tracked');
    assert.ok(f, `缺 ignored-but-tracked: ${JSON.stringify(r.findings)}`);
    assert.ok(f.detail?.includes('src/index.ts'), `detail 应点名文件：${JSON.stringify(f.detail)}`);
    // 同一状态的直接探测版：不必跑完整 check 也能列出
    assert.deepEqual(findIgnoredButTracked(dir), ['src/index.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. 新文件在此状态下静默不落索引（断言「为什么这是事故」）──────────────────────
run('被 ignore 的目录里，新文件 git add 不进去（= 事故机制）', () => {
  const dir = repo(['src/']);
  try {
    add(dir, 'package.json', PKG);
    add(dir, 'src/index.ts', 'x\n', true);
    writeFileSync(path.join(dir, 'src/inline.ts'), 'y\n');
    let added = true;
    try {
      execFileSync('git', ['-C', dir, 'add', 'src/inline.ts'], { stdio: 'pipe' });
    } catch {
      added = false;
    }
    assert.equal(added, false, 'git add 应当拒绝被 ignore 的路径（无 -f）');
    const tracked = execFileSync('git', ['-C', dir, 'ls-files', 'src'], { encoding: 'utf8' });
    assert.ok(!tracked.includes('inline.ts'), 'inline.ts 不在索引里 → checkout 恢复不了它');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. 入口指向被 ignore 且未跟踪的产物 → fatal ──────────────────────────────────
run('main 指向被 ignore 的 lib/ 且未跟踪 → build-output-ignored', () => {
  const dir = repo(['lib/']);
  try {
    add(dir, 'package.json', JSON.stringify({ name: 'dsh-fixture', main: './lib/index.js', files: ['lib'] }));
    mkdirSync(path.join(dir, 'lib'), { recursive: true });
    writeFileSync(path.join(dir, 'lib/index.js'), 'x\n'); // 盘上有（构建产物），但未跟踪且被 ignore
    const r = check(dir);
    assert.ok(r.findings.some((x) => x.id === 'build-output-ignored'), JSON.stringify(r.findings));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. files 白名单里有不存在也未跟踪的目录 → fatal ─────────────────────────────
run('files 列了磁盘上也没有的目录 → untracked-shipped', () => {
  const dir = repo();
  try {
    add(dir, 'package.json', JSON.stringify({ name: 'dsh-fixture', main: './lib/index.js', files: ['lib', 'docs'] }));
    mkdirSync(path.join(dir, 'lib'), { recursive: true });
    writeFileSync(path.join(dir, 'lib', 'index.js'), 'x\n');
    const r = check(dir);
    assert.ok(r.findings.some((x) => x.id === 'untracked-shipped'), JSON.stringify(r.findings));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 6. entryPaths 覆盖 exports 的嵌套形状 ───────────────────────────────────────
run('entryPaths 取全 exports 的嵌套条件值', () => {
  const got = entryPaths({
    main: './lib/index.js',
    exports: { '.': { types: './lib/index.d.ts', import: './lib/index.js' }, './client': './lib/client.js' },
  });
  assert.ok(got.includes('./lib/index.d.ts') && got.includes('./lib/client.js'), JSON.stringify(got));
});

// ── 7. newestFile 跳过 node_modules/.git ────────────────────────────────────────
run('newestFile 跳过 node_modules 与 .git', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-newest-'));
  try {
    mkdirSync(path.join(dir, 'keep'), { recursive: true });
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(dir, 'keep', 'a.js'), 'a\n');
    writeFileSync(path.join(dir, 'node_modules', 'x', 'newer.js'), 'b\n');
    // 把 node_modules 里的文件时间拨到未来
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(path.join(dir, 'node_modules', 'x', 'newer.js'), future, future);
    const r = newestFile(dir);
    assert.ok(r !== null && r.file.endsWith(path.join('keep', 'a.js')), `应只看到 keep/a.js，实得 ${String(r?.file)}`);
    assert.equal(newestFile(path.join(dir, 'nope')), null, '不存在的目录应返回 null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 8. inspect 的新鲜度判定 ─────────────────────────────────────────────────────
run('src 比 lib 新 → stale=true 且提示先 build', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-fresh-'));
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'lib'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), PKG);
    writeFileSync(path.join(dir, 'lib', 'index.js'), 'old\n');
    writeFileSync(path.join(dir, 'src', 'index.ts'), 'new\n');
    const past = new Date(Date.now() - 60_000);
    utimesSync(path.join(dir, 'lib', 'index.js'), past, past);
    const r = inspect(dir);
    assert.equal(r.stale, true, 'src 更新而 lib 未更新应判 stale');
    assert.ok(r.notes.some((n) => n.includes('先 node build.mjs')), JSON.stringify(r.notes));
    // lib 重建（时间戳前进）后应转好
    utimesSync(path.join(dir, 'lib', 'index.js'), new Date(), new Date());
    assert.equal(inspect(dir).stale, false, 'lib 不比 src 旧时不应判 stale');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} dev-loop-smoke: ${cases} 组用例${process.exitCode === 1 ? '（有失败）' : '全部通过'}`);
