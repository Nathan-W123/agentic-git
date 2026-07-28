import {
  completeAgentPlan,
  type AgentPlan,
  type ChangeSet,
} from "@coord/shared-types";

/**
 * Whether a finished result can still be integrated after canonical moved.
 *
 * Exact-base integration refuses every result whose base has been overtaken.
 * That is the right default and it is why remote execution is safe, but it is
 * blunt: the integration workspace is built from *current* canonical and the
 * patches are applied three-way, so a result whose base was overtaken by work
 * it has nothing to do with would apply perfectly well. Refusing it throws
 * away a finished agent run to protect against a collision that did not occur.
 *
 * What this decides is exactly that question — did the advance touch anything
 * this result depends on? — and it answers conservatively. Anything it cannot
 * rule out is a blocker, and a blocker means the existing requeue-to-replan
 * path runs unchanged.
 */

/** The resources one canonical advance changed. */
export interface CanonicalAdvance {
  changedFiles: readonly string[];
  changedSymbols: readonly string[];
  changedApis: readonly string[];
  changedSchemas: readonly string[];
  changedConfigKeys: readonly string[];
  changedTests: readonly string[];
  changedServices: readonly string[];
}

function key(value: string): string {
  return value.trim().replaceAll("\\", "/").toLowerCase();
}

/**
 * Resources the advance changed that this result is not independent of.
 *
 * Empty means the result may be replayed onto the newer revision. Every other
 * answer names what stopped it, so the audit trail records why a run was
 * requeued rather than just that it was.
 *
 * Three things are checked, and the third is the one that matters:
 *
 * - What the result writes. Two changesets touching one file must not both be
 *   promoted from the same base; the second would silently drop the first.
 * - What the plan claimed. A file the plan declared but did not end up
 *   patching is still scope this agent reasoned about.
 * - What the plan depends on. This is where a textually disjoint result can
 *   still be wrong: an agent that read a module and wrote code against it is
 *   invalidated when that module changes, whether or not it edited it.
 *   Enrichment resolves imports into `file:` and `symbol:` dependency entries,
 *   which is what makes the check possible at all.
 */
export function replayBlockers(
  plan: AgentPlan,
  changeSet: ChangeSet,
  advance: CanonicalAdvance,
): string[] {
  const complete = completeAgentPlan(plan);
  const dependsOn = new Set(complete.dependencies.map(key));
  const touched = (type: string, value: string): boolean =>
    dependsOn.has(key(value)) || dependsOn.has(`${type}:${key(value)}`);

  const blockers: string[] = [];
  const files = new Set(
    [
      ...changeSet.patches.map((patch) => patch.path),
      ...complete.expectedFiles,
    ].map(key),
  );
  for (const file of advance.changedFiles) {
    if (files.has(key(file)) || touched("file", file)) {
      blockers.push(`file:${file}`);
    }
  }

  const axis = (
    type: string,
    claimed: readonly string[],
    changed: readonly string[],
  ): void => {
    const owned = new Set(claimed.map(key));
    for (const value of changed) {
      if (owned.has(key(value)) || touched(type, value)) {
        blockers.push(`${type}:${value}`);
      }
    }
  };
  axis("symbol", complete.expectedSymbols, advance.changedSymbols);
  axis("api", complete.expectedApis, advance.changedApis);
  axis("schema", complete.expectedSchemas, advance.changedSchemas);
  axis(
    "configuration",
    complete.expectedConfigKeys,
    advance.changedConfigKeys,
  );
  axis("test", complete.expectedTests, advance.changedTests);
  axis("service", complete.expectedServices, advance.changedServices);

  return [...new Set(blockers)].sort();
}
