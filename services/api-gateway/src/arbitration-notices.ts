/**
 * The arbitration lines standing in rooms, and what it takes to take one back.
 *
 * When one task is held behind another the room is told, in the held agent's
 * own thread: "I'll start once @Hades is done with the payment ledger." That
 * line is true for as long as the collision is, and the moment it stops being
 * true it has to go — a room full of stale "waiting on" replies is worse than
 * a room that never said anything, because the reader cannot tell which of
 * them still applies.
 *
 * Keeping that promise is the whole of this file, and it is more work than it
 * sounds: a hold routinely outlives the process that announced it, so the
 * line has to be findable from the thread it hangs in as well as from memory,
 * and it has to retire on its own condition rather than on a sweep.
 *
 * Split out of `ApiGateway` because it is exactly that — one promise, one
 * piece of state, and a boundary that fell where the code already was. What
 * it needs from the gateway is declared as {@link NoticeBoardHost} and
 * nothing more, which is the point: before this, "what does the arbitration
 * code touch" was a question you answered by reading fifteen thousand lines.
 */

import type { ChannelMessage, SubmittedTask } from "@coord/persistence";

import {
  arbitrationLine,
  arbitrationReleaseLine,
  type DeferredRef,
} from "./arbitration-line.js";
import { isCoordinatorNotice } from "./gateway-util.js";
import type { ApiGateway } from "./server.js";
import {
  CHANNEL_ARBITRATION_PREFIX,
  TASK_STATUSES_PAST_STOPPING,
  arbitrationNoticeKind,
} from "./task-narration.js";

/**
 * One arbitration line standing somewhere, and what it takes to take it back.
 *
 * A hold is normally the held agent's own reply inside its thread, so removing
 * it needs the root as well as the reply. The room-level line the coordinator
 * posts when no agent account resolves — and every notice older deployments
 * left behind — is a root of its own, and has no `replyId`.
 */
interface StandingArbitrationNotice {
  projectId: string;
  repositoryId: string;
  /** The thread root, when this is a reply; the notice itself otherwise. */
  messageId: string;
  /** Set only when the notice is a reply inside a thread. */
  replyId?: string;
  /** The task the line is about — the held one, for a hold. */
  taskId: string;
  content: string;
  kind: "hold" | "advisory";
  /**
   * The other tasks the line names, when this process is the one that posted
   * it. Empty after a restart, which is exactly what it means: the line is
   * still findable, but who it was about is no longer known.
   */
  alsoNamed: readonly string[];
}

/**
 * What the notice board needs from the gateway, and nothing else.
 *
 * A `Pick` rather than a hand-written interface on purpose. Two of these
 * methods take long inline object types, and a copy of them here would be
 * one refactor away from drifting out of step with the originals while still
 * compiling.
 */
export type NoticeBoardHost = Pick<
  ApiGateway,
  | "options"
  | "watchedChannelTasks"
  | "channelAgentNamer"
  | "appendChannelEntry"
  | "appendChannelThreadReply"
  | "watchedTaskAgent"
>;

export class ArbitrationNoticeBoard {
  /**
   * The lines currently standing, by the id of the entry that carries each —
   * a reply's own id when it is one, a root's otherwise.
   *
   * Memory only, and deliberately not the sole record: a hold routinely
   * outlives the process that announced it, which is why a line can also be
   * found from the thread it hangs in and why
   * {@link reconcileArbitrationNotices} can finish the job without this map.
   */
  private readonly arbitrationNotices = new Map<
    string,
    StandingArbitrationNotice
  >();

  public constructor(private readonly host: NoticeBoardHost) {}

  /** Dropped on shutdown; every line is still findable from its thread. */
  public clear(): void {
    this.arbitrationNotices.clear();
  }

