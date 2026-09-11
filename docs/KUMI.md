# Kumi

**Multiplayer agentic coding.** Several people, each running several AI coding
agents, against one shared repository — without the agents destroying each
other's work.

This document is the whole picture: what it is, what it does, how it works,
and what is still missing. It is written for somebody joining the project, not
for somebody who already knows it.

---

## 1. The problem

Every coding agent today is single-player. You run Claude Code or Codex in your
terminal, it edits your files, you review the diff. Fine alone.

Now put three people on one repository, each running two agents:

- Your Claude is rewriting authentication.
- My Codex starts a billing feature.
- Her Cursor agent refactors user sessions.

Nothing here produces a Git merge conflict. Git compares text. But my agent
changed an API assumption yours relies on, hers renamed a type yours is about
to reference, and two of them independently invented competing abstractions for
the same thing. Everybody's tests pass. The integration is broken.

The usual answer is **isolation** — give every agent its own Git worktree, let
them work in parallel, merge later. That does not solve the problem, it
*defers* it. The conflict still happens; it happens at merge time, after all
the work is done, when it is most expensive to unpick.

**Kumi's premise: the coordination has to happen before the work, not after
it.**

---

## 2. What Kumi actually is

A **coordination layer** that sits between every developer and every coding
agent working on a repository.

It is not a coding agent. It does not compete with Claude Code, Codex or
Cursor — it runs them. It knows what every agent *intends* to change, decides
which of those intents can safely proceed at the same time, sequences the ones
that cannot, and owns the merge into canonical.

The interface is a chat — channels, threads, @mentions — because coordination
between people and agents is a conversation. But the chat is the surface. The
coordinator is the product.

### The one-line version

> Everyone can code in parallel. Kumi keeps the work compatible.

### What makes it different

Three things, together, and the combination appears to be unoccupied:

1. **Cross-machine.** Agents run on *people's own laptops*, on their own vendor
   subscriptions. Not in a cloud sandbox.
2. **Enforced arbitration.** Not advice, not a warning, not a report. An agent
   whose plan is refused does not run.
3. **It owns integration.** Kumi merges into canonical itself, with a
   compare-and-swap against the exact base the agent read.

Competitors have one or two of these. Isolation-based tools (Conductor,
Emdash, Vibe Kanban, Claude Squad) give each agent a room and merge later.
Symbol-locking tools are single-machine and advisory.

---

## 3. How a task flows, end to end

```
  somebody types "@Odysseus fix the login redirect" in a channel
                              │
                              ▼
     the mention resolves to an agent, and the agent to its owner
                              │
                              ▼
       is that owner's machine online and running this vendor?
              no ──► ask: queue it / send to someone online / cancel
              yes │
                  ▼
         a task is filed; the owner's worker leases it
                              │
                              ▼
         PLAN — the agent reads the repository and declares
                what it intends to touch
                              │
                              ▼
        ADMISSION — the coordinator decides, against every
                    other plan currently in flight
                              │
      ┌────────────┬──────────┴──────────┬─────────────┐
      ▼            ▼                     ▼             ▼
  approved   approved_with_          sequenced      blocked
             constraints          (wait for that   (replan)
          (proceed, minus         other task)
           these resources)
                              │
                              ▼
          EXECUTE — the agent works in its own worktree
                              │
                              ▼
        INTEGRATE — compare-and-swap against the exact base
                    it read; on a stale base, salvage what
                    still applies and repair once
                              │
                              ▼
                        canonical
```

### Task states

`queued` → `planning` → `awaiting_approval` → `running` → `integrated`

with `blocked`, `failed` and `cancelled` as the other exits.

---

## 4. The coordinator — the actual core

### Claims

Before an agent writes anything, it declares a **claim**: what it expects to
touch. Claims come in kinds, in increasing precision:

| Kind | Means |
|---|---|
| `blanket` | "I don't know yet" — held only until the plan resolves |
| `declared` | The paths the plan named |
| `file` | Specific files |
| `symbol` | Specific declarations inside a file |
| `frozen` | Pinned; will not narrow further |
| `question` | Reading only, answering something |

**The granularity ladder** is the point:

```
whole plan → declared paths → files → symbols → hunks
```

