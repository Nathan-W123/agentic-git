/**
 * A terminal, over the wire, in both directions.
 *
 * The browser and the machine never address each other — one posts keystrokes
 * and reads output here, the other collects keystrokes and posts output here
 * — so the control plane is the only place the protocol is observable. These
 * drive both halves against a real gateway, because the interesting failures
 * are all about the seam: output read twice, a machine that is not yours,
 * a session addressed by somebody else, a shell that was never offered.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ORGANIZATION_ID, DEFAULT_PROJECT_ID } from "@coord/persistence";

import {
  TestClient,
  addColleague,
  bearer,
  bootstrap,
  invitableRepository,
  startRuntime,
  workerRuntime,
} from "./test-harness.js";

function terminalBase(repositoryId: string): string {
  return `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/terminal`;
}

/** Registers a machine and has it advertise what it can offer. */
async function machine(
  origin: string,
  token: string,
  name: string,
  capability?: { backend: string; shells: { id: string; label: string }[] },
): Promise<string> {
  const registered = await bearer(origin, "/api/v1/workers/register", token, {
    method: "POST",
    body: {
      organizationId: DEFAULT_ORGANIZATION_ID,
      name,
      adapters: ["codex"],
      version: "1.0.0",
    },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const workerId = registered.data.id as string;
  if (capability !== undefined) {
    // One poll is what advertises a machine's terminal. It returns as soon as
    // there is work, so with none it is answered by the caller not waiting.
    // `waitMs: 0` so this returns at once: the poll is what advertises a
    // machine, and a test — like a worker that has just started — wants the
    // advertisement recorded without waiting out a hold it has nothing to
    // wait for.
    await bearer(origin, `/api/v1/workers/${workerId}/terminal`, token, {
      method: "POST",
      body: { capability, waitMs: 0 },
    });
  }
  return workerId;
}

const BASH = {
  backend: "python",
  shells: [
    { id: "bash", label: "bash" },
    { id: "zsh", label: "zsh" },
  ],
};

test("a machine that has not allowed a terminal is offered without one", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const repositoryId = await invitableRepository(client, "term-repo");

  const quiet = await machine(runtime.origin, token, "silent-laptop");
  assert.ok(quiet.length > 0);

  const listed = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/machines`,
    token,
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  const machines = listed.data.machines as Array<Record<string, unknown>>;
  const found = machines.find((entry) => entry["id"] === quiet);
  assert.ok(found !== undefined, "the machine should be listed");
  // Listed, but with no terminal on it. Absence rather than an empty shell
  // list, because "connected but not allowed" and "connected and offering
  // nothing" are different facts and the browser says different things about
  // them — the first names the desktop app, the second does not.
  assert.equal(found?.["terminal"], undefined);

  // And opening one is refused with the sentence that says what to do, on the
  // machine, rather than a bare 409.
  const refused = await bearer(runtime.origin, terminalBase(repositoryId), token, {
    method: "POST",
    body: { workerId: quiet, shell: "bash" },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "terminal_unavailable");
  assert.match(refused.data.error.message, /desktop app/u);
});

test("keystrokes reach the machine and output comes back, once each", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const repositoryId = await invitableRepository(client, "term-repo");
  const workerId = await machine(runtime.origin, token, "my-laptop", BASH);

  const opened = await bearer(runtime.origin, terminalBase(repositoryId), token, {
    method: "POST",
    body: { workerId, shell: "bash", cols: 100, rows: 30 },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  const sessionId = opened.data.session.id as string;
  assert.equal(opened.data.session.shell, "bash");
  assert.equal(opened.data.session.backend, "python");

  // The machine collects: one session to open, with the shape it was asked
  // for. A poll that answered without the size would have every shell start
  // at 80x24 whatever the pane said.
  const first = await bearer(
    runtime.origin,
    `/api/v1/workers/${workerId}/terminal`,
    token,
    { method: "POST", body: { capability: BASH, waitMs: 0 } },
  );
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal((first.data.open as unknown[]).length, 1);
  assert.equal(first.data.open[0].id, sessionId);
  assert.equal(first.data.open[0].cols, 100);
  assert.equal(first.data.open[0].rows, 30);

  // Typed here, collected there — and collected *once*. A poll that handed
  // back the same keystrokes twice would double every character somebody
  // typed, which is the kind of bug that looks like a broken keyboard.
  for (const data of ["ls ", "-la\n"]) {
    const typed = await bearer(
      runtime.origin,
      `${terminalBase(repositoryId)}/${sessionId}/input`,
      token,
      { method: "POST", body: { data } },
    );
    assert.equal(typed.status, 200, JSON.stringify(typed.data));
  }
  const second = await bearer(
    runtime.origin,
    `/api/v1/workers/${workerId}/terminal`,
    token,
    { method: "POST", body: { capability: BASH, waitMs: 0 } },
  );
  assert.equal(second.status, 200);
  assert.deepEqual(
    (second.data.input as Array<Record<string, unknown>>).map((e) => e["data"]),
    ["ls -la\n"],
  );
  // Nothing to open a second time, and nothing left to type.
  assert.equal((second.data.open as unknown[]).length, 0);
  const third = await bearer(
    runtime.origin,
    `/api/v1/workers/${workerId}/terminal`,
    token,
    { method: "POST", body: { capability: BASH, waitMs: 0 } },
  );
  assert.equal((third.data.input as unknown[]).length, 0);

  // Output travels the other way and is read by sequence number, so a reader
  // whose connection dropped asks again from where they were rather than
  // from "whatever has arrived since" — which loses everything in between.
  for (const chunk of ["total 0\r\n", "drwx a\r\n"]) {
    await bearer(
      runtime.origin,
      `/api/v1/workers/${workerId}/terminal/${sessionId}/output`,
      token,
      { method: "POST", body: { data: chunk } },
    );
  }
  const read = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/${sessionId}?after=0`,
    token,
  );
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.data, "total 0\r\ndrwx a\r\n");
  assert.equal(read.data.seq, 2);

  // Asked again from the sequence they reached: nothing new, and no repeat.
  const again = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/${sessionId}?after=2`,
    token,
  );
  assert.equal(again.data.data, "");
  assert.equal(again.data.seq, 2);

  // And asked again from where they *were*, which is what a retry after a
  // dropped response does, they get the same bytes rather than none.
  const retried = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/${sessionId}?after=1`,
    token,
  );
  assert.equal(retried.data.data, "drwx a\r\n");
});

