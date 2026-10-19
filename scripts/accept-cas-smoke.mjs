// 采纳写入 CAS 守卫冒烟测试（Gitea #4：消除「采纳建议」读-改-写竞态）。
// 运行：node scripts/accept-cas-smoke.mjs
//
// 覆盖四件事：
//  1. 竞态本身——草稿在「计算 accepted」与「setDraft」之间被改动时，写入**不
//     发生**、返回已放弃、幽灵隐藏，用户的新输入原样留在草稿里；
//  2. 未竞态时行为与改动前逐字符一致（含 `/later +3m 我` 这类斜杠命令整行
//     还原）——用旧实现的字面拷贝当回归预言（oracle）做等价比对；
//  3. 逐词采纳（→）走的是同一条判据；
//  4. 宿主 face 没有 draftRev 时退化为内容等值比对（退化方案的判据也在此测）。
import assert from 'node:assert/strict';
import {
  acceptTarget,
  buildFullAccept,
  buildWordAccept,
  commitDraftIfPristine,
  draftDriftReason,
  isDraftPristine,
  readDraftSnapshot,
  wordAcceptSettled,
  wordMatchBase,
} from '../src/client/accept-guard.ts';
import { stripCommandPrefix } from '../src/client/history.ts';
import { nextAcceptChunk } from '../src/client/chunk.ts';

// ── 假输入机 face：形态与宿主 SessionInput 在本插件用到的子集一致 ──────────
// withRev=false 模拟不提供 draftRev 的老宿主 face（退化方案）。
function makeFace(initialDraft, { withRev = true } = {}) {
  let rev = 7;
  let snapshot = withRev ? { draft: initialDraft, draftRev: rev } : { draft: initialDraft };
  const wrote = [];
  const publish = (draft) => {
    if (withRev) { rev += 1; snapshot = { draft, draftRev: rev }; }
    else snapshot = { draft };
  };
  return {
    wrote,
    get draft() { return snapshot.draft; },
    get rev() { return withRev ? rev : undefined; },
    state: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    setDraft: (text) => { wrote.push(text); publish(text); },
    /** 模拟用户键击：原生输入先落到编辑器并发布 store（rev 推进）。 */
    type: (chars) => { publish(snapshot.draft + chars); },
    /** 模拟宿主推进修订号而不改文本（引用 chip 投影变化那一类）。 */
    bumpRev: () => { publish(snapshot.draft); },
  };
}

// ── 旧实现（改动前 src/client/index.ts onKeyDown 的字面拷贝）：回归预言 ─────
function legacyFullAccept(content, draftNow) {
  let accepted;
  if (content.kind === 'llm') {
    accepted = content.text;
  } else if (content.kind === 'inline') {
    accepted = content.full;
  } else {
    const contentDraft = stripCommandPrefix(draftNow);
    const head = contentDraft === ''
      ? draftNow
      : draftNow.slice(0, draftNow.length - contentDraft.length);
    const tailJoiner = head.endsWith(' ') || head === '' ? '' : ' ';
    accepted = `${head}${tailJoiner}${content.full}`;
  }
  return accepted;
}
function legacyMatchBase(content, draftNow) {
  return content.kind === 'history' ? stripCommandPrefix(draftNow) : draftNow;
}
function legacyWordAccept(content, draftNow, matchBase, chunk) {
  let accepted;
  if (content.kind === 'history') {
    const head = matchBase === ''
      ? draftNow
      : draftNow.slice(0, draftNow.length - matchBase.length);
    const tailJoiner = head.endsWith(' ') || head === '' ? '' : ' ';
    accepted = `${head}${tailJoiner}${matchBase}${chunk}`;
  } else {
    accepted = draftNow + chunk;
  }
  return accepted;
}
function legacySettled(content, accepted) {
  const full = content.kind === 'llm' ? content.text : content.full;
  return accepted === full || (content.kind === 'history' && accepted.endsWith(full));
}

