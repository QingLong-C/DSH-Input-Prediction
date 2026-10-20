#!/usr/bin/env node
/**
 * 一次性隔离的 DSH 第二实例（插件开发回路工具）。
 *
 * ## 为什么需要它
 *
 * 插件宿主层改动要生效，默认得重启 DSH —— 而重启会打断人正在跑的会话，于是"改完等重启"
 * 一轮一轮地烧时间。本脚本起一个独立实例，隔离做在两层：
 *
 * 1. `DSH_HOME` 独立 → `sessions` / `storages` / `logs` 全落进沙箱目录。实测 `dshHomePath()`
 *    认这个环境变量（`dsh-home-paths/lib/index.js:73-84`），所以不会写到真实家目录。
 * 2. **插件产物也独立**：沙箱里 `node_modules/<本包名>` 指向一份私有副本，其余依赖逐条软链到
 *    真实 profile 的 node_modules，**不跑 install**（几秒建好、不吃磁盘）。这层是必须的：否则往
 *    沙箱放未验证构建，会污染 live 宿主下次重启真正加载的那份 `lib/`。
 *
 * ## 通用性：脚本不含插件专有知识
 *
 * 插件身份从当前仓 `package.json` 的 `name` 推导；profile 里的条目 id 再用 `name: <包名>` 反查
 * （或 `--entry` 指定）。仓特定的东西（要改的端口、要关的顶层条目、验收该 grep 什么）放进该仓
 * `package.json` 的 `sandbox` 字段，命令行可叠加覆盖：
 *
 * ```json
 * "sandbox": {
 *   "entry": "suggest-ghost",
 *   "rewrites": ["port: 3081=port: 3983"],
 *   "disable": ["our-free-model"],
 *   "greps": ["apply called; artifact mtime=", "completion generated", "push landed"]
 * }
 * ```
 *
 * ## 两条会让"量出来的数据"骗人的使用坑（实测）
 *
 * - 不带 `--deploy` 会 `rmSync(HOME_)` 整体重建并从仓里拷 `lib/`，所以**手改沙箱私有产物再重启
 *   会被冲掉**。要做 A/B（例如临时压小超时值验证超时路径），先拷一份 deploy 源目录、改它、再用
 *   `--deploy <那个目录>`；启动后回读 `plugin/lib` 里的实际值，确认了才认数据。
 * - 启动时打印的 `dsh web:` URL 可能取自日志里的**旧**行（日志是追加写的，上一轮的行还在）。
 *   真实端口要用 pid 去 `ss -ltnp` 对。
 *
 * ## 三条实测踩过的坑（改回去就会再踩，实现里都留了注释）
 *
 * 1. **profile 里的 volatile 值是跨多行的单引号标量**（本仓 `_push` 实测跨 16~35 行，里面存着
 *    建议正文）。按行 `grep -v` / 逐行删会把续行留给下一个键，直接改坏 profile：
 *    `historyMinChars expected number but got 3 A","truncated":false,…` → 条目不挂载。
 *    所以剥离一律**按缩进整块删**，且只删本插件条目名下的 `_` 前缀键（别人的 `_x` 可能有意义）。
 * 2. **`--gui-port` 只管主 GUI 端口**，profile 里被别的插件钉死的监听端口照样会 `EADDRINUSE`；
 *    webServer 服务缺失会让实例在跑第一个 agent 回合时静默退出。所以脚本扫副本里全部
 *    `port: <n>`，只要有一个被占就拒绝启动并列出该用什么 `--rewrite` 换掉。替换按**整行相等**
 *    匹配：用 `/port: 3081$/` 这种没加 `m` 标志的正则，会在该行不在文件末尾时静默不生效（踩过，
 *    而且当时"端口已改"的提示是无条件打印的假话）。
 * 3. **group 成员条目关不掉**：`--patch` 叠加层对顶层条目生效，对嵌在 `group: true` 条目 `config:`
 *    列表里的成员无效（实测指 group 与指叶子都无效）。这类只能改端口/配置绕开。
 *
 * ## 用法
 *
 * ```
 * node scripts/dev-sandbox.mjs                  # 建沙箱并后台启动（读仓内 sandbox 配置）
 * node scripts/dev-sandbox.mjs --check          # 只合成校验，不启动
 * node scripts/dev-sandbox.mjs --deploy <dir>   # 把某 worktree 构建的 lib/ 装进沙箱
 * node scripts/dev-sandbox.mjs --home ~/sbx --watch --rewrite 'port: 8080=port: 8081'
 * ```
 *
 * `--watch` 打开宿主层源码热重载（只盯本插件私有产物目录）。触发要**真改内容**：只 `touch` 换
 * mtime 不产生第二次 `apply called`（实测）。判据就是那行 `artifact mtime=` 变没变 —— 没变说明
 * 进程还在跑旧字节，这一轮的观察一概不算（issue #20 的根子）。
 *
 * ⚠️ 依赖"在 `apply()` 期建立的异步上下文"才能工作的东西（例如本仓 #22 的事务外排水 pump）**不能
 * 用热重载验证**：HMR 的 `partialReload` 跑在 `runExclusive → executing.run(true, …)` 里，那样建
 * 出来的定时器仍带 `store=true`。这类必须整进程重启。
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

/** 可重复参数（`--rewrite a=b --rewrite c=d` / `--disable x` / `--grep y` / `--strip k`）。 */
export function collect(list, name) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === `--${name}` && list[i + 1] !== undefined) { out.push(list[i + 1]); i += 1; }
  }
  return out;
}

