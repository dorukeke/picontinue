# Working notes — pi-continue

One TypeScript file, `pi-continue.ts`: a pi extension that resumes the model when the output token
limit cuts a response off, and takes a **breath** (a tool-free checkpoint) before resuming when the
context is already heavy. The header comment of that file is the spec — read it before changing it.

## What this repo is

- A [pi](https://pi.dev) **package**: `package.json` declares `pi.extensions: ["./pi-continue.ts"]`
  plus the `pi-package` keyword. pi loads the `.ts` directly — no build step, no bundler, no
  runtime dependency. The only import is `import type … from "@earendil-works/pi-coding-agent"`,
  which is erased at load.
- Target: pi 1.5.x (developed against 1.5.2). The behaviour is asserted against pi's own lifecycle,
  so check `pi --version` before blaming the extension.

## Invariants — why the code looks the way it does

Each of these was found the hard way. Breaking one silently breaks a path you are not testing.

1. **Detection happens twice on purpose.** `message_end` sees the truncated assistant message;
   `agent_before_settle` acts on it. pi drops the incomplete assistant message from the settle
   context preview, so the signal is carried across as `state.stopped` instead of being re-derived
   there. Keep both halves.
2. **A draft is what makes the context continuable.** pi validates the context *after* the drafts
   are committed, and a context that ends with the truncated assistant message is not runnable on
   its own. Never return `continue: true` without an `entries: [draft]` beside it.
3. **Never inject a breath and a continue in the same settle.** The `continue` prompt is held back
   until the checkpoint reply has landed (`state.breatheDebt`), so the resume starts from the
   checkpoint rather than from a window about to be compacted out from under the model.
4. **Guard order at the settle boundary matters:** aborted → reset state and bail; queued user
   messages (`context.pendingMessages.length > 0`) → bail; streak cap → warn and bail; breath;
   continue. Reordering decides which path wins.
5. **Thresholds are headroom-aware, never flat percentages:**
   `compactAt = contextWindow - reserveTokens`;
   `breathe = min(breatheAt% × window, compactAt - margin)`;
   `hard = min(hardAt% × window, compactAt)`. A 131k window with a 64k reserve compacts at ~50%, so
   a fixed 80% would fire after the compaction already happened.
6. **`reserveTokens` must follow pi's own resolution chain:** agent-dir `settings.json` →
   project `.pi/settings.json` → `compaction.modelOverrides["<provider>/<model>"]` →
   `PI_CONTINUE_RESERVE_TOKENS`. Re-read it at `session_start` and `model_select`, and mirror pi's
   default (16384) for the estimate before settings are read.
7. **Config is read once at load** into the `CONFIG` const; env changes need a restart. Do not read
   env inside event handlers.
8. **Headless must not throw.** `setStatus` and `note` wrap every `ctx.ui.*` call in try/catch —
   route any new UI output through them.

## Layout

| Path | Purpose |
| --- | --- |
| `pi-continue.ts` | The whole extension: config, threshold maths, detection, settle handler, `/continue` |
| `test/fake-provider.ts` | Scripted provider via `registerProvider` — scenarios run offline, no API key |
| `test/probe.ts` | Dumps pi's lifecycle events and what the settle boundary sees; use it to re-check the assumptions above against a new pi version |
| `test/compaction-probe.ts` | Logs why/when pi compacts and the extension-visible usage at each boundary |
| `test/pihome/` | `PI_CODING_AGENT_DIR` fixture: compaction off, fake provider as default, retry off |
| `test/pihome-compact/` | Same fixture with compaction on (`reserveTokens 400`, `keepRecentTokens 100`) |
| `README.md` | User-facing: install paths, commands, env vars, threshold maths |

## Testing (offline, no API key)

Always pass `-nc` (skip context files, so this file is not loaded into the fake window), `-ne`
(skip installed extensions) and `PI_CODING_AGENT_DIR=./test/pihome` (so your real settings do not
leak into the run):

```bash
PI_CODING_AGENT_DIR=./test/pihome FAKE_SCENARIO=truncation FAKE_WINDOW=20000 \
pi --no-session -nc -ne -e ./test/fake-provider.ts -e ./pi-continue.ts \
  --provider fake --model fake-model -p "start working"
```

The `[fake] turn N <- "<last user text>"` lines on stderr are the assertion. Notifications and the
status footer are TUI-only — they do not appear in `-p` output, so the injected prompt is the only
visible evidence that the extension acted.

| What you are testing | Env | Expected |
| --- | --- | --- |
| Cutoff reported as `stopReason: "length"` | `FAKE_SCENARIO=truncation FAKE_WINDOW=20000` | `turn 2 <- "continue"`, then `stopReason=stop` |
| Cutoff reported as provider error text | `FAKE_SCENARIO=error FAKE_WINDOW=20000` | `turn 2 <- "continue"`, matched by `OUTPUT_LIMIT_PATTERNS`; without the large window the errored settle also reads as a full context and breathes first |
| Breath before continuing | `FAKE_SCENARIO=truncation FAKE_WINDOW=2000 FAKE_USAGE=1800` | `turn 2 <- "[pi-continue] Context checkpoint: 90%…"`, `turn 3 <- "continue"` |
| Streak cap | `FAKE_SCENARIO=always PI_CONTINUE_MAX=2 PI_CONTINUE_BREATHE_AT=99 FAKE_WINDOW=20000` | two `continue` prompts, then the run ends on the truncation notice |
| Compaction interaction | `PI_CODING_AGENT_DIR=./test/pihome-compact` | `compactAt` matches `window - reserveTokens` in `/continue status`; `session_compact` re-arms the breath |

Knobs: `FAKE_SCENARIO` (`truncation`, `error`, `always`; `breathe` only inflates usage and does
nothing on its own — a breath needs something to resume, so combine it with a truncation),
`FAKE_WINDOW`, `FAKE_USAGE`.

Keep `FAKE_WINDOW` ≥ ~20k for size-independent runs. `getContextUsage()` reports the fake provider's
usage when a turn settles normally (70 tokens by default), but on an **errored** settle pi estimates
the context from scratch — that estimate covers its system prompt and tool schemas, ~1.6k tokens
(~3.7k with this repo's context files loaded) and ignores `FAKE_USAGE`. A 1k fake window therefore
reads as 165% context on `FAKE_SCENARIO=error` and takes a breath you were not testing for. Check
the number with `test/compaction-probe.ts` if a run behaves oddly.

Manual check in the TUI: `pi -e ./pi-continue.ts`, then `/continue status` — it must print
`auto-compaction`, `breathe at` and `hard push at`. If the command is unknown, the extension did not
load.

There is no build, lint, typecheck step or CI: pi type-strips the file at load, so a type error
surfaces as a load error. One fake-provider scenario after every change is the smoke test.

## Conventions

- Tabs, double quotes, semicolons, module-scope `const` arrow helpers, JSDoc on the non-obvious
  parts. Keep it a single file.
- No runtime dependency, no build step: the "curl the `.ts` into `~/.pi/agent/extensions/`" install
  path in the README has to keep working.
- State lives in the module-scope `state` object; reset it in `session_start`.
- New behaviour must be observable: a `note()`, a footer segment, or a `/continue status` line.

## Don't

- Don't split the extension into more source files or add an npm dependency to it.
- Don't send `continue` while a breath is armed and the context is past the breath point — breathe
  first, then continue from the checkpoint.
- Don't derive truncation from the settle context alone; pi may already have dropped the message.
- Don't hardcode a threshold — go through `pointsFor()`.
- Don't add a `stopReason` or provider-error case without a matching `OUTPUT_LIMIT_PATTERNS` entry
  and a `FAKE_SCENARIO=error` run proving it.

## Releasing

1. Bump `version` in `package.json`; keep the `pi-continue.ts` header comment, the README tables
   (commands, env vars) and this file in sync with the code — the README documents maths and
   defaults that users hit directly.
2. `package.json` must still list `pi-continue.ts` and `README.md` under `files`, and
   `pi.extensions` must still point at `./pi-continue.ts`.
3. Smoke-test the published layout: `pi -e . -p "…"`, then `/continue status`.
4. Publish with `npm publish` (installs as `pi install npm:pi-continue`); git installs use
   `pi install git:github.com/dorukeke/picontinue`.