test("a shell the machine never offered is refused", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const repositoryId = await invitableRepository(client, "term-repo");
  const workerId = await machine(runtime.origin, token, "posix-box", BASH);

  const refused = await bearer(runtime.origin, terminalBase(repositoryId), token, {
    method: "POST",
    body: { workerId, shell: "powershell" },
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "unknown_shell");
  // Named, so the answer is about this machine rather than about shells in
  // general — a menu offering `cmd` on a Mac is the thing this prevents.
  assert.match(refused.data.error.message, /posix-box/u);
});

test("a terminal is only ever on your own machine, and only yours to read", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const repositoryId = await invitableRepository(client, "term-repo");
  const workerId = await machine(runtime.origin, token, "my-laptop", BASH);
  const opened = await bearer(runtime.origin, terminalBase(repositoryId), token, {
    method: "POST",
    body: { workerId, shell: "bash" },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  const sessionId = opened.data.session.id as string;

  // Somebody else in the same organization. A shell runs with its owner's
  // login, files and keys, so no role in the project makes another member's
  // laptop theirs to open one on — and a session id is the only thing
  // addressing a live shell, so it cannot be guessable into.
  const colleague = await addColleague(runtime, "terminal-other@example.com");
  const theirs = await colleague.client.request(
    `${terminalBase(repositoryId)}/machines`,
  );
  if (theirs.status === 200) {
    assert.equal(
      (theirs.data.machines as unknown[]).length,
      0,
      "another member's machines are not offered",
    );
  }
  const peek = await colleague.client.request(
    `${terminalBase(repositoryId)}/${sessionId}?after=0`,
  );
  assert.notEqual(peek.status, 200, JSON.stringify(peek.data));

  const typed = await colleague.client.request(
    `${terminalBase(repositoryId)}/${sessionId}/input`,
    { method: "POST", body: { data: "rm -rf /\n" } },
  );
  assert.notEqual(typed.status, 200, JSON.stringify(typed.data));

  // And the owner's session is untouched by any of it.
  const read = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/${sessionId}?after=0`,
    token,
  );
  assert.equal(read.status, 200);
  assert.equal(read.data.data, "");
});

test("closing tells the machine, and a closed session stops answering", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const repositoryId = await invitableRepository(client, "term-repo");
  const workerId = await machine(runtime.origin, token, "my-laptop", BASH);
  const opened = await bearer(runtime.origin, terminalBase(repositoryId), token, {
    method: "POST",
    body: { workerId, shell: "bash" },
  });
  const sessionId = opened.data.session.id as string;
  // Collected once, so the machine knows the session exists — otherwise
  // there is nothing there to be told to close.
  await bearer(runtime.origin, `/api/v1/workers/${workerId}/terminal`, token, {
    method: "POST",
    body: { capability: BASH, waitMs: 0 },
  });

  const closed = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/${sessionId}`,
    token,
    { method: "DELETE" },
  );
  assert.equal(closed.status, 200, JSON.stringify(closed.data));

  const work = await bearer(
    runtime.origin,
    `/api/v1/workers/${workerId}/terminal`,
    token,
    { method: "POST", body: { capability: BASH, waitMs: 0 } },
  );
  assert.deepEqual(work.data.close, [sessionId]);

  // Gone here too. A shell that has been ended must not keep answering
  // reads, or a stale tab looks like a live terminal.
  const after = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/${sessionId}?after=0`,
    token,
  );
  assert.equal(after.status, 404, JSON.stringify(after.data));
});

test("the shell exiting is reported, with the status it went with", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const repositoryId = await invitableRepository(client, "term-repo");
  const workerId = await machine(runtime.origin, token, "my-laptop", BASH);
  const opened = await bearer(runtime.origin, terminalBase(repositoryId), token, {
    method: "POST",
    body: { workerId, shell: "bash" },
  });
  const sessionId = opened.data.session.id as string;

  await bearer(
    runtime.origin,
    `/api/v1/workers/${workerId}/terminal/${sessionId}/output`,
    token,
    { method: "POST", body: { data: "goodbye\r\n" } },
  );
  await bearer(
    runtime.origin,
    `/api/v1/workers/${workerId}/terminal/${sessionId}/exit`,
    token,
    { method: "POST", body: { exitCode: 130 } },
  );

  const read = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/${sessionId}?after=0`,
    token,
  );
  assert.equal(read.status, 200, JSON.stringify(read.data));
  // The last thing it said, and then the fact that it ended. Both: a
  // terminal that reported the exit without the output would drop whatever
  // the command printed on its way out, which is usually the error.
  assert.equal(read.data.data, "goodbye\r\n");
  assert.equal(read.data.exitCode, 130);
});

