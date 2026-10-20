# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

（下一轮开发）

## [0.6.0] - 2026-10-20

### 修复

- **`_ops` 写入此前必然被版本冲突拒绝**：client 侧 `remote.settings.mutate(ns, ops, expectedRevision)`
  的第三个参数是 CAS 的期望版本，此前固定传 `0`。`revision` 每次该命名空间内容变化都会推进（宿主自己
  写 `_push`、消费后清空 `_ops` 都算），所以启动后的第一次写入之后，每一次 `expected=0` 的写入都被内核
  拒绝，而客户端只看 Promise 状态，表现为「resolve 了但什么都没写」。现在改为先 `describe()` 取真实
  revision 再提交，冲突时重取 revision 重试（上限 2 次）（#16，`a864545`）
- **`complete` 操作被 zod 整批拒绝**：`opsPayloadSchema` 的 `discriminatedUnion('op', …)` 缺少 `complete`
  变体，而 `HotnessOp` 的 TS 类型里有；校验失败会让**整批** ops 一起被丢弃，停顿续写因此从不触发（#17，
  `8e2e5c0`）。两份声明互不约束，编译器不会报这种漂移
- **停顿续写推送到客户端总是丢失**：`_push` 是单槽 last-wins 快照，续写载荷只存在一瞬间，随后任何其他
  会话的 pull 应答都会重写它；客户端是「事件 → 异步 `describe()`」的快照式读取，读不到被覆盖的中间值。
  宿主现在全局追踪 `lastCompletion {sessionId, completion}`，并在目标会话缓存未命中时持续捎带最近一次续写；
  跨会话误显示由客户端既有的 `completionSessionId` + `draft` 全等双校验兜住（#18，`bceac31`）。
  ⚠️ 该方案**不充分**：它只解决「瞬时载荷被 last-wins 覆盖」，没解决「载荷写不进盘」。真实根因与
  修复见下面 #22 那条（事务外排水锚点），已端到端验到幽灵可见
- **采纳建议会吞掉用户刚打的字**（#4，`3a06a6b`）：Tab 整条采纳与 `→` 逐词采纳都是
  「读草稿快照 → 拼 `accepted` → `setDraft`」，两步之间没有任何校验。原生输入先于 React 渲染
  到达宿主草稿存储，所以用户在这两步之内打的字会被整段覆盖。现在以 `ghostContent()` 同一帧
  读出的 `{draft, draftRev}` 为 CAS 基线，写入前重读比对：宿主 `InputState.draftRev`
  （`@deepseek-ai/dsh-client-ui-conversation@0.2.0-rc.2`，实测仅在草稿投影内容变化时 +1，
  **纯光标移动不推进**，故不会因挪动光标而误放弃）不等或文本不等，就一个字符都不写、幽灵照旧
  收掉。判据与 `accepted` 构造抽在 `src/client/accept-guard.ts`，两条路径共用；历史补全的斜杠
  命令整行还原逐字搬入，并由 `scripts/accept-cas-smoke.mjs` 用旧实现作回归预言逐字符比对
- **一次输入刷出上千次 armed，停顿计时器永远被推倒重来**（#21，`580e76f`）：旧
  `scheduleInlineTrigger()` 首行就 `clearInlineTimer()`，而每个 `render()` 都调它 —— debounce
  度量的其实是「距上次 render」。判据改为纯函数状态机 `decideInlineArm`（观察值 = 草稿/会话/
  幽灵形态/开关/组词），同一观察的重复送达一次都不清表；到期时刻按绝对 `dueAt` 结算，回到
  「最后一次按键 + 800ms」的真实停顿点。顺带修掉一条真实的退订泄漏：`resolve()` 也会被 render
  调用并就地换掉 `bound`（会话晚就绪），旧会话的三条 store 订阅此前一直挂到下次真切换才清，
  现在退订/订阅收敛到 `subscribeBound` 单一出口。虚拟时钟对照：armed 行数 1999 → 37、
  `setTimeout` 调用 1999 → 37、complete op 触发时刻 24780ms → 4700ms
  （`scripts/render-storm-smoke.mjs`）。**浏览器内归因已实测完成**：`renders{session=146,
  input=7,face=0,other=80}` —— 洪水来自 `sessions.list` 订阅（`onList`，未切会话时也无条件
  render）与错峰补渲染定时器，**不是**原推测的 `input.state.subscribe`；一次上百次 render 只产生
  一次 armed，修复在真实环境成立
