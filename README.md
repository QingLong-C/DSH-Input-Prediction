> 感谢 [OneHop](https://onehop.ai) 对本项目的赞助！OneHop 可为用户提供一枚兼容 OpenAI 协议的 API 密钥，即可调用上百款主流大模型，包括 GPT、Claude、Gemini、DeepSeek、Kimi 以及通义千问（Qwen）。你无需管理多家服务商账号，也不用反复修改代码，就能自由切换模型；并且采用按量付费模式。→ [onehop.ai](https://onehop.ai)

# DSH-Input Prediction

DSH-Input Prediction 是面向 DSh 桌面客户端的输入预测插件。AI 回复结束后，插件根据近期对话生成下一条用户消息建议，并以灰色文字显示在空输入框中。支持中文追问、方案比较、下一步操作及简短确认。

[下载安装包](https://github.com/QingLong-C/DSH-Input-Prediction/releases/latest) · [问题反馈](https://github.com/QingLong-C/DSH-Input-Prediction/issues) · [English](README.en.md)

## 功能

- **回复后预测**：以完整回复为依据生成建议，不在思考或正文生成阶段展示未确认的候选。
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

默认使用当前会话的模型服务商和模型，也可在插件设置中单独指定。每轮预测会产生额外的模型请求，费用及额度由所选服务商计算。

插件会将近期对话内容发送至所选模型服务以生成建议。建议仅供参考，可能与实际意图不符；请求失败、超时或未生成有效结果时，不显示建议。显示延迟取决于模型响应和网络状况。

本项目优先保证上下文完整性。当前发布版本在回复结束后生成预测，未启用正文生成期间的实验性预预测机制。

## 版本更新

GitHub Actions 每 **12 小时**检查上游更新，计划执行时间为北京时间 **09:17、21:17**；实际执行可能受 GitHub 队列影响。

检测到新提交后，工作流尝试合并，并保留本项目的品牌信息、中文追问支持及默认设置。构建和回归检查全部通过后，才更新主分支并发布 `.tgz` 安装包及 SHA256 校验文件。发生合并冲突或检查失败时，停止本轮发布；没有更新时，不重复发布。

自动发布仅更新 GitHub，不会自动安装到本机。可在 [Actions](https://github.com/QingLong-C/DSH-Input-Prediction/actions/workflows/sync-upstream.yml) 中手动运行检查；`rebuild` 选项用于在没有上游更新时重新递增版本并发布，常规检查无需开启。公开仓库连续 60 天没有活动时，GitHub 可能停用定时工作流，届时需手动重新启用。

## 兼容性与验证

已在 **DSh 桌面客户端 `0.2.0-rc.2`** 上验证安装、中文对话预测、灰字显示、Tab 采纳、Enter 发送、Esc 忽略及输入时隐藏。其他客户端版本尚未完成实测。

自动检查覆盖构建、34 项定制回归、7 组基础冒烟测试及同步流程测试。自动检查不替代客户端交互及真实模型验证。

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