/**
 * 读当前仓配置：包名 + `sandbox` 字段。脚本的通用性靠它 —— 插件专有值不进脚本本体。
 * @param {string} repo @returns {{pkgName: string, cfg: Record<string, any>}}
 */
export function readRepoConfig(repo) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  if (typeof pkg.name !== 'string' || pkg.name === '') throw new Error(`${repo}/package.json 缺 name`);
  return { pkgName: pkg.name, cfg: pkg.sandbox ?? {} };
}

/**
 * 按缩进整块删除一个 YAML 键（键行 + 比它更深缩进的全部续行）。
 * @param {string} text @param {string} key @returns {{text: string, removed: number}}
 */
export function stripKeyBlock(text, key) {
  const lines = text.split('\n');
  /** @type {string[]} */
  const out = [];
  let i = 0;
  let removed = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith(`${key}: `)) {
      const indent = line.length - line.trimStart().length;
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (nxt.trim() === '') { j += 1; continue; }
        if (nxt.length - nxt.trimStart().length > indent) { j += 1; continue; }
        break;
      }
      removed = j - i;
      i = j;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return { text: out.join('\n'), removed };
}

/**
 * 只剥**指定条目名下**的易失键（默认：键名以 `_` 开头），别的条目一概不碰。
 *
 * 为什么不全局删 `_ops`/`_push`：那是某个插件的键名；别的插件条目里的 `_x` 键可能是有意义的
 * 配置，全局删等于顺手改了别人的状态。
 * @param {string} text @param {string} entryId
 * @param {(key: string) => boolean} [isVolatile]
 * @returns {{text: string, removed: Array<{key: string, lines: number}>}}
 */
export function stripEntryVolatileKeys(text, entryId, isVolatile = (k) => k.startsWith('_')) {
  const lines = text.split('\n');
  /** @type {Array<{key: string, at: number, end: number}>} */
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)- id:\s*(\S+)\s*$/.exec(lines[i]);
    if (m === null || m[2] !== entryId) continue;
    const entryIndent = m[1].length;
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() === '') { j += 1; continue; }
      const indent = line.length - line.trimStart().length;
      if (indent <= entryIndent) break; // 回到同级/更浅 = 已出条目
      const kv = /^([A-Za-z0-9_-]+): /.exec(line.trim());
      if (kv !== null && isVolatile(kv[1])) {
        let k = j + 1;
        while (k < lines.length) {
          const nxt = lines[k];
          if (nxt.trim() === '') { k += 1; continue; }
          if (nxt.length - nxt.trimStart().length > indent) { k += 1; continue; }
          break;
        }
        found.push({ key: kv[1], at: j, end: k });
        j = k;
        continue;
      }
      j += 1;
    }
    break; // 同名条目只处理第一处
  }
  const drop = new Set();
  for (const f of found) for (let n = f.at; n < f.end; n += 1) drop.add(n);
  return { text: lines.filter((_, n) => !drop.has(n)).join('\n'), removed: found.map((f) => ({ key: f.key, lines: f.end - f.at })) };
}

/**
 * 解析 `--rewrite '旧整行=新整行'`。整行 trim 相等匹配，不用正则（`$` 少 `m` 标志那次静默失效）。
 * @param {string[]} specs @returns {Array<{from: string, to: string}>}
 */
