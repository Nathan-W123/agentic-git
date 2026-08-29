import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The agent profile, and the history it shares a panel with.
 *
 * The panel is 518px wide at the size this product is normally read at, with
 * about 523px of usable height under its header. The profile it held came to
 * roughly 744px: a banner nearly a hundred pixels tall, an identity card, a
 * strip of pills repeating the header, five separately outlined panes each
 * with its own heading, a permanent paragraph about a provider's model cache,
 * and a full-width History button — the loudest control on a page whose
 * subject is an agent you want to keep working with. So the four settings the
 * panel exists for were below the fold, and the way to reach them was to
 * scroll past everything that was already true.
 *
 * What is asserted here is the shape that answers that, in the same way the
 * rest of this browser surface is pinned — against the source, because the
 * dashboard ships as plain ES modules and one stylesheet with no bundler and
 * the test run has no browser:
 *
 *   four zones, sized so an idle profile is one screen;
 *   a reserved slot for the one part of it that changes on its own;
 *   one outer boundary, not a border per section;
 *   continuing the work is the primary action and History is beside it;
 *   history rows are rows, not cards;
 *   profile and history are two states of one shell, and the swap moves only
 *     what is inside it and puts focus back where the press came from.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

/** The whole profile: the four zone builders and what composes them. */
function profileSource(chats: string): string {
  const start = chats.indexOf("function specPill(text,");
  const end = chats.indexOf("function agentPanel()");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return chats.slice(start, end);
}

