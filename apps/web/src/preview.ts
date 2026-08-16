import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { CoordinationStore } from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
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
 * Works out how to start a repository nobody has configured.
 *
 * Every rung wants a *named file* that says what the project is — a
 * `manage.py`, a `Cargo.toml`, a `web:` line in a Procfile — rather than a
 * guess from the shape of the tree. That is the difference between this and
 * guessing: a wrong answer here spawns something that fails in a way nobody
 * can read, so a rung that cannot point at its evidence does not exist.
 *
 * `undefined` still means "say so". A repository with no app in it — a
 * library, a CLI — has no localhost to boot, and {@link describeUndetectable}
 * tells the reader what was looked for.
 *
 * Ordered by how explicit the evidence is, not by popularity. A Procfile is
 * the project stating its own start command and wins over anything inferred
 * from a manifest.
 */
export async function detectPreviewCommand(
  workspacePath: string,
): Promise<PreviewCommand | undefined> {
  // 1. The project saying it outright. A Procfile's `web:` line is a start
  //    command by definition, in every language that uses one.
  const procfile = await textOf(workspacePath, "Procfile");
  const web = /^web:\s*(.+)$/mu.exec(procfile ?? "")?.[1]?.trim();
  if (web !== undefined && web.length > 0) {
    return {
      // Through a shell because a Procfile line is a shell line — it may
      // carry `&&`, quotes or a `$PORT` of its own, and splitting it on
      // spaces would mangle all three.
      executable: "sh",
      args: ["-c", web],
      label: `Procfile: ${web}`,
    };
  }

  // 2. Node, and the package manager the repository actually pinned. Running
  //    `npm` in a pnpm workspace fails on the lockfile, so the lockfile picks.
  const manifest = await textOf(workspacePath, "package.json");
  if (manifest !== undefined) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts =
        ((JSON.parse(manifest) as { scripts?: Record<string, unknown> })
          .scripts ?? {});
    } catch {
      scripts = {};
    }
    // `dev` first: where a repository has several, that is the one meant to
    // be watched. `start` is often the production entry point, and the last
    // two are what static-site tooling tends to call it.
    const script = PREVIEW_SCRIPTS.find(
      (name) => typeof scripts[name] === "string",
    );
    if (script !== undefined) {
      const [executable, run] = await nodeRunner(workspacePath);
      return {
        executable: executable ?? "npm",
        args: [run ?? "run", script],
        label: `${executable ?? "npm"} ${run ?? "run"} ${script}`,
      };
    }
  }

  // 3. Python, where the framework names itself in a file.
  if ((await anyOf(workspacePath, "manage.py")) !== undefined) {
    // Django's runserver takes the address as an argument rather than PORT.
    return {
      executable: "python3",
      args: ["manage.py", "runserver", "0.0.0.0:${PORT}"],
      label: "python3 manage.py runserver",
    };
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
    return {
      executable: "uvicorn",
      args: [`${module}:app`, "--host", "0.0.0.0", "--port", "${PORT}"],
      label: `uvicorn ${module}:app`,
    };
  }
  if (/\bflask\b/iu.test(pythonDeps) && appModule !== undefined) {
    return {
      executable: "python3",
      args: ["-m", "flask", "--app", appModule, "run", "--host", "0.0.0.0", "--port", "${PORT}"],
      label: `flask run --app ${appModule}`,
    };
  }

  // 4. Compiled languages, where the manifest is the evidence and the
  //    toolchain resolves its own dependencies on the way.
  if ((await anyOf(workspacePath, "go.mod")) !== undefined) {
    return { executable: "go", args: ["run", "."], label: "go run ." };
  }
  if ((await anyOf(workspacePath, "Cargo.toml")) !== undefined) {
    return { executable: "cargo", args: ["run"], label: "cargo run" };
  }

  // 5. Ruby. `bin/rails` before `config.ru`: a Rails app has both, and its
  //    own binstub is the one that loads the framework.
  if ((await anyOf(workspacePath, "bin/rails")) !== undefined) {
    return {
      executable: "bin/rails",
      args: ["server", "-b", "0.0.0.0", "-p", "${PORT}"],
      label: "bin/rails server",
    };
  }
  if ((await anyOf(workspacePath, "config.ru")) !== undefined) {
    return {
      executable: "bundle",
      args: ["exec", "rackup", "--host", "0.0.0.0", "--port", "${PORT}"],
      label: "rackup",
    };
  }

  // 6. PHP's own server, which needs no framework and no install.
  const phpRoot = await anyOf(workspacePath, "public/index.php", "index.php");
  if (phpRoot !== undefined) {
    const docroot = phpRoot.startsWith("public/") ? "public" : ".";
    return {
      executable: "php",
      args: ["-S", "0.0.0.0:${PORT}", "-t", docroot],
      label: `php -S -t ${docroot}`,
    };
  }
  return undefined;
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
    let names: string[] = [];
    try {
      names = Object.keys(
        (JSON.parse(manifest) as { scripts?: Record<string, unknown> })
          .scripts ?? {},
      );
    } catch {
      return "Its package.json could not be parsed, so no script could be read.";
    }
    return names.length === 0
      ? "Its package.json has no scripts at all."
      : `Its package.json has no ${PREVIEW_SCRIPTS.join("/")} script — ` +
          `only ${names.slice(0, 8).join(", ")}.`;
  }
  // Named individually rather than as "nothing matched": the reader can add
  // whichever one their project should have had, or set the command outright.
  return (
    "Nothing in it names a way to start: no Procfile web: line, no " +
    "package.json, no manage.py or FastAPI/Flask entry point, no go.mod, " +
    "no Cargo.toml, no config.ru or bin/rails, no index.php, and no " +
    "index.html to serve as a static site."
  );
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
   */
  public async start(input: {
    repositoryId: string;
  }): Promise<PreviewStatus> {
    const stored = await this.store.getRepository(input.repositoryId);
    if (stored === undefined) {
      throw new Error(`Unknown repository: ${input.repositoryId}`);
    }
    await this.stop(input.repositoryId);

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
      taskId: `preview-${input.repositoryId}`,
      rootPath: root,
      repository: canonical,
      baseVersion: version,
    });

    // Resolved after the checkout exists, because detection reads the
    // repository's own files. A repository nobody has configured and nothing
    // can be detected for is told so plainly rather than being handed a
    // command that exits immediately.
    const command =
      this.project.config.previewCommands?.[input.repositoryId] ??
      this.project.config.previewCommand ??
      (await detectPreviewCommand(workspace.path));
    // A page with nothing that builds it needs no command at all, and this
    // process can serve it without assuming a runtime the machine may not
    // have.
    if (command === undefined && (await isStaticSite(workspace.path))) {
      const port = await freePort();
      const server = startStaticServer(workspace.path, port);
      const status: PreviewStatus = {
        repositoryId: input.repositoryId,
        url: `http://127.0.0.1:${String(port)}`,
        port,
        revision: version.revision,
        label: "static files",
        // Served in this process: there is no gap between running and ready.
        ready: true,
        startedAt: new Date().toISOString(),
        recentOutput: [`serving ${workspace.path}`],
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
      this.running.set(input.repositoryId, {
        server,
        status,
        workspacePath: workspace.path,
        lastAskedAt: Date.now(),
      });
      return { ...status, recentOutput: [...status.recentOutput] };
    }
    if (command === undefined) {
      const why = await describeUndetectable(workspace.path);
      await rm(workspace.path, { recursive: true, force: true });
      throw new Error(
        `Nothing in "${input.repositoryId}" could be started. ${why} ` +
          `Add a "previewCommands" entry for "${input.repositoryId}" in ` +
          `.coordinator/config.json — for example ` +
          `{"executable":"npm","args":["run","dev"],"label":"dev server"}.`,
      );
    }

    const port = await freePort();

    // Dependencies first. A checkout of canonical has none — they are ignored
    // by git, which is exactly why they are not in the revision — so a Node
    // app started here fails on its first import and looks like a broken
    // preview rather than an uninstalled one.
    const install =
      this.project.config.installCommands?.[input.repositoryId] ??
      this.project.config.installCommand ??
      (await detectInstallCommand(workspace.path));
    // Resolved before the install, because an install can need configuration
    // just as much as the server can — a private registry token is the usual
    // one — and because it is what creates the preview's own project.
    const environment = await this.previewEnvironment(input.repositoryId, port);
    const installOutput: string[] = [];
    if (install !== undefined) {
      const failure = await runToCompletion(
        install,
        workspace.path,
        installOutput,
        environment,
      );
      if (failure !== undefined) {
        await rm(workspace.path, { recursive: true, force: true });
        throw new Error(
          `Installing dependencies failed (${install.label}): ${failure}`,
        );
      }
    }

    const child = spawn(command.executable, withPort(command.args, port), {
      cwd: workspace.path,
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
      revision: version.revision,
      label: command.label,
      ready: false,
      startedAt: new Date().toISOString(),
      // The install's output leads the log. When a server fails to come up the
      // reason is often in the install that preceded it, and separating the
      // two would mean the reader finds only the half that says nothing.
      recentOutput: [...installOutput],
    };
    const entry: Running = {
      child,
      status,
      workspacePath: workspace.path,
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

    this.running.set(input.repositoryId, entry);

    // Whether it actually came up. Without this the status was returned the
    // moment the child was spawned, so a command that dies on its first line
    // was reported as running: a success toast naming a URL, the control
    // flipped to "stop", and a link that answers nothing. The reason was
    // written to `recentOutput` and read by nobody.
    //
    // The commonest way to reach that is not an exotic failure. Detection
    // prefers a `dev` script and falls back to `start`, and a `start` script
    // very often points at a build output — which a fresh checkout of canonical
    // does not contain, because build outputs are what `.gitignore` is for.
    // `node dist/index.js` then exits in milliseconds with a module it cannot
    // find.
    //
    // Exiting is a failure; being slow is not. A dev server that builds before
    // it serves can take minutes, and calling that broken would be worse than
    // the bug being fixed — so the wait ends the instant the child dies, and
    // otherwise gives up quietly and reports the preview as started. This is
    // the same reading `startForTask` has always taken.
    // Longer than the agent path below, because the waits are different
    // things. This one is a person who pressed play, and a repository whose
    // dev server builds before it listens — a turbo or vite pipeline from a
    // cold cache — routinely needs more than twenty seconds to reach a port.
    // Timing out here does not stop it; the status simply reads "starting"
    // when it is in fact starting. The agent path stays short because it is
    // holding a workspace and its leases while it waits.
    status.ready = await waitForPort(
      port,
      () => status.exited !== undefined,
      START_READY_TIMEOUT_MS,
    );
    const exit = status.exited;
    if (exit !== undefined) {
      const said = status.recentOutput.slice(-4).join(" ").trim();
      await this.stop(input.repositoryId);
      throw new Error(
        `"${input.repositoryId}" could not be started: ${command.label} ` +
          `exited immediately${
            exit.code === null ? "" : ` (code ${String(exit.code)})`
          }. ${said === "" ? "It printed nothing." : said} ` +
          `If that is not how this app runs, name the command in ` +
          `"previewCommands" for "${input.repositoryId}" in ` +
          `.coordinator/config.json.`,
      );
    }
    return { ...status, recentOutput: [...status.recentOutput] };
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
    const command =
      this.project.config.previewCommands?.[input.repositoryId] ??
      this.project.config.previewCommand ??
      (await detectPreviewCommand(input.workspacePath));
    if (command === undefined && (await isStaticSite(input.workspacePath))) {
      const port = await freePort();
      const server = startStaticServer(input.workspacePath, port);
      this.taskPreviews.set(input.taskId, { server, port });
      return {
        url: `http://127.0.0.1:${String(port)}`,
        output: [`serving ${input.workspacePath} as static files`],
        failed: false,
      };
    }
    if (command === undefined) {
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
    const port = await freePort();
    // The same environment the repository preview gets, and for the same
    // reason: an agent looking at its own work is running the app, not the
    // control plane, and must not be handed the control plane's project.
    const environment = await this.previewEnvironment(input.repositoryId, port);
    if (install !== undefined) {
      const failure = await runToCompletion(
        install,
        input.workspacePath,
        output,
        environment,
      );
      if (failure !== undefined) {
        return { output, failed: true };
      }
    }

    const child = spawn(command.executable, [...command.args], {
      cwd: input.workspacePath,
      env: { ...environment, ...command.env },
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

    const url = `http://127.0.0.1:${String(port)}`;
    const ready = await waitForPort(port, () => exited);
    if (exited) {
      this.taskPreviews.delete(input.taskId);
      return { output, failed: true };
    }
    // Slow is not failed. A server that has not answered yet but is still
    // running gets its URL and its output so far, and the agent decides for
    // itself whether to keep waiting — `ready` is reported so it can.
    void ready;
    return { url, output, failed: false };
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
    const environment: NodeJS.ProcessEnv = { ...process.env };
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
