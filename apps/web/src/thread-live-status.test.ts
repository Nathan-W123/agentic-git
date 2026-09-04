import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "..");

/**
 * The dashboard shell, which is three files.
 *
 * `app.js` used to hold the router, the motion system and the accent colour
 * arithmetic together. Motion moved to `motion.js` and the colour maths to
 * `colour.js`; what these tests pin - that the behaviour is there and has
 * the shape it is meant to have - never cared which of the three a line sat
 * in, so asking for "app.js" here still means the whole shell.
 */
const SHELL_MODULES = ["app.js", "motion.js", "colour.js"];

async function publicFile(name: string): Promise<string> {
  const wanted = name === "app.js" ? SHELL_MODULES : [name];
  const parts = await Promise.all(
    wanted.map(async (file) =>
      readFile(path.join(packageRoot, "public", file), "utf8"),
    ),
  );
  if (name !== "app.js") {
    return parts.join("\n");
  }
  // Only the shell, and only because several tests below slice a function out
  // of it and run it: `export` is a syntax error outside a module, and the
  // shell's own functions carry it now that two of its three files are
  // imported rather than inlined.
  return parts.join("\n").replaceAll(/^export /gmu, "");
}

type Reply = { kind: string; content: string };
type Root = { id: string; replies: Reply[] };
type LiveStatus = { reply: Reply; html: string } | undefined;

/**
 * The live line, lifted out of the browser bundle with its real neighbours.
 *
 * The dashboard ships as plain ES modules with no bundler and the test run has
 * no browser, so the surrounding predicates are sliced from the source rather
 * than stubbed: what is being checked is that these particular functions agree
 * with each other about what a running thread is saying, and a stub of
 * `threadActivityLabel` would only prove that the stub was called.
 *
 * Liveness is the one thing injected. It is answered from the task list, which
 * lives in another module and has its own tests.
 */
async function liveStatus(
  working: boolean,
  esc: (value: string) => string = String,
): Promise<(root: Root) => LiveStatus> {
  const source = await publicFile("screen-chats.js");
  const slice = (from: string, to: string): string => {
    const start = source.indexOf(from);
    assert.notEqual(start, -1, `${from} should still exist`);
    const end = source.indexOf(to, start + from.length);
    assert.notEqual(end, -1, `${from} should have a boundary`);
    return source.slice(start, end);
  };
  return Function(
    "threadIsWorking",
    "planTranscriptReplies",
    "esc",
    `"use strict";
${slice("const THREAD_FINISHED_RE", "\n/**")}
${slice("function isThreadEnding(reply)", "\n/**")}
${slice("function isThreadThinking(reply)", "\n/**")}
${slice("const THREAD_ACKNOWLEDGEMENT_RE", "\n/**")}
${slice("function isThreadAcknowledgement(reply)", "\n/**")}
${slice("function threadReplyTurns(replies)", "\n/**")}
${slice("function threadActivityLabel(entry)", "\n/**")}
${slice("function threadLiveStatus(root)", "\n/**")}
return threadLiveStatus;`,
  )(
    () => working,
    (root: Root) => root.replies,
    esc,
  ) as (root: Root) => LiveStatus;
}

const ACKNOWLEDGEMENT: Reply = {
  kind: "agent",
  content: "I've taken this task and I'm working on it.",
};

function progress(content: string): Reply {
  return { kind: "progress", content };
}

test("a running thread says what it is doing in place of its handoff line", async () => {
  const live = await liveStatus(true);
  const status = live({
    id: "thread-1",
    replies: [
      ACKNOWLEDGEMENT,
      progress("Reading the repository and working out a plan…"),
      progress("Working on apps/web/public/styles.css…"),
    ],
  });

  assert.notEqual(status, undefined, "a live run should have a line");
  assert.equal(
    status?.reply,
    ACKNOWLEDGEMENT,
    "the line stands exactly where the acknowledgement stands",
  );
  // The phase vocabulary the room's row and the thinking fold already speak,
  // so no two surfaces can disagree about what is happening.
  assert.match(status?.html ?? "", />Editing styles\.css</u);
  // A slot the render loop can recognise between redraws — one legible swap
  // per real change rather than a line rewriting itself under the reader.
  assert.match(
    status?.html ?? "",
    /class="tls-phase phase-slot glimmer-text"/u,
  );
  assert.match(status?.html ?? "", /data-phase-slot="thread-live:thread-1"/u);
  // The glimmer is the visible half of "still running". A reader who cannot
  // see it is told the same thing, and told again when it changes.
  assert.match(status?.html ?? "", /role="status"/u);
  assert.match(status?.html ?? "", /<span class="sr-only">Working: <\/span>/u);
});

