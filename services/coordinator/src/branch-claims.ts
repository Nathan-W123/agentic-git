/**
 * What an open branch holds, and what that means for the next plan.
 *
 * The coordinator arbitrates a plan against the tasks that are *executing* —
 * `active` is built from live leases. That is exactly right for two agents
 * running at once and blind to the case that actually produces merge
 * conflicts: two tasks an hour apart, on two branches, that never overlap in
 * time and therefore never see each other. The first branch merges, the
 * second tries to catch up, and git reports a collision that the coordinator
 * had every piece of information needed to prevent.
 *
 * This closes that gap by widening what a plan is arbitrated against: not
 * just what is running, but what every other open branch has already landed
 * and not yet merged.
 *
 * Two halves, deliberately treated differently:
 *
 * **The semantic surface is enforced.** Exported symbols, API routes,
 * schemas, config keys and services. These are the cases where a clean merge
 * produces broken software — one branch renames `issueToken`, another adds a
 * caller of the old name, git merges both without a murmur and the build
 * fails. No textual conflict machinery catches that, because there is no
 * textual conflict. They also change rarely, so holding them for a branch's
 * life costs almost nothing.
 *
 * **Line ranges only advise.** Files churn. Making these binding would have a
 * branch open for three days block its files for three days, and the ladder's
 * answer to a task that genuinely must edit a held line would be to sequence
 * it behind a merge that may never come. So they are recorded and reported,
 * and the contention rate can be looked at before anybody decides they should
 * be more than a warning.
 *
 * Everything here is read from what actually landed rather than from what a
 * plan forecast. A forecast is a guess about what a task will touch; a diff
 * is a fact about what it did — narrower, and always true.
 */

import type {
  BranchClaim,
  ClaimedRange,
  RecordBranchClaimInput,
} from "@coord/persistence";
import type { AgentPlan, ChangeSet, FilePatch } from "@coord/shared-types";

import type { ActivePlan } from "./plan-admission.js";

/**
 * The lines a patch changed, on the current side of the file.
 *
 * Read from hunk headers rather than by counting rows: `@@ -a,b +c,d @@`
 * states the new-side start and length outright, and a hunk with no length is
 * one line. Deletions produce a zero-length range at the point of removal,
 * which still collides with an edit there — removing a function and editing
 * it are the same argument.
 */
export function rangesFromPatches(
  patches: readonly FilePatch[],
): ClaimedRange[] {
  const ranges: ClaimedRange[] = [];
  for (const patch of patches) {
    for (const line of patch.patch.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if (hunk === null) {
        continue;
      }
      const start = Number(hunk[1]);
      const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (!Number.isFinite(start)) {
        continue;
      }
      ranges.push({
        file: patch.path,
        start,
        // Half-open, so adjacency is not overlap: [10,12) and [12,14) touch
        // and do not collide, which is what two edits on neighbouring lines
        // actually are.
        end: start + (Number.isFinite(length) ? length : 1),
      });
    }
  }
  return ranges;
}

function declared(
  plan: AgentPlan | undefined,
  key: "apis" | "schemas" | "configKeys" | "services",
  fallback: readonly string[] | undefined,
): string[] {
  if (plan === undefined) {
    return [];
  }
  const fromDeclarations = plan.declared?.[key];
  return [...(fromDeclarations ?? fallback ?? [])];
}

/**
 * What a branch should hold, having just had this changeset land on it.
 *
 * `symbolsChanged` comes off the changeset because the integration already
 * computed it from the diff. The rest come off the plan: a route or a schema
 * is a statement about intent that a diff cannot always be read back into,
 * and the plan is where the agent said it.
 */
export function claimFromChangeSet(input: {
  repositoryId: string;
  branch: string;
  revision: string;
  changeSet: ChangeSet;
  plan?: AgentPlan;
}): RecordBranchClaimInput {
  return {
    repositoryId: input.repositoryId,
    branch: input.branch,
    taskId: input.changeSet.taskId,
    revision: input.revision,
    symbols: [...input.changeSet.symbolsChanged],
    apis: declared(input.plan, "apis", input.plan?.expectedApis),
    schemas: declared(input.plan, "schemas", input.plan?.expectedSchemas),
    configKeys: declared(
      input.plan,
      "configKeys",
      input.plan?.expectedConfigKeys,
    ),
    services: declared(input.plan, "services", input.plan?.expectedServices),
    ranges: rangesFromPatches(input.changeSet.patches),
  };
}

