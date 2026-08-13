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
- **History content**: `state.tasks` filtered by this repo + vendor match on
  `task.agentId` (`VENDOR_FOR_PROVIDER` in `data.js`), newest first: status
  glyph, first line of objective, relative time; where a channel message has
  `taskId === task.id`, the row is a button firing `channel-thread-open` on
  that message. Note the vendor-match caveat: with two people's Codex in one
  room, tasks cannot be attributed per-owner client-side (same boundary the
  working-dot has; fix is stamping owner on the task, server-side).
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
