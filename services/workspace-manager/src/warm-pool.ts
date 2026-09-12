/**
 * A bounded pool of task directories kept warm per repository.
 *
 * The expensive half of starting a task is not the agent, it is the
 * directory: a full `worktree add` checkout, and then whatever the agent has
 * to install into it before it can run anything. Both survive a task; neither
 * survives the teardown that follows it. This keeps a landed task's directory
 * instead of destroying it, scrubs it back to a verified-clean checkout, and
 * hands it to the next task in the same repository.
 *
 * ### The rules that make reuse safe
 *
 * **Only success keeps anything.** A directory is offered back only by a task
 * that integrated. A failed or cancelled task's agent process can outlive the
 * cancel that was sent to it, so its directory may still be being written to
 * while the scrub runs, and the next tenant would inherit the result.
 *
 * **Scrub, then verify, then hand over.** `WorkspaceManager.scrub` resets to
 * the base hash, cleans every untracked path including ignored ones except
 * the ephemeral excludes, and verifies with `git status --ignored`. Anything
 * that fails verification is destroyed, never handed out. The cost of a false
 * refusal is one cold start; the cost of a false acceptance is a stranger's
 * `.env` in somebody else's changeset.
 *
 * **Re-base on take, not invalidate on promotion.** A take always ends in
 * `backend.advance(entry, { taskId, baseVersion })`, so canonical moving
 * while a directory sits in the pool costs nothing and needs no listener: the
 * entry catches up at the moment it is handed over.
 *
 * ### Scope
 *
 * Process lifetime only. Nothing durable describes a slot, and both hosts
 * clear their roots at start (crash recovery on the control plane, the
 * worker's own sweep), so a restart is a cold start by design.
 */

import path from "node:path";

import type { ProcessOutput } from "@coord/repository-service";

import type {
  AdvanceWorkspaceInput,
  CreateWorkspaceInput,
  SandboxLaunchSpec,
  ScrubResult,
  TaskWorkspace,
  WorkspaceCommandOptions,
  WorkspaceManager,
} from "./index.js";

/**
 * What the pool does with a directory it owns.
 *
 * A `WorkspaceManager` carrying `scrub` and `advance` satisfies this
 * structurally, which is how the control plane passes its own manager; the
 * remote worker passes a small adapter over its lease-local git client
 * instead. The reference is held per entry rather than per pool because the
 * pool outlives the run whose manager built the directory — the same reason
 * an open conversation carries its own teardown closure.
 */
export interface WarmWorkspaceBackend {
  scrub(workspace: TaskWorkspace): Promise<ScrubResult>;
  advance(
    workspace: TaskWorkspace,
    input: AdvanceWorkspaceInput,
  ): Promise<TaskWorkspace>;
  destroy(workspace: TaskWorkspace): Promise<void>;
  /**
   * Optional, and the only way a prepare step ever runs. Routing the install
   * through the backend means a sandboxed project installs inside its
   * container; running it on the host would hand an unconfined shell to a
   * lockfile the agent just wrote.
   */
  runInWorkspace?(
    workspace: TaskWorkspace,
    spec: SandboxLaunchSpec,
    options?: WorkspaceCommandOptions,
  ): Promise<ProcessOutput>;
}

/**
 * A workspace manager seen as a pool backend, or `undefined` when it cannot be
 * one.
 *
 * `scrub` and `advance` are optional on {@link WorkspaceManager} so that the
 * structural fakes implementing it in tests keep compiling, which means a
 * manager cannot simply be handed to the pool: one missing `scrub` would have
 * a directory handed on without ever being verified, and one missing
 * `advance` could not re-base it onto the revision the next task asked for.
 * Both are silent wrongness rather than a failure, so the check is here and
 * refusing is a cold start.
 */
export function warmBackendFor(
  manager: WorkspaceManager,
): WarmWorkspaceBackend | undefined {
  const scrub = manager.scrub?.bind(manager);
  const advance = manager.advance?.bind(manager);
  if (scrub === undefined || advance === undefined) {
    return undefined;
  }
  return {
    scrub,
    advance,
    destroy: manager.destroy.bind(manager),
    runInWorkspace: manager.runInWorkspace.bind(manager),
  };
}

/**
 * What the pool did about the directory's dependencies before handing it over.
 *
 * `present` is the common retained case — the landed agent's own
 * `node_modules` survived the scrub, so there was nothing to do and that is
 * not the same as there being nothing to install. `skipped` means no prepare
 * step was configured or it could not be run (a `network: none` sandbox
 * cannot reach a registry, so attempting it would fail every time and read as
 * an error the operator has to explain). `failed` still keeps the directory:
 * a checkout hit without dependencies is a hit.
 */
export type WarmDependencies =
  | "installed"
  | "present"
  | "absent"
  | "skipped"
  | "failed";

/** What a configured prepare step reports about a freshly scrubbed directory. */
export type WarmPrepareOutcome = "installed" | "present" | "absent";

