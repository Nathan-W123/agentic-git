/**
 * What a terminal is, asserted rather than assumed.
 *
 * The whole reason this code exists is that a pipe is not a terminal, so
 * these tests check the four things that actually differ — `isatty`, the
 * window size, a resize reaching the foreground program, and Ctrl-C arriving
 * as a signal instead of as a byte nobody reads. Each one is something a
 * reader would notice within a minute of using it, and none of them can be
 * checked by looking at the code.
 *
 * They run against a real shell on a real pseudo-terminal, because that is
 * the only place the answers are true. A fixture here would be a recording of
 * whatever I believed a terminal does.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  detectBackend,
  detectShells,
  helperPath,
  openTerminal,
  type TerminalHandle,
} from "./pty.js";

/**
 * Every terminal these tests opened, so none of them can outlive the run.
 *
 * This is not tidiness. A shell left holding an open pipe keeps the test
 * runner's event loop alive, so a *broken* implementation hangs the suite
 * instead of failing it — which is worse than no test at all, because it
 * wedges CI with no failure to read. Found by sabotaging `close()` and
 * watching `node --test` sit for thirteen minutes.
 */
const opened: TerminalHandle[] = [];

function reap(): void {
  for (const handle of opened.splice(0)) {
    if (handle.pid === undefined) {
      continue;
    }
    try {
      process.kill(handle.pid, "SIGKILL");
    } catch {
      // Already gone, which is the outcome this was for.
    }
  }
}

process.on("exit", reap);

/**
 * The backstop that actually works.
 *
 * `process.on("exit")` never runs while a surviving child holds the event
 * loop open — which is the exact case it was written for. An unref'd timer
 * does fire, because a loop still alive is the condition, so this turns a
 * hang into a failure with a sentence attached. Two sabotage cases sat for
 * three minutes each before this existed.
 */
const watchdog = setTimeout(() => {
  reap();
  console.error(
    "pty tests exceeded their budget — a terminal was left running, which " +
      "means teardown is broken rather than slow",
  );
  process.exit(1);
}, 120_000);
watchdog.unref?.();

/** Drives a terminal and collects everything it says. */
class Session {
  public output = "";
  public exited: number | undefined;

  public constructor(public readonly handle: TerminalHandle) {
    handle.onData((chunk) => {
      this.output += chunk;
    });
    handle.onExit((code) => {
      this.exited = code;
    });
  }

