import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  runProcess,
  type ProcessOptions,
  type ProcessOutput,
} from "@coord/repository-service";
import type { ChangeSet, FilePatchStatus } from "@coord/shared-types";

import type { EgressBinding } from "./egress-gateway.js";
import type { CredentialMount } from "./vendor-credentials.js";
import {
  GitWorktreeWorkspaceManager,
  type ChangeSetMetadata,
  type CreateWorkspaceInput,
  type SandboxLaunchSpec,
  type TaskWorkspace,
  type WorkspaceCommandOptions,
  type WorkspaceManager,
  type WorkspaceSandbox,
} from "./index.js";

/**
 * Docker-backed workspace backend.
 *
 * Git worktree creation, patch collection, and canonical promotion stay on the
 * host. Agent and validation commands run in a container that bind-mounts only
 * the task worktree, denies the network by default, and applies resource
 * limits.
 */
export interface DockerSandboxOptions {
  image: string;
  docker?: string;
  containerWorkspacePath?: string;
  network?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  user?: string;
  readOnlyRootFilesystem?: boolean;
  dropCapabilities?: boolean;
  noNewPrivileges?: boolean;
  tmpfs?: readonly string[];
  /** Explicit environment for the container. Host variables are not inherited. */
  env?: Readonly<Record<string, string>>;
  /**
   * Additional Docker metadata. Only `--label <value>` pairs are accepted;
   * arbitrary run flags would let a caller bypass the confinement policy.
   */
  extraArgs?: readonly string[];
  /**
   * Masks the worktree's `.git` pointer inside the container. Defaults to true.
   */
  maskGitMetadata?: boolean;
  /**
   * Per-task egress allowlist, from a started {@link EgressGateway}.
   *
   * Replaces `network` with the gateway's internal network — which has no
   * route off the host — and points the container's proxy variables at the
   * allowlisting sidecar. Setting both this and `network` is refused rather
   * than silently resolved, since the two express opposite intents.
   */
  egress?: EgressBinding;
  /**
   * Individual credential files to bind into the container.
   *
   * Built by `resolveVendorCredentials`, which names one or two files per
   * vendor rather than exposing a home directory.
   */
  credentialMounts?: readonly CredentialMount[];
}

export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: ProcessOptions,
) => Promise<ProcessOutput>;

interface ResolvedOptions {
  image: string;
  docker: string;
  containerWorkspacePath: string;
  network: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
  user: string | undefined;
  readOnlyRootFilesystem: boolean;
  dropCapabilities: boolean;
  noNewPrivileges: boolean;
  tmpfs: readonly string[];
  env: Readonly<Record<string, string>>;
  extraArgs: readonly string[];
  maskGitMetadata: boolean;
  egress: EgressBinding | undefined;
  credentialMounts: readonly CredentialMount[];
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function assertDockerToken(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`Docker ${label} must not be empty`);
  }
  if (/[\s\0]/u.test(value)) {
    throw new Error(`Docker ${label} must not contain whitespace: ${value}`);
  }
  if (value.startsWith("-")) {
    throw new Error(`Docker ${label} must not start with a dash: ${value}`);
  }
  return value;
}

function assertContainerPath(value: string, label: string): string {
  assertDockerToken(value, label);
  if (!value.startsWith("/")) {
    throw new Error(`Docker ${label} must be an absolute container path: ${value}`);
  }
  return value;
}

function toMountSource(workspacePath: string): string {
  if (!path.isAbsolute(workspacePath)) {
    throw new Error(
      `Workspace path must be absolute to be mounted: ${workspacePath}`,
    );
  }
  const normalized = path.resolve(workspacePath).replaceAll("\\", "/");
  if (normalized.includes("\0")) {
    throw new Error(
      `Workspace path must not contain NUL bytes: ${workspacePath}`,
    );
  }
  return normalized;
}

