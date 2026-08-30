/**
 * Waiting for work without asking for it.
 *
 * The worker polls every five seconds and that is what actually claims a task.
 * This shortens the waiting half: the control plane pushes a bare "ask again"
 * when something is submitted, so a task that lands a moment after a poll is
 * picked up now rather than at the end of the interval.
 *
 * ### Every failure here is a slower worker, never a wrong one
 *
 * No ticket, no socket, a dropped connection, a message that never arrives —
 * each one lands in the same place: {@link WorkNudge.wait} sleeps the full
 * interval and the next poll behaves exactly as it did before any of this
 * existed. That is the property that makes it safe to add to a claim path, and
 * it is why nothing in here retries hard or reports upward. It is also why the
 * message carries no task: the socket says *that* there is work, and the
 * worker still goes and asks *for* it over the authorized HTTP path.
 */

/** How long to wait before dialling again after the socket drops. */
const RECONNECT_DELAYS_MS = [1_000, 5_000, 15_000, 30_000];

export interface WorkNudgeOptions {
  serverUrl: string;
  token: string;
  organizationId: string;
  /** Injected by tests. Defaults to the global from Node 22 onward. */
  socketFactory?: (url: string) => WebSocketLike;
  fetchImpl?: typeof fetch;
}

/** The slice of the WebSocket API this uses, so a test can stand one up. */
export interface WebSocketLike {
  close: () => void;
  onopen: ((this: unknown, event: unknown) => unknown) | null;
  onmessage: ((this: unknown, event: { data: unknown }) => unknown) | null;
  onclose: ((this: unknown, event: unknown) => unknown) | null;
  onerror: ((this: unknown, event: unknown) => unknown) | null;
}

export class WorkNudge {
  private socket: WebSocketLike | undefined;
  private stopped = false;
  private attempts = 0;
  private timer: NodeJS.Timeout | undefined;
  /** Resolvers for callers currently inside `wait`. */
  private waiters = new Set<() => void>();
  /**
   * A nudge that arrived while nobody was waiting.
   *
   * Without this a message delivered during an iteration would be dropped, and
   * the worker would then sleep a full interval having just been told there
   * was work. Latched rather than queued: one pending "ask again" is the same
   * instruction as ten.
   */
  private pending = false;

  public constructor(private readonly options: WorkNudgeOptions) {}

  public start(): void {
    this.stopped = false;
    void this.connect();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    this.release();
  }

  /**
   * Sleeps, unless the control plane says not to bother.
   *
   * Resolves early on a nudge, on a nudge that arrived just before the call,
   * or after `ms` — whichever comes first.
   */
  public async wait(ms: number): Promise<void> {
    if (this.pending || this.stopped) {
      this.pending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.waiters.delete(finish);
        clearTimeout(timer);
        resolve();
      };
      // Deliberately not unref'd. This replaces a plain `setTimeout` in the
      // poll loop, and an unref'd timer would let the process exit out from
      // under an idle worker that is only sleeping between polls.
      const timer = setTimeout(finish, ms);
      this.waiters.add(finish);
    });
  }

  private release(): void {
    for (const waiter of [...this.waiters]) {
      waiter();
    }
    this.waiters.clear();
  }

  private async ticket(): Promise<string | undefined> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(
      new URL("/api/v1/auth/ws-ticket", this.options.serverUrl),
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.token}` },
      },
    );
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { ticket?: unknown };
    return typeof body.ticket === "string" ? body.ticket : undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket !== undefined) {
      return;
    }
    let url: string;
    try {
      const ticket = await this.ticket();
      if (ticket === undefined) {
        this.retry();
        return;
      }
      const address = new URL(
        "/api/v1/workers/events",
        this.options.serverUrl,
      );
      address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
      address.searchParams.set("organizationId", this.options.organizationId);
      address.searchParams.set("ticket", ticket);
      url = address.toString();
    } catch {
      this.retry();
      return;
    }
    if (this.stopped) {
      return;
    }

    try {
      const factory =
        this.options.socketFactory ??
        ((target: string) => new WebSocket(target) as unknown as WebSocketLike);
      const socket = factory(url);
      this.socket = socket;
      socket.onopen = () => {
        this.attempts = 0;
      };
      socket.onmessage = (event) => {
        // The payload is not parsed for meaning. There is exactly one thing
        // this socket says, and treating any frame as that keeps a change to
        // the message shape from silently turning the nudge off.
        this.pending = true;
        this.release();
      };
      socket.onclose = () => {
        this.socket = undefined;
        this.retry();
      };
      socket.onerror = () => {
        this.socket?.close();
        this.socket = undefined;
        this.retry();
      };
    } catch {
      this.socket = undefined;
      this.retry();
    }
  }

  private retry(): void {
    if (this.stopped || this.timer !== undefined) {
      return;
    }
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1] ??
      30_000;
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
    this.timer.unref?.();
  }
}
