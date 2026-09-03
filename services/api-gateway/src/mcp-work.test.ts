import assert from "node:assert/strict";
import test from "node:test";

import { McpArgumentError } from "./mcp.js";
import {
  createMcpWorkTools,
  editorBehind,
  splitUnifiedDiff,
  type McpWorkDeps,
} from "./mcp-work.js";

/**
 * Real `git diff --cached HEAD` output, produced by a repository with one
 * file added, one deleted, one edited and one renamed.
 *
 * Copied rather than described. Every field this parser reads is a detail of
 * what git actually prints, and a hand-written approximation would agree with
 * the parser and disagree with git.
 */
const GIT_DIFF = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..3e75765
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+new
diff --git a/drop.txt b/drop.txt
deleted file mode 100644
index 286c5f5..0000000
--- a/drop.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/keep.txt b/keep.txt
index 4cb29ea..ddc897f 100644
--- a/keep.txt
+++ b/keep.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
diff --git a/src/a b.ts b/src/renamed.ts
similarity index 100%
rename from src/a b.ts
rename to src/renamed.ts
`;

test("a real git diff splits into one patch per file, with the right status", () => {
  const patches = splitUnifiedDiff(GIT_DIFF);
  assert.deepEqual(
    patches.map((patch) => [patch.path, patch.status]),
    [
      ["added.txt", "added"],
      ["drop.txt", "deleted"],
      ["keep.txt", "modified"],
      // The `b/` side. A rename lands under its new name, and the old one is
      // claimed separately so a rename cannot slip past arbitration.
      ["src/renamed.ts", "modified"],
    ],
  );
  // Each patch is the whole of its own section and none of the next one.
  assert.match(patches[0]?.patch ?? "", /^diff --git a\/added\.txt/u);
  assert.doesNotMatch(patches[0]?.patch ?? "", /drop\.txt/u);
  // Ends on a newline, which is what `git apply` requires.
  assert.ok(patches[2]?.patch.endsWith("\n"));
  assert.match(patches[2]?.patch ?? "", /\n\+TWO\n/u);
});

test("a header nothing can parse is not what the path is read from", () => {
  // Real output, from a repository holding `src/a b/c.ts`. The header reads
  // `a/src/a b/c.ts b/src/new.ts`, which can be split at either ` b/` with
  // equal justification: git does not quote spaces, so no regex can tell
  // these apart. The lines below it each carry one path and are not
  // ambiguous, which is why they are what gets read.
  const patches = splitUnifiedDiff(`diff --git a/mode.sh b/mode.sh
old mode 100644
new mode 100755
diff --git a/src/a b/c.ts b/src/new.ts
similarity index 100%
rename from src/a b/c.ts
rename to src/new.ts
`);
  assert.deepEqual(
    patches.map((patch) => patch.path),
    // A mode change carries no `+++` and no rename, so its path does come off
    // the header. That header has one `b/` in it and is unambiguous.
    ["mode.sh", "src/new.ts"],
  );
  assert.match(patches[1]?.patch ?? "", /rename from src\/a b\/c\.ts/u);

  // The case the header cannot survive at all: a rename whose *new* name has
  // a ` b/` in it. Split the header at the last one and the file is called
  // `m.ts`; at the first and it is `src/n b/m.ts b/m.ts`. `rename to` says.
  const [moved] = splitUnifiedDiff(`diff --git a/old.ts b/src/n b/m.ts
similarity index 100%
rename from old.ts
rename to src/n b/m.ts
`);
  assert.equal(moved?.path, "src/n b/m.ts");
});

test("prose around a diff is stepped over rather than pasted into it", () => {
  // A model told to send `git diff` output will sometimes send the whole
  // terminal: a prompt line, the command it ran, then the diff. Anything
  // before the first header belongs to none of the patches.
  const patches = splitUnifiedDiff(`$ git diff HEAD
Here is what I changed:

