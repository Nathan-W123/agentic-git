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
    // Where an invitation lands. Which form it opens is resolved from
    // health rather than fixed here, so one address in the mail serves a
    // deployment selling trials and one giving accounts away.
    ["join", "join"],
    // `register` is the address older invitations carry, so it resolves the
    // same way. It used to resolve to the paid trial unconditionally, which
    // meant that on a deployment with payments off — the only kind that has
    // a waitlist — an invitation landed the person back on the waitlist form
    // they had already filled in.
    ["register", "join"],
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
  // New people are sent to the paid trial now, not to the free form. The
  // assertion is the same one either way: the link out of sign-in is a real
  // address somebody can be sent, rather than a dead `#`.
  assert.match(
    app,
    /href="#signup" data-act="auth-mode" data-value="signup"/u,
    "the create-account link should point at #signup",
  );
  const auth = app.slice(app.indexOf("function renderAuth()"));
  const foot = auth.slice(0, auth.indexOf("async function submitLogin"));
  assert.equal(
    foot.includes('href="#" data-act="auth-mode"'),
    false,
    "no auth-mode link should be left on a dead hash",
  );
});

test("sign-in is a focused card without changing its form contract", async () => {
  const app = await publicFile("app.js");
  const auth = app.slice(app.indexOf("function renderAuth()"));
  const login = auth.slice(
    auth.indexOf("if (!bootstrap && !register)"),
    auth.indexOf('return `<main class="auth-shell">'),
  );

  assert.match(login, /class="auth-shell auth-login-shell"/u);
  assert.match(login, /class="auth-card auth-login-card" data-act="login"/u);
  assert.match(login, /Welcome back/u);
  assert.match(login, /name="email" type="email"/u);
  assert.match(login, /autocomplete="username"/u);
  assert.match(login, /name="password" type="password" minlength="12"/u);
  assert.match(login, /autocomplete="current-password"/u);
  assert.match(
    login,
    /href="#forgot" data-act="auth-mode"\s*data-value="forgot"/u,
    "password recovery should remain available from the sign-in card",
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
  // Sliced to the end of `boot()` rather than to a byte budget the function
  // outgrew. The auth-link check sits further down than it used to, and a
  // window that stops short of it reports the check missing while also making
  // the "#chats" negative below vacuously true — the two failure modes that
  // would let this exact bug back in unnoticed.
  const bootStart = app.indexOf("async function boot()");
  const boot = app.slice(bootStart, app.indexOf("\n}\n", bootStart));
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

test("sign-up enters the app directly, and still handles a mailed code when one is asked for", async () => {
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
  // Email confirmation is off, so the server hands back a session and the new
  // account lands on the chats screen instead of a code form.
  assert.match(
    start,
    /registration\.user !== undefined/u,
    "sign-up should notice when it was signed in outright",
  );
  assert.match(start, /window\.location\.hash = "#chats"/u);
  assert.match(start, /await boot\(\)/u);
  assert.match(start, /registration\.registrationId/u);
  assert.match(
    start,
    /registration\.delivery/u,
    "the challenge should remember whether the code was actually mailed",
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

test("the paid sign-up has a page, a return address, and no card of its own", async () => {
  const app = await publicFile("app.js");

  // Two more addresses: where a trial starts, and where Stripe sends the
  // browser back to. `#welcome/<token>` carries its claim secret in the
  // fragment for the same reason `#reset/<token>` does — the browser never
  // sends it, so it stays out of access logs and out of `Referer`.
  for (const [hash, mode] of [
    ["signup", "signup"],
    ["welcome", "welcome"],
  ]) {
    assert.match(
      app,
      new RegExp(`\\["${hash}", "${mode}"\\]`, "u"),
      `${hash} should open the ${mode} form`,
    );
  }

  // The card is collected on Stripe's page and nowhere else. A card field on
  // this origin would be a different product with a different compliance
  // burden, so its absence is worth asserting rather than assuming.
  const signup = app.slice(
    app.indexOf("function renderSignup()"),
    app.indexOf("function renderWelcome()"),
  );
  assert.match(signup, /name="email"/u);
  // Card *fields*, not the word — `auth-card` is the form's own class, and a
  // regex that cannot tell those apart proves nothing.
  assert.doesNotMatch(signup, /name="(card|cvc|cc-|expiry)/iu);
  assert.doesNotMatch(signup, /autocomplete="cc-/iu);
  assert.match(signup, /data-act="signup"/u);

  // The trial's terms are stated where the card is asked for, not buried.
  assert.match(signup, /Fourteen days free/u);
  assert.match(signup, /bill you on day\s*\n?\s*fifteen/u);

  // Coming back from Stripe, the account is made here — after the payment,
  // never before it.
  const welcome = app.slice(
    app.indexOf("function renderWelcome()"),
    app.indexOf("function renderPasswordReset()"),
  );
  assert.match(welcome, /data-act="signup-complete"/u);
  assert.match(welcome, /name="displayName"/u);
  assert.match(welcome, /name="password"/u);
  // Arriving before the webhook lands is ordinary, not a failure.
  assert.match(welcome, /Confirming your payment/u);
  assert.match(app, /welcomePoll = window\.setTimeout/u);

  // Sign-in sends new people to the paid trial rather than the free form.
  assert.match(app, /href="#signup"[^>]*data-value="signup"/u);
});

test("the waitlist is a signed-out screen with its own address", async () => {
  const app = await publicFile("app.js");

  // A hash, so the marketing site can link straight at it and so somebody can
  // be sent the form rather than "open the app and look for the link".
  assert.match(app, /\["waitlist", "waitlist"\]/u);

  // `#signup` lands here too while payments are off. It is the address on
  // every link this product has ever sent, and a card form nobody can
  // complete is a worse answer than the thing that replaced it.
  assert.match(
    app,
    /mode === "waitlist" \|\| \(mode === "signup" && !paymentsOn\(\)\)/u,
  );

  // Read from health rather than kept as its own flag, so the screen can
  // never disagree with what the server will allow.
  assert.match(
    app,
    /function paymentsOn\(\)\s*\{\s*\n\s*return state\.health\?\.billing\?\.payments === true;/u,
  );

  const waitlist = app.slice(
    app.indexOf("function renderWaitlist()"),
    app.indexOf("function renderSignup()"),
  );
  assert.match(waitlist, /data-act="waitlist"/u);
  assert.match(waitlist, /name="email"/u);
  // No card, and no promise of one: nothing on this screen may imply a
  // charge, because nothing is being charged.
  assert.doesNotMatch(waitlist, /name="(card|cvc|cc-|expiry)/iu);
  assert.doesNotMatch(waitlist, /trial/iu);
  assert.match(waitlist, /nothing to pay/u);

  // Sign-in offers the queue rather than a trial while payments are off.
  assert.match(
    app,
    /href="#waitlist" data-act="auth-mode" data-value="waitlist"/u,
  );

  // And the form posts to the route that holds a place, saying the same thing
  // back whichever state the address was in.
  const submit = app.slice(
    app.indexOf("async function submitWaitlist(form)"),
    app.indexOf("async function submitSignup(form)"),
  );
  assert.match(submit, /joinWaitlist\(\{/u);
  assert.match(submit, /You are on the list/u);
});

test("billing says it is switched off rather than misconfigured", async () => {
  const app = await publicFile("app.js");

  const card = app.slice(
    app.indexOf("function billingCard()"),
    app.indexOf("async function billingAction("),
  );
  // Two different sentences, because they are two different situations: a
  // deployment that has switched payments off is not one somebody
  // misconfigured, and "not set up" reads as something to go and fix.
  assert.match(card, /billing\.payments !== true/u);
  assert.match(card, /Kumi is not charging right now/u);
  assert.match(card, /billing\.configured !== true/u);

  // And nothing warns about a trial or a failed payment that cannot exist.
  const banner = app.slice(
    app.indexOf("function billingBanner()"),
    app.indexOf("function banner()"),
  );
  assert.match(banner, /billing\.payments !== true/u);
});

test("an invitation opens whichever door this deployment has open", async () => {
  const app = await publicFile("app.js");

  // The mail cannot know how the deployment sells, and should not have to:
  // it sends one address and the app resolves it. That also means turning
  // payments on does not invalidate the invitations already sent.
  const resolve = app.slice(
    app.indexOf("function renderAuth()"),
    app.indexOf('if (mode === "forgot"'),
  );
  assert.notEqual(resolve, "", "renderAuth should still resolve the mode");
  assert.match(resolve, /authMode === "join"/u);
  assert.match(resolve, /paymentsOn\(\)\s*\n?\s*\?\s*"signup"/u);
  assert.match(resolve, /:\s*"register"/u);

  // And waits rather than guessing. Everywhere else an unanswered health
  // check reads as "payments off", because offering a queue to somebody who
  // could have paid is recoverable. Here both wrong guesses put a dead form
  // in front of somebody arriving on an invitation — a card form the
  // checkout answers 501 to, or a free form registration answers 410 to.
  assert.match(resolve, /state\.health === undefined/u);
  assert.match(app, /function renderInvitationLoading\(\)/u);

  // The approved address rides in the fragment, which the browser never
  // sends, so the form can be prefilled without the address reaching a
  // server or an access log.
  assert.match(app, /function invitedEmailFromHash\(\)/u);
  const reader = app.slice(
    app.indexOf("function invitedEmailFromHash()"),
    app.indexOf("/** The secret out of a `#reset/<token>` link"),
  );
  assert.match(reader, /decodeURIComponent/u);
  // A hand-edited or truncated link is an empty box, not a thrown render.
  assert.match(reader, /catch\s*\{[\s\S]{0,200}return "";/u);

  const signup = app.slice(
    app.indexOf("function renderSignup()"),
    app.indexOf("function renderWelcome()"),
  );
  assert.notEqual(signup, "", "the trial form should still exist");
  assert.match(signup, /const invited = invitedEmailFromHash\(\);/u);
  assert.match(signup, /value="\$\{esc\(invited\)\}"/u);
  // Somebody who signs up with a different address is refused by the server
  // with no way to see why, so the form says which address is the one.
  assert.match(signup, /let through/u);
  // And it still says what the card is for, invitation or not.
  assert.match(signup, /day\s*\n?\s*fifteen/u);

  // The sign-in card is chosen from the resolved mode, not the raw one.
  // Where payments are off an invitation resolves to `register`, and a card
  // picked off `authMode` would see "not bootstrap, not register" and show
  // somebody arriving on an invitation the sign-in form instead of the one
  // that makes their account. The two changes landed independently and this
  // is the line where they meet.
  const tail = app.slice(
    app.indexOf("const setupRequired = state.health?.setupRequired === true;"),
    app.indexOf("if (!bootstrap && !register)"),
  );
  assert.notEqual(tail, "", "the sign-in card should still be chosen here");
  assert.match(tail, /const bootstrap = mode === "bootstrap";/u);
  assert.match(tail, /const register = mode === "register";/u);
  assert.doesNotMatch(tail, /authMode/u);
});

test("the desktop app is offered on the way in, not only once inside", async () => {
  const app = await publicFile("app.js");

  // Agents run on the person's own machine against their own vendor
  // subscription, so an account with no worker on it never runs anything.
  // Settings has always carried the download; the two screens somebody
  // actually passes through on the way to their first task had not.
  for (const [name, from, to] of [
    ["the trial form", "function renderSignup()", "function renderWelcome()"],
    ["the last step", "function renderWelcome()", "function renderPasswordReset()"],
  ] as const) {
    const start = app.indexOf(from);
    const end = app.indexOf(to);
    assert.notEqual(start, -1, `${name}: ${from} should still exist`);
    assert.notEqual(end, -1, `${name}: ${to} should still exist`);
    assert.match(
      app.slice(start, end),
      /href="\/download"/u,
      `${name} should offer the desktop app`,
    );
  }
});

test("every auth form reports failure in the same red", async () => {
  const app = await publicFile("app.js");

  // `form-msg` is the styled one — red, centred, and holding its height so
  // the form does not jump when a message arrives. `auth-msg` is the id the
  // script writes into and has never had a rule, so the trial and welcome
  // screens were reporting errors as ordinary body text. The refusal most
  // people will now meet — an address that is not through the waitlist —
  // lands on the trial form, so it had better look like a refusal.
  assert.doesNotMatch(app, /class="auth-msg"/u);
  const shells = [...app.matchAll(/id="auth-msg"/gu)];
  assert.ok(shells.length >= 6, `expected every auth form, found ${shells.length}`);
  for (const match of shells) {
    assert.match(
      app.slice(Math.max(0, match.index - 60), match.index),
      /class="form-msg[^"]*"\s*$/u,
    );
  }
});
