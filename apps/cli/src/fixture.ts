import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TaskId } from "@coord/shared-types";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type DockerSandboxOptions,
  type WorkspaceManager,
  type WorkspaceSandbox,
} from "@coord/workspace-manager";

import {
  DEFAULT_SCENARIO,
  SCENARIOS,
  TASK_CAP,
  TASK_NORMALIZE,
  type BenchmarkScenario,
} from "./scenarios.js";

/**
 * Configuration for replacing scripted behavior with a real agent process.
 *
 * The scripted path stays the deterministic default used by CI. The live path
 * is opt-in so a benchmark run never depends on an external binary by accident.
 */
export interface LiveAgentConfig {
  /** Which adapter drives the process. Defaults to the JSONL protocol. */
  adapter?: "generic-cli" | "codex";
  command: string;
  args: string[];
  /** Benchmark tasks handed to the real agent. The rest stay scripted. */
  taskIds: TaskId[] | "all";
  /** Codex only: the sandbox its edit phase runs under. */
  executionSandbox?: "workspace-write" | "danger-full-access";
  sandbox?: DockerSandboxOptions;
}

export interface BenchmarkFixture {
  repository: CanonicalRepository;
  repositories: RepositoryService;
  workspaces: WorkspaceManager;
  scenario: BenchmarkScenario;
  rootPath: string;
  workspaceRoot: string;
  integrationRoot: string;
  liveAgent?: LiveAgentConfig;
  sandbox?: WorkspaceSandbox;
}

/** True when `task` should be driven by the real agent process. */
export function isLiveTask(
  live: LiveAgentConfig | undefined,
  taskId: TaskId,
): boolean {
  if (live === undefined) {
    return false;
  }
  return live.taskIds === "all" || live.taskIds.includes(taskId);
}

export {
  CAP_BEHAVIOR,
  NORMALIZE_BEHAVIOR,
  TASK_CAP,
  TASK_NORMALIZE,
} from "./scenarios.js";

/**
 * Splits `COORD_AGENT_ARGS` into an argument array.
 *
 * A JSON array is preferred because the agent process is spawned without a
 * shell, so whitespace splitting cannot express an argument containing spaces.
 */
export function parseAgentArgs(raw: string | undefined): string[] {
  const value = raw?.trim() ?? "";
  if (value.length === 0) {
    return [];
  }
  if (value.startsWith("[")) {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry) => typeof entry === "string")
    ) {
      throw new Error("COORD_AGENT_ARGS must be a JSON array of strings");
    }
    return [...(parsed as string[])];
  }
  return value.split(/\s+/u);
}

/**
 * Resolves `COORD_AGENT_TASKS`.
 *
 * `"all"` stays a sentinel rather than an expanded list because the scenario,
 * and therefore the task set, is chosen after the environment is read.
 */
function parseLiveTaskIds(raw: string | undefined): TaskId[] | "all" {
  const known = new Map<string, TaskId>([
    ["normalize", TASK_NORMALIZE.id],
    ["cap", TASK_CAP.id],
  ]);
  for (const scenario of SCENARIOS) {
    for (const entry of scenario.tasks) {
      known.set(entry.task.id, entry.task.id);
    }
  }

  const value = raw?.trim() ?? "";
  if (value.length === 0) {
    return [TASK_CAP.id];
  }
  if (value === "all") {
    return "all";
  }

  return value.split(",").map((entry) => {
    const resolved = known.get(entry.trim());
    if (resolved === undefined) {
      throw new Error(
        `COORD_AGENT_TASKS names an unknown benchmark task: ${entry.trim()}`,
      );
    }
    return resolved;
  });
}

function readSandboxConfig(
  env: NodeJS.ProcessEnv,
): DockerSandboxOptions | undefined {
  const mode = env["COORD_AGENT_SANDBOX"]?.trim() ?? "";
  if (mode === "" || mode === "none") {
    return undefined;
  }
  if (mode !== "docker") {
    throw new Error(`Unsupported COORD_AGENT_SANDBOX value: ${mode}`);
  }

  const image = env["COORD_AGENT_IMAGE"]?.trim() ?? "";
  if (image.length === 0) {
    throw new Error("COORD_AGENT_SANDBOX=docker requires COORD_AGENT_IMAGE");
  }
  const network = env["COORD_AGENT_NETWORK"]?.trim() ?? "";
  return {
    image,
    ...(network.length === 0 ? {} : { network }),
  };
}

