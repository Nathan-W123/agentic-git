/**
 * Noticing that somebody pushed.
 *
 * The mirror this whole system plans against is a copy. When a person pushes
 * straight to the origin — from a terminal, from their own clone, from the
 * GitHub web editor — nothing here finds out. Agents keep writing plans
 * against a base that no longer matches the remote, and the first anybody
 * hears of it is a push that refuses or a merge that fails for a reason
 * nobody can trace back to the afternoon somebody renamed a function.
 *
 * This closes the noticing, not the hole. People are allowed to push to their
 * own repository and nothing here should try to stop them. What it does is
 * fetch the upstream ref on a timer, without moving canonical an inch, and
 * record the gap as a branch claim — after which every warning path that
 * already exists for two branches works for this one, because as far as the
 * ladder is concerned that is all it is.
 *
 * **Read-only, always.** `peekRemote` writes one ref that means "what this
 * mirror has seen of the remote" and touches nothing else. A watcher that
 * moved canonical underneath running agents to answer a question would be a
 * far worse bug than the one it fixes.
 *
 * **Best effort, silently.** Every failure here — a remote that is down, a
 * private repository nobody has a token for, an index that will not build —
 * costs a warning that would have been nice to have. None of them is a
 * reason to log an error every minute for a repository that is simply not
 * reachable from this deployment.
 *
 * **Whose credential.** A private origin needs a token, and a timer has no
 * person behind it. The rule everywhere else here is "the task's own
 * submitter, never a deployment-wide credential", and this keeps to it: the
 * caller supplies a lookup that resolves to a real person's stored token, and
 * the audit written when a gap is found names whose it was. A repository with
 * nobody to borrow from is read anonymously, which is enough for a public
 * origin and is quietly nothing for a private one.
 */

import {
  claimFromUpstreamGap,
  describeUpstreamGap,
  gapIsWorthRecording,
  upstreamBranchName,
  type UpstreamGap,
} from "@coord/coordinator";
import type { CodeIntelligenceService } from "@coord/code-intelligence";
import type { CoordinationStore } from "@coord/persistence";
import type { RepositoryService } from "@coord/repository-service";

/** How often the origin is asked, when nobody asked for it. */
export const UPSTREAM_POLL_MS = 5 * 60 * 1000;

export interface UpstreamWatchOptions {
  store: CoordinationStore;
  repositories: RepositoryService;
  intelligence: CodeIntelligenceService;
  /**
   * A token for reading this repository's origin, and who it belongs to.
   *
   * Returning nothing is a complete answer: the peek is then anonymous.
   */
  credentialsFor?: (
    repositoryId: string,
  ) => Promise<{ token: string; actorId: string } | undefined>;
}

/** What one repository's check did, for a caller that wants to say so. */
export interface UpstreamCheck {
  repositoryId: string;
  outcome: "current" | "recorded" | "cleared" | "unreachable";
  detail?: string;
}

/**
 * Checks one repository's origin and records or clears what it finds.
 *
 * Three outcomes that matter and one that does not. A mirror level with its
 * origin has any stale claim cleared — the gap it described is closed, and a
 * claim still sitting there would sequence plans against changes they already
 * contain, which is worse than never recording it because it looks like it is
 * working. A mirror behind its origin gets the gap recorded. A mirror that
 * cannot be reached is left exactly as it was, because "the network was down"
 * is not evidence that anything changed.
 */
