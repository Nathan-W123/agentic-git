/**
 * One shared file: its authoritative text, and who is looking at it.
 *
 * A room is scoped to `(project, repository, overlay owner, path)` — the
 * overlay owner, not just the repository, because overlays are per-user git
 * worktrees. Two people editing "the same file" are editing one person's
 * working copy, exactly like a Live Share guest edits the host's workspace.
 * That is what keeps the git submission flow untouched: the text still lives
 * in one worktree, and that worktree's owner still submits it through the
 * ordinary pipeline.
 *
 * Pure state: no sockets, no filesystem. The gateway hub drives it.
 */

import { CollabDocument, type AppliedOperation } from "./document.js";
import {
  transformSelection,
  CollabError,
  type SelectionRange,
  type TextOperation,
} from "./text-operation.js";

export interface RoomScope {
  readonly projectId: string;
  readonly repositoryId: string;
  /** The user whose overlay worktree backs this document. */
  readonly ownerUserId: string;
  readonly path: string;
}

/** NUL-separated: every other byte can legitimately appear in a file path. */
export function roomKey(scope: RoomScope): string {
  return [
    scope.projectId,
    scope.repositoryId,
    scope.ownerUserId,
    scope.path,
  ].join("\0");
}

export interface Participant {
  /** Per-connection, so one user in two tabs shows up as two carets. */
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  /** Stable per user, so a caret keeps its colour across reconnects. */
  readonly color: string;
  /** True for the user whose overlay backs the document. */
  readonly owner: boolean;
  /** In server-document coordinates; absent until the client reports one. */
  selection?: SelectionRange;
}

/**
 * Caret colours. Chosen to stay legible on the dashboard's dark surface and
 * to remain distinguishable for the common forms of colour blindness — carets
 * are also labelled, so colour is never the only signal.
 */
const PARTICIPANT_COLORS = [
  "#4cc2ff",
  "#ffb454",
  "#7ee787",
  "#ff7b9c",
  "#c792ea",
  "#ffd866",
  "#5eead4",
  "#f78166",
] as const;

export function colorForUser(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
  }
  return (
    PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length] ??
    PARTICIPANT_COLORS[0]
  );
}

/**
 * An agent's in-flight, unapproved work touching this file.
 *
 * Derived from the audit log rather than from the agent's worktree: a plan
 * announces the files it expects to touch, and a collected changeset names
 * the files it actually changed. Neither has been approved or promoted yet,
 * which is precisely why a human editing the same file wants to see it.
 */
export interface AgentActivity {
  readonly taskId: string;
  readonly agentId: string;
  /** `planned` once a plan claims the file, `changed` once a diff exists. */
  readonly stage: "planned" | "changed";
  readonly objective: string;
  readonly occurredAt: string;
}

export interface JoinInput {
  readonly participantId: string;
  readonly userId: string;
  readonly displayName: string;
}

export class CollabRoom {
  public readonly document: CollabDocument;
  private readonly members = new Map<string, Participant>();
  private readonly agents = new Map<string, AgentActivity>();
  /** Revision whose text is known to match the file on disk. */
  private savedRevision: number;
  /**
   * When the room last saw traffic. A room with unsaved text outlives its last
   * participant — otherwise switching editor tabs would silently discard the
   * buffer — so the hub needs an age to sweep against.
   */
  public lastActivityAt: number;

  public constructor(
    public readonly scope: RoomScope,
    content: string,
    now: number = Date.now(),
  ) {
    this.document = new CollabDocument(content);
    this.savedRevision = this.document.revision;
    this.lastActivityAt = now;
  }

  public touch(now: number = Date.now()): void {
    this.lastActivityAt = now;
  }

  public get participants(): Participant[] {
    return [...this.members.values()];
  }

  public get size(): number {
    return this.members.size;
  }

  public get dirty(): boolean {
    return this.document.revision !== this.savedRevision;
  }

  public get agentActivity(): AgentActivity[] {
    return [...this.agents.values()];
  }

  public participant(participantId: string): Participant | undefined {
    return this.members.get(participantId);
  }

