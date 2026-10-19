# 内核语义陷阱：settings 双向通道与 volatile 引用

本插件与宿主之间只剩一条通道：settings 命名空间 `suggest-ghost` 上的两个 volatile
字符串字段（`_ops` 客户端到宿主，`_push` 宿主到客户端）。#16、#17、#18 三个缺陷
都长在通道语义上，而不是长在业务逻辑上，所以先看这一页再动手改代码。

描述的代码：`src/index.ts`、`src/client/index.ts`、`src/hotness-store.ts`、
`src/settings.ts`、`src/domain.ts`。

## 怎么读这份文档

行号与 diff 的核对基线是分支 `fix/issue-16-18-cleanup` 的提交 `1eb708d`。main 之后
删过两轮诊断输出（`6dfcd78` 删 console.log、`8e08e2e` 删 ctx.logger.info），行号有偏移，
按符号名定位比按行号可靠。本文随集成分支 `integrate/issues-2026-10` 前进时只更新各节的
「现状」段落，不重排全文行号；别的分支上读到行号对不上，先按符号名找。2026-10-19 本轮
（分支 `fix/issue-16-17-writeback`）的闭环部分：陷阱 1 已定性、新增「留痕通道」与「陷阱 1.5」
两节，文中「本轮」即指它。

| 标记 | 含义 |
|---|---|
| 已修 | 该代码在 `1eb708d` 上存在，本文核对过其 diff；未额外注明时不代表跑过运行时验证 |
| 待宿主验证 | 代码已合入，但未完成一次真实宿主重启后的端到端观察 |
| 内核契约 | 直接引自本机 `@deepseek-ai/dsh-settings@0.2.0-rc.2` 的源码行号（核对于 2026-10-19，换内核代次需重新核对） |
| 插件经验 | 只有本插件观测到过，内核源码与文档未确认；不要当作内核保证引用 |

## 通道长什么样

| 方向 | 载体 | 写入方 | 读取方 | 变更通知 |
|---|---|---|---|---|
| client → host | `_ops`（JSON 字符串，volatile 配置字段） | `remote.settings.mutate(ns, [{op:'set',path:['_ops'],value}], expectedRevision)`（`src/client/index.ts:1080`） | `settingsSvc.describe()` 取 `_ops`（`src/index.ts:268-291`） | `settings/document-updated(ns, revision)`（`src/index.ts:327`） |
| host → client | `_push`（同上） | `ctx.settings.update(ns, {_push})`（`src/index.ts:653`） | `remote.settings.describe()`（`src/client/index.ts:1219`） | 同一事件，经 `remote.$on` 转发（`src/client/index.ts:1302`） |

两个字段都是整值覆盖：没有队列、没有版本协商，最后一次写入决定读者看到什么。
`_ops` 之所以看起来像队列，是因为消费方读完立刻写回空值（`src/index.ts:730`），
单条载荷在盘上停留的时间取决于写入节奏，不取决于协议。

## 陷阱 1：`mutate` 的第三个参数是「我读到的 revision」，不是「我要覆盖的版本」

**症状**（插件经验 + 已修）：客户端调用 `mutate` 后 Promise 成功兑现，`_ops` 的值
却从未改变。排查时看到的现象是「写了，没报错，宿主没动」。修复前调用形态为
`svc.mutate(SETTINGS_NAMESPACE, [...], 0)`（`git show a864545`，被删的那一行）。

**根因**（内核契约）：`SettingsForms.write()` 在提交前比较期望版本与实际版本，
不相等就抛 `SettingsConflictError`：

```
node_modules/@deepseek-ai/dsh-settings/lib/index.js:511
  if (expected !== void 0 && descriptor.revision !== expected) throw new SettingsConflictError(...)
```

revision 不是持久计数，而是 `describe()` 每次调用时按内容指纹推导出来的变更计数，
首次为 0，此后每检测到一次变化加一：

```
lib/index.js:428
  const revision = previous === void 0 ? 0 : previous.revision + Number(previous.raw !== raw);
```

