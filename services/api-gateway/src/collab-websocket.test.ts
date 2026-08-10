import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import test, { type TestContext } from "node:test";

import {
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
  type CoordinationStore,
} from "@coord/persistence";

import { hashPassword } from "./auth.js";
import { ApiGateway, type ApiOperations, type WorkspaceOperations } from "./server.js";

const BOOTSTRAP_TOKEN = "bootstrap-token-with-at-least-24-characters";
const PASSWORD = "RelayPassword123!";

// ---- a minimal WebSocket client ---------------------------------------------
// Written by hand for the same reason the server is: the gateway ships no
// WebSocket dependency, and a client that speaks the wire format exactly is
// also the only way to prove the server's frame reader handles real masked
// frames, fragmentation included.

function clientFrame(opcode: number, payload: Buffer, final = true): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = (masked[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  let header: Buffer;
  if (masked.length < 126) {
    header = Buffer.from([(final ? 0x80 : 0) | opcode, 0x80 | masked.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = (final ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(masked.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

interface ServerFrame {
  opcode: number;
  payload: Buffer;
}

/** Decodes the unmasked frames a server sends. */
function readServerFrames(buffer: Buffer): {
  frames: ServerFrame[];
  rest: Buffer;
} {
  const frames: ServerFrame[] = [];
  let input = buffer;
  for (;;) {
    if (input.length < 2) {
      break;
    }
    const opcode = (input[0] ?? 0) & 0x0f;
    let length = (input[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (input.length < 4) {
        break;
      }
      length = input.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (input.length < 10) {
        break;
      }
      length = Number(input.readBigUInt64BE(2));
      offset = 10;
    }
    if (input.length < offset + length) {
      break;
    }
    frames.push({ opcode, payload: Buffer.from(input.subarray(offset, offset + length)) });
    input = input.subarray(offset + length);
  }
  return { frames, rest: input };
}

class CollabSocket {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly inbox: any[] = [];
  private readonly waiters: Array<() => void> = [];
  public closeCode: number | undefined;
  public closed = false;

  private constructor(private readonly socket: Duplex) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const { frames, rest } = readServerFrames(this.buffer);
      this.buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          this.closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
          this.closed = true;
        } else if (frame.opcode === 0x1) {
          this.inbox.push(JSON.parse(frame.payload.toString("utf8")));
        }
      }
      for (const wake of this.waiters.splice(0)) {
        wake();
      }
    });
    socket.on("close", () => {
      this.closed = true;
      for (const wake of this.waiters.splice(0)) {
        wake();
      }
    });
  }

  public static async connect(
    port: number,
    cookie: string,
    query: string,
  ): Promise<{ socket?: CollabSocket; status?: number }> {
    return await new Promise((resolve, reject) => {
      const request = http.request({
        port,
        host: "127.0.0.1",
        path: `/api/v1/collab?${query}`,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          Cookie: cookie,
        },
      });
      const timer = setTimeout(() => {
        request.destroy();
        reject(new Error("timed out negotiating the collaboration socket"));
      }, 5_000);
      request.on("upgrade", (_response, socket, head) => {
        clearTimeout(timer);
        const client = new CollabSocket(socket);
        if (head.length > 0) {
          socket.emit("data", head);
        }
        resolve({ socket: client });
      });
      request.on("response", (response) => {
        clearTimeout(timer);
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      });
      request.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      request.end();
    });
  }

  public send(message: unknown): void {
    this.socket.write(clientFrame(0x1, Buffer.from(JSON.stringify(message), "utf8")));
  }

  /** Sends one message split across two frames, exercising continuations. */
  public sendFragmented(message: unknown): void {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const split = Math.floor(payload.length / 2);
    this.socket.write(clientFrame(0x1, payload.subarray(0, split), false));
    this.socket.write(clientFrame(0x0, payload.subarray(split), true));
  }

  public sendRaw(frame: Buffer): void {
    this.socket.write(frame);
  }

  public async next(type?: string, timeoutMs = 5_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex(
        (message) => type === undefined || message.type === type,
      );
      if (index >= 0) {
        return this.inbox.splice(index, 1)[0];
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${type ?? "a message"}; saw ${JSON.stringify(this.inbox)}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  /** Resolves once the socket has been closed by the server. */
  public async waitForClose(timeoutMs = 5_000): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return this.closeCode;
  }

  public end(): void {
    this.socket.destroy();
  }
}

// ---- harness ----------------------------------------------------------------

class InMemoryWorkspace implements WorkspaceOperations {
  public readonly files = new Map<string, string>();
  public writes = 0;
  public failWrites = false;

  private key(input: { userId: string; repositoryId: string; path: string }): string {
    return `${input.userId}|${input.repositoryId}|${input.path}`;
  }

  public seed(
    input: { userId: string; repositoryId: string; path: string },
    content: string,
  ): void {
    this.files.set(this.key(input), content);
  }

  public async status(): Promise<unknown> {
    return { exists: true };
  }
  public async open(): Promise<unknown> {
    return { exists: true };
  }
  public async reset(): Promise<unknown> {
    return { exists: true };
  }
  public async discard(): Promise<void> {}
  public async listFiles(): Promise<unknown> {
    return [];
  }
  public async moveFile(input: {
    userId: string;
    repositoryId: string;
    from: string;
    to: string;
  }): Promise<unknown> {
    const from = this.key({ ...input, path: input.from });
    const content = this.files.get(from);
    if (content === undefined) {
      throw Object.assign(new Error("File was not found"), {
        status: 404,
        code: "not_found",
      });
    }
    this.files.set(this.key({ ...input, path: input.to }), content);
    this.files.delete(from);
    return { moved: true };
  }
  public async readFile(input: {
    userId: string;
    repositoryId: string;
    path: string;
  }): Promise<unknown> {
    const content = this.files.get(this.key(input));
    if (content === undefined) {
      throw Object.assign(new Error("File was not found"), {
        status: 404,
        code: "not_found",
      });
    }
    return {
      path: input.path,
      content,
      size: content.length,
      binary: input.path.endsWith(".png"),
      truncated: input.path.endsWith(".big"),
    };
  }
  public async writeFile(input: {
    userId: string;
    repositoryId: string;
    path: string;
    content: string;
  }): Promise<unknown> {
    if (this.failWrites) {
      throw Object.assign(new Error("disk is full"), {
        status: 500,
        code: "io_error",
      });
    }
    this.writes += 1;
    this.files.set(this.key(input), input.content);
    return { saved: true };
  }
  public async exec(): Promise<unknown> {
    return { exitCode: 0 };
  }
  public async submit(): Promise<unknown> {
    return { status: "noop" };
  }
}

interface Runtime {
  gateway: ApiGateway;
  store: CoordinationStore;
  workspace: InMemoryWorkspace;
  port: number;
  origin: string;
}

class HttpClient {
  private readonly cookies = new Map<string, string>();

  public constructor(private readonly origin: string) {}

  public get cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  public async request(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: any }> {
    const headers = new Headers(options.headers ?? {});
    if (this.cookieHeader.length > 0) {
      headers.set("Cookie", this.cookieHeader);
    }
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(options.method ?? "GET") &&
      this.cookies.has("coord_csrf")
    ) {
      headers.set("X-CSRF-Token", this.cookies.get("coord_csrf") ?? "");
    }
    const response = await fetch(`${this.origin}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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
    };
  }
}

async function startRuntime(
  t: TestContext,
  options: { collabTickIntervalMs?: number } = {},
): Promise<Runtime> {
  const store = new InMemoryCoordinationStore();
  const workspace = new InMemoryWorkspace();
  const operations: ApiOperations = {
    async createRepository(input) {
      const repository = {
        id: input.id,
        path: `/canonical/${input.id}.git`,
        branch: input.branch ?? "main",
      };
      await store.saveRepository(repository);
      await store.linkRepository(input.projectId, repository.id);
      return repository;
    },
    async importGitHub() {
      throw new Error("not used");
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
    workspace,
  };
  const gateway = new ApiGateway({
    store,
    operations,
    bootstrapToken: BOOTSTRAP_TOKEN,
    collabTickIntervalMs: options.collabTickIntervalMs ?? 50,
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
    workspace,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

interface Session {
  client: HttpClient;
  userId: string;
}

async function bootstrapOwner(runtime: Runtime): Promise<Session> {
  const client = new HttpClient(runtime.origin);
  const response = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
    body: {
      email: "owner@example.com",
      displayName: "Ada Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(response.status, 201);
  return { client, userId: response.data.user.id as string };
}

async function addMember(
  runtime: Runtime,
  email: string,
  displayName: string,
  role: "developer" | "viewer",
): Promise<Session> {
  const organizations = await runtime.store.listOrganizations();
  const organizationId = organizations[0]?.id ?? "";
  const user = await runtime.store.createUser({
    email,
    displayName,
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({ organizationId, userId: user.id, role });
  const client = new HttpClient(runtime.origin);
  const login = await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { client, userId: user.id };
}

async function createRepository(session: Session, id: string): Promise<string> {
  const response = await session.client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
    { method: "POST", body: { id } },
  );
  assert.equal(response.status, 201);
  return DEFAULT_PROJECT_ID;
}

function query(input: {
  projectId: string;
  repositoryId: string;
  path: string;
  owner?: string;
}): string {
  const parameters = new URLSearchParams({
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    path: input.path,
  });
  if (input.owner !== undefined) {
    parameters.set("owner", input.owner);
  }
  return parameters.toString();
}

// ---- tests ------------------------------------------------------------------

test("two sessions on one file see each other's edits and carets", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "src/index.ts" },
    "const answer = 1;\n",
  );
  const guest = await addMember(runtime, "dev@example.com", "Grace Dev", "developer");

  const first = (
    await CollabSocket.connect(
      runtime.port,
      owner.client.cookieHeader,
      query({ projectId, repositoryId: "app", path: "src/index.ts" }),
    )
  ).socket;
  assert.ok(first !== undefined);
  const hello = await first.next("welcome");
  assert.equal(hello.content, "const answer = 1;\n");
  assert.equal(hello.revision, 0);
  assert.equal(hello.participants.length, 1);
  assert.equal(hello.dirty, false);

  // The guest addresses the owner's overlay, which is only reachable because
  // the owner is sitting in it.
  const second = (
    await CollabSocket.connect(
      runtime.port,
      guest.client.cookieHeader,
      query({
        projectId,
        repositoryId: "app",
        path: "src/index.ts",
        owner: owner.userId,
      }),
    )
  ).socket;
  assert.ok(second !== undefined);
  const guestHello = await second.next("welcome");
  assert.equal(guestHello.content, "const answer = 1;\n");
  assert.equal(guestHello.participants.length, 2);
  assert.equal(guestHello.ownerUserId, owner.userId);

  const joined = await first.next("join");
  assert.equal(joined.participant.displayName, "Grace Dev");
  assert.equal(joined.participant.owner, false);
  assert.match(joined.participant.color, /^#[0-9a-f]{6}$/u);

  // The owner types at the end of the line.
  first.send({
    type: "op",
    revision: 0,
    operation: [17, " // ok", 1],
    selection: { anchor: 23, head: 23 },
  });
  const ack = await first.next("ack");
  assert.equal(ack.revision, 1);

  const relayed = await second.next("op");
  assert.equal(relayed.revision, 1);
  assert.deepEqual(relayed.operation, [17, " // ok", 1]);
  assert.equal(relayed.participantId, hello.participantId);

  // And the owner's caret arrives with it.
  const caret = await second.next("selection");
  assert.deepEqual(caret.selection, { anchor: 23, head: 23 });
  assert.equal(caret.participantId, hello.participantId);

  // The guest moves its own caret; the owner sees it.
  second.send({ type: "selection", revision: 1, selection: { anchor: 6, head: 12 } });
  const guestCaret = await first.next("selection");
  assert.deepEqual(guestCaret.selection, { anchor: 6, head: 12 });
  assert.equal(guestCaret.participantId, guestHello.participantId);

  first.end();
  second.end();
});

test("concurrent edits from both sides converge on one document", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "a.txt" },
    "abcdef",
  );
  const guest = await addMember(runtime, "dev@example.com", "Grace Dev", "developer");

  const scope = { projectId, repositoryId: "app", path: "a.txt" };
  const first = (
    await CollabSocket.connect(runtime.port, owner.client.cookieHeader, query(scope))
  ).socket;
  assert.ok(first !== undefined);
  await first.next("welcome");
  const second = (
    await CollabSocket.connect(
      runtime.port,
      guest.client.cookieHeader,
      query({ ...scope, owner: owner.userId }),
    )
  ).socket;
  assert.ok(second !== undefined);
  await second.next("welcome");
  await first.next("join");

  // Both describe revision 0: neither has seen the other's edit. The server
  // rebases whichever lands second.
  first.send({ type: "op", revision: 0, operation: ["<", 6] });
  second.send({ type: "op", revision: 0, operation: [6, ">"] });

  await first.next("ack");
  await second.next("ack");
  await first.next("op");
  await second.next("op");

  // Both saved copies must be the same text, and it must contain both edits.
  first.send({ type: "save" });
  const saved = await first.next("saved");
  assert.equal(saved.revision, 2);
  assert.equal(
    runtime.workspace.files.get(`${owner.userId}|app|a.txt`),
    "<abcdef>",
  );
  second.end();
  first.end();
});

test("a guest cannot open an overlay whose owner is not sharing it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "secret.ts" },
    "const draft = true;\n",
  );
  const guest = await addMember(runtime, "dev@example.com", "Grace Dev", "developer");

  // Nobody is in the room, so the owner's private draft stays private even
  // though the guest holds submit_task on the project and knows the path.
  const attempt = await CollabSocket.connect(
    runtime.port,
    guest.client.cookieHeader,
    query({
      projectId,
      repositoryId: "app",
      path: "secret.ts",
      owner: owner.userId,
    }),
  );
  assert.equal(attempt.status, 403);
  assert.equal(attempt.socket, undefined);

  // Once the owner opens it, the same request succeeds.
  const host = (
    await CollabSocket.connect(
      runtime.port,
      owner.client.cookieHeader,
      query({ projectId, repositoryId: "app", path: "secret.ts" }),
    )
  ).socket;
  assert.ok(host !== undefined);
  await host.next("welcome");
  const retry = await CollabSocket.connect(
    runtime.port,
    guest.client.cookieHeader,
    query({
      projectId,
      repositoryId: "app",
      path: "secret.ts",
      owner: owner.userId,
    }),
  );
  assert.ok(retry.socket !== undefined);
  await retry.socket.next("welcome");

  // And the join is on the record.
  const events = await runtime.store.listAuditEvents({});
  const join = events.find(
    (record) => record.event.type === "workspace_collaboration_joined",
  );
  assert.ok(join !== undefined, "expected the guest join to be audited");
  assert.equal(join.event.data["actorId"], guest.userId);
  assert.equal(join.event.data["ownerId"], owner.userId);
  assert.equal(join.event.data["path"], "secret.ts");

  retry.socket.end();
  host.end();
});

test("a viewer without submit_task cannot open a collaboration socket", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "a.txt" },
    "hello",
  );
  const viewer = await addMember(runtime, "viewer@example.com", "Vi", "viewer");
  const attempt = await CollabSocket.connect(
    runtime.port,
    viewer.client.cookieHeader,
    query({ projectId, repositoryId: "app", path: "a.txt" }),
  );
  assert.equal(attempt.status, 401);
});

test("an unauthenticated socket is refused", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  const attempt = await CollabSocket.connect(
    runtime.port,
    "",
    query({ projectId, repositoryId: "app", path: "a.txt" }),
  );
  assert.equal(attempt.status, 401);
});

test("missing parameters and unusable files are refused", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  const cookie = owner.client.cookieHeader;

  assert.equal(
    (await CollabSocket.connect(runtime.port, cookie, "projectId=x")).status,
    400,
  );
  assert.equal(
    (
      await CollabSocket.connect(
        runtime.port,
        cookie,
        query({ projectId, repositoryId: "app", path: "nope.ts" }),
      )
    ).status,
    404,
  );

  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "logo.png" },
    "binary",
  );
  assert.equal(
    (
      await CollabSocket.connect(
        runtime.port,
        cookie,
        query({ projectId, repositoryId: "app", path: "logo.png" }),
      )
    ).status,
    415,
  );

  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "huge.big" },
    "truncated",
  );
  assert.equal(
    (
      await CollabSocket.connect(
        runtime.port,
        cookie,
        query({ projectId, repositoryId: "app", path: "huge.big" }),
      )
    ).status,
    415,
  );
});

test("the audit event stream still works alongside the collaboration socket", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = DEFAULT_PROJECT_ID;

  // Both endpoints share one `upgrade` listener; routing must not let either
  // hub tear down the other's socket.
  const events = await new Promise<{ status?: number; upgraded: boolean }>(
    (resolve, reject) => {
      const request = http.request({
        port: runtime.port,
        host: "127.0.0.1",
        path: `/api/v1/events?projectId=${encodeURIComponent(projectId)}`,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          Cookie: owner.client.cookieHeader,
        },
      });
      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve({ upgraded: true });
      });
      request.on("response", (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, upgraded: false });
      });
      request.on("error", reject);
      request.end();
    },
  );
  assert.ok(events.upgraded, "the audit stream should still upgrade");

  // An unknown WebSocket path is still a 404 rather than a hung socket.
  const unknown = await new Promise<number>((resolve, reject) => {
    const request = http.request({
      port: runtime.port,
      host: "127.0.0.1",
      path: "/api/v1/nothing",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        Cookie: owner.client.cookieHeader,
      },
    });
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(unknown, 404);
});

test("saving flushes the shared document into the owner's overlay", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "a.txt" },
    "start",
  );
  const guest = await addMember(runtime, "dev@example.com", "Grace Dev", "developer");
  const scope = { projectId, repositoryId: "app", path: "a.txt" };

  const host = (
    await CollabSocket.connect(runtime.port, owner.client.cookieHeader, query(scope))
  ).socket;
  assert.ok(host !== undefined);
  await host.next("welcome");
  const visitor = (
    await CollabSocket.connect(
      runtime.port,
      guest.client.cookieHeader,
      query({ ...scope, owner: owner.userId }),
    )
  ).socket;
  assert.ok(visitor !== undefined);
  await visitor.next("welcome");
  await host.next("join");

  // The guest edits and saves; the text lands in the *owner's* workspace,
  // never in a workspace of the guest's own.
  visitor.send({ type: "op", revision: 0, operation: [5, "ed"] });
  await visitor.next("ack");
  await host.next("op");
  visitor.send({ type: "save" });
  const saved = await visitor.next("saved");
  assert.equal(saved.savedBy, guest.userId);
  assert.equal(runtime.workspace.files.get(`${owner.userId}|app|a.txt`), "started");
  assert.equal(runtime.workspace.files.has(`${guest.userId}|app|a.txt`), false);
  // Everyone in the room learns the buffer is clean again.
  assert.equal((await host.next("saved")).revision, 1);

  const audited = (await runtime.store.listAuditEvents({})).find(
    (record) => record.event.type === "workspace_collaboration_saved",
  );
  assert.ok(audited !== undefined);
  assert.equal(audited.event.data["actorId"], guest.userId);
  assert.equal(audited.event.data["ownerId"], owner.userId);

  visitor.end();
  host.end();
});

test("a failed write reports an error and does not claim the document is saved", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "a.txt" },
    "start",
  );
  const host = (
    await CollabSocket.connect(
      runtime.port,
      owner.client.cookieHeader,
      query({ projectId, repositoryId: "app", path: "a.txt" }),
    )
  ).socket;
  assert.ok(host !== undefined);
  await host.next("welcome");
  host.send({ type: "op", revision: 0, operation: [5, "!"] });
  await host.next("ack");
  runtime.workspace.failWrites = true;
  host.send({ type: "save" });
  const error = await host.next("error");
  assert.equal(error.fatal, false);
  assert.equal(runtime.workspace.files.get(`${owner.userId}|app|a.txt`), "start");
  host.end();
});

test("a stale or malformed operation produces a fatal error the client resyncs from", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "a.txt" },
    "abc",
  );
  const host = (
    await CollabSocket.connect(
      runtime.port,
      owner.client.cookieHeader,
      query({ projectId, repositoryId: "app", path: "a.txt" }),
    )
  ).socket;
  assert.ok(host !== undefined);
  await host.next("welcome");

  // An operation over the wrong document length cannot be rebased.
  host.send({ type: "op", revision: 0, operation: [99, "x"] });
  const failure = await host.next("error");
  assert.equal(failure.fatal, true);

  // The connection survives, and a resync hands back a usable snapshot.
  host.send({ type: "resync" });
  const snapshot = await host.next("welcome");
  assert.equal(snapshot.content, "abc");
  assert.equal(snapshot.revision, 0);

  // Garbage is rejected the same way rather than closing the socket.
  host.send({ type: "nonsense" });
  assert.equal((await host.next("error")).code, "invalid_message");

  // And the session still works afterwards.
  host.send({ type: "op", revision: 0, operation: [3, "d"] });
  assert.equal((await host.next("ack")).revision, 1);
  host.end();
});

test("a fragmented message is reassembled", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "a.txt" },
    "abc",
  );
  const host = (
    await CollabSocket.connect(
      runtime.port,
      owner.client.cookieHeader,
      query({ projectId, repositoryId: "app", path: "a.txt" }),
    )
  ).socket;
  assert.ok(host !== undefined);
  await host.next("welcome");
  host.sendFragmented({ type: "op", revision: 0, operation: [3, "defgh"] });
  assert.equal((await host.next("ack")).revision, 1);
  host.end();
});

test("an unmasked client frame closes the connection", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "a.txt" },
    "abc",
  );
  const host = (
    await CollabSocket.connect(
      runtime.port,
      owner.client.cookieHeader,
      query({ projectId, repositoryId: "app", path: "a.txt" }),
    )
  ).socket;
  assert.ok(host !== undefined);
  await host.next("welcome");
  const payload = Buffer.from('{"type":"save"}', "utf8");
  host.sendRaw(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  assert.equal(await host.waitForClose(), 1002);
});

test("a participant leaving is announced and the room is reclaimed", async (t) => {
  const runtime = await startRuntime(t);
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "a.txt" },
    "abc",
  );
  const guest = await addMember(runtime, "dev@example.com", "Grace Dev", "developer");
  const scope = { projectId, repositoryId: "app", path: "a.txt" };

  const host = (
    await CollabSocket.connect(runtime.port, owner.client.cookieHeader, query(scope))
  ).socket;
  assert.ok(host !== undefined);
  const hostHello = await host.next("welcome");
  const visitor = (
    await CollabSocket.connect(
      runtime.port,
      guest.client.cookieHeader,
      query({ ...scope, owner: owner.userId }),
    )
  ).socket;
  assert.ok(visitor !== undefined);
  const visitorHello = await visitor.next("welcome");
  await host.next("join");

  visitor.end();
  const left = await host.next("leave");
  assert.equal(left.participantId, visitorHello.participantId);
  assert.equal(hostHello.participantId !== visitorHello.participantId, true);

  host.end();
  // A clean room with nobody in it is dropped rather than held forever.
  const deadline = Date.now() + 3_000;
  while (runtime.gateway.collaboration.roomCount > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(runtime.gateway.collaboration.roomCount, 0);
});

test("an unsaved room outlives its last participant and is flushed when idle", async (t) => {
  const runtime = await startRuntime(t, { collabTickIntervalMs: 20 });
  // A very short idle window so the sweep runs within the test.
  (
    runtime.gateway.collaboration as unknown as { idleFlushMs: number }
  ).idleFlushMs = 1;
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "a.txt" },
    "abc",
  );
  const host = (
    await CollabSocket.connect(
      runtime.port,
      owner.client.cookieHeader,
      query({ projectId, repositoryId: "app", path: "a.txt" }),
    )
  ).socket;
  assert.ok(host !== undefined);
  await host.next("welcome");
  host.send({ type: "op", revision: 0, operation: [3, "def"] });
  await host.next("ack");
  host.end();

  // Closing the tab must not throw the unsaved text away.
  const deadline = Date.now() + 5_000;
  while (
    runtime.workspace.files.get(`${owner.userId}|app|a.txt`) !== "abcdef" &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(runtime.workspace.files.get(`${owner.userId}|app|a.txt`), "abcdef");
});

test("an agent's in-flight work on the open file is announced", async (t) => {
  const runtime = await startRuntime(t, { collabTickIntervalMs: 20 });
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "src/index.ts" },
    "const answer = 1;\n",
  );
  const host = (
    await CollabSocket.connect(
      runtime.port,
      owner.client.cookieHeader,
      query({ projectId, repositoryId: "app", path: "src/index.ts" }),
    )
  ).socket;
  assert.ok(host !== undefined);
  const hello = await host.next("welcome");
  assert.deepEqual(hello.agents, []);

  const repository = await runtime.store.getRepository("app");
  assert.ok(repository !== undefined);
  const run = await runtime.store.createRun({
    repository,
    projectId,
    mode: "coordinated",
    scenario: "test",
    baseVersion: {
      sequence: 1,
      revision: "a".repeat(40),
      branch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
  await runtime.store.saveTask(run.id, {
    id: "task_agentic",
    objective: "Rename the answer",
    agentId: "codex",
    validationCommands: [],
    projectId,
  });
  await runtime.store.appendAudit(run.id, {
    type: "plan_received",
    taskId: "task_agentic",
    data: { expectedFiles: ["src/index.ts"], riskLevel: "medium" },
  });

  const planned = await host.next("agents");
  assert.equal(planned.agents.length, 1);
  assert.equal(planned.agents[0].stage, "planned");
  assert.equal(planned.agents[0].agentId, "codex");
  assert.equal(planned.agents[0].objective, "Rename the answer");

  await runtime.store.appendAudit(run.id, {
    type: "changeset_collected",
    taskId: "task_agentic",
    data: { changeSetId: "cs_1", files: ["src/index.ts"] },
  });
  const changed = await host.next("agents");
  assert.equal(changed.agents[0].stage, "changed");

  // Once the work lands (or fails) the badge goes away.
  await runtime.store.appendAudit(run.id, {
    type: "canonical_promoted",
    taskId: "task_agentic",
    data: { revision: "b".repeat(40) },
  });
  const cleared = await host.next("agents");
  assert.deepEqual(cleared.agents, []);
  host.end();
});

test("an agent working on a different file is not announced", async (t) => {
  const runtime = await startRuntime(t, { collabTickIntervalMs: 20 });
  const owner = await bootstrapOwner(runtime);
  const projectId = await createRepository(owner, "app");
  runtime.workspace.seed(
    { userId: owner.userId, repositoryId: "app", path: "src/index.ts" },
    "const answer = 1;\n",
  );
  const host = (
    await CollabSocket.connect(
      runtime.port,
      owner.client.cookieHeader,
      query({ projectId, repositoryId: "app", path: "src/index.ts" }),
    )
  ).socket;
  assert.ok(host !== undefined);
  await host.next("welcome");

  const repository = await runtime.store.getRepository("app");
  assert.ok(repository !== undefined);
  const run = await runtime.store.createRun({
    repository,
    projectId,
    mode: "coordinated",
    scenario: "test",
    baseVersion: {
      sequence: 1,
      revision: "a".repeat(40),
      branch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
  await runtime.store.appendAudit(run.id, {
    type: "changeset_collected",
    taskId: "task_elsewhere",
    data: { changeSetId: "cs_2", files: ["src/other.ts"] },
  });
  // A human's own overlay submission is not an agent editing behind them.
  await runtime.store.appendAudit(run.id, {
    type: "plan_received",
    taskId: "task_self",
    data: {
      expectedFiles: ["src/index.ts"],
      source: "workspace-submit",
      actorId: owner.userId,
    },
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  await assert.rejects(async () => await host.next("agents", 200));
  host.end();
});
