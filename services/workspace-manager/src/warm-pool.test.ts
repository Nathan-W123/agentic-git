import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GitClient,
  RepositoryService,
  type CanonicalRepository,
  type ProcessOutput,
} from "@coord/repository-service";
import type { CanonicalVersion, TaskId } from "@coord/shared-types";

import {
  GitWorktreeWorkspaceManager,
  WarmWorkspacePool,
  warmBackendFor,
  type SandboxLaunchSpec,
  type TaskWorkspace,
  type WarmWorkspaceBackend,
  type WorkspaceCommandOptions,
} from "./index.js";

/**
 * The pool hands one task's directory to another task, so every test here is
 * really the same question asked in a different way: what can a landed task
 * leave behind that the next one would notice?
 */

async function seedRepository(
  repositories: RepositoryService,
  root: string,
  name: string,
  gitignore?: string,
): Promise<{
  repository: CanonicalRepository;
  version: CanonicalVersion;
  sourcePath: string;
}> {
  const sourcePath = path.join(root, `${name}-source`);
  await repositories.initializeWorkingRepository(sourcePath);
  await writeFile(path.join(sourcePath, "a.txt"), "seed\n", "utf8");
  if (gitignore !== undefined) {
    await writeFile(path.join(sourcePath, ".gitignore"), gitignore, "utf8");
  }
  await repositories.commitAll(sourcePath, "seed");
  const repository = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, `${name}.git`),
    name,
  );
  return {
    repository,
    version: await repositories.getCanonicalVersion(repository),
    sourcePath,
  };
}

/** Moves canonical on, the way a promotion does, from the working clone. */
async function advanceCanonical(
  repositories: RepositoryService,
  sourcePath: string,
  repository: CanonicalRepository,
  contents: string,
): Promise<CanonicalVersion> {
  await writeFile(path.join(sourcePath, "a.txt"), contents, "utf8");
  await repositories.commitAll(sourcePath, "advance");
  await repositories
    .getGitClient()
    .run([
      "-C",
      sourcePath,
      "push",
      repository.path,
      `HEAD:${repository.branch}`,
    ]);
  return await repositories.getCanonicalVersion(repository);
}

function takeInput(
  taskId: string,
  rootPath: string,
  repository: CanonicalRepository,
  baseVersion: CanonicalVersion,
) {
  return {
    taskId: taskId as TaskId,
    rootPath,
    repository,
    baseVersion,
  };
}

