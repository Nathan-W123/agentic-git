import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoordinatorProject } from "@coord/cli/project";
import { InMemoryCoordinationStore } from "@coord/persistence";
import {
  UpstreamChangedError,
  type RepositoryService,
} from "@coord/repository-service";
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

interface RecordedRemoteCall {
  operation: "sync" | "push";
  credentials?: { token: string };
  /** Present when the push was handed a model to name its branch with. */
  branchNamer?: unknown;
}

function recordingRepositories(
  captured: RecordedRemoteCall[],
  outcomes: {
    sync?: Array<"sync" | Error>;
    push?: Array<"push" | Error>;
  } = {},
): RepositoryService {
  const syncOutcomes = [...(outcomes.sync ?? [])];
  const pushOutcomes = [...(outcomes.push ?? [])];
  return {
    syncFromRemote: async (
      _repository: unknown,
      options: { credentials?: { token: string } },
    ) => {
      captured.push({ operation: "sync", ...options });
      const outcome = syncOutcomes.shift() ?? "sync";
      if (outcome instanceof Error) {
        throw outcome;
      }
      const revision = "feedface12".padEnd(40, "0");
      return {
        status: "already_current",
        remoteUrl: "https://push.invalid/origin.git",
        upstreamBranch: "main",
        upstreamRevision: revision,
        previousRevision: revision,
        revision,
      };
    },
    pushToRemote: async (
      _repository: unknown,
      options: { credentials?: { token: string }; branchNamer?: unknown },
    ) => {
      captured.push({ operation: "push", ...options });
      const outcome = pushOutcomes.shift() ?? "push";
      if (outcome instanceof Error) {
        throw outcome;
      }
      return {
        remoteUrl: "https://push.invalid/origin.git",
        targetBranch: "coord/readable-push-names",
        summary: "Use readable push branch names and include a fuller summary",
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
  // The push action arrives from inside this claimed task. Its own claim is
  // exempt from the sync guard; another task's claim would still block it.
  await store.claimSubmittedTasks("origin");

  const captured: RecordedRemoteCall[] = [];
  const result = await pushCanonical(
    project,
    store,
    github,
    { repository: { id: "origin" }, task: { id: task.id } },
    recordingRepositories(captured),
  );

  assert.equal(result.outcome, "done");
  assert.deepEqual(
    captured.map((call) => call.operation),
    ["sync", "push"],
  );
  assert.ok(
    captured.every(
      (call) => call.credentials?.token === "ghp_users_own",
    ),
  );
  // The explanation is the branch and the identity the push carried, and
  // nothing else: the person reading the thread knows where it landed and
  // which account to look for on GitHub. The objective summary, the revision
  // and the remote URL are deliberately absent.
  assert.equal(
    result.explanation,
    "Pushed to coord/readable-push-names as octocat.",
  );
  assert.doesNotMatch(
    result.explanation,
    /Use readable push branch names and include a fuller summary/u,
  );
});

test("a direct push runs as the authenticated actor without creating a task", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_direct_user" });

  const captured: RecordedRemoteCall[] = [];
  const result = await pushCanonicalForActor(
    project,
    store,
    github,
    { repositoryId: "origin", actorId: submitter },
    recordingRepositories(captured),
  );

  assert.equal(result.outcome, "done");
  assert.deepEqual(
    captured.map((call) => call.operation),
    ["sync", "push"],
  );
  assert.ok(
    captured.every(
      (call) => call.credentials?.token === "ghp_direct_user",
    ),
  );
  // `/push` says the branch and the account, full stop.
  assert.equal(
    result.explanation,
    "Pushed to coord/readable-push-names as octocat.",
  );
  assert.deepEqual(
    await store.listSubmittedTasks({ repositoryId: "origin" }),
    [],
  );
  assert.equal(
    (await store.listAuditEvents({})).filter(
      (entry) => entry.event.type === "repository_synced",
    ).length,
    1,
  );
});

test("the push is handed the local model that names its branch", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_named" });
  const previous = process.env["COORD_LOCAL_TRIAGE"];
  delete process.env["COORD_LOCAL_TRIAGE"];
  t.after(async () => {
    if (previous === undefined) {
      delete process.env["COORD_LOCAL_TRIAGE"];
    } else {
      process.env["COORD_LOCAL_TRIAGE"] = previous;
    }
  });

  const captured: RecordedRemoteCall[] = [];
  const result = await pushCanonicalForActor(
    project,
    store,
    github,
    { repositoryId: "origin", actorId: submitter },
    recordingRepositories(captured),
  );

  assert.equal(result.outcome, "done");
  // The model is offered, never required: building it loads nothing, and the
  // push names its own branch when the model declines to.
  const push = captured.find((call) => call.operation === "push");
  assert.equal(typeof push?.branchNamer, "function");
});

