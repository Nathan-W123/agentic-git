import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemoryCoordinationStore } from "@coord/persistence";
import {
  GitClient,
  RepositoryService,
  type GitRunOptions,
  type ProcessOutput,
} from "@coord/repository-service";

import { CoordinatorProject } from "./project.js";
import { repoAdd, repoCreate } from "./commands.js";
import {
  formatRepoPushResult,
  pushCredentials,
  repoPush,
} from "./repo-export.js";

/**
 * The CLI-facing export path.
 *
 * Remote URL validation refuses file:// and git://, so a fake HTTPS host is
 * mapped to a local bare repository at the git-invocation boundary. Nothing in
 * the validator is relaxed and real git performs the push.
 */

const LOOPBACK_HOST = "https://push.invalid/origin.git";

class LoopbackGitClient extends GitClient {
  public constructor(private readonly localRemote: string) {
    super();
  }

  public override async run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<ProcessOutput> {
    return await super.run(
      args.map((arg) => (arg === LOOPBACK_HOST ? this.localRemote : arg)),
      options,
    );
  }
}

interface Harness {
  root: string;
  project: CoordinatorProject;
  store: InMemoryCoordinationStore;
  repositories: RepositoryService;
  remotePath: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cexp-"));
  const projectRoot = path.join(root, "p");
  await mkdir(projectRoot, { recursive: true });
  const project = await CoordinatorProject.init(projectRoot);

  const plain = new RepositoryService();
  const seed = path.join(root, "seed");
  await plain.initializeWorkingRepository(seed, "main");
  await writeFile(path.join(seed, "a.txt"), "one\n", "utf8");
  await plain.commitAll(seed, "seed");

  const remotePath = path.join(root, "origin.git");
  await new GitClient().run(["clone", "--bare", seed, remotePath]);

  return {
    root,
    project,
    store: new InMemoryCoordinationStore(),
    repositories: new RepositoryService(new LoopbackGitClient(remotePath)),
    remotePath,
  };
}

