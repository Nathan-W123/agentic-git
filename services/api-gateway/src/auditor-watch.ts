/**
 * The auditor: reading canonical as it advances, and saying what it finds.
 *
 * A promotion lands, this diffs it, asks a model whether anything in it is
 * wrong, and posts what comes back into the room as findings somebody can
 * approve. An approved finding with `selffix` dispatches its own fix.
 *
 * Four pieces of state, and each of them is load-bearing:
 *
 *   - `auditorSequence` is the audit-log position consumed so far. It starts
 *     at the log head rather than at zero, because a fresh process must not
 *     treat every promotion in the repository's history as news and audit all
 *     of it. Nothing is lost by skipping what happened while this process was
 *     down: each audit diffs from the last audited revision, not from the
 *     event that woke it, so a missed promotion folds into the next audit.
 *   - `auditorSince` is when this process started, and so the oldest
 *     promotion it treats as news.
 *   - `auditsRunning` keeps a slow audit from being started twice.
 *   - `auditorTimer` is the poll, unreferenced so it cannot hold the process
 *     open.
 *
 * Split out of `ApiGateway` because that state is nobody else's and this is
 * the only code that reads it. What it still needs from the gateway is
 * declared as {@link AuditorHost} — nine members, which is more coupling than
 * anybody would design from scratch and is exactly the value of writing it
 * down: it is now a list that can be argued with rather than an unknown.
 */

import type { SubmittedTask } from "@coord/persistence";
import { localAgentsOnly } from "@coord/shared-types";

import {
  buildAuditPrompt,
  formatAuditSummary,
  formatFinding,
  findingsReferencedBy,
  fixObjectiveFor,
  parseAuditFindings,
  parseFindingReply,
  readsAsApproval,
  type AuditFinding,
} from "./auditor.js";
import type { ApiGateway, ChannelMentionCandidate } from "./server.js";

const AUDITOR_POLL_INTERVAL_MS = 15_000;

const AUDITOR_EVENT_BATCH = 25;

const AUDIT_TIMEOUT_MS = 180_000;

const AUDIT_THREAD_TITLE = "Audit log";

/**
 * What the auditor needs from the gateway, and nothing else.
 *
 * A `Pick` rather than a hand-written interface: several of these take long
 * inline object types, and a copy of them here would be one refactor away
 * from drifting out of step while still compiling.
 */
export type AuditorHost = Pick<
  ApiGateway,
  | "options"
  | "appendChannelEntry"
  | "appendChannelThreadReply"
  | "askAgent"
  | "auditorFor"
  | "bestFitFor"
  | "dispatchOneMention"
  | "objectivesBehind"
  | "projectOverTokenBudget"
>;

export class AuditorWatch {
  /** The audit-log position consumed so far; see the note above. */
  private auditorSequence: number | undefined;
  /** When this process started, and so the oldest promotion it calls news. */
  private readonly auditorSince = new Date().toISOString();
  /** Repositories with an audit in flight, so a slow one is not started twice. */
  private readonly auditsRunning = new Set<string>();
  private auditorTimer: NodeJS.Timeout | undefined;

  public constructor(private readonly host: AuditorHost) {}

  /** Stops the poll. Anything in flight finishes on its own. */
  public stop(): void {
    if (this.auditorTimer !== undefined) {
      clearInterval(this.auditorTimer);
      this.auditorTimer = undefined;
    }
  }

  /**
   * Starts the auditor's watch on canonical.
   *
   * A poller and not a scheduler, and the distinction is the whole design.
   * There is no cron anywhere in this system, and an auditor on a clock
   * would wake on a repository nobody had touched, re-read it, and bill
   * somebody for confirming that nothing changed. Waking on `canonical_
   * promoted` instead means the trigger is a real change by construction:
   * no change, no event, no spend, and no code needed to arrange that.
   *
   * Inert unless the deployment can actually read a diff. A gateway with no
   * `canonicalDiff` operation has no repository access, and an auditor that
   * cannot see a change must not run and quietly report the repository
   * clean.
   */
  public startAuditorWatch(): void {
    if (
      this.auditorTimer !== undefined ||
      this.host.options.operations.canonicalDiff === undefined
    ) {
      return;
    }
    this.auditorTimer = setInterval(
      () => {
        void this.pumpAuditor();
      },
      this.host.options.auditorPollIntervalMs ?? AUDITOR_POLL_INTERVAL_MS,
    );
    // Never a reason to hold the process open for an audit.
    this.auditorTimer.unref?.();
  }

