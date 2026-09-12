/**
 * The worker's side of the warm-workspace pool.
 *
 * The remote worker is the product's primary executor — agents run on
 * people's own laptops, not in a cloud sandbox — so the per-task cost that
 * matters most is paid here. Every lease used to clone into its own scratch
 * directory and delete it in a `finally`, which meant the checkout was paid
 * again per task and whatever the agent installed into it died with the
 * lease.
 *
 * A warm slot is a retained local clone, per repository, outside every
 * lease's scratch so the teardown leaves it alone. It is offered back only by
 * a lease the control plane says reached canonical, scrubbed to a
 * verified-clean checkout by the same {@link GitWorktreeWorkspaceManager}
 * rule the control plane uses, and re-based on the next lease's revision at
 * the moment it is handed over.
 *
 * There is deliberately no prepare step here: the worker never installs
 * anything, the agent does, and the agent's own `node_modules` surviving the
 * scrub is precisely what retention is for.
 */

import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { GitClient } from "@coord/repository-service";
import type {
  AdvanceWorkspaceInput,
  GitWorktreeWorkspaceManager,
  ScrubResult,
  TaskWorkspace,
  WarmWorkspaceBackend,
} from "@coord/workspace-manager";

/** How long a git command in a warm slot may take before it is a failure. */
const GIT_COMMAND_TIMEOUT_MS = 20 * 60 * 1_000;

/**
 * Where a repository's warm slots live.
 *
 * Under `workspaceRoot/warm/` rather than under a lease's scratch, which is
 * the whole point: the run's `finally` removes its scratch, and a slot has to
 * outlive that. A repository id is a coordinator identifier rather than
 * anything a person types, but it becomes a path segment here, so it is
 * reduced to characters that cannot leave the directory they belong in — the
 * same rule the bare repository cache uses.
 */
export function warmSlotPath(
  workspaceRoot: string,
  repositoryId: string,
  slot: string,
): string {
  return path.join(
    warmRepositoryRoot(workspaceRoot, repositoryId),
    createHash("sha256").update(slot, "utf8").digest("hex").slice(0, 24),
  );
}

/**
 * Where one repository's slots live — the `rootPath` every slot shares, which
 * is what the pool matches a take against.
 */
export function warmRepositoryRoot(
  workspaceRoot: string,
  repositoryId: string,
): string {
  const safe = repositoryId.replaceAll(/[^A-Za-z0-9._-]/gu, "_");
  return path.join(
    warmSlotRoot(workspaceRoot),
    safe.length === 0 || safe.replaceAll(".", "") === ""
      ? createHash("sha256").update(repositoryId, "utf8").digest("hex").slice(0, 24)
      : safe,
  );
}

/** The directory every repository's slots sit under. */
export function warmSlotRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), "warm");
}

/**
 * Clears every slot at worker start.
 *
 * Nothing durable describes a slot — the pool is a process-lifetime map — so
 * a directory found here belongs to a process that is gone, and reasoning
 * about what state it was left in is not worth the disk it would save. The
 * same reasoning crash recovery applies to the control plane's scratch roots.
 */