test("the push token is read from the environment, never from config", async () => {
  assert.equal(pushCredentials({}), undefined);
  assert.equal(pushCredentials({ GITHUB_TOKEN: "   " }), undefined);
  assert.deepEqual(pushCredentials({ GITHUB_TOKEN: "ghp_abc" }), {
    token: "ghp_abc",
  });

  const harness = await createHarness();
  try {
    // A token must never be persisted anywhere a commit could pick it up.
    const config = JSON.stringify(harness.project.config);
    assert.ok(!config.includes("GITHUB_TOKEN"));
    assert.ok(!config.includes("token"));
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("CLI push output includes the short branch and longer summary", () => {
  assert.equal(
    formatRepoPushResult({
      remoteUrl: "https://github.com/example/project.git",
      targetBranch: "coord/readable-push-names",
      summary: "Use readable push branch names and include a fuller summary",
      revision: "abcdef1234567890".padEnd(40, "0"),
      upstreamBranch: "main",
      upstreamRevision: "1".repeat(40),
      createdBranch: true,
    }),
    "Pushed abcdef123456 to coord/readable-push-names\n" +
      "Summary: Use readable push branch names and include a fuller summary\n" +
      "Remote: https://github.com/example/project.git\n" +
      "Created the target branch; main was not modified.",
  );
});

test("a repository imported from a remote pushes to a dedicated branch", async () => {
  const harness = await createHarness();
  try {
    const canonical = await harness.repositories.importRemoteRepository(
      LOOPBACK_HOST,
      path.join(harness.project.repositoriesPath, "origin.git"),
      "origin",
      { branch: "main" },
    );
    await harness.store.saveRepository({
      id: canonical.id,
      path: canonical.path,
      branch: canonical.branch,
      provider: "github",
      remoteUrl: LOOPBACK_HOST,
    });
    harness.project.config.defaultRepository = canonical.id;
    await harness.project.save();

    const result = await repoPush(
      harness.project,
      harness.store,
      { targetBranch: "coord/done" },
      harness.repositories,
    );

    assert.equal(result.targetBranch, "coord/done");
    assert.equal(result.createdBranch, true);
    const refs = await new GitClient().run([
      "ls-remote",
      "--heads",
      harness.remotePath,
    ]);
    assert.ok(refs.stdout.includes("coord/done"));
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("pushing a repository with no recorded remote explains what to do", async () => {
  const harness = await createHarness();
  try {
    // Imported from a local path, so no remote is associated with it.
    await repoAdd(harness.project, harness.store, {
      sourcePath: path.join(harness.root, "seed"),
      id: "localonly",
    });

    await assert.rejects(
      repoPush(harness.project, harness.store, {}, harness.repositories),
      /has no remote recorded/u,
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a greenfield project can be created, registered, and pushed", async () => {
  const harness = await createHarness();
  try {
    const registered = await repoCreate(harness.project, harness.store, {
      id: "newidea",
    });
    assert.equal(registered.id, "newidea");

    // It has a real canonical revision despite starting empty.
    const version = await harness.repositories.getCanonicalVersion({
      id: registered.id,
      path: registered.path,
      branch: registered.branch,
    });
    assert.equal(version.revision.length, 40);

    // Never imported from a remote, so publishing requires an explicit remote
    // and an acknowledgement that no upstream baseline exists.
    const result = await repoPush(
      harness.project,
      harness.store,
      {
        repositoryId: "newidea",
        remoteUrl: LOOPBACK_HOST,
        targetBranch: "coord/greenfield",
        allowUnverifiedUpstream: true,
      },
      harness.repositories,
    );
    assert.equal(result.targetBranch, "coord/greenfield");

    const refs = await new GitClient().run([
      "ls-remote",
      "--heads",
      harness.remotePath,
    ]);
    assert.ok(refs.stdout.includes("coord/greenfield"));
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("an explicit per-user credential wins over the environment token", async () => {
  const harness = await createHarness();
  const previousToken = process.env["GITHUB_TOKEN"];
  process.env["GITHUB_TOKEN"] = "ghp_deployment_wide";
  try {
    await harness.store.saveRepository({
      id: "origin",
      path: path.join(harness.root, "unused.git"),
      branch: "main",
      provider: "github",
      remoteUrl: LOOPBACK_HOST,
    });
    harness.project.config.defaultRepository = "origin";
    await harness.project.save();

    // Capturing at the service boundary: what matters is which credential
    // reaches the push, not whether git accepts it.
    const captured: Array<{ credentials?: { token: string } }> = [];
    const recording = {
      pushToRemote: async (
        _repository: unknown,
        options: { credentials?: { token: string } },
      ) => {
        captured.push(options);
        return {
          remoteUrl: LOOPBACK_HOST,
          targetBranch: "coord/x",
          summary: "Update the repository",
          revision: "0".repeat(40),
          upstreamBranch: "main",
          upstreamRevision: undefined,
          createdBranch: true,
        };
      },
    } as unknown as RepositoryService;

    // The dashboard's shape: the submitter's own stored token is handed in,
    // and the deployment's environment must not answer instead.
    await repoPush(
      harness.project,
      harness.store,
      { credentials: { token: "ghp_submitters_own" } },
      recording,
    );
    assert.equal(captured[0]?.credentials?.token, "ghp_submitters_own");

    // The CLI's shape: nothing passed, the operator's own environment pays.
    await repoPush(harness.project, harness.store, {}, recording);
    assert.equal(captured[1]?.credentials?.token, "ghp_deployment_wide");
  } finally {
    if (previousToken === undefined) {
      delete process.env["GITHUB_TOKEN"];
    } else {
      process.env["GITHUB_TOKEN"] = previousToken;
    }
    await rm(harness.root, { recursive: true, force: true });
  }
});