A claim starts coarse and narrows as the agent's intent becomes concrete. Two
agents wanting "the auth module" collide. Two agents wanting `refreshToken()`
and `validateSession()` — same file, different declarations — do not. Kumi
admits both.

That is what "symbol-level concurrency control" means, and it is why two agents
can safely edit one file at the same time. Whole-file locking would discard one
of them.

**Blanket narrowing.** A first agent that arrives with a blanket claim is asked
to narrow it the moment a second agent shows up with a concrete plan — rather
than the second being blocked on a claim the first never actually needed.

**Dynamic release.** Files come back to the pool *during* a run, as soon as the
agent is done with them, not when the whole task finishes.

### Ownership modes

Per resource, what concurrent access means:

| Mode | Behaviour |
|---|---|
| `exclusive` | One agent at a time |
| `shared` | Concurrent edits allowed (markdown, text) |
| `observe` | Readable, not writable |
| `approval_required` | A human decides |

### Admission outcomes

- **`approved`** — proceed
- **`approved_with_constraints`** — proceed, but these resources are deferred;
  do the rest now. *Partial admission is an approval, not a refusal.*
- **`sequenced`** — a real dependency; wait for the other task, then go
- **`blocked`** — replan

Blocked is deliberately rare and bounded: `BLOCKED_ATTEMPTS_BEFORE_SEQUENCING`
is 2, and a task may be blocked at most 4 times in its life before the system
stops and asks a human.

### Integration

Every change carries the exact revision it was written against.
Integration is a **compare-and-swap**: if canonical moved, the write is
refused rather than merged.

On refusal Kumi does not simply fail. It **salvages** the parts of the change
that still apply cleanly, and gives the agent **one** repair attempt against
the new base. One, not a loop — an agent that cannot land a change twice is
telling you something.

---

## 5. Execution model — local, by design

**Agents run on people's own machines.** The control plane never starts an
agent process. `COORD_LOCAL_AGENTS_ONLY=1` is permanent.

Why:

- **Cost.** RAM was ~70% of the hosting bill when execution was server-side.
- **Credentials.** Everyone uses their own Claude/Codex/Cursor subscription.
  Kumi is not reselling inference.
- **Trust.** Your code is on your machine.

### How it works

A **worker** runs inside the desktop app. It:

1. registers with the control plane, advertising which vendor CLIs this
   machine actually has installed
2. polls for work its owner is entitled to run
3. clones into an isolated worktree, runs the agent CLI, collects the changeset
4. reports back

Six vendors are supported today:

| Provider | CLI |
|---|---|
| `anthropic` | Claude Code |
| `openai` | Codex |
| `google` | Gemini |
| `cursor` | Cursor |
| `copilot` | GitHub Copilot |
| `kiro` | Kiro |

An agent is **live** — the green dot — only when its *owner's* machine is
polling and advertising that agent's vendor. Per adapter, not per person: a
machine with Claude but no Codex makes Claude agents green and Codex agents
grey.

---

## 6. The product surface

### Channels and threads

Slack-shaped, deliberately. A repository has channels; @mentioning an agent
files a task and opens a thread; the agent narrates itself there as it works.
Anyone in the channel can watch, cut in mid-run, redirect it, or hand it to
somebody else.

This is the part that makes it multiplayer rather than a task queue with a UI.

### Work channels — a channel that is a branch

A channel can be opened as a *work channel*, and then it **is** a branch.
Tick "Work on a branch" when you create it and Kumi cuts `kumi/<name>`; every
task dispatched in that room lands there instead of on the repository's own
branch. The room's own branch icon opens a review — how far ahead it is, what
changed, what conflicts — and one button merges it.

Two gates, in order:

1. **Kumi reviews the branch into the repository.** The diff, the
   conversation and the tasks that produced it are all in one room, so the
   review happens where the work happened. A conflict refuses rather than
   resolving: a merge that needs a person is a merge a person should do.
2. **GitHub reviews the repository into main.** Merged channels offer a
   second button that pushes canonical to the channel's own branch on GitHub
   and opens a pull request — under *your* GitHub account, not a bot's.

Merging closes the room. Its branch is gone, so anything said there would be
dispatched against a branch nothing can check out.

