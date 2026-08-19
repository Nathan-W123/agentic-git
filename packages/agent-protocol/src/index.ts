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
  /**
   * Whether this task is one turn of a conversation — a session that may be
   * asked to continue after the turn lands.
   *
   * Some CLIs make session persistence a choice per invocation (codex's
   * `--ephemeral`), and hermetic execution is the right default for a task
   * that runs once: nothing worth remembering, nothing left on the host.
   * This flag is how an adapter learns the trade has changed — a
   * conversational turn should keep its vendor-side state resumable, because
   * the next turn's warmth is worth more than this turn's tidiness. Adapters
   * whose CLIs always persist (Claude Code) may ignore it.
   */
  conversational?: boolean;
}

export interface AgentSession {
  id: string;
  agentId: string;
  taskId: string;
  startedAt: string;
  /**
   * An adapter-opaque token naming the session's state in the vendor's own
   * store — for Claude Code headless, the `session_id` its result envelope
   * reports and its `--resume` flag accepts.
   *
   * What makes a session survive the adapter instance that opened it: an
   * ephemeral-exec adapter holds no process between calls, so everything a
   * "warm" continuation needs lives on the vendor's side, named by this. The
   * platform stamps it onto the session record it keeps for an open
   * conversation (from {@link AgentAdapter.resumeToken}) and hands the
   * record back through {@link AgentAdapter.continueTask}, which may be a
   * different instance entirely. Absent for adapters whose sessions die with
   * their process.
   */
  resume?: string;
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
       * The agent is done with part of its approved plan and is handing that
       * part back before the task ends.
       *
       * The mirror of `scope_change_requested`: that one asks for more, this
       * one gives some away. An over-claimed plan — twenty-two files declared,
       * eight actually touched — otherwise holds every one of them until the
       * task settles, and every other agent that needs one of the fourteen
       * waits for work that finished long ago.
       *
       * Answered with a `ScopeChangeDecision`, like a widening, because the
       * answer has the same shape: granted or not, and the plan now in force.
       * A granted release narrows that plan, so the released files stop being
       * writable — an edit to one after this is a scope escape and fails the
       * task. Ask for it back through `scope_change_requested` if that turns
       * out to be wrong, and expect a refusal: whoever took it next owes this
       * agent nothing.
       */
      event: "scope_release_requested";
      requestId?: string;
      releasedFiles: string[];
      releasedSymbols?: string[];
      releasedApis?: string[];
      releasedSchemas?: string[];
      releasedConfigKeys?: string[];
      releasedTests?: string[];
      releasedServices?: string[];
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
      /** The first question, mirrored from `questions[0]` for older readers. */
      question: string;
      /** At least two; one "option" is a statement, not a question. */
      options: string[];
      /** Index into `options` the agent would pick itself; advisory only. */
      recommended?: number;
      /**
       * The whole set, one to {@link MAX_AGENT_QUESTIONS} of them.
       *
       * A run that is blocked is usually blocked on more than one decision,
       * and asking them one at a time costs a round trip and fifteen minutes
       * of held leases each. Asking together costs one prompt.
       *
       * Optional so an adapter that only ever asks one thing can keep filling
       * `question` and `options` alone; read it through
       * {@link agentQuestionSet}, which normalises both shapes.
       */
      questions?: AgentQuestion[];
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
  /**
   * What was chosen for the first question, or undefined when nobody
   * answered. Mirrors `answers[0].chosen`, and is what an adapter that only
   * ever asks one thing reads.
   */
  chosen?: number;
  /** One entry per question asked, in the order they were asked. */
  answers?: QuestionChoice[];
  status: "answered" | "cancelled";
}

/**
 * One person's answer to one question.
 *
 * Three shapes rather than one index, because the prompt offers three: pick
 * an option, write something the agent did not think of, or say this one does
 * not matter. A skipped question is deliberately not the same as an
 * unanswered one — it is somebody saying "your call", which the agent may act
 * on, and it is what makes asking six questions cheap enough to be worth
 * doing.
 */
