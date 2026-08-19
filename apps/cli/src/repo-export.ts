import type { CoordinationStore } from "@coord/persistence";
import {
  RepositoryService,
  type PushToRemoteResult,
  type RemoteRepositoryCredentials,
  type SyncFromRemoteResult,
} from "@coord/repository-service";

import type { CoordinatorProject } from "./project.js";
import { resolveRepository } from "./commands.js";

/**
 * Publishing canonical state back to the origin it was imported from.
 *
 * This is the "the project is done, put it on GitHub" step. It is deliberately
 * separate from integration: canonical advances continuously as tasks land,
 * and publishing is an explicit decision a human makes.
 */

export interface RepoPushOptions {
  repositoryId?: string;
  /** Branch created on the remote. Defaults to a short change-derived name. */
  targetBranch?: string;
  /** Overrides the remote recorded at import. */
  remoteUrl?: string;
  allowExistingTarget?: boolean;
  allowUnverifiedUpstream?: boolean;
  expectedUpstreamRevision?: string;
  /**
   * Authenticates the push as a specific person, overriding the environment.
   *
   * The dashboard passes the task submitter's own stored GitHub token here,
   * so a push runs as whoever asked for it and reaches only what they can
   * reach. The environment fallback below is for the local CLI only, where
   * the operator's shell *is* the identity.
   */
  credentials?: RemoteRepositoryCredentials;
}

/**
 * Reads the push credential from the environment.
 *
 * Kept out of configuration files and out of the store: a token in
 * `.coordinator/config.json` would be committed by accident sooner or later.
 *
 * This is the single-operator CLI's path and only that. The dashboard never
 * consults it — a deployment-wide token would let any user's task push
 * wherever the token reaches, under the token owner's name, which is the
 * confused deputy per-user GitHub connections exist to remove.
 */
export function pushCredentials(
  env: NodeJS.ProcessEnv = process.env,
): { token: string } | undefined {
  const token = env["GITHUB_TOKEN"]?.trim() ?? "";
  return token.length === 0 ? undefined : { token };
}

/** Formats the two levels of push description for the interactive CLI. */
export function formatRepoPushResult(result: PushToRemoteResult): string {
  return (
    `Pushed ${result.revision.slice(0, 12)} to ${result.targetBranch}\n` +
    `Summary: ${result.summary}\n` +
    `Remote: ${result.remoteUrl}\n` +
    `${result.createdBranch ? "Created" : "Updated"} the target branch; ` +
    `${result.upstreamBranch} was not modified.`
  );
}

export async function repoPush(
  project: CoordinatorProject,
  store: CoordinationStore,
  options: RepoPushOptions = {},
  repositories = new RepositoryService(),
): Promise<PushToRemoteResult> {
  const repository = await resolveRepository(project, store, options.repositoryId);

  const remoteUrl = options.remoteUrl ?? repository.remoteUrl;
  if (remoteUrl === undefined || remoteUrl.length === 0) {
    throw new Error(
      `${repository.id} has no remote recorded. Import it with ` +
        "`coord repo github <owner/name>`, or pass an explicit remote to push to.",
    );
  }

  const credentials = options.credentials ?? pushCredentials();
  return await repositories.pushToRemote(
    {
      id: repository.id,
      path: repository.path,
      branch: repository.branch,
    },
    {
      remoteUrl,
      ...(options.targetBranch === undefined
        ? {}
        : { targetBranch: options.targetBranch }),
      ...(options.expectedUpstreamRevision === undefined
        ? {}
        : { expectedUpstreamRevision: options.expectedUpstreamRevision }),
      ...(options.allowExistingTarget === undefined
        ? {}
        : { allowExistingTarget: options.allowExistingTarget }),
      ...(options.allowUnverifiedUpstream === undefined
        ? {}
        : { allowUnverifiedUpstream: options.allowUnverifiedUpstream }),
      ...(credentials === undefined ? {} : { credentials }),
    },
  );
}

