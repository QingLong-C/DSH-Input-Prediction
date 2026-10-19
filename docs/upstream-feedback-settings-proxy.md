# 上游反馈草稿：settings 远程代理在写冲突时对调用方显示为成功

> **状态：待提交的草稿。** 尚未提交给 DSH 内核或 dsh-settings 维护者，也未收到任何回复。
> 提交前需要先补文末「发出前要补的证据」里那三项。
>
> 收件对象：DSH 内核 / `@deepseek-ai/dsh-settings` 与远程 settings 代理（`dsh-api-settings-controller`）维护者。
> 涉及版本：`@deepseek-ai/dsh-settings@0.2.0-rc.2`、`@deepseek-ai/dsh-api-settings-controller@0.2.0-rc.2`（本机核对于 2026-10-19）。
> 报告方：dsh-suggest-ghost 插件（`src/client/index.ts` 的 `writeOps`，修复见该仓库 commit `a864545`）。

## 一句话

`SettingsForms.write()` 遇到 revision 不匹配会抛 `SettingsConflictError`；插件经由
`ctx.remote.settings.mutate()` 提交同类写入时，观测到 Promise 成功兑现而值没有落盘。
写失败在客户端侧表现为写成功，调用方无从判断。（内核侧确实会抛错，所以信号是在中间某一
环节丢的，环节尚未定位，这正是我们想请维护者确认的第一件事。）

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

## 我们接受的反驳

如果远程代理确实在冲突时 reject，那么本次观测到的「resolve + 值未落盘」就另有原因
（例如写入根本没到达 `write()`，或 `revision` 的推导时机与我们理解的不一致）。这正是我们
想从维护者那里得到的答案：到底是哪一种，以及插件侧应当断言什么。在拿到答复之前，本仓库
把这一条记为「未闭环」而不是内核缺陷，文档见
`docs/internals-cordis-settings-pitfalls.md` 陷阱 1。

## 发出前要补的证据

- [ ] 把上面 1-5 步在真实宿主上跑一遍，录下客户端 Promise 的实际状态与随后
      `describe()` 的 `_ops` 值（区分「内核没收到」与「内核拒绝但没回传」）。
- [ ] 确认观测所用的内核代次：本仓库同时支持 `0.1.1-rc.2` 到 `0.2.0-rc.2` 五代
      （`package.json` peerDependencies），事故记录未标注代次。
- [ ] 用 `code === 'SETTINGS_CONFLICT'` 而不是文本匹配做一次判定，确认客户端能否拿到该码
      （当前插件代码靠 `/conflict|revision/i` 匹配文本，`src/client/index.ts:1086`）。

## 环境

dsh-suggest-ghost 分支 `fix/issue-16-18-cleanup`，基线 commit `1eb708d`；本文行号与 diff
核对于该基线。内核侧行号核对于本机
`@deepseek-ai/dsh-settings@0.2.0-rc.2`（2026-10-19）。
