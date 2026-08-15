import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSlashHelp,
  parseSlashCommand,
  SLASH_COMMANDS,
  slashCommandsMatching,
} from "./slash.js";

test("a command and a mention live in the same message", () => {
  // They answer different questions — how to treat the request, and who it
  // is for — so taking the command word off must leave the mention and the
  // objective exactly as they were.
  const parsed = parseSlashCommand("/plan @Eos rework the retry loop");
  assert.equal(parsed?.command.name, "plan");
  assert.equal(parsed?.rest, "@Eos rework the retry loop");

  // Leading space, and a command with nothing after it.
  assert.equal(parseSlashCommand("  /help")?.command.name, "help");
  assert.equal(parseSlashCommand("/help")?.rest, "");
});

test("a slash inside a sentence is not a command", () => {
  // Slashes appear in ordinary text constantly. Reading any of them as
  // syntax would turn a sentence into an error nobody typed.
  for (const content of [
    "check /usr/bin/env is on the path",
    "the file is at src/retry.ts",
    "should we do this and/or that",
    "look at apps/web/public/data.js",
    "10/10 would ship",
  ]) {
    assert.equal(parseSlashCommand(content), undefined, content);
  }

  // Anchored to the start: a command word later in the message is prose.
  assert.equal(parseSlashCommand("please /plan this"), undefined);

  // An unknown word after the slash is not a command either — guessing at it
  // would be worse than reading it literally.
  assert.equal(parseSlashCommand("/deploy everything"), undefined);
  assert.equal(parseSlashCommand("/"), undefined);
});

test("the lookup offers what is being typed, and everything for a bare slash", () => {
  // Prefix rather than substring: offering /cancel for "/can" is helping,
  // offering it for "/el" is guessing.
  assert.deepEqual(
    slashCommandsMatching("/can").map((entry) => entry.name),
    ["cancel"],
  );
  assert.deepEqual(
    slashCommandsMatching("/").map((entry) => entry.name),
    SLASH_COMMANDS.map((entry) => entry.name),
  );
  assert.deepEqual(slashCommandsMatching("/zzz"), []);
});

test("help lists every command, so the picker and the text cannot drift", () => {
  const help = formatSlashHelp();
  for (const command of SLASH_COMMANDS) {
    assert.match(help, new RegExp(`/${command.name}\\b`, "u"), command.name);
    assert.ok(help.includes(command.summary), command.summary);
  }
});

test("/stop is a channel command that names agents rather than an objective", () => {
  const parsed = parseSlashCommand("/stop @Papa");
  assert.equal(parsed?.command.name, "stop");
  assert.equal(parsed?.rest, "@Papa");
  // Bare, it means everyone — so it must parse with nothing after it.
  assert.equal(parseSlashCommand("/stop")?.command.name, "stop");
  // It takes no objective: the rest of the line is who, not what.
  assert.equal(parsed?.command.takesObjective, false);
  // And it is offered while somebody is still typing it.
  assert.ok(slashCommandsMatching("/st").some((entry) => entry.name === "stop"));
});
