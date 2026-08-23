import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* The dashboard is served as plain browser modules, so these read the source
   the gateway actually hands out rather than importing it: there is no build
   step between the file and the page. Same approach `assets.test.ts` takes. */
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(packageRoot, "public", name), "utf8");
}

/** Lifts one self-contained top-level function out of a browser module. */
function extract<T>(source: string, name: string): T {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} did not end`);
  return new Function(
    `${source.slice(start, end + 2)}\nreturn ${name};`,
  )() as T;
}

test("usage is asked for by vendor, never by the agent's own id", async () => {
  const chats = await publicFile("screen-chats.js");
  const providerOf = extract<(agent: unknown) => string>(
    chats,
    "usageProviderId",
  );
  // One's own agent is keyed by the bare vendor already.
  assert.equal(providerOf({ id: "openai", provider: "openai" }), "openai");
  // Everyone else arrives as the server's `<userId>:<provider>` composite,
  // which the usage route has no path for — asking for it verbatim is what
  // printed "Route was not found" in the card.
  assert.equal(providerOf({ id: "user_9f2:openai" }), "openai");
  assert.equal(
    providerOf({ id: "user_9f2:anthropic", provider: "anthropic" }),
    "anthropic",
  );
  assert.equal(providerOf({}), "");
});

test("the profile card and the specification read one usage key", async () => {
  const chats = await publicFile("screen-chats.js");
  const card = chats.slice(
    chats.indexOf("function usageBlock("),
    chats.indexOf("\n}\n", chats.indexOf("function usageBlock(")),
  );
  const spec = chats.slice(
    chats.indexOf("function agentUsage("),
    chats.indexOf("\n}\n", chats.indexOf("function agentUsage(")),
  );
  for (const [name, source] of [
    ["usageBlock", card],
    ["agentUsage", spec],
  ] as const) {
    assert.match(
      source,
      /state\.providerUsage\[usageStateKey\(agent\)\]/u,
      `${name} should read usage under the resolved vendor and owner`,
    );
  }
});

test("a face that opens the card is the face that asks for the usage", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  // The card carries its usage section again, keyed for the delegated
  // listener that fetches it.
  assert.match(chats, /usage: usageBlock\(agent\)/u);
  assert.match(chats, /usageProviderId: providerId/u);
  // Both the roster row and the transcript's author face hand the vendor to
  // that listener, for every agent in the room — a teammate's row names the
  // owner beside it so the answer is that agent's account and not the
  // reader's.
  const roster = chats.slice(
    chats.indexOf("function rosterRow("),
    chats.indexOf("function section("),
  );
  assert.match(roster, /"data-hover": "agent-usage"/u);
  assert.match(roster, /"data-hover-value": usageProviderId\(agent\)/u);
  assert.match(roster, /"data-hover-owner": usageOwner\(agent\)/u);
  assert.doesNotMatch(roster, /agent\.mine === true\n\s*\? \{/u);
  const wrap = chats.slice(
    chats.indexOf("function identityWrap("),
    chats.indexOf("function plainAnchor("),
  );
  assert.match(wrap, /identity\.usageProviderId/u);
  assert.match(wrap, /identity\.usageOwnerId/u);
  assert.match(app, /closest\('\[data-hover="agent-usage"\]'\)/u);
  assert.match(app, /target\.dataset\.hoverValue/u);
  assert.match(app, /target\.dataset\.hoverOwner/u);
});

test("nothing on the card is withheld because the agent is somebody else's", async () => {
  // The whole point of this change: usage is an operational fact about an
  // agent anybody in the room may put to work, so neither the hover card nor
  // the specification refuses to draw it for a teammate's agent.
  const chats = await publicFile("screen-chats.js");
  const card = chats.slice(
    chats.indexOf("function usageBlock("),
    chats.indexOf("\n}\n", chats.indexOf("function usageBlock(")),
  );
  const spec = chats.slice(
    chats.indexOf("function agentUsage("),
    chats.indexOf("\n}\n", chats.indexOf("function agentUsage(")),
  );
  for (const source of [card, spec]) {
    assert.doesNotMatch(source, /agent\.mine !== true/u);
  }
  assert.doesNotMatch(chats, /Usage is private to the agent's owner/u);
});