- **设置页改开关在运行中不生效**（#19 遗留，`95994d6`）：`liveSettings = flattenConfig(resolved)`
  与 `effective()` 的两个入参同源，读的都是 `apply(ctx, config)` 首次解析并 `deepFreeze` 的时刻
  快照，内核重解析永不回填。新增 `src/live-settings.ts` 做「事件驱动标脏 + 下一次读才
  `describe()` + 5s TTL 兜底」的实时读源，`bootSettings` 降级为默认层，实时覆盖值按
  `keyof FlatConfig` 键表逐键取（`_ops`/`_push` 在类型层就落不进设置）。隔离实例已实测到
  `live settings refreshed rev=… applied=23`（按 revision 变化去重），即"改了能被重新读到"第一次
  成为可直接观察的事实；设置页各开关的逐项人工确认仍待 live 宿主重启（issue #19 验收清单）

- **同一个草稿再停顿多少次都不出续写**：宿主按载荷字符串全等给 `_ops` 去重，而「消费后清空
  `_ops`」在 `settings/document-updated` 回调里是**结构性不可能**的——那次写入落在内核 HMR 的
  `AsyncLocalStorage` 事务内，`runExclusive` 直接拒（`@deepseek-ai/dsh-hmr/lib/index.js:279-281`，
  本机一个进程实测 `HMR transactions cannot be nested` 372/373 次）。两件事实叠起来等于
  「同一份载荷永远只会被消费一次」：`pull` 因 `rev` 自增侥幸躲过，`complete` 的载荷
  `{rev:0, ops:[{op:'complete', sessionId, draft}]}` 逐字节由草稿决定，于是
  「输入 A → 停顿 → 改成 B → 删回 A → 再停顿」这条合法重发被当成回声静默丢弃。现在每次写入自带
  进程内单调 `seq`（新增 `src/client/ops-envelope.ts`，纯函数，locale 捎带一并收进来），
  去重回到它本来的职责。`scripts/ops-envelope-smoke.mjs` 断言不变量，并断言新增顶层键不会被宿主
  拒（`opsPayloadSchema` 非 strict；反向验过未知 op 仍被拒，判据不是永真）

- **故障留痕的节流按 kind 计数会吞掉新故障**：`traceFault` 原先用 `kind` 做计数键，于是
  「路由缺失」报出第一条之后，同一 50 次窗口里混进来的**任何不同性质**的新故障（写锁超时、
  模型 4xx、投影服务缺失）都被同一个计数器一起丢弃——等于主动重犯 #17 批评的静默丢弃。现在计数键
  改成 `kind + 归一化签名`（新增 `src/fault-signature.ts`）：同类只报计数，新类必定独立报出
  第一条。归一化只抹「每条都不同但显然同类」的部分（会话 id、`after Nms`、任意数字），
  原因文本保留，所以签名不会退化成常量。`scripts/fault-signature-smoke.mjs` 六组断言里
  最关键的一组就是「四类不同故障必须落在四个桶」
- **停顿续写的投递被内核事务拒绝，幽灵永远不出现**（#22，同时也是 #18 未修的那一半）：宿主消费
  `complete` → 生成续写成功 → 在 `await` 之后的续体里写 `_push` → 内核拒 `HMR transactions cannot be
  nested`（判据是 `dsh-hmr/lib/index.js:271,280,284` 的 `AsyncLocalStorage.getStore()`；ALS 沿
  await / microtask / **事务内建立的 timer** 传播，所以"推迟一个 tick"不逃逸）。实测五种写上下文
  后确定：**只有 `apply()` 期建立的异步上下文在事务外**（`boot-setInterval` 写入 OK 147ms，而
  completion 续体内的写入 1ms 即被拒）。新增 `src/deferred-writes.ts`（push/clearOps 两槽队列、
  时间与次数淘汰、`decidePushDrain`/`decideClearOpsDrain` 两个可离线证伪的判定）与 apply() 期
  `setInterval` 排水 pump，两个 nested 拒绝分支由"丢弃"改为"排队补写"。两条安全约束：带续写的载荷
  超 8s 丢弃（续写只对其所属草稿有意义，不做无界补投）；补做 `_ops` 清空前先比对盘上现值与入队时
  同步捕获的那份，不等就放弃（否则会吃掉未消费的新 op）。隔离实例端到端实测：
  `push refused … queued carriedCompletion=1` → `deferred push landed rev=3 carriedCompletion=1
  after=301ms attempts=1`，客户端 `#dsh-suggest-ghost-overlay[data-shown="1"]` 首次真的显示出续写；
  `_ops` 清空也开始成功（连带缓解"载荷长期滞留盘上、重启即被重放"）。**热重载不能用来验这条**：
  HMR 重建的 pump 仍带 `store=true`，部署必须整进程重启

