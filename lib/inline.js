/**
 * 停顿续写（inline completion）纯函数：续写指令模板、输出净化链。
 *
 * 独立成模块的原因：`generate.ts` 里的 `generateSuggestion`/`generateCompletion`
 * 用了 `using`（显式资源管理）语法，Node 22 的 `--experimental-strip-types`
 * 冒烟装载器不识别，任何从 generate.ts 的导入都会让纯函数冒烟测试链接失败。
 * 把「无运行时依赖的续写纯函数」抽到这里，generate.ts 只做 LLM 编排。
 * @module dsh-suggest-ghost/inline
 */
import { cleanSuggestion, sanitizeSuggestion, shouldFilterCompletion, stripDraftEcho, } from './sanitize.js';
/**
 * 行内续写指令：预测草稿的自然延续，禁止复述草稿或生成内容。
 *
 * 与 `systemPrompt`（预测下一条提示词）不同：这里模型看到的是用户**正在输入**
 * 的草稿，任务是续写它——像 IDE 的 Copilot 那样在光标后补全。
 */
export function inlinePrompt(maxChars, language) {
    return [
        'You are an inline text completion engine. Your ONLY job is to predict the natural continuation of the user\'s in-progress text.',
        '',
        `OUTPUT LANGUAGE: ${language}. Every word of your continuation MUST be in ${language}. Do NOT mix languages.`,
        '',
        'CRITICAL CONSTRAINTS:',
        '- You MUST NOT echo the draft. Output ONLY the continuation text that follows the draft.',
        '- Output a single line. No Markdown, no quotes, no labels, no explanation.',
        '- If the draft starts with a slash command (e.g. /later, /remind), continue its argument text naturally.',
        '- Match the tone and style of the draft.',
        '- If nothing natural follows, reply with nothing at all.',
        '',
        `At most ${maxChars} visible characters.`,
    ].join('\n');
}
/**
 * 续写输出净化链：cleanSuggestion → stripDraftEcho → trim → filter → sanitizeSuggestion。
 * 返回净化后文本；空/不合格返回 undefined。
 */
export function sanitizeCompletion(raw, draft, maxChars) {
    let out = cleanSuggestion(raw);
    out = stripDraftEcho(out, draft);
    out = out.trim();
    if (out.length === 0 || shouldFilterCompletion(out))
        return undefined;
    return sanitizeSuggestion(out, maxChars).text;
}
