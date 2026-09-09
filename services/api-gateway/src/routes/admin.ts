/**
 * The operator side.
 *
 * The waitlist, the user list, and the overview. Everything here is gated
 * on an operator, not on a project role.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import {
  describeError,
} from "@coord/shared-types";
import {
  TRIAL_DAYS,
} from "../billing.js";
import {
  hashPassword,
} from "../auth.js";
import {
  assertTokenScope,
} from "../authorization.js";
import {
  HttpError,
  booleanField,
  emailField,
  objectBody,
  stringField,
} from "../field-validation.js";
import {
  matchPath,
  publicUser,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

export async function routeAdmin(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  if (path.startsWith(`${API_PREFIX}/admin/`)) {
    assertTokenScope(principal, "manage_organization");
  }

  // ---- The waitlist, from the operator's side ---------------------------
  // Behind the same system-administrator check as every other admin route:
  // the list is people's addresses and what they wrote about themselves,
  // and nobody inside one organization has any business reading it.
  if (path === `${API_PREFIX}/admin/waitlist` && method === "GET") {
    if (!principal.user.systemAdmin) {
      throw new HttpError(403, "forbidden", "System administrator required");
    }
    gw.sendJson(response, 200, {
      waitlist: await gw.options.store.listWaitlistEntries(),
    });
    return true;
  }

  const waitlistApproveMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/admin/waitlist/([^/]+)/approve$`, "u"),
  );
  if (waitlistApproveMatch !== undefined && method === "POST") {
    if (!principal.user.systemAdmin) {
      throw new HttpError(403, "forbidden", "System administrator required");
    }
    const entryId = waitlistApproveMatch[0] ?? "";
    const entries = await gw.options.store.listWaitlistEntries();
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (entry === undefined) {
      throw new HttpError(404, "not_found", "That waitlist entry was not found");
    }
    // Approving is what turns the address into one registration will build
    // an account for. Nothing is created here — they still choose their own
    // name and password — so an approval that is never used costs nothing
    // and can be taken back by removing the row.
    const first = await gw.options.store.markWaitlistEntryInvited(
      entry.id,
      new Date().toISOString(),
    );
    if (first) {
      // `#join` rather than a form named in this message, because which
      // form an invitation opens is the deployment's business and not the
      // mail's: with payments on it is the trial and a card, with them off
      // it is a free account. The address rides in the fragment, which the
      // browser never sends, so it prefills the form without reaching a
      // server or an access log — and the gate still checks it, so a
      // forwarded invitation admits nobody new.
      const joinUrl = `${gw.appBaseUrl}/app#join/${encodeURIComponent(
        entry.email,
      )}`;
      if (gw.appBaseUrl === "") {
        // No public address is configured, so every link in this message
        // would be relative — and a relative link in an email is not a link.
        // The approval is already durable and the address can be told by any
        // other means, so this names the missing variable rather than sending
        // something that reads like an invitation and opens nothing.
        console.error(
          `[mail] Not sending ${entry.email} their invitation: this ` +
            "deployment has no public address configured (KUMI_APP_URL), so " +
            "the sign-up link would be relative. They are approved — the " +
            `link is <your-kumi>/app#join/${encodeURIComponent(entry.email)}`,
        );
      } else {
        try {
          await gw.mailer({
            to: entry.email,
            subject: "Your Kumi invitation",
            text:
              `You are through the Kumi waitlist.\n\n` +
              `Create your account here:\n\n${joinUrl}\n\n` +
              `Use this address — ${entry.email} — when you sign up; it is ` +
              `the one that has been let through.\n\n` +
              (gw.payments
                ? `You will be asked for a card. The first ${TRIAL_DAYS} ` +
                  `days are free and nothing is charged until day ${
                    TRIAL_DAYS + 1
                  } — cancel before then and you pay nothing.\n\n`
                : "") +
              `Kumi runs your agents on your own machine, against your own ` +
              `Claude or Codex subscription, so the last step is the desktop ` +
              `app:\n\n${gw.appBaseUrl}/download\n`,
          });
        } catch (error) {
          // Best effort, like every other message this sends. The approval is
          // already durable and the address can be told by any other means;
          // failing the request would only make an operator press approve
          // again against a row that is already approved.
          console.error(
            `[mail] Could not tell ${entry.email} they are through the ` +
              `waitlist: ${describeError(error)}`,
          );
        }
      }
    }
    gw.sendJson(response, 200, {
      entry: await gw.options.store.getWaitlistEntryByEmail(entry.email),
      // Whether this call is the one that did it, so two operators pressing
      // approve together can tell which of them sent the message.
      approved: first,
    });
    return true;
  }

  const waitlistEntryMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/admin/waitlist/([^/]+)$`, "u"),
  );
  if (waitlistEntryMatch !== undefined && method === "DELETE") {
    if (!principal.user.systemAdmin) {
      throw new HttpError(403, "forbidden", "System administrator required");
    }
    await gw.options.store.deleteWaitlistEntry(waitlistEntryMatch[0] ?? "");
    gw.sendJson(response, 200, { removed: true });
    return true;
  }

  if (path === `${API_PREFIX}/admin/users`) {
    if (!principal.user.systemAdmin) {
      throw new HttpError(403, "forbidden", "System administrator required");
    }
    if (method === "GET") {
      gw.sendJson(response, 200, {
        users: (await gw.options.store.listUsers()).map(publicUser),
      });
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const email = emailField(body["email"]) ?? "";
      if ((await gw.options.store.getUserByEmail(email)) !== undefined) {
        throw new HttpError(
          409,
          "email_in_use",
          "User email is already in use",
        );
      }
      const user = await gw.options.store.createUser({
        email,
        displayName:
          stringField(body["displayName"], "displayName", { max: 120 }) ?? "",
        passwordDigest: await hashPassword(
          stringField(body["password"], "password", { max: 256 }) ?? "",
        ),
        systemAdmin: booleanField(body["systemAdmin"], "systemAdmin") ?? false,
      });
      await gw.options.store.appendAudit(undefined, {
        type: "user_changed",
        data: {
          userId: user.id,
          actorId: principal.user.id,
          action: "created",
        },
      });
      gw.sendJson(response, 201, { user: publicUser(user) });
      return true;
    }
  }

  const adminUserMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/admin/users/([^/]+)$`, "u"),
  );
  if (adminUserMatch !== undefined && method === "PATCH") {
    if (!principal.user.systemAdmin) {
      throw new HttpError(403, "forbidden", "System administrator required");
    }
    const body = objectBody(await gw.readJson(request));
    const displayName = stringField(body["displayName"], "displayName", {
      max: 120,
      optional: true,
    });
    const password =
      stringField(body["password"], "password", {
        max: 256,
        optional: true,
      });
    const disabled = booleanField(body["disabled"], "disabled");
    const systemAdmin = booleanField(body["systemAdmin"], "systemAdmin");
    const userId = adminUserMatch[0] ?? "";
    if (userId === principal.user.id && disabled === true) {
      throw new HttpError(
        409,
        "self_lockout",
        "You cannot disable your own account",
      );
    }
    const current = await gw.options.store.getUser(userId);
    if (current === undefined) {
      throw new HttpError(404, "not_found", "User was not found");
    }
    if (
      current.systemAdmin &&
      (systemAdmin === false || disabled === true) &&
      (await gw.options.store.listUsers()).filter(
        (entry) => entry.systemAdmin && !entry.disabled,
      ).length <= 1
    ) {
      throw new HttpError(
        409,
        "last_system_admin",
        "The last active system administrator cannot be removed",
      );
    }
    const user = await gw.options.store.updateUser(
      userId,
      {
        ...(displayName === undefined ? {} : { displayName }),
        ...(password === undefined
          ? {}
          : { passwordDigest: await hashPassword(password) }),
        ...(disabled === undefined ? {} : { disabled }),
        ...(systemAdmin === undefined ? {} : { systemAdmin }),
      },
    );
    if (disabled === true || password !== undefined) {
      await gw.options.store.revokeUserSessions(user.id);
    }
    await gw.options.store.appendAudit(undefined, {
      type: "user_changed",
      data: {
        userId: user.id,
        actorId: principal.user.id,
        action: "updated",
      },
    });
    gw.sendJson(response, 200, { user: publicUser(user) });
    return true;
  }

  if (method === "GET" && path === `${API_PREFIX}/admin/overview`) {
    if (!principal.user.systemAdmin) {
      throw new HttpError(403, "forbidden", "System administrator required");
    }
    const organizations = await gw.options.store.listOrganizations();
    const projects = (
      await Promise.all(
        organizations.map(
          async (organization) =>
            await gw.options.store.listProjects(organization.id),
        ),
      )
    ).flat();
    const tasks = await gw.options.store.listSubmittedTasks();
    const approvals = await gw.options.store.listApprovals();
    // Every status, not just the queued one. A deployment's health is the
    // shape of this distribution rather than any single number in it: the
    // gap between what was submitted and what integrated is where work goes
    // missing, and a count of "pending" alone cannot show it.
    const tasksByStatus: Record<string, number> = {};
    for (const task of tasks) {
      tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
    }
    gw.sendJson(response, 200, {
      counts: {
        users: await gw.options.store.countUsers(),
        organizations: organizations.length,
        projects: projects.length,
        repositories: (await gw.options.store.listRepositories()).length,
        tasks: tasks.length,
        pendingTasks: tasks.filter((task) => task.status === "submitted").length,
        pendingApprovals: approvals.filter(
          (approval) => approval.status === "pending",
        ).length,
        activeRuns: gw.activeRuns.size,
        webSocketConnections: gw.webSockets.connections,
      },
      tasksByStatus,
      // Named, so the dashboard can ask each one for its own coordination
      // metrics rather than guessing at a project id.
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        organizationId: project.organizationId,
      })),
      // Named rather than counted. A pending approval is a run stopped on a
      // person, and a bare count tells that person there is something to do
      // without telling them where — which is how three of them sat unread
      // long enough for the process holding them to be redeployed away.
      // Repository and task are what turn the number into somewhere to go.
      pendingApprovals: approvals
        .filter((approval) => approval.status === "pending")
        .slice(0, 20)
        .map((approval) => ({
          id: approval.id,
          repositoryId: approval.repositoryId,
          taskId: approval.taskId,
          kind: approval.kind,
          reasons: approval.reasons,
          requestedAt: approval.requestedAt,
          expiresAt: approval.expiresAt,
          // Whether anything is still listening. An approval past its own
          // deadline that is somehow still pending had nobody watching it:
          // the waiter would have ended it otherwise.
          stale: approval.expiresAt <= new Date().toISOString(),
        })),
      recentRuns: await gw.options.store.listRuns(20),
    });
    return true;
  }

  throw new HttpError(404, "not_found", "Route was not found");

  return false;
}
