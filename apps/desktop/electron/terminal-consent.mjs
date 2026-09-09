/**
 * Whether this machine will open a terminal, decided by installing the app.
 *
 * The MCP allowlist next door asks before it runs anything, and should: an
 * MCP server is a *program somebody else defined*, handed down by a project
 * an owner may not administer, and its definition can change under the person
 * who agreed to it. None of that is true here. A terminal is this machine's
 * own shell, opened by its own owner, from an account already signed in on
 * this computer — the control plane will not open one on anybody else's
 * machine, whatever their role in the project. Asking a second time is asking
 * somebody to agree to something they did by installing the app.
 *
 * So the first start writes the consent, and the menu is where it is taken
 * back. Three states, not two, and the difference is the whole reason this
 * file is careful:
 *
 * - **Absent** — never decided. The worker refuses, and this opts in.
 * - **`"all"`** — allowed.
 * - **`[]`** — decided *against*. Left alone, or the next start would quietly
 *   turn it back on and the menu's off switch would last until a restart.
 *
 * No Electron here, for the reason `mcp-consent.mjs` holds none: the file it
 * writes is the one the worker trusts, and getting it wrong means either a
 * shell nobody agreed to or a switch that does not stay off.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where the worker keeps the config it reads. */
export function terminalConfigPath(root) {
  return path.join(root, ".coordinator", "config.json");
}

async function readConfig(root) {
  try {
    const parsed = JSON.parse(await readFile(terminalConfigPath(root), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // No config yet, or one this build cannot read. `ensureProject` writes it
    // fresh on the next start either way.
  }
  return undefined;
}

/**
 * What the saved config allows, read the way the worker reads it.
 *
 * `undefined` for anything that is not `"all"` or an array — including a
 * malformed value — because "I cannot tell what this says" and "nobody has
 * said" lead to the same place: refuse, and ask.
 */
export function terminalConsent(config) {
  const allow = config?.terminal?.allow;
  if (allow === "all") {
    return "all";
  }
  if (Array.isArray(allow)) {
    return allow.filter((entry) => typeof entry === "string" && entry !== "");
  }
  return undefined;
}

/** Reads it from the worker root's config. */
export async function readTerminalConsent(root) {
  return terminalConsent(await readConfig(root));
}

/**
 * The config with this answer written into it.
 *
 * Every other key is kept exactly as it was, and so is every other key under
 * `terminal` — `cwd` pins where sessions start, and a switch that silently
 * dropped it would move somebody's terminals without saying so. Pure, so the
 * merge is testable without a disk.
 */
export function withTerminalConsent(config, allowed) {
  const saved = config && typeof config === "object" && !Array.isArray(config)
    ? config
    : {};
  const terminal =
    saved.terminal && typeof saved.terminal === "object" && !Array.isArray(saved.terminal)
      ? saved.terminal
      : {};
  return { ...saved, terminal: { ...terminal, allow: allowed ? "all" : [] } };
}

async function write(root, config) {
  const configPath = terminalConfigPath(root);
  await mkdir(path.dirname(configPath), { recursive: true });
  // Written the way `ensureProject` and the MCP list write it — pretty, with
  // a trailing newline — so the three never take turns reformatting one file.
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
  return config;
}

/**
 * Opts this machine in, unless its owner has already said otherwise.
 *
 * Called at every worker start and answers what it did, because "already
 * allowed" and "just allowed" and "the owner turned this off" are three
 * different things to a log somebody is reading to find out why a terminal
 * did or did not open.
 */
export async function ensureTerminalConsent(root) {
  const saved = await readConfig(root);
  const current = terminalConsent(saved);
  if (current !== undefined) {
    return { wrote: false, allowed: current === "all" || current.length > 0 };
  }
  await write(root, withTerminalConsent(saved, true));
  return { wrote: true, allowed: true };
}

/**
 * The menu's switch.
 *
 * Off writes an empty list rather than removing the key, which is what makes
 * it stick: absent is "never decided", and the next start would opt straight
 * back in.
 */
export async function setTerminalConsent(root, allowed) {
  return await write(root, withTerminalConsent(await readConfig(root), allowed));
}
