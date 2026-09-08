/**
 * A terminal, between a browser and the machine the reader is sitting at.
 *
 * Two halves of one conversation, neither of which can address the other.
 * The browser opens a session, types into it and reads from it; the worker
 * long-polls for what to do and posts back what the shell said. Everything
 * they share is held in {@link TerminalSessions}, in memory, because a
 * session is a live process on somebody's laptop and a row describing one
 * that has gone would be a lie with a primary key.
 *
 * Authorization is in three layers, because one is not enough for a shell:
 *
 * 1. `run_task` on the repository, the same grant that lets somebody
 *    dispatch an agent there — which is the closest existing thing to "may
 *    cause code to execute".
 * 2. The machine has to be the caller's own. A terminal is a shell with its
 *    owner's login, files and keys; nothing here lets one member open one on
 *    another member's laptop, whatever their role.
 * 3. The machine's owner has to have allowed it, on the machine, in local
 *    config the control plane cannot write — see `terminalAllowed` in
 *    `apps/cli/src/project.ts`. The worker enforces that one; the control
 *    plane cannot, and saying so here is the point.
 */

import {
  HttpError,
  objectBody,
  stringField,
} from "../field-validation.js";
import { authorizeRepository } from "../authorization.js";
import { matchPath } from "../gateway-util.js";
import { API_PREFIX } from "../http-util.js";
import { WORKER_POLL_MS } from "../terminal-sessions.js";
import type { TerminalCapability } from "../terminal-sessions.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

/** Bounds a terminal's shape, so a resize cannot ask for something absurd. */
function dimension(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= max
    ? value
    : fallback;
}