export function parseRewrites(specs) {
  return specs.map((spec) => {
    const i = spec.indexOf('=');
    if (i <= 0) throw new Error(`--rewrite 需要 '旧行=新行' 形式，收到 ${JSON.stringify(spec)}`);
    return { from: spec.slice(0, i).trim(), to: spec.slice(i + 1).trim() };
  });
}

/**
 * 应用整行替换；命中数交回调用方决定去留（0 命中必须拒绝启动：静默不替换比报错坏）。
 * @param {string[]} lines @param {Array<{from: string, to: string}>} rules
 * @returns {{lines: string[], hits: number[]}}
 */
export function applyRewrites(lines, rules) {
  const hits = rules.map(() => 0);
  const out = lines.map((line) => {
    let next = line;
    rules.forEach((r, k) => {
      if (next.trim() === r.from) { hits[k] += 1; next = next.replace(r.from, r.to); }
    });
    return next;
  });
  return { lines: out, hits };
}

/**
 * 副本里钉死的监听端口（`port: <n>` 整行）。
 * @param {string[]} lines @returns {number[]}
 */
export function declaredPorts(lines) {
  const out = new Set();
  for (const line of lines) {
    const m = /^\s*port:\s*(\d+)\s*$/.exec(line);
    if (m !== null) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 按包名在 profile 里反查条目 id（`- id: X` 后数行内出现 `name: <pkgName>`）。
 * @param {string} patchText @param {string} pkgName @returns {string | null}
 */
export function findEntryId(patchText, pkgName) {
  const lines = patchText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)- id:\s*(\S+)\s*$/.exec(lines[i]);
    if (m === null) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      if (lines[j].trim() === `name: ${pkgName}`) return m[2];
    }
  }
  return null;
}

// 只有直接执行才跑主流程：否则 `import { stripKeyBlock }` 会顺手起一个实例，纯函数就没法测。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) main();