  /**
   * Consumes new canonical promotions and audits the repositories they
   * touched.
   *
   * Deliberately quiet about everything it decides not to do: most
   * promotions are in repositories with no auditor, and saying so anywhere
   * would be noise proportional to how much the team ships.
   */
  private async pumpAuditor(): Promise<void> {
    try {
      // Until the first new promotion anchors a sequence, the window is
      // "since this process started" rather than "after sequence N". There is
      // no cheap way to ask this log for its head — the filter pages forward
      // from the oldest match, so an unanchored `limit` query would return
      // the *first* promotions the repository ever made and audit its whole
      // history. A timestamp asks the question actually being asked.
      const events = await this.host.options.store.listAuditEvents({
        types: ["canonical_promoted"],
        ...(this.auditorSequence === undefined
          ? { occurredAfter: this.auditorSince }
          : { afterSequence: this.auditorSequence }),
        limit: AUDITOR_EVENT_BATCH,
      });
      for (const record of events) {
        this.auditorSequence = Math.max(
          this.auditorSequence ?? 0,
          record.sequence,
        );
        const data = (record.event.data ?? {}) as Record<string, unknown>;
        const repositoryId = data["repositoryId"];
        const projectId = data["projectId"];
        const revision = data["revision"];
        const previousRevision = data["previousRevision"];
        if (
          typeof repositoryId !== "string" ||
          typeof projectId !== "string" ||
          typeof revision !== "string" ||
          typeof previousRevision !== "string"
        ) {
          // Written before this event carried a repository, or by something
          // that does not fill it in. Nothing to audit against.
          //
          // Said out loud, on stderr, because this skip is indistinguishable
          // from "no auditor here" and from "the auditor found nothing" to
          // anyone watching the room — and one writer omitting the stamp took
          // hours to find precisely because all three look like silence.
          process.stderr.write(
            `[auditor] skipped promotion at sequence ${String(record.sequence)}: ` +
              `event carries no repositoryId/projectId to audit against\n`,
          );
          continue;
        }
        await this.auditCanonicalAdvance({
          projectId,
          repositoryId,
          previousRevision,
          revision,
          sequence: record.sequence,
        });
      }
    } catch (error) {
      // A failed poll must never take the gateway down or stop the next one.
      process.stderr.write(
        `[auditor] poll failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  /**
   * One repository's audit of one canonical advance.
   *
   * The diff base is the last revision this repository's auditor actually
   * finished looking at — not the `previousRevision` of the event that woke
   * it. That is what makes a missed event harmless: a promotion that landed
   * while the process was down, or while an earlier audit was still running,
   * is inside the next audit's range instead of being skipped. The first
   * audit in a repository has no such base and uses the event's own.
   */
  private async auditCanonicalAdvance(input: {
    projectId: string;
    repositoryId: string;
    previousRevision: string;
    revision: string;
    sequence: number;
  }): Promise<void> {
    const { projectId, repositoryId, revision, sequence } = input;
    if (this.auditsRunning.has(repositoryId)) {
      // An audit outlives the poll that started it. Skipping here rather than
      // queueing is deliberate: the next promotion's audit will diff from the
      // running one's base and cover this change too, so nothing is lost and
      // a busy repository cannot stack audits on top of each other.
      return;
    }
    const auditor = await this.host.auditorFor(projectId, repositoryId);
    if (auditor === undefined) {
      return;
    }
    const cursor = await this.host.options.store.getAuditorCursor(repositoryId);
    if (cursor?.paused === true) {
      // Switched off. The cursor is deliberately left where it is, so
      // resuming audits everything that landed in the meantime rather than
      // skipping it — which is the difference between pausing and demoting.
      return;
    }
    if (cursor !== undefined && cursor.sequence >= sequence) {
      // Already handled by a previous process. Not an error.
      return;
    }
    // `""` is a row that exists without an audit behind it — written by
    // pausing before anything had run — and is not a revision to diff from.
    const fromRevision =
      cursor?.revision === undefined || cursor.revision === ""
        ? input.previousRevision
        : cursor.revision;
    if (fromRevision === revision) {
      return;
    }
    if (await this.host.projectOverTokenBudget(projectId)) {
      // The budget exists to stop unwatched spend, and this is the least
      // watched spend in the product. `leaseWork` would refuse the *fix*
      // tasks later, but it would not refuse this — the audit is a chat
      // completion, not a leased task — so the check has to be here.
      return;
    }
    this.auditsRunning.add(repositoryId);
    try {
      await this.runAudit({
        projectId,
        repositoryId,
        auditor,
        fromRevision,
        toRevision: revision,
      });
      await this.host.options.store.saveAuditorCursor({
        repositoryId,
        revision,
        sequence,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      // The cursor is deliberately not advanced: an audit that failed has not
      // examined this range, and the next promotion should still cover it.
      process.stderr.write(
        `[auditor] audit failed for ${repositoryId}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    } finally {
      this.auditsRunning.delete(repositoryId);
    }
  }

  /**
   * Reads the change, asks the auditor about it, and writes what it says.
   *
   * The audit itself is a chat completion rather than a submitted task,
   * because auditing is read-only and the task pipeline exists to land
   * changes: a task that deliberately writes nothing comes back `empty`,
   * which the pipeline records as a *failed* task. A clean audit is the
   * commonest outcome there is, and it must not look like a failure.
   *
   * The consequence is that the diff has to be carried in the prompt — the
   * provider CLIs run in an empty scratch directory and cannot read the
   * repository — which is also why the diff is bounded before it gets here.
   */
  public async resumeAuditing(input: {
    projectId: string;
    repositoryId: string;
  }): Promise<"audited" | "nothing_to_audit" | "unavailable"> {
    const { projectId, repositoryId } = input;
    const auditor = await this.host.auditorFor(projectId, repositoryId);
    if (auditor === undefined || this.host.options.operations.canonicalHead === undefined) {
      return "unavailable";
    }
    if (this.auditsRunning.has(repositoryId)) {
      return "audited";
    }
    const head = await this.host.options.operations.canonicalHead({
      projectId,
      repositoryId,
    });
    const cursor = await this.host.options.store.getAuditorCursor(repositoryId);
    if (head === undefined || cursor?.revision === head) {
      return "nothing_to_audit";
    }
    if (cursor === undefined || cursor.revision === "") {
      // Never audited anything, so there is no "since" to audit from and
      // nothing has changed on this auditor's watch. Anchoring here rather
      // than reading the whole repository: an audit of an entire codebase is
      // an unbounded cost nobody asked for by flicking a switch.
      await this.host.options.store.saveAuditorCursor({
        repositoryId,
        revision: head,
        sequence: cursor?.sequence ?? 0,
        updatedAt: new Date().toISOString(),
      });
      return "nothing_to_audit";
    }
    if (await this.host.projectOverTokenBudget(projectId)) {
      return "unavailable";
    }
    this.auditsRunning.add(repositoryId);
    // Not awaited: an audit is a whole model call and the person who flicked
    // the switch should not be watching a spinner for it. Failures land in
    // the log, and the next promotion re-covers the range because the cursor
    // only moves on success.
    void (async () => {
      try {
        await this.runAudit({
          projectId,
          repositoryId,
          auditor,
          fromRevision: cursor.revision,
          toRevision: head,
        });
        await this.host.options.store.saveAuditorCursor({
          repositoryId,
          revision: head,
          sequence: cursor.sequence,
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        process.stderr.write(
          `[auditor] resume audit failed for ${repositoryId}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      } finally {
        this.auditsRunning.delete(repositoryId);
      }
    })();
    return "audited";
  }

  private async runAudit(input: {
    projectId: string;
    repositoryId: string;
    auditor: ChannelMentionCandidate;
    fromRevision: string;
    toRevision: string;
  }): Promise<void> {
    // Fires on every canonical promotion, which is to say on every merge this
    // project makes, and nobody asked for it. Refused before the diff is even
    // read: a deployment that will not spend agents on its own initiative
    // should not spend the repository work either.
    if (localAgentsOnly()) {
      return;
    }
    const { projectId, repositoryId, auditor } = input;
    const diff = await this.host.options.operations.canonicalDiff?.({
      projectId,
      repositoryId,
      fromRevision: input.fromRevision,
      toRevision: input.toRevision,
    });
    if (diff === undefined || diff.patch.trim().length === 0) {
      // A promotion with no textual change — a revert to an identical tree, a
      // merge that moved the branch pointer only. Nothing to read.
      return;
    }
    const objectives = await this.host.objectivesBehind(
      repositoryId,
      input.fromRevision,
      input.toRevision,
    );
    const answer = await this.host.askAgent(
      auditor,
      buildAuditPrompt({
        repositoryId,
        fromRevision: input.fromRevision,
        toRevision: input.toRevision,
        files: diff.files,
        patch: diff.patch,
        truncated: diff.truncated,
        ...(objectives.length === 0 ? {} : { objectives }),
      }),
      AUDIT_TIMEOUT_MS,
    );
    if (answer.text === undefined) {
      throw new Error(answer.error ?? "the auditor did not answer");
    }
    const findings = parseAuditFindings(answer.text);
    const authorId = `${auditor.userId}:${auditor.provider}`;
    // One thread for the life of the repository, not one per audit.
    //
    // A thread per merge buried the channel and, worse, gave each audit no
    // memory of the last: the point of an auditor is that it is reading the
    // same codebase repeatedly, and every finding it has already raised is
    // context for the next one. One thread is where that accumulates.
    const root = await this.auditThreadRoot({
      projectId,
      repositoryId,
      authorId,
    });
    // Said even when there is nothing to say, for now.
    //
    // The argument against is real — an auditor that posts "all clear" after
    // every merge is one everybody mutes, and a muted auditor is worse than
    // none. But it is inside a thread rather than in the room, and until
    // somebody has watched it work at least once, silence and "not running"
    // look exactly alike. Worth revisiting once it has earned trust.
    await this.host.appendChannelThreadReply({
      projectId,
      repositoryId,
      messageId: root.id,
      authorId,
      content:
        findings.length === 0
          ? `Audited ${String(diff.files.length)} file${
              diff.files.length === 1 ? "" : "s"
            } at ${input.toRevision.slice(0, 8)} — nothing to report` +
            // An all-clear over a diff that was cut short is a different
            // claim from an all-clear over the whole change, and the two read
            // identically unless this says so. The findings path has carried
            // the caveat since it was written; the clean path, where it
            // matters more, did not.
            (diff.truncated
              ? ", though the change was too large to read in full."
              : ".")
          : formatAuditSummary({
              findings,
              fromRevision: input.fromRevision,
              toRevision: input.toRevision,
              fileCount: diff.files.length,
              truncated: diff.truncated,
            }),
      // Same reasoning as the findings below: an audit's report of itself is
      // what the thread is for, not the run thinking aloud.
      kind: "outcome",
    });
    for (const finding of findings) {
      await this.host.appendChannelThreadReply({
        projectId,
        repositoryId,
        messageId: root.id,
        authorId,
        content: formatFinding(finding),
        // A finding is the thing the audit exists to produce, so it is an
        // outcome and not commentary. Left unmarked it defaulted to `agent`,
        // which the thread reads as the run talking to itself and folds away
        // into the thinking block — burying the one part anybody opened the
        // thread for, and denying it the fold and the simplify control every
        // other summary gets.
        kind: "outcome",
      });
    }
    // Findings get a line in the room; a clean audit does not.
    //
    // The mute argument above holds for "all clear after every merge" and
    // fails for a defect nobody has seen yet. Bumping the thread moves it to
    // the foot of the channel but says nothing about what is in it, so a high
    // finding looked exactly like a routine all-clear until somebody thought
    // to open it — which is the same silence problem one layer up.
    if (findings.length > 0) {
      const high = findings.filter(
        (finding) => finding.severity === "high",
      ).length;
      const worst = findings[0];
      await this.host.appendChannelEntry({
        projectId,
        repositoryId,
        // From the auditor, not from the coordinator. A system line is the
        // deployment speaking in its own name, which is right for "a run could
        // not start" and wrong for this: an audit is an agent's own reading of
        // a change, and attributing it to the machinery made the one agent
        // that works unprompted the only one with no face in the room.
        kind: "agent",
        authorId,
        content:
          `Audit of ${String(diff.files.length)} file` +
          `${diff.files.length === 1 ? "" : "s"} found ` +
          `${String(findings.length)} issue` +
          `${findings.length === 1 ? "" : "s"}` +
          `${high > 0 ? ` (${String(high)} high)` : ""}` +
          `${worst === undefined ? "" : ` — ${worst.title}`}` +
          `. Open the audit thread to approve a fix.`,
      });
    }
    // Back to the foot of the channel, which is also what keeps it findable:
    // `auditThreadRoot` looks through recent messages, and a thread bumped on
    // every audit never falls out of that window.
    await this.host.options.store
      .bumpChannelMessage(repositoryId, root.id, new Date().toISOString())
      .catch(() => undefined);
  }

  /**
   * The one thread this repository's audits are written into.
   *
   * Found by looking rather than remembered, because anything remembered here
   * is remembered in this process and lost on the next deploy — which is the
   * fault that has already cost this channel a summary, an ending and a file
   * list. The root carries a fixed opening line, and that line is the marker.
   */
  private async auditThreadRoot(input: {
    projectId: string;
    repositoryId: string;
    authorId: string;
  }): Promise<{ id: string }> {
    const recent = await this.host.options.store.listChannelMessages(
      input.repositoryId,
      input.authorId,
      { limit: 60 },
    );
    const existing = recent.find(
      (message) =>
        message.authorId === input.authorId &&
        message.content.startsWith(AUDIT_THREAD_TITLE),
    );
    if (existing !== undefined) {
      return existing;
    }
    return await this.host.appendChannelEntry({
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      kind: "agent",
      authorId: input.authorId,
      content: `${AUDIT_THREAD_TITLE} — every audit of this repository lands here.`,
    });
  }

  /**
   * Turns an approval in an auditor's thread into real work.
   *
   * This is the gate the whole feature hangs on. The auditor finds things
   * unprompted, but nothing it finds becomes work until a person says so —
   * so an approval is the only thing here that can spend anything, and a
   * reply that is not clearly an approval must fall through untouched to the
   * ordinary thread behaviour rather than being guessed at.
   *
   * Returns whether it handled the reply.
   */
  public async dispatchApprovedFindings(input: {
    projectId: string;
    repositoryId: string;
    messageId: string;
    viewerId: string;
    reply: string;
    auditor: ChannelMentionCandidate;
    named: ChannelMentionCandidate[];
    candidates: ChannelMentionCandidate[];
  }): Promise<boolean> {
    const { projectId, repositoryId, messageId, auditor, reply } = input;
    if (!readsAsApproval(reply)) {
      return false;
    }
    const root = await this.host.options.store.getChannelMessage(
      repositoryId,
      messageId,
      input.viewerId,
    );
    // Findings are numbered per audit, and every audit of this repository now
    // lands in one thread — so the replies hold 1, 2, 3, then 1, 2 again, and
    // reading them as one list makes "fix 3" match two different findings and
    // dispatch both. Numbering is only unique inside an audit, so that is the
    // unit this reads.
    const replies = root?.replies ?? [];
    // Each audit opens with its summary; findings follow it. The last summary
    // is therefore where the newest audit's findings begin.
    const latestStart = replies.reduce(
      (found, entry, index) =>
        parseFindingReply(entry.content) === undefined &&
        /^Audited\b/u.test(entry.content.trim())
          ? index
          : found,
      -1,
    );
    const parse = (entries: typeof replies): AuditFinding[] =>
      entries
        .map((entry) => parseFindingReply(entry.content))
        .filter((finding): finding is AuditFinding => finding !== undefined);
    const latest = parse(
      latestStart === -1 ? replies : replies.slice(latestStart),
    );
    const everything = parse(replies);
    if (everything.length === 0) {
      return false;
    }
    // The newest audit first, because that is what somebody replying to it
    // means. Older findings stay reachable — scrolling up and approving one is
    // a real thing to do — but only once the newest audit has had its say.
    const fromLatest = findingsReferencedBy(reply, latest);
    const widened =
      fromLatest.length > 0 ? fromLatest : findingsReferencedBy(reply, everything);
    // A number that means two different findings from two different audits.
    // Neither is more likely than the other, and dispatching both would spend
    // somebody's account twice on a request that named one thing.
    const ambiguous =
      fromLatest.length === 0 &&
      new Set(widened.map((finding) => finding.index)).size < widened.length;
    const approved = ambiguous ? [] : widened;
    if (approved.length === 0) {
      // An approval that could mean any of several findings. Asking is the
      // only honest response: picking one would be a guess that spends
      // somebody's account, and doing nothing silently is the failure this
      // whole path exists to remove.
      await this.host.appendChannelThreadReply({
        projectId,
        repositoryId,
        messageId,
        authorId: `${auditor.userId}:${auditor.provider}`,
        content: ambiguous
          ? `That number matches findings from more than one audit in this ` +
            `thread. Quote a few words from the one you mean, or say "all" ` +
            `for every finding in the latest audit.`
          : `Which one? Reply with its number — "yes, fix 2" — or "all" for ` +
            `every finding above.`,
      });
      return true;
    }
    for (const finding of approved) {
      // Who does the work, in the order the evidence is strongest. Somebody
      // named in the reply is unambiguous and wins. Otherwise a finding the
      // auditor said it could fix itself goes back to the auditor — that is
      // the "handle the small ones yourself" case, and it is the auditor's
      // own claim, made before anybody approved anything, so it cannot be
      // shaped to grab work. Anything else goes to whichever agent's role
      // and recent work best matches the finding.
      const assignee =
        input.named[0] ??
        (finding.selfFixable
          ? auditor
          : ((await this.host.bestFitFor({
              repositoryId,
              text: `${finding.title} ${finding.detail} ${finding.files.join(" ")}`,
              candidates: input.candidates.filter(
                (candidate) =>
                  candidate.visibility === "org" ||
                  candidate.userId === input.viewerId,
              ),
            })) ?? auditor));
      // The same refusal every other dispatch path gives. An approval is not
      // consent to spend a stranger's subscription.
      if (
        assignee.visibility === "personal" &&
        assignee.userId !== input.viewerId
      ) {
        await this.host.appendChannelThreadReply({
          projectId,
          repositoryId,
          messageId,
          authorId: `${auditor.userId}:${auditor.provider}`,
          content:
            `@${assignee.name} is personal to ${assignee.userName} — only ` +
            `they can task it here. Name an org-wide agent instead.`,
        });
        continue;
      }
      await this.host.dispatchOneMention({
        projectId,
        repositoryId,
        content: fixObjectiveFor(finding),
        senderId: input.viewerId,
        candidate: assignee,
        threadMessageId: messageId,
        trigger: "audit_fix",
      });
    }
    return true;
  }
}
