import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { CoordinationStore } from "@coord/persistence";
import {
  RepositoryService,
  sanitizeChildEnv,
} from "@coord/repository-service";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import {
  CoordinatorProject,
  type PreviewCommand,
} from "@coord/cli/project";

/**
 * Runs a repository's own app, so somebody can look at what the agents built.
 *
 * Everything else in this system produces a diff and a validation result,
 * which answers "did it break the tests" and never answers "does it work".
 * That second question needs the thing running.
 *
 * **Loopback only, deliberately.** The server binds 127.0.0.1 and no port is
 * mapped anywhere: on a laptop that is exactly what is wanted, and on a hosted
 * deployment it means the preview is unreachable rather than accidentally
 * public. Exposing an app an agent just wrote, on a URL anyone holding it can
 * open, is a decision with real consequences and it is not this class's to
 * make. A hosted preview needs auth, expiry and an explicit choice; until
 * those exist, unreachable is the honest failure mode.
 */

/** How much of a preview's output is kept for the UI to show. */
const LOG_LINES = 200;

/**
 * How long a preview may run without being asked about before it is stopped.
 *
 * A preview is a thing somebody is looking at. Nobody looking at it for an
 * hour means the tab is closed and the process is just holding a port and a
 * checkout — this is a laptop, and the point of local-only is that it behaves
 * like a tool rather than a service.
 */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** How long the play button waits for a port before reporting "starting". */
const START_READY_TIMEOUT_MS = 120_000;

export interface PreviewStatus {
  repositoryId: string;
  /** Where to look. Always loopback; see the class doc. */
  url: string;
  port: number;
  /** Canonical revision the preview was started from. */
  revision: string;
  /** What is actually running, so the reader is not guessing. */
  label: string;
  /**
   * Whether the port is answering yet.
   *
   * Distinct from "running", because the gap between them is not always
   * instant: a command that builds before it serves — which is the honest
   * shape for any repository whose start script expects a build output — can
   * be several minutes of a perfectly healthy process. Offering the address
   * during that window is offering something that does not work, and a reader
   * who clicks it concludes the preview is broken.
   */
  ready: boolean;
  startedAt: string;
  /** Set once the process has exited, with however it went. */
  exited?: { code: number | null; signal: string | null; at: string };
  recentOutput: string[];
  /**
   * The commands that were tried and did not survive, before this one.
   *
   * Present only when something was ruled out on the way. A repository is
   * started by working down a list of candidates, and which of them were
   * tried is the difference between "this app cannot be started" and "the
   * first guess was wrong" — a distinction the reader has no other way to
   * make, because the failed attempts leave nothing behind.
   */
  tried?: string[];
}

/**
 * One way a repository might start, and where it is run from.
 *
 * `cwd` is what a monorepo needs. The thing that serves a page is `apps/web`
 * and the root has no script that starts it, so the candidate is the app's own
 * `dev` script run in the app's own directory. Relative to the checkout, and
 * absent for the ordinary case of a command run at the root.
 */
export interface PreviewCandidate extends PreviewCommand {
  cwd?: string;
}

interface Running {
  /** A spawned dev server, or a static one served in this process. */
  child?: ChildProcess;
  server?: Server;
  status: PreviewStatus;
  workspacePath: string;
  lastAskedAt: number;
}

/**
 * The port, written into the arguments that need it spelled out.
 *
 * `PORT` is in the child's environment already and most servers read it, but
 * several of the commands detected below take the address as an argument —
 * Django's `runserver`, `php -S`, `rails server` — and `spawn` performs no
 * shell expansion, so `${PORT}` would arrive at the process as those seven
 * literal characters. Substituted here rather than at detection time because
 * detection runs before a port has been chosen.
 */
function withPort(args: readonly string[], port: number): string[] {
  return args.map((arg) => arg.replaceAll("${PORT}", String(port)));
}