/**
 * Reads the live agent configuration from the environment.
 *
 * Returns `undefined` when `COORD_AGENT_CMD` is unset, which keeps the scripted
 * fixture as the default path.
 */
export function readLiveAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): LiveAgentConfig | undefined {
  const command = env["COORD_AGENT_CMD"]?.trim() ?? "";
  if (command.length === 0) {
    return undefined;
  }

  const sandbox = readSandboxConfig(env);
  const adapter = env["COORD_AGENT_ADAPTER"]?.trim();
  if (adapter !== undefined && adapter !== "generic-cli" && adapter !== "codex") {
    throw new Error(`Unsupported COORD_AGENT_ADAPTER value: ${adapter}`);
  }
  const executionSandbox = env["COORD_CODEX_SANDBOX"]?.trim();
  if (
    executionSandbox !== undefined &&
    executionSandbox !== "workspace-write" &&
    executionSandbox !== "danger-full-access"
  ) {
    throw new Error(
      `Unsupported COORD_CODEX_SANDBOX value: ${executionSandbox}`,
    );
  }
  return {
    ...(adapter === undefined ? {} : { adapter }),
    ...(executionSandbox === undefined ? {} : { executionSandbox }),
    command,
    args: parseAgentArgs(env["COORD_AGENT_ARGS"]),
    taskIds: parseLiveTaskIds(env["COORD_AGENT_TASKS"]),
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

export interface BenchmarkFixtureOptions {
  liveAgent?: LiveAgentConfig;
  scenario?: BenchmarkScenario;
}

export async function createBenchmarkFixture(
  rootPath: string,
  name: string,
  options: BenchmarkFixtureOptions = {},
): Promise<BenchmarkFixture> {
  const scenario = options.scenario ?? DEFAULT_SCENARIO;
  const sourcePath = path.join(rootPath, `${name}-source`);
  const canonicalPath = path.join(rootPath, `${name}-canonical.git`);
  const repositories = new RepositoryService();

  await repositories.initializeWorkingRepository(sourcePath);
  for (const [repositoryPath, content] of Object.entries(scenario.seed)) {
    const target = path.join(sourcePath, ...repositoryPath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  // Scenarios whose tasks only add test files still need the directory to exist.
  await mkdir(path.join(sourcePath, "test"), { recursive: true });
  await repositories.commitAll(
    sourcePath,
    `seed ${scenario.name} benchmark repository`,
  );

  const repository = await repositories.importLocalRepository(
    sourcePath,
    canonicalPath,
    name,
  );
  const worktrees = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );
  const sandboxOptions = options.liveAgent?.sandbox;
  const docker =
    sandboxOptions === undefined
      ? undefined
      : new DockerWorkspaceManager(sandboxOptions, worktrees);

  return {
    repository,
    repositories,
    workspaces: docker ?? worktrees,
    scenario,
    rootPath,
    workspaceRoot: path.join(rootPath, `${name}-workspaces`),
    integrationRoot: path.join(rootPath, `${name}-integration`),
    ...(options.liveAgent === undefined
      ? {}
      : { liveAgent: options.liveAgent }),
    ...(docker === undefined ? {} : { sandbox: docker }),
  };
}

/**
 * Builds a fixture whose live tasks run a real agent binary over JSONL stdio.
 *
 * Every other benchmark task keeps its scripted behavior so the coordinated and
 * uncoordinated runs stay comparable.
 */
export async function createLiveBenchmarkFixture(
  rootPath: string,
  name: string,
  config: LiveAgentConfig | undefined = readLiveAgentConfig(),
  scenario?: BenchmarkScenario,
): Promise<BenchmarkFixture> {
  if (config === undefined) {
    throw new Error(
      "A live benchmark run requires COORD_AGENT_CMD to name the agent executable",
    );
  }
  return await createBenchmarkFixture(rootPath, name, {
    liveAgent: config,
    ...(scenario === undefined ? {} : { scenario }),
  });
}

