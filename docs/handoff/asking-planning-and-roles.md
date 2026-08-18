# Handoff — the ask tool, the deeper /plan, and what is unverified

Written at the end of a long session. Everything below was read out of the
code or observed in a run; where I am guessing, it says so.

Deployed at `5b3d60c` on `main`. Branch `chats-channels-and-agent-sign-in`
is level with it.

## Read this first: two things are unverified

Neither is broken as far as I know. Neither has been checked.

**The control-plane image has never been built.** `control-plane.Dockerfile`
gained python3/pip/venv, build-essential, curl, wget, openssh-client, jq,
unzip, ripgrep, procps, less, plus `PIP_BREAK_SYSTEM_PACKAGES=1` and
`/home/node/.local/bin` on PATH. Docker Desktop's engine was down all
session, so no build ever ran. A bad image fails the deploy outright rather
than degrading — check the site is up before assuming anything else.

Note the PATH is *prepended* (`ENV PATH=/home/node/.local/bin:$PATH`), not
spelled out. Spelling it out drops the sbin directories, and the entrypoint
looks for `setpriv` on PATH to drop privilege — losing it does not fail the
boot, it falls through to "continuing as root". Do not "tidy" that line.

**The `/` command picker has never run in a browser.** The JS parses and the
build passes; nobody has typed `/` into the composer. Worst case the menu
does not appear and the commands still work typed in full.

## The ask tool — built, plumbing proven, judgement unproven

An agent can stop mid-execution and ask the person who asked for the work up
to six questions, each with enumerated options and one of them marked as the
agent's own recommendation. Fifteen minutes, then the task is cancelled rather
than defaulted.

The path, end to end:

1. The CLI answers with `outcome: "question_asked"` carrying either `question`
   plus `options`, or `questions` — one to six entries, each with its own
   `options` and optional `recommended`
   (`adapters/prompt-cli/src/index.ts`, `COMPLETION_JSON_SCHEMA` and
   `assertExecutionResult` — at least two options each, at most
   `MAX_AGENT_QUESTIONS` of them, enforced).
2. The adapter emits `question_asked` and blocks on a waiter with no timer
   of its own. The coordinator owns the clock; two deadlines for one wait
   would disagree about when it ended.
3. `Coordinator.answerAgentQuestion` normalises both shapes through
   `agentQuestionSet`, traces `question_asked`, calls the
   `QuestionController`, waits `questionDeadlineMs` (default 15 min), traces
   `question_answered` or `question_cancelled`, and **always** calls
   `resolveQuestion`. An adapter left blocked would die on the 60-minute
   execution timeout and report the wrong cause.
4. `ApiGateway.awaitAgentAnswer` registers the wait, posts a line into the
   thread saying what was asked — the question text, never its options — and
   pushes an `agent-questions-changed` frame at the project. It finds the
   thread through `ChannelMessage.taskId`, so it does not need the run in
   memory.
5. The web app reads `GET …/channel/questions` and opens a prompt above the
   composer: one question at a time, paged, the recommended option marked, a
   free-text box for an answer nobody offered, and Skip. It answers with
   `POST …/channel/questions/:requestId/answer`, one entry per question.

**The prompt is put to one person: whoever asked for the work.** Read through
`questionRecipient`, which is `triggeredByForTask` — the mention's sender —
and not `submittedBy`, which is the owner of the agent that took the job and
on somebody else's agent is a different person entirely. The GET lists nothing
for anybody else, and the POST refuses them.

**The options are not in the transcript.** They were, as a numbered list, and
a numbered reply still settles a single-question ask (`optionChosenBy`, which
takes a number from anywhere in the sentence and refuses anything outside the
range). A set of two or more is answered in the prompt only: a bare number
cannot say which question it belongs to, and treating it as the first would
take five decisions from somebody who typed one digit.

**Silence cancels, it does not default.** The agent asked because the choice
was not its to make; nobody answering does not hand it back. Skipping is not
silence — it is somebody deliberately handing that one decision back, and the
agent is told so in words ("you decide") rather than left to infer it.

### What is genuinely unknown

No real Claude or Gemini run has ever emitted a question. Everything is
tested against a fake agent (`AskingAgent` in `coordinator.test.ts`). Two
failure modes to watch, both prompt-wording fixes in one file
(`executionPrompt` in prompt-cli):

- **It never asks.** The instruction hedges hard — "prefer deciding and
  saying what you assumed" — so it may be too conservative.
- **It asks about trivia.** Worse, because every question holds the
  workspace and the ownership leases while other work queues behind it.

