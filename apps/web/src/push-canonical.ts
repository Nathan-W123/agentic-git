import { repoPush, repoSync } from "@coord/cli/repo-export";
import type { CoordinatorProject } from "@coord/cli/project";
import { createLocalSummariser } from "@coord/local-triage";
import type { CoordinationStore } from "@coord/persistence";
import {
  PUSH_BRANCH_NAME_TIMEOUT_MS,
  UpstreamChangedError,
  type PushBranchNamer,
  type RepositoryService,
} from "@coord/repository-service";
import { describeError } from "@coord/shared-types";

import type { GitHubConnectionService } from "./github-connection.js";

export interface PushCanonicalResult {
  outcome: "done" | "refused";
  detail?: { url?: string; output?: string[] };
  explanation: string;
}

/** Held across pushes so the second one does not load the model again. */
let branchNamer: PushBranchNamer | undefined;

/**
 * The local model that names the pushed branch, or nothing.
 *
 * The same model, the same switch and the same bargain as the catch-up
 * popup's sentences: a small model on this machine, no network, no vendor
 * bill, and `COORD_LOCAL_TRIAGE=0` turns it off — a deployment that has said
 * no to local models should not quietly acquire one here either. Switched
 * off, or failing for any of the reasons it can, the branch keeps the
 * deterministic name built from the commit subjects.
 *
 * Built once and kept: the model loads on first use, and a push that had to
 * load it again every time would spend the wait for nothing.
 */
export function defaultPushBranchNamer(): PushBranchNamer | undefined {
  const raw = process.env["COORD_LOCAL_TRIAGE"]?.trim().toLowerCase() ?? "";
  if (["0", "false", "off", "no"].includes(raw)) {
    return undefined;
  }
  if (branchNamer === undefined) {
    const local = createLocalSummariser({
      budgetMs: PUSH_BRANCH_NAME_TIMEOUT_MS,
    });
    // A branch name is a handful of words; letting it run to the summariser's
    // default length only gives a small model room to explain itself.
    branchNamer = async (prompt) => await local.write(prompt, 16);
  }
  return branchNamer;
}

async function pushCanonicalAs(
  project: CoordinatorProject,
  store: CoordinationStore,
  github: GitHubConnectionService,
  input: { repositoryId: string; actorId: string; excludeTaskId?: string },
  repositories?: RepositoryService,
): Promise<PushCanonicalResult> {
  const connection = await github.tokenFor(input.actorId);
  if (connection === undefined) {
    return {
      outcome: "refused",
      explanation:
        "You haven't connected GitHub, so there is no account to push as. " +
        "Connect GitHub in Settings and ask again — the push will run as " +
        "you and reach only what your token can. Nothing was pushed.",
    };
  }
  const credentials = { token: connection.token };
  // Presentation only, and optional: the branch is named by the local model
  // when this deployment runs one, and by the commit subjects when it does not.
  const namer = defaultPushBranchNamer();
  let operation: "sync" | "push" = "sync";
  try {
    const sync = async () =>
      await repoSync(
        project,
        store,
        {
          repositoryId: input.repositoryId,
          actorId: input.actorId,
          credentials,
          ...(input.excludeTaskId === undefined
            ? {}
            : { excludeTaskId: input.excludeTaskId }),
        },
        repositories,
      );
    const push = async () =>
      await repoPush(
        project,
        store,
        {
          repositoryId: input.repositoryId,
          credentials,
          ...(namer === undefined ? {} : { branchNamer: namer }),
        },
        repositories,
      );

    await sync();
    operation = "push";
    let pushed: Awaited<ReturnType<typeof push>>;
    try {
      pushed = await push();
    } catch (error) {
      // GitHub can advance after the sync but before pushToRemote checks its
      // upstream baseline. Pull that race into canonical and retry once; all
      // other failures remain refusals, and the retry keeps repoPush's fresh
      // branch and no-force defaults.
      if (!(error instanceof UpstreamChangedError)) {
        throw error;
      }
      operation = "sync";
      await sync();
      operation = "push";
      pushed = await push();
    }
    // One line, and only the two things the person who typed `/push` was
    // waiting to hear: where it landed and whose account it went as. The
    // revision, the remote URL and the objective summary were all already on
    // screen in the channel; repeating them turned the confirmation into a
    // paragraph nobody read to the end of.
    return {
      outcome: "done",
      detail: { url: pushed.remoteUrl },
      explanation:
        `Pushed to ${pushed.targetBranch}` +
        (connection.login === undefined ? "" : ` as ${connection.login}`) +
        ".",
    };
  } catch (error) {
    const explanation = describeError(error);
    if (/authentication failed|error: 40[13]\b|returned error: 40[13]\b/iu.test(explanation)) {
      // Stored and usable are different things: a token GitHub has just
      // refused should stop looking connected in Settings, and the refusal
      // should say whose token failed rather than only that the operation did.
      await github
        .noteAuthFailure(
          input.actorId,
          `GitHub refused this token during a ${operation}`,
        )
        .catch(() => undefined);
      return {
        outcome: "refused",
        explanation:
          "GitHub refused your stored token, so nothing was pushed. It may " +
          "have expired or lost access to this repository — reconnect " +
          "GitHub in Settings.",
      };
    }
    return {
      outcome: "refused",
      explanation:
        operation === "sync"
          ? `The GitHub sync did not go through, so nothing was pushed: ${explanation}`
          : `The push did not go through: ${explanation}`,
    };
  }
}

