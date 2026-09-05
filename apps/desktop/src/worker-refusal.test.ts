import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* Read as text rather than imported: `electron/worker.mjs` pulls in `app` and
   `Menu` from Electron at module scope, so there is no loading it outside a
   running app. The three facts below are structural, and structure is what a
   text test can hold honestly. */
const workerSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
  "worker.mjs",
);

test("a refusal is shown, and is not overwritten by the worker's own noise", async () => {
  // Every line the child writes is reported as `state: "running"` — right for
  // the log it narrates, and exactly wrong for the one message that means the
  // opposite. So the refusal arrives as a signal, and is held in front of the
  // retry countdown that follows it. Without the latch the menu says "Running"
  // fifteen seconds after saying why it is not.
  const source = await readFile(workerSource, "utf8");

  assert.match(
    source,
    /message\?\.type === "registration-refused"/u,
    "the supervisor must understand the signal at all",
  );
  assert.match(
    source,
    /registration-refused"\)\s*\{[\s\S]{0,600}?state:\s*"stopped"/u,
    "and report it as not running, with the control plane's own sentence",
  );
  assert.match(
    source,
    /message\?\.type === "registered"\)\s*\{\s*refusal = undefined;/u,
    "and stop showing it once the worker is actually registered",
  );
  assert.match(
    source,
    /if \(refusal !== undefined\) \{\s*return;\s*\}[\s\S]{0,120}?state: "running"/u,
    "the stdout handler must not paint over a standing refusal",
  );
  assert.match(
    source,
    /child\.once\("exit",[\s\S]{0,120}?refusal = undefined;/u,
    "and a refusal must not outlive the worker it was about",
  );
});

test("a refused worker is not restarted at it", async () => {
  // Restarting a refused worker refuses it again sooner. The child stays alive
  // and retries on its own cadence, so the supervisor's `scheduleRestart` —
  // which counts immediate deaths and gives up after four — is deliberately
  // not involved.
  const source = await readFile(workerSource, "utf8");
  const branch =
    /message\?\.type === "registration-refused"\)\s*\{([\s\S]*?)\}\s*else if/u.exec(
      source,
    )?.[1] ?? "";
  assert.notEqual(branch, "", "the branch must exist to be checked");
  assert.doesNotMatch(
    branch,
    /scheduleRestart|startWorker/u,
    "a refusal is waited out by the child, not restarted by the host",
  );
});

test("COORD_ORGANIZATION overrules discovery, and is said out loud", async () => {
  // It was documented, the worker itself reads it, and through the app it did
  // nothing whatsoever: the child's environment was built as `{...process.env,
  // COORD_ORGANIZATION: tenancy.organizationId}`, so discovery — set last —
  // always won. Silently. That is the wrong shape for an escape hatch, since
  // the moment discovery chooses wrong is exactly the moment somebody needs
  // one, and there was none short of running the bundle by hand.
  const source = await readFile(workerSource, "utf8");

  assert.match(
    source,
    /COORD_ORGANIZATION:\s*\n?\s*process\.env\.COORD_ORGANIZATION\?\.trim\(\) \|\| tenancy\.organizationId/u,
    "an explicit organization must beat the discovered one",
  );
  // Ordering is the whole bug: it has to be read after the spread, not before.
  const spread = source.indexOf("...process.env,");
  const override = source.indexOf("COORD_ORGANIZATION:");
  assert.ok(spread !== -1 && override > spread, "and must be set after the spread");

  assert.match(
    source,
    /set by COORD_ORGANIZATION/u,
    "and the status line must say when it was, or the override is as " +
      "invisible as the bug it exists for",
  );
});
