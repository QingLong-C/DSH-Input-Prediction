# 上游反馈草稿：settings 远程代理的写冲突语义，与 `document-updated` 的事务内 emit

> **状态：待提交的草稿。** 尚未提交给 DSH 内核或 dsh-settings 维护者，也未收到任何回复。
>
> 收件对象：DSH 内核 / `@deepseek-ai/dsh-settings`、远程 settings 代理
> （`dsh-api-settings-controller`）、以及 `dsh-hmr` 的事务串行化维护者。
> 涉及版本：`@deepseek-ai/dsh-settings@0.2.0-rc.2`、
> `@deepseek-ai/dsh-api-settings-controller@0.2.0-rc.2`、
> `@deepseek-ai/dsh-api-gateway@0.2.0-rc.2`、`@deepseek-ai/dsh-hmr@0.2.0-rc.2`、
> `@deepseek-ai/cordis@4.0.1`（本机核对于 2026-10-19）。
> 报告方：dsh-suggest-ghost 插件（`src/client/index.ts` 的 `writeOps`，修复见 `a864545`
> 与本轮的 `src/client/settings-result.ts`）。
>
> 本文有两个诉求，**第二个比第一个更根本**：
>  - **诉求一**（冲突为何对客户端表现为成功）：机制本轮**已在源码里定位**，不再是未闭环
>    问题；现在请维护者确认「折进 `RemoteResult` 后照常兑现」是设计意图，并确认
>    `code` 的重映射（`SETTINGS_CONFLICT` → `settings/conflict`）是稳定契约。
>  - **诉求二**（新）：`settings/document-updated` 在 HMR 事务**内** emit，订阅方在自己的
>    回调里写 settings 必被 `HMR transactions cannot be nested` 拒绝，且该上下文沿
>    await/timer 传播、无法靠「推迟一个 tick」摆脱。本插件有实测数据：一个进程内
>    372/373 次 `_ops` 清空都是这个拒绝。

## 一句话

1. `SettingsForms.write()` 遇到 revision 不匹配会抛 `SettingsConflictError`；经由
   `ctx.remote.settings.mutate()` 提交同类写入时，**拒绝被折进 `RemoteResult` 的 error
   分支后照常兑现**，于是「写失败」在客户端侧表现为「Promise 成功」——而绝大多数调用方
   只读 Promise 状态。机制已定位（见下「环节在哪一层丢的」），我们要确认的是这是不是
   设计意图，以及 `code` 重映射是否是稳定契约。
2. `settings/document-updated` 是在 HMR 事务的 `AsyncLocalStorage` 上下文里 emit 的，
   因此订阅方在自己的回调里发起的任何 settings 写入都会被
   `HMR transactions cannot be nested` 拒绝；而这个上下文沿 await/microtask/timer
   继续传播，调用方**没有办法**靠自己「推迟到下一个 tick」摆脱它。我们要么需要一个
   显式的退出机制，要么需要该事件改为事务外 emit。

## 期望的行为（内核源码里确实是这么实现的）

`@deepseek-ai/dsh-settings/lib/index.js`：

```
501  async write(ns, change, expected, paths = []) {
511    if (expected !== void 0 && descriptor.revision !== expected) throw new SettingsConflictError(ns, expected, descriptor.revision);
```

`SettingsConflictError` 带稳定机器码与描述（`lib/index.js:165`、`lib/index.js:176`）：

```
code = "SETTINGS_CONFLICT"
message = settings namespace "<ns>" changed since it was read (expected revision <e>, now <a>)
```

`revision` 的语义在类型注释里写清楚了：`describe()` 视图上的单调版本，写时把它带回去，
过期编辑器应当被拒绝而不是静默覆盖（`lib/types/types.d.ts:37-40`）。

## 实际观测

dsh-suggest-ghost 的客户端把热度操作写进 volatile 字段 `_ops`，调用形态是：

```ts
remote.settings.mutate('suggest-ghost', [{ op: 'set', path: ['_ops'], value }], 0);
```

第三个参数固定传 `0`。宿主端每次写 `_push`、每次消费后清空 `_ops`
（`dsh-suggest-ghost/src/index.ts:653`、`src/index.ts:730`）都会推进该命名空间的
`revision`（`dsh-settings/lib/index.js:421-428`：`revision` 由 `describe()` 按内容指纹
增量推导，首次为 0，之后每次指纹变化加一），因此 `expected = 0` 在启动后的第一次写入
之后必然过期。

观测到的结果：客户端打印 `writeOps: mutate OK`（成功分支的日志，由 `d015864` 加入，
结论记录在 `a864545` 的提交说明中；main 现状已删除该日志），而随后 `describe()` 读回的
`_ops` 仍是旧值。也就是说：