export async function clearWarmSlots(workspaceRoot: string): Promise<void> {
  await rm(warmSlotRoot(workspaceRoot), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

/**
 * A warm slot as the pool sees it.
 *
 * `scrub` is the worktree manager's, unchanged: a slot is an ordinary local
 * clone, and reset/clean/status mean the same thing in one as in a worktree.
 *
 * `advance` is the part that is the worker's own. The control plane's version
 * resets to a revision its mirror already holds; a slot holds only what some
 * earlier lease fetched, so the revision this lease wants has to be brought
 * in first — from the bare cache, which the run has just made absorb this
 * lease's ref inside its per-repository guard.
 *
 * Every ref rather than the lease's own: a slot outlives the lease that
 * retained it, so the backend it carries cannot know the ref name of the
 * lease that will take it next, and a fetch by bare object id is not
 * something a git remote will generally answer. The transfer is cheap anyway
 * — the slot is a clone of that same cache, so nearly every object is already
 * there. The result is then verified against the revision that was asked for
 * before anything is reset to it: a cache that could not answer would
 * otherwise have the agent working on the wrong base and the changeset
 * diffing from it.
 *
 * The refs it lands are then deleted again, which is the half that is easy to
 * forget. The cache accumulates one `refs/coord/leases/<lease id>` per lease
 * and never drops one, so a fetch of every ref mirrors every lease this
 * machine has ever run into the slot, and a slot is taken over and over: the
 * ref set grows without bound and pins the objects behind it. `materialise`
 * is explicit that a workspace carries no refs of the coordinator's — `clone`
 * copies branches and tags, and a lease ref is deliberately neither — and
 * this is what keeps that true here. The scrub cannot see the difference
 * either way, since it verifies the working tree and not the ref namespace.
 * Deleting is safe because the reset below leaves HEAD on the revision, which
 * is all the reachability the slot needs.
 */
export class WorkerWarmBackend implements WarmWorkspaceBackend {
  public constructor(
    private readonly git: GitClient,
    private readonly worktrees: GitWorktreeWorkspaceManager,
    private readonly cachePath: string,
  ) {}

  public async scrub(workspace: TaskWorkspace): Promise<ScrubResult> {
    return await this.worktrees.scrub(workspace);
  }

  public async advance(
    workspace: TaskWorkspace,
    input: AdvanceWorkspaceInput,
  ): Promise<TaskWorkspace> {
    await this.git.run(
      [
        "-C",
        workspace.path,
        "fetch",
        "--no-tags",
        "--force",
        "--prune",
        "--end-of-options",
        this.cachePath,
        "+refs/*:refs/warm-cache/*",
      ],
      { timeoutMs: GIT_COMMAND_TIMEOUT_MS },
    );
    const revision = input.baseVersion.revision;
    const fetched = await this.git
      .run(
        ["-C", workspace.path, "rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
        { allowFailure: true },
      )
      .then((result) => (result.exitCode === 0 ? result.stdout.trim() : ""))
      .catch(() => "");
    if (fetched !== revision) {
      throw new Error(
        `Warm slot does not hold ${revision} after fetching from its cache`,
      );
    }
    // The revision is here now, so the ordinary reset-to-a-hash advance is
    // all that remains — and it is the one that keeps untracked files, which
    // is what makes this worth doing at all.
    const advanced = await this.worktrees.advance(workspace, input);
    // After the reset, never before it: until HEAD is on the revision, these
    // refs are the only thing keeping the objects just fetched reachable.
    await this.dropCacheRefs(workspace.path);
    return advanced;
  }

  /**
   * Removes the refs the catch-up fetch landed, leaving the slot's namespace
   * as `clone` left it.
   *
   * Best-effort: a slot that still carries them is untidy and slowly heavier,
   * not wrong, and failing an advance over it would turn that into a cold
   * checkout for the task waiting on it.
   */
  private async dropCacheRefs(workspacePath: string): Promise<void> {
    try {
      const listed = await this.git.run(
        [
          "-C",
          workspacePath,
          "for-each-ref",
          "--format=%(refname)",
          "refs/warm-cache",
        ],
        { allowFailure: true },
      );
      const deletions = listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("refs/warm-cache/"))
        .map((ref) => `delete ${ref}\n`)
        .join("");
      if (deletions.length === 0) {
        return;
      }
      await this.git.run(["-C", workspacePath, "update-ref", "--stdin"], {
        input: deletions,
        allowFailure: true,
      });
    } catch {
      return;
    }
  }

  public async destroy(workspace: TaskWorkspace): Promise<void> {
    // Not `worktrees.destroy`: a slot is a clone of its own, not a worktree
    // registered against a mirror, so there is no registration to remove and
    // `worktree remove` would refuse it.
    await rm(workspace.path, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Makes sure a slot's parent directory exists before anything is moved into
 * it, since a scratch-born workspace is renamed rather than created there.
 */
export async function prepareWarmSlot(slotPath: string): Promise<void> {
  await mkdir(path.dirname(slotPath), { recursive: true });
}
