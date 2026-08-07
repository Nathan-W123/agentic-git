#!/usr/bin/env node
/**
 * The first realistic-scale coordination measurement in this project.
 *
 * Every earlier experiment compared two configurations of the coordinator
 * against each other — grounding on versus off, warm replan versus cold,
 * partial admission versus all-or-nothing. None of them ever asked the
 * question the product rests on, which is whether coordinating a queue beats
 * not coordinating it at all. This harness runs that comparison at a size
 * where the answer could plausibly go either way: ten tasks, five agents, and
 * a task set with genuinely independent work in it rather than uniform
 * contention (see `team-queue-scenario.mjs` for why the bands are shaped the
 * way they are).
 *
 * ## The two arms
 *
 * **Coordinated.** One canonical repository, ten tasks, five remote workers
 * leasing against one control plane. Plans are arbitrated, conflicts are
 * detected, contended work is sequenced or requeued, results are integrated
 * against a moving canonical.
 *
 * **Uncoordinated.** The same ten tasks, the same five workers, the same
 * agents, the same machinery — but each task is bound to *its own* canonical
 * repository, all ten seeded from one identical source commit. No two tasks
 * ever share a repository, so the coordinator never compares two plans, never
 * detects a conflict, never sequences anything and never requeues: every agent
 * plans and executes against the same untouched base, exactly as five
 * developers would on five branches cut on Monday morning. The coordination
 * machinery is not stubbed out, it is starved of anything to coordinate, which
 * keeps the two arms honest about everything *except* the variable under test.
 *
 * That leaves the uncoordinated arm owing a debt the coordinated arm pays as
 * it goes: ten diffs against one base that have to become one tree. This
 * harness settles it the way a team without a coordinator does — apply each
 * task's diff in the order the tasks finished, three-way, and where the merge
 * refuses, let the later task win the file outright and charge a fixed
 * manual-repair penalty for the human who would have had to sit down and do
 * it. The penalty is a parameter, it is reported separately from measured
 * wall clock, and every number in the output is available with it removed.
 *
 * ## What is measured
 *
 * Wall clock, tokens, replans and requeues, and — the one that decides
 * whether the rest matters — whether any task's work was silently destroyed.
 * That last is checked mechanically rather than asserted: every line a task
 * added is looked for in the final tree, and a task whose added lines are
 * missing had its change overwritten by someone else's.
 *
 * Every plan either arm produced is dumped alongside the metrics, because the
 * agent-written `intent` prose on those plans is the only corpus that can
 * measure the intent-level conflict signal's false-positive rate.
 *
 * Usage (from the repository root, after `npx turbo run build`):
 *
 *   node apps/worker/scripts/team-queue-experiment.mjs \
 *     --arm=coordinated --workers=5 --out=docs/benchmarks/data/team-queue
 *
 * Requires COORD_AGENT_CMD to name the agent executable, exactly like the
 * live benchmark and the remote-path harness.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parseCodexTokens } from "@coord/adapter-codex";
import { parseClaudeUsage } from "@coord/adapter-prompt-cli";
import { assertProjectPolicy } from "@coord/shared-types";
import { ApiGateway } from "@coord/api-gateway";
import { CoordinatorProject } from "@coord/cli/project";
import { workerOperations } from "@coord/cli/worker-operations";
import { SqliteCoordinationStore } from "@coord/persistence";
import { RepositoryService, runProcess } from "@coord/repository-service";

import { WorkerClient } from "../dist/client.js";
import { Worker } from "../dist/worker.js";
import { TEAM_QUEUE_SCENARIO } from "./team-queue-scenario.mjs";
import { TEAM_QUEUE_WIRED_SCENARIO } from "./team-queue-wired-scenario.mjs";

const run = promisify(execFile);

const BOOTSTRAP_TOKEN = "bootstrap-token-team-queue-experiment";

function flag(name, fallback) {
  const raw = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return raw === undefined ? fallback : raw.slice(name.length + 3);
}

const arm = flag("arm", "coordinated");
const workerCount = Number(flag("workers", "5"));
const outDir = flag("out", "docs/benchmarks/data/team-queue");
const runBudgetMs = Number(flag("budget-ms", String(75 * 60 * 1000)));
const runLabel = flag("label", "run1");
/**
 * What one merge conflict costs a human, in seconds.
 *
 * There is no measurement behind this number and inventing one would be
 * dishonest, so it is a parameter with a deliberately modest default: five
 * minutes to open two versions of a file, work out which half of each to
 * keep, and re-run the tests. Every reported figure is available both with
 * and without it, and the uncoordinated arm's raw wall clock — what the
 * machines actually took — is never adjusted.
 */
const repairPenaltySeconds = Number(flag("repair-penalty-seconds", "300"));
/**
 * Which bands to queue, for verification runs that do not need the whole set.
 *
 * The full ten-task scenario is what the cost comparison needs and it costs
 * over two hours and two million tokens. Confirming that a scheduling fix
 * broke a livelock needs the contended core and something uncontended beside
 * it, and nothing else.
 */
/**
 * How the uncoordinated arm settles a merge it cannot apply cleanly.
 *
 * `agent` pays a real model to resolve the conflict, in the merge tree, with
 * the conflict markers `git apply --3way` left behind, and clocks what that
 * costs. `last-writer-wins` is the original behaviour: discard the merge and
 * overwrite the file with the later task's whole version, then charge
 * `--repair-penalty-seconds` for the human who would have had to do it
 * properly.
 *
 * The original is kept because every recorded number was produced by it, but
 * it is not a resolution and should not be read as one. It *destroys* the
 * earlier task's change — which is precisely why those runs report tasks
 * losing work — and the penalty standing in for the repair is an invented
 * figure with no measurement behind it. A comparison of coordinated against
 * uncoordinated wall clock is only honest if the uncoordinated side actually
 * pays for the tree it owes, so new runs should use `agent`.
 */
const conflictResolution = flag("resolve-conflicts", "agent");
if (!["agent", "last-writer-wins"].includes(conflictResolution)) {
  throw new Error("--resolve-conflicts must be agent or last-writer-wins");
}

const bands = flag("bands", "deep,partial,independent")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

if (!["coordinated", "uncoordinated"].includes(arm)) {
  throw new Error("--arm must be coordinated or uncoordinated");
}
if (!Number.isSafeInteger(workerCount) || workerCount < 2) {
  throw new Error("--workers must be at least 2");
}

