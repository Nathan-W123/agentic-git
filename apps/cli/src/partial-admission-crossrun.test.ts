import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";

import { repoAdd, runPendingTasks, taskSubmit } from "./commands.js";
import { CoordinatorProject } from "./project.js";

/**
 * Does partial admission survive the gap between two runs?
 *
 * Every partial-admission test in `services/coordinator` drives one
 * `Coordinator.run()` holding both tasks, so both share one in-memory
 * `OwnershipService` and arbitration never has to leave the process. That is
 * not the shape this deployment has. Two people prompting two agents produce
 * two separate `runPendingTasks` calls, each building its own coordinator, and
 * the only thing they share is the durable store — so cross-run arbitration
 * runs entirely through `LeasePlanAuthority` and the work-lease table.
 *
 * `lease-referee.test.ts` covers a *total* overlap, where sequencing is the
 * right answer and partial admission has nothing to offer; it accepts either
 * outcome for that reason. This covers the partial overlap, where the two
 * answers are not interchangeable: one file is contended and one is free, and
 * the whole promise of partial admission is that the free one is not held
 * hostage to the contended one.
 *
 * The load-bearing assertion is that the second agent reaches *execution*
 * while the first is still holding the shared file. Audit records are checked
 * afterwards to say which mechanism produced that, but a run that sequences
 * simply never reaches the signal.
 */

const SHARED_FILE = "shared.py";

/**
 * A scripted agent that plans the files named in its objective and writes only
 * the one it does not share.
 *
 * Writing only the private file keeps the test about admission. Both tasks
 * still *declare* the shared file, which is what makes them contend, but
 * neither depends on being granted it — so the run cannot fail for a scope
 * escape and confuse "was refused the file" with "was refused a turn".
 */
const AGENT = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  "",
  'const SIGNALS = process.env["LEASE_SIGNAL_DIR"];',
  "",
  "let started = null;",
  'let buffer = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  "  buffer += chunk;",
  '  let index = buffer.indexOf("\\n");',
  "  while (index !== -1) {",
  "    const line = buffer.slice(0, index).trim();",
  "    buffer = buffer.slice(index + 1);",
  "    if (line.length > 0) handle(JSON.parse(line));",
  '    index = buffer.indexOf("\\n");',
  "  }",
  "});",
  "",
  "function send(message) {",
  '  process.stdout.write(JSON.stringify(message) + "\\n");',
  "}",
  "",
  "function mark(name) {",
  '  fs.writeFileSync(path.join(SIGNALS, name), "1", "utf8");',
  "}",
  "",
  "function waitForSignal(name) {",
  "  const target = path.join(SIGNALS, name);",
  "  const deadline = Date.now() + 120000;",
  "  const idle = new Int32Array(new SharedArrayBuffer(4));",
  "  while (!fs.existsSync(target)) {",
  '    if (Date.now() > deadline) throw new Error("agent timed out: " + name);',
  "    Atomics.wait(idle, 0, 0, 25);",
  "  }",
  "}",
  "",
  "// FILES: what the plan declares. WRITE: the one file it actually edits.",
  "function field(name) {",
  '  const match = new RegExp(name + ":([^ ]+)").exec(started.objective);',
  '  return match === null ? [] : match[1].split(",");',
  "}",
  "",
  "function planFor() {",
  "  return {",
  "    taskId: started.taskId,",
  "    objective: started.objective,",
  "    expectedFiles: field(\"FILES\"),",
  "    expectedSymbols: [],",
  "    dependencies: [],",
  "    commands: [],",
  "    externalAccess: [],",
  '    riskLevel: "low",',
  "  };",
  "}",
  "",
  "function handle(message) {",
  '  if (message.type === "start") {',
  "    started = message;",
  "    return;",
  "  }",
  '  if (message.type === "plan_request" || message.type === "replan_request") {',
  '    send({ type: "plan", plan: planFor() });',
  '    mark("planned-" + started.taskId);',
  "    return;",
  "  }",
  '  if (message.type === "context") {',
  "    // Written before the block, not after. A repository-wide claim is",
  "    // narrowed to what its holder has actually touched, and a holder that",
  "    // has touched nothing is deliberately left whole — erasing the claim",
  "    // would admit the next arrival straight into the files it is about to",
  "    // write. So an agent that blocks before its first write pins the whole",
  "    // repository, and nothing can be partially admitted behind it. Writing",
  "    // first is what a real agent mid-edit looks like.",
  '    const blockFirst = started.objective.includes("BLOCKFIRST");',
  "    // DROP:<file> hands a file back partway through, which is what a real",
  "    // agent does when it finishes with one and knows somebody is waiting.",
  '    const drop = /DROP:([^ ]+)/.exec(started.objective);',
  "    function writeAll() {",
  '      for (const file of field("WRITE")) {',
  "        const target = path.join(message.workspacePath, file);",
  '        const previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";',
  '        fs.writeFileSync(target, previous + "# " + started.taskId + "\\n", "utf8");',
  "      }",
  "    }",
  "    if (!blockFirst) writeAll();",
  '    mark("executing-" + started.taskId);',
  "    if (drop !== null) {",
  '      waitForSignal("drop-" + started.taskId);',
  "      send({",
  '        type: "event",',
  '        event: "scope_release_requested",',
  "        releasedFiles: [drop[1]],",
  '        reason: "finished with it",',
  "        occurredAt: new Date().toISOString(),",
  "      });",
  '      mark("dropped-" + started.taskId);',
  "    }",
  '    waitForSignal("release-" + started.taskId);',
  "    if (blockFirst) writeAll();",
  "    send({",
  '      type: "done",',
  "      symbolsChanged: [],",
  '      explanation: "wrote its own file",',
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "cancel") process.exit(0);',
  "}",
  "",
].join("\n");