// ── 与 index.ts onKeyDown 等价的接线（薄接线：判据全在 accept-guard）──────
// 返回「是否写入 / 写入值 / 是否收幽灵」，用于断言竞态语义。
function tabAccept({ face, content, base, onBetween }) {
  const accepted = buildFullAccept(content, base.draft);
  if (onBetween !== undefined) onBetween(face);           // 读写之间用户又打了字
  const live = readDraftSnapshot(face.state.getSnapshot());
  const outcome = commitDraftIfPristine(base, live, () => { face.setDraft(accepted); });
  return { accepted, outcome, wrote: face.wrote.at(-1) ?? null, hidGhost: true };
}
function arrowAccept({ face, content, base, chunk, onBetween }) {
  const full = acceptTarget(content);
  const matchBase = wordMatchBase(content, base.draft);
  if (!full.startsWith(matchBase) || matchBase.length >= full.length) {
    return { skipped: true };
  }
  const piece = chunk ?? nextAcceptChunk(full.slice(matchBase.length));
  if (piece === '') return { skipped: true };
  const accepted = buildWordAccept(content, base.draft, matchBase, piece);
  if (onBetween !== undefined) onBetween(face);
  const live = readDraftSnapshot(face.state.getSnapshot());
  const outcome = commitDraftIfPristine(base, live, () => { face.setDraft(accepted); });
  // 放弃时 index 立即 hide + return；写入时沿用「吃干净才收」的既有判据。
  const hidGhost = outcome.committed ? wordAcceptSettled(content, accepted) : true;
  return { accepted, outcome, wrote: face.wrote.at(-1) ?? null, hidGhost };
}

const HISTORY = (draft, full) => ({ kind: 'history', prefix: draft, suffix: full.slice(draft.length), full });
const INLINE = (draft, suffix) => ({ kind: 'inline', prefix: draft, suffix, full: draft + suffix });
const LLM = (text) => ({ kind: 'llm', text, acceptKey: 'Tab' });

// ══ 1. 竞态：计算之后、写入之前草稿被外部改动 → 不写、已放弃、幽灵隐藏 ══
{
  const face = makeFace('/later +3m 我');
  const base = readDraftSnapshot(face.state.getSnapshot());
  const content = HISTORY(base.draft, '我重新部署了服务并跑一遍冒烟');
  const r = tabAccept({
    face,
    content,
    base,
    onBetween: (f) => f.type('的'),   // 用户又打了一个「的」：/later +3m 我的
  });
  assert.equal(r.outcome.committed, false, '草稿已变，本次采纳必须放弃');
  assert.equal(r.outcome.reason, 'draft-changed');
  assert.equal(r.wrote, null, '放弃时一个字符都不能写');
  assert.equal(r.hidGhost, true, '放弃时幽灵要收掉');
  assert.equal(face.draft, '/later +3m 我的', '用户的新输入必须原样留下');
}
// rev 单独漂移（文本巧合相同，chip 投影变了）同样放弃
{
  const face = makeFace('继续');
  const base = readDraftSnapshot(face.state.getSnapshot());
  face.bumpRev();
  const live = readDraftSnapshot(face.state.getSnapshot());
  assert.equal(isDraftPristine(base, live), false);
  assert.equal(draftDriftReason(base, live), 'rev-changed');
  let calls = 0;
  const outcome = commitDraftIfPristine(base, live, () => { calls++; });
  assert.equal(outcome.committed, false);
  assert.equal(calls, 0, 'rev 漂移不得写入');
}
// 逐词采纳受同一条判据保护
{
  const face = makeFace('帮我写个');
  const base = readDraftSnapshot(face.state.getSnapshot());
  const content = HISTORY(base.draft, '帮我写个单元测试');
  const r = arrowAccept({ face, content, base, chunk: '单元', onBetween: (f) => f.type('报告') });
  assert.equal(r.outcome.committed, false, '逐词采纳同样受 CAS 保护');
  assert.equal(r.outcome.reason, 'draft-changed');
  assert.equal(r.wrote, null);
  assert.equal(r.hidGhost, true);
  assert.equal(face.draft, '帮我写个报告', '逐词放弃不得吞掉「报告」');
}
// LLM 整条覆盖：草稿在幽灵显示后被改动 → 覆盖也被拦住
{
  const face = makeFace('');
  const base = readDraftSnapshot(face.state.getSnapshot());
  const content = LLM('重新部署一下服务');
  const r = tabAccept({ face, content, base, onBetween: (f) => f.type('先看下日') });
  assert.equal(r.outcome.committed, false);
  assert.equal(r.wrote, null);
  assert.equal(face.draft, '先看下日', 'LLM 建议不得覆盖用户已输入的文字');
}