const sleep = async (ms) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every Codex invocation either arm made, and what it cost.
 *
 * The remote-worker path cannot report token usage to the control plane on
 * this branch — that plumbing exists only on a concurrent session's
 * `remote-path-bench`, which is why the first run of this experiment reported
 * `tokens=n/a`. Rather than wait for it or duplicate it, the harness wraps the
 * adapter's own process runner: `CodexAdapter` accepts an injected runner, so
 * counting here observes exactly the invocations the adapter makes, using the
 * adapter's own parser on the adapter's own output. Nothing in the product is
 * touched and nothing about the run changes.
 *
 * The phase is read from the working directory. Planning runs in a disposable
 * read-only worktree under `planning/`; execution runs in the task workspace.
 * That distinction is the whole point of the measurement, because a replan is
 * a planning round bought twice.
 */
const codexInvocations = [];
const countingCodexRunner = async (executable, args, options) => {
  const startedAt = Date.now();
  const output = await runProcess(executable, args, options);
  const tokens = parseCodexTokens(
    `${output.stdout ?? ""}\n${output.stderr ?? ""}`,
  );
  const cwd = String(options?.cwd ?? "");
  codexInvocations.push({
    phase: /[\\/]planning[\\/]/u.test(cwd) ? "planning" : "execution",
    elapsedMs: Date.now() - startedAt,
    exitCode: output.exitCode,
    // `undefined` where the CLI printed no total: "not reported" and "cost
    // nothing" are different claims and must not be added together.
    ...(tokens === undefined ? {} : { tokens }),
  });
  return output;
};

