import {
  WORKER_PROTOCOL_VERSION,
  type WorkAssignment,
} from "@coord/cli/worker-operations";
import type { AgentTokenUsage } from "@coord/agent-protocol";
import type {
  AgentPlan,
  PlanAdmission,
  ScopeChangeDecision,
  ScopeChangeRequest,
} from "@coord/shared-types";

/**
 * HTTP client for the remote worker protocol.
 *
 * Every request carries the bearer token and no cookies, which is exactly how
 * a worker outside the control plane's network authenticates. See
 * docs/protocol/remote-workers.md.
 */

export class LeaseLostError extends Error {
  public constructor(leaseId: string) {
    super(
      `Lease ${leaseId} is no longer active. Another worker may hold this ` +
        "task, so work must stop immediately rather than be reported.",
    );
    this.name = "LeaseLostError";
  }
}

export class ControlPlaneError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

/**
 * Whether a failure was the connection rather than the request.
 *
 * The distinction decides a task's fate, so both places that need it read the
 * same predicate. The client retries these; a worker that still sees one after
 * the retries releases its lease instead of failing the task, because an
 * unreachable control plane says nothing about whether the work was any good.
 *
 * Timeouts are deliberately excluded. An aborted request may have been
 * received and acted on, so treating it as "never happened" could double-apply
 * a result. A connection that could not be established, or that the peer closed
 * under us, demonstrably carried nothing.
 *
 * A `ControlPlaneError` is an answer from a control plane that was reached, and
 * is never a transport failure however unwelcome its status.
 */
export function isTransportFailure(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    error.name === "AbortError" ||
    error instanceof ControlPlaneError
  ) {
    return false;
  }
  const codes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ENOTFOUND",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
  ]);
  const seen = new Set<unknown>();
  for (
    let cause: unknown = error;
    cause instanceof Error && !seen.has(cause);
    cause = (cause as { cause?: unknown }).cause
  ) {
    seen.add(cause);
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && codes.has(code)) {
      return true;
    }
    if (
      /socket hang up|other side closed|fetch failed|network error/iu.test(
        cause.message,
      )
    ) {
      return true;
    }
  }
  return false;
}

export interface WorkerIdentity {
  id: string;
  name: string;
  adapters: string[];
  version: string;
}

export interface WorkerClientOptions {
  serverUrl: string;
  token: string;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  /** Result posts can remain open while a human approval gate is pending. */
  resultTimeoutMs?: number;
  maxBundleBytes?: number;
  /**
   * Total tries for a request whose connection failed before it was sent.
   * One means the previous behaviour: no retry at all.
   */
  connectionAttempts?: number;
  /** First backoff between connection retries; doubles, with jitter. */
  connectionBackoffMs?: number;
}

export class WorkerClient {
  private readonly base: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly resultTimeoutMs: number;
  private readonly maxBundleBytes: number;
  private readonly connectionAttempts: number;
  private readonly connectionBackoffMs: number;

