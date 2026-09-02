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

import { spawn, spawnSync } from "node:child_process";

import { detectAgents, findAgentCommand } from "./agents.mjs";
import { runnable, treeKill } from "./installers.mjs";

/**
 * Codex's app-server handshake, written to stdin in one go.
 *
 * `account/rateLimits/read` is the interface OpenAI documents for this, so it
 * is asked first and `--status --json` is the fallback for a CLI too old to
 * answer it. Both are attempted here rather than picked, because this side
 * does not parse and therefore cannot tell which one answered; the server
 * runs its parsers in the same order over whatever came back.
 */
const CODEX_HANDSHAKE = [
  {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { clientInfo: { name: "kumi-desktop", title: "Kumi", version: "0.0.0" } },
  },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", id: 1, method: "account/rateLimits/read", params: {} },
]
  .map((message) => `${JSON.stringify(message)}\n`)
  .join("");

/**
 * What to run to ask each vendor how much is left, in the order to try.
 *
 * Every argv here is one the control plane already runs against the same CLI,
 * so this is the same question asked from the machine that holds the login
 * rather than a new one invented for the desktop.
 *
 * Cursor is the odd one out: `cursor-agent` publishes no quota at all, and its
 * status view reports account facts instead. It is still asked, because
 * "signed in here, but this vendor does not publish a quota" is a more useful
 * card than silence — and because the answer being account facts is a finding
 * the server can state rather than a number this side invents.
 */
const USAGE_COMMANDS = {
  // Claude answers by starting a session, which is why this one is given the
  // long deadline and the other two are not.
  //
  // `stream-json` rather than `json`, because the windows are not in the
  // reply. `claude -p "/usage"` sends the slash command as a *prompt* — it
  // never opens the interactive usage view — so the reply is an ordinary
  // session summary with no percentage in it, which is exactly the empty card
  // this was producing. The percentages travel beside the reply instead: the
  // CLI emits a `rate_limit_event` carrying `unifiedWindows.five_hour` and
  // `.seven_day` as soon as it knows them, and `stream-json` is the format
  // that publishes it. `--verbose` is not optional; `stream-json` is refused
  // without it.
  //
  // Stopped the moment that event lands, which is what makes this cheaper
  // than what it replaces rather than merely better: the run is killed
  // before the turn it started can finish.
  claude: [
    {
      args: ["-p", "/usage", "--output-format", "stream-json", "--verbose"],
      timeoutMs: 60_000,
      done: (text) => text.includes('"rate_limit_event"'),
      // Printing is not answering, and for this attempt that distinction is
      // the whole thing. A stream-json run always prints — a system frame, an
      // assistant turn, a result — so "stdout was not empty" made this attempt
      // win every single time, which quietly made the fallback below
      // unreachable code and filed a session summary as the usage reading.
      //
      // Exactly the rule the codex attempt already has for stderr, which was
      // written for this same mistake and never applied here: an attempt has
      // answered when it produced what it was asked for, and nothing else
      // counts.
      answered: (text) => text.includes('"rate_limit_event"'),
    },
    // A CLI too old to publish the event still answers the prompt, and the
    // server still has the parser that reads percentages out of the reply.
    { args: ["-p", "/usage", "--output-format", "json"], timeoutMs: 60_000 },
  ],
  codex: [
    {
      args: ["app-server", "--stdio"],
      stdin: CODEX_HANDSHAKE,
      timeoutMs: 8_000,
      // The app-server does not exit when it has answered — it waits for the
      // next request. Without this the first attempt would spend its whole
      // deadline after the answer was already in hand, and the fallback below
      // would never be reached inside a reasonable wait.
      done: (text) => text.includes('"id":1') || text.includes('"id": 1'),
    },
    { args: ["--status", "--json"], timeoutMs: 8_000 },
  ],
  cursor: [{ args: ["status"], timeoutMs: 15_000 }],
};

