import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  agentQuestionSet,
  type AgentAdapter,
  type AgentEvent,
  type AgentQuestion,
  type AgentSession,
  type QuestionAnswer,
  type QuestionChoice,
  type ScopeContentionNotice,
  type StartTaskInput,
} from "@coord/agent-protocol";
import {
  CodeIntelligenceService,
  groundPlan,
  type RepositoryIndex,
} from "@coord/code-intelligence";
import { IntegrationService } from "@coord/integration-service";
import type { CoordinationStore } from "@coord/persistence";
import {
  agentCommitIdentity,
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  assertAgentPlan,
  claimCoversPath,
  createId,
  describeError,
  mergePlanScope,
  normalizeRepositoryPath,
  planGroundingConfidence,
  planResourceKey,
  reducePlanScope,
  scopeReleaseResources,
  summariseChangedFiles,
  uniqueRepositoryPaths,
  uniqueStrings,
  type AgentPlan,
  type ApprovalKind,
  type AuditEvent,
  type AuditEventType,
  type CanonicalChangeNotice,
  type CanonicalVersion,
  type ChangeSet,
  type IntegrationResult,
  type PlanAdmission,
  type PlanResourceRef,
  type ConflictAssessment,
  type CoordinationRunResult,
  type CoordinatorDecision,
  type FilePatchStatus,
  type HolderWorkingChange,
  type ReplanRequest,
  type ResourceType,
  type ScopeChangeDecision,
  type ScopeChangeRequest,
  type ScopeReleaseRequest,
  type TaskDefinition,
  type TaskExecutionResult,
  isBlanketClaim,
  planAdmissionApproved,
} from "@coord/shared-types";
import {
  GitWorktreeWorkspaceManager,
  type AdvanceWorkspaceInput,
  type TaskWorkspace,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import {
  ApprovalPolicy,
  StoreApprovalController,
  type ApprovalController,
} from "./approval-service.js";
import { InMemoryAuditLog } from "./audit-log.js";
import { ConflictDetector, relatedObjectives } from "./conflict-detector.js";
import { seedContextForTask } from "./handoff-store.js";
import { OwnershipService } from "./ownership-service.js";
import {
  type ChangeSetSplit,
  splitChangeSet,
} from "./partial-admission.js";
import {
  approvedSchemaResources,
  structuralConflict,
} from "./plan-admission.js";
import {
  assessReplay,
  residualAdvance,
  speculationLanded,
  type CanonicalAdvance,
} from "./replay.js";
import { RunRecorder } from "./run-recorder.js";
import { TaskCancellationRegistry } from "./task-cancellation.js";
import {
  ScopeExpansionError,
  assertChangeSetWithinPlan,
} from "./scope-validator.js";
import { frozenClaimCovers } from "./blanket-claim.js";
import { estimateScope } from "./scope-estimation.js";

export interface CoordinatedTask {
  task: TaskDefinition;
  adapter: AgentAdapter;
  /**
   * Present when this task is one turn of a conversation.
   *
   * Successive turns carrying the same id reuse the previous turn's
   * workspace directory and agent session instead of starting from nothing —
   * see docs/architecture/conversational-tasks.md. Everything else about the
   * turn is an ordinary task: it plans, is admitted against the world as it
   * is, lands its change, and releases its leases. Only on success does
   * anything survive; a turn that fails tears down completely and the next
   * one starts cold.
   */
  conversationId?: string;
}

/**
 * What survives between the turns of one conversation.
 *
 * The workspace directory and the agent session are the conversation's
 * memory — the first cheap to keep and expensive to rebuild, the second the
 * reverse. The last landed turn's plan and change set are kept so the next
 * turn can ask what an advance underneath the conversation touched, and
 * `syncedVersion` is where canonical stood once that turn landed: everything
 * past it is somebody else's work.
 *
 * The session is the expendable half, and the only optional one: the cap and
 * the idle sweep close it — a held session is a held CLI process — while the
 * conversation itself stays open. A conversation whose session lapsed starts
 * its next turn cold with the thread as context, in the directory it always
 * had.
 */
interface OpenConversation {
  adapter: AgentAdapter;
  /** Whose conversation this is — the agent, not the adapter instance. */
  agentId: string;
  session?: AgentSession;
  workspace: TaskWorkspace;
  /**
   * Destroys the workspace directory, captured from the coordinator that
   * retained it. The registry outlives any one run's workspace manager, so
   * each conversation carries its own way home instead of the registry
   * having to hold a manager that may not be the one that built the
   * directory.
   */
  destroyWorkspace: () => Promise<void>;
  plan: AgentPlan;
  changeSet: ChangeSet;
  syncedVersion: CanonicalVersion;
  /** When the conversation's last turn landed, for the idle sweep. */
  lastLandedAt: number;
}

/** See {@link ConversationRegistry}. */
export interface ConversationRegistryOptions {
  /**
   * See {@link CoordinatorDependencies.conversationSessionIdleMs}. Absent,
   * COORD_CONVERSATION_SESSION_IDLE_MS decides, and then the default.
   */
  sessionIdleMs?: number;
  /**
   * See {@link CoordinatorDependencies.maxConversationSessions}. Absent,
   * COORD_MAX_CONVERSATION_SESSIONS decides, and then the default.
   */
  maxSessions?: number;
}

/**
 * A whole-number knob an operator may set in the environment.
 *
 * Refuses nonsense rather than falling back to the default: a deployment that
 * set a bound and got the default anyway is a deployment whose cap silently
 * is not the one it configured, and the whole point of these two is that the
 * held processes are countable.
 */
function configuredWholeNumber(key: string, fallback: number): number {
  const raw = process.env[key]?.trim() ?? "";
  if (raw.length === 0) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

/**
 * The conversations whose last turn landed and whose next has not begun.
 *
 * A class of its own, and injectable, because its lifetime is the feature:
 * the coordinator that runs a turn is built per run — its approval policy
 * and plan authority are that run's — while a conversation has to survive
 * from one run to the next. A host that wants continuation makes one
 * registry per process and hands it to every coordinator it builds; a
 * coordinator given nothing keeps a private one, which is exactly the old
 * behaviour and all a single-invocation caller needs.
 *
 * The registry also owns the two process bounds, because the processes are
 * what it holds: the idle sweep and the session cap both shed sessions
 * only — the conversation stays open and its next turn starts cold, in the
 * directory it kept.
 */
export class ConversationRegistry {
  private readonly conversations = new Map<string, OpenConversation>();
  private readonly sessionIdleMs: number;
  private readonly maxSessions: number;

  public constructor(options: ConversationRegistryOptions = {}) {
    // Caller first, deployment second, default last. The environment is read
    // here rather than at the place a registry is built because a deployment
    // builds one in its own host process (`apps/web`) and passes no options
    // at all: a bound only an argument could reach would be a bound no
    // operator could set.
    this.sessionIdleMs =
      options.sessionIdleMs ??
      configuredWholeNumber(
        "COORD_CONVERSATION_SESSION_IDLE_MS",
        DEFAULT_CONVERSATION_SESSION_IDLE_MS,
      );
    this.maxSessions =
      options.maxSessions ??
      configuredWholeNumber(
        "COORD_MAX_CONVERSATION_SESSIONS",
        DEFAULT_MAX_CONVERSATION_SESSIONS,
      );
  }

  /** Removes and returns a conversation; the caller owns it from then on. */
  public take(conversationId: string): OpenConversation | undefined {
    const held = this.conversations.get(conversationId);
    this.conversations.delete(conversationId);
    return held;
  }

  /** Stores a conversation whose turn just landed, and re-applies the cap. */
  public async retain(
    conversationId: string,
    conversation: OpenConversation,
  ): Promise<void> {
    this.conversations.set(conversationId, conversation);
    // A held session is a held CLI process, so the population is bounded
    // the moment it grows rather than on some later sweep.
    await this.enforceSessionCap();
  }

  /** Closes and forgets one conversation's session, keeping the rest. */
  private async closeSession(conversation: OpenConversation): Promise<void> {
    const session = conversation.session;
    if (session === undefined) {
      return;
    }
    delete conversation.session;
    try {
      await conversation.adapter.cancel(session.id);
    } catch {
      // A session that will not close is still forgotten: the sweep exists
      // to stop holding processes, and keeping the record on top of a
      // wedged one would hold both.
    }
  }

  /**
   * Holds the number of live conversation sessions at the cap.
   *
   * Oldest landing gives its session up first — it is the conversation most
   * likely to already be over. Only the process goes; the conversation and
   * its directory stay, and its next turn starts cold.
   */
  private async enforceSessionCap(): Promise<void> {
    while (true) {
      const live = [...this.conversations.values()]
        .filter((conversation) => conversation.session !== undefined)
        .sort((a, b) => a.lastLandedAt - b.lastLandedAt);
      const oldest = live[0];
      if (oldest === undefined || live.length <= this.maxSessions) {
        return;
      }
      await this.closeSession(oldest);
    }
  }

  /**
   * Closes conversation sessions that have sat idle past the deadline.
   *
   * Public so a host can run it on a timer; every run also sweeps on entry,
   * which bounds a deployment that is doing anything at all. The
   * conversations stay open — their next turn starts cold, in the directory
   * they kept — because the session is the expendable half of what a
   * conversation holds.
   */
  public async closeIdleSessions(now: number = Date.now()): Promise<void> {
    for (const conversation of this.conversations.values()) {
      if (
        conversation.session !== undefined &&
        now - conversation.lastLandedAt >= this.sessionIdleMs
      ) {
        await this.closeSession(conversation);
      }
    }
  }

  /**
   * Ends a conversation entirely: session closed, directory destroyed.
   *
   * For whoever owns the decision that the conversation is over — an
   * explicit "that's it", the task's own expiry — as opposed to the sweeps,
   * which shed only the process and leave the conversation continuable.
   * Unknown ids are a no-op: ending twice, or ending what a failed turn
   * already tore down, is not an error.
   */
  public async endConversation(conversationId: string): Promise<void> {
    const held = this.take(conversationId);
    if (held === undefined) {
      return;
    }
    await this.closeSession(held);
    await held.destroyWorkspace();
  }

  /**
   * Ends every open conversation, for a host retiring the registry — a
   * shutdown, mainly — so held processes and directories do not outlive
   * whoever would have swept them.
   */
  public async endAllConversations(): Promise<void> {
    for (const conversationId of [...this.conversations.keys()]) {
      await this.endConversation(conversationId);
    }
  }
}

export interface CoordinatorRunInput {
  repository: CanonicalRepository;
  workspaceRoot: string;
  integrationRoot: string;
  tasks: CoordinatedTask[];
  scenario?: string;
  organizationId?: string;
  projectId?: string;
}

interface PlannedTask extends CoordinatedTask {
  session: AgentSession;
  plan: AgentPlan;
  planRevision: number;
  plannedVersion: CanonicalVersion;
  decision: CoordinatorDecision;
  /**
   * The open conversation this turn resumed, taken out of the coordinator's
   * map the moment planning began. From then on it rides here, so the
   * failure paths that already tear an entry down only have to also destroy
   * this workspace — there is no side table to remember to clear.
   */
  resumed?: OpenConversation;
  /** Set when admission granted less than this task planned. */
  admission?: PlanAdmission;
  /**
   * Holder WIP this task already planned against while deferred.
   *
   * Present only after a speculative replan. On wake, {@link assessReplay}
   * grades the residual advance; when speculation covers what landed the
   * task starts without another planning round. Never an admission — the
   * holders still own the files.
   */
  speculatedAdvance?: CanonicalAdvance;
  /**
   * The anchored estimate a blanket claim was granted against, kept so the
   * freeze has something to narrow to before the agent's first write.
   */
  blanketEstimate?: readonly string[];
}

interface PreparedTask extends PlannedTask {
  workspace: TaskWorkspace;
  changeSet: ChangeSet;
  /** The withheld half, kept so it can be queued once the granted half lands. */
  split?: ChangeSetSplit;
}

/**
 * Kept as a local name because this module calls it in dozens of places, but
 * the rule itself lives in shared-types now — the gateway renders the very
 * aggregates raised here, and two copies of "unwrap the causes" is how one end
 * ends up reporting a wrapper the other end would have expanded.
 */
const errorMessage = describeError;

function emptyAdvance(): CanonicalAdvance {
  return {
    changedFiles: [],
    changedSymbols: [],
    changedApis: [],
    changedSchemas: [],
    changedConfigKeys: [],
    changedTests: [],
    changedServices: [],
  };
}

/**
 * Every resource a plan claims, as the plan itself spells it.
 *
 * Two jobs at once. It holds a release to what the plan actually names —
 * giving back a file that was never claimed changes nothing, and answering
 * "granted" to it would tell an agent it had freed something it never held.
 * And it maps whatever the agent wrote back onto the plan's own spelling, so
 * the narrowing and the lease release act on one string rather than two: the
 * plan matches resources case-insensitively, ownership keys them exactly, and
 * a release that used the agent's spelling for one and the plan's for the
 * other would drop a file from the plan while its lease stayed held.
 */
function planClaimedResources(plan: AgentPlan): Map<string, PlanResourceRef> {
  const claimed = new Map<string, PlanResourceRef>();
  const add = (
    resourceType: ResourceType,
    ids: readonly string[] | undefined,
  ): void => {
    for (const resourceId of ids ?? []) {
      claimed.set(planResourceKey(resourceType, resourceId), {
        resourceType,
        resourceId,
      });
    }
  };
  add("file", plan.expectedFiles);
  add("symbol", plan.expectedSymbols);
  add("api", plan.expectedApis);
  add("schema", plan.expectedSchemas);
  add("configuration", plan.expectedConfigKeys);
  add("test", plan.expectedTests);
  add("service", plan.expectedServices);
  return claimed;
}

/**
 * What one plan wants that another plan already holds.
 *
 * The sentence a contention notice is built from: the waiter declared these,
 * the holder claims them, and only the holder can hand them back. Symbols and
 * every other axis are compared the same way files are — a task queued behind
 * a symbol is waiting just as long as one queued behind a file.
 *
 * A frozen or blanket claim is read through {@link claimCoversPath} as well as
 * through its file list: a claim covers directories the holder has not named
 * file by file, and those are exactly the paths a waiter is refused for.
 */
export function contestedPlanResources(
  holder: AgentPlan,
  waiter: AgentPlan,
): {
  files: string[];
  symbols: string[];
  apis: string[];
  schemas: string[];
  configKeys: string[];
  tests: string[];
  services: string[];
} {
  const held = planClaimedResources(holder);
  const contested = {
    files: [] as string[],
    symbols: [] as string[],
    apis: [] as string[],
    schemas: [] as string[],
    configKeys: [] as string[],
    tests: [] as string[],
    services: [] as string[],
  };
  const axes: ReadonlyArray<
    [ResourceType, readonly string[] | undefined, keyof typeof contested]
  > = [
    ["file", waiter.expectedFiles, "files"],
    ["symbol", waiter.expectedSymbols, "symbols"],
    ["api", waiter.expectedApis, "apis"],
    ["schema", waiter.expectedSchemas, "schemas"],
    ["configuration", waiter.expectedConfigKeys, "configKeys"],
    ["test", waiter.expectedTests, "tests"],
    ["service", waiter.expectedServices, "services"],
  ];
  for (const [resourceType, wanted, bucket] of axes) {
    for (const resourceId of wanted ?? []) {
      const covered =
        held.has(planResourceKey(resourceType, resourceId)) ||
        (resourceType === "file" && claimCoversPath(holder, resourceId));
      if (covered) {
        contested[bucket].push(resourceId);
      }
    }
  }
  return {
    files: uniqueStrings(contested.files),
    symbols: uniqueStrings(contested.symbols),
    apis: uniqueStrings(contested.apis),
    schemas: uniqueStrings(contested.schemas),
    configKeys: uniqueStrings(contested.configKeys),
    tests: uniqueStrings(contested.tests),
    services: uniqueStrings(contested.services),
  };
}

function pairKey(taskIds: readonly [string, string]): string {
  return [...taskIds].sort().join("\0");
}

function conflictFingerprint(assessment: ConflictAssessment): string {
  return JSON.stringify({
    taskIds: [...assessment.taskIds].sort(),
    score: assessment.score,
    disposition: assessment.disposition,
    evidence: assessment.evidence,
  });
}

export interface CoordinatorDependencies {
  repositories?: RepositoryService;
  workspaces?: WorkspaceManager;
  integrations?: IntegrationService;
  conflicts?: ConflictDetector;
  ownership?: OwnershipService;
  intelligence?: CodeIntelligenceService;
  approvalPolicy?: ApprovalPolicy;
  approvals?: ApprovalController;
  audit?: InMemoryAuditLog;
  store?: CoordinationStore;
  /**
   * Ask the agent that produced a result to redo the part that collided,
   * rather than ending its session and paying for a fresh one to rediscover
   * the whole task. On by default; set false to restore the previous
   * behaviour, in which any collision cost a full replan.
   */
  repairConflicts?: boolean;
  /**
   * How often the worktree is read while an agent edits, to report what it
   * has touched (see `watchWorkingChanges`).
   *
   * Each tick is two read-only git calls against one worktree. Ten seconds
   * is responsive enough that a thread looks alive without making the poll
   * itself a noticeable share of a run's work; a test that wants determinism
   * sets its own.
   */
  workingChangePollMs?: number;
  /**
   * Who puts an agent's question to a person, and brings back what they said.
   *
   * Absent on a deployment with nobody to ask — a CLI run, a benchmark — in
   * which case a question is cancelled immediately rather than waiting out a
   * deadline for an answer that was never going to come.
   */
  questions?: QuestionController;
  /** How long a person has, before the task is cancelled. See `answerAgentQuestion`. */
  questionDeadlineMs?: number;
  /**
   * How long a conversation's session may sit idle between turns before it
   * is closed. The conversation stays open — the next turn starts cold, in
   * the same directory — because the session is a held CLI process and this
   * is the first thing in the system that keeps one alive across the gap
   * between a person's messages. Attention is less predictable than work,
   * so the process is bounded even when nobody ends the conversation.
   *
   * Configures the coordinator's private registry only; a shared
   * {@link CoordinatorDependencies.conversations} carries its own bounds.
   */
  conversationSessionIdleMs?: number;
  /**
   * How many conversations may hold a live session at once. Past the cap,
   * the conversation whose turn landed longest ago gives its session up
   * first — it is the one most likely to already be over. The workspace
   * directory is not counted or evicted here: it holds no process, and it
   * is the half that is expensive to rebuild.
   *
   * Configures the coordinator's private registry only, like the idle
   * deadline above.
   */
  maxConversationSessions?: number;
  /**
   * Where open conversations live between turns.
   *
   * Injectable because its lifetime is the feature: a coordinator is built
   * per run — its approval policy and plan authority belong to that run —
   * while a conversation has to survive from one run to the next. A
   * long-lived host makes one registry per process and hands it to every
   * coordinator it builds; absent, the coordinator keeps a private one,
   * which is all a single-invocation caller needs.
   */
  conversations?: ConversationRegistry;
  /**
   * Who arbitrates this run's plans against work running *outside* it.
   *
   * The wave loop below already sequences the tasks of one run against each
   * other, which is the whole story when a run is the only thing executing in
   * its repository. It stops being the whole story the moment a second
   * invocation exists: each run holds its own conflict detector and its own
   * in-memory ownership table, so two runs started by two dispatches see
   * nothing of one another and both admit a plan for the same file.
   *
   * Absent by default, which keeps a lone run — a benchmark, a CLI invocation,
   * a test — behaving exactly as before. A deployment that can execute two
   * runs at once supplies one backed by durable state.
   */
  planAuthority?: PlanAuthority;
  /**
   * Who performs the things an agent can ask the platform for.
   *
   * Absent by default, so an agent that asks is told plainly that this
   * deployment does nothing — which is a real answer and lets the agent carry
   * on, rather than a failure. A deployment that can host actions supplies
   * one; see docs/architecture/agent-actions.md.
   */
  actionAuthority?: ActionAuthority;
  /**
   * Where a person's "stop" reaches this run.
   *
   * Absent by default — a benchmark or a CLI run has nobody to stop it
   * mid-flight, and behaves exactly as before. A long-lived host makes one
   * registry per process, hands it to every run and to its API surface, and
   * a cancel then aborts the named task's live session and is honoured at
   * the run's own checkpoints. See {@link TaskCancellationRegistry}.
   */
  cancellations?: TaskCancellationRegistry;
}

/**
 * The platform doing something on an agent's behalf, mid-task.
 *
 * Kept behind an interface for the same reason the plan authority is: the
 * coordinator is a service and knows nothing about deployments, and the only
 * thing that can start a preview lives in the app that serves the API.
 *
 * The rule the implementation is held to — an agent may only request what the
 * task's submitter could do themselves, on the task's own repository — is
 * enforced there rather than here. This side chooses nothing; it carries the
 * request and returns the answer.
 */
export interface ActionAuthority {
  perform(input: {
    task: TaskDefinition;
    repository: CanonicalRepository;
    projectId?: string;
    action: string;
    /** The task's own checkout, which is what an agent asks to look at. */
    workspacePath: string;
  }): Promise<{
    outcome: "done" | "refused";
    detail?: { url?: string; output?: string[] };
    explanation: string;
  }>;
}

/**
 * How many actions one task may ask for.
 *
 * An agent legitimately restarts its app after each fix, so this cannot be
 * small. It exists because a loop that asks a thousand times is three lines of
 * agent and a denial of service, not because ten is a meaningful number.
 */
const MAX_ACTIONS_PER_TASK = 10;

/** One planned task, offered for arbitration before it is allowed to edit. */
export interface PlanAdmissionRequest {
  task: TaskDefinition;
  plan: AgentPlan;
  planRevision: number;
  /** Canonical revision the plan was written against. */
  baseVersion: CanonicalVersion;
  repository: CanonicalRepository;
  projectId?: string;
  /**
   * Whether this replaces a contract this task already holds.
   *
   * An approved admission is normally immutable — it is what ownership was
   * granted against, and letting a later request widen it would let a task
   * grant itself scope nobody arbitrated. Mid-execution scope arbitration is
   * the one caller that legitimately produces a wider contract, because the
   * widening is decided against every other holder first.
   */
  revising?: boolean;
  /**
   * Refuse rather than narrow: answer `deferred` where a partial grant would
   * otherwise be offered.
   *
   * Set by the mid-execution callers. A partial admission is an answer to
   * "what may this task start on", and both replan paths are past that — the
   * agent is already running inside an approved plan. Handing one of them a
   * narrower plan than it asked for means its contract, its ownership and the
   * changeset it eventually returns are describing three different things,
   * and the caller has no way to renegotiate with an agent mid-flight. A
   * refusal is a real answer there: the agent keeps the plan it already had
   * and carries on working inside it.
   */
  partialAdmission?: boolean;
}

export type PlanAuthorityDecision =
  /**
   * The task may execute. `plan` is what it may execute — the same plan, or a
   * narrower one where only part of it was free.
   */
  | {
      outcome: "admitted";
      plan: AgentPlan;
      /**
       * The decision `plan` came out of, present when it narrowed the plan.
       *
       * Without it the executor knows only what it may touch, which is not
       * enough to tell a deliberately withheld file apart from one nobody
       * arbitrated: both look like a path outside the plan. The first is the
       * expected shape of a partial admission and belongs in the deferred
       * half; the second is a scope escape and fails the task.
       */
      admission?: PlanAdmission;
    }
  /**
   * Something else holds what this plan wants. The coordinator waits
   * `retryAfterMs`, then reconsiders the task from the top of the wave loop —
   * which replans it first if canonical moved in the meantime, so the retry is
   * made against the winner's result rather than against a stale base.
   */
  | {
      outcome: "deferred";
      retryAfterMs: number;
      blockedBy: readonly string[];
      explanation: string;
    };

/**
 * The authority on whether a plan may start, given everything else running.
 *
 * Deliberately not the same object as {@link ConflictDetector}: that one
 * compares plans held in memory by one run, this one answers for a whole
 * repository across every run in the deployment. The coordinator treats the
 * answer as binding and does not second-guess it.
 */
export interface PlanAuthority {
  admit(request: PlanAdmissionRequest): Promise<PlanAuthorityDecision>;
  /**
   * The whole repository, for a task that is alone in it, or nothing.
   *
   * Asked before the agent is asked to plan, because the answer decides
   * whether it is asked at all: a plan exists so a second task can arbitrate
   * against it, and where there is no second task it buys nothing but a round
   * trip. A grant is recorded on the lease exactly as an admitted plan is —
   * that record is what makes the claim visible to whoever arrives next.
   *
   * Optional: an authority that does not implement it simply leaves every
   * task planning as it always did.
   */
  claimRepository?(
    request: BlanketClaimRequest,
  ): Promise<AgentPlan | undefined>;
  /**
   * Narrows a repository-wide claim to what its holder has actually touched,
   * once somebody else is in the repository.
   *
   * `observe` reads the holder's worktree, and is called at the moment of the
   * freeze rather than sampled from anything periodic: a file written a
   * second ago is a file this task owns, and handing it away would put two
   * agents in it. The narrowed plan is written under the lease store's
   * compare-and-swap, so a freeze and an admission decided at the same moment
   * cannot both win.
   *
   * Answers `undefined` while the claim should stay whole — nobody else is
   * here yet — and the narrowed plan once it has been frozen.
   */
  freezeBlanketClaim?(
    request: BlanketFreezeRequest,
  ): Promise<AgentPlan | undefined>;
  /**
   * Turns the half a partial admission withheld into work of its own.
   *
   * Called only once the granted half is durably in canonical: a task asking
   * for the remainder of something that never landed is worse than no task at
   * all. Optional, because an authority that never returns a partial
   * admission never has a remainder to queue.
   *
   * This lives on the authority rather than in the coordinator for the same
   * reason `admit` does — it needs durable state across runs, which the
   * coordinator deliberately has no reach into. Without it the deferred files
   * are dropped in silence: the granted half integrates, the task is reported
   * complete, and nobody ever writes the rest.
   */
  deferRemainder?(request: DeferredScopeRequest): Promise<void>;
  /**
   * Who is queued behind this task right now, and on what.
   *
   * The mirror of `admit`: that one tells an arriving task it must wait, this
   * one tells the holder that somebody is waiting. Both answers come out of
   * the same durable state — the arriving task's own non-approved contract
   * names its blockers — which is why this lives on the authority rather than
   * in the coordinator, whose view stops at its own run.
   *
   * Answers only what the holder could actually hand back: resources in the
   * plan it is executing. A waiter blocked on something this task never
   * claimed is somebody else's queue.
   *
   * Optional. An authority without it simply never tells anyone, which is the
   * behaviour every release request had before this existed.
   */
  listWaitingOn?(
    request: WaitingWorkRequest,
  ): Promise<readonly WaitingWork[]>;
}

/** The holder, and the plan whose resources a queue could form behind. */
export interface WaitingWorkRequest {
  task: TaskDefinition;
  plan: AgentPlan;
  repository: CanonicalRepository;
  projectId?: string;
}

/** One task waiting, and the part of the holder's plan it is waiting for. */
export interface WaitingWork {
  taskId: string;
  files: readonly string[];
  symbols?: readonly string[];
  apis?: readonly string[];
  schemas?: readonly string[];
  configKeys?: readonly string[];
  tests?: readonly string[];
  services?: readonly string[];
  /** What the authority told the waiter, for the holder to read. */
  explanation?: string;
}

/** What an authority needs to decide whether a task is alone in a repository. */
export interface BlanketClaimRequest {
  task: TaskDefinition;
  repository: CanonicalRepository;
  projectId?: string;
  baseVersion: CanonicalVersion;
}

/** A blanket claim, and the worktree read that decides what it becomes. */
export interface BlanketFreezeRequest {
  task: TaskDefinition;
  plan: AgentPlan;
  planRevision: number;
  repository: CanonicalRepository;
  projectId?: string;
  baseVersion: CanonicalVersion;
  /** Read synchronously at freeze time; never a cached or polled view. */
  observe(): Promise<
    ReadonlyArray<{ path: string; status: FilePatchStatus }>
  >;
  /**
   * Where the objective said this task would go, for a holder that has not
   * written anything yet.
   *
   * A claim can only be narrowed to what its holder has actually touched, and
   * a holder that has touched nothing used to be left holding the repository
   * — correctly, because erasing the claim would admit the arrival into the
   * files the holder is about to write. But "has written nothing" is not the
   * rare case: it is the whole of the window between an agent starting and
   * its first edit, which for a real coding agent is however long it spends
   * reading. Every arrival during that window was refused everything.
   *
   * So a holder that cannot yet be narrowed by observation is narrowed by
   * declaration instead. This is only ever populated from an estimate the
   * coordinator judged anchored — a task whose objective named real paths,
   * directories or symbols — and a task whose objective could not produce one
   * is never granted a blanket claim in the first place. Empty means fall
   * back to keeping the claim whole.
   */
  estimatedFiles: readonly string[];
}

/** The remainder of a partially admitted task, once its granted half landed. */
export interface DeferredScopeRequest {
  task: TaskDefinition;
  repository: CanonicalRepository;
  projectId?: string;
  admission: PlanAdmission;
  split: ChangeSetSplit;
}

/**
 * How many waves may pass with nothing admitted before the run gives up.
 *
 * A deferral is only useful if something can change while we wait: a lease
 * lapses, a holder promotes, canonical moves. An authority that defers this
 * many times in a row is not describing a queue, it is failing to make
 * progress, and spinning on it forever would strand the run silently — the
 * failure mode this whole mechanism exists to end.
 */
const MAX_CONSECUTIVE_DEFERRED_WAVES = 240;

/**
 * Somewhere to put a question, and somewhere for the answer to come back.
 *
 * An interface rather than a channel client, for the same reason the store
 * is: the coordinator knows a question needs answering and nothing about
 * where people are. Returning `undefined` — or resolving with no choice — is
 * how "nobody answered" is said.
 */
export interface QuestionController {
  awaitAnswer(input: {
    requestId: string;
    taskId: string;
    repositoryId: string;
    projectId?: string;
    /** The first question, for a controller that only shows one. */
    question: string;
    options: string[];
    /** Every question the agent asked, one to six of them. */
    questions: AgentQuestion[];
    deadlineMs: number;
  }): Promise<{ chosen?: number; answers?: QuestionChoice[] } | undefined>;
}

/**
 * Fifteen minutes.
 *
 * Long enough that somebody at lunch can still answer, short enough that the
 * leases an unanswered question is holding are not held for the hour the
 * execution timeout would otherwise allow.
 */
const DEFAULT_QUESTION_DEADLINE_MS = 15 * 60 * 1000;

/** See {@link CoordinatorDependencies.workingChangePollMs}. */
const DEFAULT_WORKING_CHANGE_POLL_MS = 10_000;

/**
 * Fifteen minutes, like the question deadline and for the same reason: long
 * enough that somebody who stepped away can still pick their conversation
 * back up warm, short enough that an abandoned one is not a process held for
 * the rest of the day. A deployment that holds more, or less, sets
 * COORD_CONVERSATION_SESSION_IDLE_MS.
 */
const DEFAULT_CONVERSATION_SESSION_IDLE_MS = 15 * 60 * 1000;

/**
 * Eight held CLI processes is a deliberate deployment cost; twenty is the
 * failure mode the design doc names. Between turns a session does nothing
 * but remember, so the cap can be small without costing anyone a running
 * turn — a turn in flight is not in this map at all. A machine with more or
 * less room than this assumes sets COORD_MAX_CONVERSATION_SESSIONS.
 */
const DEFAULT_MAX_CONVERSATION_SESSIONS = 8;

export class Coordinator {
  private readonly repositories: RepositoryService;
  private readonly workspaces: WorkspaceManager;
  private readonly integrations: IntegrationService;
  private readonly conflicts: ConflictDetector;
  private readonly ownership: OwnershipService;
  private readonly intelligence: CodeIntelligenceService;
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly approvals: ApprovalController | undefined;
  private readonly audit: InMemoryAuditLog;
  private readonly store: CoordinationStore | undefined;
  private readonly repairConflicts: boolean;
  private readonly workingChangePollMs: number;
  private readonly questions: QuestionController | undefined;
  private readonly questionDeadlineMs: number;
  private readonly conversations: ConversationRegistry;
  private readonly planAuthority: PlanAuthority | undefined;
  private readonly actionAuthority: ActionAuthority | undefined;
  private readonly cancellations: TaskCancellationRegistry | undefined;
  /** Where each task is working, for an action that needs to reach it. */
  private readonly taskWorkspacePaths = new Map<string, string>();
  /**
   * Live worktrees keyed by task id — the in-process half of looking up a
   * holder's edits while a waiter is deferred. Cleared on cleanup.
   */
  private readonly taskWorkspaces = new Map<string, TaskWorkspace>();
  /** Actions each task has spent, for the cap. */
  private readonly actionsUsed = new Map<string, number>();
  public constructor(dependencies: CoordinatorDependencies = {}) {
    this.repositories = dependencies.repositories ?? new RepositoryService();
    this.workspaces =
      dependencies.workspaces ??
      new GitWorktreeWorkspaceManager(this.repositories.getGitClient());
    this.integrations =
      dependencies.integrations ??
      new IntegrationService(this.repositories, this.workspaces);
    this.conflicts = dependencies.conflicts ?? new ConflictDetector();
    this.ownership = dependencies.ownership ?? new OwnershipService();
    this.intelligence =
      dependencies.intelligence ??
      new CodeIntelligenceService(this.repositories);
    this.approvalPolicy = dependencies.approvalPolicy ?? new ApprovalPolicy();
    this.repairConflicts = dependencies.repairConflicts ?? true;
    this.workingChangePollMs =
      dependencies.workingChangePollMs ?? DEFAULT_WORKING_CHANGE_POLL_MS;
    this.questions = dependencies.questions;
    this.questionDeadlineMs =
      dependencies.questionDeadlineMs ?? DEFAULT_QUESTION_DEADLINE_MS;
    this.conversations =
      dependencies.conversations ??
      new ConversationRegistry({
        ...(dependencies.conversationSessionIdleMs === undefined
          ? {}
          : { sessionIdleMs: dependencies.conversationSessionIdleMs }),
        ...(dependencies.maxConversationSessions === undefined
          ? {}
          : { maxSessions: dependencies.maxConversationSessions }),
      });
    this.planAuthority = dependencies.planAuthority;
    this.actionAuthority = dependencies.actionAuthority;
    this.cancellations = dependencies.cancellations;
    this.store = dependencies.store;
    this.approvals =
      dependencies.approvals ??
      (this.store === undefined
        ? undefined
        : new StoreApprovalController(
            this.store,
            this.approvalPolicy.timeoutMs,
          ));
    this.audit = dependencies.audit ?? new InMemoryAuditLog();
  }

  public async run(input: CoordinatorRunInput): Promise<CoordinationRunResult> {
    // Sessions past their idle deadline go before any new work starts, so a
    // deployment that is doing anything at all keeps its held processes
    // bounded without needing a timer of its own.
    await this.conversations.closeIdleSessions();
    const runAudit: AuditEvent[] = [];
    const initialVersion = await this.repositories.getCanonicalVersion(
      input.repository,
    );
    const recorder =
      this.store === undefined
        ? undefined
        : await RunRecorder.begin(this.store, {
            repository: input.repository,
            ...(input.projectId === undefined
              ? {}
              : { projectId: input.projectId }),
            mode: "coordinated",
            baseVersion: initialVersion,
            ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
          });
    const ownershipHeartbeat = setInterval(() => {
      this.ownership.renewActive();
    }, this.ownership.renewalIntervalMs);

    try {
      const result = await this.execute(
        input,
        initialVersion,
        recorder,
        runAudit,
      );
      const runStatus = result.tasks.every(
        (taskResult) => taskResult.status === "integrated",
      )
        ? "completed"
        : "failed";
      await recorder?.finish(runStatus, result.canonicalVersion);
      return result;
    } catch (error) {
      try {
        await recorder?.finish("failed");
      } catch (finishError) {
        throw new AggregateError(
          [error, finishError],
          "Coordination failed and the durable run could not be finalized",
        );
      }
      throw error;
    } finally {
      clearInterval(ownershipHeartbeat);
    }
  }

  private async execute(
    input: CoordinatorRunInput,
    initialVersion: CanonicalVersion,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<CoordinationRunResult> {
    for (const entry of input.tasks) {
      await recorder?.task(entry.task);
      await this.trace(recorder, runAudit, "task_submitted", entry.task.id, {
        objective: entry.task.objective,
        agentId: entry.task.agentId,
      });
    }

    // A run with one task has nothing to arbitrate: no pair to assess, no
    // wave to order. Enrichment and grounding exist to make plans comparable
    // with each other, so a solo run skips the repository index they need —
    // scope enforcement and exact-base integration hold the task to its
    // declarations and its base revision either way.
    const initialIndex =
      input.tasks.length === 1
        ? undefined
        : await this.intelligence.index(
            input.repository,
            initialVersion.revision,
          );
    const { planned, failed: planningFailures } = await this.planTasks(
      input,
      initialVersion,
      initialIndex,
      recorder,
      runAudit,
    );
    const pending = [...planned];
    // Tasks that failed planning are already settled results: their status
    // and audit trail were written where they failed, and seeding them here
    // is what lets the survivors' run still return one row per task.
    const taskResults: TaskExecutionResult[] = [...planningFailures];
    const latestAssessments = new Map<string, ConflictAssessment>();
    const recordedConflictFingerprints = new Set<string>();
    /** Consecutive waves in which the plan authority admitted nothing. */
    let deferredWaves = 0;

    // From here every task has a live session an outside stop must be able
    // to reach. Registered after planning on purpose: a task that fails
    // planning tears itself down inside planTasks and leaves no session to
    // abort. A stop that lands during planning is recorded and honoured at
    // the first wave boundary below instead.
    for (const entry of planned) {
      this.cancellations?.register(entry.task.id, async () => {
        await entry.adapter.cancel(entry.session.id);
      });
    }

    try {
      while (pending.length > 0) {
        // A stopped task leaves before it costs anything more — no replan,
        // no admission, no workspace. Its row and lease were settled by
        // whoever stopped it; what is owed here is the session teardown and
        // an honest result naming the ending.
        if (this.cancellations !== undefined) {
          for (const entry of [...pending]) {
            const reason = this.cancellations.reasonFor(entry.task.id);
            if (reason === undefined) {
              continue;
            }
            pending.splice(pending.indexOf(entry), 1);
            const cleanupFailure = await this.cleanupTask(
              entry,
              entry.resumed?.workspace,
              recorder,
              runAudit,
            );
            const explanation =
              cleanupFailure === undefined
                ? reason
                : `${reason}; ${cleanupFailure}`;
            await recorder?.status(entry.task.id, "cancelled", explanation);
            taskResults.push({
              task: entry.task,
              plan: entry.plan,
              decision: entry.decision,
              status: "cancelled",
              explanation,
            });
          }
          if (pending.length === 0) {
            break;
          }
        }
        const waveVersion = await this.repositories.getCanonicalVersion(
          input.repository,
        );
        const moved = pending.filter(
          (entry) => entry.plannedVersion.revision !== waveVersion.revision,
        );
        // The index inside the wave loop exists for replanning, and a wave
        // with nothing to replan — always the first, and every wave of a
        // solo run — can skip building it: reading every source file out of
        // git is the single most expensive control-plane step, and a task
        // with nobody to be replanned against should not pay it.
        const index =
          moved.length === 0
            ? undefined
            : await this.intelligence.index(
                input.repository,
                waveVersion.revision,
              );
        // Canonical moving is not the same as canonical moving *under this
        // plan*. The worker path learned that separately — see
        // `COORD_STRICT_PLAN_REBASE` in `worker-operations.ts`, where the
        // measurement was 16 to 26 replans a run at roughly 145k tokens each,
        // "most of those advances never touched the plan discarded for them".
        // This loop kept the old rule, so it is where the n(n-1)/2 came from.
        const needsReplan =
          index === undefined
            ? []
            : await this.replansDisturbedBy(
                input.repository,
                moved,
                waveVersion,
                index,
              );
        // Speculation that covered this advance is why a moved task skipped
        // replan. Advance plannedVersion so the next wave does not re-grade
        // the holder's files as a fresh disturbance.
        if (index !== undefined) {
          const required = new Set(needsReplan);
          for (const entry of moved) {
            if (required.has(entry) || entry.speculatedAdvance === undefined) {
              continue;
            }
            entry.plannedVersion = waveVersion;
            delete entry.speculatedAdvance;
          }
        }
        // Every task still queued has to see the canonical state the previous
        // wave produced, and each of those replans is a full round trip to an
        // agent. Issued one at a time they dominate a real run: a fully
        // sequenced set of n tasks performs n(n-1)/2 of them, so eight tasks
        // means twenty-eight agent calls back to back.
        //
        // They are independent. A replan reads canonical and the shared index,
        // both immutable at this point in the wave, and writes only to its own
        // entry and its own agent session. Audit appends are already made
        // concurrently by the parallel execution below and are serialised by
        // the store, so the chain stays intact; only the interleaving of events
        // between tasks changes. Initial planning is parallel for the same
        // reasons, and this makes replanning agree with it.
        await Promise.all(
          needsReplan.map(async (entry) => {
            if (index === undefined) {
              throw new Error("Coordinator lost the index it built to replan");
            }
            await this.replanTask(
              input,
              entry,
              waveVersion,
              index,
              recorder,
              runAudit,
            );
            delete entry.speculatedAdvance;
          }),
        );

        const assessments = this.conflicts.assessAll(
          pending.map((entry) => entry.plan),
        );
        const newlyRecorded = assessments.filter((assessment) => {
          latestAssessments.set(pairKey(assessment.taskIds), assessment);
          const fingerprint = conflictFingerprint(assessment);
          if (recordedConflictFingerprints.has(fingerprint)) {
            return false;
          }
          recordedConflictFingerprints.add(fingerprint);
          return true;
        });
        if (newlyRecorded.length > 0) {
          await recorder?.conflicts(newlyRecorded);
          for (const assessment of newlyRecorded) {
            await this.trace(
              recorder,
              runAudit,
              "conflict_detected",
              undefined,
              {
                taskIds: assessment.taskIds,
                score: assessment.score,
                disposition: assessment.disposition,
                evidence: assessment.evidence,
                // For whoever narrates this to a room. The channel watcher can
                // reach a repository's channel only if the event says which
                // repository — the same stamp `canonical_promoted` carries for
                // the same reason — and the explanation is the sentence the
                // detector already wrote about *why* these two collide.
                repositoryId: input.repository.id,
                ...(input.projectId === undefined
                  ? {}
                  : { projectId: input.projectId }),
                explanation: assessment.explanation,
              },
            );
          }
        }

        const blockers = this.buildBlockers(pending, assessments);
        let wave = pending.filter(
          (entry) => (blockers.get(entry.task.id)?.size ?? 0) === 0,
        );
        let cycleOverride = false;
        if (wave.length === 0) {
          const first = pending[0];
          if (first === undefined) {
            throw new Error("Coordinator lost its pending task state");
          }
          wave = [first];
          cycleOverride = true;
        }

        for (const entry of pending) {
          const blockedBy = [...(blockers.get(entry.task.id) ?? [])];
          const isReady = wave.includes(entry);
          const blockingConflicts = assessments.filter(
            (assessment) =>
              assessment.disposition === "block" &&
              assessment.taskIds.includes(entry.task.id),
          );
          const constraints = [
            ...(blockedBy.length > 0
              ? ["Start from canonical state after blocking tasks integrate"]
              : []),
            ...blockingConflicts.map(
              (assessment) =>
                `Human approval required for conflict score ${assessment.score} with ` +
                assessment.taskIds.find((id) => id !== entry.task.id),
            ),
            ...(cycleOverride && isReady
              ? [
                  "Human approval required to break a cyclic dependency; validation must prove compatibility",
                ]
              : []),
          ];
          entry.decision = {
            decision: isReady ? "approved" : "queued",
            taskId: entry.task.id,
            planRevision: entry.planRevision,
            ownershipGrants: entry.decision.ownershipGrants,
            constraints,
            blockedBy,
            explanation: isReady
              ? "Approved for the next non-conflicting execution wave"
              : `Queued behind ${blockedBy.join(", ")} due to structural ownership or dependency evidence`,
          };
          await recorder?.decision(entry.decision);
          await recorder?.status(
            entry.task.id,
            isReady ? "approved" : "queued",
            entry.decision.explanation,
          );
        }

        // Everything above sequenced this run's tasks against each other.
        // This asks the one question that view cannot answer: is anything
        // *outside* this run already holding what these plans want?
        const admittedWave: PlannedTask[] = [];
        let shortestRetryMs = Number.POSITIVE_INFINITY;
        for (const entry of wave) {
          const answer: PlanAuthorityDecision =
            this.planAuthority === undefined
              ? { outcome: "admitted", plan: entry.plan }
              : await this.planAuthority.admit({
                  task: entry.task,
                  plan: entry.plan,
                  planRevision: entry.planRevision,
                  baseVersion: waveVersion,
                  repository: input.repository,
                  ...(input.projectId === undefined
                    ? {}
                    : { projectId: input.projectId }),
                });
          if (answer.outcome === "admitted") {
            // Partial admission answers with a narrower plan than was asked
            // for. Executing what was granted rather than what was submitted
            // is what keeps scope enforcement, the ownership grants and the
            // change set all describing the same piece of work.
            //
            // A speculative plan written against holder WIP that never landed
            // is invalid on wake: fall back to today's replan against bare
            // canonical before treating this as ready to execute. The
            // replanned plan replaces `answer.plan` — speculation was never
            // an admission of that overlay.
            if (
              entry.speculatedAdvance !== undefined &&
              entry.plannedVersion.revision === waveVersion.revision
            ) {
              const index = await this.intelligence.index(
                input.repository,
                waveVersion.revision,
              );
              await this.replanTask(
                input,
                entry,
                waveVersion,
                index,
                recorder,
                runAudit,
                {
                  reason:
                    "Speculative plan was against holder work that did not land",
                  changedFiles: [],
                },
              );
              delete entry.speculatedAdvance;
            } else {
              entry.plan = answer.plan;
            }
            // Kept because `plan` alone cannot say why a file is missing from
            // it. Collection needs to tell "withheld, and somebody else is
            // writing it" from "never arbitrated", and only the decision knows.
            if (answer.admission !== undefined) {
              entry.admission = answer.admission;
            }
            admittedWave.push(entry);
            continue;
          }
          shortestRetryMs = Math.min(shortestRetryMs, answer.retryAfterMs);
          entry.decision = {
            ...entry.decision,
            decision: "queued",
            blockedBy: uniqueStrings([
              ...entry.decision.blockedBy,
              ...answer.blockedBy,
            ]),
            explanation: answer.explanation,
          };
          await recorder?.decision(entry.decision);
          await recorder?.status(entry.task.id, "queued", answer.explanation);
        }

        if (admittedWave.length === 0) {
          // Nothing may start yet. While we wait, plan against what the
          // holders are already editing — so when they land, assessReplay
          // finds the advance unsurprising and the waiter starts without a
          // cold planning round. Speculation never admits or takes leases.
          deferredWaves += 1;
          if (deferredWaves > MAX_CONSECUTIVE_DEFERRED_WAVES) {
            throw new Error(
              `No task could be admitted after ${MAX_CONSECUTIVE_DEFERRED_WAVES} ` +
                "consecutive waves; the plan authority is not making progress",
            );
          }
          await this.speculateDuringDeferredWait(
            input,
            pending,
            waveVersion,
            recorder,
            runAudit,
          );
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Number.isFinite(shortestRetryMs) ? shortestRetryMs : 1_000,
            ),
          );
          continue;
        }
        deferredWaves = 0;

        for (const selected of admittedWave) {
          pending.splice(pending.indexOf(selected), 1);
        }

        const prepared = await Promise.all(
          admittedWave.map(async (entry) =>
            await this.prepareTask(
              input,
              entry,
              admittedWave,
              waveVersion,
              recorder,
              runAudit,
              pending,
            ),
          ),
        );

        const failedProducers: PlannedTask[] = [];
        for (const result of prepared) {
          if (!("changeSet" in result)) {
            taskResults.push(result);
            if (result.status !== "integrated") {
              const plannedTask = admittedWave.find(
                (entry) => entry.task.id === result.task.id,
              );
              if (plannedTask !== undefined) {
                failedProducers.push(plannedTask);
              }
            }
            continue;
          }
          const taskResult = await this.integrateTask(
            input,
            result,
            recorder,
            runAudit,
          );
          taskResults.push(taskResult);
          if (taskResult.status !== "integrated") {
            failedProducers.push(result);
          }
        }
        if (failedProducers.length > 0) {
          await this.cancelFailedDependents(
            pending,
            failedProducers,
            taskResults,
            recorder,
            runAudit,
          );
        }
      }
    } catch (error) {
      // The collapse ends every pending session, so no live abort remains
      // for a later cancel to deliver.
      for (const entry of pending) {
        this.cancellations?.release(entry.task.id);
      }
      const cleanup = await Promise.allSettled(
        // Sessions and any resumed conversations' workspaces alike: a run
        // that throws ends every pending turn, and an ended turn ends its
        // conversation. Flat so one failure cannot shadow the other.
        pending.flatMap((entry) => [
          entry.adapter.cancel(entry.session.id),
          ...(entry.resumed === undefined
            ? []
            : [this.workspaces.destroy(entry.resumed.workspace)]),
        ]),
      );
      const failures = cleanup
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          [error, ...failures],
          "Coordination and pending-session cleanup both failed",
        );
      }
      throw error;
    }

    const canonicalVersion = await this.repositories.getCanonicalVersion(
      input.repository,
    );
    return {
      canonicalVersion,
      conflicts: [...latestAssessments.values()],
      tasks: input.tasks.map((entry) => {
        const result = taskResults.find(
          (candidate) => candidate.task.id === entry.task.id,
        );
        if (result === undefined) {
          throw new Error(`Missing result for task ${entry.task.id}`);
        }
        return result;
      }),
      audit: runAudit,
      ...(recorder === undefined ? {} : { runId: recorder.runId }),
    };
  }

  private async planTasks(
    input: CoordinatorRunInput,
    version: CanonicalVersion,
    /** Absent on a solo run, where plans are never compared with anything. */
    index: RepositoryIndex | undefined,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<{ planned: PlannedTask[]; failed: TaskExecutionResult[] }> {
    const results = await Promise.allSettled(
      input.tasks.map(async (entry): Promise<PlannedTask> => {
        // Taken before the first await, so of two turns naming one
        // conversation in the same wave exactly one resumes it and the other
        // cold-starts, rather than both holding the same worktree.
        const resumed = this.takeConversation(entry);
        let session: AgentSession | undefined;
        try {
          const capabilities = await entry.adapter.getCapabilities();
          if (!capabilities.canPlan || !capabilities.canEditFiles) {
            throw new Error(
              `Agent ${entry.task.agentId} cannot satisfy the coordination protocol`,
            );
          }
          // What earlier tasks in this repository worked out, from the
          // handoffs they left. Every run starts with an empty context
          // window, so without this each one rediscovers the repository from
          // nothing — including whatever the last agent learned the hard way
          // and wrote down. The handoffs have been recorded at every task
          // boundary all along; this is the first thing to read them back.
          //
          // Never allowed to stop a run: seeding is an advantage, and a task
          // that cannot read old notes should still do the work.
          const seeded =
            this.store === undefined
              ? ""
              : await seedContextForTask(this.store, {
                  repositoryId: input.repository.id,
                  ...(input.projectId === undefined
                    ? {}
                    : { projectId: input.projectId }),
                }).catch(() => "");
          // The conversation this request was asked inside, ahead of what
          // earlier tasks left behind. Both are background rather than fact,
          // but they are not equally close to the work: the thread is about
          // *this* request — it is where "now do the same for the other file"
          // gets its meaning — while a handoff is about the repository in
          // general. Nearest first, so the thing being asked for survives any
          // truncation the model does at the far end.
          // What other in-flight tasks already hold, told to the agent
          // *before* it plans. Admission would trim or defer a plan that
          // reaches into leased files anyway — this makes the agent route
          // around them from the start, so the common outcome is a plan that
          // admits cleanly rather than one that gets cut down after the fact.
          // Advisory wording on purpose: the lease may clear before this plan
          // arrives, and admission stays the authority either way.
          const leased =
            this.store === undefined
              ? []
              : await this.store
                  .listWorkLeases({
                    status: "active",
                    repositoryId: input.repository.id,
                  })
                  .then((leases) => [
                    ...new Set(
                      leases
                        .filter(
                          (lease) =>
                            lease.taskId !== entry.task.id &&
                            lease.plan !== undefined &&
                            planAdmissionApproved(lease.plan.admission),
                        )
                        .flatMap((lease) =>
                          // A holder that never planned names no files, and
                          // saying nothing about it would tell this agent the
                          // repository is free when one task holds all of it.
                          lease.plan !== undefined &&
                          isBlanketClaim(lease.plan.plan)
                            ? ["(the whole repository, by an unplanned task)"]
                            : (lease.plan?.plan.expectedFiles ?? []),
                        ),
                    ),
                  ])
                  .catch(() => []);
          const leaseNote =
            leased.length === 0
              ? ""
              : "Files other tasks in this repository are editing right now — " +
                "plan around them where the objective allows; work that " +
                "touches them will be deferred until those tasks land:\n" +
                leased
                  .slice(0, 20)
                  .map((file) => `- ${file}`)
                  .join("\n");
          // What landed underneath the conversation since its last turn,
          // graded before the agent plans so the turn opens knowing it.
          // Nothing to ask for a first turn, or when canonical has not
          // moved past where the last turn left it.
          const turnStart =
            resumed !== undefined &&
            resumed.syncedVersion.revision !== version.revision
              ? await this.assessTurnStart(
                  input,
                  entry,
                  resumed,
                  version,
                  recorder,
                  runAudit,
                )
              : { note: "" };
          const priorContext = [
            entry.task.context?.trim() ?? "",
            turnStart.note,
            leaseNote,
            seeded,
          ]
            .filter((part) => part !== "")
            .join("\n\n");
          const startInput: StartTaskInput = {
            task: entry.task,
            canonicalVersion: version,
            repositoryId: input.repository.id,
            ...(priorContext === "" ? {} : { priorContext }),
            // Told before the session opens, because some CLIs decide at
            // invocation time whether a session persists at all — a turn of
            // a conversation must keep its vendor-side state resumable,
            // where a one-shot task is better off hermetic.
            ...(entry.conversationId === undefined
              ? {}
              : { conversational: true }),
          };
          // A resumed conversation continues its session — the expensive
          // half of what a conversation keeps — when the adapter can.
          // Without `continueTask` the session is the expendable half: the
          // old one is closed and the turn starts cold with the thread as
          // context, exactly as a fresh task would, while the workspace
          // directory is still reused below.
          session =
            resumed?.session !== undefined &&
            entry.adapter.continueTask !== undefined
              ? await entry.adapter.continueTask(resumed.session, startInput)
              : await this.startColdSession(entry, resumed, startInput);
          if (session.taskId !== entry.task.id) {
            // Held to the contract for the same reason the plan is below: a
            // session still stamped with the old turn would make the durable
            // session record miss this run's task row entirely.
            throw new Error(
              `Agent session task ${session.taskId} does not match ${entry.task.id}`,
            );
          }
          await recorder?.session(session);
          // A semantic collision opens the turn as a replan rather than a
          // plain plan request: the previous plan and the notice of what
          // moved are the same conversation a replan already has with an
          // agent, and the answer is judged below exactly as a first plan
          // would be.
          // A task alone in its repository is handed the whole of it and
          // never asked to describe itself. The plan an agent would have
          // written here exists so a second task can arbitrate against it,
          // and where there is no second task the round trip buys nothing —
          // it is the single largest fixed cost before the first edit.
          //
          // Every condition below is about being able to keep the promise
          // later: only a solo run (nothing in this wave to arbitrate
          // against in memory), only a first turn (a replan is a
          // conversation about a plan that already exists), and only an
          // adapter that can be told its scope instead of asked for it.
          const claimRepository = this.planAuthority?.claimRepository?.bind(
            this.planAuthority,
          );
          const acceptClaim = entry.adapter.acceptBlanketClaim?.bind(
            entry.adapter,
          );
          const claimable =
            input.tasks.length === 1 &&
            turnStart.replan === undefined &&
            acceptClaim !== undefined &&
            claimRepository !== undefined &&
            // Never claim what cannot later be given back: a workspace
            // manager that cannot report working changes can never be frozen,
            // so the claim would hold the whole repository until the task
            // ended and every arrival would wait it out.
            this.workspaces.listWorkingChanges !== undefined &&
            this.planAuthority?.freezeBlanketClaim !== undefined;
          // What this task says it will touch, before it has touched
          // anything. A blanket claim can only be narrowed to observed
          // writes, so a holder still reading its way into the problem used
          // to pin the whole repository for as long as that took — and that
          // is the common case, not an edge one.
          //
          // The estimate is what makes the claim narrowable from the moment
          // it is granted. It also decides whether the claim is granted at
          // all: an objective that names nothing real cannot be narrowed by
          // declaration either, and a claim that can never be given back
          // early is not worth the planning round it saves. Those tasks fall
          // through and plan properly, which is the same trade the condition
          // above makes for an unfreezable workspace.
          //
          // Only "anchored" counts. The estimator grades itself, and a weak
          // estimate is one assembled from words that happened to match
          // rather than from a path, directory or symbol the objective named
          // — narrowing a claim to that would hand somebody else files this
          // task is about to want.
          //
          // Paid for with an index build the solo path otherwise skips, which
          // is deliberate: indexing is the most expensive step in the control
          // plane, but a planning round trip is an agent round trip, and this
          // is the cheaper of the two ways to learn where a task is going.
          const estimate = claimable
            ? await this.intelligence
                .index(input.repository, version.revision)
                .then((built) => estimateScope(entry.task.objective, built))
                .catch(() => undefined)
            : undefined;
          const estimatedFiles =
            estimate?.confidence === "anchored"
              ? estimate.files.map((file) => file.path)
              : [];
          const claim =
            claimable && claimRepository !== undefined && estimatedFiles.length > 0
              ? await claimRepository({
                  task: entry.task,
                  repository: input.repository,
                  ...(input.projectId === undefined
                    ? {}
                    : { projectId: input.projectId }),
                  baseVersion: version,
                })
              : undefined;
          if (claim !== undefined && acceptClaim !== undefined) {
            await acceptClaim(session.id, claim);
            await recorder?.plan(entry.task.id, claim);
            await recorder?.planRevision(entry.task.id, {
              revision: 1,
              reason: "initial",
              canonicalRevision: version.revision,
              plan: claim,
            });
            await this.trace(
              recorder,
              runAudit,
              "blanket_claim_granted",
              entry.task.id,
              {
                repositoryId: input.repository.id,
                canonicalRevision: version.revision,
                planningCallsSaved: 1,
              },
            );
            return {
              ...entry,
              ...(resumed === undefined ? {} : { resumed }),
              session,
              plan: claim,
              planRevision: 1,
              plannedVersion: version,
              blanketEstimate: estimatedFiles,
              decision: {
                decision: "approved",
                taskId: entry.task.id,
                planRevision: 1,
                ownershipGrants: [],
                constraints: [],
                blockedBy: [],
                explanation:
                  "Granted the whole repository: nothing else is executing in it",
              },
            };
          }
          const submitted =
            turnStart.replan === undefined
              ? await entry.adapter.requestPlan(session.id)
              : await entry.adapter.requestReplan(
                  session.id,
                  turnStart.replan,
                );
          assertAgentPlan(submitted);
          if (submitted.taskId !== entry.task.id) {
            throw new Error(
              `Agent plan task ${submitted.taskId} does not match ${entry.task.id}`,
            );
          }
          // Grounded before it is enriched: verification judges what the
          // agent declared, not what the index projected onto it.
          const plan =
            index === undefined
              ? submitted
              : this.intelligence.enrichPlan(
                  groundPlan(submitted, index),
                  index,
                );
          assertAgentPlan(plan);
          await recorder?.plan(entry.task.id, plan);
          await recorder?.planRevision(entry.task.id, {
            revision: 1,
            reason: "initial",
            canonicalRevision: version.revision,
            plan,
          });
          await this.trace(
            recorder,
            runAudit,
            "plan_received",
            entry.task.id,
            {
              revision: 1,
              expectedFiles: plan.expectedFiles,
              expectedSymbols: plan.expectedSymbols,
              riskLevel: plan.riskLevel,
              grounding: plan.grounding,
            },
          );
          return {
            ...entry,
            ...(resumed === undefined ? {} : { resumed }),
            session,
            plan,
            planRevision: 1,
            plannedVersion: version,
            decision: {
              decision: "approved",
              taskId: entry.task.id,
              planRevision: 1,
              ownershipGrants: [],
              constraints: [],
              blockedBy: [],
              explanation: "Awaiting conflict analysis",
            },
          };
        } catch (error) {
          const errors = [error];
          if (session !== undefined) {
            try {
              await entry.adapter.cancel(session.id);
            } catch (cancelError) {
              errors.push(cancelError);
            }
          }
          if (resumed !== undefined) {
            // A turn that fails ends its conversation, planning failures
            // included. The held session may still be open when the
            // continuation itself threw before producing one.
            if (session === undefined && resumed.session !== undefined) {
              try {
                await entry.adapter.cancel(resumed.session.id);
              } catch (cancelError) {
                errors.push(cancelError);
              }
            }
            try {
              await this.workspaces.destroy(resumed.workspace);
            } catch (destroyError) {
              errors.push(destroyError);
            }
          }
          const failure =
            errors.length === 1
              ? error
              : new AggregateError(
                  errors,
                  `Planning and cleanup failed for task ${entry.task.id}`,
                );
          await recorder?.status(
            entry.task.id,
            "failed",
            errorMessage(failure),
          );
          await this.trace(
            recorder,
            runAudit,
            "task_failed",
            entry.task.id,
            { stage: "planning", error: errorMessage(failure) },
          );
          throw failure;
        }
      }),
    );

    // One task's planning failure is its own. The tasks in a run are
    // independent requests — often different agents, often different people —
    // and this used to be all-or-nothing: any thrown plan cancelled every
    // healthy sibling and aborted the run, so one agent's dead sign-in read
    // as "Session … was cancelled" on work that was going fine. The failed
    // task has already recorded its ending and torn its session down inside
    // its own catch above; here it becomes a failed result in the summary,
    // and the survivors carry on into the waves.
    const planned: PlannedTask[] = [];
    const failed: TaskExecutionResult[] = [];
    results.forEach((result, position) => {
      if (result.status === "fulfilled") {
        planned.push(result.value);
        return;
      }
      const entry = input.tasks[position];
      if (entry === undefined) {
        throw new Error("Planning results out of step with the tasks planned");
      }
      failed.push({
        task: entry.task,
        // It failed before a plan existed; the placeholders say only that,
        // so the summary keeps its shape without inventing declarations.
        plan: {
          taskId: entry.task.id,
          objective: entry.task.objective,
          expectedFiles: [],
          expectedSymbols: [],
          dependencies: [],
          commands: [],
          externalAccess: [],
          riskLevel: "low",
        },
        decision: {
          decision: "rejected",
          taskId: entry.task.id,
          ownershipGrants: [],
          constraints: [],
          blockedBy: [],
          explanation: "Planning failed before arbitration",
        },
        status: "failed",
        explanation: errorMessage(result.reason),
      });
    });
    return { planned, failed };
  }

  /**
   * Claims the open conversation this turn continues, if there is one.
   *
   * Synchronous and destructive on purpose: the entry leaves the map before
   * planning's first await, so a conversation can never be resumed twice,
   * and from here on its resources ride on the turn — whose failure paths
   * already tear a turn down. A conversation is only ever put back by a turn
   * that landed.
   *
   * An id held by a different adapter is not resumed: the session belongs to
   * the adapter that opened it, and handing it to another would cross two
   * agents' state. The held pair is torn down (best-effort — teardown here
   * must not fail the new turn) and the turn starts cold.
   */
  private takeConversation(
    entry: CoordinatedTask,
  ): OpenConversation | undefined {
    if (entry.conversationId === undefined) {
      return undefined;
    }
    const held = this.conversations.take(entry.conversationId);
    if (held === undefined) {
      return undefined;
    }
    if (held.adapter === entry.adapter) {
      return held;
    }
    if (held.agentId !== entry.task.agentId) {
      // A different agent has no business resuming this conversation: the
      // held pair is torn down (best-effort — teardown here must not fail
      // the new turn) and the turn starts from nothing.
      const closed =
        held.session === undefined
          ? Promise.resolve()
          : held.adapter.cancel(held.session.id).catch(() => undefined);
      void closed
        .then(async () => await held.destroyWorkspace())
        .catch(() => undefined);
      return undefined;
    }
    // Same agent, new adapter instance — the ordinary shape when every run
    // constructs its own adapters.
    if (
      held.session?.resume !== undefined &&
      entry.adapter.continueTask !== undefined
    ) {
      // The session's state lives in the vendor's own store, named by the
      // resume token — the instance that opened it held nothing the new one
      // needs. The record rides on to `continueTask`, warm.
      return { ...held, adapter: entry.adapter };
    }
    // No token, or nobody to adopt it: the session belongs to the instance
    // that opened it and closes with it; the directory is adapter-independent
    // and survives. The turn starts cold in a warm workspace, which is the
    // trade the design names: the session is the expendable half.
    if (held.session !== undefined) {
      const session = held.session;
      delete held.session;
      void held.adapter.cancel(session.id).catch(() => undefined);
    }
    return { ...held, adapter: entry.adapter };
  }

  /**
   * Starts a fresh session for a turn, closing the resumed one first.
   *
   * The cold half of continuation: the workspace directory is still reused,
   * but an adapter without `continueTask` — or a conversation whose session
   * did not survive — pays for a fresh context window seeded from the
   * thread. Closing the old session before opening the new one keeps the
   * adapter from holding two sessions for one conversation.
   */
  private async startColdSession(
    entry: CoordinatedTask,
    resumed: OpenConversation | undefined,
    startInput: StartTaskInput,
  ): Promise<AgentSession> {
    if (resumed?.session !== undefined) {
      try {
        await entry.adapter.cancel(resumed.session.id);
      } catch {
        // The new turn must not be stopped by an old session that would not
        // close; the close is re-attempted by nothing, and the session is
        // already unreachable from the conversation.
      }
    }
    return await entry.adapter.startTask(startInput);
  }

  /**
   * Catches a kept workspace up to this wave's canonical and re-tenants it
   * under the new turn.
   *
   * Falls back to destroy-and-create for a manager that cannot advance in
   * place — correct, merely slower: only the directory's warmth is lost.
   */
  private async advanceWorkspace(
    workspace: TaskWorkspace,
    input: AdvanceWorkspaceInput,
  ): Promise<TaskWorkspace> {
    const advance = this.workspaces.advance?.bind(this.workspaces);
    if (advance !== undefined) {
      return await advance(workspace, input);
    }
    await this.workspaces.destroy(workspace);
    return await this.workspaces.create({
      taskId: input.taskId,
      rootPath: workspace.rootPath,
      repository: workspace.repository,
      baseVersion: input.baseVersion,
    });
  }

  /** See {@link ConversationRegistry.closeIdleSessions}. */
  public async closeIdleConversationSessions(
    now: number = Date.now(),
  ): Promise<void> {
    await this.conversations.closeIdleSessions(now);
  }

  /** See {@link ConversationRegistry.endConversation}. */
  public async endConversation(conversationId: string): Promise<void> {
    await this.conversations.endConversation(conversationId);
  }

  /**
   * Stage two of conversational tasks: what landed underneath the
   * conversation since its last turn, and what to do about it.
   *
   * Graded with the same machinery integration uses — `assessReplay`
   * against the last landed turn's plan and change set — and answered in
   * the doc's three outcomes. Disjoint: say nothing. Textual overlap only:
   * the workspace will already reflect it, so the agent is told which of
   * its files moved and carries on. Semantic: the advance invalidated what
   * the conversation *knows*, so the turn opens with the same conversation
   * a replan already has with an agent — the previous plan, the notice,
   * and a request to plan from the new state.
   *
   * The loose grading is deliberate, despite the stricter plan-path
   * precedent in the worker: that rule guards executing an already-written
   * plan without a fresh planning round. Every conversational turn plans
   * afresh against current canonical, and its workspace is reset to that
   * canonical before any edit — the outcomes here only shape what the
   * planning round is told. For the same reason a notice that cannot be
   * built must never fail the turn: the fallback tells the agent canonical
   * moved and lets the fresh plan do the rest.
   *
   * Graded from the last turn's landing to this run's planning version; if
   * canonical moves again before this turn's wave, the wave loop's
   * existing replan covers the remainder on the same session, and the
   * workspace advances once, straight to the wave's version — a reset is
   * oblivious to how many advances it spans.
   */
  private async assessTurnStart(
    input: CoordinatorRunInput,
    entry: CoordinatedTask,
    resumed: OpenConversation,
    version: CanonicalVersion,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<{ note: string; replan?: ReplanRequest }> {
    let notice: CanonicalChangeNotice;
    try {
      notice = await this.describeCanonicalAdvance(
        input.repository,
        resumed.syncedVersion,
        version,
        "Other work landed after this conversation's last turn",
      );
    } catch {
      return {
        note:
          "Canonical advanced since your last turn; the workspace reflects " +
          "the current state. Read before assuming anything you remember.",
      };
    }
    const assessment = assessReplay(resumed.plan, resumed.changeSet, notice);
    if (assessment.semantic.length > 0) {
      await this.trace(
        recorder,
        runAudit,
        "canonical_changed",
        entry.task.id,
        {
          stage: "turn_start",
          previousRevision: resumed.syncedVersion.revision,
          revision: version.revision,
          changedFiles: notice.changedFiles,
          changedSymbols: notice.changedSymbols,
          changedApis: notice.changedApis,
          changedSchemas: notice.changedSchemas,
          changedConfigKeys: notice.changedConfigKeys,
          changedTests: notice.changedTests,
          changedServices: notice.changedServices,
        },
      );
      await this.trace(
        recorder,
        runAudit,
        "replan_requested",
        entry.task.id,
        {
          stage: "turn_start",
          previousTaskId: resumed.plan.taskId,
          canonicalRevision: version.revision,
          changedFiles: notice.changedFiles,
        },
      );
      return {
        note: "",
        replan: {
          taskId: entry.task.id,
          previousPlan: resumed.plan,
          canonicalChange: notice,
          constraints: [],
        },
      };
    }
    if (assessment.textual.length > 0) {
      const files = assessment.textual
        .map((blocker) => blocker.replace(/^file:/u, ""))
        .join(", ");
      return {
        note:
          "Since your last turn, other work landed in files this " +
          `conversation touched: ${files}. The workspace already reflects ` +
          "the current state; build on what is there rather than on what " +
          "you remember writing.",
      };
    }
    return { note: "" };
  }

  /**
   * What one canonical advance changed, described for a grader and an agent
   * alike.
   *
   * Resources are unioned from the indexes at both endpoints, not read from
   * the destination alone: a symbol the advance deleted exists only in the
   * old index, one it introduced only in the new, and a stale assumption
   * about either is worth surfacing. The returned notice is structurally a
   * `CanonicalAdvance`, so the same object can feed `assessReplay` and a
   * `ReplanRequest` without being built twice.
   */
  private async describeCanonicalAdvance(
    repository: CanonicalRepository,
    from: CanonicalVersion,
    to: CanonicalVersion,
    reason: string,
    /** The index at `to`, when the caller already built one (the wave has). */
    index?: RepositoryIndex,
  ): Promise<CanonicalChangeNotice> {
    const changedFiles = await this.repositories.listChangedFiles(
      repository,
      from.revision,
      to.revision,
    );
    const previousIndex = await this.intelligence.index(
      repository,
      from.revision,
    );
    const currentIndex =
      index ?? (await this.intelligence.index(repository, to.revision));
    const previousResources = this.intelligence.changedResources(
      changedFiles,
      previousIndex,
    );
    const currentResources = this.intelligence.changedResources(
      changedFiles,
      currentIndex,
    );
    return {
      previousVersion: from,
      canonicalVersion: to,
      changedFiles,
      changedSymbols: uniqueStrings([
        ...previousResources.symbols,
        ...currentResources.symbols,
      ]),
      changedApis: uniqueStrings([
        ...previousResources.apis,
        ...currentResources.apis,
      ]),
      changedSchemas: uniqueStrings([
        ...previousResources.schemas,
        ...currentResources.schemas,
      ]),
      changedConfigKeys: uniqueStrings([
        ...previousResources.configKeys,
        ...currentResources.configKeys,
      ]),
      changedTests: uniqueStrings([
        ...previousResources.tests,
        ...currentResources.tests,
      ]),
      changedServices: uniqueStrings([
        ...previousResources.services,
        ...currentResources.services,
      ]),
      reason,
    };
  }

  /**
   * Of the tasks whose canonical moved, the ones it actually moved *under*.
   *
   * A replan is a full round trip to an agent, and every queued task took one
   * after every wave regardless of what the wave had touched — which is
   * exactly the n(n-1)/2 the profiling found. Graded with `assessReplay`, the
   * same machinery integration uses, so "disturbs this plan" means one thing
   * in this system rather than one per caller.
   *
   * The empty patch list is the honest input rather than a placeholder:
   * nothing has executed yet, so the only question is whether the advance
   * touches what the plan claims or depends on. Deliberately stricter than
   * the result path, which tolerates `textual` overlap because a three-way
   * apply absorbs it — that reasoning holds for a changeset already written
   * against the old tree, and letting an agent *write* against a file whose
   * current contents it has never seen is a different bet.
   *
   * `plannedVersion` is deliberately not advanced for a task that skips. It
   * records the revision the agent's plan was actually written against, and
   * keeping it true means the next wave assesses the whole delta since the
   * agent last looked rather than one wave of it — so advances that are each
   * irrelevant alone but relevant together are still caught.
   *
   * `COORD_STRICT_PLAN_REBASE=1` restores the unconditional replan, the same
   * switch and the same spelling the worker path already uses.
   */
  private async replansDisturbedBy(
    repository: CanonicalRepository,
    moved: readonly PlannedTask[],
    version: CanonicalVersion,
    index: RepositoryIndex,
  ): Promise<PlannedTask[]> {
    if (process.env["COORD_STRICT_PLAN_REBASE"] === "1") {
      return [...moved];
    }
    const required: PlannedTask[] = [];
    for (const entry of moved) {
      const advance = await this.describeCanonicalAdvance(
        repository,
        entry.plannedVersion,
        version,
        "Blocking work changed canonical state before this task started",
        index,
      ).catch(() => undefined);
      if (advance === undefined) {
        // Unreadable advance is not evidence of irrelevance. Replan, which is
        // what this loop did for every task before any of this existed.
        required.push(entry);
        continue;
      }
      // Speculation is a head start, not a guarantee. If the holder landed a
      // different set than we planned against, fall back to today's replan.
      // When speculation covers the advance, only the residual can disturb.
      let graded: CanonicalAdvance = advance;
      if (entry.speculatedAdvance !== undefined) {
        if (!speculationLanded(entry.speculatedAdvance, advance)) {
          required.push(entry);
          continue;
        }
        graded = residualAdvance(advance, entry.speculatedAdvance);
      }
      const assessment = assessReplay(
        entry.plan,
        {
          id: "",
          taskId: entry.task.id,
          baseVersion: entry.plannedVersion.sequence,
          baseRevision: entry.plannedVersion.revision,
          patches: [],
          commandsRun: [],
          tests: [],
          dependenciesChanged: [],
          symbolsChanged: [],
          riskAssessment: { level: "low", reasons: [] },
          agentExplanation: "",
          createdAt: new Date().toISOString(),
        },
        graded,
      );
      if (assessment.semantic.length > 0 || assessment.textual.length > 0) {
        required.push(entry);
      }
    }
    return required;
  }

  private async replanTask(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    version: CanonicalVersion,
    index: RepositoryIndex,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
    /** Override when the caller already knows the notice (speculation, stale). */
    noticeOverride?: Pick<CanonicalChangeNotice, "reason" | "changedFiles"> &
      Partial<
        Pick<
          CanonicalChangeNotice,
          | "changedSymbols"
          | "changedApis"
          | "changedSchemas"
          | "changedConfigKeys"
          | "changedTests"
          | "changedServices"
        >
      >,
    holderWorkingChanges?: readonly HolderWorkingChange[],
  ): Promise<void> {
    const notice: CanonicalChangeNotice =
      noticeOverride === undefined
        ? await this.describeCanonicalAdvance(
            input.repository,
            entry.plannedVersion,
            version,
            "Blocking work changed canonical state before this task started",
            index,
          )
        : {
            previousVersion: entry.plannedVersion,
            canonicalVersion: version,
            changedFiles: noticeOverride.changedFiles,
            changedSymbols: noticeOverride.changedSymbols ?? [],
            changedApis: noticeOverride.changedApis ?? [],
            changedSchemas: noticeOverride.changedSchemas ?? [],
            changedConfigKeys: noticeOverride.changedConfigKeys ?? [],
            changedTests: noticeOverride.changedTests ?? [],
            changedServices: noticeOverride.changedServices ?? [],
            reason: noticeOverride.reason,
          };
    const request: ReplanRequest = {
      taskId: entry.task.id,
      previousPlan: entry.plan,
      canonicalChange: notice,
      constraints: [...entry.decision.constraints],
      ...(holderWorkingChanges === undefined || holderWorkingChanges.length === 0
        ? {}
        : { holderWorkingChanges: [...holderWorkingChanges] }),
    };
    await recorder?.status(entry.task.id, "replanning", notice.reason);
    await this.trace(recorder, runAudit, "canonical_changed", entry.task.id, {
      previousRevision: entry.plannedVersion.revision,
      revision: version.revision,
      changedFiles: notice.changedFiles,
      changedSymbols: notice.changedSymbols,
      changedApis: notice.changedApis,
      changedSchemas: notice.changedSchemas,
      changedConfigKeys: notice.changedConfigKeys,
      changedTests: notice.changedTests,
      changedServices: notice.changedServices,
      ...(holderWorkingChanges === undefined
        ? {}
        : { speculative: true, holderWorkingChanges: holderWorkingChanges.length }),
    });
    await this.trace(recorder, runAudit, "replan_requested", entry.task.id, {
      previousPlanRevision: entry.planRevision,
      canonicalRevision: version.revision,
      changedFiles: notice.changedFiles,
      ...(holderWorkingChanges === undefined ? {} : { speculative: true }),
    });

    const submitted = await entry.adapter.requestReplan(entry.session.id, request);
    assertAgentPlan(submitted);
    if (submitted.taskId !== entry.task.id) {
      throw new Error(
        `Agent replan task ${submitted.taskId} does not match ${entry.task.id}`,
      );
    }
    entry.plan = this.intelligence.enrichPlan(
      groundPlan(submitted, index),
      index,
    );
    entry.planRevision += 1;
    entry.plannedVersion = version;
    entry.decision.planRevision = entry.planRevision;
    await recorder?.planRevision(entry.task.id, {
      revision: entry.planRevision,
      reason: "canonical_change",
      canonicalRevision: version.revision,
      plan: entry.plan,
    });
    await this.trace(recorder, runAudit, "plan_revised", entry.task.id, {
      revision: entry.planRevision,
      reason: "canonical_change",
      expectedFiles: entry.plan.expectedFiles,
      // The symbols matter as much as the files for reading a replan back:
      // most of what an agent invents about this repository is a function
      // name, and without them the record only shows half the declaration.
      expectedSymbols: entry.plan.expectedSymbols,
      grounding: entry.plan.grounding,
      ...(holderWorkingChanges === undefined ? {} : { speculative: true }),
    });
  }

  /**
   * While every ready task is deferred behind holders, plan against those
   * holders' in-progress edits — without acquiring leases.
   *
   * Skipped when working changes cannot be read. Failures never disturb the
   * wait: the next wave still falls back to today's cold replan on wake.
   */
  private async speculateDuringDeferredWait(
    input: CoordinatorRunInput,
    pending: readonly PlannedTask[],
    version: CanonicalVersion,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    if (this.workspaces.listWorkingChanges === undefined) {
      return;
    }
    const waiters = pending.filter((entry) => entry.decision.blockedBy.length > 0);
    if (waiters.length === 0) {
      return;
    }
    let index: RepositoryIndex | undefined;
    for (const entry of waiters) {
      try {
        const overlay = await this.collectHolderWorkingChanges(
          input,
          entry.decision.blockedBy,
          version,
        );
        if (overlay.changes.length === 0) {
          continue;
        }
        index =
          index ??
          (await this.intelligence.index(input.repository, version.revision));
        await this.replanTask(
          input,
          entry,
          version,
          index,
          recorder,
          runAudit,
          {
            reason:
              "Blocking work is in progress; plan against its current edits",
            // Copied rather than aliased. A CanonicalAdvance is readonly and
            // a notice is not, so the notice takes its own array — which also
            // means nothing can reach back through the notice and mutate the
            // advance the speculation is graded against.
            changedFiles: [...overlay.advance.changedFiles],
            changedSymbols: [...overlay.advance.changedSymbols],
            changedApis: [...overlay.advance.changedApis],
            changedSchemas: [...overlay.advance.changedSchemas],
            changedConfigKeys: [...overlay.advance.changedConfigKeys],
            changedTests: [...overlay.advance.changedTests],
            changedServices: [...overlay.advance.changedServices],
          },
          overlay.changes,
        );
        entry.speculatedAdvance = overlay.advance;
      } catch {
        // Speculation is a head start. A failure leaves the waiter on today's
        // path: sleep, then replan cold if canonical moved.
      }
    }
  }

  /**
   * Holder WIP readable from in-process worktrees or co-located store paths.
   */
  private async collectHolderWorkingChanges(
    input: CoordinatorRunInput,
    holderTaskIds: readonly string[],
    version: CanonicalVersion,
  ): Promise<{
    changes: HolderWorkingChange[];
    advance: CanonicalAdvance;
  }> {
    const list = this.workspaces.listWorkingChanges?.bind(this.workspaces);
    if (list === undefined) {
      return {
        changes: [],
        advance: emptyAdvance(),
      };
    }
    const changes: HolderWorkingChange[] = [];
    const files = new Set<string>();
    for (const holderId of holderTaskIds) {
      const workspace = await this.resolveHolderWorkspace(
        input,
        holderId,
        version,
      );
      if (workspace === undefined) {
        continue;
      }
      let working: Array<{ path: string; status: FilePatchStatus }>;
      try {
        working = await list(workspace);
      } catch {
        continue;
      }
      for (const change of working) {
        files.add(change.path);
        changes.push({
          path: change.path,
          status: change.status,
          ...(change.status === "deleted"
            ? {}
            : { absolutePath: path.join(workspace.path, change.path) }),
        });
      }
    }
    const changedFiles = [...files].sort((left, right) =>
      left.localeCompare(right),
    );
    let advance: CanonicalAdvance = {
      ...emptyAdvance(),
      changedFiles,
    };
    try {
      const index = await this.intelligence.index(
        input.repository,
        version.revision,
      );
      const resources = this.intelligence.changedResources(changedFiles, index);
      advance = {
        changedFiles,
        changedSymbols: resources.symbols,
        changedApis: resources.apis,
        changedSchemas: resources.schemas,
        changedConfigKeys: resources.configKeys,
        changedTests: resources.tests,
        changedServices: resources.services,
      };
    } catch {
      // File list alone is still enough for assessReplay residual credit.
    }
    return { changes, advance };
  }

  private async resolveHolderWorkspace(
    input: CoordinatorRunInput,
    holderTaskId: string,
    version: CanonicalVersion,
  ): Promise<TaskWorkspace | undefined> {
    const live = this.taskWorkspaces.get(holderTaskId);
    if (live !== undefined) {
      return live;
    }
    const stored = await this.store?.findWorkspaceByTaskId(holderTaskId);
    if (stored === undefined) {
      return undefined;
    }
    return {
      id: stored.id,
      taskId: stored.taskId,
      path: stored.path,
      rootPath: stored.path,
      repository: input.repository,
      baseVersion: {
        sequence: version.sequence,
        revision: stored.baseRevision,
        branch: version.branch,
        createdAt: stored.createdAt,
      },
      isolation:
        stored.isolation === "docker" ? "docker" : "git-worktree",
      createdAt: stored.createdAt,
    };
  }

  private buildBlockers(
    pending: readonly PlannedTask[],
    assessments: readonly ConflictAssessment[],
  ): Map<string, Set<string>> {
    const blockers = new Map(
      pending.map((entry) => [entry.task.id, new Set<string>()]),
    );
    const byId = new Map(pending.map((entry) => [entry.task.id, entry]));
    // An unverifiable plan is never proven disjoint from *related* work: its
    // declarations connect to nothing that exists, so overlap scoring against
    // it is comparing fiction with fact. When another pending task talks
    // about the same objective, the unverifiable plan waits — behind the
    // verifiable one, or behind the earlier-submitted one when both are
    // unverifiable. Work about something else entirely keeps its concurrency:
    // a plan that only creates new files is held to those declarations by
    // scope enforcement either way. Edges all point one way, so no cycle is
    // possible.
    for (const entry of pending) {
      if (planGroundingConfidence(entry.plan) !== "ungrounded") {
        continue;
      }
      for (const other of pending) {
        if (other === entry || !relatedObjectives(entry.plan, other.plan)) {
          continue;
        }
        const otherUngrounded =
          planGroundingConfidence(other.plan) === "ungrounded";
        if (
          !otherUngrounded ||
          pending.indexOf(other) < pending.indexOf(entry)
        ) {
          blockers.get(entry.task.id)?.add(other.task.id);
        }
      }
    }
    for (const assessment of assessments) {
      if (!structuralConflict(assessment)) {
        continue;
      }
      const first = byId.get(assessment.taskIds[0]);
      const second = byId.get(assessment.taskIds[1]);
      if (first === undefined || second === undefined) {
        continue;
      }
      const preferred = this.conflicts.preferredOrder(first.plan, second.plan);
      let blocker: PlannedTask;
      let blocked: PlannedTask;
      if (preferred !== undefined) {
        blocker = byId.get(preferred[0]) ?? first;
        blocked = byId.get(preferred[1]) ?? second;
      } else if (pending.indexOf(first) < pending.indexOf(second)) {
        blocker = first;
        blocked = second;
      } else {
        blocker = second;
        blocked = first;
      }
      blockers.get(blocked.task.id)?.add(blocker.task.id);
    }
    return blockers;
  }

  private async cancelFailedDependents(
    pending: PlannedTask[],
    failed: readonly PlannedTask[],
    taskResults: TaskExecutionResult[],
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    const unavailable = [...failed];
    while (true) {
      const dependent = pending.find((candidate) =>
        unavailable.some((producer) => {
          const order = this.conflicts.preferredOrder(
            producer.plan,
            candidate.plan,
          );
          return (
            order?.[0] === producer.task.id &&
            order[1] === candidate.task.id
          );
        }),
      );
      if (dependent === undefined) {
        return;
      }
      const producer = unavailable.find((candidate) => {
        const order = this.conflicts.preferredOrder(
          candidate.plan,
          dependent.plan,
        );
        return (
          order?.[0] === candidate.task.id &&
          order[1] === dependent.task.id
        );
      });
      if (producer === undefined) {
        throw new Error("Coordinator lost a failed dependency relationship");
      }
      pending.splice(pending.indexOf(dependent), 1);
      let explanation =
        `Cancelled because required producer ${producer.task.id} did not integrate`;
      try {
        await dependent.adapter.cancel(dependent.session.id);
      } catch (error) {
        explanation += `; agent cancellation also failed: ${errorMessage(error)}`;
      }
      if (dependent.resumed !== undefined) {
        // A cancelled turn ends its conversation; nothing else holds this
        // workspace any more.
        try {
          await this.workspaces.destroy(dependent.resumed.workspace);
        } catch (error) {
          explanation += `; conversation workspace teardown failed: ${errorMessage(error)}`;
        }
      }
      await recorder?.status(dependent.task.id, "cancelled", explanation);
      await this.trace(
        recorder,
        runAudit,
        "task_cancelled",
        dependent.task.id,
        {
          stage: "dependency_propagation",
          blockedBy: producer.task.id,
          explanation,
        },
      );
      taskResults.push({
        task: dependent.task,
        plan: dependent.plan,
        decision: {
          ...dependent.decision,
          decision: "queued",
          blockedBy: uniqueStrings([
            ...dependent.decision.blockedBy,
            producer.task.id,
          ]),
          explanation,
        },
        status: "cancelled",
        explanation,
      });
      unavailable.push(dependent);
    }
  }

  /**
   * Decides a plan an agent has offered in place of the one it was approved
   * for.
   *
   * Held to exactly the checks the original plan was, and for the same reason:
   * a plan the agent wrote mid-task is no more trustworthy than the one it
   * wrote at the start, and it arrives at a moment when the agent has every
   * incentive to declare whatever would let it carry on. So it is grounded
   * against the repository, assessed against the rest of this wave, put to the
   * durable authority, and passed through the approval policy before any of it
   * counts.
   *
   * A refusal leaves the approved plan in force and the agent still working
   * inside it, which is the same contract a refused scope change leaves
   * behind. It is not a failure and does not end the task.
   */
  private async handleReplanProposal(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    wave: readonly PlannedTask[],
    waveVersion: CanonicalVersion,
    event: { requestId?: string; plan: AgentPlan; reason: string },
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    const requestId = event.requestId?.trim() || createId("replan");
    let decision: ScopeChangeDecision;
    try {
      const proposed = structuredClone(event.plan);
      assertAgentPlan(proposed);
      if (proposed.taskId !== entry.task.id) {
        throw new Error("The proposed plan is for a different task");
      }
      if (event.reason.trim().length === 0) {
        throw new Error("A replan proposal must say why");
      }
      // Grounded before anything reads it, exactly as the first plan was: a
      // plan written mid-task is the one most likely to name files the agent
      // merely believes exist.
      const revisedPlan = groundPlan(
        proposed,
        await this.intelligence.index(input.repository, waveVersion.revision),
      );
      const activeConflict = wave
        .filter((candidate) => candidate.task.id !== entry.task.id)
        .map((candidate) => this.conflicts.assess(revisedPlan, candidate.plan))
        .find(
          (assessment) =>
            assessment !== undefined && structuralConflict(assessment),
        );
      if (activeConflict !== undefined) {
        throw new Error(
          `The proposed plan conflicts with active task ` +
            activeConflict.taskIds.find((id) => id !== entry.task.id) +
            `: ${activeConflict.explanation}`,
        );
      }
      // And against everything running outside this run, which the wave above
      // cannot see. A new plan is a new claim on the repository whether it
      // widens the old one or merely points somewhere else.
      if (this.planAuthority !== undefined) {
        const answer = await this.planAuthority.admit({
          task: entry.task,
          plan: revisedPlan,
          planRevision: entry.planRevision + 1,
          baseVersion: waveVersion,
          repository: input.repository,
          ...(input.projectId === undefined
            ? {}
            : { projectId: input.projectId }),
          revising: true,
          // All-or-nothing: this agent is mid-execution and its old plan is
          // still in force, so a refusal leaves it somewhere workable. A
          // narrower grant would not — see below.
          partialAdmission: false,
        });
        if (answer.outcome !== "admitted") {
          throw new Error(
            `The proposed plan overlaps work running elsewhere in this ` +
              `repository: ${answer.explanation}`,
          );
        }
        // An authority that narrowed anyway is refused rather than obeyed.
        // `revisedPlan` is what ownership is taken on and what the changeset
        // is later held to, so accepting a narrower grant here would leave the
        // withheld file inside the plan the validator checks against — it
        // would pass, and reach canonical while another task holds its lease.
        // Silently promoting somebody else's file is worse than this refusal.
        if (answer.admission !== undefined) {
          throw new Error(
            `The proposed plan overlaps work running elsewhere in this ` +
              `repository: ${answer.admission.explanation}`,
          );
        }
      }
      const reasons = this.approvalPolicy.planReasons(revisedPlan);
      if (reasons.length > 0) {
        await this.requireApproval(
          input,
          entry,
          "policy_override",
          reasons,
          recorder,
          runAudit,
        );
      }
      const leases = this.ownership.acquire(
        revisedPlan,
        entry.task.agentId,
        waveVersion.sequence,
        { approvedResources: approvedSchemaResources(revisedPlan) },
      );
      entry.plan = revisedPlan;
      entry.planRevision += 1;
      entry.decision.planRevision = entry.planRevision;
      entry.decision.ownershipGrants.push(...leases);
      await recorder?.leases(leases);
      await recorder?.planRevision(entry.task.id, {
        revision: entry.planRevision,
        reason: "agent_replan",
        canonicalRevision: waveVersion.revision,
        plan: revisedPlan,
      });
      await recorder?.decision(entry.decision);
      await this.trace(recorder, runAudit, "plan_revised", entry.task.id, {
        requestId,
        revision: entry.planRevision,
        reason: event.reason.trim(),
        proposedBy: "agent",
        expectedFiles: revisedPlan.expectedFiles,
      });
      decision = {
        requestId,
        taskId: entry.task.id,
        decision: reasons.length > 0 ? "approved_with_constraints" : "approved",
        revisedPlan,
        constraints:
          reasons.length > 0
            ? ["The replan received required human approval"]
            : [],
        ownershipGrants: leases,
        explanation: "The proposed plan is conflict-free and now in force",
        decidedAt: new Date().toISOString(),
      };
    } catch (error) {
      decision = {
        requestId,
        taskId: entry.task.id,
        decision: "rejected",
        revisedPlan: entry.plan,
        constraints: ["Continue within the previously approved plan"],
        ownershipGrants: [],
        explanation: errorMessage(error),
        decidedAt: new Date().toISOString(),
      };
      await this.trace(recorder, runAudit, "replan_requested", entry.task.id, {
        requestId,
        proposedBy: "agent",
        refused: true,
        explanation: decision.explanation,
      });
    }
    // The same reply a scope change gets: the answer to "may I work to this
    // plan instead" has the shape of the answer to "may I widen this plan".
    await entry.adapter
      .resolveScopeChange(entry.session.id, decision)
      .catch(() => undefined);
  }

  /**
   * Puts an agent's request to the platform and hands back what happened.
   *
   * Never throws at the agent. Every path here ends in an answer it can act
   * on — a deployment that does nothing, a cap it has reached, an authority
   * that failed — because the agent is blocked waiting and has an approved
   * plan it can still work inside. A refusal costs it one round trip; an
   * exception would cost the whole task.
   */
  private async handleActionRequest(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    event: { requestId?: string; action: string },
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    const requestId = event.requestId?.trim() || createId("action");
    const action = event.action.trim();
    const spent = (this.actionsUsed.get(entry.task.id) ?? 0) + 1;
    this.actionsUsed.set(entry.task.id, spent);

    await this.trace(recorder, runAudit, "action_requested", entry.task.id, {
      requestId,
      action,
      repositoryId: input.repository.id,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });

    const answer =
      this.actionAuthority === undefined
        ? {
            outcome: "refused" as const,
            explanation:
              "This deployment does not perform actions. Carry on within " +
              "the plan you already have.",
          }
        : spent > MAX_ACTIONS_PER_TASK
          ? {
              outcome: "refused" as const,
              explanation:
                `This task has already asked for ${String(
                  MAX_ACTIONS_PER_TASK,
                )} actions, which is the limit.`,
            }
          : await this.actionAuthority
              .perform({
                task: entry.task,
                repository: input.repository,
                ...(input.projectId === undefined
                  ? {}
                  : { projectId: input.projectId }),
                action,
                // The task's own checkout, not canonical: an agent looking at
                // its own work wants the change it just made, and canonical
                // does not have it yet.
                workspacePath: this.taskWorkspacePaths.get(entry.task.id) ?? "",
              })
              .catch((error: unknown) => ({
                outcome: "refused" as const,
                explanation: `The action failed: ${errorMessage(error)}`,
              }));

    await this.trace(recorder, runAudit, "action_performed", entry.task.id, {
      requestId,
      action,
      outcome: answer.outcome,
      explanation: answer.explanation,
      repositoryId: input.repository.id,
    });

    // An adapter whose CLI never emits the event has no reason to implement
    // the reply, so this is optional and its absence is not an error.
    await entry.adapter
      .resolveAction?.(entry.session.id, {
        requestId,
        action,
        outcome: answer.outcome,
        ...(answer.detail === undefined ? {} : { detail: answer.detail }),
        explanation: answer.explanation,
      })
      .catch(() => undefined);
  }

  private async prepareTask(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    wave: readonly PlannedTask[],
    waveVersion: CanonicalVersion,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
    /** This run's own queue: tasks held back, some of them behind this one. */
    waiting: readonly PlannedTask[],
  ): Promise<PreparedTask | TaskExecutionResult> {
    let workspace: TaskWorkspace | undefined;
    try {
      const planReasons = [
        ...this.approvalPolicy.planReasons(entry.plan),
        ...entry.decision.constraints.filter((constraint) =>
          constraint.startsWith("Human approval required"),
        ),
      ];
      if (planReasons.length > 0) {
        await recorder?.status(
          entry.task.id,
          "awaiting_approval",
          planReasons.join("; "),
        );
        await this.requireApproval(
          input,
          entry,
          "policy_override",
          planReasons,
          recorder,
          runAudit,
        );
      }

      const leases = this.ownership.acquire(
        entry.plan,
        entry.task.agentId,
        waveVersion.sequence,
        {
          approvedResources: approvedSchemaResources(entry.plan),
        },
      );
      entry.decision.ownershipGrants.push(...leases);
      await recorder?.leases(leases);
      await this.trace(
        recorder,
        runAudit,
        "ownership_granted",
        entry.task.id,
        { leases },
      );

      // A resumed conversation keeps its directory and catches the checkout
      // up to this wave's canonical instead of building a workspace from
      // nothing — `node_modules`, build output and scratch survive, which is
      // most of what makes a second turn faster than a first. The advance
      // lands exactly on waveVersion, so the changeset base check below
      // holds for a continued turn the same way it does for a fresh one.
      workspace =
        entry.resumed === undefined
          ? await this.workspaces.create({
              taskId: entry.task.id,
              rootPath: input.workspaceRoot,
              repository: input.repository,
              baseVersion: waveVersion,
            })
          : await this.advanceWorkspace(entry.resumed.workspace, {
              taskId: entry.task.id,
              baseVersion: waveVersion,
            });
      entry.decision.workspaceId = workspace.id;
      this.taskWorkspacePaths.set(entry.task.id, workspace.path);
      this.taskWorkspaces.set(entry.task.id, workspace);
      await recorder?.decision(entry.decision);
      await recorder?.workspace({
        id: workspace.id,
        taskId: entry.task.id,
        path: workspace.path,
        isolation: workspace.isolation,
        baseRevision: workspace.baseVersion.revision,
        createdAt: workspace.createdAt,
      });
      await recorder?.status(entry.task.id, "running");
      await this.trace(recorder, runAudit, "task_started", entry.task.id, {
        workspaceId: workspace.id,
        baseRevision: waveVersion.revision,
        planRevision: entry.planRevision,
      });

      const eventErrors: unknown[] = [];
      // The same workspace, in a binding the event closure can see is there.
      const taskWorkspace = workspace;
      let eventChain = Promise.resolve();
      await entry.adapter.streamEvents(entry.session.id, (event) => {
        eventChain = eventChain
          .then(
            async () =>
              await this.handleAgentEvent(
                input,
                entry,
                wave,
                waveVersion,
                event,
                // Only the release path reads it, and only to refuse letting
                // go of a file the agent has already edited.
                taskWorkspace,
                recorder,
                runAudit,
              ),
          )
          .catch(async (error: unknown) => {
            eventErrors.push(error);
            try {
              await entry.adapter.cancel(entry.session.id);
            } catch (cancelError) {
              eventErrors.push(cancelError);
            }
          });
      });
      // The one stretch of a run that says nothing.
      //
      // Everything either side of this reports: planning, admission,
      // collection, validation. `sendContext` is a single await around the
      // agent's whole edit phase — up to an hour — and the adapters emit
      // nothing inside it, so a thread went quiet after "execution started"
      // and stayed quiet until the run ended. There was no way to tell work
      // from a hang.
      //
      // Read from the worktree rather than from the agent: it is what is
      // actually true on disk, it needs no cooperation from any vendor CLI,
      // and it works the same for every adapter.
      const watching = this.watchWorkingChanges(
        workspace,
        entry.task.id,
        recorder,
        runAudit,
      );
      // A repository-wide claim only lasts as long as nobody else wants the
      // repository. This is what notices somebody does, and narrows the claim
      // to what this agent has already touched — read from the worktree at
      // that moment, not from the poll above, whose whole purpose is to
      // report a view that is allowed to lag.
      const freezing = this.watchBlanketClaim(
        input,
        entry,
        waveVersion,
        workspace,
        recorder,
        runAudit,
      );
      // What the release path was always missing: whoever is queued behind
      // this task's plan, told to this agent while it still holds it. The
      // first pass is awaited so a queue that already exists reaches the
      // prompt of the round the agent starts on.
      const contending = this.watchScopeContention(
        input,
        entry,
        waiting,
        recorder,
        runAudit,
      );
      await contending.first;
      // Held rather than thrown: when an event handler fails, its catch
      // cancels this session, and what rejects out of `sendContext` is the
      // echo of that teardown — "Session … was cancelled" — not the cause.
      // Throwing it here skipped the event-error aggregation below on
      // exactly the runs that had one, which is how a thread ended up
      // naming the cancel and never the reason for it.
      let contextFailure: unknown;
      let contextFailed = false;
      try {
        await entry.adapter.sendContext(entry.session.id, {
          decision: entry.decision,
          canonicalVersion: waveVersion,
          workspacePath: workspace.path,
          planRevision: entry.planRevision,
        });
      } catch (error) {
        contextFailure = error;
        contextFailed = true;
      } finally {
        await watching.stop();
        await freezing.stop();
        await contending.stop();
      }
      await eventChain;
      if (eventErrors.length > 0) {
        throw new AggregateError(
          contextFailed ? [...eventErrors, contextFailure] : eventErrors,
          `Agent events failed for task ${entry.task.id}`,
        );
      }
      if (contextFailed) {
        throw contextFailure;
      }

      // What the run spent, written where the budget throttle and the room's
      // stats both read. Every adapter has reported this for as long as the
      // method has existed, and only the remote worker ever asked — the
      // in-process runner threw the answer away, so a deployment with no
      // remote fleet showed "0 tokens spent" against months of work.
      // Best-effort on purpose: a run must never fail over bookkeeping.
      if (this.store !== undefined) {
        try {
          for (const usage of entry.adapter.reportedTokenUsage?.(
            entry.session.id,
          ) ?? []) {
            await this.store.recordTokenUsage({
              usageKey: `${entry.session.id}:${usage.phase}`,
              repositoryId: input.repository.id,
              ...(input.projectId === undefined
                ? {}
                : { projectId: input.projectId }),
              taskId: entry.task.id,
              agentId: entry.task.agentId,
              phase: usage.phase,
              totalTokens: usage.totalTokens,
              ...(usage.inputTokens === undefined
                ? {}
                : { inputTokens: usage.inputTokens }),
              ...(usage.outputTokens === undefined
                ? {}
                : { outputTokens: usage.outputTokens }),
              ...(usage.freshTokens === undefined
                ? {}
                : { freshTokens: usage.freshTokens }),
              recordedAt: new Date().toISOString(),
            });
          }
        } catch {
          // Unpriced work still lands.
        }
      }
      let changeSet = await entry.adapter.collectChanges(entry.session.id);
      if (
        changeSet.taskId !== entry.task.id ||
        changeSet.baseRevision !== waveVersion.revision ||
        changeSet.baseVersion !== waveVersion.sequence
      ) {
        throw new Error(
          `Agent ${entry.task.agentId} returned a changeset for an unexpected task or base`,
        );
      }
      // A partial admission hands the agent a narrower plan than it wrote, and
      // agents do not reliably stay inside one — this one planned two files,
      // was granted one, and wrote both. A file the admission deliberately
      // withheld is not a scope escape: it is the half another task is holding,
      // and it belongs in the deferred bucket rather than failing the whole
      // task and losing the granted work with it. Only a path in neither
      // bucket was never arbitrated at all, and that is still refused.
      //
      // The worker path has split like this since partial admission shipped.
      // This one validated the raw changeset against the reduced plan, so the
      // same run succeeded or failed on which executor happened to pick it up.
      //
      // The index goes with it, which is what makes a withheld *symbol* mean
      // anything here. `splitChangeSet` can only divide a file at the hunks
      // that reach a withheld symbol if something can say where that symbol
      // lives, and it is deliberately pessimistic when nothing can: an
      // unlocatable symbol is treated as touched by every hunk, so the whole
      // file is held back rather than promoted on an assumption. Calling this
      // without the index therefore did not disable hunk-level division so
      // much as guarantee its worst case — every symbol-level withholding
      // collapsed to a whole-file deferral, on the one executor this
      // deployment actually runs. The division logic was right and tested the
      // whole time; nothing ever handed it the answer it needed.
      //
      // Fetched only when a symbol was actually withheld. The file-level case
      // is settled by the plan alone, the common case defers nothing at all,
      // and the index is cached per revision — the wave has already built this
      // one — so the lookup is a hit rather than a second parse of the tree.
      const deferredResources = entry.admission?.deferredResources ?? [];
      const symbolIndex = deferredResources.some(
        (resource) => resource.resourceType === "symbol",
      )
        ? await this.intelligence.index(input.repository, waveVersion.revision)
        : undefined;
      const split =
        entry.admission === undefined || deferredResources.length === 0
          ? undefined
          : splitChangeSet(
              entry.plan,
              entry.admission,
              changeSet,
              symbolIndex === undefined
                ? undefined
                : (file) =>
                    this.intelligence.symbolRangesInFile(symbolIndex, file),
            );
      if (split !== undefined && split.escaped.length > 0) {
        throw new ScopeExpansionError(split.escaped);
      }
      const granted = split?.granted ?? changeSet;
      // A claim frozen from observation can be narrower than the sweep it was
      // taken in the middle of: three files of a directory were on disk, the
      // fourth was written a minute later. That file was never refused to
      // anyone — it is simply outside a claim nobody predicted — so it is put
      // through the same widening every other mid-run reach goes through, and
      // only a genuine collision ends the task.
      await this.widenFrozenClaim(
        input,
        entry,
        waveVersion,
        granted,
        recorder,
        runAudit,
      );
      assertChangeSetWithinPlan(entry.plan, granted);
      changeSet = granted;
      await recorder?.changeSet(changeSet);
      await this.trace(
        recorder,
        runAudit,
        "changeset_collected",
        entry.task.id,
        {
          changeSetId: changeSet.id,
          files: changeSet.patches.map((patch) => patch.path),
          // The same list with what happened to each file, and how much of it.
          // `files` stays as it is because the narration reads it; this is the
          // authoritative final set for the summary that hangs off the thread,
          // which the live poll can only approximate — it stops when the agent
          // does, and the last edits land between its final tick and this.
          //
          // The counts were missing here while the worker path counted the
          // same patches inline, so whether a thread showed "+12 −3" or bare
          // paths came down to which executor had run the task. Shared now, so
          // the four emitters of this event cannot disagree again.
          changedFiles: summariseChangedFiles(changeSet.patches),
        },
      );

      const reviewReasons = this.approvalPolicy.changesetReasons(
        entry.plan,
        changeSet,
        { planWasReviewed: true },
      );
      if (reviewReasons.length > 0) {
        await recorder?.status(
          entry.task.id,
          "awaiting_approval",
          reviewReasons.join("; "),
        );
        await this.requireApproval(
          input,
          entry,
          "changeset",
          reviewReasons,
          recorder,
          runAudit,
          { changeSetId: changeSet.id },
        );
      }
      return {
        ...entry,
        workspace,
        changeSet,
        ...(split === undefined ? {} : { split }),
      };
    } catch (error) {
      const failures = [errorMessage(error)];
      // A failed turn tears down completely, resumed conversation included.
      // Before the advance ran, the held directory is the only workspace to
      // destroy; after it, `workspace` is the same directory under its new
      // record — `??` picks exactly one so nothing is destroyed twice.
      const cleanupFailure = await this.cleanupTask(
        entry,
        workspace ?? entry.resumed?.workspace,
        recorder,
        runAudit,
      );
      if (cleanupFailure !== undefined) {
        failures.push(cleanupFailure);
      }
      // A stop delivered mid-session surfaces here as whatever error the
      // torn-down session produced. That ending is not a failure: whoever
      // stopped the task already settled its row and its audit trail, and a
      // task_failed on top would hand the thread two contradictory endings.
      const stopReason = this.cancellations?.reasonFor(entry.task.id);
      if (stopReason !== undefined) {
        await recorder?.status(entry.task.id, "cancelled", stopReason);
        return {
          task: entry.task,
          plan: entry.plan,
          decision: entry.decision,
          status: "cancelled",
          explanation: stopReason,
        };
      }
      const explanation = failures.join("; ");
      await recorder?.status(entry.task.id, "failed", explanation);
      await this.trace(recorder, runAudit, "task_failed", entry.task.id, {
        stage: "execution",
        error: explanation,
      });
      return {
        task: entry.task,
        plan: entry.plan,
        decision: entry.decision,
        status: "failed",
        explanation,
      };
    }
  }

  /**
   * Puts an agent's question to whoever is watching, and bounds the wait.
   *
   * The deadline is the whole design. A question costs more than a message:
   * the agent holds its workspace and its ownership leases while it waits, so
   * every task that needs one of those files queues behind an unanswered
   * question. Waiting as long as the run is allowed to live would turn a
   * question nobody saw into an hour of nothing, ending in a timeout that
   * says nothing about why.
   *
   * Silence cancels rather than defaults. The agent asked because the choice
   * was not its to make, and nobody answering does not hand it back — a
   * default would be the platform deciding on the operator's behalf and
   * calling it consent. Cancelling is recoverable: the question is on the
   * record, and asking again costs one run.
   */
  private async answerAgentQuestion(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    event: Extract<AgentEvent, { event: "question_asked" }>,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    const requestId = event.requestId ?? createId("question");
    const questions = agentQuestionSet(event);
    const first = questions[0];
    await this.trace(recorder, runAudit, "question_asked", entry.task.id, {
      requestId,
      question: first?.question ?? event.question,
      options: first?.options ?? event.options,
      // The whole set, so a reader that can show more than one does not have
      // to go back to the run to find the rest.
      questions,
      // So a reader knows how long they have, rather than discovering the
      // deadline by missing it.
      deadlineMs: this.questionDeadlineMs,
    });
    const answered = await this.questions
      ?.awaitAnswer({
        requestId,
        taskId: entry.task.id,
        repositoryId: input.repository.id,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        question: first?.question ?? event.question,
        options: [...(first?.options ?? event.options)],
        questions,
        deadlineMs: this.questionDeadlineMs,
      })
      .catch(() => undefined);
    // Answered means somebody engaged with the prompt at all. Skipping every
    // question is still an answer — it says "your call" — and only silence
    // cancels, which is the distinction the deadline exists to draw.
    const choices: QuestionChoice[] = answered?.answers ?? [];
    const chosen = answered?.chosen ?? choices[0]?.chosen;
    const engaged =
      answered !== undefined && (chosen !== undefined || choices.length > 0);
    const answer: QuestionAnswer = engaged
      ? {
          requestId,
          status: "answered",
          ...(chosen === undefined ? {} : { chosen }),
          ...(choices.length === 0 ? {} : { answers: choices }),
        }
      : { requestId, status: "cancelled" };
    await this.trace(
      recorder,
      runAudit,
      answer.status === "answered" ? "question_answered" : "question_cancelled",
      entry.task.id,
      {
        requestId,
        ...(answer.chosen === undefined
          ? {}
          : { chose: questions[0]?.options[answer.chosen] ?? "" }),
        ...(choices.length === 0
          ? {}
          : {
              chose_all: choices.map((choice, index) =>
                choice.skipped === true
                  ? "(skipped)"
                  : (choice.text ??
                    questions[index]?.options[choice.chosen ?? -1] ??
                    ""),
              ),
            }),
      },
    );
    // Handed back either way. The adapter is blocked on this call, and a
    // resolver that threw would leave it waiting on a promise nothing will
    // ever settle — the run would then die on the execution timeout instead
    // of the deadline that was actually missed.
    await entry.adapter.resolveQuestion?.(entry.session.id, answer);
  }

  private async handleAgentEvent(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    wave: readonly PlannedTask[],
    waveVersion: CanonicalVersion,
    event: AgentEvent,
    workspace: TaskWorkspace,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    if (event.event === "progress") {
      await this.trace(recorder, runAudit, "agent_progress", entry.task.id, {
        message: event.message,
        occurredAt: event.occurredAt,
      });
      return;
    }
    if (event.event === "question_asked") {
      await this.answerAgentQuestion(input, entry, event, recorder, runAudit);
      return;
    }
    if (event.event === "completed") {
      return;
    }
    if (event.event === "action_requested") {
      await this.handleActionRequest(input, entry, event, recorder, runAudit);
      return;
    }
    if (event.event === "scope_release_requested") {
      await this.handleScopeRelease(
        input,
        entry,
        waveVersion,
        workspace,
        event,
        recorder,
        runAudit,
      );
      return;
    }
    if (event.event === "replan_proposed") {
      await this.handleReplanProposal(
        input,
        entry,
        wave,
        waveVersion,
        event,
        recorder,
        runAudit,
      );
      return;
    }

    const request: ScopeChangeRequest = {
      id: event.requestId?.trim() || createId("scope"),
      taskId: entry.task.id,
      additionalFiles: event.additionalFiles.map(normalizeRepositoryPath),
      additionalSymbols: uniqueStrings(event.additionalSymbols ?? []),
      additionalApis: uniqueStrings(event.additionalApis ?? []),
      additionalSchemas: uniqueStrings(event.additionalSchemas ?? []),
      additionalConfigKeys: uniqueStrings(event.additionalConfigKeys ?? []),
      additionalTests: uniqueStrings(event.additionalTests ?? []),
      additionalServices: uniqueStrings(event.additionalServices ?? []),
      reason: event.reason.trim(),
      occurredAt: event.occurredAt,
    };
    await recorder?.scopeChange(request);
    await this.trace(
      recorder,
      runAudit,
      "scope_change_requested",
      entry.task.id,
      { request },
    );

    let decision: ScopeChangeDecision;
    try {
      const resourceCount =
        request.additionalFiles.length +
        request.additionalSymbols.length +
        request.additionalApis.length +
        request.additionalSchemas.length +
        request.additionalConfigKeys.length +
        request.additionalTests.length +
        request.additionalServices.length;
      if (resourceCount === 0 || request.reason.length === 0) {
        throw new Error(
          "Scope expansion must name at least one resource and explain why",
        );
      }
      // A scope expansion is a new set of declarations, and mid-run is when
      // an agent is most likely to name what it merely believes exists — so
      // the revised plan is verified the same way the original was.
      const revisedPlan = groundPlan(
        mergePlanScope(entry.plan, request),
        await this.intelligence.index(input.repository, waveVersion.revision),
      );
      const activeConflict = wave
        .filter((candidate) => candidate.task.id !== entry.task.id)
        .map((candidate) => this.conflicts.assess(revisedPlan, candidate.plan))
        .find(
          (assessment) =>
            assessment !== undefined && structuralConflict(assessment),
        );
      if (activeConflict !== undefined) {
        throw new Error(
          `Scope expansion conflicts with active task ` +
            activeConflict.taskIds.find((id) => id !== entry.task.id) +
            `: ${activeConflict.explanation}`,
        );
      }
      // The check above sees this run's own wave and nothing else, which is
      // the same blind spot admission had before it read durable leases: an
      // agent could widen into a file a task in another run was already
      // holding, and nothing noticed until both tried to land.
      //
      // A widening is refused rather than queued. Everywhere else a deferral
      // means "wait and try again", but this agent is mid-execution with an
      // approved plan it can still work inside — telling it to carry on is a
      // real answer, and holding a running agent idle waiting for a lease is
      // not.
      if (this.planAuthority !== undefined) {
        const answer = await this.planAuthority.admit({
          task: entry.task,
          plan: revisedPlan,
          planRevision: entry.planRevision + 1,
          baseVersion: waveVersion,
          repository: input.repository,
          ...(input.projectId === undefined
            ? {}
            : { projectId: input.projectId }),
          // Replaces a contract that was already approved, which is the one
          // case the store lets a plan be rewritten — and only because the
          // rewrite has just been decided against every other holder.
          revising: true,
          // The same all-or-nothing rule the comment above states for a
          // deferral, applied to a narrower grant: both are "not the whole
          // thing", and this caller can act on neither.
          partialAdmission: false,
        });
        if (answer.outcome === "admitted" && answer.admission !== undefined) {
          // Refused for the reason the wave loop welcomes a partial grant and
          // this path cannot: there, the reduced plan becomes the contract. On
          // this path `revisedPlan` is what ownership is taken on and what the
          // changeset is validated against, so a withheld file would sit
          // inside the approved plan, pass the check, and land while another
          // task holds its lease.
          throw new Error(
            `Scope expansion overlaps work running elsewhere in this ` +
              `repository: ${answer.admission.explanation}`,
          );
        }
        if (answer.outcome !== "admitted") {
          throw new Error(
            `Scope expansion overlaps work running elsewhere in this ` +
              `repository: ${answer.explanation}`,
          );
        }
      }

      const reasons = this.approvalPolicy.scopeReasons(revisedPlan, request);
      if (reasons.length > 0) {
        await this.requireApproval(
          input,
          entry,
          "scope_change",
          reasons,
          recorder,
          runAudit,
          { scopeChangeId: request.id },
        );
      }
      const leases = this.ownership.acquire(
        revisedPlan,
        entry.task.agentId,
        waveVersion.sequence,
        { approvedResources: approvedSchemaResources(revisedPlan) },
      );
      entry.plan = revisedPlan;
      entry.planRevision += 1;
      entry.decision.planRevision = entry.planRevision;
      entry.decision.ownershipGrants.push(...leases);
      await recorder?.leases(leases);
      await recorder?.planRevision(entry.task.id, {
        revision: entry.planRevision,
        reason: "scope_change",
        canonicalRevision: waveVersion.revision,
        plan: revisedPlan,
      });
      await recorder?.decision(entry.decision);
      decision = {
        requestId: request.id,
        taskId: entry.task.id,
        decision: reasons.length > 0
          ? "approved_with_constraints"
          : "approved",
        revisedPlan,
        constraints:
          reasons.length > 0
            ? ["Scope expansion received required human approval"]
            : [],
        ownershipGrants: leases,
        explanation: "Scope expansion is conflict-free and ownership was granted",
        decidedAt: new Date().toISOString(),
      };
    } catch (error) {
      decision = {
        requestId: request.id,
        taskId: entry.task.id,
        decision: "rejected",
        revisedPlan: entry.plan,
        constraints: ["Continue within the previously approved plan"],
        ownershipGrants: [],
        explanation: errorMessage(error),
        decidedAt: new Date().toISOString(),
      };
    }

    await recorder?.scopeDecision(decision);
    await this.trace(
      recorder,
      runAudit,
      "scope_change_decided",
      entry.task.id,
      { decision },
    );
    await entry.adapter.resolveScopeChange(entry.session.id, decision);
  }

  /**
   * An agent giving part of its approved plan back, mid-run.
   *
   * The mirror of the widening path above, and deliberately built from the
   * same pieces: one request, one decision, one plan revision, and the
   * adapter unblocked either way. A plan that named twenty-two files and
   * touched eight otherwise holds all twenty-two until the task settles, and
   * every other agent that needs one of the fourteen waits on work that
   * finished an hour ago.
   *
   * Three things make this safe rather than a new way to deadlock:
   *
   * - It is the agent that asks, not the coordinator that infers. Release at
   *   collection would look cheaper, but conflict repair sends the agent back
   *   into files it had already finished with — `repairChangeSet` re-collects
   *   and re-validates against this same plan — so a file dropped at
   *   collection could be handed back to the agent seconds later with neither
   *   the lease nor the plan entry it needs, and the re-collection would fail
   *   the whole task on a scope escape.
   * - The plan narrows with the leases, in one step. Dropping ownership alone
   *   would leave the agent believing it may still write a file another task
   *   now owns, which is exactly the double-claim the leases exist to stop.
   * - Getting a released file back is a widening like any other, and the
   *   widening path refuses on the spot rather than queueing. Nothing here
   *   waits for a lease, so releasing early cannot turn incremental
   *   acquisition into a cycle: an agent that is refused carries on inside
   *   what it still holds and reports what it could not do.
   */
  private async handleScopeRelease(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    waveVersion: CanonicalVersion,
    workspace: TaskWorkspace,
    event: Extract<AgentEvent, { event: "scope_release_requested" }>,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    const request: ScopeReleaseRequest = {
      id: event.requestId?.trim() || createId("scope"),
      taskId: entry.task.id,
      releasedFiles: uniqueRepositoryPaths(event.releasedFiles),
      releasedSymbols: uniqueStrings(event.releasedSymbols ?? []),
      releasedApis: uniqueStrings(event.releasedApis ?? []),
      releasedSchemas: uniqueStrings(event.releasedSchemas ?? []),
      releasedConfigKeys: uniqueStrings(event.releasedConfigKeys ?? []),
      releasedTests: uniqueStrings(event.releasedTests ?? []),
      releasedServices: uniqueStrings(event.releasedServices ?? []),
      reason: event.reason.trim(),
      occurredAt: event.occurredAt,
    };
    await this.trace(
      recorder,
      runAudit,
      "scope_release_requested",
      entry.task.id,
      { request },
    );

    let decision: ScopeChangeDecision;
    try {
      const asked = scopeReleaseResources(request);
      if (asked.length === 0 || request.reason.length === 0) {
        throw new Error(
          "A scope release must name at least one resource and explain why",
        );
      }
      // Only what this plan actually claims. A resource the plan never named
      // cannot be given back, and quietly "releasing" it would answer granted
      // to a request that changed nothing.
      const claimed = planClaimedResources(entry.plan);
      const resources = asked
        .map((resource) =>
          claimed.get(
            planResourceKey(resource.resourceType, resource.resourceId),
          ),
        )
        .filter(
          (resource): resource is PlanResourceRef => resource !== undefined,
        );
      if (resources.length === 0) {
        throw new Error(
          "None of the named resources are in the approved plan, so there " +
            "is nothing to release",
        );
      }
      // A file with edits in it is not finished with, whatever the agent
      // believes. Released, its lease would go to somebody else while this
      // task still holds a change to it in its workspace — two agents editing
      // one file, which is the situation ownership exists to prevent.
      //
      // An unanswerable question is answered the same way as a bad one: a
      // workspace manager that cannot report working changes cannot prove the
      // file is clean, so the release is refused rather than assumed safe.
      const releasedFiles = new Set(
        resources
          .filter((resource) => resource.resourceType === "file")
          .map((resource) => resource.resourceId),
      );
      if (releasedFiles.size > 0) {
        if (this.workspaces.listWorkingChanges === undefined) {
          throw new Error(
            "This workspace cannot report uncommitted edits, so no file can " +
              "be shown to be finished with",
          );
        }
        const working = await this.workspaces.listWorkingChanges(workspace);
        const edited = working
          .map((change) => change.path)
          .filter((changed) => releasedFiles.has(changed));
        if (edited.length > 0) {
          throw new Error(
            `Uncommitted edits are still in ${edited.join(", ")}, so ` +
              "they cannot be released",
          );
        }
      }

      const revisedPlan = reducePlanScope(entry.plan, resources);
      // The durable record of what this task is executing, rewritten the same
      // way a widening rewrites it. Without this the control plane still
      // shows the wide plan, and a task in another run keeps being refused
      // the files this one has just given up.
      //
      // A narrowing cannot collide with anything — it is a subset of a plan
      // already admitted against every other holder — so anything other than
      // an admission here is a failure to record, not a contended file. It is
      // taken as a refusal and nothing is released: an agent told its files
      // were freed while the record still claims them is worse than one told
      // to keep them.
      if (this.planAuthority !== undefined) {
        const answer = await this.planAuthority.admit({
          task: entry.task,
          plan: revisedPlan,
          planRevision: entry.planRevision + 1,
          baseVersion: waveVersion,
          repository: input.repository,
          ...(input.projectId === undefined
            ? {}
            : { projectId: input.projectId }),
          revising: true,
          partialAdmission: false,
        });
        if (answer.outcome !== "admitted") {
          throw new Error(
            `The narrowed plan could not be recorded: ${answer.explanation}`,
          );
        }
        // A grant of less than the narrowed plan, for the same reason the
        // widening path refuses one: what is released here is decided from
        // `revisedPlan`, so a further-reduced record would leave the agent
        // holding files the record says are somebody else's.
        if (answer.admission !== undefined) {
          throw new Error(
            `The narrowed plan could not be recorded whole: ` +
              answer.admission.explanation,
          );
        }
      }

      const released = this.ownership.releaseResources(
        entry.task.id,
        resources,
      );
      entry.plan = revisedPlan;
      entry.planRevision += 1;
      entry.decision.planRevision = entry.planRevision;
      const releasedIds = new Set(released.map((lease) => lease.leaseId));
      entry.decision.ownershipGrants = entry.decision.ownershipGrants.filter(
        (lease) => !releasedIds.has(lease.leaseId),
      );
      await recorder?.planRevision(entry.task.id, {
        revision: entry.planRevision,
        reason: "scope_release",
        canonicalRevision: waveVersion.revision,
        plan: revisedPlan,
      });
      await recorder?.decision(entry.decision);
      await this.trace(
        recorder,
        runAudit,
        "ownership_released",
        entry.task.id,
        {
          leaseIds: released.map((lease) => lease.leaseId),
          files: [...releasedFiles],
          stage: "scope_release",
        },
      );
      decision = {
        requestId: request.id,
        taskId: entry.task.id,
        decision: "approved",
        revisedPlan,
        constraints: [
          "The released resources are no longer yours to edit; ask for one " +
            "back with a scope change if that turns out to be wrong",
        ],
        ownershipGrants: [],
        explanation:
          `Released ${String(released.length)} lease(s); the plan now covers ` +
          `${String(revisedPlan.expectedFiles.length)} file(s)`,
        decidedAt: new Date().toISOString(),
      };
    } catch (error) {
      decision = {
        requestId: request.id,
        taskId: entry.task.id,
        decision: "rejected",
        revisedPlan: entry.plan,
        constraints: ["Continue within the previously approved plan"],
        ownershipGrants: [],
        explanation: errorMessage(error),
        decidedAt: new Date().toISOString(),
      };
    }

    await this.trace(
      recorder,
      runAudit,
      "scope_release_decided",
      entry.task.id,
      { decision },
    );
    // Handed back either way, like every other request the agent blocks on.
    await entry.adapter.resolveScopeChange(entry.session.id, decision);
  }

  private async requireApproval(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    kind: ApprovalKind,
    reasons: string[],
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
    references: { changeSetId?: string; scopeChangeId?: string } = {},
  ): Promise<void> {
    if (reasons.length === 0) {
      return;
    }
    if (recorder === undefined || this.approvals === undefined) {
      throw new Error(
        `Human approval is required but no durable approval controller is configured: ${reasons.join("; ")}`,
      );
    }
    const review = await this.approvals.review({
      ...(input.organizationId === undefined
        ? {}
        : { organizationId: input.organizationId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      repositoryId: input.repository.id,
      runId: recorder.runId,
      taskId: entry.task.id,
      kind,
      requestedBy: entry.task.agentId,
      reasons,
      ...(references.changeSetId === undefined
        ? {}
        : { changeSetId: references.changeSetId }),
      ...(references.scopeChangeId === undefined
        ? {}
        : { scopeChangeId: references.scopeChangeId }),
      onRequested: async (request) => {
        await this.trace(
          recorder,
          runAudit,
          "approval_requested",
          entry.task.id,
          {
            approvalId: request.id,
            kind: request.kind,
            reasons: request.reasons,
            expiresAt: request.expiresAt,
          },
        );
      },
    });
    await this.trace(
      recorder,
      runAudit,
      "approval_decided",
      entry.task.id,
      {
        approvalId: review.request.id,
        status: review.request.status,
        decidedBy: review.request.decidedBy,
        explanation: review.explanation,
      },
    );
    if (!review.approved) {
      throw new Error(
        `Human approval ${review.request.id} was not granted: ${review.explanation}`,
      );
    }
  }

  /**
   * The files a result still owes after integration answered.
   *
   * Two shapes reach here. Salvage kept most of a changeset and handed back
   * the contested remainder; or nothing could be kept at all and the whole
   * changeset is outstanding. Both are the same question to an agent that is
   * still holding the task: which files do you need to do again?
   */
  private contestedPaths(
    integration: IntegrationResult,
    changeSet: ChangeSet,
  ): string[] {
    if (integration.status === "conflict") {
      return [...new Set(changeSet.patches.map((patch) => patch.path))].sort();
    }
    return [
      ...new Set(
        (integration.salvagedDeferred ?? []).map((patch) => patch.path),
      ),
    ].sort();
  }

  /**
   * Asks the agent that just did the work to redo only what collided.
   *
   * The alternative this replaces is the expensive one: end the session, and
   * have a fresh agent rediscover the entire task from nothing — sixteen to
   * twenty-six times a run in the A/B series, at roughly 145k tokens each.
   * This session is still open and still has the task in context, and after
   * salvage the collision is usually a couple of lines, so what it is asked
   * costs a fraction of that.
   *
   * The contested files are reset to what canonical holds now before the
   * agent is asked. That matters: an agent shown its own losing copy has no
   * way to see what it is supposed to reconcile with, and would simply write
   * the same thing again.
   *
   * Exactly one attempt. A second collision means the file is genuinely
   * contended rather than merely overtaken, and the existing requeue is the
   * right answer for that — it is also what stops two agents trading repairs
   * for as long as they both keep losing.
   */
  private async repairChangeSet(
    input: CoordinatorRunInput,
    result: PreparedTask,
    contested: readonly string[],
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<ChangeSet | undefined> {
    const canonical = await this.repositories.getCanonicalVersion(
      input.repository,
    );
    // Show the agent the change it lost to, not its own copy of the file.
    for (const repositoryPath of contested) {
      const target = path.join(result.workspace.path, repositoryPath);
      try {
        const current = await this.repositories.readFile(
          input.repository,
          canonical.revision,
          repositoryPath,
        );
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, current, "utf8");
      } catch {
        // Absent from canonical means the other change deleted it. Leaving
        // the agent's copy in place is the honest state to reason from.
      }
    }

    await this.trace(recorder, runAudit, "replan_requested", result.task.id, {
      stage: "conflict_repair",
      files: [...contested],
      canonicalRevision: canonical.revision,
    });
    await recorder?.status(
      result.task.id,
      "running",
      `Reconciling ${contested.length} file(s) that changed underneath this work`,
    );

    await result.adapter.sendContext(result.session.id, {
      decision: result.decision,
      canonicalVersion: canonical,
      workspacePath: result.workspace.path,
      repair: {
        files: [...contested],
        reason:
          "These files changed in canonical while you were working, so your " +
          "edits to them were not kept. They have been reset to the current " +
          "canonical content. Re-apply only your intended change to them, on " +
          "top of what is now there. Everything else you did has already " +
          "been integrated — do not redo it.",
      },
    });

    const repaired = await result.adapter.collectChanges(result.session.id);
    assertChangeSetWithinPlan(result.plan, repaired);
    if (repaired.patches.length === 0) {
      return undefined;
    }
    await recorder?.changeSet(repaired);
    await this.trace(
      recorder,
      runAudit,
      "changeset_collected",
      result.task.id,
      {
        changeSetId: repaired.id,
        files: repaired.patches.map((patch) => patch.path),
        repairOf: result.changeSet.id,
      },
    );
    return repaired;
  }

  private async integrateTask(
    input: CoordinatorRunInput,
    result: PreparedTask,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<TaskExecutionResult> {
    let taskResult: TaskExecutionResult;
    try {
      await recorder?.status(result.task.id, "validating");
      let integration = await this.integrations.integrate({
        repository: input.repository,
        integrationRoot: input.integrationRoot,
        changeSet: result.changeSet,
        validationCommands: result.task.validationCommands,
        commitMessage: `coord(${result.task.id}): ${result.task.objective}`,
        author: agentCommitIdentity(result.task.agentId),
        trailers: [{ key: "Agent", value: result.task.agentId }],
        // Safe here in a way it is not everywhere: the agent is still open
        // below, so the half salvage cannot take is asked for rather than
        // dropped. A caller with nowhere to put the remainder must not set
        // this.
        salvageConflicts: this.repairConflicts,
      });

      const contested = this.repairConflicts
        ? this.contestedPaths(integration, result.changeSet)
        : [];
      if (contested.length > 0) {
        // A repair that cannot be attempted — an agent with no way to
        // reconcile, a cancelled session, a model that answers badly — must
        // not cost the work that already landed. Whatever salvage promoted is
        // in canonical, and the first answer stands.
        let repaired: ChangeSet | undefined;
        try {
          repaired = await this.repairChangeSet(
            input,
            result,
            contested,
            recorder,
            runAudit,
          );
        } catch (error) {
          await this.trace(recorder, runAudit, "task_failed", result.task.id, {
            stage: "conflict_repair",
            files: [...contested],
            error: errorMessage(error),
          });
        }
        if (repaired !== undefined) {
          // The repair is not privileged: same validation, same policy gate,
          // same compare-and-swap. A changeset a person had to approve the
          // first time is approved again here, because what it contains now
          // is not what they approved.
          const reviewReasons = this.approvalPolicy.changesetReasons(
            result.plan,
            repaired,
            { planWasReviewed: true },
          );
          if (reviewReasons.length > 0) {
            await recorder?.status(
              result.task.id,
              "awaiting_approval",
              reviewReasons.join("; "),
            );
            await this.requireApproval(
              input,
              result,
              "changeset",
              reviewReasons,
              recorder,
              runAudit,
              { changeSetId: repaired.id },
            );
          }
          const second = await this.integrations.integrate({
            repository: input.repository,
            integrationRoot: input.integrationRoot,
            changeSet: repaired,
            validationCommands: result.task.validationCommands,
            commitMessage: `coord(${result.task.id}): ${result.task.objective}`,
            author: agentCommitIdentity(result.task.agentId),
            trailers: [
              { key: "Agent", value: result.task.agentId },
              { key: "Conflict-Repair", value: contested.join(" ") },
            ],
            // One attempt. A second collision means genuine contention, and
            // the requeue that already exists is the right answer to that.
            salvageConflicts: false,
          });
          await recorder?.integration(second);
          await this.trace(
            recorder,
            runAudit,
            "validation_completed",
            result.task.id,
            {
              stage: "conflict_repair",
              status: second.status,
              files: [...contested],
            },
          );
          // A repair that fails leaves the first answer standing: whatever
          // salvage promoted is in canonical either way, and a failed second
          // pass must not present itself as the outcome of the task.
          if (second.status === "integrated") {
            integration = second;
          }
        }
      }
      await recorder?.integration(integration);
      // Reaching integration means the agent completed its run. A diff is one
      // possible deliverable, not proof that work happened: answers, audits,
      // reviews and platform actions all legitimately leave the repository
      // untouched. Inferring otherwise from the wording of the objective made
      // successful tasks fail whenever the intent heuristic missed a phrase.
      // Real execution failures arrive through the exception path below;
      // `empty` therefore completes by reporting the agent's own account.
      const reported = integration.status === "empty";
      // Nothing was validated because nothing was changed, and there is no
      // gate here to have passed or failed. Saying "validation came back
      // empty" in front of a finished report is the same false alarm this
      // whole branch exists to remove, one line earlier.
      if (!reported) {
        await this.trace(
          recorder,
          runAudit,
          "validation_completed",
          result.task.id,
          {
            status: integration.status,
            commands: integration.validation.map((entry) => ({
              label: entry.command.label,
              exitCode: entry.exitCode,
            })),
          },
        );
      }
      if ((integration.cleanupWarnings?.length ?? 0) > 0) {
        await this.trace(
          recorder,
          runAudit,
          "cleanup_failed",
          result.task.id,
          {
            stage: "integration",
            failures: integration.cleanupWarnings,
          },
        );
      }
      const agentAccount = result.changeSet.agentExplanation.trim();
      const explanation = reported
        ? // The agent's own words are the deliverable here — there is no diff
          // to read instead, and the generic line says nothing a reader can
          // use.
          agentAccount.length > 0
          ? agentAccount
          : "Reported without changing any files."
        : integration.explanation;
      if (integration.status === "integrated") {
        await this.trace(
          recorder,
          runAudit,
          "canonical_promoted",
          result.task.id,
          {
            // Where canonical moved, not just that it did. Anything watching a
            // repository rather than a run — the auditor — filters on these,
            // and `AuditEventFilter` has no repository term, so an event
            // without them is one it cannot place and silently skips. The
            // remote worker path has stamped both since the auditor was built;
            // this one never did, so every advance made in-process, which is
            // every advance a channel dispatch produces, was invisible to it.
            repositoryId: input.repository.id,
            ...(input.projectId === undefined
              ? {}
              : { projectId: input.projectId }),
            previousRevision: integration.previousVersion.revision,
            revision: integration.canonicalVersion.revision,
            changeSetId: integration.changeSetId,
            // What the agent says it did, carried so the ending can say it.
            // The account was written at `collectChanges` and travelled this
            // far unread: every successful task in the system ended with one
            // fixed sentence about canonical, which is true of all of them
            // and says nothing about any of them. The files are here for the
            // same reason — an ending that names them is worth more than one
            // that names a revision nobody will look up.
            //
            // The reader decides what to do with an empty or useless one; it
            // is reported as it stands rather than dressed up here.
            agentExplanation: result.changeSet.agentExplanation,
            files: result.changeSet.patches.map((patch) => patch.path),
          },
        );
        // Only now, with the granted half durably in canonical, does the half
        // that was withheld become work of its own. Queued earlier it would
        // ask for the remainder of something that never landed; not queued at
        // all — which is what happened here until now — the files this task
        // planned and was refused are simply never written by anyone, and the
        // task reports success having done part of the job.
        if (
          result.split !== undefined &&
          result.admission !== undefined &&
          this.planAuthority?.deferRemainder !== undefined
        ) {
          await this.planAuthority.deferRemainder({
            task: result.task,
            repository: input.repository,
            ...(input.projectId === undefined
              ? {}
              : { projectId: input.projectId }),
            admission: result.admission,
            split: result.split,
          });
        }
      } else if (reported) {
        await this.trace(
          recorder,
          runAudit,
          "task_reported",
          result.task.id,
          { explanation },
        );
      } else {
        await this.trace(
          recorder,
          runAudit,
          "task_failed",
          result.task.id,
          {
            status: integration.status,
            explanation: integration.explanation,
          },
        );
      }
      const status =
        integration.status === "integrated" || reported
          ? "integrated"
          : "failed";
      await recorder?.status(result.task.id, status, explanation);
      taskResult = {
        task: result.task,
        plan: result.plan,
        decision: result.decision,
        integration,
        status,
        explanation,
      };
    } catch (error) {
      await recorder?.status(result.task.id, "failed", errorMessage(error));
      await this.trace(recorder, runAudit, "task_failed", result.task.id, {
        stage: "integration",
        error: errorMessage(error),
      });
      taskResult = {
        task: result.task,
        plan: result.plan,
        decision: result.decision,
        status: "failed",
        explanation: errorMessage(error),
      };
    }

    let cleanupFailure: string | undefined;
    if (
      result.conversationId !== undefined &&
      taskResult.status === "integrated" &&
      taskResult.integration !== undefined
    ) {
      // The turn landed, so the conversation stays open: the session and
      // the directory are its memory, kept for the next turn. Its leases
      // are released like any other turn's — survival buys no standing
      // claim, and the next turn is arbitrated afresh against the world as
      // it is then. `syncedVersion` is canonical as this turn left it;
      // everything past it is somebody else's work, which is exactly the
      // question the next turn opens with. Only success keeps anything: the
      // failure arm below is the same full teardown every task gets.
      const failures: string[] = [];
      await this.releaseTurnLeases(
        result.task.id,
        recorder,
        runAudit,
        failures,
      );
      cleanupFailure = await this.finishCleanup(
        result.task.id,
        recorder,
        runAudit,
        failures,
      );
      const workspaces = this.workspaces;
      const workspace = result.workspace;
      // Read now, not remembered from the session's start: every vendor exec
      // may fork a fresh resume token, and the one worth keeping is the one
      // that names the state as this turn left it.
      const resume = result.adapter.resumeToken?.(result.session.id);
      await this.conversations.retain(result.conversationId, {
        adapter: result.adapter,
        agentId: result.task.agentId,
        session:
          resume === undefined
            ? result.session
            : { ...result.session, resume },
        workspace,
        // Captured here because the registry may outlive this coordinator
        // and its workspace manager; the conversation carries its own way
        // home.
        destroyWorkspace: async () => {
          await workspaces.destroy(workspace);
        },
        plan: result.plan,
        changeSet: result.changeSet,
        syncedVersion: taskResult.integration.canonicalVersion,
        lastLandedAt: Date.now(),
      });
    } else {
      cleanupFailure = await this.cleanupTask(
        result,
        result.workspace,
        recorder,
        runAudit,
      );
    }
    if (cleanupFailure !== undefined) {
      taskResult.explanation += `; ${cleanupFailure}`;
      await recorder?.status(
        result.task.id,
        taskResult.status,
        taskResult.explanation,
      );
    }
    return taskResult;
  }

  /**
   * Narrows a repository-wide claim as soon as somebody else is in the
   * repository, and stops as soon as it has.
   *
   * A timer rather than a signal because the arrival happens in another run,
   * often another process: the lease table is the only thing both sides can
   * see. What the timer decides is *when to look*, never what is true — the
   * worktree is read inside the freeze itself, so the narrowed claim is what
   * the agent had touched at the instant it was written, not at the last tick.
   *
   * Like the working-change poll, it is never allowed to disturb the run: a
   * freeze that cannot be written leaves the claim whole, which refuses the
   * arriving task rather than putting two agents in one file.
   */
  private watchBlanketClaim(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    waveVersion: CanonicalVersion,
    workspace: TaskWorkspace,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): { stop: () => Promise<void> } {
    const freeze = this.planAuthority?.freezeBlanketClaim?.bind(
      this.planAuthority,
    );
    const list = this.workspaces.listWorkingChanges?.bind(this.workspaces);
    if (
      freeze === undefined ||
      list === undefined ||
      !isBlanketClaim(entry.plan)
    ) {
      return { stop: async () => undefined };
    }
    let inFlight: Promise<void> = Promise.resolve();
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped || !isBlanketClaim(entry.plan)) {
        return;
      }
      let frozen: AgentPlan | undefined;
      try {
        frozen = await freeze({
          task: entry.task,
          plan: entry.plan,
          planRevision: entry.planRevision,
          repository: input.repository,
          ...(input.projectId === undefined
            ? {}
            : { projectId: input.projectId }),
          baseVersion: waveVersion,
          observe: async () => await list(workspace),
          estimatedFiles: entry.blanketEstimate ?? [],
        });
      } catch {
        return;
      }
      if (frozen === undefined) {
        return;
      }
      entry.plan = frozen;
      entry.planRevision += 1;
      entry.decision.planRevision = entry.planRevision;
      try {
        const leases = this.ownership.acquire(
          frozen,
          entry.task.agentId,
          waveVersion.sequence,
          { approvedResources: approvedSchemaResources(frozen) },
        );
        entry.decision.ownershipGrants.push(...leases);
        await recorder?.leases(leases);
      } catch {
        // The durable claim is what arbitration reads; the in-run ownership
        // ledger is a convenience on top of it, and a solo run has nobody to
        // take a lease from anyway.
      }
      await recorder?.planRevision(entry.task.id, {
        revision: entry.planRevision,
        reason: "scope_change",
        canonicalRevision: waveVersion.revision,
        plan: frozen,
      });
      await recorder?.decision(entry.decision);
      await this.trace(
        recorder,
        runAudit,
        "blanket_claim_frozen",
        entry.task.id,
        {
          repositoryId: input.repository.id,
          planRevision: entry.planRevision,
          files: frozen.expectedFiles,
          directories:
            frozen.claim?.kind === "frozen" ? frozen.claim.directories : [],
        },
      ).catch(() => undefined);
    };

    const timer = setInterval(() => {
      inFlight = inFlight.then(tick);
    }, this.workingChangePollMs);
    timer.unref?.();

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await inFlight.catch(() => undefined);
      },
    };
  }

  /**
   * Widens a frozen claim to cover files written after it was taken, or fails
   * the task saying which file somebody else holds and who.
   *
   * The widening is the existing mid-run path and inherits its rule exactly:
   * decided against every other holder, granted or refused immediately, never
   * queued. Nothing here waits on a lease while holding one.
   */
  private async widenFrozenClaim(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    waveVersion: CanonicalVersion,
    changeSet: ChangeSet,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<void> {
    if (entry.plan.claim?.kind !== "frozen") {
      return;
    }
    const escaped = [
      ...new Set(
        changeSet.patches
          .map((patch) => patch.path)
          .filter((file) => !frozenClaimCovers(entry.plan, file)),
      ),
    ].sort();
    if (escaped.length === 0) {
      return;
    }
    const revisedPlan: AgentPlan = {
      ...entry.plan,
      expectedFiles: [...entry.plan.expectedFiles, ...escaped].sort(),
    };
    if (this.planAuthority !== undefined) {
      const answer = await this.planAuthority.admit({
        task: entry.task,
        plan: revisedPlan,
        planRevision: entry.planRevision + 1,
        baseVersion: waveVersion,
        repository: input.repository,
        ...(input.projectId === undefined
          ? {}
          : { projectId: input.projectId }),
        revising: true,
        // Same all-or-nothing rule as every other mid-run caller: a narrower
        // grant would leave a file somebody else holds inside the plan the
        // changeset is validated against.
        partialAdmission: false,
      });
      if (answer.outcome !== "admitted" || answer.admission !== undefined) {
        const explanation =
          answer.outcome === "admitted"
            ? (answer.admission?.explanation ?? "")
            : answer.explanation;
        throw new Error(
          `Work outside the frozen claim could not be kept: ` +
            `${escaped.join(", ")} overlaps work running elsewhere in this ` +
            `repository: ${explanation}`,
        );
      }
    }
    entry.plan = revisedPlan;
    entry.planRevision += 1;
    entry.decision.planRevision = entry.planRevision;
    await recorder?.planRevision(entry.task.id, {
      revision: entry.planRevision,
      reason: "scope_change",
      canonicalRevision: waveVersion.revision,
      plan: revisedPlan,
    });
    await this.trace(recorder, runAudit, "plan_revised", entry.task.id, {
      revision: entry.planRevision,
      reason: "frozen_claim_widened",
      expectedFiles: revisedPlan.expectedFiles,
    });
  }

  /**
   * Tells a working agent that somebody is queued behind what it holds.
   *
   * The release path has always worked and never fired, because nothing told
   * an agent there was anyone to release *to*: a plan that claims twenty-two
   * files and touches eight holds the other fourteen until the task settles,
   * and every task queued behind one of them waits for work that finished
   * long ago. This is the missing half — the coordinator already knows who is
   * waiting, on the waiting task's own decision, and now says so.
   *
   * Two sources, because a queue forms in two places. Tasks in this run are
   * read straight off their decisions; tasks in other runs — the common case,
   * since a channel dispatch is its own run — come from the plan authority,
   * which is the only thing that can see across them.
   *
   * A timer for the same reason the blanket-claim freeze uses one: the
   * arrival happens elsewhere, and the durable record is all both sides
   * share. Each resource is announced once per waiting task; repeating it
   * every tick would fill the next prompt with the same sentence rather than
   * with the work.
   *
   * Advisory throughout, and never allowed to disturb the run: an authority
   * that cannot answer, or an adapter that cannot be told, leaves the holder
   * working exactly as it did before. Nothing here releases anything — only
   * the agent can do that, and only for files it has finished with.
   */
  private watchScopeContention(
    input: CoordinatorRunInput,
    entry: PlannedTask,
    waiting: readonly PlannedTask[],
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): { first: Promise<void>; stop: () => Promise<void> } {
    const note = entry.adapter.noteScopeContention?.bind(entry.adapter);
    if (note === undefined) {
      return { first: Promise.resolve(), stop: async () => undefined };
    }
    const ask = this.planAuthority?.listWaitingOn?.bind(this.planAuthority);
    const announced = new Set<string>();
    let inFlight: Promise<void> = Promise.resolve();
    let stopped = false;

    const inRun = (): WaitingWork[] =>
      waiting
        .filter(
          (candidate) =>
            candidate.task.id !== entry.task.id &&
            candidate.decision.blockedBy.includes(entry.task.id),
        )
        .map((candidate) => ({
          taskId: candidate.task.id,
          ...contestedPlanResources(entry.plan, candidate.plan),
          explanation: candidate.decision.explanation,
        }));

    const tick = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      const queued = [...inRun()];
      if (ask !== undefined) {
        try {
          queued.push(
            ...(await ask({
              task: entry.task,
              plan: entry.plan,
              repository: input.repository,
              ...(input.projectId === undefined
                ? {}
                : { projectId: input.projectId }),
            })),
          );
        } catch {
          // A queue that cannot be read is one nobody is told about, which is
          // where this started. It is not a reason to stop the holder.
        }
      }
      for (const waiter of queued) {
        if (stopped) {
          return;
        }
        // Only what this waiter has not already been announced for. The same
        // pair stays contended for as long as both are alive, and the wait is
        // re-read every tick.
        const unseen = (
          resourceType: ResourceType,
          ids: readonly string[] | undefined,
        ): string[] =>
          (ids ?? []).filter(
            (id) =>
              !announced.has(
                `${waiter.taskId}\0${planResourceKey(resourceType, id)}`,
              ),
          );
        const fresh = {
          files: unseen("file", waiter.files),
          symbols: unseen("symbol", waiter.symbols),
          apis: unseen("api", waiter.apis),
          schemas: unseen("schema", waiter.schemas),
          configKeys: unseen("configuration", waiter.configKeys),
          tests: unseen("test", waiter.tests),
          services: unseen("service", waiter.services),
        };
        const total = Object.values(fresh).reduce(
          (count, ids) => count + ids.length,
          0,
        );
        if (total === 0) {
          continue;
        }
        const notice: ScopeContentionNotice = {
          taskId: waiter.taskId,
          files: fresh.files,
          ...(fresh.symbols.length === 0 ? {} : { symbols: fresh.symbols }),
          ...(fresh.apis.length === 0 ? {} : { apis: fresh.apis }),
          ...(fresh.schemas.length === 0 ? {} : { schemas: fresh.schemas }),
          ...(fresh.configKeys.length === 0
            ? {}
            : { configKeys: fresh.configKeys }),
          ...(fresh.tests.length === 0 ? {} : { tests: fresh.tests }),
          ...(fresh.services.length === 0 ? {} : { services: fresh.services }),
          reason:
            waiter.explanation === undefined || waiter.explanation.length === 0
              ? `Task ${waiter.taskId} is waiting for these before it can start`
              : `Task ${waiter.taskId} is waiting for these before it can ` +
                `start: ${waiter.explanation}`,
          occurredAt: new Date().toISOString(),
        };
        try {
          await note(entry.session.id, notice);
        } catch {
          // A session that cannot be told — cancelled, already finished — is
          // not a failure of the run that told it.
          continue;
        }
        const told: ReadonlyArray<[ResourceType, readonly string[]]> = [
          ["file", fresh.files],
          ["symbol", fresh.symbols],
          ["api", fresh.apis],
          ["schema", fresh.schemas],
          ["configuration", fresh.configKeys],
          ["test", fresh.tests],
          ["service", fresh.services],
        ];
        for (const [resourceType, ids] of told) {
          for (const id of ids) {
            announced.add(
              `${waiter.taskId}\0${planResourceKey(resourceType, id)}`,
            );
          }
        }
        await this.trace(
          recorder,
          runAudit,
          "scope_contention_noticed",
          entry.task.id,
          {
            repositoryId: input.repository.id,
            ...(input.projectId === undefined
              ? {}
              : { projectId: input.projectId }),
            waitingTaskId: waiter.taskId,
            files: notice.files,
            symbols: notice.symbols ?? [],
            apis: notice.apis ?? [],
            schemas: notice.schemas ?? [],
            configKeys: notice.configKeys ?? [],
            tests: notice.tests ?? [],
            services: notice.services ?? [],
          },
        ).catch(() => undefined);
      }
    };

    // The first pass before the agent is handed its context, so a queue that
    // already exists is in the prompt of the round it starts on rather than
    // one poll interval later.
    inFlight = tick().catch(() => undefined);
    const first = inFlight;
    const timer = setInterval(() => {
      inFlight = inFlight.then(tick).catch(() => undefined);
    }, this.workingChangePollMs);
    timer.unref?.();

    return {
      first,
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await inFlight.catch(() => undefined);
      },
    };
  }

  /**
   * Reports what the agent is touching, on a timer, while it edits.
   *
   * Only differences are written. A run that spends twenty minutes reading
   * before its first edit would otherwise post the same empty list a hundred
   * times, and a thread of identical lines is no more informative than
   * silence — it is just louder. The first tick with anything in it reports
   * everything; each one after that reports only what is new or has changed
   * status.
   *
   * Never allowed to disturb the run. A workspace that cannot be read (a
   * manager with no cheap answer, a git call that fails under load, a
   * worktree already destroyed) simply skips that tick: this exists to
   * describe the work, and describing it must not be able to stop it.
   */
  private watchWorkingChanges(
    workspace: TaskWorkspace,
    taskId: string,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): { stop: () => Promise<void> } {
    const list = this.workspaces.listWorkingChanges?.bind(this.workspaces);
    if (list === undefined) {
      return { stop: async () => undefined };
    }
    const reported = new Map<string, FilePatchStatus>();
    let inFlight: Promise<void> = Promise.resolve();
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      let changes: Array<{ path: string; status: FilePatchStatus }>;
      try {
        changes = await list(workspace);
      } catch {
        return;
      }
      const fresh = changes.filter(
        (change) => reported.get(change.path) !== change.status,
      );
      if (fresh.length === 0) {
        return;
      }
      for (const change of fresh) {
        reported.set(change.path, change.status);
      }
      // The whole set, not just what moved: a reader arriving late, and the
      // channel summary this feeds, both want the current state of the work
      // rather than a diff they would have to accumulate themselves.
      await this.trace(recorder, runAudit, "workspace_changed", taskId, {
        files: changes.map((change) => ({
          path: change.path,
          status: change.status,
        })),
        changed: fresh.map((change) => change.path),
      }).catch(() => undefined);
    };

    const timer = setInterval(() => {
      inFlight = inFlight.then(tick);
    }, this.workingChangePollMs);
    timer.unref?.();

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        // Whatever the last tick was mid-way through, so a stop cannot leave
        // a trace being written into a run that has already moved on.
        await inFlight.catch(() => undefined);
      },
    };
  }

  private async trace(
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
    type: AuditEventType,
    taskId: string | undefined,
    data: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    runAudit.push(this.audit.record(type, taskId, data));
    await recorder?.audit(type, taskId, data);
  }

  /**
   * Tears down what a settled task was holding: its agent session, its
   * workspace, and its ownership leases. Runs on every outcome — a task that
   * integrated and a task that failed release the same three things.
   */
  private async cleanupTask(
    entry: {
      task: TaskDefinition;
      adapter: AgentAdapter;
      session: AgentSession;
    },
    workspace: TaskWorkspace | undefined,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
  ): Promise<string | undefined> {
    const taskId = entry.task.id;
    const failures: string[] = [];
    // The session is closing, so there is no live abort left to deliver.
    // Only the handler goes; any recorded stop reason stays readable, since
    // the paths that ran this cleanup still consult it to name the ending.
    this.cancellations?.release(taskId);
    this.taskWorkspacePaths.delete(taskId);
    this.taskWorkspaces.delete(taskId);
    // Closed, not dropped. Settlement is the one moment the coordinator
    // knows the session has no further use — the change set is collected,
    // and any conflict repair that wanted the agent again has already run.
    // `cancel` is the protocol's only teardown verb and doubles as the close
    // for a finished session, which is how the remote worker has always
    // ended its runs. Before this call existed here, every adapter.cancel in
    // the coordinator sat on a failure path, so a task that succeeded left
    // its session — and whatever the adapter held for it, like generic-cli's
    // planning workspace — to outlive the task for no reason.
    try {
      await entry.adapter.cancel(entry.session.id);
    } catch (error) {
      failures.push(`agent session: ${errorMessage(error)}`);
    }
    if (workspace !== undefined) {
      try {
        await this.workspaces.destroy(workspace);
      } catch (error) {
        failures.push(`workspace: ${errorMessage(error)}`);
      }
    }
    await this.releaseTurnLeases(taskId, recorder, runAudit, failures);
    return await this.finishCleanup(taskId, recorder, runAudit, failures);
  }

  /**
   * Releases what a settled turn never keeps: its ownership leases.
   *
   * Split from {@link cleanupTask} because a conversational turn that lands
   * keeps its session and workspace — the conversation's memory — while the
   * leases are the repository's and never survive a turn. Holding one across
   * a conversation would make a person's thinking time into other agents'
   * waiting time; releasing it means the next turn is arbitrated afresh.
   */
  private async releaseTurnLeases(
    taskId: string,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
    failures: string[],
  ): Promise<void> {
    let released: ReturnType<OwnershipService["releaseTask"]> = [];
    try {
      released = this.ownership.releaseTask(taskId);
    } catch (error) {
      failures.push(`ownership: ${errorMessage(error)}`);
    }
    try {
      await recorder?.releaseLeases(taskId);
    } catch (error) {
      failures.push(`lease record: ${errorMessage(error)}`);
    }
    try {
      await this.trace(
        recorder,
        runAudit,
        "ownership_released",
        taskId,
        { leaseIds: released.map((lease) => lease.leaseId) },
      );
    } catch (error) {
      failures.push(`release audit: ${errorMessage(error)}`);
    }
  }

  /** Folds teardown failures into one recorded explanation, or nothing. */
  private async finishCleanup(
    taskId: string,
    recorder: RunRecorder | undefined,
    runAudit: AuditEvent[],
    failures: readonly string[],
  ): Promise<string | undefined> {
    if (failures.length === 0) {
      return undefined;
    }
    const explanation = `Cleanup failed (${failures.join("; ")})`;
    try {
      await this.trace(recorder, runAudit, "cleanup_failed", taskId, {
        failures,
      });
    } catch (error) {
      return `${explanation}; cleanup audit: ${errorMessage(error)}`;
    }
    return explanation;
  }
}
