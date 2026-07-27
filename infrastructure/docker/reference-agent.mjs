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

function handleContext(message) {
  const workspacePath = message.workspacePath;
  log(`workspace ${workspacePath}`);
  send({
    type: "event",
    event: { event: "progress", message: "capping increment at ten" },
  });

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
    explanation: "capped the incremented value at ten",
  });
}

function handle(message) {
  switch (message.type) {
    case "start":
      log(`session ${message.sessionId} for ${message.taskId}`);
      return;
    case "plan_request":
      send({ type: "plan", plan: PLAN });
      return;
    case "replan_request":
      log(
        `replanning after ${message.request.canonicalChange.changedFiles.length} canonical file change(s)`,
      );
      send({
        type: "plan",
        plan: {
          ...PLAN,
          objective: message.request.previousPlan.objective,
        },
      });
      return;
    case "context":
      if (paused) {
        pendingContext = message;
      } else {
        handleContext(message);
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
        handleContext(context);
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
