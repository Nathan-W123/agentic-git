# Channels as branches

**Proposal:** a channel *is* a branch. Agents coordinate inside it as they do
now. When the work is done, one button opens a pull request into canonical,
reviewed inside Kumi. Merge, then archive the channel.

## Verdict

Do it. The unit already exists — you are not inventing an object, you are
admitting what a channel already is.

Conductor's own documentation says *"create a workspace for each shippable
unit of work"* and gives it a branch. Your channels are already that: a scoped
place, with the right people and agents in it, about one thing. The difference
is what happens **inside** the unit — they run agents in it, you arbitrate
between them.

**One warning, and it is the whole design risk. It is in §5. Read that first
if you read nothing else.**

---

## 1. What it gives you

**Review gets context nobody else can offer.** A GitHub PR is a diff and a
title. A Kumi PR is a diff plus the entire conversation that produced it —
every plan that was declared, every admission decision and why, every question
the agent asked and what it was told, every conflict that was sequenced. That
is a categorically better review surface, and you get it for free because the
channel already holds it.

**A gate before main.** Right now coordinated work lands in canonical. That is
right for a small team moving fast and wrong the moment anything is risky.
A branch gives risky work somewhere to live that is *still coordinated*.

**Archive means something.** Channel done → branch merged → archive. That
already matches how people treat Slack channels.

**It composes outward.** Channel branch → canonical → GitHub main. Two gates,
both natural, neither replacing anyone's existing workflow.

---

## 2. Data model

`SubChannel` gains one nullable field:

```ts
export interface SubChannel {
  id: string;
  repositoryId: string;
  projectId: ProjectId;
  slug: string;
  name: string;
  visibility: SubChannelVisibility;
  /**
   * The branch this channel's work lands on, or absent for a channel that is
   * only a conversation.
   *
   * Absent is the default and `#general` is always absent — it maps to the
   * repository's own branch, which is the thing everything else merges into.
   * A channel that has one is a unit of shippable work; a channel that does
   * not is a place to talk.
   */
  branch?: string;
  createdAt: string;
  createdBy?: string;
}
```

That is the entire schema change. One column, one migration.

**Two kinds of channel**, distinguished by nothing more than whether `branch`
is set:

| | `#general`, `#design`, `#standup` | `#login-redirect`, `#billing-v2` |
|---|---|---|
| `branch` | absent | `kumi/login-redirect` |
| Agents can work | yes — lands on the repository's branch | yes — lands on the channel's branch |
| Create PR | no | yes |
| Archive | ordinary | on merge |

---

## 3. What changes in the coordinator

Canonical is currently one thing per repository. It becomes **one per branch**.

- A worktree is cut from the channel's branch, not from the repository's
- Integration compare-and-swaps against **that branch's** head
- Claims are scoped by `(repository, branch)` — with the exception in §5
- Salvage and repair are unchanged; they already operate against "the base I
  read", whatever that base was

Everything else about admission is untouched. Two agents in `#billing-v2`
arbitrate exactly as they do today.

---

## 4. The flow

```
  #login-redirect  ──►  branch kumi/login-redirect
        │
        │   several people, several agents, arbitrated as normal
        │   every task lands on this branch
        ▼
   [ Create pull request ]
        │
        ▼
   a Kumi PR — diff, tests, preview, and the channel's whole history:
   what each agent planned, what was admitted, what was sequenced and why
        │
        ▼
   reviewed in Kumi ──► merged into canonical
        │
        ▼
   channel archived; branch deleted
        │
        ▼
   canonical ──► GitHub main (existing push)
```

### Staleness

A channel open for two weeks is a branch two weeks behind. The coordinator
should pull canonical into the channel branch on a cadence and on demand —
using the machinery it already has, because "integrate a change against a base
that moved" is exactly what salvage and repair do.

Surface it in the channel: *"canonical moved 12 commits ahead; merged in
cleanly"* or *"…and three files need attention."*

---

## 5. The risk — read this

**Two channels are two branches. Agents in different channels stop
contending.**

That is isolation. If you do nothing else, you have rebuilt Conductor with a
nicer chat on it, and thrown away the only thing that makes Kumi different.

Concretely: `#billing-v2` changes `SessionToken.userId`. `#login-redirect`
changes `SessionToken.expiresAt`. Different branches, no Git conflict, both
merge, and the build breaks — or worse, it doesn't, and the bug ships.

### The answer: claims that cross branches

Claims split into two tiers.

| Tier | Scope | Examples |
|---|---|---|
| **Local** | `(repository, branch)` | a function body, a private helper, a file's internals |
| **Interface** | `(repository)` — **global, all branches** | exported symbols, public types, API routes, database migrations, config schema, dependency versions |

An agent claiming a *local* symbol contends only within its channel. An agent
claiming an *interface* symbol contends with **every branch in the
repository**, and admission answers across all of them.

This is not extra machinery. It is the same admission ladder with a wider
scope on one tier — and it is the beginning of the "shared decision layer"
already listed as missing.

**Without this tier, do not ship channels-as-branches.** It would be a net
loss.

---

## 6. Build order

| Stage | What | Ships |
|---|---|---|
| **1** | `SubChannel.branch`, migration, branch created with the channel | Nothing visible |
| **2** | Worktrees and integration cut from the channel's branch | Agents work on branches |
| **3** | Claims scoped by branch, **plus the interface tier** | The thing that makes it safe |
| **4** | Create PR, review surface, merge, archive | The whole loop |
| **5** | Canonical → GitHub PR | Ships to production properly |

Stage 3 is not optional and not reorderable. Stages 1–2 without it are
strictly worse than today.

---

## 7. Open questions

- **Who may open a PR?** Channel members, or `developer` and above?
- **Does merging require a human?** The auditor could approve, but "an agent
  reviewed an agent" is a weak gate for anything that reaches production.
- **What happens to in-flight tasks when a channel is archived?** Cancel,
  or block the archive?
- **Can a channel change branch?** Probably not — it would orphan its history.
- **Nested work.** A channel per feature is right. A channel per *bug fix*
  might be too many channels. Do threads inside a channel ever want their own
  branch?

---

## 8. Why this is defensible

Conductor gives each shippable unit a branch and, when it conflicts, tells you
to *"ask an agent to help resolve them."* Conflicts are handled after the
fact.

This design gives each shippable unit a branch **and arbitrates inside it, and
across the branches for anything that crosses an interface.** Fewer conflicts
reach a human, and the ones Git cannot see — two branches disagreeing about a
type — are caught before either one merges.

Same shape on the outside. Completely different thing underneath.
