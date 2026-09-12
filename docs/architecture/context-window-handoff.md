# Context-window handoff and session restart

**Status: phases 1-3 landed for Claude. Codex reports a per-round total only
and Gemini nothing before a task ends, so every adapter now declares what it
can observe — `contextObservation`, where absent reads as `none` — rather than
leaving the asymmetry to behaviour.**

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
  `AgentCapabilities.maximumContextTokens`, which an agent's
  `maximumContextTokens` in `.coordinator/config.json` now supplies. Guessing a
  window from a model name would be a number nobody checked, so without one
  configured only a compaction the CLI already performed triggers a handoff:
  that needs no threshold, being the tool stating it could not fit.

## Vendor support, as measured

| | Mid-run token signal | Compaction signal | Session resume |
|---|---|---|---|
| Claude Code | yes — per-turn `usage` | yes — `compact_boundary` | `--resume`, `--fork-session` |
| Gemini | **no** — terminal event only | none | `--resume` exists |
| Codex | per-round total via `turn.completed`, as the adapter reads it | unknown | `--ephemeral` disables persistence |

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
streams would be a guess. What the adapter reads today is `turn.completed`, one
event per exec whose usage is summed over the turn — a round's cost, not the
window's occupancy — which is why it declares `contextObservation: "per_round"`
and why the table above says "as the adapter reads it" rather than "measured".
The fixture it is tested against is hand-written; a real recording would be
worth more than any amount of wording here. Separately,
`adapters/codex/src/index.ts` passes `--ephemeral`, so the session persistence
a resume would need is switched off by our own invocation — irrelevant to this
feature, whose requeue is a fresh invocation seeded with text rather than a
resume, but worth revisiting when Codex can actually be run.

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
structurally the same manoeuvre, and `requeueForContextHandoff` beside it is
the one this feature built. `HandoffReason` already declared `long_running`;
that is what the requeue now constructs.

## The protocol

The asymmetry above is declared rather than left to behaviour, because a
driver cannot otherwise tell "this vendor will never ask to be handed off"
from "this vendor has not asked yet" — two states that look identical in a
fleet and one of which looks exactly like a broken adapter.

- `AgentCapabilities.contextObservation` (`packages/agent-protocol`) is
  `"live"`, `"per_round"` or `"none"`, and absent reads as `none`. Claude is
  the only `live` adapter; Codex declares `per_round`; generic-cli, Gemini, the
  browser CLIs and the scripted agent declare `none`.
- `AgentContextPressure` (`packages/shared-types`, beside `TaskHandoff`) is the
  figures themselves: occupancy, peak, window, turns, compactions, tokens
  those compactions dropped, and whether a tool result landed after the last
  reading. It lives in shared-types rather than in the agent protocol because
  the control plane is the side that has to hold it — the gateway relays it and
  `worker-operations` writes it into an audit event — and the gateway has no
  dependency on the agent protocol.
- `context_handoff_requested` is the one new `AgentEvent`. It is neither a
  completion nor a failure: no `completed` follows, `collectChanges` is not
  called, and a driver that does not recognise it leaves the run to end the way
  it always did. It carries the pressure figures and the adapter's own verdict
  in words — and that verdict is trace data. It is recorded on the audit event
  and never copied into a handoff, because a handoff is projected from what the
  control plane holds rather than from prose an adapter asserted.

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

**Phase 2 — landed.** The monitor is wired into the running Claude session.

- `spawn` takes the phase it is buying and attaches a `ContextPressureMonitor`
  beside the narrator whenever the profile both streams and declares
  `contextObservation: "live"`. One monitor per invocation, booked to that
  invocation's phase, and cleared by `run` only after the round's envelope has
  been billed — so no round is counted twice and none is invisible in between.
- `reportedTokenUsage` now adds the in-flight monitor's `usage()` to its own
  phase's bucket, which is what the worker heartbeat has always asked for and
  always received empty. A per-task token budget can therefore stop a run
  mid-round instead of after it. Billing is keyed on `message.id`, because
  Claude repeats an assistant event per content block and the occupancy
  heuristic the turn count uses cannot tell two identical requests apart.
- The observer acts only during execution, and only at a tool boundary. A
  planning round is watched and never stopped: it is read-only under
  `--permission-mode plan`, and handing off a plan buys nothing.
