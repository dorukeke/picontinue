# pi-continue

An extension for [pi](https://github.com/earendil-works/pi) that keeps the agent moving when the
model runs out of output tokens instead of going idle mid-task.

When a response is cut off by the output token limit, pi stops the run and waits. From there you
either retype a nudge or watch the session drift. pi-continue notices the cutoff and, at the last
moment before the agent would go idle, sends the continuation prompt itself. If the context is
already heavy, it first makes the model take a **breath** — a short, tool-free checkpoint of what
is done and what comes next — and only then asks it to resume, so the restart happens from a
compact restatement rather than from a window that is about to be compacted out from under it.

```
pi-continue: response hit the output token limit — continuing (1/8)
```

## Install

### From GitHub

```bash
pi install git:github.com/dorukeke/picontinue
```

### From a local checkout

```bash
pi install ~/projects/picontinue      # personal: ~/.pi/agent/settings.json
pi install -l ~/projects/picontinue   # project only: .pi/settings.json (needs project trust)
```

### Try it once, change nothing

`-e` loads a package for a single run without writing it to settings:

```bash
pi -e git:github.com/dorukeke/picontinue -p "your prompt"
pi -e ~/projects/picontinue -p "your prompt"
```

### Single file, no package

The whole extension is one TypeScript file. Drop it in the extensions directory and pi discovers
it on the next start:

```bash
mkdir -p ~/.pi/agent/extensions
curl -o ~/.pi/agent/extensions/pi-continue.ts \
  https://raw.githubusercontent.com/dorukeke/picontinue/main/pi-continue.ts
```

A checkout works too, so you can edit and reload:

```bash
ln -s ~/projects/picontinue/pi-continue.ts ~/.pi/agent/extensions/pi-continue.ts
```

### Check that it loaded

```bash
pi list          # package installs
```

Inside pi, run `/continue status` — it prints the current context maths. If that command is
unknown, the extension is not loaded. After installing, restart pi or run `/reload`.

### Remove it

```bash
pi remove git:github.com/dorukeke/picontinue
pi uninstall git:github.com/dorukeke/picontinue   # alias
```

For a local-path install the source has to match what is stored in settings; `pi list` shows the
exact string to pass.

## What it does

| Situation | Behaviour |
| --- | --- |
| Response stopped with `stopReason: "length"` | Inject the continue prompt at the settle boundary |
| Provider reports the cutoff as error text (`max_tokens`, "reached the maximum output token limit", …) | Same |
| Context is heavy when the cutoff lands | Take a breath first, continue after the checkpoint has landed |
| `PI_CONTINUE_MAX` truncations in a row (default 8) | Stop nudging, warn, wait for you; `/continue` pushes on |
| Run was aborted, or you already queued a message | Do nothing |
| A turn ends normally | Reset the streak, and re-arm the breath |

Detection happens twice on purpose: on `message_end`, where the assistant message is visible, and
again at the settle boundary. pi drops an incomplete assistant message from the settle context, so
the `message_end` signal is carried forward as state instead of being re-derived there.

### Status footer

```
ctx 46% 60k/131k · compact>67k · continue 2/8
```

Colours shift to warning as the context approaches the breath point and to error past the hard
point. `breathing` means a checkpoint is pending, `breath armed` means the breath is next. In
headless (`-p`) runs the status is skipped and only the notifications remain.

## Commands

| Command | Effect |
| --- | --- |
| `/continue` | Show status and send the continue prompt now |
| `/continue status` | Status only: streak, context, compaction point, breath and hard points |
| `/continue on` / `/continue off` | Toggle auto-continue for the session |
| `/continue breathe` | Force a breath checkpoint now, regardless of size |
| `/continue compact` | Run pi's compaction with instructions that preserve the next step, then continue |

## Configuration

Environment variables, read once when pi starts — restart after changing them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_CONTINUE_MESSAGE` | `continue` | The prompt sent to resume |
| `PI_CONTINUE_BREATHE_AT` | `80` | Context percentage that triggers a breath |
| `PI_CONTINUE_HARD_AT` | `93` | Percentage at which the checkpoint also asks the model to save state to a file |
| `PI_CONTINUE_COMPACT_MARGIN` | `6000` | Tokens before pi's auto-compaction point at which to breathe |
| `PI_CONTINUE_RESERVE_TOKENS` | `0` (read from settings) | Override `compaction.reserveTokens` |
| `PI_CONTINUE_MAX` | `8` | Consecutive auto-continues before giving up |
| `PI_CONTINUE_OFF` | unset | Set to `1` to start disabled |

```bash
PI_CONTINUE_MESSAGE="keep going" PI_CONTINUE_MAX=3 pi
```

## How the thresholds are computed

pi compacts automatically once `contextTokens > contextWindow - compaction.reserveTokens`, so a
fixed percentage fires too late on a model with a large reserve (a 131k window with a 64k reserve
compacts at ~50%). The points are therefore headroom-aware:

```
compactAt = contextWindow - reserveTokens
breathe   = min(breatheAt%  × contextWindow, compactAt - compactMargin)
hard      = min(hardAt%    × contextWindow, compactAt)
```

With a 131k window, a 64k reserve and the defaults: `compactAt ≈ 67k`, `breathe ≈ 61k` (47%),
`hard ≈ 67k`. `reserveTokens` is read from pi's own settings for the current
`provider/model`, and re-read on model switch.

## Development

Everything is in `pi-continue.ts`; there are no runtime dependencies. Tests use a scripted fake
provider, so they run offline:

```bash
cd ~/projects/picontinue
FAKE_SCENARIO=truncation pi --no-session -ne -nc \
  -e ./test/fake-provider.ts -e ./pi-continue.ts \
  --provider fake --model fake-model -p "start working"
```

`-nc` keeps `AGENTS.md`/`CLAUDE.md` out of the run. It matters on the error path: when the provider
errors, pi estimates the context instead of taking the provider's own usage, and that estimate
(~1.6k tokens, and ~3.7k with the context files loaded) sails past a small `FAKE_WINDOW` and
triggers a breath. Pass `FAKE_WINDOW=20000` to exercise the plain continue path.

`FAKE_SCENARIO` selects the first turn's stop reason: `truncation` (`length`), `error` (cutoff
reported as error text), `breathe`, or `stop` (no action expected). `breathe` only inflates the
reported usage, and a breath also needs something to resume from, so test that path as
`FAKE_SCENARIO=truncation FAKE_WINDOW=2000 FAKE_USAGE=1800`: the checkpoint lands first, then
`continue`. `-ne` keeps other installed extensions out of the run. `test/probe.ts` and `test/compaction-probe.ts` print pi's raw boundary
and compaction state when you need to check behaviour against your pi version.

## Requirements

pi 1.5.x (developed against 1.5.2). pi bundles the `.ts` file directly — no build step.

Publishing to the [pi package gallery](https://pi.dev/packages) is a normal `npm publish`: the
`pi-package` keyword and the `pi.extensions` entry in `package.json` are what make it discoverable,
after which it installs as `pi install npm:pi-continue`.

## License

Apache-2.0
