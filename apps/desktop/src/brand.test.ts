import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The mark has to be drawn into this window rather than fetched into it: the
 * setup window opens before any server address is known, so there is nowhere
 * to fetch it from. That makes this a second copy of path data whose first
 * copy lives in the dashboard, and a second copy is only safe if something
 * fails when the two drift.
 *
 * The paths are asserted literally rather than by shape. A test that only
 * counted `<path>` elements would pass a window drawing the wrong cube.
 */
const MARK_PATHS = [
  "M29.92 9.08A4.16 4.16 0 0 1 34.08 9.08L50.92 18.8A4.16 4.16 0 0 1 53 22.4L53 41.6A4.16 4.16 0 0 1 50.92 45.2L34.08 54.92A4.16 4.16 0 0 1 29.92 54.92L13.08 45.2A4.16 4.16 0 0 1 11 41.6L11 22.4A4.16 4.16 0 0 1 13.08 18.8Z",
  "M12.25 20.72L32 32.12L51.75 20.72",
  "M32 32.12L32 54.68",
  "M24.16 19.07L30.39 15.47",
  "M17.3 28.6L17.3 35.8",
  "M39.38 45.13L45.62 41.53",
];

async function setupWindow(): Promise<string> {
  return readFile(
    fileURLToPath(new URL("../electron/setup.html", import.meta.url)),
    "utf8",
  );
}

test("the first-run window draws the Kumi mark itself", async () => {
  const html = await setupWindow();

  assert.match(html, /viewBox="0 0 64 64"/u, "the mark's box is missing");
  assert.match(html, /stroke-width="3\.52"/u, "the mark's weight is missing");
  for (const path of MARK_PATHS) {
    assert.ok(
      html.includes(`d="${path}"`),
      `the mark is missing or has drifted from the dashboard's: ${path.slice(0, 24)}…`,
    );
  }
  // Nothing here may load a file or a host: this window is what somebody sees
  // *before* they have told the app where their deployment is, so a fetched
  // logo would be a broken box. Only what the window is asked to *load*
  // counts — the address field's placeholder is example text, not a request.
  assert.doesNotMatch(html, /<img\b/u, "the window should draw, not fetch");
  assert.doesNotMatch(html, /url\(/u, "no stylesheet may pull in an asset");
  assert.doesNotMatch(
    html,
    /(?:src|href)="(?!#)/u,
    "the window should reference nothing outside itself",
  );
});

test("the first-run window is painted in the product's own colours", async () => {
  const html = await setupWindow();

  // The window shipped in someone else's palette — navy and a blue button —
  // while every other surface is warm dark and salmon.
  for (const stale of ["#0b0d12", "#12151d", "#3f6ef0", "#4c7dfd", "#e6e8ee"]) {
    assert.doesNotMatch(
      html,
      new RegExp(stale, "iu"),
      `${stale} is not one of Kumi's colours`,
    );
  }
  assert.match(html, /background: #121110;/u, "the page ground is not Kumi's");
  assert.match(html, /#D88973/u, "the accent is not Kumi's");
});