- `parseClaudeSessionId` now reads through `claudeResultEnvelope`, like
  `unwrap` and `parseClaudeUsage`. It used to `JSON.parse` the whole of stdout,
  which is one JSON value only while a profile buffers — so from the day both
  phases moved to `--output-format stream-json`, every real run threw there and
  recorded no resume token at all. The unit tests missed it because their
  envelope helper emits a single line. With the read fixed, the phase a token
  is kept from matters: an execution round's id is always recorded, and a
  planning round's is kept only for a conversation. A one-shot task that
  resumed its planning session would drag the whole planning transcript into
  the window this feature exists to watch, for a plan the driver hands back in
  the execution prompt anyway.

**Phase 3 — landed.** The graceful early requeue.

- The adapter stops the round through the same `AbortController` `cancel` uses,
  after recording its verdict on the session record — which is how `run` tells
  a deliberate stop (a `ContextHandoffStop`) from a person cancelling a task,
  since both come back as exit 130 with `aborted: true`. SIGKILL is acceptable
  at this boundary precisely because of where the boundary is: nothing local is
  in flight, and the requeued task starts from a fresh workspace.
- Two boundaries are acted on and one is deliberately not. A `compact_boundary`
  is printed between requests, so it is acted on the line it arrives on. A tool
  result is printed after the tool finished and while the CLI composes the next
  request — which is what `staleAfterToolResult` means — so an occupancy
  verdict is acted on there. A turn signal on its own is never acted on: the
  model may be writing its final answer, and one tool short of finishing is the
  worst moment to throw a round away.
- The worker reports `status: "handed_off"` with the figures, and only when the
  assignment carried `contextHandoffsRemaining`. That field's presence is the
  signal that this control plane knows the status; an older one answers it with
  a 400, and a 400 there would strand the lease until it expired. Without the
  field the adapter is never given permission to stop in the first place.
- `requeueForContextHandoff` writes `task_handed_off` **first**, so every
  figure the handoff cites has a record behind it; projects a `long_running`
  handoff from those numbers; and only then releases the lease, which is what
  returns the row to the queue. The event is deliberately not a terminal
  channel event — the task is not over, it is between attempts.
- The re-entry guard is `MAX_CONTEXT_HANDOFFS = 2`, counted from the
  `long_running` handoffs on the live audit log rather than from a column: the
  count lives where the handoffs do, and no migration is needed for a number
  the log already holds. A compacted or pruned log resets it, which costs at
  most one more budget for that task. A task past its budget is failed with
  `stage: "context_handoff_budget"` — twice filling a window after being
  reseeded with everything the control plane knows is a task that does not fit,
  and a queue it circles forever is worse than an ending that says so. The
  guard is also the permission, on both drivers: a task with no budget left is
  never given `handOff` at all — remotely from `contextHandoffsRemaining` on
  the assignment, in process from the same count read where the run is built.
  A last attempt therefore runs to whatever ending it reaches, rather than
  stopping itself into a failure it cannot be requeued from.
- Both drivers requeue. Remotely the lease is released; in process the
  coordinator returns `status: "queued"`, which the runner already turns into a
  released lease or a `retrySubmittedTask`. Both count the same budget from the
  same log, so a task that stops once on a worker and once in process has spent
  two of its two.
- The requeued task is reseeded with its own note on both paths:
  `claimWorkRepository` returns `handoffContext` — outside the gate that
  withholds the planning estimate from a claimed task, because a task's own
  handoff is not a hint about where to start reading — and the in-process
  coordinator lifts the task's own handoff out of the repository-wide seed so
  the limit of five cannot drop it.

## What is still not built

- **Delivery to a claimed task.** `handoffContext` rides the claim answer
  whether or not a claim was granted, but the adapters render prior context
  into the planning prompt only. A task handed its repository never plans, so
  today it carries the note without reading it. Delivering prior context to
  execution is a change to the adapters, and it is the same gap the
  repository's standing context has.
- **Salvage of the stopped attempt's edits.** They are discarded, and the
  handoff says so. Naming the files that were touched would cost one field on
  the `handed_off` body; promoting a validated subset would cost a great deal
  more.
- **Gemini**, pending a vendor signal: no threshold or prompt wording
  substitutes for usage the CLI does not report before the run ends.
- **Codex occupancy**, pending a real recording of `codex exec --json`. The
  adapter's fixture is hand-written, so `per_round` is what the adapter reads
  rather than a measured fact about the CLI.
