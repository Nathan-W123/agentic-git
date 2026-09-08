/**
 * What a shell is told when it opens, and what a shell counts as to everybody
 * else.
 *
 * The terminal is the one door in this system with no lock on it. These tests
 * are about being honest about that in both directions: a person opening a
 * shell is told who is already here and that nothing will stop them, and a
 * person in a browser is told somebody is in a shell without that becoming a
 * lock over every file on the branch.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { holderBlocks, holdersOfFile } from "./editor-holds.js";
import type { FileHolder } from "./editor-holds.js";
import { terminalBanner } from "./terminal-banner.js";
import { TerminalSessions } from "./terminal-sessions.js";

function agentHolder(over: Partial<FileHolder> = {}): FileHolder {
  return {
    kind: "agent",
    principalId: "claude",
    taskId: "task_1",
    file: "services/billing/src/charge.ts",
    ranges: [{ file: "services/billing/src/charge.ts", start: 9, end: 21 }],
    since: "",
    ...over,
  };
}

const named = (holder: FileHolder): string =>
  holder.kind === "agent" ? "Claude" : "Nathan";

test("the banner names the branch, who is in it, and where they are", () => {
  const text = terminalBanner({
    branch: "feature/retry",
    repositoryName: "billing",
    holders: [agentHolder()],
    nameOf: named,
  });
  assert.match(text, /billing · feature\/retry/u);
  assert.match(text, /Claude holds services\/billing\/src\/charge\.ts 9-20/u);
  // Inclusive to a reader. The range is half-open on the wire and 9-21 in a
  // terminal would send somebody to a line the agent is not on.
  assert.doesNotMatch(text, /9-21/u);
  // CRLF, or the cursor stays where the last line left it and the shell's
  // first prompt lands in the middle of the warning.
  assert.match(text, /\r\n/u);
});

test("the banner always says the part that is always true", () => {
  // Every banner, including the one with nobody in it. A reader who takes the
  // list above as protection has been misled by the thing meant to help them.
  for (const holders of [[], [agentHolder()]]) {
    const text = terminalBanner({
      branch: "feature/retry",
      holders,
      nameOf: named,
    });
    assert.match(text, /Nothing you do in here is arbitrated/u);
    assert.match(text, /cannot see what a shell edits/u);
  }
  // And an empty branch says so rather than saying nothing, because silence
  // reads as "Kumi did not check".
  assert.match(
    terminalBanner({ branch: "feature/retry", holders: [], nameOf: named }),
    /Nobody else is holding anything/u,
  );
});

test("a shell with no branch and nobody in it gets no banner at all", () => {
  // Somebody opening a shell on their own machine, attached to nothing, is
  // not owed a paragraph before their prompt.
  assert.equal(terminalBanner({ holders: [], nameOf: named }), "");
});

test("a long list becomes a count rather than a screen", () => {
  const many = Array.from({ length: 9 }, (_, index) =>
    agentHolder({ principalId: `agent_${String(index)}`, file: `f${String(index)}.ts` }),
  );
  const text = terminalBanner({
    branch: "feature/retry",
    holders: many,
    nameOf: (holder) => holder.principalId,
  });
  assert.match(text, /and 3 others/u);
  assert.doesNotMatch(text, /agent_8/u);
});

test("a shell is a holder everywhere, and a lock nowhere", () => {
  const holders = holdersOfFile({
    humans: [],
    agents: [],
    shells: [
      { userId: "user_2", machine: "nathan-mbp", since: "2026-09-08T10:00:00Z" },
    ],
    path: "services/billing/src/charge.ts",
    exceptUser: "user_1",
  });
  // Named even though a path was asked about: a shell holds no file in
  // particular, which is exactly why it is worth mentioning on all of them.
  assert.equal(holders.length, 1);
  assert.equal(holders[0]?.kind, "shell");
  assert.equal(holders[0]?.file, "");
  assert.equal(holders[0]?.machine, "nathan-mbp");
  assert.equal(holders[0]?.advisory, true);

  // And it refuses nothing. It has no ranges, so the whole-file rule would
  // otherwise make one open terminal tab a lock on every file on the branch.
  assert.equal(
    holderBlocks(holders[0] as FileHolder, [
      { file: "services/billing/src/charge.ts", start: 1, end: 5 },
    ]),
    false,
  );
  assert.equal(holderBlocks(holders[0] as FileHolder, []), false);

  // A person's own shell is not contention with themselves.
  assert.deepEqual(
    holdersOfFile({
      humans: [],
      agents: [],
      shells: [
        { userId: "user_1", machine: "nathan-mbp", since: "2026-09-08T10:00:00Z" },
      ],
      exceptUser: "user_1",
    }),
    [],
  );
});

test("a hold that does refuse still refuses with a shell beside it", () => {
  // The advisory escape must be the shell's alone. A bug that let it leak on
  // to the others would turn the whole gate off and look like it was working.
  const holders = holdersOfFile({
    humans: [],
    agents: [{ principalId: "claude", taskId: "task_1", grants: [
      {
        leaseId: "lease_1",
        resourceType: "file",
        resourceId: "services/billing/src/charge.ts",
        principalId: "claude",
        taskId: "task_1",
        mode: "exclusive",
        baseVersion: 1,
        expiresAt: "2026-09-08T11:00:00Z",
        ranges: [{ startLine: 9, endLine: 20 }],
      },
    ] }],
    shells: [
      { userId: "user_2", machine: "nathan-mbp", since: "2026-09-08T10:00:00Z" },
    ],
    exceptUser: "user_1",
  });
  const agent = holders.find((holder) => holder.kind === "agent");
  assert.notEqual(agent, undefined);
  assert.equal(agent?.advisory, undefined);
  assert.equal(
    holderBlocks(agent as FileHolder, [
      { file: "services/billing/src/charge.ts", start: 12, end: 14 },
    ]),
    true,
  );
});

test("the banner is the session's first output, and a shell is visible to others", () => {
  const sessions = new TerminalSessions();
  sessions.describeWorker("worker_1", {
    backend: "python",
    shells: [{ id: "bash", label: "bash" }],
  });
  const opened = sessions.open({
    userId: "user_1",
    projectId: "proj_1",
    repositoryId: "repo_1",
    branch: "feature/retry",
    workerId: "worker_1",
    workerName: "nathan-mbp",
    shell: "bash",
    cols: 80,
    rows: 24,
    banner: "Kumi\r\n",
  });

  // Read from the beginning, which is what a browser attaching to a session
  // does. A banner appended after the shell had started would land in the
  // middle of somebody's output instead of before their first prompt.
  const session = sessions.own(opened.id, "user_1");
  assert.notEqual(session, undefined);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const first = sessions.read(session!, 0);
  assert.equal(first.data, "Kumi\r\n");
  // It occupies a sequence number like any other output. A banner outside the
  // count would be handed back a second time to a browser that reconnected,
  // which is how a reader ends up reading the warning twice and the shell's
  // first line never.
  assert.equal(first.seq, 1);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  assert.equal(sessions.read(session!, first.seq).data, "");

  // And the session is now something everybody else can see. This is the
  // only record a terminal leaves anywhere: no lease, no row, just a live
  // process somebody can be told about.
  assert.deepEqual(
    sessions.shellsOn("repo_1", "feature/retry").map((shell) => ({
      userId: shell.userId,
      machine: shell.workerName,
    })),
    [{ userId: "user_1", machine: "nathan-mbp" }],
  );
  // Scoped to the branch it was opened on. A shell on `main` is not a warning
  // about a feature branch, and saying it was would make every banner noise.
  assert.deepEqual(sessions.shellsOn("repo_1", "main"), []);
  assert.deepEqual(sessions.shellsOn("repo_2", "feature/retry"), []);

  // Closed, and gone from the list. A warning about a terminal somebody shut
  // an hour ago is worse than none: it teaches readers to ignore the line.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  sessions.close(session!);
  assert.deepEqual(sessions.shellsOn("repo_1", "feature/retry"), []);
});