指纹包含 `entry.options.config`（`lib/index.js:421-425`），所以宿主自己写 `_push`、
消费完清空 `_ops`（`src/index.ts:653`、`src/index.ts:730`）都会推进它。结论：常量
`0` 只在「本进程启动后该命名空间从未变过」时成立，之后每一次 `expected=0` 的写入
都被拒。写入被拒和「值没变」在只读 Promise 状态的调用方看来是同一件事，于是表现为
假成功。

**正确用法**：先 `describe()` 取该 ns 的 `revision`，用它提交；冲突则重取重试。
`src/client/index.ts:1070-1094` 是现成实现。两点补充：

- 远程 `mutate` 成功时兑现的是整个 `SettingsNamespaceView`，其中带 `revision`
  （`@deepseek-ai/dsh-api-settings-controller@0.2.0-rc.2/lib/typert.remote-client.js:69,81`）。
  写完直接用它做写后确认，比再发一次 `describe()` 省一个往返。**本插件现在就是这么做的**
  （判定在 `src/client/settings-result.ts`，断言在 `scripts/ops-write-verify-smoke.mjs`）；
  修复前它被 `.then(() => true)` 整个忽略，这正是「假 OK」的来源。
- `SettingsConflictError` 带稳定机器码 `code = "SETTINGS_CONFLICT"`
  （`@deepseek-ai/dsh-settings/lib/index.js:165`）。现在代码靠
  `/conflict|revision/i` 匹配错误文本（`src/client/index.ts:1086`），能匹配上
  （报文在 `lib/index.js:176`，含 "revision" 一词），但文本是给人看的，码是给上层映射的。

**错误用法**：

```ts
// 被拒后静默，且每次写入都必然被拒
svc.mutate(ns, [{ op: 'set', path: ['_ops'], value }], 0);
```

`expectedRevision` 在本地 `SettingsForms` 接口里是可选的（`dsh-settings/lib/types/index.d.ts:114`），
省略即跳过比较（`lib/index.js:511` 的 `expected !== void 0`）。本插件源码注释记着一次
观测：远程层少传该参数会以 `settings/mutate expected 3 argument(s), got 2` 拒绝
（`src/client/index.ts:87-92`）。该报文在 0.2.0-rc.2 的本机产物里全文检索不到，而远程
schema 把该参数声明为 `undefined | number`（`typert.remote-client.js:67`）。按代次差异
处理，别按「必填」写死假设。

**当时的状态是未闭环**：本仓库拿不出证据指出那次 `resolve` 是在哪一层吞掉了内核的
reject（远程代理、typert 传输还是 `.then` 写法），因此下面三件事都缺。

> **2026-10-19 更新：这一条已闭环，吞掉 reject 的是 typert 远程面本身。**
> 内核的 `SettingsConflictError` 先在 `dsh-api-settings-controller/lib/index.js:489,501-507`
> 被**重新分类**成 `RemoteError`（码换成 `settings/conflict`，details 带
> `{ns, expected, actual}`，message 保留内核原文），再由
> `dsh-api-gateway/lib/client.js:1795-1802` 折进 `RemoteResult` 的 error 分支后
> **照常兑现**；`types.d.ts:60-73` 把契约写死了：「只有装配故障（参数元数、方法未挂载、
> 缺 Context 适配器）才 reject」。`rebuiltFailure`（`client.js:2124-2126`）原样重建
> `code`/`message`/`details`，所以**码是保留的，只是换了 taxonomy**——判冲突要认
> `settings/conflict`（远程形态）与 `SETTINGS_CONFLICT`（内核本地码）两个值，
> 内核自己的设置页也是这么分的（`dsh-client-ui-settings-models/lib/client.js:2795-2805`）。
> 结论：`mutate` 的 Promise 兑现状态**不含任何写入信息**，判落盘只能读兑现值里的
> `ok`；旧写法 `.then(() => true)` 因此把拒绝读成成功，`/conflict|revision/i` 那条
> 重试分支从来没有触发过。判定抽成纯函数在 `src/client/settings-result.ts`，
> 断言在 `scripts/ops-write-verify-smoke.mjs`。下面第 1 条（写后读回）已按此实现，
> 凭证取 `mutate` 成功时带回的写后 `SettingsNamespaceView`（`revision` + 整份 `value`），
> 所以是**零额外往返**；第 2 条（冲突显式分支）即上段的按码分诊。

