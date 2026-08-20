# Handoff — channel threading (items 2–4) and agent code names

Working notes for in-flight work on the Chats screen. Everything below was
read out of the code, not remembered; file references are the places to start.

**Status: every code item here is now built.** Items 1–4, the agent code
names, the device-auth rotation fix, and all three stages of the folder
pullout including the move route. Each section below says which. The one thing
still genuinely outstanding is infrastructure and not code: **no `/data`
volume is attached**, so every redeploy still wipes `.coordinator`.

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

1. `@mention` in a channel message → `dispatchChannelMentions`, called from
   the channel messages POST route. Thread replies reach the same dispatch
   path through `answerThreadReply` when they ask for work.
2. The person's request is the task root. As soon as dispatch accepts the task,
   the agent replies there that it took the task and is working on it; the
   transient working indicator mirrors the same live state in the channel.
3. `Task: <title>` plus the opening reasoning go in as replies, then
   `watchChannelTask` streams the run's narration into the same request-rooted
   thread.
4. A person replying in a thread is answered by `answerThreadReply`, which
   passes the thread as context and resolves the agent from the persisted task
   (or from an explicit mention for legacy threads).

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
- If a reply asks for *work* rather than an answer, the dispatch path reuses
  the existing thread and acknowledges the new task there.
- Visibility still applies: a personal agent must refuse a stranger the same
  way it does in the channel (`candidate.visibility === "personal"` guard).

## Item 3 — compact transcripts for small tasks

**Do not classify "small" up front.** Judging size before the work means
guessing before anything is known. Every accepted task now gets an immediate
acknowledgement in its thread, while a one-line change can still keep its
outcome beside the request instead of adding a full progress transcript.

If a decision up front is wanted anyway, `planOpening` already returns a title
and thoughts — a plan with no thoughts is the natural "no thread" signal.

## Item 4 — merging similar tasks into one thread — **done (explicit only)**

Built as the affordance, not the clustering. A thread's header carries a
"continue" control; taking it aims the channel composer at that thread and
closes the panel, so the next message posted from the channel lands as a reply
there instead of opening a second thread about the same work. A chip above the
composer names the thread it will go to and dismisses back to the channel, and
switching channels clears the aim — a thread belongs to the channel it hangs
in.

Nothing was needed on the server: the reply path already dispatches work into
the thread it arrived in (item 2), so aiming the composer reuses it.

Automatic clustering is still deliberately not built. `relevanceTokens` /
`scoreCandidate` remain if it is ever wanted, but auto-merging into the wrong
thread buries a task where nobody will look for it.

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

## Device-auth credentials expire permanently — **fixed**

`CredentialHome.close()` now reads the session file back out of the staged
home before deleting it and reports a `rotatedSecret` when the CLI replaced
it. `withCredentialHome` takes an `onRotate` callback; the task run path
(`openSubmitterCredentialHome`) and the chat path (`withCompletionEnv`) both
store the replacement, so a refreshed token survives the home it was written
into. Neither can fail the run that produced it — losing a rotation costs one
reconnect, and throwing would discard work somebody waited for.

Not special-cased to Codex: Claude and Gemini session files are carried
forward the same way, each with a test. An API key is never treated as
rotatable, and an unchanged file is not rewritten — otherwise every run would
churn the credential store.

The diagnosis that led to it is kept below, because it explains why the
symptom looked intermittent.

### Original diagnosis

Symptom: Codex connects through device auth, works briefly, then every run
fails with `401 Unauthorized` on `wss://api.openai.com/v1/responses`.
Reconnecting fixes it for about an hour.

Cause, confirmed by reading both halves:

- `finishDeviceAuth` (`apps/web/src/providers.ts`) stores **a snapshot of
  `auth.json`** taken once at sign-in, as a `session_file` credential.
- `withCredentialHome` (`services/workspace-manager/src/user-credentials.ts`)
  writes that snapshot into a temp home for each run and deletes the home in
  its `finally`. The Codex CLI refreshes its OAuth token during a run and
  writes the new one into `CODEX_HOME/auth.json` — into the directory being
  destroyed. **Every refreshed token is discarded.**

So the credential is not wrong, it is frozen. It verifies at sign-in, which is
why connecting looks fine, and dies for good once the original short-lived
access token expires.

Claude is not visibly affected because `finishClaudeAuth` handles it
separately and `claude setup-token` issues something long-lived — the same
discard costs it nothing for far longer. The fix should not be special-cased
to Codex regardless; any vendor CLI that rotates its own token has this.

Fix: read `auth.json` back out of the credential home after the run and, if it
differs from what was written in, store it as the new credential.
`openCredentialHome`/`close()` already owns writing the snapshot in, so
writing a changed one back belongs there; `providers.ts` then persists it
through the credential store. Needs a test that a rotated file is written back
and a stable one is not.

Note while diagnosing: every redeploy wipes `/data`, which forces a reconnect,
which buys another hour of it appearing to work. Attach the volume first or
this will look intermittent.

## Task — a folder pullout for browsing and opening code

Wanted: a panel on the right, like the threads pullout, showing the
repository's file structure — click a file to read it, and eventually move
files around to reorganise the tree.

### Most of the read side already exists

- `buildTree(paths)` in `apps/web/public/code-view.js` already turns flat
  paths into the nested `{ name, path, dirs: Map, files: [] }` shape a tree
  renders from. It takes either strings or `{ path, flag }`.
- `filePanel()` in `screen-chats.js` already renders one file with view and
  edit modes, and `state.chanFileView` (a path) is what selects it. The
  channel already mounts it in the same right-hand slot as the threads panel:
  `state.chanFileView !== undefined ? filePanel() : (threadPanel(...) || ...)`.
- `ensureCodeData` (`screen-code.js`) populates `state.files` and
  `state.changeSet`; the channel already calls it on the `chats` route.

So the panel itself is: render `buildTree(state.files.map(f => f.path))`, keep
expand/collapse state, and set `state.chanFileView` on click. Mirror the
threads pullout added alongside it — same `.thread-panel` slot, same
toggle-button-in-the-header pattern, same `chanThreadList`-style boolean.

### Moving files — **done**

The note below was right that a move needed a server capability first, and
slightly wrong about the starting point: the workspace API was not read-only,
it already had `writeFile`, which is what made the rest small.

`moveOverlayFile` (`apps/web/src/overlay.ts`) renames inside the overlay under
the overlay lock, so the pair is atomic against every other overlay operation
— a browser doing write-then-delete could leave a copy at both paths and show
a reviewer an unexplained duplicate instead of a rename. It refuses to
overwrite an existing target and refuses a missing source, and `rename` does
the work rather than copy-then-delete so there is no window where the file is
at both paths or neither.

**It needs no pipeline of its own**, which was the open question. The overlay
*is* the staging area every edit already goes through: `submit` turns whatever
the overlay holds into a changeset, so a move arrives at review as a deletion
and an addition of the same content and is revertible by the same means.

Exposed as `POST …/workspace/move` with `{from, to}`, and the tree is
draggable: files carry `data-drag-path`, directories `data-drop-dir`, and only
directories accept a drop. Dropping a file into the directory it already sits
in is a no-op rather than an error.

Three tests in `overlay.test.ts`: a move lands and leaves the overlay dirty, a
move refuses to overwrite or to invent a source, and a move cannot escape the
overlay.

### Order suggested

1. ~~Tree panel, read-only, opening into the existing `filePanel()`.~~ done
2. ~~Then the move route, server-side, with the pipeline wired through.~~ done
3. ~~Only then make the tree draggable.~~ done
