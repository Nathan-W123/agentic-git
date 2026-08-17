# Handoff — name agents at connect, and give each agent its own history panel

Three user requests, one session boundary. The naming half sits on top of the
naming feature the *other* session has in flight (uncommitted as of
2026-08-13 morning — the channel-add auto-namer that produced Zeus/Gaia/
Hestia in production is not in committed history; grep for a pool finds
nothing). Coordinate before building: the committed foundation is theirs.

## 1. Name at connect, not at channel-add

The account-level identity already exists, committed:

- `callSign` on `ProviderSettings` (`apps/web/src/providers.ts` ~151), doc:
  "held once per connected account… somebody who has met Icarus in one
  channel should meet the same Icarus in the next."
- Set/cleared via the provider settings route
  (`services/api-gateway/src/server.ts` ~2461).

To finish the user's ask:

1. **Auto-assign on connect** when `callSign` is unset — in
   `connectOwnCredential`/sign-in completion (`providers.ts`), pick from the
   pool below, avoiding signs already taken by other users' connections
   (`connectionsFor` can report them).
2. **Resolution must prefer callSign** wherever a channel resolves an agent's
   display name (the `/channel/agents` roster route and the mention matcher
   in server.ts) — channel override stays as the *exception* per the doc
   comment.
3. Stop assigning at channel-add once connect-time assignment exists — that
   code is in the other session's tree, not in committed history.

**Where the name lives (2026-08-15).** A call sign is now written twice: to
`secrets/provider-connections.json` as before, and to `agent_call_signs` in
the coordination store (`listAgentCallSigns`/`setAgentCallSign`/
`clearAgentCallSign`, migration 32). The file alone was not enough — it sits
on the control plane's own disk, so a deployment whose filesystem does not
outlive a restart came back with every name gone and every roster reading
"Claude (Nathan)" in channels the database remembered perfectly. Reads
reconcile the two: a name the store knows and the file has lost is *restored*
rather than re-dealt, the file wins where both have one, and a name cleared
through the settings route is cleared in both. The `/channel/agents` roster
also reads the store directly (`channelAgentConnections` in server.ts) for the
case the file lost the connection record along with the name.

**Where it was still lost (2026-08-15, later).** Storing the name durably was
only half of item 2 above: the `/channel/agents` roster route carried the call
sign as far as `connection.callSign` and then threw it away, building
`${AGENT_LABEL} (${owner})` as the default it handed
`resolveChannelAgentPresentation`. Only the mention matcher had been changed.
Because the browser treats the roster's resolved name as the single authority —
`channelAgentsFor` in `data.js` overwrites even the viewer's own
`myAgents()` name with it — every channel showed "Claude (Nathan)" and
"Codex (Nathan)" while the settings screen, which reads the connection itself,
showed the real name. All three sites now call one function,
`defaultChannelAgentName` (server.ts, beside `AGENT_LABEL`): the roster route,
`resolveChannelMentionCandidates`, and `channelAgentNamer`. A per-channel
rename override still beats it. If a fourth place ever needs an agent's default
name, it belongs there too — two copies of this rule is exactly how the screen
and the matcher came to disagree.

### The pool (Greek + Roman, ready to paste)

```ts
export const AGENT_CALL_SIGNS = [
  // Olympians and kin
  "Zeus", "Hera", "Poseidon", "Demeter", "Athena", "Apollo", "Artemis",
  "Ares", "Aphrodite", "Hephaestus", "Hermes", "Hestia", "Dionysus",
  "Hades", "Persephone",
  // Titans and primordials
  "Cronus", "Rhea", "Oceanus", "Tethys", "Hyperion", "Theia", "Themis",
  "Mnemosyne", "Atlas", "Prometheus", "Epimetheus", "Gaia", "Uranus",
  "Nyx", "Erebus", "Eos", "Helios", "Selene", "Iris",
  // Winds and lesser gods
  "Boreas", "Zephyrus", "Notus", "Eurus", "Pan", "Morpheus", "Nemesis",
  "Nike", "Tyche", "Eris", "Hebe", "Janus",
  // Roman counterparts and originals
  "Jupiter", "Juno", "Neptune", "Ceres", "Minerva", "Mars", "Venus",
  "Vulcan", "Mercury", "Vesta", "Bacchus", "Pluto", "Proserpina",
  "Saturn", "Ops", "Sol", "Luna", "Aurora", "Victoria", "Fortuna",
  "Bellona", "Faunus", "Flora", "Pomona", "Terminus", "Quirinus",
];
```

