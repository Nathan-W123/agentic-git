/**
 * Chats — the landing screen. One group channel per repository, with that
 * repository's agents sitting in the roster as first-class participants next
 * to the people working it.
 *
 * This replaces the old repository grid; opening a channel is what opening a
 * repository used to mean. What is new is that the channel itself is a real,
 * shared-feeling surface — messages, threads, reactions, per-agent renames
 * and model/effort all read and write through `data.js`'s channel functions
 * and behave like the real thing on this screen. What they are *not* is
 * shared with anyone else's browser: see the comment on `sendChannelMessage`
 * in `data.js` for why, and where a real backend would plug in.
 *
 * Files and Changes are drawers on the right rather than a second screen,
 * reusing the exact tree-row and diff rendering the Code screen already has
 * (`code-view.js`) so a file opened from here is the same file Code shows.
 */

import {
  api,
  canLeaveRepository,
  canManageRepository,
  channelAgentsFor,
  channelAuthor,
  channelMessagesFor,
  threadTitle,
  threadTitleReply,
  typingOn,
  agentsThinkingIn,
  agentStatus,
  personOnline,
  dmUnreadFrom,
  currentUserId,
  currentUserName,
  myAvatar,
  memberName,
  channelParticipants,
  channelUnreadCount,
  activeChannelId,
  collaborators,
  currentRepository,
  markChannelRead,
  myAgents,
  persist,
  postChannelReply,
  sendChannelMessage,
  state,
  VENDOR_FOR_PROVIDER,
} from "./data.js";
import { chatComposer, chatProgress, chatThread } from "./chat.js";
import {
  FLAG_FOR_STATUS,
  buildTree,
  parsePatch,
  patchStats,
  renderUnified,
} from "./code-view.js";
import {
  agentFace,
  avatar,
  avatarStack,
  chime,
  clockTime,
  esc,
  icon,
  iconButton,
  emptyState,
  miniSelect,
  relativeTime,
  searchBox,
  tabs,
  toast,
} from "./ui.js";

/* ------------------------------------------------------------- options ---- */

/**
 * A usable model/effort list before the real one has loaded, or for a
 * teammate's seeded agent this account has never connected and so has no
 * `providerOptions` for. Real options — loaded the same way My Agents and
 * Code load them, through `ensureAgentOptions` — replace this the moment
 * they arrive; nothing here is invented once the real list exists.
 */
const FALLBACK_MODELS = {
  anthropic: [
    { value: "claude-sonnet", label: "Sonnet" },
    { value: "claude-opus", label: "Opus" },
  ],
  openai: [
    { value: "gpt-5", label: "GPT-5" },
    { value: "gpt-5-mini", label: "Mini" },
  ],
  google: [
    { value: "gemini-2.5-pro", label: "2.5 Pro" },
    { value: "gemini-2.5-flash", label: "Flash" },
  ],
  xai: [{ value: "grok-4", label: "Grok 4" }],
  deepseek: [{ value: "deepseek-v3", label: "V3" }],
};

const FALLBACK_EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function optionsFor(agent) {
  const loaded = state.providerOptions[agent.provider];
  const models =
    loaded?.models?.length > 0
      ? loaded.models.map((model) => ({ value: model.id, label: model.label ?? model.id }))
      : (FALLBACK_MODELS[agent.provider] ?? [{ value: "default", label: "Default" }]);
  const efforts =
    loaded?.efforts?.length > 0
      ? loaded.efforts.map((effort) => ({
          value: effort,
          label: effort.charAt(0).toUpperCase() + effort.slice(1),
        }))
      : FALLBACK_EFFORTS;
  return { models, efforts };
}

/* ------------------------------------------------------------- sidebar ---- */

/**
 * A channel, and the things you can do to it.
 *
 * A div rather than a button because it now contains one: inviting somebody
 * belongs to a channel, not to the account menu, and a button inside a button
 * is not markup a browser will keep. The keyboard is served by `role=button`
 * and the delegated handler in `app.js` that exists for exactly this.
 */
