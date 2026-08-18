import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject } from "@coord/cli/project";
import { InMemoryCoordinationStore } from "@coord/persistence";
import type { RepositoryService } from "@coord/repository-service";
import { UserCredentialStore } from "@coord/workspace-manager";

import { GitHubConnectionService } from "./github-connection.js";
import {
  pushCanonical,
  pushCanonicalForActor,
} from "./push-canonical.js";

/**
 * The push action's identity rules, tested at the seam where they live: who
 * a push runs as, and what is refused when there is nobody it could run as.
 * The git mechanics underneath (new branch, moved upstream, no force) are
 * pinned by repo-export's own tests against a real remote.
 */

async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-pushcanon-"));
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

function recordingRepositories(
  captured: Array<{ credentials?: { token: string } }>,
  outcome: "push" | Error = "push",
): RepositoryService {
  return {
    pushToRemote: async (
      _repository: unknown,
      options: { credentials?: { token: string } },
    ) => {
      captured.push(options);
      if (outcome instanceof Error) {
        throw outcome;
      }
      return {
        remoteUrl: "https://push.invalid/origin.git",
        targetBranch: "coord/export-x",
        revision: "abcdef1234".padEnd(40, "0"),
        upstreamBranch: "main",
        upstreamRevision: undefined,
        createdBranch: true,
      };
    },
  } as unknown as RepositoryService;
}

test("a push runs as the task's submitter, with their stored token", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_users_own" });
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "publish this",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });

  const captured: Array<{ credentials?: { token: string } }> = [];
  const result = await pushCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    recordingRepositories(captured),
  );

  assert.equal(result.outcome, "done");
  assert.equal(captured[0]?.credentials?.token, "ghp_users_own");
  // The explanation names the identity the push carried, so the person
  // reading the thread knows which account to look for on GitHub.
  assert.match(result.explanation, /as octocat/u);
});

test("a direct push runs as the authenticated actor without creating a task", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_direct_user" });

  const captured: Array<{ credentials?: { token: string } }> = [];
  const result = await pushCanonicalForActor(
    project,
    store,
    github,
    { repositoryId: "origin", actorId: submitter },
    recordingRepositories(captured),
  );

  assert.equal(result.outcome, "done");
  assert.equal(captured[0]?.credentials?.token, "ghp_direct_user");
  assert.deepEqual(
    await store.listSubmittedTasks({ repositoryId: "origin" }),
    [],
  );
});

test("a submitter with no GitHub connection is refused by name, not covered for", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  // Even a deployment-wide token in the environment must not answer here —
  // that mechanism is exactly what per-user connections replace.
  const previousToken = process.env["GITHUB_TOKEN"];
  process.env["GITHUB_TOKEN"] = "ghp_deployment_wide";
  t.after(async () => {
    if (previousToken === undefined) {
      delete process.env["GITHUB_TOKEN"];
    } else {
      process.env["GITHUB_TOKEN"] = previousToken;
    }
  });
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "publish this",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });

  const captured: Array<{ credentials?: { token: string } }> = [];
  const result = await pushCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    recordingRepositories(captured),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /haven't connected GitHub/u);
  assert.equal(captured.length, 0, "nothing may reach the remote");
});

test("a task that records no submitter cannot push as anyone", async (t) => {
  const { project, store, github } = await harness(t);
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "publish this",
    agentId: "builder",
    validationCommands: [],
  });

  const result = await pushCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    recordingRepositories([]),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /records no submitter/u);
});

test("a token GitHub refuses mid-push is marked unusable and named in the refusal", async (t) => {
  const { project, store, github, credentials, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_expired" });
  const task = await store.submitTask({
    repositoryId: "origin",
    objective: "publish this",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });

  const result = await pushCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    recordingRepositories(
      [],
      new Error(
        "fatal: Authentication failed for 'https://github.com/x/y.git/'",
      ),
    ),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /reconnect GitHub/iu);
  const summary = await credentials.summary(submitter, "github");
  assert.match(summary?.unusableReason ?? "", /refused this token/u);
});

test("a repository with no remote is refused before any identity question", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  await store.saveRepository({
    id: "local-only",
    path: "/nowhere",
    branch: "main",
    provider: "local",
  });
  const task = await store.submitTask({
    repositoryId: "local-only",
    objective: "publish this",
    agentId: "builder",
    validationCommands: [],
    submittedBy: submitter,
  });

  const result = await pushCanonical(
    project,
    store,
    github,
    { repository: { id: "local-only" }, task: { id: task.id } },
    recordingRepositories([]),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /no remote recorded/u);
});
