#!/usr/bin/env node
/**
 * 一次性隔离测试实例（Gitea issue #20 / #22 的开发回路工具）。
 *
 * ## 它解决的问题
 *
 * 插件宿主代码改动要生效， normally 得重启 DSH —— 而重启会打断人正在跑的会话，
 * 于是"改完等重启"变成一轮一轮的浪费（#20 记的就是这个）。本脚本造一个**独立实例**：
 *
 * - `DSH_HOME` 独立 → `sessions` / `storages` / `logs` 全部落进沙箱目录，实测不写真实家目录；
 * - **插件产物也独立**（私有副本），所以往沙箱里放探针/未验证构建，不会污染 live 宿主
 *   下次重启要加载的那个 `lib/`；
 * - 其余依赖逐个软链到真实 profile 的 node_modules，**不跑 install**（几秒建好，不吃磁盘）。
 *
 * ## 两个已踩过的坑（脚本按踩坑后的写法实现，别改回去）
 *
 * 1. `cordis.patch.yml` 里 `_push` 的值是**跨多行的单引号标量**（建议正文自带换行，本机实测
 *    8 行）。按行 `grep -v` / 逐行删会把续行留给下一个键，直接把 profile 改坏：
 *    `historyMinChars expected number but got 3 A","truncated":false,…` → 条目不挂载。
 *    所以剥离必须**按缩进吞掉整块**（`stripKeyBlock`）。
 * 2. 端口 `0.0.0.0:3081` 由 profile 里 `dsh-host-webserver` 钉死，`--port 0` **只管主 GUI 端口**。
 *    第二实例不改它会 `EADDRINUSE` → webServer 服务缺失 → 那次实测实例在跑第一个 agent 回合时
 *    退出。脚本因此必须改这个端口（它是普通单行标量，替换是安全的）。
 *
 * 另记一条限制：**group 成员没法用 `--patch` 叠加层禁用**（`webhook-webserver` 之流嵌在
 * `webhook-listener` 这个 `group: true` 条目的 `config:` 列表里，overlay 指向 group 或叶子都
 * 不生效；顶层条目的 overlay 是生效的）。所以本脚本走"改端口"而不是"禁用"。
 *
 * ## 用法
 *
 * ```
 * node scripts/dev-sandbox.mjs --home ~/dsh-sbx --ws ~/dsh-sbx-ws --port 3983 [--watch] [--deploy <dir>]
 * node scripts/dev-sandbox.mjs --check --home ~/dsh-sbx --port 3983      # 只合成校验，不启动
 * ```
 *
 * `--watch` 打开宿主层源码热重载（只盯本插件产物目录）。触发要**真改内容**：只 `touch`
 * 换 mtime 不产生第二次 `apply called`（实测），所以要么改 src 后 `--deploy`，要么往
 * 沙箱那份 `lib/index.js` 里追加一行注释。 即重新 apply
 * 即重新 apply —— 判据是日志里再来一行 `apply called; artifact mtime=…`（mtime 必须变）。
 * `--deploy` 把某个 worktree 构建出的 `lib/` 装进沙箱私有副本（不重启、不碰 live）。
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const HOME_ = resolve(opt('home', join(homedir(), 'dsh-sbx-ghost')));
const WS = resolve(opt('ws', join(homedir(), 'dsh-sbx-ghost-ws')));
const WS_PORT = Number(opt('port', '3983'));
const PROFILE = join(HOME_, 'profiles', 'web');
const PLUGIN = join(HOME_, 'plugin');
// 真实 profile 与其 node_modules：从家目录推导，不做相对路径猜测（拼错过一次）
const LIVE_PROFILE = resolve(opt('live-profile', join(homedir(), '.dsh', 'profiles', 'web')));
const LIVE_NM = resolve(opt('live-nm', join(LIVE_PROFILE, 'node_modules')));
// 产物来源：默认取当前 git 工作区（脚本可以在任一 worktree 里跑）
function repoRoot() {
  const fromFlag = args.indexOf('--repo');
  if (fromFlag >= 0 && args[fromFlag + 1] !== undefined) return resolve(args[fromFlag + 1]);
  try {
    return execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return resolve(dirname(dirname(new URL(import.meta.url).pathname)));
  }
}
const REPO = repoRoot();

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`dev-sandbox: ${m}`); process.exit(1); };

/**
 * 按缩进整块删除一个 YAML 键（含它所有更深缩进的续行）。
 * @param {string} text
 * @param {string} key
 * @returns {{text: string, removed: number}}
 */
