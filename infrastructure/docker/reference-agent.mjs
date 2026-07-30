#!/usr/bin/env node
/**
 * Reference JSONL coding agent for the coordinator sandbox.
 *
 * Implements docs/protocol/generic-cli.md with no dependencies so it can run in
 * a minimal container with the network disabled. It performs the benchmark's
 * "cap" task: bound the incremented value at ten.
 *
 * It exists to verify the sandbox end to end. It is not a real coding agent.
 */

import fs from "node:fs";
import path from "node:path";

const PLAN = {
  taskId: "task_cap_value",
  objective: "Cap the incremented value at ten",
  expectedFiles: ["src/counter.js", "test/cap.test.js"],
  expectedSymbols: ["increment"],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
};

/**
 * The task this session was started for.
 *
 * The local benchmark always starts `task_cap_value`, so echoing the assigned
 * identity changes nothing there. It is what makes the agent usable from a
 * remote worker, where the control plane mints the task id and refuses a plan
 * that names a different one.
 */
let assignment;

function plan() {
  if (assignment === undefined) {
    return PLAN;
  }
  return {
    ...PLAN,
    taskId: assignment.taskId,
    objective: assignment.objective ?? PLAN.objective,
  };
}

const CAP_TEST = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { increment } from "../src/counter.js";',
  "",
  'test("caps incremented values", () => {',
  "  assert.equal(increment(20), 10);",
  "});",
  "",
].join("\n");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message) {
  // stderr is diagnostic only and never carries protocol meaning.
  process.stderr.write(`[reference-agent] ${message}\n`);
}

let paused = false;
let pendingContext;

/**
 * Confinement probes, run from inside the container the coordinator launched.
 *
 * The point is where they run. A verification script on the host can inspect
 * the flags the coordinator passed; only the agent process can report what
 * those flags actually produced around it. Every verdict is folded into the
 * completion explanation, which travels with the changeset and is persisted,
 * so a run that integrates carries its own evidence of isolation.
 *
 * Enabled by COORD_SANDBOX_PROBE so the agent stays usable unconfined.
 */
async function probeConfinement(workspacePath) {
  const verdicts = [];

  try {
    fs.writeFileSync("/coord-rootfs-probe", "x");
    verdicts.push("rootfs=WRITABLE");
  } catch {
    verdicts.push("rootfs=readonly");
  }

  try {
    const stat = fs.statSync(path.join(workspacePath, ".git"));
    // A worktree's .git is a file and a clone's is a directory. Either is
    // masked when it carries nothing: the host path inside it is what must
    // not be visible.
    const empty = stat.isFile()
      ? stat.size === 0
      : fs.readdirSync(path.join(workspacePath, ".git")).length === 0;
    verdicts.push(empty ? "git=masked" : "git=EXPOSED");
  } catch {
    verdicts.push("git=absent");
  }

  const dns = await new Promise((resolve) => {
    import("node:dns")
      .then((module) => {
        module.lookup("example.com", (error) => {
          resolve(error ? "network=denied" : "network=REACHED");
        });
      })
      .catch(() => resolve("network=denied"));
  });
  verdicts.push(dns);

  return verdicts;
}

async function handleContext(message) {
  const workspacePath = message.workspacePath;
  log(`workspace ${workspacePath}`);
  send({
    type: "event",
    event: { event: "progress", message: "capping increment at ten" },
  });

  const probe =
    process.env.COORD_SANDBOX_PROBE === "1"
      ? await probeConfinement(workspacePath)
      : undefined;
  if (probe !== undefined) {
    log(`confinement ${probe.join(" ")}`);
  }

  const sourcePath = path.join(workspacePath, "src", "counter.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const match = /return (.+) \+ 1;/u.exec(source);
  if (match === null) {
    send({
      type: "error",
      message: "increment no longer matches the approved plan",
    });
    return;
  }

  fs.writeFileSync(
    sourcePath,
    source.replace(match[0], `return Math.min(${match[1]} + 1, 10);`),
    "utf8",
  );
  fs.writeFileSync(
    path.join(workspacePath, "test", "cap.test.js"),
    CAP_TEST,
    "utf8",
  );

  send({
    type: "done",
    symbolsChanged: ["increment"],
    explanation:
      "capped the incremented value at ten" +
      (probe === undefined ? "" : ` [sandbox ${probe.join(" ")}]`),
  });
}

/** Editing is asynchronous now; a rejection must still reach the coordinator. */
function runContext(message) {
  handleContext(message).catch((error) => {
    send({ type: "error", message: String(error?.message ?? error) });
  });
}

function handle(message) {
  switch (message.type) {
    case "start":
      assignment = { taskId: message.taskId, objective: message.objective };
      log(`session ${message.sessionId} for ${message.taskId}`);
      return;
    case "plan_request":
      send({ type: "plan", plan: plan() });
      return;
    case "replan_request":
      log(
        `replanning after ${message.request.canonicalChange.changedFiles.length} canonical file change(s)`,
      );
      send({
        type: "plan",
        plan: {
          ...plan(),
          objective: message.request.previousPlan.objective,
        },
      });
      return;
    case "context":
      if (paused) {
        pendingContext = message;
      } else {
        runContext(message);
      }
      return;
    case "pause":
      paused = true;
      return;
    case "resume":
      paused = false;
      if (pendingContext !== undefined) {
        const context = pendingContext;
        pendingContext = undefined;
        runContext(context);
      }
      return;
    case "scope_decision":
      log(
        `scope ${message.decision.requestId}: ${message.decision.decision}`,
      );
      return;
    case "cancel":
      process.exit(0);
      return;
    default:
      log(`ignoring ${message.type}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line));
      } catch (error) {
        send({ type: "error", message: String(error?.message ?? error) });
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
