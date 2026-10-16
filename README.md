# DSH-Input Prediction

给 DSh 加一条「你可能接着想问的话」。AI 回复结束后，空输入框里会出现灰字建议：合适就按 **Tab** 收下，再按 **Enter** 发出去；不合适就自己写。

比如，你刚聊完内存大小，下一句可能是：

> 那 8GB 内存够日常办公用吗？

它只帮你准备下一句话，不会替你发送。

## 怎么用

| 操作 | 结果 |
|---|---|
| 等 AI 回复结束 | 空输入框显示一条灰字建议 |
| Tab | 整条填入草稿，还可以改字 |
| Enter | 发送草稿 |
| Esc | 忽略当前会话这一轮的建议 |
| 自己开始输入 | 灰字隐藏，不覆盖你写的内容 |

默认只开启**回复后的建议**。历史补全、输入停顿时续写、右方向键逐词采纳都关闭；原插件的这些选项仍然保留，需要时可以在插件设置里打开。

## 安装

1. 到 [Releases](https://github.com/QingLong-C/dsh-input-prediction/releases) 下载最新版本的 `.tgz` 文件，不用解压。
2. 打开 DSh 左侧的「插件」→「添加插件」，填入这个文件的完整路径，点击安装。
3. 首次安装后点「立即启用」。如果是覆盖升级，安装完成后完整退出 DSh，再重新打开。
4. 插件列表里应能看到 **DSH-Input Prediction**。正常聊一轮，等回复后的灰字出现即可。

已经装过本项目的中文修复版或原版 `dsh-suggest-ghost`，可以用新的 `.tgz` 直接覆盖，**不用先卸载**。为了保留已有设置，内部安装包名仍是 `dsh-suggest-ghost`，不会再多装一份。升级后检查历史补全、停顿续写和逐词采纳三个开关是否关闭。

安装文件请以本仓库的 Releases 为准；npm 上的同名包是上游版本。

## 和原插件有什么区别

这个项目从 [dsh-suggest-ghost](https://github.com/dsh-plugin-collection/dsh-suggest-ghost) 修改而来，重点是让中文对话里的追问建议更好用。

- **支持正常追问。** 可以建议解释、比较、下一步、行动请求和简短确认，不再把问句一律删掉。
- **更准确地跟随对话语言。** 生成建议时只取真正的用户消息，避免规则、技能清单、时间提示挤掉中文问题。也可以在插件设置中固定为简体中文。
- **不抢你的输入。** 输入非空时隐藏整句建议，新回合开始清掉旧建议，Esc 可以忽略当前回合。
- **设置改完能生效。** 修复了读取旧设置、写入版本冲突、会话晚就绪和输入框重建后的挂载问题。

没有合适的下一句时，可以不显示建议。这个项目独立维护，通过下面的自动同步流程跟进上游更新。

## 自动同步上游

GitHub Actions 每 12 小时检查一次上游 `main`，计划时间为北京时间 **09:17、21:17**。GitHub 排队时可能稍晚执行；也可以打开 [Actions](https://github.com/QingLong-C/DSH-Input-Prediction/actions/workflows/sync-upstream.yml)，点 **Run workflow** 立即检查。

发现新提交后，会按上次同步的基点合并改动，保留本项目的名称、中文追问和默认开关。构建、中文回归、上游冒烟及同步测试全部通过后，才更新本项目 `main` 并发布新的 `.tgz` 和 SHA256 校验文件。没有上游更新时，不重复发版。

遇到代码冲突、依赖冲突或测试失败，本轮会停止，当前可用版本不会被覆盖。具体原因在 Actions 日志里；解决后重新运行即可。上游的工作流、旧说明文档和预编译文件不会直接覆盖本项目；预编译文件由合并后的源码重新构建。

自动发版只更新 GitHub，**不会自动安装到你的电脑**。云端测试也不能替代 DSh 桌面和真实模型实测；新版本请下载后覆盖安装。手动运行时的 `rebuild` 选项会在上游未变时也递增版本并重新发布，平时保持关闭。

公开仓库连续 60 天没有活动时，GitHub 可能停用定时任务；届时到 Actions 重新启用。要暂停同步，也可以在该工作流菜单里选择 Disable workflow。

## 模型、速度和费用

插件会额外调用模型，根据最近的对话生成建议。默认沿用当前会话的服务商和模型，也可以在插件设置里单独指定。费用和额度按对应服务计算。

建议可能比正文晚一点出现，速度取决于模型和网络；请求失败、超时或没有合适结果时，不一定每轮都有灰字。最近的对话内容会发送到你选定的模型服务。

## 已经测过什么

已在 **DSh `0.2.0-rc.2` 桌面客户端**完成安装和真实中文对话测试：灰字显示、Tab 采纳、Enter 发送、Esc 忽略、自己输入时隐藏。其他 DSh 版本尚未在本项目中实测。

自动验证包括 34 项定制回归和 7 组上游冒烟测试。它通过插件接口运行，不需要修改 DSh 安装包。

## 本地开发

需要 Node.js `22.19+` 的 22 系列版本，或 `24+`，以及 pnpm。

```bash
git clone https://github.com/QingLong-C/dsh-input-prediction.git
cd dsh-input-prediction
pnpm install
pnpm build
pnpm test:cn
pnpm test:smoke
node --experimental-strip-types scripts/context-summary-smoke.mjs
```

仓库带有构建后的 `lib/`。改过源码后需要重新构建，再在 DSh「添加插件」里填写项目目录的完整路径。

## 来源和许可

- 原项目：[dsh-plugin-collection/dsh-suggest-ghost](https://github.com/dsh-plugin-collection/dsh-suggest-ghost)，原作者 WuJiaoJue / wujue。
- 本项目从[提交 `5489126`](https://github.com/dsh-plugin-collection/dsh-suggest-ghost/commit/5489126f536665b1d3723b3d9343cc08c5612efc)开始修改；更早的提交历史请查看上游仓库。
- 原插件部分生成与过滤逻辑参考了 [studyzy/dsh-suggest-prompt](https://github.com/studyzy/dsh-suggest-prompt)。

沿用 [MIT 许可](LICENSE)，保留原作者版权声明。问题和建议请发到[本项目 Issues](https://github.com/QingLong-C/dsh-input-prediction/issues)。