- **续写的五个静默出口全部留痕 + 生成链加墙钟上界**（#22 的后续；`aa146b8` + `58feb39`）：
  `handleComplete` 原先在 `inlineEnabled=false` / 草稿太短 / 会话不存在 / 槽位被更新草稿接管
  （then 与 catch 两处）/ 请求被 abort 这五处**直接 return 不打任何痕迹**；而 `generateCompletion` 无超时，一次挂住就永久静默。实测比例：live 一个进程里
  `ops consumed: complete` 30 次只对应 5 次 `completion generated`，**25 次消失在无痕迹的分支里**。
  现在七条出口各有独立 kind/reason、报文只含字符数，纯判定抽到 `src/completion-gate.ts`。
- **超时留痕被自家节流吞掉**（同一轮里我自己造的第二个观测缺陷）：`traceFault` 按
  `kind + faultSignature` 分桶，而签名**刻意**把 `session-<hex>` 折成 `session` → 所有会话共用
  同一个 timeout 桶，`every: 5` 于是把第 2~4 次超时全部静音。现场表现正是"第二次停顿零痕迹"，
  极易被误读成"上界没触发"。timeout 改为 `every: 1` 逐次必报（每次都是用户白等一整轮；
  同一会话每个上界周期最多一条，量天然有界）。同一沙箱、同一配方、只改这一个数字做了单变量
  反证：`every:5` 复现零痕迹，`every:1` 打出 `#1` 与 `#2`。
- **上界监听挂错 signal**（第二条独立缺陷）：原先挂在 `deadline(upstream, …)` 的**融合** signal 上，
  于是"复用一个已 aborted 的 controller"会让融合 signal 一出生就是 aborted → 被判成"这不是我们的
  超时"→ **顺手撤掉 timer**，那次调用再也没有界（比原缺陷更糟：兜底被关掉）。融合 signal 中止后
  不再发第二次事件，"上游先中止 + 底层随后卡死"同样无界。现在超时权威是独立的 timer signal，
  交给生成链的才是 `AbortSignal.any([upstream, timer.signal])`，归属不再事后判断。

- **续写"变成回答"**（用户报：续写有时候怎么变成回答了）。两个成因叠加，各修一处：
  - *成因一（治本）*：`generateCompletion` 把「最近几轮对话 + 当前草稿」一起喂给模型，而
    `inlinePrompt` 只说 "predict the natural continuation"，模型把「上下文 + 用户刚说的话」
    读成「轮到我回应了」，于是去回答草稿里的问题。现在把三条生命周期事实**显式命名**：
    草稿是用户**尚未发出**的文字、上下文**只用于对齐术语与语气**、**绝不回答**其中的问题
    （新增 C6/C7/C8 条款；C1-C5 为既有五条约束，语义逐条保留）。条款改为 `C1.`-`C8.`
    编号锚点，`scripts/inline-prompt-smoke.mjs` 用集合精确比较把「一条都没被删」变成可断言。
  - *成因二（兜底）*：`shouldFilterCompletion` **刻意放行**问句与助手口吻（其注释与
    `inline-smoke` 的断言都钉着这个决定），所以回答在链路上无拦截。新增
    `shouldFilterCompletionFor(text, draft)`：原语义过滤 + 形态兜底
    （输出 ≥40 字 **且** > 草稿 × 3 → 判为对话式回答丢弃），单参版语义不变。
