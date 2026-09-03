/**
 * The tools Kumi offers over MCP.
 *
 * Kept out of `server.ts`, which is already 25,000 lines, and reached through a
 * narrow set of callbacks rather than the gateway itself — so the decisions
 * here can be tested without standing up an HTTP server, and so it is obvious
 * from the interface below exactly how much of the control plane a tool can
 * touch.
 *
 * ### What these are for
 *
 * Somebody is in Claude Code or Cursor and wants Kumi to do something. They are
 * not looking at Kumi and will not open it. That shapes every choice here:
 *
 * - **Names, not ids.** A person says "the payments repo", not
 *   `repo_9f3a…`. Ids are accepted, names are what the tools are for.
 * - **A refusal is a sentence.** Everything that goes wrong comes back as text
 *   the model can read out and act on, because the person cannot go and look.
 * - **Nothing half-happens.** A tool either did the thing or did not, and says
 *   which. The one case that cannot be decided without asking — an agent whose
 *   machine is offline — writes nothing at all and asks.
 */

import type {
  CoordinationStore,
  StoredRepository,
  SubmittedTask,
} from "@coord/persistence";

import {
  McpArgumentError,
  mcpRefusal,
  mcpText,
  optionalChoice,
  optionalString,
  requiredString,
  type McpTool,
} from "./mcp.js";
import { takenTaskBrief, type McpTakenTask } from "./mcp-work.js";

/** An agent as a person in an editor needs to see it. */
export interface McpAgent {
  readonly name: string;
  /** Whether its owner has a machine listening right now. */
  readonly online: boolean;
  readonly owner: string;
  /** The CLI behind it: `claude`, `codex`, and so on. */
  readonly vendor?: string;
  /** Whether it belongs to the person holding this connection. */
  readonly mine: boolean;
}

/** A repository the caller can reach, with the roster of its default room. */
export interface McpRepository {
  readonly projectId: string;
  readonly repository: StoredRepository;
  readonly agents: readonly McpAgent[];
}

/** What one submitted message started. */
export interface McpPostResult {
  readonly taskIds: readonly string[];
  readonly channelSlug: string;
}

/**
 * Everything these tools may do.
 *
 * Deliberately small, and deliberately not the gateway: a tool cannot reach
 * anything that is not on this list, and adding to the list is a visible act.
 */
export interface McpToolDeps {
  readonly store: CoordinationStore;
  /** Refuses unless the caller's token carries this permission. */
  assertScope(permission: string): void;
  /**
   * Which editor is on the other end, from its own token.
   *
   * The reason `submit_task` no longer makes the model name an agent. See
   * `editorBehind` in `mcp-work.ts`.
   */
  callerEditor(): string | undefined;
  /**
   * Takes a task this caller has just filed, so the editor that asked for
   * the work can be the one that does it. Absent on a deployment that cannot
   * run tasks at all, where filing is still perfectly useful.
   */
  takeFiledTask?(taskId: string): Promise<McpTakenTask | undefined>;
  /** Every repository this caller may see, across their projects. */
  listRepositories(): Promise<McpRepository[]>;
  /** The mentionable roster of one room, with liveness. */
  agentsIn(input: {
    projectId: string;
    repositoryId: string;
    channel?: string;
  }): Promise<McpAgent[]>;
  /** Posts into a channel as the caller and dispatches what it mentions. */
  post(input: {
    projectId: string;
    repositoryId: string;
    channel?: string;
    content: string;
  }): Promise<McpPostResult>;
  /** Status → plain English, shared with the rest of the control plane. */
  describeState(status: string): string;
  /** The last few things an agent said it was doing. */
  progressFor(taskId: string, limit: number): Promise<string[]>;
  /** How a task ended, when it has. */
  outcomeFor(taskId: string): Promise<string | undefined>;
  /** A question this task is waiting on, if the caller is the one being asked. */
  pendingQuestionFor(taskId: string): Promise<McpPendingQuestion | undefined>;
  /** Answers a waiting question, or says why it could not. */
  answerQuestion(input: {
    requestId: string;
    answers: ReadonlyArray<{ chosen?: number; text?: string }>;
  }): Promise<"answered" | "not_waiting">;
  /** Stops a task, or says why it could not. */
  cancelTask(taskId: string): Promise<
    "cancelled" | "not_found" | "not_yours" | "already_finished"
  >;
}

