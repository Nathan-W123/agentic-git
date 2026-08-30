import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldClaimWork,
  systemPowerSource,
  type CommandRunner,
} from "./power.js";

/** Answers one canned string, and records what it was asked. */
function runner(output: string, asked: string[] = []): CommandRunner {
  return async (command, args) => {
    asked.push([command, ...args].join(" "));
    return output;
  };
}

const failing: CommandRunner = async () => {
  throw new Error("no such command");
};

test("Windows reports AC when no battery is discharging", async () => {
  const source = systemPowerSource("win32", runner("2\r\n"));
  assert.equal(await source.read(), "ac");
});

test("Windows reports battery when one is discharging", async () => {
  const source = systemPowerSource("win32", runner("1\r\n"));
  assert.equal(await source.read(), "battery");
});

test("a Windows machine with no battery at all is a desktop, so AC", async () => {
  // `Get-CimInstance Win32_Battery` returns nothing on a desktop. Treating an
  // empty answer as "battery" would stop every desktop worker from claiming.
  const source = systemPowerSource("win32", runner("\r\n"));
  assert.equal(await source.read(), "ac");
});

test("one discharging battery is enough, even beside a charged one", async () => {
  // A docked laptop can report several. Any of them draining means the machine
  // can still lose power, which is the only thing this is asked to predict.
  const source = systemPowerSource("win32", runner("2\r\n1\r\n"));
  assert.equal(await source.read(), "battery");
});

test("macOS reads pmset", async () => {
  const asked: string[] = [];
  const onMains = systemPowerSource(
    "darwin",
    runner("Now drawing from 'AC Power'", asked),
  );
  assert.equal(await onMains.read(), "ac");
  assert.deepEqual(asked, ["pmset -g batt"]);

  const unplugged = systemPowerSource(
    "darwin",
    runner("Now drawing from 'Battery Power'"),
  );
  assert.equal(await unplugged.read(), "battery");
});

test("an unreadable probe is unknown, and unknown still works", async () => {
  // The asymmetry that matters: a machine whose power source cannot be read is
  // far more often a container or a server than a laptop about to die, and
  // refusing to work on all of them would be a worker that silently never
  // claims anything.
  const source = systemPowerSource("win32", failing);
  assert.equal(await source.read(), "unknown");
  assert.equal(shouldClaimWork("unknown"), true);
});

test("only a known battery stops a claim", () => {
  assert.equal(shouldClaimWork("ac"), true);
  assert.equal(shouldClaimWork("battery"), false);
  assert.equal(shouldClaimWork("unknown"), true);
});

test("an unrecognised platform never blocks work", async () => {
  const source = systemPowerSource("aix" as NodeJS.Platform, failing);
  assert.equal(await source.read(), "unknown");
});
