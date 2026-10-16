// 冷启动端到端：真实 cordis Context + 真实 dsh-session + 真实 dsh-settings
// （内存 provider），跑通「跑到某回合 → 停机 → 重启 → client 冷启动 pull」的
// 完整对账链路。测的是编译产物（src 内部用 .js 推导导入，strip-types 无法直接
// 加载），先 pnpm build 再跑。用法：node scripts/coldstart-e2e.mjs
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import SettingsProvider from '@deepseek-ai/dsh-settings';
import { apply as applyHost, inject as hostInject, name as hostName } from '../lib/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 一个跨「进程」存活的内存 settings 文档：模拟 settings.yaml 的持久性。
 * 重启 = 丢掉插件 fiber 与内存状态，但保留这份文档。
 */
function makeMedium(initial = {}) {
  let document = structuredClone(initial);
  return {
    get document() {
      return structuredClone(document);
    },
    /**
     * 造一个 provider 类：load() 返回同一份文档，persist() 写回它。
     * writable=true 是必须的——真实 host 的 provider（settings.yaml）可写，
     * 而裸 SettingsProvider 默认只读，插件推送会被拒。
     */
    provider() {
      return class MemorySettings extends SettingsProvider {
        writable = true;
        load() {
          return structuredClone(document);
        }
        /** 把写入落到介质上（真实 provider 由 storage 承担）。 */
        async persist(ns, section) {
          document = { ...document, [ns]: structuredClone(section) };
        }
      };
    },
  };
}

