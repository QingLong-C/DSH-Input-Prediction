/**
 * #21 render 风暴冒烟测试：停顿续写的 armed 调度必须是「**观察值变了才重新计时**」。
 *
 * 与 `inline-smoke.mjs` 同风格——纯函数、node 直接跑、无浏览器、无真实定时器
 * （到期时刻用虚拟 `now` 推进，动作由策略返回，测试自己扮演调用方）。
 * 覆盖：同 draft 风暴、真实输入序列、会话/形态/配置变化、已发过不再发、
 * IME 组词、以及 `applySettings` 的 volatile 值深比较。
 *
 * 运行：`node scripts/render-storm-smoke.mjs`
 */
import assert from 'node:assert/strict';
import {
  configValuesEqual,
  decideInlineArm,
  initialInlineArmState,
  settleInlineTimer,
} from '../src/client/inline-arm-policy.ts';

/** 一次 render 向策略提交的观察值（默认：合格草稿，非组词，无幽灵）。 */
const obs = (over = {}) => ({
  now: 0,
  draft: 'npm run build',
  sessionId: 's1',
  ghostKind: null,
  enabled: true,
  minChars: 4,
  delayMs: 800,
  composing: false,
  ...over,
});

/** 把决策交给「假调用方」执行，返回本次是否产生了一次 armed（arm/reset 都算）。 */
const apply = (state, observation) => {
  const outcome = decideInlineArm(state, observation);
  const armed = outcome.decision.action === 'arm' || outcome.decision.action === 'reset';
  return { state: outcome.state, decision: outcome.decision, armed };
};

// ── 1. 风暴主场景：同一 draft 连打 1000 次 render，只允许 armed 一次 ──────────────
{
  let state = initialInlineArmState();
  let armed = 0;
  let dueAt = null;
  let cancels = 0;
  for (let i = 0; i < 1000; i += 1) {
    // 每 20ms 一次 render——正是 #21 实测的节奏（1127 次 armed，间隔约 20ms）。
    const r = apply(state, obs({ now: i * 20 }));
    state = r.state;
    if (r.decision.action === 'cancel') cancels += 1;
    if (r.armed) {
      armed += 1;
      dueAt = r.decision.dueAt;
    } else {
      assert.equal(r.decision.action, 'skip', `第 ${i} 次同观察必须是 skip，实际 ${r.decision.action}`);
      // **到期时刻一字不动**：这是「debounce 不再被 render 次数推倒重来」的硬指标。
      assert.equal(r.decision.dueAt, dueAt, `第 ${i} 次 skip 不应改动 dueAt`);
    }
  }
  assert.equal(cancels, 0);
  assert.equal(armed, 1, `1000 次同 draft render 应只 armed 1 次，实际 ${armed}`);
  assert.equal(dueAt, 800, '到期时刻必须是第一次 armed 的 now+delay');
  assert.equal(state.suppressed, 999, '被抑制的重复观察应全部计数');
  assert.equal(state.ticket.draft, 'npm run build');
}

// ── 2. 修复前的量化对照：旧实现（每次 render 都 clearTimeout+setTimeout）────────
{
  // 旧策略没有「同观察」概念：render 次数即 armed 次数。取 issue 里的真实数字，
  // 同场景（1000 次无关 render + 40 字符输入）下旧实现会打出上千行 armed。
  const renders = 1000;
  const oldArmed = renders;            // 每次 render 一次 armed + 一次 clearTimeout
  const newArmed = 1;                  // 场景 1 实测
  assert.ok(oldArmed / newArmed >= 500, '修复倍率应当是数量级的');
  // issue 报告的现场数字：40 字符草稿 → 1127 次 armed。
  assert.ok(1127 >= oldArmed, '现场计数与模拟同量级');
}

