/**
 * Terminal sessions, held between a browser and somebody's own machine.
 *
 * The shell runs on a worker — see `apps/worker/src/pty.ts` for why — and the
 * worker speaks HTTP request/response, not WebSocket. So the control plane is
 * the meeting point: the browser posts keystrokes here and reads output here,
 * the worker collects keystrokes here and posts output here, and neither ever
 * addresses the other.
 *
 * That shape decides everything below.
 *
 * **Sessions are memory, not rows.** A session is a live process on a machine
 * that may close its lid. It cannot outlive the worker holding it, so
 * persisting it would only produce records describing shells that no longer
 * exist. A control-plane restart ends every session, which is correct and is
 * what a reader is told.
 *
 * **Output is a bounded ring.** A `yes` typed into a terminal produces
 * megabytes a second, and this process serves everybody. What is kept is the
 * last {@link MAX_OUTPUT_BYTES}, which is a screen's worth of scrollback and
 * not a transcript — a reader who leaves and comes back gets the end, and is
 * told the middle was dropped rather than shown a seamless lie.
 *
 * **Every read is by sequence number.** The browser polls, and polls twice
 * where a network hiccups, so "what is new" has to be a question with a
 * stable answer rather than "whatever has arrived since I last asked".
 */

import { randomUUID } from "node:crypto";

/** How much of a session's output is kept for a reader who comes back. */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/** How much unread input one session may hold before it is refused. */
const MAX_PENDING_INPUT = 64 * 1024;

/** A session nobody has read or typed into for this long is finished. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** How long a worker's poll is held open before answering empty. */
export const WORKER_POLL_MS = 25_000;

/** What a machine says it can offer, reported rather than assumed. */
export interface TerminalCapability {
  /**
   * How a terminal is obtained there, which decides what works inside it.
   *
   * Carried all the way to the browser because a reader who cannot run a
   * full-screen program should be told, not left to discover it.
   */
  backend: "python" | "script" | "pipes";
  shells: { id: string; label: string }[];
}

export interface TerminalSessionView {
  id: string;
  workerId: string;
  workerName: string;
  repositoryId: string;
  branch?: string;
  shell: string;
  cols: number;
  rows: number;
  backend?: TerminalCapability["backend"];
  createdAt: string;
  /** Set once the shell has gone, with the status it went with. */
  exitCode?: number;
  /** Why it ended, where that is not simply the shell exiting. */
  ended?: string;
}

interface Session extends TerminalSessionView {
  userId: string;
  projectId: string;
  cwdRepositoryId: string;
  /** Ring of output, oldest first, with the sequence of the first entry. */
  chunks: string[];
  firstSeq: number;
  bytes: number;
  /** True once anything has been dropped, so the reader can be told. */
  truncated: boolean;
  /** Typed but not yet collected by the worker. */
  pendingInput: string[];
  pendingBytes: number;
  /** A resize the worker has not applied yet; only the latest matters. */
  pendingResize?: { cols: number; rows: number };
  /** Set when the browser asked to close and the worker has not seen it. */
  closing: boolean;
  /** Set once the worker has picked this session up. */
  started: boolean;
  lastTouchedAt: number;
}

/** What a worker is handed when it polls. */
export interface TerminalWork {
  open: {
    id: string;
    repositoryId: string;
    branch?: string;
    shell: string;
    cols: number;
    rows: number;
  }[];
  input: { id: string; data: string }[];
  resize: { id: string; cols: number; rows: number }[];
  close: string[];
}

