import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* By URL, for the reason the other electron-free suites are: on Windows an
   absolute path is not a valid import specifier, and this runs on the Windows
   runner during a release build. */
const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
);

interface Verdict {
  state: "signed-in" | "signed-out" | "unknowable" | "unknown";
  detail?: string;
  account?: string;
}

interface Module {
  readVendorLogin(vendor: string, io: unknown): Promise<Verdict>;
  loginIsKnowable(vendor: string): boolean;
  saysSignedOut(output: string): boolean;
}

async function load(): Promise<Module> {
  return (await import(
    pathToFileURL(path.join(electronDir, "vendor-login.mjs")).href
  )) as unknown as Module;
}

/** A runner that answers one canned result, and records what it was asked. */
function runner(result: Record<string, unknown>) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args);
      return result;
    },
  };
}

const NO_FILES = {
  home: "/home/someone",
  join: (...parts: string[]) => parts.join("/"),
  readJson: async () => undefined,
  exists: async () => false,
};

test("Claude is read from the body of its status, not its exit code", async () => {
  const { readVendorLogin } = await load();
  // `claude auth status` exits non-zero purely for being signed out while
  // still printing the status it was asked for. A reader that believed the
  // code would call a signed-in account signed out on any release that
  // decided to exit non-zero for an unrelated reason — and, worse, would
  // call a signed-OUT account signed in the moment the code came back zero.
  const live = runner({
    exitCode: 3,
    stdout: JSON.stringify({ loggedIn: true, email: "someone@example.com" }),
    stderr: "",
  });
  assert.deepEqual(await readVendorLogin("claude", live), {
    state: "signed-in",
    account: "someone@example.com",
  });
  assert.deepEqual(live.calls, [["auth", "status"]]);

  const out = runner({
    exitCode: 0,
    stdout: JSON.stringify({ loggedIn: false }),
    stderr: "",
  });
  assert.equal((await readVendorLogin("claude", out)).state, "signed-out");
});

test("Codex takes the exit code, with its own words as a veto", async () => {
  const { readVendorLogin } = await load();
  const yes = runner({ exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" });
  assert.equal((await readVendorLogin("codex", yes)).state, "signed-in");
  assert.deepEqual(yes.calls, [["login", "status"]]);

  // Exit zero and a stated refusal. The words win, which is the whole reason
  // they are read at all — and "logged in" being a substring of "Not logged
  // in" is why the test is written the other way round.
  const no = runner({ exitCode: 0, stdout: "Not logged in", stderr: "" });
  assert.equal((await readVendorLogin("codex", no)).state, "signed-out");
});

test("a CLI that could not be run is unknown, never signed out", async () => {
  const { readVendorLogin } = await load();
  // These send somebody to two different places: one to a sign-in, the other
  // to "your app could not ask this machine". Folding them together is how a
  // broken probe comes to read as a deliberate refusal.
  const broken = runner({ spawnFailed: true, detail: "spawn ENOENT" });
  const verdict = await readVendorLogin("codex", broken);
  assert.equal(verdict.state, "unknown");
  assert.match(String(verdict.detail), /ENOENT/u);
});

test("Gemini is read from its files, in the order the control plane reads them", async () => {
  const { readVendorLogin } = await load();
  const named = await readVendorLogin("gemini", {
    ...NO_FILES,
    readJson: async () => ({ active: "someone@gmail.com" }),
  });
  assert.deepEqual(named, { state: "signed-in", account: "someone@gmail.com" });

  // No account file, but credentials on disk: still signed in.
  const credentialled = await readVendorLogin("gemini", {
    ...NO_FILES,
    exists: async (file: string) => file.endsWith("oauth_creds.json"),
  });
  assert.equal(credentialled.state, "signed-in");

  assert.equal((await readVendorLogin("gemini", NO_FILES)).state, "signed-out");
});

test("the three browser-session vendors say so rather than guessing", async () => {
  const { readVendorLogin, loginIsKnowable } = await load();
  for (const vendor of ["cursor", "copilot", "kiro"]) {
    assert.equal(loginIsKnowable(vendor), false, vendor);
    const verdict = await readVendorLogin(vendor, NO_FILES);
    assert.equal(verdict.state, "unknowable", vendor);
    assert.match(String(verdict.detail), /browser session/u, vendor);
  }
  for (const vendor of ["claude", "codex", "gemini"]) {
    assert.equal(loginIsKnowable(vendor), true, vendor);
  }
});

test("a probe that throws answers unknown instead of rejecting", async () => {
  const { readVendorLogin } = await load();
  // This runs on the one path whose job is to decide whether to go on. A
  // rejection escaping here would land in the caller's catch and be
  // indistinguishable from a refusal — the exact confusion this module exists
  // to remove.
  const verdict = await readVendorLogin("codex", {
    run: async () => {
      throw new Error("the channel closed");
    },
  });
  assert.equal(verdict.state, "unknown");
  assert.match(String(verdict.detail), /channel closed/u);
});

test("the signed-out phrases match the control plane's, character for character", async () => {
  const { saysSignedOut } = await load();
  // Two copies exist because the desktop's electron modules are plain ESM
  // loaded by Electron and `providers.ts` is TypeScript in another package;
  // neither can import the other. So they are pinned instead. If this fails,
  // the two readers have drifted and one of them is about to tell somebody
  // the opposite of what the other would.
  const providers = await readFile(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "web",
      "src",
      "providers.ts",
    ),
    "utf8",
  );
  const theirs = /export function saysSignedOut[\s\S]*?return (\/[\s\S]*?\/[a-z]*)\.test\(/u
    .exec(providers)?.[1];
  assert.ok(theirs !== undefined, "providers.ts no longer defines saysSignedOut this way");
  const ours = await readFile(path.join(electronDir, "vendor-login.mjs"), "utf8");
  const mine = /export function saysSignedOut[\s\S]*?return (\/[\s\S]*?\/[a-z]*)\.test\(/u
    .exec(ours)?.[1];
  assert.equal(
    mine?.replace(/\s+/gu, ""),
    theirs.replace(/\s+/gu, ""),
    "the desktop and control-plane signed-out readers have drifted",
  );

  // And it does the job either copy is for.
  assert.equal(saysSignedOut("Not logged in"), true);
  assert.equal(saysSignedOut("Logged in using ChatGPT"), false);
});