1. 内核按契约拒绝了写入；
2. 拒绝没有到达发起写入的客户端；
3. 客户端把自己「从未生效」的写入当成了成功，并且没有任何返回信息能让它发现。

插件侧的修法是写前先 `describe()` 取当前 revision、按真实 revision 提交、冲突时重取重试
（commit `a864545`，`src/client/index.ts:1070-1094`）。这让功能可用，但没有解决「失败看起来
像成功」这个 API 语义问题，其他插件仍会踩。

## 为什么 resolve-不-reject 是危险的 API

- 唯一携带的返回值是「命名空间视图」。调用方拿到一个成功的 Promise 时，无法区分三种情况：
  写进去了、被冲突拒绝、被别的校验拒绝（如 `lib/index.js:507` 的
  `Config field "..." is not volatile`）。
- 这个 API 的正确用法要求调用方**额外**做一次读回校验才能确认写入生效。缺省形态把验证
  责任推给了调用方，而违反它的表现不是报错，是数据悄悄留在旧值上。
- 设置类写入的失败大多是低频、用户手动触发的：一次冲突可能等到用户下次打开设置页才被发现，
  而那时用户和开发者都会认为是「改了没生效」的 UI 问题，而不是并发控制拒绝。本仓库为定位
  第三个参数留了三个连续的诊断提交（`d015864`、`685045a`、`006c554`），之后才有 `a864545`。
- 冲突拒绝本身是有价值的设计（避免覆盖他人改动）；问题只在拒绝的信号被丢弃。

## 环节在哪一层丢的（本轮源码取证，0.2.0-rc.2）

```
@deepseek-ai/dsh-settings/lib/index.js:511
  if (expected !== void 0 && descriptor.revision !== expected) throw new SettingsConflictError(ns, expected, descriptor.revision);
      ↑ code = "SETTINGS_CONFLICT"（同文件 :165），message 含 "revision"（:176）

@deepseek-ai/dsh-api-settings-controller/lib/index.js:489,501-507
  settingsConflictOf(error) → new RemoteError("settings/conflict", conflict.message, {ns, expected, actual})
      ↑ 码在这里被换成远程 taxonomy；details 保留了 expected/actual

@deepseek-ai/dsh-api-gateway/lib/index.js:1425-1437   rpcFailure(error) → {ok:false, error:{code,message,details}}
@deepseek-ai/dsh-api-gateway/lib/client.js:2124-2126  rebuiltFailure(e) → new RemoteError(e.code, e.message, e.details)
@deepseek-ai/dsh-api-gateway/lib/client.js:1795-1802  invoke(): if (!result.ok) return {ok:false, error: rebuiltFailure(...)}
      ↑ 兑现，不是 reject

@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts:60-73
  「The Remote face itself folds carrier failures into the error branch, so no consumer
   wraps a call to recover one; only assembly faults (arity, an unmounted method, a
   missing Context adapter) still reject.」
```

即：内核确实抛了，控制层也确实分类了，**丢信号的最后一步是「兑现一个带 error 的结果」这个
API 形状本身**。三点补充观察：

- 码是**跨传输层保留**的（`rebuiltFailure` 原样重建 `code`），但值被重映射过。
  所以上层要判 `settings/conflict`，判 `SETTINGS_CONFLICT` 会漏——这两个名字在不同层，
  很容易踩。我们建议文档里把「远程 taxonomy 的码表」当作公开契约写出来。
- 内核自己的设置页已经是按这个形状写的（`await ctx.remote.settings.mutate(...)` 之后
  读 `response.ok`，再按 `response.error.code === "settings/conflict"` 分支：
  `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:2795-2805`）。也就是说
  「记得读 `ok`」目前是靠每个调用方各自发现，而不是 API 逼出来的。
- 成功分支带回的 `SettingsNamespaceView`（含 `revision: z.number()` 与整份 `value`，
  `dsh-api-settings-controller/lib/typert.remote-client.js:69-82`）其实**已经足够**让
  调用方做写后确认，无需额外 `describe()`。我们按这个把插件的判定做实了。
  如果能在返回结构里再加一个显式判别式（例如 `applied: boolean`），就能把「没生效」
  变成不可能被忽略的分支——这也是下面建议 2 的落点。

## 最小复现路径

以下 1-4 是从源码推导的路径，**尚未在本机以真实宿主跑通**（缺隔离 profile 下的双客户端环境）；
第 5 步的观测是本插件的实际记录。

