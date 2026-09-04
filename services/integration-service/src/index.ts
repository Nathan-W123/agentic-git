import {
  normalizeRepositoryPath,
  type CanonicalVersion,
  type ChangeSet,
  type CommandResult,
  type FilePatch,
  type FilePatchStatus,
  type GraderEditReport,
  type IntegrationResult,
  type ValidationBaseline,
  type ValidationCommand,
  type ValidationEvidence,
} from "@coord/shared-types";
import {
  emitPatch,
  parseUnifiedPatch,
  RepositoryService,
  type CanonicalRepository,
  type CommitIdentity,
  type CommitTrailer,
  type ParsedHunk,
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
  /**
   * Who wrote the change, recorded as the commit's author.
   *
   * Without this every canonical commit is authored by the coordinator, and
   * `git blame` on a repository full of agent-written code can say only that
   * a machine did it. The coordinator stays the committer either way.
   */
  author?: CommitIdentity;
  /**
   * Extra provenance for the commit's trailer block, for facts integration
   * cannot know on its own — which agent and model ran, who approved it,
   * whether the changeset was admitted only in part.
   *
   * Integration adds what it does know (task, changeset, base revision,
   * validation, replay) without being told.
   */
  trailers?: readonly CommitTrailer[];
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
  /**
   * Keep the parts of a conflicting changeset that still apply.
   *
   * Off by default, and deliberately so: salvage promotes a subset of what
   * the agent produced and hands the remainder back in
   * {@link IntegrationResult.salvagedDeferred}. A caller that ignored that
   * would silently lose the difference, which is worse than the whole
   * changeset being refused. Only callers that requeue the remainder may ask
   * for it.
   */
  salvageConflicts?: boolean;
}

export interface IntegrationServiceOptions {
  validationTimeoutMs?: number;
  maxValidationOutputBytes?: number;
  /**
   * Where the before-run results are remembered between tasks.
   *
   * Shared deliberately: two integrations of the same repository at the same
   * revision should not each pay for the same baseline. Injectable so a test
   * can watch what was reused.
   */
  baselines?: ValidationBaselineCache;
  /**
   * Skip the before-run entirely.
   *
   * For a caller that knows it does not want the comparison and would rather
   * have the wall clock — a rollback, an overlay preview. The result then
   * carries no `baseline` and its evidence tops out at `executed`, which is
   * the honest reading of one measurement.
   */
  skipBaseline?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Paths that grade a change rather than being graded by it.
 *
 * Tests, fixtures, and the files that decide what the validators are. An
 * agent editing these is not necessarily cheating — the task may be to change
 * behaviour, and the test may encode the old contract — but "passes the tests
 * as they were" and "passes the tests it rewrote" are different claims, and
 * only one of them is evidence.
 *
 * Deliberately generous about what counts. A false positive costs one extra
 * validation run and a line in the history; a false negative is the case this
 * exists to catch.
 */
const GRADER_PATH = new RegExp(
  [
    "(?:^|/)(?:tests?|__tests__|spec|specs|e2e|fixtures?|testdata)(?:/|$)",
    "\\.(?:test|spec)\\.[A-Za-z0-9]+$",
    "(?:^|/)conftest\\.py$",
    "(?:^|/)(?:jest|vitest|karma|playwright|cypress|pytest|tox|phpunit)\\.[A-Za-z0-9.]*(?:config|ini|xml)?[A-Za-z0-9.]*$",
    "(?:^|/)\\.coordinator/config\\.json$",
    "(?:^|/)(?:Makefile|justfile)$",
    "(?:^|/)\\.github/workflows/",
  ].join("|"),
  "u",
);

export function isGraderPath(filePath: string): boolean {
  return GRADER_PATH.test(normalizeRepositoryPath(filePath));
}

/** What survived a salvage pass, and what is being handed back. */
interface SalvageOutcome {
  /** Patches to apply, some of them a file's clean hunks rather than a file. */
  granted: FilePatch[];
  /** Patches that genuinely collided. The caller requeues these. */
  deferred: FilePatch[];
  /** Files that landed only in part. */
  divided: string[];
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

/**
 * How strong the evidence is, given what ran and what the baseline showed.
 *
 * Deliberately computed from the commands themselves rather than from their
 * exit codes: a suite that passes tells you nothing extra about *this* change
 * unless something it was failing now passes.
 */
export function validationEvidence(
  commands: readonly ValidationCommand[],
  baseline: ValidationBaseline | undefined,
): ValidationEvidence {
  if (commands.length === 0) {
    return "none";
  }
  if (commands.every((command) => command.proves === "integrity")) {
    return "integrity";
  }
  return baseline !== undefined && baseline.nowPassing.length > 0
    ? "demonstrated"
    : "executed";
}

/** A stable identity for a set of commands, so a baseline is not reused across a config change. */
export function validationFingerprint(
  commands: readonly ValidationCommand[],
): string {
  return JSON.stringify(
    commands.map((command) => [command.executable, command.args, command.label]),
  );
}

/**
 * Remembers a revision's validation results so the next task does not re-run them.
 *
 * The observation that makes the second run affordable: when a change passes
 * validation and promotes, canonical *is* the tree those commands ran on. So
 * the after-run of one task is the before-run of the next, and only the first
 * task at a revision pays.
 *
 * Deliberately small and in-memory. A miss costs one honest run, which is the
 * behaviour without a cache at all, so there is nothing here worth persisting
 * or worth being wrong about across a restart.
 */
export class ValidationBaselineCache {
  private readonly entries = new Map<string, CommandResult[]>();