/** A question an agent is holding a run open for. */
export interface McpPendingQuestion {
  readonly requestId: string;
  readonly questions: ReadonlyArray<{
    readonly question: string;
    readonly options: readonly string[];
    readonly recommended?: number;
  }>;
}

/** The user-visible id of a repository, which is its name. */
function repositoryLabel(entry: McpRepository): string {
  return entry.repository.id;
}

/**
 * Finds the repository a caller meant.
 *
 * By id first, then by a case-insensitive name match, because a model reading
 * `list_repositories` will echo back whatever it was shown and a person typing
 * freehand will not match case. An ambiguous name is refused rather than
 * guessed: dispatching work into the wrong repository is not a mistake anyone
 * can see from an editor.
 */
async function findRepository(
  deps: McpToolDeps,
  named: string,
): Promise<McpRepository> {
  const all = await deps.listRepositories();
  if (all.length === 0) {
    throw new McpArgumentError(
      "This account can reach no repositories. Add one in Kumi first.",
    );
  }
  const exact = all.filter((entry) => repositoryLabel(entry) === named);
  const loose =
    exact.length > 0
      ? exact
      : all.filter(
          (entry) =>
            repositoryLabel(entry).toLowerCase() === named.toLowerCase(),
        );
  if (loose.length === 1) {
    return loose[0] as McpRepository;
  }
  if (loose.length === 0) {
    throw new McpArgumentError(
      `No repository called "${named}". This account can reach: ${all
        .map(repositoryLabel)
        .join(", ")}.`,
    );
  }
  throw new McpArgumentError(
    `"${named}" matches more than one repository. Name one exactly: ${loose
      .map((entry) => `${repositoryLabel(entry)} (project ${entry.projectId})`)
      .join(", ")}.`,
  );
}

/** Rewrites `@offline` to `@online`, the way the room's own prompt does. */
function rerouteMention(content: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return content.replace(
    new RegExp(`@${escaped}(?=$|[\\s,.:;!?()\\[\\]{}])`, "giu"),
    `@${to}`,
  );
}

const OFFLINE_CHOICES = ["queue", "reroute", "cancel"] as const;

/**
 * The three tools that make this worth installing, plus the two that make it
 * usable once installed.
 */
