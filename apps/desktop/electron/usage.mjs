/**
 * Reading an agent's remaining quota from the machine it actually runs on.
 *
 * The figure used to come from the control plane, which meant it needed a
 * vendor credential stored there — and that credential was the entire reason
 * connecting an agent asked for a second sign-in. Nothing else wanted it: the
 * agent runs here, under the login this machine's CLI already holds.
 *
 * So the question is asked where the answer is. This runs the vendor's own
 * usage command and hands back what it printed, verbatim. Parsing stays on the
 * server, which already has a parser per vendor and is the only place that
 * knows what a window means — duplicating that here would be a second copy to
 * keep in step with vendors who change their output without warning.
 */

import { spawn } from "node:child_process";

import { detectAgents } from "./agents.mjs";

/**
 * What to run to ask each vendor how much is left.
 *
 * Only vendors whose CLI publishes a usage command are here. Cursor has none,
 * and inventing one would produce a card that reports a failure forever
 * instead of simply not offering the number.
 *
 * Codex is absent for a different reason: its figures come from session
 * records under its own home directory rather than from a command, so reading
 * them is a file walk rather than a spawn. Worth doing, and not by pretending
 * it is a command.
 */
const USAGE_COMMANDS = {
  claude: ["-p", "/usage", "--output-format", "json"],
};

/** How long to wait before deciding the CLI is not going to answer. */
const USAGE_TIMEOUT_MS = 60_000;

/** The most output worth carrying back; a usage report is a few lines. */
const MAX_OUTPUT = 64_000;

/**
 * Runs one vendor's usage command on this machine.
 *
 * Returns the raw text rather than a verdict. A CLI that is signed out still
 * prints something worth showing — Claude exits non-zero merely for being
 * signed out while printing the status it was asked for — so the exit code is
 * carried alongside rather than used to throw the answer away.
 */
export async function readVendorUsage(vendor) {
  const args = Object.hasOwn(USAGE_COMMANDS, vendor)
    ? USAGE_COMMANDS[vendor]
    : undefined;
  if (args === undefined) {
    return { ok: false, detail: `${String(vendor)} publishes no usage command.` };
  }
  const agents = await detectAgents();
  const entry = agents[vendor];
  if (entry === undefined) {
    return {
      ok: false,
      detail: `The ${String(vendor)} CLI is not installed on this machine.`,
    };
  }
  // The path this machine's own detection found, so the command asked about
  // usage is the same program that does the work.
  const executable = entry.command ?? vendor;
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, detail: describe(error) });
      return;
    }
    let out = "";
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, detail: "The CLI did not answer in time." });
    }, USAGE_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const take = (chunk) => {
      if (out.length < MAX_OUTPUT) {
        out += String(chunk);
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.once("error", (error) => finish({ ok: false, detail: describe(error) }));
    child.once("close", (code) => {
      // Reported whatever the exit code, for the reason above.
      finish({ ok: true, raw: out.slice(0, MAX_OUTPUT), exitCode: code ?? 0 });
    });
  });
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
