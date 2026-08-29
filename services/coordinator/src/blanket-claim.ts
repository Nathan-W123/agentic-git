import path from "node:path";

import {
  claimOccupiesPath,
  normalizeRepositoryPath,
  uniqueRepositoryPaths,
  type AgentPlan,
  type FilePatchStatus,
  type LineRange,
  type TaskDefinition,
  type TouchedFileRanges,
} from "@coord/shared-types";

/**
 * A claim on the whole repository, issued to a task nobody is competing with.
 *
 * The plan is real in every structural sense — it has the task's objective,
 * its validation commands, an empty declaration set — and carries a claim
 * marker that says the empty declarations mean "everything" rather than
 * "nothing". That is what lets scope enforcement, ownership, conflict
 * assessment and the lease record keep working on a task no agent ever
 * planned: each of them is handed an ordinary `AgentPlan`, and only the two
 * places that must know the difference read the marker.
 */
export function blanketPlan(
  task: TaskDefinition,
  grantedAt: string = new Date().toISOString(),
  /**
   * Where the objective said this task was going, carried on the claim.
   *
   * A repository-wide claim is answered before the index is built, because
   * there is nothing to arbitrate against something covering everything — so
   * an arrival behind one used to be refused outright and told to come back.
   * Recording the estimate here is what gives that arrival something to be
   * decided against: it can narrow the claim to this on the spot rather than
   * waiting out the holder's own poll.
   *
   * It does not narrow the claim by itself. `claimCoversPath` still reads a
   * blanket claim as the whole repository, which is what keeps the holder
   * safe until somebody actually needs the room.
   */
  estimatedFiles: readonly string[] = [],
): AgentPlan {
  return {
    taskId: task.id,
    objective: task.objective,
    expectedFiles: [...estimatedFiles],
    expectedSymbols: [],
    dependencies: [],
    commands: [...task.validationCommands],
    externalAccess: [],
    // Never "high": a blanket claim is not a statement that the work is
    // dangerous, and letting it read as one would send every unplanned task
    // to a human under the default approval policy.
    riskLevel: "medium",
    intent: "Repository-wide claim granted without a planning round trip",
    claim: { kind: "blanket", grantedAt },
  };
}

/**
 * The plan a blanket claim becomes when somebody else arrives: exactly the
 * files the holder has already touched, plus the directories they live in.
 *
 * Derived from behaviour and nothing else — the caller reads the worktree at
 * the moment of the freeze and hands the result here. Directories are kept
 * alongside the files because a task frozen mid-sweep has touched three files
 * of a directory it is still working through, and a file-exact freeze would
 * refuse it the fourth.
 *
 * They widen what this holder may write, and nothing more. Arbitration reads
 * the files, so the rest of a directory stays available to everybody else and
 * the fourth file is re-admitted when it is actually written rather than held
 * on the chance that it will be. See `claimOccupiesPath`, which is where that
 * distinction lives.
 */
/**
 * Records that a repository-wide holder has handed some files back.
 *
 * The claim still covers the repository — this holder has not finished, and
 * narrowing it wholesale on the strength of one release would take away
 * everything it has not yet been seen in. What changes is that the named
 * files stop being covered, so the task waiting on them can be granted them
 * while this one carries on with the rest.
 *
 * Only files. A symbol cannot be handed back out of a claim that never named
 * one: there is nothing recorded to subtract it from, and a claim that
 * covered "the repository except one function" would be a statement about
 * where its holder is going, which is exactly what a plan nobody wrote cannot
 * make.
 *
 * The caller has already proved each file clean in the holder's worktree. A
 * plan that is not a blanket claim comes back untouched — a frozen or ordinary
 * plan gives files back by having them removed from its declarations, which
 * `reducePlanScope` does, and recording them here as well would say the same
 * thing twice in two vocabularies.
 */
