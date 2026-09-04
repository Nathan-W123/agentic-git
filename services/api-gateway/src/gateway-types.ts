/**
 * The interfaces the gateway is written against.
 *
 * `ApiOperations` is the seam between routing and everything that actually
 * happens: the gateway names what it needs and the composition root supplies
 * it, which is why the whole request surface can be exercised in tests
 * without a coordinator, a workspace or a repository on disk.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  CoordinationStore,
  StoredRepository,
  SubmittedTask,
  WorkLease,
} from "@coord/persistence";
import type { ChatterFilter } from "@coord/local-triage";
import type {
  FilePatch,
  WorkAssignment as SharedWorkAssignment,
} from "@coord/shared-types";
import type { SecretSealer } from "@coord/workspace-manager";

import type { AuthenticatedPrincipal } from "./auth.js";
import type { CatchUpSummariser } from "./catch-up.js";
import type { CodexUsageReader } from "./codex-subscription-usage.js";
import type { Mailer } from "./mailer.js";
import type { ProxyDial } from "./mcp-proxy.js";
import type { StripeClient } from "./stripe.js";
import type { AgentVendor } from "./vendors.js";
import { auditRetentionDays, planHoldTtlMs } from "./gateway-util.js";

export interface StaticAsset {
  body: Buffer | string;
  contentType: string;
  etag?: string;
  /**
   * Set on assets whose URL carries a digest of their own contents. Those
   * bytes can never change, so a browser is told to keep them for a year and
   * never ask again — which is what makes a repeat launch cost no requests at
   * all rather than one revalidation per file.
   */
  immutable?: boolean;
}

/** Identifies one user's overlay workspace of one repository. */
export interface WorkspaceScopeInput {
  projectId: string;
  repositoryId: string;
  /** Always the authenticated principal's id, never caller-supplied. */
  userId: string;
}

/**
 * Human overlay workspaces: the dashboard's file editor and sandboxed
 * terminal. The implementations live with the web application; the gateway
 * only routes, authorizes, and validates shapes. Every operation receives
 * the authenticated user id, so an implementation can scope state per user
 * without trusting anything from the request body.
 */
export interface WorkspaceOperations {
  status(input: WorkspaceScopeInput): Promise<unknown>;
  open(input: WorkspaceScopeInput): Promise<unknown>;
  reset(input: WorkspaceScopeInput): Promise<unknown>;
  discard(input: WorkspaceScopeInput): Promise<void>;
  listFiles(input: WorkspaceScopeInput): Promise<unknown>;
  readFile(input: WorkspaceScopeInput & { path: string }): Promise<unknown>;
  writeFile(
    input: WorkspaceScopeInput & { path: string; content: string },
  ): Promise<unknown>;
  /** Moves or renames one path inside the overlay, atomically. */
  moveFile(
    input: WorkspaceScopeInput & { from: string; to: string },
  ): Promise<unknown>;
  exec(input: WorkspaceScopeInput & { command: string }): Promise<unknown>;
  submit(input: WorkspaceScopeInput & { objective: string }): Promise<unknown>;
}

export interface RepositoryPushResult {
  outcome: "done" | "refused";
  detail?: {
    url?: string;
    output?: string[];
    /** Both GitHub and canonical changed the same files. */
    syncConflict?: true;
    conflicts?: string[];
  };
  explanation: string;
}

export interface ChannelCommandResponse {
  name: "push";
  result: RepositoryPushResult;
}

/**
 * What posting one message into a channel actually started.
 *
 * `taskIds` exists for callers that are not looking at the room. A person who
 * posts in the channel watches the thread appear and needs nothing back; a
 * client dispatching from somebody's editor has no thread to watch, and
 * without an id it can only tell them "sent" and hope. The ids were always in
 * hand here — `dispatchOneMention` holds each task it submits — and were
 * simply dropped on the floor.
 */
export interface ChannelDispatch {
  response?: ChannelCommandResponse;
  taskIds: readonly string[];
}

export interface SlashCommandDispatch {
  handled: boolean;
  response?: ChannelCommandResponse;
}

/**
 * A `/queue /push`: publish this repository, but not until the work already
 * running in it has finished.
 *
 * In memory only, and deliberately so. The instruction means "after the
 * things running right now", and none of those survive a restart either — a
 * push resurrected an hour later would publish a canonical nobody was
 * looking at, on behalf of somebody who has long since stopped waiting.
 */