function chanRow(repo, activeRepositoryId) {
  const unread = channelUnreadCount(repo.id);
  const active = repo.id === activeRepositoryId;
  return `<div class="chan-row${active ? " active" : ""}${
    unread > 0 ? " unread" : ""
  }" role="button" tabindex="0" data-act="channel-open" data-value="${esc(repo.id)}">
    <span class="cr-hash">${icon("chatBubble")}</span>
    <span class="cr-name">${esc(repo.id)}</span>
    ${unread > 0 ? `<span class="cr-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
    <span class="cr-more">${iconButton("dots", {
      act: "channel-menu",
      value: repo.id,
      title: `More for #${repo.id}`,
      small: true,
    })}</span>
  </div>`;
}

function rosterSettings(agent) {
  const options = optionsFor(agent);
  return `<div class="roster-settings" data-agent="${esc(agent.id)}">
    <div>
      <div class="rs-label">Model</div>
      ${miniSelect(
        "channel-agent-model",
        options.models,
        agent.model || options.models[0]?.value || "",
        "Model",
      )}
    </div>
    <div>
      <div class="rs-label">Reasoning effort</div>
      ${miniSelect(
        "channel-agent-effort",
        options.efforts,
        agent.effort || options.efforts[0]?.value || "",
        "Reasoning effort",
      )}
    </div>
    ${
      // Unlike model and effort, this is not how the agent presents itself in
      // this room — it decides whose credential a teammate's prompt spends, so
      // it is account-wide and offered only for one's own agent.
      agent.mine === true
        ? `<div>
            <div class="rs-label">Available to</div>
            ${miniSelect(
              "channel-agent-visibility",
              [
                { value: "personal", label: "Only me" },
                { value: "org", label: "Everyone in the org" },
              ],
              agent.visibility === "org" ? "org" : "personal",
              "Available to",
            )}
            <div class="rs-hint">${
              agent.visibility === "org"
                ? "Teammates can send prompts that spend this account."
                : "Only you can use this agent."
            }</div>
          </div>`
        : ""
    }
  </div>`;
}

/**
 * `canModerate` shows a remove button for agents that are not the viewer's
 * own — loosened from `agent.mine` to also admit anyone the server's
 * `manage_project`+/creator check (`removeChannelAgentForUser` in data.js,
 * the `?userId=` path on the membership DELETE route) would actually allow.
 * The self-service button for one's own agent is unconditional, matching
 * that the server never restricts it by permission level either.
 */
/**
 * The hover card for one roster entry.
 *
 * Only for this account's own agents: the usage route reports the *caller's*
 * account, so showing it beside a teammate's agent would put your consumption
 * under their name. Rendered from state rather than fetched on open, so the
 * first hover shows "Checking…" and every later one is instant.
 */
function usageTip(agent) {
  if (agent.mine !== true) {
    return "";
  }
  const report = state.providerUsage[agent.id];
  let body;
  if (report === undefined || report.loading === true) {
    body = `<div class="rr-usage-empty">Checking usage…</div>`;
  } else if (report.unavailableReason !== undefined) {
    body = `<div class="rr-usage-empty">${esc(report.unavailableReason)}</div>`;
  } else if ((report.windows ?? []).length === 0) {
    body = `<div class="rr-usage-empty">No usage reported.</div>`;
  } else {
    body = `${report.windows
      .map((window) => {
        const percent = Math.max(0, Math.min(100, Number(window.percentUsed) || 0));
        return `<div class="rr-usage-row">
          <span class="rr-usage-label">${esc(window.label)}</span>
          <span class="rr-usage-bar"><i style="width:${percent}%"></i></span>
          <span class="rr-usage-pct">${Math.round(percent)}%</span>
        </div>${
          window.resetsAt === undefined
            ? ""
            : `<div class="rr-usage-reset">Resets ${esc(window.resetsAt)}</div>`
        }`;
      })
      .join("")}
      ${report.source === undefined ? "" : `<div class="rr-usage-src">${esc(report.source)}</div>`}`;
  }
  return `<div class="rr-usage" role="tooltip">${body}</div>`;
}

/**
 * One person in the roster, shaped like an agent row.
 *
 * Same markup deliberately: a channel's participants are people and agents
 * side by side, and giving each its own layout would make the two lists read
 * as unrelated things that happen to sit together. The role sits under the
 * name exactly where an agent's does — theirs is what they were granted here,
 * which is the same question being answered in both cases.
 */
/**
 * The coloured dot on an avatar.
 *
 * One element and one class rather than a colour computed here, so the meaning
 * of each colour lives in the stylesheet with the rest of the palette and the
 * two rosters cannot drift apart on what green means.
 */
function statusDot(status, title) {
  return `<span class="status-dot status-${status}" title="${esc(title)}"></span>`;
}

/**
 * Message text, with any images it refers to drawn underneath it.
 *
 * Messages are plain text and stay plain text — this is not markdown, and
 * nothing here interprets anything else somebody typed. The only pattern read
 * is `![alt](attachment:<id>)`, and the id is matched against the exact shape
 * the store issues before it is used at all: thirty-two hex characters and one
 * of four extensions. Anything else is left as the literal text it was, which
 * is what keeps a message that merely talks about the syntax from becoming an
 * image tag.
 *
 * Kept out of the record because the alternative was a column and a migration
 * on three backends to hold what is, in the end, a reference.
 */
const ATTACHMENT_PATTERN =
  /!\[([^\]]*)\]\(attachment:([0-9a-f]{32}\.(?:png|jpg|gif|webp))\)/gu;

/**
 * A narrow, safe subset of Markdown for what an agent writes.
 *
 * Escaped first, patterns applied second. That order is the whole safety
 * argument: by the time anything here matches, every `<`, `>` and `&` the
 * author wrote is already an entity, so the only tags in the output are the
 * ones constructed below. Nothing an agent writes can become an element.
 *
 * Deliberately small. Headings, bold, bullets and paragraphs are what a
 * summary is actually made of; links, images, tables and raw HTML are not,
 * and every one of them is a way for text to do something other than be read.
 */
function richText(text) {
  const blocks = esc(String(text ?? ""))
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const inline = (value) =>
    value
      .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
      .replace(/`([^`]+)`/gu, "<code>$1</code>");
  return blocks
    .map((block) => {
      const lines = block.split(/\n/u);
      // A heading is a line of its own, so a sentence that happens to contain
      // a hash is left alone.
      if (lines.length === 1 && /^#{1,4}\s+/u.test(block)) {
        return `<h4 class="rt-head">${inline(block.replace(/^#{1,4}\s+/u, ""))}</h4>`;
      }
      if (lines.every((line) => /^\s*[-*]\s+/u.test(line))) {
        return `<ul class="rt-list">${lines
          .map((line) => `<li>${inline(line.replace(/^\s*[-*]\s+/u, ""))}</li>`)
          .join("")}</ul>`;
      }
      if (lines.every((line) => /^\s*\d+[.)]\s+/u.test(line))) {
        return `<ol class="rt-list">${lines
          .map((line) => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/u, ""))}</li>`)
          .join("")}</ol>`;
      }
      return `<p>${lines.map((line) => inline(line)).join("<br>")}</p>`;
    })
    .join("");
}

function messageBody(content, repositoryId) {
  const text = String(content ?? "");
  const images = [];
  let stripped = text;
  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    images.push({ alt: match[1] ?? "", id: match[2] ?? "" });
    stripped = stripped.replace(match[0], "");
  }
  if (images.length === 0) {
    return richText(text);
  }
  const base =
    `/api/v1/projects/${encodeURIComponent(state.projectId)}` +
    `/repositories/${encodeURIComponent(repositoryId ?? "")}/attachments/`;
  return (
    richText(stripped.trim()) +
    images
      .map(
        (image) =>
          `<a class="cmsg-image" href="${esc(base + image.id)}" target="_blank"
             rel="noopener noreferrer"><img src="${esc(base + image.id)}"
             alt="${esc(image.alt)}" loading="lazy"></a>`,
      )
      .join("")
  );
}

function personRow(person) {
  // Two shapes reach here. The organization member list nests the account
  // under `user`; the room's own people list flattens it to `id`/`name`. Only
  // the first was read, so on every room whose people list had loaded the
  // name fell back to "Someone" and — worse — the id came out empty, which
  // opened a direct message to nobody and was answered "that person was not
  // found".
  const name =
    person.user?.displayName ??
    person.user?.email ??
    person.name ??
    "Someone";
  const role = String(person.role ?? "").trim();
  const userId = person.user?.id ?? person.userId ?? person.id ?? "";
  const me = userId === currentUserId();
  const online = personOnline(userId);
  const unread = dmUnreadFrom(userId);
  // Writing to yourself is not a conversation, so your own row is a label
  // rather than a button — everyone else's opens the thread with them.
  return `<div class="roster-row">
    <div class="roster-row-main"${
      me
        ? ""
        : ` role="button" tabindex="0" data-act="dm-open" data-value="${esc(userId)}"`
    }>
      <span class="rr-avatar">
        ${avatar(name, 30, name, me ? myAvatar() : undefined)}
        ${
          // Your own dot is green whenever you can see it: the page being
          // open is what "here" means, and a roster where everyone else has
          // a status and you have none reads as broken rather than modest.
          me
            ? statusDot("working", "You're here")
            : statusDot(
                online ? "working" : "away",
                online ? `${name} is here` : `${name} is away`,
              )
        }
      </span>
      <span class="rr-body">
        <div class="rr-name">${esc(name)}${me ? " (you)" : ""}</div>
        <div class="rr-role${role ? "" : " rr-role-empty"}">${
          role === "" ? "No role set" : esc(role)
        }</div>
      </span>
      ${unread > 0 ? `<span class="rr-badge">${unread}</span>` : ""}
    </div>
  </div>`;
}

/** The roles the system acts on, so the roles worth offering. */
const AUDITOR_ROLE = "auditor";
const INVESTIGATOR_ROLE = "investigator";

function isAuditor(agent) {
  return (agent.role ?? "").trim().toLowerCase() === AUDITOR_ROLE;
}

const AGENT_STATUS_TITLE = {
  working: "Working now",
  idle: "Idle",
  personal: "Personal agent — only its owner can task it here",
};

function rosterRow(agent, canModerate) {
  const renaming = state.chatRenamingId === agent.id;
  const settingsOpen = state.chatSettingsOpenId === agent.id;
  const auditor = isAuditor(agent);
  const paused = state.auditorPaused[activeChannelId()] === true;
  const status = agentStatus(agent, activeChannelId());
  return `<div class="roster-row">
    <div class="roster-row-main" role="button" tabindex="0"
      data-act="agent-panel-open" data-value="${esc(agent.id)}">
      <span class="rr-avatar" data-hover="agent-usage"
        data-hover-value="${esc(agent.id)}" tabindex="0"
        ${
          // Your own agent is talked to one to one, not by mentioning it in
          // the room — the group channel is for work everyone should see. The
          // act sits on the avatar rather than the row so it wins over the
          // row's settings toggle without taking the rest of the row with it.
          // Personal agents only. An org agent's whole point is that its
          // work happens where the team can see it; a private side-channel
          // to one would put shared spend behind a curtain.
          agent.mine && agent.visibility !== "org"
            ? `data-act="agent-chat-open" data-value="${esc(agent.id)}"`
            : ""
        }
        aria-label="${
          agent.mine
            ? `Message ${esc(agent.name)}`
            : `Usage for ${esc(agent.name)}`
        }">
        ${usageTip(agent)}
        ${agentFace(agent, 30)}
        ${statusDot(status, AGENT_STATUS_TITLE[status])}
      </span>
      <span class="rr-body">
        <div class="rr-name">${esc(agent.name)}</div>
        <div class="rr-role${agent.role ? "" : " rr-role-empty"}">${
          agent.role
            ? `${esc(agent.role)}${auditor && paused ? " · paused" : ""}${
                agent.mine ? " · Your agent" : ""
              }`
            : agent.mine
              ? "Your agent · no role set"
              : "No role set"
        }</div>
      </span>
      <span class="rr-actions">
        ${
          // Only the auditor gets a switch, because it is the only role that
          // spends without being asked. Moderators only: turning it back on
          // starts an audit, which costs money, so it is the same decision
          // the promotion route guards.
          auditor && canModerate
            ? `<button type="button" class="rr-switch${paused ? "" : " on"}"
                data-act="auditor-toggle" data-value="${esc(String(paused))}"
                role="switch" aria-checked="${paused ? "false" : "true"}"
                title="${
                  paused
                    ? "Auditing is off. Turn it on to audit everything merged since it was switched off."
                    : "Auditing is on. Turn it off to stop audits without demoting this agent."
                }"><span class="rr-switch-dot"></span></button>`
            : ""
        }
        ${iconButton("pencil", {
          act: "channel-rename-toggle",
          value: agent.id,
          title: "Rename or set role in this channel",
          small: true,
        })}
        ${iconButton("sliders", {
          act: "channel-settings-toggle",
          value: agent.id,
          title: "Model & effort",
          small: true,
        })}
        ${
          agent.mine
            ? iconButton("close", {
                act: "channel-agent-remove",
                value: agent.id,
                title: "Remove from this chat",
                small: true,
              })
            : canModerate
              ? iconButton("close", {
                  // Non-mine entries are already keyed `${userId}:${provider}`
                  // (see `channelAgentsFor` in data.js), which is exactly the
                  // pair `removeChannelAgentForUser` needs.
                  act: "channel-agent-remove-any",
                  value: agent.id,
                  title: "Remove this agent from the chat",
                  small: true,
                })
              : ""
        }
      </span>
    </div>
    ${
      renaming
        ? `<form class="roster-rename" data-act="channel-rename-form" data-value="${esc(agent.id)}">
            <input data-act="channel-rename-input" data-value="${esc(agent.id)}"
              value="${esc(agent.name)}" placeholder="${esc(agent.name)}" autocomplete="off">
            <input data-act="channel-role-input" data-value="${esc(agent.id)}"
              value="${esc(agent.role ?? "")}" placeholder="Role in this channel"
              list="channel-role-options" autocomplete="off">
            <datalist id="channel-role-options">
              <!-- Every other role is free text that reaches the agent as a
                   sentence and nothing else, so there is nothing to offer.
                   These two are the ones the code acts on, and a reserved word
                   nobody can discover is a reserved word nobody uses —
                   \`investigator\` had been exactly that since it was built. -->
              <option value="${AUDITOR_ROLE}">Audits every merge, unprompted</option>
              <option value="${INVESTIGATOR_ROLE}">Explains why a task failed</option>
            </datalist>
          </form>`
        : ""
    }
    ${settingsOpen ? rosterSettings(agent) : ""}
  </div>`;
}

function chanSidebar(activeRepositoryId) {
  const query = state.chatQuery.trim().toLowerCase();
  const channels = [...state.repositories]
    .filter((repo) => query === "" || repo.id.toLowerCase().includes(query))
    .sort((left, right) => left.id.localeCompare(right.id));
  const roster = channelAgentsFor(activeRepositoryId);
  const canModerate = canManageRepository(activeRepositoryId);
  // The membership records rather than `collaborators()`, which flattens them
  // to names — the role has to come from somewhere, and it is on the record.
  // The server's room list when it has arrived — it includes repo-scoped
  // grantees the org member list has never heard of; the org list is only
  // the floor before the roster resolves.
  const people =
    state.channelPeople[activeRepositoryId]?.length > 0
      ? state.channelPeople[activeRepositoryId]
      : (state.members ?? []);

  return `<aside class="chan-sidebar">
    <div class="chan-sidebar-head">
      ${searchBox("Search channels...", state.chatQuery, "channel-search")}
      <button type="button" class="chan-new" data-act="channel-new" title="New chat">
        ${icon("plus")}
      </button>
    </div>
    <div class="chan-list">
      <div class="chan-list-label">Channels</div>
      ${
        channels.length === 0
          ? `<div class="util-empty">No channel matches that search.</div>`
          : channels.map((repo) => chanRow(repo, activeRepositoryId)).join("")
      }
    </div>
    <div class="chan-roster">
      <div class="chan-list-label">Users</div>
      ${
        // People first, then agents. The channel header already names the
        // repository, so repeating it in the label said nothing the eye had
        // not just read — and it grew with the name, which is why a long
        // repository pushed the word "Agents" out of sight entirely.
        people.length === 0
          ? `<div class="util-empty">Nobody else has access to this repository yet.</div>`
          : people.map((person) => personRow(person)).join("")
      }
      <!-- Adding somebody belongs under the list of who is already here,
           where the question occurs to you, rather than only behind the
           channel's menu. Each button adds the kind of participant it sits
           beneath. -->
      <button type="button" class="roster-add" data-act="invite-repo"
        data-value="${esc(activeRepositoryId ?? "")}">
        ${icon("plus")}<span>Invite someone</span>
      </button>
      <div class="chan-list-label">Agents</div>
      ${
        // The broadcast address, listed with the agents it reaches so it is
        // discoverable from the roster and not only from typing "@". Clicking
        // it starts the message rather than sending one — the person still
        // says what they want asked.
        roster.length < 2
          ? ""
          : `<div class="roster-row" role="button" tabindex="0"
               data-act="mention-agents-insert">
               <div class="roster-row-main">
                 <span class="rr-avatar">${icon("users")}</span>
                 <span class="rr-body">
                   <div class="rr-name">@agents</div>
                   <div class="rr-role">Ask every agent at once</div>
                 </span>
               </div>
             </div>`
      }
      ${
        // No empty state. The "Add an agent" button sits directly beneath and
        // already says what the absence means; a sentence saying the same
        // thing above it is a line to read before reaching the thing to click.
        roster.length === 0
          ? ""
          : roster.map((agent) => rosterRow(agent, canModerate)).join("")
      }
      <button type="button" class="roster-add" data-act="channel-agent-menu"
        data-value="${esc(activeRepositoryId ?? "")}">
        ${icon("plus")}<span>Add an agent</span>
      </button>
    </div>
  </aside>`;
}

/* ---------------------------------------------------------- chan main ---- */

/**
 * Start this repository's app, or go and look at the one already running.
 *
 * The link is a plain anchor to a loopback address, which works only on the
 * machine running the control plane. That is the whole design of the preview
 * and not an oversight — see `PreviewService` — so on a hosted deployment this
 * offers a link that will not open, and it says where it points rather than
 * pretending otherwise.
 */
function previewRunning(repositoryId) {
  const preview = state.previews[repositoryId];
  return preview !== null && preview !== undefined && preview.exited === undefined
    ? preview
    : undefined;
}

/** The control, which lives in the tool tray with its siblings. */
function previewControl(repositoryId) {
  if (!repositoryId) {
    return "";
  }
  return previewRunning(repositoryId) === undefined
    ? `<button type="button" class="icon-btn" data-act="preview-start"
        data-value="${esc(repositoryId)}" title="Run this app and open it">
        ${icon("play")}</button>`
    : `<button type="button" class="icon-btn on" data-act="preview-stop"
        data-value="${esc(repositoryId)}" title="Stop the running app">
        ${icon("close")}</button>`;
}

/** The address, which stays in the header because it is state, not a control. */
function previewLink(repositoryId) {
  if (!repositoryId) {
    return "";
  }
  const preview = previewRunning(repositoryId);
  if (preview === undefined) {
    return "";
  }
  // Through this deployment rather than at the preview's own address. The
  // app binds loopback and nothing opens a port, so its own URL only works on
  // the machine running the control plane — this path works from anywhere the
  // reader is already signed in, which includes a phone, and needs no second
  // set of rules about who may look.
  const proxied =
    `/api/v1/projects/${encodeURIComponent(state.projectId)}` +
    `/repositories/${encodeURIComponent(repositoryId)}/preview/app/`;
  // No stop control beside it: stopping is a tool and lives with the tools.
  return `<span class="preview-live">
    <a class="preview-link" href="${esc(proxied)}" target="_blank"
      rel="noopener noreferrer" title="${esc(preview.label)} — ${esc(preview.url)}">
      ${esc(preview.url.replace("http://", ""))}</a>
  </span>`;
}

function chanHeader(repository, repositoryId) {
  const roster = channelAgentsFor(repositoryId);
  const people = collaborators();
  const faces = roster.slice(0, 3).map((agent) => agentFace(agent, 24)).join("");
  return `<header class="chan-head">
    <button type="button" class="icon-btn menu-btn" data-act="nav-toggle"
      title="Menu" aria-label="Menu">${icon("menu")}</button>
    <!-- Phone-only: the channel list and roster live in \`.chan-sidebar\`,
         which goes off-canvas below the 600px breakpoint the same way the
         outer app \`.sidebar\` already does at 900px. This is the only way
         back to it once it is closed, so it is a real button rather than
         something folded into a menu.

         The backticks are escaped because this comment is inside a template
         literal: a bare one closes the string, and the selector after it
         then parses as real code — ".chan-sidebar" becomes a property read
         minus an identifier named "sidebar", which is valid JavaScript and
         throws only when this header renders. -->
    <button type="button" class="icon-btn chan-sidebar-btn" data-act="chan-sidebar-toggle"
      title="Channels &amp; people" aria-label="Channels &amp; people">${icon("list")}</button>
    <!-- The desktop counterpart of the button above: on a wide screen the
         channel list is a column rather than a drawer, so folding it away is
         a different act from opening it and gets its own control. Hidden
         below the breakpoint where the drawer takes over. -->
    <button type="button" class="icon-btn desk-only" data-act="chan-collapse-toggle"
      title="${state.chanCollapsed ? "Show channels &amp; people" : "Hide channels &amp; people"}"
      aria-pressed="${state.chanCollapsed === true}"
      aria-label="${state.chanCollapsed ? "Show channels and people" : "Hide channels and people"}">${icon(
        "columns",
      )}</button>
    ${icon("chatBubble", 'class="ch-hash"')}
    <div class="ch-title">
      <div class="ch-name">${esc(repositoryId ?? "")}</div>
      <div class="ch-desc">
        <span>${esc(repository?.branch ?? "main")} branch</span>
        <span class="ch-sep">·</span>
        <!-- Counted, not spelled out. "3 agents, 2 teammates" is six words
             for two numbers, and it grew or shrank with the plural — the two
             figures are easier to read as figures. The titles carry the
             words for anyone hovering or using a screen reader. -->
        <span class="ch-count" title="${people.length} ${
          people.length === 1 ? "person" : "people"
        }">${icon("personBust")}${people.length}</span>
        <span class="ch-count" title="${roster.length} agent${
          roster.length === 1 ? "" : "s"
        }">${icon("robotBust")}${roster.length}</span>
      </div>
    </div>
    <span class="spacer"></span>
    ${
      // A running preview's address is not a control, so it stays out of the
      // fold. The point of hiding the tools is a quieter header; hiding the
      // one live thing in it would mean expanding a menu to find out whether
      // your app is up.
      previewLink(repositoryId)
    }
    <span class="avatar-stack">${faces}${avatarStack(people, 3, 24)}</span>
    ${
      // Six controls sat permanently in a header that is 44 pixels tall on a
      // phone, and on any given visit a reader wants none of them. Behind one
      // arrow they are a menu; in front of it they were the header.
      state.chanToolsOpen !== true
        ? ""
        : `<span class="chan-tools">
            ${previewControl(repositoryId)}
            <button type="button" class="icon-btn${state.chanTree === true ? " on" : ""}"
              data-act="chan-tree-toggle" title="Files"
              aria-pressed="${state.chanTree === true}">${icon("folder")}</button>
            <button type="button" class="icon-btn${state.chanThreadList === true ? " on" : ""}"
              data-act="channel-threads-toggle" title="Threads"
              aria-pressed="${state.chanThreadList === true}">${icon("reply")}</button>
            <button type="button" class="icon-btn${state.termOpen ? " on" : ""}"
              data-act="chan-term-toggle" title="Terminal"
              aria-pressed="${state.termOpen}">${icon("terminal")}</button>
            <button type="button" class="icon-btn${state.chanMsgSearchOpen ? " on" : ""}"
              data-act="channel-msg-search-toggle" title="Search messages"
              aria-pressed="${state.chanMsgSearchOpen}">${icon("search")}</button>
            ${iconButton("info", { act: "channel-info", value: repositoryId ?? "", title: "Channel info" })}
          </span>`
    }
    <button type="button" class="icon-btn chan-tools-toggle${
      state.chanToolsOpen === true ? " on" : ""
    }" data-act="chan-tools-toggle"
      title="${state.chanToolsOpen === true ? "Hide tools" : "Show tools"}"
      aria-expanded="${state.chanToolsOpen === true}">${icon("chevronDown")}</button>
  </header>`;
}

