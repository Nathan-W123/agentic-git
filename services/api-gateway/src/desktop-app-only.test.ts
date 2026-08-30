import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_APP_MARKER,
  classifyClient,
  shouldRedirectToDownload,
} from "./desktop-app-only.js";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const KUMI_APP = `${CHROME_MAC} Electron/38.0.0 ${DESKTOP_APP_MARKER}0.2.0`;

function withFlag<T>(value: string | undefined, run: () => T): T {
  const previous = process.env["COORD_DESKTOP_APP_ONLY"];
  if (value === undefined) {
    delete process.env["COORD_DESKTOP_APP_ONLY"];
  } else {
    process.env["COORD_DESKTOP_APP_ONLY"] = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_DESKTOP_APP_ONLY"];
    } else {
      process.env["COORD_DESKTOP_APP_ONLY"] = previous;
    }
  }
}

test("the app is recognised before anything else looks at the string", () => {
  // It is Chromium, so it carries a desktop User-Agent underneath its marker.
  // Checking the marker last would classify the app as the thing it is meant
  // to be let through instead of.
  assert.equal(classifyClient(KUMI_APP), "app");
});

test("phones and tablets are mobile", () => {
  for (const agent of [IPHONE, IPAD, ANDROID]) {
    assert.equal(classifyClient(agent), "mobile", agent.slice(0, 40));
  }
});

test("an ordinary desktop browser is a desktop browser", () => {
  assert.equal(classifyClient(CHROME_MAC), "desktop-browser");
});

test("a client that sends no User-Agent is treated as a desktop browser", () => {
  // The conservative reading. Sending nothing is not evidence of a phone, and
  // the consequence of being wrong is a redirect to a download page rather
  // than anything lost.
  assert.equal(classifyClient(undefined), "desktop-browser");
  assert.equal(classifyClient(""), "desktop-browser");
});

test("off by default, nobody is redirected anywhere", () => {
  withFlag(undefined, () => {
    for (const agent of [CHROME_MAC, IPHONE, KUMI_APP, undefined]) {
      assert.equal(shouldRedirectToDownload(agent), false);
    }
  });
});

test("on, only desktop browsers are sent to the installer", () => {
  withFlag("1", () => {
    assert.equal(shouldRedirectToDownload(CHROME_MAC), true);
    assert.equal(shouldRedirectToDownload(undefined), true);
    // The two that must never be redirected: the app would be sent away from
    // the dashboard it exists to show, and a phone has no build to be sent to.
    assert.equal(shouldRedirectToDownload(KUMI_APP), false);
    assert.equal(shouldRedirectToDownload(IPHONE), false);
    assert.equal(shouldRedirectToDownload(ANDROID), false);
  });
});

test("anything but the exact 1 leaves it off", () => {
  for (const value of ["0", "", "true", "yes"]) {
    withFlag(value, () => {
      assert.equal(
        shouldRedirectToDownload(CHROME_MAC),
        false,
        `${value} must not arm the redirect`,
      );
    });
  }
});
