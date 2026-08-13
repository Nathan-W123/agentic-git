import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, rm } from "node:fs/promises";
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
  startedAt: string;
  /** Set once the process has exited, with however it went. */
  exited?: { code: number | null; signal: string | null; at: string };
  recentOutput: string[];
}

interface Running {
  child: ChildProcess;
  status: PreviewStatus;
  workspacePath: string;
  lastAskedAt: number;
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
    const command = this.project.config.previewCommand;
    if (command === undefined) {
      throw new Error(
        'No preview command is configured. Add "previewCommand" to ' +
          '.coordinator/config.json — for example {"executable":"npm",' +
          '"args":["run","dev"],"label":"dev server"}.',
      );
    }
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
      startedAt: new Date().toISOString(),
      recentOutput: [],
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
        entry.child.kill("SIGTERM");
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
    await Promise.allSettled(
      [...this.running.keys()].map((repositoryId) => this.stop(repositoryId)),
    );
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
