import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import test, { type TestContext } from "node:test";

import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
  type CoordinationStore,
} from "@coord/persistence";

import { ApiGateway, type ApiOperations } from "./server.js";
import { hashPassword } from "./auth.js";

const BOOTSTRAP_TOKEN = "bootstrap-token-with-at-least-24-characters";
const PASSWORD = "RelayPassword123!";

interface TestRuntime {
  gateway: ApiGateway;
  store: CoordinationStore;
  origin: string;
  port: number;
}

class TestClient {
  private readonly cookies = new Map<string, string>();

  public constructor(private readonly origin: string) {}

  public get cookieHeader(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  public async request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      csrf?: boolean;
    } = {},
  ): Promise<{ status: number; data: any; headers: Headers }> {
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers ?? {});
    if (this.cookieHeader.length > 0) {
      headers.set("Cookie", this.cookieHeader);
    }
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (
      options.csrf !== false &&
      !["GET", "HEAD", "OPTIONS"].includes(method) &&
      this.cookies.has("coord_csrf")
    ) {
      headers.set("X-CSRF-Token", this.cookies.get("coord_csrf") ?? "");
    }
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(";", 1);
      const separator = pair?.indexOf("=") ?? -1;
      if (pair === undefined || separator < 1) {
        continue;
      }
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value.length === 0) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    const contentType = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      data: contentType.includes("application/json")
        ? await response.json()
        : await response.text(),
      headers: response.headers,
    };
  }
}

async function rawHttp(port: number, request: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for raw HTTP response"));
    }, 4_000);
    socket.once("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function startRuntime(
  t: TestContext,
  options: { allowedOrigins?: readonly string[] } = {},
): Promise<TestRuntime> {
  const store = new InMemoryCoordinationStore();
  const operations: ApiOperations = {
    async listAgents() {
      return [
        { id: "test-agent", adapter: "generic-cli", default: true },
      ];
    },
    async importGitHub(input) {
      const repository = {
        id: input.id ?? "imported",
        path: "/canonical/imported.git",
        branch: input.branch ?? "main",
        provider: "github" as const,
        remoteUrl: `https://github.com/${input.repository}.git`,
      };
      await store.saveRepository(repository);
      await store.linkRepository(input.projectId, repository.id);
      return repository;
    },
    async submitTask(input) {
      return await store.submitTask({
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        objective: input.objective,
        agentId: input.agentId ?? "test-agent",
        validationCommands: [],
        submittedBy: input.actorId,
      });
    },
    async runRepository() {},
    async projectMetrics(input) {
      return { stub: true, projectId: input.projectId };
    },
    async leaseWork(input) {
      const leased = await store.leaseNextTask({
        workerId: input.workerId,
        projectId: input.projectId,
        baseRevision: "a".repeat(40),
        ttlMs: 5 * 60 * 1000,
        ...(input.repositoryId === undefined
          ? {}
          : { repositoryId: input.repositoryId }),
      });
      if (leased === undefined) {
        return undefined;
      }
      return {
        lease: leased.lease,
        task: leased.task,
        repository: { id: leased.task.repositoryId, branch: "main" },
        canonicalVersion: {
          sequence: 1,
          revision: "a".repeat(40),
          branch: "main",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        bundleUrl: `/api/v1/workers/leases/${leased.lease.id}/bundle`,
        bundleRef: `coord-lease/${leased.lease.id}`,
        heartbeatIntervalMs: 60_000,
      };
    },
    async leaseBundle() {
      return Buffer.from("PACK-placeholder");
    },
    async acceptWorkResult(input) {
      await store.finishWorkLease(
        input.leaseId,
        input.status,
        new Date().toISOString(),
        input.detail,
      );
      return { accepted: true };
    },
  };
  const gateway = new ApiGateway({
    store,
    operations,
    bootstrapToken: BOOTSTRAP_TOKEN,
    ...(options.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: options.allowedOrigins }),
    staticAssets: new Map([
      [
        "/index.html",
        { body: "<!doctype html><title>Relay</title>", contentType: "text/html" },
      ],
    ]),
  });
  await new Promise<void>((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(0, "127.0.0.1", resolve);
  });
  const address = gateway.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test gateway did not bind a TCP port");
  }
  t.after(async () => {
    await gateway.close();
    await store.close();
  });
  return {
    gateway,
    store,
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
  };
}

