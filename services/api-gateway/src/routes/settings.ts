/**
 * The caller's own settings, and what they can look back at.
 *
 * Their GitHub connection, past runs, approvals, the catch-up, metrics, the
 * audit log and billing.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import type {
  AuditEventFilter,
  SubmittedTask,
} from "@coord/persistence";
import {
  requestFromObjective,
} from "@coord/shared-types";
import {
  authorizeOrganization,
  authorizeProject,
} from "../authorization.js";
import {
  billableSeats,
} from "../billing.js";
import {
  type CatchUpChange,
  buildCatchUpDigest,
  catchUpSince,
  emptyCatchUpDigest,
  summariseCatchUpLines,
} from "../catch-up.js";
import {
  HttpError,
  objectBody,
  stringField,
} from "../field-validation.js";
import {
  matchPath,
  narrowToRepositories,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import {
  APPROVAL_STATUSES,
} from "../gateway-util.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

export async function routeSettings(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  // ---- The caller's own GitHub connection (Settings) --------------------
  // Per authenticated user, exactly like provider chat: nothing here
  // touches projects or repositories. It is the identity a push of this
  // user's tasks will authenticate as, which is nobody's business but
  // their own.
  if (
    path === `${API_PREFIX}/github/credential` ||
    path === `${API_PREFIX}/github/credential/device-auth`
  ) {
    const githubOperations = gw.options.operations.githubCredential;
    if (githubOperations === undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment does not support GitHub connections",
      );
    }
    const performGitHub = async <T>(
      operation: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        const code = (error as { code?: unknown }).code;
        if (
          error instanceof Error &&
          typeof status === "number" &&
          typeof code === "string"
        ) {
          throw new HttpError(status, code, error.message);
        }
        throw error;
      }
    };
    if (path === `${API_PREFIX}/github/credential/device-auth`) {
      const deviceAuth = githubOperations.deviceAuth;
      if (deviceAuth === undefined) {
        throw new HttpError(
          501,
          "unsupported",
          "This deployment does not support GitHub sign-in",
        );
      }
      // The flow id travels in the query string, same as the provider
      // device-auth family and for the same reason: one route shape, an
      // opaque id, scoped to the caller server-side regardless.
      const flowId =
        stringField(
          new URL(request.url ?? "", "http://localhost").searchParams.get(
            "flow",
          ) ?? undefined,
          "flow",
          { max: 64, optional: true },
        ) ?? "";
      if (method === "POST") {
        gw.sendJson(response, 200, {
          deviceAuth: await performGitHub(() =>
            deviceAuth.start({ userId: principal.user.id }),
          ),
        });
        return true;
      }
      if (flowId.length === 0) {
        throw new HttpError(400, "invalid_request", "flow is required");
      }
      if (method === "GET") {
        gw.sendJson(response, 200, {
          deviceAuth: await performGitHub(() =>
            deviceAuth.status({ userId: principal.user.id, flowId }),
          ),
        });
        return true;
      }
      if (method === "DELETE") {
        await performGitHub(() =>
          deviceAuth.cancel({ userId: principal.user.id, flowId }),
        );
        gw.sendJson(response, 200, { cancelled: true });
        return true;
      }
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }
    if (method === "GET") {
      gw.sendJson(
        response,
        200,
        await performGitHub(() =>
          githubOperations.status({ userId: principal.user.id }),
        ),
      );
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      // Read but never echoed: the response is the same connection status
      // the GET returns, so nothing that reaches a log or a browser
      // carries the token.
      const token = stringField(body["token"], "token", { max: 512 }) ?? "";
      gw.sendJson(
        response,
        200,
        await performGitHub(() =>
          githubOperations.connect({ userId: principal.user.id, token }),
        ),
      );
      return true;
    }
    if (method === "DELETE") {
      await performGitHub(() =>
        githubOperations.disconnect({ userId: principal.user.id }),
      );
      gw.sendJson(response, 200, { disconnected: true });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "Unsupported method");
  }

  const runsMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/runs$`, "u"),
  );
  if (runsMatch !== undefined && method === "GET") {
    const projectId = runsMatch[0] ?? "";
    const authorized = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "view",
    );
    const limit = Math.min(
      500,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10)),
    );
    gw.sendJson(response, 200, {
      runs: narrowToRepositories(
        await gw.options.store.listRuns(limit * 5),
        authorized.repositories,
      )
        .filter((run) => run.projectId === projectId)
        .slice(0, limit),
    });
    return true;
  }

  const runDetailMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/runs/([^/]+)$`, "u"),
  );
  if (runDetailMatch !== undefined && method === "GET") {
    const runId = runDetailMatch[0] ?? "";
    const detail = await gw.options.store.getRun(runId);
    if (detail === undefined || detail.run.projectId === undefined) {
      throw new HttpError(404, "not_found", "Run was not found");
    }
    await authorizeProject(
      gw.options.store,
      principal,
      detail.run.projectId,
      "view",
    );
    gw.sendJson(response, 200, { run: detail });
    return true;
  }

  const approvalsMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/approvals$`, "u"),
  );
  if (approvalsMatch !== undefined && method === "GET") {
    const projectId = approvalsMatch[0] ?? "";
    const authorized = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "view",
    );
    const statusValue = url.searchParams.get("status") ?? undefined;
    const status =
      statusValue === undefined
        ? undefined
        : APPROVAL_STATUSES.find((entry) => entry === statusValue);
    if (statusValue !== undefined && status === undefined) {
      throw new HttpError(
        400,
        "invalid_status",
        `Approval status must be one of ${APPROVAL_STATUSES.join(", ")}`,
      );
    }
    gw.sendJson(response, 200, {
      approvals: narrowToRepositories(
        await gw.options.store.listApprovals({
          projectId,
          ...(status === undefined ? {} : { status }),
        }),
        authorized.repositories,
      ),
    });
    return true;
  }

  // What changed while somebody was away, for the popup on their next
  // sign-in. Assembled from what the store already knows rather than by
  // asking an agent to write it, so it is the same document every time,
  // costs nothing, and still appears when no agent is connected.
  const catchUpMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/catch-up$`, "u"),
  );
  if (catchUpMatch !== undefined && method === "GET") {
    const projectId = catchUpMatch[0] ?? "";
    const { repositories } = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "view",
    );
    const now = new Date().toISOString();
    const cursor = await gw.options.store.getCatchUpCursor(
      projectId,
      principal.user.id,
    );
    const since = catchUpSince(cursor?.seenAt, now);
    if (since === undefined) {
      // Nobody's first visit has a "while you were away" — so it starts the
      // clock instead of reporting one. Written here rather than left to the
      // client's "seen" call because a first visit shows no popup to dismiss,
      // and a mark that only ever appears when somebody dismisses something
      // would mean the second visit had nothing to measure from either.
      await gw.options.store.markCatchUpSeen(
        projectId,
        principal.user.id,
        now,
      );
      gw.sendJson(response, 200, {
        catchUp: emptyCatchUpDigest(now, now),
      });
      return true;
    }
    // The same narrowing the repository list does: a grant holder is caught
    // up on the repositories they were granted, and told nothing about the
    // others.
    const all = await gw.options.store.listProjectRepositories(projectId);
    const visible =
      repositories === undefined
        ? all
        : all.filter((entry) => repositories.has(entry.id));
    const visibleIds = new Set(visible.map((entry) => entry.id));

    const messages: string[] = [];
    for (const repository of visible) {
      const entries = await gw.options.store.listChannelMessages(
        repository.id,
        principal.user.id,
        // The same page cap the stats route uses: counting by fetching is
        // honest about what the channel API can see, and a busier interval
        // than that reads as "a lot happened" either way.
        { limit: 200 },
      );
      for (const entry of entries) {
        // Somebody's own messages are not news to them, and neither is
        // anything they had already seen when they left.
        if (entry.createdAt > since && entry.authorId !== principal.user.id) {
          messages.push(entry.createdAt);
        }
        for (const reply of entry.replies) {
          if (
            reply.createdAt > since &&
            reply.authorId !== principal.user.id
          ) {
            messages.push(reply.createdAt);
          }
        }
      }
    }

    // When a task's work landed, which is not the same as when the task
    // finished. A conversational task keeps its thread open for the next
    // turn, so it is `open` with no `completedAt` even though a change of
    // its own has already been promoted — and a digest that looked only at
    // `completedAt` skipped exactly those, leaving the client to caption
    // them with the request somebody typed instead of an account of what
    // was done. `openedAt` is stamped when a turn lands and the thread is
    // held open, so it is that turn's landing moment.
    const landedAt = (task: SubmittedTask): string | undefined =>
      task.completedAt ?? task.openedAt;
    const tasks = (
      await gw.options.store.listSubmittedTasks({ projectId })
    ).filter((task) => {
      const at = landedAt(task);
      return (
        visibleIds.has(task.repositoryId) && at !== undefined && at > since
      );
    });
    const completedChanges = await Promise.all(
      tasks.map(async (task) => {
        const filter: AuditEventFilter = {
          taskId: task.id,
          types: ["canonical_promoted", "task_reported"],
        };
        const [archived, live] = await Promise.all([
          gw.options.store.listArchivedAuditEvents(filter).catch(() => []),
          gw.options.store.listAuditEvents(filter),
        ]);
        const outcome = [...archived, ...live].at(-1)?.event;
        const data = (outcome?.data ?? {}) as Record<string, unknown>;
        const agentResponse =
          outcome?.type === "task_reported"
            ? data["explanation"]
            : data["agentExplanation"];
        const changedFiles = Array.isArray(data["files"])
          ? data["files"].filter(
              (file): file is string => typeof file === "string",
            )
          : [];
        return {
          task,
          change: {
            id: task.id,
            repositoryId: task.repositoryId,
            objective: requestFromObjective(task.objective),
            at: landedAt(task) ?? outcome?.occurredAt ?? since,
            ...(typeof agentResponse === "string" ? { agentResponse } : {}),
            changedFiles,
          } satisfies CatchUpChange,
        };
      }),
    );
    const conversations = await gw.options.store.listDirectConversations(
      projectId,
      principal.user.id,
    );

    const catchUp = buildCatchUpDigest({
      since,
      now,
      landed: completedChanges
        .filter(({ task }) => ["integrated", "open"].includes(task.status))
        .map(({ change }) => change),
      // Cancelled work is somebody's own decision, not news; only a task
      // that stopped on its own is something they have to look at.
      failed: completedChanges
        .filter(({ task }) => task.status === "failed")
        .map(({ change }) => change),
      messages,
      // Only conversations that moved while they were away. An older
      // unread message is a badge they have already seen sitting on the
      // inbox, and repeating it here would make the popup impossible to
      // clear.
      direct: conversations
        .filter((conversation) => conversation.lastMessage.createdAt > since)
        .reduce((total, conversation) => total + conversation.unread, 0),
    });
    // The facts are already right; this only rewrites how they read. A
    // deployment with no local model, or one whose model is slow or
    // unhelpful, gets the deterministic wording back unchanged.
    gw.sendJson(response, 200, {
      catchUp: await summariseCatchUpLines(
        catchUp,
        gw.catchUpSummariser,
        completedChanges.map(({ change }) => change),
      ),
    });
    return true;
  }
  // Marking the catch-up read. Its own call rather than a side effect of
  // reading it: a request that both reports the news and forgets it loses
  // the whole document when the response does not arrive.
  const catchUpSeenMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/catch-up/seen$`, "u"),
  );
  if (catchUpSeenMatch !== undefined && method === "POST") {
    const projectId = catchUpSeenMatch[0] ?? "";
    await authorizeProject(gw.options.store, principal, projectId, "view");
    await gw.options.store.markCatchUpSeen(
      projectId,
      principal.user.id,
      new Date().toISOString(),
    );
    // Read back rather than echoed: the write is forward-only, so what the
    // caller sent is not necessarily what the mark now says.
    const cursor = await gw.options.store.getCatchUpCursor(
      projectId,
      principal.user.id,
    );
    gw.sendJson(response, 200, { seenAt: cursor?.seenAt });
    return true;
  }

  const metricsMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/metrics$`, "u"),
  );
  if (metricsMatch !== undefined && method === "GET") {
    const projectId = metricsMatch[0] ?? "";
    await authorizeProject(gw.options.store, principal, projectId, "view");
    const operation = gw.options.operations.projectMetrics;
    if (operation === undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment does not expose coordination metrics",
      );
    }
    gw.sendJson(response, 200, {
      metrics: await operation({ projectId }),
    });
    return true;
  }

  const approvalMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/approvals/([^/]+)$`, "u"),
  );
  if (approvalMatch !== undefined) {
    const approvalId = approvalMatch[0] ?? "";
    const approval = await gw.options.store.getApproval(approvalId);
    if (approval === undefined || approval.projectId === undefined) {
      throw new HttpError(404, "not_found", "Approval was not found");
    }
    await authorizeProject(
      gw.options.store,
      principal,
      approval.projectId,
      method === "GET" ? "view" : "review",
    );
    if (method === "GET") {
      const detail = await gw.options.store.getRun(approval.runId);
      const changeSet = detail?.changeSets.find(
        (entry) => entry.id === approval.changeSetId,
      );
      gw.sendJson(response, 200, { approval, changeSet });
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const status = stringField(body["status"], "status", { max: 20 });
      if (status !== "approved" && status !== "rejected") {
        throw new HttpError(
          400,
          "invalid_decision",
          "status must be approved or rejected",
        );
      }
      const comment =
        stringField(body["comment"], "comment", {
          max: 2_000,
          optional: true,
        }) ?? "";
      const decided = await gw.options.store.decideApproval({
        approvalId,
        status,
        decidedBy: principal.user.id,
        comment,
        decidedAt: new Date().toISOString(),
      });
      await gw.options.store.appendAudit(approval.runId, {
        type: "approval_decided",
        taskId: approval.taskId,
        data: {
          projectId: approval.projectId,
          approvalId,
          status,
          actorId: principal.user.id,
          comment,
        },
      });
      gw.sendJson(response, 200, { approval: decided });
      return true;
    }
  }

  const auditMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/audit$`, "u"),
  );
  if (auditMatch !== undefined && method === "GET") {
    const projectId = auditMatch[0] ?? "";
    await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "view",
    );
    const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
    const runIds = new Set(
      (await gw.options.store.listRuns(5_000))
        .filter((run) => run.projectId === projectId)
        .map((run) => run.id),
    );
    const events = (
      await gw.options.store.listAuditEvents({
        afterSequence: Number.isSafeInteger(after) && after >= 0 ? after : 0,
        limit: 5_000,
      })
    ).filter(
      (record) =>
        (record.runId !== undefined && runIds.has(record.runId)) ||
        record.event.data["projectId"] === projectId,
    );
    gw.sendJson(response, 200, { events });
    return true;
  }

  const billingMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/organizations/([^/]+)/billing$`, "u"),
  );
  if (billingMatch !== undefined && method === "GET") {
    const organizationId = billingMatch[0] ?? "";
    // `view`, not `manage_organization`: everybody in a team benefits from
    // knowing the trial ends on Friday, and hiding it until somebody with
    // billing rights notices is how a trial lapses by surprise.
    await authorizeOrganization(
      gw.options.store,
      principal,
      organizationId,
      "view",
    );
    const subscription =
      await gw.options.store.getSubscription(organizationId);
    const memberships =
      await gw.options.store.listMemberships(organizationId);
    gw.sendJson(response, 200, {
      billing: {
        // Whether anybody is being charged here, and whether the plumbing
        // to charge them exists. Two questions, because a deployment with
        // payments switched off is not a deployment somebody misconfigured
        // and the screen should not read like one.
        payments: gw.payments,
        configured:
          gw.payments &&
          gw.stripe !== undefined &&
          gw.stripePriceId !== undefined,
        status: subscription?.status ?? "trialing",
        trialEndsAt: subscription?.trialEndsAt,
        currentPeriodEnd: subscription?.currentPeriodEnd,
        seats: billableSeats(
          memberships,
          await gw.organizationGrants(organizationId),
        ),
        // Whether a portal link can be made at all. A team that has never
        // paid has no Stripe customer, and offering "manage billing" that
        // can only fail is worse than not offering it.
        manageable: subscription?.stripeCustomerId !== undefined,
      },
    });
    return true;
  }

  const checkoutMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/organizations/([^/]+)/billing/checkout$`, "u"),
  );
  if (checkoutMatch !== undefined && method === "POST") {
    const organizationId = checkoutMatch[0] ?? "";
    await authorizeOrganization(
      gw.options.store,
      principal,
      organizationId,
      "manage_organization",
      // A lapsed subscription must not block the act that ends the lapse.
      { ignoreEntitlement: true },
    );
    gw.assertPaymentsEnabled();
    const stripe = gw.requireStripe();
    const priceId = gw.stripePriceId;
    if (priceId === undefined) {
      throw new HttpError(
        501,
        "billing_not_configured",
        "No price is configured for this deployment",
      );
    }
    if (
      (await gw.options.store.getSubscription(organizationId))?.status ===
      "comped"
    ) {
      // Refused at the route, not only hidden in the interface. A comped
      // team has nothing to buy, and a checkout it completes — or abandons —
      // is the one way its comp can be taken away from it.
      throw new HttpError(
        409,
        "already_comped",
        "This team is not billed. There is nothing to buy.",
      );
    }
    const memberships =
      await gw.options.store.listMemberships(organizationId);
    const existing =
      await gw.options.store.getSubscription(organizationId);
    const session = await stripe.createCheckoutSession({
      organizationId,
      priceId,
      // At least one: an organization with no billable seat yet still has
      // somebody standing at the checkout, and Stripe refuses a quantity of
      // zero. They are buying the seat they are about to use.
      quantity: Math.max(
        1,
        billableSeats(
          memberships,
          await gw.organizationGrants(organizationId),
        ),
      ),
      // Fragments, not paths. The dashboard routes on `location.hash`, so a
      // path-shaped return lands on the default screen with nothing said —
      // somebody would pay and be shown the room they started in. The
      // fragment is also never sent to the server, which is why the rest of
      // this app's deep links use one.
      successUrl: `${gw.appBaseUrl}/app#billing-done`,
      cancelUrl: `${gw.appBaseUrl}/app#billing-cancelled`,
      ...(existing?.stripeCustomerId === undefined
        ? { customerEmail: principal.user.email }
        : { customerId: existing.stripeCustomerId }),
    });
    gw.sendJson(response, 200, { url: session.url });
    return true;
  }

  const portalMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/organizations/([^/]+)/billing/portal$`, "u"),
  );
  if (portalMatch !== undefined && method === "POST") {
    const organizationId = portalMatch[0] ?? "";
    await authorizeOrganization(
      gw.options.store,
      principal,
      organizationId,
      "manage_organization",
      // A lapsed subscription must not block the act that ends the lapse.
      { ignoreEntitlement: true },
    );
    gw.assertPaymentsEnabled();
    const stripe = gw.requireStripe();
    const subscription =
      await gw.options.store.getSubscription(organizationId);
    if (subscription?.stripeCustomerId === undefined) {
      throw new HttpError(
        409,
        "no_stripe_customer",
        "This organization has never been billed, so there is nothing to manage",
      );
    }
    const session = await stripe.createPortalSession({
      customerId: subscription.stripeCustomerId,
      returnUrl: `${gw.appBaseUrl}/app#billing`,
    });
    gw.sendJson(response, 200, { url: session.url });
    return true;
  }

  return false;
}
