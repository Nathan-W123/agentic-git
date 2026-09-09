/**
 * A push nobody asked permission for, turned into something the ladder can
 * already arbitrate — and taken back the moment it stops being true.
 *
 * The three ways this goes wrong are all quiet. A claim recorded under the
 * canonical branch reads as "the base holds these files" and warns nobody. A
 * claim left behind after canonical pulls sequences plans against changes
 * they already contain, which is worse than never recording it because it
 * looks like it is working. And a network failure taken as evidence would
 * clear real contention every time a remote hiccuped.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  UPSTREAM_TASK_ID,
  claimFromUpstreamGap,
  describeUpstreamGap,
  gapIsWorthRecording,
  upstreamBranchName,
  type UpstreamGap,
} from "@coord/coordinator";
import type { BranchClaim, RecordBranchClaimInput } from "@coord/persistence";

import { checkUpstream, type UpstreamWatchOptions } from "./upstream-watch.js";

function gap(over: Partial<UpstreamGap> = {}): UpstreamGap {
  return {
    repositoryId: "repo_1",
    upstreamBranch: "main",
    revision: "b".repeat(40),
    mirrorRevision: "a".repeat(40),
    files: ["services/billing/src/charge.ts"],
    ...over,
  };
}

test("a push is recorded under a branch that says where it came from", () => {
  const claim = claimFromUpstreamGap(
    gap({
      resources: {
        symbols: ["charge"],
        apis: ["POST /charges"],
        schemas: [],
        configKeys: [],
        services: [],
      },
    }),
  );
  // Not `main`. Canonical's own branch is the base every plan is written
  // against, and a claim on it would read as "the base holds these" rather
  // than "these moved somewhere you have not got yet".
  assert.equal(claim.branch, "origin/main");
  assert.notEqual(claim.branch, "main");
  assert.equal(claim.taskId, UPSTREAM_TASK_ID);
  assert.equal(claim.revision, "b".repeat(40));
  assert.deepEqual(claim.symbols, ["charge"]);
  assert.deepEqual(claim.apis, ["POST /charges"]);
  // No ranges, ever. There is no cheap honest way to read them here, and an
  // advisory that never refuses anything is not worth diffing every file on
  // a timer to produce.
  assert.deepEqual(claim.ranges, []);
});

test("an unreadable index still records what the file list is worth", () => {
  // The index is the difference between a claim and a guess, but a file list
  // alone still narrows through `interfaceScopeOf` — a migration or a
  // lockfile in it is a real warning with no symbol resolved at all.
  const claim = claimFromUpstreamGap(gap());
  assert.deepEqual(claim.symbols, []);
  assert.deepEqual(claim.shapes, []);
  assert.equal(claim.branch, upstreamBranchName("main"));
});

test("nothing pushed is nothing to record", () => {
  assert.equal(gapIsWorthRecording(gap()), true);
  assert.equal(gapIsWorthRecording(gap({ files: [] })), false);
  // Same revision on both sides is a mirror that is level, whatever the file
  // list says — a claim there would warn about the base against itself.
  assert.equal(
    gapIsWorthRecording(gap({ revision: "a".repeat(40) })),
    false,
  );
});

test("the sentence names the remedy, because nothing else can", () => {
  const text = describeUpstreamGap(
    gap({ files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] }),
  );
  assert.match(text, /origin\/main has 5 files/u);
  assert.match(text, /a\.ts, b\.ts, c\.ts and 2 more/u);
  // No plan can be narrowed around this and no agent can wait it out.
  // Somebody has to pull, and the warning is useless without saying so.
  assert.match(text, /pulls/u);
  assert.match(text, /aaaaaaaa/u);
  assert.match(text, /bbbbbbbb/u);
});

/* ------------------------------------------------------------------ watch */

interface Recorded {
  recorded: RecordBranchClaimInput[];
  released: string[];
  audits: Record<string, unknown>[];
}

