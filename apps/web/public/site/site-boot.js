/**
 * The first script the marketing pages run — classic, synchronous, and tiny,
 * because both of its jobs must happen before the page paints.
 *
 * It cannot be inline: the gateway's Content-Security-Policy is
 * `script-src 'self'` with no inline allowance, so an inline redirect would
 * be the one script on the site guaranteed never to run. Same-origin and
 * parser-blocking in <head> is the closest the CSP permits to inline.
 *
 * Job one: legacy deep links. The dashboard used to live at "/", and every
 * mailed link pointed there — claim links (`/#welcome/<token>`), password
 * resets (`/#reset/<token>`), the trial-warning mail's `/#settings`. Those
 * mails are in inboxes and cannot be re-sent, so "/" must keep honouring
 * them forever: any hash naming a dashboard screen is forwarded to /app with
 * the fragment intact. The list is an allowlist, not "any hash" — the
 * marketing page's own anchors (#how, #features) must keep scrolling, not
 * bounce visitors into the sign-in screen. It mirrors AUTH_HASHES in app.js
 * plus the billing/settings returns the server mails and hands to Stripe.
 *
 * Job two: installed desktop shells. main.mjs ships inside installers and
 * old installs load the bare origin — which is now this page. The preload
 * exposes KUMI_SERVER on every desktop window, so its presence is the tell:
 * a desktop shell showing the marketing page is always wrong, hash or no
 * hash, and gets sent to the dashboard.
 *
 * Job three: the motion gate's CSS half. Scroll reveals hide content until
 * JavaScript shows it, so the hidden initial state must never apply when the
 * JavaScript will not run — with scripts disabled this file never executes
 * and nothing is ever hidden, and with reduced motion requested the class is
 * withheld. Only when this line actually runs, for a visitor who accepts
 * motion, does `html.anim` arm the reveal styles that site.js then plays.
 */
(function () {
  "use strict";
  var hash = window.location.hash;
  if (window.KUMI_SERVER) {
    window.location.replace("/app" + hash);
    return;
  }
  // The other kind of installed shell. A PWA pinned before the dashboard
  // moved keeps its cached manifest, whose start_url is "/", and launches
  // with no hash and no preload global — so neither tell above fires and the
  // person's installed app opens on its own advertisement. Standalone
  // display mode is the one thing such a launch cannot hide.
  if (window.matchMedia("(display-mode: standalone)").matches) {
    window.location.replace("/app" + hash);
    return;
  }
  if (hash.length > 1) {
    var screen = hash.slice(1).split(/[/?]/)[0];
    var legacy = [
      "signin",
      "register",
      "signup",
      "welcome",
      "setup",
      "forgot",
      "reset",
      "billing",
      "billing-done",
      "billing-cancelled",
      "settings",
    ];
    if (legacy.indexOf(screen) !== -1) {
      window.location.replace("/app" + hash);
      return;
    }
  }
  if (window.matchMedia("(prefers-reduced-motion: no-preference)").matches) {
    document.documentElement.className += " anim";
  }
})();