export interface QuestionChoice {
  /** Index into that question's options, when one was picked. */
  chosen?: number;
  /** What they wrote instead, when they answered in their own words. */
  text?: string;
  /** They passed on this one and left the decision to the agent. */
  skipped?: boolean;
}

/**
 * One question and the answers it will accept.
 *
 * `recommended` is the agent's own pick. It is what makes a six-question
 * prompt answerable in a second — the reader agrees or overrides rather than
 * deciding each one from nothing — and it is advisory only: nothing is
 * chosen for anybody, and silence still cancels.
 */
export interface AgentQuestion {
  question: string;
  /** At least two; one "option" is a statement, not a question. */
  options: string[];
  /** Index into `options`, when the agent has a preference. */
  recommended?: number;
}

/**
 * The most an agent may ask at once.
 *
 * Six is what the prompt can page through without becoming a form. Past that
 * the agent is designing rather than asking, and the honest move is to decide
 * and say what it assumed.
 */
export const MAX_AGENT_QUESTIONS = 6;

/**
 * The question set an event carries, whichever shape it used to carry it.
 *
 * Older adapters emit one `question` and its `options`; newer ones fill
 * `questions`. Every reader wants the same list, so it is derived here once
 * rather than in each of them.
 */
export function agentQuestionSet(
  event: Extract<AgentEvent, { event: "question_asked" }>,
): AgentQuestion[] {
  const asked: AgentQuestion[] =
    event.questions !== undefined && event.questions.length > 0
      ? event.questions
      : [
          {
            question: event.question,
            options: event.options,
            ...(event.recommended === undefined
              ? {}
              : { recommended: event.recommended }),
          },
        ];
  return asked.slice(0, MAX_AGENT_QUESTIONS).map((entry) => ({
    question: entry.question,
    options: [...entry.options],
    ...(entry.recommended === undefined
      ? {}
      : { recommended: entry.recommended }),
  }));
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

  /**
   * Continues an existing session as a new task — the next turn of a
   * conversation.
   *
   * The session is the expensive half of what a conversation keeps: whatever
   * the underlying CLI holds in context. This hands it the next request
   * without paying to rediscover the last one. The whole record travels, not
   * just the id, because the instance being asked may not be the instance
   * that opened the session — a fresh one adopts the vendor-side state the
   * record's `resume` token names. The returned record is the same session
   * under the new turn: same id, restamped with the new task, carrying
   * whatever token now names the state. A continued session starts its turn
   * fresh everywhere else — the caller registers `streamEvents` again and
   * sends a new context, exactly as it would for a session just started.
   *
   * Optional: an adapter without it is continued "cold" — the coordinator
   * closes the old session and starts a fresh one with the thread as
   * context, which is exactly what happens today. The workspace directory is
   * reused either way; the session is the expendable half.
   */
  continueTask?(
    session: AgentSession,
    input: StartTaskInput,
  ): Promise<AgentSession>;

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

  /**
   * Ends a session, whatever state it is in.
   *
   * Both the abort and the close: the coordinator calls this when a task
   * settles — integrated, failed and cancelled alike — because the protocol
   * has no second verb for a session that merely finished. Implementations
   * must tolerate a session whose work already completed, and a second
   * cancel of one already cancelled; both happen in ordinary operation.
   */
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

  /**
   * The token that would resume this session's vendor-side state, if the
   * underlying tool has one. See {@link AgentSession.resume}.
   *
   * Synchronous like `reportedTokenUsage` and read at the same kind of
   * moment: when a turn settles and the platform decides what to keep. The
   * answer moves as the session works — every Claude headless exec forks a
   * new vendor session id — so it is read at the end, not remembered from
   * the start. Absent, or answering undefined, means this session cannot be
   * resumed by a different instance and a continuation without its process
   * starts cold.
   */
  resumeToken?(sessionId: string): string | undefined;
}