/** The deadline for an attempt that does not name its own. */
const USAGE_TIMEOUT_MS = 30_000;

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
  const attempts = Object.hasOwn(USAGE_COMMANDS, vendor)
    ? USAGE_COMMANDS[vendor]
    : undefined;
  if (attempts === undefined) {
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
  //
  // Resolved even where the project config deliberately does not pin it. A
  // bare name is fine on any platform that has an executable of that name;
  // on Windows it is resolved by a PATHEXT search that finds the `.cmd` npm
  // installed and then refuses to start it. Holding the real path is what
  // lets `runnable` see a batch shim and run it through an interpreter.
  const executable =
    entry.command ?? (await findAgentCommand(vendor)) ?? vendor;
  let last;
  /** The first attempt's stdout, kept for the probe when nothing answers. */
  let firstOutput;
  for (const attempt of attempts) {
    const result = await runOnce(executable, attempt);
    firstOutput ??= result.raw ?? result.output;
    // The first attempt that actually answered wins — `ok` now means this one
    // produced what it was asked for, not merely that it printed. A complaint
    // on stderr, or a stream that never carried the event, falls through to
    // the next attempt.
    if (result.ok) {
      return result;
    }
    last = result;
  }
  const carried = last?.raw ?? last?.output;
  if (carried !== undefined) {
    // Nothing produced a window, so say what was actually there instead of
    // leaving the card to describe it from the shape of the text.
    //
    // Three readings of this evening's card were spent guessing which step
    // failed, because "it answered with a session summary" is the same
    // sentence whether the CLI is too old to publish the event, does not
    // publish it in `-p` mode, or published it and something here missed it.
    // Those need different fixes and the card could not tell them apart.
    return {
      ...last,
      // `ok`, because there is something real to show and read: the card's
      // job from here is to say what was found, and a reading marked
      // unavailable falls back to the control plane's own login instead —
      // which is a different machine and therefore a different account.
      ok: true,
      raw: `${probe(executable, firstOutput)}\n${carried}`,
    };
  }
  return last ?? { ok: false, detail: "Nothing to run." };
}

/**
 * One line naming the CLI and what its stream actually carried.
 *
 * `--version` is asked of the binary, not of the account — it starts no turn
 * and spends nothing, which is why it is safe to ask on a path somebody is
 * already waiting on. The event types are read out of the run that just
 * happened rather than provoking another one.
 *
 * Prepended to the raw rather than carried beside it, so it needs no change to
 * the route, the store, or the shape either side already agrees on. Every
 * parser downstream reads lines it recognises and skips the rest, and this
 * line looks like none of them.
 */
function probe(executable, output) {
  let version = "version unknown";
  try {
    const { command, args } = runnable(executable, ["--version"]);
    const asked = spawnSync(command, args, {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10_000,
    });
    const said = `${asked.stdout ?? ""}`.trim().split("\n")[0];
    if (said) {
      version = said.slice(0, 80);
    }
  } catch {
    // A CLI that will not say its version still ran the command above, so
    // this is a missing detail rather than a reason to report nothing.
  }
  const kinds = new Set();
  for (const line of `${output ?? ""}`.split("\n")) {
    const type = /"type"\s*:\s*"([\w.-]+)"/u.exec(line)?.[1];
    if (type !== undefined) {
      kinds.add(type);
    }
  }
  const seen = kinds.size === 0 ? "no typed events" : [...kinds].join(", ");
  return `kumi-probe: ${version} — stream carried: ${seen}`;
}

