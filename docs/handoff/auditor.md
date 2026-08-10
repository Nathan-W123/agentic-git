# Handoff — the auditor agent, and per-repository leave

Working notes. Everything here was read out of the code; file references are
where to start.

**Stages 1–3 are built.** The auditor audits every canonical advance without
being asked, posts what it finds in its own thread, does the small fixes
itself when approved, and hands the rest to whichever agent fits. Stage 4 —
driving the running app in a browser — is deliberately not started; see below
for what it needs.

The plan for stages 2 and 3 was written before they were built, and the
sections below have been rewritten to say what the code does rather than what
it was going to do. Where building it changed the plan, the section says so.

## What an auditor is meant to be

One agent per repository, promoted by an owner, whose job is to audit without
being asked: find backend logic bugs, eventually drive the app itself looking
for places the frontend and backend disagree, post what it finds in its own
thread, hand approved findings to the agent best placed to fix them, and do
the small ones itself.

The point is the *unprompted* part. Everything else in this product runs
because somebody asked for it — which is also where all four of the open
questions below come from.

## Stage 1 — the reserved role. **Done** (`4019f8a`)

`AUDITOR_ROLE` / `isAuditorRole` in `services/api-gateway/src/server.ts:204`.

Every other role is free text that reaches an agent as a sentence in its
objective (`withRoleContext`) and does nothing else. `auditor` is reserved
because holding it will change what the system *does*, so:

- granting it needs `manage_project`, not the `view` the rest of that route
  needs — naming a role is collaboration, handing one the ability to spend on
  its own initiative is administration;
- one holder per repository, enforced against
  `listChannelAgentOverrides(repositoryId)`;
- re-asserting it on the current holder is a success, not a 409 (the
  `heldBy !== agentId` term in the holder search), because saving the same row
  again must not be an error;
- matched trimmed and lower-cased, since a reserved word that "Auditor" walks
  around is not reserved.

A fourth rule was added when the rest was built:

- **the holder must be an org-wide agent.** `dispatchOneMention` submits every
  task with `actorId: candidate.userId`, so an audit runs on its holder's own
  account. For an @mention that is fair — someone named the agent. Nobody
  names an auditor: it spends continuously, forever, and promotion needs only
  `manage_project`, so without this an admin could commit a colleague's
  personal subscription to a permanent background cost they never agreed to
  and would discover on a bill. An org-wide credential is one its owner has
  already published as spendable by other people's requests; that is the
  consent this needs, and it already exists. Enforced at promotion
  (`auditor_must_be_org_wide`) and re-checked at audit time, because a
  credential can be made personal again afterwards.

Three tests in `server.test.ts` cover it: *"auditor is a reserved role:
owner-only, and one to a repository"*, *"a collaborator cannot promote an
auditor, but can still set a plain role"*, and *"a personal agent cannot be
made auditor, an org-wide one can"*.

## Stage 2 — audit when canonical moves. **Done**

`startAuditorWatch` / `pumpAuditor` / `auditCanonicalAdvance` / `runAudit` in
`server.ts`; the pure half is `services/api-gateway/src/auditor.ts`.

### Trigger on the advance, not on a clock

There is **no scheduler in this codebase**. Every `setInterval` in the product
is a heartbeat or a short-lived poller: `apps/worker/src/worker.ts:317`,
`services/coordinator/src/coordinator.ts:206` (ownership),
`collab-websocket.ts:215` and `websocket.ts:168` (socket keepalive), and
`server.ts:6309` (the channel progress poller, 2 s, which stops itself when
nothing is being watched). Do not add a cron: an auditor that wakes hourly
re-reads a repository nobody has touched and bills for it.

Trigger on canonical advancing instead. `pumpAuditor` polls
`listAuditEvents({ types: ["canonical_promoted"], afterSequence })` every 15
seconds — far slower than the 2 s channel progress poller, because nobody is
waiting on an audit.

Two things had to be fixed before that worked, and both are worth knowing:

