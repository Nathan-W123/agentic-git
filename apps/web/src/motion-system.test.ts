import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The rules the conversation's movement is held to.
 *
 * The dashboard ships as plain ES modules and one stylesheet with no bundler,
 * and the test run has no browser, so this is pinned the way the rest of the
 * browser surface is pinned: by asserting the shape of the source. What is
 * being protected here is not a set of numbers — it is the four decisions
 * that keep the screen calm, each of which was arrived at by undoing its
 * opposite:
 *
 *   one source for how long anything takes and what curve it takes it on;
 *   one animation per property, so nothing is moved by two things at once;
 *   one continuous signal per running task, so parallel work stays readable;
 *   nothing historical, waiting or finished moves at all.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

/** The declared value of one custom property in the stylesheet's root block. */
function token(css: string, name: string): string | undefined {
  return new RegExp(`\\n {2}${name}: ([^;]+);`, "u").exec(css)?.[1];
}

test("there is one set of durations and one curve", async () => {
  const css = await publicFile("styles.css");
  assert.equal(token(css, "--ease-motion"), "cubic-bezier(0.32, 0.72, 0, 1)");
  assert.equal(token(css, "--motion-press"), "0.09s");
  assert.equal(token(css, "--motion-pop"), "0.14s");
  assert.equal(token(css, "--motion-content"), "0.22s");
  assert.equal(token(css, "--motion-panel"), "0.26s");
  assert.equal(token(css, "--motion-panel-out"), "0.19s");
  assert.equal(token(css, "--motion-emphasis"), "0.3s");
  assert.equal(token(css, "--motion-scrim"), "0.18s");

  // One curve, and it is the token. A second easing written out by hand is
  // how two surfaces that move together stop agreeing about what "settling"
  // feels like — and it is invisible in review, because each of them looks
  // reasonable on its own.
  assert.equal(
    (css.match(/cubic-bezier\(/gu) ?? []).length,
    1,
    "the only cubic-bezier in the stylesheet should be --ease-motion itself",
  );

  // `all` animates whatever a rule happens to set, including the properties
  // somebody adds to it next year.
  assert.doesNotMatch(css, /transition:\s*all/u);
});

test("nothing about a message is animated by two things at once", async () => {
  const css = await publicFile("styles.css");
  // The bar is the clearest case: a step forward animates its width, and the
  // rule underneath transitions the same width. Whichever won, the other was
  // still fighting it.
  const filling = /\n\.bar > i\.bar-progress-fill \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(filling, undefined, "a bar that moved should still say so");
  assert.match(filling ?? "", /animation: bar-progress-fill var\(--motion-emphasis\)/u);
  assert.match(filling ?? "", /transition: none;/u);
  assert.doesNotMatch(
    filling ?? "",
    /thread-activity-sweep/u,
    "the step forward owns the bar while it is moving",
  );
});

test("a running task carries one signal, and a stopped one carries none", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The face fills and sweeps; the phrase beside it names the phase and holds
  // still. Before this, a single running thread offered a travelling mark, a
  // travelling phrase and — in the list — a breathing dot, all on one row and
  // none of them the same rhythm.
  const face = /\n\.agent-face-working > svg \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(face ?? "", /animation: agent-run-sweep 2\.4s ease-in-out infinite;/u);
  const activity =
    /\n\.cmsg-thread-link \.ctl-activity \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(activity, undefined, "a live thread should still say what it is doing");
  assert.doesNotMatch(activity ?? "", /animation/u);
  assert.doesNotMatch(activity ?? "", /background-clip/u);

  // Waiting is not working. A thread held for somebody's go-ahead is stopped,
  // and the difference between stopped and moving is the one thing the room
  // is being asked to show.
  const held = /\n\.cmsg-thread-link \.ctl-held \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(held, undefined, "a held thread should still be marked");
  assert.doesNotMatch(held ?? "", /animation/u);
  assert.match(held ?? "", /background: var\(--orange\);/u);

  // A finished thread in the list keeps its words and loses its motion.
  const listStart = chats.indexOf("function threadListPanel(repositoryId)");
  const list = chats.slice(
    listStart,
    chats.indexOf("\n/**\n * Your own agent", listStart),
  );
  assert.match(list, /finished\s*\? ""/u, "an ended thread shows no live state");
  assert.doesNotMatch(list, /text-sweep/u);

  // The agent profile is the one place the same running task is described
  // three times over — as a face, as a work zone and as a row in its own
  // history — so it is the easiest place to end up with three rhythms for
  // one thing. The face keeps the sweep. The work zone states the phase in a
  // reserved slot and holds still; its history rows never move at all.
  const work = /\n\.agent-spec \.aspec-work \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(work, undefined, "the profile should still say what is running");
  assert.doesNotMatch(work ?? "", /animation/u);
  const active =
    /\n\.agent-spec \.aspec-work\.is-active \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.notEqual(active, undefined, "running work should still be marked");
  assert.doesNotMatch(active ?? "", /animation/u);
  // Reserved, so the one thing that does change — the phase — changes without
  // moving the settings under it.
  assert.match(work ?? "", /min-height: 56px;/u);
  assert.match(active ?? "", /min-height: 72px;/u);
  // And it is the transcript's own slot, not a second phase mechanism.
  const spec = chats.slice(
    chats.indexOf("function agentCurrentWorkZone("),
    chats.indexOf("function agentRuntimeZone("),
  );
  assert.match(spec, /class="aspec-work-phase phase-slot"/u);
  assert.match(spec, /data-phase-slot="agent-profile:\$\{esc\(agent\.id\)\}"/u);

  // A history is a list of things that have already happened, and the rows
  // that have not are still queued or running somewhere else. None of them
  // move — least of all on a keystroke in the search box above them.
  const row = /\n\.agent-history-row \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(row ?? "", /animation: none;/u);
  const historyStart = chats.indexOf("function agentHistoryRow(");
  const history = chats.slice(
    historyStart,
    chats.indexOf("function agentHistory(agent, repositoryId)", historyStart),
  );
  // The face was a second sweep per running row, on top of the one the panel
  // header already carries for the same agent.
  assert.doesNotMatch(history, /statusAgentFace/u);
});