async function bootstrap(client: TestClient): Promise<any> {
  const response = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(response.status, 201);
  return response.data;
}

test("bootstrap, sessions, CSRF, static fallback, and logout work over HTTP", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);

  const initialHealth = await client.request("/api/v1/health");
  assert.equal(initialHealth.status, 200);
  assert.equal(initialHealth.data.setupRequired, true);

  const setup = await bootstrap(client);
  assert.equal(setup.user.email, "owner@example.com");
  assert.match(client.cookieHeader, /coord_session=/u);
  assert.match(client.cookieHeader, /coord_csrf=/u);

  const me = await client.request("/api/v1/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.displayName, "Owner");

  const missingCsrf = await client.request("/api/v1/organizations", {
    method: "POST",
    csrf: false,
    body: { slug: "blocked", name: "Blocked" },
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal(missingCsrf.data.error.code, "csrf_failed");

  const created = await client.request("/api/v1/organizations", {
    method: "POST",
    body: { slug: "new-team", name: "New team" },
  });
  assert.equal(created.status, 201);

  const invalidEmail = await client.request("/api/v1/admin/users", {
    method: "POST",
    body: {
      email: "not-an-email",
      displayName: "Invalid",
      password: PASSWORD,
    },
  });
  assert.equal(invalidEmail.status, 400);
  assert.equal(invalidEmail.data.error.code, "invalid_email");

  const staticPage = await client.request("/some/client/route");
  assert.equal(staticPage.status, 200);
  assert.equal(staticPage.headers.get("cache-control"), "no-cache");
  assert.equal(staticPage.headers.get("content-security-policy")?.includes("object-src 'none'"), true);
  const etag = staticPage.headers.get("etag");
  assert.ok(etag);
  const unchangedPage = await client.request("/some/client/route", {
    headers: { "If-None-Match": etag },
  });
  assert.equal(unchangedPage.status, 304);

  const logout = await client.request("/api/v1/auth/logout", {
    method: "POST",
    body: {},
  });
  assert.equal(logout.status, 200);
  assert.equal((await client.request("/api/v1/auth/me")).status, 401);
});

test("project authorization isolates tenants and enforces viewer permissions", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const firstOrganization = await owner.request("/api/v1/organizations", {
    method: "POST",
    body: { slug: "first", name: "First" },
  });
  const secondOrganization = await owner.request("/api/v1/organizations", {
    method: "POST",
    body: { slug: "second", name: "Second" },
  });
  const firstId = firstOrganization.data.organization.id;
  const secondId = secondOrganization.data.organization.id;
  const firstProject = await owner.request(
    `/api/v1/organizations/${firstId}/projects`,
    {
      method: "POST",
      body: { slug: "project-a", name: "Project A" },
    },
  );
  const secondProject = await owner.request(
    `/api/v1/organizations/${secondId}/projects`,
    {
      method: "POST",
      body: { slug: "project-b", name: "Project B" },
    },
  );
  const user = await owner.request("/api/v1/admin/users", {
    method: "POST",
    body: {
      email: "viewer@example.com",
      displayName: "Viewer",
      password: PASSWORD,
    },
  });
  await owner.request(`/api/v1/organizations/${firstId}/members`, {
    method: "POST",
    body: { userId: user.data.user.id, role: "viewer" },
  });

  const viewer = new TestClient(runtime.origin);
  const login = await viewer.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "viewer@example.com", password: PASSWORD },
  });
  assert.equal(login.status, 200);

  assert.equal(
    (
      await viewer.request(
        `/api/v1/projects/${firstProject.data.project.id}`,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await viewer.request(
        `/api/v1/projects/${secondProject.data.project.id}`,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await viewer.request(
        `/api/v1/projects/${firstProject.data.project.id}/tasks`,
        {
          method: "POST",
          body: {
            repositoryId: "missing",
            objective: "Viewer must not submit",
          },
        },
      )
    ).status,
    403,
  );
  const agents = await viewer.request(
    `/api/v1/projects/${firstProject.data.project.id}/agents`,
  );
  assert.equal(agents.status, 200);
  assert.equal(agents.data.agents[0].id, "test-agent");
});

