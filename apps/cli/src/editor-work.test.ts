import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
  type CoordinationStore,
} from "@coord/persistence";
import { IntegrationService } from "@coord/integration-service";
import { RepositoryService } from "@coord/repository-service";
import type { FilePatch } from "@coord/shared-types";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import {
  EDITOR_LEASE_MAX_EXTENSION_MS,
  EDITOR_LEASE_TTL_MS,
  editorPlan,
  extendEditorWork,
  pathsTouched,
  readsAsLapsedHold,
  reportEditorWork,
  takeEditorWork,
} from "./editor-work.js";

/**
 * The editor half of the worker protocol, against a real Git repository.
 *
 * A stub would prove nothing here. The whole claim of this path is that a
 * diff produced on somebody else's machine, by an agent this control plane
 * never started, integrates through exactly the machinery a worker's result
 * does — and that is a claim about `git apply`, canonical revisions and
 * admission, none of which a fake store exercises.
 */
interface Harness {
  root: string;
  store: CoordinationStore;
  repositories: RepositoryService;
  userId: string;
  revision: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "editor-"));
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
    "repo_editor",
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
    email: "editor@example.com",
    displayName: "Editor",
    passwordDigest: "digest",
  });
  return {
    root,
    store,
    repositories,
    userId: user.id,
    revision: version.revision,
  };
}

function services(harness: Harness) {
  const repositories = harness.repositories;
  return {
    repositories,
    integrations: new IntegrationService(
      repositories,
      new GitWorktreeWorkspaceManager(repositories.getGitClient()),
    ),
    integrationRoot: path.join(harness.root, "integrate"),
  };
}

async function submit(
  harness: Harness,
  overrides: { submittedBy?: string; objective?: string } = {},
): Promise<string> {
  const task = await harness.store.submitTask({
    repositoryId: "repo_editor",
    projectId: DEFAULT_PROJECT_ID,
    objective: overrides.objective ?? "raise the value",
    agentId: "generic-cli",
    validationCommands: [],
    ...(overrides.submittedBy === undefined
      ? { submittedBy: harness.userId }
      : { submittedBy: overrides.submittedBy }),
  });
  return task.id;
}

async function take(harness: Harness, vendor = "claude", ttlMs?: number) {
  return await takeEditorWork(
    harness.store,
    {
      actorId: harness.userId,
      organizationId: DEFAULT_ORGANIZATION_ID,
      projectId: DEFAULT_PROJECT_ID,
      repositoryIds: ["repo_editor"],
      vendor,
      label: "Claude Code (editor)",
      ...(ttlMs === undefined ? {} : { ttlMs }),
    },
    harness.repositories,
  );
}

/** What an editor's `git diff` would have produced for a one-line change. */
function valuePatch(value: number): FilePatch[] {
  return [
    {
      path: "src/value.js",
      status: "modified",
      patch: [
        "diff --git a/src/value.js b/src/value.js",
        "--- a/src/value.js",
        "+++ b/src/value.js",
        "@@ -1 +1 @@",
        "-export const value = 1;",
        `+export const value = ${value};`,
        "",
      ].join("\n"),
    },
  ];
}

test("an editor takes a task, reports a diff, and it lands in canonical", async () => {
  const harness = await createHarness();
  const taskId = await submit(harness);

  const taken = await take(harness);
  assert.ok(taken, "nothing was handed over");
  assert.equal(taken.task.id, taskId);
  assert.equal(taken.baseRevision, harness.revision);
  // The hold is long, because an editor is renewed by an agent choosing to
  // call a tool rather than by a timer beside a process.
  assert.ok(
    new Date(taken.expiresAt).getTime() - Date.now() >
      EDITOR_LEASE_TTL_MS - 60_000,
  );
  // The task is off the queue: this is what stops a desktop worker picking up
  // the same objective while the editor is halfway through it.
  assert.equal((await harness.store.getSubmittedTask(taskId))?.status, "claimed");

  const reported = await reportEditorWork(
    harness.store,
    {
      leaseId: taken.leaseId,
      actorId: harness.userId,
      status: "completed",
      patches: valuePatch(2),
      summary: "Raised the value to 2.",
    },
    services(harness),
  );
  assert.equal(reported.outcome, "accepted", JSON.stringify(reported));

  // Canonical actually moved, and moved to the editor's text.
  const after = await harness.repositories.getCanonicalVersion({
    id: "repo_editor",
    path: path.join(harness.root, "canon.git"),
    branch: "main",
  });
  assert.notEqual(after.revision, harness.revision);
  assert.equal(
    (await harness.store.getSubmittedTask(taskId))?.status,
    "integrated",
  );
});