test("a phase changes in place, once, however many arrive at once", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // Both places a phase is shown are slots with a stable identity, so the
  // render loop can tell "the same task now says something else" from "a
  // different task".
  assert.match(chats, /data-phase-slot="thread-link:\$\{esc\(entry\.id\)\}"/u);
  assert.match(chats, /data-phase-slot="thread-item:\$\{esc\(entry\.id\)\}"/u);

  const start = app.indexOf("function playPhaseSlots(root)");
  assert.notEqual(start, -1, "the render loop should own phase changes");
  const body = app.slice(start, app.indexOf("\n}\n", start));
  // An unchanged phase — which is what a poll tick, a keystroke and every
  // other background render carries — plays nothing.
  assert.match(body, /if \(last\.text === text\) \{\n {6}continue;/u);
  // First sight of a slot is the row arriving, not a change.
  assert.match(body, /phaseSeen\.set\(key, \{ text, at: 0 \}\);/u);
  // Several within the window are one swap, ending on the latest. The text is
  // written by the render either way — nothing here delays live data.
  assert.match(body, /now - last\.at < PHASE_COALESCE_MS/u);
  assert.match(body, /if \(!quiet && !coalesce\)/u);
  assert.match(body, /animateOnce\(slot, "phase-changing", false\)/u);
  const window_ = /const PHASE_COALESCE_MS = (\d+);/u.exec(app)?.[1];
  assert.equal(Number(window_) >= 250 && Number(window_) <= 300, true);

  // A stable one-line slot: a phase appearing or going must not move the row
  // it is on, and the swap itself may not move it either.
  const slot = /\n\.phase-slot \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(slot ?? "", /min-height: 1\.3em;/u);
  const swap = /@keyframes phase-swap \{([\s\S]*?)\n\}\n/u.exec(css)?.[1];
  assert.match(swap ?? "", /transform: translateY\(3px\);/u);
  assert.match(
    /\n\.phase-changing \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? "",
    /animation: phase-swap var\(--motion-pop\)/u,
  );
});

test("the live line is seen going when the answer replaces it", async () => {
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");
  // Handled by the render loop rather than by CSS, like every other surface
  // whose comings and goings survive a document swap.
  assert.match(
    app,
    /selector: "#chan-messages > \.chan-typing",\n {4}parent: "#chan-messages",\n {4}enter: "typing-entering",\n {4}leave: "typing-leaving",/u,
  );
  const leaving = /\n\.chan-typing\.typing-leaving \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.match(leaving ?? "", /animation: typing-out var\(--motion-pop\)/u);
  // Out of flow for the whole of its exit: the transcript underneath it may
  // be pinned to its own bottom, and a row fading in the layout would take
  // the reader's position with it when it finally went.
  assert.match(leaving ?? "", /position: absolute;/u);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.chan-typing\.typing-leaving \{\n {4}display: none;/u,
  );
});

