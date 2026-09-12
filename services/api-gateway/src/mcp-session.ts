/**
 * MCP sessions: the `Mcp-Session-Id` half of the protocol, and what a
 * returning client is told.
 *
 * ### Why there is a record at all
 *
 * A CLI client opens a connection per task, does three tool calls and goes
 * away. Before this, every one of those connections started from nothing: the
 * model had to ask which repositories exist, the person had to say which one
 * again, and whatever the last session filed was invisible. The session id the
 * spec already defines is the hook for fixing that, and `initialize`'s
 * `instructions` field is where the answer goes.
 *
 * ### Why the row is in the store
 *
 * Everything else this gateway keeps per connection — editor presence, bundle
 * tickets, the proxy's manifest cache — is a map in memory, on the explicit
 * reasoning that losing it to a restart is not a fault. This is the opposite
 * case. A deploy is exactly the moment a client reconnects, and in a Postgres
 * deployment the store is the one component every process shares.
 *
 * ### Why the id is not a credential
 *
 * It is stored in plain text and compared as plain text. Every request still
 * authenticates with its bearer token; the id only selects which record that
 * principal is continuing, and is worth nothing without the token. An id
 * presented by the wrong principal is answered **404, never 403**: 403 would
 * confirm the id exists, and 404 is what the spec says makes a client
 * re-`initialize`, which is the behaviour wanted either way.
 *
 * ### Why a request with no id still works
 *
 * Every client and every test written against this endpoint before sessions
 * existed sends no header, and demanding one (which the spec permits, with a
 * 400) would break them to buy nothing. No header means no handle, and the
 * tools behave exactly as they did.
 *
 * ### Why outcomes are not stored
 *
 * The record keeps which tasks a session touched and nothing about how they
 * went. State and outcome are read live from `submitted_tasks` and the audit
 * log when the brief is written, so a session record can never contradict the
 * run it is describing.
 *
 * ### Why the notes are merged in the store
 *
 * An editor issues parallel tool calls. Each request loads its own handle, so
 * two of them writing a whole task list computed from their own read would
 * each persist a stale copy and one task id would vanish. The handle therefore
 * tracks only what *this* request added, and the store folds it into the row.
 *
 * ### Why the seed is cached
 *
 * `findTaskHandoffs` reads the whole live and archived handoff log per call by
 * design, and the brief is computed on the handshake, which a client performs
 * once per task. A store-level `limit` would not do instead: `listAuditEvents`
 * returns events ascending by sequence, so a limit keeps the *oldest*
 * handoffs, which is the opposite of what a successor wants. So the expensive
 * read is cached per person and repository for a minute, pruned on the way
 * past rather than on a timer — a timer is a handle held open for the life of
 * the process to tidy a map that only grows while somebody is using it.
 */

import { randomBytes } from "node:crypto";

import {
  mergeMcpSessionTasks,
  type CoordinationStore,
  type McpSessionFocus,
  type McpSessionRecord,
  type McpSessionTask,
} from "@coord/persistence";

import { MCP_PROTOCOL_VERSION, type McpReply } from "./mcp.js";

/** The header the spec names the session on. Node lower-cases what arrives. */
export const MCP_SESSION_HEADER = "mcp-session-id";
/** The revision header a client sends on every request after the handshake. */
export const MCP_PROTOCOL_HEADER = "mcp-protocol-version";

/**
 * How long an idle session id stays accepted. Sliding, checked on read the way
 * a cookie session's expiry is, and overridable per deployment with
 * `COORD_MCP_SESSION_TTL_HOURS`. It governs *acceptance* only: the row itself
 * is still read for continuity long after the id has stopped working.
 */
