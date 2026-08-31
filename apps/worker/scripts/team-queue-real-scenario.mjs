/**
 * A team-queue scenario built from a repository's own history.
 *
 * The scenario beside this one is a three-file pricing service written to make
 * tasks collide: four of its ten objectives necessarily rewrite one function.
 * That is the right shape for asking whether arbitration fires at all, and the
 * wrong shape for asking what arbitration is worth, because the contention
 * rate is a property of the fixture rather than of any real work. Measured on
 * this repository, the estimate behind a blanket claim locks around seventeen
 * files while the work touches two — a ratio a six-file corpus cannot express,
 * because it does not have seventeen files to lock.
 *
 * So this builds the scenario backwards out of commits that really landed.
 * Take a window of history, step back to the commit before the earliest of
 * them, and hand each commit's subject to an agent as its objective. Three
 * things follow that a synthetic corpus cannot offer:
 *
 * - The tasks are real and they really co-occurred, so whatever contention
 *   there is between them is the contention this codebase actually produces
 *   rather than a rate somebody chose.
 * - Every task has a reference diff — the commit that really implemented it —
 *   so a behavioural check can compare against what shipped.
 * - The base is a real tree, with a real build, real tests, and the file-size
 *   distribution that makes arbitration hard. One file in this repository is
 *   23,000 lines, and nothing in a six-file fixture behaves like that.
 *
 * The cost is that a task can fail for reasons unrelated to coordination: a
 * commit subject is terser than a request a person would send, and some
 * commits are not reproducible from their subject alone. That is a real
 * limitation, and it applies equally to both arms — which is what keeps the
 * comparison sound even where an individual task is unfair.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** Field separator for `git log --format`; never appears in a subject line. */
const UNIT = "\x1f";

const git = async (repo, ...args) =>
  (await exec("git", ["-C", repo, ...args], { maxBuffer: 256 * 1024 * 1024 }))
    .stdout;

/**
 * Whether a commit is worth handing to an agent as work.
 *
 * Merges are skipped because their subject describes a branch rather than a
 * change. A commit touching nothing but lockfiles or build output is skipped
 * for the same reason: reproducing it is mechanical and says nothing about
 * whether two agents can share a repository.
 */
function usable(subject, files) {
  if (/^Merge (pull request|branch|remote)/u.test(subject)) {
    return false;
  }
  if (files.length === 0) {
    return false;
  }
  return files.some(
    (file) => !/(^|\/)(package-lock\.json|dist\/|\.lock$|\.min\.)/u.test(file),
  );
}

/**
 * Builds a scenario from `count` usable commits ending at `head`.
 *
 * The base is the parent of the oldest commit taken, so every task starts from
 * a tree where none of the work exists yet — the same starting position the
 * synthetic scenario gets by writing its files fresh.
 */
export async function buildRealScenario({
  repositoryPath,
  head = "HEAD",
  count = 8,
  agents = ["codex-a", "codex-b", "codex-c", "codex-d", "codex-e"],
  validationCommands,
}) {
  // Over-read, because most commits in any window are filtered out.
  const log = (
    await git(
      repositoryPath,
      "log",
      `--format=%H${UNIT}%s`,
      `-${String(Math.max(count * 6, 60))}`,
      head,
    )
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split(UNIT);
      return { sha, subject };
    });

  const chosen = [];
  for (const entry of log) {
    if (chosen.length >= count) {
      break;
    }
    const files = (
      await git(
        repositoryPath,
        "diff",
        "--name-only",
        `${entry.sha}^`,
        entry.sha,
      ).catch(() => "")
    )
      .split("\n")
      .filter(Boolean);
    if (!usable(entry.subject, files)) {
      continue;
    }
    chosen.push({ ...entry, files });
  }
  if (chosen.length === 0) {
    throw new Error(`No usable commits found in ${repositoryPath} at ${head}`);
  }
  // Oldest first, so the base is the parent of the earliest and the tasks read
  // in the order they were really done.
  chosen.reverse();
  const base = (await git(repositoryPath, "rev-parse", `${chosen[0].sha}^`)).trim();

  const taskId = (sha) => `task_${sha.slice(0, 12)}`;

  return {
    name: "team-queue-real",
    description:
      `${String(chosen.length)} commits that really landed in ` +
      `${repositoryPath}, replayed as objectives against the tree before the ` +
      "earliest of them",
    /**
     * A revision in a real repository rather than a map of file contents. The
     * harness clones this instead of writing a seed tree: a 241,000-line
     * corpus is not something to carry in memory as a string map.
     */
    sourceRepository: { path: repositoryPath, revision: base },
    /** What each task's commit really changed, for scoring against reality. */
    reference: chosen.map((entry) => ({
      taskId: taskId(entry.sha),
      sha: entry.sha,
      subject: entry.subject,
      files: entry.files,
    })),
    tasks: chosen.map((entry, index) => ({
      // Every task is its own band. Contention here is discovered rather than
      // designed, so labelling one "deep" in advance would be inventing the
      // very thing this scenario exists to measure.
      band: "observed",
      task: {
        id: taskId(entry.sha),
        objective: entry.subject,
        agentId: agents[index % agents.length],
        validationCommands,
      },
      behavior: {
        plan: {
          taskId: taskId(entry.sha),
          objective: "live-only",
          expectedFiles: [],
          expectedSymbols: [],
          dependencies: [],
          commands: [],
          externalAccess: [],
          riskLevel: "low",
        },
        async execute() {
          throw new Error(
            "team-queue-real has no scripted behaviour; run it live",
          );
        },
      },
    })),
  };
}
