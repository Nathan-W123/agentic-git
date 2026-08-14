# Agent actions

A design for letting an agent ask the platform to *do* something mid-task,
rather than only to edit files and describe what it did.

Not built. Written after "take a screenshot of the UI and paste it in the
chat" turned out to be impossible for a reason that had nothing to do with
screenshots.

## The gap, stated precisely

It is smaller than it first looks, and being precise about it is what keeps
this feature from growing into "give agents everything".

An agent today can already: run any shell command, iterate internally, read and
write its workspace, ask a **person** a question mid-task and wait for the
answer (`question_asked` → `QuestionController` → back), and ask for **more
scope** mid-task and wait for the decision (`scope_change_requested` →
`ScopeChangeDecision` → back). Its results come back as file changes *and* a
free-text explanation — the explanation is a real channel, and a long report
travels through it intact.

What it cannot do is ask the *platform* for anything. Two round trips exist and
both are special cases: one talks to a human, one talks to the scheduler.
Neither generalises. So an agent cannot say "start this repository's app and
tell me the URL", which means it cannot look at the thing it just built, which
is why a screenshot is out of reach — not for want of a browser, which it can
install and run itself, but for want of somewhere to point it.

Nothing an agent starts outlives its task, either. That is deliberate and
correct: a task ends, its workspace is destroyed, and a server left running
would be an orphan. `PreviewService` exists precisely because a preview has to
outlive a run — and the agent has no way to reach it.

## The shape

A third round trip, built like the two that already work.

### Protocol

An agent event, alongside `scope_change_requested` in
`adapters/generic-cli/src/protocol.ts`:

```
{ event: "action_requested", requestId, action: "preview_start", occurredAt }
```

And a host reply, alongside `scope_decision`:

```
{ type: "action_result", sessionId, result: {
    requestId,
    action: "preview_start",
    outcome: "done" | "refused",
    detail: { url?: string },
    explanation: string,
} }
```

The adapter half is already written twice over: `sendScopeDecision`
(`adapters/generic-cli/src/index.ts:605`) resolves a pending promise held by the
agent, and the event dispatch in `handleAgentEvent`
(`services/coordinator/src/coordinator.ts:1519`) is where the new case goes.

### The coordinator cannot do this itself

`PreviewService` lives in `apps/web`; the coordinator is a service and knows
nothing about deployments. Same problem the durable referee had, and the same
answer: an optional injected interface.

```ts
export interface ActionAuthority {
  perform(input: {
    task: TaskDefinition;
    repository: CanonicalRepository;
    action: string;
  }): Promise<{ outcome: "done" | "refused"; detail?: unknown; explanation: string }>;
}
```

Absent by default, exactly like `planAuthority`, so a benchmark or a CLI run is
unchanged and a deployment that can host actions supplies one. `apps/web` wires
it to the operations it already exposes.

## The rule that keeps this safe

> **An agent may only request actions the task's submitter could perform
> themselves, on the task's own repository.**

That single sentence is the security model, and everything below follows from
it.

It means the action list is **fixed and short**, never "run this command". An
open channel would let an agent ask the platform to do what the agent itself is
forbidden to do — which would quietly undo scope enforcement, the thing that
makes plan arbitration mean anything. A request to start a repository's own
configured preview command is not that: the command was configured by an
operator, the repository is the one the task is already editing, and the
permission is the one the submitter already holds.

Consequences worth stating:

- **Scoped to the task's repository.** An agent cannot act on another one, which
  is where a prompt-injected agent would otherwise reach first.
- **Bounded per task.** A cap on requests, because a loop that starts a preview
  a thousand times is a denial of service written in three lines of agent.
- **Refusal is a normal answer.** `refused` with a reason, not an exception —
  the agent carries on within what it already has, exactly as a rejected scope
  change leaves the approved plan in force.
- **Recorded.** Every request and answer is an audit event, so "what did this
  agent ask the platform to do" is a question with an answer.

## First actions

Three:

- `push` — publishes **canonical** to the repository's recorded remote, on a
  new branch, and answers with the branch and revision. Canonical rather than
  the task's workspace: the workspace holds work that has not been integrated
  or validated, and publishing that would put the agent's version somewhere a
  reader would take for the project's. It refuses rather than forces when the
  branch already exists or the upstream has moved, and refuses with a specific
  reason when the repository has no remote or the deployment has no
  `GITHUB_TOKEN`. Pushing a branch is not a merge: it puts work where somebody
  can look at it, which is the whole of what "push to GitHub" is asking for.
