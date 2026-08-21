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
  adapter: "claude" | "gemini" | "cursor" | "copilot" | "kiro";
  /** Defaults to the adapter's vendor CLI when omitted. */
  command?: string;
  /** Claude reasoning effort. Gemini does not support this setting. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export type AgentConfig =
  | GenericCliAgentConfig
  | CodexAgentConfig
  | PromptCliAgentConfig;

/** Adapters whose `command` defaults to the vendor CLI when omitted. */
const OPTIONAL_COMMAND_ADAPTERS = [
  "codex",
  "claude",
  "gemini",
  "cursor",
  "copilot",
  "kiro",
] as const;

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
  previewCommand?: PreviewCommand;
  /**
   * Per-repository overrides, keyed by repository id.
   *
   * One command cannot serve every repository — a Node app and a Python CLI
   * want different things, and a project holds both. This wins over
   * `previewCommand`, which stays as the default for a project whose
   * repositories all start the same way.
   */
  previewCommands?: Record<string, PreviewCommand>;
  /**
   * How to install this repository's dependencies before its app is started.
   *
   * A preview runs in a fresh checkout of canonical, and a fresh checkout has
   * no dependencies in it — they are ignored by git, which is exactly why they
   * are not in the revision. Without this, starting a Node app fails on its
   * first import and reads as the preview being broken.
   *
   * Absent means detection decides: a repository with a package.json and no
   * `node_modules` gets an install, and everything else is started as it is.
   */
  installCommand?: PreviewCommand;
  /** Per-repository overrides, keyed by repository id. */
  installCommands?: Record<string, PreviewCommand>;
}

/** A {@link ValidationCommand} that may also carry the app's configuration. */
export interface PreviewCommand extends ValidationCommand {
  /**
   * Added to the environment the command runs in, after the control plane's
   * own defaults and last, so a repository that needs something specific can
   * always say so.
   */
  env?: Record<string, string>;
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
   * These entries omit `command`, so each defaults to the vendor's own name on
   * PATH (see OPTIONAL_COMMAND_ADAPTERS) and costs nothing when the CLI is
   * absent — an agent nobody mentions is never spawned, and one that is
   * mentioned without its CLI installed fails saying the command was not
   * found, which is a far better answer than being told no agent exists.
   *
   * Each entry corresponds to a provider offered by My Agents, so connecting
   * one in the browser is enough to make its task adapter resolvable.
   */
  agents: {
    codex: { adapter: "codex" },
    claude: { adapter: "claude" },
    gemini: { adapter: "gemini" },
    cursor: { adapter: "cursor" },
    copilot: { adapter: "copilot" },
    kiro: { adapter: "kiro" },
  },
};

/**
 * Adds the default agent for any vendor this config has none for.
 *
 * {@link DEFAULT_CONFIG} lists an agent per vendor the connect screen offers,
 * so a fresh project can run whatever somebody connects. That is only a
 * default at creation, though: a project created before a vendor was added
 * has a stored `agents` map without it, and this map is read verbatim. So
 * every deployment older than a vendor answered a task for it with "No cursor
 * agent is configured on this deployment" — after the person had connected
 * Cursor and had every reason to think they were done. The same gap the
 * defaults were added to close, one level up.
 *
 * Only genuinely missing vendors are filled. An agent the project already has
 * for that adapter wins whatever it is named, and a name already taken is
 * left alone — this adds what is absent and never redefines what is present.
 * Entries omit `command`, so an agent whose CLI is not installed costs
 * nothing until somebody mentions it, and then fails saying the command was
 * not found rather than denying it exists.
 */
function backfillDefaultAgents(agents: Record<string, AgentConfig>): void {
  const configured = new Set(
    Object.values(agents).map((agent) => agent.adapter),
  );
  // Only a config that already runs vendor CLIs gets more of them. A project
  // whose agents are all its own commands has been written deliberately, and
  // filling it with six vendors nobody asked for would be an opinion, not a
  // repair.
  if (!Object.values(agents).some((agent) => agent.adapter !== undefined)) {
    return;
  }
  for (const [name, agent] of Object.entries(DEFAULT_CONFIG.agents)) {
    if (configured.has(agent.adapter) || agents[name] !== undefined) {
      continue;
    }
    agents[name] = structuredClone(agent);
    configured.add(agent.adapter);
  }
}

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