const git = async (repo, ...args) =>
  (await run("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024 }))
    .stdout;

/**
 * The agent executable, read the same way `coord benchmark --live` reads it.
 *
 * `COORD_AGENT_ARGS` is the one addition: a JSON array of arguments, which a
 * `generic-cli` agent needs and a Codex agent does not. It exists so the whole
 * harness — both arms, the merge, the survival check — can be exercised end to
 * end against a scripted agent before any of it is pointed at a real model,
 * because a plumbing bug found after an hour of live tokens is an expensive
 * way to learn about a typo.
 *
 * `COORD_AGENT_EFFORT` is the prompt-cli reasoning setting. It is a first-class
 * field on a `claude` agent rather than something smuggled through
 * `COORD_AGENT_ARGS`, because the prompt-cli adapter accepts only `--model`
 * pairs in `args` — deliberately, so that project configuration cannot weaken
 * the invocation mode it enforces — and would reject `--effort` there. The
 * model itself does go through `args`, as `["--model", "opus"]`.
 */
function liveAgent() {
  const command = process.env["COORD_AGENT_CMD"]?.trim() ?? "";
  if (command.length === 0) {
    throw new Error("COORD_AGENT_CMD must name the agent executable");
  }
  const adapter = process.env["COORD_AGENT_ADAPTER"]?.trim() ?? "codex";
  const windowsSandbox =
    process.env["COORD_CODEX_WINDOWS_SANDBOX"]?.trim() ?? "unelevated";
  const executionSandbox = process.env["COORD_CODEX_SANDBOX"]?.trim();
  const rawArgs = process.env["COORD_AGENT_ARGS"]?.trim() ?? "";
  const effort = process.env["COORD_AGENT_EFFORT"]?.trim() ?? "";
  if (effort.length > 0 && adapter !== "claude") {
    throw new Error("COORD_AGENT_EFFORT applies only to a claude agent");
  }
  return {
    adapter,
    command,
    ...(rawArgs.length === 0 ? {} : { args: JSON.parse(rawArgs) }),
    ...(effort.length === 0 ? {} : { effort }),
    ...(adapter === "codex" ? { windowsSandbox } : {}),
    ...(executionSandbox === undefined ? {} : { executionSandbox }),
  };
}

/**
 * A control plane, canonical repositories, and the scenario's tasks queued.
 *
 * The arm is expressed entirely in how many canonical repositories exist. One
 * repository means ten tasks contend and the coordinator arbitrates them. Ten
 * repositories — every one an identical clone of the same source commit —
 * means no two tasks are ever comparable, which is what makes the control a
 * control rather than a differently-tuned coordinator.
 */
async function bootControlPlane(root, scenario) {
  const projectRoot = path.join(root, "cp");
  await mkdir(projectRoot, { recursive: true });
  const project = await CoordinatorProject.init(projectRoot);
  const agent = liveAgent();
  project.config.agents = Object.fromEntries(
    scenario.tasks.map((entry) => [entry.task.agentId, { ...agent }]),
  );
  project.config.defaultAgent = scenario.tasks[0].task.agentId;
  await project.save();

  // One seeded source tree, imported once per canonical repository, so every
  // arm and every task starts from a byte-identical base commit.
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  for (const [file, contents] of Object.entries(scenario.seed)) {
    const target = path.join(sourcePath, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  await repositories.commitAll(sourcePath, "seed");
  const seedRevision = (await git(sourcePath, "rev-parse", "HEAD")).trim();

  const store = SqliteCoordinationStore.open(path.join(root, "state.db"));
  const shared = arm === "coordinated";
  const canonicals = new Map();
  const importCanonical = async (key) => {
    const canonical = await repositories.importLocalRepository(
      sourcePath,
      path.join(root, `canon-${key}.git`),
      `repo_team_queue_${key}`,
      "main",
    );
    await store.saveRepository({
      id: canonical.id,
      path: canonical.path,
      branch: canonical.branch,
    });
    canonicals.set(key, canonical);
    return canonical;
  };
  if (shared) {
    await importCanonical("shared");
  } else {
    for (const entry of scenario.tasks) {
      await importCanonical(entry.task.id);
    }
  }

  const operations = {
    async createRepository() {
      throw new Error("not used");
    },
    async importGitHub() {
      throw new Error("not used");
    },
    async submitTask() {
      throw new Error("not used");
    },
    async runRepository() {},
    ...workerOperations(project, store),
  };
  const gateway = new ApiGateway({
    store,
    operations,
    bootstrapToken: BOOTSTRAP_TOKEN,
  });
  // The control plane shares a process with five workers, and a worker that
  // is grounding a plan or hashing a bundle can stall the event loop for
  // longer than Node's five-second keep-alive. When that happens the server
  // closes idle sockets, the next worker request fails to connect, and — via
  // the worker's own error handling — the *task* is reported failed and never
  // retried. The first run of this experiment lost seven of ten tasks that
  // way, including three of the four with nothing to contend over, which
  // measured the harness rather than the coordinator. These timeouts are
  // generous enough that only a genuinely dead connection trips them.
  gateway.server.keepAliveTimeout = 5 * 60 * 1000;
  gateway.server.headersTimeout = 6 * 60 * 1000;
  gateway.server.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${gateway.server.address().port}`;

  const cookies = [];
  const setup = await fetch(`${origin}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bootstrap-Token": BOOTSTRAP_TOKEN,
    },
    body: JSON.stringify({
      email: "owner@example.com",
      displayName: "Owner",
      password: "RelayPassword123!",
    }),
  });
  assert.equal(setup.status, 201);
  for (const cookie of setup.headers.getSetCookie()) {
    cookies.push(cookie.split(";")[0] ?? "");
  }
  const csrf = /coord_csrf=([^;]+)/u.exec(cookies.join("; "))?.[1] ?? "";
  const issued = await fetch(`${origin}/api/v1/auth/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies.join("; "),
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify({ name: "fleet", scopes: ["view", "run_task"] }),
  });
  assert.equal(issued.status, 201);
  const token = (await issued.json()).token;

  // Bootstrap creates the owner's organization, and a worker's tenant is now a
  // required registration field rather than something the control plane infers
  // from the token. Read back rather than assumed: the id is minted during
  // bootstrap and nothing else here knows it.
  const [organization] = await store.listOrganizations();
  if (organization === undefined) {
    throw new Error("bootstrap created no organization to register workers in");
  }

  // Leasing is project-scoped now: a worker asks for work in one project, and
  // the queue it reads is `listSubmittedTasks({projectId})`. So the tasks and
  // the workers have to agree on a project, and there has to be a real one —
  // `authorizeProject` resolves it before any work is handed out. One project
  // holds every task in both arms, because the arm is expressed in how many
  // canonical repositories exist, and splitting the project as well would
  // change a second variable.
  const projectRecord = await store.createProject({
    organizationId: organization.id,
    slug: "team-queue",
    name: "team-queue experiment",
  });
  // Approvals off, because there is nobody to give one.
  //
  // The policy defaults gate any plan declaring a schema change and then wait
  // up to 24 hours for a human, while the worker holds the lease for up to 8.
  // In an unattended benchmark that is not a review, it is a deadlock: the
  // first wired pilot gated eight of ten plans and burned its whole budget
  // waiting. Nothing is being measured about approvals here, and the recorded
  // corpus never tripped this gate at all — its plans did not declare schemas
  // — so disabling it makes the arms comparable rather than diverging from
  // them. Plans are recorded before the gate either way, so the intent corpus
  // this run exists to produce is unaffected.
  //
  // `version: 1` is not decoration: `assertProjectPolicy` rejects a policy
  // without it, the rejection surfaces as a 500 on every lease, and the worker
  // loop treats that as a transport error and retries silently. Omitting it
  // cost a full twenty-minute run that produced 3,895 failed iterations and
  // not one plan. Validated here, at boot, so a malformed policy is a startup
  // error rather than a budget spent on nothing.
  const policy = { version: 1, approvals: { enabled: false } };
  assertProjectPolicy(policy);
  await store.updateProject(projectRecord.id, { policy });

  // The store mints its own task ids, so nothing downstream can key off the
  // scenario's. Every later lookup — which repository a task owns, which band
  // it was designed into, which commit is its contribution — goes through this
  // index, built once at submission where both ids are in hand.
  const submitted = [];
  for (const entry of scenario.tasks) {
    const canonical = canonicals.get(shared ? "shared" : entry.task.id);
    const record = await store.submitTask({
      repositoryId: canonical.id,
      projectId: projectRecord.id,
      objective: entry.task.objective,
      agentId: entry.task.agentId,
      validationCommands: entry.task.validationCommands,
    });
    submitted.push({
      taskId: record.id,
      scenarioTaskId: entry.task.id,
      band: entry.band,
      agentId: entry.task.agentId,
      objective: entry.task.objective,
      repositoryId: canonical.id,
      canonicalPath: canonical.path,
    });
  }
  const byTaskId = new Map(submitted.map((entry) => [entry.taskId, entry]));

  return {
    project,
    store,
    gateway,
    origin,
    token,
    organizationId: organization.id,
    projectId: projectRecord.id,
    repositories,
    sourcePath,
    seedRevision,
    canonicals,
    submitted,
    byTaskId,
  };
}

async function outstanding(store) {
  const tasks = await store.listSubmittedTasks();
  return tasks.filter(
    (task) => task.status !== "integrated" && task.status !== "failed",
  );
}

/** Runs the workers until the queue drains, keeping every iteration result. */
async function driveWorkers(plane, root, count, deadline) {
  const iterations = [];
  const workers = [];
  for (let index = 0; index < count; index += 1) {
    const worker = new Worker({
      client: new WorkerClient({
        serverUrl: plane.origin,
        token: plane.token,
        // The default is thirty seconds, which is a sane production figure and
        // the wrong one here: an admission that has to ground a plan against a
        // repository five other workers are also hammering can legitimately
        // take longer, and the cost of being wrong is a permanently failed
        // task rather than a retry.
        requestTimeoutMs: 10 * 60 * 1000,
      }),
      project: plane.project,
      organizationId: plane.organizationId,
      projectId: plane.projectId,
      workspaceRoot: path.join(root, `w${String(index)}`),
      name: `team-queue-worker-${String(index)}`,
      version: "1.0.0",
      // Halved chatter against a control plane that is sharing a process with
      // the workers it is serving.
      pollIntervalMs: 3_000,
      // Belt and braces against the deadlock the project policy above removes.
      // If anything still gates a plan, the worker gives the lease back in a
      // minute instead of holding it for the default eight hours, which is
      // long enough to strand a run that has no reviewer behind it.
      planApprovalWaitMs: 60_000,
      // Only the Codex adapter takes an injected runner. A `claude` run needs
      // none: the prompt-cli adapter reads the usage block out of the same
      // envelope it already parses and reports it through the protocol, so its
      // tokens arrive by the ordinary path as `agent_usage_reported`.
      ...((process.env["COORD_AGENT_ADAPTER"]?.trim() ?? "codex") === "codex"
        ? { codexRunner: countingCodexRunner }
        : {}),
    });
    await worker.register();
    workers.push(worker);
  }

  const loop = async (worker, index) => {
    while (Date.now() < deadline) {
      if ((await outstanding(plane.store)).length === 0) {
        return;
      }
      const startedAt = Date.now();
      let result;
      try {
        result = await worker.runOnce();
      } catch (error) {
        result = {
          worked: false,
          reason: error instanceof Error ? error.message : String(error),
          threw: true,
        };
      }
      iterations.push({
        worker: index,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        ...result,
      });
      abortIfHopeless();
      if (!result.worked || result.deferred === true) {
        await sleep(1_500);
      }
    }
  };

  /**
   * Stops a run that is failing every iteration instead of letting it spend
   * its whole budget doing so.
   *
   * The worker loop is deliberately forgiving — a failed iteration is recorded
   * and retried, because transient control-plane trouble should not kill a
   * run. The cost of that forgiveness is that a *permanent* fault is
   * indistinguishable from a slow start: a malformed project policy made every
   * lease return 500, and the loop turned that into 3,895 identical failures
   * over twenty minutes with nothing to show. If nothing has succeeded after
   * this many consecutive failures, something is wrong with the setup rather
   * than with one request, and stopping now leaves the reason on the record
   * while it is still cheap to read.
   */
  const abortIfHopeless = () => {
    const MIN_ATTEMPTS = 40;
    if (iterations.length < MIN_ATTEMPTS) {
      return;
    }
    if (iterations.some((entry) => entry.worked === true)) {
      return;
    }
    const reasons = new Set(
      iterations.map((entry) => String(entry.reason ?? "").slice(0, 200)),
    );
    throw new Error(
      `${String(iterations.length)} iterations, none of which worked. ` +
        `This is a setup fault, not a flaky request. Distinct reasons: ` +
        [...reasons].map((reason) => JSON.stringify(reason)).join(", "),
    );
  };

  await Promise.all(workers.map(async (worker, index) => await loop(worker, index)));
  await Promise.all(workers.map(async (worker) => await worker.stop()));
  return iterations;
}

/**
 * Every line a patch adds, normalised for comparison.
 *
 * Whitespace-only and structural lines are dropped: they recur throughout any
 * tree and finding one proves nothing about whether a task's change survived.
 */
function addedLines(patch) {
  return [
    ...new Set(
      patch
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1).trim())
        .filter((line) => line.length > 3 && !/^[{}()[\];,]+$/u.test(line)),
    ),
  ];
}

/**
 * Whether each task's work is still present in the final tree.
 *
 * This is the correctness measure, and it is deliberately mechanical: a task
 * whose added lines cannot be found anywhere in the final tree had its change
 * discarded, whatever the run's status fields say about it. Statuses record
 * what the system believed; this records what is actually in the repository.
 */
async function survival(finalTreePath, patches, byTaskId) {
  const files = (await git(finalTreePath, "ls-files")).split("\n").filter(Boolean);
  const blob = (
    await Promise.all(
      files.map(async (file) =>
        readFile(path.join(finalTreePath, file), "utf8").catch(() => ""),
      ),
    )
  ).join("\n");
  const haystack = new Set(blob.split("\n").map((line) => line.trim()));
  return patches.map((entry) => {
    const lines = addedLines(entry.patch);
    const surviving = lines.filter((line) => haystack.has(line));
    const known = byTaskId.get(entry.taskId);
    return {
      taskId: entry.taskId,
      scenarioTaskId: known?.scenarioTaskId,
      band: known?.band,
      addedLines: lines.length,
      survivingLines: surviving.length,
      survivalRatio:
        lines.length === 0 ? 1 : surviving.length / lines.length,
      /** No added line survived: this task's change is simply not there. */
      whollyOverwritten: lines.length > 0 && surviving.length === 0,
      /** Some of it went missing, which is the silent-corruption case. */
      partiallyOverwritten:
        lines.length > 0 && surviving.length > 0 && surviving.length < lines.length,
    };
  });
}

/**
 * Whether each task's *behaviour* survived, judged by its own tests.
 *
 * The line-based check below asks whether a task's added lines are still
 * present verbatim. That is the right question when the loser of a merge is
 * simply overwritten, and the wrong one as soon as anybody genuinely resolves
 * a conflict: a real resolution rewrites the lines it combines, so a tree that
 * correctly implements both changes scores as having lost both. Measured on
 * the first agent-resolved run, all three tasks read as partially lost while
 * `node --test` passed on the merged tree.
 *
 * So the task's own tests are run against the merged tree instead. A task
 * whose tests pass there had its behaviour preserved however the lines were
 * rearranged; a task whose tests fail lost something real. The tests come from
 * that task's own canonical, not the merged tree, because a merge can drop a
 * test as easily as it can drop the code it covers.
 */
async function behaviouralSurvival(mergePath, plane, root) {
  const results = [];
  for (const entry of plane.submitted) {
    const canonical = plane.canonicals.get(entry.scenarioTaskId);
    if (canonical === undefined) {
      continue;
    }
    const head = (await git(canonical.path, "rev-parse", "HEAD")).trim();
    if (head === plane.seedRevision) {
      continue;
    }
    const changed = (
      await git(canonical.path, "diff", "--name-only", plane.seedRevision, head)
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const testFiles = changed.filter((file) => /(^|\/)test\//u.test(file));
    if (testFiles.length === 0) {
      results.push({
        scenarioTaskId: entry.scenarioTaskId,
        judged: false,
        reason: "task changed no test file, so its behaviour cannot be judged",
      });
      continue;
    }
    const probe = path.join(root, `probe-${entry.scenarioTaskId}`);
    await run("git", ["clone", "--quiet", mergePath, probe]);
    for (const file of testFiles) {
      const contents = await git(canonical.path, "show", `${head}:${file}`).catch(
        () => undefined,
      );
      if (contents === undefined) {
        continue;
      }
      const target = path.join(probe, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }
    let passed = false;
    let output = "";
    try {
      const { stdout } = await run("node", ["--test", ...testFiles], {
        cwd: probe,
        maxBuffer: 16 * 1024 * 1024,
      });
      passed = true;
      output = stdout.slice(-1500);
    } catch (error) {
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`.slice(-1500);
    }
    await rm(probe, { recursive: true, force: true }).catch(() => undefined);
    results.push({
      scenarioTaskId: entry.scenarioTaskId,
      judged: true,
      testFiles,
      passed,
      ...(passed ? {} : { output }),
    });
  }
  return results;
}

