import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemoryCoordinationStore } from "@coord/persistence";
import { GitClient, RepositoryService } from "@coord/repository-service";

import {
  acceptWorkResult,
  leaseBundle,
  leaseWork,
} from "./worker-operations.js";

/**
 * The control-plane half of the worker protocol, tested against a real Git
 * repository rather than a stub, because the point of the bundle is that a
 * worker with no filesystem access can reconstruct the workspace from it.
 */

interface Harness {
  root: string;
  store: InMemoryCoordinationStore;
  repositories: RepositoryService;
  workerId: string;
  revision: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cwork-"));
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();

  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "src", "value.js"),
    "export const value = 1;\n",
    "utf8",
  );
  await repositories.commitAll(sourcePath, "seed");

  const canonical = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canon.git"),
    "repo_worker",
    "main",
  );
  const version = await repositories.getCanonicalVersion(canonical);

  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: canonical.id,
    path: canonical.path,
    branch: canonical.branch,
  });
  const user = await store.createUser({
    email: "fleet@example.com",
    displayName: "Fleet",
    passwordDigest: "digest",
  });
  const worker = await store.registerWorker({
    userId: user.id,
    name: "worker-a",
    adapters: ["generic-cli"],
    version: "1.0.0",
  });

  return {
    root,
    store,
    repositories,
    workerId: worker.id,
    revision: version.revision,
  };
}

async function submit(harness: Harness): Promise<string> {
  const task = await harness.store.submitTask({
    repositoryId: "repo_worker",
    objective: "raise the value",
    agentId: "generic-cli",
    validationCommands: [],
  });
  return task.id;
}

test("a lease pins the worker to the canonical revision", async () => {
  const harness = await createHarness();
  try {
    assert.equal(await leaseWork(harness.store, { workerId: harness.workerId }), undefined);

    const taskId = await submit(harness);
    const assignment = await leaseWork(harness.store, {
      workerId: harness.workerId,
    });

    assert.equal(assignment?.task.id, taskId);
    assert.equal(assignment?.lease.baseRevision, harness.revision);
    assert.equal(assignment?.repository.branch, "main");
    assert.match(assignment?.bundleUrl ?? "", /\/workers\/leases\/.+\/bundle$/u);
    assert.ok((assignment?.heartbeatIntervalMs ?? 0) > 0);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a worker reconstructs the workspace from the bundle alone", async () => {
  const harness = await createHarness();
  try {
    await submit(harness);
    const assignment = await leaseWork(harness.store, {
      workerId: harness.workerId,
    });
    const bundle = await leaseBundle(
      harness.store,
      assignment?.lease.id ?? "",
    );
    assert.ok(bundle !== undefined);
    // Git bundles are binary and start with a signature line.
    assert.match(bundle.subarray(0, 16).toString("utf8"), /^# v\d/u);

    // Stand in for a worker on another machine: it has the bytes and nothing
    // else — no access to the canonical repository path.
    const remote = path.join(harness.root, "worker-side");
    await mkdir(remote, { recursive: true });
    const bundlePath = path.join(remote, "revision.bundle");
    await writeFile(bundlePath, bundle);

    const git = new GitClient();
    const workspace = path.join(remote, "workspace");
    await git.run([
      "clone",
      "--branch",
      assignment?.bundleRef ?? "",
      bundlePath,
      workspace,
    ]);

    // Line endings are not part of the contract: a worker on Windows checks
    // out with autocrlf, and git converts back when it diffs, so a CRLF
    // working tree still produces a clean patch.
    const restored = await readFile(
      path.join(workspace, "src", "value.js"),
      "utf8",
    );
    assert.equal(
      restored.replaceAll("\r\n", "\n"),
      "export const value = 1;\n",
    );

    const head = await git.run(["-C", workspace, "rev-parse", "HEAD"]);
    assert.equal(head.stdout.trim(), harness.revision);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a bundle is only served for an active lease", async () => {
  const harness = await createHarness();
  try {
    await submit(harness);
    const assignment = await leaseWork(harness.store, {
      workerId: harness.workerId,
    });
    const leaseId = assignment?.lease.id ?? "";

    await harness.store.finishWorkLease(
      leaseId,
      "released",
      new Date().toISOString(),
    );
    assert.equal(await leaseBundle(harness.store, leaseId), undefined);
    assert.equal(await leaseBundle(harness.store, "lease_missing"), undefined);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a completed result must match the revision it was leased against", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await leaseWork(harness.store, {
      workerId: harness.workerId,
    });
    const leaseId = assignment?.lease.id ?? "";

    // Built from some other revision: the control plane cannot integrate this.
    const stale = await acceptWorkResult(harness.store, {
      leaseId,
      status: "completed",
      actorId: "user",
      changeSet: { taskId, baseRevision: "b".repeat(40), patches: [] },
    });
    assert.equal(stale.accepted, false);
    assert.match(stale.reason ?? "", /does not match the revision/u);

    // Right revision, wrong task.
    const misrouted = await acceptWorkResult(harness.store, {
      leaseId,
      status: "completed",
      actorId: "user",
      changeSet: { taskId: "task_other", baseRevision: harness.revision },
    });
    assert.equal(misrouted.accepted, false);

    // A completed result with no changeset at all.
    const empty = await acceptWorkResult(harness.store, {
      leaseId,
      status: "completed",
      actorId: "user",
      changeSet: undefined,
    });
    assert.equal(empty.accepted, false);

    // The lease survived all three rejections and still accepts a valid result.
    const accepted = await acceptWorkResult(harness.store, {
      leaseId,
      status: "completed",
      actorId: "user",
      changeSet: {
        id: "changeset_1",
        taskId,
        baseRevision: harness.revision,
        patches: [{ path: "src/value.js", status: "modified", patch: "@@" }],
      },
    });
    assert.equal(accepted.accepted, true);
    assert.equal(
      (await harness.store.getWorkLease(leaseId))?.status,
      "completed",
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a lapsed lease cannot report a result", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await leaseWork(harness.store, {
      workerId: harness.workerId,
    });
    const leaseId = assignment?.lease.id ?? "";

    // The worker stalled, the lease expired, and the task went back to the
    // queue. Accepting its late result would let two workers write the task.
    await harness.store.expireWorkLeases(
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );
    const late = await acceptWorkResult(harness.store, {
      leaseId,
      status: "completed",
      actorId: "user",
      changeSet: { taskId, baseRevision: harness.revision, patches: [] },
    });
    assert.equal(late.accepted, false);
    assert.match(late.reason ?? "", /lease is expired/u);

    // And the task really is available again.
    assert.equal(
      (await harness.store.listSubmittedTasks({ status: "submitted" })).length,
      1,
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a failed result settles the task and is audited", async () => {
  const harness = await createHarness();
  try {
    const taskId = await submit(harness);
    const assignment = await leaseWork(harness.store, {
      workerId: harness.workerId,
    });

    const result = await acceptWorkResult(harness.store, {
      leaseId: assignment?.lease.id ?? "",
      status: "failed",
      actorId: "user",
      changeSet: undefined,
      detail: "agent exited with code 3",
    });
    assert.equal(result.accepted, true);

    const tasks = await harness.store.listSubmittedTasks();
    assert.equal(tasks.find((entry) => entry.id === taskId)?.status, "failed");

    const audit = await harness.store.listAudit();
    const failure = audit.find((event) => event.type === "task_failed");
    assert.equal(failure?.taskId, taskId);
    assert.equal(failure?.data["detail"], "agent exited with code 3");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});