test("a retained workspace is handed to the next task as a new tenancy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-pool-"));
  try {
    const repositories = new RepositoryService();
    const { repository, version } = await seedRepository(
      repositories,
      root,
      "canonical",
    );
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const backend = warmBackendFor(manager);
    assert.ok(backend !== undefined);
    const pool = new WarmWorkspacePool({ log: () => {} });
    const workspaces = path.join(root, "workspaces");

    const first = await manager.create(
      takeInput("task_one", workspaces, repository, version),
    );
    assert.equal(pool.retain(backend, first), true);
    await pool.settled();

    const taken = await pool.take(
      takeInput("task_two", workspaces, repository, version),
    );
    assert.ok(taken !== undefined);
    assert.equal(taken.workspace.path, first.path);
    assert.equal(taken.workspace.taskId, "task_two");
    assert.notEqual(taken.workspace.id, first.id);
    assert.equal(taken.dependencies, "skipped");
    assert.equal(pool.stats().hits, 1);
    assert.equal(pool.size(repository.id), 0);

    await manager.destroy(taken.workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The leak test. Everything the pool exists to prevent is in here at once: a
 * dirty tracked file, an untracked file already staged intent-to-add by
 * `collectChangeSet`, and — the case the whole scrub was rewritten for — a
 * gitignored `.env` and log, which `clean` without `-x` leaves in place and
 * `status` without `--ignored` cannot even see.
 */
test("a warm workspace carries nothing of the task that left it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-leak-"));
  try {
    const repositories = new RepositoryService();
    const { repository, version } = await seedRepository(
      repositories,
      root,
      "canonical",
      "*.log\n.env\n",
    );
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const backend = warmBackendFor(manager);
    assert.ok(backend !== undefined);
    const pool = new WarmWorkspacePool({ log: () => {} });
    const workspaces = path.join(root, "workspaces");

    const first = await manager.create(
      takeInput("task_one", workspaces, repository, version),
    );
    await writeFile(path.join(first.path, "a.txt"), "edited\n", "utf8");
    await writeFile(path.join(first.path, "invented.txt"), "mine\n", "utf8");
    await writeFile(path.join(first.path, ".env"), "SECRET=1\n", "utf8");
    await writeFile(path.join(first.path, "debug.log"), "noisy\n", "utf8");
    const collected = await manager.collectChangeSet(first, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "did some work",
    });
    assert.ok(collected.patches.length > 0);

    assert.equal(pool.retain(backend, first), true);
    await pool.settled();
    const taken = await pool.take(
      takeInput("task_two", workspaces, repository, version),
    );
    assert.ok(taken !== undefined);

    assert.equal(
      await readFile(path.join(taken.workspace.path, "a.txt"), "utf8"),
      "seed\n",
    );
    for (const gone of ["invented.txt", ".env", "debug.log"]) {
      await assert.rejects(access(path.join(taken.workspace.path, gone)));
    }
    assert.deepEqual(
      (await manager.listWorkingChanges(taken.workspace)).map(
        (entry) => entry.path,
      ),
      [],
    );
    const second = await manager.collectChangeSet(taken.workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "nothing yet",
    });
    assert.deepEqual(second.patches, []);

    await manager.destroy(taken.workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("what is expensive to rebuild survives a retention, ignored or not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-ephemeral-"));
  try {
    const repositories = new RepositoryService();
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const backend = warmBackendFor(manager);
    assert.ok(backend !== undefined);
    const workspaces = path.join(root, "workspaces");

    for (const [name, gitignore] of [
      ["ignored", "node_modules/\n*.tsbuildinfo\n.yarn/\n"],
      ["bare", undefined],
    ] as const) {
      const { repository, version } = await seedRepository(
        repositories,
        root,
        name,
        gitignore,
      );
      const pool = new WarmWorkspacePool({ log: () => {} });
      const first = await manager.create(
        takeInput(`task_${name}_one`, workspaces, repository, version),
      );
      await mkdir(path.join(first.path, "node_modules"), { recursive: true });
      await writeFile(
        path.join(first.path, "node_modules", "x.js"),
        "1\n",
        "utf8",
      );
      await writeFile(path.join(first.path, "a.tsbuildinfo"), "{}\n", "utf8");
      await mkdir(path.join(first.path, "pkg", ".yarn", "cache"), {
        recursive: true,
      });
      await writeFile(
        path.join(first.path, "pkg", ".yarn", "cache", "q.zip"),
        "z\n",
        "utf8",
      );
      await mkdir(path.join(first.path, ".yarn"), { recursive: true });
      await writeFile(
        path.join(first.path, ".yarn", "install-state.gz"),
        "s\n",
        "utf8",
      );
      await mkdir(path.join(first.path, "scratchdir"), { recursive: true });
      await writeFile(
        path.join(first.path, "scratchdir", "note.txt"),
        "mine\n",
        "utf8",
      );

      assert.equal(pool.retain(backend, first), true);
      await pool.settled();
      const taken = await pool.take(
        takeInput(`task_${name}_two`, workspaces, repository, version),
      );
      assert.ok(taken !== undefined, `${name}: the directory was discarded`);
      for (const kept of [
        path.join("node_modules", "x.js"),
        "a.tsbuildinfo",
        path.join("pkg", ".yarn", "cache", "q.zip"),
        path.join(".yarn", "install-state.gz"),
      ]) {
        await access(path.join(taken.workspace.path, kept));
      }
      await assert.rejects(
        access(path.join(taken.workspace.path, "scratchdir", "note.txt")),
      );
      await manager.destroy(taken.workspace);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the pool keeps what it was told to keep and no more", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-bounds-"));
  try {
    const repositories = new RepositoryService();
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const backend = warmBackendFor(manager);
    assert.ok(backend !== undefined);
    const workspaces = path.join(root, "workspaces");
    const one = await seedRepository(repositories, root, "one");
    const two = await seedRepository(repositories, root, "two");

    const pool = new WarmWorkspacePool({ perRepository: 1, log: () => {} });
    const firstOfOne = await manager.create(
      takeInput("task_a", workspaces, one.repository, one.version),
    );
    const secondOfOne = await manager.create(
      takeInput("task_b", workspaces, one.repository, one.version),
    );
    const firstOfTwo = await manager.create(
      takeInput("task_c", workspaces, two.repository, two.version),
    );
    assert.equal(pool.retain(backend, firstOfOne), true);
    assert.equal(pool.retain(backend, secondOfOne), false);
    // A second repository has its own slot: the bound is per repository, not
    // per pool.
    assert.equal(pool.retain(backend, firstOfTwo), true);
    await pool.settled();
    assert.equal(pool.size(one.repository.id), 1);
    assert.equal(pool.size(two.repository.id), 1);
    await manager.destroy(secondOfOne);

    const disabled = new WarmWorkspacePool({ perRepository: 0, log: () => {} });
    const spare = await manager.create(
      takeInput("task_d", workspaces, one.repository, one.version),
    );
    assert.equal(disabled.retain(backend, spare), false);
    assert.equal(
      await disabled.take(
        takeInput("task_e", workspaces, one.repository, one.version),
      ),
      undefined,
    );
    await manager.destroy(spare);

    await pool.drain();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a canonical advance between retain and take costs nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-advance-"));
  try {
    const repositories = new RepositoryService();
    const { repository, version, sourcePath } = await seedRepository(
      repositories,
      root,
      "canonical",
    );
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const backend = warmBackendFor(manager);
    assert.ok(backend !== undefined);
    const pool = new WarmWorkspacePool({ log: () => {} });
    const workspaces = path.join(root, "workspaces");

    const first = await manager.create(
      takeInput("task_one", workspaces, repository, version),
    );
    assert.equal(pool.retain(backend, first), true);
    await pool.settled();

    const moved = await advanceCanonical(
      repositories,
      sourcePath,
      repository,
      "landed\n",
    );
    assert.notEqual(moved.revision, version.revision);

    const taken = await pool.take(
      takeInput("task_two", workspaces, repository, moved),
    );
    assert.ok(taken !== undefined);
    assert.equal(taken.workspace.baseVersion.revision, moved.revision);
    assert.equal(
      await readFile(path.join(taken.workspace.path, "a.txt"), "utf8"),
      "landed\n",
    );

    await manager.destroy(taken.workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dependency preparation decides what a take reports, and never blocks it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-prepare-"));
  try {
    const repositories = new RepositoryService();
    const { repository, version } = await seedRepository(
      repositories,
      root,
      "canonical",
    );
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const inner = warmBackendFor(manager);
    assert.ok(inner !== undefined);
    const workspaces = path.join(root, "workspaces");
    const ran: SandboxLaunchSpec[] = [];
    const recording: WarmWorkspaceBackend = {
      ...inner,
      async runInWorkspace(
        workspace: TaskWorkspace,
        spec: SandboxLaunchSpec,
        options?: WorkspaceCommandOptions,
      ): Promise<ProcessOutput> {
        ran.push(spec);
        return await inner.runInWorkspace!(workspace, spec, options);
      },
    };

    // A prepare that never resolves leaves the entry warming, and a take
    // passes over it: waiting on somebody else's install is strictly worse
    // than the cold checkout the caller would otherwise do.
    const stuck = new WarmWorkspacePool({
      log: () => {},
      prepare: async () => await new Promise<never>(() => {}),
    });
    const held = await manager.create(
      takeInput("task_stuck", workspaces, repository, version),
    );
    assert.equal(stuck.retain(recording, held), true);
    assert.equal(
      await stuck.take(
        takeInput("task_waiting", workspaces, repository, version),
      ),
      undefined,
    );
    assert.equal(stuck.size(repository.id), 1);

    const installed = new WarmWorkspacePool({
      log: () => {},
      prepare: async (_workspace, run) => {
        await run({ command: process.execPath, args: ["--version"] });
        return "installed";
      },
    });
    const ready = await manager.create(
      takeInput("task_ready", workspaces, repository, version),
    );
    assert.equal(installed.retain(recording, ready), true);
    await installed.settled();
    const taken = await installed.take(
      takeInput("task_next", workspaces, repository, version),
    );
    assert.ok(taken !== undefined);
    assert.equal(taken.dependencies, "installed");
    // Through the backend, never straight onto the host: that is what makes a
    // sandboxed project's install run inside its own container.
    assert.deepEqual(
      ran.map((spec) => spec.args),
      [["--version"]],
    );
    await manager.destroy(taken.workspace);

    // A prepare that throws still keeps the worktree. A checkout hit without
    // dependencies is a hit.
    const failing = new WarmWorkspacePool({
      log: () => {},
      prepare: async () => {
        throw new Error("no registry");
      },
    });
    const unlucky = await manager.create(
      takeInput("task_unlucky", workspaces, repository, version),
    );
    assert.equal(failing.retain(recording, unlucky), true);
    await failing.settled();
    const afterFailure = await failing.take(
      takeInput("task_after", workspaces, repository, version),
    );
    assert.ok(afterFailure !== undefined);
    assert.equal(afterFailure.dependencies, "failed");
    assert.equal(failing.stats().prepareFailures, 1);
    await manager.destroy(afterFailure.workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idle and shutdown both give every kept directory back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-warm-sweep-"));
  try {
    const repositories = new RepositoryService();
    const { repository, version } = await seedRepository(
      repositories,
      root,
      "canonical",
    );
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const backend = warmBackendFor(manager);
    assert.ok(backend !== undefined);
    const workspaces = path.join(root, "workspaces");
    const git = repositories.getGitClient();
    const registered = async (): Promise<number> =>
      (
        await git.run([
          `--git-dir=${repository.path}`,
          "worktree",
          "list",
          "--porcelain",
        ])
      ).stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length;

    const idling = new WarmWorkspacePool({ idleMs: 1_000, log: () => {} });
    const first = await manager.create(
      takeInput("task_one", workspaces, repository, version),
    );
    assert.equal(idling.retain(backend, first), true);
    await idling.settled();
    await idling.closeIdle(Date.now() + 5_000);
    assert.equal(idling.size(repository.id), 0);
    await assert.rejects(access(first.path));

    const draining = new WarmWorkspacePool({ log: () => {} });
    const second = await manager.create(
      takeInput("task_two", workspaces, repository, version),
    );
    assert.equal(draining.retain(backend, second), true);
    await draining.settled();
    await draining.drain();
    await assert.rejects(access(second.path));
    // Only the bare repository itself is left registered.
    assert.equal(await registered(), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * `scrub` and `advance` are optional on `WorkspaceManager` so the structural
 * fakes in other suites keep compiling. That makes the check load-bearing: a
 * manager missing `scrub` would hand a directory on without ever verifying
 * it, which is silent wrongness rather than a failure.
 */
test("a manager that cannot scrub is never pooled", () => {
  const manager = new GitWorktreeWorkspaceManager();
  assert.notEqual(warmBackendFor(manager), undefined);
  const { scrub: _scrub, ...withoutScrub } = manager as unknown as {
    scrub: unknown;
  };
  assert.equal(
    warmBackendFor({
      ...withoutScrub,
      create: manager.create.bind(manager),
      destroy: manager.destroy.bind(manager),
      advance: manager.advance.bind(manager),
      runInWorkspace: manager.runInWorkspace.bind(manager),
      collectChangeSet: manager.collectChangeSet.bind(manager),
    }),
    undefined,
  );
});