三条缺口的现状：

1. **写后读回校验（已实现）**：`writeOps` 不再把兑现当成功。凭证取 `mutate` 成功时带回的
   写后 `SettingsNamespaceView`（`revision` + 整份 `value`），所以**零额外往返**；判据是
   「载荷还在盘上」**或**「revision 相对提交时动过」，两者都不成立判 `unsettled` 并留痕。
   形状参照设置卡片 scope 的 `readValue()`（写成功后重读本 ns 的 `row.value`）。
2. **冲突的显式分支（已实现）**：按稳定码分诊（`settings/conflict` / `SETTINGS_CONFLICT`），
   有码就不查文本；重试上限仍是 2 次，超限返回 `false`，调用方按「未送达」处理。
3. **运行时可读性（已实现，但通道换了）**：见下面「留痕通道」小节——`ctx.logger` 在这个
   宿主里**运行期一个字都不落盘**，写后判定如果只走 logger 就等于没写。

## 留痕通道：`[dsh-suggest-ghost][ops-trace]`

**grep 什么**：`grep '\[dsh-suggest-ghost\]\[ops-trace\]' ~/.dsh/dsh-web.log`

**为什么是 `console.log` 而不是 `ctx.logger`**（本机 `0.2.0-rc.2` 产物核对，2026-10-19；
issue #20 只记到了第 1 条的一半）：

1. 宿主全局**只注册了一个** logger exporter：`dsh-app-boot/lib/index.js:4053-4066`，
   `levels: { default: 2 }`（cordis 级别 error0 / info1 / warn2 / debug3，
   `cordis/lib/index.js:459-463`）挡掉 `debug`，回调体又是
   `if (type === "warn" || type === "error") startupLogs.push(...)` → **`info` 过了门也被丢**。
2. `startupLogs` 唯一的写盘机会是启动失败时的 `dsh/lib/bin.js:158 reportStartupFailure`
   （文件开头就是 `WARNING: Raw diagnostics...` + `StartupError: dsh: startup failed`）——
   所以 `~/.dsh/logs/startup-*.log` 是**崩溃转储**，不是运行日志。
3. 宿主 stdout 被 tee 进 `~/.dsh/dsh-web.log`，`console.log` 是运行期**唯一**可见面。

于是 main 连着两轮清理各删掉了什么：`6dfcd78`（删 console.log）删的是唯一的可观测面，
`8e08e2e`（删 ctx.logger.info）删的是本来就不存在的可观测面。本插件的 seam 在
`src/index.ts` 的 `traceOps` / `traceFault`：语义事件只走 `console.log`（带上面那个标记），
故障**额外**补一份 `ctx.logger.warn`，好在崩溃转储里也留一份。同类故障按 `kind` 节流
（第一次完整打，之后每 50 次一条带计数）——历史上 `_ops` 清空的 nested 拒绝一个进程
刷了 372 行同样的报文，那本身就是噪声；但一次都不打就又回到静默失败。

## 陷阱 1.5：在 `settings/document-updated` 的回调里再写 settings，内核会拒绝

**症状**（插件经验 + 本机日志计数）：`_ops` 消费后那次清空，历史上 373 次里 372 次报
`HMR transactions cannot be nested`，而当时错误分支是 `/* noop */`，所以没人知道。

**根因**（内核契约）：`SettingsForms.write()` 在 `configEditor.edit()` 的**回调内**调
`this.describe()` 做版本比较（`dsh-settings/lib/index.js:510`），而 `describe()` 就地
`emit("settings/document-updated", ns, revision)`（同文件 :435）。`edit` 由 `dsh-hmr` 的
`runExclusive` 串行化，事务标记来自 `executing.run(true, operation)`
（`dsh-hmr/lib/index.js:271,284`），入口判据是
`if (this.executing.getStore()) return Promise.reject(new Error("HMR transactions cannot be nested"))`（:280）。
→ 插件的事件回调**整个跑在事务上下文里**，回调里（含它的 await 续体）发起的任何 settings
写入都被拒。

