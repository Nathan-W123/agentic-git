import {
  type AgentPlan,
  type ApprovalKind,
  type ApprovalRequest,
  type ChangeSet,
  type RiskLevel,
  type ScopeChangeRequest,
} from "@coord/shared-types";
import {
  type CoordinationStore,
  type CreateApprovalInput,
} from "@coord/persistence";

export interface ApprovalPolicyOptions {
  enabled?: boolean;
  requireSchemaReview?: boolean;
  requireChangesetReview?: boolean;
  riskLevels?: readonly RiskLevel[];
  pathPatterns?: readonly string[];
  approvalTimeoutMs?: number;
  requireRemotePlanReview?: boolean;
}

const DEFAULT_PATH_PATTERNS = [
  ".github/workflows/**",
  "authentication/**",
  "database/migrations/**",
  "infrastructure/production/**",
  "package.json",
  "secrets/**",
] as const;

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character !== undefined) {
      source += escapeRegex(character);
    }
  }
  return new RegExp(`^${source}$`, "u");
}

export class ApprovalPolicy {
  private readonly enabled: boolean;
  private readonly riskLevels: ReadonlySet<RiskLevel>;
  private readonly pathPatterns: ReadonlyArray<{
    pattern: string;
    regex: RegExp;
  }>;
  public readonly timeoutMs: number;
  public readonly requireSchemaReview: boolean;
  public readonly requireChangesetReview: boolean;
  /**
   * Whether a remote worker's plan is gated before it executes.
   *
   * Kept separate from {@link planReasons} rather than folded into it: the
   * reasons a plan is risky are the same locally and remotely, and only the
   * decision to stop for them at admission time is a project's to make.
   */
  public readonly requireRemotePlanReview: boolean;

  public constructor(options: ApprovalPolicyOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.riskLevels = new Set(options.riskLevels ?? ["high", "critical"]);
    this.pathPatterns = (options.pathPatterns ?? DEFAULT_PATH_PATTERNS).map(
      (pattern) => ({ pattern, regex: globRegex(pattern) }),
    );
    this.timeoutMs = options.approvalTimeoutMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000) {
      throw new RangeError("Approval timeout must be at least one second");
    }
    this.requireSchemaReview = options.requireSchemaReview ?? true;
    this.requireChangesetReview = options.requireChangesetReview ?? false;
    this.requireRemotePlanReview = options.requireRemotePlanReview ?? false;
  }

  /**
   * Why a remote worker's plan must wait for a person, or nothing.
   *
   * Empty unless the project asked for the gate. The reasons themselves are
   * {@link planReasons} — the same ones the local scheduler stops on — so a
   * project cannot end up with a plan that is risky enough to gate in one
   * execution mode and not the other.
   */
  public remotePlanReasons(plan: AgentPlan): string[] {
    return this.requireRemotePlanReview ? this.planReasons(plan) : [];
  }

  public planReasons(plan: AgentPlan): string[] {
    if (!this.enabled) {
      return [];
    }
    return this.reasons(plan, plan.expectedFiles);
  }

  public changesetReasons(
    plan: AgentPlan,
    changeSet: ChangeSet,
    options: { planWasReviewed?: boolean } = {},
  ): string[] {
    if (!this.enabled) {
      return [];
    }
    const reasons =
      options.planWasReviewed === true
        ? this.escalatedChangesetReasons(plan, changeSet)
        : this.reasons(
            plan,
            changeSet.patches.map((patch) => patch.path),
          );
    if (this.requireChangesetReview) {
      reasons.push("Project policy requires human review of every changeset");
    }
    return [...new Set(reasons)];
  }

  public scopeReasons(
    _plan: AgentPlan,
    request: ScopeChangeRequest,
  ): string[] {
    if (!this.enabled) {
      return [];
    }
    const reasons =
      this.requireSchemaReview && request.additionalSchemas.length > 0
        ? ["Scope expansion changes one or more schemas"]
        : [];
    reasons.push(...this.pathReasons(request.additionalFiles));
    return [...new Set(reasons)];
  }

  private reasons(plan: AgentPlan, files: readonly string[]): string[] {
    const reasons: string[] = [];
    if (this.riskLevels.has(plan.riskLevel)) {
      reasons.push(`Task risk level is ${plan.riskLevel}`);
    }
    if (
      this.requireSchemaReview &&
      (plan.expectedSchemas?.length ?? 0) > 0
    ) {
      reasons.push("Task changes one or more schemas");
    }
    reasons.push(...this.pathReasons(files));
    return [...new Set(reasons)];
  }

  private escalatedChangesetReasons(
    plan: AgentPlan,
    changeSet: ChangeSet,
  ): string[] {
    if (
      changeSet.riskAssessment.level !== plan.riskLevel &&
      this.riskLevels.has(changeSet.riskAssessment.level)
    ) {
      return [
        `Changeset risk level increased to ${changeSet.riskAssessment.level}`,
      ];
    }
    return [];
  }

  private pathReasons(files: readonly string[]): string[] {
    const reasons: string[] = [];
    for (const file of files) {
      const match = this.pathPatterns.find((entry) => entry.regex.test(file));
      if (match !== undefined) {
        reasons.push(
          `Path ${file} matches protected pattern ${match.pattern}`,
        );
      }
    }
    return [...new Set(reasons)];
  }
}