test("the newest phase wins, including one the run has moved on from", async () => {
  const live = await liveStatus(true);
  const later = live({
    id: "thread-1",
    replies: [
      ACKNOWLEDGEMENT,
      progress("Working on apps/web/public/app.js…"),
      progress("Finished editing. Validating…"),
    ],
  });
  assert.match(later?.html ?? "", />Testing</u);
});

test("narration the protocol never named is shown as the agent wrote it", async () => {
  const live = await liveStatus(true);
  // The phase vocabulary is small and the run is not limited to it. A line
  // outside it is the agent saying something nothing anticipated, and it is
  // worth more than the phase it left unchanged.
  const status = live({
    id: "thread-1",
    replies: [
      ACKNOWLEDGEMENT,
      progress("Working on apps/web/public/app.js…"),
      progress("Waiting for the sandbox to come back"),
    ],
  });
  assert.match(status?.html ?? "", />Waiting for the sandbox to come back</u);

  // Whitespace is normalised so a multi-line update cannot put a paragraph on
  // a one-line status; the clipping itself belongs to the stylesheet, so the
  // words that fit are the agent's own.
  const wrapped = live({
    id: "thread-1",
    replies: [
      ACKNOWLEDGEMENT,
      progress("Retrying the failed check\n\n   against the rebuilt image"),
    ],
  });
  assert.match(wrapped?.html ?? "", />against the rebuilt image</u);
});

test("narration reaches the document as text, never as markup", async () => {
  // The verbatim branch above puts a line an agent wrote straight into the
  // page. It is the only place in this line that is not one of six fixed
  // phase words, so it is the only place that has to be escaped — and the
  // marker proves it goes through the escaper rather than merely looking
  // harmless in the case somebody happened to test with.
  const live = await liveStatus(true, (value) => `«${value}»`);
  const status = live({
    id: "thread-1",
    replies: [
      ACKNOWLEDGEMENT,
      progress("Retrying <img src=x onerror=alert(1)> once more"),
    ],
  });
  assert.match(
    status?.html ?? "",
    />«Retrying <img src=x onerror=alert\(1\)> once more»</u,
  );
  assert.match(status?.html ?? "", /data-phase-slot="thread-live:«thread-1»"/u);
});

test("a run with nothing narrated yet still says it has started", async () => {
  const live = await liveStatus(true);
  const status = live({ id: "thread-1", replies: [ACKNOWLEDGEMENT] });
  assert.match(status?.html ?? "", />Starting</u);
});

test("the words come back the moment the run is not running", async () => {
  const stopped = await liveStatus(false);
  assert.equal(
    stopped({
      id: "thread-1",
      replies: [ACKNOWLEDGEMENT, progress("Validating…")],
    }),
    undefined,
    "a thread nobody is working on shows the sentence it was given",
  );

  // An ending is the case a stale busy frame can still get wrong: the turn has
  // its outcome to show and nothing left to narrate.
  const live = await liveStatus(true);
  assert.equal(
    live({
      id: "thread-1",
      replies: [
        ACKNOWLEDGEMENT,
        progress("Validating…"),
        { kind: "outcome", content: "Done — the settings modal opens." },
      ],
    }),
    undefined,
  );

  // A turn with no handoff line has nothing to stand in for. Nothing is
  // invented for it.
  assert.equal(
    live({
      id: "thread-1",
      replies: [{ kind: "agent", content: "Which branch should I use?" }],
    }),
    undefined,
  );
});

test("only the handoff announcement is recognised as one", async () => {
  const source = await publicFile("screen-chats.js");
  const start = source.indexOf("const THREAD_ACKNOWLEDGEMENT_RE");
  const isAcknowledgement = Function(
    `"use strict";\n${source.slice(
      start,
      source.indexOf("\n/**", source.indexOf("function isThreadAcknowledgement", start)),
    )}\nreturn isThreadAcknowledgement;`,
  )() as (reply: Reply) => boolean;

  // Every fixed sentence the gateway writes when a task is taken.
  for (const content of [
    "I've taken this task and I'm working on it.",
    "I've taken this task and I'm working on the plan.",
    "I've taken this task and queued it behind my current work.",
    "I've taken this task and queued it behind the push waiting on this channel.",
  ]) {
    assert.equal(isAcknowledgement({ kind: "agent", content }), true, content);
  }

  // Anything an agent addressed to a person stays exactly as it was written.
  assert.equal(
    isAcknowledgement({
      kind: "agent",
      content: "I've filed this, but nothing is running it yet — my agents run on my own machine and it isn't online.",
    }),
    false,
  );
  assert.equal(
    isAcknowledgement({
      kind: "agent",
      content: "Done — I've taken this task off the queue.",
    }),
    false,
  );
  // The run's own narration is folded away by `isThreadThinking`, and a
  // progress line that happened to quote the sentence is not the announcement.
  assert.equal(
    isAcknowledgement({ kind: "progress", content: ACKNOWLEDGEMENT.content }),
    false,
  );
});

