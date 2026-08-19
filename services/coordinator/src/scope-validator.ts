import { claimCoversPath, type AgentPlan, type ChangeSet } from "@coord/shared-types";

export class ScopeExpansionError extends Error {
  public constructor(public readonly unexpectedFiles: readonly string[]) {
    super(
      `Changeset includes files outside the approved plan: ${unexpectedFiles.join(", ")}`,
    );
    this.name = "ScopeExpansionError";
  }
}

export function assertChangeSetWithinPlan(
  plan: AgentPlan,
  changeSet: ChangeSet,
): void {
  const approvedFiles = new Set(plan.expectedFiles);
  // A coordinator-issued claim approves paths the declarations cannot name: a
  // blanket claim approves the repository, and a claim frozen from observation
  // approves the directories its holder was already working in. Both are
  // decided against every other holder before they are issued, exactly as a
  // declared file is, so what they cover is as approved as anything here.
  const unexpectedFiles = [
    ...new Set(
      changeSet.patches
        .map((patch) => patch.path)
        .filter(
          (file) => !approvedFiles.has(file) && !claimCoversPath(plan, file),
        ),
    ),
  ].sort();

  if (unexpectedFiles.length > 0) {
    throw new ScopeExpansionError(unexpectedFiles);
  }
}