export interface PendingChannelPush {
  projectId: string;
  repositoryId: string;
  /** Who asked, and so whose GitHub connection the push is made with. */
  actorId: string;
  /** The room it was asked in, so the answer goes back to that room. */
  channelId?: string;
  /** The thread it was asked in, when it was asked inside one. */
  messageId?: string;
  /**
   * In flight.
   *
   * The pump ticks every couple of seconds and a push takes longer than
   * that, so without this the same instruction would publish twice.
   */
  running: boolean;
}

export interface ApiOperations {
  listAgents?(): Promise<
    Array<{
      id: string;
      adapter:
        | "codex"
        | "claude"
        | "gemini"
        | "cursor"
        | "copilot"
        | "kiro"
        | "generic-cli";
      default: boolean;
    }>
  >;
  createRepository(input: {
    projectId: string;
    id: string;
    branch?: string;
    actorId: string;
  }): Promise<StoredRepository>;
  /**
   * Removes the canonical repository and its persisted coordination state.
   * Older or store-only deployments may omit this and retain the persistence-
   * only fallback used before repository filesystem lifecycle was exposed.
   */
  deleteRepository?(input: {
    projectId: string;
    repositoryId: string;
    actorId: string;
  }): Promise<void>;
  importGitHub(input: {
    projectId: string;
    repository: string;
    id?: string;
    branch?: string;
    token?: string;
    actorId: string;
  }): Promise<StoredRepository>;
  /**
   * Brings canonical up to date with the GitHub remote it was imported
   * from — the other half of export, and what unblocks a push refused
   * because the remote moved. Optional the same way the GitHub connection
   * is: a deployment without remote repositories has nothing to sync.
   */
  syncRepository?(input: {
    projectId: string;
    repositoryId: string;
    actorId: string;
    /** A person's answer to "which side wins" for files that collide. */
    conflictResolution?: "refuse" | "prefer-remote" | "prefer-local";
  }): Promise<{
    status: "already_current" | "fast_forwarded" | "merged";
    remoteUrl: string;
    upstreamBranch: string;
    upstreamRevision: string;
    previousRevision: string;
    revision: string;
    resolved?: { side: "remote" | "local"; files: string[] };
  }>;
  /**
   * Publishes canonical directly for the authenticated caller. This is a
   * repository operation, not agent work: `/push` invokes it without filing
   * a task or entering plan admission.
   */
  pushRepository?(input: {
    projectId: string;
    repositoryId: string;
    actorId: string;
  }): Promise<RepositoryPushResult>;
  submitTask(input: {
    projectId: string;
    repositoryId: string;
    objective: string;
    agentId?: string;
    /**
     * The vendor CLI to run this under, when the caller knows which account
     * should pay for it but not which of the deployment's configured
     * `agentId`s maps to that vendor — the shape a channel @mention dispatch
     * has: it knows the mentioned agent's vendor (claude/codex/gemini) but
     * has no business knowing the operator's `.coordinator/config.json` agent
     * names. An implementation that accepts this resolves it to a real
     * `agentId` itself. Ignored when `agentId` is also given.
     */
    vendor?: AgentVendor;
    actorId: string;
    /** Work, or a question to be answered on its owner's machine. */
    kind?: "task" | "question";
    /** The channel message a routed answer belongs under. Questions only. */
    answerTo?: string;
    /**
     * What the request was asked inside, for the agent that will run it —
     * the thread a channel dispatch came from, so a follow-up like "now do
     * the same for the other file" means something on the far end.
     *
     * Deliberately not folded into `objective`: that text is what somebody
     * asked for, and it is rendered in the channel, in task lists and in
     * thread titles, where a pasted transcript would make every request
     * unreadable. The coordinator merges this with the handoffs earlier tasks
     * left, and hands the pair to the planning prompt as background.
     */
    context?: string;
    /**
     * The conversation this task is one turn of — the thread root's message
     * id, the one identity every turn of a thread shares. A task submitted
     * with it leaves its status `open` when a turn lands, waiting for the
     * next reply, and its arrival settles the conversation's previous open
     * turn. See docs/architecture/conversational-tasks.md.
     */
    conversationId?: string;
    /**
     * File this as held rather than queued: `/plan` records the intent and
     * nothing may run it until a person says go.
     *
     * Carried into the insert rather than applied afterwards, because a task
     * that is briefly `submitted` is briefly leasable — and the next
     * dispatch in this repository leases the oldest queued row, which was
     * how a held plan came to run on its author's credential without ever
     * being approved.
     */
    planOnly?: boolean;
    /** Queue this after this agent owner's latest unfinished task, if any. */
    queueAfterCurrent?: boolean;
    /**
     * What this channel picked for the agent, overriding the deployment's
     * configured default for this one task. See `SubmitTaskInput.model`.
     */
    model?: string;
    effort?: string;
  }): Promise<SubmittedTask>;
  runRepository(input: {
    projectId: string;
    repositoryId: string;
    actorId: string;
  }): Promise<void>;
  /**
   * Stops work: exact tasks, one agent's, or a whole repository's.
   *
   * The full job, not a row flip — the implementation marks the rows
   * cancelled, aborts live in-process sessions, releases work leases (which
   * is what stops a remote worker), and appends the `task_cancelled` audit
   * events the channel narrates from. `vendor` mirrors `submitTask`'s: the
   * channel knows which vendor an agent runs, never the deployment's
   * internal agent ids. Absent on deployments that cannot reach running
   * work, where cancel degrades to the store-only row flip.
   */
  cancelTasks?(input: {
    projectId: string;
    repositoryId: string;
    taskIds?: string[];
    agentId?: string;
    vendor?: AgentVendor;
    /**
     * Narrow a vendor-scoped stop to one persona's work. A channel persona
     * is an (owner, vendor) pair, and every persona of one vendor resolves
     * to the same configured agent — without this, "/stop @agent" also
     * stopped every other persona's same-vendor tasks.
     */
    ownerId?: string;
    reason: string;
    actorId: string;
  }): Promise<{
    cancelled: Array<{
      id: string;
      agentId: string;
      objective: string;
      was: "running" | "queued" | "held" | "waiting";
    }>;
  }>;
  /**
   * Stops work in a way that can be undone.
   *
   * The reversible sibling of {@link cancelTasks}, and everything said there
   * applies: the row flip alone is not the job. What differs is that the row
   * goes to a non-terminal `paused` and the live run keeps the directory the
   * agent was editing, so resuming continues rather than starts over.
   *
   * Absent on deployments that cannot reach running work, where the pause
   * button is simply not offered — a pause that could not stop the agent
   * would be worse than no pause at all.
   */
  pauseTasks?(input: {
    projectId: string;
    repositoryId: string;
    taskIds: string[];
    reason: string;
    actorId: string;
  }): Promise<{
    paused: Array<{
      id: string;
      agentId: string;
      objective: string;
      was: "running" | "queued";
    }>;
  }>;
  /** Puts one paused task back in the queue. See {@link pauseTasks}. */
  resumeTask?(input: {
    projectId: string;
    repositoryId: string;
    taskId: string;
    actorId: string;
  }): Promise<{ resumed: boolean }>;
  /**
   * The unified diff between two canonical revisions.
   *
   * The auditor's whole input. It is an operation rather than a direct
   * `RepositoryService` call because the gateway has no repository paths and
   * no business acquiring any — every other thing it knows about a
   * repository's contents arrives the same way.
   *
   * Absent on deployments without repository access, in which case the
   * auditor reports that it cannot read the change rather than auditing
   * nothing and calling the repository clean.
   */
  canonicalDiff?(input: {
    projectId: string;
    repositoryId: string;
    fromRevision: string;
    toRevision: string;
  }): Promise<{ files: string[]; patch: string; truncated: boolean }>;
  /**
   * Where canonical stands right now.
   *
   * Needed only by the auditor resuming after being switched off: every other
   * audit is triggered by a promotion event that already names the revision
   * it landed, but a resume is triggered by a person and has to ask.
   * Undefined for a repository whose canonical branch has no commits yet.
   */
  canonicalHead?(input: {
    projectId: string;
    repositoryId: string;
  }): Promise<string | undefined>;
  /**
   * Runs the repository's own app so somebody can look at it.
   *
   * Absent on a deployment that cannot host one. The URL these answer with is
   * always loopback on the machine running this process — see `PreviewService`
   * — so it is useful when that machine is the reader's own and unreachable
   * otherwise, which is the safe way round.
   */
  previewStart?(input: {
    projectId: string;
    repositoryId: string;
  }): Promise<unknown>;
  previewStatus?(input: {
    projectId: string;
    repositoryId: string;
  }): Promise<unknown>;
  previewStop?(input: {
    projectId: string;
    repositoryId: string;
  }): Promise<void>;
  /**
   * Remembers how one repository is started, when nothing could be detected.
   *
   * Asking once beats predicting ecosystems. Detection covers Node and static
   * pages because those can be known rather than guessed; everything else is
   * a question with one right answer that only the person who built it has.
   */
  previewConfigure?(input: {
    projectId: string;
    repositoryId: string;
    command: string;
  }): Promise<void>;
  /**
   * Images posted into a channel. Absent on a deployment with nowhere to put
   * them, in which case the composer offers no attach control.
   */
  attachmentSave?(input: {
    bytes: Buffer;
    contentType: string;
  }): Promise<string>;
  attachmentRead?(
    id: string,
  ): Promise<{ bytes: Buffer; contentType: string } | undefined>;
  /**
   * Where an attached image sits on disk, for handing to an agent that can
   * open it. Absent on a deployment that stores images somewhere a task
   * cannot reach, where the reference stays a reference.
   */
  attachmentPath?(id: string): Promise<string | undefined>;
  /**
   * One file out of canonical, as bytes. Used to lift an image an agent
   * committed into the channel, where it can be looked at rather than
   * listed.
   */
  canonicalFileBytes?(input: {
    projectId: string;
    repositoryId: string;
    revision: string;
    path: string;
  }): Promise<Buffer | undefined>;
  /** Canonical branch history, newest first. */
  repositoryVersions?(input: {
    projectId: string;
    repositoryId: string;
    limit?: number;
  }): Promise<unknown>;
  /**
   * Reverts canonical to an earlier revision through the ordinary pipeline.
   * Never a raw reset: it is planned, conflict-checked, validated, and
   * promoted by compare-and-swap like any other change.
   */
  rollbackRepository?(input: {
    projectId: string;
    repositoryId: string;
    targetRevision: string;
    actorId: string;
    reason?: string;
    /**
     * Restore only these paths. `/stop` uses it to undo one task without
     * taking work other agents landed since; omitted, the whole tree goes
     * back, which is what the manual rollback endpoint means.
     */
    files?: readonly string[];
  }): Promise<{ status: string; explanation: string }>;
  dockerStatus?(): Promise<{
    available: boolean;
    version?: string;
    explanation: string;
  }>;
  /**
   * Remote execution hooks. A deployment without workers omits these and the
   * worker endpoints report that they are unsupported.
   */
  /** Coordination metrics derived from the audit chain, project-scoped. */
  projectMetrics?(input: { projectId: string }): Promise<unknown>;
  leaseWork?(input: {
    workerId: string;
    projectId: string;
    actorId: string;
    repositoryId?: string;
    /**
     * The only repositories this caller may be handed work from, when the
     * caller reaches the project through repository grants rather than an
     * organization role. Absent means every repository in the project.
     */
    repositories?: ReadonlySet<string>;
    /** What this worker can execute. Absent means work alone. */
    kinds?: readonly ("task" | "question")[];
    /**
     * The protocol version the worker announced. Read off the request
     * rather than assumed, because the lease decides by it what the other
     * end can be trusted to look at — see `mcpServersForLease`.
     */
    protocolVersion?: number;
  }): Promise<WorkAssignment | undefined>;
  leaseBundle?(
    leaseId: string,
    /** A commit the worker already holds; only the delta above it is packed. */
    have?: string,
  ): Promise<Buffer | undefined>;
  /**
   * Hands a solo remote task the whole repository, so it can skip the planning
   * round trip the way an in-process one always has.
   *
   * Optional, and answering `undefined` is the ordinary case rather than a
   * fault: it means the conditions were not met and the worker plans exactly
   * as it does today. A deployment that omits this behaves the same way.
   */
  claimWorkRepository?(input: {
    leaseId: string;
    actorId: string;
    protocolVersion: number;
  }): Promise<{ plan?: unknown; planningContext?: string }>;
  /**
   * The two directions of a repository claim, folded onto the heartbeat.
   *
   * Up goes what the holder has written; down comes a claim that was narrowed
   * underneath it and the ask that turns an arrival's retry into a run. The
   * gateway carries the traffic and decides none of it — everything this
   * answers is about leases and holders, which live on the other side of this
   * interface with every other decision of that kind.
   */
  claimHeartbeat?(input: {
    leaseId: string;
    workingChanges?: unknown;
  }): Promise<Record<string, unknown>>;
  /** A holder's answer to the ask, posted on its own route. */
  settleClaimDeclaration?(input: {
    leaseId: string;
    askId: string;
    declaration?: unknown;
    workingChanges?: unknown;
  }): Promise<boolean>;
  /**
   * Arbitrates a worker's plan before it executes. A deployment that omits
   * this cannot run plan-first workers, and the endpoint says so.
   */
  admitWorkPlan?(input: {
    leaseId: string;
    actorId: string;
    plan: unknown;
  }): Promise<
    | { outcome: "admitted"; admission: unknown }
    | { outcome: "rejected"; reason: string }
    | { outcome: "lease_lost"; reason: string }
  >;
  /**
   * Arbitrates a scope expansion an agent asked for mid-execution. A
   * deployment that omits this refuses the request rather than pretending to
   * decide it, which is what the worker did unconditionally before.
   */
  arbitrateScopeChange?(input: {
    leaseId: string;
    actorId: string;
    request: unknown;
  }): Promise<
    | { outcome: "decided"; decision: unknown }
    | { outcome: "rejected"; reason: string }
    | { outcome: "lease_lost"; reason: string }
  >;
  acceptWorkResult?(input: {
    leaseId: string;
    status: "completed" | "failed";
    actorId: string;
    plan: unknown;
    changeSet: unknown;
    detail?: string;
    /** What the agent said, when the lease was on a question. */
    answer?: string;
    // Narrowed from `unknown` only as far as this route actually reads it:
    // whether to post, and what. The body is still relayed whole to the
    // worker, so an implementation may return more than this names.
  }): Promise<{ accepted: boolean; answer?: string }>;
  /**
   * Work taken and reported by an editor rather than by a worker process.
   *
   * Absent on a deployment that cannot run tasks at all, which answers the
   * three MCP work tools with 501 rather than with silence.
   */
  editorWork?: EditorWorkOperations;
  /** Dashboard overlay workspaces; absent on deployments without them. */
  workspace?: WorkspaceOperations;
  /** Direct provider chat (Anthropic/OpenAI/Google); absent when unsupported. */
  chatProviders?: ChatProviderOperations;
  /**
   * The caller's own GitHub connection, spent when a task of theirs pushes.
   * Absent on a deployment that cannot push anywhere.
   */
  githubCredential?: GitHubCredentialOperations;
}