export const MCP_SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
/** How many of one person's sessions are kept. See the migration for why count. */
export const MCP_SESSIONS_KEPT_PER_USER = 40;
/** How many tasks one session remembers. Oldest dropped. */
export const MCP_SESSION_MAX_TASKS = 20;
/** The cap on the handshake brief, which is paid for on every task a client starts. */
export const MCP_INSTRUCTIONS_MAX_CHARS = 6_000;
/** The cap on `session_context`, which is asked for deliberately. */
export const MCP_CONTEXT_MAX_CHARS = 20_000;
/** How many recent tasks a brief lists. */
export const MCP_BRIEF_RECENT_TASKS = 5;
/** How many handoffs the handshake brief seeds from. */
export const MCP_BRIEF_HANDOFFS = 2;
/** How many `session_context` asks for, being the deliberate call. */
export const MCP_CONTEXT_HANDOFFS = 5;
/** How long a gathered seed is reused for. */
export const MCP_BRIEF_SEED_CACHE_MS = 60_000;
/** `clientInfo` is somebody else's text; kept short enough to print. */
export const MCP_CLIENT_FIELD_MAX = 120;
/** An objective on a session row is a reminder, not a second copy of it. */
export const MCP_OBJECTIVE_SNIPPET_MAX = 200;

/** The longest session id this server will look up. */
const SESSION_ID_MAX = 200;

/**
 * The id off the header, or undefined when there is nothing usable there.
 *
 * The spec requires visible ASCII, so anything else is refused here rather
 * than turned into a store lookup for a key that cannot exist. That same rule
 * is what refuses a repeated header: Node comma-joins every duplicated header
 * except `set-cookie`, so two `Mcp-Session-Id` lines reach this function as
 * the single string `"a, b"`, whose space fails the check — which is the
 * answer wanted, because two ids is not one session. The non-string guard is
 * a different case, and not one HTTP produces: it is defence against a caller
 * that hands this function a raw header array of its own.
 */
export function parseSessionHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SESSION_ID_MAX) {
    return undefined;
  }
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) {
      return undefined;
    }
  }
  return trimmed;
}

/**
 * Whether a `MCP-Protocol-Version` header names something this server speaks.
 *
 * Absent is fine — the spec says to assume the revision before the header
 * existed. Anything that is not a date, or a date after ours, is not: it is
 * the same rule `initialize` applies when it echoes a version back, and a
 * client asking for a revision this server has never heard of is better told
 * so than served something it will misread.
 */
export function protocolVersionAcceptable(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && value <= MCP_PROTOCOL_VERSION;
}

/** What an `initialize` payload says about the client, with its lengths capped. */
export function initializeParamsOf(payload: unknown): {
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
} {
  const params = isObject(payload) ? payload["params"] : undefined;
  const info = isObject(params) ? params["clientInfo"] : undefined;
  const asked = isObject(params) ? params["protocolVersion"] : undefined;
  const name = isObject(info) ? info["name"] : undefined;
  const version = isObject(info) ? info["version"] : undefined;
  return {
    ...(typeof asked === "string" && asked !== ""
      ? { protocolVersion: asked.slice(0, MCP_CLIENT_FIELD_MAX) }
      : {}),
    ...(typeof name === "string" && name !== ""
      ? { clientName: name.slice(0, MCP_CLIENT_FIELD_MAX) }
      : {}),
    ...(typeof version === "string" && version !== ""
      ? { clientVersion: version.slice(0, MCP_CLIENT_FIELD_MAX) }
      : {}),
  };
}

/**
 * Whether the reply to an `initialize` is one a session may be minted on.
 *
 * Keyed on the reply rather than on the parsed method deliberately.
 * `handleMcpMessage` refuses a message that is not JSON-RPC 2.0, and answers a
 * message with no `id` as a notification, both before it reaches the
 * `initialize` branch — so "the method said initialize" is not the same fact
 * as "a session was initialized", and handing out a session id on an error
 * reply would leave the client holding one this server never recorded.
 */
export function initializedOk(reply: McpReply): boolean {
  return reply.status === 200 && isObject(reply.body) && "result" in reply.body;
}

/** A fresh session id: visible ASCII, generated like any other secret here. */
export function newMcpSessionId(): string {
  return `mcps_${randomBytes(24).toString("base64url")}`;
}

/**
 * One request's view of a session.
 *
 * Loaded from the row, mutated by the tools that ran, and written back once at
 * the end of the request. It tracks the notes *this* request added separately
 * from the list it loaded, because that is what the store needs in order to
 * merge rather than overwrite — see the header.
 */
export class McpSessionHandle {
  private readonly loaded: readonly McpSessionTask[];
  private readonly added: McpSessionTask[] = [];
  private current: McpSessionFocus | undefined;
  private changed = false;