function chanSearchRow() {
  if (!state.chanMsgSearchOpen) {
    return `<div hidden></div>`;
  }
  return `<div class="chan-search">${searchBox(
    "Search messages in this channel...",
    state.chanMsgQuery,
    "channel-msg-search",
  )}</div>`;
}

/**
 * The one line under a message that stands for its whole thread.
 *
 * It used to read "8 replies", counting every step the run narrated to
 * itself — so a one-line edit looked like a long conversation, and the number
 * told you how long the work took rather than how much was said. It also
 * never said what the thread was *about*, though the agent names every task
 * it picks up and that name is sitting in the first reply.
 *
 * So: the name, the faces of whoever is in it, and a count of things actually
 * said. Thinking is excluded — it is the run talking to itself, and it has
 * its own collapsed block inside the thread.
 */
function threadSummaryLink(entry, replies, repositoryId) {
  const titled = threadTitleReply(entry);
  // No content fallback here: this link renders directly under the root
  // message's own text, and a "title" echoing it would say nothing twice.
  // The task-objective fallback inside the helper still names threads that
  // never got a "Task:" reply.
  const name = threadTitle(entry, { fallbackToContent: false });
  const said = replies.filter(
    (reply) => reply !== titled && !isThreadThinking(reply),
  );
  // One face per participant, in the order they first appear, so a thread
  // shows who is in it before it is opened. Deduplicated by author: three
  // messages from one agent is one agent.
  const seen = new Set();
  const faces = replies
    .map((reply) => channelAuthor(repositoryId, reply))
    .filter((author) => {
      const key = author?.name ?? "";
      if (key === "" || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 4)
    .map((author) =>
      author.agent !== undefined ? agentFace(author.agent, 18) : avatar(author.name, 18, author.name, author.name === currentUserName() ? myAvatar() : undefined),
    )
    .join("");
  const count =
    said.length === 0
      ? "Thread"
      : `${said.length} repl${said.length === 1 ? "y" : "ies"}`;
  return `<button type="button" class="cmsg-thread-link" data-act="channel-thread-open"
      data-value="${esc(entry.id)}">
      <span class="ctl-faces">${faces}</span>
      ${name === "" ? "" : `<span class="ctl-name">${esc(name)}</span>`}
      <span class="ctl-count">${esc(count)}</span>
    </button>`;
}

/**
 * What the work under this thread changed, collapsed.
 *
 * The narration says "wrote changes to a.ts, b.ts and 2 more" once, in
 * passing, and it scrolls away — so a thread could describe work in detail
 * and still leave nobody able to answer "what did it actually touch?".
 *
 * A `<details>` rather than anything scripted: it remembers nothing, needs no
 * state, and a reader who does not care never sees the list. Closed by
 * default, because the answer most people want is the count.
 *
 * Ordered by what happened rather than alphabetically — new files first, then
 * edits, then deletions — since that is the order somebody reviewing a change
 * reads it in.
 */
const CHANGED_FILE_MARK = { added: "+", modified: "~", deleted: "−" };
const CHANGED_FILE_ORDER = { added: 0, modified: 1, deleted: 2 };

function changedFilesBlock(entry, repositoryId) {
  const files = Array.isArray(entry.changedFiles) ? entry.changedFiles : [];
  if (files.length === 0) {
    return "";
  }
  // Undoing work is offered where the work is shown, because that is the only
  // place the question "undo what?" already has an answer. Anywhere else it
  // would need a revision typed in, and nobody reads a channel holding a list
  // of forty-character hashes.
  //
  // Only for a task that landed something, and only for somebody who could
  // manage the repository anyway — the API refuses either way, and a button
  // that exists to be refused is worse than no button.
  // Counts are per file and summed for the header. Absent on rows written
  // before they were reported, and shown as nothing rather than as zero: a
  // file that changed no lines is a different claim from one nobody counted.
  const num = (value) => (typeof value === "number" ? value : undefined);
  const tally = (key) =>
    files.reduce((total, file) => total + (num(file[key]) ?? 0), 0);
  const totalAdded = tally("added");
  const totalRemoved = tally("removed");
  const counts = (added, removed) =>
    added === undefined && removed === undefined
      ? ""
      : `<span class="cf-stat"><span class="cf-add">+${added ?? 0}</span><span
           class="cf-del">−${removed ?? 0}</span></span>`;
  const rows = [...files]
    .sort(
      (left, right) =>
        (CHANGED_FILE_ORDER[left.status] ?? 3) -
          (CHANGED_FILE_ORDER[right.status] ?? 3) ||
        String(left.path).localeCompare(String(right.path)),
    )
    .map(
      (file) =>
        // A row opens the file, editable, in the side panel — the same action
        // and the same panel the transcript's inline file links use. A list of
        // what changed is the most natural place to want to look at one of
        // them, and it was the only place naming a file that could not be
        // opened from.
        //
        // A deleted file is not opened: there is nothing at that path to read
        // any more, and offering it would end in an empty editor.
        `<li class="cmsg-file ${esc(file.status)}"${
          file.status === "deleted"
            ? ""
            : ` role="button" tabindex="0" data-act="chan-file-open"
                data-value="${esc(file.path)}"
                title="Open ${esc(file.path)}"`
        }><span class="cmsg-file-mark">${
          CHANGED_FILE_MARK[file.status] ?? "~"
        }</span><span class="cmsg-file-path">${esc(file.path)}</span>${counts(
          num(file.added),
          num(file.removed),
        )}</li>`,
    )
    .join("");
  return `<details class="cmsg-changes">
    <summary><span class="cf-caret">${icon("chevronRight")}</span>
      <span class="cf-title">${files.length} file${
        files.length === 1 ? "" : "s"
      } changed</span>
      ${
        totalAdded === 0 && totalRemoved === 0
          ? ""
          : counts(totalAdded, totalRemoved)
      }</summary>
    <ul class="cmsg-files">${rows}</ul>
  </details>`;
}

/**
 * Where a thread's run has got to, read from what it already said.
 *
 * The narration is the progress record: planning, "planned N file(s)",
 * execution, one "Working on…" line per stretch of files, validation, the
 * ending. Parsing those beats new plumbing — it works for every thread ever
 * written, and the bar can never disagree with the words directly above it.
 *
 * The executing span is the honest core: files named in "Working on" lines
 * against the count the plan declared is a measured fact. Everything else is
 * a fixed milestone, which is all a phase deserves.
 */
function threadProgress(entry) {
  const replies = entry.replies ?? [];
  if (replies.length === 0) {
    return undefined;
  }
  // Finished is finished however it was said. The regex catches the fixed
  // endings; an agent's own summary does not match it, and a bar stuck at 90%
  // under a task that landed an hour ago reads as a hang. The task's status
  // and the `outcome` reply kind both survive rewording.
  const task = state.tasks.find((candidate) => candidate.id === entry.taskId);
  if (task !== undefined && !["submitted", "claimed"].includes(task.status)) {
    return undefined;
  }
  if (replies.some((reply) => reply.kind === "outcome")) {
    return undefined;
  }
  let planned = 0;
  const touched = new Set();
  let progress = 5;
  // A bar only means something over a run the narration can recognise. The
  // audit thread — and any other thread whose replies carry none of the run
  // markers below — sat at the 5% floor forever, reading as a task stuck at
  // the beginning rather than a thread that simply is not a task.
  let sawRunMarker = false;
  for (const reply of replies) {
    const text = String(reply.content ?? "");
    if (/planning workspace prepared/iu.test(text)) {
      sawRunMarker = true;
      progress = Math.max(progress, 10);
    }
    const plannedMatch = /planned (\d+) file/iu.exec(text);
    if (plannedMatch !== null) {
      sawRunMarker = true;
      planned = Number(plannedMatch[1]);
      progress = Math.max(progress, 15);
    }
    if (/execution started/iu.test(text)) {
      sawRunMarker = true;
      progress = Math.max(progress, 20);
    }
    const working = /^Working on (.+?)(?:…|\.\.\.|$)/u.exec(text.trim());
    if (working?.[1] !== undefined) {
      for (const file of working[1].split(/,| and /u)) {
        const name = file.trim();
        if (name !== "" && !/^\d+ more$/u.test(name)) {
          touched.add(name);
        }
      }
      const share = planned > 0 ? Math.min(touched.size / planned, 1) : 0.5;
      progress = Math.max(progress, Math.round(20 + 55 * share));
    }
    if (/Validating…|Wrote changes to/iu.test(text)) {
      progress = Math.max(progress, 80);
    }
    if (/Validation passed/iu.test(text)) {
      progress = Math.max(progress, 90);
    }
    if (THREAD_FINISHED_RE.test(text.trim())) {
      return undefined; // Finished threads carry no bar; the ending says it.
    }
  }
  return sawRunMarker ? progress : undefined;
}

function messageRow(
  entry,
  repositoryId,
  { isReply = false, hideChanges = false, actions = "" } = {},
) {
  const author = channelAuthor(repositoryId, entry);
  // System messages are the coordinator narrating, not a participant in the
  // room — same "centered, no avatar, no reactions" treatment `chat.js`'s
  // `.msg.system` gives the private panel's own system lines (an error, a
  // connect prompt), so a mention refusal or dispatch confirmation reads as
  // the same kind of thing there.
  if (entry.kind === "system") {
    return `<div class="cmsg-row cmsg-system"><p class="msg system">${esc(entry.content)}</p></div>`;
  }
  const reactions = Object.entries(entry.reactions ?? {});
  const replies = entry.replies ?? [];
  return `<div class="cmsg-row${
    // The auditor reads every merge without being asked, so its lines arrive
    // among work nobody is looking at yet. Drawn in the accent so they are
    // recognisable as the unprompted ones — and in *the reader's* accent
    // rather than a colour of their own, because a second meaning-carrying
    // colour in a room that already has one is just noise.
    isAuditor(author.agent ?? {}) ? " cmsg-auditor" : ""
  }"${
    // The id is the jump target the pinned banner scrolls to. Gated on the
    // channel copy only: the thread panel renders the same root with
    // isReply, and one message must not put two ids in the document.
    isReply ? "" : ` id="cmsg-${esc(entry.id)}"`
  }>
    <span class="cmsg-avatar">${
      author.agent !== undefined ? agentFace(author.agent, 32) : avatar(author.name, 32, author.name, author.name === currentUserName() ? myAvatar() : undefined)
    }</span>
    <div class="cmsg-body">
      <div class="cmsg-top">
        <span class="cmsg-name${author.agent !== undefined ? " agent-name" : ""}">${esc(
          author.name,
        )}</span>
        <span class="cmsg-time">${esc(clockTime(entry.at))}</span>
      </div>
      <div class="cmsg-text">${messageBody(entry.content, repositoryId)}</div>
      ${
        reactions.length === 0
          ? ""
          : `<div class="cmsg-reactions">${reactions
              .map(
                ([emoji, info]) =>
                  `<button type="button" class="cmsg-reaction${info.mine ? " mine" : ""}"
                    data-act="channel-react" data-value="${esc(entry.id)}">${emoji} ${info.count}</button>`,
              )
              .join("")}</div>`
      }
      ${
        // The file list belongs to the thread, so it renders under the
        // thread's own link — the work is the thread's story, and a summary of
        // it sitting directly under the opening message read as a property of
        // that one message, beside a second copy wherever else the task was
        // mentioned. Only a message with no thread keeps the block on itself,
        // because there is nothing else for it to hang from.
        replies.length === 0
          ? hideChanges
            ? ""
            : changedFilesBlock(entry, repositoryId)
          : threadSummaryLink(entry, replies, repositoryId) +
            (() => {
              // A few pixels of accent under the thread: how far its run has
              // got, present only while there is a run to speak of. Quiet by
              // design — the thread's own words carry the detail, this just
              // spares opening it to learn "roughly where".
              const progress = threadProgress(entry);
              return progress === undefined
                ? ""
                : `<div class="thread-progress" title="${progress}% by phase">
                     <i style="width:${progress}%"></i>
                   </div>`;
            })() +
            changedFilesBlock(entry, repositoryId)
      }
    </div>
    <span class="cmsg-actions">
      ${
        // Revert, as quiet as the actions beside it. It was a labelled button
        // under the file list, which gave "undo this task" more visual weight
        // than the task itself had.
        entry.taskId === undefined || !canManageRepository(repositoryId)
          ? ""
          : iconButton("history", {
              act: "chan-revert-task",
              value: entry.taskId,
              title: "Return the repository to the state before this task",
              small: true,
            })
      }
      ${iconButton("smile", { act: "channel-react", value: entry.id, title: "React", small: true })}
      ${
        // Roots only. A pin lives on `channel_messages`, and a reply is a row
        // in another table entirely — offering the button on one sent a POST
        // that could only ever 404, and the optimistic local pin it had
        // already drawn stayed in the banner afterwards, advertising a pin the
        // server had no record of. The thread's own header carries the pin for
        // everything inside it, which is the affordance a reader wants anyway:
        // you pin the conversation, not one line of it.
        isReply
          ? ""
          : iconButton("pin", {
              act: "channel-pin",
              value: entry.id,
              title: entry.pinnedAt === undefined ? "Pin" : "Unpin",
              small: true,
            })
      }
      ${
        // Anything the caller wants sitting beside the reply button — the
        // summary's simplify wand rides here, so the two read as one set of
        // quiet actions rather than a button under the text and an icon over
        // it.
        actions
      }
      ${
        // Every message can be replied to, agent's and person's alike. A
        // channel message replies by opening its thread; a message already
        // inside one replies by quoting it into the thread's composer —
        // there is no third place for the answer to go.
        isReply
          ? iconButton("reply", {
              act: "thread-reply-quote",
              value: entry.id,
              title: "Reply to this message",
              small: true,
            })
          : iconButton("reply", {
              act: "channel-thread-open",
              value: entry.id,
              title: "Reply in thread",
              small: true,
            })
      }
    </span>
  </div>`;
}

/**
 * The three dots, for one surface.
 *
 * People and agents are shown by the same row because they mean the same
 * thing to whoever is waiting — something is coming, hold on. `threadId`
 * decides which surface this is: a reply being typed belongs to its thread,
 * not to the room behind it.
 */
function typingIndicator(repositoryId, threadId) {
  const names = typingOn(repositoryId, threadId);
  // An agent is "thinking" while a task it owns is running. That is only
  // meaningful in the room itself: a task belongs to the channel, and there
  // is nothing tying one to a particular thread.
  const busy = threadId === undefined ? agentsThinkingIn(repositoryId) : [];
  if (names.length === 0 && busy.length === 0) {
    return "";
  }
  const who = [
    ...busy.map((name) => `${name} is thinking`),
    ...(names.length === 0
      ? []
      : [
          names.length === 1
            ? `${names[0]} is typing`
            : names.length === 2
              ? `${names[0]} and ${names[1]} are typing`
              : `${names.length} people are typing`,
        ]),
  ].join(" · ");
  // Reuses `.chan-typing`/`.typing-dots`, the same dots `threadTyping`
  // already animates for an agent mid-task, so a person typing and an agent
  // working do not arrive as two different visual languages.
  return `<div class="chan-typing" aria-live="polite">
    <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="typing-who">${esc(who)}</span>
  </div>`;
}

function messageList(repositoryId) {
  const query = state.chanMsgQuery.trim().toLowerCase();
  const entries = channelMessagesFor(repositoryId).filter(
    (entry) => query === "" || entry.content.toLowerCase().includes(query),
  );
  if (entries.length === 0) {
    return `<div class="chan-messages" id="chan-messages">${emptyState(
      "chatBubble",
      query === "" ? "No messages yet" : "Nothing matches that search",
      query === ""
        ? "Say hello — messages sent here stay in this channel for your session."
        : "Try a different search term.",
      // Also on the empty branch: an empty channel is exactly where somebody
      // starting to type matters most, and leaving it off here meant the dots
      // could not appear until the room already had a message in it.
    )}${typingIndicator(repositoryId, undefined)}</div>`;
  }
  // One file summary per task, and the thread's copy wins. A task can be
  // named by more than one channel entry — the thread that follows its work
  // and a bare outcome line — and each carries the same task id, so the same
  // list rendered under both read as two different changes. The thread is
  // where the story lives, so it keeps the summary and the loose mention
  // goes without.
  const threadedTasks = new Set(
    entries
      .filter(
        (entry) =>
          (entry.replies ?? []).length > 0 && entry.taskId !== undefined,
      )
      .map((entry) => entry.taskId),
  );
  let lastDay = "";
  const rows = entries.map((entry) => {
    const day = new Date(entry.at ?? Date.now()).toDateString();
    let separator = "";
    if (day !== lastDay) {
      lastDay = day;
      const isToday = day === new Date().toDateString();
      separator = `<div class="chan-day">${isToday ? "Today" : esc(day)}</div>`;
    }
    const hideChanges =
      (entry.replies ?? []).length === 0 &&
      entry.taskId !== undefined &&
      threadedTasks.has(entry.taskId);
    return separator + messageRow(entry, repositoryId, { hideChanges });
  });
  return `<div class="chan-messages" id="chan-messages">${rows.join(
    "",
  )}${typingIndicator(repositoryId, undefined)}</div>`;
}

/**
 * The lines that end a thread, as the narration used to write them.
 *
 * This was once the whole test, on the reasoning that a separate status field
 * would be a second source of truth that could disagree with what the channel
 * shows. The reasoning held only while the ending was one of three fixed
 * sentences. It stopped holding the moment the ending became the agent's own
 * account of what it did: nothing a model writes begins "Done —", so a thread
 * that finished perfectly well matched nothing here and was read as still
 * running — its summary filed inside the collapsed thinking block, its typing
 * dots never retiring.
 *
 * So the flag exists now (`outcome`, see `ChannelEntryKind`) and this is the
 * fallback for replies written before it did.
 */
const THREAD_FINISHED_RE = /^(Done —|I could not|This was cancelled)/u;

/** Whether a reply is the one that ended the thread. */
function isThreadEnding(reply) {
  return (
    reply.kind === "outcome" ||
    THREAD_FINISHED_RE.test(String(reply.content ?? "").trim())
  );
}

/**
 * Whether a reply is the run talking to itself rather than to the reader.
 *
 * `progress` is the server's mark. The content test behind it is for replies
 * written before that mark existed, which are indistinguishable otherwise —
 * and it must not be applied to a marked ending, which is the bug the
 * `outcome` kind was added to fix.
 */
function isThreadThinking(reply) {
  return (
    reply.kind === "progress" ||
    (reply.kind === "agent" && !isThreadEnding(reply))
  );
}

/**
 * Who `@` can currently complete to, narrowed by what has been typed.
 *
 * Nameless participants are dropped rather than matched against. A member
 * with no display name and no email, or an agent connected before it was
 * given a call sign, has nothing to insert after the `@` -- and reading
 * `.toLowerCase()` off the missing name used to throw from inside the
 * composer's keydown handler. That took `preventDefault` down with it, so
 * Up and Down stopped moving the highlight and Enter fell through to the
 * textarea and opened a new line instead of accepting the selection.
 */
function channelMentionCandidates(repositoryId) {
  const query = state.mentionQuery.trim().toLowerCase();
  // The broadcast address, offered like any other name so it is
  // discoverable from the same "@" that reveals everyone else. The server
  // answers it with every reachable agent — questions only.
  const broadcast =
    query === "" || "agents".includes(query)
      ? [{ name: "agents", kind: "broadcast" }]
      : [];
  return [
    ...broadcast,
    ...channelParticipants(repositoryId)
      .filter((entry) => typeof entry.name === "string" && entry.name !== "")
      .filter(
        (entry) => query === "" || entry.name.toLowerCase().includes(query),
      ),
  ].slice(0, 7);
}

/**
 * The commands offered for what has been typed.
 *
 * Prefix rather than substring, matching the server's own `slashCommandsMatching`:
 * offering `/cancel` while somebody types `/can` is helping, offering it for
 * `/el` is guessing. The list comes from the server with the messages, so the
 * picker cannot offer something the channel would not recognise.
 */
function channelSlashCandidates(repositoryId) {
  const query = state.slashQuery.trim().toLowerCase();
  return (state.channelSlashCommands[repositoryId] ?? [])
    .filter((entry) => String(entry.name ?? "").startsWith(query))
    .slice(0, 6);
}

function slashPopover(candidates) {
  if (candidates.length === 0) {
    return `<div class="mention-pop"><div class="mention-item" style="color:var(--text-4)">No commands</div></div>`;
  }
  const index = state.slashIndex % candidates.length;
  return `<div class="mention-pop">${candidates
    .map(
      (entry, position) => `<button type="button" class="mention-item slash-item${
        position === index ? " active" : ""
      }" data-act="channel-slash-pick" data-value="${esc(entry.name)}">
        <span class="slash-name">/${esc(entry.name)}</span>
        <span class="slash-summary">${esc(entry.summary ?? "")}</span>
      </button>`,
    )
    .join("")}</div>`;
}

function mentionPopover(candidates) {
  if (candidates.length === 0) {
    return `<div class="mention-pop"><div class="mention-item" style="color:var(--text-4)">No matches</div></div>`;
  }
  const index = state.mentionIndex % candidates.length;
  return `<div class="mention-pop">${candidates
    .map(
      (entry, position) => `<button type="button" class="mention-item${
        position === index ? " active" : ""
      }" data-act="channel-mention-pick" data-value="${esc(entry.name)}">
        ${
          entry.kind === "broadcast"
            ? icon("users")
            : entry.kind === "agent"
              ? agentFace(entry.agent, 20)
              : avatar(entry.name, 20)
        }
        <span>${esc(entry.name)}</span>
        <span class="mi-kind">${
          entry.kind === "broadcast"
            ? "every agent"
            : entry.kind === "agent"
              ? "agent"
              : ""
        }</span>
      </button>`,
    )
    .join("")}</div>`;
}