Caution from production history: an agent named after a *thing* confuses the
model about itself ("Apollo integration isn't installed" — server.ts ~363).
`agentIdentity()` already counters this; keep it in the loop for new names.

## 2. Per-agent history panel (replaces the notifications tab)

Click an agent anywhere → side panel for *that agent*. Personal agent of
yours → two tabs: **History | Private chat**. Anyone else's → history only.

Concrete wiring, all verified points:

- `rosterRow` (`screen-chats.js` ~330): `roster-row-main` currently fires
  `channel-settings-toggle`; change to open the panel
  (`state.activeAgentPanel = agent.id`, default tab history). Keep settings
  reachable from the sliders icon already in `rr-actions`.
- `agentPanel()` (`screen-chats.js`): today resolves from `myAgents()` only —
  widen to `channelAgentsFor(activeChannelId())` so teammates' agents open
  too; render the tab strip with `tabs()` from `ui.js` (~764) when
  `agent.mine`; `state.agentPanelTab`.
- **History content**: `state.tasks` filtered by this repo + `taskBelongsToAgent`
  (`data.js`), newest first: status glyph, first line of objective, relative
  time; where a channel message has `taskId === task.id`, the row is a button
  firing `channel-thread-open` on that message.

**The vendor-match caveat, half closed (2026-08-17).** This section used to
warn that with two people's Codex in one room, tasks could not be attributed
per-owner client-side, and that the fix was stamping the owner on the task
server-side. The stamp was already there: `dispatchOneMention` submits every
channel task under the *mentioned agent's* account rather than the sender's —
deliberately, so one person's agent never spends another's — which makes
`SubmittedTask.submittedBy` the agent's owner, and `GET /tasks` already hands
whole task rows to the browser. What was missing was any client reading it.

`taskBelongsToAgent(task, agent)` in `data.js` now reads the pair —
`(submittedBy, vendor-of agentId)`, the same key `recentObjectivesFor` groups
by server-side — and the panel history, the news banner's naming, the working
dot's durable half and `myAgents`'s running-task lookup all go through it.
Before that, every Codex task landed in every Codex agent's panel: two people
opened two panels onto one identical history. Two consequences worth knowing:
the working dot no longer excludes teammates (the `agent.mine` gate existed
only because the vendor could not say whose run it was), and `myAgents` had
been comparing a vendor id against a provider id — `provider.adapter` is not a
field the providers payload carries — so *no* agent of your own had ever been
seen running.

Still open, and genuinely needing a schema change: **two Codex CLIs on one
account**. The credential store is `users[userId]["codex"]` and
`provider-connections.json` is `file[userId]["openai"]`, both single-valued, so
the second connection overwrites the first and there is one roster row, one
call sign, one `${userId}:openai`. Separating those needs a per-connection
identity carried onto `SubmittedTask`, not a client-side matcher.
- **NAV**: remove the notifications entry the same way "My Agents" went
  (route stays reachable; the bell in the topbar stays as the record and the
  unread badge). Banners (already live) cover the interrupt case.

## Recent context a fresh session needs

- Banners: `banner()` in `ui.js`, `bannerLineForAudit()` in `data.js`, fired
  from the audit-frame handler in `app.js`.
- Thread rules: channel line unless report / >1 file / >400 chars / notable
  mid-run event. Auto-merge is cross-agent, objective-included, 0.42 bar.
- Token usage records at collectChanges in the coordinator (in-process path).
- Deploy discipline: build-verify main in the `bsm` worktree before push;
  check `/api/v1/health` `build.commit` before believing a production test —
  timing ate three tests yesterday.
