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
  activeChannelId,
  activeTasks,
  agentStatus,
  agentsThinkingIn,
api,
  canDeleteChannelEntry,
  canLeaveRepository,
  canManageRepository,
  channelAgentsFor,
  channelAuthor,
  channelAwaitsGoAhead,
  channelMessagesFor,
  channelDraft,
  channelNewSince,
  channelParticipants,
  channelUnreadCount,
  channelUnreadMark,
  collaborators,
  currentUserId,
  currentUserName,
  dmUnreadFrom,
  flushChannelDrafts,
  markChannelRead,
  memberName,
  myAgents,
  myAvatar,
  pendingQuestionFor,
  persist,
  personOnline,
  phoneLayout,
  postChannelReply,
  providerEffortOptions,
  providerModelOptions,
  providerOptionsNote,
  saveChannelDraft,
  sendChannelMessage,
  snapshotChannelRead,
  state,
  taskBelongsToAgent,
  threadAwaitsGoAhead,
  threadIsWorking,
  threadTitle,
  threadTitleReply,
  typingOn,
  waitingTasks,
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
  agentLabelOf,
  brandMark,
  avatar,
  chime,
  clockTime,
  esc,
  icon,
  iconButton,
  imeComposing,
  emptyState,
  miniSelect,
  relativeTime,
  searchBox,
  showPopover,
  toast,
} from "./ui.js";

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
  const mentions = channelUnreadCount(repo.id, { mentionsOnly: true });
  const active = repo.id === activeRepositoryId;
  // A room where something has stopped for a person. Unread says "there are
  // words you have not read"; this says "nothing here moves until you answer",
  // which is the one thing a reader cannot discover by not opening the room.
  const held = channelAwaitsGoAhead(repo.id);
  return `<div class="chan-row${active ? " active" : ""}${
    unread > 0 ? " unread" : ""
  }" role="button" tabindex="0" data-act="channel-open" data-value="${esc(repo.id)}"
    title="#${esc(repo.id)}" aria-label="Open channel ${esc(repo.id)}"${
      active ? ' aria-current="page"' : ""
    }>
    <span class="cr-hash">${icon("chatBubble")}</span>
    <span class="cr-name">${esc(repo.id)}</span>
    ${
      held
        ? `<span class="cr-held" title="An agent here is waiting for your go-ahead"><span class="sr-only">Waiting for you</span></span>`
        : ""
    }
    ${
      unread > 0
        ? `<span class="cr-badge" title="${
            mentions > 0 ? `${mentions} unread mention${mentions === 1 ? "" : "s"}` : `${unread} unread`
          }">${mentions > 0 ? "@" : unread > 99 ? "99+" : unread}</span>`
        : ""
    }
    <span class="cr-more">${iconButton("dots", {
      act: "channel-menu",
      value: repo.id,
      title: `More for #${repo.id}`,
      small: true,
    })}</span>
  </div>`;
}

/**
 * "in 3 hours", from the reset time the CLI reported.
 *
 * The formatted `resetsAt` string is made server-side, in the server's zone,
 * so a reader in another zone gets a clock time that is not theirs. The raw
 * seconds-since-epoch beside it is zone-free, and how long until the quota
 * comes back is the question a person actually has. Empty when the CLI gave
 * no reset time, or when the moment has already passed and the number would
 * only be stale.
 */
function usageResetsIn(window) {
  const at = Number(window?.resetsAtEpoch);
  if (!Number.isFinite(at) || at <= 0) {
    return "";
  }
  const seconds = (at * 1000 - Date.now()) / 1000;
  if (seconds <= 0) {
    return "";
  }
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `in ${minutes} min`;
  }
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600);
    return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(seconds / 86_400);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** "Resets Jul 29, 10:59am · in 3 hours", with either half allowed to be missing. */
function usageResetText(window) {
  const when = window?.resetsAt;
  const soon = usageResetsIn(window);
  if (when === undefined || when === null || when === "") {
    return soon === "" ? "" : `Resets ${soon}`;
  }
  return soon === "" ? `Resets ${when}` : `Resets ${when} · ${soon}`;
}

/**
 * The plan and any credit balance, which are facts about the account rather
 * than about one window. Codex reports both; the other CLIs report neither,
 * and this renders nothing at all for them rather than an empty row.
 */
function usageAccountLine(report) {
  const parts = [];
  if (typeof report?.planType === "string" && report.planType.trim() !== "") {
    parts.push(`${report.planType.trim()} plan`);
  }
  // `typeof`, not `Number()`: a null balance coerces to 0, and "0 credits" is
  // a claim the CLI never made.
  const credits = report?.creditBalance;
  if (typeof credits === "number" && Number.isFinite(credits)) {
    parts.push(
      `${credits.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })} credits`,
    );
  }
  return parts.join(" · ");
}

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
          usageResetText(window) === ""
            ? ""
            : `<div class="rr-usage-reset">${esc(usageResetText(window))}</div>`
        }`;
      })
      .join("")}
      ${
        usageAccountLine(report) === ""
          ? ""
          : `<div class="rr-usage-plan">${esc(usageAccountLine(report))}</div>`
      }
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
 * The shape of every attachment this browser has already drawn once.
 *
 * A picture has no size until its bytes arrive, and the whole screen is one
 * `innerHTML` assignment — so every render throws away the `<img>` that had
 * already decoded and builds a fresh one that has not. The transcript then
 * laid every image out at the stylesheet's guessed 4/3 box and snapped it to
 * the real shape a moment later, once per render, for every picture on
 * screen. A background frame arriving while somebody read or typed is what
 * that looked like from the outside: the conversation jumping under them.
 *
 * The fix is to stop guessing. The first decode is measured and kept here,
 * and every render after it hands the browser the true ratio in the markup,
 * so the box is right in the first frame and never moves. Attachment ids are
 * content-addressed and their bytes are immutable, so a remembered size can
 * never be wrong for the id it was measured on — which is what makes this
 * safe to keep in `localStorage` and reuse across reloads.
 */
const IMAGE_SIZE_KEY = "ag.image-sizes";

/**
 * Enough for any transcript somebody is actually reading, and small enough
 * that the entry never grows without bound. `Map` iterates in insertion
 * order, so the oldest measurement is the one that goes.
 */
const IMAGE_SIZE_LIMIT = 400;

const RATIO_PATTERN = /^[1-9][0-9]{0,4} \/ [1-9][0-9]{0,4}$/u;

const imageSizes = new Map(
  (() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(IMAGE_SIZE_KEY) ?? "[]",
      );
      return Array.isArray(saved)
        ? saved.filter(
            (entry) =>
              Array.isArray(entry) &&
              typeof entry[0] === "string" &&
              typeof entry[1] === "string" &&
              // Read back into a `style` attribute, so it is checked on the
              // way in rather than trusted because this app wrote it: another
              // script on the origin can put anything under this key.
              RATIO_PATTERN.test(entry[1]),
          )
        : [];
    } catch {
      return [];
    }
  })(),
);

/**
 * Measures one decoded attachment, and says whether that was news.
 *
 * "News" is what the callers act on: an image whose real shape differed from
 * the box reserved for it has just changed the height of everything below it,
 * and that is the moment a reader needs putting back where they were.
 */
function rememberImageSize(node) {
  const id = node?.dataset?.attachment;
  const width = node?.naturalWidth ?? 0;
  const height = node?.naturalHeight ?? 0;
  if (id === undefined || width < 1 || height < 1) {
    return false;
  }
  const ratio = `${String(width)} / ${String(height)}`;
  if (imageSizes.get(id) === ratio) {
    return false;
  }
  imageSizes.set(id, ratio);
  while (imageSizes.size > IMAGE_SIZE_LIMIT) {
    imageSizes.delete(imageSizes.keys().next().value);
  }
  try {
    persist(IMAGE_SIZE_KEY, JSON.stringify([...imageSizes]));
  } catch {
    // A full or blocked store is not worth losing the render over. The map
    // still holds the measurement for the rest of this session.
  }
  return true;
}

/**
 * One attachment, in a box the browser can lay out before it has the bytes.
 *
 * The ratio goes in the `style` attribute rather than the stylesheet because
 * it is per-image; the stylesheet keeps the 4/3 fallback for the one render
 * that happens before anything has been measured. An inline `aspect-ratio`
 * has no `auto` keyword in it on purpose — the measured numbers *are* the
 * natural ratio, so letting the decode override them again is the shift this
 * is here to remove.
 *
 * `loading="lazy"` stays on exactly the images nobody has measured yet. A
 * lazy image that has never been seen is a zero-cost placeholder; a lazy
 * image that has been seen is a picture the reader already has in cache, and
 * deferring it only buys a blank box where the bytes were ready.
 */
function attachmentImage(base, image) {
  const ratio = imageSizes.get(image.id);
  return `<a class="cmsg-image" href="${esc(base + image.id)}" target="_blank"
             rel="noopener noreferrer"><img src="${esc(base + image.id)}"
             alt="${esc(image.alt)}" data-attachment="${esc(image.id)}"
             decoding="async"${ratio === undefined ? ' loading="lazy"' : ""}
             ${ratio === undefined ? "" : `style="aspect-ratio: ${esc(ratio)}"`}></a>`;
}

/**
 * The three helpers below take the draft rather than reading one.
 *
 * Three composers stage images now — the channel bar, the thread panel's reply
 * box, and direct messages — and they hold their text in separate drafts. The
 * rules for where the references live inside a draft, and for what the
 * textarea may show of it, are the same in all three, so they are written once
 * and passed the draft. The channel's is the default, because it is the caller
 * that came first and every one of its call sites reads the same string it
 * always did.
 */
function draftAttachments(repositoryId, draft = state.chatDraft) {
  const base =
    `/api/v1/projects/${encodeURIComponent(state.projectId)}` +
    `/repositories/${encodeURIComponent(repositoryId ?? "")}/attachments/`;
  return [...String(draft ?? "").matchAll(ATTACHMENT_PATTERN)].map((match) => ({
    reference: match[0],
    alt: match[1] || "Attached image",
    id: match[2],
    src: base + match[2],
  }));
}

function draftText(source = state.chatDraft) {
  const draft = String(source ?? "");
  const attachmentAt = draft.search(ATTACHMENT_PATTERN);
  if (attachmentAt === -1) {
    // This value is written back into the textarea after any background
    // render. It must be byte-for-byte what the person typed: `trimEnd()`
    // made a render arriving after Space or Shift+Enter silently erase that
    // input and clamp the restored caret to the shortened value.
    return draft;
  }

  // Attachments are stored after the visible draft as reference lines. Drop
  // the single newline that separates that hidden suffix from the textarea,
  // but never trim the visible text itself — in particular, keep spaces and
  // an additional newline the person entered before the separator.
  const visible = draft.slice(0, attachmentAt);
  return visible.endsWith("\n") ? visible.slice(0, -1) : visible;
}

function draftAttachmentPreviews(
  repositoryId,
  { draft = state.chatDraft, removeAct = "channel-attachment-remove" } = {},
) {
  const attachments = draftAttachments(repositoryId, draft);
  if (attachments.length === 0) {
    return "";
  }
  return `<div class="composer-attachments" aria-label="Attached images">${attachments
    .map(
      (attachment) => `<div class="composer-attachment">
        <img src="${esc(attachment.src)}" alt="${esc(attachment.alt)}"
          data-attachment="${esc(attachment.id)}" decoding="async">
        <span title="${esc(attachment.alt)}">${esc(attachment.alt)}</span>
        <button type="button" class="composer-attachment-remove"
          data-act="${esc(removeAct)}" data-value="${esc(attachment.id)}"
          aria-label="Remove ${esc(attachment.alt)}">&times;</button>
      </div>`,
    )
    .join("")}</div>`;
}

/**
 * Marks the complete names a posted message actually mentions.
 *
 * The server includes resolved mention names with every message, and the
 * optimistic local post carries the same shape. Matching those names instead
 * of guessing where an `@` token ends keeps `@Claude (Owner)` and a person's
 * multi-word display name in one span without swallowing the request after
 * it. Longest first handles names where one is a prefix of another.
 *
 * `value` and `names` are already escaped. The boundary before `@` leaves
 * email addresses and paths alone, while applying this after inline markup
 * keeps `<code>@agent</code>` untouched because its preceding character is
 * `>` rather than an accepted text boundary.
 */
function mentionMarkup(value, names = []) {
  const alternatives = [...new Set(names)]
    .filter((name) => name.length > 0)
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  if (alternatives.length === 0) {
    return value;
  }
  const pattern = new RegExp(
    `(^|[\\s([])@(${alternatives.join("|")})(?=$|[\\s,.:;!?()\\[\\]{}])`,
    "giu",
  );
  return value.replace(
    pattern,
    (_match, before, name) => `${before}<span class="mention-ping">@${name}</span>`,
  );
}

/**
 * Marks a slash command wherever one is written.
 *
 * The same boundary the picker opens on (`updateMentionState`) and the same
 * one the server parses by, so what is coloured is exactly what the channel
 * will treat as a command: a slash that starts a word. `src/retry.ts` and
 * `and/or` have no boundary before the slash and stay plain, and the trailing
 * boundary keeps `/usr/bin` out — a path is not a command, and colouring one
 * would promise something the channel is not going to do.
 *
 * `value` is already escaped, and applying this after mentions and inline
 * markup is safe for the same reason `mentionMarkup` is: every slash in the
 * markup those produced (`</span>`, `</code>`) is preceded by `<`, which is
 * not a boundary this accepts.
 */
