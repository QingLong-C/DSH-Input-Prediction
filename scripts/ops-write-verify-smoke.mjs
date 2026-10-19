/**
 * 远程 settings 写入的**兑现值判定**冒烟（Gitea #16 的离线证明）。
 *
 * #16 的现象是「日志显示 mutate OK，但宿主侧 `describe()` 读到的 `_ops` 永远停在
 * boot 初值」。主修（`a866545`）把 `expectedRevision` 从常量 0 换成 describe 现取，
 * 但**判定层没修**：`writeOps` 至今是 `.then(() => true)`，把远程面的失败信封读成
 * 成功。这个文件测的就是那一层——纯函数 `settings-result.ts`，不需要宿主、不需要
 * 浏览器，所以 #16 的这条闭环第一次有了能跑第二遍的证据。
 *
 * 运行：`node scripts/ops-write-verify-smoke.mjs`（本模块零依赖，`.ts` 直接可剥类型运行；
 * 不像 hotness-store 那种带 `.js` 说明符的 src 模块要走 lib/）。
 */
import assert from 'node:assert/strict';
import {
  isConflictRefusal,
  readRejection,
  settleWriteVerdict,
  unwrapMutateResult,
  verdictFromView,
} from '../src/client/settings-result.ts';

const SENT = '{"rev":3,"ops":[{"op":"pull","sessionId":"s1"}]}';
const EXPECTED = 12;

/** 成功信封（0.2.x 形态：`RemoteResult<SettingsNamespaceView>`）。 */
const okView = (revision, ops) => ({ ok: true, value: { ns: 'suggest-ghost', revision, value: { _ops: ops, _push: 'null' } } });

// —— 1. 载荷还在盘上：最强证据 ——
assert.equal(settleWriteVerdict(okView(13, SENT), EXPECTED, SENT), 'landed');

// —— 2. host 已抢先消费并清空 `_ops`：靠 revision 已动确认 ——
assert.equal(
  settleWriteVerdict(okView(14, 'null'), EXPECTED, SENT),
  'landed',
  'host 消费后清空是正常态，不能被误判成没落盘',
);

// —— 3. #16 的签名：远程报成功，但盘上既不是我们的载荷、计数也没动 ——
assert.equal(
  settleWriteVerdict(okView(12, 'null'), EXPECTED, SENT),
  'unsettled',
  '「ok:true + 计数没动 + 盘上不是我们的值」必须判成未落地，这是 #16 的假成功',
);

// —— 4. 冲突信封：远程面**不 reject**，失败在兑现值里（本轮修复的核心断言）——
{
  const conflict = {
    ok: false,
    error: {
      code: 'settings/conflict',
      message: 'settings namespace "suggest-ghost" changed since it was read (expected revision 12, now 13)',
      details: { ns: 'suggest-ghost', expected: 12, actual: 13 },
    },
  };
  assert.equal(
    settleWriteVerdict(conflict, EXPECTED, SENT),
    'refused-conflict',
    '冲突必须落到可重试分支——旧代码在这里 return true',
  );
  // 同一条错误如果按 Promise 状态判（修复前的判据），会被当成成功：
  assert.notEqual(settleWriteVerdict(conflict, EXPECTED, SENT), 'landed');
}

// —— 5. 非冲突拒绝不许误升成可重试冲突 ——
{
  const refused = { ok: false, error: { code: 'settings/rejected', message: 'Config field "_ops" is not volatile' } };
  assert.equal(settleWriteVerdict(refused, EXPECTED, SENT), 'refused-other');
  // 报文里带 "revision" 但码是别的：有码就只按码判，文本不得越权。
  const tricky = { ok: false, error: { code: 'gateway/internal', message: 'writer revision mismatch internally' } };
  assert.equal(
    settleWriteVerdict(tricky, EXPECTED, SENT),
    'refused-other',
    '有稳定码时文本兜底必须让位，否则不可重试的拒绝会被重试两轮',
  );
}

// —— 6. host 重启后计数归零：判据取「动了」而不是「变大了」，不得假报警 ——
assert.equal(settleWriteVerdict(okView(0, 'null'), 461, SENT), 'landed');

// —— 7. 老代次形态：没有 ok 判别式，兑现值直接就是命名空间视图 ——
assert.equal(settleWriteVerdict({ ns: 'suggest-ghost', revision: 13, value: { _ops: SENT } }, EXPECTED, SENT), 'landed');
assert.equal(settleWriteVerdict({ ns: 'suggest-ghost', revision: 12, value: { _ops: 'null' } }, EXPECTED, SENT), 'unsettled');

// —— 8. 传输层多包一层 server-response ——
assert.equal(settleWriteVerdict({ result: okView(13, SENT) }, EXPECTED, SENT), 'landed');

// —— 9. 认不出来的形态（void / 裸字符串 / null）：判 unreadable，交给调用方补一次读回 ——
for (const weird of [undefined, null, 'ok', 42, {}]) {
  assert.equal(settleWriteVerdict(weird, EXPECTED, SENT), 'unreadable', `${String(weird)} 不该被当成成功`);
}
// 读回也读不出东西时，verdictFromView 给 unreadable（而不是 settled=true）
assert.equal(verdictFromView(undefined, EXPECTED, SENT), 'unreadable');
assert.equal(verdictFromView({ value: { _ops: SENT } }, EXPECTED, SENT), 'landed');

// —— 10. 解包层：失败信封的 code/message 必须取得到（details 也在，供以后按 expected/actual 打点）——
{
  const outcome = unwrapMutateResult({ ok: false, error: { code: 'settings/conflict', message: 'm', details: { expected: 1, actual: 2 } } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'settings/conflict');
  assert.equal(outcome.message, 'm');
  // 老 host 把错误压成裸字符串：message 仍要取得到，文本兜底才有料可用。
  const bare = unwrapMutateResult({ ok: false, error: 'settings namespace changed' });
  assert.equal(bare.message, 'settings namespace changed');
}

// —— 11. 冲突判据：两个码都认（远程 `settings/conflict` + 内核 `SETTINGS_CONFLICT`），无码才回落文本 ——
assert.equal(isConflictRefusal('settings/conflict', undefined), true);
assert.equal(isConflictRefusal('SETTINGS_CONFLICT', undefined), true);
assert.equal(isConflictRefusal(undefined, 'changed since it was read (expected revision 12, now 13)'), true, '无码时文本兜底必须仍然可用');
assert.equal(isConflictRefusal(undefined, 'connection reset'), false);
assert.equal(isConflictRefusal('settings/rejected', 'expected revision 12'), false, '有码就必须只按码判');

// —— 12. reject 分支（装配故障）的取值面 ——
assert.deepEqual(readRejection(new Error('client api: settings/mutate expected 3 argument(s), got 2')), {
  code: undefined,
  message: 'client api: settings/mutate expected 3 argument(s), got 2',
});
assert.deepEqual(readRejection({ code: 'SETTINGS_CONFLICT', message: 'boom' }), { code: 'SETTINGS_CONFLICT', message: 'boom' });
assert.deepEqual(readRejection('plain string'), { code: undefined, message: 'plain string' });

console.log('ops-write-verify smoke: 兑现值判定 12 组断言通过（含 #16 的假成功签名与冲突重试分诊）');
