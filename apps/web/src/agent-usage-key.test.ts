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

test("the popover shows quota windows without provider diagnostics", async () => {
  const chats = await publicFile("screen-chats.js");
  const card = chats.slice(
    chats.indexOf("function usageBlock("),
    chats.indexOf("\n}\n", chats.indexOf("function usageBlock(")),
  );

  // Loading, unsupported providers, and empty reports are explanations for
  // the full profile. A hover summary stays absent until it has a real quota
  // window to show.
  assert.match(card, /const windows = report\?\.windows \?\? \[\];/u);
  assert.match(card, /report\.loading === true/u);
  assert.match(card, /report\.unavailableReason !== undefined/u);
  assert.match(card, /windows\.length === 0/u);
  assert.match(card, /return "";/u);
  assert.doesNotMatch(card, /Checking usage|No usage reported/u);
  assert.doesNotMatch(
    card,
    /usageNoteLines|usageAccountLine|rr-usage-plan|rr-usage-src/u,
  );

  // A genuine window keeps the useful operational facts: label, percentage,
  // meter and reset time.
  assert.match(card, /class="pcard-section pcard-usage-section"/u);
  assert.match(card, /class="rr-usage-label"/u);
  assert.match(card, /class="rr-usage-bar"/u);
  assert.match(card, /class="rr-usage-pct"/u);
  assert.match(card, /usageResetText\(window\)/u);
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

/**
 * Every fact the roster resolves has to be taken back out of the map.
 *
 * `channelAgentsFor` merges the server's roster into the agents the browser
 * already holds, and the merge is a field list rather than a spread of the
 * resolved record — deliberately, because role, model and effort each honour
 * a local override and a blind spread would wipe one mid-edit. The cost is
 * that a field added to the map and not added to the list is dropped in
 * silence.
 *
 * Which is exactly what happened to `ownerOnline`: it was put in the map,
 * never read, and so every agent looked online however long its owner's
 * machine had been off. Nothing failed — the grey dot simply never appeared
 * and the offline prompt never fired, on a path that read as fully wired.
 *
 * So this asserts the invariant rather than the instance: whatever the map
 * carries, the merge reads.
 */
test("the roster merge reads every field the resolved map carries", async () => {
  const data = await publicFile("data.js");
  const body = data.slice(
    data.indexOf("  const resolved = new Map("),
    data.indexOf("/** Agents and people who can be @mentioned in this channel. */"),
  );
  assert.notEqual(body, "", "channelAgentsFor's merge moved");

  const mapEntry = body.slice(0, body.indexOf("  );"));
  const merge = body.slice(body.indexOf("    if (server !== undefined) {"));
  assert.notEqual(merge, "", "the merge branch moved");

  // The keys the map is built with, minus the two structural ones a merge
  // would never restate.
  const carried = [...mapEntry.matchAll(/^\s{10}([a-zA-Z]+):/gmu)]
    .map((match) => match[1])
    .filter((key) => key !== undefined && key !== "name");

  assert.ok(carried.length > 0, "no fields found in the resolved map");
  for (const key of carried) {
    assert.match(
      merge,
      new RegExp(`server\\.${key}\\b`, "u"),
      `the resolved map carries \`${key}\` and the merge never reads it, so ` +
        `every agent silently loses it`,
    );
  }
  // And the one that was actually dropped, named outright so a rename cannot
  // quietly satisfy the loop above with an empty list.
  assert.match(merge, /ownerOnline: server\.ownerOnline/u);
});
