import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { allowedMcpServers, type ProjectConfig } from "@coord/cli/project";
import type { ResolvedMcpServer } from "@coord/shared-types";

/**
 * What one run's MCP servers became, vendor by vendor.
 *
 * At most one of the vendor halves is set, and only when something was
 * allowed: Claude's CLI takes a file, Codex's takes overrides on argv and
 * builds them itself from the servers, so the two are carried differently and
 * the adapter that runs the agent is the one that knows which. `withheld`
 * and `staged` are for the room — a run that quietly lacks its tools is the
 * failure this whole path is designed out of.
 */
export interface StagedMcpServers {
  claude?: { configPath: string };
  codex?: { servers: ResolvedMcpServer[] };
  /** Offered by the lease and refused by this machine's allowlist. */
  withheld: string[];
  /** Allowed and made available to the agent. */
  staged: string[];
}

/**
 * The scratch directory a run's MCP config lives in.
 *
 * Beside the workspace, never inside it: `collectChangeSet` stages every
 * untracked file in the workspace, so a config written there — secrets and
 * all — would be committed to the repository the task was for. The scratch
 * root is the run's own and is removed with it when the run ends.
 */
const MCP_DIRECTORY = "mcp";

/**
 * Turns the servers a lease offers into whatever the agent's vendor can load,
 * after the machine owner's allowlist has had its say.
 *
 * The allowlist is applied first and unconditionally: the control plane
 * decides what a repository offers, this machine decides what it runs, and an
 * offer this machine has not accepted goes no further than the `withheld`
 * list. Nothing is written for a run with nothing allowed — not even an empty
 * config — so a project that has never enabled MCP leaves no trace of it on
 * disk.
 *
 * Where something is allowed, a vendor that cannot load it is an error here
 * rather than an agent started without its tools. Cursor is the case in
 * point: it reads only `<workspace>/.cursor/mcp.json`, and writing a file
 * there is writing it into the changeset. A run that fails at staging says
 * why; a run that succeeds without its servers reports their absence as the
 * task's own confusion.
 */
export async function stageMcpServers(input: {
  scratch: string;
  vendor: string;
  servers: readonly ResolvedMcpServer[];
  allow: ProjectConfig["mcp"];
}): Promise<StagedMcpServers> {
  const { allowed, withheld } = allowedMcpServers(
    { mcp: input.allow } as ProjectConfig,
    input.servers,
  );
  if (allowed.length === 0) {
    return { withheld, staged: [] };
  }
  const staged = allowed.map((server) => server.name);
  if (input.vendor === "codex") {
    return { codex: { servers: allowed }, withheld, staged };
  }
  if (input.vendor === "claude") {
    const directory = path.join(input.scratch, MCP_DIRECTORY);
    const configPath = path.join(directory, "claude.json");
    // Owner-only at both levels. The file carries opened secrets, and the
    // process that reads it runs as the same user, so nothing wider is ever
    // needed; the mode is set at creation because the file is new — the
    // scratch root is made fresh for every lease.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify(claudeMcpConfig(allowed), undefined, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { claude: { configPath }, withheld, staged };
  }
  throw new Error(
    `${input.vendor} cannot be given managed MCP servers yet: this project ` +
      `offers ${staged.join(", ")} and this machine allows them, but the ` +
      `${input.vendor} CLI has no way to load a server config from outside ` +
      "the workspace. Run the task with a claude or codex agent, or withhold " +
      "the servers on this machine.",
  );
}

/**
 * The shape `claude --mcp-config <file>` reads.
 *
 * Secrets go in the file — `env` for a child process, `headers` for a URL —
 * and nowhere else: the file is owner-only in a directory that is removed
 * with the run, whereas argv is readable by every process the owner has.
 */
function claudeMcpConfig(
  servers: readonly ResolvedMcpServer[],
): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.transport === "http") {
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
      };
      continue;
    }
    mcpServers[server.name] = {
      command: server.command,
      args: [...(server.args ?? [])],
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
    };
  }
  return { mcpServers };
}