1. **`canonical_promoted` did not carry `repositoryId`.** It stamped
   `projectId`, `previousRevision`, `revision` and `changeSetId` only, and
   `AuditEventFilter` has no repository term either. An auditor is
   per-repository, so there was no way from the event to the place. Now
   stamped at `worker-operations.ts:2763` from `task.repositoryId`, which was
   already in scope — the same field `changeset_collected` two hundred lines
   up had been stamping all along.
2. **`watchChannelTask` was not reusable.** It filters by `taskId`, is only
   started by a channel dispatch, and deletes itself on the terminal event.
   The auditor got its own watcher in the same shape rather than an attempt to
   share that one.

**The anchor is a timestamp, not a sequence, and this is the subtle part.**
`listAuditEvents` pages *forward* from the oldest match, so a first call with
`limit` and no `afterSequence` returns the repository's **earliest**
promotions, not its latest. Anchoring on that would have made every restart
audit the entire history of the repository from the beginning — unbounded
spend, on someone's account, silently. So an unanchored poll filters on
`occurredAfter: <process start>` instead, and only adopts a sequence once it
has seen a real event.

### Where the cursor lives

A dedicated `auditor_cursors` row per repository (migration 22, both SQLite
and Postgres), holding both the last audited revision and the last consumed
log sequence. Not on the override row: that is configuration a human edits,
and this is run state written on every promotion.

Both positions are stored because they answer different questions. The
sequence makes the poll idempotent across a restart; the revision is the diff
base. Keyed on the repository alone rather than on (repository, agent), so
that changing who holds the role does not restart the audit history from zero
and re-report everything on the new holder's account.

**The diff base is the last revision actually audited, not the event's
`previousRevision`.** That is what makes a missed event harmless: a promotion
that landed while the process was down, or while an earlier audit was still
running, falls inside the next audit's range instead of being skipped.
Downtime defers an audit; it never loses one.

### What it costs, which is the part to get wrong carefully

Measured this session on `team-queue-wired`: a planning round is ~110k tokens,
a full task ~260k. An auditor that fires on every promotion in an active
repository is a permanent background spend that **nobody is waiting for**, so
nobody notices it. What holds it down:

- the diff, not the tree, so cost tracks the size of the change;
- `diffBetween` (`repository-service.ts`) truncates at 200 KB, and the prompt
  tells the auditor when it is reading a partial change so it says so rather
  than reporting the unseen half as absent;
- `projectOverTokenBudget` checks the project's `maxProjectTokensPerDay` over
  the same 24-hour `listTokenUsage` window `leaseWork` uses. **The check has
  to be here and not left to `leaseWork`**: an over-budget project stops being
  handed to workers, but the audit is a chat completion rather than a leased
  task, so nothing downstream would have refused it;
- one audit per repository at a time (`auditsRunning`). A second promotion
  arriving mid-audit is skipped rather than queued, because the next audit's
  range will cover it anyway.

Still outstanding: **the auditor does not report what it has spent.** The
handoff argued it should, in its own thread, and that is still right —
`listTokenUsage({ projectId, recordedAfter })` is the source. Unbuilt.

### The off switch

An auditor on a busy repository costs a model call per merge, and the answer
to "this is too expensive this week" should not be to demote the agent and
lose its place. So auditing switches off per repository —
`POST .../repositories/:id/auditor` with `{paused}`, `manage_project`, drawn as
a toggle on the auditor's roster row and nowhere else.

**Pausing keeps the cursor, and that is the whole difference between pausing
and demoting.** Merges that land while it is off are not audited *and not
skipped*: they sit in the gap. Switching back on audits that gap immediately —
last audited revision to current head, in one range — rather than waiting for
the next merge. That is the only audit triggered by a person rather than a
promotion, and so the only one that has to ask where canonical stands, which
is what `canonicalHead` exists for.

