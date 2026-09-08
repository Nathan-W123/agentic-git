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
  channelBranchName,
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
            // A merged work channel is finished and its branch is gone; the
            // write path refuses it, and a list that said otherwise would
            // draw a composer that 403s.
            channel.mergedAt === undefined &&
            (member ||
              channel.visibility === "public" ||
              // Redundant since #general is stored `public`, and kept because
              // a database restored from before that migration would other-
              // wise make the room every project has read-only for everybody.
              channel.slug === GENERAL_SUB_CHANNEL_SLUG),
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
      // A work channel: its own branch, cut from the repository's, and every
      // task dispatched in it lands there instead of on canonical. Opt-in per
      // channel, because most rooms are conversations and a branch for one
      // would be a branch nothing ever commits to.
      const wantsBranch = body["branch"] === true;
      const operations = gw.options.operations;
      if (wantsBranch && operations.createBranch === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment cannot create branches",
        );
      }
      const branch = wantsBranch ? channelBranchName(slug) : undefined;
      if (branch !== undefined) {
        // Created before the channel is stored, because git's own
        // compare-and-swap is the only thing here that can settle two people
        // creating the same work channel at once: `ensureBranch` writes with
        // an explicit old value of the zero object, so exactly one of them
        // creates it and the other is told.
        const { created } = await gw.performOperation(
          "branch_failed",
          async () =>
            await operations.createBranch!({
              projectId,
              repositoryId,
              branch,
            }),
        );
        if (!created) {
          // Never adopted. A branch that is already there has commits on it
          // that nobody in this channel reviewed, and adopting it would put
          // them inside this channel's pull request as though they were its
          // work.
          throw new HttpError(
            409,
            "branch_exists",
            `The branch ${branch} already exists. Pick another name.`,
          );
        }
      }
      let channel: SubChannel;
      try {
        channel = await gw.options.store.createSubChannel({
          repositoryId,
          projectId,
          slug,
          ...(name === undefined ? {} : { name }),
          visibility,
          createdBy: principal.user.id,
          ...(branch === undefined ? {} : { branch }),
        });
      } catch (error) {
        // The branch was created a moment ago and nothing has been told about
        // it, so dropping it loses nothing. Leaving it would leave a branch
        // no channel owns and a name the next attempt could not reuse.
        if (branch !== undefined) {
          await operations.deleteBranch?.({
            projectId,
            repositoryId,
            branch,
          }).catch(() => undefined);
        }
        throw error;
      }
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

  // ---- The pull request a work channel is ---------------------------------
  // A work channel is a branch, so it is already the unit a pull request
  // describes: the conversation, the tasks, the diff and the merge are one
  // thing rather than a thread over here and a review over there. These three
  // routes are the whole of it — what the branch has, bringing the
  // repository's own branch into it, and landing it.
  const branchMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channels/([^/]+)/branch(?:/(refresh|merge|ship))?$`,
      "u",
    ),
  );
  if (branchMatch !== undefined) {
    const [projectId = "", repositoryId = "", channelId = "", verb] =
      branchMatch;
    const permission =
      verb === undefined
        ? "view"
        : // Landing on canonical is the most consequential write in the
          // system, and `review` is the permission that says so by name.
          // Shipping asks a second set of reviewers, on GitHub, to take work
          // Kumi has already accepted — the same weight, and it publishes
          // under the caller's own GitHub account. Bringing canonical *into*
          // a channel touches only that channel's own branch, so it is work,
          // and anybody who can do work here may.
          verb === "merge" || verb === "ship"
          ? "review"
          : "submit_task";
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      permission,
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
    const branch = channel.branch;
    if (branch === undefined) {
      throw new HttpError(
        409,
        "not_a_branch",
        `#${channel.slug} is a conversation, not a branch. Work said here ` +
          "lands on the repository's own branch.",
      );
    }
    const operations = gw.options.operations;
    if (
      operations.branchComparison === undefined ||
      operations.mergeBranch === undefined ||
      operations.refreshBranch === undefined
    ) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment cannot read or merge branches",
      );
    }

    // Shipping happens after the merge, not instead of it: Kumi reviews the
    // branch into canonical, and GitHub reviews canonical into main. So this
    // is the one verb a merged channel still answers, and the one an
    // unmerged channel does not.
    if (verb === "ship") {
      if (channel.mergedAt === undefined) {
        throw new HttpError(
          409,
          "not_merged",
          `#${channel.slug} has not merged yet. Kumi reviews it into the ` +
            "repository first, then GitHub reviews that.",
        );
      }
      if (operations.shipChannel === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment cannot ship to GitHub",
        );
      }
      if (method !== "POST") {
        throw new HttpError(405, "method_not_allowed", "Unsupported method");
      }
      const shipped = await gw.performOperation(
        "ship_failed",
        async () =>
          await operations.shipChannel!({
            projectId,
            repositoryId,
            actorId: principal.user.id,
            branch,
            title: `#${channel.slug}`,
            body:
              `Merged from Kumi's \`${branch}\`, reviewed in the ` +
              `#${channel.slug} channel.`,
          }),
      );
      // Recorded only on success. A channel marked shipped whose pull request
      // was never opened is a channel that has stopped asking for the one
      // thing it still needs.
      const url = shipped.detail?.url;
      if (shipped.outcome === "done" && url !== undefined) {
        await gw.options.store.shipSubChannel(repositoryId, channel.id, {
          pullRequestUrl: url,
          shippedAt: new Date().toISOString(),
        });
      }
      await gw.postChannelSystemMessage(
        projectId,
        repositoryId,
        shipped.explanation,
        channel.id,
      );
      await gw.options.store.appendAudit(undefined, {
        type: "channel_updated",
        data: {
          projectId,
          repositoryId,
          channelId: channel.id,
          slug: channel.slug,
          branch,
          shipped: shipped.outcome === "done",
          ...(url === undefined ? {} : { pullRequestUrl: url }),
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, shipped);
      return true;
    }

    // A merged channel is finished. Its branch is gone, so there is nothing
    // left to compare, refresh or merge — and answering anything but "this
    // landed" would describe a branch that no longer exists.
    if (channel.mergedAt !== undefined) {
      if (verb !== undefined) {
        throw new HttpError(
          409,
          "already_merged",
          `#${channel.slug} was already merged. Open a new channel for ` +
            "follow-up work.",
        );
      }
      gw.sendJson(response, 200, {
        branch,
        merged: true,
        mergedAt: channel.mergedAt,
        mergedBy: channel.mergedBy,
        // Where it went on GitHub, when it has been anywhere. Absent is a
        // channel that merged and has not shipped, which is the state the
        // review surface offers the Ship button in.
        ...(channel.pullRequestUrl === undefined
          ? {}
          : { pullRequestUrl: channel.pullRequestUrl }),
        ...(channel.shippedAt === undefined
          ? {}
          : { shippedAt: channel.shippedAt }),
        // The same derivation the unmerged read makes, for the same reason:
        // a Ship button drawn for somebody the server would refuse is worse
        // than one that was never drawn.
        canShip:
          operations.shipChannel !== undefined &&
          (await authorizeRepository(
            gw.options.store,
            principal,
            projectId,
            repositoryId,
            "review",
          ).then(
            () => true,
            () => false,
          )),
      });
      return true;
    }

    if (verb === undefined) {
      if (method !== "GET") {
        throw new HttpError(405, "method_not_allowed", "Unsupported method");
      }
      const comparison = await gw.performOperation(
        "branch_failed",
        async () =>
          await operations.branchComparison!({
            projectId,
            repositoryId,
            branch,
          }),
      );
      gw.sendJson(response, 200, {
        branch,
        merged: false,
        ...comparison,
        // Whether the person asking could land it themselves, so the browser
        // knows whether to draw the button. Derived rather than asked for
        // separately: the answer is already in hand, and a review surface
        // that offered a merge the server would refuse is worse than one that
        // never offered it.
        canMerge: await authorizeRepository(
          gw.options.store,
          principal,
          projectId,
          repositoryId,
          "review",
        ).then(
          () => true,
          () => false,
        ),
      });
      return true;
    }

    if (method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }

    if (verb === "refresh") {
      const refreshed = await gw.performOperation(
        "branch_failed",
        async () =>
          await operations.refreshBranch!({
            projectId,
            repositoryId,
            branch,
          }),
      );
      // Said in the room either way. A branch that caught up is worth one
      // line, and one that could not is the only warning anybody gets before
      // the merge refuses at the end for the same reason.
      await gw.postChannelSystemMessage(
        projectId,
        repositoryId,
        refreshed.merged
          ? `Brought the repository's latest into \`${branch}\`. Nothing ` +
            "conflicted."
          : `Could not bring the repository's latest into \`${branch}\`: ` +
            `${refreshed.conflicts.join(", ")} ${
              refreshed.conflicts.length === 1 ? "conflicts" : "conflict"
            }. Somebody has to resolve ${
              refreshed.conflicts.length === 1 ? "it" : "them"
            } before this can merge.`,
        channel.id,
      );
      await gw.options.store.appendAudit(undefined, {
        type: "channel_updated",
        data: {
          projectId,
          repositoryId,
          channelId: channel.id,
          slug: channel.slug,
          branch,
          refreshed: refreshed.merged,
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, refreshed);
      return true;
    }

    const merged = await gw.performOperation(
      "branch_failed",
      async () =>
        await operations.mergeBranch!({
          projectId,
          repositoryId,
          branch,
          message:
            `Merge #${channel.slug}\n\n` +
            `Work channel #${channel.slug}, merged from ${branch}.`,
        }),
    );
    if (!merged.merged) {
      await gw.postChannelSystemMessage(
        projectId,
        repositoryId,
        `\`${branch}\` cannot merge yet: ${merged.conflicts.join(", ")} ` +
          `${merged.conflicts.length === 1 ? "conflicts" : "conflict"} with ` +
          "the repository's own branch. Bring the latest in and resolve " +
          "them, then try again.",
        channel.id,
      );
      gw.sendJson(response, 409, {
        error: {
          code: "merge_conflict",
          message: `${branch} conflicts with the repository's own branch`,
          conflicts: merged.conflicts,
        },
      });
      return true;
    }
    // Recorded after the merge, not before: a channel marked merged whose
    // branch never landed is a channel that has closed itself over work
    // nobody has.
    const closed = await gw.options.store.mergeSubChannel(
      repositoryId,
      channel.id,
      { mergedAt: new Date().toISOString(), mergedBy: principal.user.id },
    );
    await gw.postChannelSystemMessage(
      projectId,
      repositoryId,
      `Merged \`${branch}\` into the repository. This channel is finished — ` +
        "open a new one for follow-up work.",
      channel.id,
    );
    await gw.options.store.appendAudit(undefined, {
      type: "channel_updated",
      data: {
        projectId,
        repositoryId,
        channelId: channel.id,
        slug: channel.slug,
        branch,
        merged: true,
        revision: merged.revision,
        actorId: principal.user.id,
      },
    });
    gw.sendJson(response, 200, {
      merged: true,
      revision: merged.revision,
      channel: closed ?? channel,
    });
    return true;
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
      // The branch goes with the room. A work channel that is deleted rather
      // than merged is work somebody abandoned, and leaving the branch behind
      // would leave a name nothing owns that the next channel of that name
      // could not take.
      if (channel.branch !== undefined) {
        await gw.options.operations
          .deleteBranch?.({
            projectId,
            repositoryId,
            branch: channel.branch,
          })
          .catch(() => undefined);
      }
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
      // A work channel is addressed by the same word as its branch, and the
      // branch cannot move without orphaning every commit on it. Renaming one
      // would leave #new-name working `kumi/old-name`, which reads as a bug
      // in every place either name is shown.
      if (channel.branch !== undefined) {
        throw new HttpError(
          409,
          "branch_channel",
          `#${channel.slug} is a branch (${channel.branch}) and cannot be renamed`,
        );
      }
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