  /** What the reader sees, with the terminal's own bookkeeping removed. */
  public get text(): string {
    return this.output
      .replaceAll("\r\n", "\n")
      .replaceAll(/\[\?2004[hl]/gu, "");
  }

  public async settle(ms = 700): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Waits for a pattern, so a slow machine waits rather than fails. */
  public async until(pattern: RegExp, timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(this.text)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }
}

async function bashSession(cols = 100, rows = 30): Promise<Session | undefined> {
  const shells = detectShells();
  const shell = shells.find((candidate) => candidate.id === "bash");
  if (shell === undefined) {
    return undefined;
  }
  const cwd = await mkdtemp(path.join(os.tmpdir(), "kumi-pty-"));
  const handle = openTerminal({
    shell: { ...shell, args: ["--norc", "-i"] },
    cwd,
    cols,
    rows,
    env: { ...process.env, PS1: "$ " },
  });
  opened.push(handle);
  return new Session(handle);
}

test("the shells offered are the ones this machine has", () => {
  const shells = detectShells();
  // Every entry resolves to something real: the alternative is a menu
  // offering `cmd` on a Mac, a choice that can only fail, made to look
  // available.
  for (const shell of shells) {
    assert.ok(shell.id.length > 0);
    assert.ok(shell.label.length > 0);
    // Resolved, not merely named. A bare `"zsh"` is a string of non-zero
    // length and a menu entry that fails when pressed; what makes the offer
    // honest is that something was found at a path that exists.
    assert.ok(
      path.isAbsolute(shell.command),
      `${shell.id} was offered as ${JSON.stringify(shell.command)}, not a resolved path`,
    );
    assert.ok(
      existsSync(shell.command),
      `${shell.id} points at ${shell.command}, which is not there`,
    );
  }
  assert.equal(new Set(shells.map((s) => s.id)).size, shells.length);

  // Windows shells are never offered on a POSIX host, and the reverse.
  if (process.platform !== "win32") {
    assert.equal(
      shells.some((shell) => ["cmd", "powershell", "pwsh"].includes(shell.id)),
      false,
    );
  }
});

test("a machine with Python offers a real terminal, and says which it gave", () => {
  const backend = detectBackend();
  assert.ok(["python", "script", "pipes"].includes(backend));
  if (process.platform === "win32") {
    // Windows has no PTY reachable without native code, and saying so is the
    // point: a reader who cannot run a full-screen program is told, rather
    // than left to find out.
    assert.equal(backend, "pipes");
  } else {
    assert.notEqual(
      backend,
      "pipes",
      "a POSIX machine should manage a real terminal one way or the other",
    );
  }
  // The helper ships beside the code that runs it. Resolved rather than
  // assumed, because a build that stopped copying it would otherwise fail
  // only on somebody's laptop.
  if (backend === "python") {
    assert.ok(helperPath() !== undefined);
  }
});

test("what runs inside is a terminal, not a pipe", async (t) => {
  const session = await bashSession();
  if (session === undefined) {
    t.skip("no bash on this machine");
    return;
  }
  try {
    await session.settle();
    session.handle.write("test -t 1 && echo ISATTY=yes || echo ISATTY=no\n");
    assert.ok(
      await session.until(/ISATTY=yes/u),
      `no terminal: ${session.text.slice(-300)}`,
    );

    // The size it was opened with, read back by the shell. Without the ioctl
    // a full-screen program draws to 80x24 and wraps everything else, which
    // looks like a rendering bug and is a missing syscall.
    session.handle.write("echo SIZE=$(stty size < /dev/tty)\n");
    assert.ok(
      await session.until(/SIZE=30 100/u),
      `wrong size: ${session.text.slice(-300)}`,
    );

    // Colour, which programs turn on for a terminal and off for a pipe. This
    // is the visible half of the same `isatty` answer.
    session.handle.write("printf 'C='; ls --color=always -d / 2>/dev/null\n");
    await session.until(/C=/u);
  } finally {
    session.handle.close();
  }
});

test("Ctrl-C is a signal, which is the whole difference", async (t) => {
  const session = await bashSession();
  if (session === undefined) {
    t.skip("no bash on this machine");
    return;
  }
  try {
    await session.settle();
    session.handle.write("sleep 30; echo FINISHED_ON_ITS_OWN\n");
    await session.settle(600);

    // In a pipe this byte is data nobody reads. On a terminal the line
    // discipline turns it into SIGINT for the foreground process group —
    // which is why `vim`, `top` and every long-running command are usable at
    // all, and why this one number is the test worth having.
    session.handle.write("");
    assert.ok(await session.until(/\^C/u), `no interrupt: ${session.text.slice(-300)}`);

    session.handle.write("echo EXIT_WAS=$?\n");
    assert.ok(
      await session.until(/EXIT_WAS=130/u),
      `not a signal: ${session.text.slice(-300)}`,
    );
    // 130 is 128 + SIGINT. Nothing about a pipe can produce it.
    assert.doesNotMatch(
      session.text,
      /^FINISHED_ON_ITS_OWN$/mu,
      "the sleep ran to completion, so nothing was interrupted",
    );
  } finally {
    session.handle.close();
  }
});

test("a resize reaches the program inside", async (t) => {
  if (detectBackend() !== "python") {
    t.skip("only the helper carries a resize");
    return;
  }
  const session = await bashSession();
  if (session === undefined) {
    t.skip("no bash on this machine");
    return;
  }
  try {
    await session.settle();
    session.handle.resize(140, 45);
    await session.settle(300);
    session.handle.write("echo RESIZED=$(stty size < /dev/tty)\n");
    assert.ok(
      await session.until(/RESIZED=45 140/u),
      `resize did not land: ${session.text.slice(-300)}`,
    );
  } finally {
    session.handle.close();
  }
});

test("the shell exiting ends the session, and closing it ends the shell", async (t) => {
  const first = await bashSession();
  if (first === undefined) {
    t.skip("no bash on this machine");
    return;
  }
  await first.settle();
  first.handle.write("exit\n");
  await first.until(/./u, 3000);
  for (let attempt = 0; attempt < 50 && first.exited === undefined; attempt += 1) {
    await first.settle(100);
  }
  assert.notEqual(first.exited, undefined, "a shell that exits is reported");

  // And the other direction: a reader closing the pane must not leave a shell
  // holding a terminal on their machine forever.
  const second = await bashSession();
  assert.ok(second !== undefined);
  await second.settle();
  second.handle.close();
  // Bounded, and asserted as a failure rather than waited on forever: this is
  // the test that proves teardown works, so it must not depend on teardown
  // working to finish.
  for (let attempt = 0; attempt < 60 && second.exited === undefined; attempt += 1) {
    await second.settle(100);
  }
  const closed = second.exited !== undefined;
  if (!closed && second.handle.pid !== undefined) {
    process.kill(second.handle.pid, "SIGKILL");
  }
  assert.ok(closed, "closing the pane must end the shell, not orphan it");
});