Resuming reports which of three things happened, because "on" and "on, and it
is spending right now" are different things to tell somebody: `audited`,
`nothing_to_audit`, or `unavailable`. An auditor that has never completed an
audit anchors at head rather than reading the whole repository — auditing an
entire codebase is an unbounded cost nobody asked for by flicking a switch.

A repository with no cursor row is **not** paused. Auditing is on from the
moment an agent is promoted, and absence means nothing has said otherwise.

### Its thread

An audit that finds nothing **posts nothing at all** — no message, no thread.
This is deliberate and it is the single most important piece of restraint in
the feature: an auditor that says "all clear" after every merge is one
everybody mutes, and a muted auditor is worse than none, because the one time
it finds something real it is in a channel people have already learned to
skip. Covered by the test *"a clean audit says nothing at all"*.

When it does find something: one channel message summarising the audit, one
threaded reply per finding, numbered. One thread per audit, not one per
repository forever — a thread is a task in this product, and "everything the
auditor ever said" is not a task.

### Why the audit is a chat completion and not a task

This was the plan's biggest wrong assumption, and it is worth recording.

An audit is read-only. The task pipeline exists to land changes, and a task
that deliberately writes nothing comes back from the integration service as
`status: "empty"` — which `worker-operations.ts` records as a **failed** task.
A clean audit is the commonest outcome there is, and it must not look like a
failure in the task list.

So the audit runs through `askAgent`, the same provider-chat path
`planOpening` uses. The consequence is that **the diff has to travel in the
prompt**: the vendor CLIs run in an empty scratch directory
(`completeViaClaudeCli` in `apps/web/src/providers.ts`) and cannot read the
repository. Hence `canonicalDiff` as an optional gateway operation, and hence
the truncation budget. The gateway has no repository paths and should not
acquire any; every other thing it knows about a repository's contents arrives
as an operation too.

A gateway with no `canonicalDiff` never starts the watcher at all. An auditor
that cannot see a change must not run and quietly report the repository clean.

## Stage 3 — handing a finding to another agent. **Done**

`dispatchApprovedFindings` and `bestFitFor` in `server.ts`, called from
`answerThreadReply` before its ordinary answer-versus-work split.

`answerThreadReply` (`server.ts`) already did most of this and was the model
followed:

- it resolves `@mentions` in a reply against `resolveChannelMentionCandidates`,
  so `@Icarus` means the same thing in a thread as in the channel — matched as
  `question.includes("@" + name)`, so the name must be written exactly;
- it falls back to the thread's own agent when nobody is named;
- it applies the personal-visibility guard;
- `looksLikeTaskRequest(question)` decides answer-versus-work, and
  `dispatchOneMention({..., threadMessageId})` dispatches into the existing
  thread rather than opening a new one.

So an approved handoff is: the auditor posts a finding, a human replies
approving it (optionally naming an agent), and the existing reply path
dispatches it.

### The approval wording problem — real, and fixed

`looksLikeTaskRequest("yes, do it")` returns **false**. It is not stopped by
`ACK_ONLY_RE` (that only matches a bare "yes"), it fails at `TASK_VERB_RE` — a
concrete build/change/fix word list containing `fix`, `add`, `investigate`,
`patch`, `review` and forty others, but not `do`.

The consequence was worse than nothing happening. Falling through
`looksLikeTaskRequest` does not mean silence — it means `answerAsAgent`, so
the auditor would **reply in chat about its own finding** and the fix would
never be dispatched. It reads exactly like it worked.

Fixed with `readsAsApproval` in `auditor.ts`, applied **only** to replies
whose thread root is authored by the repository's auditor. Scoping matters: in
an ordinary channel "sure" and "go ahead" are conversation, but in an auditor
thread they are the entire approval mechanism, because the work is already
written down in the message being replied to and the reply does not have to
restate it. `TASK_VERB_RE` was deliberately **not** widened — "do" in a
channel message is a coin flip.

Rejections are checked first and allowed to win, so "yes, but not now" and
"ok, skip it" dispatch nothing. Doing nothing is recoverable by saying so
again; spending someone's account on work they just declined is not.