function runOnce(executable, attempt) {
  return new Promise((resolve) => {
    let child;
    // Through `cmd.exe` when the detected CLI is a batch shim, which on
    // Windows is what npm installs its global binaries as. Spawning one
    // directly is `spawn EINVAL` — the same rule that made the installer
    // impossible, reached by a different road.
    const { command, args } = runnable(executable, attempt.args);
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, detail: describe(error) });
      return;
    }
    // Kept apart, and this is the distinction that decides whether an attempt
    // answered at all.
    //
    // They used to be merged, and a CLI too old for the documented interface
    // then "answered" with `error: unrecognized subcommand` — enough to win
    // the attempt, so the fallback below it was never reached and the card
    // blamed an API-key account for a CLI that simply predates the method.
    // The exit code cannot settle it either: Claude exits non-zero merely for
    // being signed out, while printing the status it was asked for.
    let out = "";
    let err = "";
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        // The app-server does not exit on its own; it is killed here, after
        // it has already answered.
        stop(child);
        resolve(value);
      }
    };
    /** What this attempt amounts to, from what each stream carried. */
    const settle = (exitCode) =>
      finish(
        out.trim() === "" || attempt.answered?.(out) === false
          ? {
              ok: false,
              detail:
                err.trim().split("\n")[0]?.slice(0, 400) ??
                `${executable} ${attempt.args.join(" ")} said nothing (exit ${String(exitCode)}).`,
              // Carried even though this attempt did not answer. It is what
              // the last attempt has to show if none of them do, and it is
              // what the probe reads the event types out of — an attempt that
              // printed a whole session and simply lacked one field is not the
              // same as one that printed nothing, and throwing its output away
              // here is what made the two indistinguishable downstream.
              ...(out.trim() === "" ? {} : { output: out.slice(0, MAX_OUTPUT) }),
            }
          : { ok: true, raw: out.slice(0, MAX_OUTPUT), exitCode },
      );
    const timer = setTimeout(
      () => settle(124),
      attempt.timeoutMs ?? USAGE_TIMEOUT_MS,
    );
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (out.length < MAX_OUTPUT) {
        out += String(chunk);
      }
      if (attempt.done?.(out) === true) {
        settle(0);
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (err.length < MAX_OUTPUT) {
        err += String(chunk);
      }
    });
    child.once("error", (error) => finish({ ok: false, detail: describe(error) }));
    // Reported whatever the exit code, for the reason above.
    child.once("close", (code) => settle(code ?? 0));
    child.stdin?.on("error", () => {
      // A CLI that closed stdin before this was written has not failed; it
      // simply did not want it.
    });
    // Written before anything is read, because the handshake is what makes
    // the app-server answer. Closing stdin is what makes a CLI that expects
    // none stop waiting for one.
    if (attempt.stdin !== undefined) {
      child.stdin?.write(attempt.stdin);
    }
    child.stdin?.end();
  });
}

/**
 * Ends a reader, and everything it started.
 *
 * `kill` signals one process. On Windows the process it signals is `cmd.exe`,
 * because a batch shim is not a program and has to be run through an
 * interpreter — and killing the interpreter leaves the vendor CLI it launched
 * running. That is not a tidiness problem. The orphan inherits this process's
 * stdout pipe, so the pipe never closes, the read never ends, and whoever is
 * waiting on it waits forever: a `codex app-server` asked for a usage figure
 * would be left running on somebody's machine after every reading, and the
 * suite that exercises it hangs rather than fails, which is how this arrived —
 * as twenty-five minutes of a Windows job sitting on a four-second step.
 *
 * {@link treeKill} names the tool by its full path, because the first cut
 * asked for `taskkill` by name and a narrowed `PATH` is exactly the condition
 * this runs under. Its result is read for the same reason: a kill that could
 * not run has to fall through to the signal, which reaches less than the tree
 * does but is better than the tree surviving unremarked.
 */
function stop(child) {
  try {
    const tree = child.pid === undefined ? undefined : treeKill(child.pid);
    if (tree !== undefined) {
      const ended = spawnSync(tree.command, tree.args, {
        windowsHide: true,
        stdio: "ignore",
      });
      // A non-zero status is usually 128 — the tree was already gone — and
      // signalling a dead child below is a no-op, so both roads are safe.
      if (ended.error === undefined && ended.status === 0) {
        return;
      }
    }
    child.kill();
  } catch {
    // It exited between the state check and the signal.
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