1. 宿主与浏览器客户端都在运行，某插件声明了一个 volatile 字符串字段 `x`。
2. 客户端调用 `ctx.remote.settings.mutate(ns, [{op:'set', path:['x'], value:'A'}], 0)`。
   若这是本进程该命名空间的第一次写入，成功。
3. 宿主端做任意一次会导致该 ns 配置内容变化的写入（例如同插件的
   `ctx.settings.update(ns, { y: ... })`）。
4. 客户端再用同一个 `expected = 0` 调用 `mutate`。
5. 观察点：客户端 Promise 是否 reject；随后 `describe()` 里该 ns 的 `x` 是否还是旧值。
   本插件在 5 处看到的是 resolve + 旧值。

## 建议的 API 语义（按侵入性从小到大）

1. **冲突必须 reject**（最小改动）：远程代理保持 Promise 语义与本地
   `SettingsForms.mutate()` 的抛错一致，把 `code: 'SETTINGS_CONFLICT'`、
   `expected`、`actual` 一并带到客户端，让调用方能分辨「过期」与「其他失败」。
2. **或者返回实际写入结果**：`Promise<SettingsNamespaceView>` 已经在成功时带回 `revision`
   （`dsh-api-settings-controller/lib/typert.remote-client.js:69,81`）。若不想让冲突成为
   reject，就给结果加上显式的判别式，例如 `{ applied: boolean, revision: number, code?: ... }`，
   让「未应用」是一个必须被读到的分支，而不是一个可以忽略的 Promise 状态。
3. **可选参数带来的静默**：`expectedRevision?` 在本地接口和远程 schema 里都是可选的
   （`dsh-settings/lib/types/index.d.ts:114`；`typert.remote-client.js:67` 声明为
   `undefined | number`），省略即完全跳过比较（`lib/index.js:511` 的 `expected !== void 0`）。
   对「跨进程写入」而言，默认无并发控制与「默认覆盖」几乎同样危险，建议远程形态要求显式
   传参或显式传 `{ mode: 'force' }` 之类的意图声明。
   注：插件侧曾观测到远程层因少传该参数直接报错，记录文本为
   `settings/mutate expected 3 argument(s), got 2`（`src/client/index.ts:87-92`），而该文本
   在本机 0.2.0-rc.2 产物里检索不到。这个 arity 门禁是哪一层、哪个代次加的，需要维护者确认；
   它也可能正是丢错误的那一层。

## 诉求二：`document-updated` 的事务内 emit 让订阅方无法回写

**现象与数据**（本机 `~/.dsh/dsh-web.log`，同一进程内计数）：

| 观测 | 次数 |
|---|---|
| `_ops` 清空失败 `HMR transactions cannot be nested` | 372 |
| `_ops` 清空失败 `atomic-write: timed out waiting for the writer lock` | 1 |
| `_ops` 清空成功 | 0 |
| `consumeOps` 消费 `complete` op | 169（消费本身成功） |

**机制链**（0.2.0-rc.2，逐处 file:line）：

```
dsh-config-editor/lib/index.js:134      await (hmr === void 0 ? run() : hmr.runExclusive(run));
dsh-hmr/lib/index.js:271                executing = new AsyncLocalStorage();
dsh-hmr/lib/index.js:280                if (this.executing.getStore()) return Promise.reject(new Error("HMR transactions cannot be nested"));
dsh-hmr/lib/index.js:284                return this.executing.run(true, operation);
dsh-settings/lib/index.js:510           await this.ownerContext.configEditor.edit(entry, (raw, inherited) => {
                                            const descriptor = this.describe()...   ← 事务内
dsh-settings/lib/index.js:435           ...this.ownerContext.emit("settings/document-updated", entry.options.id, revision);
```

于是：**插件在 `settings/document-updated` 的回调里（含该回调的任何 await 续体）发起的
settings 写入，必被拒**。而「消费完清空队列」「应答 pull」「续写完成后推载荷」这些再正常
不过的反应式写入，全都长在这个回调上。

**调用方自救不了**，我们实测过四条路：

| 做法 | `executing.getStore()` | 结论 |
|---|---|---|
| 回调里直接 `settings.update()` | `true` | 拒绝 |
| `await Promise.resolve()` 之后再写 | `true` | 拒绝 |
| `queueMicrotask(...)` 里写 | `true` | 拒绝 |
| 回调里 `setTimeout(..., 5)` 里写 | `true` | 拒绝（ALS 上下文随 timer 一起传播） |
| 事务**外**建的 `setTimeout` / `new AsyncResource()` 里写 | `undefined` | 可以通过 |

