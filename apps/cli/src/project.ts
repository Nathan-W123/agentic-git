import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { ValidationCommand } from "@coord/shared-types";
import {
  openCoordinationStore,
  type CoordinationStore,
} from "@coord/persistence";
import {
  assertAllowlistEntry,
  type CredentialMountMode,
  type DockerSandboxOptions,
} from "@coord/workspace-manager";

/**
 * A coordinator project: the `.coordinator` directory beside a working tree.
 *
 * It holds the configuration, the durable store, the canonical mirrors of every
 * registered repository, and the scratch space for task and integration
 * worktrees.
 */

export const PROJECT_DIRECTORY = ".coordinator";
export const CONFIG_VERSION = 1;

interface AgentConfigBase {
  args?: string[];
  /** Maximum time for one provider planning request. */
  planningTimeoutMs?: number;
  /** Maximum time for one provider edit request. */
  executionTimeoutMs?: number;
  /**
   * Environment for the agent process.
   *
   * Values are stored in plain text in the config file. This field is suitable
   * only for non-secret values or externally managed short-lived credentials.
   */
  env?: Record<string, string>;
}

export interface GenericCliAgentConfig extends AgentConfigBase {
  adapter?: "generic-cli";
  /** Executable, run with an argument array and never through a shell. */
  command: string;
}

export interface CodexAgentConfig extends AgentConfigBase {
  adapter: "codex";
  /** Defaults to `codex` when omitted. */
  command?: string;
  /** Native Windows sandbox backend. Defaults to the stronger `elevated` mode. */
  windowsSandbox?: "elevated" | "unelevated";
  /**
   * Sandbox the edit phase runs under. Defaults to `workspace-write`, which
   * confines Codex's writes to the task workspace and is the right answer on
   * a developer machine.
   *
   * `workspace-write` needs a platform sandbox helper, and where that helper
   * is missing Codex does not fall back — it refuses filesystem access
   * outright, so a run reports that its "repository access request was
   * rejected" and inspects nothing. A container is already the isolation the
   * sandbox would be providing, so `danger-full-access` is the correct
   * setting there and wrong nearly everywhere else.
   */
  executionSandbox?: "workspace-write" | "danger-full-access";
}

/**
 * Claude Code or Gemini CLI, driven non-interactively by the prompt-cli
 * adapter. Credentials are the CLI's own login state (or API-key variables
 * supplied through `env`), never stored by the platform.
 */
