#!/usr/bin/env node
/**
 * Does the "narrow holder" shape actually convert into a partial grant?
 *
 * `docs/benchmarks/partial-admission-granularity.md` counts how often real
 * recorded plans produce the shape the rule needs — a plan reaching into a file
 * it never declared, through a symbol verification placed there — and puts it
 * at 31 of 94 tracked grounding records (33%). That page is careful to say what
 * it is not:
 *
 *   > This counts the *holder* shape and nothing more. Whether one becomes a
 *   > partial grant also needs a candidate that declared the same path, an
 *   > index that places every symbol reaching in, and the two to be executing
 *   > at once — none of which this measures.
 *
 * This script measures exactly that gap: of the holder shapes the corpus really
 * contains, how many convert into a real partial grant when a real candidate
 * plan is arbitrated against them.
 *
 * Everything on the deciding path is the shipped implementation:
 *
 *   - the repository is the benchmark scenario's own seed tree, built as a real
 *     Git repository and indexed by the real `CodeIntelligenceService`, so the
 *     withheld line ranges are a parser's answer;
 *   - both sides of every pair are **plans real agents really produced**, read
 *     out of the committed grounding corpus — not plans this script invented;
 *   - the decision is a real `PlanAdmissionController.admit`.
 *
 * No agent runs here, scripted or otherwise. That is deliberate rather than a
 * shortcut: admission is a pure function of the two plans and the index, so an
 * adapter replaying a fixture plan would contribute nothing to the decision
 * while adding a workspace, a run loop, and a changeset to it. Using the
 * recorded plans directly is both cheaper and *stronger* evidence, because the
 * plan shapes are real agent output rather than fixtures chosen by the author
 * of the harness.
 *
 * Only committed corpus files are read, so the figure is reproducible at this
 * revision.
 *
 * Run after building:
 *   npx turbo run build
 *   node scripts/measure-contested-file-conversion.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const load = async (relative) =>
  import(pathToFileURL(path.resolve(relative)).href);

const { PlanAdmissionController } = await load(
  "services/coordinator/dist/index.js",
);
const { CodeIntelligenceService } = await load(
  "services/code-intelligence/dist/index.js",
);
const { RepositoryService } = await load(
  "services/repository-service/dist/index.js",
);
const { LIVE_CHECKOUT_TRIO_SCENARIO } = await load(
  "apps/cli/dist/live-scenario.js",
);

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/** The committed corpus only — untracked samples another session is still
 * writing would make this figure unreproducible. */
