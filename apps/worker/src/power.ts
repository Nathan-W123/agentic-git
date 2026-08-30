import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

/**
 * Whether this machine is plugged in, and whether it should be taking work.
 *
 * ### Why a worker cares
 *
 * A desktop worker is only useful if it is reachable when nobody is sitting at
 * it, and on Windows that is a much narrower window than it looks. Microsoft's
 * own description of Modern Standby is that "Windows prevents desktop
 * applications from running during any part of modern standby"; only session-0
 * services survive, throttled to one second of activity every thirty. Worse,
 * Adaptive Connected Standby quiesces the network entirely during sleep on
 * battery unless Remote Desktop or a UWP background task is holding it open.
 *
 * So on battery a machine cannot honestly promise to finish what it starts. It
 * can claim a lease, lose the network, and hold that task hostage for the full
 * five-minute expiry while its owner watches nothing happen. Declining to
 * claim is the better failure: the task stays queued, plainly, and runs the
 * moment the machine is plugged in or awake.
 *
 * ### Why it shells out
 *
 * Electron has `powerMonitor`, but the worker deliberately does not depend on
 * Electron — it runs as a bare Node process beside the app today and as a
 * Windows service later, and neither has a renderer. Reading the state the way
 * the operating system already exposes it on the command line keeps this
 * dependency-free, which is what lets the whole worker bundle into one file.
 */
export type PowerState = "ac" | "battery" | "unknown";

export interface PowerSource {
  read(): Promise<PowerState>;
}

/** Injected by tests. Resolves with stdout, or rejects like `execFile` would. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<string>;

const defaultRunner: CommandRunner = async (command, args) =>
  await new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });

/**
 * `unknown` is deliberately not `battery`.
 *
 * Every caller treats an unreadable state as permission to work. A machine
 * whose power source cannot be determined is far more often a desktop, a
 * server, or a container with no battery at all than it is a laptop running
 * flat — and refusing to work on all of them to protect the rare case would
 * turn an unreadable probe into a worker that silently never claims anything.
 */
export function shouldClaimWork(state: PowerState): boolean {
  return state !== "battery";
}

async function readWindows(run: CommandRunner): Promise<PowerState> {
  // BatteryStatus 2 is "on AC". A machine with no battery returns nothing at
  // all, which is a desktop, which is always on AC.
  const out = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "(Get-CimInstance -ClassName Win32_Battery).BatteryStatus",
  ]);
  const codes = out
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value));
  if (codes.length === 0) {
    return "ac";
  }
  // Discharging on any battery is enough: a laptop in a dock with one charged
  // and one draining is still a machine that can lose power.
  return codes.includes(1) ? "battery" : "ac";
}

async function readDarwin(run: CommandRunner): Promise<PowerState> {
  const out = await run("pmset", ["-g", "batt"]);
  if (out.includes("AC Power")) {
    return "ac";
  }
  return out.includes("Battery Power") ? "battery" : "unknown";
}

async function readLinux(): Promise<PowerState> {
  // The mains adapter reports `online` directly, which is the whole question.
  const base = "/sys/class/power_supply";
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return "unknown";
  }
  for (const entry of entries) {
    try {
      const type = (await readFile(`${base}/${entry}/type`, "utf8")).trim();
      if (type !== "Mains") {
        continue;
      }
      const online = (await readFile(`${base}/${entry}/online`, "utf8")).trim();
      return online === "1" ? "ac" : "battery";
    } catch {
      // A supply that vanished mid-read, or one without these files. The next
      // one may still answer.
    }
  }
  return "unknown";
}

/**
 * The real power source, or one that always answers `unknown`.
 *
 * `platform` is a constructor argument rather than a read of
 * `process.platform` so the Windows and macOS branches are reachable from a
 * test on any host — the same shape `CodexAdapter` uses for its sandbox flags.
 */
export function systemPowerSource(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = defaultRunner,
): PowerSource {
  return {
    read: async () => {
      try {
        if (platform === "win32") {
          return await readWindows(run);
        }
        if (platform === "darwin") {
          return await readDarwin(run);
        }
        if (platform === "linux") {
          return await readLinux();
        }
        return "unknown";
      } catch {
        // A probe that fails is not a machine on battery. See shouldClaimWork.
        return "unknown";
      }
    },
  };
}
