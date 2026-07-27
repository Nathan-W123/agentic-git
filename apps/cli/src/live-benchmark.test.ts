import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCoordinatedFixture } from "./benchmark.js";
import {
  createLiveBenchmarkFixture,
  parseAgentArgs,
  readLiveAgentConfig,
} from "./fixture.js";
import { OVERLAP_SCENARIO, TASK_CAP, TASK_NORMALIZE } from "./scenarios.js";

/**
 * A real agent process for the cap task, speaking the JSONL protocol on stdio.
 *
 * It mirrors CAP_BEHAVIOR so the coordinated result stays comparable to the
 * scripted benchmark, but it reaches the workspace through a spawned process
 * rather than an in-process callback.
 */
const CAP_AGENT = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  "",
  "const PLAN = {",
  '  taskId: "task_cap_value",',
  '  objective: "Cap the incremented value at ten",',
  '  expectedFiles: ["src/counter.js", "test/cap.test.js"],',
  '  expectedSymbols: ["increment"],',
  "  dependencies: [],",
  "  commands: [],",
  "  externalAccess: [],",
  '  riskLevel: "low",',
  "};",
  "",
  "const CAP_TEST =",
  "  'import assert from \"node:assert/strict\";\\n' +",
  "  'import test from \"node:test\";\\n' +",
  "  'import { increment } from \"../src/counter.js\";\\n' +",
  "  '\\n' +",
  "  'test(\"caps incremented values\", () => {\\n' +",
  "  '  assert.equal(increment(20), 10);\\n' +",
  "  '});\\n';",
  "",
  "let buffer = '';",
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  "  buffer += chunk;",
  '  let index = buffer.indexOf("\\n");',
  "  while (index !== -1) {",
  "    const line = buffer.slice(0, index).trim();",
  "    buffer = buffer.slice(index + 1);",
  "    if (line.length > 0) {",
  "      handle(JSON.parse(line));",
  "    }",
  '    index = buffer.indexOf("\\n");',
  "  }",
  "});",
  "",
  "function send(message) {",
  '  process.stdout.write(JSON.stringify(message) + "\\n");',
  "}",
  "",
  "function handle(message) {",
  '  if (message.type === "plan_request") {',
  '    send({ type: "plan", plan: PLAN });',
  "    return;",
  "  }",
  '  if (message.type === "replan_request") {',
  '    send({ type: "plan", plan: PLAN });',
  "    return;",
  "  }",
  '  if (message.type === "context") {',
  "    send({",
  '      type: "event",',
  '      event: { event: "progress", message: "capping increment" },',
  "    });",
  '    const sourcePath = path.join(message.workspacePath, "src", "counter.js");',
  '    const source = fs.readFileSync(sourcePath, "utf8");',
  "    const match = /return (.+) \\+ 1;/u.exec(source);",
  "    if (match === null) {",
  '      send({ type: "error", message: "increment no longer matches the plan" });',
  "      return;",
  "    }",
  "    fs.writeFileSync(",
  "      sourcePath,",
  "      source.replace(match[0], `return Math.min(${match[1]} + 1, 10);`),",
  '      "utf8",',
  "    );",
  "    fs.writeFileSync(",
  '      path.join(message.workspacePath, "test", "cap.test.js"),',
  "      CAP_TEST,",
  '      "utf8",',
  "    );",
  "    send({",
  '      type: "done",',
  '      symbolsChanged: ["increment"],',
  '      explanation: "capped the incremented value at ten",',
  "    });",
  "    return;",
  "  }",
  '  if (message.type === "cancel") {',
  "    process.exit(0);",
  "  }",
  "}",
  'process.stdin.on("end", () => process.exit(0));',
  "",
].join("\n");

test("agent arguments accept both JSON and whitespace forms", () => {
  assert.deepEqual(parseAgentArgs(undefined), []);
  assert.deepEqual(parseAgentArgs("   "), []);
  assert.deepEqual(parseAgentArgs("--protocol jsonl"), ["--protocol", "jsonl"]);
  assert.deepEqual(parseAgentArgs('["--root","/a b/c"]'), ["--root", "/a b/c"]);
  assert.throws(() => parseAgentArgs('["--root", 7]'), /JSON array of strings/u);
});

