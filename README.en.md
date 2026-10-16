> Thanks to [OneHop](https://onehop.ai) for sponsoring this project! OneHop provides a single OpenAI-compatible API key for access to hundreds of models, including GPT, Claude, Gemini, DeepSeek, Kimi, and Qwen. Switch models without managing multiple provider accounts or repeatedly changing your code, with pay-as-you-go pricing. → [onehop.ai](https://onehop.ai)

# DSH-Input Prediction

DSH-Input Prediction is a next-message suggestion plugin for the DSh desktop client. After the assistant finishes, it uses recent conversation context to display a suggested follow-up as gray text in an empty input field. It supports Chinese follow-up questions, comparisons, next steps, and short confirmations.

[Download](https://github.com/QingLong-C/DSH-Input-Prediction/releases/latest) · [Issues](https://github.com/QingLong-C/DSH-Input-Prediction/issues) · [中文文档](README.md)

## Features

- Generates suggestions after the complete response; no speculative suggestions appear during reasoning or response generation.
- Preserves user goals before older assistant prose and checks candidate intent independently. Assistant offers are not treated as user decisions; uncertain suggestions are withheld.
- Supports automatic language detection and an explicit Simplified Chinese setting.
- Fills the draft only when accepted; never sends a message automatically.
- Hides suggestions when typing and clears stale suggestions when a new turn starts.
- Runs through the plugin interface without modifying the DSh application bundle.

Only post-reply suggestions are enabled by default. History completion, paused inline completion, and word-by-word acceptance are disabled and can be enabled in plugin settings.

## Installation

### Install with an Agent (recommended)

Copy the instruction below and send it to your DSh Agent. GitHub provides a copy button in the upper-right corner of the code block. The same instruction also handles upgrades.

```text
Install or upgrade DSH-Input Prediction in my current DSh profile: obtain the latest published stable release's .tgz archive and SHA256 checksum file from https://github.com/QingLong-C/DSH-Input-Prediction/releases/latest, download and verify the archive, then install and enable it with DSh's native plugin_manager tool (install_bundle, target set to the downloaded file's absolute path, enabled=true), preserving existing settings and avoiding the same-named npm package; verify the actual installed version, enabled state, and loading errors, report the outcome, and explicitly state whether a restart is required rather than reporting a download or a pending restart as successful activation.
```

DSh must expose the `plugin_manager` tool, normally available in Creator mode, for the Agent to install directly. Complete any permission prompts required by the client. Upgrades may require fully quitting and restarting DSh. Other Agents can use the instruction only if they can manage the current DSh profile; otherwise use the manual steps below.

### Manual installation

1. Download the latest `.tgz` from [Releases](https://github.com/QingLong-C/DSH-Input-Prediction/releases/latest). Do not extract it.
2. Open **Plugins → Add plugin** in DSh and install using the archive's absolute path.
3. Enable the plugin after first installation. Fully quit and restart DSh after an upgrade.
4. Confirm that **DSH-Input Prediction** appears in the plugin list, then complete a conversation turn.

The internal package name remains `dsh-suggest-ghost` to preserve existing settings. Install over an existing package with that name without uninstalling first. Existing settings may persist; disable history completion, paused inline completion, and word acceptance if only post-reply suggestions are wanted.

Use this repository's release archives. The package with the same name on npm is not this project's customized distribution.

## Usage

| Action | Result |
| --- | --- |
| Assistant finishes with an empty input field | A suggestion is generated and displayed |
| **Tab** | Copies the full suggestion into the editable draft |
| **Enter** | Sends the current draft |
| **Esc** | Dismisses this session's suggestion for the current turn |
| Start typing | Hides the suggestion without overwriting input |

## Models and data

By default, suggestions use the conversation's provider and model; a separate provider and model can be selected in plugin settings. Each prediction makes a generation request. A valid candidate requires a second, independent intent-check request; rejected or failed checks withhold the candidate. Both requests consume the selected service's quota or incur its charges, and the extra check adds latency.

Recent conversation content is sent to that service. Suggestions may not match the user's intent and may be absent after errors, timeouts, or invalid output. Latency depends on the model and network. The released version waits for the response to finish; experimental prefetching is not enabled.

## Updates

GitHub Actions checks for upstream changes every **12 hours**, scheduled for **09:17 and 21:17 Asia/Shanghai**. Runs may be delayed by GitHub's queue.

Updates are built and regression-tested on an isolated branch, then submitted as a PR, including a failed check if regression fails. Merge conflicts stop preparation. An existing upstream PR is preserved rather than overwritten or duplicated.

**Accuracy comes first; no automatic merge.** The `Prediction regression` check and human approval are required; new commits dismiss stale approvals. Prediction, context, or model changes require reviewer-run DeepSeek V4.1 Flash comparisons on the same cases, including useful-suggestion coverage. Passing automated tests does not guarantee unchanged prediction accuracy.

After merge to `main`, rebuild, retest, and verify before publishing a new archive. No changes means no PR or duplicate release. Publishing does not install the plugin on your computer. Manual runs from Actions only check for updates; they cannot bypass review. GitHub may disable schedules after 60 days of public-repository inactivity.


Live-model regression uses **DeepSeek V4.1 Flash** (`deepseek-v4.1-flash`), without GPT. To pin prediction to this model, enter your configured DeepSeek provider ID and this model ID in plugin settings. Generation and intent verification use the same model. Provider IDs are installation-specific and are not embedded in the bundle.

For a manual live regression (billable API requests), set `PREDICTION_BASE_URL` (including `/v1`) and `PREDICTION_API_KEY`, then run `pnpm build && node scripts/live-deepseek-regression.mjs`. The script uses synthetic conversations only and does not read private conversations or local credentials. Regular CI keeps using deterministic tests without API credentials.

## Compatibility and development

Installation and live Chinese conversations have been tested on **DSh desktop `0.2.0-rc.2`**, including suggestion display, Tab acceptance, Enter submission, Esc dismissal, and hiding while typing. Other versions remain unverified.

Automated checks cover the build, 42 custom regression tests, seven baseline smoke-test groups, and synchronization tests. They do not replace desktop interaction or live-model verification.

Requires Node.js `^22.19 || >=24` and pnpm:

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

Rebuild `lib/` after editing source files, then install the project directory or a packaged `.tgz` through DSh's plugin manager.

## License

Distributed under the [MIT License](LICENSE), with the original copyright notice preserved.

Based on [dsh-plugin-collection/dsh-suggest-ghost](https://github.com/dsh-plugin-collection/dsh-suggest-ghost) by WuJiaoJue / wujue and maintained independently.