/**
 * Publishes canonical immediately for the authenticated person who asked.
 *
 * Unlike {@link pushCanonical}, this path has no task to resolve: the channel
 * already authenticated the sender and passes that identity directly. It
 * synchronizes canonical before publishing and retries once if GitHub moves
 * in between. It is the implementation behind `/push`, which is a repository
 * operation rather than agent work and therefore never needs a plan or a
 * workspace.
 */
export async function pushCanonicalForActor(
  project: CoordinatorProject,
  store: CoordinationStore,
  github: GitHubConnectionService,
  request: { repositoryId: string; actorId: string },
  repositories?: RepositoryService,
): Promise<PushCanonicalResult> {
  const stored = await store.getRepository(request.repositoryId);
  if ((stored?.remoteUrl ?? "").length === 0) {
    return {
      outcome: "refused",
      explanation:
        `${request.repositoryId} has no remote recorded, so there is ` +
        "nowhere to push it. Connect it to a GitHub repository first.",
    };
  }
  return await pushCanonicalAs(project, store, github, request, repositories);
}

/**
 * Publishes canonical to the repository's recorded remote, as an agent action.
 *
 * Pushes to a *new* branch by default and refuses to update one that already
 * exists — `allowExistingTarget` stays off. An agent asking to publish is
 * asking to put work somewhere a person will look at it, which a branch does;
 * overwriting a branch somebody else is using is a different act, and not one
 * to grant on the strength of a sentence in an objective. Canonical is synced
 * before publishing; if upstream moves again before the first push, it is
 * synced and retried once rather than force-pushed.
 *
 * The credential is the *submitter's own* stored GitHub connection — the same
 * rule that decides whose account pays for the agent run decides whose
 * account publishes its result. There is deliberately no deployment-wide
 * fallback: a shared token would let any user's task push anywhere the token
 * reached, under the token owner's name, and refusing by name ("you haven't
 * connected GitHub") sends the one person who can fix it to the right place.
 */
export async function pushCanonical(
  project: CoordinatorProject,
  store: CoordinationStore,
  github: GitHubConnectionService,
  request: {
    repository: { id: string };
    task: { id: string };
  },
  repositories?: RepositoryService,
): Promise<PushCanonicalResult> {
  const stored = await store.getRepository(request.repository.id);
  const remoteUrl = stored?.remoteUrl ?? "";
  if (remoteUrl.length === 0) {
    return {
      outcome: "refused",
      explanation:
        `${request.repository.id} has no remote recorded, so there is ` +
        "nowhere to push it. Connect it to a GitHub repository first.",
    };
  }
  // The queue row is the authority on who asked, looked up rather than
  // trusted from the request: the submitter is what the push authenticates
  // as, and it must come from the same place the billing decision reads it.
  const submitter = (
    await store.listSubmittedTasks({ repositoryId: request.repository.id })
  ).find((task) => task.id === request.task.id)?.submittedBy;
  if (submitter === undefined) {
    return {
      outcome: "refused",
      explanation:
        "This task records no submitter, so there is no GitHub account to " +
        "push as. Nothing was pushed.",
    };
  }
  return await pushCanonicalAs(
    project,
    store,
    github,
    {
      repositoryId: request.repository.id,
      actorId: submitter,
      excludeTaskId: request.task.id,
    },
    repositories,
  );
}
