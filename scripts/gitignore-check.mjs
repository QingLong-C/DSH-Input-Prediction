#!/usr/bin/env node
/**
 * 构建产物与 .gitignore 的一致性体检（Gitea issue #20）。
 *
 * ## 它挡的是哪一类事故
 *
 * 本仓 `lib/` 是**纳入版本管理**的构建产物（宿主直接 `import('dsh-suggest-ghost')`
 * 加载它，见 `docs/dev-workflow.md`）。这类「产物入库」的仓库有一个静默失效面：
 * 只要有一条 gitignore 规则盖住了一个**已跟踪目录**，此后新建的文件就不进索引——
 * 构建能跑（文件在盘上），切分支/`git clean -fdx`/`git stash -u` 都会把它抹掉，
 * 而 `git checkout` 再也恢复不出来，因为 git 从来不知道它存在。
 *
 * 本插件已经为此付过代价：`src/inline.ts` 从工作区消失、只能从历史提交
 * `20a470c` 找回（issue #20 记录的第 2 起）。当时没有任何机械信号。
 *
 * ## 四条判据
 *
 * | id | 含义 | 级别 |
 * |---|---|---|
 * | `ignored-but-tracked` | 文件同时在索引里与被 ignore → 该目录的后续新增会静默丢 | fatal |
 * | `build-output-ignored` | `package.json` 的 `main`/`types`/`exports` 指向被 ignore 且未被跟踪的位置 → 打包时才发现缺文件 | fatal |
 * | `untracked-shipped` | `files` 里列了、但既未跟踪也不由构建生成 → 发出去的包缺内容 | fatal |
 * | `ignored-dirs` | 当前被 ignore 的顶层目录（信息，供人核对是否有意为之） | info |
 *
 * 用法：`node scripts/gitignore-check.mjs [--json]`
 * 退出码：0 = 通过（info 项不算失败）；1 = 有 fatal；2 = 环境不满足（不在 git 仓库里）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * 把 git 的输出按 NUL 切（文件名可能含空格/换行）。
 * @param {string} out
 * @returns {string[]}
 */
function lines(out) {
  return out.split('\0').map((s) => s.replace(/\n$/, '')).filter((s) => s !== '');
}

/**
 * 找出「已被 git 跟踪、但又被 ignore 规则覆盖」的文件。
 *
 * 判据必须用 `git check-ignore`：`git ls-files -c` 会把**已跟踪**文件照常列出，
 * 无视 ignore 规则——所以「`ls-files -c` 减去 `-co --exclude-standard`」是错的
 * （后者也包含已跟踪项），会一个都抓不到。正确做法是把全量跟踪清单喂给
 * `check-ignore -z --stdin`，它只回吐命中 ignore 规则的那些。
 *
 * 这类状态只可能来自「规则后加」或 `git add -f` 强加，两种都意味着该目录里的
 * **新**文件从此静默不落索引。
 * @param {string} root
 * @returns {string[]}
 */