**「排到下一个 tick」逃不掉**（本机实测，不是推测）：`executing` 是 `AsyncLocalStorage`，
上下文沿 await / `queueMicrotask` / **事务内建的 `setTimeout`** 继续传播，`getStore()` 仍是
`true`。只有**在事务之外建立的 async 上下文**才是 `undefined`（事务外创建的定时器，或事务外
`new AsyncResource()` 再 `runInAsyncScope`）。插件侧没有可靠的「事务外锚点」（`apply()` 本身
就可能跑在配置重载事务里），所以本仓库**没有**上排水队列，只做分诊留痕（`ops-clear-nested`
/ `push-nested` 两个 kind）。

**同一条链上的连带怀疑（未验证，已单独报 lead）**：`handleComplete` 由该回调同步调起，它的
LLM 续写 `await` 之后仍在同一个上下文里 → 那次 `pushToClient` 可能与 `_ops` 清空失败是
**同一个拒绝**。若成立，#18「ghost 永不显示」的真实原因在这，而不是载荷被下一次推送覆盖。
静态调用链（当前源码行号）：`src/index.ts:401` handler → `:411` `consumeOps` → `:871`
`handleComplete` → `:573` `generateCompletion(...).then(` → `:591` `pushToClient` →
`flushPush` → `settingsSvc.update`。定论需要运行时计数，即 `push landed` 与 `push-nested`
两条留痕的比例（这正是本轮补上留痕之后才能做的事）。

**上游待确认**：见 `docs/upstream-feedback-settings-proxy.md` 第二个诉求（显式退出事务，
或把 `document-updated` 改成事务外 emit）。

## 陷阱 2：TS 类型和 zod schema 是两份互不约束的真相

**症状**（插件经验）：客户端发出 `complete` 操作，宿主既不执行也不报错，日志里没有任何
一行提到这个载荷。

**根因**（已修，`git show 8e2e5c0`）：`_ops` 的校验用
`z.discriminatedUnion('op', [...])`，枚举里没有 `complete` 变体，`safeParse` 失败；
失败路径返回 `{ ops: [] }`，于是**整批操作**一起丢弃（不是只丢非法那一条，
`src/hotness-store.ts:263-268`）。而 `HotnessOp` 的 TS 联合类型里 `complete` 一直都在
（`src/domain.ts:59`）。两份声明放在不同文件，编译器不会因为它们不一致而报错。

**要点**：

- 加一个 op 变体要改三处：`src/domain.ts` 的 `HotnessOp`、`src/hotness-store.ts` 的
  `opsPayloadSchema`、`src/hotness-store.ts` 的 `applyOps` switch（`pull`/`complete`
  落 `default: break` 是有意的宽容，见 `src/hotness-store.ts:218-219`）。
- 兜底返回空值的那条路径必须有输出。`parseHotnessOps` 有三条返回空 ops 的路径：空载荷、
  JSON 解析失败、schema 拒绝。**三条的语义不同，留痕也不同**（本轮已按此实现）：
  空载荷是**正常态**（host 每次消费完都写回空值，`document-updated` 必然再读到它），
  不留痕——留了就成每次推送一条噪声；JSON 失败与 schema 拒绝是异常，必须留痕，
  schema 拒绝还要带 zod `issues` 摘要（#17 的直接教训：整批被拒却毫无线索）。
  做法是 `parseHotnessOps` 把原因当**数据**返回（`ParsedOpsResult.rejected`，
  `src/hotness-store.ts`），由 `consumeOps` 打印——解析函数是纯函数（无 ctx，也要被
  smoke 直接驱动），而 `consumeOps` 是两个调用点唯一的汇聚处，在这里打意味着
  「新增第三个调用点也自动带留痕」。通道见上面「留痕通道」小节。
- 同一个漂移还有第二个实例：`GhostPushPayload`（`src/settings.ts:41-64`）没有任何
  `completion` 字段，但宿主实际推的载荷带它（`src/index.ts:636-640`），客户端也确实读它
  （`src/client/index.ts:1239-1240`）。它之所以从不报错，只是因为没有任何代码把这个
  interface 用作类型约束（全仓检索仅出现在注释里）。改推送载荷时别指望它帮你检查。