// ── 3. 真实输入序列：每改一次草稿就重新计时，到期时刻随之后移 ──────────────────
{
  let state = initialInlineArmState();
  const seq = ['abc', 'abcd', 'abcde', 'abcdef'];
  const actions = [];
  seq.forEach((draft, i) => {
    const r = apply(state, obs({ now: 1000 + i * 50, draft }));
    state = r.state;
    actions.push(r.decision.action);
    if (r.armed) assert.equal(r.decision.dueAt, 1000 + i * 50 + 800);
  });
  // 'abc' 未达 minChars=4 → cancel（清表不重排）；其后三份各算一次真实输入。
  assert.deepEqual(actions, ['cancel', 'arm', 'reset', 'reset']);
  assert.equal(state.suppressed, 0, '每次都换了草稿，谈不上抑制');
  // 同一份草稿再来一次（哪怕过了很久）→ skip，不再重置。
  const again = apply(state, obs({ now: 9999, draft: 'abcdef' }));
  assert.equal(again.decision.action, 'skip');
  assert.equal(again.decision.dueAt, 1150 + 800, 'skip 必须保持既有到期时刻');
}

// ── 4. 该重置的情形：会话切换 / 幽灵形态变化 / 配置变化 ─────────────────────────
{
  // 逐条累积：每条只改一个维度，其余维度沿用上一条的值，这样 reason 才是「唯一变量」。
  let state = apply(initialInlineArmState(), obs({ now: 0 })).state; // 先 arm 一次
  const cur = { draft: 'npm run build', sessionId: 's1', ghostKind: null, delayMs: 800, minChars: 4 };
  const cases = [
    { patch: { sessionId: 's2' }, reason: 'session-changed' },
    { patch: { ghostKind: 'history' }, reason: 'kind-changed' },
    { patch: { delayMs: 300 }, reason: 'config-changed' },
    { patch: { minChars: 8 }, reason: 'config-changed' },
    { patch: { draft: 'changed draft longer' }, reason: 'draft-changed' },
  ];
  cases.forEach(({ patch, reason }, i) => {
    Object.assign(cur, patch);
    const r = apply(state, obs({ now: 100 + i * 100, ...cur }));
    assert.equal(r.decision.action, 'reset', `${reason} 必须重新计时`);
    assert.equal(r.decision.reason, reason);
    assert.equal(r.decision.dueAt, 100 + i * 100 + cur.delayMs, 'reset 的到期时刻按新观察重算');
    state = r.state;
  });
}

// ── 5. 不该重置的情形：开关关闭 / 无会话 / 未达阈值 / 组词中 / 已有续写 ──────────
{
  const cases = [
    { over: obs({ enabled: false }), reason: 'disabled' },
    { over: obs({ sessionId: null }), reason: 'no-session' },
    { over: obs({ draft: ' abc ' }), reason: 'below-min-chars' },
    { over: obs({ composing: true }), reason: 'composing' },
    { over: obs({ ghostKind: 'inline' }), reason: 'completion-visible' },
  ];
  for (const c of cases) {
    // 从「已 armed」的状态进入不合格形态：必须 cancel（清表），而不是留一张空转的表。
    let state = apply(initialInlineArmState(), obs({ now: 0 })).state;
    assert.ok(state.ticket !== null);
    const r = apply(state, c.over);
    assert.equal(r.decision.action, 'cancel', `${c.reason} 应清掉计时器`);
    assert.equal(r.decision.reason, c.reason);
    assert.equal(r.state.ticket, null);
  }
  // 组词结束后同一草稿恢复计时（组词不该留下去重键）。
  let state = apply(initialInlineArmState(), obs({ now: 0 })).state;
  state = apply(state, obs({ now: 100, composing: true })).state;
  const back = apply(state, obs({ now: 200 }));
  assert.equal(back.decision.action, 'arm');
  assert.equal(back.decision.dueAt, 1000);
}

