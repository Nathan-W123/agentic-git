import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { ChangeSet } from "@coord/shared-types";
import type { ProcessOptions, ProcessOutput } from "@coord/repository-service";

import { DockerWorkspaceManager } from "./docker-workspace-manager.js";
import type {
  ChangeSetMetadata,
  CreateWorkspaceInput,
  SandboxLaunchSpec,
  TaskWorkspace,
  WorkspaceCommandOptions,
  WorkspaceManager,
} from "./index.js";

const isWindows = process.platform === "win32";
const WORKSPACE_PATH = isWindows ? "C:\\coord\\workspace" : "/coord/workspace";
const EXPECTED_MOUNT = isWindows ? "C:/coord/workspace" : "/coord/workspace";

const WORKSPACE: TaskWorkspace = {
  id: "workspace_1",
  taskId: "task_1",
  path: WORKSPACE_PATH,
  rootPath: isWindows ? "C:\\coord" : "/coord",
  repository: { id: "repo", path: "/repo.git", branch: "main" },
  baseVersion: {
    sequence: 1,
    revision: "a".repeat(40),
    branch: "main",
    createdAt: "2026-01-01T00:00:00Z",
  },
  isolation: "docker",
  createdAt: "2026-01-01T00:00:00Z",
};

const AGENT_LAUNCH = {
  command: "/usr/local/bin/agent",
  args: ["--protocol", "jsonl"],
};

class RecordingWorkspaceManager implements WorkspaceManager {
  public readonly created: CreateWorkspaceInput[] = [];
  public readonly destroyed: TaskWorkspace[] = [];
  public readonly collected: TaskWorkspace[] = [];

  public async create(input: CreateWorkspaceInput): Promise<TaskWorkspace> {
    this.created.push(input);
    return { ...WORKSPACE, taskId: input.taskId, isolation: "git-worktree" };
  }

  public async destroy(workspace: TaskWorkspace): Promise<void> {
    this.destroyed.push(workspace);
  }

  public async runInWorkspace(
    _workspace: TaskWorkspace,
    _spec: SandboxLaunchSpec,
    _options?: WorkspaceCommandOptions,
  ): Promise<ProcessOutput> {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  }

  public async collectChangeSet(
    workspace: TaskWorkspace,
    metadata: ChangeSetMetadata,
  ): Promise<ChangeSet> {
    this.collected.push(workspace);
    return {
      id: "changeset_1",
      taskId: workspace.taskId,
      baseVersion: workspace.baseVersion.sequence,
      baseRevision: workspace.baseVersion.revision,
      patches: [],
      commandsRun: [],
      tests: [],
      dependenciesChanged: [],
      symbolsChanged: metadata.symbolsChanged,
      riskAssessment: metadata.riskAssessment,
      agentExplanation: metadata.agentExplanation,
      createdAt: "2026-01-01T00:00:00Z",
    };
  }
}

interface RunnerCall {
  executable: string;
  args: string[];
  options: ProcessOptions | undefined;
}

