/**
 * This machine's half of a terminal, on a long poll.
 *
 * The worker talks HTTP request/response and nothing else — there is no
 * socket back from the control plane — so a session is carried by asking
 * repeatedly: what should I open, what did somebody type, what shape is the
 * pane now, what should I close. The control plane holds each poll open until
 * there is an answer, so this is one request in flight rather than a loop
 * hammering somebody's laptop.
 *
 * **Consent is enforced here and nowhere else.** The control plane can decide
 * who is *allowed to ask*; only the machine can decide whether to answer. A
 * terminal is a shell with this account's login, files, network and keys, and
 * a project admin cannot grant that on somebody else's behalf. So a machine
 * whose owner has not allowed terminals never advertises one — the browser
 * sees a machine with no terminal offered, which is a different fact from a
 * machine that is offline, and is said differently.
 */

import {
  terminalAllowed,
  type CoordinatorProject,
  type ProjectConfig,
} from "@coord/cli/project";

import {
  detectBackend,
  detectShells,
  openTerminal,
  type TerminalHandle,
} from "./pty.js";

/** What the control plane hands back from a poll. */
interface TerminalWork {
  open: {
    id: string;
    repositoryId: string;
    branch?: string;
    shell: string;
    cols: number;
    rows: number;
  }[];
  input: { id: string; data: string }[];
  resize: { id: string; cols: number; rows: number }[];
  close: string[];
}

export interface TerminalLoopOptions {
  workerId: string;
  project: CoordinatorProject;
  /**
   * Where a session should start.
   *
   * Not the branch's checkout, and deliberately not pretending to be. The
   * worker's own copy of a repository is a *bare* cache, and fetching a
   * branch outside a lease would mean new protocol — the bundle endpoint is
   * lease-scoped, because that is what authorizes the fetch. So the machine
   * owner says where their terminals open, in the same local config that
   * allows them at all, and the session says on its first line where it
   * landed rather than leaving somebody to work it out from `pwd`.
   */
  workspaceFor(input: {
    repositoryId: string;
    branch?: string;
  }): Promise<string | undefined>;
  /** The three protocol calls a terminal needs, and nothing wider. */
  client: {
    terminalPoll(workerId: string, capability: unknown): Promise<unknown>;
    terminalOutput(
      workerId: string,
      sessionId: string,
      data: string,
    ): Promise<void>;
    terminalExit(
      workerId: string,
      sessionId: string,
      exitCode: number,
    ): Promise<void>;
  };
  /**
   * The consent as it stands on disk, re-read rather than remembered.
   *
   * Two comments in this file used to claim the config was live — that a
   * withdrawal took effect on the next poll, and that opening checked the
   * config rather than the advertisement. Neither was true: `project.config`
   * is the snapshot the worker loaded at start, so a machine that turned
   * terminals off went on offering them until it was restarted. That is the
   * wrong direction for a consent to lag in.
   *
   * Optional, because a caller with no way to re-read (a test, an embedder)
   * is better off with the snapshot than with nothing.
   */
  reloadConfig?(): Promise<ProjectConfig | undefined>;
  log(message: string): void;
}

/**
 * How long to wait after a failed poll before asking again.
 *
 * A control plane that is down, restarting or unreachable should not be asked
 * ten times a second from every desktop that has ever been opened.
 */
const RETRY_MS = 5_000;

export class TerminalLoop {
  private readonly sessions = new Map<string, TerminalHandle>();
  private running = false;
  /** The last config read from disk; the start-up snapshot until one is. */
  private current: ProjectConfig;

  public constructor(private readonly options: TerminalLoopOptions) {
    this.current = options.project.config;
  }

  /**
   * Re-reads the consent, and says nothing when it cannot.
   *
   * A config that has gone missing or stopped parsing leaves the last good
   * answer in place rather than becoming a refusal. Both are defensible; this
   * one is chosen because the alternative makes an editor saving a broken
   * JSON file for half a second look like the owner revoking their consent.
   * A revocation is a deliberate act, and it writes a file that parses.
   */
  private async refresh(): Promise<void> {
    const config = await this.options.reloadConfig?.().catch(() => undefined);
    if (config !== undefined) {
      this.current = config;
    }
  }