test("approval decisions are project-authorized and durably audited", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  const setup = await bootstrap(client);
  const approval = await runtime.store.createApproval({
    organizationId: DEFAULT_ORGANIZATION_ID,
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: "repo_test",
    runId: "run_test",
    taskId: "task_test",
    kind: "changeset",
    requestedBy: setup.user.id,
    requiredRole: "reviewer",
    reasons: ["Protected changeset"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const listed = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/approvals?status=pending`,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.data.approvals.map((entry: any) => entry.id),
    [approval.id],
  );

  const decided = await client.request(`/api/v1/approvals/${approval.id}`, {
    method: "POST",
    body: { status: "approved", comment: "Reviewed in the test" },
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.data.approval.status, "approved");
  assert.equal(
    (await runtime.store.getApproval(approval.id))?.decisionComment,
    "Reviewed in the test",
  );
  assert.equal(
    (await runtime.store.listAuditEvents()).some(
      (entry) =>
        entry.event.type === "approval_decided" &&
        entry.event.data["approvalId"] === approval.id,
    ),
    true,
  );
});

function decodeTextFrames(buffer: Buffer): string[] {
  const messages: string[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    if (first === undefined || second === undefined) {
      break;
    }
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) {
        break;
      }
      length = Number(buffer.readBigUInt64BE(offset + 2));
      header = 10;
    }
    if (buffer.length - offset < header + length) {
      break;
    }
    if ((first & 0x0f) === 0x1) {
      messages.push(
        buffer.subarray(offset + header, offset + header + length).toString("utf8"),
      );
    }
    offset += header + length;
  }
  return messages;
}

test("authenticated WebSockets stream only project-visible audit events", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  await runtime.store.appendAudit(undefined, {
    type: "project_changed",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      action: "test-event",
    },
  });

  const payloads = await new Promise<any[]>((resolve, reject) => {
    const socket = net.createConnection(runtime.port, "127.0.0.1");
    let response = Buffer.alloc(0);
    let headersRead = false;
    let frameBytes = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for project audit WebSocket event"));
    }, 4_000);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET /api/v1/events?projectId=${DEFAULT_PROJECT_ID}&after=0 HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${runtime.port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          `Origin: ${runtime.origin}\r\n` +
          `Cookie: ${client.cookieHeader}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      if (!headersRead) {
        response = Buffer.concat([response, chunk]);
        const boundary = response.indexOf("\r\n\r\n");
        if (boundary < 0) {
          return;
        }
        const headers = response.subarray(0, boundary).toString("ascii");
        assert.match(headers, /^HTTP\/1\.1 101 /u);
        frameBytes = response.subarray(boundary + 4);
        headersRead = true;
      } else {
        frameBytes = Buffer.concat([frameBytes, chunk]);
      }
      const messages = decodeTextFrames(frameBytes).map((entry) =>
        JSON.parse(entry),
      );
      if (
        messages.some(
          (entry) =>
            entry.type === "audit" &&
            entry.event?.data?.action === "test-event",
        )
      ) {
        clearTimeout(timer);
        socket.destroy();
        resolve(messages);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  assert.equal(payloads[0]?.type, "connected");
  assert.equal(
    payloads.some((entry) => entry.type === "audit"),
    true,
  );
});

/** A bare fetch with no cookies, standing in for a CLI, worker, or agent. */
async function bearer(
  origin: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: any }> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    data: text.length === 0 ? undefined : JSON.parse(text),
  };
}

test("api tokens authenticate headless clients without cookies or CSRF", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: {
      name: "ci-worker",
      scopes: ["view", "run_task", "manage_organization"],
    },
  });
  assert.equal(created.status, 201);
  const token = created.data.token as string;
  assert.match(token, /^coord_pat_/u);
  assert.deepEqual(created.data.scopes, [
    "view",
    "run_task",
    "manage_organization",
  ]);

  // No cookie jar at all: this is what a CLI or worker looks like.
  const me = await bearer(runtime.origin, "/api/v1/auth/me", token);
  assert.equal(me.status, 200);
  assert.equal(me.data.credential, "api_token");
  assert.equal(me.data.user.email, "owner@example.com");
  assert.equal(me.data.sessionId, undefined);
  assert.equal(me.data.token.name, "ci-worker");

  // A write with no CSRF header at all. The same request over a cookie
  // session is rejected with csrf_failed, so this is the distinguishing case.
  const organizations = await bearer(
    runtime.origin,
    "/api/v1/organizations",
    token,
    { method: "POST", body: { slug: "by-token", name: "By token" } },
  );
  assert.equal(organizations.status, 201);

  const listed = await client.request("/api/v1/auth/tokens");
  assert.equal(listed.status, 200);
  assert.equal(listed.data.tokens.length, 1);
  // Listing must never expose the secret.
  assert.equal(listed.data.tokens[0].token, undefined);
  assert.equal(listed.data.tokens[0].active, true);
  assert.ok(!JSON.stringify(listed.data).includes(token));
});

