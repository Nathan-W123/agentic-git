import {
  completeAgentPlan,
  createId,
  type AgentPlan,
  type OwnershipMode,
  type ResourceLease,
  type ResourceType,
} from "@coord/shared-types";

export class OwnershipConflictError extends Error {
  public constructor(
    public readonly resourceId: string,
    public readonly blockingLease: ResourceLease,
  ) {
    super(
      `${blockingLease.resourceType}:${resourceId} is owned by task ` +
        `${blockingLease.taskId} in ${blockingLease.mode} mode until ` +
        blockingLease.expiresAt,
    );
    this.name = "OwnershipConflictError";
  }
}

export class OwnershipApprovalRequiredError extends Error {
  public constructor(
    public readonly resourceType: ResourceType,
    public readonly resourceId: string,
  ) {
    super(`Human approval is required for ${resourceType}:${resourceId}`);
    this.name = "OwnershipApprovalRequiredError";
  }
}

export interface PlannedResource {
  type: ResourceType;
  id: string;
  mode: OwnershipMode;
}

export interface OwnershipPolicy {
  resourcesForPlan(plan: AgentPlan): PlannedResource[];
}

export class DefaultOwnershipPolicy implements OwnershipPolicy {
  public resourcesForPlan(plan: AgentPlan): PlannedResource[] {
    const complete = completeAgentPlan(plan);
    const resources: PlannedResource[] = [
      ...complete.expectedFiles.map((id): PlannedResource => ({
        type: "file",
        id,
        mode: /\.(?:md|mdx|txt)$/iu.test(id) ? "shared" : "exclusive",
      })),
      ...complete.expectedSymbols.map((id): PlannedResource => ({
        type: "symbol",
        id,
        mode: "exclusive",
      })),
      ...complete.expectedApis.map((id): PlannedResource => ({
        type: "api",
        id,
        mode: "intent",
      })),
      ...complete.expectedSchemas.map((id): PlannedResource => ({
        type: "schema",
        id,
        mode: "approval_required",
      })),
      ...complete.expectedConfigKeys.map((id): PlannedResource => ({
        type: "configuration",
        id,
        mode: "intent",
      })),
      ...complete.expectedTests.map((id): PlannedResource => ({
        type: "test",
        id,
        mode: "shared",
      })),
      ...complete.expectedServices.map((id): PlannedResource => ({
        type: "service",
        id,
        mode: "intent",
      })),
    ];
    const seen = new Set<string>();
    return resources.filter((resource) => {
      const key = `${resource.type}\0${resource.id}\0${resource.mode}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}

function compatible(first: OwnershipMode, second: OwnershipMode): boolean {
  if (first === "observe" || second === "observe") {
    return true;
  }
  if (first === "intent" && second === "intent") {
    return true;
  }
  if (first === "shared" && second === "shared") {
    return true;
  }
  return false;
}

export interface AcquireOwnershipOptions {
  /** Resource keys approved by a human, formatted as `type:id`. */
  approvedResources?: ReadonlySet<string>;
}

export class OwnershipService {
  private readonly leases = new Map<string, ResourceLease[]>();

  public constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly defaultTtlMs = 5 * 60 * 1000,
    private readonly policy: OwnershipPolicy = new DefaultOwnershipPolicy(),
  ) {
    if (!Number.isSafeInteger(defaultTtlMs) || defaultTtlMs < 1_000) {
      throw new RangeError("Ownership lease TTL must be at least one second");
    }
  }

  public get renewalIntervalMs(): number {
    return Math.max(250, Math.floor(this.defaultTtlMs / 3));
  }

  public acquire(
    plan: AgentPlan,
    principalId: string,
    baseVersion: number,
    options: AcquireOwnershipOptions = {},
  ): ResourceLease[] {
    this.expireLeases();
    const resources = this.policy.resourcesForPlan(plan);
    const pending: PlannedResource[] = [];

    for (const resource of resources) {
      const key = this.key(resource.type, resource.id);
      const existing = this.leases.get(key) ?? [];
      if (existing.some((lease) => lease.taskId === plan.taskId)) {
        continue;
      }
      if (
        resource.mode === "approval_required" &&
        !options.approvedResources?.has(key)
      ) {
        throw new OwnershipApprovalRequiredError(resource.type, resource.id);
      }
      const blocker = existing.find(
        (lease) =>
          lease.taskId !== plan.taskId &&
          !compatible(lease.mode, resource.mode),
      );
      if (blocker !== undefined) {
        throw new OwnershipConflictError(resource.id, blocker);
      }
      pending.push(resource);
    }

    const expiresAt = new Date(
      this.now().getTime() + this.defaultTtlMs,
    ).toISOString();
    const acquired = pending.map<ResourceLease>((resource) => ({
      leaseId: createId("lease"),
      resourceType: resource.type,
      resourceId: resource.id,
      principalId,
      taskId: plan.taskId,
      mode: resource.mode,
      baseVersion,
      expiresAt,
    }));

    for (const lease of acquired) {
      const key = this.key(lease.resourceType, lease.resourceId);
      this.leases.set(key, [...(this.leases.get(key) ?? []), lease]);
    }
    return acquired;
  }

  public releaseTask(taskId: string): ResourceLease[] {
    const released: ResourceLease[] = [];
    for (const [key, leases] of this.leases) {
      const retained = leases.filter((lease) => {
        if (lease.taskId === taskId) {
          released.push(lease);
          return false;
        }
        return true;
      });
      if (retained.length === 0) {
        this.leases.delete(key);
      } else {
        this.leases.set(key, retained);
      }
    }
    return released;
  }

  public activeLeases(): ResourceLease[] {
    this.expireLeases();
    return [...this.leases.values()].flat();
  }

  /** Extends every active lease while a coordinator run is still making progress. */
  public renewActive(): ResourceLease[] {
    this.expireLeases();
    const expiresAt = new Date(
      this.now().getTime() + this.defaultTtlMs,
    ).toISOString();
    const renewed: ResourceLease[] = [];
    for (const [key, leases] of this.leases) {
      const updated = leases.map((lease) => {
        const next = { ...lease, expiresAt };
        renewed.push(next);
        return next;
      });
      this.leases.set(key, updated);
    }
    return renewed;
  }

  public blockersFor(plan: AgentPlan): ResourceLease[] {
    this.expireLeases();
    const blockers: ResourceLease[] = [];
    for (const resource of this.policy.resourcesForPlan(plan)) {
      for (const lease of this.leases.get(this.key(resource.type, resource.id)) ?? []) {
        if (
          lease.taskId !== plan.taskId &&
          !compatible(lease.mode, resource.mode)
        ) {
          blockers.push(lease);
        }
      }
    }
    return blockers;
  }

  private expireLeases(): void {
    const currentTime = this.now().getTime();
    for (const [key, leases] of this.leases) {
      const active = leases.filter(
        (lease) => Date.parse(lease.expiresAt) > currentTime,
      );
      if (active.length === 0) {
        this.leases.delete(key);
      } else {
        this.leases.set(key, active);
      }
    }
  }

  private key(type: ResourceType, id: string): string {
    return `${type}\0${id}`;
  }
}
