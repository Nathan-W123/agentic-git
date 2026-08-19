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
    // Recovering a password is two more forms with two more addresses: one to
    // ask for a link, one the link itself opens.
    ["forgot", "forgot"],
    ["reset", "reset"],
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
  // And the click that swaps forms writes the URL, so the address bar is
  // always something that can be shared.
  assert.match(
    app,
    /authMode = value;[\s\S]{0,400}AUTH_MODE_HASHES\.get\(value\)/u,
    "switching forms should write the matching hash",
  );
});

/**
 * A sign-in link is a request for the sign-in page.
 *
 * It used to be answered by rewriting the hash to "#chats" whenever a session
 * happened to be in place, so `/#signin` opened the app of whoever last used
 * the browser — indistinguishable from `/#chats`, and useless to somebody who
 * was sent the link so they could get into an account of their own.
 */
test("a signed-in visitor following an auth link lands on the form", async () => {
  const app = await publicFile("app.js");
  const boot = app.slice(
    app.indexOf("async function boot()"),
    app.indexOf("async function boot()") + 2000,
  );
  assert.equal(
    boot.includes('window.location.hash = "#chats"'),
    false,
    "boot should no longer redirect an auth link into the app",
  );
  assert.match(
    boot,
    /const linked = authModeFromHash\(\);\s*if \(linked !== undefined && state\.principal !== undefined\) \{\s*await signOutForAuthLink\(linked\);\s*return;/u,
    "an auth link should win over the session it arrived on top of",
  );
  // The session has to actually end: a sign-in form drawn over a live session
  // is a dead end, because a reload walks straight past it.
  const helper = app.slice(app.indexOf("async function signOutForAuthLink("));
  const body = helper.slice(0, helper.indexOf("\n}\n"));
  assert.match(body, /api\("\/auth\/logout", \{ method: "POST"/u);
  assert.match(body, /state\.principal = undefined/u);
  assert.match(body, /authMode = mode/u);
  assert.match(body, /showAuth\(\)/u);
  // Signing in from that form must not be undone by the hash that opened it.
  for (const submit of ["submitLogin", "submitBootstrap"]) {
    const form = app.slice(app.indexOf(`async function ${submit}(form)`));
    const posted = form.slice(0, form.indexOf("\n}\n"));
    assert.match(
      posted,
      /window\.location\.hash = "#chats";\s*await boot\(\)/u,
      `${submit} should leave the auth hash behind before re-booting`,
    );
  }
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
  // The same link typed into the address bar of a signed-in tab is the same
  // request, and gets the same answer instead of being ignored for not being
  // the name of a screen.
  assert.match(
    body,
    /if \(linked !== undefined && state\.principal !== undefined\) \{\s*void signOutForAuthLink\(linked\);/u,
    "an auth hash should be honoured while the app shell is up",
  );
});

test("creating an account asks for the address and password twice", async () => {
  const app = await publicFile("app.js");
  const auth = app.slice(app.indexOf("function renderAuth()"));
  const form = auth.slice(0, auth.indexOf("function renderPasswordReset()"));
  // A mistyped address is unrecoverable by the person who made it: every way
  // back into the account is sent to the address as typed.
  assert.match(form, /name="confirmEmail"/u, "the address should be retyped");
  assert.match(
    form,
    /name="confirmPassword"/u,
    "the password should be retyped",
  );
  // Sign-in asks for neither: there is nothing there to confirm.
  assert.match(
    form,
    /bootstrap \|\| register[\s\S]{0,600}name="confirmEmail"/u,
    "the retyped fields belong to the create-account forms",
  );
  // Both halves are sent, so the server can refuse a mismatch as well.
  for (const submit of ["submitRegister", "submitBootstrap"]) {
    const body = app.slice(app.indexOf(`async function ${submit}(form)`));
    const posted = body.slice(0, body.indexOf("\n}\n"));
    assert.match(posted, /confirmEmail:/u, `${submit} should send confirmEmail`);
    assert.match(
      posted,
      /confirmationsMatch\(data\)/u,
      `${submit} should check the retyped fields before posting`,
    );
  }
});

test("registration waits for the emailed one-time code before entering the app", async () => {
  const app = await publicFile("app.js");
  const confirmation = app.slice(
    app.indexOf("function renderRegistrationConfirmation()"),
    app.indexOf("function renderAuth()"),
  );
  assert.match(
    confirmation,
    /data-act="registration-confirmation"/u,
    "the challenge should render its own form",
  );
  assert.match(
    confirmation,
    /autocomplete="one-time-code"/u,
    "the code field should use the browser's one-time-code affordance",
  );
  assert.match(confirmation, /pattern="\[0-9\]\{6\}"/u);
  // A deployment with no mail relay sends nothing, and the screen has to say
  // so rather than telling somebody to watch an inbox that stays empty.
  assert.match(
    confirmation,
    /delivery === "log"/u,
    "the challenge should tell people when no email was sent",
  );
  assert.match(confirmation, /server log/iu);

  const start = app.slice(
    app.indexOf("async function submitRegister(form)"),
    app.indexOf("async function submitRegistrationConfirmation(form)"),
  );
  assert.match(start, /registration\.registrationId/u);
  assert.match(
    start,
    /registration\.delivery/u,
    "the challenge should remember whether the code was actually mailed",
  );
  assert.doesNotMatch(
    start,
    /await boot\(\)/u,
    "starting registration must not enter the application",
  );

  const finish = app.slice(
    app.indexOf("async function submitRegistrationConfirmation(form)"),
    app.indexOf("function enterAfterInvitation()"),
  );
  assert.match(finish, /api\("\/auth\/register\/confirm"/u);
  assert.match(finish, /await boot\(\)/u);
  assert.match(finish, /message\.textContent = error\.message/u);
});

test("a forgotten password has a way out of the sign-in form", async () => {
  const app = await publicFile("app.js");
  // The old copy told people to ask their organization owner — which is no
  // answer at all for the owner, who has nobody to ask.
  assert.equal(
    app.includes("owner can reset it"),
    false,
    "the dead-end hint should be gone",
  );
  assert.match(
    app,
    /href="#forgot" data-act="auth-mode" data-value="forgot"/u,
    "sign-in should link to the reset request form",
  );
  // The link carries its secret in the fragment, which browsers do not send
  // to the server, and the form reads it from there.
  assert.match(
    app,
    /hash\.startsWith\("reset\/"\)/u,
    "the reset token should be read out of the fragment",
  );
  assert.match(
    app,
    /api\("\/auth\/password-reset", \{/u,
    "asking for a link should post to the reset endpoint",
  );
  assert.match(
    app,
    /api\("\/auth\/password-reset\/confirm", \{/u,
    "setting the new password should post to the confirm endpoint",
  );
});

test("the signed-out shell keeps the secret in a reset link", async () => {
  const app = await publicFile("app.js");
  const showAuth = app.slice(app.indexOf("function showAuth()"));
  const body = showAuth.slice(0, showAuth.indexOf("\n}\n"));
  // Rewriting the hash to the bare form name would throw the token away, and
  // the page would then have nothing to check.
  assert.match(
    body,
    /!window\.location\.hash\.startsWith\(`#\$\{hash\}`\)/u,
    "the reset token should survive the hash being normalised",
  );
});
