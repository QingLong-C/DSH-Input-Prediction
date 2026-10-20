<div align="center">
  <img src="docs/banner.png?v=2" alt="dsh-suggest-ghost — ghost autocomplete for DeepSeek Harness Web"/>
</div>

# dsh-suggest-ghost

**English** | [简体中文](README.md)

[![version](https://img.shields.io/badge/version-0.5.0-0EA5E9)](https://github.com/dsh-plugins/dsh-suggest-ghost)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

> Input prediction plugin for DeepSeek Harness Web: after each turn completes, one auxiliary LLM call predicts your next prompt and renders it as ghost text in the input box when the draft is empty; while you type, it completes from the current conversation history by prefix match. **Tab** accepts the whole suggestion, **→** accepts word by word.

## What it is

A pure plugin mount (host listens to turn events + client-side DOM overlay) — no changes to any DSH core code. Three modes switch automatically:

- **LLM next-suggestion** (empty draft): after every completed turn, the last round of conversation is sanitized and sent to the suggestion model (inherits the main request route by default, no extra config) to produce "the sentence you are most likely to type next" — the same experience as Claude Code.
- **History prefix completion** (non-empty draft): zsh-autosuggestions style — finds prefix-matching entries in conversation history, scores by recency first, with in-session frequency and cross-session hotness as secondary signals, and renders the remaining part in gray. Full/half-width punctuation, whitespace, and case differences do not affect matching. Immediate, no network.
- **Pause completion** (non-empty draft): once typing pauses for `inlineDelayMs` (default 100ms) a completion request goes out and the rest of the sentence appears as ghost text at the caret; Tab accepts the whole thing, `→` accepts word by word. **Latency expectation**: `inlineDelayMs` only decides *when the request is sent*; the model itself measured **1.1-17s** (42 generations in the real environment on 2026-10-20: fastest 1100ms, median 4900ms, slowest 16986ms), so waiting a moment after pausing usually shows nothing yet. Typing again aborts the in-flight request and restarts it - and a completion that already arrived is still shown per the alignment rule, not dropped; every such outcome is visible in the host log (`completion-preempted` / `completion-aborted` / `completion-timeout`).

Ghost text is rendered as a DOM overlay approximation (follows the input's font and scroll), not depending on the official `setGhost` input capability, so it works on rc.6; keystrokes are not intercepted during IME composition.

## Preview

![Live demo: type character by character, ghost appears, Tab to accept](docs/demo.gif)

**① History prefix completion** (non-empty draft) — type "list do" and the ghost completes the remainder of that historical message:

![History prefix completion screenshot](docs/mode-history-real.png)

**② LLM next-suggestion** (empty draft, auto-predicts your next step after a turn ends):

![LLM next-suggestion screenshot](docs/mode-llm-real.png)

Dark text = what you typed; gray = ghost suggestion. **Tab** accepts the whole suggestion, **→** accepts word by word. Ghost text follows the input's font and scroll rendering — it never overlaps or steals focus; if you don't like it, just ignore it and keep typing and it disappears — zero cost.

## Installation

**From npm (recommended — prebuilt, no approval needed):**

```bash
dsh plugin --profile web add dsh-suggest-ghost
```

One-line install from GitHub (build artifacts are committed to the repo, no local build needed):

```bash
dsh plugin --profile web add "github:WuJiaoJue/dsh-suggest-ghost"
```

Or from source:

```bash
git clone https://github.com/dsh-plugins/dsh-suggest-ghost.git
cd dsh-suggest-ghost && pnpm install && pnpm run build
dsh plugin --profile web add .
```

After installing, restart dsh web and hard-refresh the page with Ctrl+Shift+R. Works out of the box with no configuration required.

## Configuration

All settings live in the **Suggest ghost** card in Settings → Plugins and take effect immediately after saving:
card copy (field labels/hints, buttons, badges) follows the host DSH UI language (中文 / English) and updates in real time when the language is switched in Settings, without a refresh; hosts without a locale service fall back to Chinese.

| Group | Fields |
|---|---|
| LLM next-suggestion | enable toggle, max output tokens, max suggestion chars, reference turns, transcript char budget, timeout (ms), accept key, provider / model route (leave empty to inherit the main request) |
| History prefix completion | enable toggle, cross-session search, max history entries, min input chars, word-by-word accept |
| Hotness management | frequent cross-session phrases list: pin (exempt from eviction, always leads candidates), delete, manual add (pinned by default), clear all — takes effect immediately, no save needed |

You can also override by id in cordis.patch.yml (as initial values for the above):

```yaml
- id: suggest-ghost
  config:
    maxInputBytes: 4096        # framed user prompt byte cap
    maxOutputTokens: 512       # suggestion output token cap
    timeoutMs: 60000           # auxiliary request deadline (ms)
    maxRecentTurns: 1          # most recent completed turns sent to the suggestion model
    maxTranscriptChars: 12000  # transcript char budget
    maxSuggestionChars: 240    # visible suggestion char cap
    acceptKey: Tab             # accept shortcut
    llmEnabled: true           # LLM suggestion toggle
```



<div align="center">
  <img src="docs/settings-card.png?v=3" width="640" alt="Suggest ghost settings card (Settings → Plugins)"/>
</div>

## Security

- Only the last round of conversation is sent to the suggestion model, with common credentials auto-masked before sending; output is purified and unqualified replies are silently discarded
- Fully bounded end to end: input bytes / output tokens / timeout capped; re-entry guarded within the same turn, new turns invalidate stale generations, unloading aborts in-flight requests

## Compatibility

Verified on five kernel generations (`0.1.5`, `0.1.7` and `0.2.0` re-measured 2026-09-29; the rest 2026-09-07):

| DSH kernel | peer gate | host entry link | runtime symbols | isolated profile | settings page |
|---|---|---|---|---|---|
| `0.1.1-rc.2` | — | ✅ | ✅ 8/8 | ✅ | ✅ |
| `0.1.2-rc.1` | — | ✅ | ✅ 8/8 | ✅ | ✅ |
| `0.1.5-rc.3` | — | ✅ | ✅ 10/10 | ✅ | ✅ |
| `0.1.7-rc.2` | — | ✅ | ✅ 10/10 | ✅ | ✅ |
| `0.2.0-rc.2` | ✅ | ✅ | ✅ 10/10 | ✅ | ✅ |

### Peer enumeration, and the hard gate that starts at 0.2.0

Peer deps are written as an **explicit generation list** (`^0.1.1-rc.2 || ^0.1.2-rc.1 || … || ^0.2.0-rc.2`) rather than `>=0.1.1-rc.2`: node-semver excludes prereleases from every range unless a comparator carries the same `[major.minor.patch]` tuple, so `^0.1.1-rc.2` is false for `0.1.2-rc.1`, and so is `*` — there is no range form that spans generations. **Every time upstream ships a new rc generation, add another entry here.**

**At `0.2.0` this stopped being an install-time hint and became a load-time hard rejection.** While composing a profile the kernel checks each peer with `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` and skips the whole bundle on a miss:

```
dsh: skipping profile bundle "dsh-suggest-ghost": Error: Plugin … is incompatible
with dsh 0.2.0-rc.2: peerDependencies {…}
```

Two details worth remembering:

- the gate uses **`includePrerelease: true`**, so `^0.2.0` (without the rc) is false for `0.2.0-rc.2` — the entry must be written as `^0.2.0-rc.2`;
- `dsh plugin allow-version` grants an **exact-version** exemption, which bypasses the check rather than fixing it. The real fix is still another enumeration entry.

### The 0.1.7 settings rework (the only substantial source change)

`0.1.7` removed the whole `settings.yaml` system, so the plugin's data channel had to move:

| | `0.1.5` | `0.1.7+` |
|---|---|---|
| User-editable options | `ctx.settings.register(ns, schema, …)` | per-field `.volatile()` in `Config`; the kernel projects the **plugin's own Config schema** into a form, ns = Loader entry id |
| host → client | `_push` on a `SettingsScope` | `ctx.settings.update(ns, {_push})` (`_push` marked volatile) |
| client reads | `settingsScope.bind(ns).get()` | `remote.settings.describe()` (first read + event-driven re-read) |
| client → host | `scope.set('_ops', …)` | `remote.settings.mutate(ns, [{op:'set',path:['_ops'],…}])` |
| change signal (host) | `scope.watch` | `settings/document-updated(ns, revision)` event |
| change signal (client) | `scope.subscribe` | `remote.$on('settings/document-updated')` |

**The payload shape is unchanged** (the `_push` / `_ops` JSON, including the `suggestionSessionId` / `historySessionId` ownership guards) — only the carrier moved, so the client's parsing and ownership logic needed no rewrite.

Three details that only surface when you try them:

- **`Config` must not be marked `.volatile()` as a whole**, and `z.object({…}).volatile().dict` must not be spread back in — the former exposes the strategy parameters as form fields too, the latter drops each field's own `meta` during flattening and makes the entire form invisible. Mark **per field**.
- **A volatile field resolves to a reference** (cosmokit's `Volatile<T>`), not a bare value, so reads must go through `.get()`. `flattenConfig()` flattens those references into plain values so the rest of the plugin is generation-agnostic; it also accepts bare values, so `0.1.5` and earlier keep working.
- **`provider` / `model` changed from `z.string().min(1)` to `.default('')`**: once they are form fields, being required means the plugin "cannot start until filled in", while the intended meaning of empty is "inherit the main request's route".

### Other cross-generation choices

- **No `settingsNamespace()`**: the helper was removed in `0.1.2`, and importing it at runtime makes the whole module fail to link. It only validated and returned the branded string unchanged, so the code asserts the literal instead (`'suggest-ghost' as SettingsNamespace`).
- **No `deepFreeze` import**: `0.1.1` exports it from `dsh-llm`, `0.1.2` moved it into the new `dsh-util-values` and stopped re-exporting it — and that package does not exist on `0.1.1`, so switching the import source would only break the other generation. `src/generate.ts` ships an equivalent implementation (iterative traversal, cycle-safe, skips `AbortSignal`).
- **The client bundle takes no types from `@deepseek-ai/dsh-client-runtime`**: that package is `0.1.1`-only and was split out in `0.1.2`. `lib/client.js` was measured to have zero kernel imports (only `react`), so it is generation-independent; the minimal `ctx.remote` face is declared client-side (see `RemoteLike` in `src/client/index.ts`).
- **`source.kind` is `'user'`, not `'plugin'`**: `0.1.7` dropped the `plugin` kind and the `schedule` kind it added does not exist on `0.1.5`, so the two generations have no overlap. The field only builds a one-shot LLM request payload; it is not persisted or projected.

### Known trade-offs

- **Old settings do migrate**: a value tweaked on the `0.1.5` settings page was measured restoring as-is on `0.2.0` — the profile document holds non-default values today (`historyMaxEntries: 77`, `historyCrossSession: true`), and a restart reads that persisted value rather than the previous run's memory.
- **Do not treat "volatile fields are not persisted" as a guarantee**: this plugin's `_ops` / `_push` are written into the profile document, and the clear-after-consume write is refused as a nested transaction, so a payload stays on disk and a fresh instance replays it at boot (measured in an isolated instance: one leftover `complete` was consumed before any client connected). See the cold-start section above and issue #22.
- **No polling on the client**: what `0.1.7` removed along with `settingsScope` is only `scope.subscribe`. The kernel has a separate Host→client event channel — `ctx.remote.$on('settings/document-updated')`, on dsh-api-remotes' forwarding allowlist (mode `emit`). The kernel's own settings page drives `SettingsDescribeMirror` off exactly that. This plugin subscribes the same way, so `describe()` is issued only when the host actually pushes `_push`, plus once at startup and once per `connection/reset`.

How to reproduce: build an isolated profile for the kernel under test (point `$DSH_HOME` at a temp directory and hardlink its `node_modules` to that kernel tree with `cp -al`, so upward resolution cannot leak into the other generation), then check manifest composition with `dsh --profile <p> --dump-config` — **on 0.2.0 this is the step that surfaces the peer-gate rejection** — and watch plugin loading via `dsh --profile <p> "say hi"` and `dsh --profile <p> -- --no-open --port <p>`. Headless runs stop at `MISSING_CREDENTIAL` (the temp home has no credentials) — a point after plugins have loaded.

## Development

```
src/index.ts         host entry: turn/end(completed) → bounded suggestion generation
src/coldstart.ts     cold-start semantics (pure): ring seeding from the log, turn-based staleness, _push read-back, suggestion tracking
src/generate.ts      transcript extraction → sanitization → ctx.llm.stream → purification
src/transcript.ts    pure transcript logic: char + UTF-8 byte dual-budget trimming (unit-testable)
src/sanitize.ts      sanitize / purify / semantic filter / truncation (pure functions)
src/settings.ts      settings namespace + host→client push (_push) and client→host ops channel (_ops, tail-write coalescing)
src/hotness.ts       cross-session hotness table (incremental dedup, min-heap eviction, bounded memory, pin/manage APIs)
src/hotness-store.ts hotness persistence (storageDomain unit, turn-boundary coalesced writes, restore-on-restart, ops application)
src/projection.ts    suggestGhost projection last-wins fold
src/client/          ghost rendering, history matching, word splitting, shortcuts, settings card
scripts/             smoke tests and session log replay
```

### Read this before touching the settings channel

`_ops` / `_push` are the only two ways this plugin talks to the host, and three separate bugs came
from that channel's semantics, not from business logic: `mutate()`'s third argument means "the
revision I read" rather than "the value I want to overwrite", so a refused write can look like a
successful one; a zod schema and a TS union are two separate truths, so adding an operation to only
one of them drops payloads in silence; and a single-slot last-wins snapshot cannot carry a payload
that exists for one moment, because the reader sees whatever was newest when it read. Three more that
bite repeatedly: a volatile reference captured by `apply(ctx, config)` freezes after the first config
write, `settings/document-updated` never reaches the plugin's own `ctx`, and any settings write issued
from inside that event callback is refused as `HMR transactions cannot be nested` (the AsyncLocalStorage
transaction survives `await`, so deferring by a tick does not escape it). A separate section there
explains why traces have to go to stdout: `ctx.logger` writes nowhere in a healthy process, so the only
runtime-visible channel is `console.log` tee'd into the host log, and this plugin tags those traces with
`[dsh-suggest-ghost][ops-trace]` to keep them distinguishable from debug noise.

[docs/internals-cordis-settings-pitfalls.md](docs/internals-cordis-settings-pitfalls.md) covers
each as symptom, root cause, correct usage, wrong usage, with file:line and commit evidence. Every
claim there is graded as fixed, awaiting a host restart, kernel contract, or plugin-local experience,
and a pre-change checklist is at the end.

### Which copy the host actually loads

**The host loads the worktree that `<profile>/node_modules/dsh-suggest-ghost` resolves to, not the one
you are editing.** On this machine:

```
~/.dsh/profiles/web/node_modules/dsh-suggest-ghost
  -> /home/wujue/workspace/dsh-plugins/dsh-suggest-ghost
```

Two related facts decide whether a verification round counts:

- `lib/` is **committed to this repository**. The host imports `lib/index.js` (`package.json` `main`)
  and `lib/client.js` (`exports["./client"]`). `src/*.ts` is only source: edit `src/`, skip the build,
  restart the host, and it loads the previous bytecode.
- Several git worktrees can exist at once (unavoidable when issues are fixed in parallel), and the
  symlink points at exactly one of them. Changes built in any other copy never reach the host.

Both checks are read-only:

```bash
node scripts/artifact-freshness.mjs   # is lib/ older than src/ (2s tolerance); which copy is deployed
node scripts/gitignore-check.mjs      # tracked files covered by an ignore rule; fatal exits non-zero
```

The second check guards a silent failure mode. `lib/` has to stay tracked, so any rule that covers it
(`build/`, `lib/`, `src/` in `.gitignore`, or a rule in `~/.config/git/ignore`) makes **newly created
files in that directory stay out of the index**. The files are on disk, the build succeeds,
`git status` looks clean, and `git checkout` cannot restore them, because git never knew they existed.
One trap in the check itself: `git check-ignore` skips tracked paths unless you pass `--no-index`,
which is precisely the case worth catching.

Order of work, so a fix is not lost between editing and verifying:

1. Change your worktree, run `pnpm run test:smoke`, continue only when it is green.
2. Run `node build.mjs` and commit `src/` and `lib/` **together**.
3. Run `node scripts/artifact-freshness.mjs` to confirm the build is current and the deployed copy is
   the one you want the host to load.
4. Only then ask for a restart. Never verify uncommitted work: concurrent sessions and external tools
   write to this working tree without warning, and committed content is the only thing that comes back.

### Applying host-side changes without a restart

After editing `src/index.ts` and running `node build.mjs`, the default configuration needs a host
restart. That is a profile setting, not a platform limit: `@deepseek-ai/dsh-hmr` reloads plugin
source, but this profile composes it as `config: { root: [] }`, and its README says an empty `root`
keeps "only explicit configuration watches", i.e. the profile's config files only.

A second reason is the one developers trip over: the default `ignored` is
`["**/node_modules", "**/.*", "cache", "data"]`, and during development this plugin lives at
`profiles/web/node_modules/dsh-suggest-ghost` (a `link:` dependency). **Even `root: ["."]` would
not watch it**, because the ignore pattern excludes that path.

To watch it, append this to the profile's `cordis.patch.yml` (keep `root` narrow so Chokidar does
not walk all of node_modules):

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - node_modules/dsh-suggest-ghost/lib
    ignored: []
    debounce: 100
```

Validate the overlay without booting: `dsh --profile web --patch <file> --dump-config`, then check
that `id: hmr` carries those three keys and no other entry changed.

Once it is on, the log tells you whether a reload happened, so you never verify stale bytecode
again. Rather than doing this by hand, `pnpm run sandbox` (`scripts/dev-sandbox.mjs`) handles it: its own
`DSH_HOME`, its own copy of the plugin artifacts, automatic port avoidance, removal of leftover payloads
that would otherwise be replayed at boot, and it prints the greps worth watching. The script itself carries
no plugin-specific knowledge; that lives in this repo's `package.json` under `sandbox` (`entry`, `rewrites`,
`disable`, `greps`).

Every mount prints one line:

```
[dsh-suggest-ghost][ops-trace] apply called; artifact mtime=<mtime of the loaded lib/index.js>
```

`touch lib/index.js`, then look for that line again. A new mtime means the new build is in memory;
an unchanged mtime means the process is still running the previous bytes, so whatever the
verification shows is not about your change. Client-side work needs no host restart at all: the
browser module graph is loaded separately, so a page refresh is enough.

> Limitation: reloads run inside the kernel's `runExclusive` transaction, so settings writes the
> plugin issues from an event callback are refused during reload as well (pitfall 1.5 in
> `docs/internals-cordis-settings-pitfalls.md`). A failed `_ops` clear right after a reload is
> expected; judge the reload by the `apply called` mtime, not by that failure.

### Cold-start semantics (why it works right after a restart)

"No data after a restart" is a misreading: **history lives in the session log, and the host re-sends the suggestion after checking it semantically.**
The old design used *time* as the criterion (invalidate on restart, seed only when an event arrives), which left two gaps.
It now uses *semantics*:

- The **history ring** is a cache of the session log: on a pull miss it is recomputed from the log (`ringFor`), so there is no
  "seeding moment" and therefore no race where a pull arrives before the first event. Live sessions maintain it incrementally.
- A **suggestion** is valid iff its turn is still the session's last completed turn (`suggestionIsCurrent`). The host runs
  that check on every state assembly: still valid → restored as-is (your last suggestion is there when the page opens,
  no need to wait for a new turn); provably stale → cleared.
- All three push paths (pull reply / turn end / hotness-restore re-push) share one state assembler
  (`statePushOf`), and the client pulls at the single point where a session binding succeeds.

> **Difference from 0.1.5**: there `_push` landed in `settings.yaml`, so the previous suggestion could be read back
> after a restart. On `0.1.7+` volatile fields are not persisted, so **the last suggestion must be regenerated after a
> restart** — it returns as soon as the next turn completes. History prefix completion and the hotness panel keep working
> throughout, since they read the session log and the storage domain rather than a volatile field.
> Do not confuse this with your *settings values*, which do live in the profile document and do migrate (see Known trade-offs).

```bash
pnpm run build       # tsc compiles host + esbuild bundles client → lib/
pnpm run test:smoke  # pure-function smoke tests (incl. hotness persistence and cold-start semantics)
pnpm run test:e2e    # end-to-end over the real stacks: hotness persist→restore; cold-start reconciliation/pull
pnpm run replay      # replay the completion pipeline with real session logs
pnpm run sandbox     # boot an isolated second DSH instance (no restart; live artifacts untouched)
pnpm run sandbox:check    # composition check only; sandbox:deploy <dir> installs a build only
```

## Known limitations

- The cross-session hotness table is now persisted (host storage domain, lands in `~/.dsh/storages/suggest_ghost_hotness.json`): frequencies survive restarts instead of accumulating from zero; on hosts without the storage domain (older versions) it automatically degrades to in-memory only
- After a restart, history completion and the previous suggestion are available immediately (the criterion is semantic, not restart timing); a suggestion for a **new** turn still requires that turn to finish — that is inherent to "predict the next prompt", not a startup delay
- The management panel lists and filters the pushed top-K snapshot (50 entries by default; "N total" shows the full count); host-side search beyond the top-K is not implemented
- Delete only clears the current tally — typing the same text again re-counts; pin is the "never evicted" semantic
- LLM suggestions cover only the current session; to include text from other sessions as candidates, enable "cross-session search"
- Every completed turn triggers one suggestion model call (regardless of whether the input box has content); disable it in settings to save tokens if not needed

## License

MIT © wujue. The security and generation pipelines are implemented with reference to [dsh-suggest-prompt](https://github.com/studyzy/dsh-suggest-prompt) (MIT).


<div align="center">
  <img src="docs/logo-peek.png?v=1" width="150" alt=""/>
</div>