- 阈值不是拍的，两次都被自己的冒烟/复核抓回来：
  首版 8x → 冒烟当场漏掉实测的 `6→46`（7.7x）；改 5x 后复核发现仍漏 `16→67`（4.2x）、
  `34→135`（4.0x）、`22→79`（3.6x），且 `18→54` 恰好卡在等号上被 `>` 漏掉；取 3x 后
  拦下 8/42（5x 时 5/42）且正例全安全。数据源是同一次会话的 42 次 `completion generated`，
  字段只有长度（正文受隐私约束不落盘）：输出 min=2 中位=31.5 p90=67 max=135。
- 两条边界**明确留在"不拦"侧**并写进断言：输出 < 40 字不参与形态判定（`4→25` 这类 6.3x 放行，
  25 字中文完全可能是把半句写完）；恰好等于 3 倍不拦（等比例延伸是正常形态，不该因差一个字翻面）。
  取舍理由是不对称代价：漏拦可见、误杀与"没生成"同形（本仓库反复踩过的那类难查问题）。

- **「边打边等」不再被判失效**（用户实测：46 次停顿里 **45 次草稿长度都不同**）。原判据是
  `completion.draft === draft`（逐字全等），而续写是接在草稿后面的半句，用户在生成期间
  （中位 4.9 秒、最慢 17 秒）继续打字是最常见的用法 —— 全等判据把主路径整个判成了失效，
  用户看到的就是"等很久也不出东西"。用户当时靠**把等待时间调短**绕过，这是绕过不是修好。
  现在改为 `alignCompletion`：草稿未变或**以载荷草稿为前缀**都显示，并把你在末尾新打的、
  与续写开头重合的部分裁掉（已打出「构」→ 幽灵只补「建流程」）。
  只接受"你没改前面"的形态；**改中间/换内容/删末尾仍丢弃**（删字后光标位置无从得知，
  贴上可能错位 —— 宁可少显示，不可显错）。
- 判定与显示改为**共用同一次对齐结果**：早先这两处各写了一遍条件（`skipReason` 一套、
  显示分支一套），改动时极易只改一处（本仓库在别处踩过"两份真相互不约束"）。

### 文档

- 新增 `docs/internals-cordis-settings-pitfalls.md`：settings 双向通道与 volatile 引用的五条内核语义陷阱
  （`mutate` 的期望版本、TS 类型与 zod schema 漂移、单槽快照装不下一次性载荷、`apply(ctx, config)` 捕获的
  引用冻结、cordis 事件只向父传播），每条按「症状 → 根因 → 正确用法 → 错误用法 → 出处」写，并区分
  「已修」「待宿主验证」「内核契约」「仅本插件经验」
- 新增 `docs/upstream-feedback-settings-proxy.md`：#16 遗留思考的上游反馈草稿，**尚未提交给内核维护者**
- README.md / README.en.md 的「开发」章节各加一节「改双向 settings 通道前必读」，指向上面两篇文档

### 开发工具

- 新增 `scripts/artifact-freshness.mjs`：报告 `lib/` 是否比 `src/` 旧（2s 容差，避开 checkout 的
  毫秒级假阳性），以及 `<profile>/node_modules/dsh-suggest-ghost` 这条部署符号链接解析到哪个工作副本。
  多 worktree 并行时，只有链接指向的那一份会被宿主加载
- 新增 `scripts/gitignore-check.mjs`：查出「已被跟踪、但被 ignore 规则覆盖」的目录。这类目录里的新文件
  从此不进索引：文件在盘上、构建照常、`git status` 干净，而 `git checkout` 恢复不出来。判据用
  `git check-ignore --no-index`，缺 `--no-index` 时 git 会跳过已跟踪路径、恰好查不到这种状态
- 新增 `pnpm run check:loop`（两条体检一起跑）；`scripts/dev-loop-smoke.mjs` 用一次性 git 仓库断言
  上述判据，含「新文件 add 不进去」这条事故机制本身
- README.md / README.en.md 的「开发」章节各加一节，写清宿主加载哪份副本、以及改动到重启之间的落盘顺序

- README 中英版各加一节「宿主层改动怎么不重启就生效」：本 profile 把 `hmr.config.root` 合成成
  `[]`（只监听配置文件），而默认 `ignored` 里的 `**/node_modules` 又把 `link:` 形态的本插件排除掉，
  两层原因叠起来才造成「改宿主代码必须重启」。附可直接用的 `root/ignored/debounce` 片段、
  `--patch … --dump-config` 的免启动校验法，以及判据：`apply called; artifact mtime=…`
