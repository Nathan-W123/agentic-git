import type { CoordinationStore } from "@coord/persistence";
import {
  RepositoryService,
  type PushToRemoteResult,
  type RemoteRepositoryCredentials,
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
  /** Branch created on the remote. Defaults to a dated export branch. */
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