function createRunner(calls: RunnerCall[], exitCode = 0) {
  return async (
    executable: string,
    args: readonly string[],
    options?: ProcessOptions,
  ): Promise<ProcessOutput> => {
    calls.push({ executable, args: [...args], options });
    return { exitCode, stdout: "", stderr: "", durationMs: 1 };
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("the default container denies the network and drops privileges", () => {
  const manager = new DockerWorkspaceManager({ image: "coord/agent:1" });
  const args = manager.buildRunArgs(AGENT_LAUNCH, WORKSPACE);

  assert.equal(args[0], "run");
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("--interactive"));
  assert.equal(flagValue(args, "--network"), "none");
  assert.equal(flagValue(args, "--cap-drop"), "ALL");
  assert.equal(flagValue(args, "--security-opt"), "no-new-privileges");
  assert.ok(args.includes("--read-only"));
  assert.equal(flagValue(args, "--tmpfs"), "/tmp");
  assert.equal(flagValue(args, "--memory"), "2g");
  assert.equal(flagValue(args, "--cpus"), "2");
  assert.equal(flagValue(args, "--pids-limit"), "512");
});

test("only the task workspace is bind-mounted into the container", () => {
  const manager = new DockerWorkspaceManager({ image: "coord/agent:1" });
  const args = manager.buildRunArgs(AGENT_LAUNCH, WORKSPACE);

  const mounts = args.filter((entry) => entry === "--volume");
  assert.equal(mounts.length, 2);
  assert.equal(flagValue(args, "--volume"), `${EXPECTED_MOUNT}:/workspace`);
  assert.equal(flagValue(args, "--workdir"), "/workspace");
});

test("the worktree git pointer is masked inside the container", () => {
  const manager = new DockerWorkspaceManager({ image: "coord/agent:1" });
  const args = manager.buildRunArgs(AGENT_LAUNCH, WORKSPACE);

  // A detached worktree's .git is a file, so masking it with a tmpfs directory
  // is not portable. A read-only empty file bind preserves the target type.
  const volumeMounts = args.filter(
    (entry, index) => args[index - 1] === "--volume",
  );
  const mask = volumeMounts.find((entry) =>
    entry.endsWith(":/workspace/.git:ro"),
  );
  assert.ok(mask?.includes(".coord-empty-git-mask"));

  const workspaceIndex = args.indexOf(`${EXPECTED_MOUNT}:/workspace`);
  const maskIndex = args.indexOf(mask ?? "");
  assert.ok(workspaceIndex < maskIndex, "the mask must follow the workspace mount");
});

test("git metadata masking can be turned off", () => {
  const manager = new DockerWorkspaceManager({
    image: "coord/agent:1",
    maskGitMetadata: false,
  });
  const args = manager.buildRunArgs(AGENT_LAUNCH, WORKSPACE);
  assert.ok(!args.some((entry) => entry.endsWith(":/workspace/.git:ro")));
});

test("the agent command and arguments straddle the image name", () => {
  const manager = new DockerWorkspaceManager({ image: "coord/agent:1" });
  const args = manager.buildRunArgs(AGENT_LAUNCH, WORKSPACE);

  const entrypoint = args.indexOf("--entrypoint");
  assert.equal(args[entrypoint + 1], "/usr/local/bin/agent");
  assert.equal(args[entrypoint + 2], "coord/agent:1");
  assert.deepEqual(args.slice(entrypoint + 3), ["--protocol", "jsonl"]);
});

test("a launch without a workspace mounts nothing", () => {
  const manager = new DockerWorkspaceManager({ image: "coord/agent:1" });
  const args = manager.buildRunArgs(AGENT_LAUNCH);

  assert.ok(!args.includes("--volume"));
  assert.equal(flagValue(args, "--workdir"), "/tmp");
  assert.equal(flagValue(args, "--network"), "none");
});

test("host environment is never forwarded into the container", () => {
  const manager = new DockerWorkspaceManager({
    image: "coord/agent:1",
    env: { AGENT_TOKEN: "abc123" },
  });
  const wrapped = manager.wrapLaunch(
    { ...AGENT_LAUNCH, env: { SECRET_HOST_TOKEN: "leaked" } },
    WORKSPACE,
  );

  assert.equal(wrapped.command, "docker");
  const passed = wrapped.args
    .filter((entry, index) => wrapped.args[index - 1] === "--env")
    .concat();
  assert.deepEqual(passed, ["AGENT_TOKEN=abc123"]);
  assert.ok(!wrapped.args.some((entry) => entry.includes("leaked")));
  // The Docker client itself still runs on the host and needs its own PATH.
  assert.deepEqual(wrapped.env, { SECRET_HOST_TOKEN: "leaked" });
});

test("resource and network policy are configurable", () => {
  const manager = new DockerWorkspaceManager({
    image: "coord/agent:1",
    docker: "podman",
    network: "coord-allowlist",
    memory: "512m",
    cpus: "0.5",
    pidsLimit: 64,
    user: "1000:1000",
    containerWorkspacePath: "/task",
    readOnlyRootFilesystem: false,
    extraArgs: ["--label", "coord=task"],
  });
  const wrapped = manager.wrapLaunch(AGENT_LAUNCH, WORKSPACE);

  assert.equal(wrapped.command, "podman");
  assert.equal(flagValue(wrapped.args, "--network"), "coord-allowlist");
  assert.equal(flagValue(wrapped.args, "--memory"), "512m");
  assert.equal(flagValue(wrapped.args, "--cpus"), "0.5");
  assert.equal(flagValue(wrapped.args, "--pids-limit"), "64");
  assert.equal(flagValue(wrapped.args, "--user"), "1000:1000");
  assert.equal(flagValue(wrapped.args, "--volume"), `${EXPECTED_MOUNT}:/task`);
  assert.equal(manager.resolveWorkspacePath(WORKSPACE), "/task");
  assert.ok(!wrapped.args.includes("--read-only"));
  assert.equal(flagValue(wrapped.args, "--label"), "coord=task");
});

test("values that could be read as Docker flags are rejected", () => {
  assert.throws(() => new DockerWorkspaceManager({ image: "" }), /must not be empty/u);
  assert.throws(
    () => new DockerWorkspaceManager({ image: "coord/agent:1 --privileged" }),
    /must not contain whitespace/u,
  );
  assert.throws(
    () => new DockerWorkspaceManager({ image: "--privileged" }),
    /must not start with a dash/u,
  );
  assert.throws(
    () => new DockerWorkspaceManager({ image: "a", containerWorkspacePath: "task" }),
    /absolute container path/u,
  );
  assert.throws(
    () => new DockerWorkspaceManager({ image: "a", env: { "BAD-NAME": "x" } }),
    /environment variable name/u,
  );
  assert.throws(
    () => new DockerWorkspaceManager({ image: "a", pidsLimit: 0 }),
    /positive integer/u,
  );
  assert.throws(
    () =>
      new DockerWorkspaceManager({
        image: "a",
        extraArgs: ["--privileged"],
      }),
    /only complete --label/u,
  );
  assert.throws(
    () =>
      new DockerWorkspaceManager({
        image: "a",
        extraArgs: ["--volume", "/:/host"],
      }),
    /only complete --label/u,
  );
});

test("a workspace outside an absolute path cannot be mounted", () => {
  const manager = new DockerWorkspaceManager({ image: "coord/agent:1" });
  assert.throws(
    () => manager.buildRunArgs(AGENT_LAUNCH, { ...WORKSPACE, path: "relative/dir" }),
    /must be absolute/u,
  );
});

test("absolute workspace paths may contain spaces", () => {
  const manager = new DockerWorkspaceManager({ image: "coord/agent:1" });
  const spacedPath = isWindows
    ? "C:\\coord workspace\\task"
    : "/coord workspace/task";
  const args = manager.buildRunArgs(AGENT_LAUNCH, {
    ...WORKSPACE,
    path: spacedPath,
    rootPath: path.dirname(spacedPath),
  });
  assert.ok(
    args.some((entry) =>
      entry.startsWith(`${spacedPath.replaceAll("\\", "/")}:/workspace`),
    ),
  );
});

test("worktree lifecycle is delegated to the host backend", async () => {
  const inner = new RecordingWorkspaceManager();
  const manager = new DockerWorkspaceManager(
    { image: "coord/agent:1", maskGitMetadata: false },
    inner,
  );

  const workspace = await manager.create({
    taskId: "task_1",
    rootPath: WORKSPACE.rootPath,
    repository: WORKSPACE.repository,
    baseVersion: WORKSPACE.baseVersion,
  });
  assert.equal(inner.created.length, 1);
  assert.equal(workspace.isolation, "docker");

  const changeSet = await manager.collectChangeSet(workspace, {
    symbolsChanged: ["increment"],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "done",
  });
  assert.equal(changeSet.taskId, "task_1");
  assert.equal(inner.collected.length, 1);

  await manager.destroy(workspace);
  assert.deepEqual(inner.destroyed, [workspace]);
});

test("runInWorkspace executes the built Docker command", async () => {
  const calls: RunnerCall[] = [];
  const manager = new DockerWorkspaceManager(
    { image: "coord/agent:1" },
    new RecordingWorkspaceManager(),
    createRunner(calls),
  );

  await manager.runInWorkspace(WORKSPACE, {
    command: "/bin/agent",
    args: ["--check"],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.executable, "docker");
  assert.equal(flagValue(calls[0]?.args ?? [], "--volume"), `${EXPECTED_MOUNT}:/workspace`);
  assert.deepEqual(calls[0]?.args.slice(-1), ["--check"]);
});

test("an unreachable Docker daemon fails fast", async () => {
  const calls: RunnerCall[] = [];
  const manager = new DockerWorkspaceManager(
    { image: "coord/agent:1" },
    new RecordingWorkspaceManager(),
    createRunner(calls, 1),
  );

  await assert.rejects(manager.assertAvailable(), /Docker is not available/u);
  assert.deepEqual(calls[0]?.args, ["version", "--format", "{{.Server.Version}}"]);
});