- `src/index.ts` 里「volatile 字段不落盘，故内存里没有跨进程残留」这条断言**是错的**，已按观测更正：
  `_ops`/`_push` 实际写在 profile 文档里，且一个复制该 profile 的新实例在没有任何客户端连接时就
  重放了遗留 `complete` 载荷。连带说明「消费后清空」为何长期失败、代价是什么

- 新增 `scripts/dev-sandbox.mjs`：一条命令拉起**隔离的第二个 DSH 实例**用于验证宿主层改动
  （`pnpm run sandbox` / `sandbox:check`）。隔离做在两层：`DSH_HOME` 独立（`sessions`/`storages`/
  `logs` 全部落沙箱），以及**插件产物独立**（私有 `lib/` 副本，其余依赖逐条软链，不跑 install）。
  后者是必须的：否则往沙箱里放未验证构建，会污染 live 宿主下次重启真正加载的那份 `lib/`。
  实测：父进程退出后子进程存活，改 `lib/index.js` 内容触发重新 apply（`apply called` 的 mtime 变）。
- 过程中钉住三件事：① profile 里 `dsh-host-webserver` 的 `port: 3081` 必须换掉，`--port 0`
  只管主 GUI 端口（不换会 `EADDRINUSE` → `webServer` 缺失 → 实例跑第一个 agent 回合时自行退出，
  我一度误判成"热重载杀进程"）；② `_push` 是跨 16 行的单引号标量，按行删会把它改坏（
  `stripKeyBlock` 按缩进整块删，`scripts/dev-sandbox-smoke.mjs` 反向验过：退化成按行删即报红）；
  ③ group 成员无法用 `--patch` 叠加层禁用（`webhook-webserver` 嵌在 `webhook-listener` 的
  `config:` 列表里，overlay 指 group 或叶子都不生效），所以走换端口而不是禁用
- 另两处自记的坑也写进了脚本注释：日志 fd 必须归子进程（父进程接管道则它退出后子进程写日志
  吃 EPIPE 而死）；`pkill -f` 的模式串会匹配到调用方自己的命令行

- 新增 `scripts/completion-align-smoke.mjs`（11 组）。写它的时候**连续抓到自己三处错**：
  ① `overlap` 计算里 `Math.min` 套 `Math.max` 无意义；② 多乘了一维"cur 与 cur+text 的公共
  前缀"，在"你打的字与续写无关"和"载荷草稿为空"两种情况下会误裁（冒烟当场抓到）；
  ③ 两条断言构造错误 —— 把"用户多打了一个与续写不重合的字"写成了"应当裁掉续写首字"，
  实际不裁才是对的。这三处都是实现/断言写错，不是需求变更。
- 顺带查实一个观测缺口：`src/client` 被根 `tsconfig.json` exclude，客户端走 esbuild
  **只转译不检查类型**，所以 `pnpm typecheck` 对客户端代码**没有任何约束**。
  `tsconfig.client.json` 是既有的诊断配置（注释里已写明"补齐两个 devDep 后可当门禁"），
  当前基线 40 条错误、尚未接入。本轮新代码在它下面只多出 1 条 **TS5097**（`.ts` 后缀导入），
  与同目录既有 9 处 import 完全同类，属既有配置缺陷的复制、非新类型问题。

### 变更

- `scripts/dev-sandbox.mjs` **通用化**：脚本本体不再含任何插件/本机专有字面量（代码区命中 0 处）。
  插件身份从 `package.json` 的 `name` 推导、profile 条目 id 用 `name: <包名>` 反查；原先硬编码的
  三样东西分别变成 `sandbox.rewrites`（整行替换 + 0 命中即拒启动 + 端口占用扫描）、
  `sandbox.disable`（顶层条目；group 成员无效这点写进 help）、`sandbox.greps`（验收读法）。
  易失载荷剥离也从"全局删 `_ops`/`_push`"改为**只删本插件条目名下的 `_` 前缀键** —— 全局删会
  顺手改掉别人条目的状态。`dev-sandbox-smoke` 从 5 组扩到 14 组，并做了两轮变异验证：忽略 entryId、
  把整行匹配放宽成包含匹配，都能报红（第一处变异起初漏抓，原因是 fixture 把别人条目排在了后面）