export function createMcpTools(deps: McpToolDeps): McpTool[] {
  const listRepositories: McpTool = {
    name: "list_repositories",
    title: "List repositories",
    description:
      "Lists the Kumi repositories this account can reach, and for each one " +
      "the agents that can be given work there and whether each agent's " +
      "machine is currently online. Call this first when you do not already " +
      "know a repository name or an agent name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      deps.assertScope("view");
      const all = await deps.listRepositories();
      if (all.length === 0) {
        return mcpText("This account can reach no repositories.");
      }
      // The roster travels with the repository because there is no
      // `list_agents`: without it a model cannot answer the question
      // `submit_task` asks it when an agent is offline.
      const lines = all.map((entry) => {
        const roster =
          entry.agents.length === 0
            ? "    no agents in this repository yet"
            : entry.agents
                .map((agent) => {
                  // The display name usually already carries the owner —
                  // "Claude (Nathan)" — and printing it twice reads as two
                  // different facts about the same agent.
                  const owner = agent.name.includes(agent.owner)
                    ? ""
                    : `, ${agent.owner}'s`;
                  return `    @${agent.name} — ${
                    agent.online ? "online" : "offline"
                  }${owner}`;
                })
                .join("\n");
        return `${repositoryLabel(entry)}\n${roster}`;
      });
      return mcpText(lines.join("\n\n"));
    },
  };

  const submitTask: McpTool = {
    name: "submit_task",
    title: "Give Kumi a task",
    description:
      "Asks a Kumi agent to do a piece of work in a repository. The task " +
      "appears in that repository's channel so the rest of the team can see " +
      "it, and runs on the agent owner's own machine. Returns a task id to " +
      "follow with task_status.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description: "Repository name, as list_repositories reports it.",
        },
        agent: {
          type: "string",
          description:
            "Optional. Which agent should do it, without the @. Leave it " +
            "out and Kumi gives the work to the agent for this editor, " +
            "which is almost always what the person meant. Name one only " +
            "when they asked for somebody else.",
        },
        objective: {
          type: "string",
          description: "What you want done, in plain language.",
        },
        channel: {
          type: "string",
          description:
            "Optional channel to post in. Defaults to the repository's main room.",
        },
        when_offline: {
          type: "string",
          enum: [...OFFLINE_CHOICES],
          description:
            "What to do if the agent's machine is offline. Omit on the first " +
            "call: the tool will tell you it is offline and let you ask the " +
            "person. 'queue' files it to run when the machine returns, " +
            "'reroute' sends it to the agent named in reroute_to instead, " +
            "'cancel' means do not call again.",
        },
        reroute_to: {
          type: "string",
          description: "Agent to send it to instead, when when_offline is 'reroute'.",
        },
      },
      required: ["repository", "objective"],
      additionalProperties: false,
    },
    async run(args) {
      deps.assertScope("submit_task");
      const named = requiredString(args, "repository", 200);
      const agentName = optionalString(args, "agent", 200)?.replace(/^@/u, "");
      const objective = requiredString(args, "objective");
      const channel = optionalString(args, "channel", 200)?.replace(/^#/u, "");
      const whenOffline = optionalChoice(args, "when_offline", OFFLINE_CHOICES);
      const rerouteTo = optionalString(args, "reroute_to", 200)?.replace(
        /^@/u,
        "",
      );

      if (whenOffline === "cancel") {
        return mcpText("Nothing was submitted.");
      }
      // A leading slash is a channel command, not an objective, and the room
      // would run it instead of dispatching work — returning success for a
      // task that was never created. Refused where it can still be explained.
      if (objective.startsWith("/")) {
        return mcpRefusal(
          "An objective cannot start with '/' — that is a Kumi channel " +
            "command. Describe the work instead.",
        );
      }
      if (agentName?.toLowerCase() === "agents") {
        return mcpRefusal(
          "@agents addresses everyone in the room and does not start work. " +
            "Name one agent; list_repositories shows who is there.",
        );
      }

      const found = await findRepository(deps, named);
      const roster = await deps.agentsIn({
        projectId: found.projectId,
        repositoryId: found.repository.id,
        ...(channel === undefined ? {} : { channel }),
      });
      // Nobody named. This used to be impossible — the argument was required
      // — and that was the bug: a person who names no agent has expressed no
      // preference, and the model, forced to fill the field in, picked one
      // off the roster. Work typed into Codex was run by Claude, and nothing
      // anywhere had made that decision on purpose.
      //
      // The order below is what a person means, in the order they mean it.
      const editor = deps.callerEditor();
      const own =
        editor === undefined
          ? undefined
          : roster.find((agent) => agent.mine && agent.vendor === editor);
      const target =
        agentName === undefined
          ? (own ??
            // No editor to fall back on. One agent in the room is not a
            // guess; more than one is, so it asks.
            (roster.length === 1 ? roster[0] : undefined))
          : roster.find(
              (agent) => agent.name.toLowerCase() === agentName.toLowerCase(),
            );
      if (target === undefined && agentName === undefined) {
        return mcpText(
          roster.length === 0
            ? `No agents are in ${repositoryLabel(found)} yet. Add one in Kumi first.`
            : [
                `Who should do this in ${repositoryLabel(found)}?`,
                "",
                ...roster.map(
                  (agent) =>
                    `  @${agent.name} (${agent.owner})${
                      agent.online ? "" : " — offline"
                    }`,
                ),
                "",
                "Ask the person, then call submit_task again with agent set.",
              ].join("\n"),
        );
      }
      if (target === undefined) {
        return mcpRefusal(
          roster.length === 0
            ? `No agents are in ${repositoryLabel(found)} yet. Add one in Kumi first.`
            : `No agent called "${agentName ?? ""}" in ${repositoryLabel(
                found,
              )}. You can address: ${roster
                .map((agent) => `@${agent.name}`)
                .join(", ")}.`,
        );
      }

      let addressed = target;
      if (whenOffline === "reroute") {
        if (rerouteTo === undefined) {
          throw new McpArgumentError(
            "reroute_to is required when when_offline is 'reroute'",
          );
        }
        const replacement = roster.find(
          (agent) => agent.name.toLowerCase() === rerouteTo.toLowerCase(),
        );
        if (replacement === undefined) {
          return mcpRefusal(
            `No agent called "${rerouteTo}" in ${repositoryLabel(found)}.`,
          );
        }
        addressed = replacement;
      }

      // Checked here rather than left to the dispatch, which files the task
      // and says so in a thread nobody in this conversation is reading. The
      // window is three minutes wide and advisory — re-checked on the second
      // call, so an agent that came back in the meantime is simply used.
      // The caller's own editor is, by definition, at the keyboard: it is the
      // thing asking. Sending it down the offline exchange would be telling
      // somebody their machine is not listening while they are typing into
      // it, and the first prompt of a session would always take that path,
      // because presence is only declared once an editor takes work.
      const mine = addressed === own;
      if (!mine && !addressed.online && whenOffline === undefined) {
        const alternatives = roster.filter(
          (agent) => agent.online && agent.name !== addressed.name,
        );
        return mcpText(
          [
            `@${addressed.name}'s machine is offline, so nothing was submitted yet.`,
            "",
            "Ask which they would like:",
            "  • queue — file it now and run it when that machine comes back",
            alternatives.length === 0
              ? "  • reroute — nobody else in this room is online right now"
              : `  • reroute — send it to one of: ${alternatives
                  .map((agent) => `@${agent.name}`)
                  .join(", ")}`,
            "  • cancel — do nothing",
            "",
            "Then call submit_task again with the same arguments plus " +
              "when_offline set to their answer.",
          ].join("\n"),
        );
      }

      const content =
        addressed.name === target.name
          ? `@${target.name} ${objective}`
          : rerouteMention(`@${target.name} ${objective}`, target.name, addressed.name);
      const posted = await deps.post({
        projectId: found.projectId,
        repositoryId: found.repository.id,
        ...(channel === undefined ? {} : { channel }),
        content,
      });
      if (posted.taskIds.length === 0) {
        // The message is durably posted, so this is not a lie either way —
        // but it is the one case where "sent" would be misleading, and the
        // person needs to know their work has not started.
        return mcpRefusal(
          `Posted in #${posted.channelSlug}, but no task started. ` +
            `@${addressed.name} may be a personal agent belonging to somebody ` +
            `else. Open Kumi to see what it said.`,
        );
      }
      const taskId = posted.taskIds[0] ?? "";
      // Filed, and then taken back, when the agent that was asked is the one
      // asking. A prompt typed into Codex should be done by Codex: the person
      // is sitting in front of it, it is signed in, and handing the work to
      // some other process is the surprise this whole path exists to remove.
      //
      // The message is still posted first, and that ordering is the point:
      // the room sees the work either way, and the thread follows it exactly
      // as it would have. What changes is who picks it up, not whether
      // anybody else can see it.
      if (mine && deps.takeFiledTask !== undefined) {
        const taken = await deps.takeFiledTask(taskId).catch(() => undefined);
        if (taken !== undefined) {
          return mcpText(
            [
              `Filed in #${posted.channelSlug} and taken by you, because it ` +
                `was addressed to @${addressed.name}. Do it here.`,
              "",
              takenTaskBrief(taken),
            ].join("\n"),
          );
        }
        // Something else got there first, or this deployment cannot lease.
        // Not an error: the task is real and filed, and saying where it went
        // beats reporting a failure for work that started fine.
        return mcpText(
          `Sent to @${addressed.name} in #${posted.channelSlug}. Task ${taskId}. ` +
            "Something else picked it up before you could; task_status follows it.",
        );
      }
      return mcpText(
        [
          `Sent to @${addressed.name} in #${posted.channelSlug}.`,
          `Task ${taskId}.`,
          addressed.online
            ? "It is running on their machine now."
            : "Queued — it will start when their machine comes back.",
        ].join(" "),
      );
    },
  };

  const taskStatus: McpTool = {
    name: "task_status",
    title: "Check a Kumi task",
    description:
      "Reports where a Kumi task has got to: whether it is queued, running or " +
      "finished, the last few things the agent said it was doing, and how it " +
      "ended.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The id submit_task returned." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async run(args) {
      deps.assertScope("view");
      const taskId = requiredString(args, "task_id", 200);
      const task = await deps.store.getSubmittedTask(taskId);
      if (task === undefined) {
        return mcpRefusal(`No task called "${taskId}".`);
      }
      const [progress, outcome, waiting] = await Promise.all([
        deps.progressFor(task.id, 3),
        deps.outcomeFor(task.id),
        deps.pendingQuestionFor(task.id),
      ]);
      const lines = [
        `${task.objective}`,
        `Status: ${deps.describeState(task.status)}`,
      ];
      if (progress.length > 0) {
        lines.push("", "Latest:", ...progress.map((entry) => `  ${entry}`));
      }
      if (outcome !== undefined) {
        lines.push("", outcome);
      }
      // Surfaced here because there is nowhere else it could be. A run that has
      // asked something is stopped until somebody answers, and from an editor
      // this is the only place that fact can appear — without it the task
      // simply looks stuck, and `answer_question` has no request id to use.
      if (waiting !== undefined) {
        lines.push("", `Waiting for an answer (request ${waiting.requestId}):`);
        waiting.questions.forEach((question, index) => {
          lines.push(`  ${index + 1}. ${question.question}`);
          question.options.forEach((option, choice) => {
            const recommended =
              question.recommended === choice ? "  (recommended)" : "";
            lines.push(`       [${choice}] ${option}${recommended}`);
          });
        });
        lines.push(
          "",
          "Ask the person, then call answer_question with the numbers in " +
            "brackets — one per question, in order.",
        );
      }
      return mcpText(lines.join("\n"));
    },
  };

  const cancelTask: McpTool = {
    name: "cancel_task",
    title: "Stop a Kumi task",
    description:
      "Stops a task you submitted — the queued row, the running agent and its " +
      "lease. Only tasks you submitted yourself can be stopped this way.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The id submit_task returned." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async run(args) {
      // Deliberately not `run_task`, which the dashboard's own cancel route
      // uses. That scope is the same one `POST /workers/leases` requires, so a
      // token handed to an editor for stopping work could register as a worker
      // and lease other people's tasks. Narrower scope, plus the run has to be
      // the caller's own.
      deps.assertScope("submit_task");
      const taskId = requiredString(args, "task_id", 200);
      const outcome = await deps.cancelTask(taskId);
      if (outcome === "cancelled") {
        return mcpText(`Stopped ${taskId}.`);
      }
      if (outcome === "not_found") {
        return mcpRefusal(`No task called "${taskId}".`);
      }
      if (outcome === "not_yours") {
        return mcpRefusal(
          `${taskId} was submitted by somebody else. Stop it from Kumi, or ask them to.`,
        );
      }
      return mcpRefusal(`${taskId} has already finished.`);
    },
  };

  const answerQuestion: McpTool = {
    name: "answer_question",
    title: "Answer an agent's question",
    description:
      "Answers a question a running Kumi agent is waiting on. Call " +
      "task_status first to see the question, its numbered options and the " +
      "request id. The agent resumes as soon as this lands.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          type: "string",
          description: "The request id task_status reported.",
        },
        choices: {
          type: "array",
          items: { type: "integer" },
          description:
            "One option number per question, in the order task_status listed " +
            "them. Use -1 for a question you are answering in words instead.",
        },
        answers: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional free text, one per question, for anything the options " +
            "do not cover.",
        },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
    async run(args) {
      deps.assertScope("view");
      const requestId = requiredString(args, "request_id", 200);
      const chosen = args["choices"];
      const written = args["answers"];
      if (chosen !== undefined && !Array.isArray(chosen)) {
        throw new McpArgumentError('"choices" must be a list of numbers');
      }
      if (written !== undefined && !Array.isArray(written)) {
        throw new McpArgumentError('"answers" must be a list of strings');
      }
      const length = Math.max(
        Array.isArray(chosen) ? chosen.length : 0,
        Array.isArray(written) ? written.length : 0,
      );
      if (length === 0) {
        throw new McpArgumentError(
          "Give at least one answer — a choice number, some text, or both",
        );
      }
      const answers = Array.from({ length }, (_unused, index) => {
        const pick = Array.isArray(chosen) ? chosen[index] : undefined;
        const say = Array.isArray(written) ? written[index] : undefined;
        return {
          // -1 is how a caller says "none of these, read what I wrote". The
          // control plane already treats an out-of-range index as no choice.
          ...(typeof pick === "number" && Number.isInteger(pick) && pick >= 0
            ? { chosen: pick }
            : {}),
          ...(typeof say === "string" && say.trim().length > 0
            ? { text: say.trim() }
            : {}),
        };
      });
      const outcome = await deps.answerQuestion({ requestId, answers });
      return outcome === "answered"
        ? mcpText("Answered. The agent has picked the work back up.")
        : mcpRefusal(
            "That question is no longer waiting for an answer — it was " +
              "answered already, or the agent gave up waiting. Call " +
              "task_status to see where the task got to.",
          );
    },
  };

  return [listRepositories, submitTask, taskStatus, cancelTask, answerQuestion];
}

/** Exported for the gateway's own use when narrowing a task to its owner. */
export function taskBelongsTo(task: SubmittedTask, userId: string): boolean {
  return task.submittedBy === userId;
}
