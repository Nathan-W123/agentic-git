import type { WorkAssignment } from "@coord/cli/worker-operations";

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
}

export class WorkerClient {
  private readonly base: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  public constructor(private readonly options: WorkerClientOptions) {
    this.base = options.serverUrl.replace(/\/+$/u, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private async request(
    path: string,
    init: { method?: string; body?: unknown; expectBinary?: boolean } = {},
  ): Promise<{ status: number; json?: unknown; bytes?: Buffer }> {
    const headers = new Headers({
      Authorization: `Bearer ${this.options.token}`,
    });
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method ?? "GET",
        headers,
        signal: controller.signal,
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
      return {
        status: response.status,
        bytes: Buffer.from(await response.arrayBuffer()),
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
    repositoryId?: string,
  ): Promise<WorkAssignment | undefined> {
    const { status, json } = await this.request("/api/v1/workers/leases", {
      method: "POST",
      body: {
        workerId,
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
      if (error instanceof ControlPlaneError && error.code === "lease_lost") {
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

  public async report(
    leaseId: string,
    result:
      | { status: "completed"; changeSet: unknown; detail?: string }
      | { status: "failed"; detail: string },
  ): Promise<{ accepted: boolean; reason?: string }> {
    const { json } = await this.request(
      `/api/v1/workers/leases/${leaseId}/result`,
      { method: "POST", body: result },
    );
    return (json as { accepted: boolean; reason?: string }) ?? { accepted: true };
  }

  public async release(leaseId: string): Promise<void> {
    await this.request(`/api/v1/workers/leases/${leaseId}/release`, {
      method: "POST",
    });
  }
}