export function stripKeyBlock(text, key) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let removed = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();
    if (stripped.startsWith(`${key}: `)) {
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

// 只有被直接执行时才跑主流程：否则 `import { stripKeyBlock } from './dev-sandbox.mjs'`
// 会顺手把一整个隔离实例启动起来（纯函数就没法被测了）。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (!invokedDirectly) {
  // 作为模块被引入时只导出工具函数，不做任何副作用
} else {
// ── 1. 端口必须真空出来（撞过 EADDRINUSE 导致 webServer 缺失、实例跑回合时退出）──
function portInUse(port) {
  try {
    return execFileSync('ss', ['-ltnH', `( sport = :${port} )`], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}
if (portInUse(WS_PORT)) die(`端口 ${WS_PORT} 已被占用；换一个（第二实例必须避开 live 钉死的 3081）`);

// ── 2. profile 副本：改端口 + 剥易失载荷 + 只读不改真实 profile ─────────────────
if (!flag('deploy')) {
  rmSync(HOME_, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });      // profile 副本的目标目录（漏了它 copyFileSync 直接 ENOENT）
  mkdirSync(join(HOME_, 'logs'), { recursive: true });   // 写流要的是这个目录，建错位置会让启动崩在 spawn 之后
  for (const f of ['package.json', 'cordis.yml', 'compatibility.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
    const src = join(LIVE_PROFILE, f);
    if (existsSync(src)) copyFileSync(src, join(PROFILE, f));
  }
  for (const d of ['patches', 'external-plugins']) {
    const src = join(LIVE_PROFILE, d);
    if (existsSync(src)) execFileSync('cp', ['-rp', src, PROFILE], { stdio: 'ignore' });
  }
  const patchPath = join(PROFILE, 'cordis.patch.yml');
  let patch = readFileSync(patchPath, 'utf8');
  // 按行替换：别用 /port: 3081$/ 的正则——没有 m 标志时 $ 只匹配整个字符串末尾，
  // 端口行不在文件末尾时就静默不替换，实例照样去抢 live 占用的 3081（实测踩过，
  // 而且当时的"端口已改"提示是无条件打印的假话）。改完必须断言新旧值都在/不在。
  const lines = patch.split('\n');
  let hits = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === 'port: 3081') {
      hits += 1;
      lines[i] = lines[i].replace('port: 3081', `port: ${WS_PORT}`);
    }
  }
  if (hits !== 1) die(`profile 里 \`port: 3081\` 命中 ${hits} 处，预期 1 处；先人工确认再改，别猜`);
  patch = lines.join('\n');
  if (patch.includes('port: 3081') || !patch.includes(`port: ${WS_PORT}`)) die('端口替换未生效，拒绝启动（否则会抢 live 的 3081）');
  const ops = stripKeyBlock(patch, '_ops');
  const push = stripKeyBlock(ops.text, '_push');
  patch = push.text + '\n# dev-sandbox：关掉公告弹层，它会吃掉指针事件（实测挡过工作区选择）\n- id: our-free-model\n  disabled: true\n';
  if (flag('watch')) {
    patch += '\n# dev-sandbox：宿主层源码热重载（只盯本插件私有产物；实测 apply() 期建的 timer 能写 settings）\n'
      + '- id: hmr\n  disabled: false\n  config:\n    root:\n      - node_modules/dsh-suggest-ghost/lib\n    ignored: []\n    debounce: 100\n';
  }
  writeFileSync(patchPath, patch);
  say(`profile 副本就绪：端口→${WS_PORT}，剥除 _ops ${ops.removed - 0} 行块 / _push ${push.removed} 行块（后者是多行单引号标量，按行删会改坏 profile）`);
  // 私有插件副本：只放运行所需（src 不进沙箱）
  rmSync(PLUGIN, { recursive: true, force: true });
  mkdirSync(PLUGIN, { recursive: true });
  for (const f of ['package.json', 'cordis.patch.yml', 'icon.svg']) {
    const src = join(REPO, f);
    if (existsSync(src)) copyFileSync(src, join(PLUGIN, f));
  }
  for (const d of ['lib', 'docs']) {
    const src = join(REPO, d);
    if (existsSync(src)) execFileSync('cp', ['-rp', src, PLUGIN], { stdio: 'ignore' });
  }
  // node_modules：逐条软链，唯独本插件指向私有副本
  const nm = join(PROFILE, 'node_modules');
  mkdirSync(nm, { recursive: true });
  if (!existsSync(LIVE_NM)) die(`找不到真实 node_modules：${LIVE_NM}`);
  for (const entry of readdirSync(LIVE_NM)) {
    if (entry === 'dsh-suggest-ghost') continue;
    const link = join(nm, entry);
    if (!existsSync(link) && !lstatSafe(link)) symlinkSync(join(LIVE_NM, entry), link);
  }
  const mine = join(nm, 'dsh-suggest-ghost');
  if (lstatSafe(mine)) rmSync(mine, { recursive: true, force: true });
  symlinkSync(PLUGIN, mine);
  chmodSync(HOME_, 0o700);
  say(`产物独立副本：${mine} → ${PLUGIN}（往这里放构建不会污染 live 要加载的 ${join(REPO, 'lib')}）`);
} else {
  if (!existsSync(join(PROFILE, 'node_modules'))) die('沙箱还不存在，先不带 --deploy 建一次');
}

function lstatSafe(p) { try { lstatSync(p); return true; } catch { return false; } }

// ── 3. --deploy：把某个 worktree 的构建装进沙箱 ────────────────────────────────
if (flag('deploy')) {
  const src = resolve(String(opt('deploy')));
  if (!existsSync(join(src, 'lib'))) die(`--deploy 指向的目录里没有 lib/：${src}`);
  rmSync(join(PLUGIN, 'lib'), { recursive: true, force: true });
  execFileSync('cp', ['-rp', join(src, 'lib'), PLUGIN], { stdio: 'ignore' });
  say(`已部署构建：${src}/lib → ${PLUGIN}/lib`);
  if (flag('check')) { console.log('  （--check 到此为止）'); process.exit(0); }
}

// ── 4. --check：只做合成校验，不启动 ──────────────────────────────────────────
function findBin() {
  const fromFlag = opt('bin', null);
  if (fromFlag) return resolve(fromFlag);
  try {
    const found = execFileSync('sh', ['-c', "command -v dsh || true"], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch { /* 继续找 */ }
  // 退化：在 npx 缓存里找一个 dsh 启动器（缓存目录 id 会变，所以不能写死）
  const cache = join(homedir(), '.npm', '_npx');
  for (const dir of readdirSync(cache)) {
    const cand = join(cache, dir, 'node_modules', '.bin', 'dsh');
    if (existsSync(cand)) return cand;
  }
  die('找不到 dsh 启动器：用 --bin <path> 指定');
}
const BIN = findBin();
if (flag('check')) {
  if (!existsSync(BIN)) die(`找不到 dsh 启动器：${BIN}`);
  const out = execFileSync('node', [BIN, '--profile', 'web', '--dump-config'], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: HOME_ }, timeout: 180_000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const okGhost = /^- id: suggest-ghost$/m.test(out);
  const bad = out.split('\n').filter((l) => /invalid config|ValidationError/i.test(l)).slice(0, 3);
  say(`合成配置：suggest-ghost ${okGhost ? '在册 ✓' : '缺失 ✗'}；校验错误 ${bad.length} 条`);
  for (const b of bad) say(`    ${b.slice(0, 140)}`);
  process.exit(okGhost && bad.length === 0 ? 0 : 1);
}

// ── 5. 启动 ───────────────────────────────────────────────────────────────────
mkdirSync(WS, { recursive: true });
try { execFileSync('git', ['-C', WS, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); }
catch { try { execFileSync('git', ['-C', WS, 'init', '-q'], { stdio: 'ignore' }); } catch { /* 非致命 */ } }

const env = { ...process.env, DSH_HOME: HOME_ };
const envFile = join(homedir(), '.dsh', 'env.local');
if (existsSync(envFile)) {
  // 密钥只进子进程环境，绝不复制进沙箱目录（沙箱里出现凭据文件就等于多一份泄露面）
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  say('已把 ~/.dsh/env.local 注入子进程环境（仅内存，未复制到沙箱）');
}
const log = join(HOME_, 'logs', 'sbx.log');
// 日志 fd 必须由子进程自己持有。先前改成"父进程用 createWriteStream 接管道"，父进程
// 打印完 process.exit() 后管道断裂，子进程下一次写日志吃 EPIPE 直接死 —— 沙箱表现为
// "启动成功、稍后自行退出"，我一度把它误判成"热重载会杀进程"。
// 这里用 openSync('a') 把 fd 交给 spawn：追加写，且父进程退出与子进程无关。
let logFd;
try {
  logFd = openSync(log, 'a');
} catch (error) {
  die(`日志文件打不开 ${log}: ${String(error)}`);
}
const child = spawn('node', [BIN, '--profile', 'web', '--port', '0', '--no-open'], {
  env, cwd: HOME_, detached: true, stdio: ['ignore', logFd, logFd],
});
child.unref();
try {
  closeSync(logFd); // 子进程已继承，父进程这边关掉，否则 fd 泄漏
} catch {
  /* 已经关了 */
}
writeFileSync(join(HOME_, 'sbx.pid'), `${child.pid}\n`);
say(`已启动 pid=${child.pid}（pidfile: ${join(HOME_, 'sbx.pid')}；停它请用这个 pid，别用 pkill -f，模式串会匹配到自己的命令行）`);

setTimeout(() => {
  const txt = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const url = (/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(txt) ?? [null])[0];
  const alive = lstatSafe(`/proc/${child.pid}`);
  console.log('');
  say(`存活=${alive ? 'yes' : 'NO'}  URL=${url ?? '（未就绪）'}`);
  const nested = (txt.match(/PROBE|cannot be nested/g) ?? []).length;
  say(`日志 ${txt.split('\n').length} 行；端口冲突 ${/EADDRINUSE/.test(txt) ? '有 ✗' : '无 ✓'}；nested/探针痕迹 ${nested}`);
  console.log('');
  console.log('读法（跑一次输入→停顿后逐条看）：');
  for (const g of [
    'apply called; artifact mtime=',      // 这份进程跑的到底是哪次构建（#20）
    'completion generated',              // 模型出东西了
    'completion dropped (empty or filtered)',
    'completion failed',                 // 常见是 no logged request route：新会话没有已记录请求
    'push landed', 'push dropped inside settings transaction',   // #22 的那一跳
    'live settings refreshed',           // #19
  ]) say(`    grep -F '${g}' ${log}`);
}, 26_000);

// 打印完就收手：child.stdout/stderr 的 pipe 会一直吊着事件循环，父进程永不退出
// （实测脚本因此挂在后台，`| tail` 也就永远等不到输出）。
// 打印完就退出：子进程自己持有日志 fd，父进程退出不会影响它
const finish = () => process.exit(0);
setTimeout(finish, 45_000);

}
