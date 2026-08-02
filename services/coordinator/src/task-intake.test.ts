import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { CodeIntelligenceService } from "@coord/code-intelligence";
import {
  InMemoryCoordinationStore,
  type CoordinationStore,
  type StoredRepository,
} from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import type { ValidationCommand } from "@coord/shared-types";

import { TaskIntakeService, type TaskIntakeOptions } from "./task-intake.js";

/**
 * Intake end to end against a real repository and a real store: the objective
 * goes in, one or several tasks come out, and the queue is the only thing that
 * has to be true afterwards.
 *
 * No agent runs here and none is needed. Decomposition happens strictly before
 * an agent exists, so everything it decides is decidable from the repository
 * index and the queue.
 */

const VALIDATION: ValidationCommand[] = [
  { executable: "git", args: ["diff", "--check"], label: "patch integrity" },
];

/**
 * Two independent service packages and an unrelated app.
 *
 * `billing` and `notifications` share no import and no symbol, which is what
 * makes an objective spanning both a legitimate split candidate.
 */
async function seedWorkspace(root: string): Promise<StoredRepository> {
  const source = path.join(root, "source");
  const canonicalPath = path.join(root, "canonical.git");
  await repositories.initializeWorkingRepository(source);

  const write = async (relative: string, contents: string): Promise<void> => {
    const target = path.join(source, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  };

  await write("package.json", '{ "name": "root" }\n');
  await write("services/billing/package.json", '{ "name": "billing" }\n');
  await write(
    "services/billing/src/invoice.ts",
    [
      "export interface InvoiceLine { amount: number }",
      "export function createInvoice(lines: InvoiceLine[]) {",
      "  return lines.length;",
      "}",
    ].join("\n"),
  );
  await write(
    "services/billing/src/tax.ts",
    "export function invoiceTaxRate() { return 0.2; }\n",
  );
  await write(
    "services/notifications/package.json",
    '{ "name": "notifications" }\n',
  );
  await write(
    "services/notifications/src/receipt.ts",
    "export function deliveryReceipt() { return true; }\n",
  );
  await write(
    "services/notifications/src/queue.ts",
    "export function deliveryQueue() { return []; }\n",
  );
  await write("apps/dashboard/package.json", '{ "name": "dashboard" }\n');
  await write(
    "apps/dashboard/src/screen.ts",
    "export function renderScreen() { return null; }\n",
  );

  await repositories.commitAll(source, "seed");
  const canonical = await repositories.importLocalRepository(
    source,
    canonicalPath,
    "example",
  );
  return { id: canonical.id, path: canonical.path, branch: canonical.branch };
}

/**
 * One canonical repository for the whole file.
 *
 * Seeding costs several git processes and indexing costs one read per file,
 * and no test here writes to the repository — only to its own store. Sharing
 * the fixture (and the index cache with it) is what keeps this suite in
 * seconds rather than minutes.
 */
const repositories = new RepositoryService();
const codeIntelligence = new CodeIntelligenceService(repositories);
let fixtureRoot: string | undefined;
let fixture: Promise<StoredRepository> | undefined;

async function sharedRepository(): Promise<StoredRepository> {
  if (fixture === undefined) {
    fixture = (async () => {
      fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "coord-intake-"));
      return await seedWorkspace(fixtureRoot);
    })();
  }
  return await fixture;
}

