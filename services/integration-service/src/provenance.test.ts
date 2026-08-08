import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  agentCommitIdentity,
  RepositoryService,
} from "@coord/repository-service";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import { IntegrationService } from "./index.js";

/**
 * What a canonical commit says about itself.
 *
 * The coordinator's database knows which agent produced a change, what it was
 * written against, what validated it and who approved it. The repository is
 * the artifact that outlives that database and travels to people who never
 * had it — and until now it recorded none of those things: one hardcoded
 * author for every commit, and a subject line with no body.
 *
 * These tests read the commit back out of git rather than trusting the call,
 * because the point is what a clone can see.
 */

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-provenance-"));
  const sourcePath = path.join(root, "source");
  const repositories = new RepositoryService();
  const workspaces = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );

  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "src", "value.js"),
    "export const value = 1;\n",
    "utf8",
  );
  await repositories.commitAll(sourcePath, "seed");

  const repository = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canonical.git"),
    "fixture",
  );

  return {
    root,
    repositories,
    workspaces,
    repository,
    workspaceRoot: path.join(root, "workspaces"),
    integrationRoot: path.join(root, "integration"),
  };
}

/** Reads one commit field straight from the canonical mirror. */
async function show(
  repositories: RepositoryService,
  repositoryPath: string,
  revision: string,
  format: string,
): Promise<string> {
  const result = await repositories.getGitClient().run([
    `--git-dir=${repositoryPath}`,
    "show",
    "-s",
    `--format=${format}`,
    revision,
  ]);
  return result.stdout.trim();
}