`findingsReferencedBy` resolves *which* finding: "all", explicit numbers
("yes, fix 2", "1 and 3"), or a bare approval when there is exactly one
finding on the table. A bare approval against several findings is ambiguous
and the auditor asks which rather than guessing.

### Who the work goes to, and who pays

Assignment, in order of how strong the evidence is:

1. **an agent named in the reply** — unambiguous, so it wins;
2. **the auditor itself**, when the finding is marked `selffix: yes`. This is
   the "handle the small ones yourself" case. It is the auditor's own claim,
   made in the audit before anybody approved anything, so it cannot be shaped
   to grab work after the fact;
3. **the best fit by role and recent work**, scored with the same
   `scoreCandidate` the no-mention auto-claim path uses — one question, one
   answer, so a finding and an identically worded channel message cannot land
   on different agents. Unlike auto-claim there is no minimum score and no
   margin: a person has already approved the work, so the only open question
   is who, and the fallback is the auditor rather than silence.

Role context travels: the objective is built as
`withRoleContext(candidate.role, ...)`, so the receiving agent is told its
role without new plumbing, and `fixObjectiveFor` writes the finding as a
self-contained instruction with its file list — the agent that fixes it is not
the agent that found it and has none of its context.

`dispatchOneMention` submits with `actorId: candidate.userId` — **the agent's
owner pays, never the sender** — under a new `trigger: "audit_fix"` alongside
`"mention"` and `"auto_claim"`, so the audit trail can tell unprompted spend
from asked-for spend.

The personal-visibility guard is applied to the assignee: an approval is not
consent to spend a stranger's subscription.

## Stage 4 — driving the app. Not started, deliberately

**Nothing like this exists**: no Playwright, no Puppeteer, no browser
dependency anywhere in the product — and the dependency tree is nearly bare
(`pg`, `monaco-editor`, `typescript`, two wordlists), so this would be the
first heavy one. It also needs a per-repository "how to build, start and log
into this app" configuration, which does not exist either, plus some notion of
what "correct" looks like, or it will report design choices as bugs.

It is worth doing, because it is the only thing that catches the class of bug
where every layer reports success and the result is still wrong — this
session's GitHub import returned 201, toasted "Repository connected", and
produced an empty repository. But it should follow findings the auditor has
already earned trust with.

**What stands in for it today:** the audit prompt asks explicitly for places
the frontend and backend disagree that are readable from the diff — a route,
request shape, response field, status code or error code changed on one side
and not the other; a client reading a field the server no longer sends. That
catches a real share of the same class statically, for no dependency and no
running app. It does not catch anything that only appears when the thing is
actually running, which is the half a browser is for.

## Open questions — what is left

Resolved while building: **who pays** (org-wide agents only, enforced at
promotion and re-checked at audit time), **the audit's trigger identity**
(`trigger: "audit_fix"`, distinct from `"mention"` and `"auto_claim"`), and
**the approval wording** (`readsAsApproval`, scoped to auditor threads).

Still open:

1. **Does the auditor audit its own fixes?** It does, today. An approved fix
   promotes canonical like any other task, which re-triggers the auditor on
   its own work. This cannot run away — every fix is gated on a human
   approval, so the loop cannot close without a person in it — and reviewing
   the fix is arguably the right behaviour. But it is the auditor marking its
   own homework, and a second opinion would be better. Skipping advances whose
   task the auditor itself submitted needs the task's `agentId` at the trigger
   point, which the event does not carry.
2. **It does not report what it has spent.** Argued for above and still
   unbuilt.
3. **Discoverability is a `<datalist>`, not a design.** The role field is
   still free text — every other role is prose that reaches the agent as a
   sentence, so there is nothing to offer — but `auditor` is now offered as
   the one option, described as "Audits every merge, unprompted". That is
   enough for someone to find the word without being told it exists. It is
   not enough to explain what holding it costs; the toggle's tooltip is
   currently the only place that is said.

## Also outstanding — per-repository leave

