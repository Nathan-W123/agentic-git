import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";
import type { SequencedAuditEvent } from "@coord/shared-types";

import { repoAdd, runPendingTasks, taskSubmit } from "./commands.js";
import { CoordinatorProject } from "./project.js";

/**
 * Does the plan-lease referee engage when two tasks want the same file?
 *
 * Production says no: three runs in one day put two overlapping agents into
 * concurrent execution, in both orders, and no `plan_admitted` narration ever
 * appeared. Correctness survived on the exact-base integration check — the
 * loser replanned on top of the winner — which costs a whole agent execution
 * per collision and leaves the coordinator looking asleep.
 *
 * The suspicion under test is about *wiring*, not about admission itself:
 * `services/coordinator/src/plan-admission.ts` and `saveWorkLeasePlan` are
 * covered elsewhere and pass. So this test deliberately drives the entry point
 * the deployment actually uses — `runPendingTasks`, which is what
 * `operations.runRepository` in `apps/web/src/index.ts` calls on every channel
 * dispatch — rather than `Coordinator.execute` or the `worker-operations`
 * helpers. Reaching admission through a helper the deployed path never calls
 * would prove nothing.
 *
 * The shape mirrors the production evidence: two separate dispatches, one task
 * each, the first demonstrably executing before the second plans.
 */

/**
 * The file both tasks declare. Nothing depends on it being Python; it only has
 * to be one file two plans both name, and one the repository's validation
 * command will not try to run.
 */
const OVERLAP_FILE = "same.py";

/**
 * A scripted agent that plans {@link OVERLAP_FILE} and then blocks.
 *
 * The block is the whole instrument. A real agent takes minutes between
 * planning and finishing, which is the window in which a second agent plans
 * and admission is supposed to arbitrate; a scripted agent that returns
 * immediately would close that window before the second task ever arrived and
 * would report a clean sequence for the wrong reason. So this one announces
 * that it has reached execution and waits for the test to release it, which
 * makes the overlap a fact of the run rather than a race the test hopes to
 * win.
 *
 * Written as joined lines rather than a template literal because the escape
 * sequences in the JSON framing have to survive being written to disk intact.
 */
const AGENT = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  "",
  'const SIGNALS = process.env["LEASE_SIGNAL_DIR"];',
  'const OVERLAP = process.env["LEASE_OVERLAP_FILE"];',
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
  "// Synchronous on purpose: this process has nothing else to do, and holding",
  "// the thread is what holds the coordination window open.",
  "function waitForSignal(name) {",
  "  const target = path.join(SIGNALS, name);",
  "  const deadline = Date.now() + 120000;",
  "  const idle = new Int32Array(new SharedArrayBuffer(4));",
  "  while (!fs.existsSync(target)) {",
  "    if (Date.now() > deadline) {",
  '      throw new Error("agent timed out waiting for " + name);',
  "    }",
  "    Atomics.wait(idle, 0, 0, 25);",
  "  }",
  "}",
  "",
  "function planFor() {",
  "  return {",
  "    taskId: started.taskId,",
  "    objective: started.objective,",
  "    expectedFiles: [OVERLAP],",
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
  '  if (message.type === "plan_request") {',
  '    send({ type: "plan", plan: planFor() });',
  '    mark("planned-" + started.taskId);',
  "    return;",
  "  }",
  "  // Replanning happens to whichever task loses the exact-base check at",
  "  // landing time. It re-declares the same file: the objective has not",
  "  // changed, only the base it will be applied to.",
  '  if (message.type === "replan_request") {',
  '    send({ type: "plan", plan: planFor() });',
  "    return;",
  "  }",
  '  if (message.type === "context") {',
  '    mark("executing-" + started.taskId);',
  '    waitForSignal("release-" + started.taskId);',
  "    const target = path.join(message.workspacePath, OVERLAP);",
  '    const previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";',
  '    fs.writeFileSync(target, previous + "# touched by " + started.taskId + "\\n", "utf8");',
  "    send({",
  '      type: "done",',
  "      symbolsChanged: [],",
  '      explanation: "appended a line to " + OVERLAP,',
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "cancel") process.exit(0);',
  "}",
  "",
].join("\n");

const GREET_SOURCE = [
  "export function greet(name) {",
  '  return "Hello, " + name;',
  "}",
  "",
].join("\n");

const GREET_TEST = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { greet } from "../src/greet.js";',
  "",
  'test("greets", () => {',
  '  assert.equal(greet("world"), "Hello, world");',
  "});",
  "",
].join("\n");