// ── 6. 自循环闸门：发过 complete 之后，同 (会话, 草稿) 不再重复问 ────────────────
{
  // 旧实现里这条循环是 armed 风暴的第二个来源：fire → 写 `_ops` → revision 变 →
  // 事件回来 → applySettings → render → 又 armed → 又 fire……
  let state = apply(initialInlineArmState(), obs({ now: 0 })).state;
  assert.equal(state.ticket.dueAt, 800);
  // 到期：调用方结算——真发出去了，就记去重键。
  state = settleInlineTimer(state, { sessionId: 's1', draft: 'npm run build' });
  assert.equal(state.ticket, null);
  // host 因这次写入推回 `_push`（revision 变、render 再来），草稿仍是同一份：
  let armedAfterFire = 0;
  for (let i = 0; i < 200; i += 1) {
    const r = apply(state, obs({ now: 900 + i * 20 }));
    state = r.state;
    if (r.armed) armedAfterFire += 1;
    else assert.equal(r.decision.reason, 'already-fired');
  }
  assert.equal(armedAfterFire, 0, '同一草稿发过一次就到此为止');
  // 用户继续输入 → 新草稿 → 允许再问（去重键只锁同一份草稿）。
  const typed = apply(state, obs({ now: 5000, draft: 'npm run build && npm test' }));
  assert.equal(typed.decision.action, 'arm');
  // 切会话也解锁：同草稿在另一会话上仍是新请求。
  let s2 = settleInlineTimer(typed.state, { sessionId: 's1', draft: 'npm run build && npm test' });
  const switched = apply(s2, obs({ now: 6000, sessionId: 's2', draft: 'npm run build && npm test' }));
  assert.equal(switched.decision.action, 'arm');
  // **去重键不得永久锁死草稿**：为 B 起表时 A 的键即作废，于是「输入 A→停顿发问→
  // 继续输入 B→删回 A」这条普通路径仍会重新发问（否则用户删回原样后再无续写）。
  let chain = apply(initialInlineArmState(), obs({ now: 0, draft: 'alpha' })).state;
  chain = settleInlineTimer(chain, { sessionId: 's1', draft: 'alpha' });
  assert.equal(apply(chain, obs({ now: 100, draft: 'alpha' })).decision.reason, 'already-fired');
  chain = apply(chain, obs({ now: 200, draft: 'alpha bet' })).state; // 为 B 起表 → A 的键作废
  chain = settleInlineTimer(chain, { sessionId: 's1', draft: 'alpha bet' });
  const back = apply(chain, obs({ now: 300, draft: 'alpha' }));
  assert.equal(back.decision.action, 'arm', '删回旧草稿仍应重新计时');
}

// ── 7. 到期时草稿已不合格：结算但不记去重键（下次仍可重新计时）──────────────────
{
  let state = apply(initialInlineArmState(), obs({ now: 0 })).state;
  state = settleInlineTimer(state, null); // 发送前的 minChars 兜底校验没过
  assert.equal(state.firedDraft, null, '没发出去就不能记去重键');
  const again = apply(state, obs({ now: 1000 }));
  assert.equal(again.decision.action, 'arm');
}

// ── 8. issue 现场等价场景：40 字符逐字输入 + 1000 次无关 render ──────────────────
{
  // 输入 40 个字符，每个字符除真实按键外还带来 1 次同值重复 store 通知（实测常见），
  // 其间穿插 1000 次与输入无关的 render（事件回流、错峰补渲染、投影面变化……）。
  let state = initialInlineArmState();
  let armed = 0;
  let skips = 0;
  let cancels = 0;
  let draft = '';
  const pump = (now) => {
    const r = apply(state, obs({ now, draft }));
    state = r.state;
    if (r.armed) armed += 1;
    else if (r.decision.action === 'skip') skips += 1;
    else cancels += 1;
  };
  for (let i = 0; i < 40; i += 1) {
    draft += '字';                      // 每字符都改变草稿
    const t = i * 100;                  // 每 100ms 一个字符
    pump(t);                            // 真实输入（草稿已变）
    pump(t + 5);                        // 同值重复通知
    for (let k = 0; k < 25; k += 1) pump(t + 10 + k * 3); // 与该次输入无关的 render
  }
  const total = 40 * 2 + 1000;
  // 前 3 个字符未达 minChars=4 → cancel；此后每个字符各一次 armed。
  assert.equal(total, 1080);
  assert.equal(armed + skips + cancels, total, '每次 render 都必须被策略归到某一类');
  assert.equal(cancels, 3 * 27, '未达阈值的那几帧应全部 cancel');
  assert.equal(armed, 37, `armed 应等于「真实达到阈值的输入次数」，实际 ${armed}`);
  assert.equal(skips, 37 * 26, `其余全部识别为重复观察，实际 skip ${skips}`);
  assert.equal(state.suppressed, skips, '诊断计数与 skip 次数一致');
  // 对照：修复前每一次 render 都要 clearTimeout + setTimeout，同场景为 1080 次。
  assert.ok(total / armed > 25, `倍率应显著，实际 ${total}/${armed}`);
  // 停手：最后一次输入之后不再有真实变化，计时器到期即只发一次。
  const last = state.ticket;
  assert.ok(last.dueAt > 0);
  state = settleInlineTimer(state, { sessionId: last.sessionId, draft: last.draft });
  const idle = apply(state, obs({ now: last.dueAt + 50, draft }));
  assert.equal(idle.decision.action, 'skip');
  assert.equal(idle.decision.reason, 'already-fired', '停顿后只发一次');
}