after(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

function intake(options: TaskIntakeOptions = {}): TaskIntakeService {
  return new TaskIntakeService(codeIntelligence, repositories, options);
}

async function withWorkspace(
  body: (
    store: CoordinationStore,
    repository: StoredRepository,
  ) => Promise<void>,
): Promise<void> {
  const repository = await sharedRepository();
  const store = new InMemoryCoordinationStore();
  await store.saveRepository(repository);
  try {
    await body(store, repository);
  } finally {
    await store.close();
  }
}

const SPANNING_OBJECTIVE =
  "Give invoices a currency column and give delivery receipts a timestamp";

test("an uncontended objective is queued whole", async () => {
  await withWorkspace(async (store, repository) => {
    const result = await intake().submit(store, {
      repository,
      objective: SPANNING_OBJECTIVE,
      agentId: "agent-a",
      validationCommands: VALIDATION,
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.decision.split, false);
    assert.equal(result.decision.reason, "no_contention");
    assert.equal(result.tasks[0]?.objective, SPANNING_OBJECTIVE);
    assert.equal(result.estimate?.confidence, "anchored");
  });
});

test("a contended objective enters the queue as independent tasks", async () => {
  await withWorkspace(async (store, repository) => {
    // Somebody else is already working in billing.
    const sibling = await store.submitTask({
      repositoryId: repository.id,
      objective: "Rework the invoice tax rate table",
      agentId: "agent-b",
      validationCommands: VALIDATION,
    });

    const result = await intake().submit(store, {
      repository,
      objective: SPANNING_OBJECTIVE,
      agentId: "agent-a",
      validationCommands: VALIDATION,
    });

    assert.equal(result.decision.split, true);
    assert.equal(result.tasks.length, 2);
    assert.deepEqual(result.decision.contendingTaskIds, [sibling.id]);

    const queued = await store.listSubmittedTasks({
      repositoryId: repository.id,
    });
    assert.equal(queued.length, 3);

    // Every queued task, sibling included, keeps its own objective.
    for (const task of result.tasks) {
      assert.ok(task.objective.startsWith(SPANNING_OBJECTIVE));
      assert.ok(task.objective.includes("Scope constraint"));
      assert.equal(task.agentId, "agent-a");
      assert.deepEqual(task.validationCommands, VALIDATION);
    }

    const scopes = result.decision.subtasks.map((subtask) => subtask.modules);
    assert.deepEqual(scopes.flat().sort(), [
      "services/billing",
      "services/notifications",
    ]);
    // Only the billing half still collides with the sibling.
    assert.deepEqual(
      result.decision.subtasks.map((subtask) => subtask.contended),
      [true, false],
    );
  });
});

test("a split leaves a durable, run-free audit record", async () => {
  await withWorkspace(async (store, repository) => {
    await store.submitTask({
      repositoryId: repository.id,
      objective: "Rework the invoice tax rate table",
      agentId: "agent-b",
      validationCommands: VALIDATION,
    });
    const result = await intake().submit(store, {
      repository,
      objective: SPANNING_OBJECTIVE,
      agentId: "agent-a",
      validationCommands: VALIDATION,
    });
    assert.equal(result.decision.split, true);

    const events = await store.listAudit();
    const decomposed = events.filter(
      (event) => event.type === "task_decomposed",
    );
    assert.equal(decomposed.length, 1);
    const data = decomposed[0]?.data as {
      objective: string;
      reason: string;
      subtasks: { taskId: string; modules: string[] }[];
    };
    assert.equal(data.objective, SPANNING_OBJECTIVE);
    assert.equal(data.reason, "split");
    assert.deepEqual(
      data.subtasks.map((subtask) => subtask.taskId).sort(),
      result.tasks.map((task) => task.id).sort(),
    );
    assert.ok((await store.verifyAudit()).valid);
  });
});

test("no audit event is written when nothing was split", async () => {
  await withWorkspace(async (store, repository) => {
    await intake().submit(store, {
      repository,
      objective: SPANNING_OBJECTIVE,
      agentId: "agent-a",
      validationCommands: VALIDATION,
    });
    const events = await store.listAudit();
    assert.equal(
      events.filter((event) => event.type === "task_decomposed").length,
      0,
    );
  });
});

test("leases held by a running task are the contention signal when present", async () => {
  await withWorkspace(async (store, repository) => {
    const running = await store.submitTask({
      repositoryId: repository.id,
      objective: "Something the estimator cannot place at all",
      agentId: "agent-b",
      validationCommands: VALIDATION,
    });
    const claimed = await store.claimSubmittedTasks(repository.id);
    assert.equal(claimed.length, 1);

    const version = await repositories.getCanonicalVersion({
      id: repository.id,
      path: repository.path,
      branch: repository.branch,
    });
    const run = await store.createRun({
      repository,
      mode: "coordinated",
      baseVersion: version,
    });
    await store.saveLeases(run.id, [
      {
        leaseId: "lease-1",
        resourceType: "file",
        resourceId: "services/billing/src/invoice.ts",
        principalId: "agent-b",
        taskId: running.id,
        mode: "exclusive",
        baseVersion: version.sequence,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);

    const result = await intake().submit(store, {
      repository,
      objective: SPANNING_OBJECTIVE,
      agentId: "agent-a",
      validationCommands: VALIDATION,
    });

    assert.equal(result.decision.split, true);
    assert.deepEqual(result.decision.contendingTaskIds, [running.id]);
  });
});

test("decomposition can be turned off without touching the repository", async () => {
  await withWorkspace(async (store, repository) => {
    await store.submitTask({
      repositoryId: repository.id,
      objective: "Rework the invoice tax rate table",
      agentId: "agent-b",
      validationCommands: VALIDATION,
    });
    const result = await intake({ mode: "off" }).submit(store, {
      repository,
      objective: SPANNING_OBJECTIVE,
      agentId: "agent-a",
      validationCommands: VALIDATION,
    });
    assert.equal(result.tasks.length, 1);
    assert.equal(result.decision.reason, "disabled");
    assert.equal(result.estimate, undefined);
  });
});

test("a repository that cannot be indexed still accepts the task", async () => {
  const store = new InMemoryCoordinationStore();
  const repository: StoredRepository = {
    id: "missing",
    path: path.join(os.tmpdir(), "coord-intake-does-not-exist.git"),
    branch: "main",
  };
  await store.saveRepository(repository);

  const result = await intake().submit(store, {
    repository,
    objective: SPANNING_OBJECTIVE,
    agentId: "agent-a",
    validationCommands: VALIDATION,
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]?.objective, SPANNING_OBJECTIVE);
  assert.ok(result.degraded);
  assert.equal(result.decision.split, false);
  await store.close();
});

test("an empty objective is refused before anything is written", async () => {
  await withWorkspace(async (store, repository) => {
    await assert.rejects(
      async () =>
        await intake().submit(store, {
          repository,
          objective: "   ",
          agentId: "agent-a",
          validationCommands: VALIDATION,
        }),
      /non-empty objective/u,
    );
    assert.equal((await store.listSubmittedTasks()).length, 0);
  });
});
