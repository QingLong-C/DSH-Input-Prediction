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

### 文档

- 新增 `docs/internals-cordis-settings-pitfalls.md`：settings 双向通道与 volatile 引用的五条内核语义陷阱
  （`mutate` 的期望版本、TS 类型与 zod schema 漂移、单槽快照装不下一次性载荷、`apply(ctx, config)` 捕获的
  引用冻结、cordis 事件只向父传播），每条按「症状 → 根因 → 正确用法 → 错误用法 → 出处」写，并区分
  「已修」「待宿主验证」「内核契约」「仅本插件经验」
- 新增 `docs/upstream-feedback-settings-proxy.md`：#16 遗留思考的上游反馈草稿，**尚未提交给内核维护者**
- README.md / README.en.md 的「开发」章节各加一节「改双向 settings 通道前必读」，指向上面两篇文档

### 已知缺口

- #17 同时要求「schema 拒绝路径必须留痕」，那行日志（`parseHotnessOps` 打印 issues 摘要）已随 main 的
  `6dfcd78`（chore: remove all debug console.log statements）一并删除；`parseHotnessOps` 现在三条返回空
  ops 的路径全部静默。#16 的冲突/失败日志同批被删（重试逻辑本身保留）
- #16 的写后读回校验仍缺：`writeOps` 成功兑现不等于值已落盘（对比设置卡片路径写入后会 `readValue()`）
- #19 遗留未修：用户可调项仍从被捕获的 `resolved` 读取，也就是会冻结的 volatile 引用（另分支处理）

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