export interface PromptCliAgentConfig extends AgentConfigBase {
  adapter: "claude" | "gemini";
  /** Defaults to `claude` / `gemini` when omitted. */
  command?: string;
  /** Claude reasoning effort. Gemini does not support this setting. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export type AgentConfig =
  | GenericCliAgentConfig
  | CodexAgentConfig
  | PromptCliAgentConfig;

/** Adapters whose `command` defaults to the vendor CLI when omitted. */
const OPTIONAL_COMMAND_ADAPTERS = ["codex", "claude", "gemini"] as const;

export interface SandboxConfig {
  mode: "docker";
  image: string;
  network?: string;
  user?: string;
  /**
   * Hosts a sandboxed vendor CLI may reach, replacing `--network none` with an
   * internal network behind an allowlisting proxy.
   *
   * Present is what makes a `codex`, `claude`, or `gemini` agent runnable
   * inside the Docker sandbox at all: without it those adapters still refuse,
   * because a vendor CLI with no route to its provider cannot do anything and
   * an unrestricted network would be worse than the CLI's own sandbox.
   *
   * Omit to keep the deny-everything default. Cannot be combined with
   * `network`, which expresses the opposite intent.
   */
  egressAllowlist?: string[];
  /**
   * How the vendor CLI's login state reaches the container.
   *
   * `ephemeral-copy` (the default) stages just the credential file into a
   * task-scoped copy the CLI may rewrite when it refreshes its token, leaving
   * the host's own file untouched. `read-only` binds the host file directly,
   * which suits API-key deployments that never rewrite it. `none` mounts
   * nothing, for agents authenticating purely through `env`.
   */
  credentials?: "ephemeral-copy" | "read-only" | "none";
}

export interface ProjectConfig {
  version: number;
  defaultRepository?: string;
  defaultAgent?: string;
  /** Commands every task must pass before its changeset can be promoted. */
  validationCommands: ValidationCommand[];
  agents: Record<string, AgentConfig>;
  sandbox?: SandboxConfig;
  /**
   * How to run this repository's own app, for looking at it.
   *
   * Absent means the repository has no preview, which is most of them — a
   * library has nothing to boot. The command is run in a checkout of canonical
   * with `PORT` and `HOST` in its environment; it is expected to keep running
   * until it is stopped, unlike a validation command.
   */
  previewCommand?: ValidationCommand;
}

export const DEFAULT_CONFIG: ProjectConfig = {
  version: CONFIG_VERSION,
  validationCommands: [
    {
      executable: "git",
      args: ["diff", "--check"],
      label: "patch integrity",
    },
  ],
  /*
   * An empty map here meant a fresh project could not run a task at all.
   * `resolveAgentIdForVendor` (apps/web) looks for an agent whose adapter
   * matches the vendor an @mention resolved to, finds none, and the dispatch
   * fails with "No codex agent is configured on this deployment" — after the
   * person had already connected the Codex CLI and had every reason to think
   * they were done. Connecting a CLI supplies a *credential*; this map is
   * what says the deployment can *run* that vendor, and nothing bridged the
   * two.
   *
   * Both entries omit `command`, so each defaults to the vendor's own name on
   * PATH (see OPTIONAL_COMMAND_ADAPTERS) and costs nothing when the CLI is
   * absent — an agent nobody mentions is never spawned, and one that is
   * mentioned without its CLI installed fails saying the command was not
   * found, which is a far better answer than being told no agent exists.
   *
   * Gemini is left out deliberately: its CLI has no non-interactive login
   * (see SIGN_IN_FLOWS in apps/web/src/providers.ts), so an entry would
   * advertise something this deployment cannot actually sign in to.
   */
  agents: {
    codex: { adapter: "codex" },
    claude: { adapter: "claude" },
  },
};

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/iu;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MIN_AGENT_TIMEOUT_MS = 1_000;
const MAX_AGENT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

function fail(message: string): never {
  throw new Error(`Invalid ${PROJECT_DIRECTORY}/config.json: ${message}`);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function assertAgentTimeout(
  name: string,
  field: "planningTimeoutMs" | "executionTimeoutMs",
  value: number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_AGENT_TIMEOUT_MS ||
    value > MAX_AGENT_TIMEOUT_MS
  ) {
    fail(
      `agent "${name}" needs "${field}" to be an integer between one second and one day`,
    );
  }
  return value;
}

export function assertProjectIdentifier(value: unknown, where: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(
      `${where} must start alphanumeric and contain only letters, digits, ` +
        `dot, dash, or underscore`,
    );
  }
  return value;
}

function assertValidationCommand(value: unknown, where: string): ValidationCommand {
  if (typeof value !== "object" || value === null) {
    fail(`${where} must be an object`);
  }
  const command = value as Partial<ValidationCommand>;
  if (
    typeof command.executable !== "string" ||
    command.executable.trim().length === 0 ||
    command.executable.includes("\0")
  ) {
    fail(`${where} needs a non-empty "executable"`);
  }
  if (
    !Array.isArray(command.args) ||
    !command.args.every(
      (entry) => typeof entry === "string" && !entry.includes("\0"),
    )
  ) {
    fail(`${where} needs "args" to be an array of strings`);
  }
  if (
    typeof command.label !== "string" ||
    command.label.trim().length === 0 ||
    command.label.includes("\0")
  ) {
    fail(`${where} needs a non-empty "label"`);
  }
  return {
    executable: command.executable,
    args: [...command.args],
    label: command.label,
  };
}