test("the live configuration is absent unless COORD_AGENT_CMD is set", () => {
  assert.equal(readLiveAgentConfig({}), undefined);
  assert.equal(readLiveAgentConfig({ COORD_AGENT_CMD: "  " }), undefined);
});

test("the cap task runs live by default", () => {
  const config = readLiveAgentConfig({ COORD_AGENT_CMD: "agent" });
  assert.deepEqual(config, {
    command: "agent",
    args: [],
    taskIds: [TASK_CAP.id],
  });
});

test("live task selection is configurable and validated", () => {
  // "all" stays a sentinel: the scenario is not known when the env is read.
  assert.equal(
    readLiveAgentConfig({ COORD_AGENT_CMD: "agent", COORD_AGENT_TASKS: "all" })
      ?.taskIds,
    "all",
  );
  assert.deepEqual(
    readLiveAgentConfig({
      COORD_AGENT_CMD: "agent",
      COORD_AGENT_TASKS: "normalize",
    })?.taskIds,
    [TASK_NORMALIZE.id],
  );
  assert.throws(
    () =>
      readLiveAgentConfig({
        COORD_AGENT_CMD: "agent",
        COORD_AGENT_TASKS: "task_unknown",
      }),
    /unknown benchmark task/u,
  );
});

test("the Docker sandbox requires an explicit image", () => {
  assert.throws(
    () =>
      readLiveAgentConfig({
        COORD_AGENT_CMD: "agent",
        COORD_AGENT_SANDBOX: "docker",
      }),
    /requires COORD_AGENT_IMAGE/u,
  );
  assert.deepEqual(
    readLiveAgentConfig({
      COORD_AGENT_CMD: "agent",
      COORD_AGENT_SANDBOX: "docker",
      COORD_AGENT_IMAGE: "coord/agent:1",
      COORD_AGENT_NETWORK: "coord-allowlist",
    })?.sandbox,
    { image: "coord/agent:1", network: "coord-allowlist" },
  );
  assert.throws(
    () =>
      readLiveAgentConfig({
        COORD_AGENT_CMD: "agent",
        COORD_AGENT_SANDBOX: "firejail",
      }),
    /Unsupported COORD_AGENT_SANDBOX/u,
  );
});

test("a live fixture needs a configured agent executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-live-missing-"));
  try {
    await assert.rejects(
      createLiveBenchmarkFixture(root, "live", undefined),
      /requires COORD_AGENT_CMD/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real agent process integrates alongside a scripted agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-live-"));

  try {
    const scriptPath = path.join(root, "cap-agent.mjs");
    await writeFile(scriptPath, CAP_AGENT, "utf8");

    const config = readLiveAgentConfig({
      COORD_AGENT_CMD: process.execPath,
      COORD_AGENT_ARGS: JSON.stringify([scriptPath]),
    });
    const fixture = await createLiveBenchmarkFixture(
      root,
      "live",
      config,
      OVERLAP_SCENARIO,
    );
    assert.deepEqual(fixture.liveAgent?.taskIds, [TASK_CAP.id]);
    assert.equal(fixture.sandbox, undefined);

    const result = await runCoordinatedFixture(fixture);
    assert.equal(result.metrics.tasksCompleted, 2);
    assert.equal(result.metrics.conflictWarnings, 1);
    assert.equal(result.metrics.reworkCount, 0);

    const capTask = result.run.tasks.find(
      (entry) => entry.task.id === TASK_CAP.id,
    );
    assert.equal(capTask?.status, "integrated");
    assert.ok((capTask?.decision?.planRevision ?? 0) > 1);
    assert.equal(
      capTask?.integration?.status,
      "integrated",
      capTask?.explanation,
    );

    const source = await fixture.repositories.readFile(
      fixture.repository,
      result.run.canonicalVersion.revision,
      "src/counter.js",
    );
    assert.match(source, /return Math\.min\(Number\(value\) \+ 1, 10\);/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
