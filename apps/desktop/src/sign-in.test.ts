import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { signIn } from "./sign-in.js";

/**
 * A control plane, reduced to the one route this flow calls.
 *
 * The real gateway is tested against the real routes in the api-gateway suite.
 * What is under test here is the app's half: what it opens, what it accepts
 * back, and what it refuses.
 */
async function stubServer(
  exchange: (code: string) => { status: number; body: unknown },
): Promise<{ origin: string; close: () => Promise<void>; codes: string[] }> {
  const codes: string[] = [];
  const server: Server = createServer((request, response) => {
    if (
      request.method === "POST" &&
      request.url === "/api/v1/auth/app-authorization/exchange"
    ) {
      let raw = "";
      request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      request.on("end", () => {
        const code = String(
          (JSON.parse(raw || "{}") as { code?: unknown }).code ?? "",
        );
        codes.push(code);
        const answer = exchange(code);
        response
          .writeHead(answer.status, { "Content-Type": "application/json" })
          .end(JSON.stringify(answer.body));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    codes,
    close: async () =>
      await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Plays the browser: reads what was opened, then calls back. */
function browserThatApproves(
  reply: (params: URLSearchParams) => URLSearchParams,
): { open: (url: string) => Promise<void>; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    open: async (url: string) => {
      opened.push(url);
      const authorize = new URL(url);
      const callback = new URL(
        authorize.searchParams.get("redirect_uri") ?? "",
      );
      for (const [key, value] of reply(authorize.searchParams)) {
        callback.searchParams.set(key, value);
      }
      await fetch(callback.toString());
    },
  };
}

test("approving in the browser hands the app a token, with nothing typed", async () => {
  const control = await stubServer((code) => ({
    status: 201,
    body: { token: `coord_pat_for_${code.slice(0, 6)}`, name: "My laptop" },
  }));
  try {
    const browser = browserThatApproves((params) => {
      const back = new URLSearchParams();
      // The gateway echoes the state and adds a code. Both come back.
      back.set("state", params.get("state") ?? "");
      back.set("code", "granted-code-value");
      return back;
    });

    const result = await signIn({
      server: control.origin,
      appName: "My laptop",
      openBrowser: browser.open,
    });

    assert.equal(result.name, "My laptop");
    assert.match(result.token, /^coord_pat_/u);
    // The code was exchanged over a POST rather than read out of the URL.
    assert.deepEqual(control.codes, ["granted-code-value"]);

    // What the person was actually shown: a page on their own deployment,
    // naming the app, pointed back at a listener only this machine can reach.
    const authorize = new URL(browser.opened[0] ?? "");
    assert.equal(authorize.pathname, "/authorize");
    assert.equal(authorize.searchParams.get("name"), "My laptop");
    const callback = new URL(
      authorize.searchParams.get("redirect_uri") ?? "",
    );
    assert.equal(callback.protocol, "http:");
    assert.equal(callback.hostname, "127.0.0.1");
    assert.ok((authorize.searchParams.get("state") ?? "").length > 20);
  } finally {
    await control.close();
  }
});

test("a reply that does not match this request is refused", async () => {
  // Anything else on this machine can reach a loopback listener. Without the
  // state check it could walk up with a code of its own and sign this app in
  // as somebody else entirely — so a mismatch has to end the attempt rather
  // than be retried or ignored.
  const control = await stubServer(() => ({
    status: 201,
    body: { token: "coord_pat_should_never_be_reached" },
  }));
  try {
    const browser = browserThatApproves(() => {
      const back = new URLSearchParams();
      back.set("state", "a-state-this-app-never-issued");
      back.set("code", "attacker-code");
      return back;
    });

    await assert.rejects(
      signIn({
        server: control.origin,
        appName: "My laptop",
        openBrowser: browser.open,
        timeoutMs: 5_000,
      }),
      /did not match/u,
    );
    // And nothing was exchanged: the flow stopped before spending anything.
    assert.deepEqual(control.codes, []);
  } finally {
    await control.close();
  }
});

test("a refusal ends the wait rather than hanging on it", async () => {
  const control = await stubServer(() => ({ status: 201, body: {} }));
  try {
    // The shape a cancel takes: the right state, and no code.
    const browser = browserThatApproves((params) => {
      const back = new URLSearchParams();
      back.set("state", params.get("state") ?? "");
      return back;
    });

    await assert.rejects(
      signIn({
        server: control.origin,
        appName: "My laptop",
        openBrowser: browser.open,
        timeoutMs: 5_000,
      }),
      /cancelled/u,
    );
  } finally {
    await control.close();
  }
});

test("a control plane that refuses the exchange is reported, not swallowed", async () => {
  const control = await stubServer(() => ({
    status: 400,
    body: { error: { message: "That approval is no longer valid" } },
  }));
  try {
    const browser = browserThatApproves((params) => {
      const back = new URLSearchParams();
      back.set("state", params.get("state") ?? "");
      back.set("code", "expired-code");
      return back;
    });

    await assert.rejects(
      signIn({
        server: control.origin,
        appName: "My laptop",
        openBrowser: browser.open,
        timeoutMs: 5_000,
      }),
      /no longer valid/u,
    );
  } finally {
    await control.close();
  }
});