- 测试覆盖：`scripts/inline-smoke.mjs` 只测续写的纯函数净化链，**不**覆盖这里。
  漂移断言在 `scripts/ops-schema-coverage-smoke.mjs`：变体清单**从 `src/domain.ts` 的
  `HotnessOp` 现解析**（不手抄名单——手抄的名单自己就是第三份会漂移的真相），逐个造
  合法载荷过真 `parseHotnessOps` 断言放行，再与 `hotnessSchemaVariants()`（从真 schema
  推导）做集合相等，还要每个变体都能找到消费方。反向验证做过：给 `HotnessOp` 加一个
  假变体 → 红（并报出 zod issues）；只往 schema 加假分支 → 也红。
  留痕本身另有断言（未知 op 被拒且 `rejected` 有值、空载荷**不**留痕）。

## 陷阱 3：单槽 last-wins 快照装不下「只存在一瞬间」的载荷

**症状**（插件经验，见 `git show bceac31` 正文）：停顿续写已经生成，客户端从不显示。
当时加的日志打出的观测是连续三个 revision 的 `_push` 里 `completion=no`（commit 正文
记录为 rev37/39/40）。

**根因**（结构性，不是窗口小）：三件事叠加，中间值在原理上就读不到。

1. `_push` 是整值覆盖（`src/index.ts:653`），一次续写产生的载荷只在盘上停留到下一次
   写入为止。而下一次写入由**任意会话**的活动触发（写入点见本节末尾的清单）。
2. 客户端的读法是「事件到达，然后异步 `describe()` 一次」（`src/client/index.ts:1302`
   → `src/client/index.ts:1219`）。它读的是发起读取那一刻的最新值，不是事件对应的那个值。
   被覆盖的中间值没有任何机制能让它重新出现。
3. 客户端还会主动丢弃多余读取：`describeInFlight` 期间的并发事件直接返回且不补读
   （`src/client/index.ts:1216`、`src/client/index.ts:1296`），revision 未变时整轮处理
   跳过（`src/client/index.ts:1225`）。宿主侧同理，指纹与上次相同的推送直接不写盘
   （`src/index.ts:612-614`），连事件都不产生。

**正确用法**：要么让宿主把该状态留着、在每次推送里重复提供，要么把通道换成带递增 id
的 ops 队列。前者是现在的修法（已修，待宿主验证）：宿主全局记住
`lastCompletion = {sessionId, completion}`（`src/index.ts:457`、`src/index.ts:461-470`），
`statePushOf` 在目标会话缓存未命中时持续捎带最近一次续写
（`src/index.ts:690-694`）。后者未做。

跨会话误显示由客户端的双校验兜住（已修，`src/client/index.ts:911-920`）：
`completionSessionId === currentId` 且 `completion.draft === 当前草稿` 才显示。捎带
过来的别人的续写因此不会串台，代价是它一直在载荷里。

**同类风险备案**：`_push` 上「省略 = 客户端保留现值」语义的一次性字段共享这个丢失模式。

| 字段 | 省略语义的定义处 | 宿主写入处 | 客户端保留现值处 |
|---|---|---|---|
| `history` / `historySessionId` | `src/settings.ts:58-61`（"缺省表示不携带"） | `src/index.ts:633-635` | `src/client/index.ts:1268-1273` |
| `completion` / `completionSessionId` | `src/index.ts:567-570`（`null` = 作废，`undefined` = 保留） | `src/index.ts:636-640` | `src/client/index.ts:1277-1282` |
| `error` | `src/settings.ts:62-63`（"最近一次生成失败的摘要"） | `src/index.ts:641` | 无：客户端的解析结构里没有它（`src/client/index.ts:1233-1241`），写了也读不到 |

`suggestion` / `suggestionSessionId` 不在这一类，别按同一套理解处理：它是必填字段而不是
可选字段（`src/settings.ts:44-53`），宿主每次推送都带（`src/index.ts:623-630`），客户端把
缺失当作清空而不是保留（`src/client/index.ts:1259-1261`）。它仍然受整值覆盖影响，但
「省略」在这条通道上对不同类型意味着相反的事，加字段时以 `ClientPush`（`src/index.ts:554-573`）
为准，那里逐字段写了 `null` 与 `undefined` 的分工。