**What makes this different from a worktree tool.** Two channels are two
branches, and if that were the end of it, agents in different channels would
simply stop contending — isolation, which is worse than having no branches at
all. `#billing` changes `SessionToken.userId`, `#login` changes
`SessionToken.expiresAt`, neither conflicts in Git, both merge, the build
breaks.

So a claim has two tiers. What is **local** to a branch — a private helper, a
file's internals, a test — contends only inside it, and Git arbitrates the
rest. What crosses between them — **exported symbols, API routes, schemas,
config keys, dependency manifests, migrations** — contends across every
branch in the repository, on the same admission ladder with a wider scope.
The indexer records which declarations actually leave their file, so this is
a fact about the code rather than a guess. Conflicts Git cannot see are
caught before either branch merges.

### Human control

- **`/stop`, `/cancel`** — scoped to one agent's own tasks
- Cut in mid-run with a new instruction
- `approval_required` resources hold for a human decision
- Agents ask questions in-thread and wait for answers

### Repository operations

- Import from GitHub, push, pull
- Per-user GitHub credentials — pushes are attributed to the person, not a bot
- Preview: run the app from a workspace, with its own port
- Code view, diffs, changesets

### Review

An **auditor** agent reviews changes automatically. Pausable per channel.

### Other surfaces

- **Web app** — the main interface
- **Desktop app** (Electron, Mac/Windows/Linux) — hosts the worker; this is
  what actually runs agents
- **Mobile** — read threads, answer questions, approve
- **CLI**
- **MCP, both directions** (see below)

---

## 7. MCP — both directions

### Kumi as an MCP server

Add one line to Claude Code or Codex, then type *"have Kumi fix the login
redirect"* in your editor. It lands in a Kumi channel thread, gets coordinated
like anything else, and runs.

Eleven tools. Five to file and follow work — `list_repositories`, `submit_task`,
`task_status`, `cancel_task`, `answer_question`; two for the repository's
standing context, the note every agent planning there is handed —
`get_repository_context`, `set_repository_context`; and four for an editor
doing the work itself — `take_task`, `report_task`, `extend_task`,
`task_progress`.

Hand-rolled JSON-RPC 2.0 — no SDK dependency.

### Agents using MCP servers

A workspace configures MCP servers once; every task on every machine gets those
tools. Two-step approval, secrets sealed with the same cipher as vendor
credentials, and — critically — **machine-owner consent**: the project decides
what is *offered*, the laptop decides what actually *runs*.

---

## 8. Architecture

**19 packages**, TypeScript, Turborepo. ~178,000 lines of source.

```
apps/
  web          the browser interface (plain ES modules, no bundler)
  desktop      Electron; hosts the worker
  worker       leases tasks, runs agent CLIs, reports changesets
  cli

services/
  api-gateway         HTTP + WebSocket; auth, routing, channels, MCP
  coordinator         admission, claims, arbitration
  workspace-manager   worktrees, isolation, changeset collection
  persistence         two interchangeable stores
  repository-service  git
  code-intelligence   symbol indexing
  integration-service canonical merge

packages/
  shared-types, agent-protocol, collab,
  intent-analysis, local-triage

adapters/
  codex, prompt-cli, generic-cli
```

### Persistence

Two implementations — **SQLite** (`:memory:` for tests and the in-process
default) and **Postgres** — behind one interface, verified by a shared
contract test suite run against both. **67 forward migrations.**

### Tenancy

```
organization  ← the team, the billing account, the boundary
  └ project
      └ repository  ← channels hang off these
```

Access is either an **organization membership** (reaches everything) or a
**repository grant** (reaches exactly one). Roles: `viewer`, `developer`,
`admin`, `owner`. `developer` and above can run agents.

> **Known wart:** the UI calls all three layers "workspace", which has caused
> real confusion. See §10.

### Quality

