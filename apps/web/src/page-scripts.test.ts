import assert from "node:assert/strict";
import test from "node:test";

import { loadStaticAssets } from "./assets.js";

/**
 * Every served page has to be able to run its own code.
 *
 * The control plane sends `script-src 'self'` with no `'unsafe-inline'`. A
 * document with an inline <script> is therefore served, rendered, and inert:
 * the browser declines to execute it, nothing in the page is wired up, and
 * what a person sees is the static markup with dead buttons. Nothing fails.
 * Nothing is logged server-side. It looks like a working page.
 *
 * That is precisely what happened to the approve page — it shipped, and the
 * Approve button did nothing for everyone who reached it, because the check
 * that it was *served* passed and there was no check that it *ran*.
 */

/** Inline means a <script> with a body, as opposed to one with a src. */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>\s*\S/iu;

test("no served page carries a script the browser will refuse to run", async () => {
  const assets = await loadStaticAssets();
  const offenders: string[] = [];
  for (const [path, asset] of assets) {
    if (!asset.contentType.startsWith("text/html")) {
      continue;
    }
    if (INLINE_SCRIPT.test(asset.body.toString("utf8"))) {
      offenders.push(path);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these pages have inline scripts, which \`script-src 'self'\` blocks: ${offenders.join(", ")}`,
  );
});

test("the pages that need behaviour actually reference a script", async () => {
  // The other half of the same mistake: moving a script out and forgetting to
  // point at it leaves a page just as dead, and the check above would pass.
  const assets = await loadStaticAssets();
  for (const [page, script] of [
    ["/authorize", "/authorize.js"],
    ["/download", "/download.js"],
  ]) {
    const html = assets.get(page as string)?.body.toString("utf8");
    assert.ok(html !== undefined, `${page} is not served`);
    assert.match(
      html,
      new RegExp(`<script[^>]*\\bsrc="${script}"`, "u"),
      `${page} does not load ${script}`,
    );
    assert.ok(
      assets.get(script as string) !== undefined,
      `${script} is not served, so ${page} would 404 on it`,
    );
  }
});
