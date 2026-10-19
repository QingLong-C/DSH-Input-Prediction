#!/usr/bin/env node
/**
 * 产物新鲜度 + 部署指向体检（Gitea issue #20）。
 *
 * ## 它挡的是哪一类事故
 *
 * issue #20 的原始记录里有这么一段：「修复→重启加载→验证失败→再查」的循环里，
 * 多次是**加载了被回退的旧代码**，浪费多轮重启与验证。成因不是玄学，是两条本可机械核对的事实：
 *
 * 1. **`lib/` 比 `src/` 旧**。本仓 `lib/` 是纳入版本管理的构建产物，宿主加载的是
 *    `lib/index.js`，不是 `src/index.ts`。改完 src 没重建（或重建失败）时，工作区看起来
 *    一切正常，重启加载的仍是旧字节码——这轮验证直接作废。
 * 2. **宿主加载的 worktree 不是你正在改的那个**。部署靠
 *    `<profile>/node_modules/dsh-suggest-ghost` 这条**符号链接**指回某个工作区；
 *    一旦它指向主仓而你在别的 worktree 里改（或反过来），怎么重启都不会加载你的改动。
 *    这条在引入 worktree 之后变成高频风险：`git worktree list` 上有 5 个可用工作副本，
 *    但只有符号链接指向的那一个会进宿主。
 *
 * 两项都是「看一眼就知道」的事实，但没人看，所以做成脚本。
 *
 * ## 用法
 * `node scripts/artifact-freshness.mjs`          信息输出，恒返回 0
 * `node scripts/artifact-freshness.mjs --strict` 发现陈旧或指向不一致时返回 1
 * `node scripts/artifact-freshness.mjs --json`   机器可读
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * 递归取目录下所有文件的最新 mtime。
 * @param {string} dir
 * @param {string[]} skip 要跳过的目录名
 * @returns {{mtime: number, file: string} | null}
 */
export function newestFile(dir, skip = ['node_modules', '.git']) {
  /** @type {{mtime: number, file: string} | null} */
  let best = null;
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = /** @type {string} */ (stack.pop());
    /** @type {string[]} */
    let names;
    try {
      names = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!skip.includes(name)) stack.push(full);
        continue;
      }
      if (best === null || st.mtimeMs > best.mtime) best = { mtime: st.mtimeMs, file: full };
    }
  }
  return best;
}

/**
 * 找出宿主实际加载的插件目录：`<profile>/node_modules/<name>` 解析后的真实路径。
 * profile 目录按 `$DSH_PROFILE_DIR` → `~/.dsh/profiles/*` 的顺序探测。
 * @param {string} pkgName
 * @returns {Array<{link: string, resolved: string | null}>}
 */
export function findDeployed(pkgName) {
  /** @type {string[]} */
  const roots = [];
  const envDir = process.env.DSH_PROFILE_DIR;
  if (typeof envDir === 'string' && envDir !== '') roots.push(envDir);
  const base = path.join(os.homedir(), '.dsh', 'profiles');
  if (existsSync(base)) {
    for (const name of readdirSync(base)) roots.push(path.join(base, name));
  }
  /** @type {Array<{link: string, resolved: string | null}>} */
  const out = [];
  for (const root of roots) {
    const link = path.join(root, 'node_modules', pkgName);
    if (!existsSync(link)) continue;
    /** @type {string | null} */
    let resolved = null;
    try {
      resolved = execFileSync('readlink', ['-f', link], { encoding: 'utf8' }).trim();
    } catch {
      resolved = null;
    }
    out.push({ link, resolved });
  }
  return out;
}

/**
 * 计算体检结果。
 * @param {string} root 当前工作副本根目录
 * @returns {{root: string, pkgName: string, src: {file: string, mtime: number} | null, lib: {file: string, mtime: number} | null, stale: boolean, deployed: Array<{link: string, resolved: string | null, matchesCwd: boolean}>, notes: string[]}}
 */
export function inspect(root) {
  const notes = [];
  const pkgPath = path.join(root, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
  const pkgName = typeof pkg.name === 'string' ? pkg.name : '';
  const src = newestFile(path.join(root, 'src'));
  const lib = newestFile(path.join(root, 'lib'));

  // checkout / clone 会把 src 与 lib 的 mtime 写成「此刻」，两者相差几毫秒是常态，
  // 不是陈旧。真正的未重建至少是秒级（编辑到构建之间不可能只隔毫秒）。
  const STALE_TOLERANCE_MS = 2_000;

  let stale = false;
  if (src === null || lib === null) {
    notes.push('src/ 或 lib/ 缺失——跳过新鲜度判定');
  } else if (src.mtime - lib.mtime > STALE_TOLERANCE_MS) {
    stale = true;
    notes.push(
      `lib/ 比 src/ 旧：src 最新改动 ${new Date(src.mtime).toISOString()}（${path.relative(root, src.file)}），` +
        `lib 最新产物 ${new Date(lib.mtime).toISOString()}。宿主加载的是 lib/，` +
        `现在重启验证的是旧字节码——先 node build.mjs。`,
    );
  } else {
    notes.push('lib/ 不比 src/ 旧（时间戳判定；确认内容仍需 git diff lib/）');
  }

  const deployed = pkgName === '' ? [] : findDeployed(pkgName).map((d) => ({ ...d, matchesCwd: d.resolved === root }));
  if (deployed.length === 0) {
    notes.push('未在任何 profile 里找到本插件的部署链接（未安装，或用别的方式加载）');
  } else {
    for (const d of deployed) {
      if (d.resolved === null) notes.push(`${d.link} 存在但无法解析真实路径`);
      else if (!d.matchesCwd) {
        notes.push(
          `宿主加载的是 ${d.resolved}，**不是**你正在改的 ${root}。` +
            `在这个 worktree 里怎么改、怎么重启都不会生效（#20 的「白跑一轮」）。`,
        );
      } else notes.push(`宿主加载的正是本工作副本：${d.resolved}`);
    }
    if (deployed.some((d) => d.matchesCwd) && stale) notes.push('且该副本的 lib/ 是陈旧的——两个问题叠加');
  }
  return { root, pkgName, src, lib, stale, deployed, notes: [...new Set(notes)] };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  let root;
  try {
    root = execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('artifact-freshness: 当前目录不在 git 仓库里');
    process.exit(2);
  }
  const r = inspect(root);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`工作副本: ${r.root}`);
    for (const n of r.notes) console.log(`  · ${n}`);
    const bad = r.stale || (r.deployed.length > 0 && !r.deployed.some((d) => d.matchesCwd));
    if (!bad) console.log('✅ artifact-freshness: 产物不陈旧，且部署链接指向本副本');
    else console.log('⚠️  artifact-freshness: 见上面各条，重启前先处理');
  }
  process.exit(process.argv.includes('--strict') && (r.stale || (r.deployed.length > 0 && !r.deployed.some((d) => d.matchesCwd))) ? 1 : 0);
}