/**
 * A user's GitHub token, stored beside their agent connections so a push
 * runs as whoever submitted the task. The gateway only routes, authenticates
 * and validates shape; verifying the token against GitHub and storing it
 * encrypted live in the implementation, and the token itself is never echoed
 * back in any response.
 */
/**
 * Doing a Kumi task from inside an editor, with no worker process anywhere.
 *
 * The three verbs are the whole of it: take one task and a hold on it, keep
 * the hold while a long turn runs, file what came back. Everything they reach
 * lives on the other side of this interface, exactly as leasing does, because
 * the gateway routes work and decides none of it.
 *
 * The shape differs from {@link ApiOperations.leaseWork} in one way that
 * matters: nothing here carries a workspace, a bundle, or an admitted plan.
 * The agent already has the repository open, and its plan is written from the
 * diff at report time rather than promised at take time. See
 * `apps/cli/src/editor-work.ts` for why that is the only honest order.
 */
export interface EditorWorkOperations {
  take(input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    /** The repositories this caller may be handed work from. Never widened. */
    repositoryIds: readonly string[];
    /** Which CLI this editor is: `claude`, `codex`, `cursor` and so on. */
    vendor: string;
    /** How the editor's worker row is named. */
    label: string;
    /** One named task, for an editor taking back work it has just filed. */
    taskId?: string;
  }): Promise<
    | {
        leaseId: string;
        taskId: string;
        objective: string;
        repositoryId: string;
        branch: string;
        baseRevision: string;
        baseVersion: number;
        expiresAt: string;
        validationCommands: readonly string[];
      }
    | undefined
  >;
  report(input: {
    leaseId: string;
    actorId: string;
    status: "completed" | "failed" | "released";
    patches: readonly FilePatch[];
    summary: string;
    detail?: string;
  }): Promise<
    | { outcome: "accepted"; integrationStatus?: string; requeued?: boolean }
    | { outcome: "refused"; reason: string }
    | { outcome: "lease_lost"; reason: string }
  >;
  /** The new expiry, or `undefined` when the hold was already gone. */
  extend(input: {
    leaseId: string;
    ttlMs: number;
  }): Promise<string | undefined>;
}

