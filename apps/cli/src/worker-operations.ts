import type {
  CoordinationStore,
  SubmittedTask,
  WorkLease,
} from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import type { CanonicalVersion } from "@coord/shared-types";

import type { CoordinatorProject } from "./project.js";

/**
 * Control-plane half of the remote worker protocol.
 *
 * The gateway owns transport and authentication; this owns the decisions that
 * need canonical state — which revision a worker builds from, what bytes it
 * receives, and whether a returned changeset is acceptable.
 */

/** A worker holds a task for this long before it must heartbeat again. */
export const WORK_LEASE_TTL_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface WorkAssignment {
  lease: WorkLease;
  task: SubmittedTask;
  repository: { id: string; branch: string };
  /**
   * The canonical version the lease was issued against. Sent in full so the
   * worker never has to reconstruct sequence or timestamp from the revision.
   */
  canonicalVersion: CanonicalVersion;
  bundleUrl: string;
  /** Branch to check out from the bundle: `git clone --branch <ref>`. */
  bundleRef: string;
  heartbeatIntervalMs: number;
}

/** Derived from the lease so concurrent bundle requests cannot collide. */
export function bundleRefFor(leaseId: string): string {
  return `coord-lease/${leaseId.replaceAll(/[^A-Za-z0-9_-]/gu, "")}`;
}

async function canonicalOf(
  store: CoordinationStore,
  repositoryId: string,
  repositories: RepositoryService,
) {
  const repository = await store.getRepository(repositoryId);
  if (repository === undefined) {
    throw new Error(`Unknown repository: ${repositoryId}`);
  }
  const canonical = {
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  };
  return {
    canonical,
    version: await repositories.getCanonicalVersion(canonical),
  };
}

/**
 * Leases the next pending task to a worker.
 *
 * The canonical revision is resolved here, not by the worker, so every worker
 * builds from a revision the control plane chose and recorded on the lease.
 */
export async function leaseWork(
  store: CoordinationStore,
  input: { workerId: string; repositoryId?: string },
  repositories = new RepositoryService(),
): Promise<WorkAssignment | undefined> {
  // Resolving the revision needs a repository, but which task comes next is
  // only known after the claim. Peek first, then confirm the revision matches
  // what was actually leased.
  const pending = await store.listSubmittedTasks({
    status: "submitted",
    ...(input.repositoryId === undefined
      ? {}
      : { repositoryId: input.repositoryId }),
  });
  const next = pending[0];
  if (next === undefined) {
    return undefined;
  }

  const { version } = await canonicalOf(store, next.repositoryId, repositories);
  const leased = await store.leaseNextTask({
    workerId: input.workerId,
    baseRevision: version.revision,
    ttlMs: WORK_LEASE_TTL_MS,
    // Pin to the repository whose revision was just resolved, so a task that
    // arrives for a different repository between the peek and the claim cannot
    // be leased against the wrong base.
    repositoryId: next.repositoryId,
  });
  if (leased === undefined) {
    return undefined;
  }

  const repository = await store.getRepository(leased.task.repositoryId);
  return {
    lease: leased.lease,
    task: leased.task,
    repository: {
      id: leased.task.repositoryId,
      branch: repository?.branch ?? "main",
    },
    canonicalVersion: version,
    bundleUrl: `/api/v1/workers/leases/${leased.lease.id}/bundle`,
    bundleRef: bundleRefFor(leased.lease.id),
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

/**
 * Serves the workspace contents for a lease as a Git bundle.
 *
 * Only the leased revision is packaged, so a worker never receives history it
 * was not assigned, and the control plane never has to run a Git server.
 */
export async function leaseBundle(
  store: CoordinationStore,
  leaseId: string,
  repositories = new RepositoryService(),
): Promise<Buffer | undefined> {
  const lease = await store.getWorkLease(leaseId);
  if (lease === undefined || lease.status !== "active") {
    return undefined;
  }
  const repository = await store.getRepository(lease.repositoryId);
  if (repository === undefined) {
    return undefined;
  }
  return await repositories.createBundle(
    {
      id: repository.id,
      path: repository.path,
      branch: repository.branch,
    },
    lease.baseRevision,
    bundleRefFor(lease.id),
  );
}

export interface WorkResultInput {
  leaseId: string;
  status: "completed" | "failed";
  actorId: string;
  changeSet: unknown;
  detail?: string;
}

/**
 * Accepts a worker's result and settles the lease.
 *
 * A completed result must carry a changeset whose base matches the revision
 * the lease was issued against. A worker that built from a different revision
 * is reporting work the control plane cannot safely integrate.
 */
export async function acceptWorkResult(
  store: CoordinationStore,
  input: WorkResultInput,
): Promise<{ accepted: boolean; reason?: string }> {
  const lease = await store.getWorkLease(input.leaseId);
  if (lease === undefined) {
    throw new Error(`Unknown lease: ${input.leaseId}`);
  }
  if (lease.status !== "active") {
    // The lease already lapsed, so another worker may hold the task. Accepting
    // now would let two workers write results for the same task.
    return { accepted: false, reason: `lease is ${lease.status}` };
  }

  const now = new Date().toISOString();
  if (input.status === "failed") {
    await store.finishWorkLease(input.leaseId, "failed", now, input.detail);
    await store.completeSubmittedTask(lease.taskId, "failed");
    await store.appendAudit(undefined, {
      type: "task_failed",
      taskId: lease.taskId,
      data: {
        workerId: lease.workerId,
        leaseId: lease.id,
        detail: input.detail ?? "worker reported failure",
      },
    });
    return { accepted: true };
  }

  const changeSet = input.changeSet;
  if (
    typeof changeSet !== "object" ||
    changeSet === null ||
    Array.isArray(changeSet)
  ) {
    return { accepted: false, reason: "a completed result requires a changeset" };
  }
  const record = changeSet as Record<string, unknown>;
  if (record["baseRevision"] !== lease.baseRevision) {
    return {
      accepted: false,
      reason:
        `changeset base ${String(record["baseRevision"])} does not match the ` +
        `revision this lease was issued against (${lease.baseRevision})`,
    };
  }
  if (record["taskId"] !== lease.taskId) {
    return { accepted: false, reason: "changeset is for a different task" };
  }

  await store.finishWorkLease(input.leaseId, "completed", now, input.detail);
  await store.appendAudit(undefined, {
    type: "changeset_collected",
    taskId: lease.taskId,
    data: {
      workerId: lease.workerId,
      leaseId: lease.id,
      changeSetId: record["id"] ?? null,
      files: Array.isArray(record["patches"])
        ? (record["patches"] as Array<{ path?: unknown }>).map(
            (patch) => patch.path,
          )
        : [],
    },
  });
  return { accepted: true };
}

/** Convenience binding for a project-hosted control plane. */
export function workerOperations(
  _project: CoordinatorProject,
  store: CoordinationStore,
) {
  const repositories = new RepositoryService();
  return {
    leaseWork: async (input: { workerId: string; repositoryId?: string }) =>
      await leaseWork(store, input, repositories),
    leaseBundle: async (leaseId: string) =>
      await leaseBundle(store, leaseId, repositories),
    acceptWorkResult: async (input: WorkResultInput) =>
      await acceptWorkResult(store, input),
  };
}