export async function routeTerminal(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { request, response, url, method, path, principal } = req;

  // ---- the worker's half ------------------------------------------------
  const workerMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/workers/([^/]+)/terminal(?:/([^/]+)/(output|exit))?$`,
      "u",
    ),
  );
  if (workerMatch !== undefined) {
    const [workerId = "", sessionId, verb] = workerMatch;
    if (method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }
    const worker = await gw.options.store.getWorker(workerId);
    if (worker === undefined || worker.userId !== principal.user.id) {
      // Not "forbidden": a worker id is not a secret and telling a caller
      // that one exists but is not theirs is a membership oracle.
      throw new HttpError(404, "not_found", "Worker was not found");
    }

    if (verb === "output") {
      const body = objectBody(await gw.readJson(request));
      const data = typeof body["data"] === "string" ? body["data"] : "";
      gw.terminals.append(sessionId ?? "", workerId, data);
      gw.sendJson(response, 200, { ok: true });
      return true;
    }
    if (verb === "exit") {
      const body = objectBody(await gw.readJson(request));
      const code = typeof body["exitCode"] === "number" ? body["exitCode"] : 0;
      gw.terminals.finish(sessionId ?? "", workerId, code);
      gw.sendJson(response, 200, { ok: true });
      return true;
    }

    // The poll. What the machine can do travels with it, so the browser's
    // menu is always what this machine has right now rather than what it had
    // when it registered — a shell installed since should simply appear.
    const body = objectBody(await gw.readJson(request));
    const capability = body["capability"];
    if (typeof capability === "object" && capability !== null) {
      const shape = capability as Partial<TerminalCapability>;
      const backend = shape.backend;
      if (
        (backend === "python" || backend === "script" || backend === "pipes") &&
        Array.isArray(shape.shells)
      ) {
        gw.terminals.describeWorker(workerId, {
          backend,
          shells: shape.shells
            .filter(
              (shell): shell is { id: string; label: string } =>
                typeof shell === "object" &&
                shell !== null &&
                typeof (shell as { id?: unknown }).id === "string" &&
                typeof (shell as { label?: unknown }).label === "string",
            )
            .slice(0, 12),
        });
      }
    }

    // How long to hold this open. A worker that has just started wants to
    // advertise what it can do and see the current state at once, rather than
    // waiting out a poll it began before it had anything to say — so the
    // caller names the wait and the server bounds it.
    const asked = body["waitMs"];
    const waitMs =
      typeof asked === "number" && Number.isFinite(asked)
        ? Math.min(Math.max(asked, 0), WORKER_POLL_MS)
        : WORKER_POLL_MS;
    let work = gw.terminals.collect(workerId);
    if (waitMs > 0 && !gw.terminals.hasWork(work)) {
      // Held open rather than answered empty: a poll that returned at once
      // would be a busy loop on somebody's laptop, and one that never
      // returned would look like a hang. Anything arriving for this worker
      // wakes it early.
      await gw.terminals.waitForWork(workerId, waitMs);
      work = gw.terminals.collect(workerId);
    }
    gw.sendJson(response, 200, work);
    return true;
  }

  // ---- the browser's half -----------------------------------------------
  const match = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/terminal` +
        `(?:/(machines|[^/]+))?(?:/(input|resize))?$`,
      "u",
    ),
  );
  if (match === undefined) {
    return false;
  }
  const [projectId = "", repositoryId = "", target, verb] = match;

  // The grant that lets somebody dispatch an agent here. A terminal is the
  // same power held directly, so it is not a weaker check.
  await authorizeRepository(
    gw.options.store,
    principal,
    projectId,
    repositoryId,
    "run_task",
  );
  if (!(await gw.options.store.projectHasRepository(projectId, repositoryId))) {
    throw new HttpError(404, "not_found", "Repository was not found");
  }

  // Which machines could offer one. Only this person's own: a terminal runs
  // with its owner's login and files, and nothing here lets one member open a
  // shell on another's laptop whatever their role in the project.
  if (target === "machines" && method === "GET") {
    const workers = await gw.options.store.listWorkers({
      seenAfter: new Date(Date.now() - 90_000).toISOString(),
    });
    const mine = workers.filter(
      (worker) => worker.userId === principal.user.id,
    );
    gw.sendJson(response, 200, {
      machines: mine.map((worker) => {
        const capability = gw.terminals.capabilityOf(worker.id);
        return {
          id: worker.id,
          name: worker.name,
          // Absent means the machine has not offered one — either an older
          // desktop build, or its owner has not allowed it. Said as absence
          // rather than as an empty list, because those are different facts.
          ...(capability === undefined ? {} : { terminal: capability }),
        };
      }),
    });
    return true;
  }

  if (target === undefined) {
    if (method === "GET") {
      gw.sendJson(response, 200, {
        sessions: gw.terminals.listFor(principal.user.id, repositoryId),
      });
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const workerId =
        stringField(body["workerId"], "workerId", { max: 200 }) ?? "";
      const shell = stringField(body["shell"], "shell", { max: 60 }) ?? "";
      const worker = await gw.options.store.getWorker(workerId);
      if (worker === undefined || worker.userId !== principal.user.id) {
        throw new HttpError(
          404,
          "not_found",
          "That machine is not one of yours, or is no longer connected.",
        );
      }
      const capability = gw.terminals.capabilityOf(workerId);
      if (capability === undefined) {
        throw new HttpError(
          409,
          "terminal_unavailable",
          `${worker.name} has not offered a terminal. Open the desktop app ` +
            "on that machine and allow terminals for this repository.",
        );
      }
      if (!capability.shells.some((candidate) => candidate.id === shell)) {
        throw new HttpError(
          400,
          "unknown_shell",
          `${worker.name} does not have ${shell === "" ? "that shell" : shell}.`,
        );
      }
      // The room decides the branch, and so the checkout the shell starts in
      // — resolved through `authorizeSubChannel` for the same reason the
      // workspace and the preview are: that is where "may this person see
      // this room" is decided.
      const channelId = url.searchParams.get("channelId") ?? undefined;
      const channel =
        channelId === undefined || channelId === ""
          ? undefined
          : await gw.authorizeSubChannel({
              projectId,
              repositoryId,
              channelId,
              principal,
            });
      const branch =
        channel?.branch !== undefined && channel.mergedAt === undefined
          ? channel.branch
          : undefined;
      const session = gw.terminals.open({
        userId: principal.user.id,
        projectId,
        repositoryId,
        ...(branch === undefined ? {} : { branch }),
        workerId,
        workerName: worker.name,
        shell,
        cols: dimension(body["cols"], 80, 500),
        rows: dimension(body["rows"], 24, 200),
      });
      await gw.options.store.appendAudit(undefined, {
        type: "workspace_command_executed",
        data: {
          projectId,
          repositoryId,
          actorId: principal.user.id,
          command: `terminal opened on ${worker.name} (${shell})`,
          workerId,
          ...(branch === undefined ? {} : { branch }),
        },
      });
      gw.sendJson(response, 201, { session });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "Unsupported method");
  }

  const session = gw.terminals.own(target, principal.user.id);
  if (session === undefined) {
    throw new HttpError(404, "not_found", "That terminal is no longer open");
  }

  if (verb === "input" && method === "POST") {
    const body = objectBody(await gw.readJson(request));
    const data = typeof body["data"] === "string" ? body["data"] : "";
    if (!gw.terminals.type(session, data)) {
      throw new HttpError(
        429,
        "terminal_backed_up",
        "That machine has stopped reading. It may have gone to sleep.",
      );
    }
    gw.sendJson(response, 200, { ok: true });
    return true;
  }

  if (verb === "resize" && method === "POST") {
    const body = objectBody(await gw.readJson(request));
    gw.terminals.resize(
      session,
      dimension(body["cols"], session.cols, 500),
      dimension(body["rows"], session.rows, 200),
    );
    gw.sendJson(response, 200, { ok: true });
    return true;
  }

  if (verb === undefined && method === "GET") {
    const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
    const read = gw.terminals.read(session, Number.isFinite(after) ? after : 0);
    gw.sendJson(response, 200, {
      ...read,
      shell: session.shell,
      backend: session.backend,
      ...(session.branch === undefined ? {} : { branch: session.branch }),
      ...(session.exitCode === undefined
        ? {}
        : { exitCode: session.exitCode }),
      ...(session.ended === undefined ? {} : { ended: session.ended }),
    });
    return true;
  }

  if (verb === undefined && method === "DELETE") {
    gw.terminals.close(session);
    gw.sendJson(response, 200, { closed: true });
    return true;
  }

  throw new HttpError(405, "method_not_allowed", "Unsupported method");
}
