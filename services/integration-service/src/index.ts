import {
  normalizeRepositoryPath,
  type ChangeSet,
  type CommandResult,
  type IntegrationResult,
  type ValidationCommand,
} from "@coord/shared-types";
import {
  RepositoryService,
  runProcess,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  GitWorktreeWorkspaceManager,
  type WorkspaceManager,
} from "@coord/workspace-manager";

export interface IntegrateChangeSetInput {
  repository: CanonicalRepository;
  integrationRoot: string;
  changeSet: ChangeSet;
  validationCommands: ValidationCommand[];
  commitMessage: string;
}

export class IntegrationService {
  public constructor(
    private readonly repositories = new RepositoryService(),
    private readonly workspaces: WorkspaceManager =
      new GitWorktreeWorkspaceManager(repositories.getGitClient()),
  ) {}

  public async integrate(
    input: IntegrateChangeSetInput,
  ): Promise<IntegrationResult> {
    const previousVersion = await this.repositories.getCanonicalVersion(
      input.repository,
    );

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

    for (const filePatch of input.changeSet.patches) {
      normalizeRepositoryPath(filePatch.path);
    }

    const integrationWorkspace = await this.workspaces.create({
      taskId: `integration-${input.changeSet.taskId}`,
      rootPath: input.integrationRoot,
      repository: input.repository,
      baseVersion: previousVersion,
    });

    const validation: CommandResult[] = [];

    try {
      const combinedPatch = input.changeSet.patches
        .map((filePatch) => filePatch.patch)
        .join("");
      const applyResult = await this.repositories.getGitClient().run(
        [
          "-C",
          integrationWorkspace.path,
          "apply",
          "--index",
          "--3way",
          "--whitespace=error-all",
          "-",
        ],
        {
          allowFailure: true,
          input: combinedPatch,
        },
      );

      if (applyResult.exitCode !== 0) {
        return {
          taskId: input.changeSet.taskId,
          changeSetId: input.changeSet.id,
          status: "conflict",
          previousVersion,
          canonicalVersion: previousVersion,
          validation,
          explanation:
            applyResult.stderr.trim() ||
            "The changeset could not be replayed on the latest canonical revision",
        };
      }

      for (const command of input.validationCommands) {
        const startedAt = new Date().toISOString();
        const output = await runProcess(command.executable, command.args, {
          cwd: integrationWorkspace.path,
        });
        const result: CommandResult = {
          command,
          exitCode: output.exitCode,
          stdout: output.stdout,
          stderr: output.stderr,
          startedAt,
          durationMs: output.durationMs,
        };
        validation.push(result);

        if (result.exitCode !== 0) {
          return {
            taskId: input.changeSet.taskId,
            changeSetId: input.changeSet.id,
            status: "validation_failed",
            previousVersion,
            canonicalVersion: previousVersion,
            validation,
            explanation: `Validation failed: ${command.label}`,
          };
        }
      }

      const candidateRevision = await this.repositories.commitAll(
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
    } finally {
      await this.workspaces.destroy(integrationWorkspace);
    }
  }
}

