import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import type {
  CoordinationStore,
  Organization,
  OrganizationRole,
  ProjectRecord,
  WorkLease,
  WorkerRecord,
  StoredRepository,
  SubmittedTask,
  SubmittedTaskStatus,
} from "@coord/persistence";
import {
  assertProjectPolicy,
  createId,
  projectBudgets,
  type ApprovalStatus,
} from "@coord/shared-types";

import {
  AuthService,
  AuthenticationError,
  hashPassword,
  hashSecret,
  parseBearer,
  secretMatches,
  type AuthenticatedPrincipal,
} from "./auth.js";
import {
  authorizeOrganization,
  authorizeProject,
  authorizeRepository,
  canAssignRole,
  ALL_PERMISSIONS,
  assertTokenScope,
  isPermission,
  permissionsForRole,
  type Permission,
} from "./authorization.js";
import { RateLimiter } from "./rate-limiter.js";
import { CollabWebSocketHub } from "./collab-websocket.js";
import { AuditWebSocketHub, type WebSocketAuthorization } from "./websocket.js";

const API_PREFIX = "/api/v1";

/**
 * The vendor CLI behind each provider id, for @mention dispatch: a task runs
 * under a vendor (`SubmitTaskInput.vendor`/`openSubmitterCredentialHome`),
 * not under the dashboard's provider id. Mirrors `PROVIDER_VENDORS` in
 * `apps/web/src/providers.ts`, which cannot be imported here without coupling
 * the gateway to that implementation.
 */
const PROVIDER_TO_VENDOR: Record<string, "claude" | "codex" | "gemini"> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
};

/** People say "Claude", not "Anthropic" — mirrors `AGENT_LABEL` in data.js. */
const AGENT_LABEL: Record<string, string> = {
  anthropic: "Claude",
  openai: "Codex",
  google: "Gemini",
};

/** Mirrors `firstWord` in `apps/web/public/data.js`. */
function firstWord(name: string): string {
  return String(name ?? "").trim().split(/\s+/u)[0] || "Teammate";
}

/**
 * A task whose progress is being narrated into a channel thread.
 *
 * The channel shows one line per request — the agent's own answer — and
 * everything the task then does is a reply underneath it. Without this a
 * thread said "working on it" once and then nothing until somebody went
 * looking at the run, which reads as the agent having stopped.
 */
interface WatchedChannelTask {
  taskId: string;
  projectId: string;
  repositoryId: string;
  /** The agent-authored message the replies hang off. */
  messageId: string;
  authorId: string;
  /** Whose credential the run is spending, for reporting a failed sign-in. */
  ownerId: string;
  provider: string;
  /** Last audit sequence already narrated, so nothing is said twice. */
  cursor: number;
  startedAtMs: number;
}

/**
 * How much of a thread goes to the model when answering a follow-up.
 *
 * The narration can run to dozens of steps on a long task; the last stretch is
 * what a question like "what did you get done?" is actually about, and sending
 * all of it would spend the reader's usage on the middle of a log nobody asked
 * about.
 */
const THREAD_CONTEXT_LINES = 24;

/** How often the thread is brought up to date while a task is running. */
const CHANNEL_PROGRESS_INTERVAL_MS = 2000;
/** How long the opening line may take before a fixed one is used instead. */
const ACKNOWLEDGEMENT_TIMEOUT_MS = 6000;
/**
 * A plain question deserves a real answer, so it waits properly.
 *
 * Measured against the installed CLI rather than guessed: a `claude -p` call
 * routinely runs past thirty seconds, and the first version of this budgeted
 * twenty-five — so every dynamic line silently fell back to a fixed one and
 * the feature looked hardcoded. Nothing is blocked while this runs: the
 * answer is posted to the channel when it arrives, and the sender's own
 * message was durable long before.
 */
const QUESTION_TIMEOUT_MS = 180000;
/** The thread title and opening reasoning, asked for together. */
const OPENING_TIMEOUT_MS = 120000;

/**
 * Politeness and preamble, which carry no information about the work.
 *
 * Stripped so an opening line reads as a summary rather than as the request
 * repeated back. Somebody who has just typed a sentence does not need it
 * quoted at them; they need to see that the part that matters was understood.
 */
const REQUEST_PREAMBLE_RE =
  /^(hi|hey|hello|ok|okay|so|and|also|please|pls|can you|could you|would you|will you|can we|could we|i want you to|i'd like you to|i would like you to|lets|let's|we should|we need to|do you think you can|are you able to)\b[\s,:-]*/iu;

/** A request, short enough to read back in a chat line. */
export function summariseObjective(objective: string): string {
  let text = objective.replace(/\s+/gu, " ").trim();
  // Context sentences come before the ask often enough to be worth dropping:
  // "this is a greenfield project, the end goal is X. can you get started"
  // is a request to get started, and the first clause is background.
  const sentences = text.split(/(?<=[.!?])\s+/u).filter((part) => part.trim().length > 0);
  const asking = sentences.find((part) => REQUEST_PREAMBLE_RE.test(part.trim()));
  text = (asking ?? sentences.at(-1) ?? text).trim();
  // Peel politeness repeatedly: "so please can you fix…" is three layers.
  for (let round = 0; round < 4; round += 1) {
    const stripped = text.replace(REQUEST_PREAMBLE_RE, "").trim();
    if (stripped === text || stripped.length === 0) {
      break;
    }
    text = stripped;
  }
  if (text.length <= 90) {
    return text;
  }
  // Cut on a word boundary; a summary that ends mid-word reads as breakage.
  const clipped = text.slice(0, 90);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
}

/**
 * Prefixes an objective with the role the mentioned agent currently holds in
 * this repository's channel, so the CLI prompt the agent actually receives
 * says what it says — see the call site in `dispatchOneMention` for why this
 * is the one place that can resolve a (repository, agent) role at all. An
 * agent has no role until someone in that channel sets one — there is no
 * vendor-guessed default anymore — so a blank or whitespace-only role is the
 * ordinary case for a freshly connected agent, not an edge case, and leaves
 * the objective untouched rather than prefixing an empty sentence.
 */
export function withRoleContext(role: string, objective: string): string {
  const trimmedRole = role.trim();
  if (trimmedRole === "") {
    return objective;
  }
  return `Your role in this repository: ${trimmedRole}.\n\n${objective}`;
}

/**
 * A task is stopped being followed after this long even without a terminal
 * event, so a run that dies without recording an ending cannot leave a
 * watcher polling for the lifetime of the process.
 */
const CHANNEL_PROGRESS_MAX_MS = 60 * 60 * 1000;

/** Audit events that end a task, and the line each one closes the thread with. */
const CHANNEL_TERMINAL_EVENTS: Record<string, string> = {
  canonical_promoted: "Done — the change is in canonical.",
  task_failed: "I could not finish this.",
  task_cancelled: "This was cancelled.",
};

/**
 * Turns a run's failure into something the reader can act on.
 *
 * "I could not finish this" is true and useless. The reason is already in the
 * audit record, and the one that matters most in practice — an expired
 * sign-in — has an obvious remedy that the person reading the thread is the
 * only one who can carry out. Note that `claude auth status` reports a
 * *stored* session, not a working one, so this is the first place the
 * difference becomes visible.
 */
const IS_AUTH_FAILURE_RE =
  /OAuth session expired|could not be refreshed|Failed to authenticate|Not logged in|invalid_api_key|unauthorized|401/iu;

/**
 * What each integration outcome means, said plainly.
 *
 * The integration path records its outcome as a status and an explanation
 * rather than an `error`, so a run that got all the way to integration and
 * stopped had nothing in the field the narration reads — which is how "I could
 * not finish this." reached a thread with no reason attached at all.
 */
const INTEGRATION_FAILURE_REASONS: Record<string, string> = {
  conflict:
    "the change clashed with work that landed while I was writing it, and I " +
    "could not merge the two",
  validation_failed: "the checks did not pass on what I wrote",
  policy_failed: "this project's rules would not let the change land",
  stale: "the branch moved on before I could land it",
  empty: "I did not end up with any changes to make",
};

/**
 * The same courtesy for a question that could not be answered.
 *
 * Kept apart from {@link explainTaskFailure} because a question that fails did
 * not "fail to finish" — nothing was started. Borrowing the task wording made
 * a momentary model error read as abandoned work.
 */
export function explainAnswerFailure(error?: string): string {
  if (IS_AUTH_FAILURE_RE.test(error ?? "")) {
    return (
      "I could not answer that — my sign-in has expired. Reconnect me from " +
      "My Agents."
    );
  }
  const cleaned = (error ?? "").replace(/\s+/gu, " ").trim();
  return cleaned.length === 0
    ? "I could not answer that just now."
    : `I could not answer that just now: ${cleaned.slice(0, 200)}`;
}

function explainTaskFailure(error: string, status?: string): string {
  if (
    /OAuth session expired|could not be refreshed|Failed to authenticate|invalid_api_key|Not logged in|401/iu.test(
      error,
    )
  ) {
    return (
      "I could not finish this — my sign-in has expired. Reconnect me from " +
      "My Agents and send this again."
    );
  }
  const cleaned = error.replace(/\s+/gu, " ").trim();
  const reason = status === undefined ? undefined : INTEGRATION_FAILURE_REASONS[status];
  if (cleaned.length > 0) {
    return reason === undefined
      ? `I could not finish this: ${cleaned.slice(0, 240)}`
      : `I could not finish this — ${reason}: ${cleaned.slice(0, 200)}`;
  }
  return reason === undefined
    ? "I could not finish this."
    : `I could not finish this — ${reason}.`;
}

/**
 * One audit event as a line worth reading in a channel.
 *
 * Deliberately a whitelist: the audit log carries a lot that means nothing to
 * somebody watching a chat, and narrating all of it would bury the few events
 * that actually say what the agent is doing. Anything unrecognised is
 * skipped rather than dumped.
 */
export function narrateTaskEvent(
  type: string,
  data: Record<string, unknown>,
): string | undefined {
  const files = Array.isArray(data["files"])
    ? (data["files"] as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  switch (type) {
    case "task_started":
      return "Reading the repository and working out a plan…";
    case "plan_received":
      return files.length > 0
        ? `Planning changes to ${files.slice(0, 4).join(", ")}${
            files.length > 4 ? ` and ${String(files.length - 4)} more` : ""
          }.`
        : "Planned the change.";
    case "plan_admitted":
      return "Plan approved — starting on the code.";
    case "replan_requested":
      return "Something moved underneath me; re-planning against the latest code.";
    case "agent_progress":
      return typeof data["message"] === "string" && data["message"].length > 0
        ? String(data["message"]).slice(0, 300)
        : undefined;
    case "changeset_collected":
      return files.length > 0
        ? `Wrote changes to ${files.slice(0, 4).join(", ")}${
            files.length > 4 ? ` and ${String(files.length - 4)} more` : ""
          }. Validating…`
        : "Finished editing. Validating…";
    case "validation_completed":
      return data["status"] === "integrated"
        ? "Validation passed."
        : `Validation came back ${String(data["status"] ?? "unresolved")}.`;
    case "approval_requested":
      return "Waiting on a human review before this can land.";
    case "task_failed": {
      // Two shapes reach here. Most emitters record `error`; the integration
      // path records `explanation` and a `status`. Reading only the first left
      // the most common ending — a run that finished and could not land —
      // reported as a bare "I could not finish this."
      const detail =
        typeof data["error"] === "string" && data["error"].length > 0
          ? data["error"]
          : typeof data["explanation"] === "string"
            ? data["explanation"]
            : "";
      return explainTaskFailure(
        detail,
        typeof data["status"] === "string" ? data["status"] : undefined,
      );
    }
    case "approval_decided":
      return undefined;
    default:
      return CHANNEL_TERMINAL_EVENTS[type];
  }
}

/** One connected agent an @mention (or an auto-claim) could resolve to. */
type ChannelMentionCandidate = {
  userId: string;
  userName: string;
  provider: string;
  vendor: "claude" | "codex" | "gemini";
  visibility: "personal" | "org";
  name: string;
  /** This channel's declared role for the agent, or "" if unlabeled. */
  role: string;
};

/* ------------------------------------------------- no-mention auto-claim --
 *
 * When a channel message carries no "@" at all, `maybeAutoClaimTask` (near
 * `dispatchChannelMentions`) decides whether it reads as a task and, if so,
 * whether exactly one connected agent is a clear enough fit to dispatch to
 * without being asked by name. Everything below is that decision's two
 * halves — "is this a task" and "who fits" — kept as free functions so each
 * is independently readable and testable.
 */

/**
 * A message that is only an acknowledgment, greeting, or filler — never a
 * task, regardless of anything else in it (there is nothing else in it).
 */
const ACK_ONLY_RE =
  /^(hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|k|kk|cool|nice|great|awesome|sounds good|sounds great|got it|no problem|np|sure|yep|yeah|yes|no|nope|lol|haha|\+1|👍)[\s!.,?]*$/iu;

/**
 * Verbs and verb phrases that read as a request for work, in the base form
 * and the inflections a channel message actually uses ("fix", "fixed",
 * "fixing", …). Deliberately concrete build/change/fix vocabulary — see
 * {@link looksLikeTaskRequest} for why this stays a word list.
 */
const TASK_VERB_RE =
  /\b(make|makes|made|making|fix|fixe[sd]|fixing|add|adds|added|adding|update|updates|updated|updating|change|changes|changed|changing|remove|removes|removed|removing|delete|deletes|deleted|deleting|implement|implements|implemented|implementing|build|builds|built|building|create|creates|created|creating|refactor|refactors|refactored|refactoring|investigate|investigates|investigated|investigating|debug|debugs|debugged|debugging|patch|patches|patched|patching|migrate|migrates|migrated|migrating|rename|renames|renamed|renaming|adjust|adjusts|adjusted|adjusting|tweak|tweaks|tweaked|tweaking|write|writes|wrote|writing|move|moves|moved|moving|deploy|deploys|deployed|deploying|revert|reverts|reverted|reverting|upgrade|upgrades|upgraded|upgrading|optimi[sz]e[sd]?|optimi[sz]ing|clean ?up|handle|handles|handled|handling|support|supports|supported|supporting|enable|enables|enabled|enabling|disable|disables|disabled|disabling|hook ?up|wire ?up|set ?up|review|reviews|reviewed|reviewing|swap|swaps|swapped|swapping|replace|replaces|replaced|replacing|bump|bumps|bumped|bumping|revise|revises|revised|revising|look into|check into)\b/iu;

/**
 * A question about the status of existing work — asked *with* a task verb
 * present ("is the login fix deployed yet?" contains "fix" and "deploy")
 * but not itself a request for new work. Checked after {@link TASK_VERB_RE}
 * matches, to veto exactly that overlap.
 */
const STATUS_QUESTION_RE =
  /\b(is|are|was|were|did|does|do|has|have|any|what'?s|when'?s)\b[^?]*\b(done|finished|fixed|ready|status|progress|update|updated|merged|deployed|live|working)\b[^?]*\?\s*$/iu;

/**
 * The message with its @mentions removed.
 *
 * Strips `@Name` and `@Name (Owner)` and nothing more. Allowing whitespace
 * inside the name made an earlier version greedy enough to swallow the whole
 * sentence, which read as "not a question" and turned every question into a
 * task.
 *
 * Used for the objective as well as the question test: a task called
 * "@Claude (Nathan) this is a greenfield project…" is named after the routing
 * rather than the work, and that name is what a person has to recognise it by
 * later.
 */
function withoutMentions(content: string): string {
  return content.replace(/@[\w.-]+(?:\s*\([^)]*\))?/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Openers that make a sentence a question even without a question mark. */
const INTERROGATIVE_RE =
  /^(what|why|how|when|who|where|which|is|are|was|were|do|does|did|can|could|would|will|should|have|has|any)\b/iu;

/**
 * Whether a message addressed to an agent by name is a question rather than
 * a request for work.
 *
 * The bias here is the opposite of {@link looksLikeTaskRequest}'s, and
 * deliberately so. That one guards the no-mention path, where a false
 * positive spends somebody's account on work nobody asked for, so it demands
 * positive evidence of a task. Naming an agent is already that evidence: the
 * sender chose it on purpose. So a mention is treated as work unless it
 * reads as a question, rather than only when it matches a verb list — a
 * whitelist miss on this path would answer "kick off the release checklist"
 * with chat instead of doing it.
 *
 * A question containing a real task verb ("can we make a chess game?") is
 * still work; the question mark is grammar, not intent.
 */
function readsAsQuestion(content: string): boolean {
  const text = withoutMentions(content);
  if (text.length === 0) {
    return false;
  }
  if (TASK_VERB_RE.test(text)) {
    return false;
  }
  return text.endsWith("?") || INTERROGATIVE_RE.test(text);
}

/**
 * Whether a channel message reads as a request for work, conservatively.
 *
 * This is not NLP — a small, documented word list, biased hard toward false
 * negatives on purpose. A message that should have triggered but didn't
 * costs nothing: the sender can still @mention the right agent by hand,
 * which always works. A message that shouldn't have triggered but did
 * spends someone's real API/subscription usage on unwanted work. Those two
 * failure modes are not symmetric, so the rule requires *positive* evidence
 * — a concrete task verb — rather than merely the *absence* of a chatter
 * marker, and a status question about existing work is excluded even when
 * it contains a verb.
 */
function looksLikeTaskRequest(content: string): boolean {
  const text = content.trim();
  if (text.length < 6) {
    return false;
  }
  if (ACK_ONLY_RE.test(text)) {
    return false;
  }
  if (!TASK_VERB_RE.test(text)) {
    return false;
  }
  if (STATUS_QUESTION_RE.test(text)) {
    return false;
  }
  return true;
}

/** Common words that carry no relevance signal, stripped before scoring. */
const RELEVANCE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with",
  "is", "are", "can", "could", "would", "we", "you", "your", "please",
  "hey", "hi", "this", "that", "it", "be", "as", "at", "by", "our", "us",
  "someone", "anybody", "anyone", "who", "what", "when", "where", "why",
  "how", "just", "also", "really", "its", "was", "were", "not", "so",
]);

/**
 * Lowercased, punctuation-stripped, stopword-filtered token set for
 * matching a message against a candidate's role/name text or a past
 * objective. Single-character tokens are dropped as noise; two-character
 * ones are kept deliberately ("ui", "db", "ci" all carry real signal for
 * this).
 */
function relevanceTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gu, " ")
      .split(/\s+/u)
      .filter((word) => word.length > 1 && !RELEVANCE_STOPWORDS.has(word)),
  );
}

/** How many of an owner's most recent submitted tasks feed the activity signal. */
const RECENT_ACTIVITY_LOOKBACK = 25;
/** Caps the recent-activity contribution so the declared role/name always leads it. */
const MAX_ACTIVITY_SCORE = 2;
/** Weight of one overlapping role/name token — see the constants below for how this is used. */
const ROLE_TOKEN_WEIGHT = 2;
/**
 * Retained for the score's own arithmetic, no longer a gate on dispatching.
 *
 * It used to be the bar a candidate had to clear before anyone would take an
 * unaddressed request, which meant a task sharing no vocabulary with any
 * agent's role went unanswered. Set
 * equal to one overlapping role/name token: recent activity alone (see
 * {@link scoreCandidate}) can never reach this on its own, because it is
 * gated on a role/name match existing in the first place.
 */
const MIN_CLAIM_SCORE = ROLE_TOKEN_WEIGHT;
/**
 * The winner must beat the runner-up by both a flat margin and a relative
 * one, together. A flat `+2` alone would still let a runner-up of 8 vs a
 * winner of 10 through (clearly too close relatively); a `1.5x` ratio alone
 * would let a winner of 1 vs a runner-up of 0 through on a single
 * coincidental token. Requiring both is what makes "two similarly relevant
 * agents" — the ambiguous case the brief calls out — fail closed instead of
 * picking a coin flip.
 */
const MIN_MARGIN_ABSOLUTE = ROLE_TOKEN_WEIGHT;
const MIN_MARGIN_RATIO = 1.5;

/**
 * Scores one candidate's fit for a message.
 *
 * The primary signal is overlap between the message's words and the
 * candidate's declared role plus its display name — genuine free text a
 * channel lets someone set per agent (`setChannelAgentOverride`). An agent
 * nobody has labeled contributes no role tokens at all (role is "" until
 * set — there is no vendor-guessed default), so it competes on name overlap
 * alone, same as any other candidate whose role happens not to match. The
 * secondary signal is
 * a small, capped bonus for recent task activity this candidate's *owner*
 * has actually had in this repository.
 *
 * That activity signal is deliberately coarse, and deliberately reuses data
 * that already exists rather than adding a new tracking system: there is no
 * per-agent recent-files or recent-activity index anywhere in this codebase
 * today (the Changes drawer / `state.changeSet` in `data.js` holds one
 * changeset for whichever session Code currently has open, not a
 * roster-wide per-agent history). What already exists and is cheap to read
 * is `store.listSubmittedTasks({ repositoryId })`, whose records carry
 * `submittedBy` and `objective` for free — no new plumbing. It is
 * attributed to the *owner* of a candidate rather than disambiguated
 * further by vendor, because the coordinator's own `agentId` is configured
 * one-per-vendor for the whole deployment, not one per user (see
 * `resolveAgentIdForVendor` in `apps/web/src/index.ts`) — there is no finer
 * key available to join on. That makes it an approximation of "this agent
 * has been active here," not a literal "these are the files it touched,"
 * which is why it is weighted low, capped, and — see the `roleOverlap === 0`
 * check below — never enough on its own to make a candidate eligible.
 */