const tracked = execFileSync(
  "git",
  ["ls-files", "docs/benchmarks/data/grounding"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter((entry) => entry.endsWith(".json"));

/**
 * Every plan-grounding record in the corpus, whatever record shape holds it.
 *
 * The families differ — the before/after runs carry `plans[]`, the substitution
 * runs carry `firstPlan` and one plan per arm — so records are found by their
 * `grounding` key rather than by a per-family path.
 */
function groundingRecords(node, file, trail = []) {
  const found = [];
  if (Array.isArray(node)) {
    for (const [at, entry] of node.entries()) {
      found.push(...groundingRecords(entry, file, [...trail, String(at)]));
    }
    return found;
  }
  if (node === null || typeof node !== "object") {
    return found;
  }
  if (
    typeof node.grounding === "object" &&
    node.grounding !== null &&
    Array.isArray(node.expectedFiles)
  ) {
    found.push({ file, at: trail.join("."), plan: node });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "grounding") {
      continue;
    }
    found.push(...groundingRecords(value, file, [...trail, key]));
  }
  return found;
}

const records = [];
for (const file of tracked) {
  const parsed = JSON.parse(
    execFileSync("git", ["show", `HEAD:${file}`], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  records.push(...groundingRecords(parsed, file));
}

/**
 * The holder shape: a file the plan reaches only because verification placed a
 * declared symbol there. A file the plan named outright, or reached through a
 * `fileReferents` mapping, is the plan's whole and is never narrowed.
 */
function reachedOnlyBySymbol(plan) {
  const declared = new Set(plan.expectedFiles ?? []);
  const mapped = new Set(
    (plan.grounding?.fileReferents ?? []).flatMap((entry) =>
      entry.resolved === undefined ? (entry.files ?? []) : [entry.resolved],
    ),
  );
  const reached = new Map();
  for (const referent of plan.grounding?.symbolReferents ?? []) {
    for (const file of referent.files ?? []) {
      if (declared.has(file) || mapped.has(file)) {
        continue;
      }
      const entry = reached.get(file) ?? [];
      entry.push(referent);
      reached.set(file, entry);
    }
  }
  return reached;
}

const holders = [];
for (const record of records) {
  const reached = reachedOnlyBySymbol(record.plan);
  for (const [file, referents] of reached) {
    holders.push({ ...record, contested: file, referents });
  }
}

const bySlot = new Map();
for (const record of records) {
  const slot = record.at.split(".")[0] ?? "(root)";
  bySlot.set(slot, (bySlot.get(slot) ?? 0) + 1);
}
console.log(
  `corpus: ${String(records.length)} grounding records in ${String(tracked.length)} committed files`,
);
console.log(
  `  by slot: ${[...bySlot].map(([slot, count]) => `${slot}=${String(count)}`).join(" ")}`,
);
// `partial-admission-granularity.md` quotes 31/94 = 33%. Its denominator is the
// `plans` and `firstPlan` slots — the plans agents submitted. The `arms` slots
// are the post-replan outcomes of the substitution experiment, which is why
// none of them carries the shape: by then the agent has adopted the real name.
const submitted = (bySlot.get("plans") ?? 0) + (bySlot.get("firstPlan") ?? 0);
console.log(
  `  submitted-plan slots (the denominator used in partial-admission-granularity.md): ${String(submitted)}`,
);
console.log(
  `holder shape: ${String(new Set(holders.map((entry) => `${entry.file}#${entry.at}`)).size)} records ` +
    `reach a file they never declared (${String(holders.length)} record/file pairs)`,
);

if (holders.length === 0) {
  console.log("\nnothing to convert; stopping");
  process.exit(0);
}

// The repository the corpus was produced against: the benchmark scenario's own
// seed tree, rebuilt byte-for-byte. Symbol ranges therefore match the ones the
// recorded runs saw.
const root = mkdtempSync(path.join(os.tmpdir(), "coord-conversion-"));
const repo = path.join(root, "repo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "--quiet", repo]);
git(repo, "config", "user.email", "t@example.com");
git(repo, "config", "user.name", "t");
git(repo, "config", "core.autocrlf", "false");
for (const [file, contents] of Object.entries(LIVE_CHECKOUT_TRIO_SCENARIO.seed)) {
  const target = path.join(repo, ...file.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
git(repo, "add", "-A");
git(repo, "commit", "--quiet", "-m", "seed");
const base = git(repo, "rev-parse", "HEAD").trim();

const intelligence = new CodeIntelligenceService(new RepositoryService());
const index = await intelligence.index(
  { id: "conversion", path: path.join(repo, ".git"), branch: "main" },
  base,
);
const symbolRangesInFile = (file) => intelligence.symbolRangesInFile(index, file);

/**
 * Candidates are recorded plans too: every plan in the corpus that *declared* a
 * contested path outright. That is the other half the rule needs, and the
 * corpus contains it because the trio scenario really does put a misnaming task
 * and a correctly-naming task on the same file at the same time.
 */
const candidatesByFile = new Map();
for (const record of records) {
  for (const file of record.plan.expectedFiles ?? []) {
    const entry = candidatesByFile.get(file) ?? [];
    entry.push(record);
    candidatesByFile.set(file, entry);
  }
}

const asPlan = (record, taskId, extra = {}) => ({
  taskId,
  objective: record.plan.intent ?? "recorded objective",
  expectedFiles: record.plan.expectedFiles ?? [],
  expectedSymbols: record.plan.expectedSymbols ?? [],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
  grounding: {
    confidence: record.plan.grounding?.confidence ?? "grounded",
    revision: base,
    missingFiles: record.plan.grounding?.missingFiles ?? [],
    unresolvedSymbols: record.plan.grounding?.unresolvedSymbols ?? [],
    fileReferents: record.plan.grounding?.fileReferents ?? [],
    symbolReferents: record.plan.grounding?.symbolReferents ?? [],
    notes: [],
  },
  ...extra,
});

const controller = new PlanAdmissionController();
const outcomes = [];

for (const holder of holders) {
  const pool = (candidatesByFile.get(holder.contested) ?? []).filter(
    (entry) => entry.file !== holder.file || entry.at !== holder.at,
  );
  if (pool.length === 0) {
    outcomes.push({ holder, outcome: "no-candidate-in-corpus" });
    continue;
  }
  for (const candidateRecord of pool) {
    const holderPlan = asPlan(holder, "task_holder");
    const candidatePlan = asPlan(candidateRecord, "task_candidate");
    let admission;
    try {
      admission = controller.admit({
        plan: candidatePlan,
        agentId: "agent-candidate",
        baseRevision: base,
        baseVersion: 1,
        active: [
          {
            taskId: holderPlan.taskId,
            agentId: "agent-holder",
            plan: holderPlan,
          },
        ],
        symbolRangesInFile,
      });
    } catch (error) {
      outcomes.push({
        holder,
        candidate: candidateRecord,
        outcome: "error",
        detail: String(error?.message ?? error),
      });
      continue;
    }

    const grantedFile = admission.ownershipGrants?.some(
      (lease) =>
        lease.resourceType === "file" && lease.resourceId === holder.contested,
    );
    const withheld = admission.deferredResources ?? [];
    const withheldSymbolsHere = withheld.filter(
      (entry) =>
        entry.resourceType === "symbol" &&
        (entry.locations ?? []).some((at) => at.file === holder.contested),
    );
    const withheldWholeFile = withheld.some(
      (entry) =>
        entry.resourceType === "file" && entry.resourceId === holder.contested,
    );

    let outcome;
    if (admission.status === "approved") {
      // Nothing was contested at all: the two plans never met inside the file.
      outcome = "no-contest";
    } else if (grantedFile && withheldSymbolsHere.length > 0) {
      outcome = "partial-grant";
    } else if (grantedFile) {
      outcome = "granted-whole";
    } else if (withheldWholeFile) {
      outcome = "file-withheld-whole";
    } else {
      outcome = admission.status;
    }

    outcomes.push({
      holder,
      candidate: candidateRecord,
      outcome,
      status: admission.status,
      withheld: withheldSymbolsHere.map((entry) => entry.resourceId),
    });
  }
}

const tally = new Map();
for (const entry of outcomes) {
  tally.set(entry.outcome, (tally.get(entry.outcome) ?? 0) + 1);
}

console.log(
  `\ncandidate pairings arbitrated: ${String(outcomes.length)} ` +
    `(real recorded holder x real recorded candidate)`,
);
console.log("\noutcome                     count    share");
for (const [outcome, count] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log(
    `  ${outcome.padEnd(24)} ${String(count).padStart(5)}   ` +
      `${((100 * count) / outcomes.length).toFixed(1)}%`,
  );
}

const partial = tally.get("partial-grant") ?? 0;
console.log(
  `\npartial admission fired on ${String(partial)}/${String(outcomes.length)} pairings ` +
    `(${((100 * partial) / outcomes.length).toFixed(1)}%)`,
);

/** Per holder: did any real candidate in the corpus convert it? */
const byHolder = new Map();
for (const entry of outcomes) {
  const key = `${entry.holder.file}#${entry.holder.at}#${entry.holder.contested}`;
  const current = byHolder.get(key) ?? false;
  byHolder.set(key, current || entry.outcome === "partial-grant");
}
const converted = [...byHolder.values()].filter(Boolean).length;
console.log(
  `holders convertible by at least one recorded candidate: ` +
    `${String(converted)}/${String(byHolder.size)} ` +
    `(${((100 * converted) / byHolder.size).toFixed(1)}%)`,
);

/**
 * The same figure over *distinct* plan shapes.
 *
 * The corpus is deliberately repetitive — the substitution runs are the same
 * scenario sampled dozens of times — so the raw pairing count above is mostly
 * one pair counted many times. Collapsing identical (holder, candidate)
 * declarations is the number to quote.
 */
const shape = (record) =>
  JSON.stringify([
    record.plan.expectedFiles ?? [],
    record.plan.expectedSymbols ?? [],
    (record.plan.grounding?.symbolReferents ?? []).map((entry) => [
      entry.declared,
      entry.resolved,
      entry.files,
    ]),
  ]);

const distinct = new Map();
for (const entry of outcomes) {
  if (entry.candidate === undefined) {
    continue;
  }
  const key = `${shape(entry.holder)}\0${shape(entry.candidate)}\0${entry.holder.contested}`;
  if (!distinct.has(key)) {
    distinct.set(key, entry.outcome);
  }
}
const distinctTally = new Map();
for (const outcome of distinct.values()) {
  distinctTally.set(outcome, (distinctTally.get(outcome) ?? 0) + 1);
}
console.log(
  `\ndistinct (holder shape, candidate shape) pairs: ${String(distinct.size)}`,
);
for (const [outcome, count] of [...distinctTally].sort((a, b) => b[1] - a[1])) {
  console.log(
    `  ${outcome.padEnd(24)} ${String(count).padStart(4)}   ` +
      `${((100 * count) / distinct.size).toFixed(1)}%`,
  );
}

const blocked = outcomes.filter((entry) => entry.outcome === "blocked");
if (blocked.length > 0) {
  // The interesting split is not which files the candidate named — the blocked
  // and converted candidates name the same ones — but whether the candidate
  // claims the very symbol the holder occupies. Removing a file from a plan
  // cannot remove a symbol both plans still want, so those refuse whole.
  const reasons = new Map();
  for (const entry of blocked) {
    const holderSymbols = new Set(
      (entry.holder.referents ?? []).map((referent) => referent.resolved),
    );
    const clash = (entry.candidate?.plan.expectedSymbols ?? []).filter(
      (symbol) => holderSymbols.has(symbol),
    );
    const key =
      clash.length > 0
        ? `candidate also claims the holder's symbol: ${clash.join(", ")}`
        : "no shared symbol; refused for another reason";
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  console.log("\nwhy the rest were refused outright");
  for (const [key, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
}

const contestedFiles = new Map();
for (const entry of outcomes) {
  if (entry.outcome !== "partial-grant") {
    continue;
  }
  const key = `${entry.holder.contested} — withheld ${entry.withheld.join(", ")}`;
  contestedFiles.set(key, (contestedFiles.get(key) ?? 0) + 1);
}
if (contestedFiles.size > 0) {
  console.log("\nwhat was withheld, where");
  for (const [key, count] of [...contestedFiles].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
}

rmSync(root, { recursive: true, force: true });
