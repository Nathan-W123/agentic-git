import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject } from "@coord/cli/project";
import { InMemoryCoordinationStore } from "@coord/persistence";
import {
  SyncDivergedError,
  type RepositoryService,
} from "@coord/repository-service";
import { UserCredentialStore } from "@coord/workspace-manager";

import { GitHubConnectionService } from "./github-connection.js";
import { pullCanonical } from "./pull-canonical.js";

/**
 * The pull action's rules, tested at the seam where they live: whose token a
 * sync reads with, what an anonymous pull may do, and how a refusal reads.
 * The git mechanics underneath (fast-forward, merge, conflict refusal,
 * moved import point) are pinned by the repository service's own tests
 * against a real remote.
 */

async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-pullcanon-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, "p");
  await mkdir(projectRoot, { recursive: true });
  const project = await CoordinatorProject.init(projectRoot);
  const store = new InMemoryCoordinationStore();
  const credentials = await UserCredentialStore.open(path.join(root, "secrets"));
  const github = new GitHubConnectionService({
    credentials,
    fetchImpl: async () =>
      new Response(JSON.stringify({ login: "octocat" }), { status: 200 }),
  });
  await store.saveRepository({
    id: "origin",
    path: path.join(root, "unused.git"),
    branch: "main",
    provider: "github",
    remoteUrl: "https://push.invalid/origin.git",
  });
  const submitter = (
    await store.createUser({
      email: "submitter@example.test",
      displayName: "Submitter",
      passwordDigest: "x",
    })
  ).id;
  return { project, store, credentials, github, submitter };
}

function syncingRepositories(
  captured: Array<{ credentials?: { token: string } }>,
  outcome:
    | "already_current"
    | "fast_forwarded"
    | "merged"
    | Error = "fast_forwarded",
): RepositoryService {
  const previousRevision = "cafebabe12".padEnd(40, "0");
  const revision =
    outcome === "already_current"
      ? previousRevision
      : "beefbeef12".padEnd(40, "0");
  return {
    syncFromRemote: async (
      _repository: unknown,
      options: { credentials?: { token: string } },
    ) => {
      captured.push(options);
      if (outcome instanceof Error) {
        throw outcome;
      }
      return {
        status: outcome,
        remoteUrl: "https://push.invalid/origin.git",
        upstreamBranch: "main",
        upstreamRevision: "feedface12".padEnd(40, "0"),
        previousRevision,
        revision,
      };
    },
    getCanonicalVersion: async () => ({
      sequence: 3,
      revision,
      branch: "main",
      createdAt: new Date().toISOString(),
    }),
  } as unknown as RepositoryService;
}

test("a pull reads with the submitter's stored token and reports the move", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_users_own" });
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "pull from GitHub",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });

  const captured: Array<{ credentials?: { token: string } }> = [];
  const result = await pullCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    syncingRepositories(captured),
  );

  assert.equal(result.outcome, "done");
  assert.equal(captured[0]?.credentials?.token, "ghp_users_own");
  assert.match(result.explanation, /Pulled from GitHub/u);
  assert.match(result.explanation, /unblocked/u);
  // The sync is on the audit record, so the channel and the log agree.
  const audited = (await store.listAuditEvents({})).filter(
    (entry) => entry.event.type === "repository_synced",
  );
  assert.equal(audited.length, 1);
});

test("no GitHub connection still pulls — a read needs no identity", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "pull from GitHub",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });

  const captured: Array<{ credentials?: { token: string } }> = [];
  const result = await pullCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    syncingRepositories(captured, "already_current"),
  );

  assert.equal(result.outcome, "done");
  assert.equal(captured[0]?.credentials, undefined);
  assert.match(result.explanation, /nothing to pull/iu);
});

test("a merged pull says both sides moved and nothing was lost", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "pull from GitHub",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });

  const result = await pullCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    syncingRepositories([], "merged"),
  );

  assert.equal(result.outcome, "done");
  assert.match(result.explanation, /both moved/u);
  assert.match(result.explanation, /Nothing from either side was lost/u);
});

test("a conflicting sync is refused with the service's own explanation", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "pull from GitHub",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });

  const result = await pullCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    syncingRepositories([], new SyncDivergedError("main", ["src/app.js"])),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /both changed the same files/u);
  assert.match(result.explanation, /src\/app\.js/u);
  assert.match(result.explanation, /Nothing was changed/u);
});

test("a token GitHub refuses mid-sync is marked unusable", async (t) => {
  const { project, store, github, credentials, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_expired" });
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "pull from GitHub",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });

  const result = await pullCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    syncingRepositories(
      [],
      new Error("fatal: Authentication failed for 'https://github.com/x/y.git/'"),
    ),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /reconnect GitHub/iu);
  const summary = await credentials.summary(submitter, "github");
  assert.match(summary?.unusableReason ?? "", /during a sync/u);
});

test("the asking task's own claim does not block its own pull", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "pull from GitHub",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });
  // The action arrives from inside the run, so the asking task is claimed
  // by definition — counting it would refuse every pull ever asked for.
  await store.claimSubmittedTasks("origin");

  const result = await pullCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    syncingRepositories([]),
  );

  assert.equal(result.outcome, "done");
});

test("executing tasks block the sync — the ground must not move under them", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "pull from GitHub",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });
  // Another task is mid-run in the same repository.
  await store.submitTask({
    repositoryId: "origin",
    objective: "unrelated work",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });
  await store.claimSubmittedTasks("origin");

  const captured: Array<{ credentials?: { token: string } }> = [];
  const result = await pullCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    syncingRepositories(captured),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /executing .* right now/u);
  assert.equal(captured.length, 0, "nothing may touch the mirror");
});

test("a repository with no remote is refused before anything is fetched", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  await store.saveRepository({
    id: "local-only",
    path: "/nowhere",
    branch: "main",
    provider: "local",
  });
  const task = await store.submitTask({
    repositoryId: "local-only",
    objective: "pull from GitHub",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });

  const result = await pullCanonical(
    project,
    store,
    github,
    { repository: { id: "local-only" }, task: { id: task.id } },
    syncingRepositories([]),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /nothing to pull from/u);
});