  public constructor(private readonly options: WorkerClientOptions) {
    const server = new URL(options.serverUrl);
    if (
      !["http:", "https:"].includes(server.protocol) ||
      server.username.length > 0 ||
      server.password.length > 0
    ) {
      throw new Error("Worker server URL must be credential-free HTTP or HTTPS");
    }
    this.base = server.href.replace(/\/+$/u, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.resultTimeoutMs =
      options.resultTimeoutMs ?? 25 * 60 * 60 * 1000;
    this.maxBundleBytes = options.maxBundleBytes ?? 256 * 1024 * 1024;
    this.connectionAttempts = options.connectionAttempts ?? 3;
    this.connectionBackoffMs = options.connectionBackoffMs ?? 250;
    for (const [name, value] of [
      ["requestTimeoutMs", this.timeoutMs],
      ["resultTimeoutMs", this.resultTimeoutMs],
      ["maxBundleBytes", this.maxBundleBytes],
      ["connectionAttempts", this.connectionAttempts],
      ["connectionBackoffMs", this.connectionBackoffMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  /**
   * One attempt, retried only when the connection itself failed.
   *
   * A control plane sharing a process with the workers it serves stalls its
   * event loop under load, and Node closes idle keep-alive sockets after five
   * seconds. The next request reuses a socket the server has already gone away
   * from, and fetch rejects before anything is sent. That is not a failure of
   * the request, it is a failure to make one, and it used to end a task
   * permanently: the worker reports any error inside a lease as `failed` and
   * the control plane does not retry. A ten-task live run lost seven tasks
   * that way, three of them with nothing to contend over.
   *
   * Only connection-level rejections are retried, and deliberately not
   * timeouts. An aborted request may have been received and acted on, so
   * repeating it could double-submit a result; a connection that was never
   * established cannot have been. HTTP error statuses are answers, not
   * failures, and are never retried either.
   */
  private async request(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      expectBinary?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<{ status: number; json?: unknown; bytes?: Buffer }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.connectionAttempts; attempt += 1) {
      try {
        return await this.attempt(path, init);
      } catch (error) {
        if (
          attempt === this.connectionAttempts ||
          !isTransportFailure(error)
        ) {
          throw error;
        }
        lastError = error;
        // Backoff with jitter: every worker in a fleet loses its keep-alive
        // sockets at the same moment when the server stalls, and retrying in
        // lockstep would reproduce the stall that closed them.
        const backoff = this.connectionBackoffMs * 2 ** (attempt - 1);
        // Deliberately not `unref`'d. This timer is the only thing that will
        // make progress: the request has failed, the retry is what resumes
        // it, and there may be a lease already claimed on the other side.
        // Unreffing it told Node the process was free to exit here, so a
        // worker with nothing else pending would drop the retry on the floor
        // and settle nothing — which is also why every test after the first
        // one to reach this line was cancelled rather than run.
        await new Promise((resolve) => {
          setTimeout(resolve, backoff + Math.random() * backoff);
        });
      }
    }
    throw lastError;
  }

  private async attempt(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      expectBinary?: boolean;
      timeoutMs?: number;
    },
  ): Promise<{ status: number; json?: unknown; bytes?: Buffer }> {
    const headers = new Headers({
      Authorization: `Bearer ${this.options.token}`,
    });
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const controller = new AbortController();
    // Cleared in the `finally` below, so it holds the process open only for
    // as long as the request it is bounding. Unreffing it instead meant the
    // deadline could be skipped entirely when nothing else kept the loop
    // alive — which is the one case a deadline exists for.
    const timer = setTimeout(
      () => controller.abort(),
      init.timeoutMs ?? this.timeoutMs,
    );
    try {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method ?? "GET",
        headers,
        signal: controller.signal,
        redirect: "error",
        ...(init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
      });

      if (response.status === 204) {
        return { status: 204 };
      }
      if (init.expectBinary === true && response.ok) {
        return {
          status: response.status,
          bytes: await this.readBundle(response),
        };
      }

      const text = await response.text();
      const json: unknown = text.length === 0 ? undefined : JSON.parse(text);
      if (!response.ok) {
        const error = (json as { error?: { code?: string; message?: string } })
          ?.error;
        throw new ControlPlaneError(
          response.status,
          error?.code ?? "request_failed",
          error?.message ?? `Request to ${path} failed with ${response.status}`,
        );
      }
      return { status: response.status, json };
    } finally {
      // A fetch resolves as soon as headers arrive. Keeping the deadline alive
      // through body parsing prevents a peer from holding a worker forever
      // with a response that starts promptly and then stalls.
      clearTimeout(timer);
    }
  }

  private async readBundle(response: Response): Promise<Buffer> {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const declaredLength = Number(contentLength);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 0
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Repository bundle has an invalid Content-Length");
      }
      if (declaredLength > this.maxBundleBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `Repository bundle exceeds ${this.maxBundleBytes} bytes`,
        );
      }
    }