/**
 * Branch claims, dressed as plans so the existing ladder can arbitrate them.
 *
 * Synthetic rather than a second decision path, because everything needed is
 * already built: the detector compares seven dimensions, the ladder answers
 * approved / narrowed / sequenced / blocked, and the narrowing and freezing
 * logic has been through several rounds of real use. Adding a parallel
 * mechanism for branches would mean two things to keep in step, and the
 * second one would be the one nobody remembers.
 *
 * **The whole surface goes in, including files, and something else narrows
 * it.** `narrowToBranch` already reduces a plan from another branch through
 * `interfaceScopeOf`, which keeps what crosses between branches — routes,
 * schemas, config keys, exported symbols, and interface files like
 * migrations and dependency manifests — and drops what is local, ordinary
 * source files included. That is exactly the line between the enforced half
 * and the advisory one, drawn once, in the place that already had to draw it
 * for two agents running at the same time. An `expectedFiles: []` here would
 * be a second, blunter copy of the same rule, and the two would drift.
 */
export function branchClaimsAsActivePlans(
  claims: readonly BranchClaim[],
): ActivePlan[] {
  return claims
    .map((claim) => ({
      taskId: claim.taskId,
      agentId: `branch:${claim.branch}`,
      plan: {
        taskId: claim.taskId,
        objective: `work already landed on ${claim.branch}`,
        // Every file the claim actually touched. `interfaceScopeOf` keeps
        // only the ones that cross — a migration, a manifest — and drops the
        // rest, so an ordinary source file two branches both edited stays
        // advisory without this having to know which is which.
        expectedFiles: [...new Set(claim.ranges.map((range) => range.file))],
        expectedSymbols: [...claim.symbols],
        expectedApis: [...claim.apis],
        expectedSchemas: [...claim.schemas],
        expectedConfigKeys: [...claim.configKeys],
        expectedServices: [...claim.services],
        dependencies: [],
        commands: [],
        externalAccess: [],
        riskLevel: "medium",
        declared: {
          symbols: [...claim.symbols],
          apis: [...claim.apis],
          schemas: [...claim.schemas],
          configKeys: [...claim.configKeys],
          services: [...claim.services],
          // Empty rather than absent: `asDeclared` falls back to the enriched
          // list when `declared` is missing, and an absent `files` key with a
          // present `declared` object is the shape that means "declared
          // nothing", which is what this is.
          tests: [],
          dependencies: [],
        },
      } satisfies AgentPlan,
    }));
}

/** One place a plan is about to edit that another branch already changed. */
export interface RangeWarning {
  branch: string;
  taskId: string;
  file: string;
  /** The claimed range, so the message can name the lines rather than the file. */
  start: number;
  end: number;
  since: string;
}

/**
 * Where this plan's files meet lines another open branch has already changed.
 *
 * File-level, not range-level, on the plan's side: a plan says which files it
 * expects to touch and cannot say which lines, so the honest comparison is
 * "you are about to edit a file somebody else has changed, here specifically".
 * Naming the lines is what makes it worth reading — "src/login.ts is busy" is
 * true of most files in most repositories and teaches somebody to ignore it.
 */
export function rangeWarnings(
  plan: AgentPlan,
  claims: readonly BranchClaim[],
): RangeWarning[] {
  const wanted = new Set(plan.expectedFiles);
  const warnings: RangeWarning[] = [];
  for (const claim of claims) {
    for (const range of claim.ranges) {
      if (!wanted.has(range.file)) {
        continue;
      }
      warnings.push({
        branch: claim.branch,
        taskId: claim.taskId,
        file: range.file,
        start: range.start,
        end: range.end,
        since: claim.createdAt,
      });
    }
  }
  return warnings;
}

/**
 * The warnings as one sentence per file, oldest holder first.
 *
 * Collapsed per file because a task that rewrote a module produced a hunk
 * every few lines, and thirty ranges in one file is a wall nobody reads. The
 * count is kept, because "in 30 places" and "in one place" are different
 * situations.
 */
export function describeRangeWarnings(warnings: readonly RangeWarning[]): string[] {
  const byKey = new Map<string, RangeWarning[]>();
  for (const warning of warnings) {
    const key = `${warning.branch}\u0000${warning.file}`;
    byKey.set(key, [...(byKey.get(key) ?? []), warning]);
  }
  return [...byKey.values()]
    .sort((a, b) => (a[0]?.since ?? "").localeCompare(b[0]?.since ?? ""))
    .map((group) => {
      const first = group[0];
      if (first === undefined) {
        return "";
      }
      const places =
        group.length === 1
          ? `lines ${String(first.start)}–${String(first.end - 1)}`
          : `${String(group.length)} places`;
      return (
        `${first.file}: #${first.branch.replace(/^kumi\//u, "")} has already ` +
        `changed ${places} here and has not merged yet.`
      );
    })
    .filter((line) => line !== "");
}