interface Harness {
  root: string;
  project: CoordinatorProject;
  sourcePath: string;
  signalsPath: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpart-"));
  const sourcePath = path.join(root, "src-repo");
  const signalsPath = path.join(root, "signals");
  await mkdir(signalsPath, { recursive: true });

  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({ name: "parted", private: true, type: "module" })}\n`,
    "utf8",
  );
  for (const name of [SHARED_FILE, "a.py", "b.py"]) {
    await writeFile(path.join(sourcePath, name), `# ${name}\n`, "utf8");
  }
  await repositories.commitAll(sourcePath, "seed");

  const projectRoot = path.join(root, "proj");
  await mkdir(projectRoot, { recursive: true });
  const agentPath = path.join(projectRoot, "agent.mjs");
  await writeFile(agentPath, AGENT, "utf8");

  const project = await CoordinatorProject.init(projectRoot);
  project.config.validationCommands = [];
  project.config.agents = {
    parted: {
      command: process.execPath,
      args: [agentPath],
      env: { LEASE_SIGNAL_DIR: signalsPath },
    },
  };
  project.config.defaultAgent = "parted";
  await project.save();

  return { root, project, sourcePath, signalsPath };
}

async function awaitSignal(
  signalsPath: string,
  name: string,
  timeoutMs: number,
  detail: string,
): Promise<void> {
  const target = path.join(signalsPath, name);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(target);
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for "${name}" after ${timeoutMs}ms. ${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function releaseSignal(signalsPath: string, name: string): Promise<void> {
  await writeFile(path.join(signalsPath, name), "1", "utf8");
}

test("a partially overlapping plan is admitted for its free files, across runs", async () => {
  const harness = await createHarness();
  const store = harness.project.openStore();
  // The local runner leases work under a user; without one it falls back to
  // running with no arbitration at all, which is not the case under test.
  await store.createUser({
    email: "partial@example.com",
    displayName: "Partial",
    passwordDigest: "digest",
  });
  let runOne: Promise<unknown> | undefined;
  let runTwo: Promise<unknown> | undefined;
  let first: { id: string } | undefined;
  let second: { id: string } | undefined;

  try {
    const repository = await repoAdd(harness.project, store, {
      sourcePath: harness.sourcePath,
      id: "parted",
    });

    // --- First dispatch: holds the shared file and blocks ---------------
    first = await taskSubmit(harness.project, store, {
      objective: `first FILES:${SHARED_FILE},a.py WRITE:${SHARED_FILE}`,
    });
    runOne = runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
    });
    await awaitSignal(
      harness.signalsPath,
      `executing-${first.id}`,
      120_000,
      "The first task never reached execution.",
    );

    // --- Second dispatch, overlapping on one file only ------------------
    second = await taskSubmit(harness.project, store, {
      objective: `second FILES:${SHARED_FILE},b.py WRITE:b.py`,
    });
    runTwo = runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
    });

    // The claim. `b.py` is contended with nobody, so partial admission should
    // hand it over immediately and let this agent work while the first still
    // holds `shared.py`. A run that only knows how to sequence never gets
    // here — it waits out the holder, and this is where that shows up.
    await awaitSignal(
      harness.signalsPath,
      `executing-${second.id}`,
      90_000,
      `The second task never started while the first held ${SHARED_FILE}. ` +
        "Its plan overlapped on that one file and was clear on b.py, so it " +
        "should have been admitted for b.py rather than sequenced behind " +
        "the whole of the first task.",
    );

    await releaseSignal(harness.signalsPath, `release-${first.id}`);
    await releaseSignal(harness.signalsPath, `release-${second.id}`);
    await Promise.all([runOne, runTwo]);

    // What the referee recorded, now that the behaviour is established.
    const events = await store.listAuditEvents();
    const secondId = second.id;
    const firstId = first.id;
    const decision = events.find(
      (entry) =>
        entry.event.type === "plan_admitted" &&
        entry.event.taskId === secondId &&
        entry.event.data["partial"] === true,
    );
    assert.ok(
      decision !== undefined,
      "The second task executed alongside the first but no partial admission " +
        "was recorded for it, so it was let through by something other than " +
        "the mechanism this test is about.",
    );
    assert.deepEqual(
      decision.event.data["grantedFiles"],
      ["b.py"],
      "Only the uncontended file should have been granted",
    );
    const deferred = (decision.event.data["deferredResources"] ??
      []) as Array<{ resourceId: string }>;
    assert.deepEqual(
      deferred.map((entry) => entry.resourceId),
      [SHARED_FILE],
      "The contended file should be the one held back",
    );

    // The other half of the same story, named rather than implied: nothing
    // could have been partially admitted here until the first task gave
    // something back. It arrived holding the whole repository, and what freed
    // `b.py` was its claim narrowing to the one file it had actually touched
    // — a release that happened in another run, mid-execution, and was picked
    // up without either task restarting.
    const frozen = events.find(
      (entry) =>
        entry.event.type === "blanket_claim_frozen" &&
        entry.event.taskId === firstId,
    );
    assert.ok(
      frozen !== undefined,
      "No blanket claim was frozen, so the second task was admitted into a " +
        "repository the first still claimed in full.",
    );
    assert.deepEqual(
      frozen.event.data["files"] ?? frozen.event.data["expectedFiles"],
      [SHARED_FILE],
      "The narrowed claim should keep exactly what the holder had written",
    );
  } finally {
    if (first !== undefined) {
      await releaseSignal(harness.signalsPath, `release-${first.id}`);
    }
    if (second !== undefined) {
      await releaseSignal(harness.signalsPath, `release-${second.id}`);
    }
    await Promise.allSettled([runOne, runTwo]);
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a holder still reading is narrowed by its objective, not by its writes", async () => {
  // The case the first draft of the test above timed out on, and the reason
  // partial admission so rarely got a chance: a repository-wide claim could
  // only be narrowed to files the holder had already written, so the whole
  // span between an agent starting and its first edit — however long it
  // spends reading — refused every arrival everything.
  //
  // The holder here never writes until released, which is what a real agent
  // reading its way into a problem looks like from the outside. Nothing it
  // has done can narrow its claim; only what it said it would do can.
  const harness = await createHarness();
  const store = harness.project.openStore();
  await store.createUser({
    email: "reading@example.com",
    displayName: "Reading",
    passwordDigest: "digest",
  });
  let runOne: Promise<unknown> | undefined;
  let runTwo: Promise<unknown> | undefined;
  let first: { id: string } | undefined;
  let second: { id: string } | undefined;

  try {
    const repository = await repoAdd(harness.project, store, {
      sourcePath: harness.sourcePath,
      id: "reading",
    });

    first = await taskSubmit(harness.project, store, {
      // Names real repository paths, which is what makes the estimate
      // anchored — an objective that named nothing real would be refused the
      // blanket claim outright and would plan instead, which is the other
      // half of the same rule.
      objective: `edit ${SHARED_FILE} and a.py BLOCKFIRST FILES:${SHARED_FILE},a.py WRITE:${SHARED_FILE}`,
    });
    runOne = runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
    });
    await awaitSignal(
      harness.signalsPath,
      `executing-${first.id}`,
      120_000,
      "The first task never reached execution.",
    );

    second = await taskSubmit(harness.project, store, {
      objective: `edit b.py FILES:b.py WRITE:b.py`,
    });
    runTwo = runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
    });

    await awaitSignal(
      harness.signalsPath,
      `executing-${second.id}`,
      90_000,
      "The second task never started. The first had written nothing, so its " +
        "claim could only have been narrowed by what its objective declared " +
        "— which is the whole point of estimating it.",
    );

    await releaseSignal(harness.signalsPath, `release-${first.id}`);
    await releaseSignal(harness.signalsPath, `release-${second.id}`);
    await Promise.all([runOne, runTwo]);

    const events = await store.listAuditEvents();
    const firstId = first.id;
    const frozen = events.find(
      (entry) =>
        entry.event.type === "blanket_claim_frozen" &&
        entry.event.taskId === firstId,
    );
    assert.ok(
      frozen !== undefined,
      "The claim was never narrowed, so the second task got in some other way.",
    );
    // Both files the objective named, and nothing the holder had touched —
    // because it had touched nothing.
    assert.deepEqual(frozen.event.data["files"], ["a.py", SHARED_FILE]);
  } finally {
    if (first !== undefined) {
      await releaseSignal(harness.signalsPath, `release-${first.id}`);
    }
    if (second !== undefined) {
      await releaseSignal(harness.signalsPath, `release-${second.id}`);
    }
    await Promise.allSettled([runOne, runTwo]);
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a file dropped mid-run is picked up by a task in another run", async () => {
  // The release path end to end, across the boundary that matters. Every
  // existing test of it drives one Coordinator.run() holding both tasks, so
  // the release never has to leave the process — but a release only helps if
  // the task waiting on the file is somebody else's dispatch, which means the
  // narrowed plan has to reach the durable lease before the waiter's next
  // admission reads it.
  //
  // The holder here declares two files and hands one back partway through,
  // while still working. Nothing about it settles; nothing restarts.
  const harness = await createHarness();
  const store = harness.project.openStore();
  await store.createUser({
    email: "drop@example.com",
    displayName: "Drop",
    passwordDigest: "digest",
  });
  let runOne: Promise<unknown> | undefined;
  let runTwo: Promise<unknown> | undefined;
  let first: { id: string } | undefined;
  let second: { id: string } | undefined;

  try {
    const repository = await repoAdd(harness.project, store, {
      sourcePath: harness.sourcePath,
      id: "dropped",
    });

    // Holds both files, writes only its own, and will give the shared one back.
    first = await taskSubmit(harness.project, store, {
      objective:
        // Deliberately vague: no real path, so the scope estimate stays
        // weak, no repository-wide claim is granted, and this task holds
        // exactly the two files it planned until it gives one back.
        "tidy up the two modules FILES:shared|py,a|py " +
        "WRITE:a|py DROP:shared|py",
    });
    runOne = runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
    });
    await awaitSignal(
      harness.signalsPath,
      `executing-${first.id}`,
      120_000,
      "The first task never reached execution.",
    );

    // The second wants the shared file and nothing else, so until the drop
    // lands there is nothing it can be given.
    second = await taskSubmit(harness.project, store, {
      objective:
        "adjust the shared module FILES:shared|py WRITE:shared|py",
    });
    runTwo = runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
    });

    // Let the holder hand it back, and confirm it did before expecting
    // anything of the waiter — otherwise a waiter that started for some other
    // reason would read as a successful pickup.
    await releaseSignal(harness.signalsPath, `drop-${first.id}`);
    await awaitSignal(
      harness.signalsPath,
      `dropped-${first.id}`,
      120_000,
      "The first task never released the shared file.",
    );

    await awaitSignal(
      harness.signalsPath,
      `executing-${second.id}`,
      120_000,
      `The second task never started after ${SHARED_FILE} was released. The ` +
        "holder is still running, so the only thing that could have let it " +
        "in is the release reaching the durable lease it arbitrates against.",
    );

    await releaseSignal(harness.signalsPath, `release-${first.id}`);
    await releaseSignal(harness.signalsPath, `release-${second.id}`);
    await Promise.all([runOne, runTwo]);

    const events = await store.listAuditEvents();
    const firstId = first.id;
    assert.ok(
      events.some(
        (entry) =>
          entry.event.type === "ownership_released" &&
          entry.event.taskId === firstId,
      ),
      "no ownership release was recorded, so the second task got in some " +
        "other way than the one under test",
    );
  } finally {
    for (const id of [first?.id, second?.id]) {
      if (id !== undefined) {
        await releaseSignal(harness.signalsPath, `drop-${id}`);
        await releaseSignal(harness.signalsPath, `release-${id}`);
      }
    }
    await Promise.allSettled([runOne, runTwo]);
    await rm(harness.root, { recursive: true, force: true });
  }
});
