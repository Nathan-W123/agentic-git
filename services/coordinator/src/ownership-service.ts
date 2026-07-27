import {
  createId,
  type AgentPlan,
  type ResourceLease,
} from "@coord/shared-types";

export class OwnershipConflictError extends Error {
  public constructor(
    public readonly resourceId: string,
    public readonly blockingLease: ResourceLease,
  ) {
    super(
      `${resourceId} is already owned by task ${blockingLease.taskId} until ` +
        blockingLease.expiresAt,
    );
    this.name = "OwnershipConflictError";
  }
}

export class OwnershipService {
  private readonly leases = new Map<string, ResourceLease>();

  public constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly defaultTtlMs = 5 * 60 * 1000,
  ) {}

  public acquire(
    plan: AgentPlan,
    principalId: string,
    baseVersion: number,
  ): ResourceLease[] {
    this.expireLeases();
    const resources = [...new Set(plan.expectedFiles)].sort();

    for (const resourceId of resources) {
      const existing = this.leases.get(resourceId);
      if (existing !== undefined && existing.taskId !== plan.taskId) {
        throw new OwnershipConflictError(resourceId, existing);
      }
    }

    const expiresAt = new Date(
      this.now().getTime() + this.defaultTtlMs,
    ).toISOString();
    const acquired = resources.map<ResourceLease>((resourceId) => ({
      leaseId: createId("lease"),
      resourceType: "file",
      resourceId,
      principalId,
      taskId: plan.taskId,
      mode: "exclusive",
      baseVersion,
      expiresAt,
    }));

    for (const lease of acquired) {
      this.leases.set(lease.resourceId, lease);
    }
    return acquired;
  }

  public releaseTask(taskId: string): ResourceLease[] {
    const released: ResourceLease[] = [];
    for (const [resourceId, lease] of this.leases) {
      if (lease.taskId === taskId) {
        released.push(lease);
        this.leases.delete(resourceId);
      }
    }
    return released;
  }

  public activeLeases(): ResourceLease[] {
    this.expireLeases();
    return [...this.leases.values()];
  }

  private expireLeases(): void {
    const currentTime = this.now().getTime();
    for (const [resourceId, lease] of this.leases) {
      if (Date.parse(lease.expiresAt) <= currentTime) {
        this.leases.delete(resourceId);
      }
    }
  }
}

