# Handoff — channel threading (items 2–4) and agent code names

Working notes for in-flight work on the Chats screen. Everything below was
read out of the code, not remembered; file references are the places to start.

## Where things are

- Channel/thread server logic: `services/api-gateway/src/server.ts`
- Browser modules: `apps/web/public/*.js` — **shipped verbatim, never compiled
  or typechecked.** `scripts/check-public-syntax.mjs` (wired into
  `@coord/web`'s `typecheck`) parses them; a duplicate `export function` once
  passed every build and rendered a blank page in production.
- Chats screen: `apps/web/public/screen-chats.js`; state and API calls:
  `apps/web/public/data.js`; event/action routing: `apps/web/public/app.js`

## Current behaviour, verified

A thread is **a task**, not a topic. The code says so: *"the channel keeps one
line per request rather than a running commentary."*

1. `@mention` in a channel message → `dispatchChannelMentions`, called **only**
   from the channel messages POST route. Replies never reach it.
2. The agent posts an **acknowledgement** message immediately; that message is
   the thread root. `authorId` is `` `${candidate.userId}:${candidate.provider}` ``.
3. `Task: <title>` plus the opening reasoning go in as replies, then
   `watchChannelTask` streams the run's narration into the same thread via
   `messageId: acknowledgement.id`.
4. A person replying in a thread is answered by `answerThreadReply`. **It
   already passes the thread so far as context** — item 1 on the original list
   is therefore essentially done. The agent is derived from the root's
   `authorId`; there is no mention routing, so it is always *that* agent.

Consequences worth holding on to:

- `appendChannelThreadReply` takes an arbitrary `authorId`, so several agents
  in one thread is a **dispatch-routing** problem, not a storage one.
- The objective is built as
  `withRoleContext(candidate.role, withoutMentions(content) || content)` —
  the triggering text only.

## Item 2 — a second agent in a thread

Let a reply address a different agent and have it answer in the same thread
with the same context the thread's own agent already receives.

- Run replies through mention resolution
  (`resolveChannelMentionCandidates`) instead of assuming the root's agent.
  Keep the current behaviour as the fallback when no mention is present —
  that is what makes "reply without @mentioning" work today.
- If a reply asks for *work* rather than an answer, the dispatch path must
  reuse the existing thread instead of creating an acknowledgement of its own.
  Today `dispatchChannelMentions` always creates one; it needs to accept a
  target thread.
- Visibility still applies: a personal agent must refuse a stranger the same
  way it does in the channel (`candidate.visibility === "personal"` guard).

## Item 3 — no thread for small tasks

**Do not classify "small" up front.** Judging size before the work means
guessing before anything is known. Make threads *lazy* instead: post the
acknowledgement as an ordinary message and promote it to a thread only when
there is more than one thing to say. A one-line change produces an
acknowledgement and an outcome and stays flat, with no heuristic to get wrong.

If a decision up front is wanted anyway, `planOpening` already returns a title
and thoughts — a plan with no thoughts is the natural "no thread" signal.

## Item 4 — merging similar tasks into one thread

Last, and **explicit before automatic**. Auto-merging into the wrong thread
buries a task where nobody will look for it, which is worse than not merging.
Start with a "continue in this thread" affordance; consider clustering later.
`relevanceTokens` / `scoreCandidate` already exist if scoring is wanted.

Note items 3 and 4 interact: lazy threads mean far fewer threads to merge.

## Agent code names

Today a roster entry is named `` `${AGENT_LABEL[provider.id] ?? provider.name} (${shortUser()})` ``
in `myAgents` (`data.js`). Wanted instead: a generated code name — Icarus,
Bravo — from a pool of **30–100**, assigned at random.

Requirements:

- Renaming already exists end to end: `renameChannelAgent` →
  `POST /channel/agents/:agentId` with `{ name }`, stored per channel in
  `state.channelAgentOverrides`. Generated names should flow through the same
  override so "change it" needs nothing new.
- **On joining a channel, a name already in use there must prompt** — offering
  regenerate or type-your-own. Uniqueness is per channel, so the check belongs
  next to the roster for that repository.
- Roles are unchanged. The role label is separate from the name and stays.

**Check before building:** `@mention` routing resolves against the agent's
displayed name. If names become code names, resolution has to follow, or
dispatch silently stops matching — and two agents that both roll "Bravo" need
a tiebreak. Verify `resolveChannelMentionCandidates` against the name source
first.

## Verifying anything here

The local scratch instance **cannot exercise the roster.** The channel roster
is per-user provider connections ∩ membership; the local project uses the
host's shared CLI login, so `connectionsFor` returns nothing, the roster is
empty, and no mention resolves to a candidate. Rename, roster hover, dispatch
and thread paths therefore cannot be reproduced locally — they need a
deployment where someone has signed in per user.

Local boot, for everything else:

```
COORD_BOOTSTRAP_TOKEN=dev-bootstrap-token-relay-2026 COORD_PORT=4761 \
  node <repo>/apps/web/dist/index.js --root=.
```
from `C:\Users\nward\AppData\Local\Temp\relay-shots-0803`
(owner@example.com / relay-dev-owner-2026!A). Static assets load at server
start — restart after editing `public/`.

## Shipping

Branch `chats-channels-and-agent-sign-in` → merge into `main` in a throwaway
worktree → push. Railway auto-deploys `main`.

- Project `satisfied-unity` `8264200e-f8da-42d6-943e-6ad10046e589`
- Service `@coord/web` `e3042ac3-db6d-4b90-b4fa-9b9f5e10b30f`
- Environment `23177a19-aadb-4d9f-8742-69a2917c0dcf`
- Live at <https://coordweb-production.up.railway.app>

Always confirm a deploy by fetching the asset and grepping for the change;
"SUCCESS" on the previous deployment is easy to misread as the new one.

## Still outstanding, unrelated to the above

**No `/data` volume is attached.** Every redeploy wipes `.coordinator`, so
accounts, agent sign-ins and channel memberships are lost each time. Attach a
volume at `/data` (service → Settings → Volumes) before treating anything
configured in the deployment as durable.
