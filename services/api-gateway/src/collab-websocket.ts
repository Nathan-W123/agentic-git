/**
 * Live multi-user editing for the dashboard's overlay editor.
 *
 * ## Where the shared document lives
 *
 * Overlays are per-user detached git worktrees keyed by
 * `hash(user, project, repository)`, so two people "editing the same file" are
 * physically editing two different files. Collaboration therefore needs a
 * shared *live* document that is not either worktree, plus a rule for which
 * worktree it lands in when saved.
 *
 * The rule is the Live Share one: a room is anchored to one overlay — its
 * owner's — and guests edit the owner's working copy. The live text lives in
 * memory here; `save` flushes it into the owner's overlay through the same
 * `writeFile` port the single-user editor already uses. Nothing about
 * submission changes: the owner still submits their overlay through
 * `OverlayWorkspaceService.submit`, which still plans, admits, gates, and
 * validates exactly as before. This layer is additive.
 *
 * ## Who may join
 *
 * Opening a file addresses your own overlay by default, so a lone user's
 * session is indistinguishable from the old behaviour. Addressing *another*
 * user's overlay requires two things: the project permission the editor
 * already demands (`submit_task`, checked by the gateway's `authorize`
 * callback), and the owner having that exact file open right now. A user's
 * unsubmitted draft is never readable just because someone knows the path —
 * the owner has to be in the room. Joins are audited.
 *
 * ## Consistency
 *
 * Server-authoritative OT from `@coord/collab`: clients name the revision
 * they were looking at, this hub rebases their operation onto anything that
 * landed since, and broadcasts the rebased form. See that package for why OT
 * rather than a CRDT.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  CollabError,
  CollabRoomRegistry,
  parseClientMessage,
  roomKey,
  MAX_PATH_LENGTH,
  type AgentActivity,
  type CollabRoom,
  type RoomScope,
  type ServerMessage,
} from "@coord/collab";
import type { CoordinationStore } from "@coord/persistence";

import type { WebSocketAuthorization } from "./websocket.js";
import {
  acceptKey,
  encodeCloseFrame,
  encodeFrame,
  encodeTextFrame,
  isWebSocketHandshake,
  rejectUpgrade,
  FrameReader,
  OPCODE_PONG,
} from "./ws-frame.js";

/**
 * The overlay operations this hub needs. Structurally a subset of
 * `WorkspaceOperations`, so the gateway hands over the same implementation the
 * HTTP editor routes use and no second filesystem path exists.
 */
export interface CollabWorkspacePort {
  readFile(
    input: {
      projectId: string;
      repositoryId: string;
      userId: string;
      path: string;
    },
  ): Promise<unknown>;
  writeFile(
    input: {
      projectId: string;
      repositoryId: string;
      userId: string;
      path: string;
      content: string;
    },
  ): Promise<unknown>;
}

export interface CollabWebSocketOptions {
  path?: string;
  /**
   * Must enforce the same project permission the HTTP editor routes do.
   * Throwing rejects the upgrade.
   */
  authorize: (
    request: IncomingMessage,
    projectId: string,
  ) => Promise<WebSocketAuthorization>;
  reauthorize: (
    authorization: WebSocketAuthorization,
  ) => Promise<WebSocketAuthorization>;
  /** Absent on deployments without overlay workspaces; upgrades then fail. */
  workspace?: CollabWorkspacePort | undefined;
  tickIntervalMs?: number;
  reauthorizeIntervalMs?: number;
  /**
   * How long a room with unsaved text may sit empty before it is flushed to
   * the owner's overlay and dropped.
   */
  idleFlushMs?: number;
}

/** Matches the overlay's own write ceiling, in UTF-16 units rather than bytes. */
const MAX_DOCUMENT_UNITS = 512 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_SOCKET_BUFFER = 4 * 1024 * 1024;
/** Messages allowed per window before a connection is treated as abusive. */
const MESSAGE_BUDGET = 600;
const MESSAGE_WINDOW_MS = 10_000;
/** Runs whose audit events have been resolved to a project and repository. */
const MAX_CACHED_RUNS = 512;