/**
 * Every conflict-resolution pass the uncoordinated arm had to pay for.
 *
 * This is the cost the arm used to get for free. `git apply --3way` leaves
 * conflict markers behind when it refuses; a real team then sits down and
 * works out which half of each side to keep. Nothing in this harness did that
 * — it overwrote the file with the later task's version and charged a made-up
 * penalty — so the uncoordinated wall clock measured coding and nothing else.
 * Here the resolution is actually performed, by the same model doing the
 * coding, and what it costs is measured rather than assumed.
 */
const conflictResolutions = [];

/**
 * Resolves the conflict markers in a merge tree, with an agent, and clocks it.
 *
 * Run in the merge tree itself rather than a workspace: the thing being
 * resolved is a tree, the tests that decide whether it worked are in it, and
 * the agent needs to be able to run them. It is told not to discard either
 * side, because discarding is exactly what the old behaviour did and what the
 * lost-work metric counts.
 */
async function resolveConflictsWithAgent(mergePath, files, taskId) {
  const command = process.env["COORD_AGENT_CMD"]?.trim() ?? "";
  if (command.length === 0) {
    throw new Error("COORD_AGENT_CMD must name the agent executable");
  }
  const rawArgs = process.env["COORD_AGENT_ARGS"]?.trim() ?? "";
  const effort = process.env["COORD_AGENT_EFFORT"]?.trim() ?? "";
  const prompt = [
    "A three-way merge left conflict markers in this repository.",
    "",
    "Conflicted files:",
    ...files.map((file) => "- " + file),
    "",
    "Resolve every conflict so the working tree is coherent and node --test",
    "passes.",
    "",
    "Both sides are changes somebody made deliberately. Keep the intent of",
    "both: do not delete one side's change to make the markers go away, and",
    "do not weaken or delete a test to make it pass. Where two changes",
    "affect the same calculation, combine them so both apply.",
    "",
    "Leave no conflict markers behind. Reply with a one-line summary.",
  ].join("\n");

  const startedAt = Date.now();
  const output = await runProcess(
    command,
    [
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      ...(rawArgs.length === 0 ? [] : JSON.parse(rawArgs)),
      ...(effort.length === 0 ? [] : ["--effort", effort]),
    ],
    {
      cwd: mergePath,
      input: prompt,
      timeoutMs: 30 * 60 * 1000,
      maxOutputBytes: 32 * 1024 * 1024,
    },
  );
  const elapsedMs = Date.now() - startedAt;
  const usage = parseClaudeUsage(output.stdout) ?? undefined;
  const record = {
    taskId,
    files: [...files],
    elapsedMs,
    exitCode: output.exitCode,
    ...(usage === undefined
      ? {}
      : {
          tokens: usage.totalTokens,
          ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
        }),
  };
  conflictResolutions.push(record);
  return record;
}

