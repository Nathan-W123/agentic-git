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
  canLeaveRepository,
  canManageRepository,
  channelAgentsFor,
  channelAuthor,
  channelMessagesFor,
  typingOn,
  agentsThinkingIn,
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
} from "./data.js";
import {
  FLAG_FOR_STATUS,
  buildTree,
  changeSetStats,
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
  searchBox,
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
function personRow(person) {
  const name = person.user?.displayName ?? person.user?.email ?? "Someone";
  const role = String(person.role ?? "").trim();
  return `<div class="roster-row">
    <div class="roster-row-main">
      <span class="rr-avatar">${avatar(name, 30)}</span>
      <span class="rr-body">
        <div class="rr-name">${esc(name)}</div>
        <div class="rr-role${role ? "" : " rr-role-empty"}">${
          role === "" ? "No role set" : esc(role)
        }</div>
      </span>
    </div>
  </div>`;
}

function rosterRow(agent, canModerate) {
  const renaming = state.chatRenamingId === agent.id;
  const settingsOpen = state.chatSettingsOpenId === agent.id;
  return `<div class="roster-row">
    <div class="roster-row-main" role="button" tabindex="0"
      data-act="channel-settings-toggle" data-value="${esc(agent.id)}">
      <span class="rr-avatar" data-hover="agent-usage"
        data-hover-value="${esc(agent.id)}">
        ${usageTip(agent)}
        ${agentFace(agent, 30)}
      </span>
      <span class="rr-body">
        <div class="rr-name">${esc(agent.name)}</div>
        <div class="rr-role${agent.role ? "" : " rr-role-empty"}">${
          agent.role
            ? `${esc(agent.role)}${agent.mine ? " · Your agent" : ""}`
            : agent.mine
              ? "Your agent · no role set"
              : "No role set"
        }</div>
      </span>
      <span class="rr-actions">
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
              value="${esc(agent.role ?? "")}" placeholder="Role in this channel" autocomplete="off">
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
  const people = state.members ?? [];

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

function chanHeader(repository, repositoryId) {
  const roster = channelAgentsFor(repositoryId);
  const people = collaborators();
  const faces = roster.slice(0, 3).map((agent) => agentFace(agent, 24)).join("");
  return `<header class="chan-head">
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
    <span class="avatar-stack">${faces}${avatarStack(people, 3, 24)}</span>
    <button type="button" class="icon-btn${state.chanThreadList === true ? " on" : ""}"
      data-act="chan-tree-toggle" title="Files"
      aria-pressed="${state.chanTree === true}">${icon("folder")}</button>
    <button type="button" class="icon-btn${state.chanThreadList === true ? " on" : ""}"
      data-act="channel-threads-toggle" title="Threads"
      aria-pressed="${state.chanThreadList === true}">${icon("reply")}</button>
    <button type="button" class="icon-btn${state.chanMsgSearchOpen ? " on" : ""}"
      data-act="channel-msg-search-toggle" title="Search messages"
      aria-pressed="${state.chanMsgSearchOpen}">${icon("search")}</button>
    ${iconButton("info", { act: "channel-info", value: repositoryId ?? "", title: "Channel info" })}
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

function messageRow(entry, repositoryId, { isReply = false } = {}) {
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
  return `<div class="cmsg-row">
    <span class="cmsg-avatar">${
      author.agent !== undefined ? agentFace(author.agent, 32) : avatar(author.name, 32)
    }</span>
    <div class="cmsg-body">
      <div class="cmsg-top">
        <span class="cmsg-name${author.agent !== undefined ? " agent-name" : ""}">${esc(
          author.name,
        )}</span>
        <span class="cmsg-time">${esc(clockTime(entry.at))}</span>
      </div>
      <div class="cmsg-text">${esc(entry.content)}</div>
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
        replies.length === 0
          ? ""
          : `<button type="button" class="cmsg-thread-link" data-act="channel-thread-open"
              data-value="${esc(entry.id)}">${icon("reply")} ${replies.length} repl${
                replies.length === 1 ? "y" : "ies"
              }</button>`
      }
    </div>
    <span class="cmsg-actions">
      ${iconButton("smile", { act: "channel-react", value: entry.id, title: "React", small: true })}
      ${
        isReply
          ? ""
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
    )}${codeBlocks(repositoryId)}${typingIndicator(repositoryId, undefined)}</div>`;
  }
  let lastDay = "";
  const rows = entries.map((entry) => {
    const day = new Date(entry.at ?? Date.now()).toDateString();
    let separator = "";
    if (day !== lastDay) {
      lastDay = day;
      const isToday = day === new Date().toDateString();
      separator = `<div class="chan-day">${isToday ? "Today" : esc(day)}</div>`;
    }
    return separator + messageRow(entry, repositoryId);
  });
  return `<div class="chan-messages" id="chan-messages">${rows.join(
    "",
  )}${codeBlocks(repositoryId)}${typingIndicator(repositoryId, undefined)}</div>`;
}

/**
 * The lines that end a thread, as the server writes them.
 *
 * Matched here rather than carried as a flag because the thread already says
 * this: an agent that has reported finishing has finished. A separate status
 * field would be a second source of truth that could disagree with what the
 * channel is actually showing.
 */
const THREAD_FINISHED_RE = /^(Done —|I could not|This was cancelled)/u;

function channelMentionCandidates(repositoryId) {
  const query = state.mentionQuery.trim().toLowerCase();
  return channelParticipants(repositoryId)
    .filter((entry) => query === "" || entry.name.toLowerCase().includes(query))
    .slice(0, 6);
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
        ${entry.kind === "agent" ? agentFace(entry.agent, 20) : avatar(entry.name, 20)}
        <span>${esc(entry.name)}</span>
        <span class="mi-kind">${entry.kind === "agent" ? "agent" : ""}</span>
      </button>`,
    )
    .join("")}</div>`;
}

function composer(repositoryId) {
  const candidates = state.mentionActive ? channelMentionCandidates(repositoryId) : [];
  return `<div class="chan-composer-wrap">
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
  const threads = channelMessagesFor(repositoryId)
    .filter((entry) => (entry.replies ?? []).length > 0)
    .slice()
    .reverse();
  return `<aside class="thread-panel">
    ${panelGrip()}
    <header class="thread-head">
      <span>Threads</span>
      <span class="spacer"></span>
      ${iconButton("close", { act: "channel-threads-close", title: "Close" })}
    </header>
    <div class="thread-body">
      ${
        threads.length === 0
          ? `<div class="util-empty">No threads yet. A thread appears when an agent has more than one thing to say about a task.</div>`
          : threads
              .map((entry) => {
                const count = (entry.replies ?? []).length;
                const author = channelAuthor(repositoryId, entry);
                return `<button type="button" class="thread-item"
                  data-act="channel-thread-open" data-value="${esc(entry.id)}">
                  <span class="ti-top">
                    <span class="ti-who">${esc(author.name)}</span>
                    <span class="ti-time">${esc(clockTime(entry.at))}</span>
                  </span>
                  <span class="ti-text">${esc(entry.content)}</span>
                  <span class="ti-count">${count} repl${count === 1 ? "y" : "ies"}</span>
                </button>`;
              })
              .join("")
      }
    </div>
  </aside>`;
}

function threadPanel(repositoryId) {
  const messageId = state.activeChannelThread;
  if (messageId === undefined) {
    return "";
  }
  const root = channelMessagesFor(repositoryId).find((entry) => entry.id === messageId);
  if (root === undefined) {
    return "";
  }
  return `<aside class="thread-panel">
    ${panelGrip()}
    <header class="thread-head">
      <span>Thread</span>
      <span class="spacer"></span>
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
  const isThinking = (reply) =>
    reply.kind === "agent" && !THREAD_FINISHED_RE.test(String(reply.content ?? "").trim());
  const finishedAt = replies.findIndex((reply) =>
    THREAD_FINISHED_RE.test(String(reply.content ?? "").trim()),
  );
  const done = finishedAt !== -1;
  // The title line names the task and is not commentary; it stays out.
  const [first, ...rest] = replies;
  const titleLine = /^Task: /u.test(String(first?.content ?? "")) ? first : undefined;
  const body = titleLine === undefined ? replies : rest;
  const steps = body.filter(isThinking);
  const outcome = body.filter((reply) => !isThinking(reply));

  const count = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return `
    ${titleLine === undefined ? "" : messageRow(titleLine, repositoryId, { isReply: true })}
    ${
      steps.length === 0
        ? ""
        : `<details class="thread-thinking"${done ? "" : " open"}>
             <summary><span class="tt-label">Thinking</span>
               <span class="tt-count">${esc(count)}</span></summary>
             ${steps.map((reply) => messageRow(reply, repositoryId, { isReply: true })).join("")}
           </details>`
    }
    ${outcome.map((reply) => messageRow(reply, repositoryId, { isReply: true })).join("")}`;
}

/** The dots belong where the work is, which is inside the thread. */
function threadTyping(root) {
  const replies = root.replies ?? [];
  if (
    root.kind !== "agent" ||
    replies.length === 0 ||
    replies.some((reply) => THREAD_FINISHED_RE.test(String(reply.content ?? "").trim()))
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
 * One file, inline in the transcript.
 *
 * Collapsed it is a single line — flag, path, and the +/- it carries — which
 * is all a reader scanning the conversation needs. Expanding it reveals the
 * recorded patch in place, so reviewing a change never leaves the channel.
 */
function codeBlock(patch) {
  const stats = patchStats(patch.patch);
  const flag = FLAG_FOR_STATUS[patch.status] ?? "M";
  const active = state.chanFileView === patch.path;
  return `<div class="cblock${active ? " active" : ""}">
    <button type="button" class="cblock-head" data-act="chan-file-open"
      data-value="${esc(patch.path)}">
      <span class="cblock-flag flag-${flag}">${flag}</span>
      <span class="cblock-path">${esc(patch.path)}</span>
      <span class="cblock-stats">
        <span class="delta-add">+${stats.additions}</span>
        <span class="delta-del">-${stats.deletions}</span>
      </span>
    </button>
  </div>`;
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
      ${iconButton("folder", {
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
 * The changeset, rendered into the conversation rather than beside it.
 *
 * This sits at the end of the transcript because that is where the work
 * landed: the agent said what it did, and the files it touched follow, in the
 * same column, in the same reading order.
 */
function codeBlocks(repositoryId) {
  if (!codeDataLoadedFor(repositoryId)) {
    return "";
  }
  const patches = state.changeSet?.patches ?? [];
  if (patches.length === 0) {
    return "";
  }
  const stats = changeSetStats(state.changeSet);
  // Folded by default. A changeset of fifty files is a footnote to the
  // conversation, not the conversation — and it used to push every message
  // out of view. Opening one now happens beside the transcript, so the
  // messages that explain the change stay readable next to it.
  return `<details class="cblocks"${state.chanFilesOpen ? " open" : ""}
    data-act="chan-files-toggle">
    <summary class="cblocks-head">
      ${icon("git")}
      <span>${patches.length} file${patches.length === 1 ? "" : "s"} changed</span>
      <span class="delta-add">+${stats.additions}</span>
      <span class="delta-del">-${stats.deletions}</span>
    </summary>
    ${patches.map((patch) => codeBlock(patch)).join("")}
  </details>`;
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

  return `<div class="chats-shell">
    ${chanSidebar(repositoryId)}
    <div class="chan-main">
      ${chanHeader(repository, repositoryId)}
      ${chanSearchRow()}
      ${messageList(repositoryId)}
      ${composer(repositoryId)}
    </div>
    ${
      state.chanFileView !== undefined
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
  const title = String(
    (root.replies ?? []).find((reply) => /^Task: /u.test(String(reply.content ?? "")))
      ?.content ?? root.content,
  )
    .replace(/^Task: /u, "")
    .replace(/\s+/gu, " ")
    .trim();
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
  updateMentionState(node);
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

export function handleComposerKeydown(event, rerender) {
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
