/**
 * Consent, read from disk rather than from memory.
 *
 * The file used to carry two comments saying the config was live — that a
 * withdrawal took effect on the next poll, and that opening checked the
 * config rather than the advertisement seconds earlier. Neither was: both
 * read `project.config`, the snapshot the worker loaded at start. A machine
 * whose owner turned terminals off went on offering them, and opening one,
 * until the app was restarted.
 *
 * That is the wrong direction for a consent to lag in, and it is the whole
 * point of the desktop app's switch, so it is tested against a real file
 * being rewritten under a running loop.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject, type ProjectConfig } from "@coord/cli/project";

import { TerminalLoop } from "./terminal-loop.js";

interface Poll {
  capability: unknown;
}

/** A control plane that hands out one piece of work and then nothing. */
function fakeClient(work: unknown) {
  const polls: Poll[] = [];
  const output: string[] = [];
  const exits: number[] = [];
  let handed = false;
  return {
    polls,
    output,
    exits,
    client: {
      async terminalPoll(_workerId: string, capability: unknown) {
        polls.push({ capability });
        // Slowed on purpose. The real call is a long poll; without a wait
        // here the loop spins as fast as the event loop allows and starves
        // everything this test is trying to observe.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (handed) {
          return undefined;
        }
        handed = true;
        return work;
      },
      async terminalOutput(_w: string, _s: string, data: string) {
        output.push(data);
      },
      async terminalExit(_w: string, _s: string, code: number) {
        exits.push(code);
      },
    },
  };
}

async function until(
  condition: () => boolean,
  what: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function project(
  terminal: NonNullable<ProjectConfig["terminal"]>,
): Promise<CoordinatorProject> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kumi-terminal-live-"));
  const opened = await CoordinatorProject.init(root);
  opened.config.terminal = terminal;
  await opened.save();
  return opened;
}

test("consent withdrawn while the app runs takes the terminal away", async (t) => {
  const opened = await project({ allow: "all" });
  t.after(async () => await rm(opened.root, { recursive: true, force: true }));

  const fake = fakeClient(undefined);
  const loop = new TerminalLoop({
    workerId: "worker_1",
    project: opened,
    client: fake.client,
    reloadConfig: async () =>
      (await CoordinatorProject.open(opened.root)).config,
    workspaceFor: async () => opened.workspaceRoot,
    log: () => undefined,
  });
  t.after(async () => await loop.stop());

  loop.start();
  // Allowed: the machine says what it can offer, so the browser can list it.
  await until(() => fake.polls.length > 0, "a first poll");
  assert.notEqual(fake.polls[0]?.capability, undefined);

  // The switch, as the desktop app writes it: a file on disk, no restart, no
  // message to this process.
  const revoking = await CoordinatorProject.open(opened.root);
  revoking.config.terminal = { allow: [] };
  await revoking.save();

  // And within a poll the machine stops offering one. Absent, not an empty
  // list: "this machine offers no terminal" and "it offers one with no
  // shells" are different facts, and the browser draws them differently.
  const before = fake.polls.length;
  await until(
    () => fake.polls.length > before + 1,
    "a poll made after the withdrawal",
  );
  assert.equal(fake.polls.at(-1)?.capability, undefined);
});

test("an open that arrives after a withdrawal is refused, not honoured", async (t) => {
  const opened = await project({ allow: "all" });
  t.after(async () => await rm(opened.root, { recursive: true, force: true }));

  // The window this closes: the browser was handed a capability, somebody
  // pressed it, and the consent went away in between. Simulated by handing
  // the loop an open request from a poll whose config has already been
  // rewritten — which is exactly the state that window produces.
  const revoking = await CoordinatorProject.open(opened.root);
  revoking.config.terminal = { allow: ["something-else"] };
  await revoking.save();

  const fake = fakeClient({
    open: [
      {
        id: "term_1",
        repositoryId: "demo-app",
        shell: "bash",
        cols: 80,
        rows: 24,
      },
    ],
    input: [],
    resize: [],
    close: [],
  });
  const loop = new TerminalLoop({
    workerId: "worker_1",
    project: opened,
    client: fake.client,
    reloadConfig: async () =>
      (await CoordinatorProject.open(opened.root)).config,
    workspaceFor: async () => opened.workspaceRoot,
    log: () => undefined,
  });
  t.after(async () => await loop.stop());

  loop.start();
  await until(() => fake.exits.length > 0, "the session to end");

  // 126 is "found it, would not run it" — the shell was never started.
  assert.deepEqual(fake.exits, [126]);
  // And the reader is told which of the several possible refusals this was,
  // and where the switch is. A pane that simply closed would send somebody
  // looking for a broken worker.
  const said = fake.output.join("");
  assert.match(said, /has not been allowed to open a terminal for demo-app/u);
  assert.match(said, /Allow Terminals on This Machine/u);
});

test("a config that stops parsing is not a withdrawal", async (t) => {
  const opened = await project({ allow: "all" });
  t.after(async () => await rm(opened.root, { recursive: true, force: true }));

  const fake = fakeClient(undefined);
  let readable = true;
  const loop = new TerminalLoop({
    workerId: "worker_1",
    project: opened,
    client: fake.client,
    // An editor mid-save, a disk that answered ENOENT for a moment. The last
    // good answer stands: a revocation is a deliberate act that writes a file
    // which parses, and treating an unreadable one as "no" would make half a
    // second of a text editor look like the owner changing their mind.
    reloadConfig: async () => {
      if (!readable) {
        throw new Error("EBUSY");
      }
      return (await CoordinatorProject.open(opened.root)).config;
    },
    workspaceFor: async () => opened.workspaceRoot,
    log: () => undefined,
  });
  t.after(async () => await loop.stop());

  loop.start();
  await until(() => fake.polls.length > 0, "a first poll");
  readable = false;

  const before = fake.polls.length;
  await until(
    () => fake.polls.length > before + 1,
    "a poll made while the config was unreadable",
  );
  assert.notEqual(fake.polls.at(-1)?.capability, undefined);
});