/**
 * The sandbox terminal, as a drawer over the bottom of the channel.
 *
 * What it talks to is not a shell session: the server runs one process per
 * request inside the project's Docker sandbox and hands back the output. So
 * there is no prompt to echo and nothing persists between commands except the
 * overlay's own files -- `cd` does not stick, and neither does an export. The
 * header says so rather than letting the resemblance to a real terminal
 * imply otherwise.
 */
function terminalDrawer() {
  const log = state.termLog
    .map((entry) => {
      if (entry.kind === "command") {
        return `<div class="term-cmd"><span class="term-caret">$</span>${esc(entry.text)}</div>`;
      }
      if (entry.kind === "note") {
        return `<div class="term-note">${esc(entry.text)}</div>`;
      }
      return `<pre class="term-out${entry.bad === true ? " bad" : ""}">${esc(entry.text)}</pre>`;
    })
    .join("");
  return `<section class="term-drawer" aria-label="Sandbox terminal"
    style="height:${Number(state.termHeight)}px">
    <div class="term-grip" data-act="chan-term-resize" role="separator"
      aria-label="Resize terminal" aria-orientation="horizontal"
      tabindex="0" title="Drag to resize"></div>
    <header class="term-head">
      <span class="term-ico">${icon("terminal")}</span>
      <strong>Terminal</strong>
      <span class="term-sub">one command per run, in this repository's sandbox</span>
      <span class="spacer"></span>
      ${iconButton("close", { act: "chan-term-toggle", title: "Close terminal" })}
    </header>
    <div class="term-body" data-term-body>${
      log === ""
        ? `<div class="term-note">Commands run in your isolated overlay workspace. Each one is a fresh process, so a directory change or an exported variable does not carry to the next.</div>`
        : log
    }${state.termBusy ? `<div class="term-note">Running…</div>` : ""}</div>
    <form class="term-form" data-act="chan-term-submit">
      <span class="term-caret">$</span>
      <input data-act="chan-term-input" autocomplete="off" spellcheck="false"
        placeholder="${state.termBusy ? "Running…" : "Type a command"}"
        value="${esc(state.termDraft)}"${state.termBusy ? " disabled" : ""} />
    </form>
  </section>`;
}