  public constructor(private readonly limit = 64) {}

  private static key(
    repositoryId: string,
    revision: string,
    commands: readonly ValidationCommand[],
  ): string {
    return `${repositoryId}\u0000${revision}\u0000${validationFingerprint(commands)}`;
  }

  public get(
    repositoryId: string,
    revision: string,
    commands: readonly ValidationCommand[],
  ): CommandResult[] | undefined {
    return this.entries.get(
      ValidationBaselineCache.key(repositoryId, revision, commands),
    );
  }

  public set(
    repositoryId: string,
    revision: string,
    commands: readonly ValidationCommand[],
    results: readonly CommandResult[],
  ): void {
    const key = ValidationBaselineCache.key(repositoryId, revision, commands);
    // Oldest out first, and re-inserting refreshes position — a revision being
    // actively worked on is exactly the one worth keeping.
    this.entries.delete(key);
    this.entries.set(key, [...results]);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }
}

export class IntegrationService {
  private readonly baselines: ValidationBaselineCache;

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
    this.baselines = options.baselines ?? new ValidationBaselineCache();
  }

  /** One validation command in a workspace, as a recorded result. */
  private async runValidationCommand(
    workspace: TaskWorkspace,
    command: ValidationCommand,
  ): Promise<CommandResult & { timedOut?: boolean }> {
    const startedAt = new Date().toISOString();
    const output = await this.workspaces.runInWorkspace(
      workspace,
      { command: command.executable, args: command.args },
      {
        timeoutMs: this.options.validationTimeoutMs ?? 10 * 60 * 1000,
        maxOutputBytes: this.options.maxValidationOutputBytes ?? 1024 * 1024,
      },
    );
    return {
      command,
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
      startedAt,
      durationMs: output.durationMs,
      ...(output.timedOut === true ? { timedOut: true } : {}),
    };
  }