export interface WarmWorkspacePoolOptions {
  /**
   * How many directories to keep per repository. Defaults to
   * `COORD_WARM_WORKSPACES_PER_REPOSITORY`, then to 1. Zero disables the pool
   * entirely: every `retain` is refused and every `take` misses, which is
   * exactly today's create-and-destroy behaviour.
   */
  perRepository?: number;
  /**
   * How long an unused directory is kept before {@link
   * WarmWorkspacePool.closeIdle} destroys it. Defaults to
   * `COORD_WARM_WORKSPACE_IDLE_MS`, then to six hours — a directory nobody has
   * asked for since this morning is disk, not warmth.
   */
  idleMs?: number;
  /**
   * Optional dependency preparation, run once per retained directory in the
   * background. Absent means every hand-over reports `skipped`.
   */
  prepare?: (
    workspace: TaskWorkspace,
    run: (
      spec: SandboxLaunchSpec,
      options?: WorkspaceCommandOptions,
    ) => Promise<ProcessOutput>,
  ) => Promise<WarmPrepareOutcome>;
  /** Where the one line per take goes. Injected so tests can read it. */
  log?: (line: string) => void;
}

export interface WarmWorkspaceStats {
  hits: number;
  misses: number;
  retained: number;
  discarded: number;
  prepareFailures: number;
}

interface WarmEntry {
  workspace: TaskWorkspace;
  backend: WarmWorkspaceBackend;
  retainedAt: number;
  state: "pending" | "ready";
  dependencies: WarmDependencies;
  settling: Promise<void>;
}

/** Six hours. */
const DEFAULT_IDLE_MS = 21_600_000;
const DEFAULT_PER_REPOSITORY = 1;

/**
 * A whole number from the environment, or the default.
 *
 * Deliberately strict: a deployment that sets a knob to something the parser
 * does not understand gets the documented default rather than a silently
 * disabled pool, and an operator reading `COORD_WARM_WORKSPACES_PER_REPOSITORY=one`
 * back out of the environment sees that it did nothing rather than that it
 * worked.
 */