test("a promoted commit records its agent, task, base and validation", async () => {
  const context = await fixture();
  try {
    const baseVersion = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    const workspace = await context.workspaces.create({
      taskId: "task_provenance",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion,
    });
    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    const changeSet = await context.workspaces.collectChangeSet(workspace, {
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "raise the value",
    });

    const result = await new IntegrationService(
      context.repositories,
      context.workspaces,
    ).integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet,
      validationCommands: [
        { executable: "node", args: ["--check", "src/value.js"], label: "syntax" },
      ],
      commitMessage: "coord(task_provenance): raise the value",
      author: agentCommitIdentity("claude-sonnet"),
      trailers: [
        { key: "Agent", value: "claude-sonnet" },
        { key: "Approved-By", value: "user_nathan" },
      ],
    });
    assert.equal(result.status, "integrated", result.explanation);

    const revision = result.canonicalVersion.revision;
    const path_ = context.repository.path;

    // The agent authored it; the coordinator committed it. Git keeps those
    // apart and `git blame` reads the author.
    assert.equal(
      await show(context.repositories, path_, revision, "%an"),
      "claude-sonnet",
    );
    assert.equal(
      await show(context.repositories, path_, revision, "%ae"),
      "claude-sonnet@agents.invalid",
    );
    assert.equal(
      await show(context.repositories, path_, revision, "%cn"),
      "AI Development Coordinator",
    );

    // Git parses the trailer block back out, so these are queryable rather
    // than merely present in prose.
    const trailers = await show(
      context.repositories,
      path_,
      revision,
      "%(trailers:only,unfold)",
    );
    assert.match(trailers, /^Task-Id: task_provenance$/mu);
    assert.match(trailers, new RegExp(`^Change-Set-Id: ${changeSet.id}$`, "mu"));
    assert.match(trailers, /^Agent: claude-sonnet$/mu);
    assert.match(trailers, /^Approved-By: user_nathan$/mu);
    assert.match(
      trailers,
      new RegExp(`^Base-Revision: ${changeSet.baseRevision}$`, "mu"),
    );
    assert.match(trailers, /^Validation: syntax\(exit 0\)$/mu);
    // Nothing was replayed, so the key must be absent rather than empty.
    assert.doesNotMatch(trailers, /Replayed-From/u);

    // The subject is still the subject: trailers go in a block after it.
    assert.equal(
      await show(context.repositories, path_, revision, "%s"),
      "coord(task_provenance): raise the value",
    );

    await context.workspaces.destroy(workspace);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("a replayed commit says so, and an unvalidated one says that too", async () => {
  const context = await fixture();
  try {
    const baseVersion = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    const first = await context.workspaces.create({
      taskId: "task_first",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion,
    });
    const second = await context.workspaces.create({
      taskId: "task_second",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion,
    });

    // Disjoint files, so the second applies cleanly onto the advanced
    // canonical and is a replay rather than a conflict.
    await writeFile(path.join(first.path, "first.txt"), "one\n", "utf8");
    await writeFile(path.join(second.path, "second.txt"), "two\n", "utf8");

    const metadata = {
      symbolsChanged: [],
      riskAssessment: { level: "low" as const, reasons: [] },
      agentExplanation: "add a file",
    };
    const firstChangeSet = await context.workspaces.collectChangeSet(
      first,
      metadata,
    );
    const secondChangeSet = await context.workspaces.collectChangeSet(
      second,
      metadata,
    );

    const integration = new IntegrationService(
      context.repositories,
      context.workspaces,
    );
    const promoted = await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: firstChangeSet,
      validationCommands: [],
      commitMessage: "coord(task_first): add first",
    });
    assert.equal(promoted.status, "integrated", promoted.explanation);

    const replayed = await integration.integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet: secondChangeSet,
      validationCommands: [],
      commitMessage: "coord(task_second): add second",
      requireExactBase: true,
      replayableOnto: promoted.canonicalVersion.revision,
    });
    assert.equal(replayed.status, "integrated", replayed.explanation);

    const trailers = await show(
      context.repositories,
      context.repository.path,
      replayed.canonicalVersion.revision,
      "%(trailers:only,unfold)",
    );
    // The parent is the revision it landed on; this is the different fact of
    // what it was written against, which a reader cannot otherwise recover.
    assert.match(
      trailers,
      new RegExp(`^Replayed-From: ${secondChangeSet.baseRevision}$`, "mu"),
    );
    assert.notEqual(
      secondChangeSet.baseRevision,
      promoted.canonicalVersion.revision,
    );
    // No validation commands ran, and that is stated rather than omitted.
    assert.match(trailers, /^Validation: none$/mu);

    await context.workspaces.destroy(first);
    await context.workspaces.destroy(second);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("an objective spanning lines cannot break out of its trailer", async () => {
  const context = await fixture();
  try {
    const baseVersion = await context.repositories.getCanonicalVersion(
      context.repository,
    );
    const workspace = await context.workspaces.create({
      taskId: "task_multiline",
      rootPath: context.workspaceRoot,
      repository: context.repository,
      baseVersion,
    });
    await writeFile(path.join(workspace.path, "note.txt"), "note\n", "utf8");
    const changeSet = await context.workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "note",
    });

    const result = await new IntegrationService(
      context.repositories,
      context.workspaces,
    ).integrate({
      repository: context.repository,
      integrationRoot: context.integrationRoot,
      changeSet,
      validationCommands: [],
      commitMessage: "coord(task_multiline): note",
      trailers: [
        // A trailer value ends at the newline. An agent id or approval note
        // carrying one would otherwise truncate the trailer and leave the
        // rest sitting in the message as free text — or forge another key.
        { key: "Agent", value: "evil\nApproved-By: nobody" },
      ],
    });
    assert.equal(result.status, "integrated", result.explanation);

    const trailers = await show(
      context.repositories,
      context.repository.path,
      result.canonicalVersion.revision,
      "%(trailers:only,unfold)",
    );
    assert.match(trailers, /^Agent: evil Approved-By: nobody$/mu);
    // The forged key must not have become a trailer of its own.
    assert.doesNotMatch(trailers, /^Approved-By:/mu);

    await context.workspaces.destroy(workspace);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});