- `preview_start` — runs the task's **own workspace** (see below, not canonical)
  and answers with the loopback URL, or with the boot output if it did not come
  up. Everything it needs exists: the command resolution, the dependency
  install, the detection and the log capture are all in `PreviewService`.
- `preview_stop` — because an agent that has finished looking should be able to
  free the port rather than leaving it until teardown.

That is enough for the case that prompted this. An agent asked to check its own
work starts the app, points Playwright at the URL, writes a PNG into the
repository, and commits it — and a committed image already appears in the
channel. No new bytes-transport, no protocol growth beyond the round trip
itself.

## What this does *not* do

Worth writing down, because the temptation will be to add each of these next:

- **Not a shell.** The action is a name from a list, never a command.
- **Not a way out of the workspace.** The agent's own edits are still confined
  and still enforced against its plan.
- **Not a persistence mechanism.** A preview outlives the task; nothing else
  does, and nothing here changes what a task is.
- **Not for talking to people.** `question_asked` already does that, better,
  with a deadline and a named human.

## Staging

1. **Refuse-only.** Emit the event, dispatch it, always answer `refused`. Proves
   the round trip against a real agent with no capability attached and no risk.
2. **`preview_start`**, behind a project policy flag, with the per-task cap and
   the audit events.
3. **`preview_stop`**, and only then consider whether a third action has earned
   its place. It should have to argue for itself against the rule above.

## Decided: an agent's preview is not the repository's preview

The question looked like "does a preview belong to the task or the
repository", and framed that way it is a question about surprise: an agent
restarting one would replace the preview a person is watching.

It is really a correctness question, and it answers itself. **An agent checking
its own work does not want canonical.** Its changes are in its workspace and
have not landed — a preview of canonical shows the app *without* the change the
agent just made, so the screenshot it takes is confidently wrong. A wrong
picture is worse than no picture, because it will be believed.

So there are two things sharing a name:

|            | Human preview             | Agent preview            |
| ---------- | ------------------------- | ------------------------ |
| Serves     | canonical head            | the task's own workspace |
| Scope      | per repository            | per task                 |
| Lifetime   | until stopped or idle     | dies with the task       |
| Started by | the button                | `preview_start`          |

The agent's is the simpler of the two: no idle sweep, because a task ends; no
orphan, because teardown already destroys the workspace; and no contention,
because it cannot touch the repository's. It also needs no checkout of its own
— the workspace is already there, already installed if the task installed
anything, and already contains the work being looked at.

`PreviewService` grows a second entry point rather than a flag: same process
supervision, same port allocation, same log capture, a different root and a
different key.

## Decided: the agent sees the boot output

Handing back only "started" or "failed" would leave an agent unable to fix the
one thing it is best placed to fix — its own start command, in a repository it
has just been editing. The install and server output are already captured in
`PreviewStatus.recentOutput`; `detail` carries them.

This changes the shape of `preview_start`, and the change is the interesting
part. Answering the instant the process spawns is useless: a dev server takes a
moment to bind, and everything worth reporting — a missing dependency, a port
conflict, a syntax error — happens after the spawn returns. So the action waits,
briefly and boundedly, for one of three outcomes:

- the port accepts a connection → `done`, with the URL;
- the process exits → `refused`, with the tail of its output;
- neither, within the deadline → `done`, with the URL *and* the output so far,
  because a server that is slow to start is not a failure and the agent can
  decide for itself.

That is a real behaviour difference from the button, which returns immediately
and lets a person watch. An agent cannot watch, so the wait belongs here.

## Open question

- **Cap size.** Low enough to bound abuse, high enough that an agent
  legitimately restarting after each fix is not cut off mid-task. Somewhere
  around ten feels right and it should be a policy value rather than a
  constant, but nothing here depends on the number.

## A note on why the gap was misdiagnosed

The first reading of this was "the harness collects file changes and nothing
else", which is wrong — the explanation channel carries a full report and does
it well. The real limit was never *output*. It was that an agent has no way to
ask for anything, and every capability it wants has to already be inside its own
CLI. That is a much narrower problem, and this is a much narrower feature than
"give agents every capability", which is what it would have become on the first
reading.