test("the live line replaces the row's words and nothing else about it", async () => {
  const chats = await publicFile("screen-chats.js");
  const flowStart = chats.indexOf("function threadReplies(root, repositoryId)");
  assert.notEqual(flowStart, -1, "the thread renderer should still exist");
  const flow = chats.slice(flowStart, chats.indexOf("\n/**", flowStart));
  // Same row, same author, same time — only the words are live.
  assert.match(flow, /reply === live\?\.reply/u);
  assert.match(flow, /messageRow\(reply, repositoryId, \{\s*isReply: true,\s*bodyHtml: live\.html,/u);

  // The override is a rendering decision and stops there. The stored content
  // is still what the row falls back to.
  const rowStart = chats.indexOf("function messageRow(");
  const row = chats.slice(rowStart, chats.indexOf("\n/**", rowStart));
  assert.match(row, /bodyHtml = undefined,/u);
  assert.match(row, /bodyHtml \?\?\n\s*messageFoldClip\(/u);

  // One running task, one continuous signal: the dots said only that something
  // was happening, and this says what.
  const typingStart = chats.indexOf("function threadTyping(root)");
  const typing = chats.slice(typingStart, chats.indexOf("\n/*", typingStart));
  assert.match(typing, /if \(threadLiveStatus\(root\) !== undefined\) \{\n {4}return "";/u);
});

test("live copy glimmers, and is not taken apart word by word", async () => {
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  // An arrival is a one-time event and this line is the opposite of one.
  // Wrapping its words would also cut the travelling band into one gradient
  // per word, because the highlight is painted across the whole line.
  assert.match(app, /const REVEAL_SKIPPED_CLASS = "glimmer-text";/u);
  const start = app.indexOf("function insideSkipped(node, root)");
  const skipped = app.slice(start, app.indexOf("\n}\n", start));
  assert.match(
    skipped,
    /parent\.classList\.contains\(REVEAL_SKIPPED_CLASS\)/u,
  );

  const glimmer = /\n\.glimmer-text \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(glimmer, undefined, "live copy should still glimmer");
  // The same travelling band, on the same clock, as the running bar and the
  // working agent's mark. A fourth rhythm for the same fact is how one piece
  // of work ends up looking like three.
  assert.match(
    glimmer ?? "",
    /animation: thread-activity-sweep 2\.4s ease-in-out infinite;/u,
  );
  assert.match(glimmer ?? "", /background-size: 250% 100%;/u);
  assert.match(glimmer ?? "", /-webkit-background-clip: text;/u);
  assert.match(glimmer ?? "", /background-clip: text;/u);

  // Resolved rather than turned off: a transparent fill over a gradient that
  // is no longer painted is how live copy becomes invisible.
  const still =
    /@media \(prefers-reduced-motion: reduce\) \{\n {2}\.glimmer-text \{([\s\S]*?)\n {2}\}/u
      .exec(css)?.[1];
  assert.notEqual(still, undefined, "a reader who asked not to be moved still reads it");
  assert.match(still ?? "", /animation: none;/u);
  assert.match(still ?? "", /background-image: none;/u);
  assert.match(still ?? "", /-webkit-text-fill-color: currentColor;/u);
  const forced =
    /@media \(forced-colors: active\) \{\n {2}\.glimmer-text \{([\s\S]*?)\n {2}\}/u
      .exec(css)?.[1];
  assert.match(forced ?? "", /color: CanvasText;/u);

  // One line, clipped, in a slot that reserves its own height — the line
  // appearing, changing or going must not move the transcript under it.
  const line = /\n\.thread-live-status \.tls-phase \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(line ?? "", /text-overflow: ellipsis;/u);
  assert.match(line ?? "", /white-space: nowrap;/u);
  assert.match(/\n\.phase-slot \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? "", /min-height: 1\.3em;/u);
});