export async function checkUpstream(
  options: UpstreamWatchOptions,
  repositoryId: string,
): Promise<UpstreamCheck> {
  const stored = await options.store.getRepository(repositoryId);
  const remoteUrl = stored?.remoteUrl ?? "";
  if (stored === undefined || remoteUrl === "") {
    return { repositoryId, outcome: "current" };
  }
  const repository = {
    id: stored.id,
    path: stored.path,
    branch: stored.branch,
  };
  const credential = await options
    .credentialsFor?.(repositoryId)
    .catch(() => undefined);
  let peeked;
  try {
    peeked = await options.repositories.peekRemote(repository, {
      remoteUrl,
      ...(credential === undefined
        ? {}
        : { credentials: { token: credential.token } }),
    });
  } catch (error) {
    return {
      repositoryId,
      outcome: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const branch = upstreamBranchName(peeked.upstreamBranch);
  if (peeked.current) {
    // Level, or ahead of the origin because this deployment has pushed and
    // the origin has not moved since. Either way there is no gap left to
    // warn about, and the claim goes.
    const held = (
      await options.store.listBranchClaims(repositoryId).catch((): [] => [])
    ).filter((claim) => claim.branch === branch);
    if (held.length === 0) {
      return { repositoryId, outcome: "current" };
    }
    await options.store.releaseBranchClaims(repositoryId, branch);
    return {
      repositoryId,
      outcome: "cleared",
      detail: `canonical has caught up with ${branch}`,
    };
  }

  // What the pushed files actually hold, read from an index at the revision
  // the origin is on. The same read an agent's landed work gets, for the same
  // reason: a claim built from a file list alone is a guess about symbols,
  // and a guess is what the whole contract layer exists to replace.
  //
  // Indexing the upstream revision is safe — it is in this mirror's object
  // store after the fetch, and indexing reads objects rather than refs.
  const observed = await options.intelligence
    .index(repository, peeked.upstreamRevision)
    .then((index) => ({
      resources: options.intelligence.changedResources(peeked.files, index),
      contracts: {
        shapes: options.intelligence.shapesIn(peeked.files, index).map((shape) => ({
          ...shape,
          consumers: options.intelligence.consumersOf(index, {
            file: shape.file,
            symbol: shape.symbol,
          }),
        })),
      },
    }))
    .catch(() => undefined);

  const gap: UpstreamGap = {
    repositoryId,
    upstreamBranch: peeked.upstreamBranch,
    revision: peeked.upstreamRevision,
    mirrorRevision: peeked.previousRevision,
    files: peeked.files,
    ...(observed === undefined ? {} : { resources: observed.resources }),
    ...(observed === undefined ? {} : { contracts: observed.contracts }),
  };
  if (!gapIsWorthRecording(gap)) {
    return { repositoryId, outcome: "current" };
  }

  // Replaced rather than added to. A second push moves the gap; two claims
  // for one upstream branch would describe two overlapping pasts and the
  // older one would never be true again.
  await options.store.releaseBranchClaims(repositoryId, branch).catch(() => {});
  await options.store.recordBranchClaim(claimFromUpstreamGap(gap));
  await options.store
    .appendAudit(undefined, {
      type: "conflict_detected",
      data: {
        repositoryId,
        stage: "upstream_push_observed",
        branch,
        revision: peeked.upstreamRevision,
        mirrorRevision: peeked.previousRevision,
        files: peeked.files.slice(0, 50),
        // Named because it was borrowed. A background check that reads
        // somebody's private repository with their stored token should say
        // whose it used, in the one place that outlives the check.
        ...(credential === undefined ? {} : { actorId: credential.actorId }),
      },
    })
    .catch(() => undefined);
  return {
    repositoryId,
    outcome: "recorded",
    detail: describeUpstreamGap(gap),
  };
}

/**
 * Every repository with an origin, one after another.
 *
 * Sequential on purpose. Each check is a network fetch and a possible index
 * build, and a deployment with forty repositories doing all of that at once
 * on a timer would be indistinguishable from an outage.
 */
export async function checkAllUpstreams(
  options: UpstreamWatchOptions,
): Promise<UpstreamCheck[]> {
  const repositories = await options.store
    .listRepositories()
    .catch((): [] => []);
  const checks: UpstreamCheck[] = [];
  for (const repository of repositories) {
    if ((repository.remoteUrl ?? "") === "") {
      continue;
    }
    checks.push(
      await checkUpstream(options, repository.id).catch(
        (error: unknown): UpstreamCheck => ({
          repositoryId: repository.id,
          outcome: "unreachable",
          detail: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }
  return checks;
}

/**
 * The timer, returned so the caller can stop it.
 *
 * Unreferenced, like every other sweep here: a watcher for a change nobody
 * has made should not be the reason a process refuses to exit.
 */
export function watchUpstreams(
  options: UpstreamWatchOptions,
  everyMs = UPSTREAM_POLL_MS,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void checkAllUpstreams(options).catch(() => undefined);
  }, everyMs);
  timer.unref?.();
  return timer;
}
