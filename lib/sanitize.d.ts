/**
 * 输出安全管线：转录脱敏、输出净化、语义过滤与截断。
 * 参考 @studyzy/dsh-suggest-prompt（MIT 许可）的安全设计，重写为精简实现。
 * @module dsh-suggest-ghost/sanitize
 */
/** 把文本中的密钥形状替换为占位标签。 */
export declare function redactSecrets(text: string): string;
/**
 * 净化模型输出：剥离控制序列与覆盖符、去除引号与围栏、压缩为单行。
 * 注意顺序：**先剥围栏再删控制符**——若先删 `\n`（属于 C0 控制符），围栏标记
 * 与正文会连成无空白的一串，`\S*` 会一路吞到底（```json\n{...}\n``` 变空串）。
 * @returns 净化后的单行文本（不截断）。
 */
export declare function cleanSuggestion(text: string): string;
/** 建议可见字符上限截断；返回截断标记。 */
export declare function sanitizeSuggestion(text: string, maxChars: number): {
    readonly text: string;
    readonly truncated: boolean;
};
/** 检测文本是否含中日韩字符（决定建议回复语言）。 */
export declare function hasCJK(text: string): boolean;
/** 检测文本是否含西里尔字母（俄语等）。 */
export declare function hasCyrillic(text: string): boolean;
/** 判定净化后的输出是否应丢弃（返回 true = 无建议）。 */
export declare function shouldFilterSuggestion(text: string): boolean;
/** 续写场景的过滤：比建议场景更宽松，问句/感谢/助手口吻在续写语境下是合理续写。 */
export declare function shouldFilterCompletion(text: string): boolean;
/**
 * "续写变成了回答"的形态兜底判据。
 *
 * ## 为什么需要它
 *
 * `shouldFilterCompletion` 只做语义过滤，且**故意**放行助手口吻与问句（见上一行的注释，
 * `scripts/inline-smoke.mjs` 有断言钉着这个决定）。于是当模型把「用户正在输入的草稿」
 * 当成「发给它的消息」去**回答**时，链路上没有任何拦截 —— 用户看到的就是幽灵位置冒出一段
 * 回复而不是下半句。
 *
 * ## 为什么用形态而不是语义正则
 *
 * 想靠 `ASSISTANT_VOICE_RE` / `QUESTION_RE` 拦，就会误杀中文正常续写：这两个正则里有
 * `我来|我帮你|让我` 和 `？`，而中文草稿的续写里"你""吗""？"极其常见 —— 拦掉它们等于把
 * 这个功能的常用场景一起砍掉。所以改用**与语言无关的形态特征**：真正的续写是"接着你的话
 * 往下写半句"，而回答是"成段、且相对草稿显著更长"。
 *
 * ## 阈值怎么来的（线上实测，非拍脑袋）
 *
 * 数据源：`/tmp/dsh-web-now.log` 单次会话的 42 次 `completion generated`，字段只有长度
 * （正文受隐私约束不落盘），分布：
 *
 * ```
 * 输出长度  min=2  中位=31.5  p90=67  max=135
 * 12/42 次 输出 > 草稿 3 倍；最极端 5 字草稿 → 94 字输出（18.8x）
 * ```
 *
 * - `>200` 的绝对上限已由 `shouldFilterCompletion` 承担，这里不重复。
 * - 取 **输出 > 草稿 × 5**（`CONVERSATION_RATIO_TRIGGER`）并叠加 **输出 ≥ 40 字**
 *   （`CONVERSATION_MIN_CHARS`）：两个条件同时满足才判为对话式回答。
 *   比值取 3 的经过（两次都靠冒烟/复核抓出来，不是拍的）：
 *   首版写 8x → 冒烟当场漏掉实测的 6→46（7.7x）；改 5x 后复核发现仍有 3.0~4.2x 那批
 *   （16→67、34→135、22→79、18→54）会被放过，而 9→54 恰好卡在等号上被 `>` 漏掉。
 *   取 3x 后拦下 8/42（5x 时 5/42），且正例全安全。
 *   不再往下压到 2.5x（能到 10/42）：2.5x 已经进入"短草稿正常续写"的常见区间，
 *   继续压会开始误杀；而下面的绝对量门限保证短输出不参与判定。
 *   - 既有正例（`What about the tests?` 21 字、`thanks for asking!` 18 字、
 *     `Let me look into that for you` 29 字）都**不到 40 字**，绝对安全；
 *   - 实测里 `174 字草稿 → 125 字输出`（0.7x）这类**长草稿正常续写**也不会被拦（0.7x，远小于 3）。
 *
 * 用**字符数**而非词数：中文没有空格，`text.split(/\s+/)` 对中文几乎无效（既有实现里那句
 * 孤立词判定对中文基本是空转），比值必须按字符算。
 *
 * @param text 净化后的续写输出
 * @param draft 生成这份续写时客户端提交的草稿
 * @returns true = 判为对话式回答，应当丢弃
 */
export declare function shouldFilterCompletionFor(text: string, draft: string): boolean;
/** 剥离续写输出中对草稿的回显（避免重复用户已输入的内容）。 */
export declare function stripDraftEcho(completion: string, draft: string): string;