**2,882 automated tests.** Build and typecheck clean across all 19 packages.
`strict`, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`.

The house rule: **sabotage a test before trusting it.** Break the code the test
covers, confirm the test fails for the right reason and only that reason, then
restore. A test that passes against broken code is worse than no test.

---

## 9. Security posture

- Agents run on member machines under their own accounts — the control plane
  never executes agent code
- Vendor credentials are per-user, encrypted at rest, and selected by the
  *mentioned agent's owner*
- Repository grants narrow what a machine can be handed, enforced at lease time
  and re-checked on the way out
- Audit chain over admissions, integrations and configuration changes
- MCP servers need project approval *and* machine-owner consent
- A worker only ever runs what its owner is entitled to run

**Stated plainly:** an approved MCP server is an arbitrary process, chosen by a
project admin, running on a teammate's laptop under their account. There is no
egress containment on that path. The consent gate is the control.

---

## 10. What is missing — read this part

Honest list. Nothing here is hidden.

### Real gaps

- **No shared decision layer.** Kumi arbitrates over *artifacts* — files,
  symbols, hunks. It does not arbitrate over *decisions*. Two agents can edit
  completely different files while one decides `User.id` is a number and the
  other decides it is a UUID. No symbol lock catches that. This is the sharpest
  known hole.
- **No runtime isolation.** Worktrees isolate code. They do not isolate ports,
  databases, dev servers, migrations, test fixtures or cloud resources. Agents
  still collide there.
- **No plan-drift detection.** A plan is admitted, then narrowed on arrival —
  but execution is not continuously checked against the declared footprint. An
  agent that says it will touch `auth.ts` and then touches `database.ts` is not
  caught mid-run.
- **No cross-repo coordination.**
- **No attention queue.** There is no "Needs you: 2". With several agents
  running, the human becomes the bottleneck and nothing surfaces what actually
  needs a decision.
- **No prepared review.** You get diffs and changesets, not a briefing.

### Smaller known issues

- Every worker start registers **twice**; `registerWorker` never upserts and
  nothing deletes, so that table only grows
- A task is only logged when it *finishes* — a run in progress is invisible
- Three layers share the word "workspace" in the UI
- Missing spellcheck dictionary in the Windows package (cosmetic, noisy)

### Deployment configuration

Not code — someone has to set these:

```
KUMI_PAYMENTS_ENABLED     off unless you are actually charging
STRIPE_SECRET_KEY / STRIPE_PRICE_ID / STRIPE_WEBHOOK_SECRET
KUMI_APP_URL
COORD_MAIL_API_URL / COORD_MAIL_API_KEY / COORD_MAIL_FROM
COORD_LOCAL_AGENTS_ONLY=1   permanent
COORD_ORGANIZATION          per machine; overrides discovery
```

> **Watch this one:** with payments enabled and no subscription row, every role
> in an organization folds to `viewer` — including `owner`. The deployment's
> system administrator is exempt, so the person most likely to be testing is
> the one person who cannot see it happening.

---

## 11. Vocabulary

| Term | Meaning |
|---|---|
| **Canonical** | The real repository; the thing everyone integrates into |
| **Claim** | What an agent has declared it intends to touch |
| **Admission** | The decision to let a plan proceed, and on what terms |
| **Arbitration** | Deciding between competing claims |
| **Lease** | A worker's hold on a task while it runs |
| **Worker** | The process inside the desktop app that runs agents |
| **Changeset** | What an agent produced, plus the base it was written against |
| **Salvage** | Keeping the parts of a rejected change that still apply |
| **Sequenced** | Not refused — ordered after something else |
| **Live** | This agent's owner has a machine polling and running its vendor |

---

## 12. Where to start reading

| To understand | Read |
|---|---|
| Admission and claims | `apps/cli/src/lease-admission.ts` |
| The lease protocol | `services/api-gateway/src/routes/workers.ts` |
| Authorization | `services/api-gateway/src/authorization.ts` |
| Worktrees and changesets | `services/workspace-manager/src/index.ts` |
| Running an agent | `apps/worker/src/worker.ts` |
| The desktop's worker | `apps/desktop/electron/worker.mjs` |
| Channels and dispatch | `services/api-gateway/src/routes/messages.ts` |
| The data model | `services/persistence/src/store.ts` |

Build: `npx turbo run build` · Test: `node --test <package>/dist/*.test.js`

The code is commented unusually heavily, and the comments explain *why* rather
than *what* — often naming the specific bug a line exists to prevent. They are
worth reading; several would have saved a day each.