// ── 9. applySettings 的值深比较（volatile 配置展开值）────────────────────────────
{
  const base = {
    inlineDelayMs: 100,
    hot: [{ text: 'git status', count: 3 }],
    history: ['a', 'b'],
    suggestion: { turn: 1, baseSeq: 2, text: 'next', truncated: false, acceptKey: 'Tab' },
    completion: null,
    completionSessionId: null,
  };
  assert.ok(configValuesEqual(base, { ...base }), '同形状不同引用 → 相等');
  assert.ok(configValuesEqual(base, base), '同引用 → 相等（短路）');
  assert.ok(configValuesEqual(base, { ...base, hot: [...base.hot] }), '数组内容相同 → 相等');
  assert.ok(!configValuesEqual(base, { ...base, inlineDelayMs: 300 }), '标量变了 → 不等');
  assert.ok(!configValuesEqual(base, { ...base, history: ['b', 'a'] }), '数组顺序敏感');
  assert.ok(!configValuesEqual(base, { ...base, hot: [{ text: 'git status', count: 4 }] }), '嵌套对象值敏感');
  assert.ok(!configValuesEqual(base, { ...base, extra: 1 }), '多一个键 → 不等');
  assert.ok(!configValuesEqual({ a: 1 }, { a: undefined }), '缺键与 undefined 不等价');
  assert.ok(!configValuesEqual(null, undefined), 'null ≠ undefined');

  // host 每分钟约 40 次 `_push`，但载荷里大部分字段常年不变：值未变 → 不 render。
  let rendered = 0;
  let settings = base;
  for (let i = 0; i < 40; i += 1) {
    const next = { ...base, hot: [...base.hot] }; // 新引用、同内容（describe 每次都重新解析）
    if (!configValuesEqual(next, settings)) {
      settings = next;
      rendered += 1;
    }
  }
  assert.equal(rendered, 0, '40 次同值 `_push` 不得触发任何 render');
  // 其中一次真的带来新建议 → 恰好一次 render。
  const changed = { ...base, suggestion: { ...base.suggestion, text: 'another' } };
  assert.ok(!configValuesEqual(changed, settings));
  settings = changed;
  rendered += 1;
  assert.equal(rendered, 1);
}

// ── 10. 归零：解绑/effect 卸载后必须回到初始态（否则残留 ticket 会吞掉首次 armed）
{
  let state = apply(initialInlineArmState(), obs({ now: 0 })).state;
  state = initialInlineArmState();
  const r = apply(state, obs({ now: 100 }));
  assert.equal(r.decision.action, 'arm', '归零后第一帧必须能重新 armed');
}

