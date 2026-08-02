import { copyFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Minimal-scope credential mounts for the vendor CLIs.
 *
 * The sandbox gives a container no home directory and no host environment, so
 * a CLI authenticated by a subscription login has nothing to authenticate
 * with. The blunt fix — mounting the user's home directory — hands an agent
 * far more than its credentials: `~/.claude.json` carries project history and
 * MCP server configuration, and `~/.codex` carries session, goal, and memory
 * databases. None of that is needed to make an API call.
 *
 * So each vendor names the specific files it authenticates with, and nothing
 * else is mounted. What the container gets is a tmpfs home containing one or
 * two files.
 *
 * ### Why the default is a copy rather than a read-only bind
 *
 * All three vendors store OAuth material that the CLI refreshes in place: the
 * files carry `last_refresh` and `expiry_date` fields and are rewritten when
 * the access token ages out. A read-only bind therefore works only until the
 * first refresh, and then fails in a way that looks like an auth bug rather
 * than a mount policy.
 *
 * `ephemeral-copy` stages the file into a task-scoped directory and mounts
 * that read-write. The CLI refreshes normally, the refreshed token dies with
 * the task, and the host's own credential file is never opened for writing by
 * anything in the container. `read-only` remains available for API-key
 * deployments, where nothing is ever rewritten.
 *
 * Neither mode narrows what the *agent* can do with a credential it has been
 * given: a task that can call the vendor's API can also read the token it is
 * calling with. Scoping the mount bounds which secrets are exposed, not what
 * the agent may do with the one it needs.
 */
export type VendorCliKind = "codex" | "claude" | "gemini";

export type CredentialMountMode = "ephemeral-copy" | "read-only";

export interface CredentialMount {
  /** Absolute host path to bind. */
  hostPath: string;
  /** Absolute path inside the container. */
  containerPath: string;
  readOnly: boolean;
}

export interface VendorCredentialPlan {
  mounts: readonly CredentialMount[];
  /** Environment the CLI needs to find the staged home. */
  env: Readonly<Record<string, string>>;
  /** Container paths that must be writable for the mounts to land. */
  tmpfs: readonly string[];
  /** Optional files that were not present on the host. */
  missing: readonly string[];
}

interface VendorFile {
  /** Path relative to the host home directory. */
  relativePath: string;
  /** Absent means the CLI cannot authenticate at all. */
  required: boolean;
}

interface VendorProfile {
  files: readonly VendorFile[];
  /** Environment pointing the CLI at the staged home, keyed by container home. */
  env: (containerHome: string) => Record<string, string>;
}

const PROFILES: Record<VendorCliKind, VendorProfile> = {
  codex: {
    // Only auth.json. The adapter already passes --ignore-user-config, so
    // config.toml is not consulted, and the sqlite databases beside it are
    // session state this task has no business reading.
    files: [{ relativePath: ".codex/auth.json", required: true }],
    env: (home) => ({ CODEX_HOME: path.posix.join(home, ".codex") }),
  },
  claude: {
    // Deliberately not ~/.claude.json: that is project history and MCP
    // configuration, not credentials.
    files: [{ relativePath: ".claude/.credentials.json", required: true }],
    env: (home) => ({ CLAUDE_CONFIG_DIR: path.posix.join(home, ".claude") }),
  },
  gemini: {
    // google_accounts and projects carry the account and GCP project the
    // token is scoped to; without them the CLI re-runs account selection,
    // which cannot succeed non-interactively.
    files: [
      { relativePath: ".gemini/oauth_creds.json", required: true },
      { relativePath: ".gemini/google_accounts.json", required: false },
      { relativePath: ".gemini/projects.json", required: false },
      { relativePath: ".gemini/installation_id", required: false },
    ],
    env: () => ({}),
  },
};

export interface ResolveVendorCredentialsOptions {
  /** Host home directory. Defaults to the current user's. */
  home?: string;
  /** Home directory as the container sees it. Defaults to `/home/agent`. */
  containerHome?: string;
  mode?: CredentialMountMode;
  /**
   * Directory to stage copies in. Required for `ephemeral-copy`; the caller
   * owns its lifetime and must remove it when the task ends.
   */
  stagingDir?: string;
}

/** Environment variable names a vendor credential plan may set. */
export function credentialEnvNames(kind: VendorCliKind): string[] {
  return ["HOME", ...Object.keys(PROFILES[kind].env("/home/agent"))];
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Builds the mounts and environment one vendor CLI needs inside the sandbox.
 *
 * Throws when a required credential is absent, because the alternative is a
 * container that starts, fails to authenticate, and reports an empty changeset
 * as a completed task — the exact failure the adapters already work to make
 * loud.
 */
export async function resolveVendorCredentials(
  kind: VendorCliKind,
  options: ResolveVendorCredentialsOptions = {},
): Promise<VendorCredentialPlan> {
  const profile = PROFILES[kind];
  const home = options.home ?? os.homedir();
  const containerHome = options.containerHome ?? "/home/agent";
  const mode = options.mode ?? "ephemeral-copy";

  if (!containerHome.startsWith("/")) {
    throw new Error(
      `The container home must be an absolute path: ${containerHome}`,
    );
  }
  if (mode === "ephemeral-copy" && options.stagingDir === undefined) {
    throw new Error(
      "ephemeral-copy credential mounts need a stagingDir to copy into",
    );
  }

  const mounts: CredentialMount[] = [];
  const missing: string[] = [];

  for (const file of profile.files) {
    const hostPath = path.join(home, file.relativePath);
    if (!(await isFile(hostPath))) {
      if (file.required) {
        throw new Error(
          `The ${kind} CLI credential ${file.relativePath} was not found at ` +
            `${hostPath}. Log in with the vendor CLI on this host, or supply ` +
            `an API key through the agent's env block instead.`,
        );
      }
      missing.push(file.relativePath);
      continue;
    }

    const containerPath = path.posix.join(
      containerHome,
      ...file.relativePath.split("/"),
    );

    if (mode === "read-only") {
      mounts.push({ hostPath, containerPath, readOnly: true });
      continue;
    }

    const staged = path.join(
      options.stagingDir as string,
      ...file.relativePath.split("/"),
    );
    await mkdir(path.dirname(staged), { recursive: true });
    await copyFile(hostPath, staged);
    mounts.push({ hostPath: staged, containerPath, readOnly: false });
  }

  return {
    mounts,
    env: { HOME: containerHome, ...profile.env(containerHome) },
    // The home itself must be a writable mount or the per-file binds have
    // nothing to land on under a read-only root filesystem.
    tmpfs: [containerHome],
    missing,
  };
}
