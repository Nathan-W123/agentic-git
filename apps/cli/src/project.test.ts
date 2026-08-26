import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CoordinatorProject,
  assertProjectConfig,
  type ProjectConfig,
} from "./project.js";

const VALID: ProjectConfig = {
  version: 1,
  validationCommands: [
    { executable: "node", args: ["--test"], label: "tests" },
  ],
  agents: { local: { command: "node", args: ["agent.mjs"] } },
  defaultAgent: "local",
};

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cproj-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a valid configuration round-trips", () => {
  assert.deepEqual(assertProjectConfig(VALID), VALID);
});

test("configuration errors name the offending field", () => {
  assert.throws(() => assertProjectConfig({ ...VALID, version: 99 }), /"version"/u);
  assert.throws(
    () => assertProjectConfig({ ...VALID, validationCommands: "no" }),
    /"validationCommands"/u,
  );
  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        validationCommands: [{ executable: "node", label: "x" }],
      }),
    /validationCommands\[0\] needs "args"/u,
  );
  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        validationCommands: [
          { executable: "node", args: ["--test\0hidden"], label: "tests" },
        ],
      }),
    /validationCommands\[0\] needs "args"/u,
  );
  assert.throws(
    () => assertProjectConfig({ ...VALID, agents: { bad: { args: [] } } }),
    /agent "bad" needs a non-empty "command"/u,
  );
});

test("a default agent must actually be configured", () => {
  assert.throws(
    () => assertProjectConfig({ ...VALID, defaultAgent: "missing" }),
    /names an agent that is not configured/u,
  );
});

test("identifiers and optional sandbox fields are validated", () => {
  assert.throws(
    () => assertProjectConfig({ ...VALID, defaultRepository: "../outside" }),
    /"defaultRepository".*must start alphanumeric/su,
  );
  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        agents: { "bad/name": { command: "node" } },
      }),
    /agent name/u,
  );
  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        sandbox: {
          mode: "docker",
          image: "coord/agent:1",
          network: 7,
        } as never,
      }),
    /"sandbox.network" must be a non-empty string/u,
  );
});

test("a Codex agent can use the default executable", () => {
  const config = assertProjectConfig({
    ...VALID,
    agents: {
      codex: { adapter: "codex", windowsSandbox: "unelevated" },
    },
    defaultAgent: "codex",
  });
  assert.deepEqual(config.agents.codex, {
    adapter: "codex",
    windowsSandbox: "unelevated",
  });
  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        agents: {
          codex: { adapter: "codex", windowsSandbox: "disabled" } as never,
        },
      }),
    /"windowsSandbox" to be "elevated" or "unelevated"/u,
  );
});

test("vendor CLI agents default their executables; unknown adapters fail", () => {
  const config = assertProjectConfig({
    ...VALID,
    agents: {
      claude: { adapter: "claude" },
      gemini: { adapter: "gemini", command: "gemini-preview" },
      cursor: { adapter: "cursor" },
      copilot: { adapter: "copilot" },
      kiro: { adapter: "kiro" },
    },
    defaultAgent: "claude",
  });
  assert.deepEqual(config.agents.claude, { adapter: "claude" });
  assert.deepEqual(config.agents.gemini, {
    adapter: "gemini",
    command: "gemini-preview",
  });
  assert.deepEqual(config.agents.cursor, { adapter: "cursor" });
  assert.deepEqual(config.agents.copilot, { adapter: "copilot" });
  assert.deepEqual(config.agents.kiro, { adapter: "kiro" });
  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        agents: { mystery: { adapter: "unknown-vendor" } as never },
      }),
    /unsupported "adapter"/u,
  );
});

