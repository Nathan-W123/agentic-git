/**
 * API tokens, organizations, invitations and membership.
 *
 * Who exists, who may act, and the tokens they act through.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import {
  randomBytes,
} from "node:crypto";
import type {
  OrganizationRole,
} from "@coord/persistence";
import {
  hashSecret,
} from "../auth.js";
import {
  ALL_PERMISSIONS,
  assertTokenScope,
  authorizeOrganization,
  authorizeRepository,
  canAssignRole,
  isPermission,
  permissionsForRole,
} from "../authorization.js";
import {
  HttpError,
  emailField,
  objectBody,
  optionalEditorVendor,
  slugField,
  stringField,
} from "../field-validation.js";
import {
  matchPath,
  publicInvitation,
  publicUser,
  invitationIdForCode,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import {
  INVITATION_TTL_MS,
  ROLES,
  normalizeInvitationCode,
} from "../gateway-util.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

export async function routeOrganizations(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  if (path === `${API_PREFIX}/auth/tokens` && method === "GET") {
    gw.sendJson(response, 200, {
      tokens: await gw.auth.listApiTokens(principal.user.id),
    });
    return true;
  }

  if (path === `${API_PREFIX}/auth/tokens` && method === "POST") {
    // A token minting another would make revocation meaningless — a leaked
    // credential could silently refresh itself forever — so ordinarily only
    // an interactive session may mint.
    //
    // The desktop app is the exception, and it had to be: it authenticates
    // with a token, so connecting an editor on the machine it runs on was
    // impossible from the one place that can actually write that editor's
    // config. What makes it safe is that the exception does not touch the
    // invariant. A minted token carries strictly fewer scopes than the one
    // that minted it, so nothing escalates; it is recorded against its
    // parent and revoked with it, so revocation still reaches everything;
    // and it may not mint in turn, so the chain is one link long.
    const parent =
      principal.credential === "api_token" ? principal.token : undefined;
    if (principal.credential !== "session" && parent === undefined) {
      throw new HttpError(
        403,
        "session_required",
        "API tokens can only be created from a signed-in session",
      );
    }
    const body = objectBody(await gw.readJson(request));
    const requested = body["scopes"];
    if (
      !Array.isArray(requested) ||
      !requested.every((entry): entry is string => typeof entry === "string")
    ) {
      throw new HttpError(400, "invalid_scopes", "scopes must be an array of strings");
    }
    for (const scope of requested) {
      if (!isPermission(scope)) {
        throw new HttpError(400, "invalid_scopes", `Unknown scope: ${scope}`);
      }
    }

    const organizationId = stringField(body["organizationId"], "organizationId", {
      max: 120,
      optional: true,
    });
    // Bound the grant by what the user can actually do, so a token can never
    // be a privilege escalation.
    const allowed = new Set<string>();
    if (principal.user.systemAdmin && organizationId === undefined) {
      for (const permission of ALL_PERMISSIONS) {
        allowed.add(permission);
      }
    } else if (organizationId !== undefined) {
      const { role } = await authorizeOrganization(
        gw.options.store,
        principal,
        organizationId,
        "view",
      );
      for (const permission of permissionsForRole(role)) {
        allowed.add(permission);
      }
    } else {
      for (const membership of principal.memberships) {
        for (const permission of permissionsForRole(membership.role)) {
          allowed.add(permission);
        }
      }
      // Repository grants count too, and leaving them out made this refuse
      // everybody it was meant to serve. A repository-scoped invitation
      // grants that one repository and deliberately no organization
      // membership — which is the whole point of scoping it — and the
      // invitation route requires a repository, so in practice *every*
      // person invited to a deployment arrives with grants and no
      // memberships. Bounding a token by memberships alone therefore
      // bounded it by nothing: a developer on the only repository they can
      // see was told their role granted not even `view`, and could create
      // no token at all.
      for (const grant of await gw.options.store
        .listGrantsForUser(principal.user.id)
        .catch((): [] => [])) {
        for (const permission of permissionsForRole(grant.role)) {
          allowed.add(permission);
        }
      }
    }
    const exceeded = requested.filter((scope) => !allowed.has(scope));
    if (exceeded.length > 0) {
      throw new HttpError(
        403,
        "scope_exceeds_role",
        `Your role does not grant: ${exceeded.join(", ")}`,
      );
    }
    if (parent !== undefined) {
      // One link, and one only. A minted token that could mint would grow a
      // chain whose tail survives revoking the head — the cascade below is
      // a single level, deliberately, because a recursive one is a loop
      // over attacker-controlled depth. Refusing here is what keeps the two
      // in step.
      const holder = await gw.options.store.getApiToken(parent.id);
      if (holder?.createdByToken !== undefined) {
        throw new HttpError(
          403,
          "session_required",
          "This token was itself minted by another, and cannot mint further",
        );
      }
      // Narrower than the token doing the minting, always. Bounding by the
      // person's role alone would let a token that carries `view` mint one
      // that carries everything its owner could — an escalation from a
      // credential rather than from a person, which is the whole thing this
      // exception must not become.
      const beyond = requested.filter((scope) => !parent.scopes.includes(scope));
      if (beyond.length > 0) {
        throw new HttpError(
          403,
          "scope_exceeds_token",
          `This token cannot grant what it does not hold: ${beyond.join(", ")}`,
        );
      }
    }

    // Which editor this is for, when it is for one. Validated against the
    // fixed list rather than stored as typed: it decides who does somebody's
    // work, so an unrecognised value must read as "not an editor" instead of
    // as an agent nobody has.
    const editorVendor = optionalEditorVendor(body["editorVendor"]);
    const expiresInDays = body["expiresInDays"];
    if (
      expiresInDays !== undefined &&
      (typeof expiresInDays !== "number" || !Number.isSafeInteger(expiresInDays))
    ) {
      throw new HttpError(
        400,
        "invalid_expiry",
        "expiresInDays must be an integer",
      );
    }

    const user = await gw.options.store.getUser(principal.user.id);
    if (user === undefined) {
      throw new HttpError(404, "not_found", "User was not found");
    }
    const issued = await gw.auth.issueApiToken({
      user,
      name: stringField(body["name"], "name", { max: 120 }) ?? "",
      scopes: requested,
      ...(organizationId === undefined ? {} : { organizationId }),
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
      ...(principal.sessionId === undefined
        ? {}
        : { createdBySession: principal.sessionId }),
      // Recorded so revoking the parent revokes this too, which is the
      // whole of what makes minting from a token safe.
      ...(parent === undefined ? {} : { createdByToken: parent.id }),
      // Recorded once, at mint, so the tools can tell which editor a
      // request came from without asking the model to say. Read from the
      // name otherwise, which is editable and therefore only a hint.
      ...(editorVendor === undefined ? {} : { editorVendor }),
    });
    await gw.options.store.appendAudit(undefined, {
      type: "api_token_issued",
      data: {
        userId: principal.user.id,
        tokenId: issued.record.id,
        name: issued.record.name,
        scopes: issued.record.scopes,
        organizationId: issued.record.organizationId ?? null,
        expiresAt: issued.record.expiresAt ?? null,
      },
    });
    // The plaintext appears here and nowhere else, ever.
    gw.sendJson(response, 201, { ...issued.record, token: issued.token });
    return true;
  }

  if (method === "DELETE" && path.startsWith(`${API_PREFIX}/auth/tokens/`)) {
    const tokenId = decodeURIComponent(
      path.slice(`${API_PREFIX}/auth/tokens/`.length),
    );
    await gw.auth.revokeApiToken(principal, tokenId, "revoked by owner");
    await gw.options.store.appendAudit(undefined, {
      type: "api_token_revoked",
      data: { userId: principal.user.id, tokenId },
    });
    gw.sendJson(response, 200, { revoked: true, tokenId });
    return true;
  }

  if (method === "GET" && path === `${API_PREFIX}/organizations`) {
    gw.sendJson(response, 200, {
      organizations: await gw.reachableOrganizations(principal),
    });
    return true;
  }
  if (method === "POST" && path === `${API_PREFIX}/organizations`) {
    assertTokenScope(principal, "manage_organization");
    if (!principal.user.systemAdmin) {
      // An operator's tool, not a self-serve one. This route wrote no
      // subscription row, and a missing row used to be read as a fresh
      // fourteen-day trial — so anybody signed in could mint themselves
      // another fortnight whenever the last one ran out, and orphan the
      // organization they were supposed to be paying for. Sign-up is the
      // way to get an organization; that path takes a card.
      throw new HttpError(
        403,
        "forbidden",
        "New organizations are created by signing up",
      );
    }
    const body = objectBody(await gw.readJson(request));
    const slug = slugField(body["slug"]) ?? "";
    if (
      (await gw.options.store.listOrganizations()).some(
        (organization) => organization.slug === slug,
      )
    ) {
      throw new HttpError(
        409,
        "slug_in_use",
        "Organization slug is already in use",
      );
    }
    const organization = await gw.options.store.createOrganization({
      slug,
      name: stringField(body["name"], "name", { max: 120 }) ?? "",
    });
    await gw.options.store.saveMembership({
      organizationId: organization.id,
      userId: principal.user.id,
      role: "owner",
    });
    // Written explicitly, because a missing row is now no entitlement at
    // all rather than a fortnight's grace. An organization an operator
    // makes by hand is one nobody is going to be invoiced for, and saying
    // so here is what keeps it working.
    await gw.options.store.saveSubscription({
      organizationId: organization.id,
      status: "comped",
    });
    await gw.options.store.appendAudit(undefined, {
      type: "organization_changed",
      data: {
        organizationId: organization.id,
        action: "created",
        actorId: principal.user.id,
      },
    });
    gw.sendJson(response, 201, { organization });
    return true;
  }

  const organizationMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/organizations/([^/]+)$`, "u"),
  );
  if (organizationMatch !== undefined) {
    const organizationId = organizationMatch[0] ?? "";
    const permission = method === "GET" ? "view" : "manage_organization";
    const authorized = await authorizeOrganization(
      gw.options.store,
      principal,
      organizationId,
      permission,
    );
    if (method === "GET") {
      gw.sendJson(response, 200, authorized);
      return true;
    }
    if (method === "PATCH") {
      const body = objectBody(await gw.readJson(request));
      const name = stringField(body["name"], "name", {
        max: 120,
        optional: true,
      });
      const slug = slugField(body["slug"], { optional: true });
      if (
        slug !== undefined &&
        (await gw.options.store.listOrganizations()).some(
          (organization) =>
            organization.id !== organizationId &&
            organization.slug === slug,
        )
      ) {
        throw new HttpError(
          409,
          "slug_in_use",
          "Organization slug is already in use",
        );
      }
      const organization = await gw.options.store.updateOrganization(
        organizationId,
        {
          ...(name === undefined ? {} : { name }),
          ...(slug === undefined ? {} : { slug }),
        },
      );
      await gw.options.store.appendAudit(undefined, {
        type: "organization_changed",
        data: {
          organizationId,
          action: "updated",
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, { organization });
      return true;
    }
  }


  // ---- Invitations ------------------------------------------------------
  // Membership already required an account, and creating an account required
  // a system administrator, so an organization owner had no way to bring in
  // a colleague. An invitation closes that loop: it names an email and a
  // role, and creates the account at the moment it is accepted.
  const invitationsMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/organizations/([^/]+)/invitations$`, "u"),
  );
  if (invitationsMatch !== undefined) {
    const organizationId = invitationsMatch[0] ?? "";
    const authorized = await authorizeOrganization(
      gw.options.store,
      principal,
      organizationId,
      "manage_members",
    );
    if (method === "GET") {
      gw.sendJson(response, 200, {
        invitations: (
          await gw.options.store.listInvitations(organizationId)
        ).map(publicInvitation),
      });
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      // An address is optional, and without one this is a link rather than
      // a letter: anybody holding it can join, and more than one person
      // can. That is what an invitation actually gets used for — pasted
      // into the group chat where the team already is — and the addressed
      // form could not do it. It named one mailbox, it was spent the first
      // time it was opened, and the second person to click it was told the
      // invitation had already been used.
      //
      // What it is not is a weaker grant. The link still expires, is still
      // revocable, still names exactly one repository, and still cannot
      // hand out a role its author could not assign. It is a bearer
      // credential for that one repository, which is what makes it worth
      // keeping out of a public place — but the group chat it was always
      // going to be pasted into is not one.
      const offered =
        body["email"] === undefined || body["email"] === ""
          ? undefined
          : emailField(body["email"]);
      const email = offered ?? "";
      const recipientName = stringField(
        body["recipientName"],
        "recipientName",
        { max: 80, optional: true },
      );
      const invitationCode =
        recipientName === undefined
          ? undefined
          : normalizeInvitationCode(recipientName);
      if (recipientName !== undefined && invitationCode === undefined) {
        throw new HttpError(
          400,
          "invalid_invitation_code",
          "Invite names must become 6–48 characters using letters, numbers, spaces, or dashes",
        );
      }
      const role = stringField(body["role"], "role", { max: 20 }) as
        | OrganizationRole
        | undefined;
      if (role === undefined || !ROLES.includes(role)) {
        throw new HttpError(400, "invalid_role", "Role is invalid");
      }
      // The same ceiling as adding a member directly: an invitation must not
      // be a way to hand out a role you could not assign yourself.
      if (!canAssignRole(authorized.role, role)) {
        throw new HttpError(403, "forbidden", "You cannot assign that role");
      }
      // An invitation names exactly one repository, and that is all it
      // grants.
      //
      // The upstream design allowed the name to be omitted, in which case
      // the invitation admitted the person to the whole organization —
      // every repository it holds, including ones created later. That is a
      // much larger thing to hand out than the person offering it usually
      // means to, and it cannot be narrowed afterwards: an organization role
      // reaches everything by design (see `authorizeRepository`), so the
      // only way back is to remove the member entirely. Requiring the
      // repository makes the smaller grant the only one on offer.
      const repositoryId = stringField(body["repositoryId"], "repositoryId", {
        max: 128,
      });
      // Authorized, not merely looked up.
      //
      // This read `listProjectRepositories` on a project id taken raw from
      // the body, and that lookup is keyed on the project alone in all
      // three backends — so the only question asked was "does this
      // repository exist somewhere under that project", never "may this
      // caller give it away". A grant on one repository is enough to learn
      // an organization's project id, and the route then answered 201 for a
      // repository the caller had no access to and 404 for one that did not
      // exist: an oracle, and then an invitation to somebody else's code
      // which acceptance turns into a real grant.
      //
      // `manage_members` rather than `view`, because handing out access is
      // what this does, and the caller must hold that on the repository
      // itself — a grant carries a role, and an `owner` grant on a
      // repository is exactly who should be able to share it.
      const invitedProjectId =
        stringField(body["projectId"], "projectId", { max: 128 }) ?? "";
      if (repositoryId === undefined || repositoryId === "") {
        throw new HttpError(
          400,
          "invalid_request",
          "A repository is required",
        );
      }
      const { project: invitedProject } = await authorizeRepository(
        gw.options.store,
        principal,
        invitedProjectId,
        repositoryId,
        "manage_members",
      );
      // And the repository has to live under the organization the path
      // named, or an owner-grant holder could mint invitations for a
      // foreign repository under an organization they do administer.
      if (invitedProject.organizationId !== organizationId) {
        throw new HttpError(
          404,
          "not_found",
          "Repository was not found in that project",
        );
      }
      // Deliberately no "already a member" refusal. That check belonged to
      // the organization-wide invitation, where a second one would have
      // added nothing; a repository grant is worth offering to someone who
      // is already in the organization but cannot reach this repository.
      const id =
        invitationCode === undefined
          ? `inv_${randomBytes(9).toString("base64url")}`
          : invitationIdForCode(invitationCode);
      if (
        invitationCode !== undefined &&
        (await gw.options.store.getInvitation(id)) !== undefined
      ) {
        throw new HttpError(
          409,
          "invitation_code_unavailable",
          "That invite name is already in use",
        );
      }
      const secret =
        invitationCode ?? randomBytes(32).toString("base64url");
      const now = new Date();
      const invitation = {
        id,
        organizationId,
        repositoryId,
        email,
        role,
        secretHash: hashSecret(secret),
        invitedBy: principal.user.id,
        // A link from whoever runs the deployment, to one repository, is
        // free use of that repository. Both halves are required: only an
        // operator may give access away, and only a repository-scoped
        // invitation is narrow enough to give. An organization-wide link
        // would be handing over every repository the organization has,
        // including ones that do not exist yet, so it is never comped.
        //
        // Settled here rather than at acceptance so the answer cannot change
        // under the recipient between clicking and joining.
        comped: principal.user.systemAdmin && repositoryId !== undefined,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + INVITATION_TTL_MS,
        ).toISOString(),
        acceptedAt: undefined,
        acceptedBy: undefined,
        revokedAt: undefined,
      };
      await gw.options.store.createInvitation(invitation);
      await gw.options.store.appendAudit(undefined, {
        type: "membership_changed",
        data: {
          organizationId,
          email,
          role,
          // Worth telling apart in the record: one act of sharing that can
          // become any number of members.
          ...(email === "" ? { openLink: true } : {}),
          action: "invited",
          actorId: principal.user.id,
        },
      });
      // The only time the secret exists in a response. It is not stored in
      // recoverable form, so a lost link is reissued rather than looked up.
      gw.sendJson(response, 201, {
        invitation: publicInvitation(invitation),
        token: invitationCode ?? `${id}.${secret}`,
      });
      return true;
    }
  }

  const invitationMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/organizations/([^/]+)/invitations/([^/]+)$`,
      "u",
    ),
  );
  if (invitationMatch !== undefined && method === "DELETE") {
    const [organizationId = "", invitationId = ""] = invitationMatch;
    await authorizeOrganization(
      gw.options.store,
      principal,
      organizationId,
      "manage_members",
    );
    const found = await gw.options.store.getInvitation(invitationId);
    if (found === undefined || found.organizationId !== organizationId) {
      throw new HttpError(404, "not_found", "Invitation was not found");
    }
    await gw.options.store.revokeInvitation(
      invitationId,
      new Date().toISOString(),
    );
    gw.sendJson(response, 200, { revoked: true });
    return true;
  }

  const membersMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/organizations/([^/]+)/members$`, "u"),
  );
  if (membersMatch !== undefined) {
    const organizationId = membersMatch[0] ?? "";
    const authorized = await authorizeOrganization(
      gw.options.store,
      principal,
      organizationId,
      method === "GET" ? "view" : "manage_members",
    );
    if (method === "GET") {
      const memberships = await gw.options.store.listMemberships(
        organizationId,
      );
      const users = await Promise.all(
        memberships.map(
          async (membership) =>
            await gw.options.store.getUser(membership.userId),
        ),
      );
      gw.sendJson(response, 200, {
        members: memberships.map((membership, index) => ({
          ...membership,
          user:
            users[index] === undefined
              ? undefined
              : publicUser(users[index]),
        })),
      });
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const role = stringField(body["role"], "role", { max: 20 }) as
        | OrganizationRole
        | undefined;
      if (role === undefined || !ROLES.includes(role)) {
        throw new HttpError(400, "invalid_role", "Role is invalid");
      }
      if (!canAssignRole(authorized.role, role)) {
        throw new HttpError(403, "forbidden", "You cannot assign that role");
      }
      const userId = stringField(body["userId"], "userId", {
        max: 128,
        optional: true,
      });
      const email = emailField(body["email"], { optional: true });
      const user =
        userId === undefined
          ? email === undefined
            ? undefined
            : await gw.options.store.getUserByEmail(email)
          : await gw.options.store.getUser(userId);
      if (user === undefined) {
        throw new HttpError(404, "user_not_found", "User was not found");
      }
      const membership = await gw.options.store.saveMembership({
        organizationId,
        userId: user.id,
        role,
      });
      // The PATCH and DELETE routes below have always synced; adding
      // somebody never did, which is the commonest of the three.
      await gw.syncSeatQuantity(organizationId);
      await gw.options.store.appendAudit(undefined, {
        type: "membership_changed",
        data: {
          organizationId,
          userId: user.id,
          role,
          action: "saved",
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 201, { membership, user: publicUser(user) });
      return true;
    }
  }

  const memberMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/organizations/([^/]+)/members/([^/]+)$`,
      "u",
    ),
  );
  if (memberMatch !== undefined) {
    const [organizationId = "", userId = ""] = memberMatch;
    const authorized = await authorizeOrganization(
      gw.options.store,
      principal,
      organizationId,
      "manage_members",
    );
    const current = await gw.options.store.getMembership(
      organizationId,
      userId,
    );
    if (current === undefined) {
      throw new HttpError(404, "not_found", "Membership was not found");
    }
    if (method === "PATCH") {
      const body = objectBody(await gw.readJson(request));
      const role = stringField(body["role"], "role", { max: 20 }) as
        | OrganizationRole
        | undefined;
      if (role === undefined || !ROLES.includes(role)) {
        throw new HttpError(400, "invalid_role", "Role is invalid");
      }
      if (!canAssignRole(authorized.role, role)) {
        throw new HttpError(403, "forbidden", "You cannot assign that role");
      }
      if (current.role === "owner" && role !== "owner") {
        const owners = (
          await gw.options.store.listMemberships(organizationId)
        ).filter((membership) => membership.role === "owner");
        if (owners.length <= 1) {
          throw new HttpError(
            409,
            "last_owner",
            "The last organization owner cannot be demoted",
          );
        }
      }
      const membership = await gw.options.store.saveMembership({
        organizationId,
        userId,
        role,
      });
      await gw.options.store.appendAudit(undefined, {
        type: "membership_changed",
        data: {
          organizationId,
          userId,
          role,
          action: "updated",
          actorId: principal.user.id,
        },
      });
      // A promotion from viewer to developer is a seat starting to cost
      // money, and a demotion is one stopping.
      await gw.syncSeatQuantity(organizationId);
      gw.sendJson(response, 200, { membership });
      return true;
    }
    if (method === "DELETE") {
      const owners = (
        await gw.options.store.listMemberships(organizationId)
      ).filter((membership) => membership.role === "owner");
      if (current.role === "owner" && owners.length <= 1) {
        throw new HttpError(
          409,
          "last_owner",
          "The last organization owner cannot be removed",
        );
      }
      await gw.options.store.removeMembership(organizationId, userId);
      await gw.syncSeatQuantity(organizationId);
      await gw.options.store.appendAudit(undefined, {
        type: "membership_changed",
        data: {
          organizationId,
          userId,
          action: "removed",
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, { removed: true });
      return true;
    }
  }

  return false;
}