function slashMarkup(value) {
  return value.replace(
    /(^|[\s([])\/([a-z0-9-]+)(?=$|[\s,.:;!?()[\]{}])/giu,
    (_match, before, name) => `${before}<span class="slash-ping">/${name}</span>`,
  );
}

/**
 * Marks the `@…` a person is part-way through typing.
 *
 * `mentionMarkup` can only colour a name it recognises, which is the right
 * rule for a posted message and the wrong one for a draft: it means the ping
 * a person is typing stays grey until its last character lands, and a name
 * that never resolves stays grey forever. In the composer the `@` itself is
 * the thing being written, so it is coloured from the first character.
 *
 * Run after `mentionMarkup`, never before: a resolved multi-word name is
 * already inside a span by then, and the `@` in it is preceded by `>` rather
 * than a boundary this accepts, so it is left alone rather than being cut
 * back to its first word.
 */
function draftMentionMarkup(value) {
  return value.replace(
    /(^|[\s([])@([\w.-]*)/gu,
    (_match, before, name) => `${before}<span class="mention-ping">@${name}</span>`,
  );
}

/**
 * The composer's text, marked up for the layer painted under the textarea.
 *
 * Mentions and commands, and none of `richText`'s markdown. What is on screen
 * while somebody types has to be character-for-character what they typed, or
 * the mirror and the textarea wrap at different points and the caret stops
 * landing where the letters are. `**bold**` collapsing to two fewer
 * characters would do exactly that; a span around characters that are all
 * still there does not.
 *
 * The trailing newline is deliberate. A textarea keeps a final empty line
 * visible and a div collapses it, so without this the mirror is one line
 * shorter than the box the moment somebody ends on Enter.
 */
function composerMirror(value, participants = []) {
  // Posted messages bring their resolved mentions with them. A draft has no
  // such record yet, so its mirror has to read the same live roster as the
  // picker. Passing no names here was the merge regression that left every
  // `<span class="mention-ping">` out of the composer even though the mirror
  // itself was present.
  const names = [
    "agents",
    "everyone",
    ...participants
      .map((participant) => participant?.name)
      .filter((name) => typeof name === "string" && name.length > 0),
  ].map((name) => esc(name));
  // Resolved names first, so a multi-word one is coloured whole; then the
  // half-typed `@` that has no name to match yet; then commands. The draft
  // pass cannot undo the first because what that produced is already inside a
  // span — see `draftMentionMarkup`.
  return `${slashMarkup(
    draftMentionMarkup(mentionMarkup(esc(String(value ?? "")), names)),
  )}\n`;
}

/** Repaints the layer under the textarea. Called on every keystroke. */
function paintComposerMirror(node) {
  const mirror = node
    .closest(".composer-field")
    ?.querySelector("[data-composer-mirror]");
  if (mirror === null || mirror === undefined) {
    return;
  }
  mirror.innerHTML = composerMirror(
    node.value,
    channelParticipants(activeChannelId()),
  );
  // A composer past its max height scrolls, and the mirror has to scroll with
  // it or the highlight slides off the text it belongs to.
  mirror.scrollTop = node.scrollTop;
}

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
function richText(text, mentions) {
  const mentionNames = [
    "agents",
    "everyone",
    ...mentions
      .map((mention) => mention?.name)
      .filter((name) => typeof name === "string")
      .map((name) => esc(name)),
  ];
  const blocks = esc(String(text ?? ""))
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  // The command keeps the colour it had in the composer. A message whose
  // first word turned grey the moment it was sent read as though the channel
  // had stopped recognising it, when what it had done was run it.
  const inline = (value) =>
    slashMarkup(
      mentionMarkup(
        value
          .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
          .replace(/`([^`]+)`/gu, "<code>$1</code>"),
        mentionNames,
      ),
    );
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

function messageBody(content, repositoryId, mentions) {
  const text = String(content ?? "");
  // Older messages and optimistic replies may not carry resolved mention
  // metadata yet. The current roster is the same source the picker uses, so
  // it is the accurate fallback until the server copy arrives.
  const resolvedMentions = mentions ?? channelParticipants(repositoryId);
  const images = [];
  let stripped = text;
  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    images.push({ alt: match[1] ?? "", id: match[2] ?? "" });
    stripped = stripped.replace(match[0], "");
  }
  if (images.length === 0) {
    return richText(text, resolvedMentions);
  }
  const base =
    `/api/v1/projects/${encodeURIComponent(state.projectId)}` +
    `/repositories/${encodeURIComponent(repositoryId ?? "")}/attachments/`;
  return (
    richText(stripped.trim(), resolvedMentions) +
    images.map((image) => attachmentImage(base, image)).join("")
  );
}

/**
 * Who is in this room, for anything that counts or lists them.
 *
 * The server's room list when it has arrived — it includes repo-scoped
 * grantees the org member list has never heard of; the org list is only the
 * floor before the roster resolves.
 *
 * One function because the header and the sidebar disagreed. The sidebar read
 * this; the header read `collaborators()`, which is the whole *organization*
 * and, when that had not loaded, a list containing only the reader. So a room
 * with two people in its sidebar had a "1" in its header, and the number never
 * moved no matter who joined — it was not a count of this room at all.
 */
function channelPeopleFor(repositoryId) {
  const room = state.channelPeople[repositoryId];
  return room !== undefined && room.length > 0 ? room : (state.members ?? []);
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
        ${
          // Only when there is one. Most people in most rooms have no role,
          // so "No role set" was a second line under every name in the list —
          // a column of identical grey text saying nothing about anybody, and
          // it made a one-line row two lines tall for the privilege. An agent
          // keeps its empty state (see `rosterRow`): a role is what an agent
          // is *for*, and its absence is worth prompting about.
          role === "" ? "" : `<div class="rr-role">${esc(role)}</div>`
        }
      </span>
      ${unread > 0 ? `<span class="rr-badge">${unread}</span>` : ""}
    </div>
  </div>`;
}

/** The role the roster acts on. */
const AUDITOR_ROLE = "auditor";

function isAuditor(agent) {
  return (agent.role ?? "").trim().toLowerCase() === AUDITOR_ROLE;
}

const AGENT_STATUS_TITLE = {
  working: "Working now",
  idle: "Idle",
  personal: "Personal agent — only its owner can task it here",
};

/**
 * One agent in the roster: a face, a name, what it is here for, and one
 * button.
 *
 * Rename replaces the name itself. It does not grow a second settings panel
 * under the row or retain a duplicate input after the edit is done.
 */
function rosterRow(agent) {
  const settingsOpen = state.chatSettingsOpenId === agent.id;
  const auditor = isAuditor(agent);
  const paused = state.auditorPaused[activeChannelId()] === true;
  const status = agentStatus(agent, activeChannelId());
  return `<div class="roster-row">
    <div class="roster-row-main" role="button" tabindex="0"
      data-act="agent-panel-open" data-value="${esc(agent.id)}">
      <span class="rr-avatar" data-hover="agent-usage"
        data-hover-value="${esc(agent.id)}" tabindex="0"
        aria-label="Open details for ${esc(agent.name)}">
        ${usageTip(agent)}
        ${agentFace(agent, 30)}
        ${statusDot(status, AGENT_STATUS_TITLE[status])}
      </span>
      <span class="rr-body">
        ${
          settingsOpen
            ? `<form class="roster-rename" data-act="channel-rename-form"
                data-value="${esc(agent.id)}">
                <input class="rr-name-input" data-act="channel-rename-input"
                  data-value="${esc(agent.id)}" value="${esc(agent.name)}"
                  aria-label="Rename ${esc(agent.name)}" autocomplete="off"
                  enterkeyhint="done"${agent.mine ? ' maxlength="40"' : ""}>
              </form>`
            : `<div class="rr-name">${esc(agent.name)}</div>`
        }
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
      <span class="rr-more">${iconButton("dots", {
        act: "roster-agent-menu",
        value: agent.id,
        title: `More for ${agent.name}`,
        small: true,
      })}</span>
    </div>
  </div>`;
}

/**
 * What the "..." on a roster row offers, in the order somebody reaches for it.
 *
 * Built here rather than in `app.js` because every condition in it is the
 * same one the row itself is drawn from — who owns the agent, whether it is
 * the auditor, whether this account may moderate the channel. Splitting that
 * across two files is how a menu ends up offering what the row would not.
 *
 * Deliberately short: rename and delete are the two row edits. Messaging and
 * the auditor switch remain only where those capabilities actually apply.
 */
export function rosterMenuItems(agentId) {
  const repositoryId = activeChannelId();
  const agent = channelAgentsFor(repositoryId).find(
    (entry) => entry.id === agentId,
  );
  if (agent === undefined) {
    return [];
  }
  const canModerate = canManageRepository(repositoryId);
  const paused = state.auditorPaused[repositoryId] === true;
  const items = [];
  // Only for personal agents of this account. This is the explicit route to a
  // one-to-one conversation; clicking the agent itself opens its details.
  // An org agent's whole point is that its work happens where the team can see
  // it, so no private-chat action is offered for one.
  if (agent.mine === true && agent.visibility !== "org") {
    items.push({
      act: "agent-chat-open",
      value: agent.id,
      label: `Message ${agent.name}`,
      iconName: "chatBubble",
    });
  }
  items.push({
    act: "channel-settings-toggle",
    value: agent.id,
    label: "Rename",
    iconName: "pencil",
  });
  // Only the auditor gets this, because it is the only role that spends
  // without being asked. Moderators only: turning it back on starts an audit,
  // which costs money, so it is the same decision the promotion route guards.
  if (isAuditor(agent) && canModerate) {
    items.push({
      act: "auditor-toggle",
      // The *current* paused state, read off what is on screen — the handler
      // flips it.
      value: String(paused),
      label: paused ? "Resume auditing" : "Pause auditing",
      hint: paused
        ? "Audits everything merged since it was switched off"
        : "Stops audits without demoting this agent",
      iconName: paused ? "play" : "pause",
    });
  }
  if (agent.mine === true || canModerate) {
    const removeAct =
      agent.mine === true
        ? "channel-agent-remove"
        : "channel-agent-remove-any";
    items.push({
      act: removeAct,
      value: agent.id,
      label: "Delete",
      iconName: "trash",
      danger: true,
    });
  }
  return items;
}

/**
 * One heading in the sidebar, and the one thing it adds.
 *
 * Three lists, three ways to add to them, and each used to look like something
 * else: a filled accent square beside the search box for a new channel, and
 * two full-width "Invite someone" / "Add an agent" rows sitting permanently at
 * the bottom of the people and agent lists, indented to look like more rows.
 * Three permanent elements, none of them the same shape, all saying "add one
 * of these". They are one shape now — a "+" on the heading of the list it adds
 * to — which costs no row of its own, holds still while the list under it
 * grows, and puts the control where somebody counting the list is already
 * looking.
 */
function section(label, act, value, title) {
  return `<div class="chan-sec">
    <span class="chan-sec-label">${esc(label)}</span>
    <button type="button" class="chan-sec-add" data-act="${act}"
      data-value="${value}" title="${esc(title)}" aria-label="${esc(title)}">
      ${icon("plus")}
    </button>
  </div>`;
}

function chanSidebar(activeRepositoryId) {
  const query = state.chatQuery.trim().toLowerCase();
  const channels = [...state.repositories]
    .filter((repo) => query === "" || repo.id.toLowerCase().includes(query))
    .sort((left, right) => left.id.localeCompare(right.id));
  const roster = channelAgentsFor(activeRepositoryId);
  // The membership records rather than `collaborators()`, which flattens them
  // to names — the role has to come from somewhere, and it is on the record.
  // The server's room list when it has arrived — it includes repo-scoped
  // grantees the org member list has never heard of; the org list is only
  // the floor before the roster resolves.
  const people = channelPeopleFor(activeRepositoryId);
  const user = currentUserName();

  const channel = esc(activeRepositoryId ?? "");
  return `<aside class="chan-sidebar" aria-label="Channels and account">
    <!-- The collapse control belongs to the surface it changes. It stays in
         this crown when the sidebar becomes an icon rail, so expanding it
         never requires hunting in the conversation header. -->
    <div class="chan-sidebar-top">
      <button type="button" class="chan-brand" data-act="nav" data-value="chats"
        title="Lattice chats" aria-label="Lattice chats">
        ${brandMark(26)}
        <span class="brand-text"><b>Lattice</b></span>
      </button>
      <button type="button" class="icon-btn desk-only chan-collapse-btn"
        data-act="chan-collapse-toggle"
        title="${state.chanCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
        aria-pressed="${state.chanCollapsed === true}"
        aria-label="${state.chanCollapsed ? "Expand sidebar" : "Collapse sidebar"}">${icon(
          "columns",
        )}</button>
      ${iconButton("close", {
        act: "chan-sidebar-close",
        title: "Close",
        cls: "drawer-close",
      })}
    </div>
    <div class="chan-sidebar-head">
      ${searchBox("Search channels...", state.chatQuery, "channel-search")}
    </div>
    <!-- One scroller, not three.
         The column used to be a four-row grid in which the channel list had
         its own scrollbar capped at 38vh and the roster had a second one
         underneath it, so a long list of channels and a long list of people
         were two independent things to drag inside 256 pixels — and the cap
         left a band of empty panel whenever neither list was long. Everything
         now scrolls together, the way the conversation beside it does, and
         each heading sticks to the top of the panel while its own section is
         passing so the reader always knows which list they are in. -->
    <div class="chan-scroll">
      <div class="chan-sec chan-sec-channels">
        <span class="chan-sec-label">Channels</span>
        <button type="button" class="chan-sec-add" data-act="channel-new"
          data-value="${channel}" title="New channel" aria-label="New channel">
          ${icon("plus")}
        </button>
      </div>
      <div class="chan-list">
        ${
          channels.length === 0
            ? `<div class="util-empty">No channel matches that search.</div>`
            : channels.map((repo) => chanRow(repo, activeRepositoryId)).join("")
        }
      </div>
      ${section("People", "invite-repo", channel, "Invite someone")}
      <div class="chan-roster">
        ${
          // People first, then agents. The channel header already names the
          // repository, so repeating it in the label said nothing the eye had
          // not just read — and it grew with the name, which is why a long
          // repository pushed the word "Agents" out of sight entirely.
          people.length === 0
            ? `<div class="util-empty">Nobody else yet.</div>`
            : people.map((person) => personRow(person)).join("")
        }
      </div>
      ${section("Agents", "channel-agent-menu", channel, "Add an agent")}
      <div class="chan-roster">
        ${
          // No empty state. The "+" on the heading directly above is both the
          // explanation and the thing to press; a sentence between them is a
          // line to read on the way past.
          roster.map((agent) => rosterRow(agent)).join("")
        }
      </div>
    </div>
    <!-- The profile is the one account control at the foot. Its menu already
         contains Settings, so a second Settings row here would only make the
         same destination compete with the account that owns it. -->
    <div class="chan-sidebar-foot">
      ${
        state.health === undefined
          ? `<div class="sys-line" title="Control plane unreachable"><span class="dot grey"></span>Control plane unreachable</div>`
          : ""
      }
      <button type="button" class="chan-account" data-act="user-menu"
        title="Open profile menu" aria-label="Open profile menu for ${esc(user)}">
        ${avatar(user, 32, user, myAvatar())}
        <span class="chan-account-copy"><b>${esc(user)}</b></span>
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

/**
 * Why the last preview of this repository stopped, if it stopped on its own.
 *
 * A preview that fails to come up at all is reported as an error the moment it
 * is asked for. This is the other case: one that ran, was watched, and then
 * died — which the control cannot show by flipping back to "play", because that
 * is also what it looks like before anything was ever started.
 */
function previewStopped(repositoryId) {
  const preview = state.previews[repositoryId];
  return preview !== null && preview !== undefined && preview.exited !== undefined
    ? preview
    : undefined;
}

/** The control, which lives in the tool tray with its siblings. */
function previewControl(repositoryId) {
  if (!repositoryId) {
    return "";
  }
  if (previewRunning(repositoryId) !== undefined) {
    return `<button type="button" class="icon-btn on" data-act="preview-stop"
        data-value="${esc(repositoryId)}" title="Stop the running app">
        ${icon("close")}</button>`;
  }
  const stopped = previewStopped(repositoryId);
  // The output is the diagnosis and it is the only copy: nothing else in the
  // page renders it, so a dead preview used to be indistinguishable from one
  // that was never started.
  const why =
    stopped === undefined
      ? "Run this app and open it"
      : `${stopped.label} stopped — ${
          (stopped.recentOutput ?? []).slice(-3).join(" ").trim() ||
          "it printed nothing"
        }. Press to run it again.`;
  return `<button type="button" class="icon-btn${stopped === undefined ? "" : " warn"}"
      data-act="preview-start" data-value="${esc(repositoryId)}"
      title="${esc(why)}">${icon("play")}</button>`;
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
  // A running preview is not necessarily a reachable one: a command that builds
  // before it serves is healthy for minutes while answering nothing. Offering
  // the address then is offering something that does not work, and whoever
  // clicks it concludes the preview is broken rather than slow.
  if (preview.ready === false) {
    return `<span class="preview-live">
      <span class="preview-starting" title="${esc(preview.label)} — ${esc(preview.url)}">
        starting…</span>
    </span>`;
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

function chanHeader(repositoryId) {
  const roster = channelAgentsFor(repositoryId);
  const people = channelPeopleFor(repositoryId);
  return `<header class="chan-head">
    <!-- No hamburger. It opened the outer app rail, which stopped being
         rendered when this sidebar became the navigation, so between 600 and
         900 pixels the header led with a button that did nothing at all. The
         channels button below is the one that opens something. -->
    <!-- Phone-only: the channel list and roster live in \`.chan-sidebar\`,
         which goes off-canvas below the 600px breakpoint the same way the
         outer app \`.sidebar\` already does at 900px. This is the only way
         back to it once it is closed, so it is a real button rather than
         something folded into a menu.

         The backticks are escaped because this comment is inside a template
         literal: a bare one closes the string, and the selector after it
         then parses as real code — ".chan-sidebar" becomes a property read
         minus an identifier named "sidebar", which is valid JavaScript and
         throws only when this header renders.

         Not the only way in any more — a rightward swipe across the
         conversation drags the same drawer out, and a leftward one puts it
         back (see the phone drawer drag in app.js). The button stays because
         a gesture leaves no trace on the screen, so it cannot be the sole
         route to a surface; \`aria-expanded\` is what tells a reader which of
         the two states the invisible drawer is currently in. -->
    <button type="button" class="icon-btn chan-sidebar-btn" data-act="chan-sidebar-toggle"
      aria-expanded="${state.chanSidebarOpen === true}"
      title="Channels &amp; people" aria-label="Channels &amp; people">${icon("list")}</button>
    ${icon("chatBubble", 'class="ch-hash"')}
    <div class="ch-title">
      <div class="ch-name">${esc(repositoryId ?? "")}</div>
      <div class="ch-desc">
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
    <!-- No faces here. Six cropped circles said "some agents and some people
         are in this room", which the two counts already say exactly, in less
         space and without the guessing. -->
    ${
      // Six controls sat permanently in a header that is 44 pixels tall on a
      // phone, and on any given visit a reader wants none of them. Behind one
      // arrow they are a menu; in front of it they were the header.
      //
      // Except on a phone, where the header wraps and the tools get a full
      // row of their own (see the 600px tier in styles.css): there the fold
      // saved no space, and the toggle was one more tap in front of every
      // tool. Pinned open below the breakpoint — the chevron is hidden by
      // the same tier, and `chanToolsOpen` keeps meaning what it means on
      // desktop.
      state.chanToolsOpen !== true && !phoneLayout()
        ? ""
        : `<span class="chan-tools">
            ${previewControl(repositoryId)}
            <button type="button" class="icon-btn${state.chanTree === true ? " on" : ""}"
              data-act="chan-tree-toggle" title="Files"
              aria-pressed="${state.chanTree === true}">${icon("folder")}</button>
            <button type="button" class="icon-btn${state.chanThreadList === true ? " on" : ""}"
              data-act="channel-threads-toggle" title="Threads"
              aria-pressed="${state.chanThreadList === true}">${icon("reply")}</button>
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
      aria-expanded="${
        state.chanToolsOpen === true
      }">${
        // Points up when the tools are away and left when they are out: the
        // arrow indicates the direction they went, not the direction of the
        // fold. Closed it stands up on its own; open it lies down pointing
        // back along the row it just laid out.
        icon("chevronUp")
      }</button>
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
 * Everybody who said something in a thread, first appearance first and one
 * entry per person however much they said.
 *
 * Authors rather than names, because the faces are drawn from them: an agent
 * gets its vendor mark in its owner's colour, a person gets their portrait,
 * and only `channelAuthor` knows which of the two a reply came from.
 */
function threadParticipants(replies, repositoryId) {
  const authors = [];
  for (const reply of replies) {
    const author = channelAuthor(repositoryId, reply);
    const name = author?.name ?? "";
    if (name !== "" && !authors.some((seen) => seen.name === name)) {
      authors.push(author);
    }
  }
  return authors;
}

/** How much was actually said, thinking excluded. */
function threadSaidCount(said) {
  return said === 0 ? "No replies yet" : `${said} repl${said === 1 ? "y" : "ies"}`;
}

/**
 * The way into a thread from the channel: who is in it, and how many replies.
 *
 * Deliberately not the card the threads pullout uses. In the channel the root
 * message directly above has already said what the thread is about, so a card
 * repeating the task's name under every one of them was the same sentence
 * twice inside 40 pixels, wrapped in a surface loud enough to compete with the
 * conversation it belongs to.
 *
 * What is left is the one fact the message above does not carry — how much was
 * said in reply — as an accent-coloured link with the repliers' faces beside
 * it. The colour is the reader's own accent rather than a fixed blue, so it is
 * the same "this is a link" signal every other tinted thing on the screen uses.
 *
 * The count still excludes the run's own narration and the `Task:` title
 * reply: those are the thread naming itself and thinking aloud, not replies,
 * and counting them made a one-line edit look like a long conversation.
 *
 * A held run adds one breathing amber dot beside the count and nothing else.
 * This used to be a bordered amber banner on its own line under the link,
 * spelling out "open the thread and reply go ahead" — directly above the
 * room's own line saying the same sentence in words. Two paragraphs and a
 * link for one fact. The dot keeps the fact and drops the repetition; the
 * words survive for screen readers, and the sentence itself is still in the
 * room, one message down, now pointing back here.
 */
function threadSummaryLink(entry, replies, repositoryId) {
  const titled = threadTitleReply(entry);
  const said = replies.filter(
    (reply) => reply !== titled && !isThreadThinking(reply),
  );
  const faces = threadParticipants(replies, repositoryId)
    .slice(0, 3)
    .map((author) =>
      author.agent !== undefined
        ? agentFace(author.agent, 20)
        : avatar(
            author.name,
            20,
            author.name,
            author.name === currentUserName() ? myAvatar() : undefined,
          ),
    )
    .join("");
  return `<button type="button" class="cmsg-thread-link" data-act="channel-thread-open"
      data-value="${esc(entry.id)}">
      <span class="avatar-stack ctl-faces">${faces}</span>
      <span class="cmsg-thread-replies">${esc(threadSaidCount(said.length))}</span>${
        threadAwaitsGoAhead(entry)
          ? `<span class="ctl-held" aria-hidden="true"></span>
      <span class="sr-only">Waiting for your go-ahead</span>`
          : ""
      }
    </button>`;
}

/**
 * How the room's own hold line opens, as the gateway writes it.
 *
 * Mirrors `CHANNEL_HOLD_PREFIX` in `services/api-gateway/src/server.ts`. The
 * line is already addressed to the reader in words; what the browser adds is
 * the one thing the text cannot carry — which thread it is talking about.
 */
const HOLD_NOTICE_PREFIX = "⏸ Waiting on you";

/** Root kinds spoken by an agent rather than a person or the coordinator. */
const AGENT_AUTHORED_ROOT_KINDS = new Set(["agent", "outcome"]);

/**
 * The thread a room-level hold line is about, if it is about one.
 *
 * Walked backwards from the line itself: a hold is announced immediately
 * after the run that raised it stops, so the nearest held thread above it is
 * the one being waited on. Nothing found is not an error — the announcement
 * can outlive the loaded page, and a line with no target simply renders as
 * the plain message it has always been.
 */
function holdNoticeTarget(entry, repositoryId) {
  if (
    entry.kind !== "outcome" ||
    !String(entry.content ?? "").startsWith(HOLD_NOTICE_PREFIX)
  ) {
    return undefined;
  }
  const messages = channelMessagesFor(repositoryId);
  const at = messages.findIndex((message) => message.id === entry.id);
  for (let index = (at === -1 ? messages.length : at) - 1; index >= 0; index -= 1) {
    if (threadAwaitsGoAhead(messages[index])) {
      return messages[index];
    }
  }
  return undefined;
}

/**
 * A line back to the message this one is answering, above the message itself.
 *
 * The hold announcement says "the plan is in the thread" and then leaves the
 * reader to find it: the thread is somewhere above, collapsed, among however
 * much else the room has said since. So the line wears the reference every
 * chat app draws for a reply — a hairline turning up out of the avatar gutter
 * into a quiet one-line quote of the message it points at — and clicking it
 * goes there. `channel-pin-jump` is exactly that navigation already: open the
 * target as a thread if it has one, scroll to it if it does not, and say so
 * when it has aged out of the loaded history.
 */
function holdNoticeRef(entry, repositoryId) {
  const root = holdNoticeTarget(entry, repositoryId);
  if (root === undefined) {
    return "";
  }
  return messageReference(root, repositoryId);
}

/** The compact address above an inline reply. */
function messageReference(root, repositoryId) {
  const author = channelAuthor(repositoryId, root);
  const line =
    root.deletedAt !== undefined
      ? "This message was deleted"
      : (String(root.content ?? "")
          .split(/\n/u)
          .map((part) => part.trim())
          .find((part) => part.length > 0) ?? "");
  return `<button type="button" class="cmsg-ref" data-act="channel-pin-jump"
      data-value="${esc(root.id)}">
      <span class="cmsg-ref-elbow" aria-hidden="true"></span>
      ${
        author.agent !== undefined
          ? agentFace(author.agent, 16)
          : avatar(
              author.name,
              16,
              author.name,
              author.name === currentUserName() ? myAvatar() : undefined,
            )
      }
      <span class="cmsg-ref-name">${esc(author.name)}</span>
      <span class="cmsg-ref-text">${esc(
        line.length > 80 ? `${line.slice(0, 77)}…` : line,
      )}</span>
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

/* ------------------------------------------------- message identity ---- */

/* The kinds `channelAuthor` resolves against the agent roster rather than the
   member list. Named here because an agent it *cannot* resolve still has to
   be recognised as an agent: the author id it falls back to is the server's
   `<userId>:<provider>` composite, and reading that as a person is how a face
   would come to offer a direct message to an id nobody has. */
const AGENT_AUTHORED_KINDS = new Set(["agent", "progress", "outcome"]);

/**
 * The face and the name at the top of a message, as something you can press.
 *
 * The roster already answers "who is this" for everybody in the room, but the
 * transcript is where a name is actually *read* — and the only route from a
 * line to the person who wrote it used to be finding them again in the
 * sidebar. Same two destinations the sidebar uses, so a face means the same
 * thing wherever it is pressed: a person opens the conversation with them, an
 * agent opens its panel.
 *
 * `undefined` for the reader's own lines and for authors the room cannot name
 * at all. There is no conversation with yourself to open, and a card headed by
 * an empty id is worse than no card — the same reasoning that makes your own
 * `personRow` a label rather than a button.
 */
function authorIdentity(repositoryId, entry, author) {
  if (author.agent !== undefined) {
    const status = agentStatus(author.agent, repositoryId);
    return {
      kind: "agent",
      act: "agent-panel-open",
      value: String(author.agent.id ?? ""),
      name: author.name,
      face: agentFace(author.agent, 38),
      // What the agent is here for, which is the line its roster row leads
      // with too. "Your agent" is worth saying on a shared transcript: whose
      // an agent is decides who may task it.
      detail: [
        String(author.agent.role ?? "").trim(),
        author.agent.mine === true ? "Your agent" : "",
      ]
        .filter((part) => part !== "")
        .join(" · "),
      status,
      statusText: AGENT_STATUS_TITLE[status] ?? "",
      label: `Open details for ${author.name}`,
      hint: "Open agent details",
    };
  }
  const userId = String(entry.authorId ?? "");
  if (
    userId === "" ||
    userId === "you" ||
    userId === currentUserId() ||
    AGENT_AUTHORED_KINDS.has(entry.kind)
  ) {
    return undefined;
  }
  // Both roster shapes, exactly as `personRow` reads them: the organization
  // list nests the account under `user`, the room's own people list flattens
  // it. Reading only one is what used to leave a name as "Someone".
  const person = channelPeopleFor(repositoryId).find(
    (candidate) =>
      (candidate.user?.id ?? candidate.userId ?? candidate.id ?? "") === userId,
  );
  const online = personOnline(userId);
  const unread = dmUnreadFrom(userId);
  return {
    kind: "person",
    act: "dm-open",
    value: userId,
    name: author.name,
    face: avatar(author.name, 38, author.name),
    detail: String(person?.role ?? "").trim(),
    status: online ? "working" : "away",
    statusText: online ? "Here now" : "Away",
    label: `Open your conversation with ${author.name}`,
    hint: unread > 0 ? `Open messages · ${unread} unread` : "Send a message",
  };
}

/**
 * A face or a name, wrapped in the button that opens whoever it belongs to.
 *
 * A wrapper inside the existing avatar and name rather than those elements
 * themselves: the picture keeps its place in the row's layout and the name
 * keeps its weight in the header line, while the thing that answers a press
 * is exactly the thing somebody aimed at. Content back untouched when there
 * is nobody to open — a tab stop that does nothing is worse than no tab stop.
 *
 * A span with `role=button` rather than a `<button>`, because a real button
 * inside the message's own controls is markup a browser will not keep. The
 * keyboard is served by `role=button` plus `data-act` and the delegated
 * handler in `app.js` that exists for exactly that pair.
 */
function identityWrap(identity, content) {
  if (identity === undefined) {
    return content;
  }
  return `<span class="cmsg-identity" role="button" tabindex="0"
    data-act="${esc(identity.act)}" data-value="${esc(identity.value)}"
    aria-label="${esc(identity.label)}">${content}${profileCard(identity)}</span>`;
}

/**
 * Who somebody is, without leaving the conversation to find out.
 *
 * CSS-driven exactly like the roster's `.rr-usage`: rendered with the message
 * and revealed by `:hover`/`:focus-within`, so no pointer tracking and no
 * request is involved in reading one. Everything on it is already in state
 * for the roster's sake, so a hover costs nothing a render did not cost
 * anyway.
 */
function profileCard(identity) {
  if (identity === undefined) {
    return "";
  }
  return `<span class="profile-card" role="tooltip">
    <span class="profile-card-head">
      <span class="profile-card-face">${identity.face}${statusDot(
        identity.status,
        // No tooltip on the dot: the line under it already says this in
        // words, and a native tooltip opening on top of a card that is
        // itself a tooltip is one hover producing two answers.
        "",
      )}</span>
      <span class="profile-card-id">
        <span class="profile-card-name">${esc(identity.name)}</span>
        ${
          identity.detail === ""
            ? ""
            : `<span class="profile-card-detail">${esc(identity.detail)}</span>`
        }
      </span>
    </span>
    <span class="profile-card-status">${esc(identity.statusText)}</span>
    <span class="profile-card-hint">${esc(identity.hint)}</span>
  </span>`;
}

/** The face a message is drawn with, at whatever size is asked for. */
function authorFace(author, size) {
  return author.agent !== undefined
    ? agentFace(author.agent, size)
    : avatar(
        author.name,
        size,
        author.name,
        author.name === currentUserName() ? myAvatar() : undefined,
      );
}

function messageRow(
  entry,
  repositoryId,
  {
    isReply = false,
    inlineReplyTo = undefined,
    hideChanges = false,
    actions = "",
    compact = false,
    threadPath = undefined,
  } = {},
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
  // One acknowledgement under a person's task stays visually flat. Once the
  // agent has substantive narration too, that same request becomes the root
  // of the task thread. Legacy agent-authored roots keep their old shape.
  const inlineReply = inlineReplyTo !== undefined;
  const hasTaskThread = channelMessageHasTaskThread(entry);
  const channelThread = hasTaskThread && !isReply;
  // Agent answers and acknowledgements remain ordinary roots in the room's
  // chronological transcript. Their stored reference is the address back to
  // the request that prompted them; it does not replace the task thread the
  // acknowledgement may also grow below itself. Resolve against the complete
  // loaded channel rather than the filtered `messageList`, so searching for
  // the answer does not make its address disappear.
  const referencedRoot =
    !isReply &&
    AGENT_AUTHORED_ROOT_KINDS.has(entry.kind) &&
    entry.referencedMessageId !== undefined
      ? channelMessagesFor(repositoryId).find(
          (message) => message.id === entry.referencedMessageId,
        )
      : undefined;
  // A message somebody unsaid, whose thread is still standing. The row stays
  // where it was — the replies under it are answers to something, and closing
  // the gap would leave them answering the message above — but everything the
  // row could still *do* goes with the words. React, pin, revert and delete
  // all act on a line that is no longer there.
  const deleted = entry.deletedAt !== undefined;
  // Who the face and the name belong to, and so whether they are pressable at
  // all. Resolved once and used by both: a transcript where the picture opens
  // somebody and the name beside it does nothing is a worse answer than
  // neither being pressable.
  const identity = authorIdentity(repositoryId, entry, author);
  // The path is assigned by `messageThreadPaths`, which can start it on an
  // earlier compact-group message than the one that owns the task. A direct
  // channel render still gets a complete standalone path as a safe fallback.
  const path =
    threadPath ??
    (channelThread ? { start: true, through: false, end: true } : undefined);
  const changedBlock = hideChanges
    ? ""
    : changedFilesBlock(entry, repositoryId);
  const progress = channelThread ? threadProgress(entry) : undefined;
  const progressBlock =
    progress === undefined
      ? ""
      : `<div class="thread-progress" title="${progress}% by phase">
           <i style="width:${progress}%"></i>
         </div>`;
  return `<div class="cmsg-row${isReply ? " cmsg-reply" : ""}${
    inlineReply ? " cmsg-inline-reply" : ""
  }${compact ? " cmsg-compact" : ""
  }${channelThread ? " cmsg-threaded" : ""}${
    path?.start === true ? " cmsg-thread-path-start" : ""
  }${path?.through === true ? " cmsg-thread-path-through" : ""}${
    path?.end === true ? " cmsg-thread-path-end" : ""
  }${deleted ? " cmsg-deleted" : ""}${
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
    ${
      // Above the name, the way a reply's reference sits above the reply:
      // this line is an answer to a thread further up, and the reference is
      // how the reader gets back to it. Only on the channel copy — inside
      // the thread panel there is nothing to navigate to — and never on a
      // message whose words have been taken away.
      //
      // A sibling of the avatar rather than the first thing in the body: the
      // reference's hairline turns up out of the avatar gutter, and from
      // inside the body the only way to reach that gutter is to lean back
      // over it — which draws the line straight across the face standing
      // there. Given its own line above the row (see `flex-wrap` on
      // `.cmsg-row`) the hairline points down the avatar column instead.
      deleted
        ? ""
        : inlineReply
          ? messageReference(inlineReplyTo, repositoryId)
          : isReply
            ? ""
            : referencedRoot !== undefined
              ? messageReference(referencedRoot, repositoryId)
              : holdNoticeRef(entry, repositoryId)
    }
    ${
      compact
        ? ""
        : `<span class="cmsg-avatar">${identityWrap(
            identity,
            authorFace(author, 32),
          )}</span>`
    }
    <div class="cmsg-body">
      ${channelThread ? `<div class="cmsg-thread-route">` : ""}
      ${
        compact
          ? ""
          : `<div class="cmsg-top">
              <span class="cmsg-name${author.agent !== undefined ? " agent-name" : ""}">${identityWrap(
                identity,
                esc(author.name),
              )}</span>
              <span class="cmsg-time">${esc(clockTime(entry.at))}</span>
            </div>`
      }
      <div class="cmsg-text">${
        deleted
          ? `<span class="cmsg-tombstone">${icon("trash")} This message was deleted</span>`
          : messageBody(
              entry.content,
              repositoryId,
              entry.mentions,
            )
      }</div>
      ${
        deleted || reactions.length === 0
          ? ""
          : `<div class="cmsg-reactions">${reactions
              .map(
                ([emoji, info]) =>
                  // Its own emoji in the value, not the row's default: a
                  // tally is a toggle of *that* reaction. Clicking the 🎉
                  // somebody else left used to add a 👍 instead, because the
                  // only emoji the client could send was the hardcoded one.
                  `<button type="button" class="cmsg-reaction${info.mine ? " mine" : ""}"
                    data-act="channel-react" data-value="${esc(entry.id)}"
                    data-emoji="${esc(emoji)}"
                    title="${info.mine ? "Remove your" : "Add a"} ${esc(emoji)}"
                    aria-pressed="${info.mine ? "true" : "false"}">${emoji} ${info.count}</button>`,
              )
              .join("")}<button type="button" class="cmsg-reaction cmsg-react-add"
                    data-act="channel-react-pick" data-value="${esc(entry.id)}"
                    title="Add a reaction" aria-label="Add a reaction">${icon("smile")}</button></div>`
      }
      ${
        // The route ends at the thread link. Progress and changed files are
        // deliberately outside it, so opening either can never pull the grey
        // connector down past the thing it identifies.
        channelThread
          ? threadSummaryLink(entry, replies, repositoryId)
          : changedBlock
      }
      ${channelThread ? `</div>${progressBlock}${changedBlock}` : ""}
    </div>
    <span class="cmsg-actions">
      ${
        // Revert, as quiet as the actions beside it. It was a labelled button
        // under the file list, which gave "undo this task" more visual weight
        // than the task itself had.
        deleted ||
        entry.taskId === undefined ||
        !canManageRepository(repositoryId)
          ? ""
          : iconButton("history", {
              act: "chan-revert-task",
              value: entry.taskId,
              title: "Return the repository to the state before this task",
              small: true,
            })
      }
      ${
        deleted
          ? ""
          : iconButton("smile", {
              act: "channel-react-pick",
              value: entry.id,
              title: "React",
              small: true,
            })
      }
      ${
        // Copy the words, not the row: what somebody wants off a message is
        // the text they can paste somewhere else, without the attachment
        // references the composer wrote into it or the mention markup.
        deleted
          ? ""
          : iconButton("copy", {
              act: "channel-message-copy",
              value: entry.id,
              title: "Copy text",
              small: true,
            })
      }
      ${
        // Roots only. A pin lives on `channel_messages`, and a reply is a row
        // in another table entirely — offering the button on one sent a POST
        // that could only ever 404, and the optimistic local pin it had
        // already drawn stayed in the banner afterwards, advertising a pin the
        // server had no record of. The thread's own header carries the pin for
        // everything inside it, which is the affordance a reader wants anyway:
        // you pin the conversation, not one line of it.
        isReply || inlineReply || deleted
          ? ""
          : iconButton("pin", {
              act: "channel-pin",
              value: entry.id,
              title: entry.pinnedAt === undefined ? "Pin" : "Unpin",
              small: true,
            })
      }
      ${
        // Delete, in the same quiet set as the rest. Its own words or a
        // manager's reach — `canDeleteChannelEntry` is the client's copy of
        // the rule the gateway holds, so the button is absent rather than
        // present-and-refused.
        //
        // Reply or root is decided by `messageId` rather than by `isReply`:
        // the thread panel draws its own root in the compact reply style, so
        // the flag says how a row looks and only the field says what it is.
        // A reply carries its root's id too, because deleting one is a write
        // against the thread it lives in.
        (() => {
          if (deleted || !canDeleteChannelEntry(repositoryId, entry)) {
            return "";
          }
          const parentId = entry.messageId;
          return iconButton("trash", {
            act: parentId ? "thread-reply-delete" : "channel-message-delete",
            value: parentId ? `${parentId}|${entry.id}` : entry.id,
            title: parentId ? "Delete this reply" : "Delete this message",
            small: true,
          });
        })()
      }
      ${
        // Anything the caller wants sitting beside the reply button — the
        // summary's simplify wand rides here, so the two read as one set of
        // quiet actions rather than a button under the text and an icon over
        // it.
        actions
      }
      ${
        // A reply to a person stays in the channel and names the message it
        // answers. Agent work keeps its task thread; replies already inside a
        // task thread still quote into that thread's composer.
        isReply
          ? iconButton("reply", {
              act: "thread-reply-quote",
              value: entry.id,
              title: "Reply to this message",
              small: true,
            })
          : inlineReply || (entry.kind === "user" && !hasTaskThread)
            ? iconButton("reply", {
                act: "channel-message-reply",
                value: inlineReply ? inlineReplyTo.id : entry.id,
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
 * Whether one timeline item continues the uninterrupted run of human messages
 * immediately before it. Replies keep their reference and full header, and a
 * date boundary starts a fresh group even when the same person was speaking
 * on both sides of midnight.
 */
function continuesUserMessageGroup(previous, current, startsNewDay) {
  if (
    previous === undefined ||
    startsNewDay ||
    previous.inlineReplyTo !== undefined ||
    current.inlineReplyTo !== undefined
  ) {
    return false;
  }
  const before = previous.entry;
  const after = current.entry;
  const authorId = String(after.authorId ?? "");
  return (
    before.kind === "user" &&
    after.kind === "user" &&
    authorId !== "" &&
    String(before.authorId ?? "") === authorId
  );
}

/** Whether a channel root owns the compact thread summary drawn under it. */
function channelMessageHasTaskThread(entry) {
  const replies = entry.replies ?? [];
  return (
    replies.length > 0 &&
    (entry.kind !== "user" ||
      (entry.taskId !== undefined && replies.length > 1))
  );
}

/**
 * Assigns one connector path to every visible run of consecutive prompts.
 *
 * The path begins on the run's one visible avatar, crosses otherwise ordinary
 * compact messages when necessary, branches at every task, and ends at the
 * final task. Search results opt out because they are independent hits rather
 * than a trustworthy uninterrupted run.
 */
function messageThreadPaths(timeline, groupConsecutive) {
  const paths = timeline.map(() => undefined);
  let groupStart = 0;
  while (groupStart < timeline.length) {
    let groupEnd = groupStart + 1;
    if (groupConsecutive) {
      while (groupEnd < timeline.length) {
        const previous = timeline[groupEnd - 1];
        const current = timeline[groupEnd];
        const startsNewDay =
          new Date(previous.at ?? 0).toDateString() !==
          new Date(current.at ?? 0).toDateString();
        if (!continuesUserMessageGroup(previous, current, startsNewDay)) {
          break;
        }
        groupEnd += 1;
      }
    }

    const branches = [];
    for (let index = groupStart; index < groupEnd; index += 1) {
      if (
        timeline[index].inlineReplyTo === undefined &&
        channelMessageHasTaskThread(timeline[index].entry)
      ) {
        branches.push(index);
      }
    }
    if (branches.length > 0) {
      const lastBranch = branches[branches.length - 1];
      for (let index = groupStart; index <= lastBranch; index += 1) {
        paths[index] = {
          start: index === groupStart,
          through: index < lastBranch,
          end: index === lastBranch,
        };
      }
    }
    groupStart = groupEnd;
  }
  return paths;
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
    return `<div class="chan-messages" id="chan-messages" role="log"
      aria-live="polite" aria-relevant="additions" aria-label="Channel messages"
      data-scroll-key="channel:${esc(repositoryId)}">${emptyState(
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
          entry.taskId !== undefined &&
          channelMessageHasTaskThread(entry),
      )
      .map((entry) => entry.taskId),
  );
  // A person's reply is a message in the room, not a branch off the message
  // it answers. Sitting it directly under its target pushed the newest thing
  // said back up into history — you replied and your own words appeared
  // somewhere above the bottom of the chat, sometimes off screen entirely.
  // So replies are folded into the one timeline by when they were written and
  // land where every other new message lands: at the end. The relationship is
  // not lost, it is carried by the reference line above the reply
  // (`inlineReplyTo`), which quotes the message and jumps to it when clicked —
  // the same way every other chat app does it.
  //
  // A merge rather than a sort of everything: the roots keep exactly the
  // order the transcript arrived in — reordering those on a clock the server
  // and the optimistic local copy do not always agree on would shuffle
  // history — and only the replies are placed, each after the last message
  // written before it. A reply newer than every root therefore ends up last,
  // which is the whole point.
  const stamp = (value) => {
    const parsed = Date.parse(value ?? "");
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const pending = [];
  for (const entry of entries) {
    if (
      entry.kind !== "user" ||
      (entry.taskId !== undefined && (entry.replies ?? []).length > 1)
    ) {
      continue;
    }
    for (const reply of entry.replies ?? []) {
      // A reply with no stamp of its own borrows its parent's, so it settles
      // next to the message it answers rather than at the top of the room.
      pending.push({
        entry: reply,
        inlineReplyTo: entry,
        at: reply.at ?? entry.at,
      });
    }
  }
  pending.sort((a, b) => stamp(a.at) - stamp(b.at));
  const timeline = [];
  let next = 0;
  for (const entry of entries) {
    // Strictly earlier, so a reply stamped the same millisecond as the
    // message it answers still lands after it rather than in front of it.
    while (next < pending.length && stamp(pending[next].at) < stamp(entry.at)) {
      timeline.push(pending[next]);
      next += 1;
    }
    timeline.push({ entry, inlineReplyTo: undefined, at: entry.at });
  }
  timeline.push(...pending.slice(next));
  const threadPaths = messageThreadPaths(timeline, query === "");
  let lastDay = "";
  // Where this visit found the room, as a timestamp — see `snapshotChannelRead`.
  // Suppressed while searching: the results are hits scattered through history,
  // not a transcript, and "New messages" drawn across them would be pointing at
  // a boundary that does not exist in what is on screen.
  const mark = query === "" ? channelUnreadMark(repositoryId) : undefined;
  const mine = currentUserId() || "you";
  let markDrawn = mark === undefined;
  const rows = timeline.map((item, index) => {
    const entry = item.entry;
    const day = new Date(item.at ?? Date.now()).toDateString();
    let separator = "";
    const startsNewDay = day !== lastDay;
    if (startsNewDay) {
      lastDay = day;
      const isToday = day === new Date().toDateString();
      separator = `<div class="chan-day">${isToday ? "Today" : esc(day)}</div>`;
    }
    // The first thing somebody else said after the reader last left. Above the
    // day separator rather than below it, so a night's backlog reads "you were
    // away from here" and then "and this is tomorrow", and it is the id
    // `channel-jump-unread` scrolls to.
    if (
      !markDrawn &&
      entry.authorId !== mine &&
      Date.parse(item.at ?? "") > mark
    ) {
      markDrawn = true;
      separator = `<div class="chan-unread" id="chan-unread"><span>New messages</span></div>${separator}`;
    }
    if (item.inlineReplyTo !== undefined) {
      return (
        separator +
        messageRow(entry, repositoryId, { inlineReplyTo: item.inlineReplyTo })
      );
    }
    const hideChanges =
      (entry.replies ?? []).length === 0 &&
      entry.taskId !== undefined &&
      threadedTasks.has(entry.taskId);
    // Search results are independent hits rather than a faithful transcript;
    // always name them so filtering an intervening author cannot create a
    // group that did not exist in the channel.
    const compact =
      query === "" &&
      continuesUserMessageGroup(timeline[index - 1], item, startsNewDay);
    return (
      separator +
      messageRow(entry, repositoryId, {
        hideChanges,
        compact,
        threadPath: threadPaths[index],
      })
    );
  });
  return `<div class="chan-messages" id="chan-messages" role="log"
    aria-live="polite" aria-relevant="additions" aria-label="Channel messages"
    data-scroll-key="channel:${esc(repositoryId)}">${rows.join(
    "",
  )}${typingIndicator(repositoryId, undefined)}</div>`;
}

/**
 * The emoji the picker offers, in the order every chat offers them.
 *
 * A short fixed set rather than a full emoji keyboard: the picker is for
 * answering a message without typing, and the long tail of emoji is a
 * different feature with a search box in it. These are the six or so that
 * carry an actual reply — yes, done, thanks, funny, watching, thinking — plus
 * the two that stand in for applause and disagreement.
 */
const REACTION_CHOICES = [
  "\u{1F44D}",
  "\u{1F389}",
  "\u2705",
  "\u{1F440}",
  "\u{1F64F}",
  "\u{1F602}",
  "\u{1F914}",
  "\u{1F44E}",
];

/**
 * The emoji choices, anchored to the button that asked for them.
 *
 * The server has always accepted any emoji on a reaction — the client was the
 * part that could only ever send one, so every reaction in the product was a
 * thumbs-up regardless of what somebody meant. This is the missing half.
 *
 * Which ones the reader has already left are marked, because the picker
 * doubles as the way to take one back: pressing a lit choice toggles it off,
 * the same as pressing the tally under the message.
 */
export function reactionPicker(anchor, repositoryId, messageId) {
  // Roots and thread replies both: the same row renders in both places, and a
  // reaction on a reply is a real row in the store — the picker marking only
  // roots would leave a reply's own reactions looking unset in it.
  const roots = channelMessagesFor(repositoryId);
  const message =
    roots.find((entry) => entry.id === messageId) ??
    roots
      .flatMap((entry) => entry.replies ?? [])
      .find((reply) => reply.id === messageId);
  const reactions = message?.reactions ?? {};
  const body = REACTION_CHOICES.map(
    (emoji) =>
      `<button type="button" class="react-choice${
        reactions[emoji]?.mine === true ? " mine" : ""
      }" data-act="channel-react-choose"
        data-value="${esc(messageId)}" data-emoji="${esc(emoji)}"
        title="${esc(emoji)}" aria-label="React with ${esc(emoji)}"
        aria-pressed="${reactions[emoji]?.mine === true ? "true" : "false"}">${emoji}</button>`,
  ).join("");
  showPopover(anchor, `<div class="react-grid">${body}</div>`, { width: 236 });
}

/**
 * A message's words on the clipboard.
 *
 * The text as it was written, minus the attachment reference lines the
 * composer appends — those are an internal address for a picture and paste as
 * noise into anything outside this app. Roots and thread replies both, since
 * the same row renders in both places.
 */
export async function copyMessageText(repositoryId, messageId) {
  const roots = channelMessagesFor(repositoryId);
  const entry =
    roots.find((message) => message.id === messageId) ??
    roots.flatMap((message) => message.replies ?? []).find(
      (reply) => reply.id === messageId,
    );
  // Removed rather than truncated at: `draftText` slices a *draft* at its
  // first attachment because a draft keeps its references in a block at the
  // end, but a sent message can have a picture in the middle of a sentence,
  // and slicing there would put half of it on the clipboard.
  const text = String(entry?.content ?? "")
    .replace(ATTACHMENT_PATTERN, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (text === "") {
    toast("That message has no text to copy", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Message copied");
  } catch {
    // A denied clipboard permission or an insecure origin. Saying so beats a
    // button that looks like it worked.
    toast("Could not reach the clipboard", "error");
  }
}

/**
 * The way back down, for a reader who has scrolled up.
 *
 * Rendered once with the channel and shown or hidden by class rather than by
 * re-rendering: whether somebody is following the conversation changes on
 * every wheel notch, and rebuilding the screen at that rate is the latency the
 * transcript spent a lot of effort not having. `paintJumpToLatest` is the only
 * thing that touches it after this.
 *
 * Two jobs in one control: with new messages behind it, it says how many and
 * carries the reader to the first of them; with none, it is the plain "back to
 * the bottom" every chat has.
 */
function jumpToLatest() {
  return `<button type="button" class="chan-jump" data-act="channel-jump-latest"
    hidden aria-label="Jump to the latest messages">
    <span class="chan-jump-count"></span>${icon("chevronDown")}</button>`;
}

/**
 * Shows, hides and labels that button against what the transcript is doing.
 *
 * Called from the scroll listener and after every render. Reads
 * `followingChannel`, which is the same flag the restore path uses to decide
 * whether to pin the bottom — so the pill is visible exactly when a new message
 * would *not* be scrolled to, which is the only time it has anything to offer.
 */
export function paintJumpToLatest() {
  const pill = document.querySelector(".chan-jump");
  if (pill === null) {
    return;
  }
  noteFollowChanged();
  const repositoryId = activeChannelId();
  // What the count is measured from. The visit's unread mark when there is one
  // — that is the older boundary and the one the reader actually cares about —
  // and otherwise the moment they scrolled away, so a room they had fully read
  // still tells them how much arrived behind their back.
  const since = channelUnreadMark(repositoryId) ?? leftBottomAt;
  const count = followingChannel ? 0 : channelNewSince(repositoryId, since);
  state.chanNewMessages[repositoryId] = count;
  // Against the node rather than against state: every render hands back a
  // fresh, blank pill, and a count remembered in state would leave that blank
  // label looking correct and never repaint it.
  if (pill.dataset.count !== String(count)) {
    pill.dataset.count = String(count);
    const label = pill.querySelector(".chan-jump-count");
    if (label !== null) {
      label.textContent = count === 0 ? "" : `${count > 99 ? "99+" : count} new`;
    }
    pill.classList.toggle("has-new", count > 0);
  }
  pill.hidden = followingChannel;
}

/**
 * When the reader last left the bottom of the transcript, or `undefined` while
 * they are still there. Module-level rather than in `state`: it is a fact about
 * this scroller in this tab, it means nothing after a reload, and it is written
 * from a scroll handler that must stay cheap.
 */
let leftBottomAt;

/** Keeps that stamp in step with the follow flag. Called wherever it changes. */
function noteFollowChanged() {
  if (followingChannel) {
    leftBottomAt = undefined;
  } else {
    leftBottomAt ??= Date.now();
  }
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
 * `progress` is the server's mark, and it is the whole test. The fallback that
 * used to sit behind it — treat any `agent` reply that is not an ending as
 * narration — was written for replies stored before that mark existed, and it
 * swallowed every sentence an agent addresses to a person inside a thread.
 *
 * That is what "they start on the task but they don't respond and confirm"
 * was. Asking for more work in a thread does get an acknowledgement, posted
 * before the task is even submitted — but it is a reply rather than a root, it
 * carries the default `agent` kind, and so it was filed as run chatter and
 * hoisted into a "Thinking" fold that renders closed once a thread has an
 * ending. The reader saw their request and then nothing. The same fold ate
 * "Starting now.", "Queued again — I'll report back here.", the held plan, and
 * every answer an agent gives to a question asked in a thread.
 *
 * The cost is threads older than the `progress` mark, whose narration is
 * stored as `agent` and now renders inline instead of folded. That is a couple
 * of days of history reading slightly long, against every agent reply since
 * being visible at all.
 */
function isThreadThinking(reply) {
  return reply.kind === "progress";
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
  // The two broadcast addresses, offered like any other name so they are
  // discoverable from the same "@" that reveals everyone else. `@agents` the
  // server answers with every reachable agent — questions only; `@everyone`
  // it turns into a ping for every person in the channel and no work at all.
  // Both first, and people after: a room's broadcast is the row somebody is
  // looking for when they open the picker with nothing typed, and the five
  // that fit are worth more to it than the fifth name down a list.
  const broadcast = [
    { name: "agents", kind: "broadcast", hint: "every agent" },
    { name: "everyone", kind: "broadcast", hint: "everyone here" },
  ].filter((entry) => query === "" || entry.name.includes(query));
  return [
    ...broadcast,
    ...channelParticipants(repositoryId)
      .filter((entry) => typeof entry.name === "string" && entry.name !== "")
      .filter(
        (entry) => query === "" || entry.name.toLowerCase().includes(query),
      ),
    // Five, not seven. The picker opens upward from the composer and covers
    // the conversation you are replying to, so every extra row is a line of
    // context taken away at the moment you most want it. Five is enough to
    // recognise a name; past that you are reading a directory, and typing
    // one more character narrows it faster than scanning does.
  ].slice(0, 5);
}

/**
 * The commands offered for what has been typed.
 *
 * Prefix rather than substring, matching the server's own `slashCommandsMatching`:
 * offering `/cancel` while somebody types `/can` is helping, offering it for
 * `/el` is guessing. The list comes from the server with the messages, so the
 * picker cannot offer something the channel would not recognise.
 */
function channelSlashCandidates(repositoryId, target = "channel") {
  const query = state.slashQuery.trim().toLowerCase();
  const matching = (state.channelSlashCommands[repositoryId] ?? []).filter(
    (entry) => String(entry.name ?? "").startsWith(query),
  );
  if (target === "thread") {
    // The server sends one channel-wide command list, with the general task
    // commands first. Reusing its first six entries in a thread pushed
    // `/retry` and `/cancel` below the picker's hard limit, even though those
    // are the two commands whose meaning is specifically tied to a thread.
    // Put every command the thread handles directly first. A more specific
    // query still finds any other command because ordering happens after the
    // prefix filter.
    const threadFirst = ["retry", "cancel", "push", "ask", "dnc", "simple"];
    matching.sort((left, right) => {
      const leftAt = threadFirst.indexOf(String(left.name ?? ""));
      const rightAt = threadFirst.indexOf(String(right.name ?? ""));
      return (
        (leftAt === -1 ? threadFirst.length : leftAt) -
        (rightAt === -1 ? threadFirst.length : rightAt)
      );
    });
  }
  return matching.slice(0, 6);
}

function slashPopover(candidates, target) {
  if (candidates.length === 0) {
    return `<div class="mention-pop"><div class="mention-item" style="color:var(--text-4)">No commands</div></div>`;
  }
  const index = state.slashIndex % candidates.length;
  return `<div class="mention-pop">${candidates
    .map(
      (entry, position) => `<button type="button" class="mention-item slash-item${
        position === index ? " active" : ""
      }" data-act="${target === "thread" ? "thread" : "channel"}-slash-pick"
        data-value="${esc(entry.name)}">
        <span class="slash-name">/${esc(entry.name)}</span>
        <span class="slash-summary">${esc(entry.summary ?? "")}</span>
      </button>`,
    )
    .join("")}</div>`;
}

function mentionPopover(candidates, target) {
  if (candidates.length === 0) {
    return `<div class="mention-pop"><div class="mention-item" style="color:var(--text-4)">No matches</div></div>`;
  }
  const index = state.mentionIndex % candidates.length;
  return `<div class="mention-pop">${candidates
    .map(
      (entry, position) => `<button type="button" class="mention-item${
        position === index ? " active" : ""
      }" data-act="${target === "thread" ? "thread" : "channel"}-mention-pick"
        data-value="${esc(entry.name)}">
        ${
          entry.kind === "broadcast"
            ? icon("users", 'width="20" height="20"')
            : entry.kind === "agent"
              ? agentFace(entry.agent, 18)
              : avatar(entry.name, 18)
        }
        <span>${esc(entry.name)}</span>
        <span class="mi-kind">${esc(
          entry.kind === "broadcast"
            ? (entry.hint ?? "everyone")
            : entry.kind === "agent"
              ? "agent"
              : "person",
        )}</span>
      </button>`,
    )
    .join("")}</div>`;
}

function composerSuggestions(repositoryId, target = "channel") {
  if (state.composerAutocompleteTarget !== target) {
    return "";
  }
  return `${
    state.slashActive
      ? slashPopover(channelSlashCandidates(repositoryId, target), target)
      : ""
  }${
    state.mentionActive
      ? mentionPopover(channelMentionCandidates(repositoryId), target)
      : ""
  }`;
}

function mentionActiveFor(target) {
  return state.composerAutocompleteTarget === target && state.mentionActive;
}

/** Repaints only the two small suggestion surfaces, never either transcript. */
function paintComposerSuggestions(repositoryId) {
  const channel = document.querySelector("[data-composer-suggestions]");
  if (channel !== null) {
    channel.innerHTML = composerSuggestions(repositoryId, "channel");
  }
  const thread = document.querySelector("[data-thread-composer-suggestions]");
  if (thread !== null) {
    thread.innerHTML = composerSuggestions(repositoryId, "thread");
  }
  document
    .querySelector(".chan-composer-wrap")
    ?.classList.toggle("mention-active", mentionActiveFor("channel"));
  document
    .querySelector(".thread-composer-wrap")
    ?.classList.toggle("mention-active", mentionActiveFor("thread"));
}


/**
 * The prompt an agent's question opens above the composer.
 *
 * Above the chat rather than inside it, because a question is not a message:
 * it is a wait. A message scrolls away while the run that needs it goes on
 * holding its workspace, and a numbered list in the transcript could not say
 * which of its options was already taken, page between six of them, or take
 * an answer nobody offered. This can, and it sits where the reader's hands
 * already are.
 *
 * One set at a time. Two prompts stacked over the composer is a form, and a
 * person who owes two agents an answer is better served by finishing one.
 */
function agentQuestionPrompt(repositoryId) {
  const pending = pendingQuestionFor(repositoryId);
  const questions = pending?.questions ?? [];
  if (pending === undefined || questions.length === 0) {
    return "";
  }
  const requestId = pending.requestId;
  const total = questions.length;
  const step = Math.min(
    Math.max(state.questionStep[requestId] ?? 0, 0),
    total - 1,
  );
  const current = questions[step];
  const answers = state.questionAnswers[requestId] ?? [];
  const picked = answers[step] ?? {};
  const sending = state.questionSending[requestId] === true;
  const askerName = String(
    channelAuthor(repositoryId, {
      kind: "agent",
      authorId: pending.agentId,
    }).name ?? "An agent",
  ).split(" (")[0];
  const thread = channelMessagesFor(repositoryId).find(
    (entry) => entry.id === pending.messageId,
  );
  const context = thread === undefined ? "" : threadTitle(thread);
  return `<div class="ask-prompt" data-request="${esc(requestId)}"
    role="dialog" aria-label="A question from ${esc(askerName)}">
    ${
      context === ""
        ? ""
        : `<div class="ask-context">${esc(askerName)} — ${esc(context)}</div>`
    }
    <div class="ask-card${sending ? " is-sending" : ""}">
      <div class="ask-head">
        <h4>${esc(current.question)}</h4>
        <div class="ask-head-tools">
          ${
            total === 1
              ? ""
              : `<div class="ask-pager">
                  <button type="button" class="ask-step" data-act="question-back"
                    ${step === 0 ? "disabled" : ""}
                    title="Previous question" aria-label="Previous question"
                    >${icon("chevronRight")}</button>
                  <span>${String(step + 1)} of ${String(total)}</span>
                  <button type="button" class="ask-step" data-act="question-next"
                    ${step === total - 1 ? "disabled" : ""}
                    title="Next question" aria-label="Next question"
                    >${icon("chevronRight")}</button>
                </div>`
          }
          <button type="button" class="ask-step" data-act="question-dismiss"
            title="Not now" aria-label="Not now">${icon("close")}</button>
        </div>
      </div>
      <div class="ask-options">
        ${current.options
          .map(
            (option, index) => `<button type="button"
              class="ask-option${picked.chosen === index ? " is-picked" : ""}"
              data-act="question-choose" data-value="${String(index)}">
              <span class="ask-num">${String(index + 1)}</span>
              <span class="ask-label">${esc(option)}</span>
              ${
                current.recommended === index
                  ? `<span class="ask-recommended">Recommended</span>`
                  : ""
              }
            </button>`,
          )
          .join("")}
      </div>
      <div class="ask-else${picked.text ? " is-picked" : ""}">
        <span class="ask-num">${icon("pencil")}</span>
        <input type="text" data-act="question-text" placeholder="Something else"
          value="${esc(picked.text ?? "")}" ${sending ? "disabled" : ""}>
        <button type="button" class="btn btn-ghost btn-sm ask-skip"
          data-act="question-skip">Skip</button>
      </div>
    </div>
  </div>`;
}

function composer(repositoryId) {
  // One lean bar: a "+" on the left, the text, and send on the right. Every
  // other affordance — attaching an image, running a command, addressing
  // somebody — lives behind the "+", which is where the two chat apps people
  // already use put them. A row of icons is a row of decisions offered before
  // there is anything to decide about; one control asks nothing until it is
  // pressed, and the bar stays the width of a sentence.
  //
  // Empty and unfocused, the composer shrinks further and its toolbar folds
  // into the compact bar — the rest is in styles.css, off the textarea's own
  // `:placeholder-shown`, so typing opens it without waiting for a render.
  // Three things it cannot see from there, because all three live outside the
  // form: an image staged for the next message, a thread that message is
  // aimed at, and an upload still in flight. Each of them is a pending
  // decision the bar has to stay open over, and each has a control on the row
  // that answers it.
  const pending =
    state.attaching > 0 ||
    state.composerThreadId !== undefined ||
    draftAttachments(repositoryId).length > 0;
  const replyTarget =
    state.composerThreadId === undefined
      ? undefined
      : channelMessagesFor(repositoryId).find(
          (entry) => entry.id === state.composerThreadId,
        );
  return `<div class="chan-composer-wrap${mentionActiveFor("channel") ? " mention-active" : ""}">
    <div data-composer-suggestions>${composerSuggestions(repositoryId, "channel")}</div>
    ${composerThreadChip(repositoryId)}
    ${draftAttachmentPreviews(repositoryId)}
    <form class="composer${pending ? " is-expanded" : ""}" data-act="channel-submit">
      <div class="composer-field">
        <!-- The ping colours the letters, which a textarea cannot do: it has
             one colour for all of its text. So the highlighting is painted by
             a div underneath holding the same string, and the textarea above
             it is made transparent apart from its caret. Everything typing
             depends on — selection, undo, spellcheck, IME, mobile keyboards —
             is still the real control; only the pixels come from the mirror.
             Hidden from assistive tech, because a screen reader should hear
             the textarea's value once and not twice. -->
        <div class="composer-mirror" data-composer-mirror aria-hidden="true"
          >${composerMirror(
            draftText(),
            channelParticipants(repositoryId),
          )}</div>
        <textarea data-act="channel-input" rows="1" spellcheck="true"
          enterkeyhint="send"
          placeholder="${
            state.composerThreadId === undefined
              ? `Message #${esc(repositoryId ?? "")}`
              : replyTarget?.kind === "user" &&
                  replyTarget.taskId === undefined
                ? "Write a reply..."
                : "Add to this thread..."
          }">${esc(draftText())}</textarea>
      </div>
      <div class="composer-bar">
        <!-- The input is the control; the menu entry only clicks it. A bare
             file input cannot be styled into this bar, and a label would take
             the click before the delegated handler ever saw it. -->
        <input type="file" data-act="channel-attach-input" accept="image/png,
          image/jpeg,image/gif,image/webp" multiple hidden>
        ${iconButton("plus", {
          act: "composer-plus",
          value: "channel",
          title: "Add to this message",
          cls: "composer-plus",
        })}
        ${state.attaching > 0
          ? `<span class="composer-note">attaching ${esc(String(state.attaching))} image(s)…</span>`
          : ""}
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
 * What kind of thing this panel is, said in one word above what it is called.
 *
 * Six different surfaces share the one column and each of them used to open
 * with nothing but a name in it — a repository path, a person, a thread's
 * first sentence — which are all things the transcript underneath is also full
 * of. So the panel arriving read as the conversation changing rather than as a
 * second surface over it. The word is the smallest thing that says "you
 * stepped aside into this, and it closes".
 */
function panelKind(label) {
  return `<span class="panel-kind">${esc(label)}</span>`;
}

/**
 * The control every one of those six surfaces is looked for first.
 *
 * One call rather than six spellings of the same `iconButton`, so the close
 * cannot drift apart from panel to panel — it was already three different
 * tooltips for the identical act.
 */
function panelClose(act, title) {
  return iconButton("close", { act, title, cls: "panel-close" });
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
      ${panelKind("Files")}
      <span class="spacer"></span>
      ${panelClose("chan-tree-close", "Close files (Esc)")}
    </header>
    <div class="thread-body tree-body" data-scroll-key="tree:${esc(repositoryId)}">
      ${
        // The workspace this lists is cut from canonical once and only moves
        // forward on its own while it is clean. A dirty one is somebody's
        // unfinished edit and is deliberately left where it is — but then this
        // panel is showing an old revision of the repository with nothing to
        // say so, which is how a repository with three files in it reads as a
        // repository with one. The endpoint that re-cuts it has existed all
        // along with nothing in the interface calling it.
        state.workspace?.exists === true &&
        typeof state.workspace.baseRevision === "string" &&
        typeof state.workspace.canonicalRevision === "string" &&
        state.workspace.baseRevision !== state.workspace.canonicalRevision
          ? `<div class="tree-stale">
               <span>These files are from an earlier version of the repository${
                 (state.workspace.dirtyFiles ?? []).length > 0
                   ? `, held back because you have unsaved edits in ${String(
                       (state.workspace.dirtyFiles ?? []).length,
                     )} file(s)`
                   : ""
               }.</span>
               <button class="btn btn-primary" type="button" data-act="workspace-reset">Update${
                 (state.workspace.dirtyFiles ?? []).length > 0
                   ? " and discard"
                   : ""
               }</button>
             </div>`
          : ""
      }
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
    .filter(
      (entry) =>
        (entry.replies ?? []).length > 0 &&
        (entry.kind !== "user" ||
          (entry.taskId !== undefined && (entry.replies ?? []).length > 1)),
    )
    .slice()
    .sort((left, right) => lastActivity(right).localeCompare(lastActivity(left)));
  return `<aside class="thread-panel">
    ${panelGrip()}
    <header class="thread-head">
      ${panelKind("Threads")}
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
      ${panelClose("channel-threads-close", "Close threads (Esc)")}
    </header>
    <div class="thread-body" data-scroll-key="thread-list:${esc(repositoryId)}">
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
                // The one thing a log of finished work cannot say for itself:
                // which of these is still moving. Marked from the task's own
                // status, the same signal that keeps the agent's typing dots
                // up in the channel, so the two never disagree about who is
                // working.
                const working = threadIsWorking(entry);
                // The other half of the same question. A held thread is not
                // working and not finished, and without this it read as the
                // latter — a row somebody had already dealt with — which is
                // precisely the thread that needs them.
                const held = threadAwaitsGoAhead(entry);
                // The subject leads: somebody scanning this log is looking
                // for a piece of work, and the agent's name told them which
                // colleague — the wrong first question. Who and how much
                // demote to one quiet line beneath, and the clock time goes
                // to the row's tooltip: the list is newest-first, so the
                // ordering already answers "when" for anybody scanning it.
                //
                // No leading glyph either. Every row carried the same terminal
                // mark: fifty identical icons down a list are a texture rather
                // than information, and this one was actively misleading — a
                // thread is a conversation about a piece of work, not a shell
                // session, so the mark promised a log of command output. There
                // was nothing meaningful to put in its place. The author's face
                // was the obvious candidate, but a thread is rooted in the
                // message that asked for the work, so that column would have
                // been the same person's avatar the whole way down. The name
                // leads instead, and the one thing worth spotting at a glance —
                // which thread is running — is already carried by the accent
                // wash and leading edge of `.thread-item-active`.
                return `<div class="thread-item-row">
                  <button type="button" class="thread-item${working ? " thread-item-active" : ""}${held ? " thread-item-held" : ""}"
                    title="${esc(
                      working
                        ? `Working now — started ${clockTime(entry.at)}`
                        : held
                          ? `Waiting for your go-ahead — started ${clockTime(entry.at)}`
                          : clockTime(entry.at),
                    )}"
                    data-act="channel-thread-open" data-value="${esc(entry.id)}">
                    <span class="ti-main">
                      <span class="ti-text">${esc(threadTitle(entry))}</span>
                      <span class="ti-meta">
                        <span class="ti-who">${esc(author.name)}</span>
                        <span class="ti-count">${esc(threadSaidCount(count))}</span>
                        ${
                          working
                            ? `<span class="ti-live"><span class="sr-only">Working</span></span>`
                            : held
                              ? `<span class="ti-held">Waiting for you</span>`
                              : ""
                        }
                      </span>
                    </span>
                    <span class="ti-go">${icon("chevronRight")}</span>
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
 * Matched by owner *and* vendor (`taskBelongsToAgent`). This used to be the
 * vendor alone, on the reasoning that a task records which vendor ran it and
 * not whose account paid for it — but it does record the owner, as
 * `submittedBy`, because a channel dispatch submits under the mentioned
 * agent's account rather than the sender's. Without that half, two people's
 * Codex in one room opened two panels showing one identical history.
 */
function agentHistoryRows(agent, repositoryId) {
  const messages = channelMessagesFor(repositoryId);
  return state.tasks
    .filter(
      (task) =>
        task.repositoryId === repositoryId &&
        // This agent's work, not this vendor's. The filter used to be the
        // vendor alone, which every Codex in the room answers to — so two
        // people each with a Codex connected opened two panels showing one
        // identical history, and neither could tell which rows were its own.
        taskBelongsToAgent(task, agent),
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

/**
 * How long a history line is allowed to be before it stops describing the work
 * and starts reproducing the request. Sized to the column: one line at the
 * panel's narrowest, so no row wraps and none is cut off mid-word by CSS
 * instead of by us.
 */
const BRIEF_OBJECTIVE_LIMIT = 72;

function capitalised(text) {
  return text === "" ? text : `${text[0].toUpperCase()}${text.slice(1)}`;
}

/** One clean clause, ending in an ellipsis when there was more. */
function shortened(text) {
  if (text.length <= BRIEF_OBJECTIVE_LIMIT) {
    return capitalised(text.replace(/[\s,;:]+$/u, ""));
  }
  const cut = text.slice(0, BRIEF_OBJECTIVE_LIMIT);
  const space = cut.lastIndexOf(" ");
  // A word boundary, unless the only one is so early that keeping it would
  // leave a couple of characters standing in for a sentence.
  const kept = space > BRIEF_OBJECTIVE_LIMIT / 2 ? cut.slice(0, space) : cut;
  return `${capitalised(kept.replace(/[\s,;:.]+$/u, ""))}…`;
}

/**
 * Enough of a request to recognise it, rather than the request itself.
 *
 * History rows printed the first line of the objective verbatim, so a panel of
 * forty tasks read as forty pasted prompts — carrying the "@zeus" that
 * dispatched them, whatever markdown the person happened to type, and running
 * on until the column cut them off. What a reader wants from this list is
 * which piece of work each row was.
 *
 * Deliberately mechanical: no model call and no stored field, so this costs
 * nothing and cannot disagree with the task it describes. It only ever
 * shortens text the row already had, and the untouched objective stays one
 * hover away on the row itself.
 */
function briefObjective(objective) {
  const body = withoutRolePreamble(objective)
    // Fenced code and pasted logs say how the request was written, not what it
    // asked for; inline code is worth keeping, just not its backticks.
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    // Emphasis and links are formatting for a message body, and this row is
    // not one: the words inside them are the description, the syntax is not.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/gu, (_match, starred, scored) =>
      starred ?? scored,
    );
  const line =
    body
      .split(/\r?\n/u)
      .map((entry) =>
        entry
          // Markdown scaffolding, then the mention that dispatched the work:
          // every row in this panel is that agent's, so its own name is the
          // one word the line cannot be telling the reader.
          .replace(/^\s*(?:[-*+>]|#{1,6}|\d+[.)])\s+/u, "")
          .replace(/^(?:\s*@[\w.-]+[,:]?\s*)+/u, "")
          .replace(/\s+/gu, " ")
          .trim(),
      )
      .find((entry) => entry.length > 0) ?? "";
  if (line === "") {
    return "";
  }
  // The leading sentence, but only when stopping there leaves something worth
  // reading: a full stop inside "app.js" or after "e.g" would otherwise cut a
  // row down to a fragment.
  const sentence = line.split(/(?<=[.!?])\s+/u)[0] ?? line;
  return shortened(sentence.length >= 24 ? sentence : line);
}

/**
 * The one line a history row shows for a task.
 *
 * The agent's own "Task: …" opener first, when the thread it was discussed in
 * has one. That title was written by the agent that did the work, from the
 * whole request — a description in the proper sense, which no amount of
 * client-side trimming can match. The condensed objective is the fallback for
 * everything dispatched outside a thread, or answered before the opener
 * landed.
 */
function taskSummaryLine(task, message) {
  const titled = threadTitleReply(message);
  const title =
    titled === undefined
      ? ""
      : String(titled.content)
          .replace(/^Task:\s*/u, "")
          .split("\n")[0]
          .replace(/\s+/gu, " ")
          .trim();
  return (
    (title === "" ? briefObjective(task.objective) : shortened(title)) ||
    "(no description)"
  );
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
      // A description of the work, not the words that asked for it. The
      // request is still here — on the row's tooltip, with its role preamble
      // taken off, for the reader who wants to know exactly what was said.
      const line = taskSummaryLine(task, message);
      const full = withoutRolePreamble(task.objective).trim();
      const open =
        message === undefined
          ? ""
          : ` role="button" tabindex="0" data-act="channel-thread-open"
              data-value="${esc(message.id)}"`;
      return `<div class="agent-history-row ${esc(task.status)}"${open}
        title="${esc(full)}">
        <span class="ah-glyph">${glyph}</span>
        <span class="ah-objective">${esc(line)}</span>
        <span class="ah-when">${esc(relativeTime(task.submittedAt))}</span>
      </div>`;
    })
    .join("")}</div>`;
}

/** Every loaded room this exact agent belongs to, with that room's overrides. */
function agentChannelAssignments(agent, repositoryId) {
  return state.repositories.flatMap((repository) => {
    // The active room is necessarily known well enough to have opened this
    // panel. Other rooms only become facts once their authoritative roster
    // has arrived; `agent-panel-open` starts those reads in the background.
    if (
      repository.id !== repositoryId &&
      !state.channelRosterLoaded.has(repository.id)
    ) {
      return [];
    }
    const member = channelAgentsFor(repository.id).find(
      (candidate) => candidate.id === agent.id,
    );
    return member === undefined ? [] : [{ repository, member }];
  });
}

function agentUsage(agent) {
  if (agent.mine !== true) {
    return `<div class="aspec-note">Usage is private to the agent's owner.</div>`;
  }
  const report = state.providerUsage[agent.provider ?? agent.id];
  if (report === undefined || report.loading === true) {
    return `<div class="aspec-note">Checking usage…</div>`;
  }
  if (report.unavailableReason !== undefined) {
    return `<div class="aspec-note">${esc(report.unavailableReason)}</div>`;
  }
  if ((report.windows ?? []).length === 0) {
    return `<div class="aspec-note">No usage reported.</div>`;
  }
  return `<div class="aspec-usage">
    ${report.windows
      .map((window) => {
        const percent = Math.max(0, Math.min(100, Number(window.percentUsed) || 0));
        return `<div>
          <div class="aspec-usage-head">
            <span>${esc(window.label)}</span>
            <strong>${Math.round(percent)}%</strong>
          </div>
          <div class="aspec-meter"><i style="width:${percent}%"></i></div>
          ${
            usageResetText(window) === ""
              ? ""
              : `<div class="aspec-usage-reset">${esc(usageResetText(window))}</div>`
          }
        </div>`;
      })
      .join("")}
    ${
      usageAccountLine(report) === ""
        ? ""
        : `<div class="aspec-usage-plan">${esc(usageAccountLine(report))}</div>`
    }
    ${
      report.source === undefined
        ? ""
        : `<div class="aspec-usage-source">${esc(report.source)}</div>`
    }
  </div>`;
}

/** The profile-like landing surface for an agent panel. */
function agentSpec(agent, repositoryId) {
  const assignments = agentChannelAssignments(agent, repositoryId);
  const agentTasks = [...activeTasks(), ...waitingTasks()].filter((candidate) =>
    taskBelongsToAgent(candidate, agent),
  );
  // Prefer work in the room the panel was opened from, but do not call an
  // agent idle while it is visibly working in another channel.
  const task =
    agentTasks.find((candidate) => candidate.repositoryId === repositoryId) ??
    agentTasks[0];
  const taskRepositoryId = task?.repositoryId ?? repositoryId;
  const taskMessage =
    task === undefined
      ? undefined
      : channelMessagesFor(taskRepositoryId).find((entry) => entry.taskId === task.id);
  const currentAssignment =
    assignments.find(({ repository }) => repository.id === repositoryId)?.member ?? agent;
  const status = agentStatus(agent, repositoryId);
  const allChannelsLoaded = state.repositories.every((repository) =>
    state.channelRosterLoaded.has(repository.id),
  );
  // The reference treats configuration as a short set of integrations rather
  // than a settings table. The controls stay in place, but each value now reads
  // as one compact connection chip beneath the profile introduction.
  const configurationChip = (label, control, title = "") =>
    `<div class="aspec-chip"${title === "" ? "" : ` title="${esc(title)}"`}>
      <span class="aspec-chip-label">${esc(label)}</span>
      <span class="aspec-chip-value">${control}</span>
    </div>`;
  const readOnly = (value) =>
    `<span class="aspec-chip-text">${esc(value)}</span>`;
  // Channel roles remain editable in the profile's capabilities list. This is
  // the same form contract as before, only presented like the checked rows in
  // the supplied design.
  const roleField = (repository, member, here = false) => `<form
    class="aspec-capability aspec-channel" data-act="agent-role-form"
    data-value="${esc(agent.id)}" data-repo="${esc(repository.id)}">
    <span class="aspec-capability-mark">${icon("check")}</span>
    <span class="aspec-capability-copy">
      <span class="aspec-capability-title">${
        here ? "Role in this channel" : `#${esc(repository.id)}`
      }</span>
      <span class="aspec-capability-meta">${
        here ? `How ${esc(agent.name)} contributes in #${esc(repository.id)}` : "Channel role"
      }</span>
    </span>
    <input class="aspec-role" data-act="agent-role-input"
      data-value="${esc(agent.id)}" data-repo="${esc(repository.id)}"
      value="${esc(member.role ?? "")}" maxlength="120" autocomplete="off"
      enterkeyhint="done" placeholder="Not set"
      aria-label="Role for ${esc(agent.name)} in #${esc(repository.id)}">
  </form>`;
  // Model and reasoning are the agent's own credential spending its owner's
  // account, so only that owner picks them; a teammate reads what was chosen.
  // A role is the opposite — it is this channel's declaration of what the
  // agent is *for*, so anybody in the room may write one, and the server has
  // the last word on the two roles that mean something (auditor, investigator).
  const providerId = agent.provider ?? agent.id;
  const models = agent.mine === true ? providerModelOptions(providerId) : [];
  const efforts =
    agent.mine === true
      ? providerEffortOptions(providerId, currentAssignment.model ?? "")
      : [];
  const optionsNote = agent.mine === true ? providerOptionsNote(providerId) : "";
  // Personal or org-wide. Unlike the two rows under it this is not a channel
  // override at all — it is the stored credential's own field, so the answer
  // is the same in every room and only its owner may change it. It sits with
  // Connection above the per-channel settings for that reason, and says so in
  // the chip's tooltip rather than in another line of prose.
  const visibility = agent.visibility === "org" ? "org" : "personal";
  const configuration = `<div class="aspec-chip-grid" data-agent="${esc(agent.id)}">
      ${configurationChip("Connection", readOnly(agentLabelOf(providerId)), providerId)}
      ${configurationChip(
        "Visibility",
        agent.mine === true
          ? miniSelect(
              "channel-agent-visibility",
              [
                { value: "personal", label: "Only me" },
                { value: "org", label: "Anyone in the org" },
              ],
              visibility,
              "Who may @mention this agent to submit work",
            )
          : readOnly(
              visibility === "org" ? "Anyone in the org" : "Only its owner",
            ),
        `Set on the connection, so it applies wherever this agent works — not just #${repositoryId}`,
      )}
      ${configurationChip(
        "Model",
        models.length === 0
          ? readOnly(currentAssignment.model || "Default")
          : miniSelect(
              "channel-agent-model",
              models,
              currentAssignment.model ?? "",
              "Model in this channel",
            ),
      )}
      ${configurationChip(
        "Reasoning",
        efforts.length === 0
          ? readOnly(currentAssignment.effort || "Default")
          : miniSelect(
              "channel-agent-effort",
              efforts,
              currentAssignment.effort ?? "",
              "Reasoning effort in this channel",
            ),
      )}
    </div>`;
  // The room the panel was opened from is already the whole first section, so
  // it is not repeated in the list underneath it; that list is only "and here
  // is everywhere else this agent works".
  const elsewhere = assignments.filter(
    ({ repository }) => repository.id !== repositoryId,
  );
  const currentRepository =
    state.repositories.find((repository) => repository.id === repositoryId) ?? {
      id: repositoryId,
    };
  const currentRole = String(currentAssignment.role ?? "").trim();
  const description =
    currentRole === ""
      ? `Ready to take on work in #${repositoryId}. Review how this agent is connected, who can task it, and how it is configured for this channel.`
      : `Focused on ${currentRole} in #${repositoryId}. Review how this agent is connected, who can task it, and how it is configured for this channel.`;
  return `<div class="agent-spec">
    <div class="aspec-content">
      <section class="aspec-head">
        <span class="aspec-face">
          ${agentFace(agent, 68)}
          ${statusDot(status, AGENT_STATUS_TITLE[status])}
        </span>
        <h2>${esc(agent.name)}</h2>
        <p class="aspec-description">${esc(description)}</p>
        <div class="aspec-sub">${esc(AGENT_STATUS_TITLE[status])} · #${esc(
          repositoryId,
        )}${agent.mine ? " · Your agent" : ""}</div>
      </section>

      <section class="aspec-section">
        <h3 class="aspec-label">Works with</h3>
        ${configuration}
        ${optionsNote === "" ? "" : `<div class="aspec-note">${esc(optionsNote)}</div>`}
      </section>

      <section class="aspec-section">
        <h3 class="aspec-label">Capabilities</h3>
        <div class="aspec-capabilities">
          ${roleField(currentRepository, currentAssignment, true)}
          <div class="aspec-capability aspec-current-task">
            <span class="aspec-capability-mark">${icon("check")}</span>
            <span class="aspec-capability-copy">
              <span class="aspec-capability-title">${
                task === undefined
                  ? "Available for new work"
                  : esc(taskSummaryLine(task, taskMessage))
              }</span>
              <span class="aspec-capability-meta">${
                task === undefined
                  ? `No task is running in #${esc(repositoryId)}`
                  : `${esc(
                      String(task.status ?? "working").replaceAll("_", " "),
                    )} · #${esc(taskRepositoryId)} · ${esc(relativeTime(task.submittedAt))}`
              }</span>
            </span>
            <button type="button" class="aspec-nav" data-act="agent-panel-tab"
              data-value="history" title="Task history">
              <span>History</span>${icon("arrowRight")}</button>
          </div>
        </div>
        <div class="aspec-note">A role is what this agent is for here; it rides
          on every task submitted in this channel.${
            // Said where the switch is, because "anyone in the org" reads like
            // handing over the key otherwise: it decides who may @mention the
            // agent, and the credential behind it is still never shared.
            agent.mine === true
              ? ` Sharing it with the org lets teammates @mention it —
          the credential itself is never shared.`
              : ""
          }</div>
      </section>

      ${
        elsewhere.length === 0 && allChannelsLoaded
          ? ""
          : `<section class="aspec-section">
              <div class="aspec-label-row">
                <h3 class="aspec-label">Also in</h3>
                <span class="aspec-count">${elsewhere.length}</span>
              </div>
              ${
                elsewhere.length === 0
                  ? ""
                  : `<div class="aspec-capabilities aspec-channels">
                      ${elsewhere
                        .map(({ repository, member }) => roleField(repository, member))
                        .join("")}
                    </div>`
              }
              ${
                allChannelsLoaded
                  ? ""
                  : `<div class="aspec-note">Checking remaining channels…</div>`
              }
            </section>`
      }

      <section class="aspec-section aspec-usage-section">
        <div class="aspec-label-row">
          <h3 class="aspec-label">Usage</h3>
          ${
            agent.mine === true
              ? iconButton("refresh", {
                  act: "agent-usage-refresh",
                  value: providerId,
                  title: "Check usage again",
                  small: true,
                })
              : ""
          }
        </div>
        <div class="aspec-usage-card">${agentUsage(agent)}</div>
      </section>
    </div>
  </div>`;
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
  const requestedTab = state.agentPanelTab ?? "spec";
  const tab =
    requestedTab === "history" || requestedTab === "spec"
      ? requestedTab
      : canChatPrivately
        ? "chat"
        : "spec";
  // Every way out of the details page is one header control on the right, and
  // each one is a toggle back to the details when it is the view you are in.
  // The tab strip that used to say Details / Private chat is gone: it was a
  // second navigation band under a header that already had room for it, and it
  // could only ever offer two of the three places this panel goes.
  const headerAction = (view, iconName, title) =>
    iconButton(tab === view ? "robot" : iconName, {
      act: "agent-panel-tab",
      value: tab === view ? "spec" : view,
      title: tab === view ? "Back to agent details" : title,
      small: true,
      cls: tab === view ? "on" : "",
    });
  // The header is the panel's first grid row directly. It used to be wrapped
  // in `.agent-panel-head` so it could share that row with a tab strip — but
  // that class is also the settings screen's agent header, and the two
  // definitions merged into a column flex box that centred its child: the
  // header shrank to its own content and floated in the middle of the panel,
  // hairline and all, while the page under it stayed full width.
  return `<aside class="thread-panel agent-detail-panel">
    ${panelGrip()}
    <header class="thread-head">
      ${panelKind(
        tab === "history" ? "Agent history" : tab === "chat" ? "Agent chat" : "Agent",
      )}
      <span class="dm-head-name">
        ${agentFace(agent, 20)}
        ${esc(agent.name)}
      </span>
      <span class="spacer"></span>
      ${canChatPrivately ? headerAction("chat", "chatBubble", "Private chat") : ""}
      ${headerAction("history", "history", "Task history")}
      ${panelClose("agent-panel-close", "Close agent panel (Esc)")}
    </header>
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
        : tab === "history"
          ? agentHistory(agent, repositoryId)
          : agentSpec(agent, repositoryId)
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
  const repositoryId = activeChannelId();
  const dmPending =
    (state.dmAttaching ?? 0) > 0 ||
    draftAttachments(repositoryId, state.dmDraft).length > 0;
  return `<aside class="thread-panel">
    ${panelGrip()}
    <header class="thread-head">
      ${panelKind("Direct")}
      <span class="dm-head-name">
        ${avatar(name, 20)}
        ${esc(name)}
        ${statusDot(online ? "working" : "away", online ? "Here" : "Away")}
      </span>
      <span class="spacer"></span>
      ${panelClose("dm-close", "Close conversation (Esc)")}
    </header>
    <div class="thread-body dm-body" data-scroll-key="dm:${esc(userId)}">
      ${
        messages.length === 0
          ? `<p class="dm-empty">No messages yet. This conversation is just
             between you and ${esc(name)} — it is not in the channel.</p>`
          : messages
              .map((message) => {
                const mine = message.authorId === currentUserId();
                return `<div class="dm-msg${mine ? " dm-mine" : ""}">
                  <div class="dm-bubble cmsg-text">${messageBody(
                    message.content,
                    repositoryId,
                    [],
                  )}</div>
                  <span class="dm-msg-actions">${iconButton("reply", {
                    act: "dm-reply-quote",
                    value: message.id,
                    title: "Reply to this message",
                    small: true,
                  })}${
                    // Only your own, and there is no tombstone: the two people
                    // here are the whole audience, so unsending takes it off
                    // both screens and leaves nothing to explain.
                    mine
                      ? iconButton("trash", {
                          act: "dm-delete",
                          value: message.id,
                          title: "Delete this message",
                          small: true,
                        })
                      : ""
                  }</span>
                  <time class="dm-time">${esc(clockTime(message.createdAt))}</time>
                </div>`;
              })
              .join("")
      }
    </div>
    <div class="thread-composer-wrap">
      ${draftAttachmentPreviews(repositoryId, {
        draft: state.dmDraft,
        removeAct: "dm-attachment-remove",
      })}
      <form class="composer${dmPending ? " is-expanded" : ""}" data-act="dm-submit"
        style="margin:0 12px 12px">
        <textarea data-act="dm-input" rows="1" enterkeyhint="send"
          placeholder="Message ${esc(name)}...">${esc(draftText(state.dmDraft))}</textarea>
        <div class="composer-bar">
          <input type="file" data-act="dm-attach-input" accept="image/png,
            image/jpeg,image/gif,image/webp" multiple hidden>
          ${iconButton("paperclip", {
            act: "dm-attach",
            title: "Attach images",
            small: true,
          })}
          ${(state.dmAttaching ?? 0) > 0
            ? `<span class="composer-note">attaching ${esc(String(state.dmAttaching))} image(s)…</span>`
            : ""}
          <span class="spacer"></span>
          <button class="send-btn" type="submit" title="Send">${icon("send")}</button>
        </div>
      </form>
    </div>
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
  const hasReplies = (root.replies?.length ?? 0) > 0;
  // The subject in the header, where a reader looks first. "Thread" only
  // when nothing names it — and the title being here is what the fold
  // comment inside threadReplies has assumed all along.
  const title = threadTitle(root) || "Thread";
  // The same pending state the channel bar keeps itself open over, for the
  // same reason: an image staged for the next reply, or one still uploading,
  // is something to send with no text at all — and on a phone the idle bar
  // folds its note away unless it is told the box is not idle.
  const threadPending =
    state.threadAttaching > 0 ||
    draftAttachments(repositoryId, state.threadDraft).length > 0;
  return `<aside class="thread-panel">
    ${panelGrip()}
    <header class="thread-head">
      ${panelKind("Thread")}
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
      ${panelClose("channel-thread-close", "Close thread (Esc)")}
    </header>
    <div class="thread-body"
      data-scroll-key="thread:${esc(repositoryId)}:${esc(messageId)}">
      <div class="thread-root${hasReplies ? " has-replies" : ""}">${messageRow(root, repositoryId, { isReply: true })}</div>
      ${threadReplies(root, repositoryId)}
      ${threadTyping(root)}
      ${typingIndicator(repositoryId, root.id)}
    </div>
    <div class="thread-composer-wrap${mentionActiveFor("thread") ? " mention-active" : ""}">
      <div data-thread-composer-suggestions>${composerSuggestions(repositoryId, "thread")}</div>
      ${draftAttachmentPreviews(repositoryId, {
        draft: state.threadDraft,
        removeAct: "thread-attachment-remove",
      })}
      <form class="composer${threadPending ? " is-expanded" : ""}" data-act="channel-thread-submit">
        <div class="composer-field">
          <div class="composer-mirror" data-composer-mirror aria-hidden="true"
            >${composerMirror(
              draftText(state.threadDraft),
              channelParticipants(repositoryId),
            )}</div>
          <textarea data-act="channel-thread-input" rows="1" spellcheck="true"
            enterkeyhint="send"
            placeholder="Reply in thread...">${esc(draftText(state.threadDraft))}</textarea>
        </div>
        <div class="composer-bar">
          <!-- Same arrangement as the channel bar: the input is the control
               and the button only clicks it, because a bare file input cannot
               be styled into the bar and a label would swallow the click
               before the delegated handler saw it. One paperclip rather than
               the channel's "+" menu — attaching is the only thing this
               composer adds to a message, and a menu holding one item is a
               click asking to be skipped. -->
          <input type="file" data-act="channel-thread-attach-input" accept="image/png,
            image/jpeg,image/gif,image/webp" multiple hidden>
          ${iconButton("paperclip", {
            act: "thread-attach",
            title: "Attach images",
            small: true,
          })}
          ${state.threadAttaching > 0
            ? `<span class="composer-note">attaching ${esc(String(state.threadAttaching))} image(s)…</span>`
            : ""}
          <span class="spacer"></span>
          <button class="send-btn" type="submit" title="Send">${icon("send")}</button>
        </div>
      </form>
    </div>
  </aside>`;
}

/**
 * Splits a thread into turns without inventing a task identifier in the UI.
 *
 * Every request that starts or extends work is stored as a `user` reply before
 * that run's progress. It is therefore the durable boundary between turns,
 * including a task explicitly added to an existing thread. Replies before the
 * first such boundary are retained as a legacy opening turn; threads whose
 * root is itself the request never needed a copied user reply.
 */
function threadReplyTurns(replies) {
  const turns = [];
  let turn = { prompt: undefined, replies: [] };
  let ended = false;
  const finish = () => {
    if (turn.prompt !== undefined || turn.replies.length > 0) {
      turns.push(turn);
    }
  };
  for (const reply of replies) {
    // A human prompt is the usual boundary. An outcome is also a durable
    // boundary for work merged into this thread automatically: that path can
    // add the next agent acknowledgement and run without copying the channel
    // prompt into the reply list.
    if (reply.kind === "user" || ended) {
      finish();
      turn = {
        prompt: reply.kind === "user" ? reply : undefined,
        replies: [],
      };
      ended = false;
      if (reply.kind === "user") {
        continue;
      }
    }
    turn.replies.push(reply);
    ended = reply.kind === "outcome";
  }
  finish();
  return turns;
}

/** One turn's narration, with state independent from every other turn. */
function threadThinkingBlock(rootId, turn, index) {
  // A task title belongs to the fold only when it opens this turn. A later
  // agent reply that happens to begin "Task:" is something the agent said to
  // the reader and must stay visible.
  const [first, ...rest] = turn.replies;
  const titleLine = /^Task: /u.test(String(first?.content ?? ""))
    ? first
    : undefined;
  const body = titleLine === undefined ? turn.replies : rest;
  const steps = body.filter(isThreadThinking);
  if (steps.length === 0 && titleLine === undefined) {
    return { html: "", visible: body };
  }

  const key = `${rootId}:thinking:${index}`;
  // Silent at zero. A task that has been stated and not yet worked on has a
  // block holding the request alone, and "0 steps" reads as a failure rather
  // than work that has not started.
  const count =
    steps.length === 0
      ? ""
      : `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  const html = `<details class="thread-thinking"${
    // Every turn starts folded. Its independent key still keeps an explicit
    // reader choice stable as more progress arrives for this turn alone.
    state.thinkingOpen[key] === true ? " open" : ""
  }>
    <summary data-act="thinking-toggle" data-value="${esc(key)}">
      <span class="tt-label">Thinking</span>
      <span class="tt-count">${esc(count)}</span></summary>
    <div class="tt-body">${
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
  </details>`;
  return {
    html,
    visible: body.filter((reply) => !isThreadThinking(reply)),
  };
}

/**
 * Renders each request with the thinking and answer that belong to that turn.
 *
 * The old renderer filtered the whole thread into one progress pile and one
 * reply pile. That moved every Thinking disclosure to the top, above even the
 * prompt that caused it, and made a re-prompt look like it produced no new
 * work. Keeping the same fold per turn preserves chronology and causality.
 */
function threadReplies(root, repositoryId) {
  const replies = root.replies ?? [];
  if (replies.length === 0) {
    return `<div class="thread-count">No replies yet</div>`;
  }
  const titled = threadTitleReply(root);
  const said = replies.filter(
    (reply) => reply !== titled && !isThreadThinking(reply),
  );
  const flow = threadReplyTurns(replies)
    .map((turn, index) => {
      const thinking = threadThinkingBlock(root.id, turn, index);
      return `${
        turn.prompt === undefined
          ? ""
          : summaryBlock(turn.prompt, repositoryId)
      }${thinking.html}${thinking.visible
        .map((reply) => summaryBlock(reply, repositoryId))
        .join("")}`;
    })
    .join("");
  return `<section class="thread-replies" aria-label="${esc(
    threadSaidCount(said.length),
  )}">
    <div class="thread-replies-head" aria-hidden="true">
      <span>${esc(threadSaidCount(said.length))}</span>
    </div>
    <div class="thread-replies-flow">${flow}</div>
  </section>`;
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
  // The *last* reply, not any of them. A thread whose earlier turn ended is
  // exactly where somebody asks for the next one, and asking whether the
  // thread has ever ended meant the dots never came back for it — the same
  // turn whose acknowledgement was being folded away, so it went quiet twice.
  if (
    root.kind !== "agent" ||
    replies.length === 0 ||
    isThreadEnding(replies[replies.length - 1])
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
      ${panelKind("File")}
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
      ${panelClose("chan-file-close", "Close files (Esc)")}
    </header>
    ${
      editing
        ? fileEditor(path)
        : `<div class="thread-body code-body"
             data-scroll-key="file:${esc(activeChannelId())}:${esc(path)}:diff">${
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
    return `<div class="thread-body fp-editor-wrap"
      data-scroll-key="file:${esc(activeChannelId())}:${esc(path)}:loading">
      <p class="fp-note">Reading ${esc(path)}…</p>
    </div>`;
  }
  if (state.chanFileError !== undefined) {
    const hasDiff = (state.changeSet?.patches ?? []).some(
      (entry) => entry.path === path,
    );
    return `<div class="thread-body fp-editor-wrap"
      data-scroll-key="file:${esc(activeChannelId())}:${esc(path)}:error">
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
  return `<div class="thread-body fp-editor-wrap"
      data-scroll-key="file:${esc(activeChannelId())}:${esc(path)}:edit">
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
    ${
      // Bringing the repository up to date with GitHub. It lived on the
      // repositories screen, which this interface no longer has — leaving a
      // person whose pull had just been refused with nowhere to settle it.
      // Offered only where there is a GitHub origin to sync from.
      state.repositories.find((repo) => repo.id === repositoryId)?.provider ===
      "github"
        ? `<div class="pop-block">
             <button type="button" class="btn btn-sm"
               data-act="channel-sync" data-value="${esc(repositoryId)}">
               ${icon("sync")} Sync from GitHub
             </button>
             <p>Brings this project up to date with what has landed on
               GitHub. Needed before pushing when the two have both moved
               on.</p>
           </div>`
        : ""
    }
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
        "Create or import a repository to open its channel — every repository becomes a channel here, with its agents in the roster.",
        `<button class="btn btn-primary" data-act="repo-create" style="margin-top:6px">${icon(
          "plus",
        )} Create new repository</button>
        <button class="btn" data-act="repo-connect">${icon(
          "link",
        )} Import from GitHub</button>`,
      )}
    </div></div></div>`;
  }
  const repositoryId = activeChannelId();

  return `<div class="chats-shell${state.chanSidebarOpen === true ? " roster-open" : ""}${state.chanCollapsed ? " chan-collapsed" : ""}">
    ${chanSidebar(repositoryId)}
    ${
      // Phone-only scrim over the off-canvas `.chan-sidebar` — see the toggle
      // button in `chanHeader`. Tapping outside the drawer is how it closes,
      // the same as `.tree-scrim` over the file tree.
      //
      // Rendered unconditionally, unlike `.tree-scrim`: a drawer being dragged
      // out under a finger is a third of the way open at some point, and it
      // wants a scrim a third of the way dark, which an element that only
      // exists once the drawer is fully open cannot be. It is transparent and
      // untouchable until then, and hidden outright above the phone
      // breakpoint — see `.chan-sidebar-scrim` in styles.css.
      `<div class="chan-sidebar-scrim" data-act="chan-sidebar-close"></div>`
    }
    <div class="chan-main">
      ${chanHeader(repositoryId)}
      ${chanSearchRow()}
      ${pinnedBanner(repositoryId)}
      ${messageList(repositoryId)}
      ${jumpToLatest()}
      ${agentQuestionPrompt(repositoryId)}
      ${composer(repositoryId)}
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

/**
 * The transcript's height as the follow flag last saw it.
 *
 * The soft keyboard, the collapsing address bar and the composer growing an
 * attachment thumbnail all change how tall the scroller is, and the browser
 * answers by firing `scroll` on a container the reader never touched. Measured
 * against a stale height that reads as "they scrolled a long way up", so the
 * conversation stopped following itself because somebody opened the keyboard.
 */
let followHeight = 0;

export function scrollChannel() {
  const list = document.querySelector("#chan-messages");
  if (list !== null) {
    list.scrollTop = list.scrollHeight;
    followHeight = list.clientHeight;
    followingChannel = true;
    paintJumpToLatest();
  }
}

/**
 * The first message this visit had not seen, or the bottom when there is none.
 *
 * The unread line is the more useful destination of the two: somebody coming
 * back to a busy room wants the start of what they missed, not the end of it.
 */
export function jumpToUnreadOrLatest() {
  const target = document.getElementById("chan-unread");
  if (target === null) {
    scrollChannel();
    return;
  }
  target.scrollIntoView({ block: "center" });
}

/**
 * Where the reader had a transcript, in terms of what they were reading.
 *
 * Taken before the render that replaces the DOM; `restoreChannelAnchor` puts
 * it back afterwards. A message id rather than a pixel offset, because
 * history loading in above the reader moves every offset but not the line
 * they had their eyes on. The offset is kept as the tie-breaker for the
 * scrollers whose rows carry no id, and for a message that has since gone.
 */
const SCROLL_SURFACES = ["#chan-messages", ".thread-body"];

export function captureChannelScroll() {
  return SCROLL_SURFACES.map((selector) => {
    const scroller = document.querySelector(selector);
    if (scroller === null) {
      return undefined;
    }
    const edge = scroller.getBoundingClientRect().top;
    // The first row still on screen: what the reader is looking at, as
    // opposed to the rows that have scrolled off above it.
    const anchor = [...scroller.querySelectorAll("[id]")].find(
      (node) => node.getBoundingClientRect().bottom > edge,
    );
    return {
      selector,
      // Panels share `.thread-body` — a thread, a direct message, the file
      // editor. Restoring one panel's offset into the next would be a
      // position the reader never had, so the shape has to match too.
      shape: scroller.className,
      key: scroller.dataset.scrollKey,
      top: scroller.scrollTop,
      // Read this from the node now, not from the last scroll event. Browsers
      // may deliver that event after a live update has already started its
      // render, and a stale `followingChannel` is exactly how a reader who had
      // just moved up got snapped back to the latest message.
      following:
        selector === "#chan-messages"
          ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
            FOLLOW_SLACK_PX
          : undefined,
      id: anchor?.id,
      offset:
        anchor === undefined ? 0 : anchor.getBoundingClientRect().top - edge,
    };
  }).filter((saved) => saved !== undefined);
}

/**
 * Puts a transcript back where `captureChannelScroll` found it.
 *
 * Called with the new DOM in place, before `restoreChannelScroll` — following
 * the bottom and a requested jump both outrank standing still, and both are
 * that function's job. This is what happens the rest of the time, and what
 * used to happen instead was nothing at all: the replaced node starts at
 * `scrollTop` 0, so a reader who was scrolled up anywhere in the history got
 * the first message ever sent, every time anything rendered.
 */
export function restoreChannelAnchor(saved) {
  watchImageSizes();
  for (const entry of saved ?? []) {
    const scroller = document.querySelector(entry.selector);
    if (
      scroller === null ||
      scroller.className !== entry.shape ||
      scroller.dataset.scrollKey !== entry.key
    ) {
      continue;
    }
    const anchor =
      entry.id === undefined ? null : document.getElementById(entry.id);
    if (anchor === null) {
      // The message is gone — filtered out by a search, or off the end of the
      // loaded history. The raw offset is still closer than the top.
      scroller.scrollTop = entry.top;
    } else {
      scroller.scrollTop =
        anchor.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        entry.offset;
    }
    heldAnchors.set(entry.selector, { entry, applied: scroller.scrollTop });
  }
}

/**
 * The anchor each surface is currently sitting on, and the offset that put it
 * there.
 *
 * A picture decoding late is the one thing that moves a reader *after* the
 * restore above has finished: it adds its real height in the middle of
 * history that was already laid out, and everything below — including the
 * message being read — slides. The anchor is a message id and a distance from
 * the top of the scroller, so re-applying the same one puts that message back
 * under the reader's eyes whatever grew above it.
 *
 * `applied` is how this knows it still may. If the scroller has moved since
 * the restore, the reader moved it, or the follow pin did, and either way
 * this has no business reaching in.
 */
const heldAnchors = new Map();

let imageWatchBound = false;

/**
 * Measures every image the app draws, once, and holds the reader still when
 * the measurement changes what they are looking at.
 *
 * On `document` rather than on the transcript, and bound once rather than per
 * render: `load` does not bubble, so this is a capture-phase listener, and
 * that also catches the composer's staged thumbnail. Measuring there is worth
 * having — an image is staged before it is posted, so by the time the message
 * appears in the transcript its shape is already known and the very first
 * render of it is the right size.
 */
function watchImageSizes() {
  if (imageWatchBound) {
    return;
  }
  imageWatchBound = true;
  document.addEventListener(
    "load",
    (event) => {
      const node = event.target;
      if (node?.tagName !== "IMG" || !rememberImageSize(node)) {
        return;
      }
      // A size nobody had measured means the box just changed from the
      // stylesheet's guess to the truth, which moved everything below it.
      for (const [selector, held] of heldAnchors) {
        const scroller = document.querySelector(selector);
        if (
          scroller === null ||
          !scroller.contains(node) ||
          scroller.scrollTop !== held.applied
        ) {
          continue;
        }
        restoreChannelAnchor([held.entry]);
      }
    },
    true,
  );
}

/**
 * Puts the transcript back where the reader had it, after a render replaced
 * it. Called with the new DOM in place.
 */
export function restoreChannelScroll(saved) {
  const list = document.querySelector("#chan-messages");
  if (list === null) {
    return;
  }
  const captured = (saved ?? []).find(
    (entry) =>
      entry.selector === "#chan-messages" &&
      entry.key === list.dataset.scrollKey,
  );
  if (captured?.following !== undefined) {
    followingChannel = captured.following;
  }
  followHeight = list.clientHeight;
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
    // The pin above measured a transcript that may still be settling: a
    // picture nobody has measured yet holds the stylesheet's guessed box
    // until its bytes arrive. Settling on the next frame catches the text
    // that laid itself out late; the `load` handler below catches the
    // pictures whose real shape turns out not to be the guess.
    requestAnimationFrame(() => {
      const settled = document.querySelector("#chan-messages");
      // A second render can replace the node before this callback runs. Never
      // let an old render reach forward and move the new transcript.
      if (settled === list && followingChannel) {
        settled.scrollTop = settled.scrollHeight;
        followHeight = settled.clientHeight;
      }
    });
  }
  paintJumpToLatest();
  if (list.dataset.followBound === "1") {
    return;
  }
  list.dataset.followBound = "1";
  // A viewport resize and a finger drag can produce the same scroll event on
  // a phone. Record the reader's intent before that event: the height-change
  // branch below may keep following through a keyboard/address-bar resize,
  // but it must not turn an upward wheel or drag into a jump to the bottom.
  list.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaY < 0) {
        followingChannel = false;
      }
    },
    { passive: true },
  );
  let touchStartY;
  list.addEventListener(
    "touchstart",
    (event) => {
      touchStartY = event.touches[0]?.clientY;
    },
    { passive: true },
  );
  list.addEventListener(
    "touchmove",
    (event) => {
      const y = event.touches[0]?.clientY;
      if (touchStartY !== undefined && y !== undefined && y > touchStartY + 4) {
        followingChannel = false;
      }
    },
    { passive: true },
  );
  // `load` does not bubble, so the transcript listens for it on the way down
  // rather than binding every image. An attachment that decodes after the
  // pin adds its full height above the newest message otherwise, which reads
  // as the conversation drifting upward on its own. This is the follow half;
  // `watchImageSizes` holds a reader who is *not* following, on this surface
  // and on the thread panel beside it.
  list.addEventListener(
    "load",
    () => {
      if (followingChannel) {
        list.scrollTop = list.scrollHeight;
        followHeight = list.clientHeight;
      }
    },
    true,
  );
  list.addEventListener("scroll", () => {
    const height = list.clientHeight;
    // Not the reader: the scroller changed size under them and the browser
    // adjusted. Following is theirs to turn off by scrolling away, and a
    // keyboard opening is not that.
    if (height !== followHeight) {
      followHeight = height;
      if (followingChannel) {
        list.scrollTop = list.scrollHeight;
      }
      return;
    }
    const distance = list.scrollHeight - list.scrollTop - height;
    followingChannel = distance <= FOLLOW_SLACK_PX;
    paintJumpToLatest();
  });
  paintJumpToLatest();
}

export function openChannel(repositoryId, rerender) {
  // The draft belongs to the room it was typed in. Parked before anything else
  // moves, because after `state.repositoryId` changes there is no longer a way
  // to tell which channel the words in the composer were meant for — which is
  // how a half-written message used to follow the reader into the next channel
  // and sit there waiting to be sent to the wrong people.
  const leaving = state.repositoryId;
  if (leaving !== undefined && leaving !== repositoryId) {
    saveChannelDraft(leaving, state.chatDraft);
    flushChannelDrafts();
  }
  state.repositoryId = repositoryId;
  persist("ag.repo", repositoryId);
  // Only when the room actually changed. Re-opening the one already on screen
  // — which is what tapping the current channel in the sidebar does — must not
  // reach into a live composer: an upload writes its reference into
  // `state.chatDraft` without going through a keystroke, so the parked copy can
  // be a few characters behind the real one, and swapping it in would drop the
  // picture somebody had just staged.
  if (leaving !== repositoryId) {
    state.chatDraft = channelDraft(repositoryId);
  }
  // Before `markChannelRead`, which is what makes the room read: this is the
  // "you were here" line, and it has to be taken while there is still a
  // boundary to take.
  snapshotChannelRead(repositoryId);
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
    const target = channelMessagesFor(repositoryId).find(
      (entry) => entry.id === continuing,
    );
    const posted = postChannelReply(repositoryId, continuing, state.chatDraft);
    if (posted === undefined) {
      return;
    }
    state.chatDraft = "";
    saveChannelDraft(repositoryId, "");
    closeComposerAutocomplete("channel");
    // A direct reply is one message, not a mode the composer stays trapped
    // in. Continuing an agent task remains sticky as before.
    const directReply =
      target?.kind === "user" && target.taskId === undefined;
    if (directReply) {
      state.composerThreadId = undefined;
    }
    markChannelRead(repositoryId);
    rerender();
    // The reply is now the last line of the room, so it gets the same ending
    // as any other message sent: the transcript goes to the bottom, where the
    // words that were just typed are. Jumping to the message being answered —
    // which is what this did while replies were drawn underneath it — sent
    // the reader back up into history the moment they hit send.
    if (directReply) {
      scrollChannel();
    }
    return;
  }
  const sent = sendChannelMessage(repositoryId, state.chatDraft, "user");
  if (sent === undefined) {
    return;
  }
  state.chatDraft = "";
  saveChannelDraft(repositoryId, "");
  closeComposerAutocomplete("channel");
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
  const directReply = root.kind === "user" && root.taskId === undefined;
  const author = channelAuthor(repositoryId, root);
  const title = `${directReply ? `${author.name}: ` : ""}${threadTitle(root)}`;
  return `<div class="composer-thread">
    ${icon("reply")}
    <span class="ct-label">${directReply ? "Replying to" : "Continuing in"}</span>
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
  // The whole draft, references included: the reply carries its images the
  // same way a channel message does, and `messageBody` reads them back out.
  postChannelReply(activeChannelId(), state.activeChannelThread, state.threadDraft);
  state.threadDraft = "";
  closeComposerAutocomplete("thread");
  rerender();
}

/**
 * Closes whichever picker a composer was showing, because it just sent.
 *
 * Both pickers are a suggestion about the word under the cursor, and sending
 * takes that word — the whole draft — away. Leaving either one open left a
 * list of commands hanging over an emptied composer with nothing left to
 * complete: the popup outlives the message it was helping to write, and,
 * since only typing reopens the question, it stays there through a channel
 * switch and everything after it.
 *
 * The query and the highlighted row go with it. A stale `/dep` left behind
 * would decide what the next `/` offers before a single character of it has
 * been typed.
 */
function closeComposerAutocomplete(target) {
  if (state.composerAutocompleteTarget !== target) {
    return;
  }
  state.mentionActive = false;
  state.mentionQuery = "";
  state.mentionIndex = 0;
  state.slashActive = false;
  state.slashQuery = "";
  state.slashIndex = 0;
}

function autocompleteSnapshot() {
  return (
    `${String(state.composerAutocompleteTarget)} ` +
    `${String(state.mentionActive)} ${state.mentionQuery} ` +
    `${String(state.slashActive)} ${state.slashQuery}`
  );
}

/** Updates the live layers around a composer without rebuilding the screen. */
function updateComposerPresentation(node, target) {
  const before = autocompleteSnapshot();
  updateMentionState(node, target);
  paintComposerMirror(node);

  node.style.height = "auto";
  if (node.value !== "") {
    node.style.height = `${Math.min(node.scrollHeight, 148)}px`;
  }

  if (autocompleteSnapshot() !== before) {
    paintComposerSuggestions(activeChannelId());
  }
}

/**
 * A keystroke in the thread reply box, without losing a staged image.
 *
 * The textarea only ever shows the visible half of the draft, so writing its
 * value straight into `state.threadDraft` — which is what this used to do,
 * back when a thread had nothing to stage — would drop the reference lines an
 * upload appended and post the words without the picture. Same split, and the
 * same reasoning, as `updateComposerInput` beside it; no render, because the
 * textarea is already showing the character that was just typed and rebuilding
 * the screen for it is what made typing lag.
 */
export function updateThreadComposerInput(node) {
  const references = draftAttachments(activeChannelId(), state.threadDraft)
    .map((attachment) => attachment.reference)
    .join("\n");
  state.threadDraft = `${node.value}${references === "" ? "" : `\n${references}\n`}`;
  updateComposerPresentation(node, "thread");
}

function updateMentionState(node, target = "channel") {
  state.composerAutocompleteTarget = target;
  const value = node.value;
  const cursor = node.selectionStart ?? value.length;
  const before = value.slice(0, cursor);
  // A slash that starts a word, anywhere in the message — the same rule the
  // server now parses by (`parseSlashCommand` in slash.ts). It used to have
  // to be the very first thing typed, which nothing on screen said and
  // nobody could infer: a person who had written the mention first got a
  // slash that opened nothing.
  //
  // The word boundary is what keeps a path out. `src/retry.ts` and `and/or`
  // have no space before the slash, so neither opens the picker, and a
  // command that matches nothing shows no popover anyway.
  const slash = /(^|\s)\/([a-z0-9-]*)$/iu.exec(before);
  state.slashActive = slash !== null;
  if (slash !== null) {
    state.slashQuery = slash[2] ?? "";
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

export function updateComposerInput(node) {
  const references = draftAttachments(activeChannelId())
    .map((attachment) => attachment.reference)
    .join("\n");
  state.chatDraft = `${node.value}${references === "" ? "" : `\n${references}\n`}`;
  saveChannelDraft(activeChannelId(), state.chatDraft);
  // What the screen actually shows about a draft is the suggestion popup and
  // nothing else: the send button is always enabled, and the textarea already
  // holds the character that was just typed. Only that small popup needs an
  // update when its query changes.
  //
  // It used to happen on every keystroke, and a render here is not cheap — it
  // rebuilds the whole app, destroying the textarea being typed into, then
  // finds its replacement, refocuses it and restores the selection. With a
  // long transcript behind it that is the latency between pressing a key and
  // seeing the letter, on the one screen where responsiveness is the entire
  // experience.
  // Both pickers, not just the mention one: their small suggestion surface is
  // updated whenever either popup changes. Rebuilding the full app for that
  // used to reparse the transcript, sidebar and roster after every character
  // typed following "/" or "@".
  updateComposerPresentation(node, "channel");
}

/**
 * Puts the chosen command in, and leaves the cursor where the request goes.
 *
 * A trailing space rather than a newline: the command is the start of a
 * sentence that usually continues with an "@" and an objective, and the
 * mention picker is what should open next.
 */
function composerTarget(target) {
  return target === "thread"
    ? { selector: "[data-act='channel-thread-input']", draft: "threadDraft" }
    : { selector: "[data-act='channel-input']", draft: "chatDraft" };
}

export function pickSlashCommand(name, rerender, target = "channel") {
  const { selector, draft } = composerTarget(target);
  const node = document.querySelector(selector);
  const source = state[draft] ?? "";
  const cursor = node?.selectionStart ?? draftText(source).length;
  const before = source.slice(0, cursor);
  const after = source.slice(cursor);
  // The same boundary `updateMentionState` opened the picker on, so what is
  // completed is the word the picker was offering — whatever came before it
  // in the message is kept.
  const replaced = before.replace(/(^|\s)\/([a-z0-9-]*)$/iu, `$1/${name} `);
  state[draft] = replaced + after;
  state.composerAutocompleteTarget = target;
  state.slashActive = false;
  state.slashQuery = "";
  rerender();
  const next = document.querySelector(selector);
  if (next !== null) {
    const pos = replaced.length;
    next.focus({ preventScroll: true });
    next.setSelectionRange(pos, pos);
  }
}

export function pickMention(name, rerender, target = "channel") {
  const { selector, draft } = composerTarget(target);
  const node = document.querySelector(selector);
  const source = state[draft] ?? "";
  const cursor = node?.selectionStart ?? draftText(source).length;
  const before = source.slice(0, cursor);
  const after = source.slice(cursor);
  const replaced = before.replace(/@([\w.-]*)$/u, `@${name} `);
  state[draft] = replaced + after;
  state.composerAutocompleteTarget = target;
  state.mentionActive = false;
  state.mentionQuery = "";
  rerender();
  const next = document.querySelector(selector);
  if (next !== null) {
    const pos = replaced.length;
    next.focus({ preventScroll: true });
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







export function handleComposerKeydown(event, rerender) {
  // An IME accepting a candidate is not input to the composer: acting on
  // that Enter sends the message mid-word, and the same press steered the
  // pickers below too. Checked before anything else claims a key.
  if (imeComposing(event)) {
    return;
  }
  const target =
    event.target?.dataset?.act === "channel-thread-input" ? "thread" : "channel";
  const ownsSuggestions = state.composerAutocompleteTarget === target;
  // The same four keys as the mention picker, because they are the same
  // gesture — a list under the cursor that Up/Down move through, Enter or Tab
  // accepts, and Escape dismisses. Handled first, and only one picker is ever
  // open at a time (see `updateMentionState`), so the two cannot both claim
  // an Enter.
  if (ownsSuggestions && state.slashActive) {
    const list = channelSlashCandidates(activeChannelId(), target);
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
      pickSlashCommand(
        list[state.slashIndex % list.length].name,
        rerender,
        target,
      );
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      state.slashActive = false;
      rerender();
      return;
    }
  }
  if (ownsSuggestions && state.mentionActive) {
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
      pickMention(list[state.mentionIndex % list.length].name, rerender, target);
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
    if (target === "thread") {
      submitThreadReply(rerender);
    } else {
      submitComposerMessage(rerender);
    }
  }
}
