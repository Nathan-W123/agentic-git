import type { AgentPlan, ChangeSet } from "@coord/shared-types";

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
  const unexpectedFiles = [
    ...new Set(
      changeSet.patches
        .map((patch) => patch.path)
        .filter((file) => !approvedFiles.has(file)),
    ),
  ].sort();

  if (unexpectedFiles.length > 0) {
    throw new ScopeExpansionError(unexpectedFiles);
  }
}

