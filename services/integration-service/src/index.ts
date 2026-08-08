import {
  normalizeRepositoryPath,
  type CanonicalVersion,
  type ChangeSet,
  type CommandResult,
  type FilePatchStatus,
  type IntegrationResult,
  type ValidationCommand,
} from "@coord/shared-types";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  GitWorktreeWorkspaceManager,
  isEphemeralWorkspacePath,
  parseNameStatusZ,
  parsePathListZ,
  type TaskWorkspace,
  type WorkspaceManager,
} from "@coord/workspace-manager";

export interface IntegrateChangeSetInput {
  repository: CanonicalRepository;
  integrationRoot: string;
  changeSet: ChangeSet;
  validationCommands: ValidationCommand[];
  commitMessage: string;
  /** Reject instead of replaying when canonical no longer matches the worker base. */
  requireExactBase?: boolean;
  /**
   * The one canonical revision this changeset may be replayed onto despite
   * having been written against an older base.
   *
   * The caller establishes that the advance to this exact revision touched
   * nothing the changeset depends on. Naming the revision rather than passing
   * a boolean is what keeps the permission from outliving the check: canonical
   * moving once more between that check and this call leaves the revisions
   * unequal, and the result is refused as stale exactly as before.
   */
  replayableOnto?: string;
}

export interface IntegrationServiceOptions {
  validationTimeoutMs?: number;
  maxValidationOutputBytes?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patchStatus(code: string): FilePatchStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    default:
      return "modified";
  }
}