- **`inlineDelayMs` 默认值 800 → 100**（用户要求）。这个字段只决定"何时发请求"，不决定等多久：
  总等待 ≈ `inlineDelayMs` + 生成耗时。真实环境实测生成 **1.1~17 秒**（42 次：最快 1100ms、
  中位 4900ms、最慢 16986ms），所以 0.7 秒的差别在总时长里占比很小；代价是中文打字间隔常在
  0.1~0.3 秒，降到 100 后**几乎每敲一个字都触发一次 complete**，而单飞机制会 abort 掉在途生成
  （重启前实测：46 次停顿只产出 26 次生成）。**该值未经 A/B 对照实测**，是按要求改的产品决定；
  若后续发现 `completion preempted` 暴增而 `generated` 未涨，应回调。
- 该默认值**散在 5 处**（宿主 schema、宿主两处 `readVolatile`、客户端字面量与解析兜底）外加中英
  两处文档，各自写死、单独看都合法。新增 `scripts/inline-default-smoke.mjs`（3 组）把它们的一致性
  变成可断言的事：任一处单独改动即红（两个方向都做了变异验证）。它**不测"默认值应该是几"**
  （那是产品决定），只测几处彼此一致。
- 顺带修正 README 里两处**我此前写错的数字**：原文说生成"要 19~28 秒（隔离实例量到
  18971/24217/27793ms）"，那是**沙箱里另一个模型**的数字，被我拿去解释了真实环境。真实环境是
  1.1~17 秒。同时补上"已经到达的那份续写仍会按对齐判据显示，不再被丢弃"（#33 的行为）。

### 验证

- **#22 在 live 宿主结项**（2026-10-20 08:48 重启后，`apply called; artifact mtime=` 证明加载的是
  19 日 16:35 那份构建）。完整链路在真实环境读到：`completion generated` → `push refused inside
  settings transaction … queued carriedCompletion=1` → `deferred push landed … attempts=1`
  （37 次带续写的补写成功，平均 +1.2s，全部首次尝试即落）。`deferred _ops cleared after consume`
  85 次成功，而 live 旧行为是 0 次 —— 载荷不再长期滞留盘上。`live settings refreshed rev=…`
  也出现了（#19 的"改了有没有被重新读到"第一次在真实环境可观测）。
  唯一未补回的 `rev=41` 无用户可见影响：`bceac31` 的持续捎带让后续任何一次推送都自带同一份续写
  （其后 13 次补写落地、盘上 `_push` 现含 completion），等于这条通道对**单次推送丢失是自愈的**。
  这层作用是本次实测才发现的，此前文档只把捎带写成"解决瞬时载荷被覆盖"。
- 新增一节「内核代次与锚点位置」：本机内核已从 `0.2.0-rc.2` 升到 `0.2.1-rc.2`，两处锚点行号漂移
  （`dsh-hmr` 的 ALS 三处 271/280/284 → 736/749/752；`dsh-app-boot` 的 exporter 4053-4066 →
  4513-4515），另三处未变（`dsh-settings` 435/509/511、`bin.js` 158）。因此本文与代码注释改为
  **按符号引用**，行号只在那一节维护一份。

### 实测事实（会改变结论的那条）

- **续写的耗时：两个环境差一个量级，别拿一个环境的数字解释另一个。**
  - 真实环境（2026-10-20，42 次生成）：**1.1~17 秒**，最快 1100ms、中位 4900ms、最慢 16986ms。
    这是用户实际体感的依据。
  - 沙箱隔离实例（同一台机器、另一个模型路由）量到 `in 18971ms` / `24217ms` / `27793ms`。
    **本文档早前把这三个数字当成"本环境的健康耗时"并据此解释用户现象，是错的** ——
    用一个环境的数字解释另一个环境，方向就偏了。
  - 20s 上界在沙箱环境确属**误杀**（现场出现过 `no settle within 20000ms … after 20001ms`，
    那是一次本来会成功的生成），故按沙箱实测最慢 ×1.5 取 **45s**，仍紧于内层单 attempt 的 60s。
  - 耗时与输出字数**不成正比**（132 字比 109 字快），固定开销主导，所以"按吞吐外推"这类取值
    算术作废。
  - live 那 25 次"消失"的主桶是 `completion-preempted`：在途生成（当时以为 19~28s）长于连续
    打字时两次停顿的间隔，每次新停顿都会中止上一次的请求 —— 真实环境虽只有 1.1~17s，
    但玩家边打边等时这个竞争依然存在，这正是后续改用**前缀对齐**（见「修复」）而非放宽阈值的原因。

