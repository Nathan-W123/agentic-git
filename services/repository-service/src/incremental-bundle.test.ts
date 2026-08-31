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