/** Files still carrying conflict markers, which means the resolution failed. */
async function filesWithMarkers(mergePath, files) {
  const remaining = [];
  for (const file of files) {
    const contents = await readFile(path.join(mergePath, file), "utf8").catch(
      () => "",
    );
    if (/^<{7} |^={7}$|^>{7} /mu.test(contents)) {
      remaining.push(file);
    }
  }
  return remaining;
}

/**
 * The debt the uncoordinated arm owes: ten diffs against one base, one tree.
 *
 * Applied in the order the tasks finished, three-way, with the later task
 * winning any file the merge refuses — which is what "whoever finishes last
 * wins" means once it is made precise enough to execute.
 */
async function mergeUncoordinated(plane, root, order) {
  const mergePath = path.join(root, "merge");
  await run("git", ["clone", "--quiet", plane.sourcePath, mergePath]);
  await git(mergePath, "config", "user.email", "bench@example.test");
  await git(mergePath, "config", "user.name", "bench");
  await git(mergePath, "checkout", "--quiet", plane.seedRevision);

  const patches = [];
  const merges = [];
  let conflictedFiles = 0;
  for (const taskId of order) {
    const known = plane.byTaskId.get(taskId);
    const canonical =
      known === undefined ? undefined : plane.canonicals.get(known.scenarioTaskId);
    if (canonical === undefined) {
      continue;
    }
    const head = (await git(canonical.path, "rev-parse", "HEAD")).trim();
    if (head === plane.seedRevision) {
      merges.push({ taskId, status: "empty", conflictedFiles: [] });
      continue;
    }
    const patch = await git(
      canonical.path,
      "diff",
      "--binary",
      plane.seedRevision,
      head,
    );
    patches.push({ taskId, patch });
    const patchFile = path.join(root, `${taskId}.patch`);
    await writeFile(patchFile, patch, "utf8");

    let status = "clean";
    let conflicted = [];
    try {
      await git(mergePath, "apply", "--3way", patchFile);
    } catch {
      // The three-way apply refused. Which files it refused on is the honest
      // measure of the repair a human would have faced, so they are named
      // rather than counted, and each is then resolved the only way "last
      // writer wins" can be resolved at file granularity: the later task's
      // version of the file replaces whatever was there.
      status = "conflicted";
      conflicted = (await git(mergePath, "diff", "--name-only", "--diff-filter=U"))
        .split("\n")
        .filter(Boolean);
      if (conflicted.length === 0) {
        // A patch that could not be applied at all: every file it touches is
        // contested, because none of it landed.
        conflicted = patch
          .split("\n")
          .filter((line) => line.startsWith("+++ b/"))
          .map((line) => line.slice(6));
      }
      if (conflictResolution === "agent") {
        // Leave the markers `git apply --3way` wrote and pay an agent to
        // settle them, which is what the arm actually owes. Only if that
        // fails do we fall back to destroying a side, and the fallback is
        // recorded rather than silently substituted.
        const resolved = await resolveConflictsWithAgent(
          mergePath,
          conflicted,
          taskId,
        );
        const stillConflicted = await filesWithMarkers(mergePath, conflicted);
        resolved.unresolvedFiles = stillConflicted;
        resolved.succeeded = stillConflicted.length === 0;
        if (!resolved.succeeded) {
          await git(mergePath, "checkout", "--", ".").catch(() => undefined);
          for (const file of conflicted) {
            const contents = await git(
              canonical.path,
              "show",
              `${head}:${file}`,
            ).catch(() => undefined);
            if (contents === undefined) {
              continue;
            }
            const target = path.join(mergePath, file);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, contents, "utf8");
          }
        }
      } else {
        await git(mergePath, "checkout", "--", ".").catch(() => undefined);
        for (const file of conflicted) {
          const contents = await git(canonical.path, "show", `${head}:${file}`).catch(
            () => undefined,
          );
          if (contents === undefined) {
            continue;
          }
          const target = path.join(mergePath, file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, contents, "utf8");
        }
      }
      conflictedFiles += conflicted.length;
    }
    await git(mergePath, "add", "-A");
    await git(mergePath, "commit", "--quiet", "-m", `merge ${taskId}`).catch(
      () => undefined,
    );
    merges.push({ taskId, status, conflictedFiles: conflicted });
  }

  // The final tree is only worth reporting on if it is a tree a team would
  // have shipped, so it is validated exactly as the coordinated arm validates
  // every integration.
  let validation;
  try {
    const { stdout } = await run("node", ["--test"], {
      cwd: mergePath,
      maxBuffer: 32 * 1024 * 1024,
    });
    validation = { passed: true, output: stdout.slice(-4000) };
  } catch (error) {
    validation = {
      passed: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`.slice(-4000),
    };
  }

  return {
    mergePath,
    merges,
    patches,
    conflictedFiles,
    // With a real resolution pass the repair is measured, so the invented
    // penalty is not also charged. `last-writer-wins` keeps the penalty
    // because nothing was actually repaired there.
    repairPenaltyMs:
      conflictResolution === "agent"
        ? conflictResolutions.reduce((sum, entry) => sum + entry.elapsedMs, 0)
        : conflictedFiles * repairPenaltySeconds * 1000,
    resolutionMode: conflictResolution,
    conflictResolutions,
    resolutionElapsedMs: conflictResolutions.reduce(
      (sum, entry) => sum + entry.elapsedMs,
      0,
    ),
    resolutionTokens: conflictResolutions.reduce(
      (sum, entry) => sum + (entry.tokens ?? 0),
      0,
    ),
    resolutionsFailed: conflictResolutions.filter(
      (entry) => entry.succeeded === false,
    ).length,
    validation,
  };
}

/** The coordinated arm's final tree, and each task's contribution to it. */
async function coordinatedOutcome(plane, root) {
  const canonical = plane.canonicals.get("shared");
  const finalPath = path.join(root, "final");
  await run("git", ["clone", "--quiet", canonical.path, finalPath]);

  const patches = [];
  for (const entry of plane.submitted) {
    // A task's contribution is the commit the coordinator promoted for it.
    // The commit subject carries the store's task id, which is what
    // `coord(<id>): <objective>` is built from.
    const line = (
      await git(finalPath, "log", "--format=%H", `--grep=coord(${entry.taskId})`, "--fixed-strings")
    )
      .split("\n")
      .filter(Boolean)[0];
    if (line === undefined) {
      continue;
    }
    patches.push({
      taskId: entry.taskId,
      patch: await git(finalPath, "show", "--binary", "--format=", line),
    });
  }

  let validation;
  try {
    const { stdout } = await run("node", ["--test"], {
      cwd: finalPath,
      maxBuffer: 32 * 1024 * 1024,
    });
    validation = { passed: true, output: stdout.slice(-4000) };
  } catch (error) {
    validation = {
      passed: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`.slice(-4000),
    };
  }
  return { finalPath, patches, validation };
}

