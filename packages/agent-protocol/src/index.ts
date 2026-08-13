import type {
  AgentPlan,
  CanonicalVersion,
  ChangeSet,
  ReplanRequest,
  ScopeChangeDecision,
  CoordinatorDecision,
  TaskDefinition,
} from "@coord/shared-types";

export interface AgentCapabilities {
  canPlan: boolean;
  canEditFiles: boolean;
  canRunCommands: boolean;
  canUseTools: boolean;
  supportsStreaming: boolean;
  supportsPause: boolean;
  maximumContextTokens?: number;
}

export interface StartTaskInput {
  task: TaskDefinition;
  canonicalVersion: CanonicalVersion;
  repositoryId: string;
  /**
   * What earlier work in this repository already established, rendered from
   * the handoffs those tasks left behind.
   *
   * Every task runs in a fresh process with an empty context window, so
   * without this each one rediscovers the repository from nothing — including
   * the things the last agent learned the hard way and wrote down. The
   * handoffs were being recorded at every task boundary and never read back;
   * this is the path that reads them.
   *
   * Kept out of `task.objective` deliberately. The objective is what somebody
   * asked for: it is shown in the channel, in task lists and in thread
   * titles, and prepending a wall of prior context to it would make every
   * request unreadable in the places people actually look at it.
   *
   * Advisory, never authoritative. It describes what was true at some earlier
   * revision; the workspace in front of the agent is what is true now.
   */
  priorContext?: string;
}

export interface AgentSession {
  id: string;
  agentId: string;
  taskId: string;
  startedAt: string;
}

export interface CoordinatorContext {
  decision: CoordinatorDecision;
  canonicalVersion: CanonicalVersion;
  workspacePath: string;
  planRevision?: number;
  /**
   * Present when this is a second pass over work the agent has already done,
   * because part of it collided with somebody else's change.
   *
   * The alternative is throwing the run away and having a fresh agent
   * rediscover the whole task from nothing, at roughly 145k tokens. This
   * session still has the task in context and the collision is usually a
   * couple of lines, so it is asked to redo only that.
   *
   * The named files have already been overwritten in the workspace with what
   * canonical holds now, so the agent is looking at the other change rather
   * than at its own losing copy. Everything it is not told about here landed
   * and must be left alone.
   */
  repair?: ConflictRepair;
}

export interface ConflictRepair {
  /** Files reset to canonical, for the agent to re-apply its intent to. */
  files: string[];
  /** Why they came back, in a form worth putting in front of a model. */
  reason: string;
}

export type AgentEvent =
  | {
      event: "progress";
      message: string;
      occurredAt: string;
    }
  | {
      event: "scope_change_requested";
      requestId?: string;
      additionalFiles: string[];
      additionalSymbols?: string[];
      additionalApis?: string[];
      additionalSchemas?: string[];
      additionalConfigKeys?: string[];
      additionalTests?: string[];
      additionalServices?: string[];
      reason: string;
      occurredAt: string;
    }
  | {
      /**
       * The agent is stuck on a decision that is not its to make, and has
       * stopped until somebody answers.
       *
       * Options are required and enumerated, which is the whole design. A
       * free-text question is expensive at both ends: the person has to
       * compose an answer, and the agent has to re-read prose it may
       * misunderstand. Choices make the answer one word, and make the agent
       * do the thinking *before* asking — "what should I do?" is a question
       * this shape cannot express.
       *
       * Costly in a way `progress` is not: the agent holds its workspace and
       * its ownership leases while it waits, so other work queues behind an
       * unanswered question. That is why the coordinator puts a deadline on
       * it rather than waiting as long as the run is allowed to live.
       */
      event: "question_asked";
      requestId?: string;
      question: string;
      /** At least two; one "option" is a statement, not a question. */
      options: string[];
      occurredAt: string;
    }
  | {
      /**
       * The agent is asking the platform to do something it cannot do itself,
       * and has stopped until it is told what happened.
       *
       * A name from a fixed list, never a command. The rule the list is drawn
       * from is that an agent may only request what the task's submitter could
       * do themselves, on the task's own repository — see
       * docs/architecture/agent-actions.md. An open channel here would let an
       * agent ask the platform to do what the agent itself is forbidden to do,
       * which would quietly undo scope enforcement.
       *
       * Costly the same way `question_asked` is: the workspace and the leases
       * are held while it waits.
       */
      event: "action_requested";
      requestId?: string;
      action: string;
      occurredAt: string;
    }
  | {
      /**
       * The agent has decided its approved plan is the wrong one, and is
       * offering a different one.
       *
       * Distinct from `scope_change_requested`, which asks for *more* of the
       * same plan. This says the shape was wrong — the work turned out to
       * belong in different files, or the declared approach cannot be made to
       * work. Without it, an agent that discovers this mid-task has two
       * choices and both are bad: build the thing it no longer believes in, or
       * stop and be recorded as having failed.
       *
       * Answered with a `ScopeChangeDecision`, because the answer to "may I
       * work to this plan instead" has the same shape as the answer to "may I
       * widen this plan": approved or not, and the plan now in force. The
       * requests differ; the decisions do not.
       */
      event: "replan_proposed";
      requestId?: string;
      plan: AgentPlan;
      reason: string;
      occurredAt: string;
    }
  | {
      event: "completed";
      occurredAt: string;
    };

