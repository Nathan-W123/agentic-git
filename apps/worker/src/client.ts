import type { WorkAssignment } from "@coord/cli/worker-operations";
import type { AgentPlan, PlanAdmission } from "@coord/shared-types";

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
}

export class WorkerClient {
  private readonly base: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly resultTimeoutMs: number;
  private readonly maxBundleBytes: number;

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
    for (const [name, value] of [
      ["requestTimeoutMs", this.timeoutMs],
      ["resultTimeoutMs", this.resultTimeoutMs],
      ["maxBundleBytes", this.maxBundleBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  private async request(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      expectBinary?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<{ status: number; json?: unknown; bytes?: Buffer }> {
    const headers = new Headers({
      Authorization: `Bearer ${this.options.token}`,
    });
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      init.timeoutMs ?? this.timeoutMs,
    );
    timer.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method ?? "GET",
        headers,
        signal: controller.signal,
        redirect: "error",
        ...(init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) {
      return { status: 204 };
    }
    if (init.expectBinary === true && response.ok) {
      const declaredLength = Number.parseInt(
        response.headers.get("content-length") ?? "",
        10,
      );
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > this.maxBundleBytes
      ) {
        throw new Error(
          `Repository bundle exceeds ${this.maxBundleBytes} bytes`,
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > this.maxBundleBytes) {
        throw new Error(
          `Repository bundle exceeds ${this.maxBundleBytes} bytes`,
        );
      }
      return {
        status: response.status,
        bytes,
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
  }

  public async register(input: {
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
  ): Promise<WorkAssignment | undefined> {
    const { status, json } = await this.request("/api/v1/workers/leases", {
      method: "POST",
      body: {
        workerId,
        projectId,
        ...(repositoryId === undefined ? {} : { repositoryId }),
      },
    });
    return status === 204 ? undefined : (json as WorkAssignment);
  }

  public async heartbeat(leaseId: string): Promise<void> {
    try {
      await this.request(`/api/v1/workers/leases/${leaseId}/heartbeat`, {
        method: "POST",
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

  public async bundle(leaseId: string): Promise<Buffer> {
    const { bytes } = await this.request(
      `/api/v1/workers/leases/${leaseId}/bundle`,
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

  public async report(
    leaseId: string,
    result:
      | {
          status: "completed";
          plan: unknown;
          changeSet: unknown;
          detail?: string;
        }
      | { status: "failed"; detail: string },
  ): Promise<{ accepted: boolean; reason?: string }> {
    const { json } = await this.request(
      `/api/v1/workers/leases/${leaseId}/result`,
      {
        method: "POST",
        body: result,
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
}
