import {
  CodeIntelligenceService,
  type RepositoryIndex,
} from "@coord/code-intelligence";
import type {
  CoordinationStore,
  StoredRepository,
  SubmittedTask,
} from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import type {
  ProjectId,
  UserId,
  ValidationCommand,
} from "@coord/shared-types";

import {
  estimateScope,
  moduleRootFor,
  moduleRootsFrom,
  type ScopeEstimate,
  type ScopeEstimationOptions,
} from "./scope-estimation.js";
import {
  decomposeTask,
  type ContendingWork,
  type DecompositionDecision,
  type DecompositionOptions,
} from "./task-decomposition.js";

/**
 * The intake stage: everything that happens between a person describing work
 * and that work existing in the queue.
 *
 * Before this existed, intake was a single store write. That is the right
 * shape for a queue but the wrong shape for a coordinator, because it is the
 * last moment at which the *size* of a unit of work is still negotiable.
 * After it, the task is atomic by definition: an agent plans it, holds leases
 * for all of it, and every conflict that follows is a conflict this stage
 * could have declined to create.
 *
 * The service is failure-tolerant by construction. Estimation needs a
 * canonical revision and an index; either can be unavailable — a repository
 * with no commits, a mirror being rewritten, a git binary that is not there —
 * and none of those are reasons a person cannot submit a task. Every failure
 * path here falls back to submitting the objective whole, which is exactly
 * what the platform did before, and records why.
 */

export interface TaskIntakeOptions extends DecompositionOptions {
  estimation?: ScopeEstimationOptions;
  /**
   * How many queued tasks to estimate when looking for contention. Estimation
   * is cheap against a cached index but not free, and the tasks most likely to
   * contend are the ones nearest the front of the queue. Default 25.
   */
  maxContentionSamples?: number;
}

export interface TaskIntakeRequest {
  repository: StoredRepository;
  objective: string;
  agentId: string;
  validationCommands: ValidationCommand[];
  projectId?: ProjectId;
  submittedBy?: UserId;
}

export interface TaskIntakeResult {
  /** Every task written to the queue: one, or the pieces of a split. */
  tasks: SubmittedTask[];
  decision: DecompositionDecision;
  /** Absent when the repository could not be indexed at submission time. */
  estimate?: ScopeEstimate;
  /** Why estimation was skipped, when it was. */
  degraded?: string;
}

