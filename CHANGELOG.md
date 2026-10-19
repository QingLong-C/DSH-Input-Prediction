# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
  **运行时验证未完成**：需要重启宿主后观察续写显示，本条目只记录代码已合入
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
  （`scripts/render-storm-smoke.mjs`）。**浏览器内的实测归因仍未做**：三个来源各自的事件数
  搭在 `inline armed` 行里打印，留给下次运行时观察
- **设置页改开关在运行中不生效**（#19 遗留，`95994d6`）：`liveSettings = flattenConfig(resolved)`
  与 `effective()` 的两个入参同源，读的都是 `apply(ctx, config)` 首次解析并 `deepFreeze` 的时刻
  快照，内核重解析永不回填。新增 `src/live-settings.ts` 做「事件驱动标脏 + 下一次读才
  `describe()` + 5s TTL 兜底」的实时读源，`bootSettings` 降级为默认层，实时覆盖值按
  `keyof FlatConfig` 键表逐键取（`_ops`/`_push` 在类型层就落不进设置）。**需宿主重启后按
  issue #19 的验收清单确认**

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

### 修复

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

### 开发工具

- README 中英版各加一节「宿主层改动怎么不重启就生效」：本 profile 把 `hmr.config.root` 合成成
  `[]`（只监听配置文件），而默认 `ignored` 里的 `**/node_modules` 又把 `link:` 形态的本插件排除掉，
  两层原因叠起来才造成「改宿主代码必须重启」。附可直接用的 `root/ignored/debounce` 片段、
  `--patch … --dump-config` 的免启动校验法，以及判据：`apply called; artifact mtime=…`
- `src/index.ts` 里「volatile 字段不落盘，故内存里没有跨进程残留」这条断言**是错的**，已按观测更正：
  `_ops`/`_push` 实际写在 profile 文档里，且一个复制该 profile 的新实例在没有任何客户端连接时就
  重放了遗留 `complete` 载荷。连带说明「消费后清空」为何长期失败、代价是什么

### 修复

- **故障留痕的节流按 kind 计数会吞掉新故障**：`traceFault` 原先用 `kind` 做计数键，于是
  「路由缺失」报出第一条之后，同一 50 次窗口里混进来的**任何不同性质**的新故障（写锁超时、
  模型 4xx、投影服务缺失）都被同一个计数器一起丢弃——等于主动重犯 #17 批评的静默丢弃。现在计数键
  改成 `kind + 归一化签名`（新增 `src/fault-signature.ts`）：同类只报计数，新类必定独立报出
  第一条。归一化只抹「每条都不同但显然同类」的部分（会话 id、`after Nms`、任意数字），
  原因文本保留，所以签名不会退化成常量。`scripts/fault-signature-smoke.mjs` 六组断言里
  最关键的一组就是「四类不同故障必须落在四个桶」

### 已知缺口

- #17 要求「schema 拒绝路径必须留痕」，那行日志（`parseHotnessOps` 打印 issues 摘要）已随 main 的
  `6dfcd78`（chore: remove all debug console.log statements）一并删除；`parseHotnessOps` 现在三条返回空
  ops 的路径全部静默，而 :265 的注释还写着「必须留痕」。**留痕改走 `ctx.logger.warn` 正在处理**
  （分支 `fix/issue-16-17-writeback`），console.log 会被下一轮清理当成调试噪声删掉
- #16 的写后读回校验仍缺：`writeOps` 成功兑现不等于值已落盘（对比设置卡片路径写入后会 `readValue()`）；
  冲突判定也还是 `/conflict|revision/i` 文本匹配，未改用内核的 `error.code === 'SETTINGS_CONFLICT'`
  （`@deepseek-ai/dsh-settings/lib/index.js:511`）。同分支处理中
- 没有任何断言保证 `opsPayloadSchema` 覆盖 `HotnessOp` 的全部变体——#17 那类「类型有、schema 没有」的
  漂移只能靠一条遍历变体的冒烟挡住。同分支处理中
- #4 的残余窗口：宿主把编辑器提交批处理在 store 发布之前时，`draft` 与 `draftRev` 会**一起**是旧值，
  内容/版本比对都看不出漂移。真正闭合要宿主把原子插入 verbs（`captureInsertion()` + `insertText(text, span)`）
  交到插件手上，本插件用的是「校验后 `setDraft`」
- #21 的运行时归因未做：1127 次 render 到底来自哪条订阅，只有浏览器里能看到（`inline armed` 行的
  `renders{session,input,face,other}` 计数）；`remote.$on('settings/document-updated')` 是否真把
  `(ns, revision)` 透传到客户端也待确认——载荷不带 ns 时代码退化成「不过滤」
- `GhostPushPayload`（`src/settings.ts`）从未被用作类型约束，只在注释里出现，是第二份会漂移的真相；
  宿主写的 `error` 字段客户端解析结构里没有（写了没人读）

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