test("agent planning and execution time limits are validated", () => {
  const config = assertProjectConfig({
    ...VALID,
    agents: {
      claude: {
        adapter: "claude",
        effort: "low",
        planningTimeoutMs: 45_000,
        executionTimeoutMs: 135_000,
      },
    },
    defaultAgent: "claude",
  });
  assert.deepEqual(config.agents.claude, {
    adapter: "claude",
    effort: "low",
    planningTimeoutMs: 45_000,
    executionTimeoutMs: 135_000,
  });
  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        agents: {
          claude: { adapter: "claude", executionTimeoutMs: 999 },
        },
      }),
    /"executionTimeoutMs".*between one second and one day/su,
  );
  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        agents: {
          gemini: { adapter: "gemini", effort: "low" },
        },
      }),
    /cannot set Claude-only "effort"/u,
  );
});

test("a docker sandbox requires an image", () => {
  assert.throws(
    () => assertProjectConfig({ ...VALID, sandbox: { mode: "docker" } }),
    /"sandbox.image" is required/u,
  );
  assert.equal(
    assertProjectConfig({
      ...VALID,
      sandbox: { mode: "docker", image: "coord/agent:1" },
    }).sandbox?.image,
    "coord/agent:1",
  );
});

test("init creates the project and is safe to re-run", async () => {
  await withRoot(async (root) => {
    const first = await CoordinatorProject.init(root);
    first.config.agents = { local: { command: "node" } };
    first.config.defaultAgent = "local";
    await first.save();

    // Re-running init must not discard an existing configuration.
    const second = await CoordinatorProject.init(root);
    assert.equal(second.config.defaultAgent, "local");
    assert.deepEqual(Object.keys(second.config.agents), ["local"]);
  });
});

test("opening a directory with no project explains what to do", async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      CoordinatorProject.open(root),
      /No coordinator project at .*coord init/su,
    );
  });
});

test("a byte order mark does not break the configuration", async () => {
  await withRoot(async (root) => {
    const project = await CoordinatorProject.init(root);
    const raw = await readFile(project.configPath, "utf8");
    // Windows editors and PowerShell's UTF-8 mode write this.
    await writeFile(project.configPath, `\uFEFF${raw}`, "utf8");

    const reopened = await CoordinatorProject.open(root);
    assert.equal(reopened.config.version, 1);
  });
});

test("malformed JSON reports the file it came from", async () => {
  await withRoot(async (root) => {
    const project = await CoordinatorProject.init(root);
    await writeFile(project.configPath, "{ not json", "utf8");
    await assert.rejects(CoordinatorProject.open(root), /Could not parse/u);
  });
});

test("invalid mutations are not written over the last valid config", async () => {
  await withRoot(async (root) => {
    const project = await CoordinatorProject.init(root);
    const before = await readFile(project.configPath, "utf8");
    project.config.defaultRepository = "../outside";

    await assert.rejects(project.save(), /"defaultRepository"/u);
    assert.equal(await readFile(project.configPath, "utf8"), before);
  });
});

test("a fresh project does not inherit another project's edits", async () => {
  await withRoot(async (rootA) => {
    await withRoot(async (rootB) => {
      const first = await CoordinatorProject.init(rootA);
      first.config.agents = { leaked: { command: "node" } };
      // Mutating in place as well as reassigning: a shared default object
      // would carry this into the next project even though the line above
      // replaced the reference.
      Object.assign(first.config.agents, { alsoLeaked: { command: "node" } });

      const second = await CoordinatorProject.init(rootB);
      assert.equal(second.config.agents["leaked"], undefined);
      assert.equal(second.config.agents["alsoLeaked"], undefined);
      // And it still gets the defaults every fresh project gets, so this
      // cannot pass by handing out an empty map instead.
      assert.deepEqual(Object.keys(second.config.agents).sort(), [
        "claude",
        "codex",
        "cursor",
        "kiro",
      ]);
    });
  });
});

