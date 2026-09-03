/**
 * Whether a vendor CLI on this machine is actually signed in.
 *
 * The question the connect flow could not ask. An agent used to be created
 * and named the moment somebody pressed Connect, and the machine was consulted
 * afterwards — so a person ended up with a named agent, in every channel,
 * that could not run because the CLI behind it had no login. The toast said
 * so, once, and then it was gone.
 *
 * Only this machine can answer it. Under `COORD_LOCAL_AGENTS_ONLY` the CLI
 * runs here, under this machine's own login, so the control plane's own probe
 * would be asking about a computer the person has never seen — a mistake the
 * usage card made and had to be corrected for.
 *
 * Electron-free on purpose, like `mcp-consent.mjs` and `editor-mcp.mjs`
 * beside it: the process runner and the filesystem come in as arguments, so
 * every branch below is reachable from a test without spawning a CLI or
 * owning a login.
 */

/**
 * The CLI saying, in so many words, that nobody is signed in.
 *
 * A copy of `saysSignedOut` in `apps/web/src/providers.ts`, which cannot be
 * imported here — the desktop's electron modules are plain ESM loaded by
 * Electron directly, and that file is TypeScript in another package.
 * `vendor-login.test.ts` pins the two together, so changing one fails the
 * build until the other follows.
 *
 * Only the refusal is read from text. Its opposite cannot be: a CLI that *is*
 * signed in may say "Logged in using ChatGPT", or "Authenticated", or print an
 * account line and no verb at all. So this is a veto over the exit code rather
 * than the whole test — a refusal is stated, a success is merely exit zero.
 * "logged in" is also a substring of "Not logged in", which is the trap this
 * exists to have been thought about once.
 */
export function saysSignedOut(output) {
  return /\b(?:not logged in|not signed in|no active session|please (?:log|sign) in)\b/iu.test(
    output,
  );
}

/**
 * How each vendor answers, and which of them can answer at all.
 *
 * `ask` returns one of the four states. It is handed a runner and the home
 * directory and nothing else, so a vendor that answers from a file on disk
 * and one that answers from a command look the same from outside.
 *
 * The `unknowable` three are not an oversight. Cursor, Copilot and Kiro sign
 * in through a browser session this deployment deliberately does not treat as
 * a connection — `detectBrowserCli` in the control plane reports `loggedIn:
 * false` for all three by design — so there is no login state here to read.
 * Saying "unknowable" is the honest answer; refusing to connect them at all
 * because of it would make three agents permanently unusable to punish a
 * question nobody can answer.
 */
const VENDOR_LOGIN = {
  claude: {
    /**
     * `claude auth status` prints JSON carrying `loggedIn`, and the exit code
     * is not the signal: it exits non-zero purely because nobody is signed in,
     * while still printing the status it was asked for. Reading the code
     * instead of the body is what once made a working install look absent.
     */
    ask: async ({ run }) => {
      const result = await run(["auth", "status"], { timeoutMs: 30_000 });
      if (result.spawnFailed === true) {
        return { state: "unknown", detail: result.detail ?? "The Claude CLI could not be run." };
      }
      try {
        const status = JSON.parse(result.stdout);
        return status.loggedIn === true
          ? {
              state: "signed-in",
              ...(typeof status.email === "string" ? { account: status.email } : {}),
            }
          : { state: "signed-out" };
      } catch {
        // No parseable body. Fall back to the shared rule rather than
        // guessing: a stated refusal is a refusal, and anything else with a
        // clean exit is taken at its word.
        return verdictFrom(result);
      }
    },
  },
  codex: {
    /**
     * `codex login status` answers zero when it has an account and non-zero
     * when it does not; what it *says* while doing so has changed between
     * releases, which is why the words are only a veto. The control plane's
     * `detectCodex` uses this exact rule, so the connect screen and the
     * connection row cannot disagree.
     */
    ask: async ({ run }) => verdictFrom(await run(["login", "status"], { timeoutMs: 30_000 })),
  },
  gemini: {
    /**
     * Read from disk rather than asked, because the Gemini CLI publishes no
     * status command. The same two files the control plane's `detectGemini`
     * reads, in the same order.
     */
    ask: async ({ home, readJson, exists, join }) => {
      const accounts = await readJson(join(home, ".gemini", "google_accounts.json"));
      const active = typeof accounts?.active === "string" ? accounts.active : undefined;
      if (active !== undefined) {
        return { state: "signed-in", account: active };
      }
      return (await exists(join(home, ".gemini", "oauth_creds.json")))
        ? { state: "signed-in" }
        : { state: "signed-out" };
    },
  },
  cursor: { unknowable: true },
  copilot: { unknowable: true },
  kiro: { unknowable: true },
};

/** Whether this vendor's login can be established from this machine at all. */
export function loginIsKnowable(vendor) {
  return VENDOR_LOGIN[vendor]?.unknowable !== true && VENDOR_LOGIN[vendor] !== undefined;
}

/**
 * Exit code first, the CLI's own words only to veto it.
 *
 * Written once because both halves are easy to get backwards: trusting the
 * words alone tells a signed-in person they are signed out, and trusting the
 * code alone believes a CLI that printed a refusal on its way to exiting zero.
 */
function verdictFrom(result) {
  if (result.spawnFailed === true) {
    return { state: "unknown", detail: result.detail ?? "The CLI could not be run." };
  }
  const said = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (saysSignedOut(said)) {
    return { state: "signed-out" };
  }
  return result.exitCode === 0
    ? { state: "signed-in" }
    : { state: "signed-out" };
}

/**
 * What this machine can say about one vendor's login.
 *
 * Four answers, and the caller must handle all four:
 *
 * - `signed-in`  — the CLI answered and nothing said otherwise.
 * - `signed-out` — the CLI stated a refusal, or failed cleanly.
 * - `unknowable` — this vendor keeps no login state anything here can read.
 * - `unknown`    — the question could not be put: no CLI, a spawn that threw,
 *                  a timeout. Deliberately not folded into `signed-out`,
 *                  because "we could not ask" and "the answer is no" send
 *                  somebody to two different places.
 */
export async function readVendorLogin(vendor, io) {
  const spec = VENDOR_LOGIN[vendor];
  if (spec === undefined) {
    return { state: "unknown", detail: `Kumi does not know how to check ${String(vendor)}.` };
  }
  if (spec.unknowable === true) {
    return {
      state: "unknowable",
      detail: `${String(vendor)} signs in through a browser session Kumi cannot read from here.`,
    };
  }
  try {
    return await spec.ask(io);
  } catch (error) {
    // Never thrown outward. This runs on the one path whose entire job is to
    // decide whether to go on, and a rejection here would be indistinguishable
    // from a refusal — which is the failure this module exists to prevent.
    return {
      state: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