function watcher(input: {
  peek?: Record<string, unknown> | (() => never);
  claims?: BranchClaim[];
  remoteUrl?: string;
}): { options: UpstreamWatchOptions; seen: Recorded } {
  const seen: Recorded = { recorded: [], released: [], audits: [] };
  const store = {
    getRepository: async () => ({
      id: "repo_1",
      path: "/tmp/canon.git",
      branch: "main",
      remoteUrl: input.remoteUrl ?? "https://example.invalid/o.git",
    }),
    listBranchClaims: async () => input.claims ?? [],
    releaseBranchClaims: async (_repositoryId: string, branch: string) => {
      seen.released.push(branch);
    },
    recordBranchClaim: async (claim: RecordBranchClaimInput) => {
      seen.recorded.push(claim);
      return claim as unknown as BranchClaim;
    },
    appendAudit: async (_scope: unknown, entry: Record<string, unknown>) => {
      seen.audits.push(entry);
    },
  };
  const repositories = {
    peekRemote: async () => {
      if (typeof input.peek === "function") {
        return input.peek();
      }
      return input.peek;
    },
  };
  const intelligence = {
    // The index is best effort everywhere it is read; here it always fails,
    // which is the path a store-less or unbuildable repository takes.
    index: async () => {
      throw new Error("no index");
    },
    changedResources: () => ({
      symbols: [],
      apis: [],
      schemas: [],
      configKeys: [],
      services: [],
    }),
    shapesIn: () => [],
    consumersOf: () => [],
  };
  return {
    options: {
      store,
      repositories,
      intelligence,
    } as unknown as UpstreamWatchOptions,
    seen,
  };
}

test("a mirror behind its origin records the gap, once", async () => {
  const { options, seen } = watcher({
    peek: {
      remoteUrl: "https://example.invalid/o.git",
      upstreamBranch: "main",
      upstreamRevision: "b".repeat(40),
      previousRevision: "a".repeat(40),
      current: false,
      ahead: false,
      files: ["services/billing/src/charge.ts"],
    },
  });
  const result = await checkUpstream(options, "repo_1");
  assert.equal(result.outcome, "recorded");
  assert.equal(seen.recorded.length, 1);
  assert.equal(seen.recorded[0]?.branch, "origin/main");
  // Replaced rather than added to. A second push moves the gap, and two
  // claims for one upstream branch would describe two overlapping pasts.
  assert.deepEqual(seen.released, ["origin/main"]);
  // Written down, with whose change it was and where.
  assert.equal(seen.audits.length, 1);
  const data = seen.audits[0]?.["data"] as Record<string, unknown>;
  assert.equal(data["stage"], "upstream_push_observed");
  assert.equal(data["revision"], "b".repeat(40));
});

test("a mirror that has caught up gives the claim back", async () => {
  const { options, seen } = watcher({
    peek: {
      remoteUrl: "https://example.invalid/o.git",
      upstreamBranch: "main",
      upstreamRevision: "b".repeat(40),
      previousRevision: "b".repeat(40),
      current: true,
      ahead: false,
      files: [],
    },
    claims: [{ branch: "origin/main" } as BranchClaim],
  });
  const result = await checkUpstream(options, "repo_1");
  assert.equal(result.outcome, "cleared");
  assert.deepEqual(seen.released, ["origin/main"]);
  assert.equal(seen.recorded.length, 0);
});

test("an unreachable origin changes nothing at all", async () => {
  // The failure that matters most. "The network was down" is not evidence
  // that anybody pulled, and clearing real contention on a hiccup would make
  // the whole layer unreliable in exactly the conditions it is needed.
  const { options, seen } = watcher({
    peek: () => {
      throw new Error("could not resolve host");
    },
    claims: [{ branch: "origin/main" } as BranchClaim],
  });
  const result = await checkUpstream(options, "repo_1");
  assert.equal(result.outcome, "unreachable");
  assert.deepEqual(seen.released, []);
  assert.equal(seen.recorded.length, 0);
  assert.equal(seen.audits.length, 0);
});

test("a repository with no origin is not watched", async () => {
  const { options, seen } = watcher({ remoteUrl: "" });
  const result = await checkUpstream(options, "repo_1");
  assert.equal(result.outcome, "current");
  assert.deepEqual(seen.released, []);
  assert.equal(seen.recorded.length, 0);
});
