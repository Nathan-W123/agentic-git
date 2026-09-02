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

/** An agent as a person in an editor needs to see it. */
export interface McpAgent {
  readonly name: string;
  /** Whether its owner has a machine listening right now. */
  readonly online: boolean;
  readonly owner: string;
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
          description: "Agent to address, without the @.",
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
      required: ["repository", "agent", "objective"],
      additionalProperties: false,
    },
    async run(args) {
      deps.assertScope("submit_task");
      const named = requiredString(args, "repository", 200);
      const agentName = requiredString(args, "agent", 200).replace(/^@/u, "");
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
      if (agentName.toLowerCase() === "agents") {
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
      const target = roster.find(
        (agent) => agent.name.toLowerCase() === agentName.toLowerCase(),
      );
      if (target === undefined) {
        return mcpRefusal(
          roster.length === 0
            ? `No agents are in ${repositoryLabel(found)} yet. Add one in Kumi first.`
            : `No agent called "${agentName}" in ${repositoryLabel(
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
      if (!addressed.online && whenOffline === undefined) {
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
      return mcpText(
        [
          `Sent to @${addressed.name} in #${posted.channelSlug}.`,
          `Task ${posted.taskIds[0]}.`,
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
      const [progress, outcome] = await Promise.all([
        deps.progressFor(task.id, 3),
        deps.outcomeFor(task.id),
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
      return mcpText(lines.join("\n"));
    },
  };

  return [listRepositories, submitTask, taskStatus];
}

/** Exported for the gateway's own use when narrowing a task to its owner. */
export function taskBelongsTo(task: SubmittedTask, userId: string): boolean {
  return task.submittedBy === userId;
}