function summarize(iterations, records, tasks) {
  const audit = records.map((entry) => entry.event);
  const byPhase = {};
  let tokensTotal = 0;
  let reported = false;
  for (const iteration of iterations) {
    for (const entry of iteration.usage ?? []) {
      reported = true;
      tokensTotal += entry.tokens;
      byPhase[entry.phase] = (byPhase[entry.phase] ?? 0) + entry.tokens;
    }
  }

  // Tokens observed at the adapter's process boundary, where the control
  // plane cannot see them on this branch.
  const observed = { planning: 0, execution: 0 };
  let observedTotal = 0;
  let unreported = 0;
  for (const entry of codexInvocations) {
    if (entry.tokens === undefined) {
      unreported += 1;
      continue;
    }
    observed[entry.phase] += entry.tokens;
    observedTotal += entry.tokens;
  }

  /**
   * Task deaths that were the harness's fault rather than the coordinator's.
   *
   * A worker that hits any error inside a lease reports the *task* failed, and
   * the control plane does not retry it — so one dropped socket permanently
   * kills a task. Counting these separately is what keeps a run honest: a
   * comparison between arms is only meaningful if both arms actually attempted
   * the same work.
   */
  const transportFailures = iterations.filter(
    (entry) =>
      entry.transport === true ||
      /fetch failed|operation was aborted|ECONNRESET|socket hang up|ECONNREFUSED/iu.test(
        String(entry.reason ?? ""),
      ),
  ).length;
  /**
   * Transport losses the worker survived by requeueing rather than failing the
   * task. Counted apart from the total because the two say different things: a
   * dropped connection that costs a lease is noise, and one that costs a task
   * is the defect this run exists to check is gone.
   */
  const transportRequeues = iterations.filter(
    (entry) => entry.transport === true,
  ).length;

  const events = (type) => audit.filter((event) => event.type === type);
  const replanEvents = records.filter(
    (entry) => entry.event.type === "replan_requested",
  );

  return {
    transportFailures,
    transportRequeues,
    tasksIntegrated: tasks.filter((task) => task.status === "integrated").length,
    tasksFailed: tasks.filter((task) => task.status === "failed").length,
    tasksOutstanding: tasks.filter(
      (task) => task.status !== "integrated" && task.status !== "failed",
    ).length,
    tasksTotal: tasks.length,

    leaseIterations: iterations.filter((entry) => entry.worked === true).length,
    acceptedIterations: iterations.filter((entry) => entry.accepted === true)
      .length,
    deferredIterations: iterations.filter((entry) => entry.deferred === true)
      .length,

    conflictsDetected: events("conflict_detected").length,
    partialAdmissions: events("plan_admitted").filter(
      (event) => event.data.partial === true,
    ).length,
    planTimeRequeues: replanEvents.filter(
      (entry) => entry.runId === undefined,
    ).length,
    resultTimeRequeues: replanEvents.filter((entry) => entry.runId !== undefined)
      .length,
    replansTotal: replanEvents.length,

    integrationsPromoted: events("canonical_promoted").length,
    validationRuns: events("validation_completed").length,
    validationFailures: events("validation_completed").filter(
      (event) => event.data.status !== "integrated",
    ).length,

    // Reported by the worker path where that plumbing exists; observed at the
    // adapter boundary otherwise. Both are recorded rather than merged, so a
    // reader can see which number came from where.
    ...(reported ? { tokensTotal, tokensByPhase: byPhase } : {}),
    observedTokensTotal: observedTotal,
    observedTokensByPhase: observed,
    codexInvocations: codexInvocations.length,
    codexInvocationsWithoutTokenLine: unreported,
    controlPlaneTokensTotal: events("agent_usage_reported").reduce(
      (sum, event) => sum + Number(event.data.tokensTotal ?? 0),
      0,
    ),
  };
}