// ══ 2. 无竞态：草稿未变 → 写入发生，且与旧实现逐字符一致 ══
{
  const face = makeFace('帮我写个');
  const base = readDraftSnapshot(face.state.getSnapshot());
  const content = HISTORY(base.draft, '帮我写个单元测试');
  const r = tabAccept({ face, content, base });
  assert.equal(r.outcome.committed, true);
  assert.equal(r.outcome.reason, null);
  assert.equal(r.wrote, '帮我写个单元测试');
  assert.equal(face.draft, '帮我写个单元测试');
}
// 斜杠命令整行还原 / 各形态：与旧实现逐字符等价
{
  const cases = [
    ['/later +3m 我', '我重新部署了服务并跑一遍冒烟'],
    ['/later +3m ', '我重新部署了服务'],
    ['/later +3m', '我重新部署了服务'],
    ['/later', '我重新部署了服务'],
    ['/schedule 明天9点 检查构建', '检查构建日志再决定要不要回滚'],
    ['/schedule   明天9点   检查构建', '检查构建日志'],
    ['/later 我', '我要提交代码'],
    ['', '整条建议覆盖空草稿'],
    ['帮我写个', '帮我写个单元测试'],
    ['  多   空格 的草稿', '多   空格 的草稿后面接候选'],
    ['npm run build', 'npm run build --watch'],
    ['/later +3m 我', '我们'],
    ['a', 'abcdef'],
    ['/x 1', '123'],
  ];
  for (const [draft, full] of cases) {
    const face = makeFace(draft);
    const base = readDraftSnapshot(face.state.getSnapshot());
    assert.equal(
      buildFullAccept(HISTORY(draft, full), base.draft),
      legacyFullAccept(HISTORY(draft, full), draft),
      `history 整条采纳不等价: draft=${JSON.stringify(draft)}`,
    );
    // 无竞态时整条采纳确实落盘
    const r = tabAccept({ face, content: HISTORY(draft, full), base });
    assert.equal(r.outcome.committed, true);
    assert.equal(face.draft, r.accepted);
    // 逐词采纳：每个片段都与旧实现等价
    let matchBase = legacyMatchBase(HISTORY(draft, full), draft);
    let guard = 0;
    while (full.startsWith(matchBase) && matchBase.length < full.length && guard++ < 50) {
      const piece = nextAcceptChunk(full.slice(matchBase.length));
      if (piece === '') break;
      const mine = buildWordAccept(HISTORY(draft, full), draft, matchBase, piece);
      assert.equal(
        mine,
        legacyWordAccept(HISTORY(draft, full), draft, matchBase, piece),
        `history 逐词采纳不等价: draft=${JSON.stringify(draft)} matchBase=${JSON.stringify(matchBase)}`,
      );
      assert.equal(
        wordAcceptSettled(HISTORY(draft, full), mine),
        legacySettled(HISTORY(draft, full), mine),
      );
      matchBase = matchBase + piece;
    }
  }
  // inline / llm 两形态等价
  for (const draft of ['', 'npm run ', '/later +3m 我', '   ']) {
    const inline = INLINE(draft, 'and push it');
    assert.equal(buildFullAccept(inline, draft), legacyFullAccept(inline, draft));
    assert.equal(buildFullAccept(inline, draft), inline.full);
    const llm = LLM('下一条建议全文');
    assert.equal(buildFullAccept(llm, draft), legacyFullAccept(llm, draft));
    assert.equal(buildFullAccept(llm, draft), llm.text);
    for (const piece of ['片', 'ab']) {
      assert.equal(buildWordAccept(inline, draft, draft, piece), legacyWordAccept(inline, draft, draft, piece));
      assert.equal(buildWordAccept(llm, draft, draft, piece), legacyWordAccept(llm, draft, draft, piece));
    }
  }
}

