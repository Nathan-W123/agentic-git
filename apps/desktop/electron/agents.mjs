/**
 * What this machine can run agents with, and the config that records it.
 *
 * Split out of `worker.mjs` for one reason: that module imports Electron, so
 * nothing in it can be exercised without a browser. This half is `PATH` and
 * filesystem work with no Electron in it at all, and it is the half that
 * decides whether a task runs or comes back as `spawn codex ENOENT` — which
 * is exactly the half worth having under test.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/**
 * Vendor CLIs a worker can drive, and what they are called on each platform.
 *
 * `pinPath` says whether the detected file's own path is worth writing down.
 * It is for most of them: this process has just walked `PATH` and found the
 * exact file, and handing that path to the worker means the child never has
 * to repeat the search under an environment that may not match this one.
 * Claude is the exception — its npm shim cannot be spawned on Windows and its
 * adapter deliberately goes looking for the native binary instead, so naming
 * the shim here would override the one lookup that knows better.
 */
const KNOWN_AGENTS = [
  {
    id: "claude",
    adapter: "claude",
    commands: ["claude", "claude.cmd", "claude.exe"],
    pinPath: false,
  },
  {
    id: "codex",
    adapter: "codex",
    commands: ["codex", "codex.cmd", "codex.exe"],
    pinPath: true,
  },
  {
    id: "cursor",
    adapter: "cursor",
    commands: ["cursor-agent", "cursor-agent.cmd", "cursor-agent.exe"],
    pinPath: true,
  },
];

export async function exists(candidate) {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which agents this machine can actually drive.
 *
 * Only what is installed is advertised, because the adapter list a worker
 * registers with is what the control plane filters work by. Claiming an agent
 * that is not here means leasing a task and then failing it, which is strictly
 * worse than never being offered it.
 */
export async function detectAgents() {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const agents = {};
  for (const agent of KNOWN_AGENTS) {
    const found = await findOnPath(dirs, agent.commands);
    if (found === undefined) {
      continue;
    }
    agents[agent.id] = agent.pinPath
      ? { adapter: agent.adapter, command: found }
      : { adapter: agent.adapter };
  }
  return agents;
}

/**
 * The first of these names that exists in one of these directories.
 *
 * Candidates are tried in the order they are written rather than directory by
 * directory, so a `PATH` entry that holds both `codex` and `codex.cmd` yields
 * the same answer a shell would.
 */
async function findOnPath(dirs, names) {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Writes the worker's own project config, reconciled with what is installed.
 *
 * This used to return an existing config untouched, which made the file a
 * record of the machine as it was the first time the app ran. Installing a
 * CLI afterwards did nothing, and a CLI that moved — an npm global that
 * changed prefix, a reinstall — left behind a path that no longer resolved.
 *
 * So detection wins for every agent this build knows about, with one
 * exception: an entry whose `command` still points at a file that exists is
 * left exactly as it is, because that is either a path this function pinned
 * and which is still good, or one a person chose on purpose. A known agent
 * with neither is removed, since advertising a CLI that is not here means
 * leasing work only to fail it. The rest of the file — validation commands,
 * agents this build has never heard of — is preserved either way.
 */
export async function ensureProject(root, agents) {
  const configPath = path.join(root, ".coordinator", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  let saved;
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (parsed && typeof parsed === "object") {
      saved = parsed;
    }
  } catch {
    // No config, or one this build cannot read. Either way it is written
    // fresh below rather than half-repaired.
  }
  const merged = { ...(saved?.agents ?? {}) };
  for (const known of KNOWN_AGENTS) {
    const existing = merged[known.id];
    const pinned =
      typeof existing?.command === "string" ? existing.command : undefined;
    if (pinned !== undefined && (await exists(pinned))) {
      continue;
    }
    if (agents[known.id] === undefined) {
      // Detection did not find it and no saved path resolves, so the machine
      // cannot run it. Advertising it anyway means leasing work and failing
      // it, which is the thing `detectAgents` exists to avoid.
      delete merged[known.id];
      continue;
    }
    merged[known.id] = agents[known.id];
  }
  const config = {
    ...saved,
    version: 1,
    validationCommands: saved?.validationCommands ?? [],
    agents: merged,
  };
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
  return config;
}