function containerWorkingDirectory(
  spec: SandboxLaunchSpec,
  workspace: TaskWorkspace | undefined,
  options: ResolvedOptions,
): string {
  if (workspace === undefined) {
    if (spec.cwd !== undefined) {
      throw new Error(
        "A host working directory cannot be mapped without a workspace",
      );
    }
    return options.tmpfs[0] ?? "/";
  }
  if (spec.cwd === undefined) {
    return options.containerWorkspacePath;
  }
  if (spec.cwd.includes("\0")) {
    throw new Error("Sandbox working directory must not contain NUL bytes");
  }

  const root = path.resolve(workspace.path);
  const requested = path.isAbsolute(spec.cwd)
    ? path.resolve(spec.cwd)
    : path.resolve(root, spec.cwd);
  const relative = path.relative(root, requested);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Sandbox working directory escapes the workspace: ${spec.cwd}`,
    );
  }
  if (relative.length === 0) {
    return options.containerWorkspacePath;
  }
  return path.posix.join(
    options.containerWorkspacePath,
    relative.replaceAll(path.sep, "/"),
  );
}

function resolveExtraArgs(values: readonly string[]): string[] {
  const resolved: string[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag !== "--label" || value === undefined) {
      throw new Error(
        "Docker extraArgs accepts only complete --label <value> pairs",
      );
    }
    resolved.push(flag, assertDockerToken(value, "label"));
  }
  return resolved;
}

/**
 * Environment a container needs to route through the egress proxy.
 *
 * Both cases of each variable are set because the convention is not
 * standardised: Node's ecosystem generally reads the upper-case forms while
 * curl and much of the Unix tooling read the lower-case ones, and a CLI that
 * reads the case this omitted would bypass the proxy — reaching nothing,
 * since the network itself is internal, but reaching it confusingly.
 */
function proxyEnvironment(egress: EgressBinding): Record<string, string> {
  return {
    HTTP_PROXY: egress.proxyUrl,
    HTTPS_PROXY: egress.proxyUrl,
    http_proxy: egress.proxyUrl,
    https_proxy: egress.proxyUrl,
    NO_PROXY: egress.noProxy,
    no_proxy: egress.noProxy,
  };
}

function resolveCredentialMounts(
  mounts: readonly CredentialMount[],
): readonly CredentialMount[] {
  const seen = new Set<string>();
  for (const mount of mounts) {
    assertContainerPath(mount.containerPath, "credential mount target");
    if (!path.isAbsolute(mount.hostPath)) {
      throw new Error(
        `Credential mount source must be absolute: ${mount.hostPath}`,
      );
    }
    if (seen.has(mount.containerPath)) {
      throw new Error(
        `Two credential mounts target ${mount.containerPath}`,
      );
    }
    seen.add(mount.containerPath);
  }
  return mounts;
}

function resolveOptions(options: DockerSandboxOptions): ResolvedOptions {
  if (options.egress !== undefined && options.network !== undefined) {
    throw new Error(
      "A sandbox cannot set both `network` and `egress`: the egress gateway " +
        "supplies its own internal network, and an explicit network would " +
        "either duplicate it or silently widen it",
    );
  }

  const resolved: ResolvedOptions = {
    image: assertDockerToken(options.image, "image"),
    docker: options.docker ?? "docker",
    containerWorkspacePath: assertContainerPath(
      options.containerWorkspacePath ?? "/workspace",
      "workspace mount point",
    ),
    network: assertDockerToken(
      options.egress?.network ?? options.network ?? "none",
      "network",
    ),
    memory: assertDockerToken(options.memory ?? "2g", "memory limit"),
    cpus: assertDockerToken(options.cpus ?? "2", "cpu limit"),
    pidsLimit: options.pidsLimit ?? 512,
    user:
      options.user === undefined
        ? undefined
        : assertDockerToken(options.user, "user"),
    readOnlyRootFilesystem: options.readOnlyRootFilesystem ?? true,
    dropCapabilities: options.dropCapabilities ?? true,
    noNewPrivileges: options.noNewPrivileges ?? true,
    tmpfs: options.tmpfs ?? ["/tmp"],
    // Proxy variables are merged under the caller's env, so an explicitly
    // configured proxy still wins over the gateway's default.
    env: {
      ...(options.egress === undefined ? {} : proxyEnvironment(options.egress)),
      ...(options.env ?? {}),
    },
    extraArgs: resolveExtraArgs(options.extraArgs ?? []),
    maskGitMetadata: options.maskGitMetadata ?? true,
    egress: options.egress,
    credentialMounts: resolveCredentialMounts(options.credentialMounts ?? []),
  };

  if (!Number.isInteger(resolved.pidsLimit) || resolved.pidsLimit <= 0) {
    throw new Error("Docker pids limit must be a positive integer");
  }
  for (const mount of resolved.tmpfs) {
    assertContainerPath(mount, "tmpfs mount");
  }
  for (const [name, value] of Object.entries(resolved.env)) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new Error(`Invalid container environment variable name: ${name}`);
    }
    if (/[\r\n\0]/u.test(value)) {
      throw new Error(`Container environment value for ${name} is not a single line`);
    }
  }

  return resolved;
}

export class DockerWorkspaceManager
  implements WorkspaceManager, WorkspaceSandbox
{
  private readonly options: ResolvedOptions;

  public constructor(
    options: DockerSandboxOptions,
    private readonly worktrees: WorkspaceManager =
      new GitWorktreeWorkspaceManager(),
    private readonly runner: ProcessRunner = runProcess,
  ) {
    this.options = resolveOptions(options);
  }

  public async create(input: CreateWorkspaceInput): Promise<TaskWorkspace> {
    const workspace = await this.worktrees.create(input);
    try {
      toMountSource(workspace.path);
      if (this.options.maskGitMetadata) {
        await writeFile(this.gitMaskPath(workspace), "", {
          encoding: "utf8",
          flag: "w",
        });
      }
      return { ...workspace, isolation: "docker" };
    } catch (error) {
      try {
        await this.worktrees.destroy(workspace);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Docker workspace setup and rollback both failed",
        );
      }
      throw error;
    }
  }

  public async destroy(workspace: TaskWorkspace): Promise<void> {
    await this.worktrees.destroy(workspace);
  }

  public async collectChangeSet(
    workspace: TaskWorkspace,
    metadata: ChangeSetMetadata,
  ): Promise<ChangeSet> {
    return await this.worktrees.collectChangeSet(workspace, metadata);
  }

  /**
   * Delegated like the changeset it precedes: the container mounts the very
   * worktree the wrapped manager reads, so the host sees the agent's edits
   * without entering the sandbox to ask.
   */
  public async listWorkingChanges(
    workspace: TaskWorkspace,
  ): Promise<Array<{ path: string; status: FilePatchStatus }>> {
    return (await this.worktrees.listWorkingChanges?.(workspace)) ?? [];
  }

  public resolveWorkspacePath(_workspace: TaskWorkspace): string {
    return this.options.containerWorkspacePath;
  }

  public wrapLaunch(
    spec: SandboxLaunchSpec,
    workspace?: TaskWorkspace,
  ): SandboxLaunchSpec {
    return {
      command: this.options.docker,
      args: this.buildRunArgs(spec, workspace),
      // The Docker client runs on the host and may need PATH or DOCKER_HOST.
      ...(spec.env === undefined ? {} : { env: spec.env }),
    };
  }

  public buildRunArgs(
    spec: SandboxLaunchSpec,
    workspace?: TaskWorkspace,
  ): string[] {
    const options = this.options;
    const workingDirectory = containerWorkingDirectory(
      spec,
      workspace,
      options,
    );

    return [
      "run",
      "--rm",
      "--interactive",
      "--network",
      options.network,
      "--memory",
      options.memory,
      "--cpus",
      options.cpus,
      "--pids-limit",
      String(options.pidsLimit),
      ...(options.dropCapabilities ? ["--cap-drop", "ALL"] : []),
      ...(options.noNewPrivileges
        ? ["--security-opt", "no-new-privileges"]
        : []),
      ...(options.readOnlyRootFilesystem ? ["--read-only"] : []),
      ...options.tmpfs.flatMap((mount) => ["--tmpfs", mount]),
      ...(options.user === undefined ? [] : ["--user", options.user]),
      ...(workspace === undefined
        ? []
        : [
            "--volume",
            `${toMountSource(workspace.path)}:${options.containerWorkspacePath}`,
            ...(options.maskGitMetadata
              ? [
                  "--volume",
                  `${toMountSource(this.gitMaskPath(workspace))}:` +
                    `${options.containerWorkspacePath}/.git:ro`,
                ]
              : []),
          ]),
      // Docker orders mounts by destination depth, so the tmpfs home is in
      // place before a credential lands beneath it.
      ...options.credentialMounts.flatMap((mount) => [
        "--volume",
        `${toMountSource(mount.hostPath)}:${mount.containerPath}` +
          `${mount.readOnly ? ":ro" : ""}`,
      ]),
      "--workdir",
      workingDirectory,
      ...Object.entries(options.env).flatMap(([name, value]) => [
        "--env",
        `${name}=${value}`,
      ]),
      ...options.extraArgs,
      "--entrypoint",
      assertDockerToken(spec.command, "agent command"),
      options.image,
      ...spec.args,
    ];
  }

  public async runInWorkspace(
    workspace: TaskWorkspace,
    spec: SandboxLaunchSpec,
    options: WorkspaceCommandOptions = {},
  ): Promise<ProcessOutput> {
    const launch = this.wrapLaunch(spec, workspace);
    return await this.runner(launch.command, launch.args, {
      ...(launch.env === undefined ? {} : { env: launch.env }),
      ...options,
    });
  }

  public async assertAvailable(): Promise<void> {
    const result = await this.runner(
      this.options.docker,
      ["version", "--format", "{{.Server.Version}}"],
      { timeoutMs: 10_000, maxOutputBytes: 65_536 },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Docker is not available: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  /**
   * Location of the empty file bind-mounted over the worktree's `.git`.
   *
   * Derived from the workspace directory's parent rather than from
   * `rootPath`. Both name the same directory for a workspace this manager
   * created, but a workspace can also be reconstructed from a coordinator
   * context, which carries only the workspace path — and an adapter doing so
   * has no parent to report, so it sets `rootPath` to the workspace itself.
   *
   * That mattered more than it looks. Reading `rootPath` then pointed the
   * mask inside the worktree, where no such file exists, and Docker creates a
   * missing bind source as a directory. Mounting a directory onto `.git`,
   * which is a file in a worktree, fails the mount and the container exits
   * before the agent runs.
   */
  private gitMaskPath(workspace: TaskWorkspace): string {
    return path.join(
      path.dirname(path.resolve(workspace.path)),
      ".coord-empty-git-mask",
    );
  }

}
