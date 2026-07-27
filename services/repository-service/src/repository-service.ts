import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { CanonicalVersion } from "@coord/shared-types";

import { GitClient } from "./git-client.js";

export interface CanonicalRepository {
  id: string;
  path: string;
  branch: string;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

const DEFAULT_IDENTITY: CommitIdentity = {
  name: "AI Development Coordinator",
  email: "coordinator@localhost",
};

export class RepositoryService {
  public constructor(
    private readonly git = new GitClient(),
    private readonly identity: CommitIdentity = DEFAULT_IDENTITY,
  ) {}

  public async initializeWorkingRepository(
    repositoryPath: string,
    branch = "main",
  ): Promise<void> {
    await mkdir(repositoryPath, { recursive: true });
    await this.git.run(["init", `--initial-branch=${branch}`, repositoryPath]);
  }

  public async importLocalRepository(
    sourcePath: string,
    destinationPath: string,
    id: string,
    branch = "main",
  ): Promise<CanonicalRepository> {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await this.git.run(["clone", "--bare", sourcePath, destinationPath]);
    await this.git.run([
      `--git-dir=${destinationPath}`,
      "show-ref",
      "--verify",
      `refs/heads/${branch}`,
    ]);

    return {
      id,
      path: destinationPath,
      branch,
    };
  }

  public async getCanonicalVersion(
    repository: CanonicalRepository,
  ): Promise<CanonicalVersion> {
    const reference = `refs/heads/${repository.branch}`;
    const revisionResult = await this.git.run([
      `--git-dir=${repository.path}`,
      "rev-parse",
      "--verify",
      reference,
    ]);
    const revision = revisionResult.stdout.trim();

    const [sequenceResult, createdAtResult] = await Promise.all([
      this.git.run([
        `--git-dir=${repository.path}`,
        "rev-list",
        "--count",
        revision,
      ]),
      this.git.run([
        `--git-dir=${repository.path}`,
        "show",
        "-s",
        "--format=%cI",
        revision,
      ]),
    ]);

    return {
      sequence: Number.parseInt(sequenceResult.stdout.trim(), 10),
      revision,
      branch: repository.branch,
      createdAt: createdAtResult.stdout.trim(),
    };
  }

  public async commitAll(
    worktreePath: string,
    message: string,
  ): Promise<string | undefined> {
    await this.git.run(["-C", worktreePath, "add", "--all", "--"]);
    const diff = await this.git.run(
      ["-C", worktreePath, "diff", "--cached", "--quiet", "--exit-code"],
      { allowFailure: true },
    );

    if (diff.exitCode === 0) {
      return undefined;
    }

    await this.git.run([
      "-C",
      worktreePath,
      "-c",
      `user.name=${this.identity.name}`,
      "-c",
      `user.email=${this.identity.email}`,
      "commit",
      "--no-gpg-sign",
      "-m",
      message,
    ]);

    const revision = await this.git.run([
      "-C",
      worktreePath,
      "rev-parse",
      "HEAD",
    ]);
    return revision.stdout.trim();
  }

  public async promote(
    repository: CanonicalRepository,
    candidateRevision: string,
    expectedRevision: string,
  ): Promise<boolean> {
    const result = await this.git.run(
      [
        `--git-dir=${repository.path}`,
        "update-ref",
        `refs/heads/${repository.branch}`,
        candidateRevision,
        expectedRevision,
      ],
      { allowFailure: true },
    );
    return result.exitCode === 0;
  }

  public async readFile(
    repository: CanonicalRepository,
    revision: string,
    repositoryPath: string,
  ): Promise<string> {
    const result = await this.git.run([
      `--git-dir=${repository.path}`,
      "show",
      `${revision}:${repositoryPath}`,
    ]);
    return result.stdout;
  }

  public getGitClient(): GitClient {
    return this.git;
  }
}