/** One rule's declarations, by exact selector. */
function rule(css: string, selector: string): string {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const found = new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\n\\}`, "u").exec(css);
  assert.notEqual(found, null, `${selector} should be styled`);
  return found?.[1] ?? "";
}

/** The declared value of one custom property in the stylesheet's root block. */
function token(css: string, name: string): string | undefined {
  return new RegExp(`\\n {2}${name}: ([^;]+);`, "u").exec(css)?.[1];
}

test("the profile is four zones on one surface, not six cards", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const spec = profileSource(chats);

  // Identity, current work, runtime, context — built separately and composed
  // in that order, so each one's height is something that can be reasoned
  // about rather than whatever its contents came to.
  for (const zone of [
    "agentIdentityZone",
    "agentCurrentWorkZone",
    "agentRuntimeZone",
    "agentContextZone",
  ]) {
    assert.match(spec, new RegExp(`function ${zone}\\(agent, repositoryId,`, "u"));
  }
  assert.match(
    spec,
    /\$\{agentIdentityZone\([\s\S]*?\$\{agentCurrentWorkZone\([\s\S]*?\$\{agentRuntimeZone\([\s\S]*?\$\{agentContextZone\(/u,
    "the profile should compose its zones in the order it presents them",
  );

  // One outer boundary — the panel. Zones are separated by 16-20px of space,
  // and the single faint divider is the one between the settings and the
  // facts about the agent under them.
  assert.match(rule(css, ".agent-spec .aspec-content"), /gap: 18px;/u);
  const identity = rule(css, ".agent-spec .aspec-identity");
  const runtime = rule(css, ".agent-spec .aspec-settings");
  const context = rule(css, ".agent-spec .aspec-context");
  assert.doesNotMatch(identity, /^\s*border: 1px/mu);
  assert.doesNotMatch(runtime, /border/u);
  assert.match(context, /border-top: 1px solid var\(--border-soft\);/u);
  // The banner, the identity card and the per-section panes are gone.
  for (const retired of [
    ".agent-spec .aspec-banner",
    ".agent-spec .aspec-identity-card",
    ".agent-spec .aspec-pane",
    ".agent-spec .aspec-pane-title",
    ".agent-spec .aspec-editing",
    ".agent-spec .aspec-bottom-grid",
  ]) {
    assert.doesNotMatch(css, new RegExp(retired.replaceAll(".", "\\."), "u"));
  }

  // Sizes, because "compact" is only a claim until it is a number. The
  // identity zone is 88-104px, the name 18-20px, labels 11-12px, values
  // 13-14px, and every control at least 36px tall.
  assert.match(identity, /min-height: 88px;/u);
  assert.match(rule(css, ".agent-spec .aspec-identity-id h2"), /font-size: 19px;/u);
  assert.match(rule(css, ".agent-spec .aspec-field-label"), /font-size: 11px;/u);
  const control = rule(
    css,
    ".agent-spec .aspec-native-select,\n.agent-spec .aspec-field-value",
  );
  assert.match(control, /height: 36px;/u);
  assert.match(control, /font: 500 13px\/1\.35 var\(--font\);/u);
  assert.match(rule(css, ".agent-spec .aspec-action"), /min-height: 36px;/u);
  // Icon-only targets are 32px square even where their glyph is 13, and even
  // where the app's own small icon button is 26.
  const info = rule(css, ".agent-spec .aspec-info");
  assert.match(info, /width: 32px;/u);
  assert.match(info, /height: 32px;/u);
  const targets = rule(
    css,
    ".agent-spec .icon-btn.sm,\n.agent-history-row .icon-btn.sm",
  );
  assert.match(targets, /width: 32px;/u);
  assert.match(targets, /height: 32px;/u);
  // Taken back in block margin only: pulling the inline edges in would
  // overlap the target beside it.
  assert.match(targets, /margin-block: -3px;/u);

  // Two columns for the runtime, two for the context — Model, Reasoning,
  // Connection and Visibility, then Channels beside Usage.
  assert.match(runtime, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u);
  assert.match(rule(css, ".agent-spec .aspec-runtime"), /min-height: 124px;/u);
  assert.match(context, /grid-template-columns: minmax\(0, 0\.8fr\) minmax\(0, 1\.2fr\);/u);
  assert.match(
    spec,
    /"Model",[\s\S]*?"Reasoning",[\s\S]*?"Connection",[\s\S]*?"Visibility",/u,
  );

  // One natural scroller for the exceptions — a provider fault, a long task
  // title, four usage windows — and nothing nested inside it to be trapped
  // in, on a phone or anywhere else.
  const surface = rule(css, ".agent-spec");
  assert.match(surface, /overflow-y: auto;/u);
  assert.doesNotMatch(rule(css, ".agent-spec .aspec-channel-list"), /overflow/u);
});

test("the profile says what is running in a slot that reserves its height", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const spec = profileSource(chats);

  // Idle names the room rather than the absence: this panel is opened to
  // start work, and "Available in #KUMI" is where.
  assert.match(spec, /`Available in #\$\{esc\(room\)\}`/u);
  assert.match(spec, /class="aspec-zone aspec-work\$\{/u);
  assert.match(spec, /task === undefined \? "" : " is-active"/u);

  // 56px idle, 72px running, and fixed within each — a phase arriving, a
  // percentage moving or the primary action appearing when the task's own
  // message is found must not shift the four controls underneath.
  assert.match(rule(css, ".agent-spec .aspec-work"), /min-height: 56px;/u);
  assert.match(
    rule(css, ".agent-spec .aspec-work.is-active"),
    /min-height: 72px;/u,
  );

  // The phase is an ordinary `phase-slot`, so the render loop already owns
  // its crossfade, its coalescing window and its reduced-motion behaviour.
  // A second mechanism here would be a second answer to the same question.
  assert.match(spec, /class="aspec-work-phase phase-slot"/u);
  assert.match(spec, /data-phase-slot="agent-profile:\$\{esc\(agent\.id\)\}"/u);
  assert.match(rule(css, ".phase-slot"), /min-height: 1\.3em;/u);
  assert.match(
    rule(css, ".phase-changing"),
    /animation: phase-swap var\(--motion-pop\) var\(--ease-motion\);/u,
    "a status change is a 140ms crossfade, inside the 120-160ms the panel asks for",
  );

  // The work zone itself is still. The large face keeps the run's progress
  // fill, but its presence dot and the second dot beside the status text are
  // suppressed because the panel header already carries that signal.
  assert.doesNotMatch(rule(css, ".agent-spec .aspec-work"), /animation/u);
  assert.match(
    spec,
    /statusAgentFace\(agent, 52, repositoryId, \{\s*showPresence: false,\s*\}\)/u,
  );
  assert.match(spec, /const facts = \[\s*\{ text: statusText \},/u);
  assert.doesNotMatch(spec, /\{ text: statusText, dot:/u);
});

test("continuing the work is the primary action and History is beside it", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const spec = profileSource(chats);

  // Running work opens its own thread; idle work of your own opens the
  // private chat; an org agent, which has no private chat by design, is
  // tasked in the room the profile is covering. Three cases, one loud button.
  assert.match(
    spec,
    /aspec-action-primary"\s*\n\s*data-act="channel-thread-open"[\s\S]*?<span>Open thread<\/span>/u,
  );
  assert.match(
    spec,
    /aspec-action-primary"\s*\n\s*data-act="agent-panel-tab" data-value="chat">[\s\S]*?<span>Message \$\{esc\(first\)\}<\/span>/u,
  );
  assert.match(
    spec,
    /aspec-action-primary"\s*\n\s*data-act="agent-panel-close">[\s\S]*?<span>Message in #\$\{esc\(room\)\}<\/span>/u,
  );
  // The full-width History button that used to dominate the page is a quiet
  // control beside the primary one — and it still says the word, because an
  // important action needs a label rather than a clock glyph.
  assert.match(
    spec,
    /class="aspec-action aspec-action-quiet"\s*\n\s*data-act="agent-panel-tab" data-value="history">[\s\S]*?<span>History<\/span>/u,
  );
  assert.match(rule(css, ".agent-spec .aspec-action-quiet"), /background: none;/u);
  assert.match(
    rule(css, ".agent-spec .aspec-action-primary"),
    /background: var\(--accent\);/u,
  );

  // Rename, delete and the rest are the roster row's own menu. Two answers to
  // "what may I do to this agent" would be one too many.
  assert.match(spec, /act: "roster-agent-menu"/u);
  assert.match(spec, /value: agent\.id,/u);
});

test("the provider caveat is an affordance, and a fault is not", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");
  const spec = profileSource(chats);

  // Codex reports its models from a cache its own CLI writes locally, and
  // saying so took a permanent paragraph under the settings of every profile,
  // on every visit, for something that changes what one field accepts. It is
  // an "i" beside that field now.
  assert.match(spec, /function specInfoButton\(act, value, title\)/u);
  assert.match(spec, /aria-haspopup="dialog"/u);
  assert.match(spec, /specInfoButton\(\s*"agent-provider-note",/u);
  assert.match(spec, /export function agentProviderNotePopoverHtml\(agent, providerId\)/u);
  assert.match(
    app,
    /case "agent-provider-note": \{[\s\S]*?agentProviderNotePopoverHtml\(about, about\.provider \?\? about\.id\)/u,
  );
  // Never for nothing: no note, no button.
  assert.match(spec, /optionsNote === "" && !blocking\s*\n\s*\? ""/u);

  // A deployment that could not report its options at all is a fault, and a
  // fault stays on the page.
  assert.match(
    spec,
    /const blocking =\s*\n\s*agent\.mine === true && state\.providerOptions\[providerId\] === null;/u,
  );
  assert.match(spec, /class="aspec-alert" role="status"/u);
  // And it says so in words as well as in colour.
  const alert = rule(css, ".agent-spec .aspec-alert");
  assert.match(alert, /border: 1px solid color-mix\(in srgb, var\(--orange\)/u);
  assert.match(rule(css, ".agent-spec .aspec-alert svg"), /color: var\(--orange\);/u);

  // The rooms the context strip has no width for are a popover, not a clipped
  // strip — and the full list is on the control's own title either way.
  assert.match(spec, /export function agentChannelsPopoverHtml\(agent, repositoryId\)/u);
  assert.match(
    app,
    /case "agent-channels-more": \{[\s\S]*?agentChannelsPopoverHtml\(listed, activeChannelId\(\)\)/u,
  );
  assert.match(spec, /\+\$\{extra\.length\} more/u);
});

test("a history row is a row, and its extras wait to be wanted", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");
  const start = chats.indexOf("function agentHistoryRow(");
  const history = chats.slice(
    start,
    chats.indexOf("function agentHistory(agent, repositoryId)", start),
  );

  // 56-64px: the outcome, one line of request, and the facts under it.
  const row = rule(css, ".agent-history-row");
  assert.match(row, /min-height: 56px;/u);
  assert.match(row, /border: 1px solid transparent;/u);
  assert.match(history, /class="ah-objective"/u);
  assert.match(history, /class="ah-when"/u);
  assert.match(history, /class="ah-files"/u);
  assert.match(history, /historyStatusPill\(task\.status\)/u);
  // File count only where there is one.
  assert.match(history, /changed\.length === 0\s*\n\s*\? ""/u);

  // The face was this agent's own, repeated down a list of its own work,
  // beside a column of prose repeating what the row already said.
  assert.doesNotMatch(history, /statusAgentFace/u);
  assert.doesNotMatch(css, /\.agent-history-row \.ah-face/u);
  assert.doesNotMatch(css, /\.agent-history-row \.ah-preview \{/u);

  // Open and rerun survive, on hover or focus rather than as forty permanent
  // buttons in a resting list — and unconditionally where there is no hover
  // to wait for.
  assert.match(history, /act: "channel-thread-open"/u);
  assert.match(history, /act: "task-retry"/u);
  assert.match(rule(css, ".agent-history-row .ah-actions"), /opacity: 0;/u);
  assert.match(css, /\.agent-history-row:focus-within \.ah-actions/u);
  assert.match(css, /@media \(hover: none\)/u);

  // Search, filters and the Active/Recently split are untouched, and a
  // keystroke in the box must not replay an entrance for every surviving row.
  assert.match(chats, /searchBox\(\s*"Search recent tasks\.\.\.",/u);
  assert.match(chats, /segmented\(\s*"agent-history-filter",/u);
  assert.match(chats, /class="ah-section-label">Active</u);
  assert.match(chats, /class="ah-section-label">Recently</u);
  assert.match(row, /animation: none;/u);
});

test("profile and history are two states of one shell", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");
  const panel = chats.slice(
    chats.indexOf("function agentPanel()"),
    chats.indexOf("function dmPanel()"),
  );

  // The shell is the same element in both views: same panel, same grip, same
  // header, same close. Only what it holds changes.
  assert.match(panel, /<aside class="thread-panel agent-detail-panel">/u);
  assert.match(panel, /\$\{panelGrip\(\)\}/u);
  assert.match(panel, /\$\{panelClose\("agent-panel-close", "Close agent panel \(Esc\)"\)\}/u);
  assert.match(panel, /class="agent-panel-view" data-agent-view="\$\{esc\(tab\)\}"/u);
  assert.match(
    rule(css, ".agent-detail-panel > .agent-panel-view"),
    /min-height: 0;/u,
  );
  // It arrives a beat behind the shell on opening, the way `.thread-body`
  // does for every other panel — as its own rule, because the thread panel's
  // pair of children is pinned as a pair.
  assert.match(
    rule(css, ".thread-panel.panel-entering > .agent-panel-view"),
    /animation: panel-content-in var\(--motion-content\) var\(--ease-motion\) 40ms/u,
  );

  // The swap is inner content only, at 190ms — inside the 160-200ms the panel
  // asks for, and taken from the existing token rather than a new one.
  assert.match(
    rule(css, ".agent-panel-view.agent-view-swapping"),
    /animation: agent-view-swap var\(--motion-panel-out\) var\(--ease-motion\);/u,
  );
  assert.equal(token(css, "--motion-panel-out"), "0.19s");
  const swap = /@keyframes agent-view-swap \{([\s\S]*?)\n\}\n/u.exec(css)?.[1];
  assert.match(swap ?? "", /opacity: 0;/u);
  assert.doesNotMatch(swap ?? "", /transform/u, "the shell stays still");

  // Played from the press, not from the render diff: a poll tick redraws this
  // element too, and CSS cannot tell the two apart.
  assert.match(app, /function playAgentViewSwap\(\)/u);
  assert.match(app, /animateOnce\(view, "agent-view-swapping", false\)/u);
  const handler = app.slice(
    app.indexOf('case "agent-panel-tab": {'),
    app.indexOf('case "agent-panel-close"'),
  );
  assert.match(handler, /playAgentViewSwap\(\);/u);

  // And focus goes back to the control the press came from — the header's own
  // toggle, or the History button in the work zone, whichever was used.
  assert.match(handler, /const fromHead = node\.closest\("\.thread-head"\) !== null;/u);
  assert.match(handler, /returnFocusToAgentPanelTrigger\(value, fromHead\);/u);
  const focus = app.slice(
    app.indexOf("function returnFocusToAgentPanelTrigger("),
    app.indexOf("function sidePanelOpen()"),
  );
  assert.match(focus, /const back = view === "spec" \? "history" : "spec";/u);
  assert.match(focus, /\(fromHead \? inHead : inBody\) \?\? inHead \?\? inBody/u);
  assert.match(focus, /target\?\.focus\(\{ preventScroll: true \}\)/u);

  // Escape still closes, and closing still puts the surface away rather than
  // leaving it open and invisible.
  assert.match(app, /case "agent-panel-close":\s*\n\s*clearRightPanel\("agent"\);/u);
});

test("the profile opens with the layout and stops for direct manipulation", async () => {
  const css = await publicFile("styles.css");

  // 190ms, opacity and 10px of horizontal travel — the width is part of the
  // animation, so the conversation gives up its column over the same interval
  // rather than jumping aside a frame early.
  assert.match(
    css,
    /\.chats-shell \.agent-detail-panel\.panel-entering,\n\.chats-shell\.panels-2 \.agent-detail-panel\.panel-entering,\n\.chats-shell\.panels-3 \.agent-detail-panel\.panel-entering \{\n {2}animation: agent-panel-in var\(--motion-panel-out\) var\(--ease-motion\);/u,
  );
  const entering = /@keyframes agent-panel-in \{([\s\S]*?)\n\}\n/u.exec(css)?.[1];
  assert.match(entering ?? "", /width: 0;/u);
  assert.match(entering ?? "", /transform: translateX\(10px\);/u);
  const leaving = /@keyframes agent-panel-out \{([\s\S]*?)\n\}\n/u.exec(css)?.[1];
  assert.match(leaving ?? "", /transform: translateX\(10px\);/u);

  // A drag is direct manipulation of the width everything inside the panel is
  // laid out against, and `animation` and `transition` do not inherit — so
  // the panel being quiet is not the same as its contents being quiet.
  assert.match(
    rule(css, "body.resizing-panel .agent-detail-panel *"),
    /transition: none;\n {2}animation: none;/u,
  );

  // Reduced motion takes the travel and the crossfade away entirely, and
  // leaves the feedback that is left at 80ms of opacity and colour.
  const quiet = css.slice(css.indexOf("@keyframes agent-panel-out"));
  assert.match(
    quiet,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.agent-panel-view\.agent-view-swapping \{\n {4}animation: none;/u,
  );
  assert.match(quiet, /transition-duration: 0\.08s;/u);
  assert.match(
    quiet,
    /transition-property: opacity, background-color, border-color, color;/u,
  );
});
