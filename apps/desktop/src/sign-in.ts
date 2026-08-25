/**
 * Signing a desktop app in without ever showing anybody a token.
 *
 * The app opens the person's browser at the deployment they named, they click
 * Approve on a page that says what is being approved, and the app receives the
 * result on a listener only it can hear. Nothing is copied, pasted, or typed.
 *
 * Deliberately free of any Electron import, and of any dependency at all. The
 * risky half of this flow — a loopback listener, a redirect coming back from
 * a browser, a code exchanged for a credential — is exactly the half worth
 * testing, and it is testable only while it is ordinary Node.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface SignInOptions {
  /** The deployment to sign in to, e.g. `https://kumi.example.com`. */
  server: string;
  /** What this machine will be called in the person's token list. */
  appName: string;
  /** Opens the person's browser. Separate so a test never launches one. */
  openBrowser: (url: string) => void | Promise<void>;
  /** How long to wait for somebody to decide. Default two minutes. */
  timeoutMs?: number;
}

export interface SignInResult {
  token: string;
  name: string;
}

/** The path the browser is sent back to. Nothing else is answered. */
const CALLBACK_PATH = "/kumi-sign-in";

const DEFAULT_TIMEOUT_MS = 120_000;

/** What the person sees in the tab that did its job. */
function closingPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Kumi</title><style>body{margin:0;min-height:100vh;display:grid;
place-items:center;font:15px/1.5 system-ui,sans-serif;background:#0b0d12;
color:#e6e8ee}p{opacity:.7;font-size:13px;margin-top:6px}</style></head>
<body><main style="text-align:center"><strong>${message}</strong>
<p>You can close this tab.</p></main></body></html>`;
}

/** Equal without saying how much of it matched. */
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Runs the whole flow and resolves with a token this app may keep.
 *
 * Rejects rather than hanging on a refusal, a mismatch, or a timeout: an app
 * waiting forever on a browser tab somebody closed is indistinguishable from
 * one that is broken.
 */
export async function signIn(options: SignInOptions): Promise<SignInResult> {
  const server = options.server.replace(/\/+$/u, "");
  const state = randomBytes(24).toString("base64url");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const listener = createServer();
  // Loopback explicitly, never a wildcard bind. The whole security of this
  // flow is that the address the code is delivered to is reachable from
  // nowhere but this machine, and `listen(0)` alone would not promise that.
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });

  const address = listener.address() as AddressInfo | null;
  if (address === null) {
    listener.close();
    throw new Error("Could not open a local listener to sign in with");
  }
  const redirectUri = `http://127.0.0.1:${String(address.port)}${CALLBACK_PATH}`;

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Sign-in timed out waiting for approval"));
      }, timeoutMs);
      timer.unref?.();

      const settle = (outcome: () => void): void => {
        clearTimeout(timer);
        outcome();
      };

      listener.on("request", (request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (url.pathname !== CALLBACK_PATH) {
          response.writeHead(404).end();
          return;
        }
        const returned = url.searchParams.get("state") ?? "";
        const delivered = url.searchParams.get("code") ?? "";
        // The state check is what stops anything else on this machine from
        // walking up to the listener and handing it a code of its choosing —
        // which would sign this app in as somebody else entirely.
        if (!sameSecret(returned, state)) {
          response
            .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
            .end(closingPage("That sign-in did not match this app."));
          settle(() => {
            reject(new Error("Sign-in reply did not match this request"));
          });
          return;
        }
        if (delivered === "") {
          response
            .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
            .end(closingPage("Sign-in was cancelled."));
          settle(() => {
            reject(new Error("Sign-in was cancelled"));
          });
          return;
        }
        response
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(closingPage("Signed in."));
        settle(() => {
          resolve(delivered);
        });
      });

      const authorize = new URL(`${server}/authorize`);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("name", options.appName);
      void Promise.resolve(options.openBrowser(authorize.toString())).catch(
        (error: unknown) => {
          settle(() => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        },
      );
    });

    // Exchanged over a POST rather than read out of the redirect: a token in a
    // URL is a token in the browser's history and in anything logging this
    // listener's requests. The code is worth nothing without this call.
    const exchanged = await fetch(
      `${server}/api/v1/auth/app-authorization/exchange`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      },
    );
    const data = (await exchanged.json().catch(() => ({}))) as {
      token?: unknown;
      name?: unknown;
      error?: { message?: unknown };
    };
    if (!exchanged.ok || typeof data.token !== "string") {
      throw new Error(
        typeof data.error?.message === "string"
          ? data.error.message
          : `Sign-in could not be completed (${String(exchanged.status)})`,
      );
    }
    return {
      token: data.token,
      name: typeof data.name === "string" ? data.name : options.appName,
    };
  } finally {
    listener.close();
  }
}
