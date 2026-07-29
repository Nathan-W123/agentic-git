import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentPlan, TaskDefinition, ValidationCommand } from "@coord/shared-types";

import type { ScriptedAgentBehavior } from "./scripted-agent.js";

/**
 * Benchmark scenarios.
 *
 * Each scenario is a seed repository plus a task set chosen to exercise one
 * coordination property. Scripted behavior keeps every scenario deterministic,
 * so a change in the reported metrics is a change in the coordinator and not
 * noise from an agent.
 */

export const VALIDATION_COMMANDS: ValidationCommand[] = [
  {
    executable: "node",
    args: ["--test"],
    label: "repository tests",
  },
];

export interface ScenarioTask {
  task: TaskDefinition;
  behavior: ScriptedAgentBehavior;
}

export interface BenchmarkScenario {
  name: string;
  description: string;
  /** Repository-relative files written before the first canonical commit. */
  seed: Readonly<Record<string, string>>;
  tasks: ScenarioTask[];
  /**
   * Tasks whose conflict is intentionally outside the current structural and
   * semantic evidence model. Present so expected misses remain explicit.
   */
  knownUndetectedConflicts?: Readonly<Record<string, string>>;
}

function testSource(
  importLine: string,
  name: string,
  body: readonly string[],
): string {
  return [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    importLine,
    "",
    `test(${JSON.stringify(name)}, () => {`,
    ...body.map((line) => `  ${line}`),
    "});",
    "",
  ].join("\n");
}