export class IntegrationService {
  public constructor(
    private readonly repositories = new RepositoryService(),
    private readonly workspaces: WorkspaceManager =
      new GitWorktreeWorkspaceManager(repositories.getGitClient()),
    private readonly options: IntegrationServiceOptions = {},
  ) {
    for (const [name, value] of [
      ["validationTimeoutMs", options.validationTimeoutMs],
      ["maxValidationOutputBytes", options.maxValidationOutputBytes],
    ] as const) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < 1)
      ) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  public async integrate(
    input: IntegrateChangeSetInput,
  ): Promise<IntegrationResult> {
    const previousVersion = await this.repositories.getCanonicalVersion(
      input.repository,
    );

    const overtaken =
      input.changeSet.baseRevision !== previousVersion.revision;
    // The workspace below is built from current canonical and the patches are
    // applied three-way, so replaying is not a new mechanism — this gate is
    // the only thing that has been standing in front of it.
    const replaying =
      overtaken && input.replayableOnto === previousVersion.revision;
    if (input.requireExactBase === true && overtaken && !replaying) {
      return {
        taskId: input.changeSet.taskId,
        changeSetId: input.changeSet.id,
        status: "stale",
        previousVersion,
        canonicalVersion: previousVersion,
        validation: [],
        explanation:
          "Canonical state changed after the remote plan; the task must replan",
      };
    }

    if (input.changeSet.patches.length === 0) {
      return {
        taskId: input.changeSet.taskId,
        changeSetId: input.changeSet.id,
        status: "empty",
        previousVersion,
        canonicalVersion: previousVersion,
        validation: [],
        explanation: "The agent produced no repository changes",
      };
    }

    const declaredEntries = input.changeSet.patches.map((filePatch) => ({
      path: normalizeRepositoryPath(filePatch.path),
      status: filePatch.status,
    }));
    const declaredPaths = declaredEntries.map((entry) => entry.path);
    if (new Set(declaredPaths).size !== declaredPaths.length) {
      return {
        taskId: input.changeSet.taskId,
        changeSetId: input.changeSet.id,
        status: "policy_failed",
        previousVersion,
        canonicalVersion: previousVersion,
        validation: [],
        explanation: "The changeset declares the same file more than once",
      };
    }

    const integrationWorkspace = await this.workspaces.create({
      taskId: `integration-${input.changeSet.taskId}`,
      rootPath: input.integrationRoot,
      repository: input.repository,
      baseVersion: previousVersion,
    });

    let result: IntegrationResult | undefined;
    let operationError: unknown;
    try {
      result = await this.integrateInWorkspace(
        input,
        previousVersion,
        integrationWorkspace,
        declaredEntries,
      );
      if (replaying && result.status === "integrated") {
        result = {
          ...result,
          replayedFrom: input.changeSet.baseRevision,
          explanation:
            `${result.explanation}; replayed from ` +
            `${input.changeSet.baseRevision.slice(0, 12)} onto a canonical ` +
            "revision that changed nothing it depends on",
        };
      }
    } catch (error) {
      operationError = error;
    }

    let cleanupError: unknown;
    try {
      await this.workspaces.destroy(integrationWorkspace);
    } catch (error) {
      cleanupError = error;
    }

    if (operationError !== undefined) {
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [operationError, cleanupError],
          "Integration and integration-workspace cleanup both failed",
        );
      }
      throw operationError;
    }
    if (result === undefined) {
      throw new Error("Integration completed without an outcome");
    }
    if (cleanupError === undefined) {
      return result;
    }

    const warning = `Integration workspace cleanup failed: ${errorMessage(cleanupError)}`;
    return {
      ...result,
      cleanupWarnings: [...(result.cleanupWarnings ?? []), warning],
      explanation: `${result.explanation}; ${warning}`,
    };
  }

  private async integrateInWorkspace(
    input: IntegrateChangeSetInput,
    previousVersion: CanonicalVersion,
    integrationWorkspace: TaskWorkspace,
    declaredEntries: Array<{ path: string; status: FilePatchStatus }>,
  ): Promise<IntegrationResult> {
    const validation: CommandResult[] = [];
    const combinedPatch = input.changeSet.patches
      .map((filePatch) => filePatch.patch)
      .join("");
    // `--whitespace=nowarn` rather than `error-all`. Erroring on whitespace
    // rejected work that had nothing wrong with it: git counts a trailing
    // space as an error, so a Markdown hard line break — two trailing spaces,
    // the documented way to write one — failed the apply outright. That
    // arrived here as a conflict, and a conflict costs a full replan.
    //
    // Integration is not the place to hold an opinion about whitespace
    // anyway. The bytes reaching this point were already validated on the
    // worker, and a project that wants a whitespace rule has a validation
    // command to put it in, where the failure names the real reason.
    const applyResult = await this.repositories.getGitClient().run(
      [
        "-C",
        integrationWorkspace.path,
        "apply",
        "--index",
        "--3way",
        "--whitespace=nowarn",
        "-",
      ],
      {
        allowFailure: true,
        input: combinedPatch,
      },
    );

    if (applyResult.exitCode !== 0) {
      // Not every failed apply is a conflict, and the difference decides what
      // happens next: a conflict is genuine contention worth replanning
      // against, while a patch that cannot be applied at all is a defect in
      // the changeset that replanning will reproduce.
      //
      // The question is asked of the index rather than of the error text.
      // A three-way apply that truly conflicts leaves unmerged stages behind;
      // one that failed for any other reason leaves none. That is structural,
      // so it does not drift when git rewords a message.
      const unmerged = await this.repositories.getGitClient().run(
        [
          "-C",
          integrationWorkspace.path,
          "diff",
          "--name-only",
          "--diff-filter=U",
          "-z",
        ],
        { allowFailure: true },
      );
      const conflictedPaths =
        unmerged.exitCode === 0 ? parsePathListZ(unmerged.stdout) : [];
      const detail =
        applyResult.stderr.trim() || applyResult.stdout.trim() || "no detail";

      if (conflictedPaths.length === 0) {
        return {
          taskId: input.changeSet.taskId,
          changeSetId: input.changeSet.id,
          status: "policy_failed",
          previousVersion,
          canonicalVersion: previousVersion,
          validation,
          explanation:
            "The changeset could not be applied, and not because it " +
            `conflicts: ${detail}`,
        };
      }

      return {
        taskId: input.changeSet.taskId,
        changeSetId: input.changeSet.id,
        status: "conflict",
        previousVersion,
        canonicalVersion: previousVersion,
        validation,
        explanation:
          `The changeset conflicts with current canonical in ` +
          `${conflictedPaths.join(", ")}: ${detail}`,
      };
    }

    const appliedNames = await this.repositories.getGitClient().run([
      "-C",
      integrationWorkspace.path,
      "diff",
      "--cached",
      "--name-status",
      "-z",
      "--no-renames",
      previousVersion.revision,
      "--",
    ]);
    const appliedEntries = parseNameStatusZ(appliedNames.stdout)
      .map((entry) => ({ path: entry.path, status: patchStatus(entry.code) }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const expectedEntries = [...declaredEntries].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    if (
      appliedEntries.length !== expectedEntries.length ||
      appliedEntries.some(
        (entry, index) =>
          entry.path !== expectedEntries[index]?.path ||
          entry.status !== expectedEntries[index]?.status,
      )
    ) {
      return {
        taskId: input.changeSet.taskId,
        changeSetId: input.changeSet.id,
        status: "policy_failed",
        previousVersion,
        canonicalVersion: previousVersion,
        validation,
        explanation:
          "Patch contents or statuses do not match the changeset declaration",
      };
    }

    const candidateTree = (
      await this.repositories.getGitClient().run([
        "-C",
        integrationWorkspace.path,
        "write-tree",
      ])
    ).stdout.trim();

    for (const command of input.validationCommands) {
      const startedAt = new Date().toISOString();
      const output = await this.workspaces.runInWorkspace(
        integrationWorkspace,
        {
          command: command.executable,
          args: command.args,
        },
        {
          timeoutMs: this.options.validationTimeoutMs ?? 10 * 60 * 1000,
          maxOutputBytes:
            this.options.maxValidationOutputBytes ?? 1024 * 1024,
        },
      );
      const commandResult: CommandResult = {
        command,
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        startedAt,
        durationMs: output.durationMs,
      };
      validation.push(commandResult);

      if (commandResult.exitCode !== 0) {
        return {
          taskId: input.changeSet.taskId,
          changeSetId: input.changeSet.id,
          status: "validation_failed",
          previousVersion,
          canonicalVersion: previousVersion,
          validation,
          explanation:
            `Validation failed: ${command.label}` +
            (output.timedOut === true ? " (timed out)" : ""),
        };
      }
    }

    // Validation is evidence, not an additional editor. Generated dependency,
    // build, and coverage output may remain untracked, but source, index, and
    // history must still exactly match the candidate.
    const [validatedTree, validatedHead, workingChanges, untrackedFiles] =
      await Promise.all([
      this.repositories.getGitClient().run([
        "-C",
        integrationWorkspace.path,
        "write-tree",
      ]),
      this.repositories.getGitClient().run([
        "-C",
        integrationWorkspace.path,
        "rev-parse",
        "HEAD",
      ]),
      this.repositories.getGitClient().run([
        "-C",
        integrationWorkspace.path,
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--",
      ]),
      this.repositories.getGitClient().run([
        "-C",
        integrationWorkspace.path,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]),
    ]);
    const unexpectedUntracked = parsePathListZ(untrackedFiles.stdout).filter(
      (repositoryPath) => !isEphemeralWorkspacePath(repositoryPath),
    );
    if (
      validatedTree.stdout.trim() !== candidateTree ||
      validatedHead.stdout.trim() !== previousVersion.revision ||
      parsePathListZ(workingChanges.stdout).length > 0 ||
      unexpectedUntracked.length > 0
    ) {
      return {
        taskId: input.changeSet.taskId,
        changeSetId: input.changeSet.id,
        status: "policy_failed",
        previousVersion,
        canonicalVersion: previousVersion,
        validation,
        explanation:
          "A validation command modified repository content or history",
      };
    }

    const candidateRevision = await this.repositories.commitIndex(
      integrationWorkspace.path,
      input.commitMessage,
    );
    if (candidateRevision === undefined) {
      return {
        taskId: input.changeSet.taskId,
        changeSetId: input.changeSet.id,
        status: "empty",
        previousVersion,
        canonicalVersion: previousVersion,
        validation,
        explanation: "The applied changeset did not change canonical content",
      };
    }

    const promoted = await this.repositories.promote(
      input.repository,
      candidateRevision,
      previousVersion.revision,
    );
    if (!promoted) {
      const currentVersion = await this.repositories.getCanonicalVersion(
        input.repository,
      );
      return {
        taskId: input.changeSet.taskId,
        changeSetId: input.changeSet.id,
        status: "stale",
        previousVersion,
        canonicalVersion: currentVersion,
        validation,
        candidateRevision,
        explanation:
          "Canonical state changed during validation; the candidate was not promoted",
      };
    }

    const canonicalVersion = await this.repositories.getCanonicalVersion(
      input.repository,
    );
    return {
      taskId: input.changeSet.taskId,
      changeSetId: input.changeSet.id,
      status: "integrated",
      previousVersion,
      canonicalVersion,
      validation,
      candidateRevision,
      explanation: `Promoted ${candidateRevision.slice(0, 12)} atomically`,
    };
  }
}