A third failure mode stopped being hypothetical and is now fenced in the
same prompt: **it offers options the platform cannot honour.** A real run
blocked on credentials offered "have the operator provision credentials to
the runner", waited out the answer, and could do nothing with it — nothing
anywhere provisions credentials on request. The prompt now requires every
option to be an action the agent itself can take in its own workspace once
the answer arrives, and tells it to fail with a precise explanation instead
of asking when the blocker needs somebody else's hands. Late answers are
also no longer silent: the gateway remembers a lapsed question per thread
and tells a "1" that arrives after the deadline exactly what happened to it
(`answerLapsedQuestion` in server.ts), which is the record the original
incident lacked.

**Do this before porting to Codex.** If the wording needs tuning, better to
find out in one adapter than to have copied it into two.

### Codex and generic-cli cannot ask

`resolveQuestion` is optional, so they are unaffected rather than broken.
The Codex port is a near-mechanical mirror — same shapes, same names, same
scope-change machinery — of about seven edits: the `QuestionAsked` variant,
the schema enum plus two optional fields, the `assertExecutionResult`
branch, `pendingQuestion` on the session, the execution-loop branch,
`createQuestionWaiter`/`resolveQuestion`, and the prompt.

One caution: Codex runs with `--output-schema` **enforcement** where Claude's
is advisory. A malformed schema there fails runs outright.

`generic-cli` speaks its own NDJSON protocol and is a design question, not a
port.

## The deeper /plan — not started, and the one trap in it

`/plan @agent do X` already works: the agent states its intent in the thread,
the task holds at `submitted`, and "go ahead" starts it. The queue does the
waiting, so a held plan costs no lease, no workspace and no clock.

What it shows is the agent's *prose*. The deeper version gates on the
**admitted plan** — declared files, symbols, grounding confidence — which is
the whole point of doing it at all.

Four touchpoints:

1. `"plan"` added to `ApprovalKind` (`packages/shared-types`).
2. **The flag has to reach the coordinator.** This is the trap. `/plan` lives
   entirely in the gateway; the coordinator has no idea a task was
   plan-gated. It needs a field on `TaskDefinition` carried through
   `SubmitTaskInput` → the store (all three backends) → `runPendingTasks` →
   `TaskDefinition`. That is the same five-hop path `context` took earlier
   today, and a field dropped at one hop compiles fine and silently never
   arrives — which is exactly how `seedContextForTask` sat unused for weeks.
3. `requireApproval(input, entry, "plan", reasons, recorder, runAudit)` after
   grounding and before `sendContext`. That helper already raises, waits, and
   refuses on rejection — the gate itself is one call.
4. The channel rendering the real plan, or step 3 buys nothing a reader can
   use.

## Also outstanding

**Map a repository when its first agent joins** — not a role, deliberately.
Trigger on `channel_agent_membership_changed` when the repository has no
handoffs yet: map it once and write that as the initial handoff, so the
first real task starts from something. Do *not* trigger on
`repository_imported`; a new repository's channel starts empty, so there is
no agent with a role to do the work and the trigger can never fire.

**Two roles survived a longer list**, and the test that killed the rest is
worth keeping: *what does the model know that a query does not?*

- **Investigator** — built and live. Reads a failed task's audit trail,
  classifies the failure, says whether a retry would help. Never retries
  itself; a person says "yes, retry".
- **Cartographer** — the mapping above.

Rejected, with reasons, so nobody re-proposes them: a planner critic (the
coordinator already grounds plans and acts on it in three places in
`plan-admission.ts`), a handoff historian (staleness is a git query, and the
reader is already a model — annotate the handoff with what changed since its
revision instead), a tech-debt groundskeeper (the auditor with a different
prompt), a cost watchdog (a threshold over numbers already recorded), and
release notes (now a query, since `canonical_promoted` carries the agent's
explanation and file list).

**Three small deterministic wins** from the same discussion, none needing an
agent: refuse an empty plan for a non-report objective (the "planned 0
file(s)" case), annotate seeded handoffs with what has changed since their
revision, and filter them by resource overlap — `findTaskHandoffs` already
supports it and is called without it.

## Working in this repository

**Two sessions share this checkout.** Commit with explicit paths, never
`git add -A` on a shared directory: a broad add swept half-finished work
from the other session into a commit of mine, and mine into one of theirs.
Check `git status` before staging, and check whether a migration number has
been taken before claiming one.

**Run suites serially** (`--concurrency=1`). Note that turbo serialises
*packages* while `node --test` still parallelises files inside one, which is
the gap the existing guidance does not cover. One wall-clock test — "partial
admission starts work that all-or-nothing arbitration would have made wait"
— fails under load and passes alone. Check attribution before debugging your
diff.

**Verify a test bites before trusting it.** Every fix this session was
checked by breaking the fix and watching the test fail with the symptom the
user reported. Twice that caught a test that passed for the wrong reason.

**There is no build marker anywhere in the API**, so a server-side deploy
cannot be confirmed from outside. Adding the commit SHA to
`/api/v1/health` would make every future deploy checkable in one request; it
was offered and not picked up.
