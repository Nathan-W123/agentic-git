# Handoff — the auditor agent, and per-repository leave

Working notes. Everything here was read out of the code; file references are
where to start. Stage 1 is built and committed. Stages 2 and 3 are **not
started** — this is the plan for them, written before building rather than
after, so the next person is not guessing at intent.

## What an auditor is meant to be

One agent per repository, promoted by an owner, whose job is to audit without
being asked: find backend logic bugs, eventually drive the app itself looking
for places the frontend and backend disagree, post what it finds in its own
thread, hand approved findings to the agent best placed to fix them, and do
the small ones itself.

The point is the *unprompted* part. Everything else in this product runs
because somebody asked for it.

## Stage 1 — the reserved role. **Done** (`4019f8a`)

`AUDITOR_ROLE` / `isAuditorRole` in `services/api-gateway/src/server.ts`.

Every other role is free text that reaches an agent as a sentence in its
objective (`withRoleContext`) and does nothing else. `auditor` is reserved
because holding it will change what the system *does*, so:

- granting it needs `manage_project`, not the `view` the rest of that route
  needs — naming a role is collaboration, handing one the ability to spend on
  its own initiative is administration;
- one holder per repository, enforced against
  `listChannelAgentOverrides(repositoryId)`;
- re-asserting it on the current holder is a success, not a 409, because
  saving the same row again must not be an error;
- matched trimmed and lower-cased, since a reserved word that "Auditor" walks
  around is not reserved.

Two tests in `server.test.ts` cover the promotion rules and the permission
line.

**Nothing consumes the role yet.** That is the whole of what stages 2 and 3 add.

## Stage 2 — audit when canonical moves

### Trigger on the advance, not on a clock

There is **no scheduler in this codebase**. The only `setInterval`s are
websocket heartbeats (`collab-websocket.ts`, `websocket.ts`) and the channel
progress poller (`server.ts`). Do not add a cron: an auditor that wakes hourly
re-reads a repository nobody has touched and bills for it.

Trigger on canonical advancing instead. The machinery exists and is already
used twice:

- `canonicalAdvance(repositories, intelligence, repository, from, to)` in
  `apps/cli/src/worker-operations.ts` returns changed files, symbols, APIs,
  schemas, config keys, tests and services between two revisions.
- `CanonicalChangeNotice` (`packages/shared-types`) is the shape it travels in,
  and `PlanAdmission.canonicalChange` already carries one to workers.

So: remember the last revision the auditor examined, and when canonical moves
past it, audit **the diff** rather than the tree. That gives "nothing changed,
nothing to say" for free, and bounds the cost to the size of the change.

Where to hook it: `canonical_promoted` is already traced and already watched —
`watchChannelTask` streams run narration off audit events. The auditor wants
the same trigger, not a new one.

### What it costs, which is the part to get wrong carefully

Measured this session on `team-queue-wired`: a planning round is ~110k tokens,
a full task ~260k. An auditor that fires on every promotion in an active
repository is a permanent background spend that **nobody is waiting for**, so
nobody notices it. Before switching it on:

- store the last audited revision per repository, so a restart does not
  re-audit history;
- give it a budget — the project policy already has `budgets` with
  `maxProjectTokensPerDay`, and `leaseWork` already refuses work when a project
  is over it (`apps/cli/src/worker-operations.ts`). Reuse that rather than
  inventing a second accounting;
- report what it has spent somewhere a human sees, in the auditor thread
  itself.

### Its thread

Threads are lazy already (`planOpening` output is held and only written when a
run says something substantive — see the threading handoff). An audit that
finds nothing should therefore produce no thread at all, which is the correct
behaviour and needs no new code.

One thread per audit, not one per repository forever: a thread is a task in
this product, and "everything the auditor ever said" is not a task.

## Stage 3 — handing a finding to another agent

`answerThreadReply` (`server.ts`) already does most of this and is the model to
follow:

- it resolves `@mentions` in a reply against `resolveChannelMentionCandidates`,
  so `@Icarus` means the same thing in a thread as in the channel;
- it falls back to the thread's own agent when nobody is named;
- it applies the personal-visibility guard;
- `looksLikeTaskRequest(question)` decides answer-versus-work, and
  `dispatchOneMention({..., threadMessageId})` dispatches into the existing
  thread rather than opening a new one.

So an approved handoff is: the auditor posts a finding, a human replies
approving it (optionally naming an agent), and the existing reply path
dispatches it. **Check whether `looksLikeTaskRequest` fires on "yes, do it"** —
it was written for people describing work, not approving it, and an approval
that reads as a comment will silently do nothing.

Role context already travels: the objective is built as
`withRoleContext(candidate.role, ...)`, so the receiving agent is told its role
without new plumbing.

Only ever dispatch to **one** agent even if several are named — two agents
editing one repository from one sentence is a collision, not collaboration.
`answerThreadReply` already takes `answering[0]` for exactly this reason.

## Stage 4 — driving the app. Deliberately last

**Nothing like this exists**: no Playwright, no Puppeteer, no browser
dependency anywhere in the product. It also needs a deployed target, a login,
and some notion of what "correct" looks like, or it will report design choices
as bugs.

It is worth doing, because it is the only thing that catches the class of bug
where every layer reports success and the result is still wrong — this
session's GitHub import returned 201, toasted "Repository connected", and
produced an empty repository. But it should follow findings the auditor has
already earned trust with.

## Also outstanding — per-repository leave

Access held through an organization role reaches **every** repository the
organization owns, so there is no per-repository grant to give up. The leave
route says so (409 `org_membership_reaches_repository`, `server.ts`) and is
right to; the menu now offers Leave only to somebody who can leave, and Delete
to somebody who can manage the repository (`27b1b77`).

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
surprising day to day. This needs a product decision before code.

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