export function releaseFromBlanketClaim(
  plan: AgentPlan,
  files: readonly string[],
): AgentPlan {
  if (plan.claim?.kind !== "blanket" || files.length === 0) {
    return plan;
  }
  const released = [
    ...new Set([...(plan.claim.released ?? []), ...files]),
  ].sort();
  return {
    ...structuredClone(plan),
    claim: { ...plan.claim, released },
  };
}

export function freezePlanFromWorkingChanges(
  plan: AgentPlan,
  changes: ReadonlyArray<{
    path: string;
    status: FilePatchStatus;
    /**
     * Which lines of this file have been written, where the caller could read
     * them. Absent means "somewhere in this file", and the file stands whole.
     */
    ranges?: readonly LineRange[];
  }>,
  frozenAt: string = new Date().toISOString(),
): AgentPlan {
  const files = [
    ...new Set([
      ...plan.expectedFiles,
      ...changes.map((change) => normalizeRepositoryPath(change.path)),
    ]),
  ].sort();
  const directories = [
    ...new Set(
      files
        .map((file) => file.slice(0, file.lastIndexOf("/") + 1))
        // A file at the repository root has no directory to widen to. Taking
        // "" would claim the entire repository under the name of a narrowing,
        // which is the one thing a freeze must never do.
        .filter((directory) => directory.length > 0),
    ),
  ].sort();
  // Only files with something read off them. A file observed as changed but
  // never located is left out, and the whole of it stays this holder's — the
  // absence has to read as "everywhere", never as "nowhere".
  const touched: TouchedFileRanges[] = [];
  for (const change of changes) {
    if (change.ranges === undefined || change.ranges.length === 0) {
      continue;
    }
    const file = normalizeRepositoryPath(change.path);
    const existing = touched.find((entry) => entry.file === file);
    if (existing === undefined) {
      touched.push({ file, ranges: [...change.ranges] });
    } else {
      existing.ranges.push(...change.ranges);
    }
  }
  touched.sort((left, right) => left.file.localeCompare(right.file));
  return {
    ...plan,
    expectedFiles: files,
    claim: {
      kind: "frozen",
      directories,
      frozenAt,
      ...(touched.length === 0 ? {} : { touched }),
    },
  };
}

/**
 * The lines a frozen claim says its holder has been writing in one file, or
 * nothing when it has not been able to say.
 *
 * Nothing is the conservative answer everywhere it appears: no observation
 * means the holder could be anywhere in the file, which is how this behaved
 * before there was anything to observe.
 */
export function frozenTouchedRanges(
  plan: Pick<AgentPlan, "claim">,
  file: string,
): readonly LineRange[] | undefined {
  if (plan.claim?.kind !== "frozen") {
    return undefined;
  }
  const entry = plan.claim.touched?.find((touched) => touched.file === file);
  return entry === undefined || entry.ranges.length === 0
    ? undefined
    : entry.ranges;
}

/** What a paused blanket holder said the rest of its work needs. */
export interface HolderDeclaration {
  files: readonly string[];
  symbols: readonly string[];
}

/**
 * The ordinary plan a blanket claim becomes once its holder has described
 * itself, or nothing when the answer cannot be used.
 *
 * The footprint is the **union** of what the holder says it will do and what
 * it has already been observed touching. Never just the answer: a holder that
 * has written in a function it forgets to mention must keep that function, or
 * its work is handed to somebody else and silently overwritten. `observed` is
 * what supplies that second half, and the files in it the answer did not name
 * are recorded on the claim as `held` — whole, because a line range read off a
 * worktree is a new-side hunk number and the spans it would have to be matched
 * against are base-side index positions, so it cannot protect a file at symbol
 * granularity honestly. Coarse and right beats fine and wrong in this
 * direction: the cost is a big file the holder brushed once and forgot.
 *
 * Answers `undefined` — leaving the caller to fall back to the plain freeze —
 * when the answer yields no usable file or no usable symbol. A converted plan
 * with no symbols is worse than the freeze it replaces: `partitionContested`
 * and `declaredSpans` both refuse to narrow a holder that declared none, so
 * the arrival would gain nothing while the holder had surrendered the
 * directory latitude a freeze would have given it.
 */
