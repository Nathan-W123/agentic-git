/**
 * Connecting an editor to Kumi, from Kumi, without anybody typing a command.
 *
 * ### Why this writes files instead of running the vendors' own commands
 *
 * Because the commands are not stable and getting them wrong is silent.
 * `claude mcp add` defaults to *local* scope, which binds the server to the
 * directory you happened to run it in — so it works from your home folder and
 * is simply absent in your repository, with nothing to say why. Codex changed
 * its flags between two patch releases. Cursor has no add command at all.
 * Every one of them ends up writing a config file, and the file is the stable
 * thing.
 *
 * ### The rule that matters
 *
 * These files belong to the person, not to Kumi. `~/.claude.json` holds their
 * projects and history; `config.toml` holds their model and sandbox settings.
 * So every write here merges: one key is set, one section is replaced, and
 * everything else comes back byte for byte. A connect that quietly dropped
 * somebody's other MCP servers would be worse than the manual command it
 * replaces.
 *
 * ### Codex, and the one thing that cannot be a file
 *
 * Codex will not read a token out of its config. It reads the *name* of an
 * environment variable and looks that up in its own process environment, so
 * connecting it needs a variable set on the machine as well as a file
 * written. On Windows that is `setx`. Everywhere else it is a line in a shell
 * profile, which is the person's own file in a way a config directory is not,
 * so it is handed back for them to paste rather than written for them.
 *
 * Holds no Electron, like `mcp-consent.mjs` and `tenancy.mjs`: what it
 * decides is a merge, and a merge should be testable without an application.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** The environment variable Codex is told to read its bearer token from. */
export const CODEX_TOKEN_VARIABLE = "KUMI_TOKEN";

/** Editors this can connect, and where each keeps the file it reads. */
export const CONNECTABLE = ["claude", "codex", "cursor"];

function parsed(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    // No file, or one this build cannot read. Treated as empty rather than
    // repaired: the merge below only ever adds a key, so the worst case is a
    // file with one server in it instead of a throw the person cannot act on.
    return {};
  }
}

/**
 * `~/.claude.json`, with one server added under `mcpServers`.
 *
 * User scope on purpose. A server written per-project is the failure this
 * exists to prevent: present in one directory, missing in every other, and
 * silent about it.
 */
export function mergeClaudeConfig(saved, server) {
  const config = saved && typeof saved === "object" ? saved : {};
  const servers =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};
  return {
    ...config,
    mcpServers: {
      ...servers,
      [server.name]: {
        type: "http",
        url: server.url,
        headers: { Authorization: `Bearer ${server.token}` },
      },
    },
  };
}

/** `~/.cursor/mcp.json`. The same shape, in its own file. */
export function mergeCursorConfig(saved, server) {
  const config = saved && typeof saved === "object" ? saved : {};
  const servers =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};
  return {
    ...config,
    mcpServers: {
      ...servers,
      [server.name]: {
        url: server.url,
        headers: { Authorization: `Bearer ${server.token}` },
      },
    },
  };
}

/** TOML strings, quoted the way `tomlString` in the Codex adapter quotes them. */
function tomlString(value) {
  return `"${String(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * `~/.codex/config.toml`, with one `[mcp_servers.<name>]` section rewritten.
 *
 * Edited as text rather than parsed and re-emitted, because re-emitting would
 * mean owning a TOML writer and would reformat a file full of somebody's own
 * settings and comments. The section is found by its own header and replaced
 * up to the next top-level header; absent, it is appended.
 */
export function mergeCodexToml(text, server) {
  const existing = typeof text === "string" ? text : "";
  const section =
    `[mcp_servers.${server.name}]\n` +
    `url = ${tomlString(server.url)}\n` +
    `bearer_token_env_var = ${tomlString(CODEX_TOKEN_VARIABLE)}\n`;
  // The name is constrained rather than escaped: every vendor keys its config
  // by it, and one carrying a bracket or a dot would name a different TOML
  // table than the one written here.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(server.name)) {
    throw new Error(
      `MCP server name ${JSON.stringify(server.name)} must be lower-case ` +
        "letters, digits, dash or underscore, starting with a letter or digit",
    );
  }
  const header = new RegExp(`^\\[mcp_servers\\.${server.name}\\]\\s*$`, "mu");
  const found = header.exec(existing);
  if (found === null) {
    const separator = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${section}`;
  }
  const from = found.index;
  // The next header at the start of a line, which is where this section ends.
  const rest = existing.slice(from + found[0].length);
  const next = /^\[/mu.exec(rest);
  const to = next === null ? existing.length : from + found[0].length + next.index;
  return `${existing.slice(0, from)}${section}${to < existing.length ? "\n" : ""}${existing.slice(to)}`;
}

/**
 * Refuses to point an editor at anything but this deployment.
 *
 * The page supplies the credential and the app supplies the address, and this
 * is the second half of that split. A config written here tells an editor
 * where to send the person's work and the token that authorises it, so a page
 * able to choose that address could quietly redirect both. Loopback is
 * allowed because a developer running Kumi locally is the ordinary case.
 */
export function assertHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${String(value)} is not a URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${url.href} must be https (or http on loopback)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("A server URL must not carry a username or password");
  }
  return url.href;
}

/** Where each editor keeps the file it reads, under one home directory. */
export function configPathFor(vendor, home) {
  if (vendor === "claude") {
    return path.join(home, ".claude.json");
  }
  if (vendor === "cursor") {
    return path.join(home, ".cursor", "mcp.json");
  }
  if (vendor === "codex") {
    return path.join(home, ".codex", "config.toml");
  }
  return undefined;
}

async function read(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Writes one editor's config so it can reach this Kumi.
 *
 * Returns the path written and, for Codex, the environment variable that
 * still has to exist for the token to be found — `undefined` on a platform
 * where this set it. The caller shows whatever comes back; a connect that
 * silently left half the job undone is the shape of every bug in this area.
 */
export async function connectEditor(input) {
  const { vendor, home, server } = input;
  assertHttpsUrl(server.url);
  const file = configPathFor(vendor, home);
  if (file === undefined) {
    throw new Error(`${vendor} cannot be connected automatically`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  if (vendor === "codex") {
    await writeFile(file, mergeCodexToml(await read(file), server), "utf8");
    return { path: file, variable: CODEX_TOKEN_VARIABLE };
  }
  const merged =
    vendor === "claude"
      ? mergeClaudeConfig(parsed(await read(file)), server)
      : mergeCursorConfig(parsed(await read(file)), server);
  // Owner-only: it carries a bearer token for this deployment.
  await writeFile(file, `${JSON.stringify(merged, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { path: file };
}
