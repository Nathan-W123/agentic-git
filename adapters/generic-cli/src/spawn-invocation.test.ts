import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
   Read rather than run: the rules being pinned here only apply on Windows,
   and this suite runs on Linux. That is the whole reason they were wrong for
   three releases — `runProcess` learned to resolve a bare npm CLI name and
   this adapter, which owns its own child, did not, so `spawn agent ENOENT`
   survived a fix that had already shipped. A behavioural test would pass on
   this machine either way; what needs pinning is that there is one spawner's
   worth of rules and not two. Same approach `agent-usage-key.test.ts` takes.
*/
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("the adapter's child is launched through the shared invocation", async () => {
  const source = await readFile(
    path.join(packageRoot, "src", "index.ts"),
    "utf8",
  );

  assert.match(source, /spawnInvocation\(/u);
  assert.match(source, /spawn\(invocation\.executable, invocation\.args, \{/u);
  assert.match(
    source,
    /windowsVerbatimArguments: invocation\.windowsVerbatimArguments/u,
  );

  // The failing shape, named so reintroducing it fails here rather than on a
  // Windows desktop three days later. Anchored on the assignment because the
  // comment above that line quotes the shape it is warning against.
  assert.doesNotMatch(source, /this\.child = spawn\(spec\.command/u);

  // And the enrichment, which is what turns "spawn agent ENOENT" into
  // something that says whether the CLI is missing or merely invisible.
  assert.match(source, /explainSpawnFailure\(error, spec\.command, childEnv\)/u);
});
