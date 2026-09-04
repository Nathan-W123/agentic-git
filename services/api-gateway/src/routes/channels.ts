/**
 * The rooms themselves.
 *
 * Creating a sub-channel, its visibility, and who is in it. What is *said*
 * in one is the next module.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import {
  GENERAL_SUB_CHANNEL_SLUG,
  type SubChannel,
  type SubChannelVisibility,
} from "@coord/persistence";
import {
  authorizeRepository,
} from "../authorization.js";
import {
  HttpError,
  objectBody,
  stringField,
} from "../field-validation.js";
import {
  matchPath,
  subChannelSlug,
  subChannelVisibility,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

export async function routeChannels(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  // ---- Repository group channel ------------------------------------------
  // One shared room per repository, with every human and agent working it
  // as a participant — the server side of what `apps/web/public/data.js`
  // produced entirely in browser state before this existed. `view` is the
  // permission for every route here, read and write alike: being able to
  // see a repository is being in the room, the same way a Slack channel
  // does not gate typing behind a stricter right than reading.
  //
  // Posting as an agent or the coordinator is deliberately not exposed yet.
  // The store methods accept a `kind` and an arbitrary `authorId` so a
  // future agent-runtime writer can use them directly, but this HTTP
  // surface only ever writes `kind: "user"` with the caller's own id, so a
  // signed-in person can never post a message that impersonates someone
  // else's agent.
  // The sub-channels inside one repository, and their administration.
  //
  // `/channels` rather than `/channel/...`: this is the list of rooms, not
  // something inside one, and keeping it off the `/channel/` prefix means
  // no existing route has to grow a special case for a path segment that
  // would otherwise look like a message id.
  const subChannelsMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channels$`,
      "u",
    ),
  );
  if (subChannelsMatch !== undefined) {
    const [projectId = "", repositoryId = ""] = subChannelsMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      method === "GET" ? "view" : "manage_project",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    // Every repository has a `#general`, including one created before
    // sub-channels existed and one created since. Asked for here so the
    // list is never empty and the browser always has somewhere to open.
    await gw.options.store.ensureGeneralSubChannel(repositoryId, projectId);
    if (method === "GET") {
      const channels = await gw.options.store.listSubChannels(repositoryId);
      const admin = await authorizeRepository(
        gw.options.store,
        principal,
        projectId,
        repositoryId,
        "manage_project",
      ).then(
        () => true,
        () => false,
      );
      // Every room's unread count for this caller in one query, so the
      // sidebar can draw a badge per room without a request per badge.
      const unread = await gw.options.store.countUnreadByChannel(
        repositoryId,
        principal.user.id,
      );
      const visible: Array<
        SubChannel & { member: boolean; canPost: boolean; unread: number }
      > = [];
      for (const channel of channels) {
        const member =
          channel.slug === GENERAL_SUB_CHANNEL_SLUG ||
          (await gw.options.store.isSubChannelMember(
            channel.id,
            principal.user.id,
          ));
        // A private room the caller is not in is simply absent — not
        // listed-but-locked, which would disclose that it exists and what
        // it is called. An admin sees everything, because administering
        // them is their job.
        if (channel.visibility === "private" && !member && !admin) {
          continue;
        }
        visible.push({
          ...channel,
          member,
          // The same rule `canPostInSubChannel` enforces on the write path.
          // Derived here rather than asked per row: the answer is already in
          // hand, and a list that disagreed with the write would show a
          // composer that 403s.
          canPost:
            member ||
            channel.visibility === "public" ||
            // Redundant since #general is stored `public`, and kept because
            // a database restored from before that migration would other-
            // wise make the room every project has read-only for everybody.
            channel.slug === GENERAL_SUB_CHANNEL_SLUG,
          // How much of this room the caller has not read. Zero rather than
          // absent, so the browser never has to tell "no badge" apart from
          // "the server did not say".
          unread: unread[channel.id] ?? 0,
        });
      }
      gw.sendJson(response, 200, { channels: visible, canManage: admin });
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const slug = subChannelSlug(
        stringField(body["slug"] ?? body["name"], "name", {
          min: 1,
          max: 60,
        }) ?? "",
      );
      if (slug.length === 0) {
        throw new HttpError(
          400,
          "invalid_request",
          "A channel name must contain a letter or a number",
        );
      }
      const visibility = subChannelVisibility(body["visibility"]);
      const name = stringField(body["name"], "name", { max: 60 });
      const existing = (
        await gw.options.store.listSubChannels(repositoryId)
      ).find((channel) => channel.slug === slug);
      if (existing !== undefined) {
        throw new HttpError(
          409,
          "channel_exists",
          "A channel with that name already exists",
        );
      }
      const channel = await gw.options.store.createSubChannel({
        repositoryId,
        projectId,
        slug,
        ...(name === undefined ? {} : { name }),
        visibility,
        createdBy: principal.user.id,
      });
      // Whoever made the room is in it, so a private channel is never
      // created into a state where nobody — including its author — can
      // read or post in it.
      await gw.options.store.setSubChannelMember(
        channel.id,
        principal.user.id,
        true,
      );
      await gw.options.store.appendAudit(undefined, {
        type: "channel_created",
        data: {
          projectId,
          repositoryId,
          channelId: channel.id,
          slug: channel.slug,
          visibility: channel.visibility,
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 201, {
        channel: { ...channel, member: true, canPost: true },
      });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "Unsupported method");
  }

  const subChannelMemberMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channels/([^/]+)/members(?:/([^/]+))?$`,
      "u",
    ),
  );
  if (subChannelMemberMatch !== undefined) {
    const [projectId = "", repositoryId = "", channelId = "", memberId] =
      subChannelMemberMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      method === "GET" ? "view" : "manage_project",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const channel = await gw.authorizeSubChannel({
      projectId,
      repositoryId,
      channelId,
      principal,
    });
    if (method === "GET") {
      const members = await gw.options.store.listSubChannelMembers(
        channel.id,
      );
      gw.sendJson(response, 200, { members });
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const userId =
        stringField(body["userId"], "userId", { min: 1, max: 200 }) ?? "";
      await gw.options.store.setSubChannelMember(channel.id, userId, true);
      await gw.options.store.appendAudit(undefined, {
        type: "channel_member_changed",
        data: {
          projectId,
          repositoryId,
          channelId: channel.id,
          userId,
          isMember: true,
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, { member: true });
      return true;
    }
    if (method === "DELETE") {
      const userId = memberId ?? "";
      await gw.options.store.setSubChannelMember(channel.id, userId, false);
      await gw.options.store.appendAudit(undefined, {
        type: "channel_member_changed",
        data: {
          projectId,
          repositoryId,
          channelId: channel.id,
          userId,
          isMember: false,
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, { member: false });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "Unsupported method");
  }

  const subChannelMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channels/([^/]+)$`,
      "u",
    ),
  );
  if (
    subChannelMatch !== undefined &&
    (method === "PATCH" || method === "DELETE")
  ) {
    const [projectId = "", repositoryId = "", channelId = ""] =
      subChannelMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "manage_project",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const channel = await gw.authorizeSubChannel({
      projectId,
      repositoryId,
      channelId,
      principal,
    });
    if (method === "DELETE") {
      if (channel.slug === GENERAL_SUB_CHANNEL_SLUG) {
        throw new HttpError(
          409,
          "general_channel",
          "The #general channel cannot be deleted",
        );
      }
      await gw.options.store.deleteSubChannel(repositoryId, channel.id);
      await gw.options.store.appendAudit(undefined, {
        type: "channel_deleted",
        data: {
          projectId,
          repositoryId,
          channelId: channel.id,
          slug: channel.slug,
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, { removed: true });
      return true;
    }
    const body = objectBody(await gw.readJson(request));
    // Optional, because this route patches: a request that changes only a
    // room's visibility sends no name, and without this it was refused with
    // "name must be a string" before it reached the store. Changing a
    // channel from private to open could not work at all.
    const rawName = stringField(body["name"] ?? body["slug"], "name", {
      max: 60,
      optional: true,
    });
    const update: {
      slug?: string;
      name?: string;
      visibility?: SubChannelVisibility;
    } = {};
    if (rawName !== undefined) {
      const slug = subChannelSlug(rawName);
      if (slug.length === 0) {
        throw new HttpError(
          400,
          "invalid_request",
          "A channel name must contain a letter or a number",
        );
      }
      if (
        slug !== channel.slug &&
        (await gw.options.store.listSubChannels(repositoryId)).some(
          (other) => other.id !== channel.id && other.slug === slug,
        )
      ) {
        throw new HttpError(
          409,
          "channel_exists",
          "A channel with that name already exists",
        );
      }
      update.slug = slug;
      update.name = slug;
    }
    if (body["visibility"] !== undefined) {
      // `#general` is the room every project member is in and the one every
      // unaddressed message falls back to. Making it private would hide the
      // repository's whole history from everybody who is not on a member
      // list that has never existed.
      if (channel.slug === GENERAL_SUB_CHANNEL_SLUG) {
        throw new HttpError(
          409,
          "general_channel",
          "The #general channel is always open to the project",
        );
      }
      update.visibility = subChannelVisibility(body["visibility"]);
    }
    const updated = await gw.options.store.updateSubChannel(
      repositoryId,
      channel.id,
      update,
    );
    await gw.options.store.appendAudit(undefined, {
      type: "channel_updated",
      data: {
        projectId,
        repositoryId,
        channelId: channel.id,
        slug: updated.slug,
        visibility: updated.visibility,
        actorId: principal.user.id,
      },
    });
    gw.sendJson(response, 200, { channel: updated });
    return true;
  }

  return false;
}
