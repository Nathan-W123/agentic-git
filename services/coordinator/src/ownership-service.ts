import {
  completeAgentPlan,
  createId,
  type AgentPlan,
  type OwnershipMode,
  type PlanResourceRef,
  type ResourceLease,
  type ResourceType,
} from "@coord/shared-types";

import {
  normalizeRanges,
  rangesIntersect,
  type LineRange,
} from "./ranges.js";

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
  /**
   * The lines of the resource this claim covers. Absent means all of it.
   *
   * Only ever set for a file, and only where the plan's reach into that file
   * is genuinely a set of spans rather than the whole path — see
   * {@link PlanFileClaim}.
   */
  ranges?: readonly LineRange[];
}

/**
 * A plan's claim on one file, where the file alone does not describe it.
 *
 * Two things are said here that `expectedFiles` cannot say. A claim on a file
 * the plan never named is how work that reaches code through a grounded
 * referent takes a lease on the file that code really lives in. And `ranges`
 * is how such a lease stays narrower than the file, so a second plan claiming
 * different lines of it is not refused on the path alone.
 *
 * Deciding *which* files these cover, and how narrow each one may honestly be,
 * is not the policy's call — it needs the repository index. The policy is
 * handed the answer.
 */
export interface PlanFileClaim {
  file: string;
  /** Absent means the whole file, exactly as naming it would. */
  ranges?: readonly LineRange[];
}

export interface PlanScopeContext {
  fileClaims?: readonly PlanFileClaim[];
}

export interface OwnershipPolicy {
  resourcesForPlan(
    plan: AgentPlan,
    context?: PlanScopeContext,
  ): PlannedResource[];
}

/** Documentation and text files are edited alongside each other safely. */
function fileMode(id: string): OwnershipMode {
  return /\.(?:md|mdx|txt)$/iu.test(id) ? "shared" : "exclusive";
}

export class DefaultOwnershipPolicy implements OwnershipPolicy {
  public resourcesForPlan(
    plan: AgentPlan,
    context: PlanScopeContext = {},
  ): PlannedResource[] {
    const complete = completeAgentPlan(plan);
    // A claim narrows the lease on a file the plan named, and adds one for a
    // file it did not. Both are the same statement — "this is what the plan
    // reaches in here" — so both come from the same list.
    const claims = new Map(
      (context.fileClaims ?? []).map((claim) => [claim.file, claim]),
    );
    const declared = new Set(complete.expectedFiles);
    const resources: PlannedResource[] = [
      ...[
        ...complete.expectedFiles,
        ...[...claims.keys()].filter((file) => !declared.has(file)).sort(),
      ].map((id): PlannedResource => {
        const ranges = claims.get(id)?.ranges;
        return {
          type: "file",
          id,
          mode: fileMode(id),
          ...(ranges === undefined ? {} : { ranges }),
        };
      }),
      // A symbol the agent named is reserved. A symbol enrichment added
      // because the agent named the file it lives in is only noted.
      //
      // `enrichPlan` puts every symbol of a declared file into the plan, so
      // leasing all of them exclusively means naming one file reserves every
      // function in it — and two tasks on different functions of one file
      // then collide on every symbol, which is the case symbol-level leases
      // exist to let through. Dropping the inherited ones entirely is the
      // other wrong answer: they are real evidence that this task is working
      // in there, and arbitration reads them. `observe` keeps the evidence
      // and drops the reservation, since it is compatible with every mode.
      //
      // Absent `declared.symbols` means nothing widened this plan, so every
      // symbol on it is the agent's own.
      ...(() => {
        const own = new Set(
          (plan.declared?.symbols ?? complete.expectedSymbols).map((name) =>
            name.toLowerCase(),
          ),
        );
        return complete.expectedSymbols.map((id): PlannedResource => ({
          type: "symbol",
          id,
          mode: own.has(id.toLowerCase()) ? "exclusive" : "observe",
        }));
      })(),
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

/**
 * Whether a live lease stands in the way of a new claim on the same resource.
 *
 * Mode is asked first and settles almost every case. What it cannot settle is
 * two exclusive claims on one file that are not actually about the same code:
 * an exclusive lease has always meant the whole path, so a plan holding forty
 * lines of a file refused every other plan the other nine hundred. When both
 * sides say which lines they mean, the honest answer is whether those lines
 * meet — and a claim that does not say still means all of them, so nothing
 * that behaved one way before behaves differently now.
 */
function blocks(existing: ResourceLease, claim: PlannedResource): boolean {
  if (compatible(existing.mode, claim.mode)) {
    return false;
  }
  const held = existing.ranges;
  const wanted = claim.ranges;
  if (held === undefined || wanted === undefined) {
    return true;
  }
  return rangesIntersect(held, wanted);
}

export interface AcquireOwnershipOptions extends PlanScopeContext {
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
    const resources = this.policy.resourcesForPlan(plan, {
      ...(options.fileClaims === undefined
        ? {}
        : { fileClaims: options.fileClaims }),
    });
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
        (lease) => lease.taskId !== plan.taskId && blocks(lease, resource),
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
      ...(resource.ranges === undefined
        ? {}
        : { ranges: normalizeRanges(resource.ranges) }),
    }));

    for (const lease of acquired) {
      const key = this.key(lease.resourceType, lease.resourceId);
      this.leases.set(key, [...(this.leases.get(key) ?? []), lease]);
    }
    return acquired;
  }

  /**
   * Drops only the named resources, leaving the rest of the task's leases
   * held.
   *
   * The narrow counterpart of {@link releaseTask}, which runs at settle and
   * takes everything. This one runs mid-task, when an agent has finished with
   * part of what it claimed: a plan that named twenty-two files and touched
   * eight held the other fourteen until the task ended, and everything that
   * needed one of them waited that long for nothing.
   *
   * Returns what was actually let go, which is not the same as what was
   * asked for: a resource this task never held is not an error here, it is
   * simply nothing to release. The caller decides whether an empty result
   * means the request was pointless.
   *
   * Nothing about acquisition changes. A task that wants a released resource
   * back asks for it the way any widening asks — and is refused on the spot
   * if somebody else has taken it, never queued behind them.
   */
  public releaseResources(
    taskId: string,
    resources: readonly PlanResourceRef[],
  ): ResourceLease[] {
    const wanted = new Set(
      resources.map((resource) =>
        this.key(resource.resourceType, resource.resourceId),
      ),
    );
    const released: ResourceLease[] = [];
    for (const key of [...this.leases.keys()]) {
      if (!wanted.has(key)) {
        continue;
      }
      const retained = (this.leases.get(key) ?? []).filter((lease) => {
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

  public blockersFor(
    plan: AgentPlan,
    context: PlanScopeContext = {},
  ): ResourceLease[] {
    this.expireLeases();
    const blockers: ResourceLease[] = [];
    for (const resource of this.policy.resourcesForPlan(plan, context)) {
      for (const lease of this.leases.get(this.key(resource.type, resource.id)) ?? []) {
        if (lease.taskId !== plan.taskId && blocks(lease, resource)) {
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
