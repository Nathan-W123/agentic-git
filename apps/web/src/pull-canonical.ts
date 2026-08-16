import { repoSync } from "@coord/cli/repo-export";
import type { CoordinatorProject } from "@coord/cli/project";
import type { CoordinationStore } from "@coord/persistence";
import type { RepositoryService } from "@coord/repository-service";
import { describeError } from "@coord/shared-types";

import type { GitHubConnectionService } from "./github-connection.js";

/**
 * Brings canonical up to date with its GitHub origin, as an agent action —
 * the other half of `pushCanonical`, and the answer to the loop it left
 * open: work merged on GitHub makes the push safety check refuse, and until
 * this existed the refusal's remedies (re-import, explicit revision) were
 * not reachable from the dashboard at all.
 *
 * Unlike push, a pull does not require a connected GitHub account: it is a
 * read, and a public repository reads anonymously. The submitter's stored
 * token rides along when they have one — a private repository needs it —
 * under the same rule as everything else: the task's own submitter, never a
 * deployment-wide credential.
 */
export async function pullCanonical(
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
        "nothing to pull from. Connect it to a GitHub repository first.",
    };
  }
  const submitter = (
    await store.listSubmittedTasks({ repositoryId: request.repository.id })
  ).find((task) => task.id === request.task.id)?.submittedBy;
  const connection =
    submitter === undefined ? undefined : await github.tokenFor(submitter);
  try {
    const synced = await repoSync(
      project,
      store,
      {
        repositoryId: request.repository.id,
        // The asking task is mid-run by definition; only *other* work in
        // the repository holds the sync off.
        excludeTaskId: request.task.id,
        ...(connection === undefined
          ? {}
          : { credentials: { token: connection.token } }),
        ...(submitter === undefined ? {} : { actorId: submitter }),
      },
      repositories,
    );
    const branch = synced.upstreamBranch;
    if (synced.status === "already_current") {
      return {
        outcome: "done",
        detail: { url: synced.remoteUrl },
        explanation:
          `Canonical already holds everything on GitHub's ${branch} ` +
          `(${synced.upstreamRevision.slice(0, 8)}) — there was nothing to ` +
          "pull. Pushing is unblocked.",
      };
    }
    if (synced.status === "fast_forwarded") {
      return {
        outcome: "done",
        detail: { url: synced.remoteUrl },
        explanation:
          `Pulled from GitHub: canonical moved from ` +
          `${synced.previousRevision.slice(0, 8)} to ` +
          `${synced.revision.slice(0, 8)} on ${branch}. Pushing is unblocked.`,
      };
    }
    return {
      outcome: "done",
      detail: { url: synced.remoteUrl },
      explanation:
        `Pulled from GitHub and merged: ${branch} on GitHub and the ` +
        "platform's local work had both moved, so the two histories were " +
        `joined at ${synced.revision.slice(0, 8)}. Nothing from either side ` +
        "was lost, and pushing is unblocked.",
    };
  } catch (error) {
    // A collision is a decision, and an agent is the wrong one to make it:
    // choosing whose version of a file survives belongs to a person. The
    // refusal names where that choice lives rather than leaving the reader
    // to guess — the earlier version of this message listed remedies a
    // dashboard could not reach at all.
    if ((error as { name?: unknown }).name === "SyncDivergedError") {
      return {
        outcome: "refused",
        explanation:
          `${describeError(error)} You can settle it from the repository's ` +
          "menu: Sync from GitHub offers both choices — take GitHub's " +
          "version of the clashing files, or keep this project's — and " +
          "either way the other side stays in the history.",
      };
    }
    const explanation = describeError(error);
    if (/authentication failed|error: 40[13]\b|returned error: 40[13]\b/iu.test(explanation)) {
      if (connection !== undefined && submitter !== undefined) {
        await github
          .noteAuthFailure(submitter, "GitHub refused this token during a sync")
          .catch(() => undefined);
        return {
          outcome: "refused",
          explanation:
            "GitHub refused your stored token, so nothing was pulled. It " +
            "may have expired or lost access to this repository — " +
            "reconnect GitHub in Settings.",
        };
      }
      return {
        outcome: "refused",
        explanation:
          "GitHub would not let this repository be read without a sign-in, " +
          "so nothing was pulled. Connect GitHub in Settings and ask again.",
      };
    }
    return {
      outcome: "refused",
      explanation: `The pull did not go through: ${explanation}`,
    };
  }
}
