import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GitClient } from "./git-client.js";
import { runProcess } from "./process-runner.js";
import { RepositoryService } from "./repository-service.js";

/**
 * Promotion safety when the canonical repository is shared.
 *
 * The multi-device deployment model has several coordinator processes, on
 * different machines, promoting into one canonical repository. Everything
 * else in that model is negotiable; this is not. If two promotions from the
 * same base can both succeed, one developer's integrated work disappears with
 * no error raised anywhere.
 *
 * In-process tests cannot establish this. `promote` delegates the atomicity to
 * `git update-ref <ref> <new> <old>`, whose guarantee is a lock file held by
 * the operating system, so the contended parties have to be real processes.
 * These tests spawn them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Racers import the built service directly rather than through the package name. */
const SERVICE_ENTRY = path
  .join(HERE, "index.js")
  .split(path.sep)
  .join("/");

interface PromotionAttempt {
  candidate: string;
  promoted: boolean;
  error?: string;
}

/**
 * A standalone process that attempts exactly one promotion.
 *
 * It waits on a shared start time rather than starting on spawn, because
 * process startup is slow and staggered enough that sequential spawns would
 * not actually contend.
 */
const RACER_SOURCE = `
import { RepositoryService } from ${JSON.stringify(`file:///${SERVICE_ENTRY}`)};

const [canonicalPath, branch, candidate, base, startAtRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw);

const repository = { id: "shared", path: canonicalPath, branch };
const service = new RepositoryService();

while (Date.now() < startAt) {
  // Spin rather than sleep: the remaining wait is a few milliseconds and the
  // point is to enter update-ref as close to simultaneously as possible.
}

try {
  const promoted = await service.promote(repository, candidate, base);
  process.stdout.write(JSON.stringify({ candidate, promoted }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      candidate,
      promoted: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
`;

interface SharedCanonical {
  root: string;
  canonicalPath: string;
  branch: string;
  base: string;
  service: RepositoryService;
  cleanup: () => Promise<void>;
}

async function createSharedCanonical(): Promise<SharedCanonical> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-race-"));
  const source = path.join(root, "source");
  const canonicalPath = path.join(root, "canonical.git");
  const service = new RepositoryService();

  await service.initializeWorkingRepository(source, "main");
  await writeFile(path.join(source, "value.txt"), "0\n", "utf8");
  await service.commitAll(source, "seed");
  const repository = await service.importLocalRepository(
    source,
    canonicalPath,
    "shared",
  );
  const version = await service.getCanonicalVersion(repository);

  return {
    root,
    canonicalPath,
    branch: repository.branch,
    base: version.revision,
    service,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Builds `count` sibling commits, each a distinct child of `base`.
 *
 * They are created up front so the race measures only the promotion, not the
 * work that produced the candidate.
 */
async function createCandidates(
  shared: SharedCanonical,
  count: number,
): Promise<string[]> {
  const git = new GitClient();
  const candidates: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const worktree = path.join(shared.root, `candidate-${index}`);
    await git.run([
      `--git-dir=${shared.canonicalPath}`,
      "worktree",
      "add",
      "--detach",
      worktree,
      shared.base,
    ]);
    await writeFile(
      path.join(worktree, "value.txt"),
      `${index + 1}\n`,
      "utf8",
    );
    await git.run(["-C", worktree, "add", "--all"]);
    await git.run([
      "-C",
      worktree,
      "-c",
      "user.name=Coordinator",
      "-c",
      "user.email=coordinator@example.invalid",
      "commit",
      "--no-gpg-sign",
      "--no-verify",
      "-m",
      `candidate ${index}`,
    ]);
    const revision = await git.run(["-C", worktree, "rev-parse", "HEAD"]);
    candidates.push(revision.stdout.trim());
  }

  assert.equal(
    new Set(candidates).size,
    count,
    "candidates must be distinct commits for the race to mean anything",
  );
  return candidates;
}

async function race(
  shared: SharedCanonical,
  candidates: readonly string[],
  base: string,
): Promise<PromotionAttempt[]> {
  const racerPath = path.join(shared.root, "racer.mjs");
  await writeFile(racerPath, RACER_SOURCE, "utf8");

  // Enough headroom for every process to reach the spin loop.
  const startAt = Date.now() + 1500 + candidates.length * 250;

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const output = await runProcess(
        process.execPath,
        [
          racerPath,
          shared.canonicalPath,
          shared.branch,
          candidate,
          base,
          String(startAt),
        ],
        { timeoutMs: 60_000 },
      );
      assert.equal(
        output.exitCode,
        0,
        `racer failed: ${output.stderr || output.stdout}`,
      );
      return JSON.parse(output.stdout.trim()) as PromotionAttempt;
    }),
  );

  return results;
}

test("only one of several concurrent processes promotes from a shared base", async () => {
  const shared = await createSharedCanonical();
  try {
    const candidates = await createCandidates(shared, 5);
    const results = await race(shared, candidates, shared.base);

    const winners = results.filter((result) => result.promoted);
    assert.equal(
      winners.length,
      1,
      `expected exactly one winner, got ${winners.length}: ${JSON.stringify(results)}`,
    );

    // No racer may fail in a way the caller cannot interpret. A loser reports
    // `false`, which the coordinator handles by rebasing and retrying; a thrown
    // error would instead surface as a failed run.
    for (const result of results) {
      assert.equal(
        result.error,
        undefined,
        `promotion raised instead of reporting a loss: ${result.error}`,
      );
    }

    // The decisive assertion: canonical holds the winner's commit, so the four
    // losing candidates were not silently written over each other.
    const version = await shared.service.getCanonicalVersion({
      id: "shared",
      path: shared.canonicalPath,
      branch: shared.branch,
    });
    assert.equal(version.revision, winners[0]?.candidate);
  } finally {
    await shared.cleanup();
  }
});

test("a process promoting against a stale base is rejected, not merged", async () => {
  const shared = await createSharedCanonical();
  try {
    const [first, second] = await createCandidates(shared, 2);
    assert.ok(first !== undefined && second !== undefined);

    // Another device promotes first. This process still believes canonical is
    // at the original base.
    const promoted = await shared.service.promote(
      { id: "shared", path: shared.canonicalPath, branch: shared.branch },
      first,
      shared.base,
    );
    assert.equal(promoted, true);

    const [stale] = await race(shared, [second], shared.base);
    assert.equal(stale?.promoted, false);
    assert.equal(stale?.error, undefined);

    const version = await shared.service.getCanonicalVersion({
      id: "shared",
      path: shared.canonicalPath,
      branch: shared.branch,
    });
    assert.equal(
      version.revision,
      first,
      "the stale promotion must not have advanced canonical",
    );
  } finally {
    await shared.cleanup();
  }
});

test("promotion is idempotent when a process retries a promotion that already landed", async () => {
  const shared = await createSharedCanonical();
  try {
    const [candidate] = await createCandidates(shared, 1);
    assert.ok(candidate !== undefined);

    const repository = {
      id: "shared",
      path: shared.canonicalPath,
      branch: shared.branch,
    };
    assert.equal(
      await shared.service.promote(repository, candidate, shared.base),
      true,
    );

    // A worker that lost its connection mid-promotion retries with the same
    // arguments. The compare-and-swap now fails, but the outcome it wanted is
    // already true, so reporting failure would cause pointless rework.
    const retry = await race(shared, [candidate], shared.base);
    assert.equal(retry[0]?.promoted, true);
    assert.equal(retry[0]?.error, undefined);
  } finally {
    await shared.cleanup();
  }
});