### 已知缺口

按当前代码状态核对过；下面每条都还成立（原先列在这里的四项已关掉，故移除：「#17 留痕被删」与「#16 写后读回」
由 `89d3a1a`/`81778cf` 完成、「schema 变体覆盖无断言」由 `b947977` 的冒烟挡住、
「#21 运行时归因」由隔离实例实测完成 —— 它是测量结果不是代码改动，所以没有对应 commit）：

- **宿主侧 settings 写面普遍没有 CAS**：`ctx.settings.update(ns, patch)` 的第三参
  `expectedRevision` 在本插件所有调用点都没传，而内核判据是 `expected !== void 0`
  （`dsh-settings/lib/index.js:511`）——`expected` 缺省时**整段冲突校验被跳过**，调用必然"成功"。
  唯一带真实 CAS 的是 `remote.settings.mutate` 那一次 `_ops` 写。设置卡片的
  `remoteSettingsScope().set`（`src/client/index.ts`）同样忽略 `mutate` 的 `ok`：保存冲突时卡片
  显示成功，随后被下一次 `readValue()` 静默改回
- **续写投递是"排队补写"而不是根治**：被事务拒绝的写入交给 apply() 期 pump 补投（最坏 +500ms），
  根治要内核提供事务外退出（`executing.exit()` 一类）或把 `document-updated` 改成事务外 emit，
  见 `docs/upstream-feedback-settings-proxy.md` 第二诉求。另有一个未修的 sub-tick 竞态：pump 取走
  旧载荷在途时来了更新载荷，旧的仍会落一次盘再被新的覆盖；根除需要 `_push` 写入带 revision CAS
- **#4 的残余窗口**：宿主把编辑器提交批处理在 store 发布之前时，`draft` 与 `draftRev` 会一起是
  旧值，内容/版本比对都看不出漂移。闭合要宿主把 `captureInsertion()` + `insertText(text, span)`
  交到插件手上（采纳是整段替换，用 span 反而引入新的坐标系假设，理由写在 `accept-guard.ts`）
- **`GhostPushPayload` 是第二份会漂移的真相**：它从未被用作类型约束（全仓只在注释里出现），要让它
  受编译器管得先把 `src/index.ts` 里那个局部 `ClientPush` 提升为导出类型再派生 —— 跨 3 个文件的
  结构性改动，且会立刻把"宿主写 `error` 字段、客户端解析结构里没有它"变成显式契约问题
- **#19 的逐项人工确认**：`live settings refreshed` 已实测到，但设置页各开关（停顿续写 / LLM 建议 /
  阈值 / top-K 含 0=不限 / 冷启动对账 / 热度面板）仍需 live 宿主重启后按 issue #19 清单逐项过一遍
- **运行期日志通道只有 stdout**：健康进程里 `ctx.logger` 不落任何地方（exporter 只收 warn/error，
  且 `startupLogs` 只在启动失败时写盘），而 `console.log` 又是 `6dfcd78` 那类"清理调试噪声"的
  删除目标。本插件用固定标记 `[dsh-suggest-ghost][ops-trace]` 区分语义留痕与调试噪声，但通道本身
  的缺失是平台问题，语义留痕长期该有正式落点

- **排水锚点不是无条件可靠**：live 出现 3 次 `deferred push write refused again in the apply()-time
  pump … pump context is inside a transaction`，其中 2 个载荷 8 次尝试耗尽后丢弃（都是
  `carriedCompletion=0`，即非续写载荷）。含义：`apply()` 期建定时器"在事务外"这个前提在**内核反复
  重载 profile 条目**时会失效（本机同时刷了 2290 行 `webhook@0.2.0-rc.2 incompatible with
  dsh 0.2.1-rc.2` → 条目被反复禁用/重载）。所以锚点只在干净 boot 后稳定，靠它兜住一切写入是过度信任；
  根治仍是诉求二（`document-updated` 改到事务外 emit）

## [0.5.0] - 2026-10-10

### 新增