/** 造一个最小会话：给定已完成回合与用户消息。 */
function makeSession(store, id, { turns, userTexts }) {
  const session = store.create(id, { meta: { cwd: process.cwd() } });
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn });
    const text = userTexts[turn - 1];
    if (text !== undefined) {
      session.append('user/message', {
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' });
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  return session;
}

/** 装配一个「进程」：真实 Context + sessions + settings provider + 本插件 host 端。 */
async function bootProcess(medium, seed = {}) {
  const root = new Context();
  if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
  new SessionStore(root);
  // 必须经 ctx.plugin 装载 provider：服务的 [Service.init] 生成器只由 cordis 的
  // fiber 生命周期驱动，裸 new 不会执行 init，那份持久文档也就不会被发布。
  root.plugin(medium.provider());
  await sleep(20);
  const captured = {};
  const sessions = root.sessions;
  const session = makeSession(sessions, seed.sessionId ?? 'session-a', {
    turns: seed.turns ?? 2,
    userTexts: seed.userTexts ?? ['第一句', '第二句'],
  });
  // 拦截 register：拿到插件自己的 scope（等价于 client 读的那份值）
  const originalRegister = root.settings.register.bind(root.settings);
  root.settings.register = (ns, schema, options) => {
    const scope = originalRegister(ns, schema, options);
    if (ns === 'suggest-ghost') captured.scope = scope;
    return scope;
  };
  applyHost(root, {
    maxInputBytes: 4096,
    maxOutputTokens: 512,
    timeoutMs: 1000,
    maxTranscriptChars: 12000,
    maxSuggestionChars: 240,
  });
  // 等插件完成 settings 注入 + 启动对账推送
  for (let i = 0; i < 40; i += 1) {
    if (root.settings.registrations?.has?.('suggest-ghost')) break;
    await sleep(10);
  }
  await sleep(30);
  return { root, session, sessions, captured };
}

/** 读 host 推给 client 的 `_push`（client 侧读的是同一份 settings 值）。 */
function pushed(captured) {
  const raw = captured.scope?.get()?._push;
  return raw === undefined ? null : JSON.parse(raw);
}

const SESSION = 'session-a';

// —— 1. 首次启动：无建议、无已知会话 → 只推热度；历史由 pull 按需取 ——
{
  const medium = makeMedium();
  const { root, captured } = await bootProcess(medium, { sessionId: SESSION, turns: 2, userTexts: ['第一句', '第二句'] });
  const p = pushed(captured);
  assert.ok(p !== null, '启动后应推送一份状态');
  assert.equal(p.suggestion, null, '首次启动无建议');
  // 首次启动 host 不知道「当前会话」（盘上没有建议可归属），历史留给 client 的
  // pull 应答——这正是 pull 存在且必须被应答的意义，见第 5 节。
  assert.equal(p.historySessionId, undefined, '首次启动不猜当前会话');
  await root[Symbol.asyncDispose]?.();
}

// —— 2. 模拟「停机前的进程」：磁盘上留有一条属于回合 2 的建议 ——
{
  const persistedPush = JSON.stringify({
    rev: 9,
    suggestion: { turn: 2, baseSeq: 3, text: '跑一下测试', truncated: false, acceptKey: 'Tab' },
    suggestionSessionId: SESSION,
    hot: null,
    total: 0,
    history: ['第一句', '第二句'],
    historySessionId: SESSION,
  });
  const medium = makeMedium({ 'suggest-ghost': { _push: persistedPush, _ops: 'null' } });
  const { root, captured } = await bootProcess(medium, { sessionId: SESSION, turns: 2, userTexts: ['第一句', '第二句'] });

  // 重启对账的核心断言：会话已进店且回合归属正确 → 建议被**恢复**而非清空。
  const p = pushed(captured);
  assert.ok(p !== null, '重启后应推送对账状态');
  assert.ok(p.suggestion !== null, '重启后上一轮建议应被恢复（这是本次修复的核心）');
  assert.equal(p.suggestion.text, '跑一下测试');
  assert.equal(p.suggestion.turn, 2);
  assert.equal(p.suggestionSessionId, SESSION);
  assert.deepEqual(p.history, ['第一句', '第二句'], '历史同样立即可用，无需等新回合');
  await root[Symbol.asyncDispose]?.();
}

// —— 3. 建议陈旧（会话在停机期间又推进了回合）→ 应作废 ——
{
  const persistedPush = JSON.stringify({
    rev: 9,
    suggestion: { turn: 1, baseSeq: 1, text: '这条已经过期', truncated: false, acceptKey: 'Tab' },
    suggestionSessionId: SESSION,
    hot: null,
    total: 0,
  });
  const medium = makeMedium({ 'suggest-ghost': { _push: persistedPush, _ops: 'null' } });
  const { root, captured } = await bootProcess(medium, { sessionId: SESSION, turns: 3, userTexts: ['一', '二', '三'] });
  const p = pushed(captured);
  assert.equal(p.suggestion, null, '回合已推进到 3，回合 1 的建议必须作废');
  assert.equal(p.historySessionId, SESSION, '历史不受建议作废影响');
  await root[Symbol.asyncDispose]?.();
}

// —— 4. 会话尚未进店（持久化懒恢复未发生）→ 不猜测、不覆盖盘上值 ——
{
  const persistedPush = JSON.stringify({
    rev: 9,
    suggestion: { turn: 2, baseSeq: 3, text: '等会话进店后再判', truncated: false, acceptKey: 'Tab' },
    suggestionSessionId: 'session-not-restored-yet',
    hot: null,
    total: 0,
  });
  const medium = makeMedium({ 'suggest-ghost': { _push: persistedPush, _ops: 'null' } });
  // 注意：本进程只创建了 SESSION，**没有**创建 session-not-restored-yet。
  const { root, captured } = await bootProcess(medium, { sessionId: SESSION, turns: 1, userTexts: ['一'] });
  const raw = captured.scope?.get()?._push;
  // 盘上残留值不得被抹掉：仍应保留那条建议，等该会话进店后由 pull 对账。
  assert.ok(typeof raw === 'string' && raw !== 'null', '会话未进店时不得清盘');
  const kept = JSON.parse(raw);
  assert.equal(kept.suggestion?.text, '等会话进店后再判', '盘上建议原样保留，留给首次 pull 对账');
  await root[Symbol.asyncDispose]?.();
}

// —— 5. pull 应答：客户端请求某会话权威状态（含会话不存在时的兜底）——
{
  const medium = makeMedium();
  const { root, captured } = await bootProcess(medium, { sessionId: SESSION, turns: 2, userTexts: ['甲', '乙'] });
  const scope = captured.scope;

  // 模拟 client 写入 pull 请求
  await root.settings.update('suggest-ghost', {
    _ops: JSON.stringify({ rev: 1, ops: [{ op: 'pull', sessionId: SESSION }] }),
  });
  await sleep(30);
  const p = pushed(captured);
  assert.equal(p.historySessionId, SESSION, 'pull 应应答该会话历史');
  assert.deepEqual(p.history, ['甲', '乙']);
  assert.equal(JSON.parse(scope.get()._ops ?? 'null'), null, 'pull 消费后应清空 _ops');

  // 会话不存在：仍应答应（不能静默丢弃），只是省略 history
  await root.settings.update('suggest-ghost', {
    _ops: JSON.stringify({ rev: 2, ops: [{ op: 'pull', sessionId: 'no-such-session' }] }),
  });
  await sleep(30);
  const after = pushed(captured);
  assert.notEqual(after.historySessionId, 'no-such-session', '未知会话不应谎报历史归属');
  await root[Symbol.asyncDispose]?.();
}

console.log('✅ coldstart e2e：重启对账 / 陈旧作废 / 懒恢复不覆盖 / pull 应答 全部通过');