/** What the platform did, or why it would not. */
export interface AgentActionResult {
  requestId: string;
  action: string;
  outcome: "done" | "refused";
  /**
   * What the agent needs to act on the answer — for a preview, the URL and
   * whatever the app said while starting.
   *
   * The output matters as much as the URL: an agent whose app failed to boot
   * is the one best placed to fix it, and it can only do that if it is told
   * what went wrong rather than that something did.
   */
  detail?: { url?: string; output?: string[] };
  explanation: string;
}

/**
 * What a person said, or that nobody did.
 *
 * `cancelled` is not a refusal of the chosen option — it is nobody having
 * chosen at all. The agent is expected to stop rather than pick for itself:
 * it asked because the decision was not its to make, and silence does not
 * transfer it back.
 */
export interface QuestionAnswer {
  requestId: string;
  /** Index into the options it offered, or undefined when nobody answered. */
  chosen?: number;
  status: "answered" | "cancelled";
}

/**
 * Model spend one agent reported for one phase of one session.
 *
 * Optional throughout, because it is the agent's to report and not every CLI
 * says. A coordinator that receives nothing records nothing rather than
 * guessing: an invented number would be worse than an absent one, since a
 * budget would then be enforced against fiction.
 */
export interface AgentTokenUsage {
  phase: "planning" | "execution";
  /** Cumulative for the phase, not an increment since the last report. */
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentAdapter {
  getCapabilities(): Promise<AgentCapabilities>;

  startTask(input: StartTaskInput): Promise<AgentSession>;

  requestPlan(sessionId: string): Promise<AgentPlan>;

  requestReplan(
    sessionId: string,
    request: ReplanRequest,
  ): Promise<AgentPlan>;

  sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void>;

  pause(sessionId: string): Promise<void>;

  resume(sessionId: string): Promise<void>;

  resolveScopeChange(
    sessionId: string,
    decision: ScopeChangeDecision,
  ): Promise<void>;

  /**
   * Hands back what a person chose, or that nobody did.
   *
   * Optional: an adapter whose CLI has no way to ask never emits
   * `question_asked`, so it is never called, and requiring it would make
   * every adapter implement a path it can never reach.
   */
  resolveQuestion?(sessionId: string, answer: QuestionAnswer): Promise<void>;

  /**
   * Hands back what the platform did about a requested action.
   *
   * Optional for the same reason as `resolveQuestion`: an adapter whose CLI
   * never emits `action_requested` is never called, and requiring it would
   * make every adapter implement a path it cannot reach.
   */
  resolveAction?(sessionId: string, result: AgentActionResult): Promise<void>;

  cancel(sessionId: string): Promise<void>;

  collectChanges(sessionId: string): Promise<ChangeSet>;

  streamEvents(
    sessionId: string,
    handler: (event: AgentEvent) => void,
  ): Promise<void>;

  /**
   * What this session has spent so far, if the underlying tool reports it.
   *
   * Synchronous and safe to call at any point, including mid-execution, so a
   * worker can send a running total up with its heartbeat and the control
   * plane can stop a task that is burning through its budget rather than
   * discovering the overspend once the bill has been paid.
   */
  reportedTokenUsage?(sessionId: string): AgentTokenUsage[];
}
