import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isStaticSite, startStaticServer } from "./preview.js";

/**
 * The static preview exists so a page with nothing that builds it can be
 * looked at without configuring anything. It is also the one part of the
 * preview that reads files by request path, so the path check is the whole
 * of its security and is what most of this exercises.
 */

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-static-"));
  await writeFile(
    path.join(root, "index.html"),
    "<!doctype html><title>Space Explorer</title>",
    "utf8",
  );
  await mkdir(path.join(root, "js"), { recursive: true });
  await writeFile(path.join(root, "js", "script.js"), "export const a = 1;\n", "utf8");
  // Something worth stealing, one level above the served directory.
  await writeFile(path.join(root, "..", "outside.txt"), "secret\n", "utf8");
  return root;
}

async function get(port: number, target: string): Promise<{
  status: number;
  body: string;
  type: string | null;
}> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${target}`);
  return {
    status: response.status,
    body: await response.text(),
    type: response.headers.get("content-type"),
  };
}

test("a directory with an index page is servable without being configured", async () => {
  const root = await fixture();
  const server = startStaticServer(root, 0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  try {
    assert.equal(await isStaticSite(root), true);

    // The root serves the index rather than a listing, which is what somebody
    // opening the app expects to happen.
    const index = await get(port, "/");
    assert.equal(index.status, 200);
    assert.match(index.body, /Space Explorer/u);
    assert.match(index.type ?? "", /text\/html/u);

    // Types come from the extension, because a browser will not run a module
    // it has been told is plain text.
    const script = await get(port, "/js/script.js");
    assert.equal(script.status, 200);
    assert.match(script.type ?? "", /javascript/u);

    const missing = await get(port, "/nope.html");
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
    await rm(path.join(root, "..", "outside.txt"), { force: true });
  }
});

test("a request cannot climb out of the directory being served", async () => {
  // The one thing a static server must not do. Every one of these resolves
  // outside the root, and each is a shape that has worked against somebody
  // else's: plain traversal, an encoded separator, and an absolute path.
  const root = await fixture();
  const server = startStaticServer(root, 0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  try {
    for (const target of [
      "/../outside.txt",
      "/js/../../outside.txt",
      "/%2e%2e/outside.txt",
      "/....//outside.txt",
    ]) {
      const answer = await get(port, target);
      assert.notEqual(answer.status, 200, target);
      assert.doesNotMatch(answer.body, /secret/u, target);
    }
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
    await rm(path.join(root, "..", "outside.txt"), { force: true });
  }
});

test("a directory with no index page is not a static site", async () => {
  // Detection has to be narrow, or every repository would look like a page and
  // the button would serve a folder of source files to somebody expecting an
  // app.
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-empty-"));
  try {
    await writeFile(path.join(root, "main.py"), "print('hi')\n", "utf8");
    assert.equal(await isStaticSite(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