interface CollabClient {
  socket: Duplex;
  reader: FrameReader;
  principal: WebSocketAuthorization["principal"];
  project: WebSocketAuthorization["project"];
  room: CollabRoom;
  participantId: string;
  closed: boolean;
  nextAuthorizationAt: number;
  budget: number;
  budgetResetAt: number;
}

interface RunContext {
  projectId: string | undefined;
  repositoryId: string;
  tasks: Map<string, { agentId: string; objective: string }>;
}

function fileSnapshot(value: unknown): {
  content: string;
  binary: boolean;
  truncated: boolean;
} {
  const record = value as Partial<{
    content: unknown;
    binary: unknown;
    truncated: unknown;
  }> | null;
  if (record === null || typeof record !== "object" || typeof record.content !== "string") {
    throw new CollabError("unreadable_file", "The workspace file could not be read");
  }
  return {
    content: record.content,
    binary: record.binary === true,
    truncated: record.truncated === true,
  };
}

function stringData(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fileList(data: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = data[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export class CollabWebSocketHub {
  private readonly rooms = new CollabRoomRegistry();
  private readonly clients = new Set<CollabClient>();
  private readonly byRoom = new Map<string, Set<CollabClient>>();
  private readonly runs = new Map<string, RunContext>();
  private readonly path: string;
  private readonly tickIntervalMs: number;
  private readonly reauthorizeIntervalMs: number;
  private readonly idleFlushMs: number;
  private readonly startedAt = new Date().toISOString();
  private auditCursor = 0;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  public constructor(
    private readonly store: CoordinationStore,
    private readonly options: CollabWebSocketOptions,
  ) {
    this.path = options.path ?? "/api/v1/collab";
    this.tickIntervalMs = options.tickIntervalMs ?? 1_000;
    this.reauthorizeIntervalMs = options.reauthorizeIntervalMs ?? 5_000;
    this.idleFlushMs = options.idleFlushMs ?? 300_000;
    for (const [name, value] of [
      ["tickIntervalMs", this.tickIntervalMs],
      ["reauthorizeIntervalMs", this.reauthorizeIntervalMs],
      ["idleFlushMs", this.idleFlushMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  /** Starts the background sweep. Upgrades are routed by the gateway. */
  public start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.ticking) {
        return;
      }
      this.ticking = true;
      void this.tick().finally(() => {
        this.ticking = false;
      });
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  /** Convenience for tests: routes every upgrade on `server` to this hub. */
  public attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      void this.tryUpgrade(request, socket, head)
        .then((claimed) => {
          if (!claimed && !socket.destroyed) {
            rejectUpgrade(socket, 404, "Not Found");
          }
        })
        .catch(() => {
          if (!socket.destroyed) {
            rejectUpgrade(socket, 500, "WebSocket upgrade failed");
          }
        });
    });
    this.start();
  }

  public close(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const client of [...this.clients]) {
      this.disconnect(client, 1001, "Server is shutting down");
    }
  }

  public get connections(): number {
    return this.clients.size;
  }

  public get roomCount(): number {
    return this.rooms.size;
  }

  /**
   * Handles an upgrade addressed to this hub.
   *
   * Returns false when the request is for a different endpoint, so the
   * gateway can offer it to the audit stream instead.
   */
  public async tryUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    let url: URL;
    try {
      // Only the origin-form path is needed; Host is untrusted and must never
      // become a URL parser input.
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      return false;
    }
    if (url.pathname !== this.path) {
      return false;
    }
    const projectId = url.searchParams.get("projectId") ?? "";
    const repositoryId = url.searchParams.get("repositoryId") ?? "";
    const filePath = url.searchParams.get("path") ?? "";
    if (
      projectId.length === 0 ||
      repositoryId.length === 0 ||
      filePath.length === 0 ||
      filePath.length > MAX_PATH_LENGTH
    ) {
      rejectUpgrade(socket, 400, "projectId, repositoryId and path are required");
      return true;
    }
    const handshake = {
      upgrade: request.headers.upgrade,
      version: request.headers["sec-websocket-version"],
      key: request.headers["sec-websocket-key"],
    };
    if (!isWebSocketHandshake(handshake)) {
      rejectUpgrade(socket, 400, "Invalid WebSocket request");
      return true;
    }
    const workspace = this.options.workspace;
    if (workspace === undefined) {
      rejectUpgrade(socket, 501, "This deployment does not support overlay workspaces");
      return true;
    }
    let authorization: WebSocketAuthorization;
    try {
      authorization = await this.options.authorize(request, projectId);
    } catch {
      rejectUpgrade(socket, 401, "Unauthorized");
      return true;
    }
    const selfUserId = authorization.principal.user.id;
    const scope: RoomScope = {
      projectId,
      repositoryId,
      ownerUserId: url.searchParams.get("owner") ?? selfUserId,
      path: filePath,
    };

    let room = this.rooms.get(scope);
    const guest = scope.ownerUserId !== selfUserId;
    if (guest) {
      // A draft in someone else's overlay is only reachable while they are
      // actually sitting in it. Knowing the path is not enough.
      const hosted =
        room !== undefined &&
        room.participants.some(
          (participant) => participant.userId === scope.ownerUserId,
        );
      if (!hosted) {
        rejectUpgrade(socket, 403, "That file is not being shared right now");
        return true;
      }
    }
    if (room === undefined) {
      let snapshot: { content: string; binary: boolean; truncated: boolean };
      try {
        snapshot = fileSnapshot(
          await workspace.readFile({
            projectId,
            repositoryId,
            userId: scope.ownerUserId,
            path: filePath,
          }),
        );
      } catch (error) {
        const status =
          typeof (error as { status?: unknown }).status === "number"
            ? ((error as { status: number }).status)
            : 500;
        rejectUpgrade(
          socket,
          status === 404 ? 404 : status === 409 ? 409 : 500,
          "The workspace file could not be opened",
        );
        return true;
      }
      if (snapshot.binary || snapshot.truncated) {
        rejectUpgrade(
          socket,
          415,
          "Binary and truncated files cannot be edited collaboratively",
        );
        return true;
      }
      room = this.rooms.create(scope, snapshot.content);
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(handshake.key)}\r\n\r\n`,
    );
    // Keystrokes are tiny and latency-sensitive; Nagle would batch them.
    (socket as Duplex & { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);

    const participant = room.join({
      participantId: randomUUID(),
      userId: selfUserId,
      displayName:
        authorization.principal.user.displayName.trim().length > 0
          ? authorization.principal.user.displayName
          : authorization.principal.user.id,
    });
    const client: CollabClient = {
      socket,
      reader: new FrameReader({
        maxMessageBytes: MAX_MESSAGE_BYTES,
        maxBufferBytes: MAX_MESSAGE_BYTES * 2,
      }),
      principal: authorization.principal,
      project: authorization.project,
      room,
      participantId: participant.id,
      closed: false,
      nextAuthorizationAt: Date.now() + this.reauthorizeIntervalMs,
      budget: MESSAGE_BUDGET,
      budgetResetAt: Date.now() + MESSAGE_WINDOW_MS,
    };
    this.clients.add(client);
    this.membersOf(room).add(client);
    room.touch();

    socket.on("data", (chunk: Buffer) => {
      void this.consume(client, chunk);
    });
    socket.on("close", () => {
      this.forget(client);
    });
    // A peer that goes away half-closes: `end` arrives, and `close` only
    // follows once this side is torn down too. Waiting for `close` would leave
    // a phantom participant behind every shut browser tab — and, worse, would
    // keep the room joinable by guests long after the owner left it.
    socket.on("end", () => {
      this.forget(client);
      socket.destroy();
    });
    socket.on("error", () => {
      this.forget(client);
      socket.destroy();
    });

    this.send(client, {
      type: "welcome",
      participantId: participant.id,
      revision: room.document.revision,
      content: room.document.content,
      participants: room.participants,
      agents: room.agentActivity,
      ownerUserId: scope.ownerUserId,
      path: scope.path,
      writable: true,
      dirty: room.dirty,
    });
    this.broadcast(room, { type: "join", participant }, client);
    if (guest) {
      await this.store
        .appendAudit(undefined, {
          type: "workspace_collaboration_joined",
          data: {
            projectId,
            repositoryId,
            actorId: selfUserId,
            ownerId: scope.ownerUserId,
            path: filePath,
          },
        })
        .catch(() => undefined);
    }
    if (head.length > 0) {
      void this.consume(client, head);
    }
    return true;
  }

  private membersOf(room: CollabRoom): Set<CollabClient> {
    const key = roomKey(room.scope);
    let members = this.byRoom.get(key);
    if (members === undefined) {
      members = new Set();
      this.byRoom.set(key, members);
    }
    return members;
  }

  private async consume(client: CollabClient, chunk: Buffer): Promise<void> {
    if (client.closed) {
      return;
    }
    const now = Date.now();
    if (now >= client.budgetResetAt) {
      client.budget = MESSAGE_BUDGET;
      client.budgetResetAt = now + MESSAGE_WINDOW_MS;
    }
    for (const event of client.reader.push(chunk)) {
      if (client.closed) {
        return;
      }
      switch (event.kind) {
        case "ping":
          client.socket.write(encodeFrame(OPCODE_PONG, event.payload));
          break;
        case "pong":
          break;
        case "close":
          this.disconnect(client, 1000, "Closed");
          return;
        case "fault":
          this.disconnect(client, event.code, event.reason);
          return;
        case "text": {
          client.budget -= 1;
          if (client.budget < 0) {
            this.disconnect(client, 1008, "Too many messages");
            return;
          }
          await this.handle(client, event.data);
          break;
        }
      }
    }
  }

  private async handle(client: CollabClient, raw: string): Promise<void> {
    const room = client.room;
    let message;
    try {
      message = parseClientMessage(raw);
    } catch (error) {
      this.sendError(client, error, true);
      return;
    }
    room.touch();
    try {
      switch (message.type) {
        case "op": {
          const growth = message.operation.targetLength - message.operation.baseLength;
          if (room.document.content.length + Math.max(growth, 0) > MAX_DOCUMENT_UNITS) {
            this.send(client, {
              type: "error",
              code: "document_too_large",
              message: `Documents larger than ${MAX_DOCUMENT_UNITS} characters cannot be edited collaboratively`,
              fatal: false,
            });
            return;
          }
          const applied = room.receive(
            client.participantId,
            message.revision,
            message.operation,
            message.selection,
          );
          this.send(client, { type: "ack", revision: applied.revision });
          this.broadcast(
            room,
            {
              type: "op",
              revision: applied.revision,
              operation: applied.operation.components,
              participantId: client.participantId,
            },
            client,
          );
          const sender = room.participant(client.participantId);
          if (sender?.selection !== undefined) {
            this.broadcast(
              room,
              {
                type: "selection",
                participantId: client.participantId,
                selection: sender.selection,
              },
              client,
            );
          }
          return;
        }
        case "selection": {
          const placed = room.setSelection(
            client.participantId,
            message.revision,
            message.selection,
          );
          if (placed === undefined) {
            return;
          }
          this.broadcast(
            room,
            {
              type: "selection",
              participantId: client.participantId,
              selection: placed,
            },
            client,
          );
          return;
        }
        case "save":
          await this.save(client);
          return;
        case "resync":
          this.resync(client);
          return;
      }
    } catch (error) {
      // A rebase failure means this client's view is unrecoverable; it
      // resynchronizes from a fresh snapshot rather than diverging silently.
      this.sendError(client, error, true);
    }
  }

  private async save(client: CollabClient): Promise<void> {
    const workspace = this.options.workspace;
    const room = client.room;
    if (workspace === undefined) {
      return;
    }
    const revision = room.document.revision;
    const content = room.document.content;
    try {
      await workspace.writeFile({
        projectId: room.scope.projectId,
        repositoryId: room.scope.repositoryId,
        // Always the overlay owner's worktree: a guest's save lands in the
        // workspace they were invited into, never in one of their own.
        userId: room.scope.ownerUserId,
        path: room.scope.path,
        content,
      });
    } catch (error) {
      this.sendError(client, error, false);
      return;
    }
    room.markSaved(revision);
    const savedBy = client.principal.user.id;
    this.broadcastAll(room, { type: "saved", revision, savedBy });
    await this.store
      .appendAudit(undefined, {
        type: "workspace_collaboration_saved",
        data: {
          projectId: room.scope.projectId,
          repositoryId: room.scope.repositoryId,
          actorId: savedBy,
          ownerId: room.scope.ownerUserId,
          path: room.scope.path,
          participants: room.size,
        },
      })
      .catch(() => undefined);
  }

  private resync(client: CollabClient): void {
    const room = client.room;
    this.send(client, {
      type: "welcome",
      participantId: client.participantId,
      revision: room.document.revision,
      content: room.document.content,
      participants: room.participants,
      agents: room.agentActivity,
      ownerUserId: room.scope.ownerUserId,
      path: room.scope.path,
      writable: true,
      dirty: room.dirty,
    });
  }

  private sendError(client: CollabClient, error: unknown, fatal: boolean): void {
    const code = error instanceof CollabError ? error.code : "internal_error";
    const message =
      error instanceof CollabError
        ? error.message
        : "The collaboration session hit an unexpected error";
    this.send(client, { type: "error", code, message, fatal });
  }

  private send(client: CollabClient, message: ServerMessage): void {
    if (
      client.closed ||
      client.socket.destroyed ||
      client.socket.writableLength > MAX_SOCKET_BUFFER
    ) {
      this.disconnect(client, 1008, "Client is too slow");
      return;
    }
    client.socket.write(encodeTextFrame(message));
  }

  private broadcast(
    room: CollabRoom,
    message: ServerMessage,
    except: CollabClient,
  ): void {
    for (const member of [...this.membersOf(room)]) {
      if (member !== except) {
        this.send(member, message);
      }
    }
  }

  private broadcastAll(room: CollabRoom, message: ServerMessage): void {
    for (const member of [...this.membersOf(room)]) {
      this.send(member, message);
    }
  }

  private forget(client: CollabClient): void {
    if (client.closed) {
      return;
    }
    client.closed = true;
    this.clients.delete(client);
    const room = client.room;
    const members = this.byRoom.get(roomKey(room.scope));
    members?.delete(client);
    room.leave(client.participantId);
    room.touch();
    this.broadcastAll(room, { type: "leave", participantId: client.participantId });
    if (room.size === 0) {
      this.byRoom.delete(roomKey(room.scope));
      // A clean room is free to rebuild from disk. A dirty one is somebody's
      // unsaved buffer and outlives them until the sweep flushes it, so that
      // closing a tab does not throw the text away.
      if (!room.dirty) {
        this.rooms.delete(room.scope);
      }
    }
  }

  private disconnect(client: CollabClient, code: number, reason: string): void {
    const socket = client.socket;
    this.forget(client);
    if (!socket.destroyed) {
      socket.end(encodeCloseFrame(code, reason));
    }
  }

  private async tick(): Promise<void> {
    await this.refreshAuthorizations();
    await this.pollAgentActivity();
    await this.flushIdleRooms();
  }

  private async refreshAuthorizations(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      [...this.clients].map(async (client) => {
        if (client.closed || now < client.nextAuthorizationAt) {
          return;
        }
        try {
          const refreshed = await this.options.reauthorize({
            principal: client.principal,
            project: client.project,
          });
          if (client.closed) {
            return;
          }
          client.principal = refreshed.principal;
          client.project = refreshed.project;
          client.nextAuthorizationAt = Date.now() + this.reauthorizeIntervalMs;
        } catch {
          this.disconnect(client, 1008, "Authorization is no longer valid");
        }
      }),
    );
  }

  /**
   * Surfaces an agent's unapproved, in-flight work on any open file.
   *
   * Read from the audit log rather than from agent worktrees, because that is
   * the one place where "a plan claims this file" and "a changeset touched
   * this file" are already recorded, for every adapter, before anything is
   * approved or promoted. The signal is file-level rather than character-level
   * — agents do not stream keystrokes — so the editor shows a badge and a
   * ghost participant, not a live caret.
   */
  private async pollAgentActivity(): Promise<void> {
    if (this.rooms.size === 0) {
      return;
    }
    let events;
    try {
      events = await this.store.listAuditEvents(
        this.auditCursor > 0
          ? { afterSequence: this.auditCursor, limit: 500 }
          : { occurredAfter: this.startedAt, limit: 500 },
      );
    } catch {
      return;
    }
    for (const record of events) {
      this.auditCursor = Math.max(this.auditCursor, record.sequence);
      const event = record.event;
      const data = event.data;
      const taskId = event.taskId;
      if (taskId === undefined) {
        continue;
      }
      if (event.type === "canonical_promoted" || event.type === "task_failed" || event.type === "task_cancelled") {
        for (const room of this.rooms.all()) {
          if (room.clearAgentActivity(taskId)) {
            this.broadcastAll(room, { type: "agents", agents: room.agentActivity });
          }
        }
        continue;
      }
      const stage =
        event.type === "plan_received"
          ? ("planned" as const)
          : event.type === "changeset_collected"
            ? ("changed" as const)
            : undefined;
      if (stage === undefined) {
        continue;
      }
      // A human's own overlay submission travels the same pipeline; it is not
      // an agent working behind their back.
      if (stringData(data, "source") === "workspace-submit") {
        continue;
      }
      const files =
        stage === "planned" ? fileList(data, "expectedFiles") : fileList(data, "files");
      if (files.length === 0) {
        continue;
      }
      const context = await this.runContext(record.runId, taskId);
      if (context === undefined) {
        continue;
      }
      const task = context.tasks.get(taskId);
      const activity: AgentActivity = {
        taskId,
        agentId: task?.agentId ?? stringData(data, "actorId") ?? "agent",
        stage,
        objective: task?.objective ?? "",
        occurredAt: event.occurredAt,
      };
      for (const room of this.rooms.all()) {
        if (
          room.scope.repositoryId !== context.repositoryId ||
          (context.projectId !== undefined &&
            room.scope.projectId !== context.projectId) ||
          !files.includes(room.scope.path)
        ) {
          continue;
        }
        if (room.noteAgentActivity(activity)) {
          this.broadcastAll(room, { type: "agents", agents: room.agentActivity });
        }
      }
    }
  }

  private async runContext(
    runId: string | undefined,
    taskId: string,
  ): Promise<RunContext | undefined> {
    if (runId === undefined) {
      return undefined;
    }
    const cached = this.runs.get(runId);
    // A run is created before its tasks are saved, so a cached context that is
    // missing the task is refreshed rather than trusted.
    if (cached !== undefined && cached.tasks.has(taskId)) {
      return cached;
    }
    let detail;
    try {
      detail = await this.store.getRun(runId);
    } catch {
      return undefined;
    }
    if (detail === undefined) {
      return cached;
    }
    const context: RunContext = {
      projectId: detail.run.projectId,
      repositoryId: detail.run.repositoryId,
      tasks: new Map(
        detail.tasks.map((task) => [
          task.id,
          { agentId: task.agentId, objective: task.objective },
        ]),
      ),
    };
    if (this.runs.size >= MAX_CACHED_RUNS) {
      const oldest = this.runs.keys().next();
      if (!oldest.done) {
        this.runs.delete(oldest.value);
      }
    }
    this.runs.set(runId, context);
    return context;
  }

  private async flushIdleRooms(): Promise<void> {
    const workspace = this.options.workspace;
    if (workspace === undefined) {
      return;
    }
    const deadline = Date.now() - this.idleFlushMs;
    for (const room of this.rooms.all()) {
      if (room.size > 0 || room.lastActivityAt > deadline) {
        continue;
      }
      if (room.dirty) {
        // Flushing writes into the owner's own private worktree — the same
        // thing their Ctrl+S does — and never touches canonical.
        try {
          await workspace.writeFile({
            projectId: room.scope.projectId,
            repositoryId: room.scope.repositoryId,
            userId: room.scope.ownerUserId,
            path: room.scope.path,
            content: room.document.content,
          });
          room.markSaved(room.document.revision);
        } catch {
          // Keep the room; the next sweep tries again rather than dropping
          // somebody's text because a write failed once.
          room.touch();
          continue;
        }
      }
      this.rooms.delete(room.scope);
    }
  }
}