Access held through an organization role reaches **every** repository the
organization owns, so there is no per-repository grant to give up. The leave
route says so (409 `org_membership_reaches_repository`, `server.ts:3327`) and
is right to; the menu now offers Leave only to somebody who can leave, and
Delete to somebody who can manage the repository (`27b1b77`).

Making "leave this one repository" work for an org-role holder is a **data
model change, not a UI one**, and there are two honest options:

1. **Exclusions.** A row saying "this user does not see this repository",
   consulted by `authorizeRepository` alongside grants. Cheap, and it inverts
   the model's grain — every access check gains a deny-list lookup, and a
   deny-list that outlives a role change is a bug factory.
2. **Convert on leave.** When an org-role holder leaves one repository,
   materialise explicit grants on every *other* repository and drop the org
   role. Honest — afterwards their access is exactly what it appears to be —
   but it silently changes what happens to repositories created later, which
   they would no longer get automatically.

Neither is obviously right. (2) matches the model better; (1) is less
surprising day to day. This needs a product decision before code. Doing
nothing is also defensible: the 409 explains itself and names both real
remedies, which is more than most refusals manage.

## Where the code is

| Piece | Where |
| --- | --- |
| Role, prompt, findings parsing, approval reading | `services/api-gateway/src/auditor.ts` |
| Watcher, audit run, thread, approval dispatch | `services/api-gateway/src/server.ts` |
| `repositoryId` on the promotion event | `apps/cli/src/worker-operations.ts` |
| Cursor row and migration 22 | `services/persistence/src/{store,memory-store,sqlite-store,postgres-store,schema,postgres-schema}.ts` |
| Bounded diff read | `services/repository-service/src/repository-service.ts` (`diffBetween`) |
| `canonicalDiff` / `canonicalHead` operations | contract in `server.ts`, implementations in `apps/web/src/index.ts` |
| Off switch: route + resume | `server.ts` (`auditorSwitchMatch`, `resumeAuditing`) |
| Off switch: toggle, role picker | `apps/web/public/{screen-chats,app,data}.js`, `styles.css` |
| Tests | `auditor.test.ts` (17, pure) and `server.test.ts` (10, over HTTP) |

## Verifying any of this

The scratch instance **cannot exercise the roster**: it uses the host's shared
CLI login, so `connectionsFor` returns nothing, the roster is empty, and no
mention resolves. Auditor promotion is reachable (it is an override route), but
dispatch and thread behaviour need a deployment where people have signed in per
user.

Local boot:

```
COORD_BOOTSTRAP_TOKEN=dev-bootstrap-token-relay-2026 COORD_PORT=4799 \
  node <repo>/apps/web/dist/index.js --root=.
```

from `C:\Users\nward\AppData\Local\Temp\relay-ui-verify`
(owner@example.com / relay-dev-owner-2026!A).

Two traps that cost time this session:

- **Static assets load once, at boot.** Editing `public/` and reloading the
  browser shows the old file. Restart the server.
- **A stale server keeps serving stale assets.** Several were left listening on
  4733–4760 from earlier restarts, and a fix verified in the repository was
  absent in the browser because the tab was pointed at one of them. Check the
  port before concluding a fix did not work: `netstat -ano | grep LISTENING`.

Most of the auditor needs none of that, though. `server.test.ts` drives the
whole loop over real HTTP against an in-memory store: promote an agent, append
a `canonical_promoted` event, and the watcher audits, posts, and dispatches on
approval — with `auditorPollIntervalMs` set to 20 ms so a test does not wait
out the 15-second production cadence. The fixture's `canonicalDiff` and
`complete` are fakes, so what is *not* covered end-to-end is the only part
that needs a real deployment: whether a real model, given a real diff, returns
findings in the format `parseAuditFindings` expects. The parser is deliberately
lenient about that — an unparseable non-empty reply is kept whole as a single
finding rather than dropped — but the first live audit is still the thing to
watch, and the prompt is the thing to tune.
