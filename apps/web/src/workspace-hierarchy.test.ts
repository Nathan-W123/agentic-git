import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/*
 * Who owns which part of the top of the chats screen.
 *
 * The bar across the top of the shell used to open with the channel's picture
 * and its name, and the sidebar directly underneath it opened with the same
 * picture and the same name again — one room, named twice, forty pixels
 * apart, and neither copy the obvious one to press. Beside them stood two
 * collapse controls drawn with the same glyph, one in the rail and one in the
 * sidebar's crown, and under those a column of channel marks in which every
 * repository beginning with the same letter drew the same square.
 *
 * What is pinned here is ownership rather than looks: the channel is named in
 * exactly one place, that place is cut to the width of the navigation it
 * belongs to, the rest of the bar is the conversation's, and each control
 * exists once. None of it asserts a colour or a glyph — the icon set and the
 * accent are free to change underneath it.
 */

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

/** One CSS rule's declarations, by its exact selector. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\n\\}`, "u").exec(css)?.[1] ?? "";
}

/** The body of one top-level function in a browser module. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is still a function in this module`);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

test("the channel is named once, by the crown, and the crown belongs to the navigation", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // One crown, and it is what carries the picture, the name and the way into
  // the channel's own details.
  const crown = fn(chats, "chanCrown");
  assert.match(crown, /class="chan-crown"/u);
  assert.match(crown, /class="chan-brand" data-act="channel-info"/u);
  assert.match(crown, /channelPictureMarkup\(activeRepositoryId \?\? "", 26\)/u);
  assert.match(crown, /const label = repositoryLabel\(activeRepositoryId \?\? ""\);/u);
  assert.match(crown, /<span class="brand-text" title="\$\{channel\}"><b>\$\{esc\(label\)\}<\/b>/u);

  // The conversation's header says what state the room is in — muted, its
  // preview, what is pinned, its actions — and no longer what it is called.
  // Nor how many are in it: those two figures are on the headings of the
  // lists that hold them, in the navigation this bar begins with.
  const header = chats.slice(
    chats.indexOf("function chanHeader("),
    chats.indexOf("function threadParticipants"),
  );
  assert.match(header, /\$\{chanCrown\(repositoryId\)\}/u);
  assert.doesNotMatch(
    header,
    /class="ch-name"/u,
    "the banner must not repeat the name the crown carries",
  );
  assert.match(header, /class="ch-desc"/u);
  assert.match(header, /act: "channel-menu"/u);

  // And the sidebar underneath it has no crown of its own any more.
  const sidebar = chats.slice(
    chats.indexOf("function chanSidebar"),
    chats.indexOf("/* ---------------------------------------------------------- chan main"),
  );
  assert.doesNotMatch(sidebar, /class="chan-brand"/u);
  assert.doesNotMatch(sidebar, /class="chan-sidebar-top"/u);
  assert.equal(
    chats.split('class="chan-brand"').length - 1,
    1,
    "one crown, in one place",
  );

  // The name is inside the button that opens the channel's details, so the
  // accessible name has to carry it too — a bare "Channel info" would leave a
  // screen reader with no way to hear which room this is.
  assert.match(crown, /aria-label="\$\{esc\(label\)\} — channel info"/u);

  // Cut to the navigation's own width, so the crown stands over the columns
  // it names and the conversation's header begins where they end. One number,
  // published on the shell, and narrowed in the two states where one of those
  // columns is away. It carries the shell's own outer inset and the two
  // column widths and nothing else — the eight pixels that used to sit
  // between the rail and the sidebar are not there to pay for any more, and
  // paying for them anyway would land the crown's edge a pixel past the
  // sidebar's.
  assert.match(
    rule(css, ".chats-shell"),
    /--nav-w: calc\(8px \+ var\(--rail-w\) \+ var\(--chan-sidebar-w\)\);/u,
  );
  assert.match(
    rule(css, ".chats-shell.no-rail"),
    /--nav-w: calc\(8px \+ var\(--chan-sidebar-w\)\);/u,
  );
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed,\s*\.chats-shell\.no-rail\.chan-collapsed \{\s*--nav-w: calc\(8px \+ var\(--rail-w\)\);/u,
  );
  const crownRule = rule(css, ".chan-crown");
  assert.match(crownRule, /width: calc\(var\(--nav-w\) - 18px\);/u);
  // And it folds on the sidebar's own duration and curve, so the pair reads
  // as one column changing width rather than two surfaces moving at once.
  assert.match(
    crownRule,
    /transition:\s*width var\(--motion-content\) var\(--ease-motion\)/u,
  );
  assert.match(
    rule(css, ".chan-sidebar"),
    /transition: width var\(--motion-content\) var\(--ease-motion\);/u,
  );

  // The bar itself is unchanged: it still spans the whole shell, so a thread
  // opening beside the conversation cannot move it.
  const banner = rule(css, ".chan-head");
  assert.match(banner, /position: absolute;/u);
  assert.match(banner, /left: 0;/u);
  assert.match(banner, /right: 0;/u);
});

test("one collapse control, in the crown, in both states", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // There were two, drawn with the same glyph and standing beside each other:
  // one at the head of the rail and one in the sidebar's crown. The rail's is
  // gone, and nothing in the stylesheet describes it any more.
  assert.equal(
    chats.split('data-act="chan-collapse-toggle"').length - 1,
    1,
    "one control, not one per surface",
  );
  assert.match(fn(chats, "chanCrown"), /class="icon-btn desk-only chan-collapse-btn"/u);
  assert.doesNotMatch(chats, /channel-rail-toggle/u);
  assert.doesNotMatch(css, /channel-rail-toggle/u);

  // Collapsed, the crown is the rail's width and holds only that control, on
  // the rail's own centre line — no padding and no centring of its own,
  // because the banner's 18px already puts a 40px button there.
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed \.chan-crown \{\s*gap: 0;\s*\}/u,
  );
  assert.match(
    css,
    /\.chats-shell\.chan-collapsed \.chan-collapse-btn \{[\s\S]{0,120}width: 40px;/u,
  );

  // The drawer keeps its own way out. It rides on the quick links now that
  // the row it used to sit in is gone, centred beside them rather than
  // stacked underneath as a third row.
  const sidebar = chats.slice(
    chats.indexOf("function chanSidebar"),
    chats.indexOf("/* ---------------------------------------------------------- chan main"),
  );
  assert.match(sidebar, /cls: "drawer-close"/u);
  assert.ok(
    sidebar.indexOf('cls: "drawer-close"') < sidebar.indexOf("</nav>"),
    "the close control rides on the quick links",
  );
  assert.match(
    css,
    /\.chan-quick-links \.drawer-close \{\s*grid-column: 2;\s*grid-row: 1 \/ span 2;/u,
  );
});

test("two channels whose names start alike do not draw the same mark", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // A dot is a word boundary as much as a dash is — "KUMI" and "KUMI.WEBSITE"
  // both drew a lone "K" before this — and a name with no boundary in it
  // stands on two letters rather than one.
  const initials = fn(chats, "channelInitials");
  assert.match(initials, /split\(\/\[-_\\s\.\/\]\+\/u\)/u);
  assert.match(initials, /Array\.from\(parts\[0\]\)\.slice\(0, 2\)/u);
  assert.match(initials, /return "#";/u);

  // And a steady tint per channel, keyed to the id rather than the display
  // name: renaming a channel must not repaint the mark somebody has learned
  // to find. None of the tints is a colour that means a state elsewhere.
  const tones = chats.slice(
    chats.indexOf("const CHANNEL_TONES"),
    chats.indexOf("function channelPictureMarkup"),
  );
  assert.match(tones, /var\(--salmon\)/u);
  assert.match(tones, /var\(--lavender\)/u);
  assert.doesNotMatch(
    tones,
    /var\(--green\)|var\(--red\)|var\(--orange\)/u,
    "status colours are not identity",
  );
  assert.match(tones, /for \(const character of String\(repositoryId\)\)/u);
  assert.match(
    fn(chats, "channelPictureMarkup"),
    /--pic-tone:\$\{channelTone\(/u,
  );
  assert.match(
    rule(css, ".channel-picture-fallback"),
    /background: color-mix\(in srgb, var\(--pic-tone, var\(--muted\)\) 20%, var\(--surface-3\)\);/u,
  );

  // Where the reader is, said in more than one way and never by colour
  // alone: the mark is lit and ringed, the bar beside it is longer, and the
  // button still carries `aria-current`.
  assert.match(
    rule(css, ".channel-rail-entry.active .channel-rail-button"),
    /box-shadow: inset 0 0 0 1px color-mix\(/u,
  );
  assert.match(rule(css, ".channel-rail-entry.active::before"), /width: 3px;/u);
  assert.match(fn(chats, "channelRail"), /aria-current="page"/u);
});
