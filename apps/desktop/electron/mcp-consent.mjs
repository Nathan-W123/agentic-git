/**
 * The machine owner's say over which MCP servers may run here.
 *
 * A project approves MCP servers for its agents, and the control plane hands
 * them down with every lease. But a server is a program — started on this
 * computer, under this person's account, with whatever secrets the project
 * attached — and the project's approval is somebody else's decision about
 * somebody else's machine. So the worker consults a second list, this
 * machine's own, kept in the project config it reads at start:
 * `mcp: { allow: "all" | [{ name, digest }] }`. Anything not on it is
 * withheld and the room is told so.
 *
 * An entry names the server *and* carries a digest of what it was when the
 * owner agreed — the command and arguments or the URL, and which secrets it
 * is given. Without that, whoever administers the project could redefine
 * `github` after the owner said yes to it, and the new program would start
 * here without anybody asking. The worker computes the digest from what
 * each lease actually carries; this file only writes down the one it was
 * shown and offers the owner the summary that goes with it.
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

function isEntry(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.name === "string" &&
    value.name !== "" &&
    typeof value.digest === "string" &&
    value.digest !== ""
  );
}

/**
 * What the saved config allows, read the way the worker reads it.
 *
 * Anything that is not the string `"all"` or an array of `{ name, digest }`
 * entries is an empty list rather than an error, and a bare name — the
 * shape from before entries carried a digest — is dropped the way the
 * worker drops it. This runs in answer to a message from a child process,
 * with nobody waiting on it; a throw here would be a stack trace in a log
 * and a question never asked.
 */
export function allowedMcp(config) {
  const allow = config?.mcp?.allow;
  if (allow === "all") {
    return "all";
  }
  if (!Array.isArray(allow)) {
    return [];
  }
  return allow
    .filter(isEntry)
    .map((entry) => ({ name: entry.name, digest: entry.digest }));
}

/** Reads the allowlist from the worker root's config. */
export async function readAllowedMcp(root) {
  return allowedMcp(await readConfig(root));
}

/**
 * The offered servers this machine has not yet allowed as they now are,
 * sorted by name and de-duplicated.
 *
 * Empty is the answer that means "nothing to ask", and it is the ordinary
 * one: a machine whose owner already said yes to exactly these, a lease with
 * no servers, a worker that sent something malformed. A server allowed
 * under a different digest is missing — it has changed, and the owner is
 * asked again — and `changed` says so, so the question can say "moved"
 * rather than "new".
 */
export function missingMcpServers(allow, servers) {
  if (allow === "all" || !Array.isArray(servers)) {
    return [];
  }
  const agreed = new Set(allow.map((entry) => `${entry.name}\0${entry.digest}`));
  const agreedNames = new Set(allow.map((entry) => entry.name));
  const seen = new Set();
  const missing = [];
  for (const server of servers) {
    if (!isEntry(server) || agreed.has(`${server.name}\0${server.digest}`)) {
      continue;
    }
    const key = `${server.name}\0${server.digest}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    missing.push({
      name: server.name,
      digest: server.digest,
      summary: typeof server.summary === "string" ? server.summary : server.name,
      changed: agreedNames.has(server.name),
    });
  }
  return missing.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Widens the saved allowlist by these servers.
 *
 * Every other key is kept exactly as it was, for the same reason
 * `ensureProject` keeps them: this file is the worker's, several hands write
 * it, and a write that only knows about its own key must not be able to
 * take another's away. `"all"` stays `"all"` — a person who has already
 * allowed everything is not narrowed to a list by being asked about part of
 * it. A name already present is *replaced*, not joined: saying yes to the
 * new `github` withdraws the yes to the old one, and a list that kept both
 * would let the project swap back and forth between two definitions
 * without ever asking again. The list comes back sorted by name, so two
 * writes that allow the same servers in a different order produce the same
 * file.
 */
export function mergeMcpAllow(config, servers) {
  const saved = config && typeof config === "object" ? config : {};
  const current = allowedMcp(saved);
  let allow;
  if (current === "all") {
    allow = "all";
  } else {
    const byName = new Map(current.map((entry) => [entry.name, entry]));
    for (const server of Array.isArray(servers) ? servers : []) {
      if (isEntry(server)) {
        byName.set(server.name, { name: server.name, digest: server.digest });
      }
    }
    allow = [...byName.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }
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
export async function allowMcpServers(root, servers) {
  const configPath = mcpConfigPath(root);
  await mkdir(path.dirname(configPath), { recursive: true });
  const config = mergeMcpAllow(await readConfig(root), servers);
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
  return config;
}

/**
 * Takes every yes back.
 *
 * The one way to withdraw consent from the app: the list goes to absent —
 * which the worker reads as "run nothing" — and the next lease that offers
 * a server puts the question up again. Only `allow` is touched; a sibling
 * key under `mcp` that some other hand wrote is not this function's to
 * lose. Nothing to forget is not an error.
 */
export async function forgetMcpAllow(root) {
  const configPath = mcpConfigPath(root);
  const saved = (await readConfig(root)) ?? {};
  if (!saved.mcp || typeof saved.mcp !== "object" || Array.isArray(saved.mcp)) {
    return saved;
  }
  const { allow: _allow, ...rest } = saved.mcp;
  const config = { ...saved, mcp: rest };
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
  return config;
}
