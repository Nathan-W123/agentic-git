import { repoPush } from "@coord/cli/repo-export";
import type { CoordinatorProject } from "@coord/cli/project";
import type { CoordinationStore } from "@coord/persistence";
import type { RepositoryService } from "@coord/repository-service";
import { describeError } from "@coord/shared-types";

import type { GitHubConnectionService } from "./github-connection.js";

/**
 * Publishes canonical to the repository's recorded remote, as an agent action.
 *
 * Pushes to a *new* branch by default and refuses to update one that already
 * exists — `allowExistingTarget` stays off. An agent asking to publish is
 * asking to put work somewhere a person will look at it, which a branch does;
 * overwriting a branch somebody else is using is a different act, and not one
 * to grant on the strength of a sentence in an objective. `pushToRemote` also
 * refuses when the upstream has moved under the revision being published.
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
): Promise<{
  outcome: "done" | "refused";
  detail?: { url?: string; output?: string[] };
  explanation: string;
}> {
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
  const connection = await github.tokenFor(submitter);
  if (connection === undefined) {
    return {
      outcome: "refused",
      explanation:
        "You haven't connected GitHub, so there is no account to push as. " +
        "Connect GitHub in Settings and ask again — the push will run as " +
        "you and reach only what your token can. Nothing was pushed.",
    };
  }
  try {
    const pushed = await repoPush(
      project,
      store,
      {
        repositoryId: request.repository.id,
        credentials: { token: connection.token },
      },
      repositories,
    );
    return {
      outcome: "done",
      detail: { url: pushed.remoteUrl },
      explanation:
        `Pushed ${pushed.revision.slice(0, 8)} to ${pushed.targetBranch} on ` +
        `${pushed.remoteUrl}` +
        (connection.login === undefined ? "" : ` as ${connection.login}`) +
        ". Open a pull request from that branch when you want it reviewed.",
    };
  } catch (error) {
    const explanation = describeError(error);
    if (/authentication failed|error: 40[13]\b|returned error: 40[13]\b/iu.test(explanation)) {
      // Stored and usable are different things: a token GitHub has just
      // refused should stop looking connected in Settings, and the refusal
      // should say whose token failed rather than only that a push did.
      await github
        .noteAuthFailure(submitter, "GitHub refused this token during a push")
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
      explanation: `The push did not go through: ${explanation}`,
    };
  }
}