export function findIgnoredButTracked(root) {
  const all = lines(git(root, ['ls-files', '-z', '--cached']));
  if (all.length === 0) return [];
  // check-ignore 在「一条都没命中」时以 1 退出——那是正常结果，不是错误。
  let out = '';
  try {
    out = execFileSync('git', ['-C', root, 'check-ignore', '--no-index', '-z', '--stdin'], {
      input: `${all.join('\0')}\0`,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const e = /** @type {{status?: number, stdout?: string}} */ (error);
    if (e.status === 1 && typeof e.stdout === 'string') out = e.stdout;
    else out = '';
  }
  return lines(out);
}

/**
 * 从 package.json 的入口声明里抽出所有相对路径（`main`/`types` + `exports` 的值）。
 * @param {Record<string, unknown>} pkg
 * @returns {string[]}
 */
export function entryPaths(pkg) {
  /** @type {string[]} */
  const out = [];
  for (const key of ['main', 'types', 'bin']) {
    const v = pkg[key];
    if (typeof v === 'string') out.push(v);
    else if (v !== null && typeof v === 'object') out.push(...Object.values(v).filter((s) => typeof s === 'string'));
  }
  const walk = (node) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(pkg.exports);
  return out.filter((p) => p.startsWith('.') || !p.includes(':'));
}

/**
 * 跑一次 git 命令并返回 stdout。
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
}

/**
 * 完整体检。
 * @param {string} root 仓库根（含 .git）
 * @returns {{findings: Array<{id: string, level: 'fatal'|'info', message: string, detail?: string[]}>, ok: boolean}}
 */
export function check(root) {
  /** @type {Array<{id: string, level: 'fatal'|'info', message: string, detail?: string[]}>} */
  const findings = [];

  const ignoredButTracked = findIgnoredButTracked(root);
  if (ignoredButTracked.length > 0) {
    findings.push({
      id: 'ignored-but-tracked',
      level: 'fatal',
      message: `${ignoredButTracked.length} 个文件既被跟踪又被 ignore：该目录里的新文件不会进索引，切分支/clean 会静默丢（#20 同类）`,
      detail: ignoredButTracked.slice(0, 20),
    });
  }

  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    findings.push({ id: 'no-package-json', level: 'fatal', message: '找不到 package.json，无法核对入口与 files' });
  } else {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const tracked = new Set(lines(git(root, ['ls-files', '-z', '--cached'])));

    // 入口指向的位置：必须「被跟踪」或「磁盘上存在且由构建生成」。
    for (const p of entryPaths(pkg)) {
      const rel = p.replace(/^\.\//, '');
      if (tracked.has(rel)) continue;
      const onDisk = existsSync(path.join(root, rel));
      if (!onDisk) continue; // 尚未构建，属正常（构建后即出现）
      const isIgnored = gitIgnoreHit(root, rel);
      if (isIgnored) {
        findings.push({
          id: 'build-output-ignored',
          level: 'fatal',
          message: `入口 ${p} 指向磁盘上存在但被 ignore、且未跟踪的位置——产物不会进版本库，clean 后无法恢复`,
        });
      }
    }

    // files 白名单：既未跟踪、磁盘上也不存在 → 发出去的包缺内容。
    for (const entry of Array.isArray(pkg.files) ? pkg.files : []) {
      if (String(entry).startsWith('./')) continue;
      const rel = String(entry).replace(/^\.\//, '');
      if (rel === 'package.json') continue;
      if (tracked.has(rel) || tracked.has(`${rel}/`) || hasTrackedUnder(root, rel, tracked)) continue;
      if (!existsSync(path.join(root, rel))) {
        findings.push({
          id: 'untracked-shipped',
          level: 'fatal',
          message: `files 里列了 ${rel}，但它既没被跟踪也不在磁盘上（发出去的包会缺这块内容）`,
        });
      }
    }
  }

  // 信息项：当前被 ignore 的顶层条目，便于人工核对「这条规则是不是有意为之」。
  const infoFile = path.join(root, '.gitignore');
  if (existsSync(infoFile)) {
    const dirs = readFileSync(infoFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('/') && !l.startsWith('#'))
      .map((l) => l.replace(/\/$/, ''));
    const present = dirs.filter((d) => existsSync(path.join(root, d)));
    if (present.length > 0) {
      findings.push({
        id: 'ignored-dirs',
        level: 'info',
        message: `.gitignore 覆盖了这些当前存在的目录：${present.join(', ')}（确认其中的新文件本就不该入库）`,
      });
    }
  }

  return { findings, ok: !findings.some((f) => f.level === 'fatal') };
}

/**
 * 某个相对路径是否命中 ignore 规则。
 * @param {string} root
 * @param {string} rel
 * @returns {boolean}
 */
function gitIgnoreHit(root, rel) {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', rel], { stdio: 'pipe' });
    return true; // 退出 0 = 被 ignore
  } catch {
    return false; // 非 0 = 未被 ignore
  }
}

/**
 * `tracked` 里是否存在位于 dir 之下的文件（目录型 files 条目用）。
 * @param {string} root
 * @param {string} dir
 * @param {Set<string>} tracked
 * @returns {boolean}
 */
function hasTrackedUnder(root, dir, tracked) {
  void root;
  const prefix = `${dir}/`;
  for (const f of tracked) if (f.startsWith(prefix)) return true;
  return false;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  let root;
  try {
    root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  } catch {
    console.error('gitignore-check: 当前目录不在 git 仓库里');
    process.exit(2);
  }
  const result = check(root);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const f of result.findings) {
      console.log(`${f.level === 'fatal' ? '✗' : '·'} [${f.id}] ${f.message}`);
      for (const d of f.detail ?? []) console.log(`      ${d}`);
    }
    if (result.ok) console.log(`✅ gitignore-check: 产物与 ignore 规则一致（${root}`);
    else console.error('❌ gitignore-check: 见上面的 fatal 项');
  }
  process.exit(result.ok ? 0 : 1);
}
