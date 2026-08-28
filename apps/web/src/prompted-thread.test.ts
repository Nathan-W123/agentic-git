import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("a prompted thread uses the free secondary slot and never covers a chosen context", async () => {
  const app = await publicFile("app.js");
  const start = app.indexOf("function openPromptedThread(");
  const end = app.indexOf("function openReadyPlan(", start);
  const open = app.slice(start, end);

  assert.match(open, /phoneLayout\(\)/u);
  assert.match(open, /activeSecondaryContext\(\) !== undefined/u);
  assert.match(open, /activeSecondaryContext\(\) !== `thread:\$\{state\.autoOpenedThread\}`/u);
  assert.match(open, /openSecondaryContext\(`thread:\$\{messageId\}`\)/u);
});

test("a ready plan follows the same single-context arbitration", async () => {
  const app = await publicFile("app.js");
  const start = app.indexOf("function openReadyPlan(");
  const end = app.indexOf("document.addEventListener", start);
  const open = app.slice(start, end);

  assert.match(open, /activeSecondaryContext\(\) !== undefined/u);
  assert.match(open, /state\.activePlan = messageId/u);
  assert.match(open, /openSecondaryContext\("plan"\)/u);
});