test("output is bounded, and a reader is told when the middle was dropped", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const repositoryId = await invitableRepository(client, "term-repo");
  const workerId = await machine(runtime.origin, token, "my-laptop", BASH);
  const opened = await bearer(runtime.origin, terminalBase(repositoryId), token, {
    method: "POST",
    body: { workerId, shell: "bash" },
  });
  const sessionId = opened.data.session.id as string;

  // `yes` in a terminal produces megabytes a second, and this process serves
  // everybody. What is kept is a screen's worth of scrollback, not a
  // transcript.
  const block = "x".repeat(64 * 1024);
  for (let index = 0; index < 6; index += 1) {
    await bearer(
      runtime.origin,
      `/api/v1/workers/${workerId}/terminal/${sessionId}/output`,
      token,
      { method: "POST", body: { data: block } },
    );
  }
  const read = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/${sessionId}?after=0`,
    token,
  );
  assert.equal(read.status, 200);
  assert.ok(
    (read.data.data as string).length <= 6 * block.length,
    "the buffer must not grow without limit",
  );
  assert.ok(
    (read.data.data as string).length < 6 * block.length,
    "something should have been dropped",
  );
  // Said rather than seamless. A gap presented as continuous output is a
  // terminal quietly lying about what a command printed.
  const stale = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/${sessionId}?after=1`,
    token,
  );
  assert.equal(stale.data.truncated, true);
});

test("a machine cannot post into a session that is not its own", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const repositoryId = await invitableRepository(client, "term-repo");
  const mine = await machine(runtime.origin, token, "my-laptop", BASH);
  const other = await machine(runtime.origin, token, "other-laptop", BASH);
  const opened = await bearer(runtime.origin, terminalBase(repositoryId), token, {
    method: "POST",
    body: { workerId: mine, shell: "bash" },
  });
  const sessionId = opened.data.session.id as string;

  // Both machines belong to the same person here, which is the point: even
  // then, a session belongs to the machine running it. Otherwise one worker
  // could write into another's terminal, and the output a reader trusts to
  // be their shell's would be somebody else's process.
  await bearer(
    runtime.origin,
    `/api/v1/workers/${other}/terminal/${sessionId}/output`,
    token,
    { method: "POST", body: { data: "not from this machine" } },
  );
  const read = await bearer(
    runtime.origin,
    `${terminalBase(repositoryId)}/${sessionId}?after=0`,
    token,
  );
  assert.equal(read.data.data, "");
});

test("a reader without run_task is refused the whole surface", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "term-authz-repo");

  // `view` is not enough. A terminal is the power to run code on a machine,
  // which is what `run_task` names, and a reviewer holding read access is
  // not being handed a shell.
  const colleague = await addColleague(runtime, "terminal-viewer@example.com");
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "viewer",
  });
  const refused = await colleague.client.request(
    `${terminalBase(repositoryId)}/machines`,
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
});
