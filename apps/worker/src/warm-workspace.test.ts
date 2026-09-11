import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitClient, RepositoryService } from "@coord/repository-service";
import type { CanonicalVersion, TaskId } from "@coord/shared-types";
import {
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
} from "@coord/workspace-manager";

import {
  clearWarmSlots,
  warmRepositoryRoot,
  warmSlotPath,
  WorkerWarmBackend,
} from "./warm-workspace.js";

/**
 * The worker's slot is a local clone rather than a worktree of a mirror it
 * cannot reach, so the two things it has to do differently from the control
 * plane are both here: catching up to a revision by fetching from the bare
 * cache, and going away with a plain removal rather than a `worktree remove`.
 */

test("slot paths cannot select or collapse the warm root", () => {
  const root = path.resolve("worker-warm");
  const repositoryRoot = warmRepositoryRoot(root, "../../../../\0");
  assert.equal(path.dirname(repositoryRoot), path.join(root, "warm"));
  assert.notEqual(repositoryRoot, path.join(root, "warm"));

  const slot = warmSlotPath(root, "../../../../\0", "lease/../../x");
  assert.equal(path.dirname(slot), repositoryRoot);
  assert.match(path.basename(slot), /^[a-f0-9]{24}$/u);
});

test("clearing the warm root is safe when there is nothing there", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-clear-"));
  try {
    await clearWarmSlots(root);
    await writeFile(path.join(root, "warm-marker"), "x\n", "utf8");
    await mkdir(warmRepositoryRoot(root, "repo"), { recursive: true });
    await clearWarmSlots(root);
    await assert.rejects(access(path.join(root, "warm")));
    // Only the warm root goes; its neighbours are somebody else's.
    await access(path.join(root, "warm-marker"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a slot catches up to a revision by fetching from its bare cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-backend-"));
  try {
    const git = new GitClient();
    const repositories = new RepositoryService(git);
    const sourcePath = path.join(root, "source");
    await repositories.initializeWorkingRepository(sourcePath);
    await writeFile(path.join(sourcePath, "a.txt"), "one\n", "utf8");
    await writeFile(path.join(sourcePath, ".gitignore"), ".env\n", "utf8");
    await repositories.commitAll(sourcePath, "first");

    // The bare cache a worker keeps per repository, standing in for what
    // `updateCache` leaves behind inside a lease.
    const cache = path.join(root, "cache.git");
    await git.run(["init", "--bare", cache]);
    await git.run(["-C", sourcePath, "push", cache, "HEAD:refs/heads/main"]);
    const firstRevision = (
      await git.run(["-C", sourcePath, "rev-parse", "HEAD"])
    ).stdout.trim();

    const slot = path.join(root, "slot");
    await git.run(["clone", "--no-checkout", cache, slot]);
    await git.run(["-C", slot, "checkout", "--detach", firstRevision]);
    await git.run(["-C", slot, "remote", "remove", "origin"]);

    const version = (revision: string): CanonicalVersion => ({
      revision,
      sequence: 1,
      branch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const workspace: TaskWorkspace = {
      id: "workspace_slot",
      taskId: "task_one" as TaskId,
      path: slot,
      rootPath: path.dirname(slot),
      repository: { id: "repo", path: slot, branch: "main" },
      baseVersion: version(firstRevision),
      isolation: "git-worktree",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const backend = new WorkerWarmBackend(
      git,
      new GitWorktreeWorkspaceManager(git),
      cache,
    );

    // A scrub on a clone means what it means on a worktree: ignored files go,
    // dependency trees stay.
    await writeFile(path.join(slot, ".env"), "SECRET=1\n", "utf8");
    await mkdir(path.join(slot, "node_modules"), { recursive: true });
    await writeFile(path.join(slot, "node_modules", "x.js"), "1\n", "utf8");
    assert.deepEqual(await backend.scrub(workspace), { clean: true });
    await assert.rejects(access(path.join(slot, ".env")));
    await access(path.join(slot, "node_modules", "x.js"));

    // Canonical moves, the cache absorbs it, and the slot catches up — the
    // ref name of the lease that will take this slot is not knowable from
    // here, which is why every ref is fetched rather than one.
    await writeFile(path.join(sourcePath, "a.txt"), "two\n", "utf8");
    await repositories.commitAll(sourcePath, "second");
    await git.run([
      "-C",
      sourcePath,
      "push",
      cache,
      "HEAD:refs/coord/leases/lease_two",
    ]);
    const secondRevision = (
      await git.run(["-C", sourcePath, "rev-parse", "HEAD"])
    ).stdout.trim();

    const advanced = await backend.advance(workspace, {
      taskId: "task_two" as TaskId,
      baseVersion: version(secondRevision),
    });
    assert.equal(advanced.path, slot);
    assert.equal(advanced.taskId, "task_two");
    assert.equal(await readFile(path.join(slot, "a.txt"), "utf8"), "two\n");
    // The expensive half is still there: an advance is a reset, not a
    // re-clone.
    await access(path.join(slot, "node_modules", "x.js"));

    // And the catch-up left no residue in the ref namespace. The cache holds
    // one `refs/coord/leases/<lease id>` per lease this machine ever ran and
    // drops none, so a fetch of every ref that kept what it landed would add
    // all of them to the slot on every take, growing its ref set and pinning
    // the objects behind it for as long as the slot lives.
    const refs = await git.run([
      "-C",
      slot,
      "for-each-ref",
      "--format=%(refname)",
      "refs/warm-cache",
    ]);
    assert.equal(refs.stdout.trim(), "");

    // A revision the cache cannot answer for is refused rather than silently
    // leaving the agent on the wrong base.
    await assert.rejects(
      backend.advance(workspace, {
        taskId: "task_three" as TaskId,
        baseVersion: version("0".repeat(40)),
      }),
    );

    await backend.destroy(advanced);
    await assert.rejects(access(slot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
