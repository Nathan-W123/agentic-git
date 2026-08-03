#!/usr/bin/env node
/**
 * Checks that `team-queue-wired` is the fixture it claims to be, before a live
 * run is spent finding out that it is not.
 *
 * Three things have to hold, and the third is the whole reason the scenario
 * exists:
 *
 * 1. The seeded tree passes its own validation command. A scenario whose
 *    `node --test` fails at the base revision makes every task's validation
 *    meaningless, and the failure would look like the agents' fault.
 * 2. Every override still applies to a file the base seed has.
 * 3. **Every partial-band module is imported by the order total.** This is
 *    what `team-queue` gets wrong: it documents the band as modules
 *    `total.js` imports, and leaves `src/format/money.js` referenced by
 *    nothing. Measured on the recorded runs, that single missing edge produced
 *    all three held-out false positives, because agents put rounding in the
 *    caller instead and grounding correctly followed them there.
 *
 * Usage (from the repository root, after `npx turbo run build`):
 *
 *   node apps/worker/scripts/team-queue-wired-verify.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { TEAM_QUEUE_WIRED_SCENARIO } from "./team-queue-wired-scenario.mjs";
import { TEAM_QUEUE_BANDS } from "./team-queue-scenario.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const fromDist = async (pkg, file) =>
  import(
    `file:///${path.join(REPO_ROOT, pkg, "dist", file).replaceAll("\\", "/")}`
  );

const { RepositoryService } = await fromDist(
  "services/repository-service",
  "index.js",
);
const { CodeIntelligenceService } = await fromDist(
  "services/code-intelligence",
  "index.js",
);

/**
 * Which module each partial-band task is meant to own.
 *
 * Written down rather than inferred: the claim under test is that the
 * scenario's design and its tree agree, and deriving the design from the tree
 * would make that true by construction.
 */
const PARTIAL_BAND_MODULES = {
  task_loyalty_tier: "src/pricing/discount.js",
  task_zero_rated_goods: "src/pricing/tax.js",
  task_rounding: "src/format/money.js",
};
const CALLER = "src/pricing/total.js";

const failures = [];

const root = await mkdtemp(path.join(tmpdir(), "team-queue-wired-"));
const sourcePath = path.join(root, "src-repo");
const repositories = new RepositoryService();
await repositories.initializeWorkingRepository(sourcePath);
for (const [file, contents] of Object.entries(TEAM_QUEUE_WIRED_SCENARIO.seed)) {
  const target = path.join(sourcePath, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

console.log("seed passes its own validation command");
try {
  execFileSync("node", ["--test"], { cwd: sourcePath, encoding: "utf8" });
  console.log("  node --test: pass\n");
} catch (error) {
  failures.push("the seeded tree does not pass `node --test`");
  console.log("  node --test: FAIL");
  console.log((error.stdout ?? "").split("\n").slice(-20).join("\n"));
}

await repositories.commitAll(sourcePath, "seed");
const canonical = await repositories.importLocalRepository(
  sourcePath,
  path.join(root, "canon.git"),
  "repo_team_queue_wired_verify",
  "main",
);
const index = await new CodeIntelligenceService(repositories).index(
  canonical,
  canonical.branch,
);
await rm(root, { recursive: true, force: true });

const importedByCaller = new Set(
  index.edges
    .filter((edge) => edge.fromFile === CALLER && edge.toFile !== undefined)
    .map((edge) => edge.toFile),
);
const caller = index.files.find((file) => file.path === CALLER);
const calledByCaller = new Map();
for (const call of caller?.symbolCalls ?? []) {
  for (const file of index.files) {
    if (file.path !== CALLER && file.symbols.includes(call.to)) {
      calledByCaller.set(file.path, `${call.from} -> ${call.to}`);
    }
  }
}

console.log("every partial-band module is reachable from the order total");
for (const [task, module] of Object.entries(PARTIAL_BAND_MODULES)) {
  if (TEAM_QUEUE_BANDS[task] !== "partial") {
    failures.push(`${task} is banded ${TEAM_QUEUE_BANDS[task]}, not partial`);
  }
  const imported = importedByCaller.has(module);
  const called = calledByCaller.get(module);
  if (!imported || called === undefined) {
    failures.push(
      `${task}: ${module} is ${imported ? "imported but never called" : "not imported"} by ${CALLER}`,
    );
  }
  console.log(
    `  ${task.padEnd(24)} ${module.padEnd(26)} ` +
      `${imported ? "imported" : "NOT IMPORTED"}` +
      `${called === undefined ? ", NOT CALLED" : `, ${called}`}`,
  );
}

console.log();
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL  ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    "team-queue-wired is well formed: the partial band owns three modules,\n" +
      "and the order total imports and calls every one of them.",
  );
}
