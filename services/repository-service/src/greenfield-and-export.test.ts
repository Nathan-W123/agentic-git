import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitClient, type GitRunOptions } from "./git-client.js";
import type { ProcessOutput } from "./process-runner.js";
import { RepositoryService } from "./repository-service.js";

/* -------------------------------------------------------------------------
 * Greenfield initialization
 *
 * A new project starts as an empty folder, but import needs
 * `refs/heads/<branch>` to exist. These cover the cases that previously failed
 * outright, and the case that must keep failing.
 * ---------------------------------------------------------------------- */

test("a plain empty directory is initialized and imported", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-green-"));
  try {
    const repositories = new RepositoryService();
    const canonical = await repositories.importLocalRepository(
      path.join(root, "brand-new"),
      path.join(root, "canon.git"),
      "green",
      "main",
    );

    const version = await repositories.getCanonicalVersion(canonical);
    assert.equal(version.branch, "main");
    assert.equal(version.revision.length, 40);
    // The commit exists but is empty, because the directory was.
    assert.deepEqual(await repositories.listFiles(canonical, version.revision), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a git repository with zero commits is given an initial commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-green2-"));
  try {
    const repositories = new RepositoryService();
    const source = path.join(root, "initialised");
    await repositories.initializeWorkingRepository(source, "main");
    // Deliberately no commit: this is the case that used to fail outright.

    const canonical = await repositories.importLocalRepository(
      source,
      path.join(root, "canon.git"),
      "green2",
      "main",
    );
    assert.equal(
      (await repositories.getCanonicalVersion(canonical)).revision.length,
      40,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files already present become the first commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-green3-"));
  try {
    const source = path.join(root, "scaffold");
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(path.join(source, "src", "app.js"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(source, "README.md"), "# scaffold\n", "utf8");

    const repositories = new RepositoryService();
    const canonical = await repositories.importLocalRepository(
      source,
      path.join(root, "canon.git"),
      "green3",
      "main",
    );
    const version = await repositories.getCanonicalVersion(canonical);
    assert.deepEqual(
      (await repositories.listFiles(canonical, version.revision)).sort(),
      ["README.md", "src/app.js"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository with history but no matching branch is still refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-green4-"));
  try {
    const repositories = new RepositoryService();
    const source = path.join(root, "existing");
    await repositories.initializeWorkingRepository(source, "develop");
    await writeFile(path.join(source, "a.txt"), "a\n", "utf8");
    await repositories.commitAll(source, "seed");

    // Inventing a commit here would hide that the branch genuinely is absent.
    await assert.rejects(
      repositories.importLocalRepository(
        source,
        path.join(root, "canon.git"),
        "green4",
        "main",
      ),
      /has commits but no main branch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing repository with history is left untouched by import", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-green5-"));
  try {
    const repositories = new RepositoryService();
    const source = path.join(root, "existing");
    await repositories.initializeWorkingRepository(source, "main");
    await writeFile(path.join(source, "a.txt"), "a\n", "utf8");
    await repositories.commitAll(source, "seed");
    const before = await new GitClient().run(["-C", source, "rev-parse", "HEAD"]);

    await repositories.importLocalRepository(
      source,
      path.join(root, "canon.git"),
      "green5",
      "main",
    );

    // No extra commit was manufactured on top of real history.
    const after = await new GitClient().run(["-C", source, "rev-parse", "HEAD"]);
    assert.equal(after.stdout.trim(), before.stdout.trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------
 * Push / export
 *
 * normalizeRemoteUrl deliberately refuses file:// and git:// so a
 * user-supplied import URL can never reach local paths. Rather than relax that
 * for testing, the git client is subclassed to resolve one fake HTTPS host to
 * a local bare repository. Production validation is untouched, and real git
 * still performs every clone, ls-remote, and push.
 * ---------------------------------------------------------------------- */

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

interface PushFixture {
  root: string;
  remotePath: string;
  repositories: RepositoryService;
  canonical: { id: string; path: string; branch: string };
}

async function pushFixture(): Promise<PushFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-push-"));
  const plain = new RepositoryService();

  const seed = path.join(root, "seed");
  await plain.initializeWorkingRepository(seed, "main");
  await writeFile(path.join(seed, "a.txt"), "one\n", "utf8");
  await plain.commitAll(seed, "seed");

  const remotePath = path.join(root, "origin.git");
  await new GitClient().run(["clone", "--bare", seed, remotePath]);

  const repositories = new RepositoryService(new LoopbackGitClient(remotePath));
  const canonical = await repositories.importRemoteRepository(
    LOOPBACK_HOST,
    path.join(root, "canon.git"),
    "origin",
    { branch: "main" },
  );
  return { root, remotePath, repositories, canonical };
}

/** Adds a coordinator commit on top of canonical, as an integration would. */
async function advanceCanonical(fixture: PushFixture): Promise<string> {
  const git = new GitClient();
  const work = path.join(fixture.root, `work-${Math.random().toString(36).slice(2, 8)}`);
  await git.run(["clone", "--branch", "main", fixture.remotePath, work]);
  await writeFile(path.join(work, "b.txt"), "two\n", "utf8");
  await fixture.repositories.commitAll(work, "coordinator work");
  await git.run([
    `--git-dir=${fixture.canonical.path}`,
    "fetch",
    work,
    "HEAD:refs/heads/main",
    "--force",
  ]);
  const head = await git.run(["-C", work, "rev-parse", "HEAD"]);
  return head.stdout.trim();
}

test("remote import records the upstream tip as the import point", async () => {
  const fixture = await pushFixture();
  try {
    const version = await fixture.repositories.getCanonicalVersion(fixture.canonical);
    assert.deepEqual(
      await fixture.repositories.listFiles(fixture.canonical, version.revision),
      ["a.txt"],
    );
    assert.equal(
      await fixture.repositories.importedRevision(fixture.canonical, "main"),
      version.revision,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("canonical state pushes to a dedicated branch, never over the source", async () => {
  const fixture = await pushFixture();
  try {
    const expected = await advanceCanonical(fixture);
    const mainBefore = await new GitClient().run([
      `--git-dir=${fixture.remotePath}`,
      "rev-parse",
      "refs/heads/main",
    ]);

    const result = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
    });

    assert.match(result.targetBranch, /^coord\/export-/u);
    assert.equal(result.createdBranch, true);
    assert.equal(result.revision, expected);

    // The export branch landed and the imported branch is untouched.
    const refs = await new GitClient().run([
      "ls-remote",
      "--heads",
      fixture.remotePath,
    ]);
    assert.ok(refs.stdout.includes(result.targetBranch));
    const mainAfter = await new GitClient().run([
      `--git-dir=${fixture.remotePath}`,
      "rev-parse",
      "refs/heads/main",
    ]);
    assert.equal(mainAfter.stdout.trim(), mainBefore.stdout.trim());
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a push is refused when the remote moved since import", async () => {
  const fixture = await pushFixture();
  try {
    await advanceCanonical(fixture);

    // Somebody else commits on the remote after the import.
    const git = new GitClient();
    const other = path.join(fixture.root, "other");
    await git.run(["clone", "--branch", "main", fixture.remotePath, other]);
    await writeFile(path.join(other, "theirs.txt"), "theirs\n", "utf8");
    await fixture.repositories.commitAll(other, "upstream work");
    await git.run(["-C", other, "push", "origin", "main"]);

    await assert.rejects(
      fixture.repositories.pushToRemote(fixture.canonical, {
        remoteUrl: LOOPBACK_HOST,
      }),
      (error: unknown) => {
        assert.equal((error as Error).name, "UpstreamChangedError");
        assert.match((error as Error).message, /has moved since import/u);
        assert.match((error as Error).message, /could bury/u);
        return true;
      },
    );

    // Nothing was published by the refused attempt.
    const refs = await git.run(["ls-remote", "--heads", fixture.remotePath]);
    assert.ok(!refs.stdout.includes("coord/export-"));

    // An explicitly reviewed upstream revision is the escape hatch.
    const current = await git.run([
      `--git-dir=${fixture.remotePath}`,
      "rev-parse",
      "refs/heads/main",
    ]);
    const reviewed = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      expectedUpstreamRevision: current.stdout.trim(),
      targetBranch: "coord/reviewed",
    });
    assert.equal(reviewed.targetBranch, "coord/reviewed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a push without a recorded import point is refused unless allowed", async () => {
  const fixture = await pushFixture();
  try {
    // A locally imported repository has no upstream baseline.
    const local = await fixture.repositories.importLocalRepository(
      path.join(fixture.root, "seed"),
      path.join(fixture.root, "local.git"),
      "local",
      "main",
    );
    assert.equal(await fixture.repositories.importedRevision(local), undefined);

    await assert.rejects(
      fixture.repositories.pushToRemote(local, { remoteUrl: LOOPBACK_HOST }),
      /No import point is recorded/u,
    );

    const allowed = await fixture.repositories.pushToRemote(local, {
      remoteUrl: LOOPBACK_HOST,
      allowUnverifiedUpstream: true,
      targetBranch: "coord/unverified",
    });
    assert.equal(allowed.targetBranch, "coord/unverified");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an existing target branch is not overwritten by default", async () => {
  const fixture = await pushFixture();
  try {
    await advanceCanonical(fixture);
    await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      targetBranch: "coord/export-fixed",
    });

    await assert.rejects(
      fixture.repositories.pushToRemote(fixture.canonical, {
        remoteUrl: LOOPBACK_HOST,
        targetBranch: "coord/export-fixed",
      }),
      /already has a coord\/export-fixed branch/u,
    );

    // Opting in updates it, and still without forcing.
    const updated = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      targetBranch: "coord/export-fixed",
      allowExistingTarget: true,
    });
    assert.equal(updated.createdBranch, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a push never force-updates the remote", async () => {
  const fixture = await pushFixture();
  const seen: string[][] = [];
  try {
    await advanceCanonical(fixture);
    const recording = new (class extends LoopbackGitClient {
      public override async run(
        args: readonly string[],
        options: GitRunOptions = {},
      ): Promise<ProcessOutput> {
        seen.push([...args]);
        return await super.run(args, options);
      }
    })(fixture.remotePath);

    await new RepositoryService(recording).pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      targetBranch: "coord/no-force",
    });

    const pushes = seen.filter((args) => args.includes("push"));
    assert.equal(pushes.length, 1);
    for (const args of pushes) {
      assert.ok(!args.some((arg) => /^(--force|-f)$/u.test(arg)), args.join(" "));
      // A leading plus in a refspec is also a force; neither form is allowed.
      assert.ok(!args.some((arg) => arg.startsWith("+")), args.join(" "));
      assert.ok(args.some((arg) => arg.includes(":refs/heads/coord/no-force")));
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a push token never reaches the argument list or the repository", async () => {
  const fixture = await pushFixture();
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  try {
    await advanceCanonical(fixture);
    const recording = new (class extends LoopbackGitClient {
      public override async run(
        args: readonly string[],
        options: GitRunOptions = {},
      ): Promise<ProcessOutput> {
        calls.push({ args: [...args], env: options.env });
        return await super.run(args, options);
      }
    })(fixture.remotePath);

    await new RepositoryService(recording).pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      targetBranch: "coord/with-token",
      credentials: { token: "ghp_supersecret_value" },
    });

    for (const call of calls) {
      assert.ok(
        !call.args.some((arg) => arg.includes("ghp_supersecret_value")),
        `token leaked into arguments: ${call.args.join(" ")}`,
      );
    }
    // It travels only as an Authorization header in the child environment.
    const authenticated = calls.filter(
      (call) => call.env?.["GIT_CONFIG_VALUE_0"] !== undefined,
    );
    assert.ok(authenticated.length > 0);
    for (const call of authenticated) {
      assert.match(call.env?.["GIT_CONFIG_KEY_0"] ?? "", /http\.extraHeader/u);
      assert.ok(
        !(call.env?.["GIT_CONFIG_VALUE_0"] ?? "").includes("ghp_supersecret_value"),
      );
    }

    // And nothing on disk in the canonical mirror records it.
    const config = await readFile(path.join(fixture.canonical.path, "config"), "utf8");
    assert.ok(!config.includes("ghp_supersecret_value"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