export interface GitHubCredentialOperations {
  status(input: { userId: string }): Promise<unknown>;
  connect(input: { userId: string; token: string }): Promise<unknown>;
  disconnect(input: { userId: string }): Promise<void>;
  /**
   * The device sign-in — GitHub's own "enter this code in your browser"
   * flow — for deployments with an OAuth App configured. Absent (or
   * answering that it is unconfigured), the paste-a-token route above is
   * the whole story.
   */
  deviceAuth?: {
    start(input: { userId: string }): Promise<unknown>;
    status(input: { userId: string; flowId: string }): Promise<unknown>;
    cancel(input: { userId: string; flowId: string }): Promise<void>;
  };
}

/**
 * Direct provider chat for the dashboard panel. The gateway only routes,
 * authenticates, and validates shapes; connections are stored per user by
 * the implementation and every operation receives the authenticated user id
 * plus whether they are a system administrator (the local-CLI connection is
 * restricted to administrators because it spends the host owner's account).
 */
export interface ChatProviderOperations {
  list(input: { userId: string; systemAdmin: boolean }): Promise<unknown>;
  /**
   * Takes a usage reading from the machine an agent runs on, rather than
   * reading it here. Optional, because a deployment that executes agents
   * itself has no machine to hear from.
   */
  reportUsage?(input: {
    userId: string;
    provider: string;
    raw: string;
  }): Promise<unknown>;
  /** Launches the provider's own browser sign-in flow on the host. */
  signIn(input: {
    systemAdmin: boolean;
    provider: string;
  }): Promise<unknown>;
  connect(input: {
    userId: string;
    systemAdmin: boolean;
    provider: string;
  }): Promise<unknown>;
  /**
   * Connects the caller's *own* provider account from a credential they
   * supply. Absent on deployments that only offer the shared host login.
   */
  connectCredential?(input: {
    userId: string;
    systemAdmin: boolean;
    provider: string;
    kind: string;
    secret: string;
    label?: string;
    /**
     * "personal" (default) or "org" — see the roster note on
     * {@link connectionsFor}. Metadata, not a secret; the gateway validates
     * it is one of the two known values and otherwise passes it through.
     */
    visibility?: "personal" | "org";
  }): Promise<unknown>;
  /**
   * Device authorization, where the vendor issues this deployment its own
   * session rather than the user handing over a copy of theirs.
   *
   * It cannot be a single call: the CLI prints a code and then waits for the
   * user to approve it in a browser, so the flow is started, polled, and
   * either completes or is cancelled. Absent on deployments whose providers
   * offer no such flow.
   */
  deviceAuth?: {
    start(input: { userId: string; provider: string }): Promise<unknown>;
    status(input: { userId: string; flowId: string }): Promise<unknown>;
    cancel(input: { userId: string; flowId: string }): Promise<void>;
    /**
     * Hands a waiting sign-in the code the browser gave the user.
     *
     * Codex, Copilot and Kiro approve in the browser while the CLI polls.
     * Claude, Gemini and some Cursor releases instead issue the user a code
     * that has to be given back to the CLI sitting on stdin.
     */
    submitCode?(input: {
      userId: string;
      flowId: string;
      code: string;
    }): Promise<unknown>;
  };
  /**
   * Records that a stored credential has stopped authenticating.
   *
   * A task fails inside the coordinator, not inside a chat completion, so the
   * provider service never sees it — and the dashboard went on showing the
   * agent as connected while every task it was given failed to sign in. This
   * is how the one place that observes the failure tells the one place that
   * can display it.
   */
  noteAuthFailure?(input: {
    userId: string;
    provider: string;
    reason: string;
  }): Promise<void>;
  disconnect(input: { userId: string; provider: string }): Promise<void>;
  /** Model/effort choices the connected account actually reports. */
  options(input: { provider: string; userId?: string }): Promise<unknown>;
  /** Consumption the provider's own CLI publishes, when it publishes any. */
  usage(input: {
    provider: string;
    /** The caller. */
    userId?: string;
    /** Whose agent, when it is not the caller's own. */
    ownerId?: string;
  }): Promise<unknown>;
  setSettings(input: {
    userId: string;
    provider: string;
    model?: string;
    effort?: string;
    /**
     * The agent's name, held on the account and therefore the same in every
     * repository — see `ProviderSettings.callSign` in `apps/web/src/providers.ts`.
     * An empty string clears it back to the vendor label, the way model and
     * effort clear.
     */
    callSign?: string;
    visibility?: "personal" | "org";
  }): Promise<unknown>;
  complete(input: {
    userId: string;
    systemAdmin: boolean;
    provider: string;
    messages: unknown;
    cliSessionId?: string;
    /** Canonical repository this answer may inspect, when asked in a channel. */
    repositoryId?: string;
    /**
     * A throwaway line — such as a title — rather than work.
     * The provider service runs these on a cheap model; see
     * `CEREMONIAL_MODELS` there.
     */
    ceremonial?: boolean;
  }): Promise<unknown>;
  /**
   * Same as {@link complete} but reports progress as the CLI produces it.
   * Each event is relayed to the browser the moment it arrives.
   */
  completeStream?(
    input: {
      userId: string;
      systemAdmin: boolean;
      provider: string;
      messages: unknown;
      cliSessionId?: string;
      /** Canonical repository this answer may inspect, when asked in a channel. */
      repositoryId?: string;
    },
    onEvent: (event: ChatStreamEvent) => void,
  ): Promise<unknown>;
  /**
   * Which vendors a set of *other* users have connected, for the repository
   * channel roster (`GET .../channel/agents` below). Deliberately narrower
   * than {@link list}: it returns only the vendor each user has connected,
   * never a secret, never the free-text label a user chose for their own
   * credential (that string is theirs, not a fact about their identity the
   * way the vendor name is), and never usage or spend. Absent on deployments
   * that do not implement chat providers at all, in which case the roster
   * still lists every person with access, just with no agents.
   *
   * `visibility` travels alongside the vendor as of the org-wide @mention
   * feature: it is what lets the roster (and the channel message handler
   * enforcing @mention dispatch) tell a pingable agent from a visible-only
   * one, and is documented safe to disclose this way on
   * `UserCredentialSummary` itself.
   */
  connectionsFor?(
    userIds: readonly string[],
  ): Promise<
    Record<
      string,
      Array<{
        provider: string;
        visibility: "personal" | "org";
        /** The agent's own name, held per account. See `ProviderSettings`. */
        callSign?: string;
      }>
    >
  >;
}

