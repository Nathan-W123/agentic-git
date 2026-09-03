/**
 * The remote-worker protocol.
 *
 * Registering a machine, leasing work, heartbeating, reporting, and the
 * ticket a browser opens its event socket with. This is the surface a
 * desktop app talks to, so its shape is a compatibility promise.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import {
  randomBytes,
} from "node:crypto";
import {
  projectBudgets,
} from "@coord/shared-types";
import {
  AuthenticationError,
} from "../auth.js";
import {
  assertTokenScope,
  authorizeOrganizationOrGrant,
  authorizeProject,
} from "../authorization.js";
import {
  HttpError,
  objectBody,
  stringField,
} from "../field-validation.js";
import {
  matchPath,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import {
  APP_TOKEN_SCOPES,
  isLoopbackCallback,
} from "../server.js";
import {
  APP_AUTHORIZATION_TTL_MS,
  SOCKET_TICKET_TTL_MS,
  WORK_LEASE_TTL_MS,
} from "../gateway-util.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

export async function routeWorkers(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  // ---- Remote worker protocol -------------------------------------------
  // Everything that pulls work or returns changesets requires the run_task
  // scope, so a leaked read-only token cannot execute. The two fleet reads
  // are deliberately not in that set: seeing the organization's workers is a
  // `view`, and holding it to `run_task` would mean a reviewer could not see
  // the machines running the work they review.
  if (path === `${API_PREFIX}/workers/register` && method === "POST") {
    const body = objectBody(await gw.readJson(request));
    const organizationId =
      stringField(body["organizationId"], "organizationId", { max: 120 }) ??
      "";
    // The tenant is decided here, once, and every later read of this worker
    // is filtered by it. `authorizeOrganizationOrGrant` is what enforces it:
    // it rejects a token bound elsewhere before consulting the caller's
    // role, so a credential confined to one organization cannot enrol a
    // worker into another even if its owner is a member of both.
    //
    // Grants count, and they have to. Somebody invited to one repository
    // has no organization membership at all, so the membership-only check
    // this used to make refused them outright: install the app, sign in,
    // and be told "You do not have permission to perform this action" by
    // the first call the worker ever makes. Their machine never registered,
    // so it never appeared online, so their agent was unmentionable —
    // "nothing is running it yet" — with nothing anywhere saying why.
    //
    // Nothing is widened by admitting them: what the worker may then be
    // *handed* is decided per lease by `authorizeProject`, which narrows to
    // the repositories the grant actually covers.
    await authorizeOrganizationOrGrant(
      gw.options.store,
      principal,
      organizationId,
      "run_task",
    ).catch((error: unknown) => {
      // Said properly, because of where it is read. This is the first call
      // a worker ever makes and the only place its failure appears is a
      // log file on somebody's own machine, with no page around it to
      // explain anything. The generic "You do not have permission to
      // perform this action" sent two people hunting through networks,
      // reinstalls and vendor logins for a problem that was an unfinished
      // invitation.
      if (
        error instanceof AuthenticationError &&
        error.code === "forbidden"
      ) {
        throw new HttpError(
          403,
          "forbidden",
          "This account cannot run agents in that workspace. Ask an " +
            "administrator to invite you to it, or to a repository in it, " +
            "as a developer or above — view-only access cannot run work.",
        );
      }
      throw error;
    });
    const adapters = body["adapters"];
    if (
      !Array.isArray(adapters) ||
      !adapters.every((entry): entry is string => typeof entry === "string")
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        "adapters must be an array of strings",
      );
    }
    const worker = await gw.options.store.registerWorker({
      userId: principal.user.id,
      organizationId,
      name: stringField(body["name"], "name", { max: 120 }) ?? "",
      adapters,
      version: stringField(body["version"], "version", { max: 40 }) ?? "0",
    });
    gw.sendJson(response, 201, worker);
    return true;
  }

  if (path === `${API_PREFIX}/agents/running` && method === "GET") {
    // Organization-wide, not project-scoped: an active lease is one agent
    // executing on some worker right now, and a fleet spans the projects it
    // serves. Counted from leases rather than from worker registrations,
    // because a registered worker is idle until it holds one.
    //
    // The organization is required rather than defaulted. These are counts,
    // but a platform-wide count still reports how busy other tenants are,
    // which is not this caller's to know.
    const { organizationId, wholeFleet } = await gw.authorizeFleet(
      principal,
      url,
    );
    const { workers, active } = await gw.organizationFleet(
      organizationId,
      wholeFleet ? undefined : principal.user.id,
    );
    const byWorker = new Map<string, number>();
    for (const lease of active) {
      byWorker.set(lease.workerId, (byWorker.get(lease.workerId) ?? 0) + 1);
    }
    gw.sendJson(response, 200, {
      running: active.length,
      workers: workers.length,
      busyWorkers: byWorker.size,
    });
    return true;
  }

  if (path === `${API_PREFIX}/workers` && method === "GET") {
    // The whole fleet the organization operates, not just the caller's own
    // workers. A team cannot run shared infrastructure it cannot see, and
    // the tenant boundary — not the registering user — is what makes that
    // safe: `authorizeFleet` requires membership of the organization being
    // asked about, and the store filters on the same id.
    //
    // Except for somebody who reaches this organization only through a
    // repository grant. They are not on the team; they were handed one
    // repository. They still need to see their own machine — that is how
    // anybody knows whether their agent will answer — so they get exactly
    // that and no more.
    const { organizationId, wholeFleet } = await gw.authorizeFleet(
      principal,
      url,
    );
    const { workers, active } = await gw.organizationFleet(
      organizationId,
      wholeFleet ? undefined : principal.user.id,
    );
    const leasesByWorker = new Map<string, typeof active>();
    for (const lease of active) {
      const bucket = leasesByWorker.get(lease.workerId) ?? [];
      bucket.push(lease);
      leasesByWorker.set(lease.workerId, bucket);
    }
    gw.sendJson(response, 200, {
      workers: workers.map((worker) => ({
        ...worker,
        /** True for the caller's own workers, which only they may drive. */
        own: worker.userId === principal.user.id,
        activeLeases: (leasesByWorker.get(worker.id) ?? []).map((lease) => ({
          id: lease.id,
          taskId: lease.taskId,
          repositoryId: lease.repositoryId,
          projectId: lease.projectId,
          issuedAt: lease.issuedAt,
          expiresAt: lease.expiresAt,
        })),
      })),
    });
    return true;
  }

  if (path === `${API_PREFIX}/workers/leases` && method === "POST") {
    assertTokenScope(principal, "run_task");
    const body = objectBody(await gw.readJson(request));
    const workerId = stringField(body["workerId"], "workerId", { max: 120 }) ?? "";
    const worker = await gw.options.store.getWorker(workerId);
    if (worker === undefined || worker.userId !== principal.user.id) {
      throw new HttpError(404, "not_found", "Worker was not found");
    }
    const projectId =
      stringField(body["projectId"], "projectId", { max: 120 }) ?? "";
    // `repositories` is not decoration. A collaborator invited to one
    // repository has no organization role, reaches this project through
    // that grant alone, and `authorizeProject` folds every grant they hold
    // here into one role to answer "can they reach the project at all".
    // That answer must not become "and may therefore run anything in it":
    // the narrowing is passed down to the lease, which is the only place
    // that decides what a machine is handed.
    const { project, repositories } = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "run_task",
    );
    // Visibility widened to the organization; execution did not follow it
    // across one. A user who belongs to two organizations could otherwise
    // point a worker registered in one at work belonging to the other, and
    // the resulting workspace, bundle, and changeset would carry another
    // tenant's code on a machine that tenant never admitted to its fleet.
    if (worker.organizationId !== project.organizationId) {
      throw new HttpError(
        403,
        "worker_organization_mismatch",
        "This worker is registered to a different organization",
      );
    }

    const nowIso = new Date().toISOString();
    // Reclaim anything a dead worker was holding before handing out new
    // work — and say so. This route runs every five seconds per worker, so
    // it is the caller that almost always settles the row, and it used to
    // discard it.
    await gw.expireLeasesAndSay(nowIso);
    await gw.options.store.touchWorker(workerId, nowIso);

    const repositoryId = stringField(body["repositoryId"], "repositoryId", {
      max: 200,
      optional: true,
    });
    // Read rather than trusted: an unknown value must not widen what a
    // worker can be handed, and the store's own clause is written against
    // this exact pair. Absent stays absent so the store applies its own
    // default rather than this route inventing one.
    const requested = Array.isArray(body["kinds"]) ? body["kinds"] : undefined;
    const kinds = requested?.filter(
      (kind): kind is "task" | "question" =>
        kind === "task" || kind === "question",
    );
    // Read, not trusted, and absent stays absent: a worker built before
    // this was sent reports nothing, and the lease reads nothing as the
    // oldest version rather than the newest. Anything that is not a whole
    // positive number is treated the same way, so a malformed value can
    // only ever narrow what the worker is handed.
    const announced = body["protocolVersion"];
    const protocolVersion =
      typeof announced === "number" &&
      Number.isInteger(announced) &&
      announced >= 1
        ? announced
        : undefined;
    const leaseOperation = gw.options.operations.leaseWork;
    if (leaseOperation === undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment does not support remote workers",
      );
    }
    const assignment = await leaseOperation({
      workerId,
      projectId,
      actorId: principal.user.id,
      ...(repositoryId === undefined ? {} : { repositoryId }),
      ...(repositories === undefined ? {} : { repositories }),
      ...(kinds === undefined || kinds.length === 0 ? {} : { kinds }),
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
    });
    if (assignment === undefined) {
      // 204 rather than an empty 200 so a polling worker can branch on the
      // status code without parsing a body.
      response.writeHead(204).end();
      return true;
    }
    // Checked again on the way out, against the same two bounds the
    // request was authorized on. `leaseWork` is an operation a deployment
    // supplies, and an authorization that only holds because one
    // implementation remembered to apply it is not an authorization. The
    // repository half matters most: it is the only thing standing between a
    // grant on one repository and an agent run from the repository beside
    // it, on this person's laptop, with their vendor login.
    if (
      assignment.task.projectId !== projectId ||
      assignment.lease.projectId !== projectId
    ) {
      await gw.options.store.finishWorkLease(
        assignment.lease.id,
        "released",
        new Date().toISOString(),
        "control-plane project mismatch",
      );
      throw new HttpError(
        500,
        "invalid_assignment",
        "Worker assignment escaped its authorized project",
      );
    }
    if (
      repositories !== undefined &&
      !repositories.has(assignment.task.repositoryId)
    ) {
      await gw.options.store.finishWorkLease(
        assignment.lease.id,
        "released",
        new Date().toISOString(),
        "control-plane repository mismatch",
      );
      throw new HttpError(
        500,
        "invalid_assignment",
        "Worker assignment escaped its authorized repositories",
      );
    }
    gw.sendJson(response, 200, assignment);
    return true;
  }

  const leaseMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/workers/leases/([^/]+)/(heartbeat|bundle|claim|declaration|plan|scope|result|release|progress)$`,
      "u",
    ),
  );
  if (leaseMatch !== undefined) {
    assertTokenScope(principal, "run_task");
    const leaseId = leaseMatch[0] ?? "";
    const action = leaseMatch[1] ?? "";
    const lease = await gw.options.store.getWorkLease(leaseId);
    if (lease === undefined) {
      throw new HttpError(404, "not_found", "Lease was not found");
    }
    const owner = await gw.options.store.getWorker(lease.workerId);
    if (owner === undefined || owner.userId !== principal.user.id) {
      throw new HttpError(404, "not_found", "Lease was not found");
    }
    if (lease.projectId === undefined) {
      throw new HttpError(
        409,
        "invalid_lease",
        "Lease has no project boundary and cannot be used remotely",
      );
    }
    await authorizeProject(
      gw.options.store,
      principal,
      lease.projectId,
      "run_task",
    );

    if (action === "progress" && method === "POST") {
      // The agent's own words, from the machine running it.
      //
      // `agent_progress` was emitted in exactly one place — the in-process
      // coordinator — so a run executing on somebody's desktop had nothing
      // whatsoever to say between "I've taken this" and its ending. Every
      // other line a run produces is either held as ceremonial or comes
      // from the coordinator, and the courtesy opening is a paid server
      // call that a deployment running its agents locally has switched off.
      // The result was a thread that looked hung for the entire time the
      // work was actually happening.
      //
      // Added as a new action rather than folded into the heartbeat: the
      // protocol version is compared strictly, so an older worker that
      // never calls this keeps working unchanged, and one that does needs
      // no negotiation.
      const body = objectBody(await gw.readJson(request));
      const message =
        stringField(body["message"], "message", {
          max: 2000,
          optional: true,
        }) ?? "";
      if (message.trim().length > 0) {
        await gw.options.store.appendAudit(undefined, {
          type: "agent_progress",
          taskId: lease.taskId,
          data: {
            projectId: lease.projectId,
            repositoryId: lease.repositoryId,
            workerId: lease.workerId,
            leaseId,
            message: message.trim(),
          },
        });
      }
      // Nothing to say back. Progress is a courtesy the run must never wait
      // on, and a worker that cannot post one keeps working.
      gw.sendJson(response, 202, { recorded: true });
      return true;
    }

    if (action === "heartbeat" && method === "POST") {
      const now = new Date();
      // A heartbeat may carry the agent's running token total. Recording it
      // here rather than only at the end is what makes a token budget a cap
      // instead of a post-mortem: an overspending task is stopped while it
      // is still spending.
      const beat = await gw.readHeartbeatBody(request);
      const reported = await gw.recordLeaseTokenUsage(
        beat,
        lease,
        now.toISOString(),
      );

      // Cost control: a lease past the project's per-task runtime budget
      // is failed rather than extended. Failing (not releasing) is
      // deliberate — requeueing would re-run the same runaway task and
      // burn the budget again.
      if (lease.projectId !== undefined) {
        const project = await gw.options.store.getProject(lease.projectId);
        const leaseBudgets = projectBudgets(project?.policy);
        const maxTaskRuntimeMs = leaseBudgets.maxTaskRuntimeMs;
        const runtimeMs =
          now.getTime() - new Date(lease.issuedAt).getTime();
        const maxTaskTokens = leaseBudgets.maxTaskTokens;
        if (maxTaskTokens !== undefined && reported > maxTaskTokens) {
          await gw.failLeaseOnBudget(lease, now, {
            detail:
              `Task exceeded the project token budget of ${maxTaskTokens} tokens`,
            data: { tokensSpent: reported, maxTaskTokens },
          });
          throw new HttpError(
            409,
            "budget_exceeded",
            "This task exceeded the project's token budget; stop work",
          );
        }
        if (maxTaskRuntimeMs !== undefined && runtimeMs > maxTaskRuntimeMs) {
          const failed = await gw.options.store.finishWorkLease(
            leaseId,
            "failed",
            now.toISOString(),
            `Task exceeded the project runtime budget of ${maxTaskRuntimeMs} ms`,
          );
          if (failed) {
            const task = (
              await gw.options.store.listSubmittedTasks({
                repositoryId: lease.repositoryId,
              })
            ).find((entry) => entry.id === lease.taskId);
            if (task?.status === "claimed") {
              await gw.options.store.completeSubmittedTask(
                task.id,
                "failed",
              );
            }
            await gw.options.store.appendAudit(undefined, {
              type: "task_failed",
              taskId: lease.taskId,
              data: {
                projectId: lease.projectId,
                repositoryId: lease.repositoryId,
                workerId: lease.workerId,
                leaseId,
                stage: "budget_enforcement",
                runtimeMs,
                maxTaskRuntimeMs,
              },
            });
          }
          throw new HttpError(
            409,
            "budget_exceeded",
            "This task exceeded the project's runtime budget; stop work",
          );
        }
      }

      // Before the lease is checked, because the two facts are unrelated and
      // conflating them is what put a live machine's light out.
      //
      // A request arriving here is proof the worker is running and can reach
      // this server — that is the whole of what `lastSeenAt` records. Whether
      // the lease it is beating for is still alive says nothing about the
      // machine. Behind the check, a worker whose leases had expired during a
      // network change went on beating every few seconds, was answered 409
      // every time, and touched nothing: after three minutes of demonstrably
      // talking to this server it read as offline, and the roster stopped
      // offering it work. Switching networks was enough to do it, and the
      // only recovery was restarting the app.
      await gw.options.store.touchWorker(lease.workerId, now.toISOString());
      const extended = await gw.options.store.heartbeatWorkLease(
        leaseId,
        now.toISOString(),
        new Date(now.getTime() + WORK_LEASE_TTL_MS).toISOString(),
      );
      if (extended === undefined) {
        await gw.expireLeasesAndSay(now.toISOString());
        throw new HttpError(
          409,
          "lease_lost",
          "This lease is no longer active; stop work and re-lease",
        );
      }
      gw.sendJson(response, 200, {
        ...extended,
        ...(await gw.claimTraffic(lease, beat)),
      });
      return true;
    }

    if (action === "bundle" && method === "GET") {
      const bundleOperation = gw.options.operations.leaseBundle;
      if (bundleOperation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment cannot serve repository bundles",
        );
      }
      // What the worker already holds, so the control plane can pack only
      // what is missing. Validated here as well as at the far end: this is
      // a value from a remote worker on its way to a Git invocation, and a
      // shape check at the boundary costs nothing. Anything else is simply
      // dropped rather than refused — a worker asking for less than it
      // could get is not an error, and the full bundle is always correct.
      const requested = url.searchParams.get("have") ?? undefined;
      const have =
        requested !== undefined && /^[0-9a-f]{40}$/u.test(requested)
          ? requested
          : undefined;
      const bundle = await bundleOperation(leaseId, have);
      if (bundle === undefined) {
        throw new HttpError(
          409,
          "lease_lost",
          "This lease is no longer active; stop work and re-lease",
        );
      }
      response
        .writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": bundle.byteLength,
        })
        .end(bundle);
      return true;
    }

    if (action === "claim" && method === "POST") {
      // Asked once, between the bundle and the plan, and cheap to refuse.
      //
      // A worker that gets nothing back plans exactly as it did before this
      // route existed, so every reason to say no — blanket claims switched
      // off, somebody else in the repository, an objective the estimator
      // could not anchor, a control plane too old to have the operation —
      // is the same answer: 204, carry on.
      const claimOperation = gw.options.operations.claimWorkRepository;
      const body = objectBody(await gw.readJson(request));
      const prepared =
        claimOperation === undefined
          ? {}
          : await claimOperation({
              leaseId,
              actorId: principal.user.id,
              // Absent reads as 0, which is below the version a claim
              // requires — so a worker that does not say cannot be granted
              // one by accident.
              protocolVersion:
                typeof body["protocolVersion"] === "number" &&
                Number.isFinite(body["protocolVersion"])
                  ? Math.trunc(body["protocolVersion"])
                  : 0,
            });
      if (
        prepared.plan === undefined &&
        (prepared.planningContext ?? "") === ""
      ) {
        response.writeHead(204).end();
        return true;
      }
      gw.sendJson(response, 200, {
        ...(prepared.plan === undefined ? {} : { plan: prepared.plan }),
        ...(prepared.planningContext === undefined
          ? {}
          : { planningContext: prepared.planningContext }),
      });
      return true;
    }

    if (action === "declaration" && method === "POST") {
      // The answer to an ask the heartbeat carried down.
      //
      // Its own route rather than a field on the next heartbeat, because the
      // two have opposite deadlines: a heartbeat must return promptly to
      // keep a lease alive, and this arrives whenever a paused agent has
      // finished thinking. Somebody is waiting on it — the arrival that
      // asked — so the sooner it is posted the sooner they run.
      //
      // The working changes travel with it because this is the one
      // observation of a remote holder that is *exact*: taken at the moment
      // the agent was paused, rather than up to a heartbeat old.
      const body = objectBody(await gw.readJson(request));
      const askId =
        stringField(body["askId"], "askId", { max: 200, optional: true }) ?? "";
      const settle = gw.options.operations.settleClaimDeclaration;
      const settled =
        settle === undefined
          ? false
          : await settle({
              leaseId,
              askId,
              declaration: body["declaration"],
              workingChanges: body["workingChanges"],
            });
      // Never an error. An ask that has been abandoned — the arrival gave up
      // and retried — is answered by a holder that could not have known, and
      // the honest reply is that nobody is listening any more rather than a
      // failure the worker would log.
      gw.sendJson(response, 202, { settled });
      return true;
    }

    if (action === "plan" && method === "POST") {
      const planOperation = gw.options.operations.admitWorkPlan;
      if (planOperation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment cannot admit remote worker plans",
        );
      }
      const body = objectBody(await gw.readJson(request));
      const outcome = await planOperation({
        leaseId,
        actorId: principal.user.id,
        plan: body["plan"],
      });
      if (outcome.outcome === "lease_lost") {
        throw new HttpError(409, "lease_lost", outcome.reason);
      }
      if (outcome.outcome === "rejected") {
        // The lease is already failed by now, so this is terminal for the
        // worker rather than something to retry with a corrected plan.
        throw new HttpError(400, "invalid_plan", outcome.reason);
      }
      gw.sendJson(response, 200, { admission: outcome.admission });
      return true;
    }

    if (action === "scope" && method === "POST") {
      const scopeOperation = gw.options.operations.arbitrateScopeChange;
      if (scopeOperation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment cannot arbitrate remote scope changes",
        );
      }
      const body = objectBody(await gw.readJson(request));
      const outcome = await scopeOperation({
        leaseId,
        actorId: principal.user.id,
        request: body["request"],
      });
      if (outcome.outcome === "lease_lost") {
        throw new HttpError(409, "lease_lost", outcome.reason);
      }
      if (outcome.outcome === "rejected") {
        throw new HttpError(400, "invalid_scope_change", outcome.reason);
      }
      gw.sendJson(response, 200, { decision: outcome.decision });
      return true;
    }

    if (action === "release" && method === "POST") {
      const released = await gw.options.store.finishWorkLease(
        leaseId,
        "released",
        new Date().toISOString(),
        "released by worker",
      );
      if (!released) {
        await gw.expireLeasesAndSay(new Date().toISOString());
        throw new HttpError(
          409,
          "lease_lost",
          "This lease is no longer active; stop work and re-lease",
        );
      }
      gw.sendJson(response, 200, { released: true });
      return true;
    }

    if (action === "result" && method === "POST") {
      const body = objectBody(await gw.readJson(request));
      // Final spend, recorded but not enforced: the tokens are already gone
      // by the time a result exists, and failing finished work over its bill
      // would waste the very thing the budget exists to protect. The cap is
      // enforced at heartbeat, while the spending is still happening.
      if (Array.isArray(body["tokenUsage"])) {
        await gw.recordReportedTokenUsage(
          lease,
          body["tokenUsage"],
          new Date().toISOString(),
        );
      }
      const status = body["status"];
      if (status !== "completed" && status !== "failed") {
        throw new HttpError(
          400,
          "invalid_request",
          'status must be "completed" or "failed"',
        );
      }
      const detail = stringField(body["detail"], "detail", {
        max: 2000,
        optional: true,
      });
      // Its own field, and its own much larger bound. `detail` is a failure
      // reason nobody reads outside a log; an answer is prose about to be
      // posted in a channel. They cannot share a cap: `stringField` throws
      // a 400 rather than clipping, and the worker turns any error inside a
      // lease into a failed task — so an answer a few paragraphs long, sent
      // as `detail`, would reach the room as "I could not answer that".
      const answer = stringField(body["answer"], "answer", {
        max: 8000,
        optional: true,
      });
      const resultOperation = gw.options.operations.acceptWorkResult;
      if (resultOperation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment cannot accept remote worker results",
        );
      }
      const accepted = await resultOperation({
        leaseId,
        status,
        actorId: principal.user.id,
        plan: body["plan"],
        changeSet: body["changeSet"],
        ...(detail === undefined ? {} : { detail }),
        ...(answer === undefined ? {} : { answer }),
      });
      // An accepted answer goes back where somebody asked. Fire-and-forget
      // and after the response is decided: the worker's report has already
      // succeeded by this point, and a channel write that fails must not
      // turn a delivered answer into a retry.
      if (accepted.accepted && accepted.answer !== undefined) {
        void gw.postRoutedAnswer(leaseId, accepted.answer).catch(
          (error: unknown) => {
            process.stderr.write(
              `[channel] routed answer for ${leaseId} could not be posted: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            );
          },
        );
      }
      gw.sendJson(response, 200, accepted);
      return true;
    }

    throw new HttpError(405, "method_not_allowed", "Unsupported lease action");
  }

  if (
    path === `${API_PREFIX}/auth/app-authorization/approve` &&
    method === "POST"
  ) {
    // Session only, exactly as minting a token by hand is: an app that
    // could approve the next app would make revoking this one pointless.
    if (principal.credential !== "session") {
      throw new HttpError(
        403,
        "session_required",
        "Approving an app requires a signed-in session",
      );
    }
    const body = objectBody(await gw.readJson(request));
    const callback = String(body["redirectUri"] ?? "");
    if (!isLoopbackCallback(callback)) {
      throw new HttpError(
        400,
        "callback_rejected",
        "An app callback must be an http address on this machine",
      );
    }
    const user = await gw.options.store.getUser(principal.user.id);
    if (user === undefined) {
      throw new HttpError(404, "not_found", "User was not found");
    }
    const name = stringField(body["name"], "name", { max: 120 }) ?? "Kumi app";
    // Minted here rather than at collection, because here is where the
    // session is: bounding a token by what its owner may actually do takes
    // the live principal and its role, and the route that already does that
    // correctly is this side of the redirect. What the code carries is the
    // finished token, and an uncollected one is withdrawn below rather than
    // left lying about.
    const issued = await gw.auth.issueApiToken({
      user,
      name,
      scopes: [...APP_TOKEN_SCOPES],
      ...(principal.sessionId === undefined
        ? {}
        : { createdBySession: principal.sessionId }),
    });
    gw.pruneAppAuthorizations();
    const code = randomBytes(32).toString("base64url");
    gw.appAuthorizations.set(code, {
      token: issued.token,
      tokenId: issued.record.id,
      name,
      approver: principal,
      expiresAt: Date.now() + APP_AUTHORIZATION_TTL_MS,
    });
    // Built here rather than in the page: the callback has been checked on
    // this side, and handing back a finished address is what stops the
    // browser being pointed anywhere the check did not see.
    const target = new URL(callback);
    target.searchParams.set("code", code);
    const state = String(body["state"] ?? "");
    if (state !== "") {
      target.searchParams.set("state", state);
    }
    gw.sendJson(response, 201, { redirectTo: target.toString() });
    return true;
  }

  if (path === `${API_PREFIX}/auth/ws-ticket` && method === "POST") {
    // Any credential may mint one, a bearer token included — which is the
    // whole point, since a token is exactly what cannot be presented to an
    // upgrade. Unlike minting an API token, this grants nothing durable: a
    // ticket opens one socket within the minute and cannot mint anything
    // further, so it does not put revocation out of reach the way a
    // token minting tokens would.
    gw.pruneSocketTickets();
    const ticket = randomBytes(32).toString("base64url");
    gw.socketTickets.set(ticket, {
      principal,
      expiresAt: Date.now() + SOCKET_TICKET_TTL_MS,
    });
    gw.sendJson(response, 201, {
      ticket,
      expiresInMs: SOCKET_TICKET_TTL_MS,
    });
    return true;
  }

  return false;
}
