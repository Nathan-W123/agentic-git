import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { repoAdd } from "@coord/cli/commands";
import { CoordinatorProject } from "@coord/cli/project";
import { RepositoryService } from "@coord/repository-service";

import {
  describeUndetectable,
  detectPreviewCommand,
  detectPreviewCommands,
  isStaticSite,
  PreviewService,
  probePort,
  probePreviewResponse,
  startStaticServer,
} from "./preview.js";

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
    // Renamed, because an id is taken by the first repository to want it and
    // the second is stored under a suffixed one — so the name on the channel
    // and the name in the failure were routinely different things. The dialog
    // asked how KUMI starts and the sentence inside it was about LATTICE.
    await store.renameRepository(repository.id, "KUMI");
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
          // Called what the reader calls it, and pointing at the id only
          // where the id is what has to be typed: the config is keyed by it.
          assert.match(error.message, /"KUMI" could not be started/u);
          assert.match(error.message, /for "unbuilt"/u);
          // The diagnosis travels with it. This is the only copy: the process
          // output is not rendered anywhere else in the page.
          assert.match(error.message, /Cannot find module|MODULE_NOT_FOUND/u);
          assert.match(error.message, /previewCommands/u);
          return true;
        },
      );
      // And nothing is left claiming to run, so the control does not offer a
      // stop button for a process that is gone.
      assert.equal(await previews.status(repository.id), undefined);
    } finally {
      await previews.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A repository whose "app" only reports the environment it was started in.
 *
 * The point under test is not that a server binds a port — it is *which*
 * project a previewed app is pointed at. A control plane previewing itself
 * inherits `COORD_PROJECT_ROOT` unless something stops it, and then either
 * refuses to start (the running control plane holds the lock) or becomes a
 * second writer on one SQLite file. Neither is a preview.
 */
async function environmentReportingRepository(scripts: {
  dev: string;
}): Promise<{ root: string; sourcePath: string; project: CoordinatorProject }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-env-"));
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({
      name: "reporter",
      private: true,
      type: "module",
      scripts,
    })}\n`,
    "utf8",
  );
  // Prints what it was handed, then serves, so the test can read the
  // environment out of the preview's own captured output.
  await writeFile(
    path.join(sourcePath, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      'const say = (name) => console.log(name + "=" + (process.env[name] ?? ""));',
      'say("COORD_PROJECT_ROOT");',
      'say("COORD_HOST");',
      'say("SECRET_FROM_CONFIG");',
      'say("COORD_BOOTSTRAP_TOKEN");',
      // How the container was deployed, which must not reach a preview: with
      // it set, the preview's own `npm ci` omits devDependencies.
      'say("NODE_ENV");',
      'createServer((_, response) => response.end("ok")).listen(',
      '  Number(process.env["PORT"]), "127.0.0.1");',
      "",
    ].join("\n"),
    "utf8",
  );
  await repositories.commitAll(sourcePath, "seed reporter");

  const projectRoot = path.join(root, "proj");
  await mkdir(projectRoot, { recursive: true });
  const project = await CoordinatorProject.init(projectRoot);
  return { root, sourcePath, project };
}

/** Waits for a line matching `name=value` in a preview's captured output. */
async function reported(
  previews: PreviewService,
  repositoryId: string,
  name: string,
): Promise<string | undefined> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const line = ((await previews.status(repositoryId))?.recentOutput ?? []).find(
      (entry) => entry.startsWith(`${name}=`),
    );
    if (line !== undefined) {
      return line.slice(name.length + 1);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

test("a previewed app is given its own project, not the control plane's", async () => {
  const { root, sourcePath, project } = await environmentReportingRepository({
    dev: "node server.mjs",
  });
  const store = project.openStore();
  // What the control plane itself was started with. Inheriting this is the bug.
  const inherited = path.join(root, "live-project");
  process.env["COORD_PROJECT_ROOT"] = inherited;
  process.env["COORD_BOOTSTRAP_TOKEN"] = "not-for-the-child";
  // How the *container* was deployed. The image sets this, and it is the one
  // that broke previewing a repository whose dev server has to be built.
  const previousNodeEnv = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
  try {
    const repository = await repoAdd(project, store, {
      sourcePath,
      id: "reporter",
    });
    const previews = new PreviewService(project, store);
    try {
      const status = await previews.start({ repositoryId: repository.id });
      assert.equal(status.ready, true);

      const projectRoot = await reported(
        previews,
        repository.id,
        "COORD_PROJECT_ROOT",
      );
      assert.notEqual(projectRoot, inherited);
      assert.ok(
        projectRoot !== undefined && projectRoot.length > 0,
        "the child was given no project at all, so it has nothing to open",
      );
      // And it is a real project: the app can open it rather than being told
      // to run `coord init` in a directory that is about to be deleted.
      await CoordinatorProject.open(projectRoot!);

      // The control plane's own secrets do not travel either.
      assert.equal(
        await reported(previews, repository.id, "COORD_BOOTSTRAP_TOKEN"),
        "",
      );
      // Loopback is the promise this class makes, and a set PORT is what makes
      // apps/web bind every interface unless COORD_HOST says otherwise.
      assert.equal(
        await reported(previews, repository.id, "COORD_HOST"),
        "127.0.0.1",
      );
      // And the deployment's own NODE_ENV does not travel. With it set, the
      // preview's `npm ci` omits devDependencies, so a repository whose dev
      // server is built by anything installs cleanly and then dies with
      // "turbo: not found" — which reads as the start command being wrong, so
      // the obvious fix is to type a different start command, and that cannot
      // work either. The command was never the problem.
      assert.equal(await reported(previews, repository.id, "NODE_ENV"), "");

      const response = await fetch(status.url);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ok");
    } finally {
      await previews.close();
      if (previousNodeEnv === undefined) {
        delete process.env["NODE_ENV"];
      } else {
        process.env["NODE_ENV"] = previousNodeEnv;
      }
    }
  } finally {
    delete process.env["COORD_PROJECT_ROOT"];
    delete process.env["COORD_BOOTSTRAP_TOKEN"];
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository can supply its own configuration, and it wins", async () => {
  const { root, sourcePath, project } = await environmentReportingRepository({
    dev: "node server.mjs",
  });
  const store = project.openStore();
  try {
    const repository = await repoAdd(project, store, {
      sourcePath,
      id: "reporter",
    });
    // The gap that made the button useless for an app needing configuration:
    // detection can find the command, and nothing could supply the value that
    // is deliberately not in the repository.
    project.config.previewCommands = {
      [repository.id]: {
        executable: process.execPath,
        args: ["server.mjs"],
        label: "reporter",
        env: { SECRET_FROM_CONFIG: "from-config", COORD_HOST: "127.0.0.1" },
      },
    };
    await project.save();

    const previews = new PreviewService(project, store);
    try {
      const status = await previews.start({ repositoryId: repository.id });
      assert.equal(status.label, "reporter");
      assert.equal(
        await reported(previews, repository.id, "SECRET_FROM_CONFIG"),
        "from-config",
      );
    } finally {
      await previews.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The play button has to start whatever somebody committed, not only the one
 * ecosystem it was written for. Every rung wants a named file saying what the
 * project is, so these fixtures are exactly that file and nothing else.
 */
async function detectIn(
  files: Record<string, string>,
): Promise<{ label?: string; executable?: string; args?: string[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpreview-detect-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, "utf8");
    }
    const found = await detectPreviewCommand(root);
    return {
      ...(found?.label === undefined ? {} : { label: found.label }),
      ...(found?.executable === undefined ? {} : { executable: found.executable }),
      ...(found?.args === undefined ? {} : { args: [...found.args] }),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a start command is found from whatever the project actually is", async () => {
  // Node, and the package manager the repository pinned — running npm in a
  // pnpm workspace fails on the lockfile, so the lockfile decides.
  assert.match(
    (await detectIn({ "package.json": '{"scripts":{"dev":"vite"}}' })).label ?? "",
    /npm(\.cmd)? run dev/u,
  );
  assert.equal(
    (
      await detectIn({
        "package.json": '{"scripts":{"dev":"vite"}}',
        "pnpm-lock.yaml": "lockfileVersion: 9",
      })
    ).label,
    "pnpm run dev",
  );
  // `dev` over `start` where both exist: that is the one meant to be watched.
  assert.match(
    (
      await detectIn({
        "package.json": '{"scripts":{"start":"node .","dev":"vite"}}',
      })
    ).label ?? "",
    /run dev$/u,
  );

  // Python, where the framework names itself.
  assert.match(
    (await detectIn({ "manage.py": "# django" })).label ?? "",
    /manage\.py runserver/u,
  );
  assert.equal(
    (
      await detectIn({
        "requirements.txt": "fastapi\nuvicorn\n",
        "main.py": "app = FastAPI()",
      })
    ).label,
    "uvicorn main:app",
  );
  assert.match(
    (
      await detectIn({ "requirements.txt": "flask\n", "app.py": "app = Flask(__name__)" })
    ).label ?? "",
    /flask run/u,
  );

  // Compiled languages, where the toolchain fetches its own dependencies.
  assert.equal((await detectIn({ "go.mod": "module x" })).label, "go run .");
  assert.equal((await detectIn({ "Cargo.toml": "[package]" })).label, "cargo run");

  // Ruby: the Rails binstub before config.ru, because a Rails app has both.
  assert.equal(
    (await detectIn({ "bin/rails": "#!/usr/bin/env ruby", "config.ru": "run App" }))
      .label,
    "bin/rails server",
  );
  assert.equal((await detectIn({ "config.ru": "run App" })).label, "rackup");

  // PHP's own server, with the docroot it should actually serve.
  assert.equal(
    (await detectIn({ "public/index.php": "<?php" })).label,
    "php -S -t public",
  );

  // Nothing that names a way to start.
  assert.deepEqual(await detectIn({ "README.md": "# a library" }), {});
});

test("a Procfile wins, because it is the project saying so outright", async () => {
  // Inferred answers are guesses about a manifest; a web: line is the command.
  const found = await detectIn({
    Procfile: "web: gunicorn app:server --bind 0.0.0.0:$PORT\nworker: rq worker\n",
    "package.json": '{"scripts":{"dev":"vite"}}',
    "requirements.txt": "flask\n",
  });
  assert.equal(found.executable, "sh");
  // Through a shell, unsplit: the line can carry quotes, `&&` or a $PORT of
  // its own, and splitting on spaces would mangle all three.
  assert.deepEqual(found.args, [
    "-c",
    "gunicorn app:server --bind 0.0.0.0:$PORT",
  ]);
  // `worker:` is not a web process and must not be picked up.
  assert.doesNotMatch(found.label ?? "", /rq worker/u);
});

test("the port is written into arguments that spell it out", async () => {
  // PORT is in the child's environment and most servers read it, but Django,
  // php -S and rails take the address as an argument — and spawn performs no
  // shell expansion, so a literal ${PORT} would reach the process unexpanded.
  for (const files of [
    { "manage.py": "# django" },
    { "public/index.php": "<?php" },
    { "bin/rails": "#!/usr/bin/env ruby" },
  ]) {
    const found = await detectIn(files);
    assert.ok(
      (found.args ?? []).some((arg) => arg.includes("${PORT}")),
      `${found.label ?? "?"} carries a port placeholder`,
    );
  }
});

test("a repository that cannot be started says what was looked for", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpreview-why-"));
  try {
    // "Nothing here looks like an app" is true and useless.
    const bare = await describeUndetectable(root);
    assert.match(bare, /Procfile/u);
    assert.match(bare, /go\.mod/u);
    assert.match(bare, /index\.html/u);

    await writeFile(
      path.join(root, "package.json"),
      '{"scripts":{"build":"tsc","test":"node --test"}}',
      "utf8",
    );
    const scripted = await describeUndetectable(root);
    assert.match(scripted, /no dev\/start\/serve\/preview script/u);
    assert.match(scripted, /build, test/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The two shapes detection used to answer "nothing here looks like an app"
 * for, and both of them are ordinary.
 *
 * A workspace root starts nothing anybody wants to look at — its `build`
 * builds every package and there is no root `dev` — while the app that serves
 * a page sits one directory down with a perfectly good `dev` script of its
 * own. And a repository with several start scripts had exactly one of them
 * tried: the best guess, which for a fresh checkout of canonical is often the
 * one pointing at a build output that is not there.
 */
test("a monorepo's own apps are candidates, ranked ahead of its libraries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpreview-mono-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        private: true,
        workspaces: ["apps/*", "packages/*"],
        scripts: { build: "turbo run build" },
      }),
      "utf8",
    );
    for (const [where, scripts] of [
      ["apps/web", { dev: "vite" }],
      ["packages/shared", { dev: "tsc --watch" }],
    ] as const) {
      await mkdir(path.join(root, where), { recursive: true });
      await writeFile(
        path.join(root, where, "package.json"),
        JSON.stringify({ scripts }),
        "utf8",
      );
    }

    const candidates = await detectPreviewCommands(root);
    assert.equal(candidates.length, 2);
    // The app first: a library's `dev` script watches and builds and serves
    // nothing, so it is a candidate and it is not the first one.
    assert.match(candidates[0]?.label ?? "", /run dev in apps\/web/u);
    assert.equal(candidates[0]?.cwd, "apps/web");
    assert.match(candidates[1]?.label ?? "", /run dev in packages\/shared/u);

    // And a root that declares workspaces says so when none of them starts
    // either, rather than reporting only on its own scripts.
    await rm(path.join(root, "apps"), { recursive: true, force: true });
    await rm(path.join(root, "packages"), { recursive: true, force: true });
    assert.match(await describeUndetectable(root), /No workspace it declares/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every start script is a candidate, and a page is the last resort", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpreview-order-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      '{"scripts":{"start":"node dist/index.js","dev":"vite"}}',
      "utf8",
    );
    await writeFile(path.join(root, "index.html"), "<!doctype html>", "utf8");

    // `dev` is still the best guess; `start` is no longer discarded for
    // losing to it, which is the difference between "the first guess was
    // wrong" and "this app cannot be started".
    assert.deepEqual(
      (await detectPreviewCommands(root)).map((candidate) => candidate.args),
      [
        ["run", "dev"],
        ["run", "start"],
      ],
    );
    // A page *and* an app is an app: serving the folder would hand somebody
    // the source of their site instead of their site, so the static server is
    // reached only once every command has been tried and has died.
    assert.equal(await isStaticSite(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A repository whose best candidate dies and whose second one serves. */
async function fallthroughRepository(): Promise<{
  root: string;
  sourcePath: string;
  project: CoordinatorProject;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-fallthrough-"));
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({
      name: "fallthrough",
      private: true,
      type: "module",
      // `dev` is preferred and cannot work here: it runs a build output, and
      // a fresh checkout of canonical does not contain one.
      scripts: { dev: "node dist/index.js", start: "node server.mjs" },
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(sourcePath, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      'createServer((_, response) => response.end("ok")).listen(',
      '  Number(process.env["PORT"]), "127.0.0.1");',
      "",
    ].join("\n"),
    "utf8",
  );
  await repositories.commitAll(sourcePath, "seed fallthrough app");

  const projectRoot = path.join(root, "proj");
  await mkdir(projectRoot, { recursive: true });
  const project = await CoordinatorProject.init(projectRoot);
  return { root, sourcePath, project };
}

test("a candidate that dies is ruled out rather than reported", async () => {
  const { root, sourcePath, project } = await fallthroughRepository();
  const store = project.openStore();
  try {
    const repository = await repoAdd(project, store, {
      sourcePath,
      id: "fallthrough",
    });
    const previews = new PreviewService(project, store);
    try {
      const status = await previews.start({ repositoryId: repository.id });
      // The second candidate, reached without anybody being asked anything.
      assert.match(status.label, /run start$/u);
      // And what was ruled out on the way, which is the only record of it:
      // the failed attempt leaves nothing else behind.
      assert.equal((status.tried ?? []).length, 1);
      assert.match(status.tried?.[0] ?? "", /run dev/u);
      assert.match(status.tried?.[0] ?? "", /exited immediately/u);

      const response = await fetch(status.url);
      assert.equal(await response.text(), "ok");
    } finally {
      await previews.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a second press joins the start in flight instead of killing it", async () => {
  const { root, sourcePath, project } = await environmentReportingRepository({
    dev: "node server.mjs",
  });
  const store = project.openStore();
  try {
    const repository = await repoAdd(project, store, {
      sourcePath,
      id: "reporter",
    });
    const previews = new PreviewService(project, store);
    try {
      // Both presses land while the first is still installing and building —
      // which is a minute of a button that looks like it did nothing, so
      // pressing it again is the obvious move. Replacing the attempt in
      // flight killed that build and reported its death as the repository
      // exiting immediately.
      const [first, second] = await Promise.all([
        previews.start({ repositoryId: repository.id }),
        previews.start({ repositoryId: repository.id }),
      ]);
      assert.equal(first.port, second.port);
      assert.equal(first.exited, undefined);

      const running = await previews.status(repository.id);
      assert.equal(running?.exited, undefined);
      assert.equal((await fetch(first.url)).status, 200);
    } finally {
      await previews.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A repository that ships a container, which is the shape the play button
 * could do nothing at all with.
 *
 * Its Dockerfile is the whole of what it says about how it runs — the start
 * command lives in the image's CMD, which no manifest mentions — so detection
 * found nothing, and somebody was asked to type a command they had already
 * written down.
 */
test("a repository with a Dockerfile is started by building its image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpreview-docker-"));
  try {
    await writeFile(
      path.join(root, "Dockerfile"),
      ["FROM node:24-alpine", "COPY . .", "EXPOSE 8080", 'CMD ["node", "server.js"]', ""].join(
        "\n",
      ),
      "utf8",
    );

    const candidates = await detectPreviewCommands(root);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.executable, "sh");
    const line = candidates[0]?.args[1] ?? "";
    // Built *and* run, in one line: an image with nothing running it serves
    // no page, so half of this would not be a preview.
    assert.match(line, /docker build -t coord-preview-/u);
    assert.match(line, /docker run --rm/u);
    // The port the Dockerfile says the app listens on, published to loopback
    // on the port the preview allocated. Spelled out rather than left to the
    // environment, because spawn performs no expansion and a container reads
    // its own env, not this one's.
    assert.match(line, /-p 127\.0\.0\.1:\$\{PORT\}:8080/u);
    // A container left behind by the last press must not be what fails the
    // next one: the name is reused deliberately, so it is removed first.
    assert.match(line, /docker rm -f coord-preview-/u);

    // And it ranks last, not first. A repository with a dev server and a
    // Dockerfile wants the dev server — seconds rather than minutes, and it
    // reloads — so the image is what is reached when nothing else is there.
    await writeFile(
      path.join(root, "package.json"),
      '{"scripts":{"dev":"vite"}}',
      "utf8",
    );
    const both = await detectPreviewCommands(root);
    assert.match(both[0]?.label ?? "", /run dev/u);
    assert.match(both.at(-1)?.label ?? "", /docker build/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository with a compose file is started by building and running it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpreview-compose-"));
  try {
    await writeFile(
      path.join(root, "compose.yaml"),
      [
        "services:",
        "  web:",
        "    build: .",
        "    ports:",
        '      - "${PORT:-3000}:3000"',
        "",
      ].join("\n"),
      "utf8",
    );

    const candidates = await detectPreviewCommands(root);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.executable, "docker");
    // `--build`, because a compose stack started from a stale image is a
    // preview of the last time somebody built it.
    assert.deepEqual(candidates[0]?.args, [
      "compose",
      "-f",
      "compose.yaml",
      "up",
      "--build",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository that cannot be started says a Dockerfile was looked for", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpreview-docker-why-"));
  try {
    // The list is what the reader acts on: it says which of these to add, and
    // a container is now one of the answers.
    const bare = await describeUndetectable(root);
    assert.match(bare, /Dockerfile/u);
    assert.match(bare, /compose file/u);

    // Including for a Node repository with nothing that serves, where "no dev
    // script" alone leaves somebody who has a Dockerfile wondering whether it
    // was even looked at.
    await writeFile(
      path.join(root, "package.json"),
      '{"scripts":{"build":"tsc"}}',
      "utf8",
    );
    assert.match(await describeUndetectable(root), /Dockerfile/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** What a built app serves, so the test can tell which build produced it. */
function serverSource(says: string): string {
  return [
    'import { createServer } from "node:http";',
    `createServer((_, response) => response.end(${JSON.stringify(says)})).listen(`,
    '  Number(process.env["PORT"]), "127.0.0.1");',
    "",
  ].join("\n");
}

/**
 * A repository whose app exists only once it has been built.
 *
 * The commonest shape there is, and the one the preview could not start.
 * Installed is not built: build output is ignored by git — which is exactly
 * why it is not in the revision — so a checkout of canonical has no `dist` in
 * it, and `node dist/server.mjs` dies on its first line. What the reader was
 * shown for that was "exited immediately", which reads as the start command
 * being wrong, so the obvious thing to try is a different one and none of
 * them can work.
 *
 * Two builds are committed, serving different words, so a test can tell which
 * of them ran.
 */
async function unbuiltAppRepository(): Promise<{
  root: string;
  sourcePath: string;
  project: CoordinatorProject;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-build-"));
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({
      name: "needs-building",
      private: true,
      type: "module",
      scripts: { build: "node build.mjs", start: "node dist/server.mjs" },
    })}\n`,
    "utf8",
  );
  for (const [name, says] of [
    ["build.mjs", "detected"],
    ["build-configured.mjs", "configured"],
  ] as const) {
    await writeFile(
      path.join(sourcePath, name),
      [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'await mkdir("dist", { recursive: true });',
        `await writeFile("dist/server.mjs", ${JSON.stringify(serverSource(says))});`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  await repositories.commitAll(sourcePath, "seed unbuilt app");

  const projectRoot = path.join(root, "proj");
  await mkdir(projectRoot, { recursive: true });
  const project = await CoordinatorProject.init(projectRoot);
  return { root, sourcePath, project };
}

test("a build runs to completion before the start command is spawned", async () => {
  const { root, sourcePath, project } = await unbuiltAppRepository();
  const store = project.openStore();
  try {
    const repository = await repoAdd(project, store, {
      sourcePath,
      id: "needs-building",
    });
    const previews = new PreviewService(project, store);
    try {
      const status = await previews.start({ repositoryId: repository.id });
      // The proof of the ordering is that anything answers at all: the start
      // script runs a file that does not exist until the build has written
      // it, so a start spawned first could only have died.
      assert.equal(status.ready, true);
      assert.match(status.label, /run start$/u);
      assert.equal((await (await fetch(status.url)).text()), "detected");
      // And nothing was ruled out on the way — the first candidate worked,
      // which it never could before.
      assert.equal(status.tried, undefined);
    } finally {
      await previews.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a configured buildCommand wins over the detected one", async () => {
  const { root, sourcePath, project } = await unbuiltAppRepository();
  const store = project.openStore();
  try {
    const repository = await repoAdd(project, store, {
      sourcePath,
      id: "needs-building",
    });
    // Detection finds the `build` script; a project that says how this
    // repository is built is answering the question rather than guessing at
    // it, so it is the one that runs.
    project.config.buildCommands = {
      [repository.id]: {
        executable: process.execPath,
        args: ["build-configured.mjs"],
        label: "configured build",
      },
    };
    await project.save();

    const previews = new PreviewService(project, store);
    try {
      const status = await previews.start({ repositoryId: repository.id });
      assert.equal((await (await fetch(status.url)).text()), "configured");
    } finally {
      await previews.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a build that fails is reported as a build failure, not a dead server", async () => {
  const { root, sourcePath, project } = await unbuiltAppRepository();
  const store = project.openStore();
  try {
    const repository = await repoAdd(project, store, {
      sourcePath,
      id: "needs-building",
    });
    project.config.buildCommands = {
      [repository.id]: {
        executable: process.execPath,
        args: ["-e", "console.error('tsc: cannot find name X'); process.exit(2)"],
        label: "configured build",
      },
    };
    await project.save();

    const previews = new PreviewService(project, store);
    try {
      await assert.rejects(
        async () => await previews.start({ repositoryId: repository.id }),
        (error: Error) => {
          // Said where it happened. Everything after a failed build is a
          // consequence of it, and reporting only the corpse of the start
          // command sends the reader looking for a start command that was
          // never wrong.
          assert.match(error.message, /Building "needs-building" failed/u);
          assert.match(error.message, /configured build/u);
          assert.match(error.message, /cannot find name X/u);
          assert.doesNotMatch(error.message, /exited immediately/u);
          // And it is not the question about how the app starts: the app
          // says how it starts, and the answer would change nothing.
          assert.doesNotMatch(error.message, /could not be started/u);
          return true;
        },
      );
      assert.equal(await previews.status(repository.id), undefined);
    } finally {
      await previews.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an agent's task preview builds the same way the play button does", async () => {
  const { root, sourcePath, project } = await unbuiltAppRepository();
  const store = project.openStore();
  try {
    // An agent's workspace is a worktree plus its own edits, so it is exactly
    // as unbuilt as the play button's checkout — and an agent that cannot
    // start what it just changed is back to guessing whether it works.
    const workspacePath = path.join(root, "task-workspace");
    await mkdir(workspacePath, { recursive: true });
    for (const name of ["package.json", "build.mjs", "build-configured.mjs"]) {
      await writeFile(
        path.join(workspacePath, name),
        await readFile(path.join(sourcePath, name), "utf8"),
        "utf8",
      );
    }

    const previews = new PreviewService(project, store);
    try {
      const started = await previews.startForTask({
        taskId: "task-1",
        repositoryId: "needs-building",
        workspacePath,
      });
      assert.equal(started.failed, false);
      assert.ok(started.url !== undefined, started.output.join("\n"));
      assert.equal((await (await fetch(started.url)).text()), "detected");
    } finally {
      await previews.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** The port something bound, once it is listening. */
async function listeningPort(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Nothing bound a port");
  }
  // Unreferenced so a connection a probe left behind cannot hold this test
  // file's process open once the assertions are done.
  server.unref();
  return address.port;
}

test("a port that connects is not the same as an app that answers", async () => {
  // The bug behind the white page. Every dev server binds its port *before*
  // it has anything to serve — Vite and webpack both do, and a container's
  // server binds the moment the process starts — so a bare TCP connect says
  // "ready" for the whole of a bundle it has not built. The reader was handed
  // the address at that moment, opened it, and got an empty document with
  // nothing anywhere saying the app was still working.
  const silent = createNetServer(() => {
    // Accepts the connection and says nothing, exactly as a server that is
    // still building does.
  });
  const building = createHttpServer((_, response) => {
    // What a proxy in front of an unfinished build answers with.
    response.writeHead(503, { "Content-Type": "text/plain" });
    response.end("still building");
  });
  const answering = createHttpServer((_, response) => {
    // An app whose front page is a 404 is up: its real page is elsewhere, and
    // refusing to offer the address would be refusing a working preview.
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });
  try {
    const silentPort = await listeningPort(silent);
    const buildingPort = await listeningPort(building);
    const answeringPort = await listeningPort(answering);

    assert.equal(await probePort(silentPort), true);
    assert.equal(await probePreviewResponse(silentPort, 400), false);

    assert.equal(await probePreviewResponse(buildingPort, 2_000), false);
    assert.equal(await probePreviewResponse(answeringPort, 2_000), true);

    // Nothing listening at all is neither.
    silent.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await probePreviewResponse(silentPort, 400), false);
  } finally {
    silent.close();
    building.close();
    answering.close();
  }
});

/**
 * A repository whose build is broken and whose dev server does not need it.
 *
 * A detected build is a guess, so a failing one is deliberately not fatal —
 * that is right, and it quietly produced the worst version of this: the app
 * starts, serves whatever bundle was there before (usually none), and the
 * page opens as an empty white rectangle. The reason existed the whole time,
 * in a log nobody was shown.
 */
async function halfBuiltRepository(): Promise<{
  root: string;
  sourcePath: string;
  project: CoordinatorProject;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-half-"));
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({
      name: "half-built",
      private: true,
      type: "module",
      scripts: { build: "node build.mjs", dev: "node server.mjs" },
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(sourcePath, "build.mjs"),
    "console.error('tsc: cannot find name Widget');\nprocess.exit(2);\n",
    "utf8",
  );
  await writeFile(path.join(sourcePath, "server.mjs"), serverSource("half"), "utf8");
  await repositories.commitAll(sourcePath, "seed half-built app");

  const projectRoot = path.join(root, "proj");
  await mkdir(projectRoot, { recursive: true });
  const project = await CoordinatorProject.init(projectRoot);
  return { root, sourcePath, project };
}

test("an app started on a build that failed says so instead of just being blank", async () => {
  const { root, sourcePath, project } = await halfBuiltRepository();
  const store = project.openStore();
  try {
    const repository = await repoAdd(project, store, {
      sourcePath,
      id: "half-built",
    });
    // Nothing to install, and saying so beats paying for a registry round
    // trip in a test that is about the build.
    project.config.installCommands = {
      [repository.id]: {
        executable: process.execPath,
        args: ["-e", "0"],
        label: "nothing to install",
      },
    };
    await project.save();

    const previews = new PreviewService(project, store);
    try {
      const status = await previews.start({ repositoryId: repository.id });
      // Still started: a guessed build that fails must not take a working dev
      // server with it, which is what it did before the build step existed.
      assert.equal(status.ready, true);
      assert.match(status.label, /run dev$/u);
      assert.equal(await (await fetch(status.url)).text(), "half");

      // And the reader is told what they are looking at. Without this the
      // only difference between a half-built app and a broken one was a line
      // in a log nothing renders.
      assert.ok(
        status.buildFailure !== undefined,
        `expected a build failure, got ${JSON.stringify(status)}`,
      );
      assert.match(status.buildFailure, /run build/u);
      assert.match(status.buildFailure, /exited 2/u);
      // The build's own words are in the output the reader can open, which is
      // where a package manager's failure text ends up.
      assert.ok(
        status.recentOutput.some((line) =>
          line.includes("cannot find name Widget"),
        ),
        status.recentOutput.join("\n"),
      );
      // It survives the poll the header reads, rather than only being in the
      // answer to the press.
      const later = await previews.status(repository.id);
      assert.match(later?.buildFailure ?? "", /run build/u);
    } finally {
      await previews.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
