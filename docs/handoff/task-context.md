# Handoff — thread context into tasks, and per-agent activity

Two pieces of work, written before building rather than after. They belong
together: both are about an agent knowing what it already knows, and the
second is a few lines once you are already in the file.

Neither is started. Everything below was read out of the code.

## Background: what an agent currently knows

Three separate channels carry context, and they do not overlap.

| | Carries | Reaches |
| --- | --- | --- |
| Handoffs | What earlier tasks completed, decided, and warned about | The next **task** in that repository |
| Thread history | The last `THREAD_CONTEXT_LINES` (24) of a thread | An agent **answering a question** |
| `priorContext` | The rendered handoffs | The **planning prompt** |

Handoff seeding was wired up on 2026-08-10 (`c4015dd`): `seedContextForTask`
had existed and been tested since the handoff work, and nothing in production
called it. The coordinator now calls it and passes the result as
`StartTaskInput.priorContext`, which both prompt adapters put in the planning
prompt, labelled as background rather than fact.

**Threads share context for talking, not for working.** `answerAsAgent` puts
thread history in the prompt when an agent *answers*. A task dispatched from
inside a thread gets `withRoleContext(role, message)` and nothing else — so
"now do the same for the other file" arrives at the agent with no idea what
"the same" refers to. That is the gap.

## Piece 1 — thread history into a task

### Why it is not a prompt tweak

The objective is the only text that travels from the channel to the agent, and
it is deliberately clean: it is what somebody asked for, and it is rendered in
the channel, in task lists, and in thread titles. Prepending a transcript to it
makes every request unreadable in the three places people actually read it —
which is why handoff context was given its own field rather than folded in.

So thread history needs its own field too, and that field has to survive the
trip: gateway → `submitTask` → the store → `runPendingTasks` → `TaskDefinition`
→ the adapter.

### The path, in order

1. **`submitted_tasks` gains a `context TEXT` column.** Migration 25 in both
   `schema.ts` and `postgres-schema.ts` (24 is `bumped_at`). Nullable; every
   existing row predates it and has nothing to say.
2. **`SubmitTaskInput` and `SubmittedTask` gain `context?: string`**
   (`services/persistence/src/store.ts`), written and read in all three
   backends. The SQL ones need it in the insert and in `toSubmittedTask`; the
   in-memory one stores it on the record.
3. **`ApiOperations.submitTask` gains `context?: string`**
   (`services/api-gateway/src/server.ts`), passed through by `taskSubmit` in
   `apps/web/src/index.ts`.
4. **`TaskDefinition` gains `context?: string`** (`packages/shared-types`), and
   `commands.ts:709` — the one place a `SubmittedTask` becomes a
   `TaskDefinition` — copies it across. `worker-operations.ts:718` and
   `recovery.ts:204` build definitions too; check each.
5. **The coordinator merges it with the handoff seed.** `coordinator.ts` already
   computes `priorContext` from `seedContextForTask`; the task's own context
   joins it — thread first, since it is about *this* request, handoffs second.

### Where the gateway gets the history

`dispatchOneMention` already knows: `input.threadMessageId` is set both for an
explicit reply inside a thread and for an auto-merge (`findThreadToContinue`).
`getChannelMessage(repositoryId, messageId, viewerId)` returns the root with
its replies.

Two things to get right:

- **Leave `progress` replies out.** They are the run narrating itself — see
  `ChannelEntryKind`. Feeding an agent its own previous commentary is noise it
  paid for once already.
- **Cap it.** `THREAD_CONTEXT_LINES` (24) is the number `answerAsAgent` uses and
  there is no reason to differ. A thread can be long and the agent pays per
  token.

### The judgement call

Only dispatch from *inside* a thread should carry it. A brand-new request that
merely happens to open a thread has no history worth carrying, and an
auto-merged one should carry the thread it was merged into — which falls out
naturally, because `threadMessageId` is set in exactly those cases.

## Piece 2 — activity per agent, not per person

`maybeAutoClaimTask` (and `bestFitFor`, copied from it on 2026-08-10) score
each candidate on its role, its name, and its owner's recent objectives. The
grouping key is `task.submittedBy`.

`submittedBy` is always the **agent's owner** — `dispatchOneMention` submits
every task with `actorId: candidate.userId`, deliberately, so that work
somebody else's agent takes never spends the sender's account. Org-wide
visibility changes who may *mention* an agent, not whose account it runs on.

**So two agents owned by one person share one work history.** Connect an
org-wide Claude and an org-wide Codex, let the team use both, and every task
groups under you — both agents then score identically on activity, and the
signal cannot say which of them did what. With org agents that is the ordinary
case, not the edge case.

### The fix needs no schema change

`SubmittedTask.agentId` is already the deployment's configured agent id, which
`resolveAgentIdForVendor` derived from the mentioned agent's vendor. And
`ApiOperations.listAgents()` returns `{ id, adapter }` for every configured
agent, where `adapter` is `codex` / `claude` / `gemini` / `generic-cli`.

So the gateway can:

1. call `listAgents()` and build `adapter → agentId`;
2. group recent objectives by `(submittedBy, agentId)` rather than by
   `submittedBy`;
3. look each candidate up by `(candidate.userId, agentIdFor(candidate.vendor))`.

`listAgents` is optional on `ApiOperations`. Where it is absent, fall back to
grouping by owner — the behaviour that exists today, which is wrong only in
the way described above and not worse than before.

### One thing already fixed

`dfac400` corrected the ordering: the store returns submitted tasks oldest
first and both callers took the first 25 per owner, so "recent activity" was
each owner's *earliest* work, frozen after 25 tasks. `recentFirst` now sorts
newest first. Do not reintroduce it by reading `listSubmittedTasks` directly.

## Verifying

`server.test.ts` has the fixtures: `startRuntime` fakes `submitTask` and
records every call, so a test can assert the context that travelled with a
task without running an agent. The thread path is exercised by posting a
channel message, waiting for the thread, then replying to it — the pattern in
*"approving a finding with 'yes, do it' dispatches the fix"*.

For piece 2, the fixture's `listAgents` already returns one `generic-cli`
agent; a test wanting two vendors will need to extend it.

Run suites **serially** (`--concurrency=1`). Several gateway tests drive real
HTTP and time out under a parallel workspace run — they fail at 26–48s where
they normally pass in 100ms, and the failure looks like a bug in the diff.