test("a token is confined to the scopes it was granted", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const readOnly = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "read-only", scopes: ["view"] },
  });
  assert.equal(readOnly.status, 201);
  const token = readOnly.data.token as string;

  // "view" is granted, so reading is fine.
  const organizations = await bearer(runtime.origin, "/api/v1/organizations", token);
  assert.equal(organizations.status, 200);

  // The owner could create an organization, but this token cannot: the
  // effective permission is the intersection of role and scope.
  const denied = await bearer(runtime.origin, "/api/v1/organizations", token, {
    method: "POST",
    body: { slug: "nope", name: "Nope" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, "token_scope_missing");
});

test("a token cannot be granted more than its owner's role allows", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const organizationId = (await owner.request("/api/v1/organizations")).data
    .organizations[0].id as string;

  // Created directly so the test exercises scope bounding, not invite plumbing.
  const viewerUser = await runtime.store.createUser({
    email: "viewer@example.com",
    displayName: "Viewer",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId,
    userId: viewerUser.id,
    role: "viewer",
  });

  const viewer = new TestClient(runtime.origin);
  const login = await viewer.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "viewer@example.com", password: PASSWORD },
  });
  assert.equal(login.status, 200);

  // A viewer holds only "view", so a wider token must be refused outright.
  const escalation = await viewer.request("/api/v1/auth/tokens", {
    method: "POST",
    body: {
      name: "escalate",
      scopes: ["view", "manage_organization"],
      organizationId,
    },
  });
  assert.equal(escalation.status, 403);
  assert.equal(escalation.data.error.code, "scope_exceeds_role");

  const allowed = await viewer.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "fine", scopes: ["view"], organizationId },
  });
  assert.equal(allowed.status, 201);

  // And that token is confined to the organization it was bound to.
  const elsewhere = await bearer(
    runtime.origin,
    "/api/v1/organizations",
    allowed.data.token as string,
    { method: "POST", body: { slug: "other", name: "Other" } },
  );
  assert.equal(elsewhere.status, 403);
});

test("a token cannot mint another token", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "worker", scopes: ["view", "manage_organization"] },
  });
  const token = created.data.token as string;

  // Otherwise a leaked credential could refresh itself forever and revocation
  // would mean nothing.
  const minted = await bearer(runtime.origin, "/api/v1/auth/tokens", token, {
    method: "POST",
    body: { name: "child", scopes: ["view"] },
  });
  assert.equal(minted.status, 403);
  assert.equal(minted.data.error.code, "session_required");
});

