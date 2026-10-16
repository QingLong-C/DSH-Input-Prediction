// 冷启动语义 smoke：建议回读的结构校验 + 语义校验（回合归属）+ 历史环的
// 按需物化/增量追加。纯函数断言，不需要 host 服务。
// 用法：node --experimental-strip-types scripts/coldstart-smoke.mjs
import assert from 'node:assert/strict';
import {
  appendToRing,
  lastCompletedTurnInLog,
  nextTrackedSuggestion,
  parsePersistedPush,
  RING_CAPACITY,
  seedRingFromLog,
  suggestionFieldsFor,
  suggestionIsCurrent,
  userTextOfEvent,
} from '../src/coldstart.ts';

/** 造一条 user/message 事件（只带该层用到的字段）。 */
function userMessage(seq, text, sourceKind = 'user') {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: { content: [{ type: 'text', text }], source: { kind: sourceKind } },
  };
}

/** 造一条 turn/end 事件。 */
function turnEnd(seq, turn, kind = 'completed') {
  return { type: 'turn/end', seq, time: 0, data: { turn, reason: { kind } } };
}

/** 造一个最小 session 视图（只实现 sessionEvents 用到的读取面）。 */
function sessionOf(events) {
  return { snapshotEvents: () => events, id: 'session-x' };
}

const suggestion = (turn, text = '跑一下测试') => ({
  version: 1,
  turn,
  baseSeq: 3,
  text,
  truncated: false,
  acceptKey: 'Tab',
});

// —— 1. userTextOfEvent：只收 source.kind === 'user' 的文本块 ——
{
  assert.equal(userTextOfEvent(userMessage(1, '  部署服务  ')), '部署服务', '应 trim');
  assert.equal(userTextOfEvent(userMessage(2, '注入', 'system')), null, '非 user 来源应跳过');
  assert.equal(userTextOfEvent(userMessage(3, '   ')), null, '空白应跳过');
  assert.equal(userTextOfEvent(userMessage(4, '<system-reminder>x</system-reminder>')), null, '系统提醒包装应跳过');
  assert.equal(userTextOfEvent(turnEnd(5, 1)), null, '非 user/message 事件应跳过');
  assert.equal(userTextOfEvent(userMessage(6, 'x'.repeat(2001))), null, '超长文本应跳过');
}

// —— 2. seedRingFromLog：时间序 + 相邻重复只计一次 ——
{
  const events = [
    userMessage(1, '第一句'),
    userMessage(2, '第一句'), // 相邻重复：跳过
    turnEnd(3, 1),
    userMessage(4, '第二句'),
    userMessage(5, '第一句'), // 非相邻重复：保留
    userMessage(6, '  '), // 空白：跳过
  ];
  assert.deepEqual(seedRingFromLog(sessionOf(events)), ['第一句', '第二句', '第一句']);
}

// —— 3. lastCompletedTurnInLog：只认 completed ——
{
  assert.equal(lastCompletedTurnInLog(sessionOf([])), 0, '无回合 = 0');
  assert.equal(lastCompletedTurnInLog(sessionOf([
    turnEnd(1, 1),
    turnEnd(2, 2, 'cancelled'),
    turnEnd(3, 3),
  ])), 3, '取最大的 completed 回合');
  assert.equal(lastCompletedTurnInLog(sessionOf([
    turnEnd(1, 5),
    turnEnd(2, 4, 'cancelled'),
  ])), 5, '被取消的更晚回合不参与');
}

// —— 4. suggestionIsCurrent：语义判据（这是重启后「建议还在不在」的唯一依据）——
{
  const log = sessionOf([turnEnd(1, 1), turnEnd(2, 2)]);
  assert.equal(suggestionIsCurrent(suggestion(2), log), true, '回合仍是最后已完成回合 → 有效');
  assert.equal(suggestionIsCurrent(suggestion(1), log), false, '会话已推进到回合 2 → 回合 1 的建议陈旧');
  assert.equal(suggestionIsCurrent(null, log), false, '无建议');
  assert.equal(suggestionIsCurrent(suggestion(2), undefined), false, '会话不存在 → 作废');
}