  public constructor(private readonly record: McpSessionRecord) {
    this.loaded = record.tasks;
    this.current = record.focus;
  }

  public get id(): string {
    return this.record.id;
  }

  public get userId(): string {
    return this.record.userId;
  }

  /** When this session was last seen, for "you were here an hour ago". */
  public get lastSeenAt(): string {
    return this.record.lastSeenAt;
  }

  /** What the client called itself on its handshake, when it said. */
  public get clientName(): string | undefined {
    return this.record.clientName;
  }

  public get focus(): McpSessionFocus | undefined {
    return this.current;
  }

  /** The row's list with this request's notes folded in, capped as it will be stored. */
  public get tasks(): readonly McpSessionTask[] {
    return mergeMcpSessionTasks(this.loaded, this.added, MCP_SESSION_MAX_TASKS);
  }

  public setFocus(focus: McpSessionFocus): void {
    this.current = focus;
    this.changed = true;
  }

  public noteTask(task: Omit<McpSessionTask, "at">, at: string = new Date().toISOString()): void {
    const noted: McpSessionTask = {
      ...task,
      objective: task.objective.slice(0, MCP_OBJECTIVE_SNIPPET_MAX),
      at,
    };
    // Deduped within this request as well as by the store, so a tool that
    // files and then re-reads the same task does not send its id twice.
    const already = this.added.findIndex(
      (entry) => entry.taskId === noted.taskId,
    );
    if (already >= 0) {
      this.added.splice(already, 1);
    }
    this.added.push(noted);
  }

  public get focusChanged(): boolean {
    return this.changed;
  }

  public get newNotes(): readonly McpSessionTask[] {
    return this.added;
  }

  /**
   * The whole row as this request leaves it, for the handshake that is
   * *creating* the row rather than updating one.
   *
   * `initialize` has no row to merge into and never calls `patch`, so a focus
   * adopted while the brief was being written — the one the brief has just
   * told the client its tools default to — would be printed and then thrown
   * away. What this returns is what the route persists.
   */
  public get row(): McpSessionRecord {
    return { ...this.record, focus: this.current, tasks: [...this.tasks] };
  }

  /** The write this request owes the row, or the bare touch when nothing moved. */
  public patch(
    now: Date,
    ttlMs: number,
  ): Parameters<CoordinationStore["updateMcpSession"]>[1] {
    return {
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      ...(this.changed ? { focus: this.current } : {}),
      ...(this.added.length === 0
        ? {}
        : {
            noteTasks: {
              tasks: [...this.added],
              max: MCP_SESSION_MAX_TASKS,
            },
          }),
    };
  }
}

/** What a brief's expensive half is made of, once it has been gathered. */
export interface McpBriefSeed {
  /** Rendered handoffs from earlier work in the focus repository. */
  readonly handoffContext: string;
  /** The repository's standing context, already rendered. Empty when none. */
  readonly standingContext: string;
}

interface SeedEntry extends McpBriefSeed {
  readonly expiresAt: number;
}

/**
 * The gathered half of a brief, remembered for a minute per person and
 * repository.
 *
 * Modelled on the proxy's manifest cache, for the same reason and with the
 * same rules: entries are dropped on the way past rather than on a timer, and
 * a second caller arriving mid-read joins the first rather than starting its
 * own. Keyed on the person as well as the repository because a brief is
 * authorized for whoever asked for it.
 */
export class McpBriefSeedCache {
  private readonly entries = new Map<string, SeedEntry>();
  private readonly inFlight = new Map<string, Promise<McpBriefSeed>>();

  public constructor(private readonly now: () => number = Date.now) {}

  public async get(
    userId: string,
    repositoryId: string,
    load: () => Promise<McpBriefSeed>,
  ): Promise<McpBriefSeed> {
    const at = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) {
        this.entries.delete(key);
      }
    }
    const key = `${userId}\0${repositoryId}`;
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.expiresAt > at) {
      return {
        handoffContext: cached.handoffContext,
        standingContext: cached.standingContext,
      };
    }
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return await existing;
    }
    const loading = load();
    this.inFlight.set(key, loading);
    try {
      const seed = await loading;
      this.entries.set(key, {
        ...seed,
        expiresAt: this.now() + MCP_BRIEF_SEED_CACHE_MS,
      });
      return seed;
    } finally {
      if (this.inFlight.get(key) === loading) {
        this.inFlight.delete(key);
      }
    }
  }
}

