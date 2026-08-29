/**
 * The thread's transport control, read out of the shipped browser sources.
 *
 * Source text rather than a rendered DOM because that is how every other
 * assertion about this screen is made here: `screen-chats.js` is served to the
 * browser as it is written, and the thing worth protecting is a property of
 * what it renders — a pause, a play, one cross in the header, and the pair
 * sitting on the composer row beside the arrow rather than up in the chrome.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "..");

async function chatScreen(): Promise<string> {
  return await readFile(
    path.join(packageRoot, "public", "screen-chats.js"),
    "utf8",
  );
}

/** The `threadTaskControl` body, which is the whole of the control. */
function taskControl(source: string): string {
  const start = source.indexOf("function threadTaskControl(root)");
  assert.notEqual(start, -1, "the thread header should own a task control");
  const end = source.indexOf("\nfunction threadPanel(", start);
  assert.notEqual(end, -1, "the task control should have a boundary");
  return source.slice(start, end);
}

test("a working thread offers pause, and a paused one offers play", async () => {
  const control = taskControl(await chatScreen());

  assert.match(
    control,
    /iconButton\("pause",[\s\S]*?act: "thread-task-pause"/u,
    "a running task should be paused from its own thread header",
  );
  assert.match(
    control,
    /iconButton\("play",[\s\S]*?act: "thread-task-resume"/u,
    "a paused task should be resumed from the same place",
  );
  // The pair is what makes the control legible: whichever way round it is,
  // the reader is looking at a transport button and not at a way out.
  assert.doesNotMatch(
    control,
    /iconButton\("close"/u,
    "the run control must never be drawn as a cross",
  );
  assert.match(
    control,
    /threadIsPaused\(root\)/u,
    "which face it shows is decided by whether the task is paused",
  );
});

test("the thread header keeps exactly one cross, and it closes the panel", async () => {
  const source = await chatScreen();
  // Anchored on the panel rather than on the header markup: several screens
  // share the `thread-head` class, and this assertion is about one of them.
  const panelStart = source.indexOf(
    "function threadPanel(repositoryId, selectedMessageId)",
  );
  assert.notEqual(panelStart, -1, "the thread panel should still exist");
  const start = source.indexOf('<header class="thread-head">', panelStart);
  assert.notEqual(start, -1, "the thread panel should still have a header");
  const end = source.indexOf("</header>", start);
  assert.notEqual(end, -1, "the thread header should have a boundary");
  const header = source.slice(start, end);

  const crosses = header.match(/iconButton\("close"/gu) ?? [];
  assert.equal(
    crosses.length,
    1,
    "two crosses in one header is the confusion this control was changed to end",
  );
  assert.match(
    header,
    /act: "channel-thread-close"[\s\S]*?cls: "panel-close"/u,
    "the one cross left is the panel's own close",
  );
  // And the run control is no longer up here at all — it went down to the
  // box, where the next thing to say is already being typed.
  assert.doesNotMatch(
    header,
    /threadTaskControl\(root\)/u,
    "the transport control belongs on the composer row, not in the chrome",
  );
});

test("the pause and play control sits in the thread composer beside send", async () => {
  const source = await chatScreen();
  const panelStart = source.indexOf(
    "function threadPanel(repositoryId, selectedMessageId)",
  );
  assert.notEqual(panelStart, -1, "the thread panel should still exist");
  const panel = source.slice(panelStart);

  // Stopping the run and saying the next thing are one decision taken in one
  // second, so the button for the first is under the hand that is already on
  // the second. Immediately before the arrow, which is where a reader looks
  // for the controls that act on this thread.
  assert.match(
    panel,
    /\$\{threadTaskControl\(root\)\}\s*\n\s*<button class="send-btn" type="submit"/u,
    "the run control should sit on the composer bar, just before send",
  );

  const control = taskControl(source);
  // Sized and classed for that row: a bare glyph beside the plus and the
  // arrow rather than the panel-header button it used to be.
  assert.equal(
    (control.match(/cls: "composer-run-btn"/gu) ?? []).length,
    2,
    "both faces of the control belong to the composer row",
  );
  assert.equal((control.match(/small: true/gu) ?? []).length, 2);

  const css = await readFile(
    path.join(packageRoot, "public", "styles.css"),
    "utf8",
  );
  // The rest of the row waits for the box to be entered. This one cannot: a
  // thread somebody parked has to offer its play to a reader with no
  // intention of typing, so it is drawn while the row around it is not.
  assert.match(
    css,
    /\.composer-run-btn \{[\s\S]{0,80}visibility: visible;/u,
    "the run control must survive the resting composer bar",
  );
  // Ordered rather than placed, like everything else on this row.
  assert.match(css, /\.composer-run-btn \{[\s\S]{0,80}order: 2;/u);
  // And with a glyph standing there, the placeholder stops before it.
  assert.match(
    css,
    /:has\(textarea:placeholder-shown\):has\(\.composer-run-btn\) \{\s*--composer-side-reserve: 41px;/u,
    "the resting box must reserve room for the control it is showing",
  );
});

test("pausing and resuming are not put behind a confirm", async () => {
  const app = await readFile(
    path.join(packageRoot, "public", "app.js"),
    "utf8",
  );
  const start = app.indexOf('case "thread-task-pause": {');
  assert.notEqual(start, -1, "pausing should be dispatchable");
  const end = app.indexOf('case "task-retry"', start);
  assert.notEqual(end, -1, "the pause and resume arms should have a boundary");
  const arms = app.slice(start, end);

  assert.match(arms, /pauseTask\(value, render\)/u);
  assert.match(arms, /resumeTask\(value, render\)/u);
  // A question in front of a reversible act only teaches people to click
  // through questions; the cancel above it keeps its confirm for the same
  // reason, because that one really does throw the work away.
  assert.doesNotMatch(
    arms,
    /confirmTaskCancel/u,
    "a reversible pause must not ask the destructive question",
  );
  assert.match(
    app,
    /case "task-cancel": \{[\s\S]{0,400}?confirmTaskCancel\(value\)/u,
    "cancelling still asks first",
  );
});

test("the browser asks the server to pause and resume the task it named", async () => {
  const agents = await readFile(
    path.join(packageRoot, "public", "screen-agents.js"),
    "utf8",
  );
  assert.match(
    agents,
    /export async function pauseTask[\s\S]*?\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/pause/u,
  );
  assert.match(
    agents,
    /export async function resumeTask[\s\S]*?\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/resume/u,
  );
});

test("a paused thread stays in the live half of the thread list", async () => {
  const source = await chatScreen();
  const start = source.indexOf("function threadListPanel(repositoryId)");
  assert.notEqual(start, -1, "the thread list should still exist");
  const panel = source.slice(start, start + 8000);

  // Paused work that fell into "Completed" is paused work nobody finds again.
  assert.match(panel, /!working &&\s*!waiting &&\s*!paused &&/u);
  assert.match(panel, /class="ti-paused"/u);
  assert.match(panel, /thread-item-paused/u);
});