test("a deployment with local models switched off pushes without one", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_unnamed" });
  const previous = process.env["COORD_LOCAL_TRIAGE"];
  process.env["COORD_LOCAL_TRIAGE"] = "0";
  t.after(async () => {
    if (previous === undefined) {
      delete process.env["COORD_LOCAL_TRIAGE"];
    } else {
      process.env["COORD_LOCAL_TRIAGE"] = previous;
    }
  });

  const captured: RecordedRemoteCall[] = [];
  const result = await pushCanonicalForActor(
    project,
    store,
    github,
    { repositoryId: "origin", actorId: submitter },
    recordingRepositories(captured),
  );

  assert.equal(result.outcome, "done");
  assert.equal(
    captured.find((call) => call.operation === "push")?.branchNamer,
    undefined,
  );
});

test("an upstream move between sync and push is pulled and retried once", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_racing_remote" });

  const captured: RecordedRemoteCall[] = [];
  const result = await pushCanonicalForActor(
    project,
    store,
    github,
    { repositoryId: "origin", actorId: submitter },
    recordingRepositories(captured, {
      push: [
        new UpstreamChangedError(
          "main",
          "a".repeat(40),
          "b".repeat(40),
        ),
        "push",
      ],
    }),
  );

  assert.equal(result.outcome, "done");
  assert.deepEqual(
    captured.map((call) => call.operation),
    ["sync", "push", "sync", "push"],
  );
  assert.equal(
    (await store.listAuditEvents({})).filter(
      (entry) => entry.event.type === "repository_synced",
    ).length,
    2,
  );
});

test("a failed sync refuses without attempting a push", async (t) => {
  const { project, store, github, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_sync_failure" });

  const captured: RecordedRemoteCall[] = [];
  const result = await pushCanonicalForActor(
    project,
    store,
    github,
    { repositoryId: "origin", actorId: submitter },
    recordingRepositories(captured, {
      sync: [new Error("the remote histories conflict")],
    }),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /sync did not go through/iu);
  assert.match(result.explanation, /nothing was pushed/iu);
  assert.deepEqual(
    captured.map((call) => call.operation),
    ["sync"],
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

  const captured: RecordedRemoteCall[] = [];
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
    recordingRepositories([], {
      push: [
        new Error(
          "fatal: Authentication failed for 'https://github.com/x/y.git/'",
        ),
      ],
    }),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /reconnect GitHub/iu);
  const summary = await credentials.summary(submitter, "github");
  assert.match(summary?.unusableReason ?? "", /during a push/u);
});

test("a token GitHub refuses during sync is marked unusable", async (t) => {
  const { project, store, github, credentials, submitter } = await harness(t);
  await github.connect({ userId: submitter, token: "ghp_expired_sync" });

  const result = await pushCanonicalForActor(
    project,
    store,
    github,
    { repositoryId: "origin", actorId: submitter },
    recordingRepositories([], {
      sync: [
        new Error(
          "fatal: Authentication failed for 'https://github.com/x/y.git/'",
        ),
      ],
    }),
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.explanation, /reconnect GitHub/iu);
  const summary = await credentials.summary(submitter, "github");
  assert.match(summary?.unusableReason ?? "", /during a sync/u);
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