test("the plan is written from the diff, not promised before it", async () => {
  const harness = await createHarness();
  const taskId = await submit(harness);
  const taken = await take(harness);
  assert.ok(taken);

  // Nothing is admitted at take time. A blanket claim here would hold the
  // repository for the whole window with a scope nobody could narrow, because
  // there is no holder process to ask.
  assert.equal(
    (await harness.store.getWorkLease(taken.leaseId))?.plan,
    undefined,
  );

  await reportEditorWork(
    harness.store,
    {
      leaseId: taken.leaseId,
      actorId: harness.userId,
      status: "completed",
      patches: valuePatch(3),
      summary: "Raised the value.",
    },
    services(harness),
  );
  const admitted = (await harness.store.listWorkLeases({}))
    .find((lease) => lease.taskId === taskId);
  assert.deepEqual(admitted?.plan?.plan.expectedFiles, ["src/value.js"]);
  assert.equal(admitted?.plan?.admission.status, "approved");
});

test("a rename claims the name it left as well as the one it took", () => {
  // A rename is one patch with two paths. Claiming only the new one would let
  // an agent rename a file out from under a second agent holding it under its
  // old name, which is exactly the collision admission exists to catch.
  const patches: FilePatch[] = [
    {
      path: "src/new.ts",
      status: "modified",
      patch: [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 100%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "",
      ].join("\n"),
    },
  ];
  assert.deepEqual(pathsTouched(patches).sort(), ["src/new.ts", "src/old.ts"]);
  const plan = editorPlan(
    {
      id: "task_1",
      objective: "move it",
      agentId: "generic-cli",
      validationCommands: [],
      repositoryId: "repo_editor",
      status: "claimed",
      kind: "task",
      submittedAt: new Date().toISOString(),
    } as never,
    patches,
  );
  assert.deepEqual([...plan.expectedFiles].sort(), [
    "src/new.ts",
    "src/old.ts",
  ]);
});

test("giving a task back puts it in the queue rather than ending it", async () => {
  const harness = await createHarness();
  const taskId = await submit(harness);
  const taken = await take(harness);
  assert.ok(taken);

  const given = await reportEditorWork(
    harness.store,
    {
      leaseId: taken.leaseId,
      actorId: harness.userId,
      status: "released",
      patches: [],
      summary: "",
    },
    services(harness),
  );
  assert.equal(given.outcome, "accepted");
  // Back in the queue, not failed: "I have not started this" and "I tried and
  // could not" are different things to say in a room.
  assert.equal(
    (await harness.store.getSubmittedTask(taskId))?.status,
    "submitted",
  );
  // And a second editor can have it.
  assert.ok(await take(harness));
});

test("an editor is never handed somebody else's work", async () => {
  const harness = await createHarness();
  const other = await harness.store.createUser({
    email: "other@example.com",
    displayName: "Other",
    passwordDigest: "digest",
  });
  await submit(harness, { submittedBy: other.id });
  // The editor runs under one person's vendor login. Taking another person's
  // task would run their work on the wrong account, under the wrong name.
  assert.equal(await take(harness), undefined);
});

test("a repository the caller cannot reach is not a place work comes from", async () => {
  const harness = await createHarness();
  await submit(harness);
  const taken = await takeEditorWork(
    harness.store,
    {
      actorId: harness.userId,
      organizationId: DEFAULT_ORGANIZATION_ID,
      projectId: DEFAULT_PROJECT_ID,
      // A collaborator granted one repository, which is not this one.
      repositoryIds: ["repo_elsewhere"],
      vendor: "claude",
      label: "Claude Code (editor)",
    },
    harness.repositories,
  );
  assert.equal(taken, undefined);
});

test("two editors cannot hold the same task", async () => {
  const harness = await createHarness();
  await submit(harness);
  const first = await take(harness);
  assert.ok(first);
  // The second asks while the first is still working. There is one task, and
  // the store's claim is the thing that decides, not a check up here.
  assert.equal(await take(harness, "codex"), undefined);
});

test("one worker row per editor, however many tasks it does", async () => {
  const harness = await createHarness();
  for (const objective of ["first", "second", "third"]) {
    await submit(harness, { objective });
    const taken = await take(harness);
    assert.ok(taken, objective);
    await reportEditorWork(
      harness.store,
      {
        leaseId: taken.leaseId,
        actorId: harness.userId,
        status: "released",
        patches: [],
        summary: "",
      },
      services(harness),
    );
  }
  // The row exists because a lease needs a foreign key. Minting one per take
  // would put back exactly the growth the retirement sweep was written to
  // remove, one row per task instead of one per restart.
  const workers = await harness.store.listWorkers({
    organizationId: DEFAULT_ORGANIZATION_ID,
  });
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0]?.adapters, ["claude"]);
});