function main() {
  const say = (m) => console.log(`  ${m}`);
  const die = (m) => { console.error(`dev-sandbox: ${m}`); process.exit(1); };
  const lstatSafe = (p) => { try { lstatSync(p); return true; } catch { return false; } };
  const portInUse = (port) => {
    try { return execFileSync('ss', ['-ltnH', `( sport = :${port} )`], { encoding: 'utf8' }).trim().length > 0; }
    catch { return false; }
  };

  let REPO = opt('repo', '');
  if (REPO === '') {
    try { REPO = execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); }
    catch { REPO = resolve(dirname(dirname(new URL(import.meta.url).pathname))); }
  }
  REPO = resolve(REPO);
  let conf;
  try { conf = readRepoConfig(REPO); } catch (error) { die(String(error)); }
  const { pkgName, cfg } = conf;
  const entryCfg = String(opt('entry', String(cfg.entry ?? '')));
  const short = (entryCfg || pkgName.split('/').pop() || pkgName).replace(/^dsh-/, '');

  const HOME_ = resolve(opt('home', join(homedir(), `dsh-sbx-${short}`)));
  const WS = resolve(opt('ws', join(homedir(), `dsh-sbx-${short}-ws`)));
  const GUI_PORT = String(opt('gui-port', '0'));
  const PROFILE = join(HOME_, 'profiles', 'web');
  const PLUGIN = join(HOME_, 'plugin');
  const LIVE_PROFILE = resolve(opt('live-profile', join(homedir(), '.dsh', 'profiles', 'web')));
  const LIVE_NM = resolve(opt('live-nm', join(LIVE_PROFILE, 'node_modules')));

  let rules;
  try { rules = parseRewrites([...asArray(cfg.rewrites), ...collect(argv, 'rewrite')]); }
  catch (error) { die(String(error)); }
  const disables = [...asArray(cfg.disable), ...collect(argv, 'disable')];
  const greps = [...asArray(cfg.greps), ...collect(argv, 'grep')];
  const extraStrip = collect(argv, 'strip');
  /** @param {unknown} v @returns {string[]} */
  function asArray(v) { return Array.isArray(v) ? v.map(String) : []; }

  if (GUI_PORT !== '0' && portInUse(Number(GUI_PORT))) die(`--gui-port ${GUI_PORT} 已被占用`);

  let entryId = entryCfg;
  if (!flag('deploy')) {
    rmSync(HOME_, { recursive: true, force: true });
    mkdirSync(PROFILE, { recursive: true });             // 漏了它，copyFileSync 直接 ENOENT
    mkdirSync(join(HOME_, 'logs'), { recursive: true }); // 建错位置会让启动崩在 spawn 之后
    for (const f of ['package.json', 'cordis.yml', 'compatibility.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
      const src = join(LIVE_PROFILE, f);
      if (existsSync(src)) copyFileSync(src, join(PROFILE, f));
    }
    for (const d of ['patches', 'external-plugins']) {
      const src = join(LIVE_PROFILE, d);
      if (existsSync(src)) execFileSync('cp', ['-rp', src, PROFILE], { stdio: 'ignore' });
    }
    const patchPath = join(PROFILE, 'cordis.patch.yml');
    if (!existsSync(patchPath)) die(`副本里没有 cordis.patch.yml：${patchPath}`);
    let patch = readFileSync(patchPath, 'utf8');
    if (entryId === '') {
      entryId = findEntryId(patch, pkgName) ?? '';
      if (entryId === '') say(`⚠ 没按 name: ${pkgName} 反查到条目 id → 跳过易失载荷剥离（可用 --entry <id> 指定）`);
      else say(`条目 id 反查：${pkgName} → ${entryId}`);
    }
    if (rules.length > 0) {
      const r = applyRewrites(patch.split('\n'), rules);
      rules.forEach((rule, k) => {
        if (r.hits[k] === 0) die(`--rewrite 未命中任何行：${JSON.stringify(rule.from)}（profile 结构变了？先人工确认，别猜）`);
        say(`rewrite 命中 ${r.hits[k]} 处：${rule.from} → ${rule.to}`);
      });
      patch = r.lines.join('\n');
    }
    const clash = declaredPorts(patch.split('\n')).filter((p) => portInUse(p));
    if (clash.length > 0) {
      die(`副本里这些端口已被占用：${clash.join(', ')}。第二实例必须避开 —— 加 `
        + `--rewrite 'port: ${clash[0]}=port: ${clash[0] + 900}'（group 成员条目 --patch 关不掉，只能改配置）`);
    }
    if (entryId !== '') {
      const st = stripEntryVolatileKeys(patch, entryId);
      patch = st.text;
      if (st.removed.length > 0) say(`剥除条目 ${entryId} 的易失载荷：${st.removed.map((r) => `${r.key}(${r.lines}行)`).join('、')}`);
    }
    for (const key of extraStrip) {
      const one = stripKeyBlock(patch, key);
      patch = one.text;
      say(`按 --strip 剥除 ${key}：${one.removed} 行`);
    }
    if (disables.length > 0) {
      patch += disables.map((id) => `\n# dev-sandbox：关掉 ${id}\n- id: ${id}\n  disabled: true`).join('\n') + '\n';
      say(`将禁用顶层条目：${disables.join('、')}（group 成员关不掉）`);
    }
    if (flag('watch')) {
      patch += '\n# dev-sandbox：宿主层源码热重载（只盯本插件私有产物目录）\n'
        + `- id: hmr\n  disabled: false\n  config:\n    root:\n      - node_modules/${pkgName}/lib\n    ignored: []\n    debounce: 100\n`;
      say('热重载已开：要**真改内容**才触发（只 touch 换 mtime 无效）');
    }
    writeFileSync(patchPath, patch);
    rmSync(PLUGIN, { recursive: true, force: true });
    mkdirSync(PLUGIN, { recursive: true });
    for (const f of ['package.json', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
      const src = join(REPO, f);
      if (existsSync(src)) copyFileSync(src, join(PLUGIN, f));
    }
    for (const d of ['lib', 'docs']) {
      const src = join(REPO, d);
      if (existsSync(src)) execFileSync('cp', ['-rp', src, PLUGIN], { stdio: 'ignore' });
    }
    const nm = join(PROFILE, 'node_modules');
    mkdirSync(nm, { recursive: true });
    if (!existsSync(LIVE_NM)) die(`找不到真实 node_modules：${LIVE_NM}`);
    for (const entry of readdirSync(LIVE_NM)) {
      if (entry === pkgName) continue;
      const link = join(nm, entry);
      if (!existsSync(link) && !lstatSafe(link)) symlinkSync(join(LIVE_NM, entry), link);
    }
    const mine = join(nm, pkgName);
    if (lstatSafe(mine)) rmSync(mine, { recursive: true, force: true });
    symlinkSync(PLUGIN, mine);
    chmodSync(HOME_, 0o700);
    say(`产物独立副本：${mine} → ${PLUGIN}（放构建不会污染 live 要加载的 ${join(REPO, 'lib')}）`);
  } else if (!existsSync(join(PROFILE, 'node_modules'))) {
    die('沙箱还不存在，先不带 --deploy 建一次');
  }

  if (flag('deploy')) {
    const srcArg = opt('deploy', '');
    if (srcArg === '') die('--deploy 需要一个含 lib/ 的目录路径');
    const src = resolve(String(srcArg));
    if (!existsSync(join(src, 'lib'))) die(`--deploy 指向的目录里没有 lib/：${src}`);
    rmSync(join(PLUGIN, 'lib'), { recursive: true, force: true });
    execFileSync('cp', ['-rp', join(src, 'lib'), PLUGIN], { stdio: 'ignore' });
    say(`已部署构建：${src}/lib → ${PLUGIN}/lib`);
  }

  // 凭据**必须**复制成文件：`credentials-local` 读的是 `dshHomePath('.credentials.yaml')`
  // （`dsh-credentials-local/lib/index.js:58`），沙箱换了 DSH_HOME 就读到空文件，于是任何
  // 走 `apiKeyEnv` 的路由都报 `no credential for provider route …`，而这类失败与"路由没配好"
  // 在现象上很难区分（实测踩过：整整一轮沙箱观测全废）。
  //
  // 这一步必须在 `--check` 之前做：`--check` 会提前 `process.exit`，而它建的沙箱同样要能跑
  // 真实回合（`dsh headless`），所以"只有启动 web 那条路径才复制凭据"是错的 —— 踩过。
  // 权限压回 0600，且只落在沙箱目录内（原文件本来就是 0600，复制不扩大权限面）。
  const copyCredentials = () => {
    const credSrc = join(homedir(), '.dsh', '.credentials.yaml');
    if (!existsSync(credSrc)) {
      say('⚠ 宿主机没有 ~/.dsh/.credentials.yaml：需要凭据的路由在沙箱里会报 no credential');
      return;
    }
    const credDst = join(HOME_, '.credentials.yaml');
    copyFileSync(credSrc, credDst);
    chmodSync(credDst, 0o600);
    say('已复制 ~/.dsh/.credentials.yaml 进沙箱（0600）—— 否则 apiKeyEnv 路由全部解析不到凭据');
  };
  if (!flag('deploy')) copyCredentials();

  const BIN = findBin();
  if (flag('check')) {
    const out = execFileSync('node', [BIN, '--profile', 'web', '--dump-config'], {
      encoding: 'utf8', env: { ...process.env, DSH_HOME: HOME_ }, timeout: 180_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const present = entryId === '' ? null : new RegExp(`^- id: ${entryId}$`, 'm').test(out);
    const bad = out.split('\n').filter((l) => /invalid config|ValidationError/i.test(l)).slice(0, 3);
    say(`合成校验：条目 ${entryId || '（未指定）'} ${present === null ? '跳过' : present ? '在册 ✓' : '缺失 ✗'}；校验错误 ${bad.length} 条`);
    for (const b of bad) say(`    ${b.slice(0, 140)}`);
    process.exit((present === null || present) && bad.length === 0 ? 0 : 1);
  }

  mkdirSync(WS, { recursive: true });
  try { execFileSync('git', ['-C', WS, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); }
  catch { try { execFileSync('git', ['-C', WS, 'init', '-q'], { stdio: 'ignore' }); } catch { /* 非致命 */ } }

  const env = { ...process.env, DSH_HOME: HOME_ };
  const envFile = join(homedir(), '.dsh', 'env.local');
  if (existsSync(envFile)) {
    // 密钥只进子进程环境，不复制文件（env.local 里的值本来就只是环境变量形态）
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m !== null) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    say('已把 ~/.dsh/env.local 注入子进程环境（仅内存，未落进沙箱）');
  }
  const log = join(HOME_, 'logs', 'sbx.log');
  // 日志 fd 归子进程：父进程接管道的话，父进程一退出管道就断，子进程下次写日志吃 EPIPE 而死
  // （表现为"启动成功、稍后自行退出"，极易被误判成热重载或内核问题）。
  let logFd;
  try { logFd = openSync(log, 'a'); } catch (error) { die(`日志打不开 ${log}: ${String(error)}`); }
  // 启动前的行数：下面取 URL 时只看**本次**新增的行。日志是追加写的，上一轮的 `dsh web:` 行还在，
  // 直接全文 grep 会拿到上一轮的（旧）端口 —— 用它去连一个已经停掉的实例，结论必然错。
  const logLinesBefore = existsSync(log) ? readFileSync(log, 'utf8').split('\n').length : 0;
  const child = spawn('node', [BIN, '--profile', 'web', '--port', GUI_PORT, '--no-open'], {
    env, cwd: HOME_, detached: true, stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  try { closeSync(logFd); } catch { /* 已关 */ }
  /**
   * 记录**真正在监听的那个 node 进程** pid，而不是 `spawn` 返回的 pid。
   *
   * 实测教训：`dsh` 是 npx 的启动器包装，`child.pid` 可能只是一个 shell/包装进程；按它 kill
   * 之后 node 子进程仍然活着占着端口（我据此误判过"沙箱已停"，然后一个残留实例继续跑）。
   * 所以启动后按 DSH_HOME 反查，把实际进程的 pid 写进 pidfile（查不到才退回 child.pid）。
   */
  const pidFile = join(HOME_, 'sbx.pid');
  writeFileSync(pidFile, `${child.pid}\n`);
  const realPids = () => {
    let out = '';
    try { out = execFileSync('sh', ['-c', 'ls /proc | grep -E "^[0-9]+$"'], { encoding: 'utf8' }); }
    catch { return []; }
    const mine = [];
    for (const p of out.split('\n')) {
      const n = p.trim();
      if (n === '') continue;
      let e = '';
      try { e = readFileSync(`/proc/${n}/environ`, 'utf8'); } catch { continue; }
      if (e.split('\0').includes(`DSH_HOME=${HOME_}`)) {
        try { mine.push({ pid: Number(n), cmd: readFileSync(`/proc/${n}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() }); }
        catch { /* 已退出 */ }
      }
    }
    return mine;
  };
  const settlePid = () => {
    const mine = realPids().filter((x) => x.cmd.includes('.bin/dsh'));
    if (mine.length > 0) {
      writeFileSync(pidFile, mine.map((x) => `${x.pid}`).join('\n') + '\n');
      return mine.map((x) => x.pid);
    }
    return [child.pid];
  };
  say(`已启动 pid=${child.pid}（稍后会写回真实 node pid）；停它请用 ${pidFile} 里的 pid`
    + ' —— `pkill -f` 的模式串会匹配到调用方自己的命令行（踩过三次）');

  const deadline = Date.now() + 45_000;
  const tick = () => {
    const all = existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [];
    // 只看本次启动之后新增的行（见上面 logLinesBefore 的理由）
    const fresh = all.slice(logLinesBefore).join('\n');
    const url = (/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(fresh) ?? [null])[0];
    if (url === null && Date.now() < deadline) { setTimeout(tick, 2000); return; }
    const pids = settlePid();
    const port = url === null ? '' : (/127\.0\.0\.1:(\d+)/.exec(url) ?? [])[1];
    console.log('');
    say(`存活=${pids.filter((p) => lstatSafe(`/proc/${p}`)).length > 0 ? 'yes' : 'NO'}  `
      + `${url ?? 'URL 未就绪（看日志）'}`);
    say(`pidfile 里的 pid：${pids.join('、')}（${pidFile}）`);
    if (port !== undefined && port !== '') {
      // 用自己的眼睛再核一次监听：日志里的 URL 只能当线索，`ss` 才是事实。
      const listening = execFileSync('ss', ['-ltnH', `( sport = :${port} )`], { encoding: 'utf8' }).trim().length > 0;
      say(`日志给的端口 ${port} 实际在监听=${listening ? 'yes ✓' : 'NO ✗'}`);
    } else {
      say('本次启动没有新的 URL 行 —— 别拿日志里的旧 URL 当本次实例（实测踩过）');
    }
    say(`端口冲突 ${/EADDRINUSE/.test(fresh) ? '有 ✗' : '无 ✓'}；新增日志 ${fresh.split('\n').length} 行`);
    if (greps.length > 0) {
      console.log('');
      say('读法：');
      for (const g of greps) say(`    grep -F '${g}' ${log}`);
    }
    process.exit(0); // 子进程自持 fd，父进程退出不影响它
  };
  setTimeout(tick, 4000);

  function findBin() {
    const fromFlag = opt('bin', '');
    if (fromFlag !== '') return resolve(fromFlag);
    try {
      const found = execFileSync('sh', ['-c', 'command -v dsh || true'], { encoding: 'utf8' }).trim();
      if (found !== '') return found;
    } catch { /* 继续找 */ }
    const cache = join(homedir(), '.npm', '_npx');
    if (existsSync(cache)) {
      for (const dir of readdirSync(cache)) {
        const cand = join(cache, dir, 'node_modules', '.bin', 'dsh');
        if (existsSync(cand)) return cand;
      }
    }
    die('找不到 dsh 启动器：用 --bin <path> 指定');
  }
}
