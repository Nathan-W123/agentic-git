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
}): RecordBranchClaimInput {
  const observed = input.resources;
  return {
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
 * One contract another open branch has left in a state canonical does not
 * share, that this plan is about to build on or edit.
 *
 * The case the whole contract layer exists for, and the one nothing here
 * could see before: two branches whose files never meet, whose symbol *names*
 * are identical, and whose merge git performs without a word.
 */
export interface ContractWarning {
  branch: string;
  taskId: string;
  file: string;
  symbol: string;
  /** What that branch left the contract as. */
  shape: string;
  /** What canonical still says it is, or `undefined` if it is new there. */
  canonical: string | undefined;
  /**
   * How this plan meets it.
   *
   * `contract` — the plan edits the contract itself, which is the collision
   * the symbol-name comparison already catches; it is repeated here with the
   * shapes so the reason can say what actually differs.
   *
   * `consumer` — the plan edits a file built on it. This is the new one, and
   * the reason the dependency map needed a reverse.
   */
  via: "contract" | "consumer";
  /** The plan's file that meets it, for the sentence. */
  through: string;
  /** That contract is partly inferred, so this comparison is partly blind. */
  inferred?: boolean;
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
  return (
    claim.apis.length > 0 ||
    claim.schemas.length > 0 ||
    claim.configKeys.length > 0 ||
    claim.services.length > 0 ||
    claim.shapes.length > 0
  );
}

/**
 * How a contract is addressed in the map {@link contractWarnings} takes.
 *
 * Exported because the caller builds that map and this reads it: two
 * different spellings of the same key is a comparison that silently finds
 * nothing, which looks exactly like a repository with no contention in it.
 */
export function contractKey(file: string, symbol: string): string {
  return `${file}\u0000${symbol}`;
}

/**
 * Where this plan meets a contract another branch has already moved.
 *
 * `canonical` is what the repository's own branch says these contracts are
 * *now*. A claim records every exported shape in the files its branch
 * touched, changed or not, so this is what separates the two: a shape whose
 * digest matches canonical is one the branch left alone, and only a shape
 * that differs is a contract that has moved somewhere and not everywhere.
 *
 * That comparison is also what makes the over-claim harmless. Two branches
 * that both edited `auth.ts` without touching `sign` record identical digests
 * for it, agree with canonical, and produce nothing.
 */
export function contractWarnings(input: {
  plan: AgentPlan;
  claims: readonly BranchClaim[];
  canonical: ReadonlyMap<string, ClaimedShape>;
}): ContractWarning[] {
  const files = new Set(input.plan.expectedFiles);
  const symbols = new Set(input.plan.expectedSymbols);
  const warnings: ContractWarning[] = [];
  for (const claim of input.claims) {
    for (const shape of claim.shapes) {
      const here = input.canonical.get(contractKey(shape.file, shape.symbol));
      // Unchanged against canonical is not a contract that moved. A shape
      // canonical has never heard of is: the branch added an export, and
      // anything already calling that name was calling something else.
      if (here !== undefined && here.digest === shape.digest) {
        continue;
      }
      const meeting =
        files.has(shape.file) || symbols.has(shape.symbol)
          ? { via: "contract" as const, through: shape.file }
          : (() => {
              const consumed = shape.consumers.find((file) => files.has(file));
              return consumed === undefined
                ? undefined
                : { via: "consumer" as const, through: consumed };
            })();
      if (meeting === undefined) {
        continue;
      }
      warnings.push({
        branch: claim.branch,
        taskId: claim.taskId,
        file: shape.file,
        symbol: shape.symbol,
        shape: shape.shape,
        canonical: here?.shape,
        ...meeting,
        ...(shape.inferred === true ? { inferred: true } : {}),
      });
    }
  }
  return warnings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.symbol.localeCompare(right.symbol) ||
      left.branch.localeCompare(right.branch),
  );
}

/**
 * The warnings as sentences, the contract this plan edits before the ones it
 * merely consumes.
 *
 * Ordered that way because they are different problems. Editing a contract
 * somebody else has already moved is a collision to resolve; consuming one is
 * a thing to know before writing code against a shape that is on its way out.
 */
export function describeContractWarnings(
  warnings: readonly ContractWarning[],
): string[] {
  const branch = (name: string): string => `#${name.replace(/^kumi\//u, "")}`;
  return [...warnings]
    .sort((left, right) =>
      left.via === right.via ? 0 : left.via === "contract" ? -1 : 1,
    )
    .map((warning) => {
      const moved =
        warning.canonical === undefined
          ? `${branch(warning.branch)} has added it as \`${warning.shape}\``
          : `${branch(warning.branch)} has already changed it from ` +
            `\`${warning.canonical}\` to \`${warning.shape}\``;
      const blind =
        warning.inferred === true
          ? " Part of this contract is inferred rather than written, so not all of it is being watched."
          : "";
      return warning.via === "contract"
        ? `${warning.file}: \`${warning.symbol}\` — ${moved}, and has not merged yet.${blind}`
        : `${warning.through} is built on \`${warning.symbol}\` from ` +
          `${warning.file}, and ${moved}. It has not merged yet, so code ` +
          `written against the shape on the repository's own branch will ` +
          `stop compiling when it does.${blind}`;
    });
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