function assertAgent(name: string, value: unknown): AgentConfig {
  assertProjectIdentifier(name, `agent name ${JSON.stringify(name)}`);
  if (typeof value !== "object" || value === null) {
    fail(`agent "${name}" must be an object`);
  }
  const agent = value as Partial<AgentConfig>;
  if (
    agent.adapter !== undefined &&
    !["generic-cli", "codex", "claude", "gemini"].includes(agent.adapter)
  ) {
    fail(`agent "${name}" has an unsupported "adapter"`);
  }
  const commandOptional = (OPTIONAL_COMMAND_ADAPTERS as readonly string[])
    .includes(agent.adapter ?? "generic-cli");
  if (
    !commandOptional &&
    (typeof agent.command !== "string" ||
      agent.command.trim().length === 0 ||
      agent.command.includes("\0"))
  ) {
    fail(`agent "${name}" needs a non-empty "command"`);
  }
  if (
    commandOptional &&
    agent.command !== undefined &&
    (typeof agent.command !== "string" ||
      agent.command.trim().length === 0 ||
      agent.command.includes("\0"))
  ) {
    fail(`agent "${name}" needs "command" to be non-empty when provided`);
  }
  if (
    agent.args !== undefined &&
    (!Array.isArray(agent.args) ||
      !agent.args.every(
        (entry) => typeof entry === "string" && !entry.includes("\0"),
      ))
  ) {
    fail(`agent "${name}" needs "args" to be an array of strings`);
  }
  if (agent.env !== undefined) {
    if (typeof agent.env !== "object" || agent.env === null) {
      fail(`agent "${name}" needs "env" to be an object`);
    }
    for (const [key, entry] of Object.entries(agent.env)) {
      if (!ENVIRONMENT_NAME.test(key)) {
        fail(`agent "${name}" has an invalid env name: ${key}`);
      }
      if (typeof entry !== "string" || entry.includes("\0")) {
        fail(`agent "${name}" env value ${key} must be a string`);
      }
    }
  }
  const common = {
    ...(agent.args === undefined ? {} : { args: [...agent.args] }),
    ...(agent.env === undefined ? {} : { env: { ...agent.env } }),
    ...(assertAgentTimeout(
      name,
      "planningTimeoutMs",
      agent.planningTimeoutMs,
    ) === undefined
      ? {}
      : { planningTimeoutMs: agent.planningTimeoutMs }),
    ...(assertAgentTimeout(
      name,
      "executionTimeoutMs",
      agent.executionTimeoutMs,
    ) === undefined
      ? {}
      : { executionTimeoutMs: agent.executionTimeoutMs }),
  };
  if (agent.adapter === "codex") {
    const codexAgent = agent as Partial<CodexAgentConfig>;
    if (
      codexAgent.windowsSandbox !== undefined &&
      codexAgent.windowsSandbox !== "elevated" &&
      codexAgent.windowsSandbox !== "unelevated"
    ) {
      fail(
        `agent "${name}" needs "windowsSandbox" to be "elevated" or "unelevated"`,
      );
    }
    if (
      codexAgent.executionSandbox !== undefined &&
      codexAgent.executionSandbox !== "workspace-write" &&
      codexAgent.executionSandbox !== "danger-full-access"
    ) {
      fail(
        `agent "${name}" needs "executionSandbox" to be "workspace-write" or "danger-full-access"`,
      );
    }
    return {
      adapter: "codex",
      ...(agent.command === undefined ? {} : { command: agent.command }),
      ...(codexAgent.windowsSandbox === undefined
        ? {}
        : { windowsSandbox: codexAgent.windowsSandbox }),
      ...(codexAgent.executionSandbox === undefined
        ? {}
        : { executionSandbox: codexAgent.executionSandbox }),
      ...common,
    };
  }
  if (agent.adapter === "claude" || agent.adapter === "gemini") {
    const promptAgent = agent as Partial<PromptCliAgentConfig>;
    if (
      promptAgent.effort !== undefined &&
      !["low", "medium", "high", "xhigh", "max"].includes(
        promptAgent.effort,
      )
    ) {
      fail(
        `agent "${name}" needs "effort" to be low, medium, high, xhigh, or max`,
      );
    }
    if (agent.adapter === "gemini" && promptAgent.effort !== undefined) {
      fail(`agent "${name}" cannot set Claude-only "effort"`);
    }
    return {
      adapter: agent.adapter,
      ...(agent.command === undefined ? {} : { command: agent.command }),
      ...(promptAgent.effort === undefined
        ? {}
        : { effort: promptAgent.effort }),
      ...common,
    };
  }
  return {
    ...(agent.adapter === undefined ? {} : { adapter: "generic-cli" as const }),
    command: agent.command as string,
    ...common,
  };
}

