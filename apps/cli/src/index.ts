#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SqliteCoordinationStore,
  type CoordinationStore,
  type SubmittedTaskStatus,
} from "@coord/persistence";
import { runProcess } from "@coord/repository-service";
import type { ApprovalStatus } from "@coord/shared-types";

import { runBenchmark, runCoordinatedFixture } from "./benchmark.js";
import {
  repoAdd,
  repoImportGitHub,
  resolveRepository,
  runPendingTasks,
  taskCancel,
  taskRetry,
  taskSubmit,
} from "./commands.js";
import { CoordinatorProject, PROJECT_DIRECTORY } from "./project.js";
import { repoPush } from "./repo-export.js";
import {
  createBenchmarkFixture,
  createLiveBenchmarkFixture,
  readLiveAgentConfig,
  type BenchmarkFixture,
  type LiveAgentConfig,
} from "./fixture.js";
import {
  DEFAULT_SCENARIO,
  SCENARIOS,
  findScenario,
  type BenchmarkScenario,
} from "./scenarios.js";

/** Kept beside the repository so a run's history travels with the checkout. */
const DEFAULT_DATABASE_PATH = path.join(".coordinator", "coordination.db");

/** Reads `--flag=value`, returning `fallback` when the flag carries no value. */
function flagValue(
  flags: readonly string[],
  name: string,
  fallback?: string,
): string | undefined {
  const prefix = `--${name}`;
  const match = flags.find(
    (entry) => entry === prefix || entry.startsWith(`${prefix}=`),
  );
  if (match === undefined) {
    return undefined;
  }
  const value = match.slice(prefix.length + 1).trim();
  return value.length === 0 ? fallback : value;
}

function openStore(flags: readonly string[], name: string): CoordinationStore {
  return SqliteCoordinationStore.open(
    flagValue(flags, name, DEFAULT_DATABASE_PATH) ?? DEFAULT_DATABASE_PATH,
  );
}

function printHelp(): void {
  const scenarios = SCENARIOS.map(
    (entry) =>
      `  ${entry.name.padEnd(12)} ${entry.tasks.length} tasks. ${entry.description}`,
  ).join("\n");

  console.log(`AI-Native Development Coordinator

Usage:
  coord init
  coord repo add <path> [--id=<name>] [--branch=<name>] [--default]
  coord repo github <owner/name|url> [--id=<name>] [--branch=<name>] [--default]
  coord repo push [--repo=<id>] [--branch=<target>] [--update-existing]
  coord repo list
  coord task submit --objective=<text> [--repo=<id>] [--agent=<id>]
  coord task list [--repo=<id>] [--status=<status>]
  coord task retry <task-id>
  coord task cancel <task-id>
  coord run [--repo=<id>]
  coord approval list [--status=<status>] [--json]
  coord approval show <approval-id> [--json]
  coord approval approve <approval-id> [--comment=<text>] [--actor=<id>]
  coord approval reject <approval-id> [--comment=<text>] [--actor=<id>]
  coord doctor

  coord demo [--live] [--scenario=<name>] [--persist[=<path>]]
  coord benchmark [--json] [--live] [--scenario=<name>] [--repeat=<n>]
  coord history [--json] [--db=<path>]
  coord history <run-id> [--json] [--db=<path>]
  coord verify-audit [--db=<path>]
  coord help

Commands:
  init          Create ${PROJECT_DIRECTORY}/ with a starter configuration.
  repo          Register a repository as canonical, or list registered ones.
  task          Submit a task against a repository, or list the queue.
  run           Execute every pending task for a repository.
  approval      Review durable human approval gates.
  doctor        Verify configuration, Git, Docker, storage, and audit health.
  demo          Run one built-in scenario through coordinated execution.
  benchmark     Compare coordinated and uncoordinated execution.
  history       List recorded runs, or show one run in detail.
  verify-audit  Check the audit chain for tampering.

Options:
  --live         Drive selected tasks with a real agent process instead of the
                 deterministic scripted behavior.
  --persist[=<path>]  Record the run to a durable store. Defaults to
                 ${DEFAULT_DATABASE_PATH}.
  --db=<path>    Store to read from. Defaults to ${DEFAULT_DATABASE_PATH}.
  --scenario=<name>  Task set to run. Defaults to "${DEFAULT_SCENARIO.name}".
  --repeat=<n>   Run the benchmark n times and report each run. Scripted
                 scenarios are deterministic, so this only varies timing;
                 it is meaningful with --live.

Scenarios:
${scenarios}

Live agent environment:
  COORD_AGENT_CMD      Agent executable. Required by --live.
  COORD_AGENT_ARGS     JSON array of arguments, or a whitespace-separated list.
  COORD_AGENT_TASKS    Tasks to run live: "cap" (default), "normalize", a
                       comma-separated list of task ids, or "all".
  COORD_AGENT_SANDBOX  "docker" to confine the agent process, "none" by default.
  COORD_AGENT_IMAGE    Container image. Required by COORD_AGENT_SANDBOX=docker.
  COORD_AGENT_NETWORK  Docker network mode. Defaults to "none".
`);
}