/**
 * The provider events a channel turn can render while the model is working.
 *
 * Kept structurally identical to `apps/web/src/providers.ts` rather than
 * importing the provider implementation into the gateway. The gateway is a
 * package boundary; it only needs the public stream contract, not the CLI
 * adapters that produce it.
 */
export type ChatStreamEvent =
  | { type: "status"; status: string }
  | { type: "reasoning_start"; hidden: boolean }
  | { type: "reasoning"; text: string }
  | { type: "reasoning_tokens"; tokens: number }
  | { type: "text"; delta: string }
  | { type: "done"; reply: unknown }
  | { type: "error"; message: string; code: string };

/**
 * Everything a worker needs to execute one task without further lookups.
 *
 * The shared definition with this side's rows named; the control plane's
 * `leaseWork` builds the same alias from the same definition, so what it
 * returns and what this gateway sends are one type rather than two that
 * happened to agree.
 */
export type WorkAssignment = SharedWorkAssignment<WorkLease, SubmittedTask>;

export interface ApiGatewayOptions {
  store: CoordinationStore;
  operations: ApiOperations;
  /**
   * Secret required to claim the first owner account. Omitted or empty leaves
   * first-run setup open — see the field of the same name on the gateway for
   * what that does and does not expose.
   */
  bootstrapToken?: string;
  allowedOrigins?: readonly string[];
  secureCookies?: boolean;
  staticAssets?: ReadonlyMap<string, StaticAsset>;
  requestBodyLimit?: number;
  rateLimitPerMinute?: number;
  /**
   * The MCP endpoint's own budget, separate from the dashboard's.
   *
   * Not a tighter cap — the same generosity, out of a different pool. An
   * editor's model polling `task_status` and a browser loading the dashboard
   * arrive from one office's IP looking identical to a per-IP limiter, so on
   * a shared bucket the polling starves the person watching the thread. They
   * are different clients doing different work and they get different budgets.
   */
  mcpRateLimitPerMinute?: number;
  authRateLimitPerMinute?: number;
  /** Event poll cadence; exposed for deterministic embedded runtimes/tests. */
  webSocketPollIntervalMs?: number;
  /**
   * Reads current Codex account quotas when no session has recorded them.
   * Injectable so tests and embedded runtimes do not launch a real CLI.
   */
  codexUsageReader?: CodexUsageReader;
  /**
   * Delivers password-reset links and registration confirmation codes.
   * Defaults to the mailer built from `COORD_SMTP_URL`, which logs messages
   * when no relay is configured. Injected by tests, which must not open a
   * socket to anywhere.
   */
  mailer?: Mailer;
  /**
   * Talks to Stripe. Absent — no `STRIPE_SECRET_KEY` — leaves every billing
   * route answering 501: a deployment nobody has configured for payment
   * should say so plainly rather than fail somewhere deeper with a message
   * about a missing key. Injected by tests, which must not call Stripe.
   */
  stripe?: StripeClient;
  /**
   * Seals the secrets a project gives its MCP servers before they are stored,
   * and is the same sealer the lease opens them with. The hosting process
   * passes `UserCredentialStore#sealer()`, so an MCP secret is protected by
   * exactly the key that already protects every stored provider credential.
   * Absent — no credential store — every route that would store or arm a
   * server answers 501, the way billing does without Stripe: a deployment
   * that cannot keep the secret must not accept it.
   */
  secretSealer?: SecretSealer;
  /**
   * Whether this deployment takes money at all.
   *
   * Defaults to `KUMI_PAYMENTS_ENABLED`, which is off. With it off there is
   * no checkout, no billing portal, no webhook, no seat reconciliation and no
   * trial — public sign-up is a waitlist instead, and the entitlement gate
   * stops folding anybody to `viewer`. Injected by tests so one case can be
   * written on each side of the switch.
   */
  paymentsEnabled?: boolean;
  /** Signing secret for Stripe webhooks; without it no webhook is accepted. */
  stripeWebhookSecret?: string;
  /** The price a seat is sold at. Required before checkout can be started. */
  stripePriceId?: string;
  /**
   * Where Checkout sends somebody back to.
   *
   * Configured rather than derived from the request, because the thin desktop
   * shell's own origin is not a URL Stripe can redirect a browser to — the
   * return has to land somewhere real that then hands back to the app.
   */
  appBaseUrl?: string;
  /**
   * How an approved MCP server is actually dialled.
   *
   * {@link dialMcp} in every deployment; a fixture in the tests that are
   * about what gets sent rather than about the socket. Injectable because
   * the interesting part of the proxy is which secrets travel with which
   * request, and that cannot be asserted through a real hostname.
   */
  mcpDial?: ProxyDial;
  /**
   * The local first pass over unaddressed channel messages.
   *
   * Defaults to the embedding filter, or to one that passes everything on
   * when `COORD_LOCAL_TRIAGE` switches it off. Injected by tests, which must
   * not load a model to prove what the gateway does with its answer.
   */
  chatterFilter?: ChatterFilter;
  /**
   * Writes the catch-up digest's prose, when a local model can.
   *
   * Defaults to the local text model, or to nothing when
   * `COORD_LOCAL_TRIAGE` switches it off. Injected by tests, which must not
   * load a model to prove what the route does with its answer — and left out
   * entirely by tests that want the deterministic wording.
   */
  catchUpSummariser?: CatchUpSummariser;
  /**
   * Writes compact thread names with the local text model.
   *
   * Defaults to the same in-process model as catch-up prose and follows the
   * same `COORD_LOCAL_TRIAGE` switch. Injectable so tests never load ONNX or
   * download model artifacts for an unrelated channel assertion.
   */
  threadTitleSummariser?: CatchUpSummariser;
  /**
   * Absolute origin this deployment is reached at, used to build links that
   * travel outside the browser. Defaults to `COORD_PUBLIC_URL`, and failing
   * that to the `Host` of the request that asked for the link.
   */
  publicUrl?: string;
  /** How often open event channels re-check account and membership state. */
  webSocketReauthorizeIntervalMs?: number;
  /**
   * Cadence of the collaboration hub's sweep: reauthorization, in-flight agent
   * activity, and flushing idle rooms. Exposed for tests.
   */
  collabTickIntervalMs?: number;
  /**
   * How often the auditor looks for canonical promotions to audit. Exposed
   * for tests, which cannot wait out the production cadence.
   */
  auditorPollIntervalMs?: number;
  /**
   * How often finished threads, standing arbitration notices and stale plan
   * holds are swept. Exposed for tests, which cannot wait out the production
   * cadence.
   */
  threadReconcileIntervalMs?: number;
  /**
   * How often seats are reconciled against Stripe, and expired sign-up
   * intents swept. A test that is about the pass cannot wait out six hours.
   */
  billingReconcileIntervalMs?: number;
  /**
   * How long the live audit log keeps an event, in days. Zero keeps
   * everything, which is what a deployment under a legal hold wants. Defaults
   * to `COORD_AUDIT_RETENTION_DAYS`, and failing that to thirty.
   */
  auditRetentionDays?: number;
  /**
   * How often the retention sweep runs. A test about the sweep cannot wait
   * out six hours, for the same reason the billing one is settable.
   */
  auditRetentionSweepIntervalMs?: number;
  /**
   * How long a held `/plan` waits for somebody to start it before it lapses.
   * Defaults to `COORD_PLAN_HOLD_TTL_MINUTES`, and failing that to
   * {@link PLAN_HOLD_TTL_MS}.
   */
  planHoldTtlMs?: number;
  /**
   * How long a task waits unclaimed before the room is told. Overridable for
   * the same reason `planHoldTtlMs` is: a test cannot wait ten minutes, and a
   * sweep nobody can reach in a test is a sweep nobody has run.
   */
  stalledTaskMs?: number;
}

export interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  requestId: string;
  /** Whether the browser reached this deployment over TLS. */
  secure: boolean;
  principal?: AuthenticatedPrincipal;
}
