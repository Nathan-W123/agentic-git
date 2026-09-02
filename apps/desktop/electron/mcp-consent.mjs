/**
 * The machine owner's say over which MCP servers may run here.
 *
 * A project approves MCP servers for its agents, and the control plane hands
 * them down with every lease. But a server is a program — started on this
 * computer, under this person's account, with whatever secrets the project
 * attached — and the project's approval is somebody else's decision about
 * somebody else's machine. So the worker consults a second list, this
 * machine's own, kept in the project config it reads at start:
 * `mcp: { allow: "all" | [names] }`. Anything not on it is withheld and the
 * room is told so.
 *
 * This file is the desktop app's half of that list: reading it to decide
 * whether there is anything to ask, and writing it once the owner has
 * answered. It holds no Electron so the merge can be tested as a plain
 * function, for the reason `agents.mjs` holds none — the file it writes is
 * the one the worker trusts, and getting it wrong means either running a
 * program nobody agreed to or silently dropping the agents this machine was
 * detected with.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where the worker keeps the config it reads at start. */
export function mcpConfigPath(root) {
  return path.join(root, ".coordinator", "config.json");
}

async function readConfig(root) {
  try {
    const parsed = JSON.parse(await readFile(mcpConfigPath(root), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // No config yet, or one this build cannot read. `ensureProject` writes
    // it fresh on the next start either way; the allowlist starts empty.
  }
  return undefined;
}

/**
 * What the saved config allows, read the way the worker reads it.
 *
 * Anything that is not the string `"all"` or an array of names is an empty
 * list rather than an error. This runs in answer to a message from a child
 * process, with nobody waiting on it; a throw here would be a stack trace in
 * a log and a question never asked.
 */
export function allowedMcp(config) {
  const allow = config?.mcp?.allow;
  if (allow === "all") {
    return "all";
  }
  if (!Array.isArray(allow)) {
    return [];
  }
  return allow.filter((name) => typeof name === "string" && name !== "");
}

/** Reads the allowlist from the worker root's config. */
export async function readAllowedMcp(root) {
  return allowedMcp(await readConfig(root));
}

/**
 * The offered names this machine has not yet allowed, sorted and de-duplicated.
 *
 * Empty is the answer that means "nothing to ask", and it is the ordinary
 * one: a machine whose owner already said yes, a lease with no servers, a
 * worker that sent something malformed.
 */
export function missingMcpNames(allow, names) {
  if (allow === "all" || !Array.isArray(names)) {
    return [];
  }
  const already = new Set(allow);
  const wanted = names.filter(
    (name) => typeof name === "string" && name !== "" && !already.has(name),
  );
  return [...new Set(wanted)].sort();
}

/**
 * Widens the saved allowlist by these names.
 *
 * Every other key is kept exactly as it was, for the same reason
 * `ensureProject` keeps them: this file is the worker's, several hands write
 * it, and a write that only knows about its own key must not be able to
 * take another's away. `"all"` stays `"all"` — a person who has already
 * allowed everything is not narrowed to a list by being asked about part of
 * it — and a list comes back de-duplicated and sorted, so two writes that
 * allow the same servers in a different order produce the same file.
 */
export function mergeMcpAllow(config, names) {
  const saved = config && typeof config === "object" ? config : {};
  const current = allowedMcp(saved);
  const allow =
    current === "all"
      ? "all"
      : [...new Set([...current, ...missingMcpNames(current, names)])].sort();
  const mcp =
    saved.mcp && typeof saved.mcp === "object" && !Array.isArray(saved.mcp)
      ? saved.mcp
      : {};
  return { ...saved, mcp: { ...mcp, allow } };
}

/**
 * Records the owner's yes, where the worker will read it on its next start.
 *
 * Written the way `ensureProject` writes it — pretty, with a trailing newline
 * — so the two never take turns reformatting the same file.
 */
export async function allowMcpServers(root, names) {
  const configPath = mcpConfigPath(root);
  await mkdir(path.dirname(configPath), { recursive: true });
  const config = mergeMcpAllow(await readConfig(root), names);
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
  return config;
}
