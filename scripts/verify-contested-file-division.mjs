#!/usr/bin/env node
/**
 * Empirical check that a *contested* file can be granted in part.
 *
 * `verify-patch-division.mjs` proves the patch arithmetic: given a set of
 * withheld lines, the two halves are patches git will apply. This proves the
 * decision that produces those lines — the half that used to be impossible.
 * A file another task is holding used to be withheld whole, on its path alone.
 * Here a real admission is run against a real repository index and the result
 * is carried all the way to `git apply --3way`:
 *
 *   1. a real repository is built and indexed by the real CodeIntelligence
 *      service, so the withheld line ranges are ones a parser produced rather
 *      than ones this script asserted;
 *   2. a real `PlanAdmissionController` arbitrates a candidate that declares
 *      the contested file against a holder that occupies one function in it;
 *   3. an agent edits both its own function and the holder's, and the result
 *      is a real `git diff --binary --full-index`;
 *   4. `splitChangeSet` divides it on the admission's own withheld ranges;
 *   5. the granted half is applied to the base revision and checked to have
 *      landed the agent's own work while leaving every line of the holder's
 *      function byte-identical to base.
 *
 * Step 5 is the claim that matters. Everything before it could be right and
 * still hand another task's code to this one.
 *
 * Run after building:
 *   npx turbo run build
 *   node scripts/verify-contested-file-division.mjs
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const load = async (relative) =>
  import(pathToFileURL(path.resolve(relative)).href);

const { PlanAdmissionController, splitChangeSet } = await load(
  "services/coordinator/dist/index.js",
);
const { reducePlanScope } = await load("packages/shared-types/dist/index.js");
const { CodeIntelligenceService } = await load(
  "services/code-intelligence/dist/index.js",
);
const { RepositoryService } = await load(
  "services/repository-service/dist/index.js",
);

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

const TARGET = "src/pricing/total.js";

/**
 * Two exported functions far enough apart that an edit to each is its own
 * hunk, with module-level code between them that belongs to neither.
 */
const BASE_SOURCE = `const TAX_RATE = 0.2;
const ROUNDING = 2;

export function orderTotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.quantity;
  }
  const taxed = sum * (1 + TAX_RATE);
  return Number(taxed.toFixed(ROUNDING));
}

const SEPARATOR = " ";
const DEFAULT_CURRENCY = "USD";

function pad(value, width) {
  return String(value).padStart(width, SEPARATOR);
}

export function formatTotal(value, currency) {
  const code = currency ?? DEFAULT_CURRENCY;
  const shown = value.toFixed(ROUNDING);
  return pad(shown, 10) + SEPARATOR + code;
}

export function summarize(order) {
  return formatTotal(orderTotal(order.items), order.currency);
}
`;

const root = mkdtempSync(path.join(os.tmpdir(), "coord-contested-"));
const repo = path.join(root, "repo");
mkdirSync(path.join(repo, "src", "pricing"), { recursive: true });
execFileSync("git", ["init", "--quiet", repo]);
git(repo, "config", "user.email", "t@example.com");
git(repo, "config", "user.name", "t");
git(repo, "config", "core.autocrlf", "false");
git(repo, "config", "core.safecrlf", "false");
writeFileSync(path.join(repo, TARGET), BASE_SOURCE);
git(repo, "add", TARGET);
git(repo, "commit", "--quiet", "-m", "base");
const base = git(repo, "rev-parse", "HEAD").trim();

// The index the admission reads the base revision through — the real one, so
// the withheld ranges below are a parser's answer and not this script's.
const intelligence = new CodeIntelligenceService(new RepositoryService());
const index = await intelligence.index(
  { id: "contested", path: path.join(repo, ".git"), branch: "main" },
  base,
);
const symbolRangesInFile = (file) =>
  intelligence.symbolRangesInFile(index, file);

const ranges = symbolRangesInFile(TARGET) ?? [];
const orderTotalRange = ranges.find((entry) => entry.name === "orderTotal");
const formatTotalRange = ranges.find((entry) => entry.name === "formatTotal");
console.log("\nindex");
check("the real index placed both functions", orderTotalRange !== undefined && formatTotalRange !== undefined,
  `(got ${ranges.map((entry) => entry.name).join(", ")})`);