function composer(repositoryId) {
  const candidates = state.mentionActive ? channelMentionCandidates(repositoryId) : [];
  return `<div class="chan-composer-wrap">
    ${state.slashActive ? slashPopover(channelSlashCandidates(repositoryId)) : ""}
    ${state.mentionActive ? mentionPopover(candidates) : ""}
    ${composerThreadChip(repositoryId)}
    <form class="composer" data-act="channel-submit">
      <textarea data-act="channel-input" rows="1" spellcheck="true"
        placeholder="${
          state.composerThreadId === undefined
            ? `Message #${esc(repositoryId ?? "")}`
            : "Add to this thread..."
        }">${esc(state.chatDraft)}</textarea>
      <div class="composer-bar">
        ${iconButton("at", { act: "channel-mention-key", title: "Mention someone" })}
        <span class="spacer"></span>
        <button class="send-btn" type="submit" title="Send">${icon("send")}</button>
      </div>
    </form>
  </div>`;
}

/**
 * The edge you drag to give the panel more of the window.
 *
 * A separator rather than a button, and reachable from the keyboard, because
 * the panel is where code is read and 340px is a guess that is wrong as often
 * as it is right. The width it sets lives on the document element, not here —
 * this screen is rebuilt wholesale on every render and would forget it.
 */
function panelGrip() {
  return `<div class="panel-grip" role="separator" aria-orientation="vertical"
    tabindex="0" title="Drag to resize — double-click to reset"
    aria-label="Resize panel"></div>`;
}

/**
 * Every thread in the channel, as a way back into one.
 *
 * Threads are where the work actually happens, and once a few messages have
 * gone by the only way back to one was to scroll the channel until its root
 * appeared. This lists them newest first — the root's own words, since that
 * is what someone is looking for, rather than a task id.
 */
/**
 * One level of the file tree, and everything opened beneath it.
 *
 * Directories carry their own open state in `state.chanTreeOpen` rather than
 * all-or-nothing expansion: a repository is mostly directories somebody is
 * not looking at, and opening the lot to reach one file buries it.
 */
function chanTreeNode(node, depth) {
  const pad = (extra) => `padding-left:${8 + depth * 12 + extra}px`;
  const rows = [];
  for (const directory of [...node.dirs.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const open = (state.chanTreeOpen ?? []).includes(directory.path);
    rows.push(`<button type="button" class="tree-row" data-act="chan-tree-dir"
      data-value="${esc(directory.path)}" data-drop-dir="${esc(directory.path)}"
      style="${pad(0)}">
      ${icon("chevronRight", `class="caret${open ? " open" : ""}"`)}
      <span class="tw-icon">${icon("folder")}</span>
      <span class="tw-name">${esc(directory.name)}</span>
    </button>`);
    if (open) {
      rows.push(chanTreeNode(directory, depth + 1));
    }
  }
  for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
    const flag = file.flag;
    // Draggable onto a directory row, which is the only drop target: dropping
    // a file onto another file has no meaning, and a tree that accepted it
    // would have to invent one.
    rows.push(`<button type="button" class="tree-row${
      file.path === state.chanFileView ? " active" : ""
    }" data-act="chan-file-open" data-value="${esc(file.path)}"
      draggable="true" data-drag-path="${esc(file.path)}"
      style="${pad(14)}" title="${esc(file.path)}">
      <span class="tw-icon">${icon("file")}</span>
      <span class="tw-name">${esc(file.name)}</span>
      ${flag ? `<span class="tw-flag flag-${flag}">${flag}</span>` : ""}
    </button>`);
  }
  return rows.join("");
}

/**
 * The repository's files, as a way into the code from the conversation.
 *
 * Changed files are marked with the same flag the diff blocks use, so the
 * tree answers "what has been touched" without being a second changes view.
 *
 * A file can be dragged onto a directory to move it. That became honest once
 * the overlay gained a move: the rename lands in the same staging area an
 * edit does, so it reaches review as a deletion and an addition and is
 * revertible the same way. Directories are the only drop target — dropping a
 * file onto another file has no meaning worth inventing.
 */
function chanTreePanel(repositoryId) {
  const patches = state.changeSet?.patches ?? [];
  const flags = new Map(
    patches.map((patch) => [patch.path, FLAG_FOR_STATUS[patch.status] ?? "M"]),
  );
  const paths = [
    ...new Set([
      ...(state.files ?? []).map((file) => file.path),
      ...patches.map((patch) => patch.path),
    ]),
  ].map((path) => ({ path, flag: flags.get(path) }));
  return `<aside class="thread-panel">
    ${panelGrip()}
    <header class="thread-head">
      <span>Files</span>
      <span class="spacer"></span>
      ${iconButton("close", { act: "chan-tree-close", title: "Close" })}
    </header>
    <div class="thread-body tree-body">
      ${
        paths.length === 0
          ? // A freshly imported repository has a canonical full of files and
            // no workspace, and files are only ever listed from a workspace.
            // Saying "no files" there is true of the workspace and a lie about
            // the repository, and it left somebody who had just imported their
            // code with nothing to do about it. So the state is named and the
            // action that fixes it is offered here.
            state.workspace?.exists === true
            ? `<div class="util-empty">This repository has no files yet.</div>`
            : `<div class="util-empty">
                 <p>Open a workspace to browse this repository's files.</p>
                 <button class="btn btn-primary" type="button"
                   data-act="workspace-open">Open workspace</button>
               </div>`
          : chanTreeNode(buildTree(paths), 0)
      }
    </div>
  </aside>`;
}

function threadListPanel(repositoryId) {
  // Newest first, and "newest" means the last thing to happen in the thread
  // rather than when it started — a thread somebody added to five minutes ago
  // is the live one, however long ago it opened. The server orders the
  // channel the same way once a thread is continued (`bumpChannelMessage`),
  // so the two views agree about which conversation is current.
  const lastActivity = (entry) => {
    const replies = entry.replies ?? [];
    const last = replies[replies.length - 1];
    return String(last?.at ?? last?.createdAt ?? entry.at ?? "");
  };
  const threads = channelMessagesFor(repositoryId)
    .filter((entry) => (entry.replies ?? []).length > 0)
    .slice()
    .sort((left, right) => lastActivity(right).localeCompare(lastActivity(left)));
  return `<aside class="thread-panel">
    ${panelGrip()}
    <header class="thread-head">
      <span>Threads</span>
      <span class="spacer"></span>
      ${
        threads.length === 0 || !canManageRepository(repositoryId)
          ? ""
          : iconButton("trash", {
              act: "channel-threads-clear",
              title: "Delete every thread in this channel",
              small: true,
            })
      }
      ${iconButton("close", { act: "channel-threads-close", title: "Close" })}
    </header>
    <div class="thread-body">
      ${
        threads.length === 0
          ? `<div class="util-empty">No threads yet. A thread appears when an agent has more than one thing to say about a task.</div>`
          : threads
              .map((entry) => {
                const replies = entry.replies ?? [];
                const titled = threadTitleReply(entry);
                // Thinking is the run talking to itself; it has never been a
                // reply and should not be counted as one here either. The
                // title reply is the thread's name, not a message in it.
                const count = replies.filter(
                  (reply) => reply.kind !== "progress" && reply !== titled,
                ).length;
                const author = channelAuthor(repositoryId, entry);
                // The subject leads: somebody scanning this log is looking
                // for a piece of work, and the agent's name told them which
                // colleague — the wrong first question. Who and when demote
                // to the metadata row beneath.
                return `<div class="thread-item-row">
                  <button type="button" class="thread-item"
                    data-act="channel-thread-open" data-value="${esc(entry.id)}">
                    <span class="ti-text">${esc(threadTitle(entry))}</span>
                    <span class="ti-top">
                      <span class="ti-face">${
                        author.agent !== undefined
                          ? agentFace(author.agent, 16)
                          : avatar(author.name, 16)
                      }</span>
                      <span class="ti-who">${esc(author.name)}</span>
                      <span class="ti-time">${esc(clockTime(entry.at))}</span>
                    </span>
                    <span class="ti-count">${
                      count === 0
                        ? "No replies yet"
                        : `${count} repl${count === 1 ? "y" : "ies"}`
                    }</span>
                  </button>
                  ${
                    canManageRepository(repositoryId)
                      ? iconButton("trash", {
                          act: "channel-thread-delete",
                          value: entry.id,
                          title: "Delete this thread",
                          small: true,
                        })
                      : ""
                  }
                </div>`;
              })
              .join("")
      }
    </div>
  </aside>`;
}

/**
 * Your own agent, in the panel beside the channel.
 *
 * Built from the same pieces the agents screen uses rather than a chat surface
 * of its own — `chatThread` and `chatComposer` carry the model and effort
 * pickers, the context ring, and the `chat-submit` handler that dispatches
 * real work. Rebuilding any of that here would have produced a box that looks
 * like the agent chat and can only talk.
 *
 * The header is this screen's own: `chatHeader` offers switch and settings
 * buttons that belong to a screen built around one agent at a time, and its
 * close button toggles the Code screen's pane rather than this panel.
 */
/**
 * What this agent has been asked to do in this repository, newest first.
 *
 * Matched by vendor rather than by owner, because a task records which vendor
 * ran it and not whose account paid for it. With two people's Codex in one
 * room their histories are therefore indistinguishable here — the same
 * boundary the working dot has, and the same fix: stamp the owner on the task,
 * server-side. Until then this is honest about being per-vendor.
 */
function agentHistoryRows(agent, repositoryId) {
  const vendor = VENDOR_FOR_PROVIDER[agent.provider ?? agent.id];
  if (vendor === undefined) {
    return [];
  }
  const messages = channelMessagesFor(repositoryId);
  return state.tasks
    .filter(
      (task) =>
        task.repositoryId === repositoryId &&
        String(task.agentId ?? "").toLowerCase().includes(vendor),
    )
    .sort(
      (left, right) =>
        new Date(right.submittedAt ?? 0).getTime() -
        new Date(left.submittedAt ?? 0).getTime(),
    )
    .map((task) => ({
      task,
      // Where the work was talked about, so a row opens the conversation
      // rather than being a dead label. Not every task has one — a task
      // submitted outside the channel never got a message.
      message: messages.find((entry) => entry.taskId === task.id),
    }));
}

/**
 * What was actually asked for, with any role preamble taken off.
 *
 * A channel dispatch prepends "Your role in this repository: …" to every
 * objective it submits, so the first line of a dispatched task's objective is
 * the operator describing the agent — not the request. A history that took
 * the first line rendered every entry as the same sentence, and an agent that
 * had done forty different things looked like it had done one thing forty
 * times.
 *
 * Mirrors `withoutRoleContext` in shared-types, which the browser cannot
 * import. Kept deliberately identical, including leaving a preamble with
 * nothing behind it alone rather than reducing it to nothing.
 */
const ROLE_CONTEXT_PREFIX = "Your role in this repository:";

function withoutRolePreamble(objective) {
  const trimmed = String(objective ?? "").trimStart();
  if (!trimmed.startsWith(ROLE_CONTEXT_PREFIX)) {
    return trimmed;
  }
  const separator = /\n[^\S\n]*\n/u.exec(trimmed);
  if (separator === null) {
    return trimmed;
  }
  const request = trimmed.slice(separator.index + separator[0].length);
  return request.trim() === "" ? trimmed : request;
}

const TASK_GLYPH = {
  integrated: "✓",
  failed: "✕",
  cancelled: "–",
  awaiting_approval: "?",
  // A conversation between turns: the last turn landed, more may come.
  open: "…",
};

function agentHistory(agent, repositoryId) {
  const rows = agentHistoryRows(agent, repositoryId);
  if (rows.length === 0) {
    return `<div class="agent-history empty">${emptyState(
      "robot",
      "Nothing yet",
      `${esc(agent.name.split(" ")[0])} has not been asked for anything in this repository.`,
    )}</div>`;
  }
  return `<div class="agent-history scroll">${rows
    .map(({ task, message }) => {
      const glyph = TASK_GLYPH[task.status] ?? "•";
      // The first line of the request, not of the objective: those differ by a
      // role preamble on everything a channel dispatched.
      const line =
        withoutRolePreamble(task.objective)
          .split(/\r?\n/u)
          .map((entry) => entry.trim())
          .find((entry) => entry.length > 0) ?? "(no description)";
      const open =
        message === undefined
          ? ""
          : ` role="button" tabindex="0" data-act="channel-thread-open"
              data-value="${esc(message.id)}"`;
      return `<div class="agent-history-row ${esc(task.status)}"${open}>
        <span class="ah-glyph">${glyph}</span>
        <span class="ah-objective">${esc(line)}</span>
        <span class="ah-when">${esc(relativeTime(task.submittedAt))}</span>
      </div>`;
    })
    .join("")}</div>`;
}

function agentPanel() {
  const agentId = state.activeAgentPanel;
  if (agentId === undefined) {
    return "";
  }
  // Every agent in the room, not only this account's. Clicking a teammate's
  // agent asked a question the panel could not answer before: it resolved
  // from `myAgents()` alone, so the click did nothing at all.
  const agent = channelAgentsFor(activeChannelId()).find(
    (candidate) => candidate.id === agentId,
  );
  if (agent === undefined) {
    return "";
  }
  const repositoryId = activeChannelId();
  // A private chat is only ever with a personal agent of your own. Somebody
  // else's has a history and nothing else, and so does an org-wide agent —
  // the whole point of publishing one is that its work happens where the team
  // can see it, so a private side-channel with it would be a way around that
  // rather than a convenience. The avatar shortcut already refuses for the
  // same reason; this is the same rule where the tabs are drawn.
  const canChatPrivately = agent.mine === true && agent.visibility !== "org";
  const tab = canChatPrivately ? (state.agentPanelTab ?? "history") : "history";
  const status = agentStatus(agent, activeChannelId());
  // Header and tabs share the grid's first row. `.thread-panel` is three rows
  // — header, a stretching body, composer — and an extra top-level child does
  // not add a row to it: it takes the body's. The tab strip became the
  // stretching element and sat in the vertical middle of the panel with the
  // history pushed below it, which is what a fourth child gets in a grid that
  // was drawn for three.
  return `<aside class="thread-panel">
    ${panelGrip()}
    <div class="agent-panel-head">
      <header class="thread-head">
        <span class="dm-head-name">
          ${agentFace(agent, 20)}
          ${esc(agent.name)}
          ${statusDot(status, AGENT_STATUS_TITLE[status])}
        </span>
        <span class="spacer"></span>
        ${iconButton("close", {
          act: "agent-panel-close",
          title: "Close this conversation",
        })}
      </header>
      ${
        canChatPrivately
          ? tabs("agent-panel-tab", [
              { value: "history", label: "History" },
              { value: "chat", label: "Private chat" },
            ], tab)
          : ""
      }
    </div>
    ${
      tab === "chat"
        ? // Progress and transcript share one row, as they do in `chatPanel`.
          // `.thread-panel` is a three-row grid and the middle row is the one
          // that stretches: left as siblings, a visible progress bar would take
          // the stretch and the transcript would stop scrolling — but only
          // while a task was running, which is exactly when it is being read.
          `<div style="display:grid;grid-template-rows:auto 1fr;min-height:0">
            ${chatProgress(agent)}
            ${chatThread(agent)}
          </div>`
        : agentHistory(agent, repositoryId)
    }
    ${
      // The composer belongs to the private chat and nothing else. Under a
      // history it would offer to send a message into a conversation the
      // reader is not having — and for somebody else's agent, into one they
      // are not allowed to have at all.
      tab === "chat"
        ? chatComposer(
            agent,
            `Ask ${agent.name.split(" ")[0]} to do anything...`,
          )
        : ""
    }
  </aside>`;
}

/**
 * A conversation with one person, in the panel a thread would otherwise use.
 *
 * The same slot on purpose. A direct message and a thread are both "the thing
 * you stepped aside into", and giving each its own region would mean two
 * panels competing for the same space and a reader having to work out which
 * one they are looking at.
 */
function dmPanel() {
  const userId = state.activeDm;
  if (userId === undefined) {
    return "";
  }
  const person = state.dmPeople.find((candidate) => candidate.id === userId);
  const name = person?.name ?? memberName(userId) ?? "Someone";
  const messages = state.dmThreads[userId] ?? [];
  const online = personOnline(userId);
  return `<aside class="thread-panel">
    ${panelGrip()}
    <header class="thread-head">
      <span class="dm-head-name">
        ${avatar(name, 20)}
        ${esc(name)}
        ${statusDot(online ? "working" : "away", online ? "Here" : "Away")}
      </span>
      <span class="spacer"></span>
      ${iconButton("close", { act: "dm-close", title: "Close conversation" })}
    </header>
    <div class="thread-body dm-body">
      ${
        messages.length === 0
          ? `<p class="dm-empty">No messages yet. This conversation is just
             between you and ${esc(name)} — it is not in the channel.</p>`
          : messages
              .map((message) => {
                const mine = message.authorId === currentUserId();
                return `<div class="dm-msg${mine ? " dm-mine" : ""}">
                  <div class="dm-bubble">${esc(message.content)}</div>
                  <span class="dm-msg-actions">${iconButton("reply", {
                    act: "dm-reply-quote",
                    value: message.id,
                    title: "Reply to this message",
                    small: true,
                  })}</span>
                  <time class="dm-time">${esc(clockTime(message.createdAt))}</time>
                </div>`;
              })
              .join("")
      }
    </div>
    <form class="composer" data-act="dm-submit" style="margin:0 12px 12px">
      <textarea data-act="dm-input" rows="1"
        placeholder="Message ${esc(name)}...">${esc(state.dmDraft)}</textarea>
      <div class="composer-bar">
        <span class="spacer"></span>
        <button class="send-btn" type="submit" title="Send">${icon("send")}</button>
      </div>
    </form>
  </aside>`;
}

function threadPanel(repositoryId) {
  const messageId = state.activeChannelThread;
  if (messageId === undefined) {
    return "";
  }
  // The banner's copy answers for a pinned thread whose transcript row has
  // aged past the loaded page — its stored replies are what let it open.
  const root =
    channelMessagesFor(repositoryId).find((entry) => entry.id === messageId) ??
    (state.channelPins[repositoryId] ?? []).find(
      (entry) => entry.id === messageId,
    );
  if (root === undefined) {
    return "";
  }
  // The subject in the header, where a reader looks first. "Thread" only
  // when nothing names it — and the title being here is what the fold
  // comment inside threadReplies has assumed all along.
  const title = threadTitle(root) || "Thread";
  return `<aside class="thread-panel">
    ${panelGrip()}
    <header class="thread-head">
      <span class="thread-title" title="${esc(title)}">${esc(title)}</span>
      <span class="spacer"></span>
      ${iconButton("pin", {
        act: "channel-pin",
        value: messageId,
        title: root.pinnedAt === undefined ? "Pin thread" : "Unpin thread",
      })}
      ${iconButton("reply", {
        act: "composer-thread-continue",
        value: messageId,
        title: "Send the next channel message into this thread",
      })}
      ${iconButton("close", { act: "channel-thread-close", title: "Close thread" })}
    </header>
    <div class="thread-body">
      <div class="thread-root">${messageRow(root, repositoryId, { isReply: true })}</div>
      ${threadReplies(root, repositoryId)}
      ${threadTyping(root)}
      ${typingIndicator(repositoryId, root.id)}
    </div>
    <form class="composer" data-act="channel-thread-submit" style="margin:0 12px 12px">
      <textarea data-act="channel-thread-input" rows="1"
        placeholder="Reply in thread...">${esc(state.threadDraft)}</textarea>
      <div class="composer-bar">
        <span class="spacer"></span>
        <button class="send-btn" type="submit" title="Send">${icon("send")}</button>
      </div>
    </form>
  </aside>`;
}

/**
 * A running commentary is worth having and not worth reading in full.
 *
 * The narration of a task — planning, editing, validating — is most of what a
 * thread contains and almost none of what somebody opening it wants first.
 * They want the request, and how it ended. So the steps in between collapse
 * into one line they can open, and the outcome stays where it can be seen.
 *
 * Collapsed by default only while there is something after them. A thread
 * still working has its latest step showing, because that is the part being
 * waited on.
 */
function threadReplies(root, repositoryId) {
  const replies = root.replies ?? [];
  if (replies.length === 0) {
    return `<div class="thread-count">No replies yet</div>`;
  }
  const finishedAt = replies.findIndex((reply) => isThreadEnding(reply));
  const done = finishedAt !== -1;
  // The title line names the task, and it now sits inside the thinking block
  // rather than above it. It used to be its own message row on the reasoning
  // that it is not commentary — true, and it still left the thread opening
  // with a restatement of the request that was already the thread's own title
  // two lines further up. Folded in, it is there for whoever wants the exact
  // wording and out of the way of everybody else.
  const [first, ...rest] = replies;
  // Deliberately first-reply-only, unlike the shared threadTitleReply
  // detector: folding a mid-thread "Task:" message into the thinking block
  // would hide a real reply, not a name.
  const titleLine = /^Task: /u.test(String(first?.content ?? "")) ? first : undefined;
  const body = titleLine === undefined ? replies : rest;
  const steps = body.filter(isThreadThinking);
  const outcome = body.filter((reply) => !isThreadThinking(reply));

  // Silent at zero. A task that has been stated and not yet worked on has a
  // block holding the request alone, and "0 steps" beside it reads as a
  // failure to do something rather than as work not started.
  const count =
    steps.length === 0
      ? ""
      : `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return `
    ${
      steps.length === 0 && titleLine === undefined
        ? ""
        : `<details class="thread-thinking"${
            // Open while it runs, unless the reader has said otherwise.
            //
            // `open` was written from `done` alone, so every arriving step
            // re-rendered the element with the attribute back on: closing it
            // lasted until the agent's next thought, which on a working task
            // is a second or two. Thinking is the noisiest thing in a thread
            // and the most reasonable thing to want folded away.
            //
            // The reader's choice is remembered per thread and outranks the
            // default in both directions — a closed one stays closed as steps
            // arrive, and one opened after the task finished stays open.
            (state.thinkingOpen[root.id] ?? !done) ? " open" : ""
          }>
             <summary data-act="thinking-toggle" data-value="${esc(root.id)}">
               <span class="tt-label">Thinking</span>
               <span class="tt-count">${esc(count)}</span></summary>
             <div class="tt-body">${
               // The request, in the agent's own restatement of it, above the
               // steps it took. First because it is what the steps are for.
               titleLine === undefined
                 ? ""
                 : `<p class="tt-task">${esc(
                     String(titleLine.content ?? "")
                       .replace(/^Task:\s*/u, "")
                       .trim(),
                   )}</p>`
             }${steps
               .map((reply) => String(reply.content ?? "").trim())
               .filter((text) => text.length > 0)
               .join("\n")
               .split(/\n+/u)
               .map((line) => `<p>${esc(line)}</p>`)
               .join("")}</div>
           </details>`
    }
    ${outcome
      .map((reply) => summaryBlock(reply, repositoryId))
      .join("")}`;
}