/**
 * Every plan either arm produced, with the agent's own `intent` prose intact.
 *
 * The control plane rewrites a submitted plan's `objective` to the assigned
 * one so the binding stays byte-exact, and moves the model's own phrasing to
 * `intent`. That prose is the sole input to the intent-level conflict signal,
 * so it is the only corpus against which that signal's false-positive rate can
 * be measured — and no run before this one kept it.
 */
async function harvestPlans(store, byTaskId) {
  const runs = await store.listRuns(500);
  const plans = [];
  for (const stored of runs) {
    for (const revision of await store.listPlanRevisions(stored.id)) {
      const known = byTaskId.get(revision.taskId);
      plans.push({
        runId: stored.id,
        taskId: revision.taskId,
        scenarioTaskId: known?.scenarioTaskId,
        band: known?.band,
        revision: revision.revision,
        reason: revision.reason,
        createdAt: revision.createdAt,
        plan: revision.plan,
      });
    }
  }
  return plans;
}

/**
 * Which seed to run against.
 *
 * `team-queue` is the recorded corpus and is frozen — the benchmark numbers in
 * `docs/benchmarks/` are only reproducible while its seed is byte-identical,
 * and `assertRegisteredSeed` enforces that. `team-queue-wired` is the same ten
 * tasks over a corrected tree, in which all three partial-band modules are
 * genuinely imported by the order total. New runs should prefer it; the
 * default stays on the recorded scenario so that repeating a past experiment
 * does not silently change what was being measured.
 */
const SCENARIOS = new Map([
  ["team-queue", TEAM_QUEUE_SCENARIO],
  ["team-queue-wired", TEAM_QUEUE_WIRED_SCENARIO],
]);
const scenarioName =
  process.argv
    .find((entry) => entry.startsWith("--scenario="))
    ?.slice("--scenario=".length) ?? "team-queue";
const baseScenario = SCENARIOS.get(scenarioName);
if (baseScenario === undefined) {
  throw new Error(
    `--scenario must be one of ${[...SCENARIOS.keys()].join(", ")}, ` +
      `got ${scenarioName}`,
  );
}

