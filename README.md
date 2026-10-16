> 感谢 [OneHop](https://onehop.ai) 对本项目的赞助！OneHop 可为用户提供一枚兼容 OpenAI 协议的 API 密钥，即可调用上百款主流大模型，包括 GPT、Claude、Gemini、DeepSeek、Kimi 以及通义千问（Qwen）。你无需管理多家服务商账号，也不用反复修改代码，就能自由切换模型；并且采用按量付费模式。→ [onehop.ai](https://onehop.ai)

# DSH-Input Prediction

DSH-Input Prediction 是面向 DSh 桌面客户端的输入预测插件。AI 回复结束后，插件根据近期对话生成下一条用户消息建议，并以灰色文字显示在空输入框中。支持中文追问、方案比较、下一步操作及简短确认。

[下载安装包](https://github.com/QingLong-C/DSH-Input-Prediction/releases/latest) · [问题反馈](https://github.com/QingLong-C/DSH-Input-Prediction/issues) · [English](README.en.md)

## 功能

- **回复后预测**：以完整回复为依据生成建议，不在思考或正文生成阶段展示未确认的候选。
- **意图核对**：优先保留用户目标与约束；候选须通过独立核对，不能把助手主动提议当成用户决定。不明确时不显示建议。
- **中文对话支持**：支持自动识别对话语言，也可在设置中指定简体中文。
- **自主采纳**：建议仅填入草稿，不会自动发送；用户可以修改或忽略。
- **输入保护**：开始输入后隐藏建议，新回合开始时清除旧建议，不覆盖已有草稿。
- **独立插件安装**：通过 DSh 插件接口运行，无需修改客户端安装包。

默认仅启用回复后的整句预测。历史补全、输入停顿续写及逐词采纳默认关闭，可按需在插件设置中启用。

## 安装与升级

### 通过 Agent 安装（推荐）

复制以下指令并发送给 DSh Agent。GitHub 代码块右上角提供复制按钮；同一条指令也可用于升级。

```text
请将 DSH-Input Prediction 安装或升级到我的当前 DSh 配置：从 https://github.com/QingLong-C/DSH-Input-Prediction/releases/latest 获取最新正式版的 .tgz 安装包及 SHA256 校验文件，下载并验证校验值后，使用 DSh 原生 plugin_manager 工具安装并启用（install_bundle，target 为下载文件的绝对路径，enabled=true），保留已有设置，不安装 npm 同名包；完成后核对实际安装版本、启用状态及加载错误，告知结果，如需重启则明确说明，不能将“已下载”或“等待重启”报告为“已生效”。
```

DSh 需启用 `plugin_manager` 工具（通常在 Creator 模式下可用），Agent 才能直接执行安装。客户端要求的权限确认仍需按提示完成；覆盖升级可能需要退出并重新启动 DSh。其他 Agent 也可使用这段指令，但必须具备当前 DSh 配置的插件管理能力；工具不可用时，请使用下方手动安装方式。

### 手动安装

1. 从 [Releases](https://github.com/QingLong-C/DSH-Input-Prediction/releases/latest) 下载最新的 `.tgz` 安装包，无需解压。
2. 在 DSh 中打开「插件」→「添加插件」，输入安装包的完整路径并安装。
3. 首次安装后选择「立即启用」；覆盖升级后，请完整退出并重新启动 DSh。
4. 确认插件列表显示 **DSH-Input Prediction**，完成一轮对话后即可使用。

内部包名保留为 `dsh-suggest-ghost`，用于兼容已有设置。已安装相同包名的版本时，可直接覆盖升级，无需先卸载。已有设置可能被保留；如仅需要回复后预测，请确认历史补全、停顿续写和逐词采纳已关闭。

请使用本仓库 Releases 提供的安装包；npm 同名包不代表本项目的定制版本。

## 使用方式

| 操作 | 行为 |
| --- | --- |
| AI 回复完成，输入框为空 | 生成并显示一条灰色建议 |
| **Tab** | 将整条建议填入草稿，仍可编辑 |
| **Enter** | 发送当前草稿 |
| **Esc** | 忽略当前会话本轮建议 |
| 直接输入内容 | 隐藏建议，保留用户输入 |

## 模型与数据处理

默认使用当前会话的模型服务商和模型，也可在插件设置中单独指定。每轮预测会产生一次候选生成请求；有有效候选时，再发起一次意图核对请求。核对未通过或失败时不显示候选。费用及额度由所选服务商计算，独立核对也会增加等待时间。

插件会将近期对话内容发送至所选模型服务以生成建议。建议仅供参考，可能与实际意图不符；请求失败、超时或未生成有效结果时，不显示建议。显示延迟取决于模型响应和网络状况。

本项目优先保证上下文完整性。当前发布版本在回复结束后生成预测，未启用正文生成期间的实验性预预测机制。

## 版本更新

GitHub Actions 每 **12 小时**检查上游更新，计划执行时间为北京时间 **09:17、21:17**；实际执行可能受 GitHub 队列影响。

检测到上游新提交后，工作流准备独立候选分支、自动构建并运行回归，再创建 PR。即使回归失败，也会在 PR 标记失败；发生无法自动解决的合并冲突时停止并保留失败日志。已有待审 PR 时不覆盖它，也不重复创建。

**准确性优先：不自动合并。** PR 必须通过 `Prediction regression` 检查并获得审查批准；新增提交会使旧批准失效。涉及预测、上下文或模型调用的改动，审查者还需使用 DeepSeek V4.1 Flash 对同一批案例做改动前后对照，并检查有效建议是否减少。自动测试通过不代表总体预测准确率不变。

合并到 `main` 后重新构建、回归和校验，才发布新版本 `.tgz` 及 SHA256 文件；未通过审查或检查失败时保留现有 Release。没有上游更新不创建 PR，也不重复发布。GitHub 定时任务可能延迟，发布安装包不会自动更新你电脑上的插件。



本项目的真实模型回归使用 **DeepSeek V4.1 Flash**（模型 ID：`deepseek-v4.1-flash`），不依赖 GPT。要固定预测模型，在插件设置里填写你已配置的 DeepSeek 服务商 ID 和该模型 ID；候选生成与意图核对使用同一模型。服务商 ID 因安装环境而异，不随安装包写死。

手动运行真实模型回归（会调用接口并消耗额度）：先设置 `PREDICTION_BASE_URL`（包含 `/v1`）和 `PREDICTION_API_KEY` 环境变量，再运行 `pnpm build && node scripts/live-deepseek-regression.mjs`。脚本只使用合成对话，不读取私人会话或本机凭据；普通 CI 仍运行不需要密钥的确定性测试。

## 兼容性与验证

已在 **DSh 桌面客户端 `0.2.0-rc.2`** 上验证安装、中文对话预测、灰字显示、Tab 采纳、Enter 发送、Esc 忽略及输入时隐藏。其他客户端版本尚未完成实测。

自动检查覆盖构建、42 项定制回归、7 组基础冒烟测试及同步流程测试。自动检查不替代客户端交互及真实模型验证。

## 本地开发

环境要求：Node.js `^22.19 || >=24`，pnpm。

```bash
git clone https://github.com/QingLong-C/DSH-Input-Prediction.git
cd DSH-Input-Prediction
pnpm install --frozen-lockfile
pnpm build
pnpm test:cn
pnpm test:smoke
node --experimental-strip-types scripts/context-summary-smoke.mjs
pnpm test:sync
```

修改源码后需重新构建 `lib/`，再通过 DSh 插件管理器安装项目目录或打包后的 `.tgz`。

## 许可证

采用 [MIT 许可证](LICENSE)，保留原作者版权声明。

本项目基于 WuJiaoJue / wujue 的 [dsh-plugin-collection/dsh-suggest-ghost](https://github.com/dsh-plugin-collection/dsh-suggest-ghost) 开发并独立维护。
