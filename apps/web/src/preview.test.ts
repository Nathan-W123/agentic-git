import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { repoAdd } from "@coord/cli/commands";
import { CoordinatorProject } from "@coord/cli/project";
import { RepositoryService } from "@coord/repository-service";

import { isStaticSite, PreviewService, startStaticServer } from "./preview.js";

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

/**
 * A preview that never comes up must say so.
 *
 * Reported from a real attempt: pressing play on a monorepo produced a success
 * toast naming a URL, a control flipped to "stop", and a link that answered
 * nothing. Detection had fallen through `dev` to a `start` script reading
 * `node dist/index.js`, and `dist` is a build output — which a fresh checkout
 * of canonical does not contain, because that is what `.gitignore` is for. The
 * process died in milliseconds and the status had already been returned.
 */

/** A repository whose `start` script points at something that is not there. */
async function unbuiltRepository(): Promise<{
  root: string;
  sourcePath: string;
  project: CoordinatorProject;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-start-"));
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({
      name: "unbuilt",
      private: true,
      type: "module",
      // No `dev`, so detection falls through to `start` exactly as it did.
      scripts: { start: "node dist/index.js" },
    })}\n`,
    "utf8",
  );
  // Deliberately not committed, and named by .gitignore, so the worktree the
  // preview checks out has neither the build output nor a way to make one.
  await writeFile(path.join(sourcePath, ".gitignore"), "dist/\n", "utf8");
  await mkdir(path.join(sourcePath, "dist"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "dist", "index.js"),
    "console.log('should never run');\n",
    "utf8",
  );
  await repositories.commitAll(sourcePath, "seed unbuilt app");

  const projectRoot = path.join(root, "proj");
  await mkdir(projectRoot, { recursive: true });
  const project = await CoordinatorProject.init(projectRoot);
  return { root, sourcePath, project };
}

test("a preview whose command exits immediately is reported, not called running", async () => {
  const { root, sourcePath, project } = await unbuiltRepository();
  const store = project.openStore();
  try {
    const repository = await repoAdd(project, store, {
      sourcePath,
      id: "unbuilt",
    });
    const previews = new PreviewService(project, store);
    try {
      await assert.rejects(
        async () => await previews.start({ repositoryId: repository.id }),
        (error: Error) => {
          // The phrasing the dashboard keys off to offer "how is this app
          // started?", so a wording change that loses the recovery prompt
          // fails here rather than in front of somebody.
          assert.match(error.message, /could not be started/u);
          assert.match(error.message, /exited immediately/u);
          // The diagnosis travels with it. This is the only copy: the process
          // output is not rendered anywhere else in the page.
          assert.match(error.message, /Cannot find module|MODULE_NOT_FOUND/u);
          assert.match(error.message, /previewCommands/u);
          return true;
        },
      );
      // And nothing is left claiming to run, so the control does not offer a
      // stop button for a process that is gone.
      assert.equal(previews.status(repository.id), undefined);
    } finally {
      await previews.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
