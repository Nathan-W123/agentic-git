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
          // An archived room is readable and closed, for everybody: it leads
          // the condition so no membership or visibility below it can reopen
          // one that has been put away.
          canPost:
            !channel.archived &&
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
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channels/([^/]+)/branch(?:/(refresh|merge|ship|comments|review))?$`,
      "u",
    ),
  );
  if (branchMatch !== undefined) {
    const [projectId = "", repositoryId = "", channelId = "", verb] =
      branchMatch;
    const permission =
      verb === undefined
        ? "view"
        : // Saying something about the work is not doing anything to it.
          // A comment is a channel message and a review is an opinion, and
          // anybody who can see the branch may leave either — withholding
          // them from the people who can read the code is how a review
          // becomes a rubber stamp by the two people allowed to speak.
          verb === "comments" || verb === "review"
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
      // The comments left on this diff, and where each one points. Read
      // from the room rather than from a comment table beside it: the room is
      // the pull request's conversation, and a comment is a message in it.
      // An anchor whose revision is not the one being drawn is left out of
      // the placed set below — a line number counted in another commit is a
      // guess — but the message is still in the transcript, which is where
      // somebody would go looking for it.
      const comments = (
        await gw.options.store
          .listChannelMessages(repositoryId, principal.user.id, {
            channelId: channel.id,
          })
          .catch(() => [])
      )
        .filter((message) => message.anchor !== undefined)
        .map((message) => ({
          id: message.id,
          authorId: message.authorId,
          kind: message.kind,
          content: message.content,
          createdAt: message.createdAt,
          anchor: message.anchor,
          replies: message.replies.length,
          // Whether it is about the diff on the screen. Said rather than
          // filtered, so a comment on an older revision is visibly stale
          // instead of silently gone.
          current: message.anchor?.revision === comparison.head,
        }));
      const reviews = await gw.options.store
        .listSubChannelReviews(repositoryId, channel.id)
        .catch(() => []);
      // What moved under this branch while it was open. Read here as well as
      // enforced at the merge, because a reason somebody meets when they
      // press the button is a reason they meet too late to plan around.
      const drift = await operations
        .branchContractDrift?.({ projectId, repositoryId, branch })
        .catch(() => undefined);
      gw.sendJson(response, 200, {
        branch,
        merged: false,
        ...comparison,
        comments,
        // Each person's standing answer, and whether it was about what is
        // there now: an approval of a branch that has moved four commits
        // since is not an approval of this.
        reviews: reviews.map((review) => ({
          ...review,
          current: review.revision === comparison.head,
        })),
        // Contracts this branch is built on that the repository has changed
        // since it cut. Empty for the ordinary case, and empty on a
        // deployment that cannot read shapes — never a guess.
        staleContracts: drift?.stale ?? [],
        // What the caller themselves has said, so the browser can show which
        // button is already pressed rather than offering both as if neither
        // were.
        myReview:
          reviews.find((review) => review.userId === principal.user.id)?.state,
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

    if (verb === "comments") {
      // A review comment is a message in the room, posted through the same
      // path as any other — which is the whole design: mentioning an agent in
      // one dispatches a task on this branch, the thread hangs off it, the
      // unread count moves, and none of that had to be rebuilt for reviews.
      // That path does its own membership check, so there is not a second one
      // here to disagree with it.
      const body = objectBody(await gw.readJson(request));
      const content =
        stringField(body["content"], "content", { min: 1, max: 8000 }) ?? "";
      const path_ =
        stringField(body["path"], "path", { min: 1, max: 1000 }) ?? "";
      const revision =
        stringField(body["revision"], "revision", { min: 7, max: 64 }) ?? "";
      const line = body["line"];
      if (
        typeof line !== "number" ||
        !Number.isSafeInteger(line) ||
        line < 1
      ) {
        throw new HttpError(
          400,
          "invalid_request",
          "A review comment needs the line it is about",
        );
      }
      // The revision is checked against the branch rather than trusted: a
      // comment stamped with a revision this branch never had could never be
      // placed against any diff, and would sit in the room pointing nowhere.
      const comparison = await gw.performOperation(
        "branch_failed",
        async () =>
          await operations.branchComparison!({
            projectId,
            repositoryId,
            branch,
          }),
      );
      if (revision !== comparison.head) {
        throw new HttpError(
          409,
          "revision_moved",
          "The branch moved while you were reading it. Reload the review — " +
            "the line you were pointing at may not be that line any more.",
        );
      }
      if (!comparison.files.includes(path_)) {
        throw new HttpError(
          400,
          "not_in_this_change",
          `${path_} is not one of the files this branch changed.`,
        );
      }
      const dispatch = await gw.postChannelMessageAndDispatch({
        projectId,
        repositoryId,
        channelId: channel.id,
        principal,
        content,
        anchor: { path: path_, line, revision },
      });
      gw.sendJson(response, 201, {
        message: dispatch.message,
        taskIds: dispatch.taskIds,
      });
      return true;
    }

    if (verb === "review") {
      const body = objectBody(await gw.readJson(request));
      const state = body["state"];
      // Optional, and allowed to be empty. Most reviews are a press of a
      // button and nothing else — the panel sends no note at all — and
      // `stringField` refuses `undefined` and an empty string alike unless
      // told otherwise. Without both of these Approve answered 400 every
      // time somebody pressed it without typing.
      const note =
        stringField(body["note"], "note", {
          min: 0,
          max: 2000,
          optional: true,
        }) ?? "";
      // Withdrawing is a state of its own rather than a DELETE, because it is
      // the same decision as the other two — what do I think of this — and a
      // second HTTP verb for one of three answers would put it somewhere
      // else in every client that offers all three together.
      if (state === "withdrawn") {
        await gw.options.store.clearSubChannelReview(
          repositoryId,
          channel.id,
          principal.user.id,
        );
        gw.sendJson(response, 200, { state: null });
        return true;
      }
      if (state !== "approved" && state !== "changes_requested") {
        throw new HttpError(
          400,
          "invalid_request",
          "A review is approved, changes_requested, or withdrawn",
        );
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
      const saved = await gw.options.store.saveSubChannelReview({
        repositoryId,
        channelId: channel.id,
        userId: principal.user.id,
        state,
        ...(note === "" ? {} : { note }),
        // Stamped with what was actually reviewed, so four commits later a
        // reader can tell this approved something else.
        revision: comparison.head,
        reviewedAt: new Date().toISOString(),
      });
      // Said out loud. A review nobody in the room can see is a decision made
      // in a panel, and the room is where the rest of the conversation is.
      await gw.postChannelSystemMessage(
        projectId,
        repositoryId,
        `${principal.user.displayName} ${
          state === "approved" ? "approved" : "asked for changes on"
        } \`${branch}\`${note === "" ? "." : `: ${note}`}`,
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
          reviewState: state,
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, { review: saved });
      return true;
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

    // The gate the audit is about, and the one thing a clean textual merge
    // cannot stand in for. Both sides agree on every symbol name; one of them
    // changed what a name means, and the other has been writing against the
    // old meaning ever since. Git merges that without a word, and the build
    // breaks on canonical rather than on either branch.
    //
    // Refused rather than resolved, like a conflict is: the remedy is the
    // button beside this one. Bringing the latest in moves the merge base
    // past the change, which is what makes this clear itself — either the
    // branch compiles against the new shape, or it now has a real conflict,
    // and both are better than finding out afterwards.
    //
    // Absent is not a refusal. A deployment with no shape reader answers
    // nothing, and refusing on that would make the feature impossible to roll
    // out — the compiler enforces it, as it happens: narrowing `drift` is
    // what lets the body below read `drift.stale` at all.
    const drift = await operations
      .branchContractDrift?.({ projectId, repositoryId, branch })
      .catch(() => undefined);
    if (drift !== undefined && drift.stale.length > 0) {
      const said = drift.stale
        .map(
          (entry) =>
            `${entry.through} is built on \`${entry.symbol}\` from ` +
            `${entry.file}, which is \`${entry.after}\` on the repository's ` +
            `own branch and was \`${entry.before}\` when this branch cut`,
        )
        .join("; ");
      await gw.postChannelSystemMessage(
        projectId,
        repositoryId,
        `\`${branch}\` cannot merge yet: ${said}. Bring the latest in — the ` +
          "code here was written against a contract that has moved.",
        channel.id,
      );
      gw.sendJson(response, 409, {
        error: {
          code: "stale_contract",
          message:
            `${branch} is built on ${drift.stale.length} ` +
            `${drift.stale.length === 1 ? "contract" : "contracts"} the ` +
            "repository has changed since it cut",
          staleContracts: drift.stale,
        },
      });
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
    // Canonical just moved, so every other open work channel in this
    // repository is now one commit further behind than it was. Catching them
    // up here rather than waiting for the next sweep is the difference
    // between a conflict discovered while somebody is still looking at the
    // merge that caused it and one discovered next week. Not awaited: the
    // person who pressed Merge is waiting on the merge, not on other
    // channels, and the sweep repeats this anyway.
    // Whatever this branch was holding, it is holding no longer: its work is
    // in canonical, so every other branch now has it too and contending over
    // it would be contending with the thing they all just merged. Awaited,
    // unlike the sweep below, because a claim outliving its branch refuses
    // work for a reason that has stopped being true — and the next plan may
    // be seconds away.
    await gw.options.store
      .releaseBranchClaims?.(repositoryId, branch)
      .catch(() => undefined);
    void gw.refreshBranchesAfterMerge(repositoryId).catch(() => undefined);
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
        // And so does what it was holding. An abandoned branch that goes on
        // refusing other people's work is the worst of both: the work is not
        // coming, and nobody can see why they are being told to wait.
        await gw.options.store
          .releaseBranchClaims?.(repositoryId, channel.branch)
          .catch(() => undefined);
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
      archived?: boolean;
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
    if (body["archived"] !== undefined) {
      // The reversible half of Delete: the room leaves the working list and
      // stops taking messages, and everything said in it is still there to be
      // read back or restored. `#general` is refused for exactly the reason
      // it cannot be deleted — it is where an unaddressed message lands, and
      // a repository without one has nowhere to put the next thing anybody
      // says. Unarchiving it is a no-op rather than an error, so a stale tab
      // pressing Restore on a room somebody already restored is not punished.
      const archived = body["archived"] === true;
      if (archived && channel.slug === GENERAL_SUB_CHANNEL_SLUG) {
        throw new HttpError(
          409,
          "general_channel",
          "The #general channel cannot be archived",
        );
      }
      update.archived = archived;
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
        archived: updated.archived,
        actorId: principal.user.id,
      },
    });
    gw.sendJson(response, 200, { channel: updated });
    return true;
  }

  return false;
}