test("requireAgent explains what is configured", async () => {
  await withRoot(async (root) => {
    const project = await CoordinatorProject.init(root);
    assert.throws(
      () => project.requireAgent(undefined),
      /No agent specified and no defaultAgent configured/u,
    );

    project.config.agents = { alpha: { command: "node" } };
    assert.throws(
      () => project.requireAgent("beta"),
      /Unknown agent: beta.*Configured agents: alpha/su,
    );
    assert.deepEqual(project.requireAgent("alpha"), [
      "alpha",
      { command: "node" },
    ]);
  });
});

/**
 * A project created before a vendor existed has a stored `agents` map without
 * it, and that map is read verbatim. So connecting Cursor in the browser and
 * then asking it to do something answered "No cursor agent is configured on
 * this deployment" — the same gap the defaults were added to close, except
 * defaults only apply when the project is created.
 */
test("a config written before a vendor existed still gains its agent", () => {
  const older = assertProjectConfig({
    version: 1,
    validationCommands: [],
    // Exactly what an older deployment holds: the two vendors that existed
    // when it was created.
    agents: { codex: { adapter: "codex" }, claude: { adapter: "claude" } },
  });

  for (const adapter of ["cursor", "copilot", "kiro", "gemini"]) {
    assert.ok(
      Object.values(older.agents).some((agent) => agent.adapter === adapter),
      `${adapter} must be runnable once it is connected`,
    );
  }
  // And the entries that were already there are untouched.
  assert.deepEqual(older.agents["codex"], { adapter: "codex" });
  assert.deepEqual(older.agents["claude"], { adapter: "claude" });
});

test("backfill never redefines an agent the project already configured", () => {
  const custom = assertProjectConfig({
    version: 1,
    validationCommands: [],
    agents: {
      // The project's own Cursor agent, named its own way and pinned to a
      // particular executable. Adding a second one called "cursor" would give
      // this deployment two, and let the wrong one answer a mention.
      "cursor-primary": { adapter: "cursor", command: "/opt/cursor/agent" },
    },
  });

  const cursors = Object.entries(custom.agents).filter(
    ([, agent]) => agent.adapter === "cursor",
  );
  assert.deepEqual(cursors, [
    ["cursor-primary", { adapter: "cursor", command: "/opt/cursor/agent" }],
  ]);
});

test("a project running only its own commands is left as it was", () => {
  const curated = assertProjectConfig({
    version: 1,
    validationCommands: [],
    agents: { local: { command: "node", args: ["agent.mjs"] } },
    defaultAgent: "local",
  });

  // Backfill repairs a config that has fallen behind the vendors on offer.
  // It does not have opinions about one that never ran vendors at all.
  assert.deepEqual(Object.keys(curated.agents), ["local"]);
});

test("buildCommand and buildCommands are validated like preview commands", () => {
  // A preview that installs and never builds starts a checkout with no build
  // output in it, which is how `node dist/index.js` came to be reported as an
  // app that exits immediately. The build is configurable for the same reason
  // the start command is — detection can find a script, and nothing can guess
  // the value a compiled app is built against — so it is checked the same way.
  const built: ProjectConfig = {
    ...VALID,
    buildCommand: { executable: "npm", args: ["run", "build"], label: "build" },
    buildCommands: {
      web: {
        executable: "npm",
        args: ["run", "build"],
        label: "build web",
        env: { API_BASE: "http://127.0.0.1:8080" },
      },
    },
  };
  assert.deepEqual(assertProjectConfig(built), built);

  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        buildCommand: { executable: "npm", label: "build" },
      }),
    /buildCommand needs "args"/u,
  );
  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        buildCommands: {
          web: { executable: "npm", args: ["run", "build"], label: "" },
        },
      }),
    /buildCommands\["web"\] needs a non-empty "label"/u,
  );
  // The half a build command has that a validation command does not.
  assert.throws(
    () =>
      assertProjectConfig({
        ...VALID,
        buildCommand: {
          executable: "npm",
          args: ["run", "build"],
          label: "build",
          env: { API_BASE: 8080 },
        },
      }),
    /buildCommand needs "env.API_BASE" to be a string/u,
  );
});