最后一行是唯一的出路，但它要求调用方**持有一个建立于事务之外的锚点**。插件侧没有可靠的
这样的锚点：`apply(ctx)` 本身就可能跑在配置重载事务里（`dsh-hmr/lib/index.js:289` 的
`runReload` 也在 `runExclusive` 内），所以在启动期捕获的 `AsyncResource` 有可能一开始就
带着 `true`。让每个订阅方去赌锚点的时机，不是一个可写进文档的规则。

**我们建议的修法（按侵入性从小到大）**：

1. **提供显式退出**：`dsh-hmr` 已经在自己的 `watchConfig` 里用了
   `this.executing.exit(...)`（`dsh-hmr/lib/index.js:303`），把这个能力以受控形式暴露给
   订阅方即可（例如 `hmr.runDetached(fn)` 或 `ctx.settings.writeOutsideTransaction(fn)`），
   并写明「事件回调内回写 settings 必须走它」。
2. **把 `document-updated` 改成事务外 emit**（把 `describe()` 里那次 emit 排到当前事务
   结束后再广播）。代价是订阅者看到的事件可能落后于实际文档状态，但至少回调里的写入是
   合法动作，而不是注定失败的静默 no-op。注意 `SettingsForms.write()` 在 edit 回调内调
   `describe()` 只为读一次 `descriptor.revision` 做比较（`dsh-settings/lib/index.js:510`）——
   如果那次内部 `describe()` 不 emit（或者提供一个不发事件的内部读取面），这条链就断了。
3. **最低成本**：把 nested 拒绝从 `Promise.reject(new Error(...))` 换成带稳定码的失败
   （现在只有一句人读文本，上层无法可靠分诊），并在 `dsh-settings` 文档里明确写
   「settings 事件回调内不可再写 settings」。我们插件现在靠自己 `text.includes('cannot be nested')`
   来分诊这一类（见 `src/index.ts` 的 `traceFault('ops-clear-nested', ...)`），这是不该
   由文本匹配承担的分支。

**我们接受的反驳**：如果 (1)(2) 都不打算做，那么请明确「反应式写入必须挂在自己的定时器/
非 ALS 锚点上」是有支持的用法，并给出推荐锚点。目前我们只能把它记为「结构性失败 + 分诊
留痕」，并在 `docs/internals-cordis-settings-pitfalls.md` 陷阱 1.5 里按插件经验引用。

## 我们接受的反驳

这一条已经不需要反驳了——机制在源码里定位到了（见「环节在哪一层丢的」），远程面**设计上
就是不 reject**。所以我们想从维护者那里得到的答案换成两个问题：

1. 「失败折进 `RemoteResult` 的 error 分支后照常兑现」是**长期契约**还是当前实现的偶然？
   若某天改成 reject，只读 `ok` 的调用方会突然开始看到 unhandled rejection（我们两侧都
   做了兼容：`ok === false` 与 reject 分支走同一套分诊）。
2. `SETTINGS_CONFLICT` → `settings/conflict` 的重映射会不会随版本变动？如果远程 taxonomy
   的码表是公开契约，请写进文档，我们好只认一个码而不是两个。

在拿到答复之前，本仓库按「API 形状如此、调用方必须读兑现值」处理：判定与写后确认已做实
（`src/client/settings-result.ts` + `scripts/ops-write-verify-smoke.mjs`），文档见
`docs/internals-cordis-settings-pitfalls.md` 陷阱 1。

## 发出前要补的证据

- [x] ~~区分「内核没收到」与「内核拒绝但没回传」~~ —— 已在源码层定位（见「环节在哪一层
      丢的」）：内核抛了、控制层分类了、远程面折进 error 分支兑现。仍需在真实宿主上复跑
      一遍 1-5 步以确认代次一致性，但结论不再依赖它。
- [ ] 诉求二需要一次可控复现：在 `settings/document-updated` 回调里写同 ns 的另一个
      volatile 字段，记录 `HMR transactions cannot be nested` 与四种「推迟」写法的结果
      （我们的小样本见上面那张表，来自单一进程的运行日志）。
- [ ] 确认观测所用的内核代次：本仓库同时支持 `0.1.1-rc.2` 到 `0.2.0-rc.2` 五代
      （`package.json` peerDependencies），事故记录未标注代次。
- [ ] 用 `code === 'SETTINGS_CONFLICT'` 而不是文本匹配做一次判定，确认客户端能否拿到该码
      （当前插件代码靠 `/conflict|revision/i` 匹配文本，`src/client/index.ts:1086`）。

## 环境

dsh-suggest-ghost 分支 `fix/issue-16-18-cleanup`，基线 commit `1eb708d`；本文行号与 diff
核对于该基线。内核侧行号核对于本机
`@deepseek-ai/dsh-settings@0.2.0-rc.2`（2026-10-19）。
