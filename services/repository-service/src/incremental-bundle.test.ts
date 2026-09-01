import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "./repository-service.js";

/**
 * The saving this exists for, measured rather than asserted in prose.
 *
 * Every task on every machine used to transfer the repository's whole
 * reachable history, on each mention, for a change that is usually a few
 * commits. On a real repository that was 41 MB a task — paid for in billed
 * egress on one side and in somebody waiting on the other. A worker that says
 * what it already holds gets only what it lacks.
 */
test("a worker that names what it holds is sent only the difference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-delta-"));
  const source = path.join(root, "source");
  const repositories = new RepositoryService();
  try {
    await repositories.initializeWorkingRepository(source);
    // Enough content that a full history is clearly larger than one commit's
    // worth of it. A single small file would make the two indistinguishable
    // through bundle framing alone, and prove nothing.
    for (let commit = 0; commit < 12; commit += 1) {
      await writeFile(
        path.join(source, `file-${String(commit)}.txt`),
        "x".repeat(20_000),
      );
      await repositories.commitAll(source, `commit ${String(commit)}`);
    }
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "delta",
    );
    const canonical = await repositories.getCanonicalVersion(repository);
    const git = repositories.getGitClient();
    const parent = (
      await git.run([
        `--git-dir=${repository.path}`,
        "rev-parse",
        `${canonical.revision}~1`,
      ])
    ).stdout.trim();

    const whole = await repositories.createBundle(
      repository,
      canonical.revision,
      "refs/coord/leases/whole",
    );
    const delta = await repositories.createBundle(
      repository,
      canonical.revision,
      "refs/coord/leases/delta",
      parent,
    );

    assert.ok(
      delta.byteLength * 4 < whole.byteLength,
      `delta ${String(delta.byteLength)} should be far smaller than ` +
        `whole ${String(whole.byteLength)}`,
    );

    // A claim the control plane cannot verify is not acted on. A bundle whose
    // prerequisite the receiver cannot resolve fails to unbundle, which is a
    // worse outcome than a large one — so anything unusable falls back to the
    // full history rather than being trusted.
    const unknown = await repositories.createBundle(
      repository,
      canonical.revision,
      "refs/coord/leases/unknown",
      "0".repeat(40),
    );
    // Compared against the delta rather than byte-for-byte against `whole`: a
    // bundle embeds the ref name it advertises, so two full bundles under
    // different lease refs differ by exactly the difference in those names.
    // What matters is that it carried the history and not the shortcut.
    assert.ok(
      unknown.byteLength > delta.byteLength * 4,
      `unverifiable have should not shrink the bundle (${String(
        unknown.byteLength,
      )} vs delta ${String(delta.byteLength)})`,
    );

    // Not a commit id at all. Rejected on shape before Git is asked.
    const malformed = await repositories.createBundle(
      repository,
      canonical.revision,
      "refs/coord/leases/malformed",
      "--upload-pack=touch /tmp/pwned",
    );
    assert.ok(
      malformed.byteLength > delta.byteLength * 4,
      "a malformed have should not reach git at all",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The worker already holds the revision it is being sent.
 *
 * This is not a corner case, it is the ordinary second task on a repository:
 * canonical has not moved since the last one, so the commit the worker names
 * as `have` *is* the lease revision, and excluding it leaves nothing to pack.
 * `git bundle create` answers that with `fatal: Refusing to create empty
 * bundle` and a non-zero exit, which reached the gateway as an unhandled 500
 * and the room as "I could not finish this: The request could not be
 * completed" — instantly, on every mention, for both vendors, because it
 * happens before any vendor does anything.
 *
 * The bundle still has to carry the ref, since that is what the worker
 * fetches. So it is built one commit further back and stays tiny.
 */
test("a worker that is already up to date still gets a usable bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-current-"));
  const source = path.join(root, "source");
  const repositories = new RepositoryService();
  try {
    await repositories.initializeWorkingRepository(source);
    for (let commit = 0; commit < 6; commit += 1) {
      await writeFile(
        path.join(source, `file-${String(commit)}.txt`),
        "x".repeat(20_000),
      );
      await repositories.commitAll(source, `commit ${String(commit)}`);
    }
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "current",
    );
    const canonical = await repositories.getCanonicalVersion(repository);

    // Exactly what the worker sends on its second task: the revision it holds
    // is the revision it is about to be given.
    const bundle = await repositories.createBundle(
      repository,
      canonical.revision,
      "refs/coord/leases/current",
      canonical.revision,
    );
    assert.ok(bundle.byteLength > 0, "an empty answer is not a bundle");

    // And it is a bundle a worker can actually use: it advertises the ref, and
    // fetching it yields the revision.
    const whole = await repositories.createBundle(
      repository,
      canonical.revision,
      "refs/coord/leases/current-whole",
    );
    assert.ok(
      bundle.byteLength * 2 < whole.byteLength,
      `up-to-date bundle ${String(bundle.byteLength)} should still be far ` +
        `smaller than the whole history ${String(whole.byteLength)}`,
    );

    const bundleFile = path.join(root, "current.bundle");
    await writeFile(bundleFile, bundle);
    const git = repositories.getGitClient();

    // Absorbed into the worker's *cache*, which is where `updateCache`
    // actually fetches a bundle — a bare repository that already holds the
    // very commit it named as `have`. Testing this against an empty clone
    // would be testing a flow the worker does not have, and would demand a
    // self-contained bundle on every repeat task, which is the whole cost the
    // delta exists to avoid.
    const cache = path.join(root, "cache");
    await git.run(["init", "--bare", "--end-of-options", cache]);
    await git.run([
      "-C",
      cache,
      "fetch",
      "--no-tags",
      "--end-of-options",
      path.join(root, "canonical.git"),
      `${canonical.revision}:refs/heads/seeded`,
    ]);
    await git.run([
      "-C",
      cache,
      "fetch",
      "--no-tags",
      "--end-of-options",
      bundleFile,
      "refs/coord/leases/current:refs/coord/leases/current",
    ]);
    const head = (
      await git.run([
        "-C",
        cache,
        "rev-parse",
        "refs/coord/leases/current",
      ])
    ).stdout.trim();
    assert.equal(head, canonical.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