async function once() {
  const selected = baseScenario.tasks.filter((entry) =>
    bands.includes(entry.band),
  );
  if (selected.length === 0) {
    throw new Error(`--bands selected no tasks: ${bands.join(",")}`);
  }
  const scenario = { ...baseScenario, tasks: selected };
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-team-"));
  const startedAt = Date.now();
  let plane;
  try {
    plane = await bootControlPlane(root, scenario);
    const iterations = await driveWorkers(
      plane,
      root,
      workerCount,
      startedAt + runBudgetMs,
    );
    const elapsedMs = Date.now() - startedAt;
    const tasks = await plane.store.listSubmittedTasks();
    const records = await plane.store.listAuditEvents();
    const metrics = summarize(iterations, records, tasks);
    // What the vendor CLIs actually reported, read from where the control
    // plane stores it. `agent_usage_reported` is not an audit event — usage
    // goes to `recordTokenUsage`, one row per lease and phase carrying a
    // running total — so the old `controlPlaneTokensTotal` read a table that
    // was never written and reported every run as free.
    const usageRows = await plane.store.listTokenUsage({});
    metrics.reportedTokensTotal = usageRows.reduce(
      (sum, row) => sum + Number(row.totalTokens ?? 0),
      0,
    );
    metrics.reportedTokensByPhase = {};
    for (const row of usageRows) {
      metrics.reportedTokensByPhase[row.phase] =
        (metrics.reportedTokensByPhase[row.phase] ?? 0) +
        Number(row.totalTokens ?? 0);
    }
    metrics.reportedTokenRows = usageRows.length;
    const plans = await harvestPlans(plane.store, plane.byTaskId);

    // Completion order is the order the control plane promoted each task's
    // work. In the uncoordinated arm it is also the order the merge replays,
    // which is what makes "whoever finishes last wins" a fact about the run
    // rather than a choice made afterwards.
    const completionOrder = records
      .filter((entry) => entry.event.type === "canonical_promoted")
      // The audit log's own sequence, not a wall-clock string: two promotions
      // in the same millisecond must still have an order, and the log already
      // knows what it was.
      .sort((a, b) => a.sequence - b.sequence)
      .map((entry) => entry.event.taskId)
      .filter((id) => id !== undefined)
      .filter((id, index, all) => all.indexOf(id) === index);

    /**
     * Work that did not survive, as a rate rather than an aside.
     *
     * This is the measure that decides whether the rest matters: wall clock
     * and tokens compare two ways of getting to a tree, and a tree missing a
     * task's change is not the same tree. It was previously computed ad hoc
     * by whoever read the artefact, which is how "about two tasks a run" ended
     * up being passed around as folklore instead of a number.
     */
    const lostWorkMetrics = (survival, behavioural = []) => {
      const judged = behavioural.filter((entry) => entry.judged);
      const failed = judged.filter((entry) => !entry.passed);
      const wholly = survival.filter((entry) => entry.whollyOverwritten);
      const partially = survival.filter((entry) => entry.partiallyOverwritten);
      const total = survival.length;
      return {
        tasksWithChangesets: total,
        tasksWhollyOverwritten: wholly.length,
        tasksPartiallyOverwritten: partially.length,
        tasksLosingWork: wholly.length + partially.length,
        lostTaskRate:
          total === 0 ? 0 : (wholly.length + partially.length) / total,
        tasksLosingWorkIds: [...wholly, ...partially]
          .map((entry) => entry.scenarioTaskId)
          .filter((id) => id !== undefined)
          .sort(),
        /**
         * The headline number, and the one to quote.
         *
         * Verbatim line survival above is a proxy that stops being valid the
         * moment a conflict is genuinely resolved rather than overwritten —
         * a correct merge rewrites the lines it combines. This asks the
         * question directly: does the merged tree still do what this task's
         * own tests say it should?
         */
        behaviouralJudged: judged.length,
        behaviouralLost: failed.length,
        behaviouralLostRate:
          judged.length === 0 ? undefined : failed.length / judged.length,
        behaviouralLostIds: failed.map((entry) => entry.scenarioTaskId).sort(),
      };
    };

    let outcome;
    if (arm === "uncoordinated") {
      const merged = await mergeUncoordinated(plane, root, completionOrder);
      outcome = {
        kind: "uncoordinated",
        /**
         * Which files each task's patch actually writes.
         *
         * In this arm every task ran from the same untouched base, so two
         * tasks naming one file here contended in fact — which makes this the
         * only observed, as opposed to designed, ground truth available for
         * scoring the conflict detector's predictions.
         */
        patchFiles: merged.patches.map((entry) => ({
          taskId: entry.taskId,
          scenarioTaskId: plane.byTaskId.get(entry.taskId)?.scenarioTaskId,
          files: [
            ...new Set(
              entry.patch
                .split("\n")
                .filter((line) => line.startsWith("+++ b/"))
                .map((line) => line.slice(6).trim()),
            ),
          ],
        })),
        merges: merged.merges,
        conflictedFiles: merged.conflictedFiles,
        repairPenaltyMs: merged.repairPenaltyMs,
        repairPenaltySeconds,
        resolutionMode: merged.resolutionMode,
        conflictResolutions: merged.conflictResolutions,
        resolutionElapsedMs: merged.resolutionElapsedMs,
        resolutionTokens: merged.resolutionTokens,
        resolutionsFailed: merged.resolutionsFailed,
        validation: merged.validation,
        survival: await survival(merged.mergePath, merged.patches, plane.byTaskId),
      };
      outcome.behaviouralSurvival = await behaviouralSurvival(
        merged.mergePath,
        plane,
        root,
      );
      outcome.lostWork = lostWorkMetrics(
        outcome.survival,
        outcome.behaviouralSurvival,
      );
    } else {
      const settled = await coordinatedOutcome(plane, root);
      outcome = {
        kind: "coordinated",
        validation: settled.validation,
        survival: await survival(settled.finalPath, settled.patches, plane.byTaskId),
      };
      outcome.behaviouralSurvival = await behaviouralSurvival(
        settled.finalPath,
        plane,
        root,
      );
      outcome.lostWork = lostWorkMetrics(
        outcome.survival,
        outcome.behaviouralSurvival,
      );
    }

    return {
      arm,
      label: runLabel,
      scenario: scenario.name,
      bands,
      workers: workerCount,
      env: {
        COORD_REPOSITORY_PARALLELISM:
          process.env["COORD_REPOSITORY_PARALLELISM"] ?? "default",
        COORD_AGENT_ADAPTER: process.env["COORD_AGENT_ADAPTER"] ?? "codex",
        // Which model actually wrote these plans. The recorded corpus is
        // Codex; anything else is a deviation and has to be legible in the
        // artefact rather than only in whoever ran it.
        COORD_AGENT_ARGS: process.env["COORD_AGENT_ARGS"] ?? "",
        COORD_AGENT_EFFORT: process.env["COORD_AGENT_EFFORT"] ?? "",
      },
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs,
      /**
       * The uncoordinated arm's wall clock is its measured execution time
       * plus the simulated repair. Both halves are reported so the penalty
       * can be set to zero by a reader who thinks it is wrong.
       */
      wallClockMs: elapsedMs + (outcome.repairPenaltyMs ?? 0),
      budgetExhausted: elapsedMs >= runBudgetMs && metrics.tasksOutstanding > 0,
      completionOrder,
      metrics,
      outcome,
      plans,
      /**
       * Every conflict assessment the coordinator actually recorded, with its
       * evidence list intact.
       *
       * `metrics.conflictsDetected` counts these, which is enough to compare
       * arms and not enough to answer the question the wired run exists to
       * ask: whether the grounded intent signal produced evidence in a real
       * arbitration, and whether it stayed advisory when it did. That is a
       * claim about the `kind` and `advisory` fields of individual evidence
       * entries, so the entries are kept rather than counted.
       */
      assessments: records
        .filter((entry) => entry.event.type === "conflict_detected")
        .map((entry) => ({
          taskId: entry.event.taskId,
          taskIds: entry.event.data.taskIds,
          score: entry.event.data.score,
          disposition: entry.event.data.disposition,
          stage: entry.event.data.stage,
          evidence: entry.event.data.evidence,
        })),
      tasks: tasks.map((task) => ({
        id: task.id,
        scenarioTaskId: plane.byTaskId.get(task.id)?.scenarioTaskId,
        status: task.status,
        agentId: task.agentId,
        band: plane.byTaskId.get(task.id)?.band,
        objective: task.objective.slice(0, 200),
      })),
      iterations: iterations.map((entry) => ({
        worker: entry.worker,
        taskId: entry.taskId,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        elapsedMs: entry.elapsedMs,
        worked: entry.worked,
        accepted: entry.accepted,
        deferred: entry.deferred,
        transport: entry.transport,
        deferredResources: entry.deferredResources,
        tokens: (entry.usage ?? []).reduce((sum, u) => sum + u.tokens, 0),
        reason:
          entry.reason === undefined ? undefined : String(entry.reason).slice(0, 400),
      })),
    };
  } finally {
    await plane?.gateway.close().catch(() => undefined);
    await plane?.store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

await mkdir(outDir, { recursive: true });
const record = await once();
const file = path.join(
  outDir,
  `team-queue-${arm}-${runLabel}-${Date.now()}.json`,
);
await writeFile(file, `${JSON.stringify(record, undefined, 2)}\n`, "utf8");
const m = record.metrics;
const lw = record.outcome.lostWork;
console.log(
  `[${arm}] integrated=${String(m.tasksIntegrated)}/${String(m.tasksTotal)} ` +
    `conflicts=${String(m.conflictsDetected)} ` +
    `replans=${String(m.planTimeRequeues)}p/${String(m.resultTimeRequeues)}r ` +
    `tokens=${String(m.reportedTokensTotal || m.tokensTotal || m.observedTokensTotal || "n/a")} ` +
    `transportFails=${String(m.transportFailures)}(requeued ${String(m.transportRequeues)}) ` +
    `elapsed=${String(Math.round(record.elapsedMs / 1000))}s ` +
    `wall=${String(Math.round(record.wallClockMs / 1000))}s ` +
    `mergeConflicts=${String(record.outcome.conflictedFiles ?? 0)} ` +
    `lostTasks=${String(lw.behaviouralLost ?? "?")}/${String(lw.behaviouralJudged ?? 0)}` +
    `(${lw.behaviouralLostRate === undefined ? "n/a" : `${(lw.behaviouralLostRate * 100).toFixed(0)}%`}) ` +
    `linesLost=${String(lw.tasksLosingWork)}/${String(lw.tasksWithChangesets)} ` +
    `resolveTime=${String(Math.round((record.outcome.resolutionElapsedMs ?? 0) / 1000))}s ` +
    `resolveTokens=${String(record.outcome.resolutionTokens ?? 0)} ` +
    `finalTests=${record.outcome.validation.passed ? "pass" : "FAIL"} -> ${file}`,
);