export function declaredPlanFromClaim(
  plan: AgentPlan,
  declaration: HolderDeclaration,
  observed: ReadonlyArray<{ path: string }>,
  declaredAt: string = new Date().toISOString(),
): AgentPlan | undefined {
  if (plan.claim?.kind !== "blanket") {
    return undefined;
  }
  const said = uniqueRepositoryPaths(
    declaration.files.filter((file) => usableRepositoryPath(file)),
  );
  const symbols = [
    ...new Set(
      declaration.symbols
        .map((symbol) => symbol.trim())
        .filter((symbol) => symbol.length > 0),
    ),
  ].sort();
  if (said.length === 0 || symbols.length === 0) {
    return undefined;
  }
  const touched = uniqueRepositoryPaths(
    observed.map((change) => change.path).filter(usableRepositoryPath),
  );
  const files = uniqueRepositoryPaths([
    ...said,
    ...touched,
    ...plan.expectedFiles,
  ]);
  // Touched and unmentioned. A file the holder named is shareable around its
  // declarations even if it has already been writing there — that is the
  // holder's own answer about its own file, and the same contract every
  // planned agent runs under.
  const held = touched.filter((file) => !said.includes(file));
  return {
    ...structuredClone(plan),
    expectedFiles: files,
    expectedSymbols: symbols,
    // The plan's own words, which is what `declaredSpans` reads before
    // enrichment widens `expectedSymbols` to every symbol in every named file.
    declared: {
      ...(plan.declared ?? {}),
      symbols,
    },
    claim: { kind: "declared", declaredAt, held },
  };
}

/**
 * Whether a path a model produced can be used as a repository path at all.
 *
 * Absolute paths, paths that escape the repository and directory names are
 * dropped rather than argued with: this answer decides which files another
 * task is refused, and a path nobody can resolve refuses nothing safely.
 */
export function usableRepositoryPath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.endsWith("/")) {
    return false;
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/u.test(trimmed)) {
    return false;
  }
  try {
    // `normalizeRepositoryPath` throws on anything it will not resolve, which
    // is right for a plan and wrong for a model's answer: here an unusable
    // path is dropped, not raised.
    const normalized = normalizeRepositoryPath(trimmed);
    return normalized.length > 0 && !normalized.split("/").includes("..");
  } catch {
    return false;
  }
}

/**
 * The paths in a change set that a holder's claim does not already account
 * for — the ones that have to be arbitrated before they can be kept.
 *
 * A frozen claim occupies every file its plan declared, so this is simply
 * "not in the claim". A declared claim occupies far less on purpose — only
 * the files its holder was writing in and did not mention — because that is
 * what lets everything it *did* name be shared around its declarations. Read
 * naively here, that would make every declared file look like an escape, and
 * a holder writing in the file it just told us about would be sent back
 * through arbitration on every collection, against a candidate that has since
 * been admitted into the other half of it: refused, and the holder failed for
 * doing exactly what it said it would do.
 *
 * So the question this asks is the wider one — is the path covered by this
 * plan *at all* — which is the same question {@link assertChangeSetWithinPlan}
 * answers when it path-binds a holder to its declarations.
 */
export function filesOutsideClaim(
  plan: Pick<AgentPlan, "claim" | "expectedFiles">,
  paths: readonly string[],
): string[] {
  const declared = uniqueRepositoryPaths(plan.expectedFiles);
  return [
    ...new Set(
      paths.filter(
        (file) =>
          !claimOccupiesPath(plan, file) &&
          !(plan.claim?.kind === "declared" && declared.includes(file)),
      ),
    ),
  ].sort();
}