function scoreCandidate(
  messageTokens: ReadonlySet<string>,
  candidate: { role: string; name: string },
  recentObjectives: readonly string[],
): { score: number; roleOverlap: number } {
  const roleTokens = relevanceTokens(`${candidate.role} ${candidate.name}`);
  let roleOverlap = 0;
  for (const token of roleTokens) {
    if (messageTokens.has(token)) {
      roleOverlap += 1;
    }
  }
  if (roleOverlap === 0) {
    return { score: 0, roleOverlap: 0 };
  }
  let activityOverlap = 0;
  for (const objective of recentObjectives) {
    for (const token of relevanceTokens(objective)) {
      if (messageTokens.has(token)) {
        activityOverlap += 1;
      }
    }
  }
  const score =
    roleOverlap * ROLE_TOKEN_WEIGHT + Math.min(activityOverlap, MAX_ACTIVITY_SCORE);
  return { score, roleOverlap };
}
const MAX_JSON_BYTES = 1024 * 1024;
/** How long a worker holds a task before it must heartbeat again. */
const WORK_LEASE_TTL_MS = 5 * 60 * 1000;
/** A week: long enough to be useful, short enough to be a poor thing to leak. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ROLES: readonly OrganizationRole[] = [
  "owner",
  "admin",
  "developer",
  "reviewer",
  "viewer",
];
const TASK_STATUSES: readonly SubmittedTaskStatus[] = [
  "submitted",
  "claimed",
  "integrated",
  "failed",
  "cancelled",
];
const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
];

export interface StaticAsset {
  body: Buffer | string;
  contentType: string;
  etag?: string;
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
  exec(input: WorkspaceScopeInput & { command: string }): Promise<unknown>;
  submit(input: WorkspaceScopeInput & { objective: string }): Promise<unknown>;
}

export interface ApiOperations {
  listAgents?(): Promise<
    Array<{
      id: string;
      adapter: "codex" | "claude" | "gemini" | "generic-cli";
      default: boolean;
    }>
  >;
  createRepository(input: {
    projectId: string;
    id: string;
    branch?: string;
    actorId: string;
  }): Promise<StoredRepository>;
  importGitHub(input: {
    projectId: string;
    repository: string;
    id?: string;
    branch?: string;
    token?: string;
    actorId: string;
  }): Promise<StoredRepository>;
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
    vendor?: "claude" | "codex" | "gemini";
    actorId: string;
  }): Promise<SubmittedTask>;
  runRepository(input: {
    projectId: string;
    repositoryId: string;
    actorId: string;
  }): Promise<void>;
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
  }): Promise<WorkAssignment | undefined>;
  leaseBundle?(leaseId: string): Promise<Buffer | undefined>;
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
  }): Promise<unknown>;
  /** Dashboard overlay workspaces; absent on deployments without them. */
  workspace?: WorkspaceOperations;
  /** Direct provider chat (Anthropic/OpenAI/Google); absent when unsupported. */
  chatProviders?: ChatProviderOperations;
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
     * Only some vendors need this leg. Codex approves in the browser and the
     * CLI polls; Anthropic issues the user a code that has to be given back
     * to the CLI sitting on stdin.
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
  options(input: { provider: string }): Promise<unknown>;
  /** Consumption the provider's own CLI publishes, when it publishes any. */
  usage(input: { provider: string }): Promise<unknown>;
  setSettings(input: {
    userId: string;
    provider: string;
    model?: string;
    effort?: string;
    visibility?: "personal" | "org";
  }): Promise<unknown>;
  complete(input: {
    userId: string;
    systemAdmin: boolean;
    provider: string;
    messages: unknown;
    cliSessionId?: string;
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
    },
    onEvent: (event: unknown) => void,
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
    Record<string, Array<{ provider: string; visibility: "personal" | "org" }>>
  >;
}

/** Everything a worker needs to execute one task without further lookups. */
export interface WorkAssignment {
  lease: WorkLease;
  task: SubmittedTask;
  repository: { id: string; branch: string };
  canonicalVersion: {
    sequence: number;
    revision: string;
    branch: string;
    createdAt: string;
  };
  /** Fetch the workspace contents from here, then clone it. */
  bundleUrl: string;
  /** Branch to check out from the bundle. */
  bundleRef: string;
  heartbeatIntervalMs: number;
  /** Remote worker protocol version this control plane speaks. */
  protocolVersion: number;
  /** Submit the agent's plan here for admission before executing. */
  planUrl: string;
}

export interface ApiGatewayOptions {
  store: CoordinationStore;
  operations: ApiOperations;
  bootstrapToken: string;
  allowedOrigins?: readonly string[];
  secureCookies?: boolean;
  staticAssets?: ReadonlyMap<string, StaticAsset>;
  requestBodyLimit?: number;
  rateLimitPerMinute?: number;
  authRateLimitPerMinute?: number;
  /** Event poll cadence; exposed for deterministic embedded runtimes/tests. */
  webSocketPollIntervalMs?: number;
  /** How often open event channels re-check account and membership state. */
  webSocketReauthorizeIntervalMs?: number;
  /**
   * Cadence of the collaboration hub's sweep: reauthorization, in-flight agent
   * activity, and flushing idle rooms. Exposed for tests.
   */
  collabTickIntervalMs?: number;
}

interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  requestId: string;
  principal?: AuthenticatedPrincipal;
}

class HttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * A colour, accepted only as `#rrggbb`.
 *
 * The value is written into a `style` attribute by the dashboard, so anything
 * looser than an exact hex triple is an injection point: `red;background:url()`
 * is a perfectly good CSS colour prefix. Validating at the edge means the
 * browser never has to sanitise it.
 */
function hexColorField(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value.trim())) {
    throw new HttpError(
      400,
      "invalid_request",
      `${field} must be a #rrggbb colour`,
    );
  }
  return value.trim().toLowerCase();
}

function stringField(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; optional?: boolean } = {},
): string | undefined {
  if (value === undefined && options.optional === true) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (
    trimmed.length < (options.min ?? 1) ||
    trimmed.length > (options.max ?? 10_000)
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      `${field} has an invalid length`,
    );
  }
  return trimmed;
}

function emailField(
  value: unknown,
  options: { optional?: boolean } = {},
): string | undefined {
  const email = stringField(value, "email", {
    max: 320,
    ...(options.optional === undefined
      ? {}
      : { optional: options.optional }),
  });
  if (
    email !== undefined &&
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)
  ) {
    throw new HttpError(400, "invalid_email", "email is not valid");
  }
  return email?.toLowerCase();
}

function slugField(
  value: unknown,
  options: { optional?: boolean } = {},
): string | undefined {
  const slug = stringField(value, "slug", {
    max: 80,
    ...(options.optional === undefined
      ? {}
      : { optional: options.optional }),
  });
  if (
    slug !== undefined &&
    !/^[a-z0-9][a-z0-9._-]*$/iu.test(slug)
  ) {
    throw new HttpError(
      400,
      "invalid_slug",
      "slug must start alphanumeric and contain only letters, digits, dot, dash, or underscore",
    );
  }
  return slug?.toLowerCase();
}

function booleanField(
  value: unknown,
  field: string,
  optional = true,
): boolean | undefined {
  if (value === undefined && optional) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_request", `${field} must be a boolean`);
  }
  return value;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

function matchPath(pathname: string, pattern: RegExp): string[] | undefined {
  const match = pattern.exec(pathname);
  if (match === null) {
    return undefined;
  }
  try {
    return match.slice(1).map((value) => decodeURIComponent(value));
  } catch {
    throw new HttpError(
      400,
      "invalid_path",
      "Request path contains invalid percent encoding",
    );
  }
}

/**
 * Drops rows for repositories the caller cannot reach.
 *
 * Per-repository access is only real if the lists respect it. Tasks, runs and
 * approvals all carry the repository they belong to, so one helper narrows
 * them; `undefined` means an organization role, which reaches everything.
 */
function narrowToRepositories<T extends { repositoryId?: string }>(
  rows: readonly T[],
  repositories: ReadonlySet<string> | undefined,
): T[] {
  if (repositories === undefined) {
    return [...rows];
  }
  return rows.filter(
    (row) => row.repositoryId !== undefined && repositories.has(row.repositoryId),
  );
}

/** An invitation without its secret, which is never stored recoverably. */
function publicInvitation(invitation: {
  id: string;
  organizationId: string;
  repositoryId?: string | undefined;
  email: string;
  role: OrganizationRole;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | undefined;
  acceptedBy: string | undefined;
  revokedAt: string | undefined;
}) {
  const status =
    invitation.revokedAt !== undefined
      ? "revoked"
      : invitation.acceptedAt !== undefined
        ? "accepted"
        : Date.parse(invitation.expiresAt) < Date.now()
          ? "expired"
          : "pending";
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    repositoryId: invitation.repositoryId,
    email: invitation.email,
    role: invitation.role,
    invitedBy: invitation.invitedBy,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    status,
  };
}

function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  systemAdmin: boolean;
  disabled: boolean;
  createdAt: string;
  appearance?: { accent?: string; agentColor?: string };
}): Omit<typeof user, "passwordDigest"> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    systemAdmin: user.systemAdmin,
    disabled: user.disabled,
    createdAt: user.createdAt,
    // Deliberately public within the organization: an agent colour only
    // identifies its owner if the people working alongside them can read it.
    ...(user.appearance === undefined ? {} : { appearance: user.appearance }),
  };
}

function safeEqual(left: string, right: string): boolean {
  const first = createHash("sha256").update(left).digest();
  const second = createHash("sha256").update(right).digest();
  return timingSafeEqual(first, second);
}

export class ApiGateway {
  public readonly server: Server;
  public readonly webSockets: AuditWebSocketHub;
  public readonly collaboration: CollabWebSocketHub;
  private readonly auth: AuthService;
  private readonly limiter: RateLimiter;
  private readonly authLimiter: RateLimiter;
  private readonly activeRuns = new Set<string>();
  /** Tasks whose progress is being narrated into a channel thread. */
  private readonly watchedChannelTasks = new Map<string, WatchedChannelTask>();
  private channelProgressTimer: NodeJS.Timeout | undefined;
  private readonly bodyLimit: number;
  private readonly allowedOrigins: ReadonlySet<string>;
  private bootstrapInProgress = false;

