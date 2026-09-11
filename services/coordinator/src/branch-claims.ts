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
  ClaimedShape,
  MovedResources,
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
 * `resources` is what the *changed files actually contain*, read back out of
 * the repository index at the revision that just landed — see
 * `CodeIntelligenceService.changedResources`. Pass it and nothing here is a
 * guess.
 *
 * Without it this falls back to the plan, and the fallback is worth naming
 * because it is weaker in both directions. A plan is written before the work:
 * an agent that forecast one config key and used two leaves the second
 * unclaimed, so another branch changes it unopposed; an agent that forecast
 * three and used one holds two nobody touched for the life of the branch. It
 * under-claims what was done and over-claims what was not.
 *
 * `changeSet.symbolsChanged` is *not* the diff either, which is easy to
 * assume and wrong: on the worker path it is a field the agent fills in
 * itself — see the output schema in `adapters/codex` — so it is the agent's
 * own account, not something computed. It is used only as a fallback, for the
 * same reason the plan is.
 */
export function claimFromChangeSet(input: {
  repositoryId: string;
  branch: string;
  revision: string;
  changeSet: ChangeSet;
  plan?: AgentPlan;
  /**
   * What the changed files hold, read from the index at the landed revision.
   *
   * The whole difference between a claim that is true and one that is a
   * forecast. Optional only so a caller that cannot index — a store-less
   * coordinator, an indexer that failed — still records something rather
   * than nothing.
   */
  resources?: {
    symbols: readonly string[];
    apis: readonly string[];
    schemas: readonly string[];
    configKeys: readonly string[];
    services: readonly string[];
  };
  /**
   * The exported contracts in the changed files, as this branch left them,
   * and who depends on them.
   *
   * Every exported shape in every file the diff touched, not only the ones
   * that moved — and that over-claim is deliberate, because the comparison is
   * by digest. Two branches that both edited `auth.ts` without touching
   * `sign` record the same digest for it and do not contend; two that left it
   * in different states record different ones and do. Recording "what I
   * changed" instead would need the shape at the base as well, and would
   * answer a narrower question less reliably.
   */
  contracts?: {
    shapes: readonly ClaimedShape[];
  };
  /**
   * Which of the recorded names the branch actually changed against
   * canonical; see {@link movedAgainstCanonical}. Left out when nobody
   * compared, and recorded as left out: the first version of this took it
   * in and did not write it, so every claim read as unmeasured and the
   * fast path was refused on presence alone.
   */
  movedResources?: MovedResources;
}): RecordBranchClaimInput {
  const observed = input.resources;
  return {
    ...(input.movedResources === undefined
      ? {}
      : { movedResources: input.movedResources }),
    repositoryId: input.repositoryId,
    branch: input.branch,
    taskId: input.changeSet.taskId,
    revision: input.revision,
    symbols: [...(observed?.symbols ?? input.changeSet.symbolsChanged)],
    apis: [...(observed?.apis ?? declared(input.plan, "apis", input.plan?.expectedApis))],
    schemas: [
      ...(observed?.schemas ??
        declared(input.plan, "schemas", input.plan?.expectedSchemas)),
    ],
    configKeys: [
      ...(observed?.configKeys ??
        declared(input.plan, "configKeys", input.plan?.expectedConfigKeys)),
    ],
    services: [
      ...(observed?.services ??
        declared(input.plan, "services", input.plan?.expectedServices)),
    ],
    ranges: rangesFromPatches(input.changeSet.patches),
    shapes: [...(input.contracts?.shapes ?? [])],
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

/**
 * Whether what a branch holds could reach another branch at all.
 *
 * Asked by the blanket fast path, which grants a lone task the whole
 * repository without planning and therefore without arbitrating against
 * anything. That path used to refuse the moment *any* branch held *anything*,
 * and the effect was that a solo task almost never got a blanket claim again:
 * claims last as long as their branch, so one open work channel with a
 * commit on it was enough to put every later task through a full planning
 * round for nothing.
 *
 * The fields tested are the ones `interfaceScopeOf` says always cross —
 * routes, schemas, config keys, services — plus the exported contracts, which
 * are exported by construction. **`symbols` is deliberately not among them.**
 * A claim's symbol list is every symbol in every file the diff touched,
 * exported or not, and a branch that changed one private helper claims the
 * whole file's worth. Treating that as "crosses branches" is the over-claim
 * `interfaceScopeOf` exists to filter; excluding it here applies the same
 * filter the planned path applies, without needing an index the fast path
 * deliberately does not build.
 *
 * The gap that leaves, stated rather than hidden: in a language whose
 * contracts this deployment cannot read, an exported symbol appears in
 * `symbols` with no shape beside it, and reads here as quiet. The planned
 * path is more careful — `interfaceScopeOf` keeps a symbol whose visibility
 * is unknown — so the fast path is the less conservative of the two for
 * exactly those repositories. What catches it afterwards is what caught it
 * before any of this existed: a textual conflict at the merge.
 */
export function claimCrossesBranches(claim: BranchClaim): boolean {
  const moved = claim.movedResources;
  return (
    namesCross(claim.apis, moved?.apis) ||
    namesCross(claim.schemas, moved?.schemas) ||
    namesCross(claim.configKeys, moved?.configKeys) ||
    namesCross(claim.services, moved?.services) ||
    shapesCross(claim.shapes)
  );
}

/**
 * Whether a dimension's names are ones this branch actually changed.
 *
 * The same distinction `shapesCross` draws, for the four name lists. A claim
 * records every route in every file its diff touched, so a branch that edited
 * a comment in a routes file claims every route that file declares — and read
 * as presence, that is a branch holding the repository against everybody.
 *
 * `moved` is the measured answer: names added or removed against canonical.
 * Absent means nobody measured, and falls back to presence rather than to
 * "nothing changed", for the same reason as everywhere else here — a
 * comparison that did not happen must not read like one that came back clean.
 */
function namesCross(
  recorded: readonly string[],
  moved: readonly string[] | undefined,
): boolean {
  return moved === undefined ? recorded.length > 0 : moved.length > 0;
}

/**
 * Whether a claim's contracts are ones this branch actually moved.
 *
 * The first version of this asked `shapes.length > 0`, which is the same
 * mistake `symbols` was excluded for, one level down. A claim records every
 * exported shape in every file its diff touched — changed or not — so a
 * branch that fixed a typo in a private helper, in a file that happens to
 * export anything, reads here as holding a contract. Almost every branch
 * does. The fast path was refused for almost every solo task, for as long as
 * any other channel stayed open.
 *
 * `moved` settles it where it was measured. Where it was not — an older claim
 * written before this existed, or a canonical index that would not build —
 * there is no measurement to read, and this falls back to the presence test
 * it used to be. Falling back rather than assuming: "we did not check" and
 * "we checked and it is fine" are different answers, and a reader that
 * conflated them would quietly widen the fast path every time indexing
 * hiccuped, which is exactly when being careful matters.
 *
 * "Did we check" is inferred rather than stored: a comparison that ran marks
 * every shape it saw, `true` or `false`, so a claim counts as measured only
 * when all of them carry a mark. Demanding all rather than any is the safe
 * reading of a state that should not arise — a half-marked claim means
 * something went wrong, and the answer to that is the blunt test, not a
 * confident one built on the half that happens to be there.
 */
function shapesCross(shapes: readonly ClaimedShape[]): boolean {
  const measured = shapes.every((shape) => shape.moved !== undefined);
  return measured
    ? shapes.some((shape) => shape.moved === true)
    : shapes.length > 0;
}

/**
 * The names a branch added or removed against canonical, per dimension.
 *
 * Set difference both ways: a route the branch declares that canonical does
 * not is added, one canonical declares that the branch does not is removed,
 * and both are the branch having moved something. A name on both sides is a
 * file that was touched without that route changing — the case this exists to
 * stop reading as a hold.
 */
export function movedAgainstCanonical(
  branch: {
    apis: readonly string[];
    schemas: readonly string[];
    configKeys: readonly string[];
    services: readonly string[];
  },
  canonical: {
    apis: readonly string[];
    schemas: readonly string[];
    configKeys: readonly string[];
    services: readonly string[];
  },
): MovedResources {
  const differing = (
    mine: readonly string[],
    theirs: readonly string[],
  ): string[] => {
    const here = new Set(mine);
    const there = new Set(theirs);
    return [
      ...mine.filter((name) => !there.has(name)),
      ...theirs.filter((name) => !here.has(name)),
    ].sort();
  };
  return {
    apis: differing(branch.apis, canonical.apis),
    schemas: differing(branch.schemas, canonical.schemas),
    configKeys: differing(branch.configKeys, canonical.configKeys),
    services: differing(branch.services, canonical.services),
  };
}