test("a hold can be pushed out, and not indefinitely in one go", async () => {
  const harness = await createHarness();
  await submit(harness);
  const taken = await take(harness);
  assert.ok(taken);

  const pushed = await extendEditorWork(harness.store, {
    leaseId: taken.leaseId,
    ttlMs: 45 * 60 * 1000,
  });
  assert.ok(pushed);
  assert.ok(new Date(pushed).getTime() > new Date(taken.expiresAt).getTime());

  // A request for a week gets an hour. An editor that keeps working keeps
  // asking; one request must not be able to claim a task for a day.
  const capped = await extendEditorWork(harness.store, {
    leaseId: taken.leaseId,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  });
  assert.ok(capped);
  assert.ok(
    new Date(capped).getTime() - Date.now() <=
      EDITOR_LEASE_MAX_EXTENSION_MS + 1_000,
  );

  // A hold that is finished cannot be pushed out at all.
  await harness.store.finishWorkLease(
    taken.leaseId,
    "released",
    new Date().toISOString(),
  );
  assert.equal(
    await extendEditorWork(harness.store, {
      leaseId: taken.leaseId,
      ttlMs: 60_000,
    }),
    undefined,
  );
});

test("reporting against a hold that has gone says so rather than failing the task", async () => {
  const harness = await createHarness();
  const taskId = await submit(harness);
  // Held for a millisecond, so it has genuinely lapsed by the time the report
  // arrives. Expiry is something the sweep does to a lease, not something a
  // caller can set on one, and reporting runs that sweep before it reads.
  const taken = await take(harness, "claude", 1);
  assert.ok(taken);
  // Past the expiry before reporting, rather than racing it. Both outcomes
  // are lease_lost, but only this one is the branch this test is about.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const late = await reportEditorWork(
    harness.store,
    {
      leaseId: taken.leaseId,
      actorId: harness.userId,
      status: "completed",
      patches: valuePatch(4),
      summary: "Raised the value.",
    },
    services(harness),
  );
  assert.equal(late.outcome, "lease_lost");
  // The task went back in the queue when the hold lapsed, and reporting
  // against the dead hold must not take it out again or end it.
  assert.equal(
    (await harness.store.getSubmittedTask(taskId))?.status,
    "submitted",
  );
});

test("a hold that lapses mid-flight is not a verdict on the work", () => {
  // These are the sentences the result path actually produces. The window can
  // close inside one call: the checks pass, integration runs, and the lease
  // reaches its expiry while it does. Telling an editor its diff was refused
  // then would send it off to redo something that was fine.
  for (const lapsed of [
    "lease is expired",
    "lease is released",
    "lease was lost before failure report",
    "lease was lost before the answer",
  ]) {
    assert.equal(readsAsLapsedHold(lapsed), true, lapsed);
  }
  // And these are not lapses. A `failed` lease was settled by something that
  // needs a person; a `completed` one already landed. "Take the task again
  // and report the same diff" is wrong advice for both.
  for (const verdict of [
    "lease is failed",
    "lease is completed",
    "Remote result is still being integrated",
    "Canonical changed; the task was requeued to replan",
    "Plan or changeset is for a different task",
  ]) {
    assert.equal(readsAsLapsedHold(verdict), false, verdict);
  }
});

test("a failure is recorded as one, without needing a plan first", async () => {
  const harness = await createHarness();
  const taskId = await submit(harness);
  const taken = await take(harness);
  assert.ok(taken);

  const failed = await reportEditorWork(
    harness.store,
    {
      leaseId: taken.leaseId,
      actorId: harness.userId,
      status: "failed",
      patches: [],
      summary: "",
      detail: "The test suite does not build on this machine.",
    },
    services(harness),
  );
  // Nothing was admitted, and nothing had to be: work that did not land has
  // no scope to arbitrate. Refusing this for missing paperwork would turn "I
  // could not do this" into "the control plane rejected your report".
  assert.equal(failed.outcome, "accepted");
  assert.equal((await harness.store.getSubmittedTask(taskId))?.status, "failed");
  const events = await harness.store.listAuditEvents({
    taskId,
    types: ["task_failed"],
  });
  assert.match(
    String(events.at(-1)?.event.data["error"] ?? ""),
    /does not build/u,
  );
});