  /**
   * The same commands at canonical, before the patch goes in.
   *
   * Reused from the cache where the last task at this revision already ran
   * them, which is the ordinary case in a busy repository: a promotion means
   * canonical *is* the tree those commands passed on.
   */
  private async collectBaseline(
    workspace: TaskWorkspace,
    repositoryId: string,
    revision: string,
    commands: readonly ValidationCommand[],
  ): Promise<ValidationBaseline | undefined> {
    if (this.options.skipBaseline === true || commands.length === 0) {
      return undefined;
    }
    const cached = this.baselines.get(repositoryId, revision, commands);
    if (cached !== undefined) {
      return {
        revision,
        cached: true,
        results: cached,
        nowPassing: [],
        alreadyFailing: [],
      };
    }
    const results: CommandResult[] = [];
    for (const command of commands) {
      // Every command runs, including ones that fail. A red baseline is the
      // point: it is what stops the next failure being blamed on the change.
      results.push(await this.runValidationCommand(workspace, command));
    }
    // Put the tree back before the patch goes anywhere near it.
    //
    // Validation commands are not guaranteed to be read-only — the tamper
    // check further down exists precisely because they are not — and this run
    // happens *before* the apply rather than after. Without the restore, a
    // command that touches a tracked file leaves the worktree disagreeing with
    // the index and the changeset fails to apply against a tree nobody
    // changed on purpose. Tracked files only: build output and installed
    // dependencies are untracked, and throwing those away would make the
    // second run pay for the first run's setup all over again.
    await this.repositories
      .getGitClient()
      .run(["-C", workspace.path, "reset", "--hard", revision]);
    this.baselines.set(repositoryId, revision, commands, results);
    return {
      revision,
      cached: false,
      results,
      nowPassing: [],
      alreadyFailing: [],
    };
  }

  /**
   * Re-runs validation with the change's own edits to its graders set aside.
   *
   * The tree is restored afterwards, and the restore is checked: this runs
   * between the applied tree and the commit, so leaving a grader at canonical
   * would promote the wrong bytes. A restore that cannot be verified reports
   * no verdict rather than a reassuring one.
   */
  private async gradeWithoutEdits(
    workspace: TaskWorkspace,
    previousVersion: CanonicalVersion,
    graderPaths: readonly string[],
    commands: readonly ValidationCommand[],
  ): Promise<GraderEditReport> {
    const git = this.repositories.getGitClient();
    const applied = (
      await git.run(["-C", workspace.path, "write-tree"])
    ).stdout.trim();
    try {
      // `restore --worktree`, deliberately, not `checkout`. Checkout writes
      // the index as well, which would replace the candidate the commit below
      // is made from — the graders would land at canonical and the promoted
      // tree would not be the one that was validated. Restoring the worktree
      // alone leaves the index holding the candidate throughout.
      await git.run([
        "-C",
        workspace.path,
        "restore",
        "--worktree",
        "--source",
        previousVersion.revision,
        "--",
        ...graderPaths,
      ]);
    } catch {
      // A grader the change *added* does not exist at canonical, so there is
      // nothing to restore it to and nothing to compare against. Saying so is
      // the answer; guessing is not.
      return { paths: [...graderPaths], passesOnlyWithEdits: false };
    }
    const withoutEdits: CommandResult[] = [];
    let allPassed = true;
    for (const command of commands) {
      const result = await this.runValidationCommand(workspace, command);
      withoutEdits.push(result);
      if (result.exitCode !== 0) {
        allPassed = false;
        break;
      }
    }
    // Put the candidate back in the worktree, from the index, which never
    // moved. Only the graders were disturbed, so only they are restored.
    await git.run([
      "-C",
      workspace.path,
      "checkout-index",
      "-f",
      "--",
      ...graderPaths,
    ]);
    const restored = (
      await git.run(["-C", workspace.path, "write-tree"])
    ).stdout.trim();
    if (restored !== applied) {
      throw new Error(
        "Could not restore the changeset after grading it without its " +
          "grader edits; refusing to promote a tree that may not be the " +
          "one that was validated",
      );
    }
    return {
      paths: [...graderPaths],
      withoutEdits,
      passesOnlyWithEdits: !allPassed,
    };
  }