/** Reads a file, or nothing when it is not there. */
async function textOf(
  workspacePath: string,
  ...names: string[]
): Promise<string | undefined> {
  for (const name of names) {
    try {
      return await readFile(path.join(workspacePath, name), "utf8");
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Whether any of these exist in the checkout. */
async function anyOf(
  workspacePath: string,
  ...names: string[]
): Promise<string | undefined> {
  for (const name of names) {
    try {
      await access(path.join(workspacePath, name));
      return name;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The package manager a Node repository pinned, by the lockfile it committed. */
async function nodeRunner(workspacePath: string): Promise<string[]> {
  const lock = await anyOf(
    workspacePath,
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
  );
  if (lock === "pnpm-lock.yaml") {
    return ["pnpm", "run"];
  }
  if (lock === "yarn.lock") {
    return ["yarn", "run"];
  }
  if (lock === "bun.lockb") {
    return ["bun", "run"];
  }
  return [process.platform === "win32" ? "npm.cmd" : "npm", "run"];
}

/**
 * A manifest's scripts, or nothing when there is no readable one there.
 *
 * `relativeDir` is for a monorepo: the same reading, done on one workspace's
 * own package.json rather than the root's.
 */
export async function readManifestScripts(
  workspacePath: string,
  relativeDir = ".",
): Promise<Record<string, string> | undefined> {
  const manifest = await textOf(
    workspacePath,
    path.join(relativeDir, "package.json"),
  );
  if (manifest === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(manifest) as { scripts?: Record<string, unknown> };
    const scripts: Record<string, string> = {};
    for (const [name, body] of Object.entries(parsed.scripts ?? {})) {
      if (typeof body === "string") {
        scripts[name] = body;
      }
    }
    return scripts;
  } catch {
    return undefined;
  }
}

/**
 * The start scripts a manifest actually has, in the order worth trying them.
 *
 * `dev` first: where a repository has several, that is the one meant to be
 * watched. `start` is often the production entry point — which in a fresh
 * checkout is frequently a build output that is not there — and the last two
 * are what static-site tooling tends to call it. All of them are offered
 * rather than only the first, because "the best guess was wrong" is not the
 * same as "this app cannot be started" and only trying the rest tells them
 * apart.
 */
function nodeScriptCandidates(
  scripts: Record<string, string>,
  runner: readonly string[],
  where?: string,
): PreviewCandidate[] {
  const executable = runner[0] ?? "npm";
  const run = runner[1] ?? "run";
  return PREVIEW_SCRIPTS.filter((name) => scripts[name] !== undefined).map(
    (name) => ({
      executable,
      args: [run, name],
      label: `${executable} ${run} ${name}${
        where === undefined ? "" : ` in ${where}`
      }`,
      ...(where === undefined ? {} : { cwd: where }),
    }),
  );
}

/** How many workspace apps are worth trying before giving up on the shape. */
const WORKSPACE_APP_LIMIT = 6;

/**
 * The apps inside a monorepo, for a root that does not start one of them.
 *
 * A workspace root is the commonest repository shape this could not previously
 * start. Its own `dev` script builds every package and then runs a server, or
 * there is no root `dev` at all — and either way the thing somebody wants to
 * look at is one app in `apps/`, whose own `dev` script starts in seconds.
 *
 * Read from the workspace declaration rather than by walking the tree: a
 * directory that is listed as a workspace is the project saying it is one,
 * which is the same standard of evidence every other rung here holds to.
 * Apps before packages, because a library's `dev` script watches and builds
 * and serves nothing.
 */
export async function workspaceAppCandidates(
  workspacePath: string,
  runner: readonly string[],
): Promise<PreviewCandidate[]> {
  const patterns: string[] = [];
  const manifest = await textOf(workspacePath, "package.json");
  try {
    const declared = (
      JSON.parse(manifest ?? "{}") as {
        workspaces?: string[] | { packages?: string[] };
      }
    ).workspaces;
    patterns.push(
      ...(Array.isArray(declared) ? declared : (declared?.packages ?? [])).filter(
        (entry): entry is string => typeof entry === "string",
      ),
    );
  } catch {
    // A manifest that will not parse declares nothing this can read.
  }
  // pnpm keeps the same list in a file of its own. Read as lines rather than
  // as YAML: it is a list of strings, and a parser would be a dependency.
  for (const line of (
    (await textOf(workspacePath, "pnpm-workspace.yaml")) ?? ""
  ).split(/\r?\n/u)) {
    const entry = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/u.exec(line)?.[1];
    if (entry !== undefined) {
      patterns.push(entry);
    }
  }
  if (patterns.length === 0) {
    return [];
  }

  // Only the one glob shape a workspace list actually uses. `apps/*` is a
  // directory listing; a literal path is itself; anything else is skipped
  // rather than guessed at, on the same principle as the rungs above.
  const directories: string[] = [];
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/+$/u, "");
    if (clean.endsWith("/*")) {
      const parent = clean.slice(0, -2);
      let entries: string[] = [];
      try {
        entries = (
          await readdir(path.join(workspacePath, parent), {
            withFileTypes: true,
          })
        )
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      directories.push(...entries.map((name) => `${parent}/${name}`));
    } else if (!clean.includes("*")) {
      directories.push(clean);
    }
  }

  const apps = (directory: string): boolean =>
    /^apps?\//u.test(directory) || /^(?:apps?|web|site|frontend)$/u.test(directory);
  const ordered = [...new Set(directories)].sort((left, right) => {
    if (apps(left) !== apps(right)) {
      return apps(left) ? -1 : 1;
    }
    return left.localeCompare(right);
  });

  const candidates: PreviewCandidate[] = [];
  for (const directory of ordered) {
    if (candidates.length >= WORKSPACE_APP_LIMIT) {
      break;
    }
    const scripts = await readManifestScripts(workspacePath, directory);
    if (scripts === undefined) {
      continue;
    }
    // One per app, not one per script: a second script in the same package is
    // a worse guess than the first script in the next app.
    const [best] = nodeScriptCandidates(scripts, runner, directory);
    if (best !== undefined) {
      candidates.push(best);
    }
  }
  return candidates;
}

/** The compose files a project may have written its stack into. */
const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
];

/**
 * What to call the image built for a repository's preview.
 *
 * Derived from the checkout's own directory, which is one preview and not one
 * repository: an agent previewing its unlanded work and somebody pressing
 * play on canonical are two different builds of the same project, and a tag
 * they shared would mean whichever finished last is what both of them run.
 * Squeezed into what a tag may contain — lowercase, and only letters, digits,
 * dot, dash and underscore — and a name that survives none of that becomes
 * `app`, which is wrong about nothing: the tag identifies the image, and the
 * label the reader sees is written separately.
 */
function previewImageTag(workspacePath: string): string {
  const base = path
    .basename(workspacePath)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[-._]+/u, "")
    .slice(0, 40);
  return `coord-preview-${base === "" ? "app" : base}`;
}

/**
 * How a repository that ships a container starts: by building it.
 *
 * The rung that was missing. A repository whose only statement about how it
 * runs is a Dockerfile had *nothing* detected for it — no Procfile, often no
 * start script, because the image's `CMD` is where that lives — so the play
 * button asked the reader to type a command for an app that had already
 * written one down. And a repository with both got its dev server, which is
 * usually what is wanted and is never what "it does not build the image"
 * means.
 *
 * Built and run in one shell line rather than as two candidates, because half
 * of it is not a preview: an image with nothing running it serves no page.
 * `sh -c` for the same reason the Procfile rung uses it — this is a sequence,
 * and `spawn` does not run sequences.
 *
 * The container's port is read from `EXPOSE` where the Dockerfile says it,
 * and is the preview's own port where it does not; `PORT` goes in either way,
 * for an image that reads it. A stale container of the same name is removed
 * first, because the second press of play would otherwise fail on the name
 * rather than on anything about the repository.
 *
 * Compose is its own case: the ports are declared in the file, so the mapping
 * is not this code's to make. `PORT` reaches it through the environment,
 * which is what a compose file publishing `${PORT}` needs, and a file that
 * publishes a fixed port is reachable there rather than at the preview's URL.
 */
export async function dockerCandidates(
  workspacePath: string,
): Promise<PreviewCandidate[]> {
  const candidates: PreviewCandidate[] = [];
  const compose = await anyOf(workspacePath, ...COMPOSE_FILES);
  if (compose !== undefined) {
    candidates.push({
      executable: "docker",
      args: ["compose", "-f", compose, "up", "--build"],
      label: `docker compose up --build (${compose})`,
    });
  }
  if ((await anyOf(workspacePath, "Dockerfile")) !== undefined) {
    const tag = previewImageTag(workspacePath);
    const exposed = /^\s*EXPOSE\s+(\d{2,5})/mu.exec(
      (await textOf(workspacePath, "Dockerfile")) ?? "",
    )?.[1];
    const inner = exposed ?? "${PORT}";
    candidates.push({
      executable: "sh",
      args: [
        "-c",
        `docker rm -f ${tag} >/dev/null 2>&1; ` +
          `docker build -t ${tag} . && ` +
          `exec docker run --rm --name ${tag} ` +
          `-p 127.0.0.1:\${PORT}:${inner} -e PORT=${inner} ${tag}`,
      ],
      label: `docker build && docker run (${tag})`,
    });
  }
  return candidates;
}

/**
 * Every way this repository might start, best first.
 *
 * Every rung wants a *named file* that says what the project is — a
 * `manage.py`, a `Cargo.toml`, a `web:` line in a Procfile — rather than a
 * guess from the shape of the tree. That is the difference between this and
 * guessing: a wrong answer here spawns something that fails in a way nobody
 * can read, so a rung that cannot point at its evidence does not exist.
 *
 * A *list* rather than an answer, because the evidence ranks candidates and
 * does not pick one. The commonest failure this had was a repository whose
 * best guess was right about the ecosystem and wrong about the command — a
 * `start` script pointing at a build output that a fresh checkout does not
 * contain — and the reader was then asked to type a start command for an app
 * that had a perfectly good one a rung further down. The caller runs down the
 * list and asks only when all of it is spent.
 *
 * An empty list still means "say so". A repository with no app in it — a
 * library, a CLI — has no localhost to boot, and {@link describeUndetectable}
 * tells the reader what was looked for.
 */
export async function detectPreviewCommands(
  workspacePath: string,
): Promise<PreviewCandidate[]> {
  const candidates: PreviewCandidate[] = [];
  const seen = new Set<string>();
  const add = (...found: PreviewCandidate[]): void => {
    for (const candidate of found) {
      const key = [
        candidate.cwd ?? ".",
        candidate.executable,
        ...candidate.args,
      ].join(" ");
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(candidate);
      }
    }
  };

  // 1. The project saying it outright. A Procfile's `web:` line is a start
  //    command by definition, in every language that uses one.
  const procfile = await textOf(workspacePath, "Procfile");
  const web = /^web:\s*(.+)$/mu.exec(procfile ?? "")?.[1]?.trim();
  if (web !== undefined && web.length > 0) {
    add({
      // Through a shell because a Procfile line is a shell line — it may
      // carry `&&`, quotes or a `$PORT` of its own, and splitting it on
      // spaces would mangle all three.
      executable: "sh",
      args: ["-c", web],
      label: `Procfile: ${web}`,
    });
  }

  // 2. Node, and the package manager the repository actually pinned. Running
  //    `npm` in a pnpm workspace fails on the lockfile, so the lockfile picks.
  const runner = await nodeRunner(workspacePath);
  const scripts = await readManifestScripts(workspacePath);
  if (scripts !== undefined) {
    add(...nodeScriptCandidates(scripts, runner));
    // 3. And the apps inside it, for the monorepo whose root starts nothing
    //    that serves a page.
    add(...(await workspaceAppCandidates(workspacePath, runner)));
  }

  // 4. Python, where the framework names itself in a file.
  if ((await anyOf(workspacePath, "manage.py")) !== undefined) {
    // Django's runserver takes the address as an argument rather than PORT.
    add({
      executable: "python3",
      args: ["manage.py", "runserver", "0.0.0.0:${PORT}"],
      label: "python3 manage.py runserver",
    });
  }
  const pythonDeps =
    (await textOf(workspacePath, "requirements.txt", "pyproject.toml")) ?? "";
  const appModule = await anyOf(
    workspacePath,
    "main.py",
    "app.py",
    "asgi.py",
    "wsgi.py",
  );
  if (/\bfastapi\b|\buvicorn\b/iu.test(pythonDeps) && appModule !== undefined) {
    const module = appModule.replace(/\.py$/u, "");
    add({
      executable: "uvicorn",
      args: [`${module}:app`, "--host", "0.0.0.0", "--port", "${PORT}"],
      label: `uvicorn ${module}:app`,
    });
  }
  if (/\bflask\b/iu.test(pythonDeps) && appModule !== undefined) {
    add({
      executable: "python3",
      args: ["-m", "flask", "--app", appModule, "run", "--host", "0.0.0.0", "--port", "${PORT}"],
      label: `flask run --app ${appModule}`,
    });
  }

  // 5. Compiled languages, where the manifest is the evidence and the
  //    toolchain resolves its own dependencies on the way.
  if ((await anyOf(workspacePath, "go.mod")) !== undefined) {
    add({ executable: "go", args: ["run", "."], label: "go run ." });
  }
  if ((await anyOf(workspacePath, "Cargo.toml")) !== undefined) {
    add({ executable: "cargo", args: ["run"], label: "cargo run" });
  }

  // 6. Ruby. `bin/rails` before `config.ru`: a Rails app has both, and its
  //    own binstub is the one that loads the framework.
  if ((await anyOf(workspacePath, "bin/rails")) !== undefined) {
    add({
      executable: "bin/rails",
      args: ["server", "-b", "0.0.0.0", "-p", "${PORT}"],
      label: "bin/rails server",
    });
  }
  if ((await anyOf(workspacePath, "config.ru")) !== undefined) {
    add({
      executable: "bundle",
      args: ["exec", "rackup", "--host", "0.0.0.0", "--port", "${PORT}"],
      label: "rackup",
    });
  }

  // 7. PHP's own server, which needs no framework and no install.
  const phpRoot = await anyOf(workspacePath, "public/index.php", "index.php");
  if (phpRoot !== undefined) {
    const docroot = phpRoot.startsWith("public/") ? "public" : ".";
    add({
      executable: "php",
      args: ["-S", "0.0.0.0:${PORT}", "-t", docroot],
      label: `php -S -t ${docroot}`,
    });
  }

  // 8. The container the repository ships, built and run. Last of the
  //    commands, and not first: an image takes minutes to build where a dev
  //    server takes seconds to start, and a repository that has both wants
  //    the one it can watch reload. Where it is the only statement about how
  //    the app runs — which is every repository whose CMD is the start
  //    command — it is the difference between a preview and a dialog asking
  //    somebody to type what they already wrote in the Dockerfile.
  //
  //    A machine with no docker on it fails this candidate the way every
  //    other missing runtime fails one: the spawn errors, the candidate is
  //    ruled out, and the walk continues.
  add(...(await dockerCandidates(workspacePath)));
  return candidates;
}

/** The best of {@link detectPreviewCommands}, for callers wanting one answer. */
export async function detectPreviewCommand(
  workspacePath: string,
): Promise<PreviewCandidate | undefined> {
  return (await detectPreviewCommands(workspacePath))[0];
}

const PREVIEW_SCRIPTS = ["dev", "start", "serve", "preview"];

/** Extensions a preview will serve, and what it calls them. */
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Whether this is a site that only needs serving.
 *
 * An `index.html` at the root with nothing that builds it is not a guess: it
 * is a page, and serving the folder is what anybody meant. This is the one
 * case worth detecting beyond Node, because it needs no runtime, no install
 * and no configuration — and it is the shape of a great many small apps.
 *
 * Serving over HTTP rather than leaving somebody to open the file matters
 * more than it looks: a `file://` page is an opaque origin, so every `fetch`
 * it makes fails, which is exactly how a working app looks broken.
 */
export async function isStaticSite(workspacePath: string): Promise<boolean> {
  try {
    await access(path.join(workspacePath, "index.html"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Serves one directory over loopback, in this process.
 *
 * In-process rather than spawning something, because the alternatives all
 * assume a runtime that may not be there — `python3 -m http.server` is the
 * obvious one and a Node container has no Python in it. This needs nothing
 * that is not already running.
 *
 * The path check is the security boundary: a request is resolved and then
 * required to still be inside the root, so `..` and absolute paths reach
 * nothing. Symlinks are followed by `readFile` and would escape it, which is
 * acceptable here and would not be if this were reachable from outside the
 * machine — it binds loopback and the proxy in front of it authenticates.
 */
export function startStaticServer(root: string, port: number): Server {
  const server = createHttpServer((request, response) => {
    const raw = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const relative = raw.endsWith("/") ? `${raw}index.html` : raw;
    const target = path.resolve(root, `.${path.posix.normalize(relative)}`);
    if (target !== root && !target.startsWith(root + path.sep)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    readFile(target)
      .then((bytes) => {
        response.writeHead(200, {
          "Content-Type":
            STATIC_TYPES[path.extname(target).toLowerCase()] ??
            "application/octet-stream",
          "Content-Length": String(bytes.length),
          // A preview is whatever the workspace holds right now, and the
          // workspace changes under it every time a task lands.
          "Cache-Control": "no-store",
        });
        response.end(bytes);
      })
      .catch(() => {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
      });
  });
  // An unhandled `error` event on a net server is a fatal exception, and this
  // one binds a port that was free a moment ago — a race the OS is entitled to
  // lose. Callers add their own listener to record what happened; this one
  // exists so that a caller who does not cannot take the control plane down
  // with a preview.
  server.on("error", () => {});
  server.listen(port, "127.0.0.1");
  return server;
}

/**
 * Why nothing could be started, in terms of what is actually in the
 * repository.
 *
 * "Nothing here looks like an app" is true and useless: it does not say what
 * was looked for, so the reader cannot tell a missing script from a missing
 * package.json from a repository that was never going to have either. The
 * config file lives on the server, which for a hosted deployment is somewhere
 * the reader cannot open, so the message has to carry the diagnosis.
 */
export async function describeUndetectable(workspacePath: string): Promise<string> {
  const manifest = await textOf(workspacePath, "package.json");
  if (manifest !== undefined) {
    const scripts = await readManifestScripts(workspacePath);
    if (scripts === undefined) {
      return "Its package.json could not be parsed, so no script could be read.";
    }
    const names = Object.keys(scripts);
    // A workspace root with no start script of its own is only undetectable
    // once its apps have been looked at too, so say that they were.
    const workspaces = (await workspaceAppCandidates(workspacePath, ["npm", "run"]))
      .length;
    const alsoWorkspaces =
      workspaces === 0 && /"workspaces"/u.test(manifest)
        ? " No workspace it declares has one either."
        : "";
    return (
      (names.length === 0
        ? "Its package.json has no scripts at all."
        : `Its package.json has no ${PREVIEW_SCRIPTS.join("/")} script — ` +
          `only ${names.slice(0, 8).join(", ")}.`) +
      alsoWorkspaces +
      // A container is a way of starting too, and one a Node repository
      // plausibly has — so a reader who has one is told it was looked at
      // rather than left wondering whether only scripts were.
      ((await anyOf(workspacePath, "Dockerfile", ...COMPOSE_FILES)) ===
      undefined
        ? " There is no Dockerfile or compose file to build and run either."
        : "")
    );
  }
  // Named individually rather than as "nothing matched": the reader can add
  // whichever one their project should have had, or set the command outright.
  return (
    "Nothing in it names a way to start: no Procfile web: line, no " +
    "package.json, no manage.py or FastAPI/Flask entry point, no go.mod, " +
    "no Cargo.toml, no config.ru or bin/rails, no index.php, no Dockerfile " +
    "or compose file to build and run, and no index.html to serve as a " +
    "static site."
  );
}

/**
 * What to call a repository when telling somebody it would not start.
 *
 * Its display name, which is what the channel is called on screen, and its id
 * otherwise. The two are not always the same — an id is taken by the first
 * repository to want it, so the second is stored under a suffixed one and
 * renamed for display — and a failure that named the id was reporting on a
 * repository the reader has never seen that name for: the dialog asked how
 * KUMI starts and the sentence inside it was about LATTICE.
 */
export function displayNameOf(repository: {
  id: string;
  displayName?: string;
}): string {
  const name = (repository.displayName ?? "").trim();
  return name === "" ? repository.id : name;
}

/**
 * How to install a repository nobody has configured.
 *
 * Only where there is something to install and it has not been installed
 * already: a checkout that somehow has `node_modules` is left alone, because
 * installing again would cost minutes to reach the same state.
 *
 * `npm ci` where there is a lockfile, `npm install` where there is not — the
 * first is faster and exact, and it refuses outright without a lockfile, which
 * would otherwise be a confusing way to fail.
 */
async function detectInstallCommand(
  workspacePath: string,
): Promise<PreviewCommand | undefined> {
  const has = async (name: string): Promise<boolean> => {
    try {
      await access(path.join(workspacePath, name));
      return true;
    } catch {
      return false;
    }
  };
  if (!(await has("package.json")) || (await has("node_modules"))) {
    return undefined;
  }
  const locked = await has("package-lock.json");
  return {
    executable: process.platform === "win32" ? "npm.cmd" : "npm",
    args: locked ? ["ci"] : ["install"],
    label: locked ? "npm ci" : "npm install",
  };
}

/**
 * How to build a repository nobody has configured.
 *
 * The other half of what a fresh checkout is missing. `node_modules` is the
 * famous one and build output is the same story: ignored by git, so not in
 * the revision, so absent from a checkout of canonical — and a repository
 * whose start script is `node dist/index.js`, or whose dev server imports a
 * sibling package that is compiled before it is importable, dies on its first
 * line without one. Which is reported as the app exiting immediately, so the
 * obvious thing to try is a different start command, and none of them can
 * work: the command was never the problem.
 *
 * A `build` script is the evidence, held to the same standard as every
 * detection rung here — a script the repository named itself, run with the
 * package manager it pinned. Nothing is inferred for a repository without
 * one, and a build that is only a guess is not allowed to be fatal: see the
 * caller.
 */
async function detectBuildCommand(
  workspacePath: string,
): Promise<PreviewCommand | undefined> {
  const scripts = await readManifestScripts(workspacePath);
  if (scripts?.["build"] === undefined) {
    return undefined;
  }
  const runner = await nodeRunner(workspacePath);
  const executable = runner[0] ?? "npm";
  const run = runner[1] ?? "run";
  return {
    executable,
    args: [run, "build"],
    label: `${executable} ${run} build`,
  };
}

/**
 * Runs one command to completion, collecting what it said.
 *
 * Answers `undefined` when it worked and a reason when it did not. The output
 * is kept either way and handed to the preview's own log, because the question
 * "why did this not start" is usually answered somewhere in an install that
 * went wrong rather than in the server that never ran.
 */
async function runToCompletion(
  command: PreviewCommand,
  cwd: string,
  output: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const child = spawn(command.executable, [...command.args], {
      cwd,
      env: { ...env, ...command.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = (chunk: Buffer): void => {
      for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
        if (line.trim().length > 0) {
          output.push(line);
        }
      }
    };
    child.stdout?.on("data", record);
    child.stderr?.on("data", record);
    child.on("error", (error) => resolve(error.message));
    child.on("close", (code) =>
      resolve(
        code === 0
          ? undefined
          : `exited ${String(code)} — ${output.slice(-3).join(" ") || "no output"}`,
      ),
    );
  });
}

/**
 * Waits for something to start answering on a port.
 *
 * Bounded, because the caller is an agent holding its workspace and its leases
 * while it waits. `false` means "not yet", which is not the same as "never" —
 * a slow dev server is still a working one, and the decision about whether to
 * keep waiting belongs to whoever asked rather than here.
 */
async function waitForPort(
  port: number,
  exited: () => boolean,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !exited()) {
    if (await probePort(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Whether anything is listening on a loopback port, asked once. */
async function probePort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = connect({ port, host: "127.0.0.1" });
    const settle = (answer: boolean): void => {
      probe.destroy();
      resolve(answer);
    };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
    probe.setTimeout(1_000, () => settle(false));
  });
}

/**
 * Variables that name *this* control plane's own state.
 *
 * A preview is a separate app in a separate checkout, and it inherits this
 * process's environment so that a PATH, a HOME and a proxy setting all reach
 * it. These are the ones that must not: they say which project directory,
 * which database and which port belong to the control plane doing the
 * starting, and handing them to a child is how a preview stops being a
 * preview.
 *
 * It is not hypothetical, and it is not only about this repository previewing
 * itself. `COORD_PROJECT_ROOT` points at a project whose control plane is
 * already running and already holds its lock, so any child that reads it
 * either refuses to start or — if the lock were not there — becomes a second
 * writer on one SQLite file. Overriding them with the preview's own values is
 * the whole of the fix; a repository that genuinely wants one of these back
 * can say so in its command's `env`, which is applied last.
 */
const CONTROL_PLANE_VARIABLES = [
  "COORD_PROJECT_ROOT",
  "COORD_PORT",
  "COORD_HOST",
  "COORD_BOOTSTRAP_TOKEN",
  "COORD_SECURE_COOKIES",
  "COORD_ALLOWED_ORIGINS",
  // How the control plane was deployed, which is not how a preview is run.
  //
  // The container image sets `NODE_ENV=production`, and inheriting it made
  // `npm ci` in the preview's checkout omit devDependencies — so a repository
  // whose dev server is built by anything (`turbo`, `vite`, `tsc`) installed
  // successfully and then failed with `turbo: not found`. Which reads as the
  // start command being wrong, so the obvious thing to try is a different
  // start command, and that cannot work either: the command was never the
  // problem, the install was.
  //
  // Deleted rather than set to "development": unset is what npm needs to
  // install dev dependencies, and it lets the app pick its own default rather
  // than this deciding one for it.
  "NODE_ENV",
  "NPM_CONFIG_PRODUCTION",
  "npm_config_production",
  // npm exports its own invocation into the child environment, so a preview
  // spawned from a control plane that was itself started by `npm start`
  // inherits that run's config and lifecycle variables.
  "npm_config_argv",
  "npm_lifecycle_event",
  "npm_lifecycle_script",
];

/**
 * Stops a spawned preview and everything it started.
 *
 * A dev server is nearly always a process that starts another one — `npm run
 * dev` is a shell script that execs a bundler — and signalling only the child
 * leaves the grandchild running: it keeps the port, so the next press of play
 * finds it taken, and it keeps the stdout pipe this process is reading, so the
 * control plane itself acquires a handle that never closes. Pressing play a
 * few times leaks a server each time.
 *
 * So the children are spawned into their own process group and the group is
 * signalled. Windows has no process groups in this sense and no negative pid,
 * where killing the child is the best available answer and `taskkill` would be
 * a dependency on a shell this code deliberately never uses.
 */
function terminate(child: ChildProcess | undefined): void {
  if (child?.pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
      return;
    }
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone, or never became a group leader. Either way the fallback
    // costs nothing and cannot make things worse.
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

/** A free loopback port, chosen by asking the OS for one and letting it go. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("Could not allocate a port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export class PreviewService {
  private readonly repositories: RepositoryService;
  private readonly worktrees: GitWorktreeWorkspaceManager;
  private readonly running = new Map<string, Running>();
  /**
   * Starts that have not finished yet, so a second press joins the first.
   *
   * Starting replaces whatever is already running, which is right for a
   * preview that is *up* and wrong for one that is still coming up: a build
   * that takes a minute has nothing to show and no way to say so, so the
   * obvious thing to do is press play again — and that killed the build,
   * which then arrived as "npm run dev exited immediately", which is a
   * diagnosis of the repository for something the second press did. Joining
   * the attempt in flight is what both presses meant.
   */
  private readonly previewsStarting = new Map<string, Promise<PreviewStatus>>();
  /** Task-scoped previews: an agent looking at its own unlanded work. */
  private readonly taskPreviews = new Map<
    string,
    { child?: ChildProcess; server?: Server; port: number }
  >();
  private readonly sweeper: NodeJS.Timeout;

  public constructor(
    private readonly project: CoordinatorProject,
    private readonly store: CoordinationStore,
    repositories?: RepositoryService,
  ) {
    this.repositories = repositories ?? new RepositoryService();
    this.worktrees = new GitWorktreeWorkspaceManager(
      this.repositories.getGitClient(),
    );
    this.sweeper = setInterval(() => {
      void this.sweepIdle();
    }, 60_000);
    this.sweeper.unref?.();
  }

  /**
   * Starts this repository's preview, replacing any already running.
   *
   * Replacing rather than refusing, because the reason somebody asks twice is
   * that canonical has moved and they want to see the new state. Refusing
   * would make them stop it first to do the obvious thing.
   *
   * A start that has not finished yet is the exception: that one is *joined*
   * rather than replaced, because replacing it means killing a build nobody
   * asked to cancel and reporting its death as the repository's fault. See
   * {@link previewsStarting}.
   */
  public async start(input: {
    repositoryId: string;
  }): Promise<PreviewStatus> {
    const already = this.previewsStarting.get(input.repositoryId);
    if (already !== undefined) {
      return await already;
    }
    const attempt = this.startOnce(input.repositoryId);
    this.previewsStarting.set(input.repositoryId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.previewsStarting.get(input.repositoryId) === attempt) {
        this.previewsStarting.delete(input.repositoryId);
      }
    }
  }

  /**
   * One start, from the checkout to a process that is still alive.
   *
   * Separate from {@link start} only so that the guard around it has one
   * thing to hold: everything below runs once per press that reaches it.
   */
  private async startOnce(repositoryId: string): Promise<PreviewStatus> {
    const stored = await this.store.getRepository(repositoryId);
    if (stored === undefined) {
      throw new Error(`Unknown repository: ${repositoryId}`);
    }
    await this.stop(repositoryId);

    const canonical = {
      id: stored.id,
      path: stored.path,
      branch: stored.branch,
    };
    const version = await this.repositories.getCanonicalVersion(canonical);
    const root = path.join(this.project.workspaceRoot, "previews");
    await mkdir(root, { recursive: true });
    // Its own checkout at canonical head. Not a task's workspace: those are
    // created and destroyed around a run, and a preview has to outlive every
    // run so it can be watched while the next task changes things.
    const workspace = await this.worktrees.create({
      taskId: `preview-${repositoryId}`,
      rootPath: root,
      repository: canonical,
      baseVersion: version,
    });

    // Resolved after the checkout exists, because detection reads the
    // repository's own files. Configuration is one command and is taken as
    // the answer; detection is a ranked list, because the evidence in a
    // repository ranks candidates and does not pick one of them.
    const configured =
      this.project.config.previewCommands?.[repositoryId] ??
      this.project.config.previewCommand;
    const candidates: PreviewCandidate[] =
      configured === undefined
        ? await detectPreviewCommands(workspace.path)
        : [configured];
    const name = displayNameOf(stored);

    // A page with nothing that builds it needs no command at all, and this
    // process can serve it without assuming a runtime the machine may not
    // have. Last, though, and not first: a repository with both an index.html
    // and an app that serves it wants the app, and serving the folder hands
    // somebody the source of their site instead of their site.
    const serveStaticallyAt = (
      port: number,
      tried: readonly string[],
    ): PreviewStatus => {
      const server = startStaticServer(workspace.path, port);
      const status: PreviewStatus = {
        repositoryId,
        url: `http://127.0.0.1:${String(port)}`,
        port,
        revision: version.revision,
        label: "static files",
        // Served in this process: there is no gap between running and ready.
        ready: true,
        startedAt: new Date().toISOString(),
        recentOutput: [`serving ${workspace.path}`],
        ...(tried.length === 0 ? {} : { tried: [...tried] }),
      };
      // The port was free when it was asked for and may not be by now. Recorded
      // the same way a spawned server's failure is, so the reader is told the
      // preview stopped rather than being left with a link to nothing.
      server.on("error", (error) => {
        status.recentOutput.push(`could not serve: ${error.message}`);
        status.exited = {
          code: null,
          signal: null,
          at: new Date().toISOString(),
        };
      });
      this.running.set(repositoryId, {
        server,
        status,
        workspacePath: workspace.path,
        lastAskedAt: Date.now(),
      });
      return { ...status, recentOutput: [...status.recentOutput] };
    };

    if (candidates.length === 0) {
      if (await isStaticSite(workspace.path)) {
        const staticPort = await freePort();
        return serveStaticallyAt(staticPort, []);
      }
      const why = await describeUndetectable(workspace.path);
      await rm(workspace.path, { recursive: true, force: true });
      throw new Error(
        `Nothing in "${name}" could be started. ${why} ` +
          `Add a "previewCommands" entry for "${repositoryId}" in ` +
          `.coordinator/config.json — for example ` +
          `{"executable":"npm","args":["run","dev"],"label":"dev server"}.`,
      );
    }

    // Dependencies first. A checkout of canonical has none — they are ignored
    // by git, which is exactly why they are not in the revision — so a Node
    // app started here fails on its first import and looks like a broken
    // preview rather than an uninstalled one.
    const install =
      this.project.config.installCommands?.[repositoryId] ??
      this.project.config.installCommand ??
      (await detectInstallCommand(workspace.path));
    // Resolved before the install, because an install can need configuration
    // just as much as the server can — a private registry token is the usual
    // one — and because it is what creates the preview's own project. The port
    // it is given is a throwaway: each attempt below asks for one of its own,
    // because a port is claimed by whatever was tried before it.
    const installOutput: string[] = [];
    if (install !== undefined) {
      const failure = await runToCompletion(
        install,
        workspace.path,
        installOutput,
        await this.previewEnvironment(repositoryId, await freePort()),
      );
      if (failure !== undefined) {
        await rm(workspace.path, { recursive: true, force: true });
        throw new Error(
          `Installing dependencies failed (${install.label}): ${failure}`,
        );
      }
    }

    // Then the build, which is the step this never had. Installed is not
    // built: a checkout of canonical has no `dist`, no compiled sibling
    // package and no bundled asset in it, because build output is ignored by
    // git for the same reason `node_modules` is. Every start script that
    // expects one therefore died here, and said so as "exited immediately".
    const configuredBuild =
      this.project.config.buildCommands?.[repositoryId] ??
      this.project.config.buildCommand;
    const build =
      configuredBuild ?? (await detectBuildCommand(workspace.path));
    // Kept, because a build that failed is nearly always the reason nothing
    // starts afterwards, and the reader is otherwise shown only the corpse.
    let buildFailure: string | undefined;
    if (build !== undefined) {
      buildFailure = await runToCompletion(
        build,
        workspace.path,
        installOutput,
        await this.previewEnvironment(repositoryId, await freePort()),
      );
      if (buildFailure !== undefined) {
        // A configured build is an answer and is fatal; a detected one is a
        // guess and is not. A repository whose `build` script is broken and
        // whose `dev` server has never needed it still previews — it did
        // before this step existed, and taking that away would be a worse
        // bug than the one being fixed.
        if (configuredBuild !== undefined) {
          await rm(workspace.path, { recursive: true, force: true });
          throw new Error(
            `Building "${name}" failed (${build.label}): ${buildFailure}`,
          );
        }
        installOutput.push(`build failed (${build.label}): ${buildFailure}`);
      }
    }

    // Down the list until something survives. A candidate that exits is ruled
    // out rather than reported: the reader is asked how the app starts only
    // once the repository has run out of ways of saying it itself.
    const tried: string[] = [];
    for (const candidate of candidates) {
      const attempt = await this.attemptCommand({
        repositoryId,
        command: candidate,
        workspacePath: workspace.path,
        revision: version.revision,
        leadingOutput: installOutput,
        timeoutMs: START_READY_TIMEOUT_MS,
      });
      if ("failure" in attempt) {
        tried.push(`${candidate.label} ${attempt.failure}`);
        continue;
      }
      if (tried.length > 0) {
        attempt.entry.status.tried = [...tried];
      }
      this.running.set(repositoryId, attempt.entry);
      return {
        ...attempt.entry.status,
        recentOutput: [...attempt.entry.status.recentOutput],
      };
    }

    // Nothing that runs, and a page to serve. Reached only here, after every
    // command has been tried, so an app is never passed over for its own
    // source — and never where a command was configured: somebody who wrote
    // down how this app starts is owed the reason it did not, rather than a
    // directory listing reported as a success.
    if (configured === undefined && (await isStaticSite(workspace.path))) {
      return serveStaticallyAt(await freePort(), tried);
    }

    await rm(workspace.path, { recursive: true, force: true });
    throw new Error(
      `"${name}" could not be started. ${
        // Said first where it happened, because everything below it is a
        // consequence: a start script that runs build output cannot survive a
        // build that did not produce any, and reporting only its death sends
        // the reader looking for a start command that does not exist.
        buildFailure === undefined || build === undefined
          ? ""
          : `Its build (${build.label}) failed: ${buildFailure}. `
      }Tried ${
        tried.length === 1 ? "one command" : `${String(tried.length)} commands`
      }: ${tried.join("; ")}. If that is not how this app runs, name the ` +
        `command in "previewCommands" for "${repositoryId}" in ` +
        `.coordinator/config.json.`,
    );
  }

  /**
   * Runs one candidate, and waits long enough to see whether it survives.
   *
   * The whole of what makes a list of candidates work. A command that dies is
   * a candidate ruled out and answers with a sentence saying how; a command
   * still running answers with the preview, whether or not it is serving
   * anything yet.
   *
   * Exiting is a failure; being slow is not. A dev server that builds before
   * it serves can take minutes, and calling that broken would be worse than
   * the bug being fixed — so the wait ends the instant the child dies, and
   * otherwise gives up quietly and reports the preview as started. Which also
   * means a healthy slow candidate costs the timeout and a dead one costs how
   * long it took to die, so working down a list is cheap in the case that
   * matters: `node dist/index.js` in a checkout with no `dist` is over in
   * milliseconds.
   */
  private async attemptCommand(input: {
    repositoryId: string;
    command: PreviewCandidate;
    workspacePath: string;
    revision: string;
    /** The install's output, which leads whichever attempt succeeds. */
    leadingOutput: readonly string[];
    timeoutMs: number;
  }): Promise<{ entry: Running } | { failure: string }> {
    const { command } = input;
    const port = await freePort();
    const environment = await this.previewEnvironment(input.repositoryId, port);
    const child = spawn(command.executable, withPort(command.args, port), {
      // A monorepo's app is started in its own directory: there is no root
      // script that runs it, and every package manager walks up from here for
      // the binaries and the modules that were hoisted to the root.
      cwd: path.join(input.workspacePath, command.cwd ?? "."),
      // The command's own `env` is applied last, so a repository that needs
      // something specific always wins over what is inferred for it.
      env: { ...environment, ...command.env },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so `terminate` can take the whole tree.
      detached: process.platform !== "win32",
    });

    const status: PreviewStatus = {
      repositoryId: input.repositoryId,
      url: `http://127.0.0.1:${String(port)}`,
      port,
      revision: input.revision,
      label: command.label,
      ready: false,
      startedAt: new Date().toISOString(),
      // The install's output leads the log. When a server fails to come up the
      // reason is often in the install that preceded it, and separating the
      // two would mean the reader finds only the half that says nothing.
      recentOutput: [...input.leadingOutput],
    };
    const entry: Running = {
      child,
      status,
      workspacePath: input.workspacePath,
      lastAskedAt: Date.now(),
    };
    const record = (chunk: Buffer): void => {
      for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
        if (line.trim().length === 0) {
          continue;
        }
        status.recentOutput.push(line);
      }
      // Kept bounded rather than complete: this is for looking at why a server
      // did not come up, and a dev server that has been running all afternoon
      // would otherwise hold its whole scrollback in memory.
      if (status.recentOutput.length > LOG_LINES) {
        status.recentOutput.splice(0, status.recentOutput.length - LOG_LINES);
      }
    };
    child.stdout?.on("data", record);
    child.stderr?.on("data", record);
    child.on("exit", (code, signal) => {
      status.exited = { code, signal, at: new Date().toISOString() };
    });
    // A dev server that dies on startup must not take the control plane with
    // it. The exit is recorded above and read back through `status`.
    child.on("error", (error) => {
      status.recentOutput.push(`could not start: ${error.message}`);
      status.exited = { code: null, signal: null, at: new Date().toISOString() };
    });

    // Whether it actually came up. Without this the status was returned the
    // moment the child was spawned, so a command that dies on its first line
    // was reported as running: a success toast naming a URL, the control
    // flipped to "stop", and a link that answers nothing. The reason was
    // written to `recentOutput` and read by nobody.
    status.ready = await waitForPort(
      port,
      () => status.exited !== undefined,
      input.timeoutMs,
    );
    const exit = status.exited;
    if (exit === undefined) {
      return { entry };
    }
    // Whatever it started before it died goes with it, so the next candidate
    // is not competing with a half-built one for the same files.
    terminate(child);
    const said = status.recentOutput.slice(-4).join(" ").trim();
    return {
      failure:
        `exited immediately${
          exit.code === null ? "" : ` (code ${String(exit.code)})`
        }: ${said === "" ? "it printed nothing" : said}`,
    };
  }

  /**
   * Runs a task's own workspace, for the agent working in it.
   *
   * A different thing from the repository preview above, sharing only the
   * machinery. That one serves canonical for a person; this serves the
   * unlanded work of one task for the agent that wrote it — and the
   * distinction is not a nicety. An agent checking its own work against
   * canonical would be looking at the app *without* the change it just made,
   * so any screenshot it took would be confidently wrong.
   *
   * Keyed by task, dies with the task, and never touches the repository's
   * preview: no idle sweep is needed because a task ends, and no checkout is
   * made because the workspace is already there and already installed.
   *
   * Waits for the server to answer before returning. An agent cannot watch a
   * port come up the way a person can, so "started" on its own would be
   * useless to it — what it needs is the URL, or the reason there is not one.
   */
  public async startForTask(input: {
    taskId: string;
    repositoryId: string;
    workspacePath: string;
  }): Promise<{ url?: string; output: string[]; failed: boolean }> {
    await this.stopForTask(input.taskId);
    const configured =
      this.project.config.previewCommands?.[input.repositoryId] ??
      this.project.config.previewCommand;
    const candidates: PreviewCandidate[] =
      configured === undefined
        ? await detectPreviewCommands(input.workspacePath)
        : [configured];
    if (candidates.length === 0 && (await isStaticSite(input.workspacePath))) {
      const port = await freePort();
      const server = startStaticServer(input.workspacePath, port);
      this.taskPreviews.set(input.taskId, { server, port });
      return {
        url: `http://127.0.0.1:${String(port)}`,
        output: [`serving ${input.workspacePath} as static files`],
        failed: false,
      };
    }
    if (candidates.length === 0) {
      return {
        output: [await describeUndetectable(input.workspacePath)],
        failed: true,
      };
    }
    const output: string[] = [];
    const install =
      this.project.config.installCommands?.[input.repositoryId] ??
      this.project.config.installCommand ??
      (await detectInstallCommand(input.workspacePath));
    // The same environment the repository preview gets, and for the same
    // reason: an agent looking at its own work is running the app, not the
    // control plane, and must not be handed the control plane's project.
    if (install !== undefined) {
      const failure = await runToCompletion(
        install,
        input.workspacePath,
        output,
        await this.previewEnvironment(input.repositoryId, await freePort()),
      );
      if (failure !== undefined) {
        return { output, failed: true };
      }
    }

    // And the same build, for the same reason and in the same order. An
    // agent's workspace is a worktree of canonical plus its own edits, so it
    // is exactly as unbuilt as the play button's checkout — and an agent that
    // cannot start the app it just changed goes back to guessing at whether
    // the change works.
    const configuredBuild =
      this.project.config.buildCommands?.[input.repositoryId] ??
      this.project.config.buildCommand;
    const build =
      configuredBuild ?? (await detectBuildCommand(input.workspacePath));
    if (build !== undefined) {
      const failure = await runToCompletion(
        build,
        input.workspacePath,
        output,
        await this.previewEnvironment(input.repositoryId, await freePort()),
      );
      // Configured is an answer and detected is a guess, the same way the
      // play button treats them: the first stops the start, the second is
      // written down and the candidates are tried anyway.
      if (failure !== undefined) {
        output.push(`build failed (${build.label}): ${failure}`);
        if (configuredBuild !== undefined) {
          return { output, failed: true };
        }
      }
    }

    // The same walk down the list the play button does, so an agent and a
    // person previewing the same repository start the same thing.
    for (const candidate of candidates) {
      const port = await freePort();
      const environment = await this.previewEnvironment(
        input.repositoryId,
        port,
      );
      const child = spawn(candidate.executable, withPort(candidate.args, port), {
        cwd: path.join(input.workspacePath, candidate.cwd ?? "."),
        env: { ...environment, ...candidate.env },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so `terminate` can take the whole tree.
        detached: process.platform !== "win32",
      });
      let exited = false;
      const record = (chunk: Buffer): void => {
        for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
          if (line.trim().length > 0) {
            output.push(line);
          }
        }
        if (output.length > LOG_LINES) {
          output.splice(0, output.length - LOG_LINES);
        }
      };
      child.stdout?.on("data", record);
      child.stderr?.on("data", record);
      child.on("exit", () => {
        exited = true;
      });
      child.on("error", (error) => {
        exited = true;
        output.push(`could not start: ${error.message}`);
      });
      this.taskPreviews.set(input.taskId, { child, port });

      const ready = await waitForPort(port, () => exited);
      if (exited) {
        this.taskPreviews.delete(input.taskId);
        terminate(child);
        output.push(`${candidate.label} exited immediately`);
        continue;
      }
      // Slow is not failed. A server that has not answered yet but is still
      // running gets its URL and its output so far, and the agent decides for
      // itself whether to keep waiting — `ready` is reported so it can.
      void ready;
      return { url: `http://127.0.0.1:${String(port)}`, output, failed: false };
    }
    // Nothing ran, and there is a page. Last here too, for the same reason:
    // an app is never passed over in favour of serving its own source.
    if (configured === undefined && (await isStaticSite(input.workspacePath))) {
      const port = await freePort();
      const server = startStaticServer(input.workspacePath, port);
      this.taskPreviews.set(input.taskId, { server, port });
      output.push(`serving ${input.workspacePath} as static files`);
      return {
        url: `http://127.0.0.1:${String(port)}`,
        output,
        failed: false,
      };
    }
    return { output, failed: true };
  }

  /** Stops a task's preview. Called on request and again at teardown. */
  public async stopForTask(taskId: string): Promise<void> {
    const running = this.taskPreviews.get(taskId);
    if (running === undefined) {
      return;
    }
    this.taskPreviews.delete(taskId);
    terminate(running.child);
    try {
      running.server?.close();
    } catch {
      // Already gone.
    }
  }

  /** What this repository's preview is doing, if it has one. */
  public async status(repositoryId: string): Promise<PreviewStatus | undefined> {
    const entry = this.running.get(repositoryId);
    if (entry === undefined) {
      return undefined;
    }
    // Asking counts as watching, which is what keeps the idle sweep from
    // stopping a preview somebody has open.
    entry.lastAskedAt = Date.now();
    // And it is where a slow preview is noticed to have finished coming up.
    // Deliberately answered on demand rather than by a background loop: a loop
    // would have to keep a timer alive for as long as the preview might still
    // be building, which is indistinguishable from a process that will not
    // exit. One connect per poll costs nothing and nobody has to own it.
    if (!entry.status.ready && entry.status.exited === undefined) {
      entry.status.ready = await probePort(entry.status.port);
    }
    return { ...entry.status, recentOutput: [...entry.status.recentOutput] };
  }

  /** Stops the preview and removes its checkout. Safe to call when none runs. */
  public async stop(repositoryId: string): Promise<void> {
    const entry = this.running.get(repositoryId);
    if (entry === undefined) {
      return;
    }
    this.running.delete(repositoryId);
    if (entry.status.exited === undefined) {
      // A dev server usually spawns children of its own, and killing only the
      // parent leaves them holding the port. Best effort either way: this is
      // cleanup, and a failure here must not surface as the caller's error.
      terminate(entry.child);
      try {
        entry.server?.close();
      } catch {
        // Already gone.
      }
    }
    try {
      await rm(entry.workspacePath, { recursive: true, force: true });
    } catch {
      // A checkout left behind is worth less than the error it would raise.
    }
  }

  /** Stops everything. Called when the process serving these is going away. */
  public async close(): Promise<void> {
    clearInterval(this.sweeper);
    // A start still in flight would otherwise register its preview after
    // everything had been stopped, leaving a process nobody is holding.
    await Promise.allSettled([...this.previewsStarting.values()]);
    await Promise.allSettled([
      ...[...this.running.keys()].map((repositoryId) => this.stop(repositoryId)),
      ...[...this.taskPreviews.keys()].map((taskId) => this.stopForTask(taskId)),
    ]);
  }

  /**
   * The environment a previewed app runs in.
   *
   * Inherited, minus this control plane's own identity, plus the port it has
   * been given — spelled both the way most dev servers read it and the way
   * this codebase's own apps do, because a preview of a control plane is a
   * case worth supporting and it reads `COORD_PORT` first.
   *
   * `COORD_PROJECT_ROOT` is not merely cleared but *replaced*, with a project
   * of the preview's own. Clearing it alone would leave a previewed control
   * plane falling back to its working directory, which is the checkout — where
   * there is no project, so it exits telling somebody to run `coord init` in a
   * directory that is about to be deleted. The replacement is kept across
   * restarts on purpose: a preview you have to set up from scratch every time
   * you press play is one nobody presses twice.
   */
  private async previewEnvironment(
    repositoryId: string,
    port: number,
  ): Promise<NodeJS.ProcessEnv> {
    // A preview is somebody else's app: it gets the allow-listed child
    // environment — a PATH, a HOME, locale and proxy settings — and not this
    // process's own. Without that it inherited `COORD_DATABASE_URL`, so a
    // previewed app could connect to the coordination store directly.
    const environment: NodeJS.ProcessEnv = sanitizeChildEnv(process.env);
    for (const name of CONTROL_PLANE_VARIABLES) {
      delete environment[name];
    }
    const projectRoot = path.join(
      this.project.workspaceRoot,
      "preview-projects",
      repositoryId,
    );
    await mkdir(projectRoot, { recursive: true });
    // Idempotent, and never overwrites an existing config — so a preview keeps
    // whatever was set up in it last time.
    await CoordinatorProject.init(projectRoot);
    return {
      ...environment,
      PORT: String(port),
      HOST: "127.0.0.1",
      COORD_PORT: String(port),
      COORD_HOST: "127.0.0.1",
      COORD_PROJECT_ROOT: projectRoot,
    };
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const [repositoryId, entry] of [...this.running]) {
      if (now - entry.lastAskedAt > IDLE_TIMEOUT_MS) {
        await this.stop(repositoryId);
      }
    }
  }
}