export class TerminalSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly capabilities = new Map<string, TerminalCapability>();
  /** Workers waiting on a poll, so new work wakes them rather than waits. */
  private readonly waiting = new Map<string, (() => void)[]>();

  /** Records what a machine can do, refreshed every time it says so. */
  public describeWorker(workerId: string, capability: TerminalCapability): void {
    this.capabilities.set(workerId, capability);
  }

  public capabilityOf(workerId: string): TerminalCapability | undefined {
    return this.capabilities.get(workerId);
  }

  public open(input: {
    userId: string;
    projectId: string;
    repositoryId: string;
    branch?: string;
    workerId: string;
    workerName: string;
    shell: string;
    cols: number;
    rows: number;
  }): TerminalSessionView {
    this.sweep();
    const capability = this.capabilities.get(input.workerId);
    const session: Session = {
      id: `term_${randomUUID()}`,
      userId: input.userId,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      cwdRepositoryId: input.repositoryId,
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      workerId: input.workerId,
      workerName: input.workerName,
      shell: input.shell,
      cols: input.cols,
      rows: input.rows,
      ...(capability === undefined ? {} : { backend: capability.backend }),
      createdAt: new Date().toISOString(),
      chunks: [],
      firstSeq: 0,
      bytes: 0,
      truncated: false,
      pendingInput: [],
      pendingBytes: 0,
      closing: false,
      started: false,
      lastTouchedAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.wake(input.workerId);
    return view(session);
  }

  /**
   * One session, if it belongs to this person.
   *
   * Ownership is the whole check. A session is a shell on somebody's machine
   * opened at somebody's request, and the id is the only thing addressing it,
   * so a reader who is not its owner is told it does not exist rather than
   * which of the two it is.
   */
  public own(sessionId: string, userId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    return session !== undefined && session.userId === userId
      ? session
      : undefined;
  }

  public listFor(userId: string, repositoryId?: string): TerminalSessionView[] {
    this.sweep();
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.userId === userId &&
          (repositoryId === undefined || session.repositoryId === repositoryId),
      )
      .map(view);
  }

  /** What the reader has not seen, from a sequence number they name. */
  public read(
    session: Session,
    after: number,
  ): { data: string; seq: number; truncated: boolean } {
    session.lastTouchedAt = Date.now();
    const from = Math.max(after, session.firstSeq);
    const skipped = from - session.firstSeq;
    const data = session.chunks.slice(skipped).join("");
    return {
      data,
      seq: session.firstSeq + session.chunks.length,
      // Said when the reader asked for something already dropped, which is
      // the only moment the gap is theirs rather than the buffer's.
      truncated: after < session.firstSeq && after > 0,
    };
  }

  public type(session: Session, data: string): boolean {
    if (session.pendingBytes + data.length > MAX_PENDING_INPUT) {
      // A worker that has stopped collecting is one whose machine has gone.
      // Refusing is better than growing until this process runs out.
      return false;
    }
    session.pendingInput.push(data);
    session.pendingBytes += data.length;
    session.lastTouchedAt = Date.now();
    this.wake(session.workerId);
    return true;
  }

  public resize(session: Session, cols: number, rows: number): void {
    session.cols = cols;
    session.rows = rows;
    // Only the latest shape matters: a reader dragging a pane produces
    // dozens of these and the shell only ever needed the one it ended on.
    session.pendingResize = { cols, rows };
    session.lastTouchedAt = Date.now();
    this.wake(session.workerId);
  }

  public close(session: Session, reason?: string): void {
    session.closing = true;
    if (reason !== undefined) {
      session.ended = reason;
    }
    session.lastTouchedAt = Date.now();
    this.wake(session.workerId);
  }

  /** Output from the machine, appended and trimmed to the ring. */
  public append(sessionId: string, workerId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.workerId !== workerId) {
      return false;
    }
    session.chunks.push(data);
    session.bytes += data.length;
    session.lastTouchedAt = Date.now();
    while (session.bytes > MAX_OUTPUT_BYTES && session.chunks.length > 1) {
      const dropped = session.chunks.shift() ?? "";
      session.bytes -= dropped.length;
      session.firstSeq += 1;
      session.truncated = true;
    }
    return true;
  }

  public finish(sessionId: string, workerId: string, exitCode: number): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.workerId !== workerId) {
      return;
    }
    session.exitCode = exitCode;
    session.closing = true;
    session.lastTouchedAt = Date.now();
  }

  /** Everything one worker owes attention to, and nothing anyone else's. */
  public collect(workerId: string): TerminalWork {
    this.sweep();
    const work: TerminalWork = { open: [], input: [], resize: [], close: [] };
    for (const session of this.sessions.values()) {
      if (session.workerId !== workerId) {
        continue;
      }
      if (session.closing) {
        // A session closed before the worker ever saw it never needs opening,
        // and telling it to close something it does not have is noise.
        if (session.started) {
          work.close.push(session.id);
        }
        this.sessions.delete(session.id);
        continue;
      }
      if (!session.started) {
        session.started = true;
        work.open.push({
          id: session.id,
          repositoryId: session.cwdRepositoryId,
          ...(session.branch === undefined ? {} : { branch: session.branch }),
          shell: session.shell,
          cols: session.cols,
          rows: session.rows,
        });
      }
      if (session.pendingInput.length > 0) {
        work.input.push({ id: session.id, data: session.pendingInput.join("") });
        session.pendingInput = [];
        session.pendingBytes = 0;
      }
      if (session.pendingResize !== undefined) {
        work.resize.push({ id: session.id, ...session.pendingResize });
        delete session.pendingResize;
      }
    }
    return work;
  }

  public hasWork(work: TerminalWork): boolean {
    return (
      work.open.length > 0 ||
      work.input.length > 0 ||
      work.resize.length > 0 ||
      work.close.length > 0
    );
  }

  /**
   * Waits for this worker to have something to do.
   *
   * A poll that answered immediately would be a busy loop on somebody's
   * laptop; one that never answered would look like a hang. So it waits, and
   * anything arriving for this worker wakes it early.
   */
  public async waitForWork(workerId: string, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        const list = this.waiting.get(workerId) ?? [];
        const index = list.indexOf(finish);
        if (index !== -1) {
          list.splice(index, 1);
        }
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      const list = this.waiting.get(workerId) ?? [];
      list.push(finish);
      this.waiting.set(workerId, list);
    });
  }

  private wake(workerId: string): void {
    const list = this.waiting.get(workerId);
    if (list === undefined) {
      return;
    }
    this.waiting.delete(workerId);
    for (const resolve of list) {
      resolve();
    }
  }

  /** Drops sessions nobody is reading and nothing is writing. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastTouchedAt > IDLE_TIMEOUT_MS) {
        session.closing = true;
        session.ended = "This session was idle for too long and was closed.";
        if (!session.started) {
          this.sessions.delete(id);
        }
      }
    }
  }

  /** Every session on a machine that has gone, ended rather than left open. */
  public endForWorker(workerId: string, reason: string): void {
    for (const [id, session] of this.sessions) {
      if (session.workerId === workerId) {
        session.ended = reason;
        session.closing = true;
        this.sessions.delete(id);
      }
    }
    this.capabilities.delete(workerId);
  }
}

function view(session: Session): TerminalSessionView {
  return {
    id: session.id,
    workerId: session.workerId,
    workerName: session.workerName,
    repositoryId: session.repositoryId,
    ...(session.branch === undefined ? {} : { branch: session.branch }),
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    ...(session.backend === undefined ? {} : { backend: session.backend }),
    createdAt: session.createdAt,
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    ...(session.ended === undefined ? {} : { ended: session.ended }),
  };
}