触发下一次覆盖的写入点：pull 应答（`src/index.ts:720`）、续写结果（`src/index.ts:501`、
`src/index.ts:534`）、回合结束（`src/index.ts:759`）、热度恢复补推（`src/index.ts:318`）。

再加 transient 载荷时，先回答「它消失的时机由谁决定」。答案如果是别人的写入节奏，就
不该放这条通道。

## 陷阱 4：`apply(ctx, config)` 闭包捕获的 volatile 引用会冻结

**症状**（插件经验）：客户端写入 `complete` 后，宿主内读到的 `_ops` 永远停在第一次
`pull` 的那份载荷；或者用户在设置页改了开关，运行中的行为不变。

**根因**（插件经验，代码注释在 `src/index.ts:247-252`、`src/index.ts:262-266`）：内核每次
配置写入会重新解析 config 并替换 fiber 持有的对象。`apply(ctx, config)` 拿到的
`Volatile<T>` 引用（`.volatile()` 字段的解析产物是引用而不是裸值，
`src/index.ts:148-153`）会停在失效时刻的值上，`readVolatile()` 对它调用 `.get()`
也只返回冻结那份（`src/generate.ts:136-143`）。`settings/document-updated` 只带
`(ns, revision)`，不带载荷，所以也没有别的线索可循。

**正确用法**：实时读值走 settings 服务的 `describe()`，它是同一份展开结果的权威源
（`src/index.ts:268-291`）；volatile 引用只作为服务尚未注入时的启动早期回退
（`src/index.ts:286-290`）。判重按载荷内容比，不按引用身份比（同值重写也会换引用，
`src/index.ts:247-252`）。

**现状要分清**：

- `_ops` 已按 `describe()` 读（已修，`git show 8d5918e`）。
- 用户可调项**已改完（代码层，待宿主验证）**：`liveSettings` 不再是被捕获的
  `flattenConfig(resolved)`，而是 `createLiveSettings()` 读源（`src/live-settings.ts`，
  提交 `95994d6`，集成为 `df09953`）。要点是三条：`effective()` 读
  `liveSettings.snapshot(bootSettings)`，`bootSettings` 降级为**默认层**；
  `settings/document-updated` 命中本 ns 时 `invalidate()` 标脏、**下一次读**才
  `describe()`；实时覆盖值按 `Record<keyof FlatConfig, FieldSpec>` 键表逐键取，
  `_ops`/`_push` 不是 `FlatConfig` 的键，**类型层就落不进设置**。
  「设置页改了不生效」是否真的消除，需宿主重启后按 issue #19 的验收清单确认。
- 同一次改动还带来一个**新的读路径成本**：`describe()` 在内核里会按 raw 变化
  `emit('settings/document-updated')`（`@deepseek-ai/dsh-settings/lib/index.js:435`），
  所以「读 → 事件 → 再读」理论上能自喂。本插件的对策是事件只标脏、不立刻读，
  并加了 5s TTL 兜底与重入保护；引用这条前先确认这两个机制还在。

`dsh-settings` 的 README 把 reference 生命周期与通知推给
`vendor/loader/README.md`（`@deepseek-ai/dsh-settings/README.md:57`），那份文档在本机
安装里读不到，所以本条按插件经验记，不按契约记。

## 陷阱 5：cordis 事件只向父传播，不向子传播

**症状**（插件经验）：`ctx.on('settings/document-updated', ...)` 的回调一次都不触发。
看起来像「客户端写了，宿主完全收不到通知」，容易误诊成写入没落盘（也就是陷阱 1）。

**根因**（内核契约 + 插件经验）：内核在 settings 服务自己的 `ownerContext` 上发这个事件：

```
@deepseek-ai/dsh-settings/lib/index.js:435
  if (previous?.raw !== raw || ...) this.ownerContext.emit("settings/document-updated", entry.options.id, revision);
```

传播方向只有向上，服务上下文的兄弟与子上下文都收不到，插件自己的 `ctx` 也在收不到的
那一侧。「只向父传播」是本插件据以修好的经验结论（`src/index.ts:323-324`），未在 cordis
文档核对，按插件经验引用。