/**
 * A command that starts an app, which is a validation command plus the one
 * thing an app needs and a test run does not: configuration.
 *
 * A validation command is handed a checkout and asked whether it passes. An
 * app is handed a checkout and asked to *be* something — and the difference
 * between a checkout and a running app is almost always a value that is not in
 * the repository, because values that identify one machine's database, project
 * directory or API key are exactly what does not get committed. Detection can
 * find the command; nothing can guess those.
 */
function assertPreviewCommand(value: unknown, where: string): PreviewCommand {
  const command = assertValidationCommand(value, where);
  const env = (value as { env?: unknown }).env;
  if (env === undefined) {
    return command;
  }
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    fail(`${where} needs "env" to be an object of string values`);
  }
  const entries = Object.entries(env as Record<string, unknown>);
  for (const [name, entry] of entries) {
    // A NUL in either half is rejected for the same reason it is in the
    // executable: the value crosses into `execve`, where a NUL truncates
    // rather than erroring, so what runs would not be what was configured.
    if (name.trim().length === 0 || name.includes("\0") || name.includes("=")) {
      fail(`${where} has an invalid environment variable name`);
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      fail(`${where} needs "env.${name}" to be a string`);
    }
  }
  return {
    ...command,
    env: Object.fromEntries(entries as [string, string][]),
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
    ![
      "generic-cli",
      "codex",
      "claude",
      "gemini",
      "cursor",
      "copilot",
      "kiro",
    ].includes(agent.adapter)
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
  if (
    agent.adapter === "claude" ||
    agent.adapter === "gemini" ||
    agent.adapter === "cursor" ||
    agent.adapter === "copilot" ||
    agent.adapter === "kiro"
  ) {
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
    if (agent.adapter !== "claude" && promptAgent.effort !== undefined) {
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
  backfillDefaultAgents(agents);

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
    // that are not an array — plus the optional `env` an app needs and a test
    // run does not.
    ...(config.previewCommand === undefined
      ? {}
      : {
          previewCommand: assertPreviewCommand(
            config.previewCommand,
            "previewCommand",
          ),
        }),
    ...(config.previewCommands === undefined
      ? {}
      : {
          previewCommands: Object.fromEntries(
            Object.entries(
              config.previewCommands as Record<string, unknown>,
            ).map(([repositoryId, entry]) => [
              repositoryId,
              assertPreviewCommand(
                entry,
                `previewCommands["${repositoryId}"]`,
              ),
            ]),
          ),
        }),
    ...(config.installCommand === undefined
      ? {}
      : {
          installCommand: assertPreviewCommand(
            config.installCommand,
            "installCommand",
          ),
        }),
    ...(config.installCommands === undefined
      ? {}
      : {
          installCommands: Object.fromEntries(
            Object.entries(
              config.installCommands as Record<string, unknown>,
            ).map(([repositoryId, entry]) => [
              repositoryId,
              assertPreviewCommand(
                entry,
                `installCommands["${repositoryId}"]`,
              ),
            ]),
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
    // `COORD_SANDBOX_USER` is the deployment-level escape hatch for an image
    // whose entrypoint genuinely needs root — installing packages, writing
    // outside /tmp and the worktree. Without either, the sandbox runs as the
    // user that owns the worktree rather than as root; see
    // `defaultSandboxUser` in the workspace manager.
    const user = sandbox.user ?? process.env["COORD_SANDBOX_USER"];
    return {
      image: sandbox.image,
      ...(sandbox.network === undefined ? {} : { network: sandbox.network }),
      ...(user === undefined || user === "" ? {} : { user }),
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
