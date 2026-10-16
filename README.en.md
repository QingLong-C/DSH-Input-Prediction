# DSH-Input Prediction

A DSh plugin that suggests your next message after the assistant finishes. Press **Tab** to fill the draft, **Enter** to send, or **Esc** to dismiss the current turn. Start typing to hide the suggestion.

See the [Chinese README](README.md) for installation and details. Download the prebuilt `.tgz` from [Releases](https://github.com/QingLong-C/dsh-input-prediction/releases), add its absolute path in DSh’s plugin manager, enable it, and fully restart DSh when upgrading.

Only post-reply suggestions are enabled by default. History completion, paused inline completion, and right-arrow word acceptance are off. The internal package name remains `dsh-suggest-ghost` to preserve existing settings during in-place upgrades; the displayed name is **DSH-Input Prediction**.

Suggestions make additional model requests using the conversation’s provider and model unless configured otherwise. They may arrive later or be absent. This project has been tested on DSh desktop `0.2.0-rc.2`; other versions are unverified.

Based on [dsh-plugin-collection/dsh-suggest-ghost](https://github.com/dsh-plugin-collection/dsh-suggest-ghost), commit `5489126f536665b1d3723b3d9343cc08c5612efc`, with Chinese follow-up support and integration fixes. Independently maintained; upstream updates are not merged automatically. Original MIT license and attribution are preserved.

## Automatic upstream updates

The GitHub Actions workflow checks upstream every 12 hours (09:17 and 21:17 Asia/Shanghai). It merges changes against the recorded upstream base, preserves local customizations, runs the build and regression tests, and publishes a new installable archive only after success. Conflicts or failing tests stop publication. It does not install updates on your computer. Use **Actions → Sync upstream and release → Run workflow** for an immediate check. The optional `rebuild` input publishes a new version even without upstream changes. GitHub may disable schedules after 60 days of repository inactivity.