/**
 * How much summary is worth folding away.
 *
 * A two-line ending is not a wall of text and putting it behind a disclosure
 * would cost a click to read three words. This is roughly where a summary
 * stops being a sentence and starts being a document.
 */
const SUMMARY_FOLD_CHARS = 400;

/**
 * The wand beside a summary's reply button: one icon, three states.
 *
 * Untouched, it asks for the plain rewrite; while that is being written it
 * waits, visibly busy and unclickable; once the rewrite exists it toggles
 * between the two versions, lit while the simple one is showing. One icon
 * rather than a labelled button because it lives in the message's quiet
 * action row now, next to reply — the tooltip carries the words the label
 * used to.
 */
function simplifyAction(reply) {
  const simple = state.simplified[reply.id];
  if (typeof simple === "string") {
    const showing = state.simplifyShown[reply.id] === true;
    return `<button type="button" class="icon-btn sm${showing ? " active" : ""}"
      data-act="summary-simplify-toggle" data-value="${esc(reply.id)}"
      aria-pressed="${showing}"
      title="${showing ? "Show what the agent actually said" : "Show the simple version"}"
      aria-label="${showing ? "Show the full summary" : "Show the simple version"}">${icon("wand")}</button>`;
  }
  const busy = state.simplifying[reply.id] === true;
  return `<button type="button" class="icon-btn sm${busy ? " busy" : ""}"
    data-act="summary-simplify" data-value="${esc(reply.id)}"${busy ? " disabled" : ""}
    title="${busy ? "Simplifying…" : "Rewrite this as briefly and plainly as possible"}"
    aria-label="Simplify this summary">${icon("wand")}</button>`;
}

/**
 * The agent's own account of what it did, foldable and simplifiable.
 *
 * Folded rather than truncated: a summary is the most valuable thing in a
 * thread and cutting it off mid-sentence would be worse than either showing
 * all of it or none. Open by default — it is the answer, and a reader who has
 * to expand the answer has been given a filing cabinet rather than a reply —
 * but the choice is remembered per message, in both directions.
 */
function summaryBlock(reply, repositoryId) {
  const full = String(reply.content ?? "");
  const simple = state.simplified[reply.id];
  const showingSimple = state.simplifyShown[reply.id] === true;
  const body = showingSimple && typeof simple === "string" ? simple : full;
  const row = messageRow(
    { ...reply, content: body },
    repositoryId,
    { isReply: true, actions: simplifyAction(reply) },
  );
  if (full.length <= SUMMARY_FOLD_CHARS) {
    return row;
  }
  const firstLine = full.split(/\n/u).find((line) => line.trim().length > 0) ?? "";
  return `<details class="thread-summary"${
    state.summaryOpen[reply.id] === false ? "" : " open"
  }>
    <summary data-act="summary-toggle" data-value="${esc(reply.id)}">
      <span class="tt-label">Summary</span>
      <span class="ts-peek">${esc(
        firstLine.length > 90 ? `${firstLine.slice(0, 87)}…` : firstLine,
      )}</span>
    </summary>
    <div class="ts-body">${row}</div>
  </details>`;
}

/** The dots belong where the work is, which is inside the thread. */
function threadTyping(root) {
  const replies = root.replies ?? [];
  if (
    root.kind !== "agent" ||
    replies.length === 0 ||
    replies.some((reply) => isThreadEnding(reply))
  ) {
    return "";
  }
  return `<div class="chan-typing thread-typing">
    <span class="typing-dots" aria-label="still working"><i></i><i></i><i></i></span>
  </div>`;
}

/* ---------------------------------------------------------- code inline ---- */

/**
 * Whether this repository's workspace and changeset have been fetched.
 * The channel loads this itself now — there is no separate Code screen to
 * inherit it from, so an unloaded channel means in-flight, not "go look
 * somewhere else first".
 */
function codeDataLoadedFor(repositoryId) {
  return state.codeRepo === repositoryId && state.codeLoaded === true;
}

/**
 * A file's diff, in the panel the thread uses.
 *
 * The same column, because both answer "what is this message about" and only
 * one of them can be the answer at a time — and reading a diff should not
 * cost you sight of the conversation that explains it.
 */
function filePanel() {
  const path = state.chanFileView;
  if (path === undefined) {
    return "";
  }
  const patch = (state.changeSet?.patches ?? []).find(
    (entry) => entry.path === path,
  );
  const editing = state.chanFileMode === "edit";
  const dirty =
    editing &&
    state.chanFileDraft !== undefined &&
    state.chanFileDraft !== state.chanFileBase;
  const stats = patch === undefined ? undefined : patchStats(patch.patch);
  return `<aside class="thread-panel file-panel${dirty ? " dirty" : ""}">
    ${panelGrip()}
    <header class="thread-head">
      <span class="fp-path" title="${esc(path)}">${esc(path)}</span>
      ${
        stats === undefined
          ? ""
          : `<span class="fp-stats">
        <span class="delta-add">+${stats.additions}</span>
        <span class="delta-del">-${stats.deletions}</span>
      </span>`
      }
      <span class="spacer"></span>
      <div class="fp-modes" role="tablist">
        <button type="button" role="tab" class="${editing ? "" : "on"}"
          aria-selected="${editing ? "false" : "true"}"
          data-act="chan-file-mode" data-mode="diff"
          ${patch === undefined ? "disabled" : ""}>Diff</button>
        <button type="button" role="tab" class="${editing ? "on" : ""}"
          aria-selected="${editing ? "true" : "false"}"
          data-act="chan-file-mode" data-mode="edit">Edit</button>
      </div>
      ${iconButton("arrowLeft", {
        act: "chan-file-back",
        title: "Back to files",
      })}
      ${iconButton("close", {
        act: "chan-file-close",
        title: "Close files",
      })}
    </header>
    ${
      editing
        ? fileEditor(path)
        : `<div class="thread-body code-body">${
            patch === undefined
              ? emptyState(
                  "file",
                  "Not in this changeset",
                  "This file has no diff to show here. Edit shows what it says now.",
                )
              : renderUnified(parsePatch(patch.patch))
          }</div>`
    }
  </aside>`;
}