// —— 5. parsePersistedPush：结构校验（盘上内容不可信）——
{
  const good = JSON.stringify({ rev: 7, suggestion: suggestion(2), suggestionSessionId: 'session-a' });
  assert.deepEqual(parsePersistedPush(good), { suggestion: suggestion(2), sessionId: 'session-a' });
  assert.equal(parsePersistedPush(good).suggestion.version, 1, '回读时补齐 version');

  assert.deepEqual(parsePersistedPush(undefined), { suggestion: null, sessionId: null });
  assert.deepEqual(parsePersistedPush(''), { suggestion: null, sessionId: null });
  assert.deepEqual(parsePersistedPush('null'), { suggestion: null, sessionId: null }, 'EMPTY_PUSH');
  assert.deepEqual(parsePersistedPush('{ 坏 JSON'), { suggestion: null, sessionId: null }, '解析失败');
  assert.deepEqual(parsePersistedPush('[]'), { suggestion: null, sessionId: null }, '非对象');

  // 有建议无会话 id：保留 id 为 null，建议作废（无从判断归属）
  const noSession = JSON.stringify({ suggestion: suggestion(2) });
  assert.deepEqual(parsePersistedPush(noSession), { suggestion: null, sessionId: null });

  // 字段级防御：逐项破坏都应降级为「无建议」而不是抛错
  for (const patch of [
    { turn: -1 }, { turn: 1.5 }, { turn: '2' },
    { baseSeq: -1 }, { text: '' }, { text: 42 },
    { truncated: 'no' }, { acceptKey: '' }, { acceptKey: null },
  ]) {
    const raw = JSON.stringify({
      suggestion: { ...suggestion(2), ...patch },
      suggestionSessionId: 'session-a',
    });
    const got = parsePersistedPush(raw);
    assert.equal(got.suggestion, null, `畸形字段应作废：${JSON.stringify(patch)}`);
    assert.equal(got.sessionId, 'session-a', '会话 id 仍应保留（供上层区分「无建议」与「会话未知」）');
  }
}

// —— 6. appendToRing：增量维护（相邻去重 + 容量截断）——
{
  const ring = ['a'];
  assert.equal(appendToRing(ring, 'a'), false, '相邻重复不入环');
  assert.deepEqual(ring, ['a']);
  assert.equal(appendToRing(ring, 'b'), true);
  assert.deepEqual(ring, ['a', 'b']);

  const big = [];
  for (let i = 0; i < RING_CAPACITY + 5; i += 1) appendToRing(big, `词-${i}`);
  assert.equal(big.length, RING_CAPACITY, '容量硬上限');
  assert.equal(big[big.length - 1], `词-${RING_CAPACITY + 4}`, '保留最新');
  assert.equal(big[0], '词-5', '从头部截断最旧');
}

// —— 7. 冷启动组合语义：重启后「历史立刻可用」且「建议按回合归属决定去留」——
{
  // 进程 A：会话跑到回合 2，建议为回合 2 生成并落盘（模拟 settings.yaml 的 _push）
  const events = [userMessage(1, '部署服务'), turnEnd(2, 1), userMessage(3, '查日志'), turnEnd(4, 2)];
  const persisted = JSON.stringify({ suggestion: suggestion(2), suggestionSessionId: 's' });

  // 进程 B（重启）：会话已进店 → 历史按需物化即可用，建议语义校验通过 → 保留
  const live = sessionOf(events);
  const restored = parsePersistedPush(persisted);
  assert.deepEqual(seedRingFromLog(live), ['部署服务', '查日志'], '历史无需任何播种时机');
  assert.equal(suggestionIsCurrent(restored.suggestion, live), true, '重启后建议仍在有效期');

  // 若磁盘上的建议属于更早的回合（会话在停机前又推进过）→ 判为陈旧
  const stale = parsePersistedPush(JSON.stringify({ suggestion: suggestion(1), suggestionSessionId: 's' }));
  assert.equal(suggestionIsCurrent(stale.suggestion, live), false, '旧回合建议应作废');
}