  /**
   * The held agent's own account of one admission decision, in its thread.
   *
   * It used to be a line in the room under the coordinator's name, on the
   * argument that the coordinator made the decision and putting it in an
   * agent's mouth would suggest agents negotiate with each other. What that
   * produced was a referee's announcement floating in the channel beside the
   * threads it was about, and a person following one agent's work watched it
   * go quiet with the explanation somewhere else entirely. Whether the
   * coordinator or the agent decided is not the reader's question; "why has
   * this stopped" is, and the thread is where it is asked.
   *
   * So the agent says it, in the first person, where its other lines are: "I'll
   * start once they're done". It is still one sentence — the other agent, and
   * what happens next. Every earlier version spent a second and third clause
   * justifying the decision, which read as the coordinator explaining itself
   * to a room that only wanted to know the order. The blocker may have
   * finished between the event and this lookup — the line still stands, it
   * just reads as history.
   *
   * Two agents is the ordinary case, not the only one. One agent given two
   * tasks that collide is arbitrated exactly like two agents that do, and the
   * sentence came out "@Hades and @Hades have conflicting files — @Hades will
   * wait for @Hades to go first": a true decision phrased as a stranger's
   * quarrel, naming the one thing the reader already knew and none of what
   * they needed. So when both sides resolve to one agent it is said as what it
   * is — two tasks, and the order they will be taken in — with the tasks told
   * apart by what each was asked to do.
   *
   * Answers whether the thread has now been told, so the caller can leave the
   * generic narration of the same event unsaid: a thread does not need to be
   * handed "waiting my turn" and "looks like @Codex has the same files open"
   * one after the other about a single admission.
   */
  public async announceArbitration(
    watched: { projectId: string; repositoryId: string; taskId: string },
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const describe = await this.host.channelAgentNamer(
      watched.projectId,
      watched.repositoryId,
    );
    const held = describe.name(watched.taskId);
    const blockedBy = (
      Array.isArray(data["blockedBy"]) ? data["blockedBy"] : []
    ).filter((entry): entry is string => typeof entry === "string");
    // Deduplicated by the name that will be printed, not by task id. Two of
    // one agent's tasks blocking a third resolve to the same name, and
    // "@Hades and @Hades" is not a list of two blockers.
    const blockers = [
      ...new Set(blockedBy.slice(0, 2).map((entry) => describe.name(entry))),
    ];
    const blocker =
      blockers.length > 0 ? blockers.join(" and ") : "work in flight";
    // Only a resolved agent name can be shared by two tasks and still mean one
    // agent. The objective fallback is per task, so two of them matching would
    // be two tasks asked for the same thing, which is a different sentence.
    const oneAgent =
      held.startsWith("@") && blockers.length === 1 && blockers[0] === held;
    const heldWork = describe.objective(watched.taskId);
    const blockerWork =
      blockedBy.length > 0
        ? [...new Set(blockedBy.slice(0, 2).map(describe.objective))].join(
            " and ",
          )
        : "the work already in flight";
    const fileList = (value: unknown): string[] =>
      (Array.isArray(value) ? value : []).filter(
        (entry): entry is string => typeof entry === "string",
      );
    const deferred: DeferredRef[] = (
      Array.isArray(data["deferredResources"]) ? data["deferredResources"] : []
    ).flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }
      const resource = entry as {
        resourceType?: unknown;
        resourceId?: unknown;
        heldBy?: unknown;
        implied?: unknown;
      };
      return typeof resource.resourceId === "string"
        ? [
            {
              resourceType:
                typeof resource.resourceType === "string"
                  ? resource.resourceType
                  : "file",
              resourceId: resource.resourceId,
              implied: resource.implied === true,
            },
          ]
        : [];
    });
    // Who holds the withheld half, for the case `blockedBy` is empty by
    // design. Taken from the resources the room is about to be told about, so
    // the name in the sentence is the name behind the loss it describes.
    const holders = [
      ...new Set(
        (Array.isArray(data["deferredResources"])
          ? data["deferredResources"]
          : []
        )
          .flatMap((entry) =>
            typeof entry === "object" && entry !== null
              ? ((entry as { heldBy?: unknown }).heldBy ?? [])
              : [],
          )
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 2)
          .map((entry) => describe.name(entry)),
      ),
    ];
    const status = String(data["status"] ?? "");
    const approved =
      status === "approved" || status === "approved_with_constraints";
    // Whose voice this is decides the sentence, so it is settled before the
    // sentence is written rather than after.
    const speaker = await this.arbitrationNoticeThread(watched);
    const announcement = {
      held,
      blockedByNames: blockers,
      holderNames: holders,
      heldWork,
      blockerWork,
      status,
      firstPerson: speaker !== undefined,
      partial: data["partial"] === true,
      grantedFiles: fileList(data["grantedFiles"]),
      deferred,
    };
    if (approved && data["partial"] !== true) {
      // The hold described a temporary condition, and the condition is over.
      // In a thread that is worth a sentence — the agent said it was waiting,
      // so it says what it is doing now, and the stale line goes rather than
      // standing above its own contradiction. In the room the line is only
      // ever removed: nobody there is following this particular run, and a
      // second announcement about it starting is the noise that moving these
      // into threads was meant to end.
      let spoken = false;
      await this.replaceArbitrationNotice(
        watched,
        (prior) => {
          // Nothing standing, or nothing standing in a thread, or nobody left
          // to say it: all three are simply a withdrawal, because a release
          // only means anything as the same voice that said it was waiting.
          if (prior?.replyId === undefined || speaker === undefined) {
            return undefined;
          }
          spoken = true;
          // Named from what the hold recorded, not from this event: an
          // approval carries no `blockedBy`, because from its own point of
          // view there is nothing left to be blocked by.
          const cleared = prior.alsoNamed.slice(0, 2);
          return {
            content: arbitrationReleaseLine({
              ...announcement,
              blockedByNames: [...new Set(cleared.map(describe.name))],
              blockerWork:
                cleared.length > 0
                  ? [...new Set(cleared.map(describe.objective))].join(" and ")
                  : blockerWork,
            }),
            alsoNamed: [],
          };
        },
        speaker,
      );
      return spoken;
    }
    const content = arbitrationLine(announcement);
    await this.replaceArbitrationNotice(
      watched,
      () => ({ content, alsoNamed: blockedBy }),
      speaker,
    );
    return speaker !== undefined;
  }

  /**
   * The thread an arbitration line belongs in, and the agent that speaks it.
   *
   * Both halves have to resolve or there is nothing to say in an agent's name:
   * a thread with no agent behind it would put first-person words under
   * whoever last posted, and an agent with no thread has nowhere to say them.
   * Either failure falls back to the room-level coordinator line, which is
   * what this used to be for everybody.
   *
   * The account is resolved from the task rather than taken from the watcher's
   * `authorId`, because that field is whoever caused the watch to exist — for
   * a run resumed from the dashboard it is the person who pressed play, and
   * putting an agent's sentence under their name is worse than saying it in
   * the room.
   */
  public async arbitrationNoticeThread(watched: {
    projectId: string;
    repositoryId: string;
    taskId: string;
  }): Promise<{ messageId: string; authorId: string } | undefined> {
    const task = (
      await this.host.options.store
        .listSubmittedTasks({ repositoryId: watched.repositoryId })
        .catch((): SubmittedTask[] => [])
    ).find((entry) => entry.id === watched.taskId);
    if (task === undefined) {
      return undefined;
    }
    const agent = await this.host.watchedTaskAgent(task).catch(() => undefined);
    if (agent === undefined) {
      return undefined;
    }
    // The live watch first: it holds the root this run is already narrating
    // into, which is the thread the reader has open. `conversationId` is the
    // same fact on the row for a run this process is not following, and the
    // scan is what is left for a task whose thread predates that column.
    let messageId =
      this.host.watchedChannelTasks.get(watched.taskId)?.messageId ??
      task.conversationId;
    if (messageId === undefined) {
      messageId = (
        await this.host.options.store
          .listChannelMessages(watched.repositoryId, "", { limit: 50 })
          .catch((): ChannelMessage[] => [])
      ).find((message) => message.taskId === watched.taskId)?.id;
    }
    return messageId === undefined
      ? undefined
      : {
          messageId,
          authorId: `${agent.ownerId}:${agent.provider}`,
        };
  }

  /**
   * Keeps at most one temporary sequencing line standing for a held task.
   *
   * The prior line is looked for in the thread as well as in memory. A hold
   * routinely outlives the process that announced it — this deployment
   * restarts on every deploy, and being held is precisely a state that waits —
   * so trusting the Map alone meant a restart both stranded the old line and
   * posted a second one beside it the next time the same task was arbitrated.
   *
   * What replaces it is asked for rather than passed in, because the answer
   * depends on what was standing: a release only has anything to say if there
   * was a hold to release, and it names the work it was waiting on from what
   * that hold recorded. Answering nothing withdraws and leaves the thread
   * quiet, which is what every ending does.
   */
  private async replaceArbitrationNotice(
    watched: { projectId: string; repositoryId: string; taskId: string },
    next?: (prior: StandingArbitrationNotice | undefined) =>
      | { content: string; alsoNamed: readonly string[] }
      | undefined,
    speaker?: { messageId: string; authorId: string },
  ): Promise<void> {
    const prior = await this.findArbitrationNotice(watched);
    const replacement = next?.(prior);
    if (replacement !== undefined && prior?.content === replacement.content) {
      return;
    }
    if (prior !== undefined) {
      await this.dropArbitrationNotice(prior);
      this.arbitrationNotices.delete(prior.replyId ?? prior.messageId);
    }
    if (replacement === undefined) {
      return;
    }
    const { content, alsoNamed } = replacement;
    const posted: { messageId: string; replyId?: string } =
      speaker === undefined
        ? // No agent account resolved, so the room says it in its own name and
          // carries the task on the message — the shape every notice had
          // before these moved into threads, and the only one a line with
          // nobody to attribute it to can take.
          {
            messageId: (
              await this.host.appendChannelEntry({
                projectId: watched.projectId,
                repositoryId: watched.repositoryId,
                kind: "system",
                authorId: "coordinator",
                content,
                taskId: watched.taskId,
              })
            ).id,
          }
        : {
            messageId: speaker.messageId,
            // The agent's own kind, so the bubble is the agent's: this is the
            // same account it gives of everything else it does, and the reader
            // already knows who is speaking from the name on it.
            replyId: (
              await this.host.appendChannelThreadReply({
                projectId: watched.projectId,
                repositoryId: watched.repositoryId,
                messageId: speaker.messageId,
                kind: "agent",
                authorId: speaker.authorId,
                content,
              })
            ).id,
          };
    // Only a marked line is remembered, because the marker is the whole of
    // what makes one findable again — an unmarked one (the release) is a
    // statement about something that happened, and is never taken back.
    if (content.startsWith(CHANNEL_ARBITRATION_PREFIX)) {
      this.arbitrationNotices.set(posted.replyId ?? posted.messageId, {
        projectId: watched.projectId,
        repositoryId: watched.repositoryId,
        messageId: posted.messageId,
        ...(posted.replyId === undefined ? {} : { replyId: posted.replyId }),
        taskId: watched.taskId,
        content,
        kind: "hold",
        alsoNamed,
      });
    }
  }

  /**
   * Takes back a notice because the condition it describes is over.
   *
   * Called from every path a held task can leave by — it finished, it failed,
   * it was cancelled from its thread, it never started, the watchdog gave up
   * on it. Each of those used to drop the watcher and leave "starts once the
   * other one is done" standing in the room as a promise about a run that no
   * longer exists.
   *
   * Silent and best-effort: an ending has already been said, and a sequencing
   * notice ceasing to be true is not itself news.
   */
  public async withdrawArbitrationNotice(watched: {
    projectId: string;
    repositoryId: string;
    taskId: string;
  }): Promise<void> {
    await this.replaceArbitrationNotice(watched).catch(() => undefined);
  }

  /**
   * The hold standing for this task, whether or not this process posted it.
   *
   * Memory first, because it is exact and free. Failing that the thread and
   * the room are read, which is the case that matters: a hold routinely
   * outlives the process that announced it, and after a restart the only
   * record left is the line itself.
   *
   * Newest first in both, because what is being replaced is whatever was last
   * said about this task's collision, and an older line about the same one is
   * exactly what a second announcement would otherwise sit beside.
   */
  private async findArbitrationNotice(watched: {
    projectId: string;
    repositoryId: string;
    taskId: string;
  }): Promise<StandingArbitrationNotice | undefined> {
    const remembered = [...this.arbitrationNotices.values()]
      .reverse()
      .find(
        (notice) =>
          notice.kind === "hold" && notice.taskId === watched.taskId,
      );
    if (remembered !== undefined) {
      return remembered;
    }
    const messages =
      (await this.host.options.store
        .listChannelMessages(watched.repositoryId, "", { limit: 50 })
        .catch(() => undefined)) ?? [];
    // Only a hold is replaced by a hold. An advisory line about the same task
    // is a different statement with a different end condition, and silently
    // swapping one for the other would lose the record that two agents were
    // allowed to overlap.
    const isHold = (entry: {
      kind: string;
      authorId: string;
      content: string;
    }): boolean =>
      isCoordinatorNotice(entry) &&
      arbitrationNoticeKind(entry.content) === "hold";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message === undefined || message.taskId !== watched.taskId) {
        continue;
      }
      // The thread's own replies before the root, because that is where a
      // hold is written now. The root form is the room-level fallback, and
      // every notice a deployment before this one left behind.
      const replies = message.replies ?? [];
      for (let at = replies.length - 1; at >= 0; at -= 1) {
        const reply = replies[at];
        if (reply !== undefined && isHold(reply)) {
          return {
            projectId: watched.projectId,
            repositoryId: watched.repositoryId,
            messageId: message.id,
            replyId: reply.id,
            taskId: watched.taskId,
            content: reply.content,
            kind: "hold",
            alsoNamed: [],
          };
        }
      }
      if (isHold(message)) {
        return {
          projectId: watched.projectId,
          repositoryId: watched.repositoryId,
          messageId: message.id,
          taskId: watched.taskId,
          content: message.content,
          kind: "hold",
          alsoNamed: [],
        };
      }
    }
    return undefined;
  }

  /** One notice removed, and the removal broadcast. */
  private async dropArbitrationNotice(notice: {
    projectId: string;
    repositoryId: string;
    messageId: string;
    replyId?: string;
  }): Promise<void> {
    if (notice.replyId !== undefined) {
      await this.host.options.store.deleteChannelReply(
        notice.repositoryId,
        notice.messageId,
        notice.replyId,
      );
      await this.host.options.store.appendAudit(undefined, {
        type: "channel_reply_deleted",
        data: {
          projectId: notice.projectId,
          repositoryId: notice.repositoryId,
          messageId: notice.messageId,
          replyId: notice.replyId,
        },
      });
      return;
    }
    await this.host.options.store.deleteChannelMessage(
      notice.repositoryId,
      notice.messageId,
    );
    await this.host.options.store.appendAudit(undefined, {
      type: "channel_message_deleted",
      data: {
        projectId: notice.projectId,
        repositoryId: notice.repositoryId,
        messageId: notice.messageId,
      },
    });
  }

  /**
   * Sweeps up arbitration notices whose collision is over.
   *
   * The live paths withdraw their own — this is for the ones no live path can
   * reach. Three shapes, all of which left a permanent line in the room:
   *
   *   - a restart between the hold and its release, after which nothing in
   *     memory knew the message existed;
   *   - the blocker finishing while the held task carries on without ever
   *     being re-admitted, so the sentence "starts once that one is done"
   *     describes something that already happened;
   *   - the advisory "can run together" line, which is about two runs that
   *     are running, long after both of them stopped.
   *
   * A notice whose tasks the store cannot find at all counts as over too: the
   * work is gone, and the line about it is the only thing left claiming it is
   * in flight.
   */
  public async reconcileArbitrationNotices(): Promise<void> {
    const repositories = await this.host.options.store.listRepositories();
    for (const repository of repositories) {
      const [messages, tasks] = await Promise.all([
        this.host.options.store.listChannelMessages(repository.id, "", {
          limit: 40,
        }),
        this.host.options.store.listSubmittedTasks({ repositoryId: repository.id }),
      ]);
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const settled = (taskId: string | undefined): boolean => {
        if (taskId === undefined) {
          return false;
        }
        const status = byId.get(taskId)?.status;
        return status === undefined || TASK_STATUSES_PAST_STOPPING.has(status);
      };
      for (const message of messages) {
        const subject = message.taskId;
        if (subject === undefined) {
          // Written before notices carried their task, or a thread that has
          // none. Nothing to decide it against, and guessing from the words is
          // how a line that is still true ends up lost.
          continue;
        }
        // A hold hangs in the held task's own thread now, so both places are
        // read: the replies for what this deployment writes, the root itself
        // for the room-level fallback and for every notice an older
        // deployment left standing.
        const candidates: {
          id: string;
          entry: { kind: string; authorId: string; content: string };
          replyId?: string;
        }[] = [
          ...(message.replies ?? []).map((reply) => ({
            id: reply.id,
            entry: reply,
            replyId: reply.id,
          })),
          { id: message.id, entry: message },
        ];
        const notices = candidates.filter((candidate) =>
          isCoordinatorNotice(candidate.entry),
        );
        for (const notice of notices) {
          const tracked = this.arbitrationNotices.get(notice.id);
          const others = tracked?.alsoNamed ?? [];
          const kind =
            tracked?.kind ?? arbitrationNoticeKind(notice.entry.content);
          // A hold is over as soon as either end of it is: the held task has
          // stopped needing to be told when it starts, or the work it was
          // waiting on has finished. An advisory line describes two runs being
          // in flight together, so it waits for both of them to stop. A notice
          // this process did not post — the restart case — knows only its own
          // subject, which is what the thread it hangs in records.
          const over =
            kind === "advisory"
              ? [subject, ...others].every((id) => settled(id))
              : settled(subject) ||
                (others.length > 0 && others.every((id) => settled(id)));
          if (!over) {
            continue;
          }
          await this.dropArbitrationNotice({
            projectId: message.projectId,
            repositoryId: repository.id,
            messageId: message.id,
            ...(notice.replyId === undefined
              ? {}
              : { replyId: notice.replyId }),
          }).catch(() => undefined);
          this.arbitrationNotices.delete(notice.id);
        }
      }
    }
  }
}
