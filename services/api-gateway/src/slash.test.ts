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
  // syntax would turn a sentence into an error nobody typed. None of them
  // spells a command word with whitespace on both sides, which is what the
  // scan requires now that position no longer rules them out.
  for (const content of [
    "check /usr/bin/env is on the path",
    "the file is at src/retry.ts",
    "should we do this and/or that",
    "look at apps/web/public/data.js",
    "10/10 would ship",
    // The command words themselves, as parts of a path rather than as words.
    "read docs/plan.md before starting",
    "it is in scripts/stop.sh",
  ]) {
    assert.equal(parseSlashCommand(content), undefined, content);
  }

  // An unknown word after the slash is not a command either — guessing at it
  // would be worse than reading it literally.
  assert.equal(parseSlashCommand("/deploy everything"), undefined);
  assert.equal(parseSlashCommand("/"), undefined);
});

test("a command is read wherever it is written, not only at the start", () => {
  // Position was a rule the composer could not teach: somebody who had
  // already typed a mention and then thought of "/plan" got a slash that did
  // nothing, with no way to tell that was the reason.
  const middle = parseSlashCommand("@Eos /plan rework the retry loop");
  assert.equal(middle?.command.name, "plan");
  // Only the command word is lifted out — everything around it reaches the
  // dispatcher exactly as written, with the seam closed up.
  assert.equal(middle?.rest, "@Eos rework the retry loop");

  const trailing = parseSlashCommand("@Papa stop what you are doing /stop");
  assert.equal(trailing?.command.name, "stop");
  assert.equal(trailing?.rest, "@Papa stop what you are doing");

  // The first known command wins, and an unknown word before it is left in
  // the message as the text it was.
  const first = parseSlashCommand("/deploy the thing /ask @Eos why");
  assert.equal(first?.command.name, "ask");
  assert.equal(first?.rest, "/deploy the thing @Eos why");

  // A second line is still the same message.
  const multiline = parseSlashCommand("have a look at this\n/plan @Eos the retry loop");
  assert.equal(multiline?.command.name, "plan");
  assert.equal(multiline?.rest, "have a look at this\n@Eos the retry loop");
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

test("a command written last is still the command, and the mentions survive", () => {
  // How it is typed when somebody says the thing first and then decides they
  // want the agent's question round before implementation. The command word
  // is lifted out from the end the same way it is from the front, and the
  // mention stays where it was.
  const parsed = parseSlashCommand("@Zeus change the background color /ask");
  assert.equal(parsed?.command.name, "ask");
  assert.equal(parsed?.rest, "@Zeus change the background color");
  assert.match(parsed?.command.summary ?? "", /questions before starting/u);
  assert.equal(parsed?.command.usage, "/ask @agent what you want done");
});

test("/dnc and /simple carry an objective, like /ask and /plan", () => {
  // "Do not code" is an answer-only request: the mention and the question
  // around the command word must reach the dispatcher exactly as written.
  const dnc = parseSlashCommand("/dnc @Eos what does the retry loop do?");
  assert.equal(dnc?.command.name, "dnc");
  assert.equal(dnc?.rest, "@Eos what does the retry loop do?");
  assert.equal(dnc?.command.takesObjective, true);

  // `/simple` is about the shape of the reply, and like any command it is
  // read wherever in the message it was typed.
  const simple = parseSlashCommand("@Eos /simple why did the build fail?");
  assert.equal(simple?.command.name, "simple");
  assert.equal(simple?.rest, "@Eos why did the build fail?");
  assert.equal(simple?.command.takesObjective, true);

  // Both are offered while somebody is still typing them.
  assert.deepEqual(
    slashCommandsMatching("/d").map((entry) => entry.name),
    ["dnc"],
  );
  assert.ok(
    slashCommandsMatching("/si").some((entry) => entry.name === "simple"),
  );
});

test("/push is a direct command without an agent or objective", () => {
  const parsed = parseSlashCommand("/push");
  assert.equal(parsed?.command.name, "push");
  assert.equal(parsed?.rest, "");
  assert.equal(parsed?.command.takesObjective, false);
  assert.ok(
    slashCommandsMatching("/pu").some((entry) => entry.name === "push"),
  );
  assert.match(formatSlashHelp(), /\/push\b/u);
  assert.doesNotMatch(formatSlashHelp(), /\/push @agent/u);

  // It is syntax only as its own slash word, like every other command.
  assert.equal(parseSlashCommand("read docs/push.md first"), undefined);
});

test("/queue carries a follow-up objective and is discoverable", () => {
  const parsed = parseSlashCommand(
    "/queue @Eos rework the retry loop after the current task",
  );
  assert.equal(parsed?.command.name, "queue");
  assert.equal(
    parsed?.rest,
    "@Eos rework the retry loop after the current task",
  );
  assert.equal(parsed?.command.takesObjective, true);
  assert.ok(
    slashCommandsMatching("/qu").some((entry) => entry.name === "queue"),
  );
  assert.match(formatSlashHelp(), /\/queue @agent/u);
});