  /**
   * What this machine can offer, recomputed each poll.
   *
   * Each poll rather than once at start, so a shell installed since the
   * desktop app was opened simply appears, and consent withdrawn in config
   * takes effect on the next poll rather than at the next restart.
   */
  private capability(): { backend: string; shells: { id: string; label: string }[] } | undefined {
    const config = this.current;
    // Absent consent is a refusal. A machine that has never been asked
    // advertises nothing, so the browser offers no terminal against it rather
    // than offering one that will fail.
    const anyAllowed =
      config.terminal?.allow === "all" ||
      (Array.isArray(config.terminal?.allow) && config.terminal.allow.length > 0);
    if (!anyAllowed) {
      return undefined;
    }
    return {
      backend: detectBackend(),
      shells: detectShells().map((shell) => ({
        id: shell.id,
        label: shell.label,
      })),
    };
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.loop();
  }

  public async stop(): Promise<void> {
    this.running = false;
    for (const handle of this.sessions.values()) {
      handle.close();
    }
    this.sessions.clear();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.refresh();
        const work = (await this.options.client.terminalPoll(
          this.options.workerId,
          this.capability(),
        )) as TerminalWork | undefined;
        if (work !== undefined) {
          await this.apply(work);
        }
      } catch (error) {
        // Logged once and slept on. A machine that cannot reach the control
        // plane is the ordinary state of a laptop that has been closed, and
        // it is not worth a line a second.
        this.options.log(
          `terminal poll failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  private async apply(work: TerminalWork): Promise<void> {
    for (const request of work.open ?? []) {
      await this.openSession(request);
    }
    for (const typed of work.input ?? []) {
      this.sessions.get(typed.id)?.write(typed.data);
    }
    for (const shape of work.resize ?? []) {
      this.sessions.get(shape.id)?.resize(shape.cols, shape.rows);
    }
    for (const id of work.close ?? []) {
      this.sessions.get(id)?.close();
      this.sessions.delete(id);
    }
  }

  private async openSession(request: TerminalWork["open"][number]): Promise<void> {
    const say = async (text: string): Promise<void> => {
      await this.options.client
        .terminalOutput(this.options.workerId, request.id, text)
        .catch(() => undefined);
    };
    const end = async (code: number): Promise<void> => {
      this.sessions.delete(request.id);
      await this.options.client
        .terminalExit(this.options.workerId, request.id, code)
        .catch(() => undefined);
    };

    // Consent, per repository, checked at the moment of opening rather than
    // trusted from the advertisement — the two are seconds apart and the
    // config can change between them.
    // Re-read here as well as before the poll: the advertisement is up to a
    // poll old by the time somebody presses it, and a withdrawal made in that
    // window should refuse this open rather than the next one.
    await this.refresh();
    if (!terminalAllowed(this.current, request.repositoryId)) {
      await say(
        `This machine has not been allowed to open a terminal for ` +
          `${request.repositoryId}. Turn it on in the desktop app on this ` +
          `computer — Agents → Allow Terminals on This Machine.\r\n`,
      );
      await end(126);
      return;
    }

    const shell = detectShells().find(
      (candidate) => candidate.id === request.shell,
    );
    if (shell === undefined) {
      await say(`This machine has no ${request.shell}.\r\n`);
      await end(127);
      return;
    }

    const cwd =
      (await this.options
        .workspaceFor({
          repositoryId: request.repositoryId,
          ...(request.branch === undefined ? {} : { branch: request.branch }),
        })
        .catch(() => undefined)) ?? this.options.project.directory;

    let handle: TerminalHandle;
    try {
      handle = openTerminal({ shell, cwd, cols: request.cols, rows: request.rows });
    } catch (error) {
      await say(
        `Could not start ${shell.label}: ${
          error instanceof Error ? error.message : String(error)
        }\r\n`,
      );
      await end(1);
      return;
    }
    this.sessions.set(request.id, handle);

    // Said once, at the top, because the alternative is somebody running
    // `npm test` in the wrong directory and reading the failure as their
    // code's. Names the machine's own answer rather than implying this is a
    // checkout of the branch, which it is not.
    await say(
      `\u001b[2m${shell.label} on this machine, in ${cwd}` +
        `${
          request.branch === undefined
            ? ""
            : ` — #${request.branch.replace(/^kumi\//u, "")} is checked out ` +
              `on the control plane, not here`
        }\u001b[0m\r\n`,
    );

    // Posted as it arrives rather than batched on a timer: a terminal that
    // answered in bursts would feel broken even though every byte arrived.
    handle.onData((chunk) => {
      void say(chunk);
    });
    handle.onExit((code) => {
      void end(code);
    });
    this.options.log(
      `terminal ${request.id} opened: ${shell.label} in ${cwd} (${handle.backend})`,
    );
  }
}