// ══ 3. 逐词采纳：无竞态时行为不变（含命令整行回填、吃干净收幽灵）══════════
{
  const face = makeFace('/later +3m 我');
  const base = readDraftSnapshot(face.state.getSnapshot());
  const content = HISTORY(base.draft, '我重新部署了服务');
  const r = arrowAccept({ face, content, base, chunk: '重新' });
  assert.equal(r.outcome.committed, true);
  assert.equal(face.draft, '/later +3m 我重新', '命令前缀段必须随逐词采纳保留');
  assert.equal(r.hidGhost, false, '还有后缀未吃干净，幽灵不该收');
}
{
  const face = makeFace('帮我写个');
  const base = readDraftSnapshot(face.state.getSnapshot());
  const content = HISTORY(base.draft, '帮我写个');
  const r = arrowAccept({ face, content, base, chunk: '单元测试' });
  assert.equal(r.skipped, true, '后缀为空时不拦截（保留浏览器光标行为）');
  assert.equal(face.wrote.length, 0);
}

// ══ 4. face 无 draftRev → 退化为内容等值比对 ══════════════════════════════
{
  const face = makeFace('我重新', { withRev: false });
  const base = readDraftSnapshot(face.state.getSnapshot());
  assert.equal(base.rev, null, 'face 无 draftRev 时记为 null');
  // 文本未变 → 写入照常发生
  const ok = tabAccept({ face, content: HISTORY(base.draft, '我重新部署了服务'), base });
  assert.equal(ok.outcome.committed, true);
  assert.equal(face.draft, '我重新部署了服务');
  // 文本变了 → 放弃（退化方案仍能挡住用户输入被吞）
  const face2 = makeFace('我重新', { withRev: false });
  const base2 = readDraftSnapshot(face2.state.getSnapshot());
  const bad = tabAccept({
    face: face2,
    content: HISTORY(base2.draft, '我重新部署了服务'),
    base: base2,
    onBetween: (f) => f.type('一下'),
  });
  assert.equal(bad.outcome.committed, false);
  assert.equal(bad.outcome.reason, 'draft-changed');
  assert.equal(face2.draft, '我重新一下');
  // 退化方案下 rev 无从比对，仅文本判据生效
  assert.equal(isDraftPristine({ draft: 'a', rev: null }, { draft: 'a', rev: 3 }), true);
  assert.equal(isDraftPristine({ draft: 'a', rev: 3 }, { draft: 'b', rev: 3 }), false);
}
// 快照形态不完整也不抛错（保守降级为空草稿 + rev null）
{
  assert.deepEqual(readDraftSnapshot(undefined), { draft: '', rev: null });
  assert.deepEqual(readDraftSnapshot(null), { draft: '', rev: null });
  assert.deepEqual(readDraftSnapshot(42), { draft: '', rev: null });
  assert.deepEqual(readDraftSnapshot({ draft: 1, draftRev: 'x' }), { draft: '', rev: null });
  assert.deepEqual(readDraftSnapshot({ draft: 'a', draftRev: Number.NaN }), { draft: 'a', rev: null });
  // draft 与 draftRev 必须来自同一帧快照：只读一次对象
  let reads = 0;
  const once = { get draft() { reads++; return 'a'; }, draftRev: 1 };
  const face = { state: { getSnapshot: () => once }, setDraft: () => {} };
  readDraftSnapshot(face.state.getSnapshot());
  assert.equal(reads, 1, 'readDraftSnapshot 不得二次取草稿');
}

console.log('✅ accept-cas-smoke: 采纳 CAS 守卫（#4）全部通过');