- **语言检测增强**：`suggestionLanguage` 先去噪（移除代码块/URL/路径），再按文字系统字符数统计主导语言，避免代码里的 CJK 字符误导判断
- **历史补全定位改进**：锚定到 DOM 量出的草稿行尾，修复垂直偏移（行高居中补偿）
- **设置卡片增强**：新增 `select` 控件类型、`language` section、更多可调字段（`maxInputBytes`、`maxOutputTokens` 等改为 writable）

### 改进

- **配置重构**：`StrategyFields` 合并到 `EditableFields`，全部标 `.volatile()`，统一走 WebUI 表单
- **热度淘汰优化**：`MinSeqHeap` 按 `(seq, count)` 双键排序，高频条目保留更久（如 ×21 的常用短语比单次条目存活更久）
- **文本排版属性**：ghost overlay 完整复制 30+ 项 CSS 排版属性（font-variant-*, text-rendering 等），长建议换行与编辑器一致

## [0.4.1] - 2026-10-10

### 修复

- **建议语言支持西里尔文字（俄语等）**：`suggestionLanguage` 新增 `hasCyrillic` 检测，俄语用户不再收到英文建议（[GitHub #1](https://github.com/dsh-plugins/dsh-suggest-ghost/issues/1)）
- 非 CJK/非西里尔文字回退到「镜像用户语言」指令，覆盖所有文字系统（法语、德语、西班牙语、阿拉伯语等）
- 新增冒烟测试覆盖多语言场景

## [0.4.0] - 2026-09-29

### 重大变更

- **适配 DSH 0.1.7+ volatile 配置体系**：`settings.yaml` 已被上游移除，本插件改用 `ctx.settings.update` + `settings/document-updated` 事件通道；策略字段（`maxInputBytes`、`maxOutputTokens` 等）保留在 Config 中由 `cordis.patch.yml` 控制，可调字段改走 volatile 存储
- **支持五代内核**：peer 依赖从两代扩展到五代（`0.1.1-rc.2`、`0.1.2-rc.1`、`0.1.5-rc.3`、`0.1.7-rc.2`、`0.2.0-rc.2`）；`0.2.0` 起 peer 不满足会在加载期硬拒绝，必须枚举对应代次

### 新增

- 设置卡片改为 section 分组表单布局（LLM / 历史 / 热度管理），对齐官方 SettingsForm 视觉
- 新增「在设置中显示」开关（仅详情页），控制设置对话框中是否出现本插件设置页
- 新增帮助按钮（字段级说明，aria-expanded 切换）
- 新增 `icon.svg` 插件图标
- 新增 `ghost-geom-smoke.mjs` 冒烟测试（overlay 定位几何验证）
- 新增 `settings-scope.ts`（client 侧 scope 最小面类型，适配 0.1.7 移除的旧 scope）
- 新增 `styles.ts`（样式从卡片组件抽取，`sgc-` 前缀防冲突）
- 每会话建议表（`suggestionBySession`）替代单槽，多开会话互不干扰
- 新增 `cosmokit` 依赖（上游 settings 事件类型来源）

### 修复

- 设置卡片「显示设置」section 补上 i18n（中英双字典），英文界面不再残留中文

### 已知取舍

- 升级到 `0.1.7+` 后旧设置不自动迁移（volatile 字段不落盘），需按默认值重设一次
- 重启后上一条建议需要重新生成（新回合跑完即恢复）；历史前缀补全与热度面板照常可用

## [0.3.0] - 2026-09-16

### 新增

- **冷启动语义改造**：重启后不再「没有数据」
  - 改「时间」判据为**语义**判据：启动时回读盘上残留并校验，有效则原样恢复
  - 可判定为陈旧则清场；会话尚未进店时不猜测、不覆盖
  - 会话活跃期间由 `session/event` 增量维护
- 日志取环种子、回合语义校验、`_push` 回读
- 热度持久化语义（storage 域、回合边界合并落盘、重启恢复合并）
- 双语 README 重写（提升插件商城可发现性）
- AppStore 风格截图声明

## [0.2.1] - 2026-09-14

### 修复

- 修复幽灵文本重叠问题
- 修复 placeholder 让位逻辑

## [0.2.0] - 2026-09-04

### 新增

- 初始发布：LLM 下一条建议 + 历史前缀补全
- 热度管理（跨会话高频短语）
- 设置卡片（中英双语）