const COUNTER_IMPORT = 'import { increment } from "../src/counter.js";';
const FORMAT_IMPORT = 'import { formatCount } from "../src/format.js";';

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: "coord-benchmark-fixture",
    private: true,
    type: "module",
  },
  undefined,
  2,
)}\n`;

const COUNTER_SOURCE = [
  "export function increment(value) {",
  "  return value + 1;",
  "}",
  "",
].join("\n");

const FORMAT_SOURCE = [
  "export function formatCount(value) {",
  "  return String(value);",
  "}",
  "",
].join("\n");

const CONFIG_SOURCE = "export const MAX_STEP = 1;\n";

const BASE_TEST = testSource(COUNTER_IMPORT, "increments values", [
  "assert.equal(increment(1), 2);",
]);

async function rewrite(
  workspacePath: string,
  repositoryPath: string,
  transform: (source: string) => string,
): Promise<void> {
  const target = path.join(workspacePath, ...repositoryPath.split("/"));
  const source = await readFile(target, "utf8");
  await writeFile(target, transform(source), "utf8");
}

async function addFile(
  workspacePath: string,
  repositoryPath: string,
  content: string,
): Promise<void> {
  await writeFile(
    path.join(workspacePath, ...repositoryPath.split("/")),
    content,
    "utf8",
  );
}

function definition(
  id: string,
  objective: string,
  agentId: string,
): TaskDefinition {
  return { id, objective, agentId, validationCommands: VALIDATION_COMMANDS };
}

function plan(
  task: TaskDefinition,
  expectedFiles: string[],
  expectedSymbols: string[],
  dependencies: string[] = [],
): AgentPlan {
  return {
    taskId: task.id,
    objective: task.objective,
    expectedFiles,
    expectedSymbols,
    dependencies,
    commands: task.validationCommands,
    externalAccess: [],
    riskLevel: "low",
  };
}

/** Replaces the whole return expression so counter edits compose in any order. */
function replaceReturnExpression(
  source: string,
  wrap: (expression: string) => string,
): string {
  const match = /return (.+);/u.exec(source);
  const expression = match?.[1];
  if (match === null || expression === undefined) {
    throw new Error("The increment implementation no longer matches the plan");
  }
  return source.replace(match[0], `return ${wrap(expression)};`);
}

export const TASK_NORMALIZE = definition(
  "task_normalize_input",
  "Normalize numeric input before incrementing",
  "scripted-codex",
);

export const TASK_CAP = definition(
  "task_cap_value",
  "Cap the incremented value at ten",
  "scripted-generic-cli",
);

export const TASK_FLOOR = definition(
  "task_floor_value",
  "Floor the incremented value at zero",
  "scripted-claude-code",
);

export const TASK_FORMAT = definition(
  "task_format_label",
  "Label formatted counts",
  "scripted-gemini",
);

export const TASK_CONFIG = definition(
  "task_config_step",
  "Raise the maximum configured step",
  "scripted-codex",
);

export const TASK_BOXED = definition(
  "task_boxed_increment",
  "Return the incremented value as a record",
  "scripted-codex",
);

export const TASK_TOTAL = definition(
  "task_format_total",
  "Add a total helper built on increment",
  "scripted-generic-cli",
);

export const NORMALIZE_BEHAVIOR: ScriptedAgentBehavior = {
  plan: plan(
    TASK_NORMALIZE,
    ["src/counter.js", "test/numeric-input.test.js"],
    ["increment"],
  ),
  async execute(workspacePath) {
    await rewrite(workspacePath, "src/counter.js", (source) => {
      if (!source.includes("return value + 1;")) {
        throw new Error("The increment implementation no longer matches the plan");
      }
      return source.replace("return value + 1;", "return Number(value) + 1;");
    });
    await addFile(
      workspacePath,
      "test/numeric-input.test.js",
      testSource(COUNTER_IMPORT, "normalizes numeric strings", [
        'assert.equal(increment("4"), 5);',
      ]),
    );
  },
};

export const CAP_BEHAVIOR: ScriptedAgentBehavior = {
  plan: plan(TASK_CAP, ["src/counter.js", "test/cap.test.js"], ["increment"]),
  async execute(workspacePath) {
    await rewrite(workspacePath, "src/counter.js", (source) =>
      replaceReturnExpression(source, (expression) =>
        `Math.min(${expression}, 10)`,
      ),
    );
    await addFile(
      workspacePath,
      "test/cap.test.js",
      testSource(COUNTER_IMPORT, "caps incremented values", [
        "assert.equal(increment(20), 10);",
      ]),
    );
  },
};

export const FLOOR_BEHAVIOR: ScriptedAgentBehavior = {
  plan: plan(TASK_FLOOR, ["src/counter.js", "test/floor.test.js"], ["increment"]),
  async execute(workspacePath) {
    await rewrite(workspacePath, "src/counter.js", (source) =>
      replaceReturnExpression(source, (expression) =>
        `Math.max(${expression}, 0)`,
      ),
    );
    await addFile(
      workspacePath,
      "test/floor.test.js",
      testSource(COUNTER_IMPORT, "floors incremented values", [
        "assert.equal(increment(-50), 0);",
      ]),
    );
  },
};

export const FORMAT_BEHAVIOR: ScriptedAgentBehavior = {
  plan: plan(
    TASK_FORMAT,
    ["src/format.js", "test/format.test.js"],
    ["formatCount"],
  ),
  async execute(workspacePath) {
    await rewrite(workspacePath, "src/format.js", (source) => {
      if (!source.includes("return String(value);")) {
        throw new Error("The formatCount implementation no longer matches the plan");
      }
      return source.replace(
        "return String(value);",
        "return `count: ${value}`;",
      );
    });
    await addFile(
      workspacePath,
      "test/format.test.js",
      testSource(FORMAT_IMPORT, "labels formatted counts", [
        'assert.equal(formatCount(3), "count: 3");',
      ]),
    );
  },
};

export const CONFIG_BEHAVIOR: ScriptedAgentBehavior = {
  plan: plan(
    TASK_CONFIG,
    ["src/config.js", "test/config.test.js"],
    ["MAX_STEP"],
  ),
  async execute(workspacePath) {
    await rewrite(workspacePath, "src/config.js", (source) => {
      if (!source.includes("MAX_STEP = 1;")) {
        throw new Error("The configured step no longer matches the plan");
      }
      return source.replace("MAX_STEP = 1;", "MAX_STEP = 5;");
    });
    await addFile(
      workspacePath,
      "test/config.test.js",
      testSource(
        'import { MAX_STEP } from "../src/config.js";',
        "raises the maximum step",
        ["assert.equal(MAX_STEP, 5);"],
      ),
    );
  },
};

export const BOXED_BEHAVIOR: ScriptedAgentBehavior = {
  plan: plan(
    TASK_BOXED,
    ["src/counter.js", "test/base.test.js"],
    ["increment"],
  ),
  async execute(workspacePath) {
    await rewrite(workspacePath, "src/counter.js", (source) =>
      replaceReturnExpression(source, (expression) => `{ value: ${expression} }`),
    );
    await addFile(
      workspacePath,
      "test/base.test.js",
      testSource(COUNTER_IMPORT, "increments values", [
        "assert.equal(increment(1).value, 2);",
      ]),
    );
  },
};

export const TOTAL_BEHAVIOR: ScriptedAgentBehavior = {
  plan: plan(
    TASK_TOTAL,
    ["src/format.js", "test/format-total.test.js"],
    ["total"],
    ["symbol:increment"],
  ),
  replan(request) {
    if (!request.canonicalChange.changedSymbols.includes("increment")) {
      throw new Error("Expected the increment contract change during replanning");
    }
    return {
      ...request.previousPlan,
      intent:
        "Add a total helper compatible with the latest increment return contract",
    };
  },
  async execute(workspacePath) {
    const counter = await readFile(
      path.join(workspacePath, "src", "counter.js"),
      "utf8",
    );
    const accessor = /return\s+\{\s*value:/u.test(counter) ? ".value" : "";
    await rewrite(workspacePath, "src/format.js", (source) => {
      return [
        'import { increment } from "./counter.js";',
        "",
        source.trimEnd(),
        "",
        "export function total(value) {",
        `  return increment(value)${accessor} + 1;`,
        "}",
        "",
      ].join("\n");
    });
    await addFile(
      workspacePath,
      "test/format-total.test.js",
      testSource(
        'import { total } from "../src/format.js";',
        "totals an incremented value",
        ["assert.equal(total(1), 3);"],
      ),
    );
  },
};

/**
 * Two tasks that both edit the increment implementation.
 *
 * The original Phase 0 proof: file overlap sequences the second task behind the
 * first, so it never builds a patch against a stale revision.
 */
export const OVERLAP_SCENARIO: BenchmarkScenario = {
  name: "overlap",
  description: "Two tasks edit one function; ownership sequences the second.",
  seed: {
    "package.json": PACKAGE_JSON,
    "src/counter.js": COUNTER_SOURCE,
    "test/base.test.js": BASE_TEST,
  },
  tasks: [
    { task: TASK_NORMALIZE, behavior: NORMALIZE_BEHAVIOR },
    { task: TASK_CAP, behavior: CAP_BEHAVIOR },
  ],
};

/**
 * Five tasks mixing a three-way collision with two independent tasks.
 *
 * Exercises the property that matters for throughput: colliding work is
 * sequenced without serializing tasks that never collide.
 */
export const MIXED_SCENARIO: BenchmarkScenario = {
  name: "mixed",
  description:
    "Three tasks contend for one function while two independent tasks run free.",
  seed: {
    "package.json": PACKAGE_JSON,
    "src/counter.js": COUNTER_SOURCE,
    "src/format.js": FORMAT_SOURCE,
    "src/config.js": CONFIG_SOURCE,
    "test/base.test.js": BASE_TEST,
  },
  tasks: [
    { task: TASK_NORMALIZE, behavior: NORMALIZE_BEHAVIOR },
    { task: TASK_CAP, behavior: CAP_BEHAVIOR },
    { task: TASK_FLOOR, behavior: FLOOR_BEHAVIOR },
    { task: TASK_FORMAT, behavior: FORMAT_BEHAVIOR },
    { task: TASK_CONFIG, behavior: CONFIG_BEHAVIOR },
  ],
};

/**
 * Two tasks that touch disjoint files but are linked by a symbol dependency.
 *
 * Structural indexing and the declared dependency sequence the producer first.
 * The consumer then replans against the new canonical contract before editing.
 */
export const DEPENDENCY_SCENARIO: BenchmarkScenario = {
  name: "dependency",
  description:
    "A signature change and a new caller in different files; dependency coordination replans the caller.",
  seed: {
    "package.json": PACKAGE_JSON,
    "src/counter.js": COUNTER_SOURCE,
    "src/format.js": FORMAT_SOURCE,
    "test/base.test.js": BASE_TEST,
  },
  tasks: [
    { task: TASK_BOXED, behavior: BOXED_BEHAVIOR },
    { task: TASK_TOTAL, behavior: TOTAL_BEHAVIOR },
  ],
};

import {
  LIVE_CHECKOUT_SCENARIO,
  LIVE_PRICING_SCENARIO,
  LIVE_PRICING_WIDE_SCENARIO,
} from "./live-scenario.js";

export {
  LIVE_CHECKOUT_SCENARIO,
  LIVE_PRICING_SCENARIO,
  LIVE_PRICING_WIDE_SCENARIO,
};

export const SCENARIOS: readonly BenchmarkScenario[] = [
  OVERLAP_SCENARIO,
  MIXED_SCENARIO,
  DEPENDENCY_SCENARIO,
  LIVE_PRICING_SCENARIO,
  LIVE_PRICING_WIDE_SCENARIO,
  LIVE_CHECKOUT_SCENARIO,
];

export const DEFAULT_SCENARIO = MIXED_SCENARIO;

export function findScenario(name: string): BenchmarkScenario {
  const scenario = SCENARIOS.find((entry) => entry.name === name);
  if (scenario === undefined) {
    throw new Error(
      `Unknown benchmark scenario: ${name}. ` +
        `Available: ${SCENARIOS.map((entry) => entry.name).join(", ")}`,
    );
  }
  return scenario;
}
