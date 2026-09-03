/**
 * Repositories, their GitHub connection, and who is granted them.
 *
 * Creating, renaming and deleting a repository, syncing and pushing it, and
 * the grants that decide who sees it at all.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import type {
  OrganizationRole,
} from "@coord/persistence";
import {
  authorizeProject,
  authorizeRepository,
} from "../authorization.js";
import {
  HttpError,
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
import {
  REPOSITORY_PICTURE_MAX_CHARS,
  ROLES,
} from "../gateway-util.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

export async function routeRepositories(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  const agentsMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/agents$`, "u"),
  );
  if (agentsMatch !== undefined && method === "GET") {
    await authorizeProject(
      gw.options.store,
      principal,
      agentsMatch[0] ?? "",
      "view",
    );
    gw.sendJson(response, 200, {
      agents: (await gw.options.operations.listAgents?.()) ?? [],
    });
    return true;
  }

  const repositoriesMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/repositories$`, "u"),
  );
  if (repositoriesMatch !== undefined && method === "GET") {
    const projectId = repositoriesMatch[0] ?? "";
    const { repositories } = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "view",
    );
    const all = await gw.options.store.listProjectRepositories(projectId);
    gw.sendJson(response, 200, {
      // Somebody holding a grant sees the repositories they were granted and
      // no others: this list is how the interface learns what exists, so
      // returning everything here would defeat the grant regardless of what
      // the per-repository routes enforce.
      repositories:
        repositories === undefined
          ? all
          : all.filter((entry) => repositories.has(entry.id)),
    });
    return true;
  }
  if (repositoriesMatch !== undefined && method === "POST") {
    const projectId = repositoriesMatch[0] ?? "";
    const { project } = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "import_repository",
    );
    const body = objectBody(await gw.readJson(request));
    const branch = stringField(body["branch"], "branch", {
      max: 240,
      optional: true,
    });
    const repository = await gw.performOperation(
      "repository_creation_failed",
      async () =>
        await gw.options.operations.createRepository({
          projectId,
          id: stringField(body["id"], "id", { max: 80 }) ?? "",
          ...(branch === undefined ? {} : { branch }),
          actorId: principal.user.id,
        }),
    );
    await gw.markChannelMembershipChosen(repository.id);
    await gw.options.store.appendAudit(undefined, {
      type: "repository_created",
      data: {
        organizationId: project.organizationId,
        projectId,
        repositoryId: repository.id,
        branch: repository.branch,
        actorId: principal.user.id,
      },
    });
    gw.sendJson(response, 201, { repository });
    return true;
  }

  const githubMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/github$`,
      "u",
    ),
  );
  if (githubMatch !== undefined && method === "POST") {
    const projectId = githubMatch[0] ?? "";
    const { project } = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "import_repository",
    );
    const body = objectBody(await gw.readJson(request));
    const id = stringField(body["id"], "id", {
      max: 80,
      optional: true,
    });
    const branch = stringField(body["branch"], "branch", {
      max: 240,
      optional: true,
    });
    const token = stringField(body["token"], "token", {
      max: 1_024,
      optional: true,
    });
    const repository = await gw.performOperation(
      "repository_import_failed",
      async () =>
        await gw.options.operations.importGitHub({
          projectId,
          repository:
            stringField(body["repository"], "repository", { max: 500 }) ?? "",
          ...(id === undefined ? {} : { id }),
          ...(branch === undefined ? {} : { branch }),
          ...(token === undefined ? {} : { token }),
          actorId: principal.user.id,
        }),
    );
    await gw.markChannelMembershipChosen(repository.id);
    await gw.options.store.appendAudit(undefined, {
      type: "repository_imported",
      data: {
        organizationId: project.organizationId,
        projectId,
        repositoryId: repository.id,
        provider: "github",
        actorId: principal.user.id,
      },
    });
    gw.sendJson(response, 201, { repository });
    return true;
  }

  // Syncing a repository from its GitHub origin. The same gate as import,
  // because it is the same kind of act — repository management, moving the
  // mirror rather than working inside it. The caller's own stored GitHub
  // token authenticates the fetch when they have one; the operation itself
  // writes the `repository_synced` audit record.
  const syncMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/sync$`,
      "u",
    ),
  );
  if (syncMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = ""] = syncMatch;
    // The repository, not just the project it was claimed under.
    //
    // `authorizeProject` cannot see a repository id, and the id in the path
    // was then handed to the operation unchecked — which resolves it
    // globally, so naming somebody else's repository under a project of
    // your own reached it. The sibling `/push` route immediately below has
    // always done both halves; this one did neither.
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "import_repository",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const syncRepository = gw.options.operations.syncRepository;
    if (syncRepository === undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment does not support syncing from a remote",
      );
    }
    const body = objectBody(await gw.readJson(request));
    const resolve = stringField(body["resolve"], "resolve", {
      max: 20,
      optional: true,
    });
    if (
      resolve !== undefined &&
      !["refuse", "prefer-remote", "prefer-local"].includes(resolve)
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        "resolve must be refuse, prefer-remote, or prefer-local",
      );
    }
    let synced;
    try {
      synced = await syncRepository({
        projectId,
        repositoryId,
        actorId: principal.user.id,
        ...(resolve === undefined
          ? {}
          : {
              conflictResolution: resolve as
                | "refuse"
                | "prefer-remote"
                | "prefer-local",
            }),
      });
    } catch (error) {
      // A collision is not a malfunction: it is a question for the person
      // who asked, and the screen can only offer them the choice if the
      // refusal is distinguishable from a sync that actually broke.
      if ((error as { name?: unknown }).name === "SyncDivergedError") {
        throw new HttpError(
          409,
          "sync_conflict",
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    gw.sendJson(response, 200, { sync: synced });
    return true;
  }

  // Resumes a `/push` after its conflict dialog has synchronized the two
  // histories. The original command message is already in the channel, so
  // this route performs only the operation and its answer; making the
  // browser post `/push` a second time would leave a duplicate command in
  // the conversation. A thread id preserves where that answer belongs when
  // the command was typed inside a task thread.
  const pushMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/push$`,
      "u",
    ),
  );
  if (pushMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = ""] = pushMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "view",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const operation = gw.options.operations.pushRepository;
    if (operation === undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment cannot push repositories from the channel",
      );
    }
    const body = objectBody(await gw.readJson(request));
    const messageId = stringField(body["messageId"], "messageId", {
      max: 200,
      optional: true,
    });
    const pushed = await operation({
      projectId,
      repositoryId,
      actorId: principal.user.id,
    });
    // A second upstream race can ask the question again. Do not turn that
    // into the error line this route exists to replace; the browser will
    // reopen the choice from the structured result.
    if (pushed.detail?.syncConflict !== true) {
      if (messageId === undefined) {
        await gw.postChannelSystemMessage(
          projectId,
          repositoryId,
          pushed.explanation,
        );
      } else {
        await gw.sayThreadIsUnanswered(
          { projectId, repositoryId, messageId },
          pushed.explanation,
        );
      }
    }
    gw.sendJson(response, 200, { push: pushed });
    return true;
  }

  // Deleting a repository. Ownership, and nothing weaker: an organization
  // owner, or somebody holding an `owner` grant on this repository — the
  // co-owner the People row promotes. Administrators and the repository's
  // own creator can still rename it and manage its grants, but deletion
  // takes everyone else's work with it, so it is not theirs to do. See
  // `authorizeRepositoryDeletion`.
  //
  // Everything scoped to the repository is cascade-deleted by
  // `removeRepository` — the shared channel, the grants, and the execution
  // history: queue, runs, approvals, leases. Runs and submitted tasks used
  // to refuse the call outright, which in production meant a repository
  // that had ever done work could not be deleted at all; see that method's
  // doc comment in `@coord/persistence`. A failure here is therefore a real
  // failure, and surfaces as an ordinary thrown error from
  // `performOperation` like any other.
  const repositoryMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)$`,
      "u",
    ),
  );
  if (repositoryMatch !== undefined && method === "DELETE") {
    const [projectId = "", repositoryId = ""] = repositoryMatch;
    const repository = await gw.authorizeRepositoryDeletion(
      principal,
      projectId,
      repositoryId,
    );
    await gw.performOperation("repository_deletion_failed", async () => {
      if (gw.options.operations.deleteRepository === undefined) {
        await gw.options.store.removeRepository(repositoryId);
        return;
      }
      await gw.options.operations.deleteRepository({
        projectId,
        repositoryId,
        actorId: principal.user.id,
      });
    });
    await gw.options.store.appendAudit(undefined, {
      type: "repository_deleted",
      data: {
        projectId,
        repositoryId,
        createdBy: repository.createdBy,
        actorId: principal.user.id,
      },
    });
    gw.sendJson(response, 200, { removed: true });
    return true;
  }

  // Renaming a repository. Only what it is *called* changes: the id stays
  // the key every row and the mirror directory on disk are addressed by,
  // so a rename here can never orphan history the way changing the id
  // would. Gated exactly as deletion is — `manage_project` through the
  // ordinary pipeline, or the repository's own creator.
  //
  // An empty name is a clear rather than an error: it puts the repository
  // back to being called by its id, which is the only way to undo a rename
  // without inventing the old name again.
  if (repositoryMatch !== undefined && method === "PATCH") {
    const [projectId = "", repositoryId = ""] = repositoryMatch;
    await gw.authorizeRepositoryOwnerAction(
      principal,
      projectId,
      repositoryId,
      "manage_project",
    );
    const body = objectBody(await gw.readJson(request));
    // `min: 0` because clearing is expressed as an empty name rather than
    // as a second route; anything else is still validated and trimmed.
    const requested = stringField(body["name"], "name", { min: 0, max: 80 });
    const displayName =
      requested === undefined || requested === "" ? undefined : requested;
    await gw.options.store.renameRepository(repositoryId, displayName);
    await gw.options.store.appendAudit(undefined, {
      type: "repository_renamed",
      data: {
        projectId,
        repositoryId,
        ...(displayName === undefined ? {} : { displayName }),
        actorId: principal.user.id,
      },
    });
    const repository = await gw.options.store.getRepository(repositoryId);
    gw.sendJson(response, 200, { repository });
    return true;
  }

  // Repository-scoped grants: promoting an existing organization member to
  // full capabilities on *this one repository* ("co-owner"), without
  // touching their organization-wide role. Gated the same way deletion is —
  // `manage_members` through the ordinary pipeline, or the repository's
  // creator.
  //
  // No "last owner" guard, unlike organization membership: an organization
  // role always confers blanket access to every repository it owns (see
  // `repository-grants`'s migration comment), so as long as the
  // organization retains an owner or admin, revoking every grant on a
  // repository — including the creator's own, if they hold one — can never
  // leave it with nobody able to reach it. The creator's own administrative
  // access does not even depend on holding a grant; it comes from
  // `createdBy`, which revoking a grant never touches.
  // The workspace picture. A room's picture, not a reader's: everybody who
  // opens this repository is drawn the same one, which is the whole reason
  // it moved off `localStorage`.
  //
  // Its own route rather than a field on the rename PATCH above, because
  // that route reads an absent `name` as "clear the name" — folding the
  // picture in would mean anyone changing a picture had to restate the name
  // to keep it. Gated identically: `manage_project`, or the creator.
  //
  // An absent or empty `picture` clears it, matching how rename expresses
  // clearing, and puts the workspace back to its initials.
  const repositoryPictureMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/picture$`,
      "u",
    ),
  );
  if (repositoryPictureMatch !== undefined && method === "PUT") {
    const [projectId = "", repositoryId = ""] = repositoryPictureMatch;
    await gw.authorizeRepositoryOwnerAction(
      principal,
      projectId,
      repositoryId,
      "manage_project",
    );
    const body = objectBody(await gw.readJson(request));
    const requested = stringField(body["picture"], "picture", {
      min: 0,
      max: REPOSITORY_PICTURE_MAX_CHARS,
      optional: true,
    });
    // Required to be an image `data:` URL. The client resizes to a 128px
    // square JPEG before sending, so anything else here is either a caller
    // that skipped that step or one aiming a URL of its own choosing at
    // every colleague's `<img src>`; neither is a picture.
    if (
      requested !== undefined &&
      requested !== "" &&
      !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(
        requested,
      )
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        "picture must be a base64 image data URL",
      );
    }
    const picture =
      requested === undefined || requested === "" ? undefined : requested;
    await gw.options.store.setRepositoryPicture(repositoryId, picture);
    await gw.options.store.appendAudit(undefined, {
      type: "repository_picture_changed",
      data: {
        projectId,
        repositoryId,
        cleared: picture === undefined,
        actorId: principal.user.id,
      },
    });
    const repository = await gw.options.store.getRepository(repositoryId);
    gw.sendJson(response, 200, { repository });
    return true;
  }

  const repositoryGrantsMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/grants$`,
      "u",
    ),
  );
  if (repositoryGrantsMatch !== undefined && method === "GET") {
    const [projectId = "", repositoryId = ""] = repositoryGrantsMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "view",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const grants = await gw.options.store.listRepositoryGrants(repositoryId);
    const users = await Promise.all(
      grants.map((grant) => gw.options.store.getUser(grant.userId)),
    );
    gw.sendJson(response, 200, {
      grants: grants.map((grant, index) => ({
        ...grant,
        user: users[index] === undefined ? undefined : publicUser(users[index]!),
      })),
    });
    return true;
  }

  const repositoryGrantMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/grants/([^/]+)$`,
      "u",
    ),
  );
  if (repositoryGrantMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = "", userId = ""] =
      repositoryGrantMatch;
    await gw.authorizeRepositoryOwnerAction(
      principal,
      projectId,
      repositoryId,
      "manage_members",
    );
    const body = objectBody(await gw.readJson(request));
    const role = stringField(body["role"], "role", { max: 20 }) as
      | OrganizationRole
      | undefined;
    if (role === undefined || !ROLES.includes(role)) {
      throw new HttpError(400, "invalid_role", "Role is invalid");
    }
    const user = await gw.options.store.getUser(userId);
    if (user === undefined) {
      throw new HttpError(404, "user_not_found", "User was not found");
    }
    const project = await gw.options.store.getProject(projectId);
    const [membership, existingGrants] = await Promise.all([
      project === undefined
        ? undefined
        : gw.options.store.getMembership(project.organizationId, userId),
      gw.options.store.listRepositoryGrants(repositoryId),
    ]);
    // People invited to only this repository intentionally have no
    // organization membership. They are still valid promotion targets once
    // their existing grant puts them in this repository's People list. Keep
    // rejecting unrelated accounts so knowing a user id cannot itself grant
    // access.
    if (
      membership === undefined &&
      !existingGrants.some((grant) => grant.userId === userId)
    ) {
      throw new HttpError(
        404,
        "not_found",
        "That user is not a member of this organization",
      );
    }
    await gw.options.store.saveRepositoryGrant({
      repositoryId,
      userId,
      role,
      grantedBy: principal.user.id,
      // Sharing a repository with a colleague is an ordinary paid seat. Only
      // an operator's invitation link gives access away.
      comped: false,
      createdAt: new Date().toISOString(),
    });
    // It says so directly above: an ordinary paid seat. It was never billed.
    await gw.syncSeatQuantity(project?.organizationId ?? "");
    await gw.options.store.appendAudit(undefined, {
      type: "membership_changed",
      data: {
        organizationId: project?.organizationId,
        projectId,
        repositoryId,
        userId,
        role,
        action: "grant_saved",
        actorId: principal.user.id,
      },
    });
    gw.sendJson(response, 200, { grant: { repositoryId, userId, role } });
    return true;
  }
  if (repositoryGrantMatch !== undefined && method === "DELETE") {
    const [projectId = "", repositoryId = "", userId = ""] =
      repositoryGrantMatch;
    const isSelf = userId === principal.user.id;
    if (isSelf) {
      // Leaving a repository one holds only through a grant. Anyone who can
      // reach the repository at all may remove their own access — this is
      // not a moderation action.
      const authorized = await authorizeRepository(
        gw.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      if (
        !(await gw.options.store.projectHasRepository(
          projectId,
          repositoryId,
        ))
      ) {
        throw new HttpError(404, "not_found", "Repository was not found");
      }
      if (authorized.repositories === undefined) {
        // Reached through an organization role, which reaches every
        // repository the organization owns — there is no per-repository
        // "leave" for that; it would either do nothing or be surprising.
        throw new HttpError(
          409,
          "org_membership_reaches_repository",
          "Your access here comes from an organization-wide role, not a grant on this repository — leave the organization, or ask an admin to change your role, to lose access.",
        );
      }
      const existing = (
        await gw.options.store.listRepositoryGrants(repositoryId)
      ).find((grant) => grant.userId === userId);
      if (existing === undefined) {
        throw new HttpError(404, "not_found", "You do not hold a grant on this repository");
      }
      await gw.options.store.removeRepositoryGrant(repositoryId, userId);
      // A revoked seat kept being invoiced until something else
      // happened to resync — which for a steady team is never.
      await gw.syncSeatQuantity(
        (await gw.options.store.getProject(projectId))?.organizationId ?? "",
      );
      await gw.options.store.appendAudit(undefined, {
        type: "membership_changed",
        data: {
          projectId,
          repositoryId,
          userId,
          action: "left",
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, { removed: true });
      return true;
    }
    // Revoking someone else's grant is moderation.
    await gw.authorizeRepositoryOwnerAction(
      principal,
      projectId,
      repositoryId,
      "manage_members",
    );
    const existing = (
      await gw.options.store.listRepositoryGrants(repositoryId)
    ).find((grant) => grant.userId === userId);
    if (existing === undefined) {
      throw new HttpError(404, "not_found", "That user does not hold a grant on this repository");
    }
    await gw.options.store.removeRepositoryGrant(repositoryId, userId);
    // A revoked seat kept being invoiced until something else
    // happened to resync — which for a steady team is never.
    await gw.syncSeatQuantity(
      (await gw.options.store.getProject(projectId))?.organizationId ?? "",
    );
    await gw.options.store.appendAudit(undefined, {
      type: "membership_changed",
      data: {
        projectId,
        repositoryId,
        userId,
        action: "revoked",
        actorId: principal.user.id,
      },
    });
    gw.sendJson(response, 200, { removed: true });
    return true;
  }

  return false;
}
