import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    // task's workspace at once — into a queue, each add being a full
    // checkout. So adds overlap. They are not free of each other while they
    // do — see the commondir race at the end of this file — but that window
    // is git's own and is retried, not locked out.
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

/**
 * The window that is git's, not ours.
 *
 * The lock above stops a delete running beside anything else. It cannot stop
 * two adds colliding, because until this was measured they were believed not
 * to: "two adds create two different directories and delete nothing". They do
 * both of those things and still collide, because `git worktree add` writes
 * the new worktree's `commondir` with an ordinary open-truncate-write, and
 * every `worktree` invocation reads each registered worktree's `commondir`
 * while enumerating. For the moment between the open and the write that file
 * exists and is empty, and a neighbour reading it dies with
 *
 *     fatal: failed to read .../worktrees/<other>/commondir: Success
 *
 * — "Success" being errno untouched, since the read did not fail, it returned
 * nothing. Eight parallel adds against one mirror on git 2.43 reproduce it in
 * roughly one attempt in a hundred and sixty with the CPU saturated, and not
 * at all on an idle machine, which is why it only ever appeared as a
 * full-suite flake.
 *
 * Serialising adds would close it and would also queue the widest part of the
 * pipeline, so the add stays parallel and the loss is retried. These two
 * tests hold that shape: the race is retried, and nothing else is.
 */
class CommondirRaceGitClient extends GitClient {
  public adds = 0;

  public constructor(private readonly failFirst: string) {
    super();
  }

  public override async run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<ProcessOutput> {
    if (args.includes("worktree") && args.includes("add")) {
      this.adds += 1;
      if (this.adds === 1) {
        throw new Error(this.failFirst);
      }
    }
    return await super.run(args, options);
  }
}

test("an add that loses git's commondir race is run again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-worktree-race-"));
  const mirror = path.join(root, "canonical.git");
  const client = new CommondirRaceGitClient(
    `git worktree add failed: fatal: failed to read ${mirror}/worktrees/` +
      "task_other-abc123/commondir: Success",
  );

  try {
    const repositories = new RepositoryService(new GitClient());
    const { repository, version } = await seedRepository(
      repositories,
      root,
      "canonical",
    );
    const manager = new GitWorktreeWorkspaceManager(client);

    // The first attempt loses the race; the workspace still materialises,
    // because losing it says nothing about this add except its timing.
    const workspace = await manager.create({
      taskId: "task_retried",
      rootPath: path.join(root, "workspaces"),
      repository,
      baseVersion: version,
    });
    assert.equal(client.adds, 2);
    assert.equal(await readFile(path.join(workspace.path, "a.txt"), "utf8"), "seed\n");

    await manager.destroy(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an add that failed on its own merits is not run again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-worktree-race-"));
  const client = new CommondirRaceGitClient(
    "git worktree add failed: fatal: invalid reference: deadbeef",
  );

  try {
    const repositories = new RepositoryService(new GitClient());
    const { repository, version } = await seedRepository(
      repositories,
      root,
      "canonical",
    );
    const manager = new GitWorktreeWorkspaceManager(client);

    // Retrying a bad revision would turn one clear failure into three slow
    // ones and report the last, so the reason has to reach the caller first
    // time and unchanged.
    await assert.rejects(
      manager.create({
        taskId: "task_doomed",
        rootPath: path.join(root, "workspaces"),
        repository,
        baseVersion: version,
      }),
      /invalid reference: deadbeef/u,
    );
    assert.equal(client.adds, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