test("revoking a token stops it immediately", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "temp", scopes: ["view"] },
  });
  const token = created.data.token as string;
  const tokenId = created.data.id as string;

  assert.equal((await bearer(runtime.origin, "/api/v1/auth/me", token)).status, 200);

  const revoked = await client.request(`/api/v1/auth/tokens/${tokenId}`, {
    method: "DELETE",
  });
  assert.equal(revoked.status, 200);

  const after = await bearer(runtime.origin, "/api/v1/auth/me", token);
  assert.equal(after.status, 401);

  const listed = await client.request("/api/v1/auth/tokens");
  assert.equal(listed.data.tokens[0].active, false);
  assert.notEqual(listed.data.tokens[0].revokedAt, undefined);
});

test("a bearer principal cannot sign out a session it does not have", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "worker", scopes: ["view"] },
  });
  const logout = await bearer(
    runtime.origin,
    "/api/v1/auth/logout",
    created.data.token as string,
    { method: "POST" },
  );
  assert.equal(logout.status, 400);
  assert.equal(logout.data.error.code, "not_a_session");
});

test("invalid and malformed tokens are refused", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  for (const candidate of [
    "coord_pat_unknown.secret",
    "coord_pat_malformed",
    "not-a-token",
  ]) {
    const response = await bearer(runtime.origin, "/api/v1/auth/me", candidate);
    assert.equal(response.status, 401, candidate);
  }
});

/**
 * The remote worker protocol, exercised the way a worker actually uses it:
 * bearer token only, no cookies, lease -> bundle -> result.
 */
async function workerRuntime(t: TestContext) {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "fleet", scopes: ["view", "run_task"] },
  });
  assert.equal(created.status, 201);
  return { runtime, client, token: created.data.token as string };
}

