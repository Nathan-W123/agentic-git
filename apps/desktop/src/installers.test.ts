import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* Imported by URL for the reason `worker-agents.test.ts` is: on Windows an
   absolute path is not a valid import specifier, and this suite runs on the
   Windows runner during a release build. */
const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
);

interface Plan {
  vendor: string;
  command: string;
  signIn: string;
}

interface InstallersModule {
  installPlan: (vendor: unknown) => Plan | undefined;
  openSignIn: (vendor: unknown) => boolean;
}

async function load(): Promise<InstallersModule> {
  return (await import(
    pathToFileURL(path.join(electronDir, "installers.mjs")).href
  )) as unknown as InstallersModule;
}

/**
 * The page names a vendor; this module decides what that means.
 *
 * That is the whole security boundary of installing from inside the app. The
 * dashboard is a remote document, so if a command could travel from it to a
 * shell, a compromised or hostile deployment would have arbitrary execution on
 * every machine running Kumi. Nothing here takes a command — only a name, and
 * only names it already knows.
 */
test("only known vendors resolve, and never to caller-supplied commands", async () => {
  const { installPlan, openSignIn } = await load();

  for (const vendor of ["claude", "codex", "cursor"]) {
    const plan = installPlan(vendor);
    assert.equal(plan?.vendor, vendor);
    assert.ok((plan?.command ?? "").length > 0, `${vendor} has no command`);
    assert.ok((plan?.signIn ?? "").length > 0, `${vendor} has no sign-in`);
  }

  // Anything else is nothing at all — not a passthrough, not a default.
  for (const hostile of [
    "gemini",
    "",
    "rm -rf /",
    "codex; calc.exe",
    "../claude",
    "__proto__",
    "constructor",
    undefined,
    null,
    42,
    { vendor: "codex" },
  ]) {
    assert.equal(
      installPlan(hostile),
      undefined,
      `installPlan accepted ${JSON.stringify(hostile)}`,
    );
    assert.equal(
      openSignIn(hostile),
      false,
      `openSignIn accepted ${JSON.stringify(hostile)}`,
    );
  }
});

/**
 * What is shown is what runs.
 *
 * The confirmation exists so somebody can recognise the command and check it
 * against the vendor's docs — two of these pipe a downloaded script into an
 * interpreter, which is a thing to agree to rather than discover. A display
 * string written separately from the invocation would eventually describe
 * something other than what executes, and the dialog would be theatre.
 */
test("the command shown is the vendor's own published one", async () => {
  const { installPlan } = await load();

  assert.match(
    installPlan("codex")?.command ?? "",
    /^npm install -g @openai\/codex$/u,
  );
  assert.match(
    installPlan("claude")?.command ?? "",
    /^npm install -g @anthropic-ai\/claude-code$/u,
  );
  // Cursor's differs by platform, and both forms come from its own docs.
  assert.match(
    installPlan("cursor")?.command ?? "",
    /cursor\.com\/install/u,
  );
  // `agent`, which is what Cursor's installer says to use — not
  // `cursor-agent`, which is a different npm package by a different author.
  assert.equal(installPlan("cursor")?.signIn, "agent");
});