  public join(input: JoinInput): Participant {
    const participant: Participant = {
      id: input.participantId,
      userId: input.userId,
      displayName: input.displayName,
      color: colorForUser(input.userId),
      owner: input.userId === this.scope.ownerUserId,
    };
    this.members.set(participant.id, participant);
    return participant;
  }

  public leave(participantId: string): boolean {
    return this.members.delete(participantId);
  }

  /**
   * Applies one participant's operation and carries every *other* caret
   * across it. The sender's own caret is set from the selection it sent with
   * the operation, which is already in post-operation coordinates.
   */
  public receive(
    participantId: string,
    clientRevision: number,
    operation: TextOperation,
    selection?: SelectionRange,
  ): AppliedOperation {
    const sender = this.members.get(participantId);
    if (sender === undefined) {
      throw new CollabError("unknown_participant", "The sender is not in the room");
    }
    const applied = this.document.receive(clientRevision, operation);
    for (const member of this.members.values()) {
      if (member.id === participantId || member.selection === undefined) {
        continue;
      }
      member.selection = transformSelection(member.selection, applied.operation);
    }
    if (selection !== undefined) {
      sender.selection = clampSelection(selection, this.document.content.length);
    }
    return applied;
  }

  /**
   * Records a caret reported against `clientRevision`, carrying it forward
   * through anything that landed since.
   *
   * Returns `undefined` when the client is beyond the history window; the
   * caller resynchronizes it rather than showing a caret in the wrong place.
   */
  public setSelection(
    participantId: string,
    clientRevision: number,
    selection: SelectionRange,
  ): SelectionRange | undefined {
    const member = this.members.get(participantId);
    if (member === undefined) {
      return undefined;
    }
    const catchUp = this.document.since(clientRevision);
    if (catchUp === undefined) {
      return undefined;
    }
    const current = clampSelection(
      transformSelection(selection, catchUp),
      this.document.content.length,
    );
    member.selection = current;
    return current;
  }

  /** Applies a change that came from outside the session (disk, reset, agent). */
  public replaceContent(content: string): AppliedOperation | undefined {
    const applied = this.document.replace(content);
    if (applied === undefined) {
      return undefined;
    }
    for (const member of this.members.values()) {
      if (member.selection !== undefined) {
        member.selection = transformSelection(member.selection, applied.operation);
      }
    }
    // Content that arrived from disk *is* what is on disk.
    this.savedRevision = this.document.revision;
    return applied;
  }

  public markSaved(revision: number): void {
    this.savedRevision = revision;
  }

  public noteAgentActivity(activity: AgentActivity): boolean {
    const existing = this.agents.get(activity.taskId);
    if (existing?.stage === activity.stage) {
      return false;
    }
    // `changed` supersedes `planned`; never the other way round.
    if (existing?.stage === "changed" && activity.stage === "planned") {
      return false;
    }
    this.agents.set(activity.taskId, activity);
    return true;
  }

  public clearAgentActivity(taskId: string): boolean {
    return this.agents.delete(taskId);
  }
}

function clampSelection(
  selection: SelectionRange,
  length: number,
): SelectionRange {
  const clamp = (value: number): number =>
    Number.isSafeInteger(value) ? Math.min(Math.max(value, 0), length) : 0;
  return { anchor: clamp(selection.anchor), head: clamp(selection.head) };
}

/** Rooms live only as long as somebody is in them. */
export class CollabRoomRegistry {
  private readonly rooms = new Map<string, CollabRoom>();

  public get size(): number {
    return this.rooms.size;
  }

  public get(scope: RoomScope): CollabRoom | undefined {
    return this.rooms.get(roomKey(scope));
  }

  public create(scope: RoomScope, content: string, now?: number): CollabRoom {
    const room = new CollabRoom(scope, content, now);
    this.rooms.set(roomKey(scope), room);
    return room;
  }

  public delete(scope: RoomScope): void {
    this.rooms.delete(roomKey(scope));
  }

  public all(): CollabRoom[] {
    return [...this.rooms.values()];
  }
}
