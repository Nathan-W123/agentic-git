# Handoff — thread context into tasks, and per-agent activity

Two pieces of work, written before building and rewritten after. They belong
together: both are about an agent knowing what it already knows, and the
second was a few lines once the first was in the file.

Both are built. Piece 1 landed in `dfa266a` (2026-09-02, the commit that added
migration `submitted-task-context`); the gaps it left — the remote worker, the
`generic-cli` adapter, the editor path, work proposed by an answer — were
closed afterwards, and this page records the whole of what is there now.
Everything below was read out of the code; identifiers are function and type
names rather than line numbers, because the lines moved between the first
draft of this page and the second.

## Background: what an agent knows

Five channels carry context, and they reach different places.

| | Carries | Reaches |
| --- | --- | --- |
| Handoffs | What earlier tasks completed, decided, and warned about | The next **task** in that repository, as planning notes |
| Thread history | The part of a thread `selectThreadContext` keeps under `THREAD_CONTEXT_TOKEN_BUDGET` (1,600 tokens; 400 per entry; older entries recalled by relevance at or above `THREAD_CONTEXT_RELEVANCE_MIN`, 0.12), with an explicit elided-history notice where it cut | An agent **answering a question** in the thread, and a **task** dispatched from inside it |
| Channel memo | One line per conversation the room recently settled (`channel-memo.ts`, a few hundred tokens) | Every **mention-dispatched task**, and work an editor files for itself |
| Standing context | The note the repository's people wrote for every agent (`repository_contexts`, versioned and audited; see [repository-standing-context.md](../architecture/repository-standing-context.md)) | Every **task** in that repository, as planning notes, and an editor's `take_task` brief |
| `priorContext` | All of the above that applies, thread first, then the standing context, then the control plane's planning hints and the handoffs | The **planning prompt** |

Handoff seeding was wired up on 2026-08-10 (`c4015dd`): `seedContextForTask`
had existed and been tested since the handoff work, and nothing in production
called it. The coordinator calls it and passes the result as
`StartTaskInput.priorContext`, which the prompt adapters put in the planning
prompt, labelled as background rather than fact.

**Threads share context for talking and for working.** `answerAsAgent` puts
thread history in the prompt when an agent *answers*; `dispatchOneMention`
puts it on the task when an agent is asked to *do* something — so "now do the
same for the other file" arrives at the agent with the messages that say what
"the same" is. That was the gap, and it is closed on every path listed below.

## Piece 1 — thread history into a task

### Why it is not a prompt tweak

The objective is deliberately clean: it is what somebody asked for, and it is
rendered in the channel, in task lists and in thread titles. Prepending a
transcript to it makes every request unreadable in the three places people
actually read it — which is why handoff context was given its own field
rather than folded in, and why thread history has one too. The gateway alone
writes it: `routes/tasks.ts` still accepts an objective and an agent and
nothing else, because context is something the room computes, never something
a client asserts.

### The path, in order

