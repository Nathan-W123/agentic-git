/**
 * The thread header's transport control, read out of the shipped browser
 * sources.
 *
 * Source text rather than a rendered DOM because that is how every other
 * assertion about this screen is made here: `screen-chats.js` is served to the
 * browser as it is written, and the thing worth protecting is a property of
 * what it renders — a pause, a play, and exactly one cross in the header.
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
  assert.match(
    header,
    /\$\{threadTaskControl\(root\)\}/u,
    "the pause/play control belongs in the header beside it",
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