diff --git a/one.ts b/one.ts
index 111..222 100644
--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-a
+b
`);
  assert.equal(patches.length, 1);
  assert.match(patches[0]?.patch ?? "", /^diff --git/u);
});

test("text that is not a diff produces no patches at all", () => {
  // The tool depends on this to tell "nothing changed" from "the model sent
  // me its own summary instead of a diff", and refuses the second.
  assert.deepEqual(splitUnifiedDiff("I edited the login handler."), []);
  assert.deepEqual(splitUnifiedDiff(""), []);
});

/** A deps object whose calls are all recorded, with per-test overrides. */
function harness(overrides: Partial<McpWorkDeps> = {}): {
  deps: McpWorkDeps;
  reported: Array<Parameters<McpWorkDeps["report"]>[0]>;
  noted: string[];
  scopes: string[];
} {
  const reported: Array<Parameters<McpWorkDeps["report"]>[0]> = [];
  const noted: string[] = [];
  const scopes: string[] = [];
  const deps: McpWorkDeps = {
    assertScope: (permission) => {
      scopes.push(permission);
    },
    // What a connected editor answers. A test that wants the other case
    // overrides it, which is what the "cannot tell" test does.
    callerEditor: () => "claude",
    take: async () => undefined,
    report: async (input) => {
      reported.push(input);
      return { outcome: "accepted", note: "Landed." };
    },
    extend: async () => ({
      expiresAt: "2026-01-01T00:00:00.000Z",
      bundleUrl: "https://kumi.example/api/v1/mcp/bundle/ticket-2",
    }),
    note: async (input) => {
      noted.push(input.message);
      return "recorded";
    },
    ...overrides,
  };
  return { deps, reported, noted, scopes };
}

function toolNamed(deps: McpWorkDeps, name: string) {
  const found = createMcpWorkTools(deps).find((tool) => tool.name === name);
  assert.ok(found !== undefined, name);
  return found;
}

test("the work tools ask for submit_task, never run_task", async () => {
  const { deps, scopes } = harness();
  for (const [name, args] of [
    ["take_task", {}],
    ["report_task", { task_id: "t-1", diff: "", summary: "did it" }],
    ["extend_task", { task_id: "t-1" }],
    ["task_progress", { task_id: "t-1", message: "reading the router" }],
  ] as const) {
    await toolNamed(deps, name).run(args);
  }
  // `run_task` is the scope `POST /workers/leases` requires. A token that
  // carried it could register as a worker and lease other people's tasks,
  // which is the whole reason these ask for something narrower.
  assert.deepEqual(scopes, [
    "submit_task",
    "submit_task",
    "submit_task",
    "submit_task",
  ]);
});

test("a summary sent where a diff should be is refused, not filed as done", async () => {
  const { deps, reported } = harness();
  const answer = await toolNamed(deps, "report_task").run({
    task_id: "t-1",
    diff: "I changed the login handler to redirect to /home.",
    summary: "fixed the redirect",
  });
  assert.equal(answer.isError, true);
  assert.match(String(answer.content[0]?.text), /does not look like a diff/u);
  // The important half: nothing was filed. Accepting this would land an empty
  // changeset and tell the room the work was done.
  assert.deepEqual(reported, []);
});

test("an empty diff is a real answer, because some tasks change nothing", async () => {
  const { deps, reported } = harness();
  const answer = await toolNamed(deps, "report_task").run({
    task_id: "t-1",
    summary: "Already fixed on canonical; nothing to change.",
  });
  assert.equal(answer.isError, undefined);
  assert.equal(reported[0]?.patches.length, 0);
  assert.equal(reported[0]?.status, "completed");
});

test("reporting success without saying what happened is refused", async () => {
  const { deps } = harness();
  await assert.rejects(
    async () =>
      await toolNamed(deps, "report_task").run({
        task_id: "t-1",
        diff: GIT_DIFF,
      }),
    McpArgumentError,
  );
});

test("failing and giving back are different words to the control plane", async () => {
  const { deps, reported } = harness();
  await toolNamed(deps, "report_task").run({
    task_id: "t-1",
    status: "failed",
    detail: "The test suite does not build on this machine.",
  });
  await toolNamed(deps, "report_task").run({
    task_id: "t-1",
    status: "released",
  });
  assert.deepEqual(
    reported.map((entry) => entry.status),
    ["failed", "released"],
  );
  // Neither needs a summary: one has a reason and the other has nothing to
  // say, and demanding prose for a task somebody is handing straight back
  // would only teach a model to invent some.
});

test("take_task reads the editor off the connection, not off the model", async () => {
  const taken: string[] = [];
  const { deps } = harness({
    callerEditor: () => "codex",
    take: async (input) => {
      taken.push(input.vendor);
      return undefined;
    },
  });
  // No argument at all. The token this request arrived on already says which
  // editor it belongs to, and asking the model to repeat that was asking it
  // to report something it could get wrong.
  await toolNamed(deps, "take_task").run({});
  // And an explicit one still wins, for the connection Kumi cannot place.
  await toolNamed(deps, "take_task").run({ editor: "claude" });
  assert.deepEqual(taken, ["codex", "claude"]);

  // A value outside the list is a mistake worth naming rather than a silent
  // fall-back to whatever the connection said.
  await assert.rejects(
    async () => await toolNamed(deps, "take_task").run({ editor: "vim" }),
    McpArgumentError,
  );
});

test("a connection Kumi cannot place asks instead of picking an agent", async () => {
  const { deps } = harness({ callerEditor: () => undefined });
  const answer = await toolNamed(deps, "take_task").run({});
  assert.equal(answer.isError, true);
  // A hand-made token is the case: it names no editor, and guessing one would
  // hand somebody's work to an agent they never chose.
  assert.match(String(answer.content[0]?.text), /cannot tell which agent/u);
  assert.match(String(answer.content[0]?.text), /claude, codex/u);
});

test("an empty queue is an answer, not a refusal", async () => {
  const { deps } = harness();
  const answer = await toolNamed(deps, "take_task").run({ editor: "claude" });
  assert.equal(answer.isError, undefined);
  assert.match(String(answer.content[0]?.text), /Nothing is waiting/u);
});

test("a task that was taken comes back with the revision and how to reach it", async () => {
  const { deps } = harness({
    take: async () => ({
      taskId: "task-9",
      objective: "Fix the login redirect",
      repository: "payments",
      branch: "main",
      baseRevision: "a".repeat(40),
      expiresAt: "2026-01-01T00:30:00.000Z",
      bundleUrl: "https://kumi.example/api/v1/mcp/bundle/ticket-1",
      validationCommands: ["npm test"],
    }),
  });
  const answer = await toolNamed(deps, "take_task").run({ editor: "claude" });
  const text = String(answer.content[0]?.text);
  assert.match(text, /Fix the login redirect/u);
  assert.match(text, new RegExp(`${"a".repeat(40)}`, "u"));
  // The bundle URL is the only way to reach a canonical revision that has not
  // been pushed to anybody's remote, so it has to be in the answer rather
  // than mentioned in a doc somewhere.
  assert.match(text, /mcp\/bundle\/ticket-1/u);
  assert.match(text, /npm test/u);
  assert.match(text, /report_task/u);
});

test("extending a hold nobody holds says what to do about it", async () => {
  const { deps } = harness({ extend: async () => undefined });
  const answer = await toolNamed(deps, "extend_task").run({ task_id: "t-1" });
  assert.equal(answer.isError, true);
  assert.match(String(answer.content[0]?.text), /take_task/u);
});

test("minutes has to be a number of them", async () => {
  const { deps } = harness();
  for (const minutes of [0, -5, "thirty"]) {
    await assert.rejects(
      async () =>
        await toolNamed(deps, "extend_task").run({ task_id: "t-1", minutes }),
      McpArgumentError,
      String(minutes),
    );
  }
});

test("the editor behind a request is read from the token, name as fallback", () => {
  // Recorded at mint: exact, and what every connection made from now on has.
  assert.equal(editorBehind({ editorVendor: "codex", name: "anything" }), "codex");
  // The fallback, for editors connected before that column existed. The app
  // mints "Claude Code on <device>", so the label is there to be read.
  assert.equal(editorBehind({ name: "Claude Code on Nathan's MacBook" }), "claude");
  assert.equal(editorBehind({ name: "Codex on desktop (read-only)" }), "codex");
  assert.equal(editorBehind({ name: "cursor on laptop" }), "cursor");

  // Anchored to the start, so a machine that happens to be called Claude is
  // not read as an editor.
  assert.equal(editorBehind({ name: "worker on Claude-the-laptop" }), undefined);
  // An ordinary token names no editor, and that is a real answer: the tools
  // ask who the work is for rather than picking somebody.
  assert.equal(editorBehind({ name: "CI deploy key" }), undefined);
  assert.equal(editorBehind({}), undefined);
  assert.equal(editorBehind(), undefined);
  // A stored value outside the list is not trusted into one.
  assert.equal(editorBehind({ editorVendor: "vim", name: "CI" }), undefined);
  // And a recorded vendor beats a name that disagrees, because the name is
  // editable and the record is not.
  assert.equal(
    editorBehind({ editorVendor: "codex", name: "Claude Code on laptop" }),
    "codex",
  );
});

test("progress is one line, and only for a task you are holding", async () => {
  const { deps, noted } = harness();
  const said = await toolNamed(deps, "task_progress").run({
    task_id: "t-1",
    message: "reading the router before touching it",
  });
  assert.equal(said.isError, undefined);
  assert.deepEqual(noted, ["reading the router before touching it"]);
  // Terse on purpose: this is called repeatedly inside a turn, and an answer
  // worth reading would spend the model's attention on Kumi rather than the
  // work.
  assert.equal(said.content[0]?.text, "Posted.");

  // Empty is not a line. A blank reply in a thread reads as the agent having
  // said something and it having been lost.
  await assert.rejects(
    async () =>
      await toolNamed(deps, "task_progress").run({ task_id: "t-1", message: "  " }),
    McpArgumentError,
  );

  const { deps: stranger } = harness({ note: async () => "not_held" });
  const refused = await toolNamed(stranger, "task_progress").run({
    task_id: "t-1",
    message: "still going",
  });
  assert.equal(refused.isError, true);
  assert.match(String(refused.content[0]?.text), /not holding/u);
});

test("take_task tells the agent the thread is empty unless it speaks", async () => {
  const { deps } = harness({
    take: async () => ({
      taskId: "task-9",
      objective: "Fix the login redirect",
      repository: "payments",
      branch: "main",
      baseRevision: "a".repeat(40),
      expiresAt: "2026-01-01T00:30:00.000Z",
      bundleUrl: "https://kumi.example/api/v1/mcp/bundle/ticket-1",
      validationCommands: [],
    }),
  });
  const answer = await toolNamed(deps, "take_task").run({});
  // The instruction has to be in the brief, not only in the tool's own
  // description: a model reads the tool it just called, and nothing else
  // will prompt it to narrate work nobody has asked it about.
  assert.match(String(answer.content[0]?.text), /task_progress/u);
});