  public constructor(private readonly options: ApiGatewayOptions) {
    if (options.bootstrapToken.trim().length < 24) {
      throw new Error("Bootstrap token must contain at least 24 characters");
    }
    this.bodyLimit = options.requestBodyLimit ?? MAX_JSON_BYTES;
    if (!Number.isSafeInteger(this.bodyLimit) || this.bodyLimit < 1) {
      throw new RangeError("Request body limit must be a positive integer");
    }
    this.allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map((value) => {
        const parsed = new URL(value);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username.length > 0 ||
          parsed.password.length > 0 ||
          parsed.pathname !== "/" ||
          parsed.search.length > 0 ||
          parsed.hash.length > 0
        ) {
          throw new Error(`Allowed origin must be a credential-free HTTP origin: ${value}`);
        }
        return parsed.origin;
      }),
    );
    this.auth = new AuthService(options.store, {
      secureCookies: options.secureCookies ?? false,
    });
    this.limiter = new RateLimiter({
      capacity: options.rateLimitPerMinute ?? 240,
    });
    this.authLimiter = new RateLimiter({
      capacity: options.authRateLimitPerMinute ?? 10,
    });
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    const authorizeSocket = async (
      request: IncomingMessage,
      projectId: string,
      permission: "view" | "submit_task",
    ): Promise<WebSocketAuthorization> => {
      this.assertOrigin(request);
      const principal = await this.auth.authenticate(request.headers.cookie);
      const { project } = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        permission,
      );
      return { principal, project };
    };
    const reauthorizeSocket = async (
      authorization: WebSocketAuthorization,
      permission: "view" | "submit_task",
    ): Promise<WebSocketAuthorization> => {
      const principal = await this.auth.refresh(authorization.principal);
      const { project } = await authorizeProject(
        this.options.store,
        principal,
        authorization.project.id,
        permission,
      );
      return { principal, project };
    };
    this.webSockets = new AuditWebSocketHub(options.store, {
      ...(options.webSocketPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.webSocketPollIntervalMs }),
      ...(options.webSocketReauthorizeIntervalMs === undefined
        ? {}
        : {
            reauthorizeIntervalMs:
              options.webSocketReauthorizeIntervalMs,
          }),
      authorize: async (request, projectId) =>
        await authorizeSocket(request, projectId, "view"),
      reauthorize: async (authorization) =>
        await reauthorizeSocket(authorization, "view"),
    });
    // Live collaborative editing. Editing over the socket demands exactly the
    // permission the HTTP editor routes demand, `submit_task`, so opening a
    // second transport cannot widen what a principal may do.
    this.collaboration = new CollabWebSocketHub(options.store, {
      ...(options.collabTickIntervalMs === undefined
        ? {}
        : { tickIntervalMs: options.collabTickIntervalMs }),
      ...(options.webSocketReauthorizeIntervalMs === undefined
        ? {}
        : { reauthorizeIntervalMs: options.webSocketReauthorizeIntervalMs }),
      workspace: options.operations.workspace,
      authorize: async (request, projectId) =>
        await authorizeSocket(request, projectId, "submit_task"),
      reauthorize: async (authorization) =>
        await reauthorizeSocket(authorization, "submit_task"),
    });
    // One `upgrade` listener routes to both hubs: Node delivers every upgrade
    // to every listener, so a hub that rejected unknown paths on its own would
    // tear down the other hub's freshly negotiated socket.
    this.server.on("upgrade", (request, socket, head) => {
      void this.routeUpgrade(request, socket, head).catch(() => {
        if (!socket.destroyed) {
          socket.destroy();
        }
      });
    });
    this.webSockets.startPolling();
    this.collaboration.start();
  }

  private async routeUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      if (await this.collaboration.tryUpgrade(request, socket, head)) {
        return;
      }
      if (await this.webSockets.tryUpgrade(request, socket, head)) {
        return;
      }
      if (!socket.destroyed) {
        socket.end(
          "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      }
    } catch {
      if (!socket.destroyed) {
        socket.end(
          "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      }
    }
  }

  public async close(): Promise<void> {
    if (this.channelProgressTimer !== undefined) {
      clearInterval(this.channelProgressTimer);
      this.channelProgressTimer = undefined;
    }
    this.watchedChannelTasks.clear();
    this.webSockets.close();
    this.collaboration.close();
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId =
      typeof request.headers["x-request-id"] === "string" &&
      /^[A-Za-z0-9._-]{1,128}$/u.test(request.headers["x-request-id"])
        ? request.headers["x-request-id"]
        : randomUUID();
    this.securityHeaders(response, requestId);
    let url: URL;
    try {
      // Routing needs only the origin-form path. Never parse an untrusted Host
      // header as a URL base: malformed authority syntax must not escape the
      // request error boundary or trigger an unhandled rejection.
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      this.sendError(
        response,
        requestId,
        new HttpError(400, "invalid_url", "Request URL is invalid"),
      );
      return;
    }
    const context: RequestContext = {
      request,
      response,
      url,
      requestId,
    };

    try {
      const ip = this.remoteAddress(request);
      const authRoute = [
        `${API_PREFIX}/auth/login`,
        `${API_PREFIX}/auth/bootstrap`,
        // Registration mints an account from an unauthenticated request, so
        // it belongs on the stricter limiter with the other two.
        `${API_PREFIX}/auth/register`,
      ].includes(url.pathname);
      const rate = (authRoute ? this.authLimiter : this.limiter).consume(
        `${ip}:${authRoute ? "auth" : "api"}`,
      );
      response.setHeader("RateLimit-Limit", String(rate.limit));
      response.setHeader("RateLimit-Remaining", String(rate.remaining));
      response.setHeader(
        "RateLimit-Reset",
        String(Math.ceil(rate.resetAt / 1000)),
      );
      if (!rate.allowed) {
        throw new HttpError(429, "rate_limited", "Too many requests");
      }

      if (!url.pathname.startsWith(API_PREFIX)) {
        await this.serveStatic(context);
        return;
      }
      this.assertOrigin(request);
      this.applyCors(request, response);
      if (request.method === "OPTIONS") {
        response.setHeader(
          "Access-Control-Allow-Methods",
          "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
        );
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, X-CSRF-Token, X-Request-Id",
        );
        response.setHeader("Access-Control-Max-Age", "600");
        response.writeHead(204).end();
        return;
      }
      // Looking at an invitation, and accepting one, must work before the
      // recipient has an account — that is the entire point of an invitation.
      // Both carry their own secret, so neither is unauthenticated in the
      // sense that matters.
      const invitationPath = /^\/api\/v1\/invitations\/[^/]+(\/accept)?$/u.test(
        url.pathname,
      );
      const isPublic =
        (request.method === "GET" && url.pathname === `${API_PREFIX}/health`) ||
        (request.method === "GET" && invitationPath) ||
        (request.method === "POST" &&
          [
            `${API_PREFIX}/auth/login`,
            `${API_PREFIX}/auth/bootstrap`,
            // Creating an account cannot require an account.
            `${API_PREFIX}/auth/register`,
          ].includes(url.pathname)) ||
        (request.method === "POST" &&
          url.pathname.endsWith("/accept") &&
          invitationPath);
      if (!isPublic) {
        const bearer = parseBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
        );
        if (bearer !== undefined) {
          // Headless client. No CSRF check: a browser never attaches a bearer
          // token on its own, so there is no cross-site request to forge.
          context.principal = await this.auth.authenticateToken(
            bearer,
            this.remoteAddress(request),
          );
        } else {
          context.principal = await this.auth.authenticate(
            request.headers.cookie,
          );
          if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")) {
            await this.auth.verifyCsrf(
              context.principal,
              request.headers.cookie,
              typeof request.headers["x-csrf-token"] === "string"
                ? request.headers["x-csrf-token"]
                : undefined,
            );
          }
        }
      }
      await this.route(context);
    } catch (error) {
      this.sendError(response, requestId, error);
    }
  }

  private async route(context: RequestContext): Promise<void> {
    const { request, response, url } = context;
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === `${API_PREFIX}/health`) {
      let docker:
        | { available: boolean; version?: string; explanation: string }
        | undefined;
      try {
        docker = await this.options.operations.dockerStatus?.();
      } catch (error) {
        docker = {
          available: false,
          explanation: error instanceof Error ? error.message : String(error),
        };
      }
      this.sendJson(response, 200, {
        status: "ok",
        database: "ready",
        setupRequired: (await this.options.store.countUsers()) === 0,
        webSocketConnections: this.webSockets.connections,
        ...(docker === undefined ? {} : { docker }),
        time: new Date().toISOString(),
      });
      return;
    }

    if (method === "POST" && path === `${API_PREFIX}/auth/bootstrap`) {
      const token =
        typeof request.headers["x-bootstrap-token"] === "string"
          ? request.headers["x-bootstrap-token"]
          : "";
      if (!safeEqual(token, this.options.bootstrapToken)) {
        throw new HttpError(403, "invalid_bootstrap_token", "Bootstrap token is invalid");
      }
      const body = objectBody(await this.readJson(request));
      if (this.bootstrapInProgress) {
        throw new HttpError(
          409,
          "bootstrap_in_progress",
          "First-run setup is already in progress",
        );
      }
      this.bootstrapInProgress = true;
      let user;
      try {
        user = await this.auth.bootstrap({
          email: emailField(body["email"]) ?? "",
          displayName:
            stringField(body["displayName"], "displayName", { max: 120 }) ?? "",
          password:
            stringField(body["password"], "password", { max: 256 }) ?? "",
          ...(body["organizationName"] === undefined
            ? {}
            : {
                organizationName:
                  stringField(body["organizationName"], "organizationName", {
                    max: 120,
                  }) ?? "",
              }),
        });
      } finally {
        this.bootstrapInProgress = false;
      }
      const issued = await this.auth.issueSession(
        user,
        this.remoteAddress(request),
        request.headers["user-agent"] ?? "",
      );
      response.setHeader("Set-Cookie", issued.cookies);
      await this.options.store.appendAudit(undefined, {
        type: "user_authenticated",
        data: { userId: user.id, bootstrap: true },
      });
      this.sendJson(response, 201, {
        user: issued.principal.user,
        memberships: issued.principal.memberships,
        csrfToken: issued.csrfToken,
      });
      return;
    }

    if (method === "POST" && path === `${API_PREFIX}/auth/register`) {
      // Open registration: anybody who can reach this control plane can make
      // an account. That is a deployment decision rather than an oversight,
      // and `COORD_DISABLE_REGISTRATION=1` closes it without a deploy for
      // installations that expect invitations to be the only way in.
      if (process.env["COORD_DISABLE_REGISTRATION"] === "1") {
        throw new HttpError(
          403,
          "registration_closed",
          "This control plane does not accept new accounts",
        );
      }
      const body = objectBody(await this.readJson(request));
      const user = await this.auth.register({
        email: emailField(body["email"]) ?? "",
        displayName:
          stringField(body["displayName"], "displayName", { max: 120 }) ?? "",
        password: stringField(body["password"], "password", { max: 256 }) ?? "",
        ...(body["organizationName"] === undefined
          ? {}
          : {
              organizationName:
                stringField(body["organizationName"], "organizationName", {
                  max: 120,
                }) ?? "",
            }),
      });
      const issued = await this.auth.issueSession(
        user,
        this.remoteAddress(request),
        request.headers["user-agent"] ?? "",
      );
      response.setHeader("Set-Cookie", issued.cookies);
      await this.options.store.appendAudit(undefined, {
        type: "user_authenticated",
        data: { userId: user.id, registered: true },
      });
      this.sendJson(response, 201, {
        user: issued.principal.user,
        memberships: issued.principal.memberships,
        csrfToken: issued.csrfToken,
      });
      return;
    }

    if (method === "POST" && path === `${API_PREFIX}/auth/login`) {
      const body = objectBody(await this.readJson(request));
      const issued = await this.auth.login({
        email: emailField(body["email"]) ?? "",
        password: stringField(body["password"], "password", { max: 256 }) ?? "",
        ipAddress: this.remoteAddress(request),
        userAgent: request.headers["user-agent"] ?? "",
      });
      response.setHeader("Set-Cookie", issued.cookies);
      await this.options.store.appendAudit(undefined, {
        type: "user_authenticated",
        data: { userId: issued.principal.user.id, bootstrap: false },
      });
      this.sendJson(response, 200, {
        user: issued.principal.user,
        memberships: issued.principal.memberships,
        csrfToken: issued.csrfToken,
      });
      return;
    }

    // ---- Accepting an invitation ------------------------------------------
    // Reachable without a session: the recipient may have no account yet. The
    // link's own secret is the credential, so this is not an open endpoint.
    // Two patterns rather than one with an optional group: matchPath decodes
    // every group, so an absent group comes back as the string "undefined"
    // rather than as undefined.
    const inviteReadMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/invitations/([^/]+)$`, "u"),
    );
    const inviteAcceptMatch =
      inviteReadMatch === undefined
        ? matchPath(
            path,
            new RegExp(`^${API_PREFIX}/invitations/([^/]+)/accept$`, "u"),
          )
        : undefined;
    const inviteTokenMatch = inviteReadMatch ?? inviteAcceptMatch;
    if (inviteTokenMatch !== undefined) {
      const token = inviteTokenMatch[0] ?? "";
      const action = inviteAcceptMatch === undefined ? undefined : "accept";
      const separator = token.indexOf(".");
      const invitation =
        separator < 1
          ? undefined
          : await this.options.store.getInvitation(token.slice(0, separator));
      const secret = separator < 1 ? "" : token.slice(separator + 1);
      // One answer for every way a link can be wrong, so a probe cannot tell
      // "no such invitation" from "wrong secret".
      if (
        invitation === undefined ||
        !secretMatches(secret, invitation.secretHash)
      ) {
        throw new HttpError(404, "not_found", "This invitation is not valid");
      }
      const organization = await this.options.store.getOrganization(
        invitation.organizationId,
      );
      const state = publicInvitation(invitation).status;

      if (method === "GET" && action === undefined) {
        this.sendJson(response, 200, {
          invitation: {
            email: invitation.email,
            role: invitation.role,
            status: state,
            organizationName: organization?.name ?? "this organization",
            ...(invitation.repositoryId === undefined
              ? {}
              : { repositoryId: invitation.repositoryId }),
            expiresAt: invitation.expiresAt,
          },
        });
        return;
      }

      if (method === "POST" && action === "accept") {
        if (state !== "pending") {
          throw new HttpError(
            409,
            `invitation_${state}`,
            `This invitation has already been ${state}`,
          );
        }
        const body = objectBody(await this.readJson(request));
        let user = await this.options.store.getUserByEmail(invitation.email);
        if (user === undefined) {
          user = await this.options.store.createUser({
            email: invitation.email,
            displayName:
              stringField(body["displayName"], "displayName", { max: 120 }) ??
              "",
            passwordDigest: await hashPassword(
              stringField(body["password"], "password", { max: 256 }) ?? "",
            ),
          });
        } else {
          // The account already exists, so the invitation is not proof of who
          // is holding the link. Signing in is.
          const signedIn = await this.auth
            .authenticate(request.headers.cookie)
            .catch(() => undefined);
          if (signedIn?.user.id !== user.id) {
            throw new HttpError(
              409,
              "account_exists",
              "An account already uses that address. Sign in as " +
                `${invitation.email} and open this link again.`,
            );
          }
        }
        const claimed = await this.options.store.acceptInvitation(
          invitation.id,
          user.id,
          new Date().toISOString(),
        );
        if (!claimed) {
          throw new HttpError(
            409,
            "invitation_used",
            "This invitation has already been used",
          );
        }
        // A repository-scoped invitation grants that repository and nothing
        // else — deliberately no organization membership, because any
        // organization role reaches every repository and would undo the point
        // of scoping the invitation in the first place.
        if (invitation.repositoryId === undefined) {
          await this.options.store.saveMembership({
            organizationId: invitation.organizationId,
            userId: user.id,
            role: invitation.role,
          });
        } else {
          await this.options.store.saveRepositoryGrant({
            repositoryId: invitation.repositoryId,
            userId: user.id,
            role: invitation.role,
            grantedBy: invitation.invitedBy,
            createdAt: new Date().toISOString(),
          });
        }
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            organizationId: invitation.organizationId,
            ...(invitation.repositoryId === undefined
              ? {}
              : { repositoryId: invitation.repositoryId }),
            userId: user.id,
            role: invitation.role,
            action: "accepted_invitation",
            actorId: user.id,
          },
        });
        const issued = await this.auth.issueSession(
          user,
          this.remoteAddress(request),
          request.headers["user-agent"] ?? "",
        );
        response.setHeader("Set-Cookie", issued.cookies);
        this.sendJson(response, 200, {
          user: issued.principal.user,
          memberships: issued.principal.memberships,
          csrfToken: issued.csrfToken,
        });
        return;
      }
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }

    const principal = this.requirePrincipal(context);
    if (method === "POST" && path === `${API_PREFIX}/auth/logout`) {
      // A bearer token has no session to end; revoking it is a separate,
      // explicit action so a stray logout cannot disable a running worker.
      if (principal.sessionId === undefined) {
        throw new HttpError(
          400,
          "not_a_session",
          "Bearer tokens are revoked through /auth/tokens, not sign-out",
        );
      }
      response.setHeader(
        "Set-Cookie",
        await this.auth.logout(principal.sessionId),
      );
      await this.options.store.appendAudit(undefined, {
        type: "user_signed_out",
        data: { userId: principal.user.id },
      });
      this.sendJson(response, 200, { signedOut: true });
      return;
    }
    if (method === "GET" && path === `${API_PREFIX}/auth/me`) {
      this.sendJson(response, 200, principal);
      return;
    }

    // A person's own interface colours. Scoped to the authenticated principal
    // with no user id in the path, so there is no request shape that edits
    // somebody else's appearance.
    if (method === "PATCH" && path === `${API_PREFIX}/auth/me/appearance`) {
      const body = objectBody(await this.readJson(request));
      // A PATCH names only what it changes. The stored value is one object, so
      // an unnamed field has to be carried over: sending just `agentColor`
      // must not silently clear the accent the user picked a moment earlier.
      const current = await this.options.store.getUser(principal.user.id);
      const appearance = {
        ...current?.appearance,
        ...(body["accent"] === undefined
          ? {}
          : { accent: hexColorField(body["accent"], "accent") }),
        ...(body["agentColor"] === undefined
          ? {}
          : { agentColor: hexColorField(body["agentColor"], "agentColor") }),
      };
      const updated = await this.options.store.updateUser(principal.user.id, {
        appearance,
      });
      this.sendJson(response, 200, { user: publicUser(updated) });
      return;
    }


    // ---- Remote worker protocol -------------------------------------------
    // Everything that pulls work or returns changesets requires the run_task
    // scope, so a leaked read-only token cannot execute. The two fleet reads
    // are deliberately not in that set: seeing the organization's workers is a
    // `view`, and holding it to `run_task` would mean a reviewer could not see
    // the machines running the work they review.
    if (path === `${API_PREFIX}/workers/register` && method === "POST") {
      const body = objectBody(await this.readJson(request));
      const organizationId =
        stringField(body["organizationId"], "organizationId", { max: 120 }) ??
        "";
      // The tenant is decided here, once, and every later read of this worker
      // is filtered by it. `authorizeOrganization` is what enforces it: it
      // rejects a token bound elsewhere before consulting the caller's role,
      // so a credential confined to one organization cannot enrol a worker
      // into another even if its owner is a member of both.
      await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        "run_task",
      );
      const adapters = body["adapters"];
      if (
        !Array.isArray(adapters) ||
        !adapters.every((entry): entry is string => typeof entry === "string")
      ) {
        throw new HttpError(
          400,
          "invalid_request",
          "adapters must be an array of strings",
        );
      }
      const worker = await this.options.store.registerWorker({
        userId: principal.user.id,
        organizationId,
        name: stringField(body["name"], "name", { max: 120 }) ?? "",
        adapters,
        version: stringField(body["version"], "version", { max: 40 }) ?? "0",
      });
      this.sendJson(response, 201, worker);
      return;
    }

    if (path === `${API_PREFIX}/agents/running` && method === "GET") {
      // Organization-wide, not project-scoped: an active lease is one agent
      // executing on some worker right now, and a fleet spans the projects it
      // serves. Counted from leases rather than from worker registrations,
      // because a registered worker is idle until it holds one.
      //
      // The organization is required rather than defaulted. These are counts,
      // but a platform-wide count still reports how busy other tenants are,
      // which is not this caller's to know.
      const { organizationId } = await this.authorizeFleet(principal, url);
      const { workers, active } = await this.organizationFleet(organizationId);
      const byWorker = new Map<string, number>();
      for (const lease of active) {
        byWorker.set(lease.workerId, (byWorker.get(lease.workerId) ?? 0) + 1);
      }
      this.sendJson(response, 200, {
        running: active.length,
        workers: workers.length,
        busyWorkers: byWorker.size,
      });
      return;
    }

    if (path === `${API_PREFIX}/workers` && method === "GET") {
      // The whole fleet the organization operates, not just the caller's own
      // workers. A team cannot run shared infrastructure it cannot see, and
      // the tenant boundary — not the registering user — is what makes that
      // safe: `authorizeFleet` requires membership of the organization being
      // asked about, and the store filters on the same id.
      const { organizationId } = await this.authorizeFleet(principal, url);
      const { workers, active } = await this.organizationFleet(organizationId);
      const leasesByWorker = new Map<string, typeof active>();
      for (const lease of active) {
        const bucket = leasesByWorker.get(lease.workerId) ?? [];
        bucket.push(lease);
        leasesByWorker.set(lease.workerId, bucket);
      }
      this.sendJson(response, 200, {
        workers: workers.map((worker) => ({
          ...worker,
          /** True for the caller's own workers, which only they may drive. */
          own: worker.userId === principal.user.id,
          activeLeases: (leasesByWorker.get(worker.id) ?? []).map((lease) => ({
            id: lease.id,
            taskId: lease.taskId,
            repositoryId: lease.repositoryId,
            projectId: lease.projectId,
            issuedAt: lease.issuedAt,
            expiresAt: lease.expiresAt,
          })),
        })),
      });
      return;
    }

    if (path === `${API_PREFIX}/workers/leases` && method === "POST") {
      assertTokenScope(principal, "run_task");
      const body = objectBody(await this.readJson(request));
      const workerId = stringField(body["workerId"], "workerId", { max: 120 }) ?? "";
      const worker = await this.options.store.getWorker(workerId);
      if (worker === undefined || worker.userId !== principal.user.id) {
        throw new HttpError(404, "not_found", "Worker was not found");
      }
      const projectId =
        stringField(body["projectId"], "projectId", { max: 120 }) ?? "";
      const { project } = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "run_task",
      );
      // Visibility widened to the organization; execution did not follow it
      // across one. A user who belongs to two organizations could otherwise
      // point a worker registered in one at work belonging to the other, and
      // the resulting workspace, bundle, and changeset would carry another
      // tenant's code on a machine that tenant never admitted to its fleet.
      if (worker.organizationId !== project.organizationId) {
        throw new HttpError(
          403,
          "worker_organization_mismatch",
          "This worker is registered to a different organization",
        );
      }

      const nowIso = new Date().toISOString();
      // Reclaim anything a dead worker was holding before handing out new work.
      await this.options.store.expireWorkLeases(nowIso);
      await this.options.store.touchWorker(workerId, nowIso);

      const repositoryId = stringField(body["repositoryId"], "repositoryId", {
        max: 200,
        optional: true,
      });
      const leaseOperation = this.options.operations.leaseWork;
      if (leaseOperation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not support remote workers",
        );
      }
      const assignment = await leaseOperation({
        workerId,
        projectId,
        actorId: principal.user.id,
        ...(repositoryId === undefined ? {} : { repositoryId }),
      });
      if (assignment === undefined) {
        // 204 rather than an empty 200 so a polling worker can branch on the
        // status code without parsing a body.
        response.writeHead(204).end();
        return;
      }
      if (
        assignment.task.projectId !== projectId ||
        assignment.lease.projectId !== projectId
      ) {
        await this.options.store.finishWorkLease(
          assignment.lease.id,
          "released",
          new Date().toISOString(),
          "control-plane project mismatch",
        );
        throw new HttpError(
          500,
          "invalid_assignment",
          "Worker assignment escaped its authorized project",
        );
      }
      this.sendJson(response, 200, assignment);
      return;
    }

    const leaseMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/workers/leases/([^/]+)/(heartbeat|bundle|plan|scope|result|release)$`,
        "u",
      ),
    );
    if (leaseMatch !== undefined) {
      assertTokenScope(principal, "run_task");
      const leaseId = leaseMatch[0] ?? "";
      const action = leaseMatch[1] ?? "";
      const lease = await this.options.store.getWorkLease(leaseId);
      if (lease === undefined) {
        throw new HttpError(404, "not_found", "Lease was not found");
      }
      const owner = await this.options.store.getWorker(lease.workerId);
      if (owner === undefined || owner.userId !== principal.user.id) {
        throw new HttpError(404, "not_found", "Lease was not found");
      }
      if (lease.projectId === undefined) {
        throw new HttpError(
          409,
          "invalid_lease",
          "Lease has no project boundary and cannot be used remotely",
        );
      }
      await authorizeProject(
        this.options.store,
        principal,
        lease.projectId,
        "run_task",
      );

      if (action === "heartbeat" && method === "POST") {
        const now = new Date();
        // A heartbeat may carry the agent's running token total. Recording it
        // here rather than only at the end is what makes a token budget a cap
        // instead of a post-mortem: an overspending task is stopped while it
        // is still spending.
        const reported = await this.recordLeaseTokenUsage(
          request,
          lease,
          now.toISOString(),
        );

        // Cost control: a lease past the project's per-task runtime budget
        // is failed rather than extended. Failing (not releasing) is
        // deliberate — requeueing would re-run the same runaway task and
        // burn the budget again.
        if (lease.projectId !== undefined) {
          const project = await this.options.store.getProject(lease.projectId);
          const leaseBudgets = projectBudgets(project?.policy);
          const maxTaskRuntimeMs = leaseBudgets.maxTaskRuntimeMs;
          const runtimeMs =
            now.getTime() - new Date(lease.issuedAt).getTime();
          const maxTaskTokens = leaseBudgets.maxTaskTokens;
          if (maxTaskTokens !== undefined && reported > maxTaskTokens) {
            await this.failLeaseOnBudget(lease, now, {
              detail:
                `Task exceeded the project token budget of ${maxTaskTokens} tokens`,
              data: { tokensSpent: reported, maxTaskTokens },
            });
            throw new HttpError(
              409,
              "budget_exceeded",
              "This task exceeded the project's token budget; stop work",
            );
          }
          if (maxTaskRuntimeMs !== undefined && runtimeMs > maxTaskRuntimeMs) {
            const failed = await this.options.store.finishWorkLease(
              leaseId,
              "failed",
              now.toISOString(),
              `Task exceeded the project runtime budget of ${maxTaskRuntimeMs} ms`,
            );
            if (failed) {
              const task = (
                await this.options.store.listSubmittedTasks({
                  repositoryId: lease.repositoryId,
                })
              ).find((entry) => entry.id === lease.taskId);
              if (task?.status === "claimed") {
                await this.options.store.completeSubmittedTask(
                  task.id,
                  "failed",
                );
              }
              await this.options.store.appendAudit(undefined, {
                type: "task_failed",
                taskId: lease.taskId,
                data: {
                  projectId: lease.projectId,
                  repositoryId: lease.repositoryId,
                  workerId: lease.workerId,
                  leaseId,
                  stage: "budget_enforcement",
                  runtimeMs,
                  maxTaskRuntimeMs,
                },
              });
            }
            throw new HttpError(
              409,
              "budget_exceeded",
              "This task exceeded the project's runtime budget; stop work",
            );
          }
        }

        const extended = await this.options.store.heartbeatWorkLease(
          leaseId,
          now.toISOString(),
          new Date(now.getTime() + WORK_LEASE_TTL_MS).toISOString(),
        );
        if (extended === undefined) {
          await this.options.store.expireWorkLeases(now.toISOString());
          throw new HttpError(
            409,
            "lease_lost",
            "This lease is no longer active; stop work and re-lease",
          );
        }
        await this.options.store.touchWorker(lease.workerId, now.toISOString());
        this.sendJson(response, 200, extended);
        return;
      }

      if (action === "bundle" && method === "GET") {
        const bundleOperation = this.options.operations.leaseBundle;
        if (bundleOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "This deployment cannot serve repository bundles",
          );
        }
        const bundle = await bundleOperation(leaseId);
        if (bundle === undefined) {
          throw new HttpError(
            409,
            "lease_lost",
            "This lease is no longer active; stop work and re-lease",
          );
        }
        response
          .writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": bundle.byteLength,
          })
          .end(bundle);
        return;
      }

      if (action === "plan" && method === "POST") {
        const planOperation = this.options.operations.admitWorkPlan;
        if (planOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "This deployment cannot admit remote worker plans",
          );
        }
        const body = objectBody(await this.readJson(request));
        const outcome = await planOperation({
          leaseId,
          actorId: principal.user.id,
          plan: body["plan"],
        });
        if (outcome.outcome === "lease_lost") {
          throw new HttpError(409, "lease_lost", outcome.reason);
        }
        if (outcome.outcome === "rejected") {
          // The lease is already failed by now, so this is terminal for the
          // worker rather than something to retry with a corrected plan.
          throw new HttpError(400, "invalid_plan", outcome.reason);
        }
        this.sendJson(response, 200, { admission: outcome.admission });
        return;
      }

      if (action === "scope" && method === "POST") {
        const scopeOperation = this.options.operations.arbitrateScopeChange;
        if (scopeOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "This deployment cannot arbitrate remote scope changes",
          );
        }
        const body = objectBody(await this.readJson(request));
        const outcome = await scopeOperation({
          leaseId,
          actorId: principal.user.id,
          request: body["request"],
        });
        if (outcome.outcome === "lease_lost") {
          throw new HttpError(409, "lease_lost", outcome.reason);
        }
        if (outcome.outcome === "rejected") {
          throw new HttpError(400, "invalid_scope_change", outcome.reason);
        }
        this.sendJson(response, 200, { decision: outcome.decision });
        return;
      }

      if (action === "release" && method === "POST") {
        const released = await this.options.store.finishWorkLease(
          leaseId,
          "released",
          new Date().toISOString(),
          "released by worker",
        );
        if (!released) {
          await this.options.store.expireWorkLeases(new Date().toISOString());
          throw new HttpError(
            409,
            "lease_lost",
            "This lease is no longer active; stop work and re-lease",
          );
        }
        this.sendJson(response, 200, { released: true });
        return;
      }

      if (action === "result" && method === "POST") {
        const body = objectBody(await this.readJson(request));
        // Final spend, recorded but not enforced: the tokens are already gone
        // by the time a result exists, and failing finished work over its bill
        // would waste the very thing the budget exists to protect. The cap is
        // enforced at heartbeat, while the spending is still happening.
        if (Array.isArray(body["tokenUsage"])) {
          await this.recordReportedTokenUsage(
            lease,
            body["tokenUsage"],
            new Date().toISOString(),
          );
        }
        const status = body["status"];
        if (status !== "completed" && status !== "failed") {
          throw new HttpError(
            400,
            "invalid_request",
            'status must be "completed" or "failed"',
          );
        }
        const detail = stringField(body["detail"], "detail", {
          max: 2000,
          optional: true,
        });
        const resultOperation = this.options.operations.acceptWorkResult;
        if (resultOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "This deployment cannot accept remote worker results",
          );
        }
        const accepted = await resultOperation({
          leaseId,
          status,
          actorId: principal.user.id,
          plan: body["plan"],
          changeSet: body["changeSet"],
          ...(detail === undefined ? {} : { detail }),
        });
        this.sendJson(response, 200, accepted);
        return;
      }

      throw new HttpError(405, "method_not_allowed", "Unsupported lease action");
    }

    if (path === `${API_PREFIX}/auth/tokens` && method === "GET") {
      this.sendJson(response, 200, {
        tokens: await this.auth.listApiTokens(principal.user.id),
      });
      return;
    }

    if (path === `${API_PREFIX}/auth/tokens` && method === "POST") {
      // A token may only be minted from an interactive session. Allowing a
      // token to mint another would make revocation meaningless: a leaked
      // credential could silently refresh itself forever.
      if (principal.credential !== "session") {
        throw new HttpError(
          403,
          "session_required",
          "API tokens can only be created from a signed-in session",
        );
      }
      const body = objectBody(await this.readJson(request));
      const requested = body["scopes"];
      if (
        !Array.isArray(requested) ||
        !requested.every((entry): entry is string => typeof entry === "string")
      ) {
        throw new HttpError(400, "invalid_scopes", "scopes must be an array of strings");
      }
      for (const scope of requested) {
        if (!isPermission(scope)) {
          throw new HttpError(400, "invalid_scopes", `Unknown scope: ${scope}`);
        }
      }

      const organizationId = stringField(body["organizationId"], "organizationId", {
        max: 120,
        optional: true,
      });
      // Bound the grant by what the user can actually do, so a token can never
      // be a privilege escalation.
      const allowed = new Set<string>();
      if (principal.user.systemAdmin && organizationId === undefined) {
        for (const permission of ALL_PERMISSIONS) {
          allowed.add(permission);
        }
      } else if (organizationId !== undefined) {
        const { role } = await authorizeOrganization(
          this.options.store,
          principal,
          organizationId,
          "view",
        );
        for (const permission of permissionsForRole(role)) {
          allowed.add(permission);
        }
      } else {
        for (const membership of principal.memberships) {
          for (const permission of permissionsForRole(membership.role)) {
            allowed.add(permission);
          }
        }
      }
      const exceeded = requested.filter((scope) => !allowed.has(scope));
      if (exceeded.length > 0) {
        throw new HttpError(
          403,
          "scope_exceeds_role",
          `Your role does not grant: ${exceeded.join(", ")}`,
        );
      }

      const expiresInDays = body["expiresInDays"];
      if (
        expiresInDays !== undefined &&
        (typeof expiresInDays !== "number" || !Number.isSafeInteger(expiresInDays))
      ) {
        throw new HttpError(
          400,
          "invalid_expiry",
          "expiresInDays must be an integer",
        );
      }

      const user = await this.options.store.getUser(principal.user.id);
      if (user === undefined) {
        throw new HttpError(404, "not_found", "User was not found");
      }
      const issued = await this.auth.issueApiToken({
        user,
        name: stringField(body["name"], "name", { max: 120 }) ?? "",
        scopes: requested,
        ...(organizationId === undefined ? {} : { organizationId }),
        ...(expiresInDays === undefined ? {} : { expiresInDays }),
        ...(principal.sessionId === undefined
          ? {}
          : { createdBySession: principal.sessionId }),
      });
      await this.options.store.appendAudit(undefined, {
        type: "api_token_issued",
        data: {
          userId: principal.user.id,
          tokenId: issued.record.id,
          name: issued.record.name,
          scopes: issued.record.scopes,
          organizationId: issued.record.organizationId ?? null,
          expiresAt: issued.record.expiresAt ?? null,
        },
      });
      // The plaintext appears here and nowhere else, ever.
      this.sendJson(response, 201, { ...issued.record, token: issued.token });
      return;
    }

    if (method === "DELETE" && path.startsWith(`${API_PREFIX}/auth/tokens/`)) {
      const tokenId = decodeURIComponent(
        path.slice(`${API_PREFIX}/auth/tokens/`.length),
      );
      await this.auth.revokeApiToken(principal, tokenId, "revoked by owner");
      await this.options.store.appendAudit(undefined, {
        type: "api_token_revoked",
        data: { userId: principal.user.id, tokenId },
      });
      this.sendJson(response, 200, { revoked: true, tokenId });
      return;
    }

    if (method === "GET" && path === `${API_PREFIX}/organizations`) {
      this.sendJson(response, 200, {
        organizations: await this.reachableOrganizations(principal),
      });
      return;
    }
    if (method === "POST" && path === `${API_PREFIX}/organizations`) {
      assertTokenScope(principal, "manage_organization");
      const body = objectBody(await this.readJson(request));
      const slug = slugField(body["slug"]) ?? "";
      if (
        (await this.options.store.listOrganizations()).some(
          (organization) => organization.slug === slug,
        )
      ) {
        throw new HttpError(
          409,
          "slug_in_use",
          "Organization slug is already in use",
        );
      }
      const organization = await this.options.store.createOrganization({
        slug,
        name: stringField(body["name"], "name", { max: 120 }) ?? "",
      });
      await this.options.store.saveMembership({
        organizationId: organization.id,
        userId: principal.user.id,
        role: "owner",
      });
      await this.options.store.appendAudit(undefined, {
        type: "organization_changed",
        data: {
          organizationId: organization.id,
          action: "created",
          actorId: principal.user.id,
        },
      });
      this.sendJson(response, 201, { organization });
      return;
    }

    const organizationMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/organizations/([^/]+)$`, "u"),
    );
    if (organizationMatch !== undefined) {
      const organizationId = organizationMatch[0] ?? "";
      const permission = method === "GET" ? "view" : "manage_organization";
      const authorized = await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        permission,
      );
      if (method === "GET") {
        this.sendJson(response, 200, authorized);
        return;
      }
      if (method === "PATCH") {
        const body = objectBody(await this.readJson(request));
        const name = stringField(body["name"], "name", {
          max: 120,
          optional: true,
        });
        const slug = slugField(body["slug"], { optional: true });
        if (
          slug !== undefined &&
          (await this.options.store.listOrganizations()).some(
            (organization) =>
              organization.id !== organizationId &&
              organization.slug === slug,
          )
        ) {
          throw new HttpError(
            409,
            "slug_in_use",
            "Organization slug is already in use",
          );
        }
        const organization = await this.options.store.updateOrganization(
          organizationId,
          {
            ...(name === undefined ? {} : { name }),
            ...(slug === undefined ? {} : { slug }),
          },
        );
        await this.options.store.appendAudit(undefined, {
          type: "organization_changed",
          data: {
            organizationId,
            action: "updated",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 200, { organization });
        return;
      }
    }


    // ---- Invitations ------------------------------------------------------
    // Membership already required an account, and creating an account required
    // a system administrator, so an organization owner had no way to bring in
    // a colleague. An invitation closes that loop: it names an email and a
    // role, and creates the account at the moment it is accepted.
    const invitationsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/organizations/([^/]+)/invitations$`, "u"),
    );
    if (invitationsMatch !== undefined) {
      const organizationId = invitationsMatch[0] ?? "";
      const authorized = await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        "manage_members",
      );
      if (method === "GET") {
        this.sendJson(response, 200, {
          invitations: (
            await this.options.store.listInvitations(organizationId)
          ).map(publicInvitation),
        });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const email = emailField(body["email"]) ?? "";
        const role = stringField(body["role"], "role", { max: 20 }) as
          | OrganizationRole
          | undefined;
        if (role === undefined || !ROLES.includes(role)) {
          throw new HttpError(400, "invalid_role", "Role is invalid");
        }
        // The same ceiling as adding a member directly: an invitation must not
        // be a way to hand out a role you could not assign yourself.
        if (!canAssignRole(authorized.role, role)) {
          throw new HttpError(403, "forbidden", "You cannot assign that role");
        }
        // An invitation names exactly one repository, and that is all it
        // grants.
        //
        // The upstream design allowed the name to be omitted, in which case
        // the invitation admitted the person to the whole organization —
        // every repository it holds, including ones created later. That is a
        // much larger thing to hand out than the person offering it usually
        // means to, and it cannot be narrowed afterwards: an organization role
        // reaches everything by design (see `authorizeRepository`), so the
        // only way back is to remove the member entirely. Requiring the
        // repository makes the smaller grant the only one on offer.
        const repositoryId = stringField(body["repositoryId"], "repositoryId", {
          max: 128,
        });
        const owned = await this.options.store.listProjectRepositories(
          stringField(body["projectId"], "projectId", { max: 128 }) ?? "",
        );
        if (!owned.some((entry) => entry.id === repositoryId)) {
          throw new HttpError(
            404,
            "not_found",
            "Repository was not found in that project",
          );
        }
        // Deliberately no "already a member" refusal. That check belonged to
        // the organization-wide invitation, where a second one would have
        // added nothing; a repository grant is worth offering to someone who
        // is already in the organization but cannot reach this repository.
        const id = `inv_${randomBytes(9).toString("base64url")}`;
        const secret = randomBytes(32).toString("base64url");
        const now = new Date();
        const invitation = {
          id,
          organizationId,
          repositoryId,
          email,
          role,
          secretHash: hashSecret(secret),
          invitedBy: principal.user.id,
          createdAt: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + INVITATION_TTL_MS,
          ).toISOString(),
          acceptedAt: undefined,
          acceptedBy: undefined,
          revokedAt: undefined,
        };
        await this.options.store.createInvitation(invitation);
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            organizationId,
            email,
            role,
            action: "invited",
            actorId: principal.user.id,
          },
        });
        // The only time the secret exists in a response. It is not stored in
        // recoverable form, so a lost link is reissued rather than looked up.
        this.sendJson(response, 201, {
          invitation: publicInvitation(invitation),
          token: `${id}.${secret}`,
        });
        return;
      }
    }

    const invitationMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/organizations/([^/]+)/invitations/([^/]+)$`,
        "u",
      ),
    );
    if (invitationMatch !== undefined && method === "DELETE") {
      const [organizationId = "", invitationId = ""] = invitationMatch;
      await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        "manage_members",
      );
      const found = await this.options.store.getInvitation(invitationId);
      if (found === undefined || found.organizationId !== organizationId) {
        throw new HttpError(404, "not_found", "Invitation was not found");
      }
      await this.options.store.revokeInvitation(
        invitationId,
        new Date().toISOString(),
      );
      this.sendJson(response, 200, { revoked: true });
      return;
    }

    const membersMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/organizations/([^/]+)/members$`, "u"),
    );
    if (membersMatch !== undefined) {
      const organizationId = membersMatch[0] ?? "";
      const authorized = await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        method === "GET" ? "view" : "manage_members",
      );
      if (method === "GET") {
        const memberships = await this.options.store.listMemberships(
          organizationId,
        );
        const users = await Promise.all(
          memberships.map(
            async (membership) =>
              await this.options.store.getUser(membership.userId),
          ),
        );
        this.sendJson(response, 200, {
          members: memberships.map((membership, index) => ({
            ...membership,
            user:
              users[index] === undefined
                ? undefined
                : publicUser(users[index]),
          })),
        });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const role = stringField(body["role"], "role", { max: 20 }) as
          | OrganizationRole
          | undefined;
        if (role === undefined || !ROLES.includes(role)) {
          throw new HttpError(400, "invalid_role", "Role is invalid");
        }
        if (!canAssignRole(authorized.role, role)) {
          throw new HttpError(403, "forbidden", "You cannot assign that role");
        }
        const userId = stringField(body["userId"], "userId", {
          max: 128,
          optional: true,
        });
        const email = emailField(body["email"], { optional: true });
        const user =
          userId === undefined
            ? email === undefined
              ? undefined
              : await this.options.store.getUserByEmail(email)
            : await this.options.store.getUser(userId);
        if (user === undefined) {
          throw new HttpError(404, "user_not_found", "User was not found");
        }
        const membership = await this.options.store.saveMembership({
          organizationId,
          userId: user.id,
          role,
        });
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            organizationId,
            userId: user.id,
            role,
            action: "saved",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 201, { membership, user: publicUser(user) });
        return;
      }
    }

    const memberMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/organizations/([^/]+)/members/([^/]+)$`,
        "u",
      ),
    );
    if (memberMatch !== undefined) {
      const [organizationId = "", userId = ""] = memberMatch;
      const authorized = await authorizeOrganization(
        this.options.store,
        principal,
        organizationId,
        "manage_members",
      );
      const current = await this.options.store.getMembership(
        organizationId,
        userId,
      );
      if (current === undefined) {
        throw new HttpError(404, "not_found", "Membership was not found");
      }
      if (method === "PATCH") {
        const body = objectBody(await this.readJson(request));
        const role = stringField(body["role"], "role", { max: 20 }) as
          | OrganizationRole
          | undefined;
        if (role === undefined || !ROLES.includes(role)) {
          throw new HttpError(400, "invalid_role", "Role is invalid");
        }
        if (!canAssignRole(authorized.role, role)) {
          throw new HttpError(403, "forbidden", "You cannot assign that role");
        }
        if (current.role === "owner" && role !== "owner") {
          const owners = (
            await this.options.store.listMemberships(organizationId)
          ).filter((membership) => membership.role === "owner");
          if (owners.length <= 1) {
            throw new HttpError(
              409,
              "last_owner",
              "The last organization owner cannot be demoted",
            );
          }
        }
        const membership = await this.options.store.saveMembership({
          organizationId,
          userId,
          role,
        });
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            organizationId,
            userId,
            role,
            action: "updated",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 200, { membership });
        return;
      }
      if (method === "DELETE") {
        const owners = (
          await this.options.store.listMemberships(organizationId)
        ).filter((membership) => membership.role === "owner");
        if (current.role === "owner" && owners.length <= 1) {
          throw new HttpError(
            409,
            "last_owner",
            "The last organization owner cannot be removed",
          );
        }
        await this.options.store.removeMembership(organizationId, userId);
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            organizationId,
            userId,
            action: "removed",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 200, { removed: true });
        return;
      }
    }

    const projectsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/organizations/([^/]+)/projects$`, "u"),
    );
    if (projectsMatch !== undefined) {
      const organizationId = projectsMatch[0] ?? "";
      // Reading the project list is the one place a grant alone has to be
      // enough: somebody invited to a single repository has no organization
      // role, and without this they sign in successfully and can see nothing.
      // Everything beyond reading still requires a real organization role.
      let hasOrganizationRole = true;
      if (method === "GET") {
        try {
          await authorizeOrganization(
            this.options.store,
            principal,
            organizationId,
            "view",
          );
        } catch (error) {
          hasOrganizationRole = false;
          const grants = await this.options.store.listGrantsForUser(
            principal.user.id,
          );
          if (grants.length === 0) {
            throw error;
          }
        }
      } else {
        await authorizeOrganization(
          this.options.store,
          principal,
          organizationId,
          "manage_project",
        );
      }
      if (method === "GET") {
        const projects = await this.reachableProjects(
          principal,
          organizationId,
          hasOrganizationRole,
        );
        if (!hasOrganizationRole && projects.length === 0) {
          throw new AuthenticationError(
            "You do not have permission to perform this action",
            403,
            "forbidden",
          );
        }
        this.sendJson(response, 200, { projects });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const slug = slugField(body["slug"]) ?? "";
        if (
          (await this.options.store.listProjects(organizationId)).some(
            (project) => project.slug === slug,
          )
        ) {
          throw new HttpError(
            409,
            "slug_in_use",
            "Project slug is already in use",
          );
        }
        const description = stringField(body["description"], "description", {
          max: 2_000,
          optional: true,
        });
        const project = await this.options.store.createProject({
          organizationId,
          slug,
          name: stringField(body["name"], "name", { max: 120 }) ?? "",
          ...(description === undefined ? {} : { description }),
        });
        await this.options.store.appendAudit(undefined, {
          type: "project_changed",
          data: {
            organizationId,
            projectId: project.id,
            action: "created",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 201, { project });
        return;
      }
    }

    const projectMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)$`, "u"),
    );
    if (projectMatch !== undefined) {
      const projectId = projectMatch[0] ?? "";
      const authorized = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        method === "GET" ? "view" : "manage_project",
      );
      if (method === "GET") {
        this.sendJson(response, 200, authorized);
        return;
      }
      if (method === "PATCH") {
        const body = objectBody(await this.readJson(request));
        const slug = slugField(body["slug"], { optional: true });
        if (
          slug !== undefined &&
          (
            await this.options.store.listProjects(
              authorized.project.organizationId,
            )
          ).some(
            (project) => project.id !== projectId && project.slug === slug,
          )
        ) {
          throw new HttpError(
            409,
            "slug_in_use",
            "Project slug is already in use",
          );
        }
        const name = stringField(body["name"], "name", {
          max: 120,
          optional: true,
        });
        const description = stringField(body["description"], "description", {
          max: 2_000,
          optional: true,
        });
        const archived = booleanField(body["archived"], "archived");
        let policy: Record<string, unknown> | null | undefined;
        if ("policy" in body) {
          const value = body["policy"];
          if (value === null) {
            policy = null;
          } else {
            try {
              assertProjectPolicy(value);
            } catch (error) {
              throw new HttpError(
                400,
                "invalid_policy",
                error instanceof Error
                  ? error.message
                  : "Project policy is invalid",
              );
            }
            policy = value as unknown as Record<string, unknown>;
          }
        }
        const project = await this.options.store.updateProject(projectId, {
          ...(slug === undefined ? {} : { slug }),
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(archived === undefined ? {} : { archived }),
          ...(policy === undefined ? {} : { policy }),
        });
        await this.options.store.appendAudit(undefined, {
          type: "project_changed",
          data: {
            organizationId: project.organizationId,
            projectId,
            action: "updated",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 200, { project });
        return;
      }
    }

    const agentsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/agents$`, "u"),
    );
    if (agentsMatch !== undefined && method === "GET") {
      await authorizeProject(
        this.options.store,
        principal,
        agentsMatch[0] ?? "",
        "view",
      );
      this.sendJson(response, 200, {
        agents: (await this.options.operations.listAgents?.()) ?? [],
      });
      return;
    }

    const repositoriesMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/repositories$`, "u"),
    );
    if (repositoriesMatch !== undefined && method === "GET") {
      const projectId = repositoriesMatch[0] ?? "";
      const { repositories } = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "view",
      );
      const all = await this.options.store.listProjectRepositories(projectId);
      this.sendJson(response, 200, {
        // Somebody holding a grant sees the repositories they were granted and
        // no others: this list is how the interface learns what exists, so
        // returning everything here would defeat the grant regardless of what
        // the per-repository routes enforce.
        repositories:
          repositories === undefined
            ? all
            : all.filter((entry) => repositories.has(entry.id)),
      });
      return;
    }
    if (repositoriesMatch !== undefined && method === "POST") {
      const projectId = repositoriesMatch[0] ?? "";
      const { project } = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "import_repository",
      );
      const body = objectBody(await this.readJson(request));
      const branch = stringField(body["branch"], "branch", {
        max: 240,
        optional: true,
      });
      const repository = await this.performOperation(
        "repository_creation_failed",
        async () =>
          await this.options.operations.createRepository({
            projectId,
            id: stringField(body["id"], "id", { max: 80 }) ?? "",
            ...(branch === undefined ? {} : { branch }),
            actorId: principal.user.id,
          }),
      );
      await this.markChannelMembershipChosen(repository.id);
      await this.options.store.appendAudit(undefined, {
        type: "repository_created",
        data: {
          organizationId: project.organizationId,
          projectId,
          repositoryId: repository.id,
          branch: repository.branch,
          actorId: principal.user.id,
        },
      });
      this.sendJson(response, 201, { repository });
      return;
    }

    const githubMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/github$`,
        "u",
      ),
    );
    if (githubMatch !== undefined && method === "POST") {
      const projectId = githubMatch[0] ?? "";
      const { project } = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "import_repository",
      );
      const body = objectBody(await this.readJson(request));
      const id = stringField(body["id"], "id", {
        max: 80,
        optional: true,
      });
      const branch = stringField(body["branch"], "branch", {
        max: 240,
        optional: true,
      });
      const token = stringField(body["token"], "token", {
        max: 1_024,
        optional: true,
      });
      const repository = await this.performOperation(
        "repository_import_failed",
        async () =>
          await this.options.operations.importGitHub({
            projectId,
            repository:
              stringField(body["repository"], "repository", { max: 500 }) ?? "",
            ...(id === undefined ? {} : { id }),
            ...(branch === undefined ? {} : { branch }),
            ...(token === undefined ? {} : { token }),
            actorId: principal.user.id,
          }),
      );
      await this.markChannelMembershipChosen(repository.id);
      await this.options.store.appendAudit(undefined, {
        type: "repository_imported",
        data: {
          organizationId: project.organizationId,
          projectId,
          repositoryId: repository.id,
          provider: "github",
          actorId: principal.user.id,
        },
      });
      this.sendJson(response, 201, { repository });
      return;
    }

    // Deleting a repository. Gated on `manage_project` through the ordinary
    // role/grant pipeline, with the repository's own creator getting a
    // second path in — see `authorizeRepositoryOwnerAction`'s doc comment.
    //
    // Runs and submitted tasks block the underlying `removeRepository` call
    // outright (it is refused, not cascaded — see that method's doc comment
    // in `@coord/persistence`); everything else scoped to the repository,
    // including its shared channel, is cascade-deleted there. That surfaces
    // here as an ordinary thrown error from `performOperation`, the same as
    // any other operation failure.
    const repositoryMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)$`,
        "u",
      ),
    );
    if (repositoryMatch !== undefined && method === "DELETE") {
      const [projectId = "", repositoryId = ""] = repositoryMatch;
      const repository = await this.authorizeRepositoryOwnerAction(
        principal,
        projectId,
        repositoryId,
        "manage_project",
      );
      await this.performOperation("repository_deletion_failed", async () => {
        await this.options.store.removeRepository(repositoryId);
      });
      await this.options.store.appendAudit(undefined, {
        type: "repository_deleted",
        data: {
          projectId,
          repositoryId,
          createdBy: repository.createdBy,
          actorId: principal.user.id,
        },
      });
      this.sendJson(response, 200, { removed: true });
      return;
    }

    // Repository-scoped grants: promoting an existing organization member to
    // full capabilities on *this one repository* ("co-owner"), without
    // touching their organization-wide role. Gated the same way deletion is —
    // `manage_members` through the ordinary pipeline, or the repository's
    // creator.
    //
    // No "last owner" guard, unlike organization membership: an organization
    // role always confers blanket access to every repository it owns (see
    // `repository-grants`'s migration comment), so as long as the
    // organization retains an owner or admin, revoking every grant on a
    // repository — including the creator's own, if they hold one — can never
    // leave it with nobody able to reach it. The creator's own administrative
    // access does not even depend on holding a grant; it comes from
    // `createdBy`, which revoking a grant never touches.
    const repositoryGrantsMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/grants$`,
        "u",
      ),
    );
    if (repositoryGrantsMatch !== undefined && method === "GET") {
      const [projectId = "", repositoryId = ""] = repositoryGrantsMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const grants = await this.options.store.listRepositoryGrants(repositoryId);
      const users = await Promise.all(
        grants.map((grant) => this.options.store.getUser(grant.userId)),
      );
      this.sendJson(response, 200, {
        grants: grants.map((grant, index) => ({
          ...grant,
          user: users[index] === undefined ? undefined : publicUser(users[index]!),
        })),
      });
      return;
    }

    const repositoryGrantMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/grants/([^/]+)$`,
        "u",
      ),
    );
    if (repositoryGrantMatch !== undefined && method === "POST") {
      const [projectId = "", repositoryId = "", userId = ""] =
        repositoryGrantMatch;
      await this.authorizeRepositoryOwnerAction(
        principal,
        projectId,
        repositoryId,
        "manage_members",
      );
      const body = objectBody(await this.readJson(request));
      const role = stringField(body["role"], "role", { max: 20 }) as
        | OrganizationRole
        | undefined;
      if (role === undefined || !ROLES.includes(role)) {
        throw new HttpError(400, "invalid_role", "Role is invalid");
      }
      const user = await this.options.store.getUser(userId);
      if (user === undefined) {
        throw new HttpError(404, "user_not_found", "User was not found");
      }
      const project = await this.options.store.getProject(projectId);
      const membership =
        project === undefined
          ? undefined
          : await this.options.store.getMembership(
              project.organizationId,
              userId,
            );
      if (membership === undefined) {
        throw new HttpError(
          404,
          "not_found",
          "That user is not a member of this organization",
        );
      }
      await this.options.store.saveRepositoryGrant({
        repositoryId,
        userId,
        role,
        grantedBy: principal.user.id,
        createdAt: new Date().toISOString(),
      });
      await this.options.store.appendAudit(undefined, {
        type: "membership_changed",
        data: {
          organizationId: project?.organizationId,
          projectId,
          repositoryId,
          userId,
          role,
          action: "grant_saved",
          actorId: principal.user.id,
        },
      });
      this.sendJson(response, 200, { grant: { repositoryId, userId, role } });
      return;
    }
    if (repositoryGrantMatch !== undefined && method === "DELETE") {
      const [projectId = "", repositoryId = "", userId = ""] =
        repositoryGrantMatch;
      const isSelf = userId === principal.user.id;
      if (isSelf) {
        // Leaving a repository one holds only through a grant. Anyone who can
        // reach the repository at all may remove their own access — this is
        // not a moderation action.
        const authorized = await authorizeRepository(
          this.options.store,
          principal,
          projectId,
          repositoryId,
          "view",
        );
        if (
          !(await this.options.store.projectHasRepository(
            projectId,
            repositoryId,
          ))
        ) {
          throw new HttpError(404, "not_found", "Repository was not found");
        }
        if (authorized.repositories === undefined) {
          // Reached through an organization role, which reaches every
          // repository the organization owns — there is no per-repository
          // "leave" for that; it would either do nothing or be surprising.
          throw new HttpError(
            409,
            "org_membership_reaches_repository",
            "Your access here comes from an organization-wide role, not a grant on this repository — leave the organization, or ask an admin to change your role, to lose access.",
          );
        }
        const existing = (
          await this.options.store.listRepositoryGrants(repositoryId)
        ).find((grant) => grant.userId === userId);
        if (existing === undefined) {
          throw new HttpError(404, "not_found", "You do not hold a grant on this repository");
        }
        await this.options.store.removeRepositoryGrant(repositoryId, userId);
        await this.options.store.appendAudit(undefined, {
          type: "membership_changed",
          data: {
            projectId,
            repositoryId,
            userId,
            action: "left",
            actorId: principal.user.id,
          },
        });
        this.sendJson(response, 200, { removed: true });
        return;
      }
      // Revoking someone else's grant is moderation.
      await this.authorizeRepositoryOwnerAction(
        principal,
        projectId,
        repositoryId,
        "manage_members",
      );
      const existing = (
        await this.options.store.listRepositoryGrants(repositoryId)
      ).find((grant) => grant.userId === userId);
      if (existing === undefined) {
        throw new HttpError(404, "not_found", "That user does not hold a grant on this repository");
      }
      await this.options.store.removeRepositoryGrant(repositoryId, userId);
      await this.options.store.appendAudit(undefined, {
        type: "membership_changed",
        data: {
          projectId,
          repositoryId,
          userId,
          action: "revoked",
          actorId: principal.user.id,
        },
      });
      this.sendJson(response, 200, { removed: true });
      return;
    }

    const tasksMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/tasks$`, "u"),
    );
    if (tasksMatch !== undefined) {
      const projectId = tasksMatch[0] ?? "";
      const authorized = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        method === "GET" ? "view" : "submit_task",
      );
      if (method === "GET") {
        const statusValue = url.searchParams.get("status") ?? undefined;
        const status =
          statusValue === undefined
            ? undefined
            : TASK_STATUSES.find((entry) => entry === statusValue);
        if (statusValue !== undefined && status === undefined) {
          throw new HttpError(
            400,
            "invalid_status",
            `Task status must be one of ${TASK_STATUSES.join(", ")}`,
          );
        }
        const tasks = await this.options.store.listSubmittedTasks({
          projectId,
          ...(status === undefined ? {} : { status }),
        });
        this.sendJson(response, 200, {
          tasks: narrowToRepositories(tasks, authorized.repositories),
        });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const repositoryId =
          stringField(body["repositoryId"], "repositoryId", { max: 128 }) ?? "";
        if (
          !(await this.options.store.projectHasRepository(
            projectId,
            repositoryId,
          )) ||
          // Reaching the project is not permission to put work into a
          // repository inside it. Same answer either way, so a probe cannot
          // tell "not linked" from "not yours".
          (authorized.repositories !== undefined &&
            !authorized.repositories.has(repositoryId))
        ) {
          throw new HttpError(
            404,
            "repository_not_found",
            "Repository is not linked to this project",
          );
        }
        const agentId = stringField(body["agentId"], "agentId", {
          max: 128,
          optional: true,
        });
        const task = await this.performOperation(
          "task_submission_failed",
          async () =>
            await this.options.operations.submitTask({
              projectId,
              repositoryId,
              objective:
                stringField(body["objective"], "objective", { max: 10_000 }) ??
                "",
              ...(agentId === undefined ? {} : { agentId }),
              actorId: principal.user.id,
            }),
        );
        await this.options.store.appendAudit(undefined, {
          type: "task_submitted",
          taskId: task.id,
          data: {
            projectId,
            repositoryId,
            actorId: principal.user.id,
            objective: task.objective,
          },
        });
        this.sendJson(response, 201, { task });
        return;
      }
    }

    const taskActionMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/tasks/([^/]+)/(retry|cancel)$`, "u"),
    );
    if (taskActionMatch !== undefined && method === "POST") {
      const [taskId = "", action = ""] = taskActionMatch;
      const task = (
        await this.options.store.listSubmittedTasks()
      ).find((entry) => entry.id === taskId);
      if (task === undefined || task.projectId === undefined) {
        throw new HttpError(404, "not_found", "Task was not found");
      }
      await authorizeProject(
        this.options.store,
        principal,
        task.projectId,
        "run_task",
      );
      const runKey = `${task.projectId}\0${task.repositoryId}`;
      if (this.activeRuns.has(runKey)) {
        throw new HttpError(
          409,
          "run_in_progress",
          `Task ${action} is unavailable while its repository run is active`,
        );
      }
      const updated =
        action === "retry"
          ? await this.options.store.retrySubmittedTask(taskId)
          : await this.options.store.cancelSubmittedTask(taskId);
      if (action === "cancel") {
        await this.options.store.appendAudit(undefined, {
          type: "task_cancelled",
          taskId,
          data: {
            projectId: task.projectId,
            actorId: principal.user.id,
          },
        });
      }
      this.sendJson(response, 200, { task: updated });
      return;
    }

    const runMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/run$`,
        "u",
      ),
    );
    if (runMatch !== undefined && method === "POST") {
      const [projectId = "", repositoryId = ""] = runMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "run_task",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const key = `${projectId}\0${repositoryId}`;
      if (this.activeRuns.has(key)) {
        throw new HttpError(
          409,
          "run_in_progress",
          "A run is already active for this repository",
        );
      }
      this.activeRuns.add(key);
      const operationId = createId("operation");
      void this.options.operations
        .runRepository({
          projectId,
          repositoryId,
          actorId: principal.user.id,
        })
        .catch(async (error: unknown) => {
          await this.options.store.appendAudit(undefined, {
            type: "task_failed",
            data: {
              projectId,
              repositoryId,
              operationId,
              stage: "run_start",
              error: error instanceof Error ? error.message : String(error),
            },
          });
        })
        .finally(() => {
          this.activeRuns.delete(key);
        });
      this.sendJson(response, 202, { operationId, status: "accepted" });
      return;
    }

    const runCommentsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/runs/([^/]+)/comments$`, "u"),
    );
    if (runCommentsMatch !== undefined) {
      const runId = runCommentsMatch[0] ?? "";
      const detail = await this.options.store.getRun(runId);
      if (detail === undefined || detail.run.projectId === undefined) {
        throw new HttpError(404, "not_found", "Run was not found");
      }
      if (method === "GET") {
        await authorizeProject(
          this.options.store,
          principal,
          detail.run.projectId,
          "view",
        );
        this.sendJson(response, 200, {
          comments: await this.options.store.listChangesetComments({ runId }),
        });
        return;
      }
      if (method === "POST") {
        // Reviewing is its own permission: a viewer reads the diff, a
        // reviewer writes on it.
        await authorizeProject(
          this.options.store,
          principal,
          detail.run.projectId,
          "review",
        );
        const body = objectBody(await this.readJson(request));
        const changeSetId = stringField(body["changeSetId"], "changeSetId", {
          max: 200,
        });
        const text = stringField(body["body"], "body", { max: 10_000 });
        if (changeSetId === undefined || text === undefined || text.length === 0) {
          throw new HttpError(
            400,
            "invalid_request",
            "changeSetId and body are required",
          );
        }
        const changeSet = detail.changeSets.find(
          (entry) => entry.id === changeSetId,
        );
        if (changeSet === undefined) {
          throw new HttpError(404, "not_found", "Changeset was not found");
        }
        const filePath = stringField(body["filePath"], "filePath", {
          max: 1_000,
          optional: true,
        });
        if (
          filePath !== undefined &&
          !changeSet.patches.some((patch) => patch.path === filePath)
        ) {
          throw new HttpError(
            400,
            "invalid_request",
            "filePath is not part of this changeset",
          );
        }
        const comment = await this.options.store.addChangesetComment({
          runId,
          changeSetId,
          taskId: changeSet.taskId,
          authorId: principal.user.id,
          body: text,
          ...(filePath === undefined ? {} : { filePath }),
        });
        this.sendJson(response, 201, { comment });
        return;
      }
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }

    const resolveCommentMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/comments/([^/]+)/resolve$`, "u"),
    );
    if (resolveCommentMatch !== undefined && method === "POST") {
      const commentId = resolveCommentMatch[0] ?? "";
      const comment = await this.options.store.getChangesetComment(commentId);
      if (comment === undefined) {
        throw new HttpError(404, "not_found", "Comment was not found");
      }
      const detail = await this.options.store.getRun(comment.runId);
      if (detail?.run.projectId === undefined) {
        throw new HttpError(404, "not_found", "Comment was not found");
      }
      await authorizeProject(
        this.options.store,
        principal,
        detail.run.projectId,
        "review",
      );
      this.sendJson(response, 200, {
        comment: await this.options.store.resolveChangesetComment(
          commentId,
          principal.user.id,
          new Date().toISOString(),
        ),
      });
      return;
    }

    const versionsMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/versions$`,
        "u",
      ),
    );
    if (versionsMatch !== undefined && method === "GET") {
      const [projectId = "", repositoryId = ""] = versionsMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const operation = this.options.operations.repositoryVersions;
      if (operation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not expose canonical history",
        );
      }
      const limit = Math.min(
        200,
        Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10)),
      );
      this.sendJson(response, 200, {
        versions: await operation({ projectId, repositoryId, limit }),
      });
      return;
    }

    const rollbackMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/rollback$`,
        "u",
      ),
    );
    if (rollbackMatch !== undefined && method === "POST") {
      const [projectId = "", repositoryId = ""] = rollbackMatch;
      // Reverting canonical wholesale is a project-management act, not
      // ordinary task work, so it needs more than the run_task a developer
      // carries.
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "manage_project",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const operation = this.options.operations.rollbackRepository;
      if (operation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not support rollback",
        );
      }
      const body = objectBody(await this.readJson(request));
      const targetRevision = stringField(
        body["targetRevision"],
        "targetRevision",
        { max: 200 },
      );
      if (targetRevision === undefined || targetRevision.length === 0) {
        throw new HttpError(
          400,
          "invalid_request",
          "targetRevision is required",
        );
      }
      const reason = stringField(body["reason"], "reason", {
        max: 2_000,
        optional: true,
      });
      const result = await operation({
        projectId,
        repositoryId,
        targetRevision,
        actorId: principal.user.id,
        ...(reason === undefined ? {} : { reason }),
      });
      // A rollback that was refused is a legitimate answer, not a transport
      // error, so the outcome travels in the body with a 200.
      this.sendJson(response, 200, { rollback: result });
      return;
    }

    // ---- Overlay workspaces (dashboard editor + sandboxed terminal) -------
    // One user's isolated worktree of one repository. The user id in scope
    // is always the authenticated principal's, so no request can address
    // another user's overlay. Editing requires submit_task (the same right
    // needed to put work into the queue); running terminal commands requires
    // run_task. Canonical is untouched by everything here except `submit`,
    // which goes through the ordinary integration pipeline.
    // Matched in two steps because matchPath decodes every group and an
    // absent optional group must stay absent rather than become "undefined".
    const workspaceBaseMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/workspace$`,
        "u",
      ),
    );
    const workspaceActionMatch =
      workspaceBaseMatch === undefined
        ? matchPath(
            path,
            new RegExp(
              `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/workspace` +
                `/(files|file|reset|exec|submit)$`,
              "u",
            ),
          )
        : undefined;
    const workspaceMatch = workspaceBaseMatch ?? workspaceActionMatch;
    if (workspaceMatch !== undefined) {
      const [projectId = "", repositoryId = ""] = workspaceMatch;
      const action = workspaceActionMatch?.[2];
      const workspaceOperations = this.options.operations.workspace;
      if (workspaceOperations === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not support overlay workspaces",
        );
      }
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        action === "exec" ? "run_task" : "submit_task",
      );
      const scope = {
        projectId,
        repositoryId,
        userId: principal.user.id,
      };
      // Overlay implementations throw errors carrying an HTTP status and
      // code; anything else stays an internal error.
      const perform = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          const status = (error as { status?: unknown }).status;
          const code = (error as { code?: unknown }).code;
          if (
            error instanceof Error &&
            typeof status === "number" &&
            typeof code === "string"
          ) {
            throw new HttpError(status, code, error.message);
          }
          throw error;
        }
      };

      if (action === undefined) {
        if (method === "GET") {
          this.sendJson(response, 200, {
            workspace: await perform(() => workspaceOperations.status(scope)),
          });
          return;
        }
        if (method === "POST") {
          this.sendJson(response, 200, {
            workspace: await perform(() => workspaceOperations.open(scope)),
          });
          return;
        }
        if (method === "DELETE") {
          await perform(() => workspaceOperations.discard(scope));
          this.sendJson(response, 200, { discarded: true });
          return;
        }
      }
      if (action === "reset" && method === "POST") {
        this.sendJson(response, 200, {
          workspace: await perform(() => workspaceOperations.reset(scope)),
        });
        return;
      }
      if (action === "files" && method === "GET") {
        this.sendJson(response, 200, {
          files: await perform(() => workspaceOperations.listFiles(scope)),
        });
        return;
      }
      if (action === "file" && method === "GET") {
        const filePath = stringField(
          url.searchParams.get("path") ?? undefined,
          "path",
          { max: 1_000 },
        );
        this.sendJson(response, 200, {
          file: await perform(() =>
            workspaceOperations.readFile({ ...scope, path: filePath ?? "" }),
          ),
        });
        return;
      }
      if (action === "file" && method === "POST") {
        const body = objectBody(await this.readJson(request));
        const filePath = stringField(body["path"], "path", { max: 1_000 });
        const content = body["content"];
        if (typeof content !== "string") {
          throw new HttpError(
            400,
            "invalid_request",
            "content must be a string",
          );
        }
        await perform(() =>
          workspaceOperations.writeFile({
            ...scope,
            path: filePath ?? "",
            content,
          }),
        );
        this.sendJson(response, 200, { saved: true });
        return;
      }
      if (action === "exec" && method === "POST") {
        const body = objectBody(await this.readJson(request));
        const command =
          stringField(body["command"], "command", { max: 4_000 }) ?? "";
        this.sendJson(response, 200, {
          result: await perform(() =>
            workspaceOperations.exec({ ...scope, command }),
          ),
        });
        return;
      }
      if (action === "submit" && method === "POST") {
        const body = objectBody(await this.readJson(request));
        const objective =
          stringField(body["objective"], "objective", {
            max: 2_000,
            optional: true,
          }) ?? "";
        this.sendJson(response, 200, {
          result: await perform(() =>
            workspaceOperations.submit({ ...scope, objective }),
          ),
        });
        return;
      }
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }

    // ---- Repository group channel ------------------------------------------
    // One shared room per repository, with every human and agent working it
    // as a participant — the server side of what `apps/web/public/data.js`
    // produced entirely in browser state before this existed. `view` is the
    // permission for every route here, read and write alike: being able to
    // see a repository is being in the room, the same way a Slack channel
    // does not gate typing behind a stricter right than reading.
    //
    // Posting as an agent or the coordinator is deliberately not exposed yet.
    // The store methods accept a `kind` and an arbitrary `authorId` so a
    // future agent-runtime writer can use them directly, but this HTTP
    // surface only ever writes `kind: "user"` with the caller's own id, so a
    // signed-in person can never post a message that impersonates someone
    // else's agent.
    const channelMessagesMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/messages$`,
        "u",
      ),
    );
    const channelTypingMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/typing$`,
        "u",
      ),
    );
    if (channelTypingMatch !== undefined) {
      const [projectId = "", repositoryId = ""] = channelTypingMatch;
      if (method !== "POST") {
        throw new HttpError(405, "method_not_allowed", "Unsupported method");
      }
      // Gated on the same right as reading the channel: knowing somebody is
      // typing tells you nothing you could not learn a second later by
      // reading what they typed.
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      const body = objectBody(await this.readJson(request));
      const threadId = stringField(body["threadId"], "threadId", {
        max: 200,
        optional: true,
      });
      // Straight to the open sockets. Nothing is stored: see
      // `broadcastTransient` for why this must not reach the audit chain.
      this.webSockets.broadcastTransient(
        projectId,
        {
          type: "channel-typing",
          projectId,
          repositoryId,
          ...(threadId === undefined ? {} : { threadId }),
          userId: principal.user.id,
          userName: principal.user.displayName,
          occurredAt: new Date().toISOString(),
        },
        principal.user.id,
      );
      this.sendJson(response, 202, { accepted: true });
      return;
    }

    if (channelMessagesMatch !== undefined) {
      const [projectId = "", repositoryId = ""] = channelMessagesMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      if (method === "GET") {
        const limit = Math.min(
          200,
          Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10)),
        );
        const before = url.searchParams.get("before") ?? undefined;
        const [messages, agentOverrides, readAt] = await Promise.all([
          this.options.store.listChannelMessages(repositoryId, principal.user.id, {
            limit,
            ...(before === undefined ? {} : { before }),
          }),
          this.options.store.listChannelAgentOverrides(repositoryId),
          this.options.store.getChannelReadCursor(repositoryId, principal.user.id),
        ]);
        this.sendJson(response, 200, { messages, agentOverrides, readAt });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const content = stringField(body["content"], "content", { max: 10_000 }) ?? "";
        const message = await this.options.store.appendChannelMessage({
          repositoryId,
          projectId,
          kind: "user",
          authorId: principal.user.id,
          content,
        });
        await this.options.store.appendAudit(undefined, {
          type: "channel_message_posted",
          data: { projectId, repositoryId, messageId: message.id },
        });
        // Best-effort and after the user's own message is durably posted: a
        // mention that fails to dispatch must not un-send what they typed.
        // Errors from an individual mention are already turned into a system
        // message inside `dispatchChannelMentions`; nothing should escape it,
        // but a broad catch here keeps a bug in that path from 500ing what is
        // otherwise a successful post.
        try {
          await this.dispatchChannelMentions({
            projectId,
            repositoryId,
            content,
            senderId: principal.user.id,
          });
        } catch (error) {
          // Still swallowed for the response — a mention that fails to
          // dispatch must not un-send what the user typed — but no longer
          // silent. A bare catch here meant every failure in the dispatch
          // path presented as "nothing happened", which is the hardest
          // possible symptom to diagnose and the one this feature actually
          // shipped with.
          process.stderr.write(
            `[channel] dispatch failed for ${repositoryId}: ${
              error instanceof Error ? (error.stack ?? error.message) : String(error)
            }\n`,
          );
        }
        this.sendJson(response, 201, { message });
        return;
      }
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }

    const channelReplyMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/messages/([^/]+)/replies$`,
        "u",
      ),
    );
    if (channelReplyMatch !== undefined && method === "POST") {
      const [projectId = "", repositoryId = "", messageId = ""] = channelReplyMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const body = objectBody(await this.readJson(request));
      const content = stringField(body["content"], "content", { max: 10_000 }) ?? "";
      let reply;
      try {
        reply = await this.options.store.addChannelReply({
          repositoryId,
          messageId,
          kind: "user",
          authorId: principal.user.id,
          content,
        });
      } catch (error) {
        throw new HttpError(
          404,
          "not_found",
          error instanceof Error ? error.message : "Channel message was not found",
        );
      }
      await this.options.store.appendAudit(undefined, {
        type: "channel_message_replied",
        data: { projectId, repositoryId, messageId, replyId: reply.id },
      });
      // Answered after the reply is stored, never before it is acknowledged:
      // the person typing should see their own message land at once, and the
      // agent's answer arrives on the event stream like any other reply.
      void this.answerThreadReply({
        projectId,
        repositoryId,
        messageId,
        viewerId: principal.user.id,
        question: content,
      }).catch((error: unknown) => {
        process.stderr.write(
          `[channel] thread reply answer failed for ${messageId}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
      this.sendJson(response, 201, { reply });
      return;
    }

    const channelReactionMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/messages/([^/]+)/reactions$`,
        "u",
      ),
    );
    if (channelReactionMatch !== undefined && method === "POST") {
      const [projectId = "", repositoryId = "", messageId = ""] = channelReactionMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const body = objectBody(await this.readJson(request));
      const emoji =
        stringField(body["emoji"], "emoji", { max: 32, optional: true }) ?? "👍";
      let message;
      try {
        message = await this.options.store.toggleChannelReaction(
          repositoryId,
          messageId,
          principal.user.id,
          emoji,
        );
      } catch (error) {
        throw new HttpError(
          404,
          "not_found",
          error instanceof Error ? error.message : "Channel message was not found",
        );
      }
      await this.options.store.appendAudit(undefined, {
        type: "channel_reaction_toggled",
        data: { projectId, repositoryId, messageId, emoji, userId: principal.user.id },
      });
      this.sendJson(response, 200, { message });
      return;
    }

    const channelReadMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/read$`,
        "u",
      ),
    );
    if (channelReadMatch !== undefined && method === "POST") {
      const [projectId = "", repositoryId = ""] = channelReadMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const at = new Date().toISOString();
      await this.options.store.markChannelRead(repositoryId, principal.user.id, at);
      this.sendJson(response, 200, { readAt: at });
      return;
    }

    // The real channel roster: every user with access to this repository —
    // by organization role or by a per-repository grant, the same two paths
    // `authorizeRepository` itself accepts, so nobody appears here who could
    // not also read the messages above — and the vendor agents each of them
    // has actually connected. This replaces the client-side `TEAMMATE_NAMES`
    // placeholder `data.js` used to invent so the roster was never empty.
    //
    // Privacy: this discloses to every repository collaborator which vendors
    // their teammates have connected. That is new — `publicUser` below shows
    // a member's name and chosen agent colour to the rest of their
    // organization, but nothing today already surfaces *which providers*
    // someone has connected. It is treated as acceptable here because (a) the
    // audience is exactly the set of people who can already see this
    // repository's shared activity, not the whole organization, (b) the
    // disclosure is bounded to vendor name + whose it is, never the secret,
    // the credential's hint, its kind, or usage/spend, and (c) a shared
    // channel roster is meaningless without it — "who's actually in this
    // room" is the entire point. The credential's own free-text label is
    // deliberately left out even though `UserCredentialSummary` carries one:
    // that string is something a user wrote for themselves, not a fact about
    // who they are, and this route only asks `connectionsFor` for the vendor.
    const channelAgentsRosterMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/agents$`,
        "u",
      ),
    );
    if (channelAgentsRosterMatch !== undefined && method === "GET") {
      const [projectId = "", repositoryId = ""] = channelAgentsRosterMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      // Same two sources `authorizeProject` reads to decide who may pass —
      // an organization role reaches every repository, a grant reaches only
      // this one — deduplicated, since somebody can hold both. Factored into
      // `channelAgentConnections` because @mention dispatch on the message
      // route below needs the identical set.
      const connections = await this.channelAgentConnections(
        projectId,
        repositoryId,
      );
      const agents = connections.map((connection) => ({
        userId: connection.userId,
        // The display name only — never the email `publicUser` would also
        // include, since a channel roster needs a name to put next to the
        // agent, not a contact address for the person behind it.
        userName: connection.userName,
        provider: connection.provider,
        // Whether anyone besides its owner may @mention it into real work —
        // see `CredentialVisibility`. Metadata, not a secret; safe for every
        // repository collaborator to see, same as the vendor name itself.
        visibility: connection.visibility,
        connected: true as const,
      }));
      this.sendJson(response, 200, { agents });
      return;
    }

    // Per-(repository, agent) presentation: a display name and/or a
    // model/effort choice that is free to disagree with the agent's
    // account-wide connection. See `renameChannelAgent` in data.js.
    const channelAgentMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/agents/([^/]+)$`,
        "u",
      ),
    );
    if (channelAgentMatch !== undefined && method === "POST") {
      const [projectId = "", repositoryId = "", agentId = ""] = channelAgentMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const body = objectBody(await this.readJson(request));
      const name = stringField(body["name"], "name", { max: 120, optional: true });
      // `min: 0`, matching model/effort below: an empty string clears the
      // role back to the vendor-wide default rather than being rejected as
      // too short, the same way clearing the model dropdown does.
      const role = stringField(body["role"], "role", {
        max: 120,
        min: 0,
        optional: true,
      });
      const model = stringField(body["model"], "model", {
        max: 200,
        min: 0,
        optional: true,
      });
      const effort = stringField(body["effort"], "effort", {
        max: 40,
        min: 0,
        optional: true,
      });
      if (
        name === undefined &&
        role === undefined &&
        model === undefined &&
        effort === undefined
      ) {
        throw new HttpError(
          400,
          "invalid_request",
          "At least one of name, role, model, or effort is required",
        );
      }
      const override = await this.options.store.setChannelAgentOverride(
        repositoryId,
        agentId,
        {
          ...(name === undefined ? {} : { name }),
          ...(role === undefined ? {} : { role }),
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
        },
      );
      await this.options.store.appendAudit(undefined, {
        type: "channel_agent_overridden",
        data: { projectId, repositoryId, agentId },
      });
      this.sendJson(response, 200, { override });
      return;
    }

    // Per-(repository, user, provider) opt-in membership: whether this
    // account's own connected agent is actually present in this channel's
    // roster, rather than every connected agent appearing in every
    // repository automatically. `agentId` here is always the bare provider
    // id (the same shape `myAgents()` in data.js mints for this account's
    // own agents, e.g. "anthropic") — a person only ever manages their own
    // membership through this route, never a teammate's, so there is no
    // `${userId}:${provider}` form to disambiguate here the way the rename
    // route above has to.
    //
    // `submit_task` rather than `view`: this changes who can be @mentioned
    // and dispatched to real work in a room shared with the rest of the
    // repository's collaborators, which is a stronger claim than reading or
    // renaming what is already there. The same reasoning `manage_project`
    // gets for `rollback` below — "this needs more than the permission that
    // merely lets you look" — applies here at the `submit_task` tier instead
    // of `manage_project`, because adding your own agent is closer to "I can
    // make it do work" than to "I can administer this repository".
    //
    // `DELETE` additionally accepts a `?userId=` query parameter naming
    // *whose* membership to remove — moderation, not self-service, so it
    // requires `manage_project` on top of the `submit_task` every caller
    // already needs to reach this route at all. The self-service path (no
    // `userId`, or one's own) is unaffected and still needs only
    // `submit_task`, matching `agent.mine` in `rosterRow` (screen-chats.js).
    // `POST` never accepts it: adding an agent to the channel is something
    // only its own owner can do for it, moderator or not.
    const channelAgentMembershipMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/agents/([^/]+)/membership$`,
        "u",
      ),
    );
    if (
      channelAgentMembershipMatch !== undefined &&
      (method === "POST" || method === "DELETE")
    ) {
      const [projectId = "", repositoryId = "", agentId = ""] =
        channelAgentMembershipMatch;
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "submit_task",
      );
      if (
        !(await this.options.store.projectHasRepository(projectId, repositoryId))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      const isMember = method === "POST";
      let targetUserId = principal.user.id;
      if (!isMember) {
        const requestedUserId = url.searchParams.get("userId")?.trim();
        if (
          requestedUserId !== undefined &&
          requestedUserId.length > 0 &&
          requestedUserId !== principal.user.id
        ) {
          await authorizeRepository(
            this.options.store,
            principal,
            projectId,
            repositoryId,
            "manage_project",
          );
          targetUserId = requestedUserId;
        }
      }
      await this.options.store.setChannelAgentMember(
        repositoryId,
        targetUserId,
        agentId,
        isMember,
      );
      await this.options.store.appendAudit(undefined, {
        type: "channel_agent_membership_changed",
        data: {
          projectId,
          repositoryId,
          provider: agentId,
          isMember,
          userId: targetUserId,
          ...(targetUserId === principal.user.id
            ? {}
            : { actorId: principal.user.id }),
        },
      });
      this.sendJson(response, 200, { member: isMember });
      return;
    }

    // ---- Direct provider chat (dashboard panel) ---------------------------
    // Connections are per authenticated user; a user can only ever spend
    // their own key. No organization permission is involved because nothing
    // here touches projects, repositories, or canonical state.
    if (path.startsWith(`${API_PREFIX}/chat/`)) {
      const chatOperations = this.options.operations.chatProviders;
      if (chatOperations === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not support provider chat",
        );
      }
      const performChat = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          const status = (error as { status?: unknown }).status;
          const code = (error as { code?: unknown }).code;
          if (
            error instanceof Error &&
            typeof status === "number" &&
            typeof code === "string"
          ) {
            throw new HttpError(status, code, error.message);
          }
          throw error;
        }
      };
      const identity = {
        userId: principal.user.id,
        systemAdmin: principal.user.systemAdmin,
      };

      if (path === `${API_PREFIX}/chat/providers` && method === "GET") {
        this.sendJson(response, 200, {
          providers: await performChat(() => chatOperations.list(identity)),
        });
        return;
      }
      const chatProviderMatch = matchPath(
        path,
        new RegExp(
          `^${API_PREFIX}/chat/providers/(anthropic|openai|google)$`,
          "u",
        ),
      );
      const chatProviderActionMatch = matchPath(
        path,
        new RegExp(
          `^${API_PREFIX}/chat/providers/(anthropic|openai|google)` +
            `/(signin|options|settings|usage|credential|device-auth)$`,
          "u",
        ),
      );
      if (chatProviderActionMatch !== undefined) {
        const [provider = "", action = ""] = chatProviderActionMatch;
        if (action === "signin" && method === "POST") {
          this.sendJson(response, 200, {
            signIn: await performChat(() =>
              chatOperations.signIn({
                systemAdmin: identity.systemAdmin,
                provider,
              }),
            ),
          });
          return;
        }
        if (action === "credential" && method === "POST") {
          if (chatOperations.connectCredential === undefined) {
            throw new HttpError(
              501,
              "unsupported",
              "This deployment does not accept per-user provider credentials",
            );
          }
          const body = objectBody(await this.readJson(request));
          const kind = stringField(body["kind"], "kind", { max: 20 }) ?? "";
          if (!["oauth_token", "api_key", "session_file"].includes(kind)) {
            throw new HttpError(
              400,
              "invalid_request",
              "kind must be oauth_token, api_key or session_file",
            );
          }
          // The secret is read but never echoed: the response is the same
          // provider list every other action returns, so nothing that reaches
          // a log or a browser carries it.
          // A session file is a whole JSON document and runs well past the
          // limit that suits a pasted key, so the cap follows the kind.
          const secret =
            stringField(body["secret"], "secret", {
              max: kind === "session_file" ? 64_000 : 4096,
            }) ?? "";
          const label = stringField(body["label"], "label", {
            max: 80,
            optional: true,
          });
          // Absent means "personal" throughout the stack — see
          // `CredentialVisibility` in @coord/workspace-manager — so an old
          // client that never sends this field keeps the behavior it always
          // had.
          const visibilityField = stringField(body["visibility"], "visibility", {
            max: 20,
            optional: true,
          });
          if (
            visibilityField !== undefined &&
            !["personal", "org"].includes(visibilityField)
          ) {
            throw new HttpError(
              400,
              "invalid_request",
              "visibility must be personal or org",
            );
          }
          const visibility = visibilityField as "personal" | "org" | undefined;
          this.sendJson(response, 200, {
            providers: await performChat(() =>
              // Non-null assertion is unnecessary; the guard above narrowed it.
              (chatOperations.connectCredential as NonNullable<
                ChatProviderOperations["connectCredential"]
              >)({
                userId: identity.userId,
                systemAdmin: identity.systemAdmin,
                provider,
                kind,
                secret,
                ...(label === undefined ? {} : { label }),
                ...(visibility === undefined ? {} : { visibility }),
              }),
            ),
          });
          return;
        }
        if (action === "device-auth") {
          if (chatOperations.deviceAuth === undefined) {
            throw new HttpError(
              501,
              "unsupported",
              "This deployment does not support device authorization",
            );
          }
          const deviceAuth = chatOperations.deviceAuth;
          // The flow id travels in the query string rather than the path so
          // the whole family stays on one route shape. It is a random opaque
          // identifier and is scoped to the caller server-side regardless.
          // `searchParams.get` answers `null` for an absent parameter, and
          // `null` is not `undefined`, so it has to be normalised before
          // `stringField` will treat it as optional rather than as the wrong
          // type. Starting a flow legitimately names none, and without this
          // the start request is refused with "flow must be a string".
          const flowId =
            stringField(
              new URL(request.url ?? "", "http://localhost").searchParams.get(
                "flow",
              ) ?? undefined,
              "flow",
              { max: 64, optional: true },
            ) ?? "";
          // A POST naming no flow starts one; a POST naming a flow answers
          // it. Same route, and which it is is a property of the request
          // rather than something the caller has to select.
          if (method === "POST" && flowId.length === 0) {
            this.sendJson(response, 200, {
              deviceAuth: await performChat(() =>
                deviceAuth.start({ userId: identity.userId, provider }),
              ),
            });
            return;
          }
          if (flowId.length === 0) {
            throw new HttpError(400, "invalid_request", "flow is required");
          }
          if (method === "POST") {
            const submitCode = deviceAuth.submitCode;
            if (submitCode === undefined) {
              throw new HttpError(
                501,
                "unsupported",
                "This deployment cannot accept a sign-in code",
              );
            }
            const body = objectBody(await this.readJson(request));
            const code = stringField(body["code"], "code", { max: 512 }) ?? "";
            this.sendJson(response, 200, {
              deviceAuth: await performChat(() =>
                submitCode({ userId: identity.userId, flowId, code }),
              ),
            });
            return;
          }
          if (method === "GET") {
            this.sendJson(response, 200, {
              deviceAuth: await performChat(() =>
                deviceAuth.status({ userId: identity.userId, flowId }),
              ),
            });
            return;
          }
          if (method === "DELETE") {
            await performChat(() =>
              deviceAuth.cancel({ userId: identity.userId, flowId }),
            );
            this.sendJson(response, 200, { cancelled: true });
            return;
          }
        }
        if (action === "options" && method === "GET") {
          this.sendJson(response, 200, {
            options: await performChat(() =>
              chatOperations.options({ provider }),
            ),
          });
          return;
        }
        if (action === "usage" && method === "GET") {
          this.sendJson(response, 200, {
            usage: await performChat(() => chatOperations.usage({ provider })),
          });
          return;
        }
        if (action === "settings" && method === "POST") {
          const body = objectBody(await this.readJson(request));
          const model = stringField(body["model"], "model", {
            max: 120,
            optional: true,
          });
          const effort = stringField(body["effort"], "effort", {
            max: 20,
            optional: true,
          });
          // Only the two the credential store understands. A free string here
          // would reach the connection file and decide, wrongly, whose
          // credential a teammate's prompt spends.
          const visibility = stringField(body["visibility"], "visibility", {
            max: 10,
            optional: true,
          });
          if (
            visibility !== undefined &&
            visibility !== "personal" &&
            visibility !== "org"
          ) {
            throw new HttpError(
              400,
              "invalid_visibility",
              "Visibility must be personal or org",
            );
          }
          this.sendJson(response, 200, {
            providers: await performChat(() =>
              chatOperations.setSettings({
                userId: identity.userId,
                provider,
                ...(model === undefined ? {} : { model }),
                ...(effort === undefined ? {} : { effort }),
                ...(visibility === undefined ? {} : { visibility }),
              }),
            ),
          });
          return;
        }
        throw new HttpError(405, "method_not_allowed", "Unsupported method");
      }
      if (chatProviderMatch !== undefined) {
        const provider = chatProviderMatch[0] ?? "";
        if (method === "POST") {
          // Sign-in based connection: the body carries nothing sensitive.
          await this.readJson(request).catch(() => undefined);
          this.sendJson(response, 200, {
            providers: await performChat(() =>
              chatOperations.connect({ ...identity, provider }),
            ),
          });
          return;
        }
        if (method === "DELETE") {
          await performChat(() =>
            chatOperations.disconnect({ userId: identity.userId, provider }),
          );
          this.sendJson(response, 200, { disconnected: true });
          return;
        }
      }
      if (path === `${API_PREFIX}/chat/complete` && method === "POST") {
        const body = objectBody(await this.readJson(request));
        const provider = stringField(body["provider"], "provider", { max: 20 }) ?? "";
        if (!["anthropic", "openai", "google"].includes(provider)) {
          throw new HttpError(400, "invalid_request", "provider is unknown");
        }
        const cliSessionId = stringField(body["cliSessionId"], "cliSessionId", {
          max: 64,
          optional: true,
        });
        this.sendJson(response, 200, {
          reply: await performChat(() =>
            chatOperations.complete({
              ...identity,
              provider,
              messages: body["messages"],
              ...(cliSessionId === undefined ? {} : { cliSessionId }),
            }),
          ),
        });
        return;
      }
      if (path === `${API_PREFIX}/chat/stream` && method === "POST") {
        const streamOperation = chatOperations.completeStream;
        if (streamOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "Streaming chat is not configured on this deployment",
          );
        }
        const body = objectBody(await this.readJson(request));
        const provider =
          stringField(body["provider"], "provider", { max: 20 }) ?? "";
        if (!["anthropic", "openai", "google"].includes(provider)) {
          throw new HttpError(400, "invalid_request", "provider is unknown");
        }
        const cliSessionId = stringField(
          body["cliSessionId"],
          "cliSessionId",
          { max: 64, optional: true },
        );
        // Newline-delimited JSON: one event per line, flushed immediately so
        // the browser sees progress rather than a buffered reply.
        response.setHeader("Content-Type", "application/x-ndjson");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Accel-Buffering", "no");
        response.writeHead(200);
        const write = (event: unknown) => {
          if (!response.writableEnded) {
            response.write(`${JSON.stringify(event)}\n`);
          }
        };
        try {
          const reply = await performChat(() =>
            streamOperation(
              {
                ...identity,
                provider,
                messages: body["messages"],
                ...(cliSessionId === undefined ? {} : { cliSessionId }),
              },
              write,
            ),
          );
          write({ type: "done", reply });
        } catch (error) {
          const failure =
            error instanceof HttpError
              ? { code: error.code, message: error.message }
              : {
                  code: "chat_failed",
                  message:
                    error instanceof Error ? error.message : String(error),
                };
          write({ type: "error", ...failure });
        }
        response.end();
        return;
      }
      throw new HttpError(404, "not_found", "Route was not found");
    }

    const runsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/runs$`, "u"),
    );
    if (runsMatch !== undefined && method === "GET") {
      const projectId = runsMatch[0] ?? "";
      const authorized = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "view",
      );
      const limit = Math.min(
        500,
        Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10)),
      );
      this.sendJson(response, 200, {
        runs: narrowToRepositories(
          await this.options.store.listRuns(limit * 5),
          authorized.repositories,
        )
          .filter((run) => run.projectId === projectId)
          .slice(0, limit),
      });
      return;
    }

    const runDetailMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/runs/([^/]+)$`, "u"),
    );
    if (runDetailMatch !== undefined && method === "GET") {
      const runId = runDetailMatch[0] ?? "";
      const detail = await this.options.store.getRun(runId);
      if (detail === undefined || detail.run.projectId === undefined) {
        throw new HttpError(404, "not_found", "Run was not found");
      }
      await authorizeProject(
        this.options.store,
        principal,
        detail.run.projectId,
        "view",
      );
      this.sendJson(response, 200, { run: detail });
      return;
    }

    const approvalsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/approvals$`, "u"),
    );
    if (approvalsMatch !== undefined && method === "GET") {
      const projectId = approvalsMatch[0] ?? "";
      const authorized = await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "view",
      );
      const statusValue = url.searchParams.get("status") ?? undefined;
      const status =
        statusValue === undefined
          ? undefined
          : APPROVAL_STATUSES.find((entry) => entry === statusValue);
      if (statusValue !== undefined && status === undefined) {
        throw new HttpError(
          400,
          "invalid_status",
          `Approval status must be one of ${APPROVAL_STATUSES.join(", ")}`,
        );
      }
      this.sendJson(response, 200, {
        approvals: narrowToRepositories(
          await this.options.store.listApprovals({
            projectId,
            ...(status === undefined ? {} : { status }),
          }),
          authorized.repositories,
        ),
      });
      return;
    }

    const metricsMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/metrics$`, "u"),
    );
    if (metricsMatch !== undefined && method === "GET") {
      const projectId = metricsMatch[0] ?? "";
      await authorizeProject(this.options.store, principal, projectId, "view");
      const operation = this.options.operations.projectMetrics;
      if (operation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment does not expose coordination metrics",
        );
      }
      this.sendJson(response, 200, {
        metrics: await operation({ projectId }),
      });
      return;
    }

    const approvalMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/approvals/([^/]+)$`, "u"),
    );
    if (approvalMatch !== undefined) {
      const approvalId = approvalMatch[0] ?? "";
      const approval = await this.options.store.getApproval(approvalId);
      if (approval === undefined || approval.projectId === undefined) {
        throw new HttpError(404, "not_found", "Approval was not found");
      }
      await authorizeProject(
        this.options.store,
        principal,
        approval.projectId,
        method === "GET" ? "view" : "review",
      );
      if (method === "GET") {
        const detail = await this.options.store.getRun(approval.runId);
        const changeSet = detail?.changeSets.find(
          (entry) => entry.id === approval.changeSetId,
        );
        this.sendJson(response, 200, { approval, changeSet });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const status = stringField(body["status"], "status", { max: 20 });
        if (status !== "approved" && status !== "rejected") {
          throw new HttpError(
            400,
            "invalid_decision",
            "status must be approved or rejected",
          );
        }
        const comment =
          stringField(body["comment"], "comment", {
            max: 2_000,
            optional: true,
          }) ?? "";
        const decided = await this.options.store.decideApproval({
          approvalId,
          status,
          decidedBy: principal.user.id,
          comment,
          decidedAt: new Date().toISOString(),
        });
        await this.options.store.appendAudit(approval.runId, {
          type: "approval_decided",
          taskId: approval.taskId,
          data: {
            projectId: approval.projectId,
            approvalId,
            status,
            actorId: principal.user.id,
            comment,
          },
        });
        this.sendJson(response, 200, { approval: decided });
        return;
      }
    }

    const auditMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/projects/([^/]+)/audit$`, "u"),
    );
    if (auditMatch !== undefined && method === "GET") {
      const projectId = auditMatch[0] ?? "";
      await authorizeProject(
        this.options.store,
        principal,
        projectId,
        "view",
      );
      const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
      const runIds = new Set(
        (await this.options.store.listRuns(5_000))
          .filter((run) => run.projectId === projectId)
          .map((run) => run.id),
      );
      const events = (
        await this.options.store.listAuditEvents({
          afterSequence: Number.isSafeInteger(after) && after >= 0 ? after : 0,
          limit: 5_000,
        })
      ).filter(
        (record) =>
          (record.runId !== undefined && runIds.has(record.runId)) ||
          record.event.data["projectId"] === projectId,
      );
      this.sendJson(response, 200, { events });
      return;
    }

    if (path.startsWith(`${API_PREFIX}/admin/`)) {
      assertTokenScope(principal, "manage_organization");
    }
    if (path === `${API_PREFIX}/admin/users`) {
      if (!principal.user.systemAdmin) {
        throw new HttpError(403, "forbidden", "System administrator required");
      }
      if (method === "GET") {
        this.sendJson(response, 200, {
          users: (await this.options.store.listUsers()).map(publicUser),
        });
        return;
      }
      if (method === "POST") {
        const body = objectBody(await this.readJson(request));
        const email = emailField(body["email"]) ?? "";
        if ((await this.options.store.getUserByEmail(email)) !== undefined) {
          throw new HttpError(
            409,
            "email_in_use",
            "User email is already in use",
          );
        }
        const user = await this.options.store.createUser({
          email,
          displayName:
            stringField(body["displayName"], "displayName", { max: 120 }) ?? "",
          passwordDigest: await hashPassword(
            stringField(body["password"], "password", { max: 256 }) ?? "",
          ),
          systemAdmin: booleanField(body["systemAdmin"], "systemAdmin") ?? false,
        });
        await this.options.store.appendAudit(undefined, {
          type: "user_changed",
          data: {
            userId: user.id,
            actorId: principal.user.id,
            action: "created",
          },
        });
        this.sendJson(response, 201, { user: publicUser(user) });
        return;
      }
    }

    const adminUserMatch = matchPath(
      path,
      new RegExp(`^${API_PREFIX}/admin/users/([^/]+)$`, "u"),
    );
    if (adminUserMatch !== undefined && method === "PATCH") {
      if (!principal.user.systemAdmin) {
        throw new HttpError(403, "forbidden", "System administrator required");
      }
      const body = objectBody(await this.readJson(request));
      const displayName = stringField(body["displayName"], "displayName", {
        max: 120,
        optional: true,
      });
      const password =
        stringField(body["password"], "password", {
          max: 256,
          optional: true,
        });
      const disabled = booleanField(body["disabled"], "disabled");
      const systemAdmin = booleanField(body["systemAdmin"], "systemAdmin");
      const userId = adminUserMatch[0] ?? "";
      if (userId === principal.user.id && disabled === true) {
        throw new HttpError(
          409,
          "self_lockout",
          "You cannot disable your own account",
        );
      }
      const current = await this.options.store.getUser(userId);
      if (current === undefined) {
        throw new HttpError(404, "not_found", "User was not found");
      }
      if (
        current.systemAdmin &&
        (systemAdmin === false || disabled === true) &&
        (await this.options.store.listUsers()).filter(
          (entry) => entry.systemAdmin && !entry.disabled,
        ).length <= 1
      ) {
        throw new HttpError(
          409,
          "last_system_admin",
          "The last active system administrator cannot be removed",
        );
      }
      const user = await this.options.store.updateUser(
        userId,
        {
          ...(displayName === undefined ? {} : { displayName }),
          ...(password === undefined
            ? {}
            : { passwordDigest: await hashPassword(password) }),
          ...(disabled === undefined ? {} : { disabled }),
          ...(systemAdmin === undefined ? {} : { systemAdmin }),
        },
      );
      if (disabled === true || password !== undefined) {
        await this.options.store.revokeUserSessions(user.id);
      }
      await this.options.store.appendAudit(undefined, {
        type: "user_changed",
        data: {
          userId: user.id,
          actorId: principal.user.id,
          action: "updated",
        },
      });
      this.sendJson(response, 200, { user: publicUser(user) });
      return;
    }

    if (method === "GET" && path === `${API_PREFIX}/admin/overview`) {
      if (!principal.user.systemAdmin) {
        throw new HttpError(403, "forbidden", "System administrator required");
      }
      const organizations = await this.options.store.listOrganizations();
      const projects = (
        await Promise.all(
          organizations.map(
            async (organization) =>
              await this.options.store.listProjects(organization.id),
          ),
        )
      ).flat();
      const tasks = await this.options.store.listSubmittedTasks();
      const approvals = await this.options.store.listApprovals();
      this.sendJson(response, 200, {
        counts: {
          users: await this.options.store.countUsers(),
          organizations: organizations.length,
          projects: projects.length,
          repositories: (await this.options.store.listRepositories()).length,
          tasks: tasks.length,
          pendingTasks: tasks.filter((task) => task.status === "submitted").length,
          pendingApprovals: approvals.filter(
            (approval) => approval.status === "pending",
          ).length,
          activeRuns: this.activeRuns.size,
          webSocketConnections: this.webSockets.connections,
        },
        recentRuns: await this.options.store.listRuns(20),
      });
      return;
    }

    throw new HttpError(404, "not_found", "Route was not found");
  }

  /**
   * Organizations the caller can reach at all.
   *
   * Membership is no longer the only route in: somebody invited to a single
   * repository holds a grant and no organization role, and listing only their
   * memberships would leave them signed in and staring at nothing. The
   * organizations behind their grants are added so the interface can find the
   * project the repository lives in.
   */
  private async reachableOrganizations(
    principal: AuthenticatedPrincipal,
  ): Promise<Organization[]> {
    const byMembership = await this.options.store.listOrganizations(
      principal.user.systemAdmin ? undefined : principal.user.id,
    );
    if (principal.user.systemAdmin) {
      return byMembership;
    }
    const grants = await this.options.store.listGrantsForUser(
      principal.user.id,
    );
    if (grants.length === 0) {
      return byMembership;
    }
    const granted = new Set(grants.map((grant) => grant.repositoryId));
    const seen = new Set(byMembership.map((entry) => entry.id));
    const found = [...byMembership];
    for (const organization of await this.options.store.listOrganizations()) {
      if (seen.has(organization.id)) {
        continue;
      }
      for (const project of await this.options.store.listProjects(
        organization.id,
      )) {
        const repositories = await this.options.store.listProjectRepositories(
          project.id,
        );
        if (repositories.some((entry) => granted.has(entry.id))) {
          found.push(organization);
          seen.add(organization.id);
          break;
        }
      }
    }
    return found;
  }

  /** Projects the caller can reach, by membership or by a repository grant. */
  private async reachableProjects(
    principal: AuthenticatedPrincipal,
    organizationId: string,
    hasOrganizationRole: boolean,
  ): Promise<ProjectRecord[]> {
    const projects = await this.options.store.listProjects(organizationId);
    if (hasOrganizationRole || principal.user.systemAdmin) {
      return projects;
    }
    const granted = new Set(
      (await this.options.store.listGrantsForUser(principal.user.id)).map(
        (grant) => grant.repositoryId,
      ),
    );
    const reachable: ProjectRecord[] = [];
    for (const project of projects) {
      const repositories = await this.options.store.listProjectRepositories(
        project.id,
      );
      if (repositories.some((entry) => granted.has(entry.id))) {
        reachable.push(project);
      }
    }
    return reachable;
  }

  private requirePrincipal(context: RequestContext): AuthenticatedPrincipal {
    if (context.principal === undefined) {
      throw new AuthenticationError("Sign in is required");
    }
    return context.principal;
  }

  /**
   * Resolves the organization whose fleet is being read, and proves the caller
   * may read it.
   *
   * The id is taken from the request and authorized, never inferred from the
   * caller's memberships. Inferring it would mean a request that named no
   * tenant still got answered with one, and the endpoint would have no single
   * value to filter the query by — which is exactly how a fleet listing ends
   * up merging tenants. Requiring it makes the boundary one explicit
   * `authorizeOrganization` call, which checks the token's organization
   * binding first, then membership, then scope.
   *
   * `view` is the permission because this is a read: every role in the
   * organization, down to `viewer`, can see the fleet it belongs to. Driving a
   * worker is a separate, stricter check at the lease endpoints.
   */
  private async authorizeFleet(
    principal: AuthenticatedPrincipal,
    url: URL,
  ): Promise<{ organizationId: string }> {
    const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
    if (organizationId.length === 0) {
      throw new HttpError(
        400,
        "invalid_request",
        "organizationId is required",
      );
    }
    await authorizeOrganization(
      this.options.store,
      principal,
      organizationId,
      "view",
    );
    return { organizationId };
  }

  /**
   * Authorizes a repository-scoped administrative action (deleting the
   * repository, changing who holds a repository-scoped grant on it) with a
   * second path in for the repository's creator, alongside the ordinary
   * role/grant permission check.
   *
   * The creator path is additive, never a substitute: an organization admin
   * who did not create a repository must not lose the ability to administer
   * it, which is why this attempts the real permission first and only
   * consults `createdBy` when that specifically fails on *role* (the
   * `"forbidden"` error code) rather than on reachability (`"not_found"`,
   * where creatorship would be a moot point) or on token scope
   * (`"token_scope_missing"`, a boundary the calling credential's own owner
   * chose and creatorship must not override).
   *
   * Returns the repository so callers do not have to fetch it twice.
   */
  private async authorizeRepositoryOwnerAction(
    principal: AuthenticatedPrincipal,
    projectId: string,
    repositoryId: string,
    permission: Permission,
  ): Promise<StoredRepository> {
    try {
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        permission,
      );
    } catch (error) {
      if (!(error instanceof AuthenticationError) || error.code !== "forbidden") {
        throw error;
      }
      // Reaches this repository (view-level access, at least) but not with
      // enough role — the creator gets a second path in here, never for
      // someone who cannot reach the repository at all.
      await authorizeRepository(
        this.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      const isLinked = await this.options.store.projectHasRepository(
        projectId,
        repositoryId,
      );
      const repository = isLinked
        ? await this.options.store.getRepository(repositoryId)
        : undefined;
      if (
        repository === undefined ||
        repository.createdBy === undefined ||
        repository.createdBy !== principal.user.id
      ) {
        throw new HttpError(
          403,
          "forbidden",
          "You do not have permission to perform this action",
        );
      }
      assertTokenScope(principal, permission);
      return repository;
    }
    if (
      !(await this.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const repository = await this.options.store.getRepository(repositoryId);
    if (repository === undefined) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    return repository;
  }

  /**
   * One organization's workers and the leases they are currently holding.
   *
   * Shared by the fleet listing and the running-agents count so the two cannot
   * disagree about what belongs to a tenant — a count computed one way and a
   * list computed another is how a boundary quietly develops a hole.
   *
   * Leases are filtered by their project as well as by their worker. Leasing
   * already refuses a worker whose organization does not match the project's,
   * so this is redundant for anything issued since; it is here for leases
   * predating that rule, which would otherwise surface another tenant's task
   * and repository ids. A lease with no project cannot be attributed to one
   * and is dropped rather than assumed to be local.
   *
   * Callers must have authorized `organizationId` first — this method filters,
   * it does not decide who may ask.
   */
  private async organizationFleet(organizationId: string): Promise<{
    workers: WorkerRecord[];
    active: WorkLease[];
  }> {
    const workers = await this.options.store.listWorkers({ organizationId });
    const owned = new Set(workers.map((worker) => worker.id));
    const visibleProjects = new Set(
      (await this.options.store.listProjects(organizationId)).map(
        (project) => project.id,
      ),
    );
    const active = (
      await this.options.store.listWorkLeases({ status: "active" })
    ).filter(
      (lease) =>
        owned.has(lease.workerId) &&
        lease.projectId !== undefined &&
        visibleProjects.has(lease.projectId),
    );
    return { workers, active };
  }

  /**
   * Every (user, connected agent) pair that is both reachable in one
   * repository's channel — the same access `authorizeRepository` itself
   * accepts, deduplicated — and an opted-in member of it. Shared by the
   * `GET .../channel/agents` roster route and by @mention dispatch below,
   * which needs the identical set to decide who a mention could possibly
   * resolve to; membership therefore also governs who can be @mentioned,
   * not just who is listed.
   *
   * Membership used to be implicit: every agent any collaborator had
   * connected showed up in every repository's channel automatically. That
   * was a discoverability nicety but also meant a room-mate's *unrelated*
   * agent — connected for a different repository, or just to try it out —
   * appeared @mentionable everywhere it had access, whether or not anyone
   * had ever used it there. `channel_agent_members` makes presence explicit.
   *
   * Grandfathering: flipping straight to opt-in would make every
   * already-active agent vanish from every channel it was already working
   * in, mid-session, with no user action taken. `hasBackfilledChannelMembership`
   * /`markChannelMembershipBackfilled` exist to prevent exactly that. The
   * *first* time this method runs for a given repository, it treats whatever
   * is reachable at that moment as "already there" and writes membership rows
   * for it, once; every call after that (for that repository) is a plain
   * filter with no writes.
   *
   * This is a per-repository lazy backfill rather than a single eager
   * deploy-time migration, chosen because the data being grandfathered
   * (`chatOperations.connectionsFor`) lives outside this store — in the
   * credential service — so there is no single SQL migration that could
   * compute it, and because a lazy per-repository trigger needs no
   * coordination with server startup or with which repositories exist yet.
   * The accepted tradeoff: if a user connects a *new* agent after this
   * feature ships but before a given repository's channel has been read
   * even once since, that agent is reachable and will be swept into that
   * repository's one-time backfill along with everything genuinely
   * pre-existing — indistinguishable, from here, from something that was
   * "already active". Once a repository's backfill has run, this tradeoff
   * closes for it permanently: every subsequent connection anywhere, and
   * every subsequently created repository, starts with zero members and
   * requires an explicit add.
   */
  /**
   * A repository created here has already chosen its members: none.
   *
   * The grandfather backfill in `channelAgentConnections` is keyed per
   * repository and runs on that repository's first channel read. A repository
   * that has just been created has never been read either, so without this it
   * takes the backfill path too and admits every agent anybody happened to
   * have connected — the opposite of opt-in, on the one channel where there is
   * no pre-existing roster to protect. Marking it at creation says what is
   * true: nothing predates this repository, so there is nothing to
   * grandfather, and its roster is empty until somebody chooses.
   */
  private async markChannelMembershipChosen(repositoryId: string): Promise<void> {
    await this.options.store
      .markChannelMembershipBackfilled(repositoryId)
      .catch(() => undefined);
  }

  private async channelAgentConnections(
    projectId: string,
    repositoryId: string,
  ): Promise<
    Array<{
      userId: string;
      userName: string;
      provider: string;
      visibility: "personal" | "org";
    }>
  > {
    const project = await this.options.store.getProject(projectId);
    const [memberships, grants] = await Promise.all([
      project === undefined
        ? []
        : this.options.store.listMemberships(project.organizationId),
      this.options.store.listRepositoryGrants(repositoryId),
    ]);
    const userIds = [
      ...new Set([
        ...memberships.map((membership) => membership.userId),
        ...grants.map((grant) => grant.userId),
      ]),
    ];
    const users = await Promise.all(
      userIds.map((userId) => this.options.store.getUser(userId)),
    );
    const chatOperations = this.options.operations.chatProviders;
    const connections =
      chatOperations?.connectionsFor === undefined
        ? {}
        : await chatOperations.connectionsFor(userIds);
    const reachable = userIds.flatMap((userId, index) => {
      const user = users[index];
      if (user === undefined) {
        return [];
      }
      return (connections[userId] ?? []).map((connection) => ({
        userId,
        userName: user.displayName,
        provider: connection.provider,
        visibility: connection.visibility ?? "personal",
      }));
    });
    if (!(await this.options.store.hasBackfilledChannelMembership(repositoryId))) {
      await Promise.all(
        reachable.map((connection) =>
          this.options.store.setChannelAgentMember(
            repositoryId,
            connection.userId,
            connection.provider,
            true,
          ),
        ),
      );
      await this.options.store.markChannelMembershipBackfilled(repositoryId);
      // Freshly backfilled: everything reachable just became a member, so
      // there is nothing further to filter this call.
      return reachable;
    }
    const members = await this.options.store.listChannelAgentMembers(repositoryId);
    const memberKeys = new Set(
      members.map((member) => `${member.userId}\0${member.provider}`),
    );
    return reachable.filter((connection) =>
      memberKeys.has(`${connection.userId}\0${connection.provider}`),
    );
  }

  /**
   * Which agents an @mention in this channel could name, in the exact text a
   * mention resolves to.
   *
   * The frontend inserts `@${name} ` where `name` is what `channelAgentsFor`
   * in `data.js` computes: `"${AGENT_LABEL[provider]} (${firstWord(
   * displayName)})"`, with any channel rename (`setChannelAgentOverride`)
   * layered on top — see `withOverride` in `data.js`. This reconstructs the
   * same string for every connected agent in the roster so a posted message
   * can be matched against it server-side. Longest name first, so "Claude
   * (Bob)" is tried before a coincidentally-shorter "Claude (Bo)" would
   * falsely match as a prefix.
   */
  private async resolveChannelMentionCandidates(
    projectId: string,
    repositoryId: string,
  ): Promise<ChannelMentionCandidate[]> {
    const [connections, overrides] = await Promise.all([
      this.channelAgentConnections(projectId, repositoryId),
      this.options.store.listChannelAgentOverrides(repositoryId),
    ]);
    const candidates = connections.flatMap((connection) => {
      const vendor = PROVIDER_TO_VENDOR[connection.provider];
      if (vendor === undefined) {
        // A provider this deployment reports but does not run tasks for
        // (there is no such vendor today, but a future provider addition
        // should not crash the roster).
        return [];
      }
      const label = AGENT_LABEL[connection.provider] ?? connection.provider;
      const defaultName = `${label} (${firstWord(connection.userName)})`;
      // Two possible override keys, matching the two shapes `data.js` mints
      // an `agent.id` with: the bare provider id when the credential's own
      // owner is renaming their own agent (`myAgents`'s `id: provider.id`),
      // or `${userId}:${provider}` when anyone else is renaming a teammate's
      // (`channelAgentsFor`'s `others`). Both are checked because either can
      // be the one actually stored, depending on who renamed it.
      const name =
        overrides[`${connection.userId}:${connection.provider}`]?.name ??
        overrides[connection.provider]?.name ??
        defaultName;
      // Same two-key lookup as `name` just above. No vendor-wide default: an
      // agent is unlabeled ("") until this channel actually names its role,
      // mirroring `withOverride` in data.js.
      const role =
        overrides[`${connection.userId}:${connection.provider}`]?.role ??
        overrides[connection.provider]?.role ??
        "";
      return [{ ...connection, vendor, name, role }];
    });
    return candidates.sort((a, b) => b.name.length - a.name.length);
  }

  /**
   * Turns a channel @mention into a real task.
   *
   * Real dispatch is new — posting a message used to be inert chat text no
   * matter what it said, by design (see the comment above the
   * `channel/messages` route). This is also the server-side enforcement point
   * for `CredentialVisibility`: a "personal" agent mentioned by anyone but its
   * owner must not run anything. That refusal is reported with a system
   * message rather than dropped silently, so it reads as a boundary rather
   * than a bug.
   *
   * Scope note, decided here rather than left open: this submits the task and
   * confirms it in the channel, but does not stream the task's own progress
   * or completion back as further channel messages. Doing that is a second,
   * separable feature — a listener on the coordinator's own task lifecycle
   * (claimed/integrated/failed), posting as the agent via the `kind: "agent"`
   * path the store already supports (see the same comment above
   * `channel/messages`) — and not something this request can do inline: a
   * submitted task sits `submitted` until something later calls
   * `runRepository`/`runPendingTasks` for the repository, at a time this
   * handler has no visibility into. The one-on-one panel's streaming
   * (`chat.js`'s `sendChat`) does not need that plumbing because it drives a
   * synchronous CLI call within the same request; a channel task is queued
   * work with no such request to hang a stream off of.
   */
  private async dispatchChannelMentions(input: {
    projectId: string;
    repositoryId: string;
    content: string;
    senderId: string;
  }): Promise<void> {
    const { projectId, repositoryId, content, senderId } = input;
    const candidates = await this.resolveChannelMentionCandidates(
      projectId,
      repositoryId,
    );
    if (content.includes("@")) {
      // An explicit @mention — resolved to a real candidate or not — is the
      // sender declaring who they mean. Auto-claim (below) must never also
      // run: it is strictly the no-mention path (see `maybeAutoClaimTask`'s
      // doc comment). Treating *any* "@" this way, even one that resolves to
      // nobody (a stray email address, a typo'd name), is the conservative
      // reading: it costs nothing to stay silent and let the sender correct
      // themselves, and it keeps this gate as simple as the mention
      // resolution immediately below it.
      const mentioned = candidates.filter((candidate) =>
        content.includes(`@${candidate.name}`),
      );
      for (const candidate of mentioned) {
        await this.dispatchOneMention({
          projectId,
          repositoryId,
          content,
          senderId,
          candidate,
        });
      }
      return;
    }
    await this.maybeAutoClaimTask({
      projectId,
      repositoryId,
      content,
      senderId,
      candidates,
    });
  }

  private async dispatchOneMention(input: {
    projectId: string;
    repositoryId: string;
    content: string;
    senderId: string;
    candidate: ChannelMentionCandidate;
    /**
     * Distinguishes an explicit @mention from an auto-claim in the audit
     * trail. Both paths submit through this exact method and the exact same
     * `submitTask` call below — see `maybeAutoClaimTask` — differing only in
     * how the candidate was chosen and how the claim is announced.
     */
    trigger?: "mention" | "auto_claim";
    /**
     * Overrides the default "Submitted a task…" confirmation. Auto-claim
     * uses this to explain *why* it picked this agent, since nobody asked
     * for it by name.
     */
    claimMessage?: string;
  }): Promise<void> {
    const {
      projectId,
      repositoryId,
      content,
      senderId,
      candidate,
      trigger = "mention",
      claimMessage,
    } = input;
    if (candidate.visibility === "personal" && candidate.userId !== senderId) {
      // Auto-claim never reaches this branch in practice — it filters a
      // stranger's undispatchable candidates out before scoring, below —
      // but the guard stays here too rather than being trusted solely to
      // the caller, so a personal agent is never one refactor away from
      // being spendable by a stranger.
      await this.postChannelSystemMessage(
        projectId,
        repositoryId,
        `@${candidate.name} is personal to ${candidate.userName} — only ` +
          `they can task it here. Ask ${candidate.userName} to switch it to ` +
          `org-wide, or mention an org-wide agent instead.`,
      );
      return;
    }
    // A question is not a task. "What are you working on?" was being turned
    // into a submitted task named after the question, with a thread and a
    // progress indicator attached to work that would never exist — the agent
    // appeared to type forever because there was nothing to finish. Anything
    // that does not read as a request for work is simply answered, in the
    // channel, like a message from a colleague.
    if (readsAsQuestion(content)) {
      await this.answerInChannel(candidate, content, projectId, repositoryId);
      return;
    }

    // The agent answers first, in its own voice, before anything slow runs.
    // Submitting a task reaches the coordinator and can take a moment; a
    // person who has just asked for something needs to know it was heard
    // inside a couple of seconds, not once the work has been queued. This
    // message is also the thread everything about the task hangs off, so the
    // channel keeps one line per request rather than a running commentary.
    const acknowledgement = await this.appendChannelEntry({
      projectId,
      repositoryId,
      kind: "agent",
      authorId: `${candidate.userId}:${candidate.provider}`,
      content: await this.composeAcknowledgement(candidate, content, claimMessage),
    });

    try {
      const task = await this.options.operations.submitTask({
        projectId,
        repositoryId,
        // The mention routed this; it is not part of what was asked for.
        // `candidate.role` — the effective per-channel role label
        // (`resolveChannelMentionCandidates`, falling back to the
        // vendor-wide default) — goes in ahead of it, the same way
        // `candidate.visibility` and `candidate.userId` above already flow
        // from this per-candidate record into how the task is submitted
        // rather than through some separate side channel. This is the one
        // place in the codebase today where a (repository, agent) pair and
        // its objective are both in hand at once, so it is the one place
        // that can honestly say what the agent's role here is; a task
        // submitted outside a channel has no such pair to resolve.
        objective: withRoleContext(candidate.role, withoutMentions(content) || content),
        vendor: candidate.vendor,
        // The mentioned (or auto-claiming) agent's owner, never the sender —
        // work someone else's agent takes must not spend the sender's own
        // account. This is exactly what `submittedBy`/
        // `openSubmitterCredentialHome` key credential selection on at run
        // time.
        actorId: candidate.userId,
      });
      await this.options.store.appendAudit(undefined, {
        type: "task_submitted",
        taskId: task.id,
        data: {
          projectId,
          repositoryId,
          actorId: candidate.userId,
          mentionedBy: senderId,
          trigger,
          objective: task.objective,
        },
      });
      // Inside the thread, not beside it: the channel already says who took
      // this, and the detail belongs where somebody following the work will
      // look for it.
      // The thread gets a name and the agent's own opening reasoning, both
      // from one call so the wait is paid once. A task id says nothing to the
      // person who asked; "Task: architecture for chess" does.
      const opening = await this.planOpening(candidate, task.objective);
      await this.appendChannelThreadReply({
        repositoryId,
        messageId: acknowledgement.id,
        authorId: `${candidate.userId}:${candidate.provider}`,
        content: `Task: ${opening.title}`,
        projectId,
      });
      for (const thought of opening.thoughts) {
        await this.appendChannelThreadReply({
          repositoryId,
          messageId: acknowledgement.id,
          authorId: `${candidate.userId}:${candidate.provider}`,
          content: thought,
          projectId,
        });
      }
      // Nothing runs a queued task on its own — it sits `submitted` until
      // somebody calls this. That is why a dispatched task produced no
      // events, no thinking, and an indicator that never stopped: the work
      // had been filed, not started. Kicked off without being awaited, so
      // the channel post does not wait on a whole run.
      void Promise.resolve(
        this.options.operations.runRepository?.({
          projectId,
          repositoryId,
          actorId: candidate.userId,
        }),
      ).catch((error: unknown) => {
        process.stderr.write(
          `[channel] run failed for ${repositoryId}: ${
            error instanceof Error ? error.message : String(error)
          }
`,
        );
      });
      // From here the thread narrates itself until the task ends.
      this.watchChannelTask({
        taskId: task.id,
        projectId,
        repositoryId,
        messageId: acknowledgement.id,
        authorId: `${candidate.userId}:${candidate.provider}`,
        ownerId: candidate.userId,
        provider: candidate.provider,
        // From zero: the task is new, so nothing already in the log carries
        // its id, and the store filters by it rather than this scanning.
        cursor: 0,
      });
    } catch (error) {
      await this.appendChannelThreadReply({
        repositoryId,
        messageId: acknowledgement.id,
        authorId: `${candidate.userId}:${candidate.provider}`,
        content: `I could not start this: ${
          error instanceof Error ? error.message : "the task could not be submitted"
        }`,
        projectId,
      });
    }
  }

  /**
   * The thread's name and the agent's opening reasoning.
   *
   * One call for both, because each costs the same wait and the person is
   * watching an empty thread until it lands. The reasoning is the agent's
   * own — what it makes of the request and what it intends to look at first
   * — rather than a description of the pipeline, which is what the audit
   * narration afterwards already provides. Falls back to the request itself
   * as a title and no reasoning, which is worse but never blank.
   */
  private async planOpening(
    candidate: ChannelMentionCandidate,
    objective: string,
  ): Promise<{ title: string; thoughts: string[] }> {
    const answer = await this.askAgent(
      candidate,
      "You have just been asked to do the following in a software project.\n" +
        "Reply with a short title on the first line — under six words, no " +
        "punctuation at the end — then two or three lines of your actual " +
        "first thoughts: what is being asked, what you want to check in the " +
        "repository, and how you would break it up. Write them as you would " +
        "think them, one per line, no bullets or numbering.\n\nRequest: " +
        objective,
      OPENING_TIMEOUT_MS,
    );
    if (answer.text === undefined) {
      return { title: summariseObjective(objective), thoughts: [] };
    }
    const lines = answer.text
      .split("\n")
      .map((line) => line.replace(/^[-*\d.\s]+/u, "").trim())
      .filter((line) => line.length > 0);
    const [title, ...thoughts] = lines;
    return {
      title:
        title === undefined || title.length > 80
          ? summariseObjective(objective)
          : title,
      // Bounded: a model that ignores "two or three lines" must not turn the
      // thread into an essay before the work has even started.
      thoughts: thoughts.slice(0, 4).map((line) => line.slice(0, 300)),
    };
  }

  /**
   * Answers a message that is not a request for work.
   *
   * Posted flat in the channel, with no thread and no task: a thread is for
   * following work, and creating one for "what are you working on?" leaves an
   * empty container that never closes. This is the same shape as the
   * one-to-one panel — a chat completion on the agent owner's credential —
   * just addressed to a room instead of a person.
   */
  private async answerInChannel(
    candidate: ChannelMentionCandidate,
    question: string,
    projectId: string,
    repositoryId: string,
  ): Promise<void> {
    const answer = await this.askAgent(
      candidate,
      "You are in a team chat for a software project. Answer this message " +
        "directly and briefly — two or three sentences at most, no markdown " +
        "headings, no preamble.\n\n" +
        question,
      QUESTION_TIMEOUT_MS,
    );
    await this.appendChannelEntry({
      projectId,
      repositoryId,
      kind: "agent",
      authorId: `${candidate.userId}:${candidate.provider}`,
      content: answer.text ?? explainAnswerFailure(answer.error),
    });
  }

  /**
   * Answers a person's reply inside an agent's own thread.
   *
   * A thread hangs off one agent's message about one task, so a reply in it is
   * addressed to that agent by construction — there is nobody else it could be
   * for, and no @mention should be needed to get an answer. Without this the
   * route stored the reply and stopped, which is why asking a failed task
   * "what did you get done then?" got silence: the question was recorded and
   * never read by anything.
   *
   * The thread so far goes in as the context, because the useful answers are
   * about what already happened in it — what was attempted, how far it got,
   * and why it stopped.
   */
  private async answerThreadReply(input: {
    projectId: string;
    repositoryId: string;
    messageId: string;
    viewerId: string;
    question: string;
  }): Promise<void> {
    const question = input.question.trim();
    if (question.length === 0) {
      return;
    }
    const root = await this.options.store.getChannelMessage(
      input.repositoryId,
      input.messageId,
      input.viewerId,
    );
    // Only an agent's thread has an agent to answer in it. A thread hanging
    // off a person's message is a conversation between people.
    if (root === undefined || root.kind !== "agent") {
      return;
    }
    const [ownerId = "", provider = ""] = root.authorId.split(":");
    if (ownerId === "" || provider === "") {
      return;
    }
    const candidates = await this.resolveChannelMentionCandidates(
      input.projectId,
      input.repositoryId,
    );
    const candidate = candidates.find(
      (entry) => entry.userId === ownerId && entry.provider === provider,
    );
    if (candidate === undefined) {
      // The agent has since been disconnected. Saying so is better than the
      // silence this method exists to remove.
      await this.appendChannelThreadReply({
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        messageId: input.messageId,
        authorId: root.authorId,
        content:
          "I cannot answer that right now — this agent is no longer " +
          "connected. Reconnect it from My Agents.",
      });
      return;
    }
    // The reply just stored is the question being asked, so it is left off the
    // end of the transcript rather than repeated to the model twice.
    const history = [
      root.content,
      ...root.replies.map((reply) => reply.content),
    ]
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .filter((line) => line.length > 0)
      .slice(-THREAD_CONTEXT_LINES);
    const answer = await this.askAgent(
      candidate,
      "You are in a team chat for a software project, answering a follow-up " +
        "question inside the thread for a task you worked on. Below is that " +
        "thread so far, oldest first. Answer the question directly and " +
        "briefly — three sentences at most, no markdown headings, no " +
        "preamble. If the thread shows the work did not finish, say plainly " +
        "how far it got and what stopped it. Do not invent progress the " +
        "thread does not show.\n\nThread so far:\n" +
        history.map((line) => `- ${line}`).join("\n") +
        `\n\nThe question: ${question}`,
      QUESTION_TIMEOUT_MS,
    );
    await this.appendChannelThreadReply({
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      messageId: input.messageId,
      authorId: root.authorId,
      content: answer.text ?? explainAnswerFailure(answer.error),
    });
  }

  /**
   * One short completion from an agent, on its owner's credential.
   *
   * Bounded by a deadline every time it is called: everything this is used
   * for sits in front of somebody waiting in a chat window, and a reply that
   * arrives after they have given up is worse than no reply at all.
   * `undefined` means the caller should say something fixed instead.
   */
  private async askAgent(
    candidate: ChannelMentionCandidate,
    prompt: string,
    timeoutMs: number,
  ): Promise<{ text?: string; error?: string }> {
    const complete = this.options.operations.chatProviders?.complete;
    if (complete === undefined) {
      return { error: "this deployment has no provider chat configured" };
    }
    // A distinct value rather than `undefined`, so "the deadline passed" and
    // "the model answered with nothing" stay separable. Collapsing them meant
    // a reply that arrived fine but was read out of the wrong field reported
    // itself as a timeout, which sent me looking at durations for something
    // that was never slow.
    const timedOut = Symbol("timeout");
    try {
      const answer = await Promise.race([
        complete({
          userId: candidate.userId,
          systemAdmin: false,
          provider: candidate.provider,
          messages: [{ role: "user", content: prompt }],
        }),
        new Promise<typeof timedOut>((resolve) =>
          setTimeout(() => resolve(timedOut), timeoutMs).unref?.(),
        ),
      ]);
      if (answer === timedOut) {
        return {
          error: `no answer within ${String(Math.round(timeoutMs / 1000))}s`,
        };
      }
      // `ChatReply.text` is the field the provider service actually fills.
      // Reading `content` — the shape of the *request* — found nothing every
      // time, so every dynamic line silently fell back to a fixed one.
      const reply = answer as { text?: unknown; content?: unknown };
      const trimmed = String(reply?.text ?? reply?.content ?? "").trim();
      return trimmed.length === 0
        ? { error: "the model answered with nothing" }
        : { text: trimmed };
    } catch (error) {
      // Carried rather than swallowed: "I could not reach my model" is true
      // and useless, and the reason is nearly always an expired sign-in the
      // reader is the only person who can fix.
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * What the agent says when it picks a request up.
   *
   * Asked of the model rather than written here, so the reply is about the
   * thing actually being requested — "Sure, I'll get a chess board rendering
   * first" rather than the same sentence every time regardless of what was
   * said. It runs on the agent owner's own credential, which is the same
   * account the work will be billed to.
   *
   * Bounded hard on both sides. The prompt asks for one short sentence, and
   * the call is raced against a deadline: an acknowledgement that arrives
   * after the person has given up is worse than a plain one that arrives at
   * once, and this sits in front of the task actually starting. Any failure —
   * no credential, a provider that is down, a model that rambles — falls back
   * to a fixed line rather than leaving the request unanswered.
   */
  private async composeAcknowledgement(
    candidate: ChannelMentionCandidate,
    request: string,
    claimMessage: string | undefined,
  ): Promise<string> {
    // Deliberately says nothing about the request. A mechanical restatement
    // reads worse than no restatement — it repeats the sender's own words,
    // typos included, and calls it a summary. The paraphrase is the agent's
    // job, and it arrives moments later as the thread's title; this line only
    // has to prove the request was heard, inside a couple of seconds, which
    // is far less time than a model call takes.
    const fallback = "On it.";
    const suffix = claimMessage === undefined ? "" : ` ${claimMessage}`;
    const complete = this.options.operations.chatProviders?.complete;
    if (complete === undefined) {
      return `${fallback}${suffix}`;
    }
    try {
      const answer = await Promise.race([
        complete({
          userId: candidate.userId,
          systemAdmin: false,
          provider: candidate.provider,
          messages: [
            {
              role: "user",
              content:
                "You are about to start this task in a team chat. Reply with " +
                "one short sentence — under 20 words — confirming you are " +
                "picking it up and naming what you will do first. No preamble, " +
                "no markdown, no quotes.\n\nTask: " +
                request,
            },
          ],
        }),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), ACKNOWLEDGEMENT_TIMEOUT_MS).unref?.(),
        ),
      ]);
      const text =
        typeof answer === "object" && answer !== null && "content" in answer
          ? String((answer as { content?: unknown }).content ?? "")
          : typeof answer === "string"
            ? answer
            : "";
      const line = text.trim().split("\n")[0]?.trim() ?? "";
      if (line.length === 0 || line.length > 300) {
        return `${fallback}${suffix}`;
      }
      return `${line}${suffix}`;
    } catch {
      return `${fallback}${suffix}`;
    }
  }

  /**
   * Follows a task and narrates what it does into its channel thread.
   *
   * Polling the audit log rather than being pushed to, because that log is
   * already the one place every part of a run reports to — the coordinator,
   * the worker and the integration service all append to it, and none of
   * them knows a channel exists. Reading it is what lets a thread describe
   * work being done by a process that has never heard of this feature.
   */
  private watchChannelTask(entry: Omit<WatchedChannelTask, "startedAtMs">): void {
    this.watchedChannelTasks.set(entry.taskId, {
      ...entry,
      startedAtMs: Date.now(),
    });
    if (this.channelProgressTimer !== undefined) {
      return;
    }
    this.channelProgressTimer = setInterval(() => {
      void this.pumpChannelProgress();
    }, CHANNEL_PROGRESS_INTERVAL_MS);
    // Never a reason to hold the process open on its own.
    this.channelProgressTimer.unref?.();
  }

  /** Brings every watched thread up to date, then drops finished ones. */
  private async pumpChannelProgress(): Promise<void> {
    if (this.watchedChannelTasks.size === 0) {
      if (this.channelProgressTimer !== undefined) {
        clearInterval(this.channelProgressTimer);
        this.channelProgressTimer = undefined;
      }
      return;
    }
    for (const watched of [...this.watchedChannelTasks.values()]) {
      try {
        const events = await this.options.store.listAuditEvents({
          afterSequence: watched.cursor,
          taskId: watched.taskId,
          limit: 200,
        });
        for (const record of events) {
          watched.cursor = record.sequence;
          const data = (record.event.data ?? {}) as Record<string, unknown>;
          if (
            record.event.type === "task_failed" &&
            typeof data["error"] === "string" &&
            IS_AUTH_FAILURE_RE.test(data["error"])
          ) {
            // The run observed it; the provider list is what has to show it.
            await this.options.operations.chatProviders?.noteAuthFailure?.({
              userId: watched.ownerId,
              provider: watched.provider,
              reason: "The sign-in has expired. Reconnect this agent.",
            }).catch(() => undefined);
          }
          const line = narrateTaskEvent(record.event.type, data);
          if (line === undefined) {
            continue;
          }
          await this.appendChannelThreadReply({
            projectId: watched.projectId,
            repositoryId: watched.repositoryId,
            messageId: watched.messageId,
            authorId: watched.authorId,
            content: line,
          });
          if (CHANNEL_TERMINAL_EVENTS[record.event.type] !== undefined) {
            this.watchedChannelTasks.delete(watched.taskId);
            break;
          }
        }
        if (Date.now() - watched.startedAtMs > CHANNEL_PROGRESS_MAX_MS) {
          // A run that never records an ending must not be followed forever —
          // and must not leave the thread looking permanently mid-sentence,
          // so giving up is said out loud rather than done quietly.
          this.watchedChannelTasks.delete(watched.taskId);
          await this.appendChannelThreadReply({
            projectId: watched.projectId,
            repositoryId: watched.repositoryId,
            messageId: watched.messageId,
            authorId: watched.authorId,
            content:
              "I could not finish this — I stopped hearing back from the run.",
          });
        }
      } catch (error) {
        process.stderr.write(
          `[channel] progress narration failed for ${watched.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }
  }

  /** One channel entry, stored and announced on the event stream. */
  private async appendChannelEntry(input: {
    projectId: string;
    repositoryId: string;
    kind: "agent" | "system";
    authorId: string;
    content: string;
  }): Promise<{ id: string }> {
    const message = await this.options.store.appendChannelMessage({
      repositoryId: input.repositoryId,
      projectId: input.projectId,
      kind: input.kind,
      authorId: input.authorId,
      content: input.content,
    });
    await this.options.store.appendAudit(undefined, {
      type: "channel_message_posted",
      data: {
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        messageId: message.id,
      },
    });
    return message;
  }

  /**
   * A reply on an existing channel thread.
   *
   * Announced as a `channel_message_posted` for the thread's own repository
   * so the same reconcile that shows a new message also shows a new reply —
   * a thread that only updated on reload would be no better than silence.
   */
  private async appendChannelThreadReply(input: {
    projectId: string;
    repositoryId: string;
    messageId: string;
    authorId: string;
    content: string;
  }): Promise<void> {
    await this.options.store.addChannelReply({
      repositoryId: input.repositoryId,
      messageId: input.messageId,
      kind: "agent",
      authorId: input.authorId,
      content: input.content,
    });
    await this.options.store.appendAudit(undefined, {
      type: "channel_message_posted",
      data: {
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        messageId: input.messageId,
      },
    });
  }

  /**
   * The no-@mention path: guesses whether a channel message is a task for
   * one of the agents actually present, and — only when exactly one stands
   * out clearly — dispatches to it through `dispatchOneMention`, the same
   * method and the same `submitTask` call an explicit @mention uses.
   *
   * Silence is the expected common case, by design: `looksLikeTaskRequest`
   * must first agree the message reads as a request for work at all, and
   * then the best-scoring candidate must clear both a minimum score and a
   * confidence margin over the runner-up. Both gates are deliberately
   * conservative (see their own doc comments) because firing wrongly spends
   * a real person's API/subscription usage on unwanted work — a strictly
   * worse outcome than staying silent and letting the sender @mention
   * explicitly, which always still works.
   *
   * A personal agent belonging to someone other than the sender is removed
   * from the candidate pool *before* scoring, not scored and then vetoed —
   * the same "only the owner may task it here" rule `dispatchOneMention`
   * enforces for an explicit mention (`CredentialVisibility` in
   * user-credentials.ts). Filtering first means this can never leak "the
   * personal agent would have been the pick" to a stranger via a claim
   * message; it is simply not a candidate for them, exactly as if it were
   * not connected to this channel. The sender can still reach it with an
   * explicit @mention, which the agent's own owner would then need to have
   * made org-wide, or which only the owner themself can send.
   */
  private async maybeAutoClaimTask(input: {
    projectId: string;
    repositoryId: string;
    content: string;
    senderId: string;
    candidates: ChannelMentionCandidate[];
  }): Promise<void> {
    const { projectId, repositoryId, content, senderId, candidates } = input;
    if (!looksLikeTaskRequest(content)) {
      return;
    }
    const dispatchable = candidates.filter(
      (candidate) =>
        candidate.visibility === "org" || candidate.userId === senderId,
    );
    if (dispatchable.length === 0) {
      return;
    }
    const messageTokens = relevanceTokens(content);
    // The only reasonably cheap "recent activity" signal that already
    // exists — see `scoreCandidate`'s doc comment for why nothing richer
    // (e.g. real recent-files-per-agent) is used here.
    const submittedTasks = await this.options.store.listSubmittedTasks({
      repositoryId,
    });
    const recentObjectivesByOwner = new Map<string, string[]>();
    for (const task of submittedTasks) {
      if (task.submittedBy === undefined) {
        continue;
      }
      const list = recentObjectivesByOwner.get(task.submittedBy) ?? [];
      if (list.length < RECENT_ACTIVITY_LOOKBACK) {
        list.push(task.objective);
        recentObjectivesByOwner.set(task.submittedBy, list);
      }
    }
    const scored = dispatchable
      .map((candidate) => ({
        candidate,
        ...scoreCandidate(
          messageTokens,
          candidate,
          recentObjectivesByOwner.get(candidate.userId) ?? [],
        ),
      }))
      .sort((a, b) => b.score - a.score);
    // Relevance decides *who*, never *whether*. Requiring a minimum score
    // meant a request had to share a word with some agent's role or name
    // before anybody would take it, so "can someone start building general
    // infrastructure for a chess engine" — unmistakably a task, addressed to
    // the room — matched nothing and was met with silence. A channel that
    // ignores plain requests is worse than one that occasionally picks the
    // less apt agent, and the sender can always name someone to override it.
    const [best] = scored;
    if (best === undefined) {
      return;
    }
    // A tie no longer means silence. The margin rules were written so that
    // "two similarly relevant agents" failed closed, on the reasoning that
    // dispatching wrongly spends somebody's real usage — but with two agents
    // connected, which is the ordinary case, near-ties are the norm and the
    // channel simply never answered anything that was not @mentioned. Never
    // answering is its own failure, and the more common one.
    //
    // So a tie is broken rather than refused, and the tie-break is the
    // question the margin was really standing in for: whose usage is this?
    // The sender's own agent goes first, because a person spending their own
    // account needs no protecting from themselves. Otherwise the earliest
    // candidate wins, which is stable across identical messages so the same
    // request does not land on a different agent each time.
    const runnerUpScore = scored[1]?.score ?? 0;
    const clearWinner =
      best.score - runnerUpScore >= MIN_MARGIN_ABSOLUTE &&
      best.score >= runnerUpScore * MIN_MARGIN_RATIO;
    const tied = scored.filter((entry) => entry.score === best.score);
    const chosen = clearWinner
      ? best
      : (tied.find((entry) => entry.candidate.userId === senderId) ?? tied[0]);
    if (chosen === undefined) {
      return;
    }
    await this.dispatchOneMention({
      projectId,
      repositoryId,
      content,
      senderId,
      candidate: chosen.candidate,
      trigger: "auto_claim",
      // No role to name it after when the winning candidate is unlabeled —
      // it won on name overlap alone, which is a real match, just not one
      // with a role phrase to hang the sentence on.
      claimMessage:
        chosen.candidate.role.trim() === ""
          ? `(Nobody was @mentioned, so I picked this up as the closest ` +
            `match — mention someone by name to send it elsewhere.)`
          : `(Nobody was @mentioned, so I picked this up as the closest match ` +
            `for ${chosen.candidate.role.toLowerCase()} work — mention someone ` +
            `by name to send it elsewhere.)`,
    });
  }

  /** A coordinator-authored line in the channel, broadcast the same way a real post is. */
  private async postChannelSystemMessage(
    projectId: string,
    repositoryId: string,
    content: string,
  ): Promise<void> {
    const message = await this.options.store.appendChannelMessage({
      repositoryId,
      projectId,
      kind: "system",
      authorId: "system",
      content,
    });
    await this.options.store.appendAudit(undefined, {
      type: "channel_message_posted",
      data: { projectId, repositoryId, messageId: message.id },
    });
  }

  private async performOperation<T>(
    code: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new HttpError(
        422,
        code,
        error instanceof Error ? error.message : "Operation could not be completed",
      );
    }
  }

  /**
   * Records the token totals a worker attached to a lease request.
   *
   * Returns everything reported for the lease so far, which is what a
   * per-task cap is measured against. A request that carries no usage — an
   * agent that does not report, or a bodyless heartbeat from an older worker
   * — writes nothing and simply reads the existing total back, so adding
   * accounting cannot break a worker that knows nothing about it.
   *
   * Malformed figures are dropped rather than rejected. The alternative is
   * failing a running task over a miscounted bill, and a gap in the data is
   * the honest record of an agent that could not say what it spent.
   */
  private async recordLeaseTokenUsage(
    request: IncomingMessage,
    lease: WorkLease,
    at: string,
  ): Promise<number> {
    const declared = Number.parseInt(
      request.headers["content-length"] ?? "0",
      10,
    );
    if (Number.isFinite(declared) && declared > 0) {
      const body = await this.readJson(request).catch(() => undefined);
      const entries = (body as { tokenUsage?: unknown } | undefined)
        ?.tokenUsage;
      if (Array.isArray(entries)) {
        await this.recordReportedTokenUsage(lease, entries, at);
      }
    }
    return (
      await this.options.store.listTokenUsage({ leaseId: lease.id })
    ).reduce((sum, entry) => sum + entry.totalTokens, 0);
  }

  /** Writes one batch of reported phase totals against a lease. */
  private async recordReportedTokenUsage(
    lease: WorkLease,
    entries: readonly unknown[],
    at: string,
  ): Promise<void> {
    const task = (
      await this.options.store.listSubmittedTasks({
        repositoryId: lease.repositoryId,
      })
    ).find((entry) => entry.id === lease.taskId);
    for (const raw of entries) {
      const entry = raw as Record<string, unknown>;
      const phase = entry["phase"];
      const total = entry["totalTokens"];
      if (
        (phase !== "planning" && phase !== "execution") ||
        typeof total !== "number" ||
        !Number.isSafeInteger(total) ||
        total < 0
      ) {
        continue;
      }
      const count = (key: string): number | undefined => {
        const value = entry[key];
        return typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0
          ? value
          : undefined;
      };
      await this.options.store.recordTokenUsage({
        // One row per lease and phase, carrying the running total: the worker
        // re-reports a larger figure as it goes, and summing those snapshots
        // would multiply the bill by the heartbeat rate.
        usageKey: `${lease.id}:${phase}`,
        ...(lease.projectId === undefined
          ? {}
          : { projectId: lease.projectId }),
        repositoryId: lease.repositoryId,
        taskId: lease.taskId,
        leaseId: lease.id,
        agentId: task?.agentId ?? lease.workerId,
        phase,
        ...(count("inputTokens") === undefined
          ? {}
          : { inputTokens: count("inputTokens")! }),
        ...(count("outputTokens") === undefined
          ? {}
          : { outputTokens: count("outputTokens")! }),
        totalTokens: total,
        recordedAt: at,
      });
    }
  }

  /** Settles a lease and its task after a budget was exceeded. */
  private async failLeaseOnBudget(
    lease: WorkLease,
    now: Date,
    input: { detail: string; data: Readonly<Record<string, unknown>> },
  ): Promise<void> {
    const failed = await this.options.store.finishWorkLease(
      lease.id,
      "failed",
      now.toISOString(),
      input.detail,
    );
    if (!failed) {
      return;
    }
    const task = (
      await this.options.store.listSubmittedTasks({
        repositoryId: lease.repositoryId,
      })
    ).find((entry) => entry.id === lease.taskId);
    if (task?.status === "claimed") {
      await this.options.store.completeSubmittedTask(task.id, "failed");
    }
    await this.options.store.appendAudit(undefined, {
      type: "task_failed",
      taskId: lease.taskId,
      data: {
        projectId: lease.projectId,
        repositoryId: lease.repositoryId,
        workerId: lease.workerId,
        leaseId: lease.id,
        stage: "budget_enforcement",
        ...input.data,
      },
    });
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
    if (contentType !== "application/json") {
      throw new HttpError(
        415,
        "unsupported_media_type",
        "Content-Type must be application/json",
      );
    }
    const declared = Number.parseInt(request.headers["content-length"] ?? "0", 10);
    if (Number.isFinite(declared) && declared > this.bodyLimit) {
      throw new HttpError(413, "body_too_large", "Request body is too large");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > this.bodyLimit) {
        throw new HttpError(413, "body_too_large", "Request body is too large");
      }
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
    }
  }

  private async serveStatic(context: RequestContext): Promise<void> {
    const { request, response, url } = context;
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new HttpError(404, "not_found", "Route was not found");
    }
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const asset =
      this.options.staticAssets?.get(requested) ??
      (requested.includes(".")
        ? undefined
        : this.options.staticAssets?.get("/index.html"));
    if (asset === undefined) {
      throw new HttpError(404, "not_found", "Asset was not found");
    }
    const body = Buffer.isBuffer(asset.body)
      ? asset.body
      : Buffer.from(asset.body, "utf8");
    const etag =
      asset.etag ??
      `"${createHash("sha256").update(body).digest("base64url")}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304);
      response.end();
      return;
    }
    response.setHeader("Content-Type", asset.contentType);
    response.setHeader("Content-Length", String(body.length));
    response.setHeader("ETag", etag);
    // Asset names are stable rather than content-hashed, so every navigation
    // must revalidate the ETag to avoid mixing an old client with a new API.
    response.setHeader("Cache-Control", "no-cache");
    response.writeHead(200);
    response.end(request.method === "HEAD" ? undefined : body);
  }

  private assertOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (origin === undefined) {
      return;
    }
    const host = request.headers.host;
    const sameOrigin =
      host !== undefined &&
      (origin === `http://${host}` || origin === `https://${host}`);
    if (!sameOrigin && !this.allowedOrigins.has(origin)) {
      throw new HttpError(403, "origin_rejected", "Request origin is not allowed");
    }
  }

  private applyCors(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const origin = request.headers.origin;
    if (origin === undefined) {
      return;
    }
    const host = request.headers.host;
    const sameOrigin =
      host !== undefined &&
      (origin === `http://${host}` || origin === `https://${host}`);
    if (!sameOrigin && this.allowedOrigins.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Vary", "Origin");
    }
  }

  private remoteAddress(request: IncomingMessage): string {
    return request.socket.remoteAddress ?? "unknown";
  }

  private securityHeaders(response: ServerResponse, requestId: string): void {
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // style-src allows 'unsafe-inline' because the vendored Monaco editor
    // injects its theming through runtime <style> elements; script-src stays
    // 'self' (no CDN, no inline scripts) and workers are same-origin scripts.
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self' ws: wss:; " +
        "font-src 'self'; worker-src 'self'; object-src 'none'; " +
        "base-uri 'none'; frame-ancestors 'none'",
    );
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    value: unknown,
  ): void {
    if (response.headersSent) {
      return;
    }
    const body = Buffer.from(JSON.stringify(value), "utf8");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", String(body.length));
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(status);
    response.end(body);
  }

  private sendError(
    response: ServerResponse,
    requestId: string,
    error: unknown,
  ): void {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const normalized =
      error instanceof AuthenticationError
        ? {
            status: error.statusCode,
            code: error.code,
            message: error.message,
          }
        : error instanceof HttpError
          ? {
              status: error.status,
              code: error.code,
              message: error.message,
            }
          : {
              status: 500,
              code: "internal_error",
              message: "The request could not be completed",
            };
    this.sendJson(response, normalized.status, {
      error: {
        code: normalized.code,
        message: normalized.message,
        requestId,
      },
    });
  }
}