test("motion is never the only thing saying a task is running", async () => {
  const chats = await publicFile("screen-chats.js");
  // Every live marker that is drawn rather than written carries its own
  // words, so a reader with motion turned off, or a screen reader with no
  // motion at all, is told the same thing.
  assert.match(chats, /<span class="ti-live"><span class="sr-only">Working<\/span><\/span>/u);
  assert.match(chats, /<span class="sr-only">Working, \$\{progress\}% done<\/span>/u);
  assert.match(chats, /<span class="sr-only">Waiting for your go-ahead<\/span>/u);
  assert.match(chats, /aria-label="still working"/u);
});

test("a press is answered by the control, not by the surface under it", async () => {
  const css = await publicFile("styles.css");
  const press = /\n\.btn:active:not\(:disabled\),\n\.send-btn:active:not\(:disabled\) \{([\s\S]*?)\n\}/u.exec(
    css,
  )?.[1];
  assert.match(press ?? "", /transform: scale\(0\.985\);/u);
  // A row in the transcript, a channel in the list, a thread tab and the
  // composer are surfaces you press *through*: they answer with the colour
  // the touch tier already gives them, and none of them may shrink. One
  // press treatment, on the two controls that are standalone targets.
  assert.equal(
    (css.match(/transform: scale\(0\.985\)/gu) ?? []).length,
    1,
    "only standalone buttons give under a press",
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\n {2}\.btn:active:not\(:disabled\),\n {2}\.send-btn:active:not\(:disabled\) \{\n {4}transform: none;/u,
  );
});

test("one place decides whether this reader wants motion at all", async () => {
  const ui = await publicFile("ui.js");
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  assert.match(ui, /export function motionIsUnwanted\(\) \{/u);
  assert.match(ui, /"\(prefers-reduced-motion: reduce\)"/u);
  // The two files that ask are the two that own motion CSS cannot: the render
  // loop and the transcript's own scrolling.
  assert.match(app, /\n {2}motionIsUnwanted,\n/u, "app.js should import the test");
  assert.match(chats, /\n {2}motionIsUnwanted,\n/u, "screen-chats.js should import it");
  for (const source of [app, chats]) {
    assert.doesNotMatch(
      source,
      /function motionIsUnwanted\(\)/u,
      "no screen keeps its own copy of the reduced-motion test",
    );
  }
});

test("everything that runs while nothing has happened shares one clock", async () => {
  const css = await publicFile("styles.css");
  // Parallel work is meant to stay readable: several agents, several threads,
  // a room still loading. They may all be visible at once, so they may not
  // each move at a speed of their own — one rhythm reads as one screen
  // waiting, and five read as five things asking for attention.
  const cadence = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const body = new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\n\\}`, "u").exec(css)?.[1];
    return /animation: [a-z-]+ ([\d.]+s [a-z-]+) infinite;/u.exec(body ?? "")?.[1] ?? "";
  };
  for (const selector of [
    // A run, on the mark of the agent doing it.
    ".agent-face-working > svg",
    // A run, as a bar.
    ".bar > i",
    // A live thread in the list, where no agent is known.
    ".thread-item-active .ti-live",
    // A room that has not loaded yet.
    ".skeleton",
    // A preview still starting, in the workspace's own list of destinations.
    ".ch-preview-toggle.starting",
  ]) {
    assert.equal(cadence(selector), "2.4s ease-in-out", `${selector} keeps the clock`);
  }
  // The one exception, and it is a different statement: dots are somebody
  // about to speak, not a task grinding on, so they run at half the period
  // and stand in for the sweep rather than beside it.
  assert.equal(cadence(".typing-dots i"), "1.2s ease-in-out");
});

test("a live line that is put back for its exit is not announced twice", async () => {
  const app = await publicFile("app.js");
  // The transcript is a log that announces what is added to it, and the
  // outgoing row is added back to it for the length of its fade. It has
  // already been read out once; the second time would land over the answer
  // that replaced it.
  const place = /place: \(parent, closed\) => \{([\s\S]*?)\n {4}\},/u.exec(app)?.[1];
  assert.match(place ?? "", /closed\.removeAttribute\("aria-live"\);/u);
  assert.match(place ?? "", /closed\.setAttribute\("aria-hidden", "true"\);/u);
  // And only back into the room it came from: changing channels also ends a
  // typing line, and that one belongs to the conversation being left.
  assert.match(
    place ?? "",
    /parent\.dataset\.scrollKey !== `channel:\$\{closed\.dataset\.typingRoom\}`/u,
  );
});

/**
 * The render loop's two one-time effects, lifted out of `app.js` and run.
 *
 * Every other assertion in this file reads the source, which is the only way
 * to pin a stylesheet. These two are decisions rather than declarations —
 * "has this message been seen before", "did four phases arrive in one tick" —
 * and a regex over them proves the code was written, not that it answers
 * correctly. So they are executed against a stand-in document instead: enough
 * of `querySelectorAll`, `dataset`, `classList` and `style` for the functions
 * to run unchanged.
 */
interface FakeNode {
  dataset: Record<string, string>;
  textContent: string;
  classes: Set<string>;
  vars: Record<string, string>;
  classList: { add: (name: string) => void; remove: (name: string) => void };
  style: { setProperty: (name: string, value: string) => void };
  isConnected: boolean;
  offsetWidth: number;
}

function node(dataset: Record<string, string>, textContent = ""): FakeNode {
  const classes = new Set<string>();
  const vars: Record<string, string> = {};
  return {
    dataset,
    textContent,
    classes,
    vars,
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
    },
    style: { setProperty: (name: string, value: string) => void (vars[name] = value) },
    isConnected: true,
    offsetWidth: 1,
  };
}

function root(nodes: FakeNode[]): { querySelectorAll: (selector: string) => FakeNode[] } {
  return {
    querySelectorAll: (selector) =>
      nodes.filter((entry) =>
        selector === "[data-entrance]"
          ? entry.dataset.entrance !== undefined
          : entry.dataset.phaseSlot !== undefined,
      ),
  };
}

/** The render loop's arrival machinery, with the clock and the media query handed in. */
async function loadMotionLoop(quiet = false): Promise<{
  playMessageEntrance: (target: unknown) => void;
  playPhaseSlots: (target: unknown) => void;
  tick: (ms: number) => void;
}> {
  const app = await publicFile("app.js");
  const group = app.slice(
    app.indexOf("function revealGroupOf(key)"),
    app.indexOf("function playTextReveal(root)"),
  );
  const arrival = app.slice(
    app.indexOf("/* ---------------------------------------------------- message arrival ---- */"),
    app.indexOf("export function render()"),
  );
  let now = 1_000;
  const built = Function(
    "motionIsUnwanted",
    "animateOnce",
    "Date",
    `"use strict";\n${group}\n${arrival}\nreturn { playMessageEntrance, playPhaseSlots };`,
  )(
    () => quiet,
    (target: FakeNode, className: string) => target.classList.add(className),
    { now: () => now },
  ) as {
    playMessageEntrance: (target: unknown) => void;
    playPhaseSlots: (target: unknown) => void;
  };
  return { ...built, tick: (ms: number) => void (now += ms) };
}

test("a message arrives once, and a backlog does not arrive at all", async () => {
  const { playMessageEntrance, tick } = await loadMotionLoop();

  // First sight of a surface is a conversation being opened. Every message in
  // it is history the reader asked to see, so none of them moves.
  const first = node({ entrance: "chan:repo-1|msg-1" });
  const second = node({ entrance: "chan:repo-1|msg-2" });
  playMessageEntrance(root([first, second]));
  assert.equal(first.classes.has("msg-entering"), false);
  assert.equal(second.classes.has("msg-entering"), false);

  // The renders nobody asked for — a poll tick, a keystroke, a focus change —
  // carry the same messages and must be silent.
  tick(50);
  playMessageEntrance(root([first, second]));
  assert.equal(first.classes.has("msg-entering"), false);

  // A third message in a surface already on screen is a genuine arrival.
  const third = node({ entrance: "chan:repo-1|msg-3" });
  playMessageEntrance(root([first, second, third]));
  assert.equal(third.classes.has("msg-entering"), true);
  assert.equal(first.classes.has("msg-entering"), false);
  assert.equal(third.vars["--entrance-delay"], "0ms");

  // A redraw landing mid-arrival resumes it from where it was rather than
  // starting it again — which is what the negative delay is for.
  third.classList.remove("msg-entering");
  tick(120);
  playMessageEntrance(root([first, second, third]));
  assert.equal(third.classes.has("msg-entering"), true);
  assert.equal(third.vars["--entrance-delay"], "-120ms");

  // And once it is over it is over, however many renders follow.
  third.classList.remove("msg-entering");
  tick(500);
  playMessageEntrance(root([first, second, third]));
  assert.equal(third.classes.has("msg-entering"), false);
});

test("opening a thread does not throw every reply it holds up the screen", async () => {
  const { playMessageEntrance } = await loadMotionLoop();
  const channel = node({ entrance: "chan:repo-1|msg-1" });
  playMessageEntrance(root([channel]));

  // A different surface, seen for the first time: the replies are backlog
  // even though the channel beside them has been on screen all along.
  const replies = [
    node({ entrance: "thread:m1|msg-2" }),
    node({ entrance: "thread:m1|msg-3" }),
  ];
  playMessageEntrance(root([channel, ...replies]));
  for (const reply of replies) {
    assert.equal(reply.classes.has("msg-entering"), false);
  }

  // The next reply into that open thread is an arrival, as it should be.
  const answer = node({ entrance: "thread:m1|msg-4" });
  playMessageEntrance(root([channel, ...replies, answer]));
  assert.equal(answer.classes.has("msg-entering"), true);
});

test("reduced motion resolves an arrival instead of playing it", async () => {
  const { playMessageEntrance } = await loadMotionLoop(true);
  const first = node({ entrance: "chan:repo-1|msg-1" });
  playMessageEntrance(root([first]));
  const arriving = node({ entrance: "chan:repo-1|msg-2" });
  playMessageEntrance(root([first, arriving]));
  // Not hidden and not held — simply where it belongs. The keyframes have no
  // fill mode, so a message that never animates is already in place.
  assert.equal(arriving.classes.has("msg-entering"), false);
  assert.equal(arriving.vars["--entrance-delay"], undefined);
});

test("four phases in one tick are one swap, ending on the latest", async () => {
  const { playPhaseSlots, tick } = await loadMotionLoop();
  const slot = node({ phaseSlot: "thread-link:m1" }, "Planning");

  // The row arriving is not a change.
  playPhaseSlots(root([slot]));
  assert.equal(slot.classes.has("phase-changing"), false);

  // The first real change plays.
  tick(1_000);
  slot.textContent = "Reading code";
  playPhaseSlots(root([slot]));
  assert.equal(slot.classes.has("phase-changing"), true);

  // The burst behind it does not: the newest text is on screen either way,
  // and the swap already playing is the one the reader is watching. Nothing
  // is queued and nothing is withheld.
  for (const [after, text] of [
    [40, "Editing app.js"],
    [90, "Editing styles.css"],
    [120, "Testing"],
  ] as Array<[number, string]>) {
    slot.classList.remove("phase-changing");
    tick(after);
    slot.textContent = text;
    playPhaseSlots(root([slot]));
    assert.equal(
      slot.classes.has("phase-changing"),
      false,
      `${text} arrived inside the window and should not flash`,
    );
  }

  // Past the window, the next real change is worth seeing again.
  slot.classList.remove("phase-changing");
  tick(400);
  slot.textContent = "Done";
  playPhaseSlots(root([slot]));
  assert.equal(slot.classes.has("phase-changing"), true);

  // And an unchanged phase — every background render — plays nothing.
  slot.classList.remove("phase-changing");
  tick(400);
  playPhaseSlots(root([slot]));
  assert.equal(slot.classes.has("phase-changing"), false);
});

test("parallel tasks keep their own phase, and neither replays the other's", async () => {
  const { playPhaseSlots, tick } = await loadMotionLoop();
  const one = node({ phaseSlot: "thread-link:m1" }, "Planning");
  const two = node({ phaseSlot: "thread-link:m2" }, "Planning");
  playPhaseSlots(root([one, two]));

  tick(1_000);
  one.textContent = "Testing";
  playPhaseSlots(root([one, two]));
  assert.equal(one.classes.has("phase-changing"), true);
  assert.equal(
    two.classes.has("phase-changing"),
    false,
    "one task moving on must not re-announce the task beside it",
  );
});