  /** Records a passing run so the next task at this revision reuses it. */
  public rememberValidation(
    repositoryId: string,
    revision: string,
    commands: readonly ValidationCommand[],
    results: readonly CommandResult[],
  ): void {
    this.baselines.set(repositoryId, revision, commands, results);
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
        replaying,
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

  /**
   * Returns the workspace to the revision it was built at.
   *
   * A failed three-way apply leaves conflict markers, unmerged index stages,
   * and any file it managed to create before giving up. Every trial below has
   * to start from the same pristine tree or its answer means nothing, and
   * `clean` is safe here specifically because nothing has run yet — validation
   * comes later, so there is no build output to lose.
   */
  private async resetWorkspace(
    workspacePath: string,
    revision: string,
  ): Promise<void> {
    // No `--end-of-options` here, and that is a fact about the deployment
    // rather than a lapse. The container's git (Debian bookworm, 2.39)
    // rejects the terminator on `reset` — "option '--end-of-options' must
    // come before non-option arguments" — while the 2.5x a laptop carries
    // accepts it, so the invocation that passed every local test failed
    // every salvage in production. The terminator was guarding against a
    // revision that reads as an option, and the guard below is the same
    // protection in a form both gits accept: these revisions come from our
    // own store, and anything that is not a bare commit hash has no business
    // reaching a `reset --hard`.
    if (!/^[0-9a-f]{4,64}$/iu.test(revision)) {
      throw new Error(
        `Refusing to reset to a revision that is not a commit hash: ${revision}`,
      );
    }
    const git = this.repositories.getGitClient();
    await git.run(["-C", workspacePath, "reset", "--hard", "--quiet", revision]);
    await git.run(["-C", workspacePath, "clean", "-fdq"]);
  }

  /** Whether a patch applies to a pristine workspace. Leaves it pristine. */
  private async appliesCleanly(
    workspacePath: string,
    revision: string,
    patchText: string,
  ): Promise<boolean> {
    const result = await this.repositories.getGitClient().run(
      [
        "-C",
        workspacePath,
        "apply",
        "--index",
        "--3way",
        "--whitespace=nowarn",
        "-",
      ],
      { allowFailure: true, input: patchText },
    );
    // `--check` cannot be used for this: combined with `--3way` git applies
    // the patch anyway and reports success, so the only honest trial is to
    // apply it for real and undo it.
    await this.resetWorkspace(workspacePath, revision);
    return result.exitCode === 0;
  }

  /**
   * Sorts a conflicting changeset into what still applies and what does not.
   *
   * Whole files are tried first, because most changesets touch several files
   * and only one of them is contested — keeping the other nine is most of the
   * value for one trial each. A file that fails is then tried a hunk at a
   * time, so a single bad hunk costs its own lines rather than the file's.
   *
   * Hunks are re-emitted from one parse rather than concatenated: a hunk's
   * new-side line numbers depend on which of its siblings survived, and
   * pasting single-hunk patches together would produce a patch that applies
   * in the wrong place.
   */
  private async salvage(
    workspacePath: string,
    revision: string,
    patches: readonly FilePatch[],
  ): Promise<SalvageOutcome> {
    const granted: FilePatch[] = [];
    const deferred: FilePatch[] = [];
    const divided: string[] = [];

    await this.resetWorkspace(workspacePath, revision);

    for (const filePatch of patches) {
      if (
        await this.appliesCleanly(workspacePath, revision, filePatch.patch)
      ) {
        granted.push(filePatch);
        continue;
      }

      const parsed = parseUnifiedPatch(filePatch.patch);
      if (parsed === undefined || parsed.hunks.length < 2) {
        // Indivisible, or a single hunk that already failed on its own.
        deferred.push(filePatch);
        continue;
      }

      const keep: ParsedHunk[] = [];
      const hold: ParsedHunk[] = [];
      for (const hunk of parsed.hunks) {
        const single = emitPatch(parsed, [hunk]);
        if (await this.appliesCleanly(workspacePath, revision, single)) {
          keep.push(hunk);
        } else {
          hold.push(hunk);
        }
      }
      if (keep.length === 0 || hold.length === 0) {
        // Nothing survived, or everything did while the file as a whole still
        // failed — which means the hunks interact rather than collide with
        // canonical. Dividing there would emit a deferred patch carrying no
        // hunks and claim a split that did not happen, so the file is handed
        // back whole and the combined re-apply is left to decide.
        deferred.push(filePatch);
        continue;
      }

      granted.push({ ...filePatch, patch: emitPatch(parsed, keep) });
      deferred.push({ ...filePatch, patch: emitPatch(parsed, hold) });
      divided.push(filePatch.path);
    }

    return { granted, deferred, divided };
  }

  private async integrateInWorkspace(
    input: IntegrateChangeSetInput,
    previousVersion: CanonicalVersion,
    integrationWorkspace: TaskWorkspace,
    declaredEntries: Array<{ path: string; status: FilePatchStatus }>,
    replaying: boolean,
  ): Promise<IntegrationResult> {
    const validation: CommandResult[] = [];
    // Taken here, before the patch goes in, because the workspace is at
    // canonical for exactly this window and never will be again. Everything
    // the two-sided comparison can say depends on measuring first.
    const baseline = await this.collectBaseline(
      integrationWorkspace,
      input.repository.id,
      previousVersion.revision,
      input.validationCommands,
    );
    // What integration is actually promoting. These start as everything the
    // changeset declared and narrow only if a conflict is salvaged, in which
    // case the tree must match what survived rather than what was submitted.
    let effectiveEntries = declaredEntries;
    let salvage: SalvageOutcome | undefined;
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

      const refused: IntegrationResult = {
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
      if (input.salvageConflicts !== true) {
        return refused;
      }

      // A conflict in one file used to discard every clean file beside it and
      // buy a replan to rediscover work that was already done. Sort out what
      // still applies and promote that; the caller requeues the rest.
      salvage = await this.salvage(
        integrationWorkspace.path,
        previousVersion.revision,
        input.changeSet.patches,
      );
      if (salvage.granted.length === 0) {
        return refused;
      }

      const salvagedPatch = salvage.granted
        .map((filePatch) => filePatch.patch)
        .join("");
      const reapplied = await this.repositories.getGitClient().run(
        [
          "-C",
          integrationWorkspace.path,
          "apply",
          "--index",
          "--3way",
          "--whitespace=nowarn",
          "-",
        ],
        { allowFailure: true, input: salvagedPatch },
      );
      if (reapplied.exitCode !== 0) {
        // Each piece applied on its own, so a failure here means they
        // interact. Nothing is lost by falling back to the original answer,
        // and guessing further would be guessing.
        await this.resetWorkspace(
          integrationWorkspace.path,
          previousVersion.revision,
        );
        return refused;
      }
      effectiveEntries = salvage.granted.map((filePatch) => ({
        path: normalizeRepositoryPath(filePatch.path),
        status: filePatch.status,
      }));
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
    const expectedEntries = [...effectiveEntries].sort((left, right) =>
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
      const commandResult = await this.runValidationCommand(
        integrationWorkspace,
        command,
      );
      validation.push(commandResult);

      if (commandResult.exitCode !== 0) {
        // Before blaming the change, ask whether this was already failing.
        // Reported either way — a regression and a pre-existing red are both
        // reasons this cannot land — but only one of them is this task's
        // doing, and they were indistinguishable.
        const alreadyRed =
          baseline?.results.some(
            (entry) =>
              entry.command.label === command.label && entry.exitCode !== 0,
          ) === true;
        return {
          taskId: input.changeSet.taskId,
          changeSetId: input.changeSet.id,
          status: "validation_failed",
          previousVersion,
          canonicalVersion: previousVersion,
          validation,
          ...(baseline === undefined ? {} : { baseline }),
          evidence: validationEvidence(input.validationCommands, baseline),
          explanation:
            `Validation failed: ${command.label}` +
            (commandResult.timedOut === true ? " (timed out)" : "") +
            (alreadyRed
              ? " (already failing before this change)"
              : ""),
        };
      }
    }

    // The comparison the second run bought. A command that was red at
    // canonical and is green here is the only evidence integration can produce
    // on its own that the change did the thing it was asked to do, rather than
    // merely not breaking anything.
    if (baseline !== undefined) {
      for (const before of baseline.results) {
        if (before.exitCode === 0) {
          continue;
        }
        const after = validation.find(
          (entry) => entry.command.label === before.command.label,
        );
        if (after !== undefined && after.exitCode === 0) {
          baseline.nowPassing.push(before.command.label);
        } else {
          baseline.alreadyFailing.push(before.command.label);
        }
      }
    }

    const evidence = validationEvidence(input.validationCommands, baseline);

    // Did this change edit the things that judge it, and does it still pass
    // without those edits?
    //
    // Not a refusal. A task whose whole point is to change behaviour has to
    // move the tests that encode the old behaviour, and banning that would
    // ban the work. What was missing is the distinction: a result that passes
    // only because the agent rewrote its grader is a different claim from one
    // that passes the grader as it stood, and both were recorded identically.
    const graderPaths = appliedEntries
      .filter((entry) => isGraderPath(entry.path))
      .map((entry) => entry.path);
    let graderEdits: GraderEditReport | undefined;
    if (graderPaths.length > 0 && input.validationCommands.length > 0) {
      graderEdits = await this.gradeWithoutEdits(
        integrationWorkspace,
        previousVersion,
        graderPaths,
        input.validationCommands,
      );
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

    // Everything a reader of the repository alone would otherwise have to ask
    // the coordinator's database for. The parent commit is already git's
    // record of what this was integrated onto; `Base-Revision` is the
    // different question of what the agent actually wrote against, and on a
    // replay the two disagree — which is what `Replayed-From` marks.
    const trailers: CommitTrailer[] = [
      { key: "Task-Id", value: input.changeSet.taskId },
      { key: "Change-Set-Id", value: input.changeSet.id },
      ...(input.trailers ?? []),
      { key: "Base-Revision", value: input.changeSet.baseRevision },
      ...(replaying
        ? [{ key: "Replayed-From", value: input.changeSet.baseRevision }]
        : []),
      // A reader comparing this commit against the task would otherwise find
      // it short, with nothing to say why.
      ...(salvage === undefined
        ? []
        : [
            {
              key: "Salvaged-From-Conflict",
              value:
                `${salvage.granted.length} of ` +
                `${input.changeSet.patches.length} file(s) applied; ` +
                `conflicted: ${salvage.deferred
                  .map((filePatch) => filePatch.path)
                  .join(" ")}` +
                (salvage.divided.length === 0
                  ? ""
                  : `; split at the hunk: ${salvage.divided.join(" ")}`),
            },
          ]),
      {
        key: "Validation",
        value:
          validation.length === 0
            ? "none"
            : validation
                .map(
                  (entry) => `${entry.command.label}(exit ${entry.exitCode})`,
                )
                .join(", "),
      },
      // What that run established, beside what it was. A reader of the history
      // could previously see "Validation: patch integrity(exit 0)" and had no
      // way to know it meant the program was never executed.
      { key: "Validation-Evidence", value: evidence },
      ...(baseline === undefined || baseline.nowPassing.length === 0
        ? []
        : [
            {
              key: "Now-Passing",
              value: baseline.nowPassing.join(", "),
            },
          ]),
      ...(baseline === undefined || baseline.alreadyFailing.length === 0
        ? []
        : [
            {
              key: "Already-Failing",
              value: baseline.alreadyFailing.join(", "),
            },
          ]),
      ...(graderEdits === undefined
        ? []
        : [
            {
              key: "Grader-Edits",
              value:
                `${graderEdits.paths.join(" ")}` +
                (graderEdits.passesOnlyWithEdits
                  ? " (validation passes only with these edits)"
                  : ""),
            },
          ]),
    ];

    const candidateRevision = await this.repositories.commitIndex(
      integrationWorkspace.path,
      input.commitMessage,
      {
        ...(input.author === undefined ? {} : { author: input.author }),
        trailers,
      },
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
      evidence,
      ...(baseline === undefined ? {} : { baseline }),
      ...(graderEdits === undefined ? {} : { graderEdits }),
      ...(salvage === undefined
        ? {}
        : {
            salvagedDeferred: salvage.deferred,
            salvagedDividedFiles: salvage.divided,
          }),
      explanation:
        `Promoted ${candidateRevision.slice(0, 12)} atomically` +
        (salvage === undefined
          ? ""
          : `; salvaged ${salvage.granted.length} of ` +
            `${input.changeSet.patches.length} file(s) from a conflict, ` +
            `${salvage.deferred.length} requeued`),
    };
  }
}
