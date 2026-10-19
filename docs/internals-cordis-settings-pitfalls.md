# 内核语义陷阱：settings 双向通道与 volatile 引用

本插件与宿主之间只剩一条通道：settings 命名空间 `suggest-ghost` 上的两个 volatile
字符串字段（`_ops` 客户端到宿主，`_push` 宿主到客户端）。#16、#17、#18 三个缺陷
都长在通道语义上，而不是长在业务逻辑上，所以先看这一页再动手改代码。

描述的代码：`src/index.ts`、`src/client/index.ts`、`src/hotness-store.ts`、
`src/settings.ts`、`src/domain.ts`。

## 怎么读这份文档

行号与 diff 的核对基线是分支 `fix/issue-16-18-cleanup` 的提交 `1eb708d`。main 之后
删过诊断日志，行号有偏移，按符号名定位比按行号可靠。本文随集成分支
`integrate/issues-2026-10` 前进时只更新下面的「现状」段落，不重排全文行号；若你在
别的分支上读到行号对不上，先按符号名找。

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
  写完直接用它刷新本地期望值，比再发一次 `describe()` 省一个往返。本插件目前忽略
  返回值（`src/client/index.ts:1080` 之后没有读结果）。
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

**尚未闭环**（待宿主验证）：本仓库没有证据指出那次 `resolve` 是在哪一层吞掉了内核的
reject（远程代理、typert 传输还是 `.then` 写法）。因此下面两件事仍缺：

1. 写后读回校验：`writeOps` 成功兑现不等于值已落盘，`src/client/index.ts:1082-1083`
   直接 `return true`。设置卡片那条路径反而有读回（`src/client/index.ts:1641-1644`
   成功后调用 `readValue()`）。
2. 对冲突的显式分支：重试上限是 2 次（`src/client/index.ts:1086`），超限后返回
   `false`，调用方按「未送达」处理（`src/client/index.ts:1050`）。
3. 运行时可读性：main 的 `6dfcd78` 删掉了 `writeOps` 的成功/冲突/失败三条日志，
   成功分支现在是静默的。下一次再遇到「写了没生效」，第一步就得把这几行输出加回来，
   否则无法区分「被拒」与「没到达内核」。

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
- 兜底返回空值的那条路径必须有输出。`parseHotnessOps` 现在有三条返回空 ops 的路径：
  载荷为空或未定义（`src/hotness-store.ts:256`）、JSON 解析失败（`src/hotness-store.ts:261`）、
  schema 拒绝（`src/hotness-store.ts:264-268`）。只有第三条在 8e2e5c0 里加过日志，
  而那行日志已在 main 的 `6dfcd78`（chore: remove all debug console.log statements）中
  删除。现状：三条路径全部静默，「静默丢弃必须留痕」这条结论在代码里只剩一句注释
  （`src/hotness-store.ts:265`）。
- 同一个漂移还有第二个实例：`GhostPushPayload`（`src/settings.ts:41-64`）没有任何
  `completion` 字段，但宿主实际推的载荷带它（`src/index.ts:636-640`），客户端也确实读它
  （`src/client/index.ts:1239-1240`）。它之所以从不报错，只是因为没有任何代码把这个
  interface 用作类型约束（全仓检索仅出现在注释里）。改推送载荷时别指望它帮你检查。
- 现有测试覆盖不到这里：`scripts/inline-smoke.mjs` 只测续写的纯函数净化链，没有一条
  断言 `parseHotnessOps` 对 `HotnessOp` 每个变体都放行。

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

1. 写入有没有被拒：`expectedRevision` 是不是刚从 `describe()` 取的现值（陷阱 1）。
2. 值有没有落盘：再发一次 `describe()`，打印该 ns 的 `revision` 与 `_ops`
   字符串。落盘了才轮到下一步。
3. 宿主有没有收到事件：先确认监听挂在 root（陷阱 5）。`src/index.ts:330-337` 那个
   三点对照探针（内核 raw / 捕获引用 / describe 值）就是为这一步写的，但它在 main 上
   已被 `6dfcd78` 删掉输出，只剩计算，要复现得先把日志加回来。
4. 宿主收到了但没动：查 `parseHotnessOps` 是不是静默返回了空 ops（陷阱 2）。
5. 宿主动了但客户端看不到：查载荷是否已被下一次推送覆盖（陷阱 3）。

## 上游待确认

`docs/upstream-feedback-settings-proxy.md` 是给内核/dsh-settings 维护者的反馈草稿，
内容是陷阱 1 里那两个未闭环问题（冲突为何对客户端表现为成功、写 API 能否返回实际写入
结果）。它是待提交草稿，不代表已发给上游，也不代表上游认同。

## 复查清单

改动这条通道前后各过一遍。每条都对应上文某一处实际发生过的失败，不是通用建议：

- [ ] 新增 op 变体：`domain.ts` 的 `HotnessOp`、`hotness-store.ts` 的
      `opsPayloadSchema`、`applyOps` switch 三处都改了？
- [ ] 新增 `_push` 字段：`settings.ts` 的 `GhostPushPayload` 和 `index.ts` 的
      `ClientPush` 都补了？（前者不受编译器检查，靠人工）
- [ ] 新字段是「一次性」还是「常驻」？一次性的不放 `_push`（陷阱 3）
- [ ] 每次 `mutate` 的 `expectedRevision` 都来自最近一次 `describe()`？（陷阱 1）
- [ ] 每条返回空值/提前 return 的兜底路径都有输出？（陷阱 2）
- [ ] 新增的事件监听挂在 `ctx.root`？（陷阱 5）
- [ ] 需要在运行中读到用户改的值，走 `describe()` 而不是闭包里的 `config`？（陷阱 4）