/**
 * How to use this server, said once on the handshake.
 *
 * Three sentences, because this text is injected into the model's context on
 * every connection and everything beyond the rules it cannot work out for
 * itself is a tax on the conversation that follows.
 */
export const STANDING_INSTRUCTIONS = [
  "You are connected to Kumi, where this account's repositories, agents and " +
    "tasks live.",
  "Call list_repositories when you do not already know a repository name. " +
    "submit_task files work for an agent; take_task hands you work to do " +
    "here; session_context shows what this account has been doing.",
  "Everything below is projected from Kumi's own records, not from anybody's " +
    "recollection.",
].join("\n");

/** One task line in a brief, already narrowed to what the caller may see. */
export interface SessionBriefTask {
  readonly taskId: string;
  readonly objective: string;
  readonly repositoryId: string;
  readonly state: string;
  readonly outcome?: string;
}

export interface SessionBriefInput {
  /** The standing instructions. Passed in so the renderer stays pure. */
  readonly standing: string;
  /** Where this client was working, when anything says. */
  readonly focus?: McpSessionFocus;
  /** The earlier session this focus and these tasks were read from. */
  readonly resumedFrom?: {
    readonly clientName?: string;
    readonly lastSeenAt: string;
  };
  readonly recentTasks: readonly SessionBriefTask[];
  /** Rendered handoffs, already carrying their own heading. Empty when none. */
  readonly handoffContext: string;
  /** The repository's standing context, already rendered. Empty when none. */
  readonly standingContext?: string;
  readonly maxChars: number;
}

/**
 * The brief itself.
 *
 * Ordered so the tail is what truncation cuts: the instructions a model cannot
 * work out for itself first, then where it was, then what it did, then the
 * background it can live without. Nothing here is summarised by a model —
 * every line is projected from rows the caller can already read.
 */
export function renderSessionBrief(input: SessionBriefInput): string {
  const sections: string[] = [input.standing];
  if (input.focus !== undefined) {
    const room =
      input.focus.channel === undefined ? "" : ` (#${input.focus.channel})`;
    const when =
      input.resumedFrom === undefined
        ? ""
        : ` Last seen ${input.resumedFrom.lastSeenAt}${
            input.resumedFrom.clientName === undefined
              ? ""
              : ` from ${input.resumedFrom.clientName}`
          }.`;
    sections.push(
      `You were last working in ${input.focus.repositoryId}${room}.${when} ` +
        "Tools default to it; name a repository to work somewhere else.",
    );
  }
  if (input.recentTasks.length > 0) {
    sections.push(
      [
        "## What this account has been doing",
        "",
        ...input.recentTasks.map((task) =>
          [
            `- ${task.taskId} — ${task.objective} (${task.repositoryId})`,
            `  ${task.state}`,
            ...(task.outcome === undefined ? [] : [`  ${task.outcome}`]),
          ].join("\n"),
        ),
      ].join("\n"),
    );
  }
  if (input.handoffContext !== "") {
    sections.push(input.handoffContext);
  }
  if (input.standingContext !== undefined && input.standingContext !== "") {
    sections.push(input.standingContext);
  }
  return capText(sections.join("\n\n"), input.maxChars);
}

/**
 * Cuts a brief down to size at a line boundary, and says that it did.
 *
 * A brief that stops mid-sentence reads as a broken server rather than as a
 * long answer, and a model given no way to ask for the rest simply carries on
 * without it — so the marker names the tool that has the rest.
 */
export function capText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const marker = "\n… (cut short — call session_context for the rest)";
  // A cap shorter than the marker cannot carry it. Emitting the marker anyway
  // would return more characters than were asked for, which turns the bound on
  // what a handshake injects into no bound at all — so a cap that small cuts
  // flat and loses the marker rather than overrunning.
  if (max <= marker.length) {
    return text.slice(0, Math.max(0, max));
  }
  const room = max - marker.length;
  const cut = text.slice(0, room);
  const lastBreak = cut.lastIndexOf("\n");
  return `${(lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd()}${marker}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