/**
 * The file, editable, in the panel beside the conversation.
 *
 * A plain textarea rather than a code editor, deliberately: this is for the
 * correction you make while reading a diff somebody is explaining to you, and
 * anything heavier would want the whole window and its own screen — which is
 * what Code already is.
 *
 * The text is not re-rendered while it is being typed. See the `chan-file-edit`
 * handler in `app.js` for why that matters here and not elsewhere.
 */
function fileEditor(path) {
  if (state.chanFileLoading) {
    return `<div class="thread-body fp-editor-wrap">
      <p class="fp-note">Reading ${esc(path)}…</p>
    </div>`;
  }
  if (state.chanFileError !== undefined) {
    const hasDiff = (state.changeSet?.patches ?? []).some(
      (entry) => entry.path === path,
    );
    return `<div class="thread-body fp-editor-wrap">
        <p class="fp-note err">${esc(state.chanFileError)}</p>
      </div>
      <div class="fp-actions">
        <span class="spacer"></span>
        ${
          hasDiff
            ? `<button class="btn" type="button" data-act="chan-file-mode"
                data-mode="diff">Show the diff</button>`
            : ""
        }
        <button class="btn" type="button" data-act="chan-file-reload">Try again</button>
      </div>`;
  }
  const dirty = state.chanFileDraft !== state.chanFileBase;
  return `<div class="thread-body fp-editor-wrap">
      <textarea class="fp-editor" data-act="chan-file-edit" spellcheck="false"
        wrap="off" aria-label="${esc(path)}">${esc(state.chanFileDraft ?? "")}</textarea>
    </div>
    <div class="fp-actions">
      <span class="fp-state">${dirty ? "Unsaved changes" : "No changes"}</span>
      <span class="spacer"></span>
      <button class="btn" type="button" data-act="chan-file-revert"
        ${dirty ? "" : "disabled"}>Revert</button>
      <button class="btn btn-primary" type="button" data-act="chan-file-save"
        ${dirty && !state.chanFileSaving ? "" : "disabled"}>${
          state.chanFileSaving ? "Saving…" : "Save"
        }</button>
    </div>`;
}

/**
 * This account's own connected agents that are not yet members of this
 * channel — the candidate list for "add to this chat". Membership, not mere
 * connection, is what makes an agent show up and be @mentionable in a
 * channel (see `channelAgentConnections` in server.ts), so this is
 * everything `myAgents` reports minus whatever `channelAgentsFor` already
 * carries for this account.
 */
function addableAgents(repositoryId) {
  const present = new Set(
    channelAgentsFor(repositoryId)
      .filter((agent) => agent.mine)
      .map((agent) => agent.id),
  );
  return myAgents().filter((agent) => agent.connected && !present.has(agent.id));
}

/**
 * Current per-repository grants, for the co-owner panel below.
 *
 * Read straight from `state.repositoryGrants`, populated by
 * `ensureRepositoryGrants` (see the `channel-info` action in app.js) rather
 * than fetched here — `channelInfoPopoverHtml` has to stay synchronous, the
 * same reason `channelAgentsFor` reads `state.channelRoster` instead of
 * fetching.
 */
function coOwnerPanelHtml(repositoryId) {
  const grants = state.repositoryGrants[repositoryId] ?? [];
  return `<div class="pop-block">
      <h4>Repository co-owners</h4>
      ${
        grants.length === 0
          ? `<p>No repository-scoped grants yet.</p>`
          : `<div class="pop-grant-list">
               ${grants
                 .map(
                   (grant) => `<div class="pop-grant-row">
                     <span>${esc(grant.user?.displayName ?? grant.userId)}</span>
                     <span class="pop-grant-role">${esc(grant.role)}</span>
                     ${iconButton("close", {
                       act: "channel-grant-revoke",
                       value: `${repositoryId}:${grant.userId}`,
                       title: "Revoke this grant",
                       small: true,
                     })}
                   </div>`,
                 )
                 .join("")}
             </div>`
      }
      <button type="button" class="btn btn-sm" data-act="channel-grant-promote" data-value="${esc(repositoryId)}">
        ${icon("users")} Promote a member to co-owner
      </button>
    </div>`;
}

/** The repository's own record, for the info popover's small facts. */
export function channelInfoPopoverHtml(repositoryId) {
  const repository = state.repositories.find((repo) => repo.id === repositoryId);
  const roster = channelAgentsFor(repositoryId);
  const addable = addableAgents(repositoryId);
  const canManage = canManageRepository(repositoryId);
  const canLeave = canLeaveRepository();
  return `<div class="pop-head"><h3># ${esc(repositoryId)}</h3><span class="spacer"></span>
      ${iconButton("close", { act: "pop-close", title: "Close", small: true })}</div>
    <div class="pop-block">
      <h4>Branch</h4>
      <p>${esc(repository?.branch ?? "main")}</p>
    </div>
    <div class="pop-block">
      <h4>Remote</h4>
      <p>${esc(repository?.remoteUrl ?? "No remote recorded")}</p>
    </div>
    <div class="pop-block">
      <h4>Stats</h4>
      <p>${(() => {
        const stats = state.channelStats[repositoryId];
        if (stats === undefined) {
          return "Counting…";
        }
        const fmt = (value) =>
          value >= 1_000_000
            ? `${(value / 1_000_000).toFixed(1)}M`
            : value >= 1_000
              ? `${(value / 1_000).toFixed(1)}k`
              : String(value);
        return `${stats.messages}${stats.capped ? "+" : ""} messages · ` +
          `${fmt(stats.replies)} replies · ${fmt(stats.tokens)} tokens spent`;
      })()}</p>
    </div>
    <div class="pop-block">
      <h4>Agents in this channel</h4>
      <p>${roster.map((agent) => esc(agent.name)).join(", ") || "None yet"}</p>
    </div>
    ${
      addable.length === 0
        ? ""
        : `<div class="pop-block">
             <h4>Add one of your agents</h4>
             <div class="pop-agent-add-list">
               ${addable
                 .map(
                   (agent) => `<button type="button" class="pop-agent-add"
                     data-act="channel-agent-add" data-value="${esc(agent.id)}">
                     ${agentFace(agent, 22)}
                     <span>${esc(agent.name)}</span>
                     <span class="pop-agent-add-cta">Add to this chat</span>
                   </button>`,
                 )
                 .join("")}
             </div>
           </div>`
    }
    ${canManage ? coOwnerPanelHtml(repositoryId) : ""}
    <div class="pop-block pop-block-danger">
      ${
        canManage
          ? `<button type="button" class="btn btn-sm btn-danger" data-act="channel-delete-repo" data-value="${esc(repositoryId)}">
               ${icon("close")} Delete repository
             </button>`
          : ""
      }
      ${
        canLeave
          ? `<button type="button" class="btn btn-sm" data-act="channel-leave" data-value="${esc(repositoryId)}">
               Leave this chat
             </button>`
          : ""
      }
    </div>`;
}

/* -------------------------------------------------------------- screen ---- */

export function renderChats() {
  if (state.repositories.length === 0) {
    return `<div class="chats-shell"><div class="scroll" style="flex:1"><div class="page">
      ${emptyState(
        "chatBubble",
        "No channels yet",
        "Create or connect a repository to open its channel — every repository becomes a channel here, with its agents in the roster.",
        `<button class="btn btn-primary" data-act="repo-create" style="margin-top:6px">${icon(
          "plus",
        )} Create new repository</button>`,
      )}
    </div></div></div>`;
  }
  const repository = currentRepository();
  const repositoryId = activeChannelId();

  return `<div class="chats-shell${state.chanSidebarOpen === true ? " roster-open" : ""}${state.chanCollapsed ? " chan-collapsed" : ""}">
    ${chanSidebar(repositoryId)}
    ${
      // Phone-only off-canvas drawer for `.chan-sidebar` — see the toggle
      // button in `chanHeader`. Tapping outside the drawer is how it closes,
      // the same as the outer app sidebar's `.nav-scrim`.
      state.chanSidebarOpen === true
        ? `<div class="chan-sidebar-scrim" data-act="chan-sidebar-close"></div>`
        : ""
    }
    <div class="chan-main">
      ${chanHeader(repository, repositoryId)}
      ${chanSearchRow()}
      ${pinnedBanner(repositoryId)}
      ${messageList(repositoryId)}
      ${composer(repositoryId)}
      ${state.termOpen ? terminalDrawer() : ""}
    </div>
    ${
      // A conversation opened by tapping somebody takes the panel: it is the
      // most recent thing the reader asked for, and the thread they were in
      // is still where they left it when they close this.
      state.activeAgentPanel !== undefined
        ? agentPanel()
        : state.activeDm !== undefined
        ? dmPanel()
        : state.chanFileView !== undefined
        ? filePanel()
        : state.chanTree === true
          ? chanTreePanel(repositoryId)
          : (threadPanel(repositoryId) ||
           (state.chanThreadList === true ? threadListPanel(repositoryId) : ""))
    }
  </div>`;
}

/* ------------------------------------------------------------ actions ---- */

/**
 * Whether the reader is following the conversation or reading back through it.
 *
 * Rendering replaces the transcript wholesale, which resets its scroll to the
 * top — so every re-render threw the reader back to the first message ever
 * sent, including the re-render caused by typing. Restoring the bottom
 * unconditionally would be just as wrong in the other direction: somebody
 * scrolled up reading history should stay there when a message arrives.
 */
let followingChannel = true;
const FOLLOW_SLACK_PX = 80;

export function scrollChannel() {
  const list = document.querySelector("#chan-messages");
  if (list !== null) {
    list.scrollTop = list.scrollHeight;
    followingChannel = true;
  }
}

/**
 * Puts the transcript back where the reader had it, after a render replaced
 * it. Called with the new DOM in place.
 */
export function restoreChannelScroll() {
  const list = document.querySelector("#chan-messages");
  if (list === null) {
    return;
  }
  // A requested jump outranks following: the reader asked for one message,
  // and snapping to the bottom over it would answer a different question.
  // One-shot, and following turns off so the next arriving message does not
  // yank them away mid-read; scrolling back down re-arms it as always.
  if (state.scrollToMessage !== undefined) {
    const target = document.getElementById(`cmsg-${state.scrollToMessage}`);
    state.scrollToMessage = undefined;
    if (target !== null) {
      followingChannel = false;
      target.scrollIntoView({ block: "center" });
      return;
    }
    toast("That message is older than the loaded history", "error");
  }
  if (followingChannel) {
    list.scrollTop = list.scrollHeight;
  }
  if (list.dataset.followBound === "1") {
    return;
  }
  list.dataset.followBound = "1";
  list.addEventListener("scroll", () => {
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    followingChannel = distance <= FOLLOW_SLACK_PX;
  });
}

export function openChannel(repositoryId, rerender) {
  state.repositoryId = repositoryId;
  persist("ag.repo", repositoryId);
  markChannelRead(repositoryId);
  // Picking a channel from the phone drawer is how it closes — the drawer
  // has no separate close button, matching the outer nav's scrim-only
  // dismissal, and "you just navigated somewhere" is itself a close.
  state.chanSidebarOpen = false;
  state.activeChannelThread = undefined;
  // A thread belongs to the channel it hangs in, so an aim taken in one
  // channel must not follow the reader into the next and post there.
  state.composerThreadId = undefined;
  // Another channel's expanded diffs are not this channel's; collapse them so
  // the transcript opens scannable rather than mid-review.
  state.chanOpenFiles = [];
  state.chanFileView = undefined;
  state.chatRenamingId = undefined;
  state.chatSettingsOpenId = undefined;
  rerender();
  scrollChannel();
}

export function submitComposerMessage(rerender) {
  chime("sent");
  const repositoryId = activeChannelId();
  if (!repositoryId) {
    return;
  }
  // Aimed at an existing thread rather than the channel, because the person
  // said so. Follow-up work that belongs to a task already being tracked
  // should land in that task's thread instead of opening a second one about
  // the same thing — and the reply path already dispatches work into the
  // thread it arrived in, so this needs nothing further to route.
  const continuing = state.composerThreadId;
  if (continuing !== undefined) {
    const posted = postChannelReply(repositoryId, continuing, state.chatDraft);
    if (posted === undefined) {
      return;
    }
    state.chatDraft = "";
    state.mentionActive = false;
    markChannelRead(repositoryId);
    rerender();
    return;
  }
  const sent = sendChannelMessage(repositoryId, state.chatDraft, "user");
  if (sent === undefined) {
    return;
  }
  state.chatDraft = "";
  state.mentionActive = false;
  markChannelRead(repositoryId);
  rerender();
  scrollChannel();
}

/**
 * What this channel has decided not to lose, in a strip above the messages.
 *
 * The banner reads from the server-fed pinned list rather than the loaded
 * transcript, because a pin exists precisely so a message survives the room
 * moving on — a banner that only knew the current page would forget exactly
 * the pins it was for. Collapsible to one line, because pins are a shelf,
 * not a second conversation.
 */
