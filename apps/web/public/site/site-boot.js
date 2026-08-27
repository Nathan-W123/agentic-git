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
 * There is no job three any more, and that is deliberate. This file used to
 * arm the `anim` class that hides the hero and every reveal, trusting
 * site.js to play them in — a trust a 404 anywhere in site.js's module
 * graph silently broke, twice, leaving the page blank. The class is now
 * added by site.js itself, first thing: the file that hides content is the
 * file that animates it, so no version mix between the two can ever hide
 * something nothing will show.
 */
(function () {
  "use strict";
  var hash = window.location.hash;

  /**
   * Whether this page is the origin's front door.
   *
   * Every forward below rescues somebody who asked for "/" and got an
   * advertisement: a mailed dashboard link, a desktop shell built before the
   * move, a pinned PWA whose cached start_url still says "/". None of them
   * can land anywhere else, so none of them are a reason to forward a page
   * served from anywhere else.
   *
   * The guard is not pedantry — it is a bug that shipped. This same page is
   * also served through the control plane's own preview proxy, at a deep
   * path under `/api/v1/.../preview/app/`, so that somebody can look at the
   * site an agent just changed. There the standalone tell fires for any
   * reader who has Kumi installed, and previewing the marketing site threw
   * them straight out of the preview and into the real dashboard: the play
   * button appeared to start the product rather than the page. A document
   * that is not at "/" is not the document these rules are about.
   */
  var atFrontDoor = window.location.pathname === "/";

  if (atFrontDoor) {
    if (window.KUMI_SERVER) {
      window.location.replace("/app" + hash);
      return;
    }
    // The other kind of installed shell. A PWA pinned before the dashboard
    // moved keeps its cached manifest, whose start_url is "/", and launches
    // with no hash and no preload global — so neither tell above fires and
    // the person's installed app opens on its own advertisement. Standalone
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
  }

})();