export interface ApprovalReviewInput {
  organizationId?: string;
  projectId?: string;
  repositoryId: string;
  runId: string;
  taskId: string;
  kind: ApprovalKind;
  requestedBy: string;
  reasons: string[];
  changeSetId?: string;
  scopeChangeId?: string;
  signal?: AbortSignal;
  onRequested?: (request: ApprovalRequest) => void | Promise<void>;
}

export interface ApprovalReviewResult {
  request: ApprovalRequest;
  approved: boolean;
  explanation: string;
}

export interface ApprovalController {
  review(input: ApprovalReviewInput): Promise<ApprovalReviewResult>;
}

export interface StoreApprovalControllerOptions {
  pollIntervalMs?: number;
  now?: () => Date;
}

/**
 * Durable human approval gate.
 *
 * The worker polls because the reviewer may be using a different process
 * through the API or CLI. Every state transition is atomic in the store.
 */
export class StoreApprovalController implements ApprovalController {
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;

  public constructor(
    private readonly store: CoordinationStore,
    private readonly timeoutMs: number,
    options: StoreApprovalControllerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 10) {
      throw new RangeError("Approval polling interval must be at least 10 ms");
    }
  }

  public async review(
    input: ApprovalReviewInput,
  ): Promise<ApprovalReviewResult> {
    const created = this.now();
    const requestInput: CreateApprovalInput = {
      ...(input.organizationId === undefined
        ? {}
        : { organizationId: input.organizationId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      repositoryId: input.repositoryId,
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      requestedBy: input.requestedBy,
      requiredRole: "reviewer",
      reasons: [...input.reasons],
      ...(input.changeSetId === undefined
        ? {}
        : { changeSetId: input.changeSetId }),
      ...(input.scopeChangeId === undefined
        ? {}
        : { scopeChangeId: input.scopeChangeId }),
      expiresAt: new Date(created.getTime() + this.timeoutMs).toISOString(),
    };
    const request = await this.store.createApproval(requestInput);
    await input.onRequested?.(request);

    while (true) {
      if (input.signal?.aborted === true) {
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("Approval wait was cancelled");
      }
      const current = await this.store.getApproval(request.id);
      if (current === undefined) {
        throw new Error(`Approval request disappeared: ${request.id}`);
      }
      if (current.status === "approved" || current.status === "rejected") {
        return {
          request: current,
          approved: current.status === "approved",
          explanation:
            current.decisionComment ??
            `Approval was ${current.status} by ${current.decidedBy ?? "unknown"}`,
        };
      }
      if (
        current.status === "expired" ||
        current.status === "cancelled" ||
        current.expiresAt <= this.now().toISOString()
      ) {
        await this.store.expireApprovals(this.now().toISOString());
        return {
          request: (await this.store.getApproval(request.id)) ?? current,
          approved: false,
          explanation: `Approval ${request.id} expired or was cancelled`,
        };
      }
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        };
        const abort = () => {
          finish(
            input.signal?.reason instanceof Error
              ? input.signal.reason
              : new Error("Approval wait was cancelled"),
          );
        };
        const timer = setTimeout(() => {
          finish();
        }, this.pollIntervalMs);
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted === true) {
          abort();
        }
      });
    }
  }
}

/** Test and trusted-local controller that records an immediate reviewer decision. */
export class AutoApprovalController implements ApprovalController {
  public constructor(
    private readonly store: CoordinationStore,
    private readonly reviewerId = "system-auto-reviewer",
  ) {}

  public async review(
    input: ApprovalReviewInput,
  ): Promise<ApprovalReviewResult> {
    const request = await this.store.createApproval({
      ...(input.organizationId === undefined
        ? {}
        : { organizationId: input.organizationId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      repositoryId: input.repositoryId,
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      requestedBy: input.requestedBy,
      requiredRole: "reviewer",
      reasons: [...input.reasons],
      ...(input.changeSetId === undefined
        ? {}
        : { changeSetId: input.changeSetId }),
      ...(input.scopeChangeId === undefined
        ? {}
        : { scopeChangeId: input.scopeChangeId }),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await input.onRequested?.(request);
    const decided = await this.store.decideApproval({
      approvalId: request.id,
      status: "approved",
      decidedBy: this.reviewerId,
      comment: "Automatically approved by the trusted-local controller",
      decidedAt: new Date().toISOString(),
    });
    return {
      request: decided,
      approved: true,
      explanation: decided.decisionComment ?? "Approved",
    };
  }
}