**正确用法**：在 root 上监听，保留回退：

```ts
const eventCtx = (ctx as unknown as { root?: typeof ctx }).root ?? ctx;
eventCtx.on('settings/document-updated', (ns, revision) => { /* ... */ });
```

见 `src/index.ts:325-327`。同理，客户端要订阅的是内核转发给浏览器的同名事件
（`remote.$on('settings/document-updated')`，`src/client/index.ts:1302`），不是宿主
上下文的事件。

## 写丢失时按这个顺序排查

1. 写入有没有被拒：客户端读的是 `mutate` 的**兑现值信封**（`ok` / `error.code`），
   不是 Promise 状态（陷阱 1）；`expectedRevision` 必须刚从 `describe()` 取。
   离线可测：`scripts/ops-write-verify-smoke.mjs`。
2. 值有没有落盘：看 `[ops-trace]` 里有没有 `_ops write unsettled` / `refused-*` 那几行；
   写后凭证就是 `mutate` 带回的视图（`revision` 动过 或 `_ops` 等于本次载荷），
   不需要再发一次 `describe()`。
3. 宿主有没有收到事件：先确认监听挂在 root（陷阱 5）。`src/index.ts:330-337` 那个
   三点对照探针（内核 raw / 捕获引用 / describe 值）就是为这一步写的，但它在 main 上
   已被 `6dfcd78` 删掉输出，只剩计算，要复现得先把日志加回来。
4. 宿主收到了但没动：查 `ops batch received` / `hotness ops applied` / `_ops batch dropped`
   三行留痕（陷阱 2）；再查 `_ops clear refused inside settings transaction`
   （陷阱 1.5——清空失败会让同一份载荷被重读）。
5. 宿主动了但客户端看不到：查载荷是否已被下一次推送覆盖（陷阱 3）。

## 上游待确认

`docs/upstream-feedback-settings-proxy.md` 是给内核/dsh-settings 维护者的反馈草稿，
内容有两个诉求：① 陷阱 1 那两个问题（冲突为何对客户端表现为成功、写 API 能否返回实际
写入结果）——① 的机制本轮已在源码里定位并闭环，草稿随之更新为「请确认这是设计意图」；
② 陷阱 1.5 的 nested transaction：`settings/document-updated` 在事务内 emit，导致订阅方
在回调里无法写 settings，且 `AsyncLocalStorage` 使「推迟一个 tick」无效——请内核提供
显式退出（`executing.exit()` 一类）或把该事件改成事务外 emit。
它仍是待提交草稿，不代表已发给上游，也不代表上游认同。

## 复查清单

改动这条通道前后各过一遍。每条都对应上文某一处实际发生过的失败，不是通用建议：

- [ ] 新增 op 变体：`domain.ts` 的 `HotnessOp`、`hotness-store.ts` 的
      `opsPayloadSchema`、`applyOps` switch 三处都改了？
- [ ] 新增 `_push` 字段：`settings.ts` 的 `GhostPushPayload` 和 `index.ts` 的
      `ClientPush` 都补了？（前者不受编译器检查，靠人工）
- [ ] 新字段是「一次性」还是「常驻」？一次性的不放 `_push`（陷阱 3）
- [ ] 每次 `mutate` 的 `expectedRevision` 都来自最近一次 `describe()`？（陷阱 1）
- [ ] 每条返回空值/提前 return 的兜底路径都有输出？异常留痕、正常态**不**留痕？（陷阱 2）
- [ ] 新增 op 变体后 `node scripts/ops-schema-coverage-smoke.mjs` 仍然绿？
- [ ] 新增的日志走的是 `[ops-trace]` seam 而不是散落的 `ctx.logger.info`？
      （后者在这个宿主里运行期一个字都不落盘）
- [ ] 有没有在 `settings/document-updated` 的回调（或它的 await 续体）里写 settings？
      有就是注定被拒的写入，只能分诊留痕，别当成功。（陷阱 1.5）
- [ ] 新增的事件监听挂在 `ctx.root`？（陷阱 5）
- [ ] 需要在运行中读到用户改的值，走 `describe()` 而不是闭包里的 `config`？（陷阱 4）
