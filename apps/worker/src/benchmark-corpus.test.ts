import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The committed benchmark corpus is evidence, so it is kept — but only the
 * parts of it that something reads.
 *
 * `team-queue-experiment.mjs` builds an `iterations` array per run and reduces
 * it into `metrics`. It also used to serialise the raw array into the result
 * file, and nothing ever read that back: every consumer — `team-queue-report`,
 * `intent-signal-eval`, `intent-relation-inputs`, `summarize-grounding-runs` —
 * takes `metrics`, `plans`, `tasks` and `outcome`. Across twenty-five runs the
 * unread field was 180,511 lines and 4.35 MB, which was 68% of the whole
 * corpus by bytes and 80% of it by line.
 *
 * The harness now writes it only under `--trace`. This is what stops a traced
 * debugging run from being committed by accident and putting it all back.
 */
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function committedRunFiles(): string[] {
  const listed = execFileSync(
    "git",
    ["ls-files", "docs/benchmarks/**/*.json"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  return listed.split("\n").filter((line) => line.endsWith(".json"));
}

test("no committed benchmark run carries the unread per-lease trace", async () => {
  const files = committedRunFiles();
  assert.ok(
    files.length > 50,
    `expected the benchmark corpus, found ${files.length} files`,
  );

  const offenders: string[] = [];
  for (const file of files) {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(REPOSITORY_ROOT, file), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "iterations" in parsed
    ) {
      offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these runs were committed with `--trace` output; re-run without it, or " +
      "strip the `iterations` key before committing",
  );
});

test("the harness keeps the trace behind a flag rather than writing it always", async () => {
  const source = await readFile(
    path.join(REPOSITORY_ROOT, "apps/worker/scripts/team-queue-experiment.mjs"),
    "utf8",
  );

  // The array itself must still be built — `metrics` is a reduction over it,
  // so removing it outright would silently zero half the reported numbers.
  assert.match(source, /const iterations = \[\];/u);
  assert.match(source, /summarize\(iterations, records, tasks\)/u);

  // ...but reach the file only when asked for.
  assert.match(source, /const keepTrace = process\.argv\.includes\("--trace"\)/u);
  assert.match(source, /\.\.\.\(keepTrace\n?\s*\?\s*\{\n?\s*iterations:/u);
});