const OVERLAP_SEED = ["# shared by both tasks", ""].join("\n");

interface Harness {
  root: string;
  project: CoordinatorProject;
  sourcePath: string;
  signalsPath: string;
}

async function createHarness(): Promise<Harness> {
  // Kept short: git stores worktree metadata under a directory of the same
  // name inside the canonical repository, so deep roots exhaust MAX_PATH.
  const root = await mkdtemp(path.join(os.tmpdir(), "clease-"));
  const sourcePath = path.join(root, "src-repo");
  const signalsPath = path.join(root, "signals");
  await mkdir(signalsPath, { recursive: true });

  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await mkdir(path.join(sourcePath, "test"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({ name: "greeter", private: true, type: "module" })}\n`,
    "utf8",
  );
  await writeFile(path.join(sourcePath, "src", "greet.js"), GREET_SOURCE, "utf8");
  await writeFile(
    path.join(sourcePath, "test", "greet.test.js"),
    GREET_TEST,
    "utf8",
  );
  // Seeded so both agents modify an existing file rather than each adding one,
  // which is the collision production actually saw.
  await writeFile(path.join(sourcePath, OVERLAP_FILE), OVERLAP_SEED, "utf8");
  await repositories.commitAll(sourcePath, "seed greeter");

  const projectRoot = path.join(root, "proj");
  await mkdir(projectRoot, { recursive: true });
  const agentPath = path.join(projectRoot, "agent.mjs");
  await writeFile(agentPath, AGENT, "utf8");

  const project = await CoordinatorProject.init(projectRoot);
  project.config.validationCommands = [
    { executable: process.execPath, args: ["--test"], label: "repository tests" },
  ];
  project.config.agents = {
    greeter: {
      command: process.execPath,
      args: [agentPath],
      env: {
        LEASE_SIGNAL_DIR: signalsPath,
        LEASE_OVERLAP_FILE: OVERLAP_FILE,
      },
    },
  };
  project.config.defaultAgent = "greeter";
  await project.save();

  return { root, project, sourcePath, signalsPath };
}

/** Blocks until the scripted agent drops `name`, or fails the test saying so. */
async function awaitSignal(
  signalsPath: string,
  name: string,
  timeoutMs = 120_000,
): Promise<void> {
  const target = path.join(signalsPath, name);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(target);
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for the agent signal "${name}". ` +
            "The run reached neither planning nor execution for that task.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function releaseSignal(signalsPath: string, name: string): Promise<void> {
  await writeFile(path.join(signalsPath, name), "1", "utf8");
}

/**
 * Renders the audit trail for a task, so a failure names what did happen.
 *
 * Failure and replan events carry their reason inline: the order of events is
 * what says whether admission ran, but when a task ends badly the reason is
 * what says whether it ended badly *because* admission did not.
 */
function describe(events: SequencedAuditEvent[], taskId: string): string {
  const mine = events.filter((entry) => entry.event.taskId === taskId);
  if (mine.length === 0) {
    return "(no audit events at all)";
  }
  return mine
    .map((entry) => {
      const detail =
        entry.event.data["error"] ??
        entry.event.data["reason"] ??
        entry.event.data["explanation"];
      const stage = entry.event.data["stage"];
      const suffix =
        detail === undefined
          ? ""
          : ` [${stage === undefined ? "" : `${String(stage)}: `}${String(detail)}]`;
      return `${entry.sequence}: ${entry.event.type}${suffix}`;
    })
    .join("\n    ");
}

test("two tasks planning the same file are arbitrated, not both admitted", async () => {
  const harness = await createHarness();
  const store = harness.project.openStore();
  // A deployment that dispatches from a channel has accounts; the local runner
  // leases work under one. Without a user there is nobody to attribute a
  // worker to, and the runner falls back to executing without arbitration —
  // deliberately, and loudly, but that is not the case under test here.
  await store.createUser({
    email: "referee@example.com",
    displayName: "Referee",
    passwordDigest: "digest",
  });
  // Held outside the try so the finally can always release the agents: a
  // failed wait must not leave two node processes blocked forever.
  let runOne: Promise<unknown> | undefined;
  let runTwo: Promise<unknown> | undefined;
  let firstId: string | undefined;
  let secondId: string | undefined;

  try {
    const repository = await repoAdd(harness.project, store, {
      sourcePath: harness.sourcePath,
      id: "greeter",
    });

    // --- First dispatch -----------------------------------------------
    const first = await taskSubmit(harness.project, store, {
      objective: `Add a comment to ${OVERLAP_FILE}`,
    });
    firstId = first.id;
    runOne = runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
    });
    // Not merely planned — executing. This is the state production run 2 was
    // in when the second task planned anyway.
    await awaitSignal(harness.signalsPath, `executing-${first.id}`);

    // --- Second dispatch, while the first still holds the file ---------
    const second = await taskSubmit(harness.project, store, {
      objective: `Add a different comment to ${OVERLAP_FILE}`,
    });
    secondId = second.id;
    runTwo = runPendingTasks(harness.project, store, {
      repositoryId: repository.id,
    });
    await awaitSignal(harness.signalsPath, `planned-${second.id}`);

    // Both tasks are now in flight and the second has just planned, so this is
    // the exact moment admission had to decide. What the durable lease table
    // holds right now is the evidence for whether it could have: admission
    // arbitrates against plans read back off active leases, so a lease with no
    // plan on it — or no lease at all — is an empty `active` set and a referee
    // with nothing to compare.
    const activeLeases = await store.listWorkLeases({
      status: "active",
      repositoryId: repository.id,
    });
    const leasesCarryingPlans = activeLeases.filter(
      (lease) => lease.plan !== undefined,
    );

    // --- Let both finish ----------------------------------------------
    await releaseSignal(harness.signalsPath, `release-${first.id}`);
    await releaseSignal(harness.signalsPath, `release-${second.id}`);
    await Promise.all([runOne, runTwo]);

    const events = await store.listAuditEvents();
    const admitted = events.filter(
      (entry) => entry.event.type === "plan_admitted",
    );

    // The claim under test. The second task planned into a file the first was
    // already executing against, so the referee owed it a decision.
    assert.ok(
      admitted.some((entry) => entry.event.taskId === second.id),
      "The second task planned the same file as an in-flight task and was " +
        "never given a plan_admitted decision. Admission did not run on the " +
        "path this dispatch took.\n" +
        `  second task: ${describe(events, second.id)}\n` +
        `  first task:  ${describe(events, first.id)}\n` +
        `  active leases during the window: ${activeLeases.length} ` +
        `(${leasesCarryingPlans.length} carrying a plan)`,
    );

    // Sequenced or trimmed both count: the point is that the second task was
    // held off the file, not which of the two shapes the referee chose.
    const decision = admitted.find(
      (entry) => entry.event.taskId === second.id,
    )!;
    const status = decision.event.data["status"];
    assert.ok(
      status === "sequenced" || decision.event.data["partial"] === true,
      `Expected the second task to be sequenced behind the first or admitted ` +
        `partially, got status ${JSON.stringify(status)}`,
    );

    // And the decision has to have bitten. If the second task started
    // executing before the first promoted, the two agents were writing the
    // same file at the same time whatever the audit log says about it.
    const promotedFirst = events.find(
      (entry) =>
        entry.event.type === "canonical_promoted" &&
        entry.event.taskId === first.id,
    );
    const startedSecond = events.find(
      (entry) =>
        entry.event.type === "task_started" && entry.event.taskId === second.id,
    );
    assert.ok(promotedFirst !== undefined, "the first task never promoted");
    assert.ok(startedSecond !== undefined, "the second task never started");
    assert.ok(
      startedSecond.sequence > promotedFirst.sequence,
      "The second task began executing before the first promoted, so both " +
        "agents held the same file at once.",
    );

    // And the point of all of it: the loser's work is not thrown away. Before
    // arbitration reached this path the second task ran headlong into the
    // first, lost the exact-base check at landing time and — because the two
    // were in different runs, with no shared wave loop to replan it — failed
    // outright. Both tasks landing is the difference between a referee and a
    // collision report.
    const settled = await store.listSubmittedTasks({
      repositoryId: repository.id,
    });
    assert.deepEqual(
      settled.map((task) => [task.id, task.status]).sort(),
      [
        [first.id, "integrated"],
        [second.id, "integrated"],
      ].sort(),
      `Both tasks should have landed.\n` +
        `  second task: ${describe(events, second.id)}\n` +
        `  first task:  ${describe(events, first.id)}`,
    );
  } finally {
    // Release unconditionally: if an assertion or a wait threw, the agents are
    // still blocked on their signals and the runs will never settle.
    if (firstId !== undefined) {
      await releaseSignal(harness.signalsPath, `release-${firstId}`);
    }
    if (secondId !== undefined) {
      await releaseSignal(harness.signalsPath, `release-${secondId}`);
    }
    await Promise.allSettled([runOne, runTwo]);
    await store.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});