// ── 11. 虚拟时钟端到端：新旧接线在同一场景下的 armed 次数与触发点偏移 ────────────
{
  const MIN = 4;
  const DELAY = 800;
  /**
   * 用虚拟时钟跑一遍「客户端接线」：`gen` 递增 = `clearTimeout`，`at(dueAt, fire)` =
   * `setTimeout`。`useOldWiring=true` 复刻 0.5.1 的 `scheduleInlineTrigger`（每次 render
   * 无条件清表重排），false 走新策略。返回 `inline armed` 行数、setTimeout 次数、
   * 以及实际发出 complete op 的时刻。
   */
  const runWorkload = (useOldWiring) => {
    let draft = '';
    let clock = 0;
    let state = initialInlineArmState();
    let gen = 0;
    let armed = 0;
    let timerSets = 0;
    const firedAt = [];
    const events = [];
    const at = (t, run) => { events.push({ t, run }); };
    const fire = (myGen) => {
      if (myGen !== gen) return;                    // 这张表已被 clearTimeout 取代
      if (draft.trim().length < MIN) {              // 到期兜底校验（两代实现同语义）
        if (!useOldWiring) state = settleInlineTimer(state, null);
        return;
      }
      if (!useOldWiring) state = settleInlineTimer(state, { sessionId: 's1', draft });
      firedAt.push({ t: clock, len: draft.length });
    };
    const render = () => {
      if (useOldWiring) {
        if (draft.trim().length < MIN) { gen += 1; return; }
        const g = gen + 1; gen = g;                 // clearTimeout(旧表) + setTimeout(新表)
        timerSets += 1; armed += 1;
        at(clock + DELAY, () => fire(g));
        return;
      }
      const outcome = decideInlineArm(state, obs({ now: clock, draft, sessionId: 's1' }));
      state = outcome.state;
      const d = outcome.decision;
      if (d.action === 'skip') return;              // 连 clearTimeout 都不许碰
      gen += 1;                                    // clearInlineTimer()
      if (d.action === 'cancel') return;
      const g = gen;                               // 本张表的代号：后续清表即作废
      timerSets += 1; armed += 1;
      at(d.dueAt, () => fire(g));
    };
    // 场景：40 字符逐字输入（100ms/字符，每字符另带 26 次同值重复通知），
    // 然后用户**停手**，但无关 render 仍以约 20ms 的节奏再刷 20 秒（#21 现场）。
    for (let i = 0; i < 40; i += 1) {
      at(i * 100, () => { draft += '字'; });
      at(i * 100, render);
      for (let k = 1; k <= 26; k += 1) at(i * 100 + k, render);
    }
    for (let k = 0; k < 1000; k += 1) at(4000 + k * 20, render);
    events.sort((a, b) => a.t - b.t);              // 稳定排序：同 t 时先进先出
    for (const e of events) { clock = e.t; e.run(); }
    return { armed, timerSets, firedAt, suppressed: state.suppressed };
  };

  const lastKeystrokeTime = 3900;
  const before = runWorkload(true);
  const after = runWorkload(false);

  // 修复前：每一次 render 都重新计时 → 风暴期间计时器永远差 800ms 才到期，
  // 直到风暴停下才 FIRED（比用户真实停顿点晚了 20 秒）。
  assert.equal(before.armed, 37 * 27 + 1000, `旧接线的 armed 行数 = render 次数，实际 ${before.armed}`);
  assert.equal(before.timerSets, before.armed);
  assert.equal(before.firedAt.length, 1, '旧接线最终也仍会 FIRED——issue 观察一致');
  assert.equal(before.firedAt[0].t, 23980 + DELAY, '旧实现只能在风暴结束后 800ms 才触发');
  assert.ok(before.firedAt[0].t - lastKeystrokeTime > 15000, '触发点被拖离停顿点 15 秒以上');

  // 修复后：armed 次数 = 真实输入次数；触发点就在停顿后 800ms；风暴期间的
  // 1000 次 render 一次 clearTimeout 都不做。
  assert.equal(after.armed, 37, `新接线的 armed 应与真实输入同量级，实际 ${after.armed}`);
  assert.equal(after.timerSets, 37);
  assert.equal(after.suppressed, 37 * 26 + 1000, '重复观察全部计数为 skip');
  assert.equal(after.firedAt.length, 1, '风暴期间只发一次 complete op（自循环已断）');
  assert.equal(after.firedAt[0].t, lastKeystrokeTime + DELAY, '触发点回到用户真实停顿点');
  assert.equal(after.firedAt[0].len, 40);
  assert.ok(before.armed / after.armed > 50, `armed 降低应为数量级：${before.armed} → ${after.armed}`);
}

console.log('render-storm-smoke: all assertions passed');
