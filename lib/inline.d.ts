/**
 * 停顿续写（inline completion）纯函数：续写指令模板、输出净化链。
 *
 * 独立成模块的原因：`generate.ts` 里的 `generateSuggestion`/`generateCompletion`
 * 用了 `using`（显式资源管理）语法，Node 22 的 `--experimental-strip-types`
 * 冒烟装载器不识别，任何从 generate.ts 的导入都会让纯函数冒烟测试链接失败。
 * 把「无运行时依赖的续写纯函数」抽到这里，generate.ts 只做 LLM 编排。
 * @module dsh-suggest-ghost/inline
 */
/**
 * 行内续写指令：预测草稿的自然延续，禁止复述草稿或生成内容。
 *
 * 与 `systemPrompt`（预测下一条提示词）不同：这里模型看到的是用户**正在输入**
 * 的草稿，任务是续写它——像 IDE 的 Copilot 那样在光标后补全。
 *
 * ## 为什么要把「生命周期」写进指令（线上回归：续写变成回答）
 *
 * user 消息形如 `Recent conversation context:\n<最近几轮>\n\nCurrent draft ...:\n<草稿>`。
 * 只给一句 "predict the natural continuation" 时，模型会把「对话上下文 + 用户刚说的话」
 * 读成「轮到我回应了」，于是**去回答草稿里的问题**；下游 `shouldFilterCompletion`
 * 又刻意放行问句/助手口吻（续写场景不过滤），回答因此被放行到 UI。
 * 线上 42 次生成里 12 次「输出 > 草稿 3 倍」，最极端 draft=5 → out=94。
 *
 * 对策是把三件事**显式命名**，不再指望模型从 "continuation" 自行推断：
 *  1. 输入是用户**尚未发出**的草稿，不是发给你的消息；
 *  2. 上下文**只用于对齐术语与语气**，不是要你回应的对话；
 *  3. **绝不回答**草稿里的问题/请求（含不写 `你`、不解释、不建议），只补下半句。
 *
 * ## 条款编号约定（`scripts/inline-prompt-smoke.mjs` 依赖它）
 *
 * `C1`–`C8` 是**稳定条款锚点**：冒烟用 `/^C(\d+)\. /m` 抽取条款清单，把
 * 「五条既有约束一条都没被删」变成可断言的集合比较，并把每条映射到关键短语。
 * **改条款内容可以，改/删锚点编号会让冒烟红**——这是故意的：锚点是证伪的抓手。
 *
 * C1 语言 / C2 单行 / C3 不复述草稿 / C4 slash 命令 / C5 字符上限是既有语义，
 * C6–C8 是本次新增的「反回答化」禁令。
 */
export declare function inlinePrompt(maxChars: number, language: string): string;
/**
 * 续写输出净化链：cleanSuggestion → stripDraftEcho → trim → filter → sanitizeSuggestion。
 * 返回净化后文本；空/不合格返回 undefined。
 *
 * 过滤这一环走 `shouldFilterCompletionFor(out, draft)`（而非单参的
 * `shouldFilterCompletion`）：后者在续写场景**刻意放行**问句/助手口吻，
 * 而「续写变成回答」正是从这个口子漏出去的。新判据 = 原语义过滤 + 一道形态兜底
 * （输出 ≥40 字且 > 草稿 ×5 → 判为对话式回答）。详见 `src/sanitize.ts`。
 * 调用顺序与签名 `(raw, draft, maxChars)` 未动。
 */
export declare function sanitizeCompletion(raw: string, draft: string, maxChars: number): string | undefined;