    if (response.body === null) {
      return Buffer.alloc(0);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        const chunk = Buffer.from(next.value);
        total += chunk.byteLength;
        if (total > this.maxBundleBytes) {
          await reader.cancel("bundle size limit exceeded").catch(() => undefined);
          throw new Error(
            `Repository bundle exceeds ${this.maxBundleBytes} bytes`,
          );
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }

  public async register(input: {
    /** The organization whose fleet this worker joins. */
    organizationId: string;
    name: string;
    adapters: string[];
    version: string;
  }): Promise<WorkerIdentity> {
    const { json } = await this.request("/api/v1/workers/register", {
      method: "POST",
      body: input,
    });
    return json as WorkerIdentity;
  }

  /** Returns undefined when the queue is empty, signalled by a 204. */
  public async lease(
    workerId: string,
    projectId: string,
    repositoryId?: string,
    /**
     * What this worker can execute. Absent means work alone, which is what
     * every build before questions existed meant — and is the whole of the
     * compatibility story, since an older control plane simply ignores a
     * field it does not read while a newer one defaults to the same thing.
     */
    kinds?: readonly string[],
  ): Promise<WorkAssignment | undefined> {
    const { status, json } = await this.request("/api/v1/workers/leases", {
      method: "POST",
      body: {
        workerId,
        projectId,
        ...(repositoryId === undefined ? {} : { repositoryId }),
        ...(kinds === undefined ? {} : { kinds }),
      },
    });
    return status === 204 ? undefined : (json as WorkAssignment);
  }

  /**
   * Extends the lease, and carries the agent's running spend up with it.
   *
   * The usage rides on the heartbeat rather than getting an endpoint of its
   * own because the two answer the same question at the same moment: the
   * control plane is already deciding whether this task may keep going, and
   * what it has cost so far is part of that decision.
   */
  public async heartbeat(
    leaseId: string,
    tokenUsage: readonly AgentTokenUsage[] = [],
  ): Promise<void> {
    try {
      await this.request(`/api/v1/workers/leases/${leaseId}/heartbeat`, {
        method: "POST",
        ...(tokenUsage.length === 0 ? {} : { body: { tokenUsage } }),
      });
    } catch (error) {
      if (
        error instanceof ControlPlaneError &&
        (error.code === "lease_lost" || error.code === "budget_exceeded")
      ) {
        // Either way the control plane has withdrawn this lease; the task no
        // longer belongs to this worker and reporting would be refused.
        throw new LeaseLostError(leaseId);
      }
      throw error;
    }
  }

  /**
   * The repository snapshot for a lease.
   *
   * `have` names a commit this machine already holds, and the control plane
   * packs only what is missing above it. Omitted on a first fetch, and
   * ignored by a control plane too old to read it — which then sends the
   * whole history exactly as before, so an upgrade in either direction is
   * safe on its own.
   */
  public async bundle(leaseId: string, have?: string): Promise<Buffer> {
    const { bytes } = await this.request(
      `/api/v1/workers/leases/${leaseId}/bundle${
        have === undefined ? "" : `?have=${encodeURIComponent(have)}`
      }`,
      { expectBinary: true },
    );
    if (bytes === undefined) {
      throw new Error(`Control plane returned no bundle for lease ${leaseId}`);
    }
    return bytes;
  }

  /**
   * Submits a plan for admission before any editing.
   *
   * The answer is the coordinator's, not an acknowledgement: only an approved
   * status licenses the worker to spend agent execution time.
   */
  /**
   * Asks for the whole repository before paying to plan it.
   *
   * The one call in the protocol whose ordinary answer is "no". A control
   * plane that says nothing — 204, a route it does not have, a version too
   * old, blanket claims switched off, somebody else already in the repository
   * — leaves the worker planning exactly as it did before this existed, so
   * every failure here is a fall-through rather than an error.
   *
   * The protocol version travels in the body because the grant depends on it:
   * a claim can be narrowed while it is held, and a worker that could not be
   * told about that must never be given one.
   */
  public async claimRepository(
    leaseId: string,
  ): Promise<AgentPlan | undefined> {
    try {
      const { json, status } = await this.request(
        `/api/v1/workers/leases/${leaseId}/claim`,
        {
          method: "POST",
          body: { protocolVersion: WORKER_PROTOCOL_VERSION },
        },
      );
      if (status === 204) {
        return undefined;
      }
      const plan = (json as { plan?: AgentPlan } | undefined)?.plan;
      return plan === undefined ? undefined : plan;
    } catch {
      return undefined;
    }
  }

  public async submitPlan(
    leaseId: string,
    plan: AgentPlan,
  ): Promise<PlanAdmission> {
    try {
      const { json } = await this.request(
        `/api/v1/workers/leases/${leaseId}/plan`,
        { method: "POST", body: { plan } },
      );
      const admission = (json as { admission?: PlanAdmission } | undefined)
        ?.admission;
      if (admission === undefined) {
        throw new Error(
          `Control plane returned no admission for lease ${leaseId}`,
        );
      }
      return admission;
    } catch (error) {
      if (
        error instanceof ControlPlaneError &&
        (error.code === "lease_lost" || error.code === "budget_exceeded")
      ) {
        throw new LeaseLostError(leaseId);
      }
      throw error;
    }
  }

  /**
   * Asks the coordinator to widen the admitted scope, mid-execution.
   *
   * Uses the long result timeout rather than the ordinary request timeout: a
   * project may gate the expansion on a reviewer, and the control plane holds
   * the request open while that person decides, exactly as it does for a
   * gated changeset.
   */
  public async requestScopeChange(
    leaseId: string,
    request: ScopeChangeRequest,
  ): Promise<ScopeChangeDecision> {
    try {
      const { json } = await this.request(
        `/api/v1/workers/leases/${leaseId}/scope`,
        {
          method: "POST",
          body: { request },
          timeoutMs: this.resultTimeoutMs,
        },
      );
      const decision = (json as { decision?: ScopeChangeDecision } | undefined)
        ?.decision;
      if (decision === undefined) {
        throw new Error(
          `Control plane returned no scope decision for lease ${leaseId}`,
        );
      }
      return decision;
    } catch (error) {
      if (
        error instanceof ControlPlaneError &&
        (error.code === "lease_lost" || error.code === "budget_exceeded")
      ) {
        throw new LeaseLostError(leaseId);
      }
      throw error;
    }
  }

  public async report(
    leaseId: string,
    result:
      | {
          status: "completed";
          plan: unknown;
          changeSet: unknown;
          detail?: string;
          /**
           * What the agent said, when the lease was on a question.
           *
           * Its own field rather than `detail`, which is a short failure
           * reason the control plane caps at 2000 characters and *throws* on
           * rather than clipping — and the worker turns any error inside a
           * lease into a failed task, so a long answer sent as `detail` would
           * reach the room as a failure.
           */
          answer?: string;
        }
      | { status: "failed"; detail: string },
    tokenUsage: readonly AgentTokenUsage[] = [],
  ): Promise<{ accepted: boolean; reason?: string }> {
    const { json } = await this.request(
      `/api/v1/workers/leases/${leaseId}/result`,
      {
        method: "POST",
        // Final spend travels with the result so the last of it is recorded
        // even when the run finished between two heartbeats.
        body: {
          ...result,
          ...(tokenUsage.length === 0 ? {} : { tokenUsage }),
        },
        timeoutMs: this.resultTimeoutMs,
      },
    );
    return (json as { accepted: boolean; reason?: string }) ?? { accepted: true };
  }

  public async release(leaseId: string): Promise<void> {
    await this.request(`/api/v1/workers/leases/${leaseId}/release`, {
      method: "POST",
    });
  }

  /**
   * The agent's own words, forwarded while the work is still happening.
   *
   * Never awaited by the run and never allowed to fail it: this is the line
   * that makes a thread look alive, and a thread looking dead is better than
   * a task dying because a courtesy could not be delivered. A control plane
   * too old to know the route answers 404, which lands here as a swallowed
   * error rather than as a broken worker.
   */
  public async progress(leaseId: string, message: string): Promise<void> {
    try {
      await this.request(`/api/v1/workers/leases/${leaseId}/progress`, {
        method: "POST",
        body: { message },
      });
    } catch {
      // Deliberately silent. See above.
    }
  }
}
