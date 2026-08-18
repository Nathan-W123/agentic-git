import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The sign-in page has an address.
 *
 * Before this, the signed-out shell was reachable only by arriving without a
 * session: every link on it was `href="#"`, and the URL said nothing about
 * which form was showing — so there was no link anybody could be sent that
 * lands on sign-in. The dashboard ships as plain ES modules with no bundler
 * and no DOM in the test run, so the behaviour is pinned the way the rest of
 * the browser surface is pinned: by asserting the shape of the source.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("the signed-out forms are named by a hash", async () => {
  const app = await publicFile("app.js");
  // The table is the whole vocabulary: a hash somebody can be sent on one
  // side, the form it opens on the other.
  for (const [hash, mode] of [
    ["signin", "login"],
    ["register", "register"],
    ["setup", "bootstrap"],
  ] as const) {
    assert.match(
      app,
      new RegExp(`\\["${hash}", "${mode}"\\]`, "u"),
      `#${hash} should open the ${mode} form`,
    );
  }
  assert.match(
    app,
    /function authModeFromHash\(\)\s*\{\s*return AUTH_HASHES\.get\(/u,
    "the URL should be read for the form it asks for",
  );
});

test("the footer links are addresses rather than dead hashes", async () => {
  const app = await publicFile("app.js");
  // The link out of Create an account is the one this exists for: it is the
  // sign-in link, and it has to be pasteable.
  assert.match(
    app,
    /href="#signin" data-act="auth-mode" data-value="login"/u,
    "the sign-in link should point at #signin",
  );
  assert.match(
    app,
    /href="#register" data-act="auth-mode" data-value="register"/u,
    "the create-account link should point at #register",
  );
  const auth = app.slice(app.indexOf("function renderAuth()"));
  const foot = auth.slice(0, auth.indexOf("async function submitLogin"));
  assert.equal(
    foot.includes('href="#" data-act="auth-mode"'),
    false,
    "no auth-mode link should be left on a dead hash",
  );
});

test("arriving on a sign-in link opens sign-in, and clicking one moves the URL", async () => {
  const app = await publicFile("app.js");
  // Boot honours the link somebody arrived on — but only once first-time
  // setup is out of the way, because nothing else can succeed before it.
  const boot = app.slice(app.indexOf("async function boot()"));
  const setup = boot.indexOf('authMode = "bootstrap"');
  const fromHash = boot.indexOf("const mode = authModeFromHash()", setup);
  assert.notEqual(setup, -1, "bootstrap should still win when setup is due");
  assert.notEqual(fromHash, -1, "boot should read the form out of the URL");
  // Signed in already: the hash has to move before the router reads it, or
  // the sign-in link would leave a signed-in person on an unknown route.
  const redirect = boot.indexOf('window.location.hash = "#chats"', fromHash);
  const applied = boot.indexOf("applyHash()", fromHash);
  assert.notEqual(redirect, -1, "a signed-in visitor should be sent inside");
  assert.equal(
    redirect < applied,
    true,
    "the redirect should happen before the router reads the hash",
  );
  // And the click that swaps forms writes the URL, so the address bar is
  // always something that can be shared.
  assert.match(
    app,
    /authMode = value;[\s\S]{0,400}AUTH_MODE_HASHES\.get\(value\)/u,
    "switching forms should write the matching hash",
  );
});

test("the hash router hands the signed-out shell its own hashes", async () => {
  const app = await publicFile("app.js");
  const applyHash = app.slice(app.indexOf("function applyHash()"));
  const body = applyHash.slice(0, applyHash.indexOf("\n}\n"));
  // The auth branch has to come first: "signin" is not a route, so falling
  // through to the router would ignore it.
  const authBranch = body.indexOf("authModeFromHash()");
  const routes = body.indexOf("ROUTES.has(route)");
  assert.notEqual(authBranch, -1, "applyHash should know about auth hashes");
  assert.notEqual(routes, -1, "applyHash should still route screens");
  assert.equal(authBranch < routes, true, "auth hashes should be read first");
  assert.match(
    body,
    /authRoot\.innerHTML = renderAuth\(\)/u,
    "a hash change while signed out should redraw the form",
  );
});