function printBenchmarkTable(
  report: Awaited<ReturnType<typeof runBenchmark>>,
  run?: number,
): void {
  const rows = [report.coordinated, report.uncoordinated];
  console.log(
    `\nScenario: ${report.scenario}${run === undefined ? "" : ` (run ${run})`}` +
      `\n${report.scenarioDescription}\n`,
  );
  console.log(
    [
      "Mode".padEnd(16),
      "Completed".padEnd(12),
      "Warnings".padEnd(10),
      "Attempts".padEnd(10),
      "Failed".padEnd(8),
      "Rework".padEnd(8),
      "Missed".padEnd(8),
      "Elapsed",
    ].join(""),
  );
  for (const row of rows) {
    console.log(
      [
        row.mode.padEnd(16),
        `${row.tasksCompleted}/${row.tasksPlanned}`.padEnd(12),
        String(row.conflictWarnings).padEnd(10),
        String(row.integrationAttempts).padEnd(10),
        String(row.integrationFailures).padEnd(8),
        `${row.reworkCount} (${row.reworkRate})`.padEnd(8),
        String(row.undetectedConflicts).padEnd(8),
        `${row.elapsedMs} ms`,
      ].join(""),
    );
  }
  console.log(
    `\nRework avoided by coordination: ${report.reworkAvoided} ` +
      `(${report.reworkRateAvoided} per task)`,
  );
  if (report.coordinated.undetectedConflicts > 0) {
    console.log(
      `Conflicts coordination did not predict: ` +
        `${report.coordinated.undetectedConflicts}. Review the scenario's structural and semantic evidence.`,
    );
  }
}

/** Reads `--scenario=<name>`, falling back to the default task set. */
function selectScenario(flags: readonly string[]): BenchmarkScenario {
  const flag = flags.find((entry) => entry.startsWith("--scenario="));
  return flag === undefined
    ? DEFAULT_SCENARIO
    : findScenario(flag.slice("--scenario=".length).trim());
}