test("a worker registers, leases exclusively, and heartbeats", async (t) => {
  const { runtime, token } = await workerRuntime(t);

  const registered = await bearer(runtime.origin, "/api/v1/workers/register", token, {
    method: "POST",
    body: { name: "worker-a", adapters: ["codex"], version: "1.0.0" },
  });
  assert.equal(registered.status, 201);
  const workerId = registered.data.id as string;

  const unscoped = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    { method: "POST", body: { workerId } },
  );
  assert.equal(unscoped.status, 400);

  // Nothing queued yet, so the poll must say so without a body.
  const empty = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(empty.status, 204);

  await runtime.store.saveRepository({
    id: "repo_worker",
    path: "/canonical/worker.git",
    branch: "main",
  });
  const task = await runtime.store.submitTask({
    repositoryId: "repo_worker",
    objective: "cap the value",
    agentId: "codex",
    validationCommands: [],
  });

  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(leased.status, 200);
  assert.equal(leased.data.task.id, task.id);
  assert.equal(leased.data.lease.status, "active");
  assert.ok(leased.data.bundleUrl.includes(leased.data.lease.id));

  // A second poll finds nothing: the task is exclusively held.
  const second = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(second.status, 204);

  const beat = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leased.data.lease.id}/heartbeat`,
    token,
    { method: "POST" },
  );
  assert.equal(beat.status, 200);
  assert.ok(beat.data.expiresAt > leased.data.lease.expiresAt);
});

test("releasing a lease returns the task to the queue", async (t) => {
  const { runtime, token } = await workerRuntime(t);
  const workerId = (
    await bearer(runtime.origin, "/api/v1/workers/register", token, {
      method: "POST",
      body: { name: "w", adapters: [], version: "1" },
    })
  ).data.id as string;

  await runtime.store.saveRepository({
    id: "repo_release",
    path: "/canonical/release.git",
    branch: "main",
  });
  await runtime.store.submitTask({
    repositoryId: "repo_release",
    objective: "objective",
    agentId: "codex",
    validationCommands: [],
  });

  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  const released = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leased.data.lease.id}/release`,
    token,
    { method: "POST" },
  );
  assert.equal(released.status, 200);

  // Another poll now finds the work again.
  const relet = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(relet.status, 200);

  // A heartbeat on the abandoned lease must be refused, not silently accepted.
  const stale = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leased.data.lease.id}/heartbeat`,
    token,
    { method: "POST" },
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, "lease_lost");
});

test("worker endpoints require the run_task scope", async (t) => {
  const { runtime, client } = await workerRuntime(t);
  const readOnly = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "read-only", scopes: ["view"] },
  });
  const token = readOnly.data.token as string;

  const denied = await bearer(runtime.origin, "/api/v1/workers/register", token, {
    method: "POST",
    body: { name: "w", adapters: [], version: "1" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, "token_scope_missing");
});

test("malformed hosts and encoded paths stay inside the HTTP error boundary", async (t) => {
  const runtime = await startRuntime(t);
  const hostResponse = await rawHttp(
    runtime.port,
    "GET /api/v1/health HTTP/1.1\r\n" +
      "Host: [malformed\r\n" +
      "Connection: close\r\n\r\n",
  );
  assert.match(hostResponse, /^HTTP\/1\.1 200 /u);

  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const malformedPath = await client.request("/api/v1/projects/%E0%A4%A");
  assert.equal(malformedPath.status, 400);
  assert.equal(malformedPath.data.error.code, "invalid_path");

  const healthy = await client.request("/api/v1/health");
  assert.equal(healthy.status, 200);
});

test("project metrics are served to members and refused across tenants", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const metrics = await owner.request(
    "/api/v1/projects/project_local/metrics",
  );
  assert.equal(metrics.status, 200);
  assert.equal(metrics.data.metrics.projectId, "project_local");

  // A signed-in user with no membership in the project's organization gets
  // the same generic refusal as for any other project-scoped resource.
  const outsiderUser = await runtime.store.createUser({
    email: "metrics-outsider@example.com",
    displayName: "Outsider",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const outsider = new TestClient(runtime.origin);
  await outsider.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: outsiderUser.email, password: PASSWORD },
  });
  const denied = await outsider.request(
    "/api/v1/projects/project_local/metrics",
  );
  assert.equal(denied.status, 403);
});

test("project policy is validated, stored, and clearable through the API", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const invalid = await owner.request("/api/v1/projects/project_local", {
    method: "PATCH",
    body: { policy: { version: 2 } },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, "invalid_policy");

  const policy = {
    version: 1,
    approvals: { requireChangesetReview: true, protectedPaths: ["infra/**"] },
  };
  const set = await owner.request("/api/v1/projects/project_local", {
    method: "PATCH",
    body: { policy },
  });
  assert.equal(set.status, 200);
  assert.deepEqual(set.data.project.policy, policy);
  const fetched = await owner.request("/api/v1/projects/project_local");
  assert.deepEqual(fetched.data.project.policy, policy);

  const cleared = await owner.request("/api/v1/projects/project_local", {
    method: "PATCH",
    body: { policy: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.project.policy, undefined);
});

test("configured browser origins receive credentialed CORS and preflight", async (t) => {
  const allowedOrigin = "https://relay-client.example";
  const runtime = await startRuntime(t, {
    allowedOrigins: [allowedOrigin],
  });
  const preflight = await fetch(`${runtime.origin}/api/v1/auth/login`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-csrf-token",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );
  assert.match(
    preflight.headers.get("access-control-allow-methods") ?? "",
    /POST/u,
  );
  assert.equal(
    preflight.headers.get("access-control-allow-credentials"),
    "true",
  );

  const allowed = await fetch(`${runtime.origin}/api/v1/health`, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(allowed.status, 200);
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );

  const denied = await fetch(`${runtime.origin}/api/v1/health`, {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("a project-bound worker token cannot pull another tenant's queue", async (t) => {
  const { runtime } = await workerRuntime(t);
  const firstOrganization = await runtime.store.createOrganization({
    slug: "worker-first",
    name: "Worker First",
  });
  const secondOrganization = await runtime.store.createOrganization({
    slug: "worker-second",
    name: "Worker Second",
  });
  const firstProject = await runtime.store.createProject({
    organizationId: firstOrganization.id,
    slug: "first",
    name: "First",
  });
  const secondProject = await runtime.store.createProject({
    organizationId: secondOrganization.id,
    slug: "second",
    name: "Second",
  });
  const developer = await runtime.store.createUser({
    email: "fleet-developer@example.com",
    displayName: "Fleet Developer",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: firstOrganization.id,
    userId: developer.id,
    role: "developer",
  });
  const developerClient = new TestClient(runtime.origin);
  await developerClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: developer.email, password: PASSWORD },
  });
  const issued = await developerClient.request("/api/v1/auth/tokens", {
    method: "POST",
    body: {
      name: "tenant-worker",
      scopes: ["view", "run_task"],
      organizationId: firstOrganization.id,
    },
  });
  const token = issued.data.token as string;
  const worker = await bearer(
    runtime.origin,
    "/api/v1/workers/register",
    token,
    {
      method: "POST",
      body: { name: "tenant-worker", adapters: ["codex"], version: "1" },
    },
  );
  const outsider = await runtime.store.createUser({
    email: "other-fleet@example.com",
    displayName: "Other Fleet",
    passwordDigest: "unused",
  });
  await runtime.store.registerWorker({
    userId: outsider.id,
    name: "other-worker",
    adapters: ["codex"],
    version: "1",
  });
  const visibleWorkers = await bearer(
    runtime.origin,
    "/api/v1/workers",
    token,
  );
  assert.deepEqual(
    visibleWorkers.data.workers.map((entry: { id: string }) => entry.id),
    [worker.data.id],
  );

  await runtime.store.saveRepository({
    id: "repo_other_tenant",
    path: "/canonical/other-tenant.git",
    branch: "main",
  });
  await runtime.store.linkRepository(
    secondProject.id,
    "repo_other_tenant",
  );
  await runtime.store.submitTask({
    projectId: secondProject.id,
    repositoryId: "repo_other_tenant",
    objective: "private objective",
    agentId: "codex",
    validationCommands: [],
  });

  const ownQueue = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    {
      method: "POST",
      body: {
        workerId: worker.data.id,
        projectId: firstProject.id,
      },
    },
  );
  assert.equal(ownQueue.status, 204);

  const crossTenant = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    {
      method: "POST",
      body: {
        workerId: worker.data.id,
        projectId: secondProject.id,
      },
    },
  );
  assert.equal(crossTenant.status, 403);
  assert.equal(crossTenant.data.error.code, "token_organization_mismatch");
  assert.equal(
    (await runtime.store.listSubmittedTasks({ projectId: secondProject.id }))[0]
      ?.status,
    "submitted",
  );
});

test("a worker cannot touch another user's lease", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const workerId = (
    await bearer(runtime.origin, "/api/v1/workers/register", token, {
      method: "POST",
      body: { name: "w", adapters: [], version: "1" },
    })
  ).data.id as string;

  await runtime.store.saveRepository({
    id: "repo_iso",
    path: "/canonical/iso.git",
    branch: "main",
  });
  await runtime.store.submitTask({
    repositoryId: "repo_iso",
    objective: "objective",
    agentId: "codex",
    validationCommands: [],
  });
  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });

  // A second tenant with a perfectly valid run_task token.
  const intruderUser = await runtime.store.createUser({
    email: "intruder@example.com",
    displayName: "Intruder",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: "org_local",
    userId: intruderUser.id,
    role: "developer",
  });
  const intruder = new TestClient(runtime.origin);
  await intruder.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "intruder@example.com", password: PASSWORD },
  });
  const intruderToken = (
    await intruder.request("/api/v1/auth/tokens", {
      method: "POST",
      body: { name: "theirs", scopes: ["view", "run_task"] },
    })
  ).data.token as string;

  for (const action of ["heartbeat", "release", "result"]) {
    const response = await bearer(
      runtime.origin,
      `/api/v1/workers/leases/${leased.data.lease.id}/${action}`,
      intruderToken,
      { method: "POST", body: { status: "failed" } },
    );
    assert.equal(response.status, 404, action);
  }
});
