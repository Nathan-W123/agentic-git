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
  var BOOT_REV = "w9";
  var hash = window.location.hash;

  // Every resource that fails to arrive is recorded, so the ?why overlay
  // below can name the missing file instead of anyone diagnosing a phone
  // from a screenshot. Capture phase, because resource error events do not
  // bubble; registered here because this file is the first script and the
  // one most likely to survive whatever broke.
  window.__kumiLoadErrors = [];
  // Uncaught runtime errors land here too — including the abort of a module
  // whose evaluation dies between two statements, which no try/catch inside
  // the module can see. The browser's own error event is the one net under
  // everything, and it carries the message, file, and line.
  window.__kumiJsErrors = [];
  window.addEventListener(
    "error",
    function (event) {
      var el = event.target;
      if (
        el &&
        el !== window &&
        (el.tagName === "SCRIPT" || el.tagName === "LINK")
      ) {
        window.__kumiLoadErrors.push(el.src || el.href || "unknown");
        return;
      }
      if (event && event.message) {
        window.__kumiJsErrors.push(
          event.message +
            " @ " +
            (event.filename || "?") +
            ":" +
            (event.lineno || 0) +
            ":" +
            (event.colno || 0)
        );
      }
    },
    true
  );
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    window.__kumiJsErrors.push(
      "promise: " + (reason && reason.message ? reason.message : String(reason))
    );
  });

  // The page's own account of itself, for the day it misbehaves on a device
  // nobody can attach a debugger to. Add ?why to the address and it says
  // which rev of each file ran, what loaded, and why the water is or is not
  // drawing. Costs nothing when the flag is absent.
  if (/[?#&]why\b/.test(window.location.search + window.location.hash)) {
    window.addEventListener("load", function () {
      setTimeout(function () {
        var probe = null;
        try {
          probe = document.createElement("canvas").getContext("webgl2");
        } catch (error) {
          probe = null;
        }
        // The panel reports on broken environments, so it must not trust
        // the APIs it is reporting on.
        function reducedMotionState() {
          try {
            return window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? "on"
              : "off";
          } catch (error) {
            return "unknown (matchMedia threw)";
          }
        }
        var panel = document.createElement("pre");
        panel.textContent = [
          "kumi site diagnostics",
          "boot: " + BOOT_REV,
          "site.js: " + (window.__kumiSiteRev || "DID NOT RUN"),
          "classes: " + (document.documentElement.className.trim() || "(none)"),
          "Motion: " + typeof window.Motion,
          "webgl2: " + (probe ? "available" : "unavailable"),
          "water: " + (window.__kumiFieldState || "not started"),
          "reduced motion: " + reducedMotionState(),
          "failed loads: " +
            (window.__kumiLoadErrors.length
              ? window.__kumiLoadErrors.join(", ")
              : "none"),
          "errors: " +
            (window.__kumiErrors && window.__kumiErrors.length
              ? window.__kumiErrors.join(" | ")
              : "none"),
          "trace: " +
            (window.__kumiTrace && window.__kumiTrace.length
              ? window.__kumiTrace.join(" > ")
              : "(none)"),
          "js errors: " +
            (window.__kumiJsErrors && window.__kumiJsErrors.length
              ? window.__kumiJsErrors.join(" | ")
              : "none"),
        ].join("\n");
        panel.style.cssText =
          "position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;" +
          "padding:14px 16px;background:rgba(12,11,10,.95);" +
          "border:1px solid #453f3b;border-radius:10px;color:#f3efe8;" +
          "font:12px/1.6 ui-monospace,Menlo,monospace;" +
          "white-space:pre-wrap;word-break:break-all";
        document.body.appendChild(panel);
      }, 1200);
    });
  }

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
    var standalone = false;
    try {
      standalone = window.matchMedia("(display-mode: standalone)").matches;
    } catch (error) {
      standalone = false;
    }
    if (standalone) {
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