function selectRepeat(flags: readonly string[]): number {
  const flag = flags.find((entry) => entry.startsWith("--repeat="));
  if (flag === undefined) {
    return 1;
  }
  const value = Number.parseInt(flag.slice("--repeat=".length), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--repeat must be a positive integer`);
  }
  return value;
}

async function runDemo(
  live: boolean,
  scenario: BenchmarkScenario,
  store: CoordinationStore | undefined,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-demo-"));
  try {
    const fixture: BenchmarkFixture = live
      ? await createLiveBenchmarkFixture(root, "demo", undefined, scenario)
      : await createBenchmarkFixture(root, "demo", { scenario });
    const result = await runCoordinatedFixture(
      fixture,
      store === undefined ? {} : { store },
    );
    const source = await fixture.repositories.readFile(
      fixture.repository,
      result.run.canonicalVersion.revision,
      "src/counter.js",
    );

    console.log(`Coordination demo: ${scenario.name}`);
    console.log(`${scenario.description}\n`);
    for (const conflict of result.run.conflicts) {
      console.log(
        `Conflict warning: ${conflict.taskIds.join(" <-> ")} ` +
          `(score ${conflict.score})`,
      );
      console.log(`  ${conflict.explanation}`);
    }
    for (const task of result.run.tasks) {
      console.log(
        `${task.task.id}: ${task.status}; initial decision=${task.decision.decision}` +
          (task.status === "integrated" ? "" : `; ${task.explanation}`),
      );
    }
    console.log(
      `\nCanonical version ${result.run.canonicalVersion.sequence} ` +
        `(${result.run.canonicalVersion.revision.slice(0, 12)})`,
    );
    console.log(`Audit events: ${result.run.audit.length}`);
    if (store !== undefined) {
      const runs = await store.listRuns(1);
      console.log(
        `Recorded run: ${runs[0]?.id ?? "unknown"} ` +
          `(coord history ${runs[0]?.id ?? ""})`,
      );
    }
    console.log(
      fixture.sandbox === undefined
        ? "Workspace isolation: git-worktree (local proof only)"
        : "Workspace isolation: git-worktree on the host, agent process in Docker",
    );
    if (fixture.liveAgent !== undefined) {
      const targets = fixture.liveAgent.taskIds;
      console.log(
        `Live agent: ${fixture.liveAgent.command} for ` +
          `${targets === "all" ? "every task" : targets.join(", ")}`,
      );
    }
    console.log("\nFinal src/counter.js:\n");
    console.log(source.trimEnd());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runHistory(
  runId: string | undefined,
  flags: readonly string[],
): Promise<void> {
  const store = openStore(flags, "db");
  const asJson = flags.includes("--json");
  try {
    if (runId === undefined) {
      const runs = await store.listRuns();
      if (asJson) {
        console.log(JSON.stringify(runs, undefined, 2));
        return;
      }
      if (runs.length === 0) {
        console.log("No recorded runs. Use `coord demo --persist` to record one.");
        return;
      }

      console.log(
        ["Run".padEnd(42), "Scenario".padEnd(12), "Status".padEnd(11), "Started"].join(""),
      );
      for (const run of runs) {
        console.log(
          [
            run.id.padEnd(42),
            (run.scenario ?? "-").padEnd(12),
            run.status.padEnd(11),
            run.startedAt,
          ].join(""),
        );
      }
      return;
    }

    const detail = await store.getRun(runId);
    if (detail === undefined) {
      throw new Error(`Unknown run: ${runId}`);
    }
    if (asJson) {
      console.log(JSON.stringify(detail, undefined, 2));
      return;
    }

    console.log(
      `Run ${detail.run.id} (${detail.run.scenario ?? "no scenario"}) ` +
        `${detail.run.status}`,
    );
    console.log(
      `Base ${detail.run.baseRevision.slice(0, 12)} -> ` +
        `${detail.run.finalRevision?.slice(0, 12) ?? "unchanged"}\n`,
    );

    console.log("Tasks:");
    for (const task of detail.tasks) {
      console.log(
        `  ${task.id.padEnd(24)} ${task.status.padEnd(11)} ` +
          `${task.decision?.decision ?? "-"}` +
          (task.explanation === undefined ? "" : ` - ${task.explanation}`),
      );
    }

    if (detail.conflicts.length > 0) {
      console.log("\nConflicts:");
      for (const conflict of detail.conflicts) {
        console.log(
          `  ${conflict.taskIds.join(" <-> ")} score ${conflict.score} ` +
            `(${conflict.disposition})`,
        );
      }
    }

    console.log("\nIntegrations:");
    for (const integration of detail.integrations) {
      console.log(
        `  ${integration.taskId.padEnd(24)} ${integration.status.padEnd(18)} ` +
          `${integration.explanation}`,
      );
    }

    console.log(`\nChangesets: ${detail.changeSets.length}`);
    for (const changeSet of detail.changeSets) {
      console.log(
        `  ${changeSet.taskId.padEnd(24)} ` +
          `${changeSet.patches.map((patch) => patch.path).join(", ")}`,
      );
    }

    console.log(`\nPlan revisions: ${detail.planRevisions.length}`);
    for (const revision of detail.planRevisions) {
      console.log(
        `  ${revision.taskId.padEnd(24)} r${String(revision.revision).padEnd(3)} ` +
          `${revision.reason.padEnd(18)} ${revision.canonicalRevision.slice(0, 12)}`,
      );
    }

    console.log(`\nScope changes: ${detail.scopeChanges.length}`);
    for (const scope of detail.scopeChanges) {
      console.log(
        `  ${scope.request.taskId.padEnd(24)} ` +
          `${(scope.decision?.decision ?? "pending").padEnd(27)} ` +
          `${scope.request.reason}`,
      );
    }

    console.log(`\nApprovals: ${detail.approvals.length}`);
    for (const approval of detail.approvals) {
      console.log(
        `  ${approval.id.padEnd(42)} ${approval.status.padEnd(10)} ` +
          `${approval.kind}`,
      );
    }

    console.log(`\nAudit events: ${detail.audit.length}`);
  } finally {
    await store.close();
  }
}

/** Opens the project rooted at the current directory and its store together. */
async function withProject<T>(
  run: (
    project: CoordinatorProject,
    store: CoordinationStore,
  ) => Promise<T>,
): Promise<T> {
  const project = await CoordinatorProject.open(process.cwd());
  const store = project.openStore();
  try {
    return await run(project, store);
  } finally {
    await store.close();
  }
}

async function runInit(): Promise<void> {
  const project = await CoordinatorProject.init(process.cwd());
  const store = project.openStore();
  await store.close();
  console.log(`Initialized ${project.directory}`);
  console.log(`Configure agents and validation commands in ${project.configPath}`);
}

async function runRepo(
  subcommand: string | undefined,
  positional: readonly string[],
  flags: readonly string[],
): Promise<void> {
  switch (subcommand) {
    case "add": {
      const sourcePath = positional[0];
      if (sourcePath === undefined) {
        throw new Error("Usage: coord repo add <path> [--id=<name>]");
      }
      await withProject(async (project, store) => {
        const id = flagValue(flags, "id");
        const branch = flagValue(flags, "branch");
        const repository = await repoAdd(project, store, {
          sourcePath,
          ...(id === undefined ? {} : { id }),
          ...(branch === undefined ? {} : { branch }),
          setDefault: flags.includes("--default"),
        });
        console.log(
          `Registered ${repository.id} (branch ${repository.branch})\n` +
            `Canonical mirror: ${repository.path}`,
        );
        if (project.config.defaultRepository === repository.id) {
          console.log(`Default repository is now ${repository.id}`);
        }
      });
      break;
    }
    case "github": {
      const repositoryName = positional[0];
      if (repositoryName === undefined) {
        throw new Error(
          "Usage: coord repo github <owner/name|url> [--id=<name>]",
        );
      }
      await withProject(async (project, store) => {
        const id = flagValue(flags, "id");
        const branch = flagValue(flags, "branch");
        const repository = await repoImportGitHub(project, store, {
          repository: repositoryName,
          ...(id === undefined ? {} : { id }),
          ...(branch === undefined ? {} : { branch }),
          ...(process.env["GITHUB_TOKEN"] === undefined
            ? {}
            : { token: process.env["GITHUB_TOKEN"] }),
          setDefault: flags.includes("--default"),
        });
        console.log(
          `Imported GitHub repository ${repository.id} ` +
            `(branch ${repository.branch})\nCanonical mirror: ${repository.path}`,
        );
      });
      break;
    }
    case "push": {
      await withProject(async (project, store) => {
        const repositoryId = flagValue(flags, "repo");
        const targetBranch = flagValue(flags, "branch");
        const remoteUrl = flagValue(flags, "remote");
        const result = await repoPush(project, store, {
          ...(repositoryId === undefined ? {} : { repositoryId }),
          ...(targetBranch === undefined ? {} : { targetBranch }),
          ...(remoteUrl === undefined ? {} : { remoteUrl }),
          allowExistingTarget: flags.includes("--update-existing"),
          allowUnverifiedUpstream: flags.includes("--allow-unverified"),
        });
        console.log(
          `Pushed ${result.revision.slice(0, 12)} to ${result.targetBranch}
` +
            `Remote: ${result.remoteUrl}
` +
            `${result.createdBranch ? "Created" : "Updated"} the target branch; ` +
            `${result.upstreamBranch} was not modified.`,
        );
      });
      break;
    }
    case "list":
      await withProject(async (project, store) => {
        const repositories = await store.listRepositories();
        if (repositories.length === 0) {
          console.log("No repositories registered. Use `coord repo add <path>`.");
          return;
        }
        for (const repository of repositories) {
          const marker =
            repository.id === project.config.defaultRepository ? "*" : " ";
          console.log(
            `${marker} ${repository.id.padEnd(24)} ${repository.branch.padEnd(12)} ${repository.path}`,
          );
        }
      });
      break;
    default:
      throw new Error(`Unknown repo subcommand: ${subcommand ?? "(none)"}`);
  }
}

async function runTask(
  subcommand: string | undefined,
  positional: readonly string[],
  flags: readonly string[],
): Promise<void> {
  switch (subcommand) {
    case "submit": {
      const objective = flagValue(flags, "objective");
      if (objective === undefined) {
        throw new Error(
          'Usage: coord task submit --objective="<what the agent should do>"',
        );
      }
      await withProject(async (project, store) => {
        const repo = flagValue(flags, "repo");
        const agent = flagValue(flags, "agent");
        const task = await taskSubmit(project, store, {
          objective,
          ...(repo === undefined ? {} : { repositoryId: repo }),
          ...(agent === undefined ? {} : { agentId: agent }),
        });
        console.log(
          `Submitted ${task.id}\n` +
            `  repository ${task.repositoryId}\n` +
            `  agent      ${task.agentId}\n` +
            `  objective  ${task.objective}\n\n` +
            "Run `coord run` to execute pending tasks.",
        );
      });
      break;
    }
    case "list":
      await withProject(async (_project, store) => {
        const repo = flagValue(flags, "repo");
        const statusValue = flagValue(flags, "status");
        const statuses: readonly SubmittedTaskStatus[] = [
          "submitted",
          "claimed",
          "integrated",
          "failed",
          "cancelled",
        ];
        const status =
          statusValue === undefined
            ? undefined
            : statuses.find((entry) => entry === statusValue);
        if (statusValue !== undefined && status === undefined) {
          throw new Error(
            `Unknown task status: ${statusValue}. Expected ${statuses.join(", ")}.`,
          );
        }
        const tasks = await store.listSubmittedTasks({
          ...(repo === undefined ? {} : { repositoryId: repo }),
          ...(status === undefined ? {} : { status }),
        });
        if (tasks.length === 0) {
          console.log("No tasks match.");
          return;
        }
        console.log(
          ["Task".padEnd(42), "Status".padEnd(12), "Agent".padEnd(16), "Objective"].join(""),
        );
        for (const task of tasks) {
          console.log(
            [
              task.id.padEnd(42),
              task.status.padEnd(12),
              task.agentId.padEnd(16),
              task.objective,
            ].join(""),
          );
        }
      });
      break;
    case "retry": {
      const taskId = positional[0];
      if (taskId === undefined) {
        throw new Error("Usage: coord task retry <task-id>");
      }
      await withProject(async (_project, store) => {
        const task = await taskRetry(store, taskId);
        console.log(`Returned ${task.id} to the submitted queue.`);
      });
      break;
    }
    case "cancel": {
      const taskId = positional[0];
      if (taskId === undefined) {
        throw new Error("Usage: coord task cancel <task-id>");
      }
      await withProject(async (_project, store) => {
        const task = await taskCancel(store, taskId);
        console.log(`Cancelled ${task.id}.`);
      });
      break;
    }
    default:
      throw new Error(`Unknown task subcommand: ${subcommand ?? "(none)"}`);
  }
}

const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
];

async function runApproval(
  subcommand: string | undefined,
  positional: readonly string[],
  flags: readonly string[],
): Promise<void> {
  await withProject(async (_project, store) => {
    if (subcommand === "list") {
      const statusValue = flagValue(flags, "status");
      const status =
        statusValue === undefined
          ? undefined
          : APPROVAL_STATUSES.find((entry) => entry === statusValue);
      if (statusValue !== undefined && status === undefined) {
        throw new Error(
          `Unknown approval status: ${statusValue}. Expected ${APPROVAL_STATUSES.join(", ")}.`,
        );
      }
      const approvals = await store.listApprovals(
        status === undefined ? {} : { status },
      );
      if (flags.includes("--json")) {
        console.log(JSON.stringify(approvals, undefined, 2));
        return;
      }
      if (approvals.length === 0) {
        console.log("No approvals match.");
        return;
      }
      console.log(
        [
          "Approval".padEnd(42),
          "Status".padEnd(11),
          "Kind".padEnd(18),
          "Task",
        ].join(""),
      );
      for (const approval of approvals) {
        console.log(
          [
            approval.id.padEnd(42),
            approval.status.padEnd(11),
            approval.kind.padEnd(18),
            approval.taskId,
          ].join(""),
        );
      }
      return;
    }

    const approvalId = positional[0];
    if (approvalId === undefined) {
      throw new Error(
        `Usage: coord approval ${subcommand ?? "show"} <approval-id>`,
      );
    }
    const approval = await store.getApproval(approvalId);
    if (approval === undefined) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }
    if (subcommand === "show") {
      const detail = await store.getRun(approval.runId);
      const changeSet = detail?.changeSets.find(
        (entry) => entry.id === approval.changeSetId,
      );
      if (flags.includes("--json")) {
        console.log(JSON.stringify({ approval, changeSet }, undefined, 2));
        return;
      }
      console.log(
        `Approval ${approval.id}\n` +
          `  status   ${approval.status}\n` +
          `  kind     ${approval.kind}\n` +
          `  task     ${approval.taskId}\n` +
          `  expires  ${approval.expiresAt}\n` +
          `  reasons  ${approval.reasons.join("; ")}`,
      );
      if (changeSet !== undefined) {
        console.log(`\nAgent explanation:\n${changeSet.agentExplanation}`);
        for (const patch of changeSet.patches) {
          console.log(`\n--- ${patch.path} (${patch.status}) ---\n${patch.patch}`);
        }
      }
      return;
    }
    if (subcommand !== "approve" && subcommand !== "reject") {
      throw new Error(`Unknown approval subcommand: ${subcommand ?? "(none)"}`);
    }
    const actor =
      flagValue(flags, "actor") ??
      process.env["USERNAME"] ??
      process.env["USER"] ??
      "local-operator";
    const comment =
      flagValue(flags, "comment") ??
      `${subcommand === "approve" ? "Approved" : "Rejected"} through the local CLI`;
    const decided = await store.decideApproval({
      approvalId,
      status: subcommand === "approve" ? "approved" : "rejected",
      decidedBy: actor,
      comment,
      decidedAt: new Date().toISOString(),
    });
    await store.appendAudit(approval.runId, {
      type: "approval_decided",
      taskId: approval.taskId,
      data: {
        approvalId,
        projectId: approval.projectId,
        status: decided.status,
        actorId: actor,
        comment,
      },
    });
    console.log(
      `${decided.status === "approved" ? "Approved" : "Rejected"} ${approvalId} as ${actor}.`,
    );
  });
}

async function runDoctor(): Promise<void> {
  await withProject(async (project, store) => {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    try {
      const git = await runProcess("git", ["--version"], {
        timeoutMs: 5_000,
        maxOutputBytes: 8_192,
      });
      checks.push({
        name: "Git",
        ok: git.exitCode === 0,
        detail: git.stdout.trim() || git.stderr.trim(),
      });
    } catch (error) {
      checks.push({
        name: "Git",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const audit = await store.verifyAudit();
    checks.push({
      name: "Audit",
      ok: audit.valid,
      detail: audit.valid
        ? `${audit.events} chained event(s)`
        : audit.reason ?? "audit chain is invalid",
    });
    const agents = Object.keys(project.config.agents);
    checks.push({
      name: "Agents",
      ok: agents.length > 0,
      detail:
        agents.length > 0
          ? agents.join(", ")
          : "No agents configured in .coordinator/config.json",
    });
    const repositories = await store.listRepositories();
    checks.push({
      name: "Repositories",
      ok: repositories.length > 0,
      detail:
        repositories.length > 0
          ? repositories.map((entry) => entry.id).join(", ")
          : "No canonical repositories imported",
    });
    if (project.config.sandbox !== undefined) {
      try {
        const docker = await runProcess("docker", ["version", "--format", "{{.Server.Version}}"], {
          timeoutMs: 5_000,
          maxOutputBytes: 8_192,
        });
        checks.push({
          name: "Docker",
          ok: docker.exitCode === 0,
          detail: docker.stdout.trim() || docker.stderr.trim(),
        });
      } catch (error) {
        checks.push({
          name: "Docker",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const check of checks) {
      console.log(
        `${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(14)} ${check.detail}`,
      );
    }
    if (checks.some((check) => !check.ok)) {
      process.exitCode = 1;
    }
  });
}

async function runPending(flags: readonly string[]): Promise<void> {
  await withProject(async (project, store) => {
    const repo = flagValue(flags, "repo");
    const repository = await resolveRepository(project, store, repo);
    console.log(`Running pending tasks for ${repository.id}...\n`);

    const summary = await runPendingTasks(project, store, {
      ...(repo === undefined ? {} : { repositoryId: repo }),
    });

    if (summary.claimed.length === 0) {
      console.log("No pending tasks. Use `coord task submit` to add one.");
      return;
    }

    console.log(
      `Executed ${summary.claimed.length} task(s): ` +
        `${summary.integrated} integrated, ${summary.failed} failed`,
    );
    if (summary.conflicts > 0) {
      console.log(`Conflict warnings: ${summary.conflicts}`);
    }
    console.log(`Canonical is now ${summary.finalRevision.slice(0, 12)}`);
    if (summary.runId !== undefined) {
      console.log(`\ncoord history ${summary.runId}`);
    }
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  });
}

async function runVerifyAudit(flags: readonly string[]): Promise<void> {
  const store = openStore(flags, "db");
  try {
    const verification = await store.verifyAudit();
    if (verification.valid) {
      console.log(
        `Audit chain intact across ${verification.events} event(s).`,
      );
      return;
    }
    console.error(
      `Audit chain broken at event ${verification.brokenAt} of ` +
        `${verification.events}: ${verification.reason}`,
    );
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}

/** Fails fast so a `--live` run never silently falls back to scripted agents. */
function requireLiveAgentConfig(): LiveAgentConfig {
  const config = readLiveAgentConfig();
  if (config === undefined) {
    throw new Error(
      "--live requires COORD_AGENT_CMD to name the agent executable",
    );
  }
  return config;
}

async function main(): Promise<void> {
  const [command = "help", ...flags] = process.argv.slice(2);
  const live = flags.includes("--live");
  const positional = flags.filter((entry) => !entry.startsWith("--"));
  switch (command) {
    case "init":
      await runInit();
      break;
    case "repo":
      await runRepo(positional[0], positional.slice(1), flags);
      break;
    case "task":
      await runTask(positional[0], positional.slice(1), flags);
      break;
    case "approval":
      await runApproval(positional[0], positional.slice(1), flags);
      break;
    case "doctor":
      await runDoctor();
      break;
    case "run":
      await runPending(flags);
      break;
    case "demo": {
      const persist = flags.some((entry) => entry.startsWith("--persist"));
      const store = persist ? openStore(flags, "persist") : undefined;
      try {
        await runDemo(live, selectScenario(flags), store);
      } finally {
        await store?.close();
      }
      break;
    }
    case "history":
      // A run id, when present, is the only positional argument.
      await runHistory(
        flags.find((entry) => !entry.startsWith("--")),
        flags,
      );
      break;
    case "verify-audit":
      await runVerifyAudit(flags);
      break;
    case "benchmark": {
      const scenario = selectScenario(flags);
      const repeat = selectRepeat(flags);
      const liveAgent = live ? requireLiveAgentConfig() : undefined;
      const reports = [];

      for (let run = 1; run <= repeat; run += 1) {
        const root = await mkdtemp(path.join(os.tmpdir(), "coord-benchmark-"));
        try {
          const report = await runBenchmark(root, {
            scenario,
            ...(liveAgent === undefined ? {} : { liveAgent }),
          });
          reports.push(report);
          if (!flags.includes("--json")) {
            printBenchmarkTable(report, repeat === 1 ? undefined : run);
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }

      if (flags.includes("--json")) {
        console.log(
          JSON.stringify(repeat === 1 ? reports[0] : reports, undefined, 2),
        );
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : error;
  console.error(message);
  process.exitCode = 1;
});