function assertSandbox(value: unknown): SandboxConfig {
  if (typeof value !== "object" || value === null) {
    fail(`"sandbox" must be an object`);
  }
  const sandbox = value as Partial<SandboxConfig>;
  if (sandbox.mode !== "docker") {
    fail(`"sandbox.mode" must be "docker"`);
  }
  if (
    typeof sandbox.image !== "string" ||
    sandbox.image.trim().length === 0 ||
    /[\s\0]/u.test(sandbox.image) ||
    sandbox.image.startsWith("-")
  ) {
    fail(`"sandbox.image" is required when a sandbox is configured`);
  }
  for (const [field, entry] of [
    ["network", sandbox.network],
    ["user", sandbox.user],
  ] as const) {
    if (
      entry !== undefined &&
      (typeof entry !== "string" ||
        entry.trim().length === 0 ||
        /[\s\0]/u.test(entry) ||
        entry.startsWith("-"))
    ) {
      fail(`"sandbox.${field}" must be a non-empty string`);
    }
  }
  if (sandbox.egressAllowlist !== undefined) {
    if (
      !Array.isArray(sandbox.egressAllowlist) ||
      sandbox.egressAllowlist.length === 0
    ) {
      fail(`"sandbox.egressAllowlist" must be a non-empty array of hostnames`);
    }
    for (const entry of sandbox.egressAllowlist) {
      try {
        assertAllowlistEntry(entry as string);
      } catch (error) {
        fail(
          `"sandbox.egressAllowlist" is invalid: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (sandbox.network !== undefined) {
      fail(
        `"sandbox.network" cannot be combined with "sandbox.egressAllowlist": ` +
          `the allowlist supplies its own internal network`,
      );
    }
  }
  if (
    sandbox.credentials !== undefined &&
    !["ephemeral-copy", "read-only", "none"].includes(sandbox.credentials)
  ) {
    fail(
      `"sandbox.credentials" must be "ephemeral-copy", "read-only", or "none"`,
    );
  }

  return {
    mode: "docker",
    image: sandbox.image,
    ...(sandbox.network === undefined ? {} : { network: sandbox.network }),
    ...(sandbox.user === undefined ? {} : { user: sandbox.user }),
    ...(sandbox.egressAllowlist === undefined
      ? {}
      : { egressAllowlist: [...sandbox.egressAllowlist] }),
    ...(sandbox.credentials === undefined
      ? {}
      : { credentials: sandbox.credentials }),
  };
}

export function assertProjectConfig(value: unknown): ProjectConfig {
  if (typeof value !== "object" || value === null) {
    fail("the file must contain a JSON object");
  }
  const config = value as Partial<ProjectConfig>;
  if (config.version !== CONFIG_VERSION) {
    fail(`"version" must be ${CONFIG_VERSION}`);
  }
  if (!Array.isArray(config.validationCommands)) {
    fail(`"validationCommands" must be an array`);
  }
  if (typeof config.agents !== "object" || config.agents === null) {
    fail(`"agents" must be an object`);
  }

  const agents: Record<string, AgentConfig> = {};
  for (const [name, entry] of Object.entries(config.agents)) {
    agents[name] = assertAgent(name, entry);
  }

  const defaultAgent =
    config.defaultAgent === undefined
      ? undefined
      : assertProjectIdentifier(config.defaultAgent, `"defaultAgent"`);
  if (defaultAgent !== undefined && agents[defaultAgent] === undefined) {
    fail(`"defaultAgent" names an agent that is not configured: ${config.defaultAgent}`);
  }
  const defaultRepository =
    config.defaultRepository === undefined
      ? undefined
      : assertProjectIdentifier(config.defaultRepository, `"defaultRepository"`);

  return {
    version: CONFIG_VERSION,
    validationCommands: config.validationCommands.map((entry, index) =>
      assertValidationCommand(entry, `validationCommands[${index}]`),
    ),
    agents,
    // Validated the same way a validation command is, because it is the same
    // shape and the same mistakes are available: a missing executable, args
    // that are not an array.
    ...(config.previewCommand === undefined
      ? {}
      : {
          previewCommand: assertValidationCommand(
            config.previewCommand,
            "previewCommand",
          ),
        }),
    ...(defaultRepository === undefined
      ? {}
      : { defaultRepository }),
    ...(defaultAgent === undefined
      ? {}
      : { defaultAgent }),
    ...(config.sandbox === undefined
      ? {}
      : { sandbox: assertSandbox(config.sandbox) }),
  };
}

export class CoordinatorProject {
  private constructor(
    public readonly root: string,
    public config: ProjectConfig,
  ) {}

  public get directory(): string {
    return path.join(this.root, PROJECT_DIRECTORY);
  }

  public get configPath(): string {
    return path.join(this.directory, "config.json");
  }

  public get databasePath(): string {
    return path.join(this.directory, "coordination.db");
  }

  public get repositoriesPath(): string {
    return path.join(this.directory, "repositories");
  }

  public get workspaceRoot(): string {
    return path.join(this.directory, "workspaces");
  }

  public get planningRoot(): string {
    return path.join(this.directory, "planning");
  }

  public get integrationRoot(): string {
    return path.join(this.directory, "integration");
  }

  /** Creates the project directory and a starter config if none exists. */
  public static async init(root: string): Promise<CoordinatorProject> {
    // Cloned: DEFAULT_CONFIG is module-level, and a project's config is
    // mutable, so sharing the reference would leak edits across projects.
    const project = new CoordinatorProject(
      path.resolve(root),
      structuredClone(DEFAULT_CONFIG),
    );
    await mkdir(project.directory, { recursive: true });
    await mkdir(project.repositoriesPath, { recursive: true });

    try {
      await readFile(project.configPath, "utf8");
      // An existing config is never overwritten; init is safe to re-run.
      return await CoordinatorProject.open(root);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
      await project.save();
      return project;
    }
  }

  public static async open(root: string): Promise<CoordinatorProject> {
    const resolved = path.resolve(root);
    const configPath = path.join(resolved, PROJECT_DIRECTORY, "config.json");

    let raw: string;
    try {
      raw = await readFile(configPath, "utf8");
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw new Error(`Could not read ${configPath}`, { cause: error });
      }
      throw new Error(
        `No coordinator project at ${resolved}. Run \`coord init\` first.`,
      );
    }

    let parsed: unknown;
    try {
      // Windows editors and PowerShell's UTF-8 mode can prepend a byte order
      // mark, which JSON.parse rejects.
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      throw new Error(
        `Could not parse ${configPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return new CoordinatorProject(resolved, assertProjectConfig(parsed));
  }

  public async save(): Promise<void> {
    const validated = assertProjectConfig(this.config);
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, undefined, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, this.configPath);
      this.config = validated;
    } catch (error) {
      try {
        await rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Project configuration save and temporary-file cleanup both failed",
        );
      }
      throw error;
    }
  }

  public openStore(): CoordinationStore {
    // COORD_DATABASE_URL selects the shared Postgres backend; without it the
    // store stays a SQLite file inside the project directory.
    return openCoordinationStore({
      databaseUrl: process.env["COORD_DATABASE_URL"],
      sqlitePath: this.databasePath,
    });
  }

  /** Docker options derived from config, or undefined when unsandboxed. */
  public sandboxOptions(): DockerSandboxOptions | undefined {
    const sandbox = this.config.sandbox;
    if (sandbox === undefined) {
      return undefined;
    }
    return {
      image: sandbox.image,
      ...(sandbox.network === undefined ? {} : { network: sandbox.network }),
      ...(sandbox.user === undefined ? {} : { user: sandbox.user }),
    };
  }

  /**
   * Egress and credential policy for a vendor CLI in the sandbox.
   *
   * Undefined means no allowlist was configured, which is what keeps the
   * vendor adapters refusing to run containerized: the mechanism exists but
   * has to be asked for, host by host.
   */
  public vendorSandboxPolicy():
    | { allow: readonly string[]; credentials: CredentialMountMode | "none" }
    | undefined {
    const sandbox = this.config.sandbox;
    if (sandbox?.egressAllowlist === undefined) {
      return undefined;
    }
    return {
      allow: sandbox.egressAllowlist,
      credentials: sandbox.credentials ?? "ephemeral-copy",
    };
  }

  public requireAgent(name: string | undefined): [string, AgentConfig] {
    const resolved = name ?? this.config.defaultAgent;
    if (resolved === undefined) {
      throw new Error(
        "No agent specified and no defaultAgent configured. " +
          `Add one to ${PROJECT_DIRECTORY}/config.json or pass --agent.`,
      );
    }
    const agent = this.config.agents[resolved];
    if (agent === undefined) {
      const known = Object.keys(this.config.agents);
      throw new Error(
        `Unknown agent: ${resolved}.` +
          (known.length === 0
            ? ` No agents are configured in ${PROJECT_DIRECTORY}/config.json.`
            : ` Configured agents: ${known.join(", ")}.`),
      );
    }
    return [resolved, agent];
  }
}
