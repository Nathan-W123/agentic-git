# Context-window handoff and session restart

**Status: phase 1 landed. Phases 2 and 3 are paused deliberately, pending
cross-vendor support. Do not build them for Claude alone.**

The goal is that an agent approaching its context limit mid-task writes a
handoff and continues in a fresh session seeded with it, instead of degrading
inside an overloaded window.

This document records what was measured about the three vendor CLIs, because
most of the design follows from facts that are not what one would assume, and
one of them is a blocker no amount of implementation effort removes.

## The premise needed correcting: Claude Code does not hit a wall

The feature was conceived around an agent that runs out of context mid-task.
That is not what happens. Claude Code compacts itself and carries on.

A forced compaction — `CLAUDE_CODE_AUTO_COMPACT_WINDOW=32000`, a 232 KB file
read twice — produced this, verbatim:

```
assistant  ctx=25772
assistant  ctx=48153
>>> compact_boundary {"trigger":"auto","pre_tokens":69478,"post_tokens":22823,
                      "cumulative_dropped_tokens":46655,"duration_ms":41749}
assistant  ctx=48483
result success turns=4
```

The run **succeeded**. There is no error, no non-zero exit, no truncated
output. What there is: **46,655 tokens of history discarded** by a generic
summariser that has never seen the admission, the constraints, the withheld
resources, or the validation evidence.

So the case for this feature is not rescuing a doomed run. It is that the
control plane can already project a *better* handoff than the summariser can
write — from evidence, per `services/coordinator/src/handoff.ts` — and today
that projection is never offered to a session that is about to lose its
history.

## What is observable mid-run

Occupancy is `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens` from each `assistant` event's `usage` block.

This is **not** the figure the adapters already record. Those total cost, which
includes `output_tokens` and sums across turns. Occupancy is the latest turn's
input side only. Two different questions, two different numbers.

The metric cross-checks against the vendor's own accounting: last observed
occupancy `48,153` plus the pending ~82 KB tool result (~21k tokens) ≈ `69,478`
= the `pre_tokens` the tool measured for itself.

Two limits worth knowing before building on it:

- **Occupancy lags by one tool result.** Usage is reported when a request is
  *sent*, so a result that landed since is uncounted. The gap was 21k tokens in
  the run above. Thresholds need headroom; the reader exposes
  `staleAfterToolResult` so a caller can treat the figure as a floor.
- **The window size is not in the stream.** `contextWindow: 200000` appears
  only in the final `result` event, which is exactly when it stops being
  useful. The limit has to come from configuration —
  `AgentCapabilities.maximumContextTokens` already exists for this and is
  currently unused. Guessing a window from a model name would be a number
  nobody checked.

## Vendor support, as measured

| | Mid-run token signal | Compaction signal | Session resume |
|---|---|---|---|
| Claude Code | yes — per-turn `usage` | yes — `compact_boundary` | `--resume`, `--fork-session` |
| Gemini | **no** — terminal event only | none | `--resume` exists |
| Codex | unverified | unknown | `--ephemeral` disables persistence |

**Gemini is blocked on a vendor capability that does not exist today.** Its
`StreamJsonFormatter` emits `init`, `message`, `tool_use`, `tool_result`,
`error` and `result`; token stats are attached only to the terminal `result`
event, via `convertToStreamStats`. The per-message events carry role and
content and no usage whatsoever. There is nothing to sample while a task runs.
This was read from the shipped bundle rather than tested live, because the
account available returns `IneligibleTierError`. Until the CLI reports usage
before completion, Gemini can only ever get the end-of-task handoff that
already exists.

**Codex is unverified, which is not the same as unsupported.** It could not be
exercised: the CLI is not installed on the machine this was investigated on and
its sandbox helper install is broken. Any statement about what `codex exec`
streams would be a guess. Separately, `adapters/codex/src/index.ts` passes
`--ephemeral`, so the session persistence a resume would need is switched off
by our own invocation — worth revisiting when Codex can actually be run.

## What "restart" would mean here

Not pause/resume. These are one-shot CLI invocations, and the adapters that
throw on `pause()` are being honest rather than unfinished.

`--resume` is also the wrong tool even where it exists: it restores the *same
overloaded context*, which is the thing being escaped. A fresh invocation
seeded with the handoff is strictly better, and `seedContextForTask()` already
renders exactly that text.

So the shape is a **graceful early requeue**: abort at a tool boundary, project
a `long_running` handoff from control-plane evidence, requeue the task seeded
with it. `requeueForCanonicalChange` in `apps/cli/src/worker-operations.ts` is
structurally the same manoeuvre and is the model to follow. `HandoffReason`
already declares `long_running`; nothing constructs it yet.

## Phases

**Phase 1 — landed.** The detection substrate, and nothing else.

- `runProcess` gained opt-in `onStdout` / `onStderr` observers. This was the
  hard blocker: it buffered both streams and resolved only on `close`, so *no*
  adapter could react to anything mid-execution regardless of what a CLI
  emitted. Per-stream `StringDecoder` so a multi-byte character split across
  reads is not corrupted; observers see bytes the retention cap declines to
  keep, since a monitor that went blind at the cap would fail on exactly the
  long runs it exists to watch; a throwing observer cannot kill the run.
- `adapters/prompt-cli/src/context-pressure.ts` — a pure state machine over the
  stream-json lines. Tested against `recorded-stream.fixture.ts`, a real
  recorded run rather than an invented one.

Nothing calls it. No existing behaviour changed.

**Phase 2 — paused.** Switch the Claude profile to `--output-format
stream-json` and wire the monitor in. The risk is contained but real: `unwrap`
and `parseClaudeUsage` currently treat the whole of stdout as one envelope,
and under stream-json the result becomes one line among many. Worth noting the
payoff is broader than this feature — `reportedTokenUsage()` would start
returning live figures, which the worker heartbeat already asks for and today
always receives empty.

**Phase 3 — paused.** The requeue itself, plus a re-entry guard so a task
cannot requeue forever.

Both are paused for the same reason: they would deliver a context-aware handoff
for one of three CLIs and make the adapters asymmetric in a way that is
awkward to unpick later. The intended end state is cross-vendor. Phase 2 should
resume when Codex can be verified on a working install, and phase 3 when there
is a defensible story for Gemini — most likely a vendor change, since no
threshold or prompt wording substitutes for usage the CLI does not report.