1. **Persistence.** Migration `submitted-task-context` in `schema.ts` and
   `postgres-schema.ts` adds `submitted_tasks.context TEXT`, nullable. It is
   `SubmitTaskInput.context` and `SubmittedTask.context` in `store.ts`,
   written in `submitTask` and read in `toSubmittedTask` in both stores.
   There is no in-memory store to cover: what tests call in-memory is
   `SqliteCoordinationStore.open(":memory:")`. `store-contract.test.ts`
   pins the round trip on both backends ("a task's context survives being
   claimed", "a task submitted with no context has none").
2. **Gateway to store.** `ApiOperations.submitTask` carries `context`;
   `apps/web/src/index.ts` passes it to `taskSubmit` in
   `apps/cli/src/commands.ts`, which trims and stores it. The test harness
   records every call in `runtime.submittedTasks`, `context` included.
3. **Store to `TaskDefinition`.** `TaskDefinition.context` lives in
   `packages/shared-types`. It is copied wherever a `SubmittedTask` becomes a
   definition: the local run loop in `commands.ts`, and `worker-operations.ts`
   in `authority.admit`, the integration definition, and the deferred-scope
   and conflict follow-up re-submits. `recovery.ts` builds no definitions
   (it only integrates), and `benchmark.ts` starts fixtures whose definitions
   carry whatever the scenario put there.
4. **The two adapter slots** are `StartTaskInput.priorContext` and
   `StartTaskInput.conversational` in `packages/agent-protocol` — not in
   shared-types. `task.context` is the conversation and nothing else;
   `priorContext` is the conversation first, then everything else planning
   should know. The coordinator (`coordinator.ts`, where it builds
   `startInput`) joins `[thread, turn note, lease note, standing context,
   likely files, recent touch points, handoffs, derived pitfalls]` into
   `priorContext`, passes `task` through with its context untouched, and
   sets `conversational: true` for a turn of a conversation. The remote
   worker (`worker.ts`, after `claimRepository`) does the same with
   `[thread, standingContext, planningContext]`, and sets `conversational`
   from `SubmittedTask.conversationId`. It used to join the two and pass the
   join in both slots, which presented the control plane's file estimates to
   the model as something somebody said, and it never set `conversational`,
   so every conversational turn on a worker opened as a one-shot. On a
   worker the flag is the whole of it so far: the session is opened
   resumable (Codex is run without `--ephemeral`), but nothing on the worker
   resumes it — there is no `continueTask` or `resumeToken` call in
   `worker.ts`, and each turn of a conversation arrives as a fresh `startTask`
   carrying the thread in `task.context`. Vendor-side continuity between
   turns exists only on the in-process coordinator, which keeps the session
   on its `OpenConversation` and calls `continueTask` when the adapter has
   one; a reader should not expect it on a worker host.
5. **Adapters.** `codex` and `prompt-cli` render `priorContext` in the planning
   prompt ("Background about this repository — notes left by earlier work and
   by the people who work here") and `task.context`
   through `conversationContextLines` in the execution and replan rounds, and
   raw in the forced-question round. `generic-cli` builds no prompt: it
   forwards both as the optional `context` and `priorContext` fields of its
   `start` message (`StartMessage` in `protocol.ts`, sent by `spawnAgent`),
   absent when empty, so an agent written before them sees the message it
   always saw. `docs/protocol/generic-cli.md` documents them.
6. **The remote path** is `leaseWork` in `worker-operations.ts` handing
   `task: leased.task` — the whole `SubmittedTask` — to the assignment,
   `routes/workers.ts` sending it, and `worker.ts` building `startTask` from
   it as above.

### Where the gateway gets the history

`dispatchOneMention` computes `continuing`: the explicit `threadMessageId`
when somebody asked inside a thread, otherwise — for a plain mention — a
thread named outright (`findThreadByName`) or one the request closely
resembles (`findThreadToContinue`, held to `THREAD_MERGE_MIN_OVERLAP`). Only
when `continuing` is set does `threadContextFor` run: it reads the root and
its replies, drops `progress` replies (the run narrating itself) and the
request being dispatched (it is already the objective), and hands the rest to
`renderThreadContext`, which selects under the budget, splices the
`elidedHistoryNotice` after the opening message, and adds the heading the
adapters know. `channelMemoFor` runs for every dispatch, excluding the thread
being carried in full. The task's `context` is memo, then thread; a brand-new
request gets the memo alone, and its `context` is `undefined` when the room
has settled nothing.

Three other dispatches carry context by their own route, because they do not
go through a mention:

- **Work proposed by an answer.** When `answerInChannel` answers a question
  and its `ANSWER_TASK:` line proposes work, the dispatch (trigger
  `answer_followup`) carries the question and the answer, rendered by the same
  `renderThreadContext`. The answer is a flat message referencing the
  question rather than a reply under it, so nothing that reads the thread back
  would find it; `answerInChannel` returns what it said for this reason.
- **Work an editor files for itself.** `fileForEditor` in the gateway's MCP
  deps submits directly, bypassing `dispatchOneMention`, so it computes
  `channelMemoFor` itself — before posting, so the post cannot be read back as
  background to itself. Its mention-less post can still be auto-claimed by
  the room's model, a possible second task for the same objective that
  predates the memo and is left as it was.
- **Work an editor takes.** `EditorWorkOperations.take` returns `context`
  (from `takeEditorWork` in `worker-operations.ts`), `takeForEditor` forwards
  it onto `McpTakenTask`, and `takenTaskBrief` prints it between the
  objective and the repository line, labelled as background.

### What is not carried

- A question routed to its owner's machine (`kind: "question"`, filed by
  `answerInChannel` under `COORD_LOCAL_AGENTS_ONLY`) carries no context. Right
  today, because every caller is at the channel root; the comment at the
  submit says what an in-thread caller must add.
- MCP `submit_task` cannot file inside an existing thread — `post` always
  opens a root — so an editor continuing a conversation gets the thread only
  when `findThreadToContinue` merges the request into it. A `reply_to`
  argument that reuses `addChannelReply` and `answerThreadReply` is the shape
  of the fix; see "Still open".

## Piece 2 — activity per agent, not per person

`maybeAutoClaimTask` and `bestFitFor` score each candidate on its role, its
name, and its owner's recent objectives. `submittedBy` is always the agent's
**owner** — `dispatchOneMention` submits every task with `actorId:
candidate.userId`, deliberately, so that work somebody else's agent takes never
spends the sender's account — and so two agents owned by one person used to
share one work history.

`agentActivityIn` now keys activity by `(submittedBy, vendor)`: the vendor is
the `adapter` of the configured agent from `listAgents()`, falling back to the
vendor name inside the agent id. `bestFitFor` and `maybeAutoClaimTask` look
each candidate up by `(candidate.userId, candidate.vendor)`. `listAgents` is
optional on `ApiOperations`; a task whose vendor cannot be read either way
contributes to nobody's queue rather than to everybody's, so it can never make
an idle agent look busy. The test is `server-channel.test.ts` "a second
request goes to a free agent, not the one already working".

`dfac400` corrected the ordering: the store returns submitted tasks oldest
first and both callers took the first 25 per owner, so "recent activity" was
each owner's *earliest* work. `recentFirst` sorts newest first; do not
reintroduce it by reading `listSubmittedTasks` directly.

## Verifying

The recorder is `runtime.submittedTasks` in `test-harness.ts`: `startRuntime`
fakes `submitTask` and records every call, so a test asserts the context that
travelled with a task without running an agent.

- Thread dispatch: `server-threads.test.ts` "animation work asked for inside a
  thread is dispatched with its context", "a request that merely opens a
  thread carries nothing; the follow-up in it does", and "a long thread
  reaches the task cut to budget, and says where the cut is".
- Auto-merge: `server-tasks.test.ts` "work merged into a resembling thread
  carries that thread with it".
- Answer follow-up: `server-channel.test.ts` "work proposed by an answer
  carries the question and the answer that scoped it".
- Editor path: `server-mcp.test.ts` "an editor that takes a task filed inside
  a thread is told the thread" and "work an editor files for itself carries
  what the room has settled"; `mcp-work.test.ts` pins `takenTaskBrief`
  directly. `seedTaskFor` in the harness takes a `context` argument for this.
- Remote worker: `apps/worker/src/worker.test.ts` "a remote worker keeps the
  thread as the conversation and planning hints as notes, and opens a
  conversational session", through the injected `codexRunner`, which sees the
  prompt and the argv. The `FAKE_CLAUDE` stand-in in the same file logs argv
  only; the Claude prompt goes over stdin.
- `generic-cli`: `generic-cli-adapter.test.ts` "the start message carries the
  conversation and prior notes as their own fields, and only when there are
  any", read back from the fixture agent's `FIXTURE_START_LOG`.

Run suites **serially** (`--concurrency=1`). Several gateway tests drive real
HTTP and time out under a parallel workspace run — they fail at 26–48s where
they normally pass in 100ms, and the failure looks like a bug in the diff.

## Still open

- MCP `submit_task` has no way to file inside a thread. The fix is a
  `reply_to` argument naming an earlier task id: look the task up, refuse
  when it is another repository's or has no `conversationId`, then
  `addChannelReply` and an awaited `answerThreadReply` (the route's version is
  fire-and-forget except for `/push`). `answerThreadReply` picks the thread's
  named or owning agent, not `submit_task`'s own-editor rule, so a thread
  that names nobody needs the caller's own agent prepended as a mention, or a
  refusal.
- `fileForEditor`'s mention-less post can be auto-claimed beside the task it
  files. Either post with a flag that suppresses auto-claim or accept the
  twin; today the two carry different context.
- `threadContextFor` drops only `progress` replies. Whether `system` and
  `plan` replies belong in a task's context is undecided.
- The planning-prompt heading in the adapters was reworded when the standing
  context landed; it names both provenances now, and still does not mention
  the thread that leads the block. Cosmetic.
- Routed questions could carry the channel memo even at the root; cheap, but
  it changes the prompt the worker's `answerQuestion` sees.
- The per-run `tasks` table (`saveTask` in `worker-operations.ts`) does not
  record context. No agent reads it; a dashboard might, and it would be a
  new migration.
