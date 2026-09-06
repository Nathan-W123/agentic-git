/** The gateway over HTTP: sessions, tokens and the WebSocket. */

import assert from "node:assert/strict";
import {
  randomBytes,
} from "node:crypto";
import net from "node:net";
import test from "node:test";
import {
  hashPassword,
} from "./auth.js";
import {
  PASSWORD,
  TestClient,
  bearer,
  bootstrap,
  decodeCloseCode,
  decodeTextFrames,
  invitableRepository,
  startRuntime,
  work,
} from "./test-harness.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
} from "@coord/persistence";

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
  assert.deepEqual(
    me.data.slashCommands.map((command: { name: string }) => command.name),
    [
      "plan",
      "queue",
      "ask",
      "dnc",
      "simple",
      "push",
      "retry",
      "cancel",
      "stop",
      "help",
    ],
  );

  const createdRepository = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
    {
      method: "POST",
      body: { id: "greenfield", branch: "trunk" },
    },
  );
  assert.equal(createdRepository.status, 201);
  assert.equal(createdRepository.data.repository.id, "greenfield");
  assert.equal(createdRepository.data.repository.branch, "trunk");
  const repositories = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.deepEqual(
    repositories.data.repositories.map(
      (repository: { id: string }) => repository.id,
    ),
    ["greenfield"],
  );
  assert.equal(
    (await runtime.store.listAuditEvents({ types: ["repository_created"] }))
      .length,
    1,
  );

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
  // A desktop shell cannot put a token on an `<img>` tag, so it fetches
  // attachments the way it fetches everything else and hands the element an
  // object URL. Tightening this back to `img-src 'self' data:` would leave
  // every image in the app broken, and nothing would say why.
  assert.equal(
    staticPage.headers.get("content-security-policy")?.includes("img-src 'self' data: blob:"),
    true,
  );
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
  assert.equal(
    (
      await viewer.request(
        `/api/v1/projects/${firstProject.data.project.id}/repositories`,
        {
          method: "POST",
          body: { id: "viewer-cannot-create" },
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
    requiredRole: "admin",
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

test("open WebSockets are closed when their user is disabled", async (t) => {
  const runtime = await startRuntime(t, {
    webSocketPollIntervalMs: 10,
    webSocketReauthorizeIntervalMs: 20,
  });
  const client = new TestClient(runtime.origin);
  const setup = await bootstrap(client);

  const closeCode = await new Promise<number>((resolve, reject) => {
    const socket = net.createConnection(runtime.port, "127.0.0.1");
    let response = Buffer.alloc(0);
    let headersRead = false;
    let frameBytes = Buffer.alloc(0);
    let disabled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for WebSocket authorization refresh"));
    }, 4_000);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET /api/v1/events?projectId=${DEFAULT_PROJECT_ID} HTTP/1.1\r\n` +
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
      try {
        if (!headersRead) {
          response = Buffer.concat([response, chunk]);
          const boundary = response.indexOf("\r\n\r\n");
          if (boundary < 0) {
            return;
          }
          assert.match(
            response.subarray(0, boundary).toString("ascii"),
            /^HTTP\/1\.1 101 /u,
          );
          frameBytes = response.subarray(boundary + 4);
          headersRead = true;
        } else {
          frameBytes = Buffer.concat([frameBytes, chunk]);
        }
        const connected = decodeTextFrames(frameBytes).some(
          (entry) => JSON.parse(entry).type === "connected",
        );
        if (connected && !disabled) {
          disabled = true;
          void runtime.store
            .updateUser(setup.user.id, { disabled: true })
            .catch(reject);
        }
        const code = decodeCloseCode(frameBytes);
        if (code !== undefined) {
          clearTimeout(timer);
          socket.destroy();
          resolve(code);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  assert.equal(closeCode, 1008);
});

/**
 * A POST with no credential of any kind, standing in for an app that does not
 * have one yet.
 */
test("an editor polling over MCP cannot spend the dashboard's rate limit", async (t) => {
  // Both arrive from one IP and look identical to a per-IP limiter: the
  // person's browser and the model in their editor sit behind the same office
  // NAT. On a shared bucket a model polling `task_status` in a loop throttles
  // the human watching the thread, which is the wrong client to punish and
  // reads as "Kumi is down".
  const runtime = await startRuntime(t, {
    rateLimitPerMinute: 2,
    mcpRateLimitPerMinute: 2,
  });
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  // Spend the MCP budget to nothing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await client.request("/api/v1/mcp", {
      method: "POST",
      body: { jsonrpc: "2.0", id: attempt, method: "ping" },
    });
  }
  const exhausted = await client.request("/api/v1/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 99, method: "ping" },
  });
  assert.equal(exhausted.status, 429);

  // The dashboard's budget is untouched by any of it.
  const dashboard = await client.request("/api/v1/health");
  assert.notEqual(dashboard.status, 429);
});

test("somebody invited to one repository can run a worker, and only on that repository", async (t) => {
  // The whole local-execution premise depends on this: agents run on the
  // machines of the people who own them. A collaborator invited to a single
  // repository owns a machine like anybody else, but `POST /workers/register`
  // authorized through memberships alone, so their worker was refused on its
  // very first call — "You do not have permission to perform this action" in
  // a log file, over and over, every few minutes. Nothing they could do about
  // it and nothing anywhere saying what was wrong. Their agent then read as
  // permanently offline in every channel, which looked like a second,
  // unrelated bug.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const shared = await invitableRepository(owner, "fleet-shared");
  const private_ = await invitableRepository(owner, "fleet-private");

  const guest = await runtime.store.createUser({
    email: "fleet-guest@example.com",
    displayName: "Guest",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: shared,
    userId: guest.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });

  const guestClient = new TestClient(runtime.origin);
  await guestClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: guest.email, password: PASSWORD },
  });
  // Minted from the grant, which is the fix one layer down: the token route
  // reads grants too, so a collaborator can carry `run_task` at all.
  const minted = await guestClient.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "guest machine", scopes: ["view", "run_task"] },
  });
  assert.equal(minted.status, 201);
  const token = minted.data.token as string;

  const registered = await bearer(
    runtime.origin,
    "/api/v1/workers/register",
    token,
    {
      method: "POST",
      body: {
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "guest-laptop",
        adapters: ["codex"],
        version: "1.0.0",
      },
    },
  );
  assert.equal(registered.status, 201);
  const workerId = registered.data.id as string;

  // Work in the repository they were actually given.
  const mine = await runtime.store.submitTask({
    repositoryId: shared,
    projectId: DEFAULT_PROJECT_ID,
    objective: "fix the login redirect",
    agentId: "codex",
    validationCommands: [],
  });
  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(leased.status, 200);
  assert.equal(leased.data.task.id, mine.id);

  // And work in a repository beside it, which they were not. Admitting the
  // worker must not have widened what it may be handed: the grant covers one
  // repository, and a lease is an arbitrary agent run on this person's own
  // laptop against their own vendor subscription. 204, the same answer an
  // empty queue gives, because from where they stand the queue is empty.
  await runtime.store.submitTask({
    repositoryId: private_,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rotate the signing key",
    agentId: "codex",
    validationCommands: [],
  });
  const withheld = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    { method: "POST", body: { workerId, projectId: DEFAULT_PROJECT_ID } },
  );
  assert.equal(withheld.status, 204);

  // The fleet is the company's, not theirs. They see the machine they run —
  // that is how anybody knows whether their own agent will answer — and not
  // how much infrastructure the organization operates.
  const ownerWorker = await bearer(
    runtime.origin,
    "/api/v1/workers/register",
    (
      await owner.request("/api/v1/auth/tokens", {
        method: "POST",
        body: { name: "owner machine", scopes: ["view", "run_task"] },
      })
    ).data.token as string,
    {
      method: "POST",
      body: {
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "owner-desktop",
        adapters: ["codex"],
        version: "1.0.0",
      },
    },
  );
  assert.equal(ownerWorker.status, 201);

  const fleet = await bearer(
    runtime.origin,
    `/api/v1/workers?organizationId=${DEFAULT_ORGANIZATION_ID}`,
    token,
  );
  assert.equal(fleet.status, 200);
  assert.deepEqual(
    (fleet.data.workers as { name: string }[]).map((worker) => worker.name),
    ["guest-laptop"],
  );

  // A stranger holding neither a membership nor a grant is refused exactly as
  // before. Widening this to grants must not have widened it to everybody.
  const stranger = await runtime.store.createUser({
    email: "fleet-stranger@example.com",
    displayName: "Stranger",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const strangerClient = new TestClient(runtime.origin);
  await strangerClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: stranger.email, password: PASSWORD },
  });
  const refused = await strangerClient.request("/api/v1/workers/register", {
    method: "POST",
    body: {
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: "stranger-laptop",
      adapters: ["codex"],
      version: "1.0.0",
    },
  });
  assert.equal(refused.status, 403);
  // And refused in words, because a worker log is the only place this is ever
  // read. "You do not have permission to perform this action", alone in a
  // file, is what sent two people hunting through networks and reinstalls.
  assert.match(String(refused.data.error?.message), /invite you to it/u);
});

test("a token may mint a narrower one, which dies with it", async (t) => {
  // The desktop app authenticates with a token, so the rule that only a
  // session may mint left it unable to create the narrow credential an editor
  // needs — from the one place that can actually write that editor's config.
  // The rule was right, though: a token refreshing itself forever would put
  // revocation out of reach. So the exception keeps the invariant instead of
  // trading it away.
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const desktop = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "desktop", scopes: ["view", "run_task", "submit_task"] },
  });
  assert.equal(desktop.status, 201);
  const parentId = desktop.data.id as string;
  const parentToken = desktop.data.token as string;

  // Narrower: allowed, and it works.
  const minted = await bearer(runtime.origin, "/api/v1/auth/tokens", parentToken, {
    method: "POST",
    body: { name: "Claude Code on Windows", scopes: ["view", "submit_task"] },
  });
  assert.equal(minted.status, 201, JSON.stringify(minted.data));
  const child = minted.data.token as string;
  assert.equal(
    (await bearer(runtime.origin, "/api/v1/auth/tokens", child)).status,
    200,
    "the minted token should authenticate",
  );

  // Wider than the token doing the minting: refused, even though the *person*
  // holds the scope — this account is a system administrator and could have
  // asked for it from a session. A credential must not escalate itself just
  // because its owner could have asked for more.
  const wider = await bearer(runtime.origin, "/api/v1/auth/tokens", parentToken, {
    method: "POST",
    body: { name: "greedy", scopes: ["view", "manage_organization"] },
  });
  assert.equal(wider.status, 403);
  assert.equal(wider.data.error.code, "scope_exceeds_token");

  // And the invariant the original rule protected: revoking the parent takes
  // the child with it, so revocation still reaches everything.
  const revoked = await client.request(
    `/api/v1/auth/tokens/${encodeURIComponent(parentId)}`,
    { method: "DELETE" },
  );
  assert.equal(revoked.status, 200);
  assert.equal(
    (await bearer(runtime.origin, "/api/v1/auth/tokens", child)).status,
    401,
    "a token outlived the one that minted it",
  );
});

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

test("a minted token cannot mint further, so the chain stays one link long", async (t) => {
  // A token may now mint one narrower token, because the desktop app needs to
  // and it authenticates with a token. What keeps that from becoming "a
  // leaked credential refreshes itself forever" is the cascade — revoking the
  // parent revokes the child — and the cascade is one level deep. So the
  // chain has to be one link long, or its tail would outlive revoking its
  // head.
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  const created = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "worker", scopes: ["view", "manage_organization"] },
  });
  const token = created.data.token as string;

  const child = await bearer(runtime.origin, "/api/v1/auth/tokens", token, {
    method: "POST",
    body: { name: "child", scopes: ["view"] },
  });
  assert.equal(child.status, 201);

  const grandchild = await bearer(
    runtime.origin,
    "/api/v1/auth/tokens",
    child.data.token as string,
    { method: "POST", body: { name: "grandchild", scopes: ["view"] } },
  );
  assert.equal(grandchild.status, 403);
  assert.equal(grandchild.data.error.code, "session_required");
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

test("a refused worker is told which of the three things is wrong, and where", async (t) => {
  // One sentence used to answer three unrelated questions. "You do not have
  // permission to perform this action" is true of a stranger, of a member
  // whose organization stopped paying, and of a token minted too narrow, and
  // it is the only thing written anywhere — a log file on the machine that
  // will not start, with a stack trace under it.
  //
  // It cost an afternoon. A co-founder's worker was refused; he was promoted
  // to developer, then to admin, and neither changed anything, because his
  // desktop had quietly registered against the personal organization that
  // signing up had created for him rather than against the team's. The
  // refusal was about a workspace nobody was looking at. So the workspace is
  // named, and the cause is distinguished.
  const previous = process.env["KUMI_PAYMENTS_ENABLED"];
  process.env["KUMI_PAYMENTS_ENABLED"] = "1";
  t.after(() => {
    if (previous === undefined) {
      delete process.env["KUMI_PAYMENTS_ENABLED"];
    } else {
      process.env["KUMI_PAYMENTS_ENABLED"] = previous;
    }
  });

  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const member = await runtime.store.createUser({
    email: "refused@example.com",
    displayName: "Refused",
    passwordDigest: await hashPassword(PASSWORD),
  });
  // An organization of their own, unpaid, exactly as signing up leaves one.
  const alone = await runtime.store.createOrganization({
    slug: "refused-workspace",
    name: "Refused's Workspace",
  });
  await runtime.store.saveMembership({
    organizationId: alone.id,
    userId: member.id,
    role: "owner",
  });

  const client = new TestClient(runtime.origin);
  await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: member.email, password: PASSWORD },
  });
  const minted = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "their machine", scopes: ["view", "run_task"] },
  });
  assert.equal(minted.status, 201);
  const token = minted.data.token as string;

  // Owner of it, and still refused: the role was never what was missing.
  const lapsed = await bearer(
    runtime.origin,
    "/api/v1/workers/register",
    token,
    {
      method: "POST",
      body: {
        organizationId: alone.id,
        name: "their-laptop",
        adapters: ["codex"],
        version: "1.0.0",
      },
    },
  );
  assert.equal(lapsed.status, 403);
  const said = String(lapsed.data.error?.message ?? "");
  assert.match(said, /Refused's Workspace/u, "it must name the organization");
  assert.match(
    said,
    /organization/u,
    "in the product's own word for a tenant — the web app spends " +
      '"workspace" on a repository\'s working area, and the settings screen ' +
      "this sends somebody to is labelled Organization",
  );
  assert.match(said, /subscription|trial/u, "it must name the cause");
  assert.match(
    said,
    /changing your role will not help/u,
    "it must say the thing they are about to try twice does not work",
  );
  assert.doesNotMatch(
    said,
    /invite/u,
    "an owner must not be told to get themselves invited",
  );

  // The other cause, same route: somewhere they hold nothing at all.
  const stranger = await bearer(
    runtime.origin,
    "/api/v1/workers/register",
    token,
    {
      method: "POST",
      body: {
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "their-laptop",
        adapters: ["codex"],
        version: "1.0.0",
      },
    },
  );
  assert.equal(stranger.status, 403);
  const elsewhere = String(stranger.data.error?.message ?? "");
  assert.match(elsewhere, /invite/u, "a stranger is told how to get standing");
  assert.doesNotMatch(
    elsewhere,
    /subscription|trial/u,
    "and is told nothing about that organization's billing",
  );
});

test("the organization listing says where this account could actually work", async (t) => {
  // The desktop app has to choose between these, and it chose by counting
  // repositories — so a machine landed in the personal organization signing
  // up had made for its owner, which had never been paid for, and was refused
  // on its first call. Nothing in this listing could have told it otherwise:
  // a role would not have, because an organization that cannot spend folds
  // every role to `viewer`, owners included. So the answer here is the same
  // question registration asks, asked in advance.
  const previous = process.env["KUMI_PAYMENTS_ENABLED"];
  process.env["KUMI_PAYMENTS_ENABLED"] = "1";
  t.after(() => {
    if (previous === undefined) {
      delete process.env["KUMI_PAYMENTS_ENABLED"];
    } else {
      process.env["KUMI_PAYMENTS_ENABLED"] = previous;
    }
  });

  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);

  const member = await runtime.store.createUser({
    email: "twotenants@example.com",
    displayName: "Two Tenants",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const personal = await runtime.store.createOrganization({
    slug: "two-tenants-personal",
    name: "Personal",
  });
  // Owner of their own, unpaid — and a developer in the team's, which is not.
  await runtime.store.saveMembership({
    organizationId: personal.id,
    userId: member.id,
    role: "owner",
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: member.id,
    role: "developer",
    comped: true,
  });
  assert.ok(bootstrapped.user.id !== member.id);

  const client = new TestClient(runtime.origin);
  await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: member.email, password: PASSWORD },
  });
  const listed = await client.request("/api/v1/organizations");
  assert.equal(listed.status, 200);

  const rows = listed.data.organizations as Array<{
    id: string;
    canRunWork?: boolean;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(
    byId.get(personal.id)?.canRunWork,
    false,
    "owning an organization that cannot spend is not being able to work in it",
  );
  assert.equal(
    byId.get(DEFAULT_ORGANIZATION_ID)?.canRunWork,
    true,
    "and a comped membership in the team's is",
  );
});

test("joining an organization does not take away a free invitation", async (t) => {
  // Two answers about one person, in one organization, in the same minute.
  //
  // `authorizeProject` takes the higher of the entitled role and the comped
  // one, so somebody invited for free could submit work all day even after
  // the organization's trial ran out. `authorizeOrganizationOrGrant` returned
  // on the membership branch before it ever looked at grants, so the moment
  // their machine tried to register it folded them to `viewer` and refused —
  // "You do not have permission to perform this action", every few minutes,
  // in a log file. Being a member was strictly worse than being a guest.
  //
  // It cost an afternoon and two promotions. A role was never what was
  // missing: an organization that cannot spend folds every role, admin and
  // owner alike.
  const previous = process.env["KUMI_PAYMENTS_ENABLED"];
  process.env["KUMI_PAYMENTS_ENABLED"] = "1";
  t.after(() => {
    if (previous === undefined) {
      delete process.env["KUMI_PAYMENTS_ENABLED"];
    } else {
      process.env["KUMI_PAYMENTS_ENABLED"] = previous;
    }
  });

  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const shared = await invitableRepository(owner, "comped-shared");
  // The organization stopped paying. Nobody swept anything; the row says so.
  await runtime.store.saveSubscription({
    organizationId: DEFAULT_ORGANIZATION_ID,
    status: "canceled",
  });

  const guest = await runtime.store.createUser({
    email: "comped@example.com",
    displayName: "Comped",
    passwordDigest: await hashPassword(PASSWORD),
  });
  // Invited for free to a repository, and then made a member — the ordinary
  // shape of a co-founder who was added to the team afterwards.
  await runtime.store.saveRepositoryGrant({
    repositoryId: shared,
    userId: guest.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    comped: true,
    createdAt: new Date().toISOString(),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: guest.id,
    role: "admin",
  });

  const client = new TestClient(runtime.origin);
  await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: guest.email, password: PASSWORD },
  });
  const minted = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "their machine", scopes: ["view", "run_task"] },
  });
  assert.equal(minted.status, 201);

  const registered = await bearer(
    runtime.origin,
    "/api/v1/workers/register",
    minted.data.token as string,
    {
      method: "POST",
      body: {
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "their-laptop",
        adapters: ["codex"],
        version: "1.0.0",
      },
    },
  );
  assert.equal(
    registered.status,
    201,
    "a comped grant must carry a member exactly as it carries a guest",
  );

  // And the comp is still only a comp: somebody holding nothing but a lapsed
  // membership is refused, which is the behaviour this must not undo.
  const plain = await runtime.store.createUser({
    email: "plain@example.com",
    displayName: "Plain",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: plain.id,
    role: "admin",
  });
  const plainClient = new TestClient(runtime.origin);
  await plainClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: plain.email, password: PASSWORD },
  });
  const plainToken = await plainClient.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "their machine", scopes: ["view", "run_task"] },
  });
  const refused = await bearer(
    runtime.origin,
    "/api/v1/workers/register",
    plainToken.data.token as string,
    {
      method: "POST",
      body: {
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "other-laptop",
        adapters: ["codex"],
        version: "1.0.0",
      },
    },
  );
  assert.equal(refused.status, 403, "an unpaid organization is still read-only");
  assert.match(
    String(refused.data.error?.message ?? ""),
    /subscription|trial/u,
    "and says so, rather than sending an admin to be invited again",
  );
});

test("deployment administration can be taken back, not only given", async (t) => {
  // The grant and the revoke are one menu item that reads
  // `person.user.systemAdmin` to decide which of the two it is. The roster
  // projected `{id, displayName}` and dropped the flag, so the answer was
  // always `undefined`, so the item always said "Make deployment admin" —
  // and the revoke, whose route, client call and handler all exist, could
  // not be reached from anywhere in the product.
  //
  // That mattered more than a missing button usually does. A system
  // administrator reaches every organization on the deployment, which widens
  // what a desktop app can discover and quietly changes which organization
  // somebody's machine registers into. Granting it to unstick one person
  // sent their worker to a different tenant, where every lease poll was
  // refused and their agent went grey — with no way to undo the grant.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "roster-admin");

  const mate = await runtime.store.createUser({
    email: "mate@example.com",
    displayName: "Mate",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: mate.id,
    role: "admin",
  });
  assert.equal(bootstrapped.user.systemAdmin, true, "the first user runs the deployment");

  const rosterPath =
    `/api/v1/projects/${DEFAULT_PROJECT_ID}` +
    `/repositories/${repositoryId}/channel/agents`;

  const before = await owner.request(rosterPath);
  assert.equal(before.status, 200);
  const findMate = (data: { people?: Array<{ userId: string; user?: { systemAdmin?: boolean } }> }) =>
    (data.people ?? []).find((person) => person.userId === mate.id);
  assert.equal(
    findMate(before.data)?.user?.systemAdmin,
    false,
    "an ordinary member reads as not an administrator, not as unknown",
  );

  await owner.request(`/api/v1/admin/users/${mate.id}`, {
    method: "PATCH",
    body: { systemAdmin: true },
  });

  const after = await owner.request(rosterPath);
  assert.equal(
    findMate(after.data)?.user?.systemAdmin,
    true,
    "and once granted the roster says so, which is what draws the revoke",
  );

  // Withheld from everybody else. The item is only drawn for an
  // administrator, so nobody else's roster needs to name who runs this
  // deployment.
  const plain = new TestClient(runtime.origin);
  await plain.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: mate.email, password: PASSWORD },
  });
  await owner.request(`/api/v1/admin/users/${mate.id}`, {
    method: "PATCH",
    body: { systemAdmin: false },
  });
  const asMate = await plain.request(rosterPath);
  assert.equal(asMate.status, 200);
  const seenByMate = (asMate.data.people ?? []) as Array<{
    userId: string;
    user?: Record<string, unknown>;
  }>;
  const seesOwner = seenByMate.find((person) => person.userId === bootstrapped.user.id);
  assert.ok(seesOwner !== undefined, "the owner is still in the room");
  assert.equal(
    "systemAdmin" in (seesOwner.user ?? {}),
    false,
    "a non-administrator is told no more than before",
  );
});

test("a machine works for its owner's team wherever it happened to register", async (t) => {
  // The afternoon this cost, in one test.
  //
  // A desktop app picks an organization at start, before any task exists,
  // from whichever one it guessed — and a co-founder's laptop guessed a
  // stranger's. It registered there, polled there, and reported itself
  // "polling" the whole time, while the agent it existed to run stayed grey
  // in the only room anybody was looking at. Two promotions and a billing
  // flag later, nothing had changed, because none of them were what was
  // wrong.
  //
  // So the guess no longer decides anything. Liveness asks whether this
  // person's machine is polling; the lease asks whether this person may work
  // in this project. Neither asks which organization a desktop app named
  // before the work existed.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const shared = await invitableRepository(owner, "the-real-work");

  // Somebody else's organization, which this account has nothing to do with.
  const elsewhere = await runtime.store.createOrganization({
    slug: "a-strangers-team",
    name: "A Stranger's Team",
  });

  const mate = await runtime.store.createUser({
    email: "mate2@example.com",
    displayName: "Mate",
    passwordDigest: await hashPassword(PASSWORD),
  });
  // Invited to one repository and nothing else — no membership anywhere,
  // which is exactly the shape that used to make this unrecoverable.
  await runtime.store.saveRepositoryGrant({
    repositoryId: shared,
    userId: mate.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });

  // Deployment administration, granted to unstick them — which is what made
  // the stranger's organization visible to their desktop at all, and so what
  // made the wrong guess possible. Registering there is refused outright
  // without it, which is the register route working exactly as intended and
  // is why this was never reproducible until somebody was promoted.
  await runtime.store.updateUser(mate.id, { systemAdmin: true });

  const client = new TestClient(runtime.origin);
  await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: mate.email, password: PASSWORD },
  });
  const minted = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "their laptop", scopes: ["view", "run_task"] },
  });
  const token = minted.data.token as string;

  // The wrong guess, made real: registered into the stranger's organization.
  const registered = await bearer(
    runtime.origin,
    "/api/v1/workers/register",
    token,
    {
      method: "POST",
      body: {
        organizationId: elsewhere.id,
        name: "their-laptop",
        adapters: ["codex"],
        version: "1.0.0",
      },
    },
  );
  assert.equal(registered.status, 201);
  const workerId = registered.data.id as string;

  // And it still takes work from the team it actually belongs to.
  const leased = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    {
      method: "POST",
      body: { workerId, projectId: DEFAULT_PROJECT_ID },
    },
  );
  assert.notEqual(
    leased.status,
    403,
    "a guess made before the work existed must not decide whether work is " +
      "handed out — this used to be worker_organization_mismatch",
  );
  assert.ok(
    leased.status === 200 || leased.status === 204,
    `expected an assignment or an empty queue, got ${String(leased.status)}`,
  );

  // Polling anywhere is polling. The row the fleet listing files this
  // machine under is now cosmetic, and liveness stopped reading it.
  const live = await runtime.gateway.liveWorkerOwners(DEFAULT_ORGANIZATION_ID);
  assert.deepEqual(
    [...(live.get(mate.id) ?? new Set<string>())],
    ["codex"],
    "their agent is reachable in the room they were invited to",
  );
});
