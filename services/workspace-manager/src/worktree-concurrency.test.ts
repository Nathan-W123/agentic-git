import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GitClient,
  RepositoryService,
  type GitRunOptions,
  type ProcessOutput,
} from "@coord/repository-service";

import { GitWorktreeWorkspaceManager } from "./index.js";

/**
 * Worktree bookkeeping must not read a mirror while something is deleting
 * from it.
 *
 * `git worktree add`, `remove` and `prune` each enumerate every registered
 * worktree and read its `commondir`, without locking. Only `remove` and
 * `prune` delete, so the dangerous interleaving is specifically a delete
 * running alongside anything else — and because removing a directory is not
 * atomic, `commondir` disappears before the entry containing it does. Under a
 * loaded machine that surfaced as
 *
 *     fatal: failed to read .../worktrees/<other>/commondir
 *
 * It was seen once, in a full-suite run with the CPU saturated, and could not
 * be provoked in isolation afterwards. That is the signature of a timing
 * window rather than of its absence, so these tests assert the property that
 * closes it instead of trying to lose the race on demand.
 */

type Kind = "read" | "write";

/** Records overlap between worktree subcommands, by mirror and by kind. */
class OverlapRecordingGitClient extends GitClient {
  public readonly violations: string[] = [];
  public maxConcurrentReads = 0;
  private readonly reads = new Map<string, number>();
  private readonly writes = new Map<string, number>();

  private static kindOf(args: readonly string[]): Kind {
    return args.includes("remove") || args.includes("prune") ? "write" : "read";
  }

  public override async run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<ProcessOutput> {
    if (!args.includes("worktree")) {
      return await super.run(args, options);
    }
    const mirror = args.find((arg) => arg.startsWith("--git-dir=")) ?? "";
    const kind = OverlapRecordingGitClient.kindOf(args);
    const reads = this.reads.get(mirror) ?? 0;
    const writes = this.writes.get(mirror) ?? 0;

    // A delete must be alone. A read may share with other reads but never
    // with a delete.
    if (writes > 0) {
      this.violations.push(`${kind} overlapped a delete on ${mirror}`);
    } else if (kind === "write" && reads > 0) {
      this.violations.push(`delete overlapped ${reads} read(s) on ${mirror}`);
    }

    if (kind === "read") {
      this.reads.set(mirror, reads + 1);
      this.maxConcurrentReads = Math.max(this.maxConcurrentReads, reads + 1);
    } else {
      this.writes.set(mirror, writes + 1);
    }
    try {
      return await super.run(args, options);
    } finally {
      if (kind === "read") {
        this.reads.set(mirror, (this.reads.get(mirror) ?? 1) - 1);
      } else {
        this.writes.set(mirror, (this.writes.get(mirror) ?? 1) - 1);
      }
    }
  }
}

async function seedRepository(
  repositories: RepositoryService,
  root: string,
  name: string,
) {
  const sourcePath = path.join(root, `${name}-source`);
  await repositories.initializeWorkingRepository(sourcePath);
  await writeFile(path.join(sourcePath, "a.txt"), "seed\n", "utf8");
  await repositories.commitAll(sourcePath, "seed");
  const repository = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, `${name}.git`),
    name,
  );
  return {
    repository,
    version: await repositories.getCanonicalVersion(repository),
  };
}

test("a worktree teardown never runs beside another operation on its mirror", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-worktree-conc-"));
  const client = new OverlapRecordingGitClient();
  const repositories = new RepositoryService(client);

  try {
    const { repository, version } = await seedRepository(
      repositories,
      root,
      "canonical",
    );

    // A separate manager per workspace, which is what really happens: the
    // integration service, the benchmark driver and crash recovery each build
    // their own against the same mirror. An instance field would serialise
    // none of these.
    const managers = Array.from(
      { length: 8 },
      () => new GitWorktreeWorkspaceManager(client),
    );
    const workspaces = await Promise.all(
      managers.map((manager, index) =>
        manager.create({
          taskId: `task_${index}`,
          rootPath: path.join(root, "workspaces"),
          repository,
          baseVersion: version,
        }),
      ),
    );
    assert.equal(workspaces.length, 8);

    const results = await Promise.allSettled(
      workspaces.map((workspace, index) => managers[index]?.destroy(workspace)),
    );
    assert.deepEqual(
      results
        .filter((entry) => entry.status === "rejected")
        .map((entry) =>
          entry.status === "rejected" ? String(entry.reason) : "",
        ),
      [],
    );

    assert.deepEqual(client.violations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialising a wave of workspaces still happens in parallel", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-worktree-conc-"));
  const client = new OverlapRecordingGitClient();
  const repositories = new RepositoryService(client);

  try {
    // Excluding everything from everything would close the window too, and
    // would turn the widest part of the pipeline — a wave materialising every
    // task's workspace at once — into a queue. Two adds create two different
    // directories and delete nothing, so they are allowed to overlap.
    const { repository, version } = await seedRepository(
      repositories,
      root,
      "canonical",
    );
    const managers = Array.from(
      { length: 6 },
      () => new GitWorktreeWorkspaceManager(client),
    );
    const workspaces = await Promise.all(
      managers.map((manager, index) =>
        manager.create({
          taskId: `task_${index}`,
          rootPath: path.join(root, "workspaces"),
          repository,
          baseVersion: version,
        }),
      ),
    );

    assert.deepEqual(client.violations, []);
    assert.ok(
      client.maxConcurrentReads > 1,
      `workspace creation was serialised (max concurrent: ${client.maxConcurrentReads})`,
    );

    for (const [index, workspace] of workspaces.entries()) {
      await managers[index]?.destroy(workspace);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful teardown does not also rescan the mirror", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-worktree-conc-"));
  const client = new OverlapRecordingGitClient();
  const repositories = new RepositoryService(client);
  const pruned: string[][] = [];

  try {
    const { repository, version } = await seedRepository(
      repositories,
      root,
      "canonical",
    );
    const manager = new GitWorktreeWorkspaceManager(
      new (class extends GitClient {
        public override async run(
          args: readonly string[],
          options: GitRunOptions = {},
        ): Promise<ProcessOutput> {
          if (args.includes("worktree") && args.includes("prune")) {
            pruned.push([...args]);
          }
          return await super.run(args, options);
        }
      })(),
    );

    const workspace = await manager.create({
      taskId: "task_prune",
      rootPath: path.join(root, "workspaces"),
      repository,
      baseVersion: version,
    });
    await manager.destroy(workspace);

    // `worktree remove` takes its own registration with it. Pruning anyway
    // made every teardown rescan every worktree the mirror had, under an
    // exclusive lock — quadratic in the width of a wave, for nothing.
    assert.deepEqual(pruned, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
