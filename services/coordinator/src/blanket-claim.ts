import {
  normalizeRepositoryPath,
  type AgentPlan,
  type FilePatchStatus,
  type TaskDefinition,
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
export function freezePlanFromWorkingChanges(
  plan: AgentPlan,
  changes: ReadonlyArray<{ path: string; status: FilePatchStatus }>,
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
  return {
    ...plan,
    expectedFiles: files,
    claim: { kind: "frozen", directories, frozenAt },
  };
}