export interface RepoSyncOptions {
  repositoryId?: string;
  /** Overrides the remote recorded at import. */
  remoteUrl?: string;
  /**
   * Authenticates the fetch. The dashboard passes the requester's own stored
   * GitHub token when they have connected one; a public repository syncs
   * without any.
   */
  credentials?: RemoteRepositoryCredentials;
  projectId?: string;
  /** Who asked, for the audit trail. */
  actorId?: string;
  /** A person's answer to "which side wins" when both changed one file. */
  conflictResolution?: "refuse" | "prefer-remote" | "prefer-local";
  /**
   * The task asking for this sync, exempted from the executing-work guard.
   * A sync requested as an agent action arrives from inside a run, so the
   * asking task is itself claimed and holds a lease — counting it would
   * refuse every pull ever asked for. Its own settle is safe under a moved
   * base: a pull task changes no files, and an empty changeset reports
   * rather than integrates.
   */
  excludeTaskId?: string;
}

/**
 * Brings canonical up to date with its GitHub origin — the other half of
 * {@link repoPush}. Work merged on GitHub after import leaves the mirror
 * behind and the push safety check rightly refusing; a sync moves the mirror
 * (fast-forward, or a true merge when both sides advanced) and the recorded
 * import point forward, after which pushing works again.
 *
 * Refused while tasks are executing in the repository: a sync moves
 * `refs/heads/<branch>` outside the coordinated write path, and the one safe
 * time for that is between runs — which is also the only time anybody
 * actually asks for it.
 */
export async function repoSync(
  project: CoordinatorProject,
  store: CoordinationStore,
  options: RepoSyncOptions = {},
  repositories = new RepositoryService(),
): Promise<SyncFromRemoteResult> {
  const repository = await resolveRepository(project, store, options.repositoryId);

  const remoteUrl = options.remoteUrl ?? repository.remoteUrl;
  if (remoteUrl === undefined || remoteUrl.length === 0) {
    throw new Error(
      `${repository.id} has no remote recorded. Import it with ` +
        "`coord repo github <owner/name>`, or pass an explicit remote to sync from.",
    );
  }

  const [leases, claimed] = await Promise.all([
    store.listWorkLeases({ status: "active", repositoryId: repository.id }),
    store.listSubmittedTasks({ repositoryId: repository.id, status: "claimed" }),
  ]);
  const otherLeases = leases.filter(
    (lease) => lease.taskId !== options.excludeTaskId,
  );
  const otherClaimed = claimed.filter(
    (task) => task.id !== options.excludeTaskId,
  );
  if (otherLeases.length > 0 || otherClaimed.length > 0) {
    throw new Error(
      `Tasks are executing in ${repository.id} right now, and a sync would ` +
        "move the repository underneath them. Wait for the work to land, or " +
        "stop it, then sync again.",
    );
  }

  const canonical = {
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
  };
  const result = await repositories.syncFromRemote(canonical, {
    remoteUrl,
    workspaceRoot: project.workspaceRoot,
    ...(options.conflictResolution === undefined
      ? {}
      : { conflictResolution: options.conflictResolution }),
    ...(options.credentials === undefined
      ? {}
      : { credentials: options.credentials }),
  });

  if (result.status !== "already_current") {
    await store.saveCanonicalVersion(
      repository.id,
      await repositories.getCanonicalVersion(canonical),
    );
  }
  await store.appendAudit(undefined, {
    type: "repository_synced",
    data: {
      repositoryId: repository.id,
      ...(options.projectId === undefined
        ? {}
        : { projectId: options.projectId }),
      ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
      status: result.status,
      previousRevision: result.previousRevision,
      revision: result.revision,
      upstreamRevision: result.upstreamRevision,
      // A resolution is a decision somebody made about somebody else's
      // files, so it belongs on the record rather than only in a toast.
      ...(result.resolved === undefined
        ? {}
        : {
            resolvedSide: result.resolved.side,
            resolvedFiles: result.resolved.files,
          }),
    },
  });
  return result;
}