if (orderTotalRange === undefined || formatTotalRange === undefined) {
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
console.log(
  `  orderTotal=${orderTotalRange.startLine}-${orderTotalRange.endLine} ` +
    `formatTotal=${formatTotalRange.startLine}-${formatTotalRange.endLine}`,
);

const planFor = (taskId, overrides) => ({
  taskId,
  objective: `objective for ${taskId}`,
  expectedFiles: [],
  expectedSymbols: [],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
  ...overrides,
});

// The holder never named total.js. It declared `calcTotal`, which does not
// exist, and verification mapped that onto `orderTotal`, which lives there.
const holder = planFor("task_holder", {
  objective: "correct rounding when an order is totalled",
  expectedFiles: ["src/audit/log.js"],
  expectedSymbols: ["calcTotal"],
  grounding: {
    confidence: "grounded",
    revision: base,
    missingFiles: [],
    unresolvedSymbols: ["calcTotal"],
    fileReferents: [],
    symbolReferents: [
      { declared: "calcTotal", resolved: "orderTotal", files: [TARGET] },
    ],
    notes: [],
  },
});

const candidate = planFor("task_candidate", {
  objective: "render a currency prefix when a price is displayed",
  expectedFiles: [TARGET],
  expectedSymbols: ["formatTotal"],
});

console.log("\nadmission");
const admission = new PlanAdmissionController().admit({
  plan: candidate,
  agentId: "agent-candidate",
  baseRevision: base,
  baseVersion: 1,
  active: [{ taskId: holder.taskId, agentId: "agent-holder", plan: holder }],
  symbolRangesInFile,
});
check(
  "the contested file is admitted rather than refused",
  admission.status === "approved_with_constraints",
  `(status ${admission.status}: ${admission.explanation})`,
);
check(
  "the file itself is granted",
  admission.ownershipGrants.some(
    (lease) => lease.resourceType === "file" && lease.resourceId === TARGET,
  ),
);
const withheld = admission.deferredResources ?? [];
check(
  "only the holder's function is withheld",
  withheld.length === 1 &&
    withheld[0].resourceType === "symbol" &&
    withheld[0].resourceId === "orderTotal",
  `(got ${withheld.map((entry) => `${entry.resourceType}:${entry.resourceId}`).join(", ")})`,
);
check(
  "the withholding is stated at the lines the index gave",
  JSON.stringify(withheld[0]?.locations) ===
    JSON.stringify([
      {
        file: TARGET,
        startLine: orderTotalRange.startLine,
        endLine: orderTotalRange.endLine,
      },
    ]),
  `(got ${JSON.stringify(withheld[0]?.locations)})`,
);
if (admission.status !== "approved_with_constraints") {
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}

// The agent does what agents do: it edits its own function, and it also edits
// the one it was told to leave alone.
console.log("\nenforcement");
const edited = BASE_SOURCE.replace(
  "  return pad(shown, 10) + SEPARATOR + code;",
  "  const prefix = code === \"USD\" ? \"$\" : \"\";\n  return prefix + pad(shown, 10) + SEPARATOR + code;",
).replace(
  "  const taxed = sum * (1 + TAX_RATE);",
  "  const taxed = sum * (1 + TAX_RATE) - order.discount;",
);
writeFileSync(path.join(repo, TARGET), edited);
const whole = git(
  repo,
  "diff",
  "--binary",
  "--full-index",
  "--no-ext-diff",
  "--no-renames",
  base,
  "--",
  TARGET,
);

const changeSet = {
  id: "changeset_verify",
  taskId: candidate.taskId,
  baseVersion: 1,
  baseRevision: base,
  patches: [{ path: TARGET, status: "modified", patch: whole }],
  commandsRun: [],
  tests: [],
  dependenciesChanged: [],
  symbolsChanged: ["formatTotal", "orderTotal"],
  riskAssessment: { level: "low", factors: [] },
  agentExplanation: "edited both functions",
  createdAt: new Date().toISOString(),
};

// Exactly what the worker does with a partial admission: the contract is the
// reduced plan, and the changeset is split against it.
const admitted = reducePlanScope(candidate, withheld);
const split = splitChangeSet(admitted, admission, changeSet, symbolRangesInFile);

check("the patch was divided rather than lost whole", split.divided.length === 1,
  `(divided ${JSON.stringify(split.divided)})`);
check("the granted half kept a hunk", split.granted.patches.length === 1);
check("the deferred half kept a hunk", split.deferred.length === 1);
check(
  "nothing escaped the admitted scope",
  split.escaped.length === 0,
  `(escaped ${split.escaped.join(", ")})`,
);

// Fresh checkout at base; apply only what was granted.
const work = path.join(root, "work");
cpSync(repo, work, { recursive: true });
git(work, "checkout", "--quiet", "--force", base, "--", TARGET);
git(work, "reset", "--quiet", base);

const applyPatch = (text, label) => {
  const file = path.join(root, `${label}.patch`);
  writeFileSync(file, text);
  try {
    // The exact flags IntegrationService applies a changeset with, so a patch
    // that passes here is a patch that passes there.
    execFileSync(
      "git",
      ["-C", work, "apply", "--index", "--3way", "--whitespace=error-all", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return true;
  } catch (error) {
    console.log(`       ${String(error.stderr ?? error.message).trim()}`);
    return false;
  }
};

check(
  "the granted half applies to the base revision",
  applyPatch(split.granted.patches[0]?.patch ?? "", "granted"),
);
const afterGranted = readFileSync(path.join(work, TARGET), "utf8");

// The claim the whole feature rests on: the holder's function is untouched.
const baseLines = BASE_SOURCE.split("\n");
const heldLines = baseLines.slice(
  orderTotalRange.startLine - 1,
  orderTotalRange.endLine,
);
const grantedLines = afterGranted.split("\n");
check(
  "every line of the holder's function survived exactly as it was",
  heldLines.every((line) => grantedLines.includes(line)),
  `\n--- holder's lines ---\n${heldLines.join("\n")}\n--- after granted ---\n${afterGranted}`,
);
check(
  "the holder's edit did not sneak through",
  !afterGranted.includes("order.discount"),
);
check(
  "the candidate's own work did land",
  afterGranted.includes("const prefix ="),
);

check(
  "the deferred half applies on top",
  applyPatch(split.deferred[0]?.patch ?? "", "deferred"),
);
check(
  "both halves together equal the undivided change",
  readFileSync(path.join(work, TARGET), "utf8") === edited,
);

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