function toCanonical(repository: StoredRepository): CanonicalRepository {
  return {
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TaskIntakeService {
  public constructor(
    private readonly codeIntelligence = new CodeIntelligenceService(),
    private readonly repositories = new RepositoryService(),
    private readonly options: TaskIntakeOptions = {},
  ) {}

  /**
   * Submits an objective as one task, or as several narrower ones.
   *
   * The returned tasks are in queue order and are the complete set: a caller
   * that reports `result.tasks[0]` and ignores the rest would be lying about
   * what it queued.
   */
  public async submit(
    store: CoordinationStore,
    request: TaskIntakeRequest,
  ): Promise<TaskIntakeResult> {
    const objective = request.objective.trim();
    if (objective.length === 0) {
      throw new Error("A task needs a non-empty objective");
    }

    const mode = this.options.mode ?? "contended";
    if (mode === "off") {
      const task = await this.submitOne(store, request, objective);
      return {
        tasks: [task],
        decision: {
          split: false,
          reason: "disabled",
          explanation: "Intake decomposition is disabled.",
          subtasks: [],
          contendingTaskIds: [],
        },
      };
    }

    let index: RepositoryIndex;
    try {
      const canonical = toCanonical(request.repository);
      const version = await this.repositories.getCanonicalVersion(canonical);
      index = await this.codeIntelligence.index(canonical, version.revision);
    } catch (error) {
      const degraded =
        `Scope could not be estimated (${errorMessage(error)}); ` +
        "the objective was queued whole.";
      const task = await this.submitOne(store, request, objective);
      return {
        tasks: [task],
        decision: {
          split: false,
          reason: "unknown_scope",
          explanation: degraded,
          subtasks: [],
          contendingTaskIds: [],
        },
        degraded,
      };
    }

    const estimate = estimateScope(objective, index, this.options.estimation);
    const contention = await this.gatherContention(store, request, index);
    const decision = decomposeTask({
      objective,
      estimate,
      index,
      contention,
      options: this.options,
    });

    if (!decision.split) {
      const task = await this.submitOne(store, request, objective);
      return { tasks: [task], decision, estimate };
    }

    const tasks: SubmittedTask[] = [];
    for (const subtask of decision.subtasks) {
      tasks.push(await this.submitOne(store, request, subtask.objective));
    }

    // Recorded without a run, because intake happens before any run exists.
    // The event is the only durable trace that one submitted objective became
    // several tasks; without it the queue would show siblings with no parent
    // and no reason.
    await store.appendAudit(undefined, {
      type: "task_decomposed",
      data: {
        repositoryId: request.repository.id,
        ...(request.projectId === undefined
          ? {}
          : { projectId: request.projectId }),
        objective,
        reason: decision.reason,
        explanation: decision.explanation,
        revision: estimate.revision,
        confidence: estimate.confidence,
        contendingTaskIds: decision.contendingTaskIds,
        subtasks: decision.subtasks.map((subtask, order) => ({
          taskId: tasks[order]?.id,
          modules: subtask.modules,
          files: subtask.files,
          contended: subtask.contended,
        })),
      },
    });

    return { tasks, decision, estimate };
  }

  private async submitOne(
    store: CoordinationStore,
    request: TaskIntakeRequest,
    objective: string,
  ): Promise<SubmittedTask> {
    return await store.submitTask({
      repositoryId: request.repository.id,
      ...(request.projectId === undefined
        ? {}
        : { projectId: request.projectId }),
      objective,
      agentId: request.agentId,
      validationCommands: request.validationCommands,
      ...(request.submittedBy === undefined
        ? {}
        : { submittedBy: request.submittedBy }),
    });
  }

  /**
   * What the new task would be competing with, strongest evidence first.
   *
   * A task holding live file leases has a *declared* scope — the same file set
   * arbitration itself compares against — so that is used verbatim. A task
   * still in the queue has no plan and no leases, so its footprint is
   * estimated exactly as this one's was. The weak signal matters more than it
   * looks: two large overlapping tasks submitted a minute apart hold nothing
   * yet, and a lease-only view would see an idle repository right up until
   * they collided.
   *
   * Never throws. Contention that cannot be read is contention this stage does
   * not know about, and not knowing means declining to split — the safe
   * direction.
   */
  private async gatherContention(
    store: CoordinationStore,
    request: TaskIntakeRequest,
    index: RepositoryIndex,
  ): Promise<ContendingWork[]> {
    const limit = this.options.maxContentionSamples ?? 25;
    const roots = moduleRootsFrom(index);
    const contention: ContendingWork[] = [];
    const leaseHolders = new Set<string>();

    for (const [taskId, files] of await this.leasedFiles(store, request)) {
      leaseHolders.add(taskId);
      contention.push({
        taskId,
        source: "lease",
        modules: [
          ...new Set(files.map((file) => moduleRootFor(file, roots))),
        ].sort(),
        files,
      });
    }

    const filter = {
      repositoryId: request.repository.id,
      ...(request.projectId === undefined
        ? {}
        : { projectId: request.projectId }),
    };
    const pending = [
      ...(await store.listSubmittedTasks({ ...filter, status: "claimed" })),
      ...(await store.listSubmittedTasks({ ...filter, status: "submitted" })),
    ];

    for (const task of pending.slice(0, limit)) {
      if (leaseHolders.has(task.id)) {
        continue;
      }
      const estimate = estimateScope(
        task.objective,
        index,
        this.options.estimation,
      );
      if (estimate.confidence === "none") {
        continue;
      }
      contention.push({
        taskId: task.id,
        source: "queued",
        modules: estimate.modules.map((entry) => entry.root),
      });
    }

    return contention;
  }

  /**
   * Unexpired file leases held right now in this repository, by task.
   *
   * Read from the runs rather than from the queue because a claimed task does
   * not carry its run id until it finishes: while the work is actually in
   * flight — precisely when its leases matter — the run is the only place they
   * are reachable from.
   */
  private async leasedFiles(
    store: CoordinationStore,
    request: TaskIntakeRequest,
  ): Promise<Map<string, string[]>> {
    const held = new Map<string, string[]>();
    const now = Date.now();
    try {
      const runs = (await store.listRuns(50)).filter(
        (run) =>
          run.status === "running" &&
          run.repositoryId === request.repository.id &&
          (request.projectId === undefined ||
            run.projectId === undefined ||
            run.projectId === request.projectId),
      );
      for (const run of runs) {
        const detail = await store.getRun(run.id);
        for (const lease of detail?.leases ?? []) {
          if (
            lease.resourceType !== "file" ||
            Date.parse(lease.expiresAt) <= now
          ) {
            continue;
          }
          const files = held.get(lease.taskId) ?? [];
          if (!files.includes(lease.resourceId)) {
            files.push(lease.resourceId);
          }
          held.set(lease.taskId, files);
        }
      }
    } catch {
      // A store that cannot answer is a missing signal, not a failed
      // submission: contention detection degrades to the queue estimate.
      return held;
    }
    for (const files of held.values()) {
      files.sort();
    }
    return held;
  }
}
