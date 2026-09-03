/**
 * Everything said in a room.
 *
 * Messages, replies, reactions, pins, reads, mutes, typing, direct
 * messages, the agent roster, and the per-room agent configuration.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import {
  localAgentsOnly,
} from "@coord/shared-types";
import type {
  QuestionChoice,
} from "../auditor.js";
import {
  authorizeProject,
  authorizeRepository,
} from "../authorization.js";
import {
  CHANNEL_MESSAGE_MAX_CHARS,
  DIRECT_MESSAGE_MAX_CHARS,
  HttpError,
  objectBody,
  stringField,
} from "../field-validation.js";
import type {
  ChannelCommandResponse,
} from "../gateway-types.js";
import {
  isCoordinatorNotice,
  isOwnChannelEntry,
  matchPath,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import {
  freshUsageTokens,
} from "../server.js";
import {
  SLASH_COMMANDS,
  parseSlashCommand,
} from "../slash.js";
import {
  normalizeChannelAgentId,
  resolveChannelAgentPresentation,
} from "../task-narration.js";
import {
  PROVIDER_TO_VENDOR,
  VENDOR_CLI_SETUP,
  defaultChannelAgentName,
  agentIsLive,
} from "../vendors.js";
import {
  isAuditorRole as roleIsAuditor,
  isInvestigatorRole as roleIsInvestigator,
} from "../auditor.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

export async function routeMessages(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  const channelMessagesMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/messages$`,
      "u",
    ),
  );
  const channelStatsMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/stats$`,
      "u",
    ),
  );
  if (channelStatsMatch !== undefined && method === "GET") {
    const [projectId = "", repositoryId = ""] = channelStatsMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "view",
    );
    // Same pairing check as every other `/channel/*` route. Message counts
    // and an afternoon's token spend are exactly what a competitor would
    // read off somebody else's room.
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    // Counted in the store, not measured off a page. Reading the newest
    // two hundred roots and taking their length reported "200+" for every
    // busier room, which is the one number a stats line must not guess at.
    const channel = await gw.authorizeSubChannel({
      projectId,
      repositoryId,
      channelId: gw.requestedChannelId(url),
      principal,
    });
    const counts = await gw.options.store.countChannelMessages(
      repositoryId,
      channel.id,
    );
    // Fresh tokens, not the billed total. A cached prompt prefix is re-read
    // every turn, so summing `totalTokens` counted the same context once per
    // turn of every task in the room and the line read in the millions
    // against an afternoon's work. The explicit fresh figure also separates
    // new cache-aware records from historical rows whose `inputTokens`
    // already included their cache. For those legacy or aggregate-only rows,
    // output is the only certainly fresh part and is shown as a lower bound.
    // Budgets still enforce against the billed total, where cache belongs.
    const usage = await gw.options.store.listTokenUsage({ repositoryId });
    const tokens = usage.reduce(
      (sum, entry) => sum + freshUsageTokens(entry),
      0,
    );
    const tokensIncomplete = usage.some(
      (entry) =>
        entry.freshTokens === undefined &&
        entry.totalTokens > entry.outputTokens,
    );
    gw.sendJson(response, 200, {
      messages: counts.messages,
      replies: counts.replies,
      tokens,
      tokensIncomplete,
    });
    return true;
  }
  // The questions an agent has stopped on, and the answers coming back.
  //
  // Their own route rather than a message shape, because a question is a
  // live wait rather than a record: it exists only while a run is holding
  // its workspace for it, and it is put to one person — whoever asked for
  // the work — rather than posted to the room.
  const channelQuestionsMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/questions$`,
      "u",
    ),
  );
  if (channelQuestionsMatch !== undefined && method === "GET") {
    const [projectId = "", repositoryId = ""] = channelQuestionsMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "view",
    );
    gw.sendJson(response, 200, {
      questions: gw.openAgentQuestionsFor({
        repositoryId,
        viewerId: principal.user.id,
      }),
    });
    return true;
  }
  const channelQuestionAnswerMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/questions/([^/]+)/answer$`,
      "u",
    ),
  );
  if (channelQuestionAnswerMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = "", requestId = ""] =
      channelQuestionAnswerMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "view",
    );
    const pending = gw.pendingAgentQuestions.get(requestId);
    if (
      pending === undefined ||
      pending.repositoryId !== repositoryId ||
      pending.submitterId !== principal.user.id
    ) {
      // The same 404 for "already answered", "deadline passed" and "not
      // yours": from out here they are one situation — there is nothing
      // left to answer — and the screen's move is the same, which is to
      // re-read the list and take the prompt down.
      throw new HttpError(
        404,
        "not_found",
        "That question is no longer waiting for an answer",
      );
    }
    const body = objectBody(await gw.readJson(request));
    const submitted = Array.isArray(body["answers"]) ? body["answers"] : [];
    const answers: QuestionChoice[] = pending.questions.map(
      (question, index) => {
        const raw = submitted[index];
        const entry =
          typeof raw === "object" && raw !== null && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
        const chosen = entry["chosen"];
        const written = entry["text"];
        // Not `stringField`: an empty box is the ordinary case here — most
        // answers are a tap — and a 400 for typing nothing would be the
        // prompt refusing its own default.
        const text =
          typeof written === "string" ? written.slice(0, 2_000) : undefined;
        if (
          typeof chosen === "number" &&
          Number.isInteger(chosen) &&
          chosen >= 0 &&
          chosen < question.options.length
        ) {
          return { chosen };
        }
        if (text !== undefined && text.trim().length > 0) {
          return { text: text.trim() };
        }
        // Anything else is a pass. Skipping is a real answer — "your call"
        // — which is what makes six questions cheap to put to somebody.
        return { skipped: true };
      },
    );
    pending.settle(answers);
    gw.sendJson(response, 200, { answered: answers.length });
    return true;
  }
  const channelTypingMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/typing$`,
      "u",
    ),
  );
  // Private mail, and so scoped to the project rather than a repository:
  // people write to each other, not to a checkout.
  const directInboxMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/direct-messages$`, "u"),
  );
  const directThreadMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/direct-messages/([^/]+)$`,
      "u",
    ),
  );
  // Correcting or unsending one piece of private mail.
  //
  // Both are sender-only and shared by both sides. A correction replaces the
  // same row so it cannot create a second unread message; an unsend removes
  // it because the two people are its whole audience and there is no third
  // party a tombstone would preserve history for. The store enforces the
  // sender rule in the same statement that performs either write.
  const directMessageActionMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/direct-messages/([^/]+)/messages/([^/]+)$`,
      "u",
    ),
  );
  if (directMessageActionMatch !== undefined) {
    const [projectId = "", , messageId = ""] = directMessageActionMatch;
    await authorizeProject(gw.options.store, principal, projectId, "view");
    if (method === "PATCH") {
      const body = objectBody(await gw.readJson(request));
      const content = stringField(body["content"], "content", {
        min: 1,
        max: DIRECT_MESSAGE_MAX_CHARS,
      }) ?? "";
      const message = await gw.options.store.updateDirectMessage(
        projectId,
        messageId,
        principal.user.id,
        content,
      );
      if (message === undefined) {
        // Sender ownership is deliberately indistinguishable from absence,
        // matching unsend below: a private-message id is not an oracle for
        // who wrote to whom.
        throw new HttpError(404, "not_found", "Message was not found");
      }
      gw.webSockets.sendToUsers(
        projectId,
        [principal.user.id, message.recipientId],
        {
          type: "direct-message-edited",
          projectId,
          message,
        },
      );
      gw.sendJson(response, 200, { message });
      return true;
    }
    if (method !== "DELETE") {
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }
    const removed = await gw.options.store.deleteDirectMessage(
      projectId,
      messageId,
      principal.user.id,
    );
    if (removed === undefined) {
      throw new HttpError(404, "not_found", "Message was not found");
    }
    // To the two of them and nobody else, and deliberately not through the
    // audit chain — the same rule sending one follows. That log is replayed
    // to every subscriber of the project, and "A deleted a message to B" is
    // the shape of a private conversation even with the words left out.
    //
    // The recipient is read back off the row rather than trusted from the
    // path: the path segment names the conversation the client had open,
    // and the row is the fact. They agree in every real request, and when
    // they do not it is the row that decides what was deleted.
    gw.webSockets.sendToUsers(
      projectId,
      [principal.user.id, removed.recipientId],
      {
        type: "direct-message-deleted",
        projectId,
        messageId,
        authorId: principal.user.id,
        recipientId: removed.recipientId,
      },
    );
    gw.sendJson(response, 200, { removed: 1 });
    return true;
  }
  const directReadMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/direct-messages/([^/]+)/read$`,
      "u",
    ),
  );

  if (directInboxMatch !== undefined) {
    const [projectId = ""] = directInboxMatch;
    if (method !== "GET") {
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }
    const project = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "view",
    );
    // The inbox and the roster in one call, because the screen that shows
    // one always shows the other: a list of conversations is useless without
    // the people you have not written to yet.
    const [conversations, reachable] = await Promise.all([
      gw.options.store.listDirectConversations(projectId, principal.user.id),
      gw.directMessagePeople(
        projectId,
        project.project.organizationId,
        principal.user.id,
        principal.user.systemAdmin,
      ),
    ]);
    const present = new Set(gw.webSockets.connectedUserIds(projectId));
    gw.sendJson(response, 200, {
      // A conversation can outlive the other person's access. It remains
      // private data in the store, but it is no longer an open destination:
      // the thread route below refuses that correspondent too. Keeping the
      // stale row in the inbox left the client with no profile from which to
      // resolve a name, so it printed the internal `user_…` id as though it
      // were another person (historical agent-backed rows had the same
      // shape). The reachability roster is the authority for both halves.
      conversations: conversations.filter((conversation) =>
        reachable.has(conversation.userId),
      ),
      // Everyone who could be written to, with whether they are here now.
      // Reachability is limited to people who share at least one repository
      // channel with the viewer; belonging somewhere else in the project is
      // not enough to open a private conversation.
      people: [...reachable.values()]
        .filter((person) => person.userId !== principal.user.id)
        .map((person) => ({
          id: person.userId,
          name: person.name,
          role: person.role,
          online: present.has(person.userId),
        })),
    });
    return true;
  }

  if (directReadMatch !== undefined) {
    const [projectId = "", otherId = ""] = directReadMatch;
    if (method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }
    await authorizeProject(gw.options.store, principal, projectId, "view");
    const marked = await gw.options.store.markDirectMessagesRead(
      projectId,
      principal.user.id,
      otherId,
      new Date().toISOString(),
    );
    gw.sendJson(response, 200, { marked });
    return true;
  }

  if (directThreadMatch !== undefined) {
    const [projectId = "", otherId = ""] = directThreadMatch;
    const project = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "view",
    );
    // Both ends have to be real people who share a channel. Without this a
    // signed-in person could open a conversation against any id at all —
    // writing to somebody elsewhere in KUMI, or filling the table with
    // messages addressed to nobody.
    if (otherId === principal.user.id) {
      throw new HttpError(
        400,
        "invalid_recipient",
        "A direct message needs two people",
      );
    }
    // Reachability is the union of the repository channels both people can
    // enter. An org check alone made a repo-invited teammate unwritable,
    // while a project-wide union let guests from unrelated channels DM.
    const reachable = await gw.directMessagePeople(
      projectId,
      project.project.organizationId,
      principal.user.id,
      principal.user.systemAdmin,
    );
    if (!reachable.has(otherId)) {
      throw new HttpError(404, "not_found", "That person was not found");
    }
    if (method === "GET") {
      const limit = Math.min(
        200,
        Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10)),
      );
      const before = url.searchParams.get("before") ?? undefined;
      const messages = await gw.options.store.listDirectMessages(
        projectId,
        principal.user.id,
        otherId,
        { limit, ...(before === undefined ? {} : { before }) },
      );
      gw.sendJson(response, 200, { messages });
      return true;
    }
    if (method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }
    const body = objectBody(await gw.readJson(request));
    // min:1 so an empty message is a 400 here rather than a throw from the
    // store, which would surface as a 500.
    const content =
      stringField(body["content"], "content", {
        min: 1,
        max: DIRECT_MESSAGE_MAX_CHARS,
      }) ?? "";
    const referencedMessageId = stringField(
      body["referencedMessageId"],
      "referencedMessageId",
      { optional: true },
    );
    if (referencedMessageId !== undefined) {
      const conversation = await gw.options.store.listDirectMessages(
        projectId,
        principal.user.id,
        otherId,
      );
      if (!conversation.some((entry) => entry.id === referencedMessageId)) {
        throw new HttpError(
          400,
          "invalid_reference",
          "A direct message reply must reference this conversation",
        );
      }
    }
    const message = await gw.options.store.appendDirectMessage({
      projectId,
      authorId: principal.user.id,
      recipientId: otherId,
      content,
      ...(referencedMessageId === undefined ? {} : { referencedMessageId }),
    });
    // To the two of them and nobody else, and not through the audit stream:
    // that log is replayed to every subscriber of the project, which is the
    // one place a private message must never be written.
    gw.webSockets.sendToUsers(projectId, [principal.user.id, otherId], {
      type: "direct-message",
      projectId,
      message,
      authorName: principal.user.displayName,
    });
    gw.sendJson(response, 201, { message });
    return true;
  }
  if (channelTypingMatch !== undefined) {
    const [projectId = "", repositoryId = ""] = channelTypingMatch;
    if (method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }
    // Gated on the same right as reading the channel: knowing somebody is
    // typing tells you nothing you could not learn a second later by
    // reading what they typed.
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "view",
    );
    const body = objectBody(await gw.readJson(request));
    const threadId = stringField(body["threadId"], "threadId", {
      max: 200,
      optional: true,
    });
    // Straight to the open sockets. Nothing is stored: see
    // `broadcastTransient` for why this must not reach the audit chain.
    gw.webSockets.broadcastTransient(
      projectId,
      {
        type: "channel-typing",
        projectId,
        repositoryId,
        // Which room, so a "…is typing" only shows to the people looking
        // at it. Absent from a caller that predates sub-channels, which the
        // browser reads as `#general`.
        ...(() => {
          const typingChannelId = gw.requestedChannelId(url, body);
          return typingChannelId === undefined
            ? {}
            : { channelId: typingChannelId };
        })(),
        ...(threadId === undefined ? {} : { threadId }),
        userId: principal.user.id,
        userName: principal.user.displayName,
        occurredAt: new Date().toISOString(),
      },
      principal.user.id,
    );
    gw.sendJson(response, 202, { accepted: true });
    return true;
  }

  if (channelMessagesMatch !== undefined) {
    const [projectId = "", repositoryId = ""] = channelMessagesMatch;
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
    if (method === "GET") {
      const limit = Math.min(
        200,
        Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10)),
      );
      const before = url.searchParams.get("before") ?? undefined;
      // Which room. Absent means `#general`, so a client that predates
      // sub-channels reads exactly what it always did; a private room the
      // caller is not in answers 404 here rather than an empty page.
      const channel = await gw.authorizeSubChannel({
        projectId,
        repositoryId,
        channelId: gw.requestedChannelId(url),
        principal,
      });
      const [
        messages,
        agentOverrides,
        readAt,
        pinned,
        mentionAgents,
        mentionPeople,
      ] = await Promise.all([
        gw.options.store.listChannelMessages(repositoryId, principal.user.id, {
          limit,
          channelId: channel.id,
          ...(before === undefined ? {} : { before }),
        }),
        gw.options.store.listChannelAgentOverrides(repositoryId),
        gw.options.store.getChannelReadCursor(
          repositoryId,
          principal.user.id,
          channel.id,
        ),
        gw.options.store.listPinnedChannelMessages(
          repositoryId,
          principal.user.id,
          channel.id,
        ),
        gw.resolveChannelMentionCandidates(
          projectId,
          repositoryId,
          channel.id,
        ),
        gw.resolveChannelPeople(projectId, repositoryId),
      ]);
      // Sent with the messages rather than on a route of its own: the
      // picker is drawn on this screen, and a second round trip to learn
      // what to offer is a second chance for the two to disagree — the
      // same reasoning `auditorPaused` rides the roster for.
      //
      // The pinned list rides here too, and separately from `messages`: a
      // pin exists so a message survives the room moving on, so it must
      // not vanish just because it aged past the page. Not run through
      // `withChangedFiles` — the banner wants a title and a target, and
      // any on-page copy already carries its file summary.
      gw.sendJson(response, 200, {
        channel: {
          ...channel,
          canPost: await gw.canPostInSubChannel(
            channel,
            principal.user.id,
            await gw.isRepositoryAdmin(principal, projectId, repositoryId),
          ),
        },
        messages: (
          await gw.withChangedFiles(repositoryId, messages)
        ).map((message) =>
          gw.withChannelMessageMentions(
            message,
            mentionAgents,
            mentionPeople,
          ),
        ),
        agentOverrides,
        readAt,
        slashCommands: SLASH_COMMANDS,
        pinned: pinned.map((message) =>
          gw.withChannelMessageMentions(
            message,
            mentionAgents,
            mentionPeople,
          ),
        ),
      });
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const content =
        stringField(body["content"], "content", {
          max: CHANNEL_MESSAGE_MAX_CHARS,
        }) ?? "";
      const posted = await gw.postChannelMessageAndDispatch({
        projectId,
        repositoryId,
        channelId: gw.requestedChannelId(url, body),
        content,
        principal,
      });
      const channel = posted.channel;
      const message = posted.message;
      const command = posted.response;
      const [mentionAgents, mentionPeople] = await Promise.all([
        gw.resolveChannelMentionCandidates(
          projectId,
          repositoryId,
          channel.id,
        ),
        gw.resolveChannelPeople(projectId, repositoryId),
      ]);
      gw.sendJson(response, 201, {
        message: gw.withChannelMessageMentions(
          message,
          mentionAgents,
          mentionPeople,
        ),
        ...(command === undefined ? {} : { command }),
      });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "Unsupported method");
  }

  const channelReplyMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/messages/([^/]+)/replies$`,
      "u",
    ),
  );
  if (channelReplyMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = "", messageId = ""] = channelReplyMatch;
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
    const body = objectBody(await gw.readJson(request));
    const content =
      stringField(body["content"], "content", {
        max: CHANNEL_MESSAGE_MAX_CHARS,
      }) ?? "";
    const referencedMessageId = stringField(
      body["referencedMessageId"],
      "referencedMessageId",
      { optional: true },
    );
    // A thread lives in a room, and a reply into it is a post in that room:
    // the same visibility and membership rules apply, taken from the root
    // rather than from the request so a reply cannot address a channel its
    // thread is not in.
    const replyRoot = await gw.options.store.getChannelMessage(
      repositoryId,
      messageId,
      principal.user.id,
    );
    if (replyRoot === undefined) {
      throw new HttpError(404, "not_found", "Channel message was not found");
    }
    const replyChannel = await gw.authorizeSubChannel({
      projectId,
      repositoryId,
      channelId: replyRoot.channelId,
      principal,
    });
    if (
      !(await gw.canPostInSubChannel(
        replyChannel,
        principal.user.id,
        await gw.isRepositoryAdmin(principal, projectId, repositoryId),
      ))
    ) {
      throw new HttpError(
        403,
        "not_a_member",
        "You are not a member of this channel",
      );
    }
    let reply;
    try {
      reply = await gw.options.store.addChannelReply({
        repositoryId,
        messageId,
        kind: "user",
        authorId: principal.user.id,
        content,
        ...(referencedMessageId === undefined
          ? {}
          : { referencedMessageId }),
      });
    } catch (error) {
      throw new HttpError(
        404,
        "not_found",
        error instanceof Error ? error.message : "Channel message was not found",
      );
    }
    await gw.options.store.appendAudit(undefined, {
      type: "channel_message_replied",
      // A reply belongs to its root, so the room comes from the root
      // rather than the request — a thread cannot be answered into a
      // different channel than the one it is in.
      data: {
        projectId,
        repositoryId,
        channelId: replyChannel.id,
        messageId,
        replyId: reply.id,
      },
    });
    // Answered after the reply is stored, never before it is acknowledged:
    // the person typing should see their own message land at once, and the
    // agent's answer arrives on the event stream like any other reply. A
    // push is the one synchronous answer: its structured sync collision has
    // to travel in this response for the browser to open the choice dialog.
    const answering = gw.answerThreadReply({
      projectId,
      repositoryId,
      messageId,
      viewerId: principal.user.id,
      question: content,
    });
    const reportAnswerFailure = (error: unknown): void => {
      process.stderr.write(
        `[channel] thread reply answer failed for ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    };
    let command: ChannelCommandResponse | undefined;
    if (parseSlashCommand(content)?.command.name === "push") {
      try {
        command = await answering;
      } catch (error) {
        reportAnswerFailure(error);
      }
    } else {
      void answering.catch(reportAnswerFailure);
    }
    gw.sendJson(response, 201, {
      reply,
      ...(command === undefined ? {} : { command }),
    });
    return true;
  }

  const channelReactionMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/messages/([^/]+)/reactions$`,
      "u",
    ),
  );
  if (channelReactionMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = "", messageId = ""] = channelReactionMatch;
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
    const body = objectBody(await gw.readJson(request));
    const emoji =
      stringField(body["emoji"], "emoji", { max: 32, optional: true }) ?? "👍";
    let message;
    try {
      message = await gw.options.store.toggleChannelReaction(
        repositoryId,
        messageId,
        principal.user.id,
        emoji,
      );
    } catch (error) {
      throw new HttpError(
        404,
        "not_found",
        error instanceof Error ? error.message : "Channel message was not found",
      );
    }
    await gw.options.store.appendAudit(undefined, {
      type: "channel_reaction_toggled",
      data: { projectId, repositoryId, messageId, emoji, userId: principal.user.id },
    });
    gw.sendJson(response, 200, { message });
    return true;
  }

  const channelPinMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/messages/([^/]+)/pin$`,
      "u",
    ),
  );
  if (channelPinMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = "", messageId = ""] = channelPinMatch;
    // The reactions rule, deliberately: a pin is shared attention, not
    // moderation — anyone who can read the room may flag what it should
    // not lose, and anyone may unflag it. The audit records who did which.
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
    let message;
    try {
      message = await gw.options.store.toggleChannelMessagePin(
        repositoryId,
        messageId,
        principal.user.id,
      );
    } catch (error) {
      throw new HttpError(
        404,
        "not_found",
        error instanceof Error ? error.message : "Channel message was not found",
      );
    }
    await gw.options.store.appendAudit(undefined, {
      type: "channel_message_pinned",
      data: {
        projectId,
        repositoryId,
        messageId,
        pinned: message.pinnedAt !== undefined,
        userId: principal.user.id,
      },
    });
    gw.sendJson(response, 200, { message });
    return true;
  }

  const channelReadMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/read$`,
      "u",
    ),
  );
  if (channelReadMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = ""] = channelReadMatch;
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
    const channel = await gw.authorizeSubChannel({
      projectId,
      repositoryId,
      channelId: gw.requestedChannelId(
        url,
        await gw.optionalJsonBody(request),
      ),
      principal,
    });
    const at = new Date().toISOString();
    await gw.options.store.markChannelRead(
      repositoryId,
      principal.user.id,
      at,
      channel.id,
    );
    // Read back rather than echoed: the cursor only moves forward, so a
    // request that arrived after a later one leaves the stored mark where it
    // was, and the answer has to say where that is.
    const readAt =
      (await gw.options.store.getChannelReadCursor(
        repositoryId,
        principal.user.id,
        channel.id,
      )) ?? at;
    gw.sendJson(response, 200, { readAt });
    return true;
  }

  // Which of this project's rooms this account has silenced. One call for
  // the whole project rather than one per channel: the browser needs the
  // answer for every room in the switcher before it can draw a single
  // badge, and a fan-out over the channel list would be a request each.
  const channelMutesMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/channel/mutes$`, "u"),
  );
  if (channelMutesMatch !== undefined && method === "GET") {
    const projectId = channelMutesMatch[0] ?? "";
    const { repositories } = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      "view",
    );
    // A mute is recorded per repository, not per project, so the stored set
    // spans every project this account can reach. Narrowed to what is
    // actually in this one — and, for a grant holder, to what they may see
    // — so the answer never names a repository the caller could not
    // otherwise learn exists.
    const muted = new Set(
      await gw.options.store.listMutedChannels(principal.user.id),
    );
    const inProject =
      await gw.options.store.listProjectRepositories(projectId);
    const repositoryIds = inProject
      .filter(
        (entry) =>
          muted.has(entry.id) &&
          (repositories === undefined || repositories.has(entry.id)),
      )
      .map((entry) => entry.id);
    gw.sendJson(response, 200, { repositoryIds });
    return true;
  }

  // Silencing one room, for the person asking and nobody else. `view` is
  // the right level: anybody who can read the channel can decide they would
  // rather not be interrupted by it, and the write touches only their own
  // preference.
  const channelMuteMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/mute$`,
      "u",
    ),
  );
  if (channelMuteMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = ""] = channelMuteMatch;
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
    const body = objectBody(await gw.readJson(request));
    const { muted } = body;
    if (typeof muted !== "boolean") {
      throw new HttpError(
        400,
        "invalid_request",
        "muted must be true or false",
      );
    }
    await gw.options.store.setChannelMuted(
      repositoryId,
      principal.user.id,
      muted,
    );
    gw.sendJson(response, 200, { muted });
    return true;
  }

  // The real channel roster: every user with access to this repository —
  // by organization role or by a per-repository grant, the same two paths
  // `authorizeRepository` itself accepts, so nobody appears here who could
  // not also read the messages above — and the vendor agents each of them
  // has actually connected. This replaces the client-side `TEAMMATE_NAMES`
  // placeholder `data.js` used to invent so the roster was never empty.
  //
  // Privacy: this discloses to every repository collaborator which vendors
  // their teammates have connected. That is new — `publicUser` below shows
  // a member's name and chosen agent colour to the rest of their
  // organization, but nothing today already surfaces *which providers*
  // someone has connected. It is treated as acceptable here because (a) the
  // audience is exactly the set of people who can already see this
  // repository's shared activity, not the whole organization, (b) the
  // disclosure is bounded to vendor name + whose it is, never the secret,
  // the credential's hint, its kind, or usage/spend, and (c) a shared
  // channel roster is meaningless without it — "who's actually in this
  // room" is the entire point. The credential's own free-text label is
  // deliberately left out even though `UserCredentialSummary` carries one:
  // that string is something a user wrote for themselves, not a fact about
  // who they are, and this route only asks `connectionsFor` for the vendor.
  const channelAgentsRosterMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/agents$`,
      "u",
    ),
  );
  if (channelAgentsRosterMatch !== undefined && method === "GET") {
    const [projectId = "", repositoryId = ""] = channelAgentsRosterMatch;
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
    // Same two sources `authorizeProject` reads to decide who may pass —
    // an organization role reaches every repository, a grant reaches only
    // this one — deduplicated, since somebody can hold both. Factored into
    // `channelAgentConnections` because @mention dispatch on the message
    // route below needs the identical set.
    const rosterChannel = await gw.authorizeSubChannel({
      projectId,
      repositoryId,
      channelId: gw.requestedChannelId(url),
      principal,
    });
    const connections = await gw.channelAgentConnections(
      projectId,
      repositoryId,
      rosterChannel.id,
    );
    const rosterOverrides =
      await gw.options.store.listChannelAgentOverrides(repositoryId);
    // Read once for the whole roster. See `liveWorkerOwners`.
    const rosterProject = await gw.options.store
      .getProject(projectId)
      .catch(() => undefined);
    const liveOwners = await gw.liveWorkerOwners(
      rosterProject?.organizationId,
    );
    const agents = connections.map((connection) => ({
      userId: connection.userId,
      // The display name only — never the email `publicUser` would also
      // include, since a channel roster needs a name to put next to the
      // agent, not a contact address for the person behind it.
      userName: connection.userName,
      provider: connection.provider,
      // Resolved here rather than left to the browser. The name on screen
      // has to be the name a mention is matched against — resolving the
      // same overrides twice, in two places, is how the screen came to show
      // one name while the server answered to another, so that a rename
      // produced silence and an old name still worked.
      //
      // The default comes from `defaultChannelAgentName`, the same function
      // the mention matcher reads, so the account's call sign is what this
      // roster reports. Rebuilding the vendor label here instead is what
      // made every reload lose every name: the browser trusts this answer
      // over the call sign it already holds for the viewer's own agents.
      ...resolveChannelAgentPresentation(
        rosterOverrides,
        connection,
        defaultChannelAgentName(connection),
      ),
      // Whether anyone besides its owner may @mention it into real work —
      // see `CredentialVisibility`. Metadata, not a secret; safe for every
      // repository collaborator to see, same as the vendor name itself.
      visibility: connection.visibility,
      // What to install, when nothing can run this agent.
      //
      // Sent only for an agent no live machine advertises, so a working
      // roster carries none of it. The reader is a person whose agent just
      // went grey and whose next question is "why" — the answer is almost
      // always that the CLI is not on their machine, and the command is the
      // shortest possible route from that question to a working agent.
      ...(agentIsLive(
        liveOwners,
        connection.userId,
        connection.provider,
      )
        ? {}
        : {
            setup: ((vendor) =>
              vendor === undefined || VENDOR_CLI_SETUP[vendor] === undefined
                ? undefined
                : // The vendor travels with it: the desktop app installs by
                  // name, never by command, so the page needs the name to
                  // ask with and must not have to derive it from a label.
                  { vendor, ...VENDOR_CLI_SETUP[vendor] })(
              PROVIDER_TO_VENDOR[connection.provider],
            ),
          }),
      /**
       * Whether this agent's owner has a machine listening right now.
       *
       * Only meaningful where the deployment refuses to execute on its own
       * behalf — hence `localAgentsOnly` beside it in the payload rather
       * than the browser having to infer it. With the flag off the control
       * plane answers regardless, and an offline owner is not a fact
       * anybody needs.
       *
       * Advisory by construction: it is true as of this response, and the
       * liveness window is three minutes wide. Treat it as what to draw and
       * what to ask, never as permission — the server's own check at
       * dispatch is the one that decides.
       */
      ownerOnline: agentIsLive(
        liveOwners,
        connection.userId,
        connection.provider,
      ),
      connected: true as const,
    }));
    // Whether auditing is switched off here. Sent with the roster rather
    // than on its own route because the switch is drawn on the roster, and
    // a second round trip to decide how to draw one toggle is a second
    // chance for the two to disagree. Absent row means auditing is on.
    const auditing = await gw.options.store.getAuditorCursor(repositoryId);
    // Everyone who can be in this room, not only organization members. A
    // repository-scoped invite grants the repository and nothing else, so
    // its holder was posting in a channel whose Users list had never heard
    // of them — present in every message and absent from the room.
    const project = await gw.options.store.getProject(projectId);
    const [memberships, grants, users] = await Promise.all([
      project === undefined
        ? Promise.resolve([])
        : gw.options.store.listMemberships(project.organizationId),
      gw.options.store.listRepositoryGrants(repositoryId),
      gw.options.store.listUsers(),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const seen = new Set<string>();
    const people = [
      ...memberships.map((entry) => ({ userId: entry.userId, role: entry.role })),
      ...grants.map((entry) => ({ userId: entry.userId, role: entry.role })),
    ].flatMap((entry) => {
      if (seen.has(entry.userId)) {
        return [];
      }
      seen.add(entry.userId);
      const user = userById.get(entry.userId);
      return user === undefined
        ? []
        : [
            {
              userId: entry.userId,
              role: entry.role,
              user: { id: user.id, displayName: user.displayName },
            },
          ];
    });
    gw.sendJson(response, 200, {
      agents,
      people,
      auditorPaused: auditing?.paused === true,
      // What makes `ownerOnline` worth drawing. Sent with the roster for
      // the same reason `auditorPaused` is: the screen that reads one reads
      // the other, and a second round trip to decide how to draw one dot is
      // a second chance for the two to disagree.
      localAgentsOnly: localAgentsOnly(),
    });
    return true;
  }

  // Correcting or removing one reply.
  //
  // A reply is a leaf — nothing hangs off it — so it goes outright, and the
  // rule about who may is the same one the root gets below: your own words,
  // or anybody who runs the project.
  const channelReplyActionMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/messages/([^/]+)/replies/([^/]+)$`,
      "u",
    ),
  );
  if (
    channelReplyActionMatch !== undefined &&
    (method === "DELETE" || method === "PATCH")
  ) {
    const [projectId = "", repositoryId = "", messageId = "", replyId = ""] =
      channelReplyActionMatch;
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
    const message = await gw.options.store.getChannelMessage(
      repositoryId,
      messageId,
      principal.user.id,
    );
    const reply = message?.replies.find((entry) => entry.id === replyId);
    if (message === undefined || reply === undefined) {
      throw new HttpError(404, "not_found", "Reply was not found");
    }
    if (method === "PATCH") {
      // Editing is narrower than moderation. A manager may remove somebody
      // else's words, but may never rewrite them under that person's name.
      if (reply.kind !== "user" || reply.authorId !== principal.user.id) {
        throw new HttpError(
          403,
          "forbidden",
          "Only the author can edit this reply",
        );
      }
      // Once an agent owns the thread, the transcript is also the prompt it
      // acted on. Rewriting that prompt would make the visible history say
      // something different from what the agent received. The same applies
      // after any later line has quoted this reply.
      if (
        message.taskId !== undefined ||
        message.replies.at(-1)?.id !== replyId ||
        (await gw.options.store.channelEntryHasDependents(
          repositoryId,
          replyId,
        ))
      ) {
        throw new HttpError(
          409,
          "message_already_answered",
          "This reply cannot be edited after an agent starts or somebody replies to it",
        );
      }
      const body = objectBody(await gw.readJson(request));
      const content = stringField(body["content"], "content", {
        min: 1,
        max: CHANNEL_MESSAGE_MAX_CHARS,
      }) ?? "";
      await gw.options.store.setChannelReplyContent(
        repositoryId,
        messageId,
        replyId,
        content,
      );
      await gw.options.store.appendAudit(undefined, {
        type: "channel_reply_edited",
        data: {
          projectId,
          repositoryId,
          messageId,
          replyId,
          authorId: reply.authorId,
        },
      });
      gw.sendJson(response, 200, {
        reply: { ...reply, content },
      });
      return true;
    }
    if (!isOwnChannelEntry(reply.authorId, principal.user.id)) {
      await authorizeRepository(
        gw.options.store,
        principal,
        projectId,
        repositoryId,
        "manage_project",
      );
    }
    await gw.options.store.deleteChannelReply(
      repositoryId,
      messageId,
      replyId,
    );
    await gw.options.store.appendAudit(undefined, {
      type: "channel_reply_deleted",
      data: {
        projectId,
        repositoryId,
        messageId,
        replyId,
        authorId: reply.authorId,
        actorId: principal.user.id,
      },
    });
    gw.sendJson(response, 200, { removed: 1 });
    return true;
  }

  // Correcting or removing a root, or clearing the channel.
  //
  // Clearing the whole channel stays `manage_project`: every thread in it is
  // a record of work other people read, and throwing the lot away is an
  // administrative act rather than tidying after yourself.
  //
  // One message is the narrower case, and the rule is the one every chat
  // product settles on — you may unsay what you said, and a moderator may
  // unsay anything. "What you said" includes your own agent's lines, because
  // an agent posts on its owner's credential and under their name; nobody
  // else's agent is yours to silence.
  //
  // What deletion *means* depends on what hangs off the message. A root with
  // replies is blanked in place: the replies are the agent's account of a
  // task, and taking them with the request would delete other people's
  // reading, not the author's words. A root nobody has replied under is
  // removed outright. And when the thread was the story of a task that is
  // still running, the work stops too — the message is the request, and
  // withdrawing a request while a machine keeps acting on it is the one
  // outcome nobody expects. See docs/architecture/message-deletion.md.
  const channelMessageMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/messages(?:/([^/]+))?$`,
      "u",
    ),
  );
  if (
    channelMessageMatch !== undefined &&
    (method === "DELETE" || method === "PATCH")
  ) {
    const [projectId = "", repositoryId = "", messageId] =
      channelMessageMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      messageId === undefined || messageId.length === 0
        ? "manage_project"
        : "view",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    if (messageId === undefined || messageId.length === 0) {
      // "Clear the channel" now means the room that is open, not every room
      // in the repository — emptying #general is not a reason to empty
      // #design, and a client that names no room still means #general.
      const cleared = await gw.authorizeSubChannel({
        projectId,
        repositoryId,
        channelId: gw.requestedChannelId(url),
        principal,
      });
      const removed = await gw.options.store.deleteChannelMessages(
        repositoryId,
        cleared.id,
      );
      await gw.options.store.appendAudit(undefined, {
        type: "channel_message_deleted",
        data: {
          projectId,
          repositoryId,
          channelId: cleared.id,
          removed,
          all: true,
        },
      });
      gw.sendJson(response, 200, { removed });
      return true;
    }
    const message = await gw.options.store.getChannelMessage(
      repositoryId,
      messageId,
      principal.user.id,
    );
    if (message === undefined) {
      throw new HttpError(404, "not_found", "Message was not found");
    }
    if (method === "PATCH") {
      if (message.kind !== "user" || message.authorId !== principal.user.id) {
        throw new HttpError(
          403,
          "forbidden",
          "Only the author can edit this message",
        );
      }
      if (message.deletedAt !== undefined) {
        throw new HttpError(409, "message_deleted", "Message was deleted");
      }
      // A correction is safe only while the line is still just a line. If
      // it has become a task prompt, acquired a thread, or been referenced
      // by a later answer, preserving the exact prompt the agent and other
      // people saw is less surprising than silently changing history.
      if (
        message.taskId !== undefined ||
        message.replies.length > 0 ||
        (await gw.options.store.channelEntryHasDependents(
          repositoryId,
          messageId,
        ))
      ) {
        throw new HttpError(
          409,
          "message_already_answered",
          "This message cannot be edited after an agent starts or somebody replies to it",
        );
      }
      const body = objectBody(await gw.readJson(request));
      const content = stringField(body["content"], "content", {
        min: 1,
        max: CHANNEL_MESSAGE_MAX_CHARS,
      }) ?? "";
      await gw.options.store.setChannelMessageContent(
        repositoryId,
        messageId,
        content,
      );
      await gw.options.store.appendAudit(undefined, {
        type: "channel_message_edited",
        data: {
          projectId,
          repositoryId,
          messageId,
          authorId: message.authorId,
        },
      });
      gw.sendJson(response, 200, {
        message: { ...message, content },
      });
      return true;
    }
    if (!isOwnChannelEntry(message.authorId, principal.user.id)) {
      await authorizeRepository(
        gw.options.store,
        principal,
        projectId,
        repositoryId,
        "manage_project",
      );
    }
    // `?purge=1` asks for the whole thread, replies and all — what the
    // thread panel's own delete has always meant and still promises in its
    // confirmation. That is moderation rather than unsaying, so it needs
    // `manage_project` however the message got there.
    const purge = url.searchParams.get("purge") === "1";
    if (purge) {
      await authorizeRepository(
        gw.options.store,
        principal,
        projectId,
        repositoryId,
        "manage_project",
      );
    }
    const cancelledTask = await gw.stopTaskBehindMessage({
      projectId,
      repositoryId,
      // A coordinator notice names a task without being that task's thread:
      // it is the room being told who is waiting on whom. Tidying one out of
      // the channel is housekeeping, and must not stop the run it mentions —
      // which is not even the run the reader is looking at.
      taskId: isCoordinatorNotice(message) ? undefined : message.taskId,
      actorId: principal.user.id,
    });
    // Replies decide the shape: blank in place when there is a thread to
    // keep standing, remove outright when there is not.
    const redacted = !purge && message.replies.length > 0;
    if (redacted) {
      await gw.options.store.redactChannelMessage(repositoryId, messageId, {
        deletedAt: new Date().toISOString(),
        deletedBy: principal.user.id,
      });
    } else {
      await gw.options.store.deleteChannelMessage(repositoryId, messageId);
    }
    await gw.options.store.appendAudit(undefined, {
      type: "channel_message_deleted",
      data: {
        projectId,
        repositoryId,
        messageId,
        authorId: message.authorId,
        actorId: principal.user.id,
        redacted,
        purge,
        ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
        cancelledTask,
      },
    });
    gw.sendJson(response, 200, {
      removed: redacted ? 0 : 1,
      redacted,
      cancelledTask,
    });
    return true;
  }

  // Auditing switched off and on for a repository, without demoting the
  // agent that holds the role. `manage_project`, matching promotion: this
  // decides whether an account is spent unprompted, which is the same
  // decision promoting an auditor makes.
  const auditorSwitchMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/auditor$`,
      "u",
    ),
  );
  if (auditorSwitchMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = ""] = auditorSwitchMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "manage_project",
    );
    const body = objectBody(await gw.readJson(request));
    const paused = body["paused"];
    if (typeof paused !== "boolean") {
      throw new HttpError(400, "invalid_request", "paused must be a boolean");
    }
    const auditor = await gw.auditorFor(projectId, repositoryId);
    if (auditor === undefined) {
      throw new HttpError(
        404,
        "no_auditor",
        "This repository has no auditor to switch on or off.",
      );
    }
    await gw.options.store.setAuditorPaused(repositoryId, paused);
    await gw.options.store.appendAudit(undefined, {
      type: "channel_agent_overridden",
      data: { projectId, repositoryId, agentId: `${auditor.userId}:${auditor.provider}`, paused },
    });
    // Resuming audits the gap immediately rather than waiting for the next
    // merge — which is the whole point of a switch you can turn back on.
    const resumed = paused
      ? undefined
      : await gw.resumeAuditing({ projectId, repositoryId });
    gw.sendJson(response, 200, {
      paused,
      ...(resumed === undefined ? {} : { resumed }),
    });
    return true;
  }

  // Per-(repository, agent) presentation: channel role/model/effort choices,
  // plus the owning account's route to its agent-wide display name. See
  // `renameChannelAgent` in data.js.
  const channelAgentMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/agents/([^/]+)$`,
      "u",
    ),
  );
  if (channelAgentMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = "", rawAgentId = ""] =
      channelAgentMatch;
    // Stored under the one key that identifies a single agent.
    //
    // A bare provider id ("anthropic") is what `myAgents` in data.js mints
    // for *this account's own* agents, so it names a provider and not an
    // agent — and the reader applied it to every agent on that provider.
    // One person renaming their own Claude therefore renamed everybody's
    // Claude in that channel, and their role label travelled with it.
    //
    // The bare form still resolves on read, because rows written before
    // this exist and would otherwise silently lose their names. It is
    // simply never written again.
    const agentId = normalizeChannelAgentId(rawAgentId, principal.user.id);
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
    const body = objectBody(await gw.readJson(request));
    const name = stringField(body["name"], "name", { max: 120, optional: true });
    const ownPrefix = `${principal.user.id}:`;
    const ownProvider = agentId.startsWith(ownPrefix)
      ? agentId.slice(ownPrefix.length)
      : undefined;
    if (name !== undefined && ownProvider === undefined) {
      throw new HttpError(
        403,
        "forbidden",
        "Only the user who added an agent can rename it",
      );
    }
    // `min: 0`, matching model/effort below: an empty string clears the
    // role back to the vendor-wide default rather than being rejected as
    // too short, the same way clearing the model dropdown does.
    const role = stringField(body["role"], "role", {
      max: 120,
      min: 0,
      optional: true,
    });
    const model = stringField(body["model"], "model", {
      max: 200,
      min: 0,
      optional: true,
    });
    const effort = stringField(body["effort"], "effort", {
      max: 40,
      min: 0,
      optional: true,
    });
    if (
      name === undefined &&
      role === undefined &&
      model === undefined &&
      effort === undefined
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        "At least one of name, role, model, or effort is required",
      );
    }
    // `auditor` and `investigator` are the roles the code knows the meaning
    // of.
    //
    // Every other role is free text the agent only ever sees as a sentence
    // in its objective. These change what the system does — they act
    // unprompted, on their own trigger, spending tokens nobody asked them
    // to — so neither is something any collaborator should be able to hand
    // out by typing a word into a text field, and neither is something two
    // agents should hold at once in the same repository.
    const reserved = roleIsAuditor(role)
      ? { holds: roleIsAuditor, noun: "auditor", conflict: "auditor_exists" }
      : roleIsInvestigator(role)
        ? {
            holds: roleIsInvestigator,
            noun: "investigator",
            conflict: "investigator_exists",
          }
        : undefined;
    if (reserved !== undefined) {
      await authorizeRepository(
        gw.options.store,
        principal,
        projectId,
        repositoryId,
        "manage_project",
      );
      const overrides =
        await gw.options.store.listChannelAgentOverrides(repositoryId);
      const holder = Object.entries(overrides).find(
        ([heldBy, entry]) => heldBy !== agentId && reserved.holds(entry.role),
      );
      if (holder !== undefined) {
        throw new HttpError(
          409,
          reserved.conflict,
          `${holder[1].name ?? holder[0]} is already the ${reserved.noun} here. Demote it first.`,
        );
      }
      // An audit runs on its holder's own account — `dispatchOneMention`
      // submits every task with `actorId: candidate.userId`, and the
      // auditor's runs are no different. For an @mention that is fair: a
      // person named the agent and its owner opted into being nameable.
      // Nobody names an auditor. It spends continuously, forever, on
      // whatever its owner is paying with, and the person promoting it
      // needs only `manage_project` — so promoting a colleague's personal
      // agent would quietly commit their subscription to a permanent
      // background cost they never agreed to and would see only on a bill.
      //
      // An org-wide credential is one its owner has already published to
      // the organization as spendable by other people's requests. That is
      // the consent this needs, and it already exists, so the rule is that
      // only such an agent may hold the role.
      const candidate = (
        await gw.resolveChannelMentionCandidates(projectId, repositoryId)
      ).find(
        (entry) =>
          `${entry.userId}:${entry.provider}` === agentId ||
          entry.provider === agentId,
      );
      if (candidate !== undefined && candidate.visibility !== "org") {
        throw new HttpError(
          409,
          `${reserved.noun}_must_be_org_wide`,
          `${candidate.name} is a personal agent, and ${
            reserved.noun === "auditor" ? "an auditor" : "an investigator"
          } spends its owner's account without being asked. Ask ` +
            `${candidate.userName} to make it org-wide first, or promote an ` +
            `org-wide agent instead.`,
        );
      }
    }
    // A name is the agent's own, not this room's.
    //
    // An agent answers to one name, everywhere: renaming your own agent
    // here writes the account's call sign — the same record the Settings
    // screen writes through `/chat/providers/{id}/settings` — and clears
    // the per-repository names that would otherwise go on shadowing it in
    // the other channels. Renaming in one room and finding the old name
    // still up in the next is what this replaces.
    //
    // Only your own. An agent's name belongs to the account that connected
    // and added it, regardless of somebody else's repository permissions.
    const chatProviders = gw.options.operations.chatProviders;
    let namedAccountWide = false;
    if (name !== undefined && ownProvider !== undefined && chatProviders !== undefined) {
      try {
        await chatProviders.setSettings({
          userId: principal.user.id,
          provider: ownProvider,
          callSign: name,
        });
        namedAccountWide = true;
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        const code = (error as { code?: unknown }).code;
        // A vendor this deployment cannot see a connection for still gets
        // the old per-channel rename rather than an error: the roster is
        // showing the agent, so refusing to rename what is plainly there
        // would be the worse answer. Everything else — a name too long for
        // a call sign, most of all — is reported, because silently storing
        // it in one channel is how the two came to disagree.
        if (code !== "not_connected") {
          if (error instanceof Error && typeof status === "number" && typeof code === "string") {
            throw new HttpError(status, code, error.message);
          }
          throw error;
        }
      }
    }
    if (namedAccountWide) {
      await gw.options.store.clearChannelAgentNameOverrides(agentId);
    }
    const override = await gw.options.store.setChannelAgentOverride(
      repositoryId,
      agentId,
      {
        ...(name === undefined || namedAccountWide ? {} : { name }),
        ...(role === undefined ? {} : { role }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
      },
    );
    await gw.options.store.appendAudit(undefined, {
      type: "channel_agent_overridden",
      data: {
        projectId,
        repositoryId,
        agentId,
        ...(namedAccountWide ? { name, scope: "account" } : {}),
      },
    });
    gw.sendJson(response, 200, {
      // The name the agent now answers to, whichever record holds it: an
      // account-wide rename leaves no `name` on the override, and a client
      // reading only the override would have seen its own rename vanish.
      override: namedAccountWide ? { ...override, name } : override,
      ...(namedAccountWide ? { scope: "account" as const } : {}),
    });
    return true;
  }

  // Per-(repository, user, provider) opt-in membership: whether this
  // account's own connected agent is actually present in this channel's
  // roster, rather than every connected agent appearing in every
  // repository automatically. `agentId` here is always the bare provider
  // id (the same shape `myAgents()` in data.js mints for this account's
  // own agents, e.g. "anthropic") — a person only ever manages their own
  // membership through this route, never a teammate's, so there is no
  // `${userId}:${provider}` form to disambiguate here the way the rename
  // route above has to.
  //
  // `submit_task` rather than `view`: this changes who can be @mentioned
  // and dispatched to real work in a room shared with the rest of the
  // repository's collaborators, which is a stronger claim than reading or
  // renaming what is already there. The same reasoning `manage_project`
  // gets for `rollback` below — "this needs more than the permission that
  // merely lets you look" — applies here at the `submit_task` tier instead
  // of `manage_project`, because adding your own agent is closer to "I can
  // make it do work" than to "I can administer this repository".
  //
  // `DELETE` accepts a `?userId=` only for compatibility with older clients,
  // but it may identify only the caller. The account that brought an agent
  // in is the only account that may take it back out; repository moderation
  // permissions do not transfer ownership of somebody else's connection.
  // `POST` never accepts it: adding an agent to the channel is something
  // only its own owner can do for it, moderator or not.
  const channelAgentMembershipMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/agents/([^/]+)/membership$`,
      "u",
    ),
  );
  if (
    channelAgentMembershipMatch !== undefined &&
    (method === "POST" || method === "DELETE")
  ) {
    const [projectId = "", repositoryId = "", agentId = ""] =
      channelAgentMembershipMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "submit_task",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const membershipChannel = await gw.authorizeSubChannel({
      projectId,
      repositoryId,
      channelId: gw.requestedChannelId(
        url,
        method === "POST" ? await gw.optionalJsonBody(request) : undefined,
      ),
      principal,
    });
    const isMember = method === "POST";
    const targetUserId = principal.user.id;
    if (!isMember) {
      const requestedUserId = url.searchParams.get("userId")?.trim();
      if (
        requestedUserId !== undefined &&
        requestedUserId.length > 0 &&
        requestedUserId !== principal.user.id
      ) {
        throw new HttpError(
          403,
          "forbidden",
          "Only the user who added an agent can remove it",
        );
      }
    }
    await gw.options.store.setChannelAgentMember(
      repositoryId,
      targetUserId,
      agentId,
      isMember,
      membershipChannel.id,
    );
    await gw.options.store.appendAudit(undefined, {
      type: "channel_agent_membership_changed",
      data: {
        projectId,
        repositoryId,
        channelId: membershipChannel.id,
        provider: agentId,
        isMember,
        userId: targetUserId,
        ...(targetUserId === principal.user.id
          ? {}
          : { actorId: principal.user.id }),
      },
    });
    gw.sendJson(response, 200, { member: isMember });
    return true;
  }

  return false;
}