function pinnedBanner(repositoryId) {
  const pins = state.channelPins[repositoryId] ?? [];
  if (pins.length === 0) {
    // The same no-op the search row uses, so the column's child list keeps
    // its shape whether or not anything is pinned.
    return `<div hidden></div>`;
  }
  const open = state.pinsOpen === true;
  return `<div class="chan-pins">
    <button type="button" class="chan-pins-head" data-act="channel-pins-toggle"
      aria-expanded="${open}">
      ${icon("pin")}
      <span>${pins.length} pinned</span>
      <span class="spacer"></span>
      ${icon(open ? "chevronUp" : "chevronDown")}
    </button>
    ${
      !open
        ? ""
        : `<div class="chan-pins-list">${pins
            .map((entry) => {
              const title = threadTitle(entry) || "(no text)";
              const pinner =
                entry.pinnedBy === undefined
                  ? "someone"
                  : (memberName(entry.pinnedBy) ?? entry.pinnedBy);
              return `<div class="chan-pin-row">
                <button type="button" class="chan-pin-jump"
                  data-act="channel-pin-jump" data-value="${esc(entry.id)}"
                  title="Pinned by ${esc(pinner)}">
                  <span class="cp-title">${esc(title)}</span>
                  <span class="cp-time">${esc(clockTime(entry.at ?? entry.createdAt))}</span>
                </button>
                ${iconButton("close", {
                  act: "channel-pin",
                  value: entry.id,
                  title: "Unpin",
                  small: true,
                })}
              </div>`;
            })
            .join("")}</div>`
    }
  </div>`;
}

/**
 * The line naming the thread the next message will join.
 *
 * Deliberately loud and dismissable: a composer that silently posts somewhere
 * other than the channel it is sitting under would be a trap, and the whole
 * value of merging by hand is that it is never a guess.
 */
function composerThreadChip(repositoryId) {
  const messageId = state.composerThreadId;
  if (messageId === undefined) {
    return "";
  }
  const root = channelMessagesFor(repositoryId).find(
    (entry) => entry.id === messageId,
  );
  if (root === undefined) {
    return "";
  }
  const title = threadTitle(root);
  return `<div class="composer-thread">
    ${icon("reply")}
    <span class="ct-label">Continuing in</span>
    <span class="ct-title" title="${esc(title)}">${esc(title.slice(0, 70))}</span>
    <span class="spacer"></span>
    ${iconButton("close", {
      act: "composer-thread-clear",
      title: "Post to the channel instead",
      small: true,
    })}
  </div>`;
}

export function submitThreadReply(rerender) {
  chime("sent");
  if (state.activeChannelThread === undefined) {
    return;
  }
  postChannelReply(activeChannelId(), state.activeChannelThread, state.threadDraft);
  state.threadDraft = "";
  rerender();
}

function updateMentionState(node) {
  const value = node.value;
  const cursor = node.selectionStart ?? value.length;
  const before = value.slice(0, cursor);
  // A command is only ever the first thing in a message — the same rule the
  // server parses by — so the picker only offers one there. Anchoring it
  // here as well is what stops a path typed mid-sentence from opening a
  // menu over the composer.
  const slash = /^\s*\/([a-z0-9-]*)$/iu.exec(before);
  state.slashActive = slash !== null;
  if (slash !== null) {
    state.slashQuery = slash[1] ?? "";
    state.slashIndex = 0;
    // One picker at a time: a bare "/" is never also a mention.
    state.mentionActive = false;
    state.mentionQuery = "";
    return;
  }
  const match = /(^|\s)@([\w.-]*)$/u.exec(before);
  if (match === null) {
    state.mentionActive = false;
    state.mentionQuery = "";
    return;
  }
  state.mentionActive = true;
  state.mentionQuery = match[2];
  state.mentionIndex = 0;
}

export function updateComposerInput(node, rerender) {
  state.chatDraft = node.value;
  // What the screen actually shows about a draft is the mention popup and
  // nothing else: the send button is always enabled, and the textarea already
  // holds the character that was just typed. So a render is only owed when
  // that popup would change.
  //
  // It used to happen on every keystroke, and a render here is not cheap — it
  // rebuilds the whole app, destroying the textarea being typed into, then
  // finds its replacement, refocuses it and restores the selection. With a
  // long transcript behind it that is the latency between pressing a key and
  // seeing the letter, on the one screen where responsiveness is the entire
  // experience.
  // Both pickers, not just the mention one: a render is owed whenever either
  // popup would change, and tracking only the first would leave the command
  // list frozen — or absent — while somebody types into it.
  const popupState = () =>
    `${String(state.mentionActive)} ${state.mentionQuery} ` +
    `${String(state.slashActive)} ${state.slashQuery}`;
  const before = popupState();
  updateMentionState(node);
  const changed = popupState() !== before;
  // The height is a property of this element, not of the app, so it is set
  // directly whether or not anything else is rebuilt.
  node.style.height = "auto";
  node.style.height = `${Math.min(node.scrollHeight, 148)}px`;
  if (!changed) {
    return;
  }
  const selStart = node.selectionStart;
  const selEnd = node.selectionEnd;
  rerender();
  const next = document.querySelector("[data-act='channel-input']");
  if (next !== null) {
    next.focus();
    next.setSelectionRange(selStart, selEnd);
    next.style.height = "auto";
    next.style.height = `${Math.min(next.scrollHeight, 148)}px`;
  }
}

/**
 * Puts the chosen command in, and leaves the cursor where the request goes.
 *
 * A trailing space rather than a newline: the command is the start of a
 * sentence that usually continues with an "@" and an objective, and the
 * mention picker is what should open next.
 */
export function pickSlashCommand(name, rerender) {
  const node = document.querySelector("[data-act='channel-input']");
  const cursor = node?.selectionStart ?? state.chatDraft.length;
  const before = state.chatDraft.slice(0, cursor);
  const after = state.chatDraft.slice(cursor);
  const replaced = before.replace(/^\s*\/([a-z0-9-]*)$/iu, `/${name} `);
  state.chatDraft = replaced + after;
  state.slashActive = false;
  state.slashQuery = "";
  rerender();
  const next = document.querySelector("[data-act='channel-input']");
  if (next !== null) {
    const pos = replaced.length;
    next.focus();
    next.setSelectionRange(pos, pos);
  }
}

export function pickMention(name, rerender) {
  const node = document.querySelector("[data-act='channel-input']");
  const cursor = node?.selectionStart ?? state.chatDraft.length;
  const before = state.chatDraft.slice(0, cursor);
  const after = state.chatDraft.slice(cursor);
  const replaced = before.replace(/@([\w.-]*)$/u, `@${name} `);
  state.chatDraft = replaced + after;
  state.mentionActive = false;
  rerender();
  const next = document.querySelector("[data-act='channel-input']");
  if (next !== null) {
    const pos = replaced.length;
    next.focus();
    next.setSelectionRange(pos, pos);
  }
}

/** How many transcript entries the drawer keeps before dropping the oldest. */
const TERM_LOG_LIMIT = 300;

/** Small enough to still show the prompt and a line; the ceiling is the
    column's own height, applied at drag time since it varies. */
const TERM_MIN_HEIGHT = 120;

function clampTermHeight(px, columnHeight) {
  const ceiling = Math.max(TERM_MIN_HEIGHT, Math.round(columnHeight * 0.85));
  return Math.min(ceiling, Math.max(TERM_MIN_HEIGHT, Math.round(px)));
}

/**
 * Drags the drawer's top edge.
 *
 * Sized against the conversation column rather than the viewport, because
 * that is what the drawer is positioned inside -- measuring the window would
 * let it be dragged taller than the space it can occupy. The height is
 * written straight to the node during the drag and only committed to state
 * on release: re-rendering the channel on every pointer move would rebuild
 * the message list for each pixel.
 */
export function startTerminalResize(event, rerender) {
  const drawer = event.target.closest(".term-drawer");
  const column = drawer?.parentElement;
  if (drawer == null || column == null) {
    return;
  }
  event.preventDefault();
  const columnHeight = column.getBoundingClientRect().height;
  const startY = event.clientY;
  const startHeight = drawer.getBoundingClientRect().height;
  const onMove = (move) => {
    // Upward drag is a negative delta and should grow the drawer.
    const next = clampTermHeight(startHeight - (move.clientY - startY), columnHeight);
    drawer.style.height = `${next}px`;
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.classList.remove("resizing-ns");
    state.termHeight = Math.round(drawer.getBoundingClientRect().height);
    persist("ag.termHeight", state.termHeight);
    rerender();
  };
  document.body.classList.add("resizing-ns");
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/** Keyboard equivalent of the drag, so the grip is not mouse-only. */
export function nudgeTerminalHeight(event, rerender) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    return;
  }
  event.preventDefault();
  const column = document.querySelector(".chan-main");
  const columnHeight = column?.getBoundingClientRect().height ?? 600;
  const step = event.key === "ArrowUp" ? 32 : -32;
  state.termHeight = clampTermHeight(state.termHeight + step, columnHeight);
  persist("ag.termHeight", state.termHeight);
  rerender();
  document.querySelector("[data-act='chan-term-resize']")?.focus();
}

function termPush(entry) {
  state.termLog.push(entry);
  if (state.termLog.length > TERM_LOG_LIMIT) {
    state.termLog.splice(0, state.termLog.length - TERM_LOG_LIMIT);
  }
}

/**
 * Runs whatever is in the terminal drafts against the repository's overlay.
 *
 * Every outcome is written into the transcript rather than raised as a toast:
 * a terminal that reports failure somewhere other than the terminal is
 * hard to read back afterwards, and the whole point of the log is that the
 * command and its result sit together.
 */
export async function runTerminalCommand(rerender) {
  const command = state.termDraft.trim();
  const repository = currentRepository();
  if (command === "" || state.termBusy) {
    return;
  }
  if (repository === undefined) {
    return;
  }
  if (command === "clear" || command === "cls") {
    state.termLog = [];
    state.termDraft = "";
    rerender();
    focusTerminalInput();
    return;
  }
  termPush({ kind: "command", text: command });
  state.termPast.push(command);
  state.termSeek = undefined;
  state.termDraft = "";
  state.termBusy = true;
  rerender();
  try {
    const project = encodeURIComponent(state.projectId);
    const repo = encodeURIComponent(repository.id);
    const response = await api(
      `/projects/${project}/repositories/${repo}/workspace/exec`,
      { method: "POST", body: { command } },
    );
    const result = response.result ?? {};
    const text = [result.stdout ?? "", result.stderr ?? ""]
      .filter((part) => part !== "")
      .join("\n");
    const failed = result.exitCode !== 0;
    if (text.trim() !== "") {
      termPush({ kind: "output", text: text.replace(/\n+$/u, ""), bad: failed });
    }
    if (result.timedOut === true) {
      termPush({ kind: "note", text: "Timed out and was killed." });
    } else if (failed) {
      termPush({ kind: "note", text: `exited ${result.exitCode}` });
    }
  } catch (error) {
    // 501 is the sandbox refusing rather than the command failing, and it is
    // the one a person is most likely to hit first, so it says what to do.
    termPush({
      kind: "note",
      text:
        error.status === 501
          ? "No Docker sandbox is configured for this project, so the terminal is disabled. Set sandbox.mode in .coordinator/config.json and restart the server."
          : error.message,
    });
  } finally {
    state.termBusy = false;
    rerender();
    focusTerminalInput();
  }
}

function focusTerminalInput() {
  const input = document.querySelector("[data-act='chan-term-input']");
  if (input === null) {
    return;
  }
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  const body = document.querySelector("[data-term-body]");
  if (body !== null) {
    body.scrollTop = body.scrollHeight;
  }
}

/**
 * Up and Down walk previously run commands, the way a shell does.
 *
 * Walking past the newest entry returns to whatever was being typed rather
 * than sticking on the last command, so Down is always a way back out.
 */
export function handleTerminalKeydown(event, rerender) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    return;
  }
  const past = state.termPast;
  if (past.length === 0) {
    return;
  }
  event.preventDefault();
  const seek = state.termSeek;
  if (event.key === "ArrowUp") {
    state.termSeek = seek === undefined ? past.length - 1 : Math.max(0, seek - 1);
  } else if (seek === undefined || seek >= past.length - 1) {
    state.termSeek = undefined;
  } else {
    state.termSeek = seek + 1;
  }
  state.termDraft = state.termSeek === undefined ? "" : past[state.termSeek];
  rerender();
  focusTerminalInput();
}

export function handleComposerKeydown(event, rerender) {
  // The same four keys as the mention picker, because they are the same
  // gesture — a list under the cursor that Up/Down move through, Enter or Tab
  // accepts, and Escape dismisses. Handled first, and only one picker is ever
  // open at a time (see `updateMentionState`), so the two cannot both claim
  // an Enter.
  if (state.slashActive) {
    const list = channelSlashCandidates(activeChannelId());
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.slashIndex = list.length === 0 ? 0 : (state.slashIndex + 1) % list.length;
      rerender();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.slashIndex =
        list.length === 0 ? 0 : (state.slashIndex - 1 + list.length) % list.length;
      rerender();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && list.length > 0) {
      event.preventDefault();
      pickSlashCommand(list[state.slashIndex % list.length].name, rerender);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      state.slashActive = false;
      rerender();
      return;
    }
  }
  if (state.mentionActive) {
    const list = channelMentionCandidates(activeChannelId());
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.mentionIndex = list.length === 0 ? 0 : (state.mentionIndex + 1) % list.length;
      rerender();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.mentionIndex =
        list.length === 0 ? 0 : (state.mentionIndex - 1 + list.length) % list.length;
      rerender();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && list.length > 0) {
      event.preventDefault();
      pickMention(list[state.mentionIndex % list.length].name, rerender);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      state.mentionActive = false;
      rerender();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitComposerMessage(rerender);
  }
}
