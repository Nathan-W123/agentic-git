import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { CoordinationStore } from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import { GitWorktreeWorkspaceManager } from "@coord/workspace-manager";

import type { CoordinatorProject } from "@coord/cli/project";

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

export interface PreviewStatus {
  repositoryId: string;
  /** Where to look. Always loopback; see the class doc. */
  url: string;
  port: number;
  /** Canonical revision the preview was started from. */
  revision: string;
  /** What is actually running, so the reader is not guessing. */
  label: string;
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
 * Works out how to start a repository nobody has configured.
 *
 * Deliberately narrow. Node is the one ecosystem with a real convention — a
 * `dev` or `start` script in package.json — and guessing beyond it does more
 * harm than good: Python, Go and Rust each have several plausible answers and
 * a wrong guess spawns something that fails in a way nobody can read.
 *
 * `undefined` means "say so", not "try something". A repository with no app in
 * it — a library, a CLI like taskman — has no localhost to boot, and telling
 * somebody that is more use than a process that exits with a usage message.
 */
async function detectPreviewCommand(
  workspacePath: string,
): Promise<{ executable: string; args: string[]; label: string } | undefined> {
  let manifest: { scripts?: Record<string, unknown> };
  try {
    manifest = JSON.parse(
      await readFile(path.join(workspacePath, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };
  } catch {
    return undefined;
  }
  const scripts = manifest.scripts ?? {};
  // `dev` first: where a repository has several, that is the one meant to be
  // watched. The rest are in the order they are usually meant — `start` is
  // often the production entry point, and the last two are what static-site
  // tooling tends to call it.
  const script = PREVIEW_SCRIPTS.find(
    (name) => typeof scripts[name] === "string",
  );
  return script === undefined
    ? undefined
    : {
        executable: process.platform === "win32" ? "npm.cmd" : "npm",
        args: ["run", script],
        label: `npm run ${script}`,
      };
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
async function describeUndetectable(workspacePath: string): Promise<string> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(workspacePath, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };
    const names = Object.keys(manifest.scripts ?? {});
    return names.length === 0
      ? "Its package.json has no scripts at all."
      : `Its package.json has no ${PREVIEW_SCRIPTS.join("/")} script — ` +
          `only ${names.slice(0, 8).join(", ")}.`;
  } catch {
    return "There is no package.json in it, so there is nothing to detect.";
  }
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
): Promise<{ executable: string; args: string[]; label: string } | undefined> {
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
  command: { executable: string; args: string[]; label: string },
  cwd: string,
  output: string[],
): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const child = spawn(command.executable, [...command.args], {
      cwd,
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
    const open = await new Promise<boolean>((resolve) => {
      const probe = connect({ port, host: "127.0.0.1" });
      const settle = (answer: boolean): void => {
        probe.destroy();
        resolve(answer);
      };
      probe.once("connect", () => settle(true));
      probe.once("error", () => settle(false));
      probe.setTimeout(1_000, () => settle(false));
    });
    if (open) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
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
        startedAt: new Date().toISOString(),
        recentOutput: [`serving ${workspace.path}`],
      };
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

    // Dependencies first. A checkout of canonical has none — they are ignored
    // by git, which is exactly why they are not in the revision — so a Node
    // app started here fails on its first import and looks like a broken
    // preview rather than an uninstalled one.
    const install =
      this.project.config.installCommands?.[input.repositoryId] ??
      this.project.config.installCommand ??
      (await detectInstallCommand(workspace.path));
    const installOutput: string[] = [];
    if (install !== undefined) {
      const failure = await runToCompletion(
        install,
        workspace.path,
        installOutput,
      );
      if (failure !== undefined) {
        await rm(workspace.path, { recursive: true, force: true });
        throw new Error(
          `Installing dependencies failed (${install.label}): ${failure}`,
        );
      }
    }

    const port = await freePort();
    const child = spawn(command.executable, [...command.args], {
      cwd: workspace.path,
      env: {
        ...process.env,
        // The two spellings between them cover almost every dev server; a
        // command that wants something else can name it in its own args.
        PORT: String(port),
        HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const status: PreviewStatus = {
      repositoryId: input.repositoryId,
      url: `http://127.0.0.1:${String(port)}`,
      port,
      revision: version.revision,
      label: command.label,
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
    if (install !== undefined) {
      const failure = await runToCompletion(
        install,
        input.workspacePath,
        output,
      );
      if (failure !== undefined) {
        return { output, failed: true };
      }
    }

    const port = await freePort();
    const child = spawn(command.executable, [...command.args], {
      cwd: input.workspacePath,
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
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
    try {
      running.child?.kill("SIGTERM");
      running.server?.close();
    } catch {
      // Already gone.
    }
  }

  /** What this repository's preview is doing, if it has one. */
  public status(repositoryId: string): PreviewStatus | undefined {
    const entry = this.running.get(repositoryId);
    if (entry === undefined) {
      return undefined;
    }
    // Asking counts as watching, which is what keeps the idle sweep from
    // stopping a preview somebody has open.
    entry.lastAskedAt = Date.now();
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
      try {
        entry.child?.kill("SIGTERM");
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

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const [repositoryId, entry] of [...this.running]) {
      if (now - entry.lastAskedAt > IDLE_TIMEOUT_MS) {
        await this.stop(repositoryId);
      }
    }
  }
}