// —— 8. nextTrackedSuggestion：产出即取代；作废只作废自己的 ——
{
  const none = { suggestion: null, sessionId: null };
  // 产出：直接取代（跨会话也取代——它才是「最新」那条）
  const a = nextTrackedSuggestion(none, 's-a', suggestion(1, 'A 的建议'));
  assert.deepEqual(a, { suggestion: suggestion(1, 'A 的建议'), sessionId: 's-a' });
  const b = nextTrackedSuggestion(a, 's-b', suggestion(2, 'B 的建议'));
  assert.equal(b.sessionId, 's-b', 'B 的新建议取代 A');
  // 作废别人的建议：不影响被追踪者（这是「另一会话生成失败」的场景）
  assert.deepEqual(nextTrackedSuggestion(b, 's-a', null), b, '作废 A 不应抹掉 B 的追踪');
  // 作废自己的建议：清空
  assert.deepEqual(nextTrackedSuggestion(b, 's-b', null), none, '作废自己的建议应清空追踪');
  // 无追踪时的作废：无变化
  assert.deepEqual(nextTrackedSuggestion(none, 's-a', null), none);
}

// —— 9. suggestionFieldsFor：pull 别的会话不能弄丢仍在有效期的建议 ——
{
  const trackedA = { suggestion: suggestion(1, 'A 的建议'), sessionId: 's-a' };
  // pull A：本会话校验通过 → 用本会话的
  assert.deepEqual(
    suggestionFieldsFor(trackedA, 's-a', trackedA.suggestion),
    { suggestion: trackedA.suggestion, sessionId: 's-a' },
  );
  // pull B（B 无建议）：保留 A 的建议 + A 的归属，client 守卫会隐藏它
  assert.deepEqual(
    suggestionFieldsFor(trackedA, 's-b', null),
    { suggestion: trackedA.suggestion, sessionId: 's-a' },
    'pull 无建议的会话不得抹掉别的会话的建议',
  );
  // pull A 但校验判定陈旧：A 自己的作废，且不误带别的会话
  assert.deepEqual(
    suggestionFieldsFor(trackedA, 's-a', null),
    { suggestion: null, sessionId: null },
    '本会话建议陈旧应作废',
  );
  // 无特定会话（仅刷新热度）：仍带上被追踪的建议，归属不变
  assert.deepEqual(
    suggestionFieldsFor(trackedA, null, null),
    { suggestion: trackedA.suggestion, sessionId: 's-a' },
  );
  // 完全没有建议：干净的空字段
  assert.deepEqual(
    suggestionFieldsFor({ suggestion: null, sessionId: null }, 's-a', null),
    { suggestion: null, sessionId: null },
  );
}

// —— 10. 端到端语义链：重启 → 对账 → pull 应答 ——
{
  // 停机前：会话跑到回合 2，建议为回合 2 生成，落盘在 settings 的 _push
  const events = [userMessage(1, '第一句'), turnEnd(2, 1), userMessage(3, '第二句'), turnEnd(4, 2)];
  const live = sessionOf(events);
  const persisted = parsePersistedPush(
    JSON.stringify({ suggestion: suggestion(2), suggestionSessionId: 's' }),
  );

  // 启动对账：会话已进店、语义有效 → 恢复追踪（不产生任何 LLM 调用）
  let tracked = { suggestion: null, sessionId: null };
  if (suggestionIsCurrent(persisted.suggestion, live)) {
    tracked = nextTrackedSuggestion(tracked, persisted.sessionId, persisted.suggestion);
  }
  assert.equal(tracked.sessionId, 's', '重启后建议被恢复而非清空');

  // 历史同样无需等待：按需物化即可
  assert.deepEqual(seedRingFromLog(live), ['第一句', '第二句']);

  // 于是「打开页面」这一拍就能给出完整的 pull 应答
  const fields = suggestionFieldsFor(tracked, 's', tracked.suggestion);
  assert.deepEqual(fields, { suggestion: suggestion(2), sessionId: 's' });
}

console.log('✅ coldstart 冒烟测试通过（结构校验/语义校验/按需物化/增量维护/跨会话追踪）');