function configuredWholeNumber(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export class WarmWorkspacePool {
  private readonly entries = new Map<string, WarmEntry[]>();
  private readonly perRepository: number;
  private readonly idleMs: number;
  private readonly prepare: WarmWorkspacePoolOptions["prepare"];
  private readonly log: (line: string) => void;
  private readonly prepareFailedFor = new Set<string>();
  private hits = 0;
  private misses = 0;
  private retained = 0;
  private discarded = 0;
  private prepareFailures = 0;

  public constructor(options: WarmWorkspacePoolOptions = {}) {
    this.perRepository =
      options.perRepository ??
      configuredWholeNumber(
        "COORD_WARM_WORKSPACES_PER_REPOSITORY",
        DEFAULT_PER_REPOSITORY,
      );
    this.idleMs =
      options.idleMs ??
      configuredWholeNumber("COORD_WARM_WORKSPACE_IDLE_MS", DEFAULT_IDLE_MS);
    this.prepare = options.prepare;
    this.log = options.log ?? ((line: string) => console.log(line));
  }

  /**
   * Offers a landed task's directory to the pool.
   *
   * Synchronous up to the moment ownership is decided, and it has to be: the
   * caller destroys the directory when this returns false, so a yield between
   * the decision and the bookkeeping would let two callers both be told they
   * still own it. Everything slow — the scrub, the optional install — happens
   * afterwards, in the entry's own `settling` promise, with the entry already
   * in the map and marked `pending` so a concurrent take passes over it.
   */
  public retain(
    backend: WarmWorkspaceBackend,
    workspace: TaskWorkspace,
  ): boolean {
    if (this.perRepository <= 0) {
      return false;
    }
    const repositoryId = workspace.repository.id;
    const existing = this.entries.get(repositoryId) ?? [];
    if (existing.length >= this.perRepository) {
      return false;
    }
    const entry: WarmEntry = {
      workspace,
      backend,
      retainedAt: Date.now(),
      state: "pending",
      dependencies: "skipped",
      settling: Promise.resolve(),
    };
    existing.push(entry);
    this.entries.set(repositoryId, existing);
    this.retained += 1;
    entry.settling = this.settle(repositoryId, entry);
    return true;
  }

  /**
   * Hands a ready directory to the next task, re-based on the requested
   * revision.
   *
   * A `pending` entry is a miss and stays warming. Waiting on somebody else's
   * `npm install` is strictly worse than the cold checkout the caller would
   * otherwise do, and the entry is still there for the task after this one.
   */
  public async take(
    input: CreateWorkspaceInput,
  ): Promise<
    { workspace: TaskWorkspace; dependencies: WarmDependencies } | undefined
  > {
    const repositoryId = input.repository.id;
    const rootPath = path.resolve(input.rootPath);
    const candidates = this.entries.get(repositoryId) ?? [];
    // Removed before any await, for the reason `retain` is synchronous: two
    // tasks starting together must not be handed the same directory.
    const index = candidates.findIndex(
      (entry) =>
        entry.state === "ready" && entry.workspace.rootPath === rootPath,
    );
    if (index < 0) {
      this.misses += 1;
      this.log(`[warm] ${repositoryId} workspace miss`);
      return undefined;
    }
    const [entry] = candidates.splice(index, 1);
    if (entry === undefined) {
      this.misses += 1;
      this.log(`[warm] ${repositoryId} workspace miss`);
      return undefined;
    }
    this.prune(repositoryId, candidates);
    let advanced: TaskWorkspace;
    try {
      advanced = await entry.backend.advance(entry.workspace, {
        taskId: input.taskId,
        baseVersion: input.baseVersion,
      });
    } catch (error) {
      this.discarded += 1;
      this.misses += 1;
      this.log(
        `[warm] ${repositoryId} workspace discarded: advance failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.destroyQuietly(entry);
      return undefined;
    }
    this.hits += 1;
    this.log(
      `[warm] ${repositoryId} workspace hit (dependencies ${entry.dependencies})`,
    );
    return { workspace: advanced, dependencies: entry.dependencies };
  }

  /** Destroys every entry nobody has taken within the idle bound. */
  public async closeIdle(now: number = Date.now()): Promise<void> {
    const expired: WarmEntry[] = [];
    for (const [repositoryId, entries] of [...this.entries]) {
      const kept = entries.filter((entry) => {
        if (now - entry.retainedAt < this.idleMs) {
          return true;
        }
        expired.push(entry);
        return false;
      });
      this.prune(repositoryId, kept);
    }
    await Promise.allSettled(
      expired.map(async (entry) => {
        await entry.settling.catch(() => {});
        await this.destroyQuietly(entry);
      }),
    );
  }

  /**
   * Gives every directory back at shutdown.
   *
   * Best-effort on the settling promise first: a scrub or install still
   * running holds file handles in the directory it is about to remove, and on
   * Windows that is the difference between a clean exit and a stuck one.
   */
  public async drain(): Promise<void> {
    const all = [...this.entries.values()].flat();
    this.entries.clear();
    await Promise.allSettled(
      all.map(async (entry) => {
        await entry.settling.catch(() => {});
        await this.destroyQuietly(entry);
      }),
    );
  }

  public stats(): WarmWorkspaceStats {
    return {
      hits: this.hits,
      misses: this.misses,
      retained: this.retained,
      discarded: this.discarded,
      prepareFailures: this.prepareFailures,
    };
  }

  public size(repositoryId: string): number {
    return (this.entries.get(repositoryId) ?? []).length;
  }

  /** Awaits everything in flight, for tests that must observe a settled pool. */
  public async settled(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()].flat().map((entry) => entry.settling),
    );
  }

  private async settle(
    repositoryId: string,
    entry: WarmEntry,
  ): Promise<void> {
    const scrubbed = await entry.backend
      .scrub(entry.workspace)
      .catch(
        (error: unknown): ScrubResult => ({
          clean: false,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    if (!scrubbed.clean) {
      this.remove(repositoryId, entry);
      this.discarded += 1;
      this.log(
        `[warm] ${repositoryId} workspace discarded: ${scrubbed.reason}`,
      );
      await this.destroyQuietly(entry);
      return;
    }
    entry.dependencies = await this.runPrepare(repositoryId, entry);
    entry.state = "ready";
  }

  private async runPrepare(
    repositoryId: string,
    entry: WarmEntry,
  ): Promise<WarmDependencies> {
    const prepare = this.prepare;
    const run = entry.backend.runInWorkspace?.bind(entry.backend);
    if (prepare === undefined || run === undefined) {
      return "skipped";
    }
    try {
      return await prepare(entry.workspace, async (spec, options) =>
        await run(entry.workspace, spec, options),
      );
    } catch (error) {
      this.prepareFailures += 1;
      // Once per repository. A project whose install cannot run here will do
      // it again on every landing, and a line per task would bury the one
      // line that says why.
      if (!this.prepareFailedFor.has(repositoryId)) {
        this.prepareFailedFor.add(repositoryId);
        this.log(
          `[warm] ${repositoryId} dependency preparation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return "failed";
    }
  }

  private remove(repositoryId: string, entry: WarmEntry): void {
    const entries = this.entries.get(repositoryId);
    if (entries === undefined) {
      return;
    }
    const index = entries.indexOf(entry);
    if (index >= 0) {
      entries.splice(index, 1);
    }
    this.prune(repositoryId, entries);
  }

  private prune(repositoryId: string, entries: WarmEntry[]): void {
    if (entries.length === 0) {
      this.entries.delete(repositoryId);
      return;
    }
    this.entries.set(repositoryId, entries);
  }

  private async destroyQuietly(entry: WarmEntry): Promise<void> {
    try {
      await entry.backend.destroy(entry.workspace);
    } catch {
      // A directory that will not go is not a reason to fail the task that
      // handed it back; it is disk, and the idle sweep and the host's own
      // start-up clear are both still ahead of it.
    }
  }
}
