/**
 * Turning what happened to a task into a line somebody can read.
 *
 * A channel is the only place most people see a run, so the wording here is
 * the product. Two rules run through all of it: never claim more certainty
 * than the event carries, and never leave a terminal state unnarrated - a
 * thread that simply stops is read as a hang.
 */

import { AGENT_ACCOUNT_PREFIX, localAgentsOnly } from "@coord/shared-types";

import { collapseWhitespace } from "./text.js";
import { withoutMentions } from "./request-classification.js";

/** How often the thread is brought up to date while a task is running. */
export const CHANNEL_PROGRESS_INTERVAL_MS = 2000;
/**
 * How a hold and its release open in a task thread.
 *
 * Read back as well as written: the memory of which holds were announced dies
 * with the process, and a plan can sit held across a deploy — so the thread's
 * own last workflow marker decides whether there is anything to answer.
 */
export const CHANNEL_HOLD_PREFIX = "⏸ Waiting on you";
export const CHANNEL_RELEASE_PREFIX = "▶ Go-ahead received";
/**
 * How work somebody parked used to say so, and how it is still recognised.
 *
 * Nothing writes this any more: pausing and resuming are a button changing
 * face, and a thread does not need to be told in words what its own control
 * is already showing. The opening is kept because threads paused before that
 * changed still carry the line, and the release walk below has to stop at it
 * — otherwise one of those threads getting its go-ahead would answer a
 * marker it cannot see, or say nothing at all.
 */
export const CHANNEL_PAUSED_PREFIX = "⏸ Paused";
/**
 * How a plan that nobody started in time says so.
 *
 * Deliberately not {@link CHANNEL_HOLD_PREFIX}: the browser recognises a
 * room-level hold by that exact opening and walks back to the thread it is
 * waiting on, so a line announcing that the wait is over would render as one
 * still running.
 */
export const CHANNEL_PLAN_LAPSED_PREFIX = "⌛ Plan expired";
/**
 * How the coordinator's arbitration lines open, and how they are found again.
 *
 * Every one of them describes a condition rather than an event — "starts once
 * that one is done", "can run together" — so each is only true while the
 * collision it describes is live. They are withdrawn rather than left as
 * history, and the withdrawal has to survive the process that posted them:
 * a deploy in the middle of a hold used to strand its notice in the room
 * forever, because the only record of which message to delete was a Map in
 * the memory that just died. The prefix plus the notice's `taskId` is what
 * lets a fresh process recognise its predecessor's lines.
 *
 * The replan account (`announceReplay`) deliberately does not carry it: that
 * one is written in the past tense about something that already happened, and
 * stays as the room's record of why an agent started over.
 */
export const CHANNEL_ARBITRATION_PREFIX = "⚖️";
/**
 * How the advisory line ended, and so how one is still told from a hold.
 *
 * Nothing writes this line any more: two plans that overlap only in intent
 * are both admitted whole, neither is refused anything, and a room told
 * "they can run together" was being handed an announcement with no decision
 * in it. What survives is the reading of it, because the lines this
 * deployment has already posted outlive the process that posted them, and a
 * hold and an advisory retire on opposite conditions — a hold as soon as
 * either end of it is over, an advisory only once both runs have stopped.
 * A message carries only its text and its task, so the sentence itself is
 * what tells the sweep which one it is looking at.
 */
export const CHANNEL_ADVISORY_ENDING = "can run together.";

/** Which of the coordinator's conflict lines this is, read off the words. */
export function arbitrationNoticeKind(content: string): "hold" | "advisory" {
  return content.endsWith(CHANNEL_ADVISORY_ENDING) ? "advisory" : "hold";
}
/**
 * How many of an agent's tasks, and how many recent channel lines, travel
 * with a question it is asked in the channel. Enough to answer "what are you
 * working on" and "what did you make of that", short enough that the context
 * is not itself the cost of answering.
 */
/**
 * Root message kinds an agent writes under its own `${userId}:${provider}` id.
 *
 * A thread is answered by the agent whose thread it is, and which agent that
 * is has always been read from the root's *kind*. That worked for the
 * legacy acknowledgement roots, which are `agent`, and quietly failed for
 * everything else the same agent writes.
 *
 * `outcome` is the one that mattered. A task that ends without being
 * thread-worthy — the ordinary single-file change whose account fits in a
 * sentence — has its ending posted as a top-level channel message of that
 * kind, authored by the agent. The dashboard offers a reply on every message,
 * so replying to an agent's last visible word opened a thread the server then
 * classified as a conversation between people, and every follow-up typed
 * there was stored and answered by nobody. The author was right there in
 * `root.authorId` the whole time, in exactly the form the code ten lines
 * below parses.
 */
export const AGENT_AUTHORED_ROOT_KINDS = new Set(["agent", "outcome", "progress"]);

/**
 * Marks the one agent reply that points at work which already landed.
 *
 * The reference itself is persisted in `referencedMessageId`; this prefix is
 * only the presentation discriminator the browser needs in order to draw
 * that reference as an inline completed-work link instead of the ordinary
 * quiet reply address above a message.
 */
export const CHANNEL_COMPLETED_WORK_PREFIX = "Already handled —";

/**
 * An image in a message, in the one form the channel writes and reads.
 *
 * The id shape is checked here as well as in the store, because this match is
 * what decides whether a filesystem path is pasted into an agent's objective.
 */
export const ATTACHMENT_REFERENCE =
  /!\[([^\]]*)\]\(attachment:([0-9a-f]{32}\.(?:png|jpg|gif|webp))\)/gu;

/**
 * A message as the local classifier should read it: the words, without the
 * plumbing.
 *
 * A pasted screenshot arrives inside the text as
 * `![shot.png](attachment:<32 hex>.png)`. The reader is a sentence-embedding
 * model, so that blob is not neutral — it is thirty characters of hex and
 * punctuation pulling a short sentence away from anything resembling a
 * request. A message that was picked up perfectly well without an image
 * stopped being picked up with one, which is a strange rule for a product
 * where "here is a screenshot of the bug" is the most natural way to ask for
 * something.
 *
 * The alt text goes with it. It reads like the part somebody wrote, and for a
 * pasted screenshot it is not — the browser fills it with the file name, so
 * keeping it left "shot.png" behind, which is letters enough to make a message
 * containing nothing but an image look like a request.
 */
export function withoutAttachments(content: string): string {
  return content.replace(ATTACHMENT_REFERENCE, " ").replace(/\s+/gu, " ").trim();
}

export const CHANNEL_ANSWER_CONTEXT = 8;

/**
 * A task's state in words, for the agent being asked how its work is going.
 *
 * The status column is a scheduler's vocabulary and it is read here by
 * something that speaks English. `open` is the one that matters: it means the
 * work landed and the conversation is still warm for a follow-up, and it is
 * only ever reached *from* a successful integration —
 * `store.openSubmittedTask` refuses any row that is not `claimed`, and the
 * only caller runs inside the `integrated` branch of the settlement loop. To a
 * reader, "open" says the opposite of all of that.
 *
 * That is not a hypothetical misreading. Asked for a status report, agents
 * reported work they had finished, summarised and posted about as still
 * outstanding — which is the correct answer to what they were shown. Handing a
 * model a raw enum and expecting it to know the local meaning of a word that
 * already has a plain one is asking it to guess; these are the same states,
 * said properly.
 */
export function describeTaskState(status: string): string {
  switch (status) {
    case "submitted":
      return "queued, not started yet";
    case "claimed":
      return "running now";
    case "planned":
      return "planned, waiting for a person to approve it";
    case "open":
      return "done — finished and landed, thread still open for follow-ups";
    case "integrated":
      return "done — finished and landed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
}
/**
 * A task is stopped being followed after this long even without a terminal
 * event, so a run that dies without recording an ending cannot leave a
 * watcher polling for the lifetime of the process.
 */
export const CHANNEL_PROGRESS_MAX_MS = 60 * 60 * 1000;

/** Audit events that end a task, and the line each one closes the thread with. */
/**
 * Narrated, but true of every run that has ever started.
 *
 * A line that says nothing specific about *this* task is not reason enough to
 * open a thread, so these are held back and only written once something
 * substantive follows. Without this every task threaded, because every task
 * says it started.
 */
/**
 * Narration that is true of the run rather than about its outcome, and so is
 * never on its own a reason to open a thread.
 *
 * `agent_progress` is here because thinking is not an answer. It was the
 * reason every task got a thread: the first thought the agent had was
 * "substantive", so a thread opened around it, and a request to add one line
 * to a README arrived as a thread with a title, an opening, and a running
 * commentary nobody asked to read. A simple task should look like the agent
 * typing and then saying it is done.
 *
 * Nothing is lost when it is held. The moment a run says something that is
 * genuinely about this task — it needs a review, it hit a conflict, it has a
 * report — the thread opens and everything held is written into it first, in
 * order, so the reasoning is there for the one run in ten that needs
 * explaining.
 */
/**
 * Lines that are true of every run, and so say nothing about this one.
 *
 * Held until something notable opens the thread, which is what stops "change
 * this 1 to a 2" getting a room of its own.
 *
 * Two things that used to be in here are not any more, and the distinction is
 * the whole point of the list: `agent_progress` carries the agent's *own*
 * message, and `workspace_changed` names the files it is editing right now.
 * Neither is boilerplate — they are the only things in a run that are about
 * this run — and holding them meant the thread stayed empty for the entire
 * time the work was happening and appeared, complete, once it was over. A
 * room whose purpose is watching somebody think is no use delivered as a
 * transcript afterwards.
 *
 * The cost is honest and was chosen deliberately: a task that narrates
 * anything at all now opens a thread, so most real work gets one. Only a run
 * that says nothing of its own between starting and ending still lands as a
 * single line in the channel.
 */
export const CHANNEL_CEREMONIAL_EVENTS = new Set([
  "task_started",
  // Every planned run has a plan, so saying it has one distinguishes nothing.
  // Its absence from this set quietly made the whole feature inert: the
  // coordinator traces `plan_received` on every planned turn
  // (`coordinator.ts`, and each of the worker paths), it is the *first* thing
  // narrated after the held opening, and being neither ceremonial nor an
  // admission it fell straight through to the flush below — so `threaded`
  // was already true by the time any ending arrived, and the branch that ends
  // a quick task as two lines in the channel could only ever be reached by a
  // run that died before it planned. Both spellings are held: "Planning
  // changes to a.ts, b.ts" names files, but naming them is still just the
  // shape of every plan, and the file list reaches the reader anyway on the
  // outcome's own changed-file summary.
  "plan_received",
  // The ordinary body of every clean run. Each of these is true of a task
  // that changed one word, and any one of them opening a thread is how
  // "change this 1 to a 2" got a room of its own again — the referee's
  // publish path now records an approved admission for every solo dispatch,
  // which made "Plan approved" the thread-maker for everything. Held, they
  // flush in order into whichever thread a *notable* line opens: a question,
  // a hold, a failure, a replan, an approval gate. A run none of those touch
  // ends as two lines in the channel, which is what a quick task is.
  "changeset_collected",
  "validation_completed",
]);


export const CHANNEL_TERMINAL_EVENTS: Record<string, string> = {
  // The fallback, for a run whose agent explained nothing — see the
  // `canonical_promoted` case in `narrateTaskEvent`, which prefers the
  // agent's own words and only lands here when there are none worth reading.
  canonical_promoted: "Done — the change is in canonical.",
  // Work that finished by reporting rather than by changing anything. An
  // ending, and not a failure — see `readsAsReportRequest`.
  task_reported: "Done — nothing needed changing, so here is what I found.",
  task_failed: "I could not finish this.",
  task_cancelled: "This was cancelled.",
};

/**
 * The closing line a finished task deserves, by the status it finished in.
 *
 * Keyed on the task's own status rather than on an audit event, because this
 * is for threads whose run ended while nothing was listening — the event has
 * been and gone, and the status is what survives it.
 */
/**
 * Statuses past the point where stopping means anything.
 *
 * The three terminal ones, plus `open` — a conversational turn that has
 * already landed in canonical and is only waiting to be spoken to again.
 * Cancelling that would rewrite finished work as abandoned.
 */
export const TASK_STATUSES_PAST_STOPPING = new Set<string>([
  "integrated",
  "failed",
  "cancelled",
  "open",
]);

export const TERMINAL_STATUS_LINE: Record<string, string> = {
  integrated: CHANNEL_TERMINAL_EVENTS["canonical_promoted"] ?? "Done.",
  // A landed conversational turn, which is finished work even though the task
  // is not finished: `open` means the change is in canonical and the thread is
  // waiting for the next message. Its absence here quietly retired this whole
  // sweep for the case it was written for — every channel dispatch carries a
  // conversation id, so every turn that succeeds settles as `open`, and an
  // orphaned thread was skipped on every pass forever while its last word
  // stayed a progress line. Failed and cancelled turns still settle
  // terminally, which is why only the successful ones went quiet.
  open: CHANNEL_TERMINAL_EVENTS["canonical_promoted"] ?? "Done.",
  failed: CHANNEL_TERMINAL_EVENTS["task_failed"] ?? "I could not finish this.",
  cancelled:
    CHANNEL_TERMINAL_EVENTS["task_cancelled"] ?? "This was cancelled.",
};

/**
 * Whether a thread has already been given an ending.
 *
 * Matches the fixed closing sentences above. An agent's own summary will not
 * match, which is why the sweep also requires the last reply to still be a
 * progress line before it writes anything.
 */
/* Slow on purpose: this only catches threads a restart orphaned, which is a
   once-per-deploy event, and every pass reads the recent messages of every
   repository. */
/**
 * The opening line of the auditor's thread, and how it is found again.
 *
 * A marker in the content rather than a stored id: an id would need a column,
 * and everything this feature has kept only in memory has been lost to a
 * restart. The thread is bumped on every audit, so it stays inside the window
 * the lookup reads.
 */
/**
 * Whether a terminal event is itself the thing the reader asked for.
 *
 * The no-thread ending exists for work whose whole story is "started, done":
 * a one-line outcome beside the request, rather than a thread that
 * exists only to hold it. A report is the opposite case. Asking an agent to
 * audit the codebase produces no diff and no intermediate commentary, so it
 * reached that branch and the entire findings were flattened into one channel
 * message with nothing to open — the deliverable posted as though it were a
 * receipt.
 *
 * Length is the second test because the same is true of any ending long
 * enough to be read rather than glanced at, whatever event carried it.
 */
export function READS_AS_DELIVERABLE(type: string, line: string): boolean {
  return (
    type === "task_reported" ||
    /\n/u.test(line) ||
    line.length > 240
  );
}

export const THREAD_ENDED_RE = /^(?:Done\b|I could not finish|This was cancelled)/u;

/**
 * Turns a run's failure into something the reader can act on.
 *
 * "I could not finish this" is true and useless. The reason is already in the
 * audit record, and the one that matters most in practice — an expired
 * sign-in — has an obvious remedy that the person reading the thread is the
 * only one who can carry out. Note that `claude auth status` reports a
 * *stored* session, not a working one, so this is the first place the
 * difference becomes visible.
 *
 * `401` is bounded on both sides, and by more than `\b`. A run's own text is
 * full of numbers that are not status codes — lease ids, hashes, byte counts,
 * ports, versions, file positions — and an unbounded `401` matched every one
 * of them, reporting the failure as an expired sign-in. That is the most
 * confidently wrong thing this function can say: it sends the reader off to
 * reconnect an account that was never the problem, and the remedy cannot
 * work no matter how carefully they follow it. `.` and `-` are excluded
 * alongside word characters, so `1.401.0` and `x-401-y` are not status codes
 * either. `unauthorized` is bounded for the same reason.
 */
export const IS_AUTH_FAILURE_RE =
  /OAuth session expired|could not be refreshed|Failed to authenticate|Not logged in|invalid_api_key|\bunauthorized\b|(?<![\w.-])401(?![\w.-])/iu;

/**
 * Whether an error is the agent's own vendor sign-in failing — as opposed
 * to some other credential the run touched. The push path fails in GitHub's
 * name when the *submitter's* GitHub token is refused, and those failures
 * speak the same auth vocabulary ("401", "unauthorized"); but reconnecting
 * an agent is the wrong door for them — that fix lives in Settings → GitHub,
 * and the push failure's own words already point there. Anything
 * naming GitHub keeps those words.
 */
/**
 * Where the sign-in that failed actually lives.
 *
 * "Reconnect me from Settings → Agents" reconnects the credential this server
 * holds. When execution is local that credential is not on the path at all —
 * the vendor CLI runs on somebody's own machine, under the login that machine
 * is signed in with — so the instruction sends a reader to a page that cannot
 * fix what broke. Following it and being told the agent is connected, while
 * every run keeps failing for want of a sign-in, is worse than being told
 * nothing.
 *
 * Which machine is not knowable from here. Naming the app is as far as this
 * can honestly go, and it is far enough to get somebody to the right screen.
 */
export function signInRemedy(): string {
  return localAgentsOnly()
    ? "Sign in to my CLI on the machine running the Kumi app — open a " +
        "terminal there and run it once — then send this again."
    : "Reconnect me from Settings → Agents and send this again.";
}

export function isVendorSignInFailure(error: string): boolean {
  return IS_AUTH_FAILURE_RE.test(error) && !/github/iu.test(error);
}

/**
 * What each integration outcome means, said plainly.
 *
 * The integration path records its outcome as a status and an explanation
 * rather than an `error`, so a run that got all the way to integration and
 * stopped had nothing in the field the narration reads — which is how "I could
 * not finish this." reached a thread with no reason attached at all.
 */
export const INTEGRATION_FAILURE_REASONS: Record<string, string> = {
  conflict:
    "the change clashed with work that landed while I was writing it, and I " +
    "could not merge the two",
  validation_failed: "the checks did not pass on what I wrote",
  policy_failed: "this project's rules would not let the change land",
  stale: "the branch moved on before I could land it",
  empty: "I did not end up with any changes to make",
};

/**
 * The same courtesy for a question that could not be answered.
 *
 * Kept apart from {@link explainTaskFailure} because a question that fails did
 * not "fail to finish" — nothing was started. Borrowing the task wording made
 * a momentary model error read as abandoned work.
 */
export function explainAnswerFailure(error?: string): string {
  if (isVendorSignInFailure(error ?? "")) {
    // Carrying the evidence, for the reason `explainTaskFailure` does.
    return (
      `I could not answer that — my sign-in has expired. ${signInRemedy()}` +
      `\n\nWhat I got back: ${clipToBoundary(
        (error ?? "").replace(/\s+/gu, " ").trim(),
        FAILURE_DETAIL_MAX,
      )}`
    );
  }
  const cleaned = (error ?? "").replace(/\s+/gu, " ").trim();
  return cleaned.length === 0
    ? "I could not answer that just now."
    : `I could not answer that just now: ${clipToBoundary(cleaned, FAILURE_DETAIL_MAX)}`;
}

/**
 * The message stripped down to the words it is actually made of, for
 * comparing what was asked against what came back: mentions, the punctuation
 * a model adds when it quotes, and the case it chooses when it tidies a
 * sentence up all have to stop mattering.
 */
export function echoShape(value: string): string {
  return withoutMentions(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether a reply is nothing but the request handed back.
 *
 * This is the bug `/ask` shipped with: asked "@agent change the background
 * color", the answer posted in the channel was "Change the background" — the
 * sender's own words, capitalised and clipped, with not one thing added. It
 * is indistinguishable from a broken agent, and it is worse than silence
 * because it looks like an answer.
 *
 * Deliberately narrow, so a real answer is never mistaken for one. A reply
 * only counts as an echo when every word in it was already in the request:
 * anything that adds a word — an explanation, a refusal, a "yes, because…" —
 * has said something and is posted as written. A one-word reply is left alone
 * for the same reason ("Yes." answers a question that contains "yes"), and so
 * is a long one, which is an answer that happens to quote.
 */
export function readsAsEchoOfRequest(request: string, answer: string): boolean {
  const asked = echoShape(request);
  const said = echoShape(answer);
  if (asked === "" || said === "") {
    return false;
  }
  const words = said.split(" ");
  if (words.length < 2 || words.length > 25) {
    return false;
  }
  return asked === said || asked.includes(said);
}

/**
 * What is said instead of the echo.
 *
 * Says the true thing — that no answer came back — and gives the reader both
 * ways forward, because an instruction sent to `/ask` is the commonest way to
 * land here and "ask me a question" is not the only reasonable next move.
 */
export const ECHOED_REQUEST_REPLY =
  "That came back as your own message repeated rather than an answer, so " +
  "there was nothing worth posting. Ask me what you want to know about it — " +
  "or say it without `/ask` and I'll take it on as work instead.";

/**
 * A bounded excerpt that still ends on a word.
 *
 * Every bound here used to be a bare `slice`, which is how a channel line
 * ended "…What the URL act": a sentence cut mid-word reads as a model that
 * stopped mid-thought rather than as a quotation somebody shortened. Cutting
 * back to the last space and marking the cut says which of the two happened.
 */
export function clipToBoundary(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, max);
  const lastSpace = head.lastIndexOf(" ");
  // Only honour the word boundary when it is near the end; a single
  // unbroken token longer than the bound would otherwise clip to nothing.
  const kept = lastSpace > max * 0.6 ? head.slice(0, lastSpace) : head;
  return `${kept.trimEnd()}…`;
}

/**
 * Formerly a hard cap on task endings. Kept as Infinity so the agent's own
 * words reach the channel whole — never cut mid-sentence or mid-word.
 */
export const TERMINAL_SUMMARY_MAX = Number.POSITIVE_INFINITY;

/**
 * An ending the reader gets all of.
 *
 * Nothing an agent writes about its own work is shortened here. A cut ending
 * — mid-word or mid-sentence — tells the reader the account was truncated and
 * not what it said. There is nowhere in the channel to go for the rest, so
 * there is no shortening worth doing. Whitespace is collapsed so a multi-line
 * explanation still reads as one channel reply.
 */
export function shortenEnding(written: string): string {
  const collapsed = collapseWhitespace(written);
  return collapsed.length <= TERMINAL_SUMMARY_MAX
    ? collapsed
    : clipToBoundary(collapsed, TERMINAL_SUMMARY_MAX);
}

/**
 * Formerly a hard cap on agent failure accounts. Kept as Infinity so a
 * failure that *is* the answer is never shortened to fit a channel budget.
 */
export const FAILURE_ACCOUNT_MAX = Number.POSITIVE_INFINITY;

/** How much of the machinery's own error text a failure line may quote. */
export const FAILURE_DETAIL_MAX = 240;

/**
 * Splits a failure into the alarm and the agent's own words, if it carries
 * both. See {@link AGENT_ACCOUNT_PREFIX} for who writes the seam.
 */
export function splitAgentAccount(detail: string): {
  alarm: string;
  account?: string;
} {
  const at = detail.indexOf(AGENT_ACCOUNT_PREFIX);
  if (at < 0) {
    return { alarm: detail };
  }
  const account = detail.slice(at + AGENT_ACCOUNT_PREFIX.length).trim();
  return account.length === 0
    ? { alarm: detail }
    : { alarm: detail.slice(0, at), account };
}

export function explainTaskFailure(error: string, status?: string): string {
  if (isVendorSignInFailure(error)) {
    // The interpretation, and then the evidence for it.
    //
    // This used to return the sentence alone, which made the guess
    // unfalsifiable: a reader told their sign-in had expired, who had just
    // signed in, had no way to find out whether the diagnosis was wrong or
    // their login really was broken — and neither did anyone helping them.
    // The pattern behind this branch is a handful of substrings matched
    // against whatever a vendor CLI happened to print, so it is wrong often
    // enough that hiding what it read is the expensive choice. Keeping the
    // agent's own words costs one line and settles the question.
    return (
      `I could not finish this — my sign-in has expired. ${signInRemedy()}` +
      `\n\nWhat I got back: ${clipToBoundary(
        error.replace(/\s+/gu, " ").trim(),
        FAILURE_DETAIL_MAX,
      )}`
    );
  }
  // Split before collapsing whitespace: the alarm is one sentence and reads
  // the same flattened, while the account may be several paragraphs the agent
  // laid out for a reader.
  const { alarm, account } = splitAgentAccount(error);
  const cleaned = alarm.replace(/\s+/gu, " ").trim();
  const reason = status === undefined ? undefined : INTEGRATION_FAILURE_REASONS[status];
  const opening =
    cleaned.length > 0
      ? reason === undefined
        ? `I could not finish this: ${clipToBoundary(cleaned, FAILURE_DETAIL_MAX)}`
        : `I could not finish this — ${reason}: ${clipToBoundary(cleaned, FAILURE_DETAIL_MAX)}`
      : reason === undefined
        ? "I could not finish this."
        : `I could not finish this — ${reason}.`;
  // Its own paragraph, so the answer is not read as a continuation of the
  // alarm's sentence — and so the ending is long enough and shaped enough to
  // open a thread rather than land as one clipped line in the room.
  // Agent-authored account text is never clipped: the reader asked for that
  // answer, and a char bound only throws the end of it away.
  return account === undefined
    ? opening
    : `${opening}\n\n${AGENT_ACCOUNT_PREFIX} ${
        account.trim().length <= FAILURE_ACCOUNT_MAX
          ? account.trim()
          : clipToBoundary(account.trim(), FAILURE_ACCOUNT_MAX)
      }`;
}

/**
 * One audit event as a line worth reading in a channel.
 *
 * Deliberately a whitelist: the audit log carries a lot that means nothing to
 * somebody watching a chat, and narrating all of it would bury the few events
 * that actually say what the agent is doing. Anything unrecognised is
 * skipped rather than dumped.
 */
export function narrateTaskEvent(
  type: string,
  data: Record<string, unknown>,
): string | undefined {
  const files = Array.isArray(data["files"])
    ? (data["files"] as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  switch (type) {
    case "task_started":
      return "Reading the repository and working out a plan…";
    case "plan_received":
      return files.length > 0
        ? `Planning changes to ${files.slice(0, 4).join(", ")}${
            files.length > 4 ? ` and ${String(files.length - 4)} more` : ""
          }.`
        : "Planned the change.";
    case "plan_admitted": {
      // One sentence per outcome, because the outcomes are opposites. This
      // used to say "Plan approved — starting on the code" for every status,
      // including the ones where the whole point is that the code is *not*
      // being started: a deferred task announced it was working and then sat
      // silent, which is indistinguishable from a hang — and was reported as
      // one.
      const status = String(data["status"] ?? "");
      const why =
        typeof data["explanation"] === "string" &&
        data["explanation"].trim().length > 0
          ? ` ${data["explanation"].trim()}`
          : "";
      if (status === "sequenced") {
        return (
          "⚖️ Waiting my turn — files this plan needs are leased to another " +
          "task in flight. I start the moment it lands." + why
        );
      }
      if (status === "blocked") {
        // Not "so I'm narrowing the plan". What narrows is the *claim* on the
        // repository, never the ask — but a reader watching their own request
        // go by has no way to tell those apart, and took the line as notice
        // that the thing they asked for was being cut down. The decision this
        // announces is an order of work, so that is what it says.
        return (
          "⚖️ Waiting for the work in flight — it holds files this plan " +
          "needs, so it goes first and I pick this up after it lands." + why
        );
      }
      if (data["partial"] === true) {
        const granted = Array.isArray(data["grantedFiles"])
          ? (data["grantedFiles"] as unknown[]).filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [];
        // `deferredResources` are records, not strings — `{resourceType,
        // resourceId, heldBy, reason}`. Filtering them for strings kept
        // nothing, every time, so this line has never once named the file it
        // was holding: it always fell through to "the rest", which is the one
        // thing the reader wanted it to say.
        const deferred = (
          Array.isArray(data["deferredResources"])
            ? (data["deferredResources"] as unknown[])
            : []
        )
          .map((entry) =>
            typeof entry === "object" && entry !== null
              ? (entry as { resourceId?: unknown }).resourceId
              : entry,
          )
          .filter((entry): entry is string => typeof entry === "string");
        const clause = (files: string[]) =>
          files.slice(0, 3).join(", ") +
          (files.length > 3 ? ` and ${String(files.length - 3)} more` : "");
        // First person, because this is the agent's own thread and the lines
        // around it are too. The channel copy names both agents instead —
        // there the reader is watching a room, here they are reading one
        // worker's account of its own turn.
        return (
          `⚖️ Starting on ${granted.length > 0 ? clause(granted) : "the free part"} — ` +
          `${deferred.length > 0 ? clause(deferred) : "the rest"} is leased to ` +
          "another task and follows when that lands."
        );
      }
      return "Plan approved — starting on the code.";
    }
    case "replan_requested":
      return "Something moved underneath me; re-planning against the latest code.";
    case "lease_expired":
      // Not a failure: the task goes back in the queue and is picked up
      // again. But it is the one ending that used to say nothing at all —
      // expiry settles the lease in the store and writes no event — so a run
      // whose machine slept, lost its network, or had the app closed under it
      // left a thread reading "I've taken this task and I'm working on it"
      // permanently. A person watching that has no way to tell it from work
      // in progress, and waits for something that is never coming.
      return (
        "I lost contact with the machine running me, so I have put this back " +
        "in the queue. It starts again when that machine is back."
      );
    case "agent_progress":
      // Full message, never a char bound: a slice here cut mid-word with no
      // ellipsis and left answers looking like the model stopped mid-thought.
      return typeof data["message"] === "string" && data["message"].length > 0
        ? String(data["message"])
        : undefined;
    case "workspace_changed": {
      // Read off the worktree while the agent is still editing. This is the
      // stretch that used to say nothing at all — a thread went quiet after
      // "execution started" and stayed quiet for up to an hour, with no way
      // to tell work from a hang.
      //
      // Only what moved since the last report, because that is what is new to
      // the reader; the full set travels in the same event for the summary
      // that hangs off the thread.
      const changed = Array.isArray(data["changed"])
        ? (data["changed"] as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      if (changed.length === 0) {
        return undefined;
      }
      return `Working on ${changed.slice(0, 3).join(", ")}${
        changed.length > 3 ? ` and ${String(changed.length - 3)} more` : ""
      }…`;
    }
    case "changeset_collected":
      return files.length > 0
        ? `Wrote changes to ${files.slice(0, 4).join(", ")}${
            files.length > 4 ? ` and ${String(files.length - 4)} more` : ""
          }. Validating…`
        : "Finished editing. Validating…";
    case "validation_completed":
      return data["status"] === "integrated"
        ? "Validation passed."
        : `Validation came back ${String(data["status"] ?? "unresolved")}.`;
    case "approval_requested":
      return "Waiting on a human review before this can land.";
    case "canonical_promoted": {
      // What the agent says it did, rather than the one sentence that was
      // true of every task this system has ever finished.
      //
      // "Done — the change is in canonical." says the pipeline worked. It
      // does not say what changed, and it was identical under every request,
      // so a reader following two tasks saw the same ending twice and learned
      // nothing from either. The agent wrote an account of its own work at
      // `collectChanges` and it travelled all the way to promotion unread.
      const written =
        typeof data["agentExplanation"] === "string"
          ? collapseWhitespace(data["agentExplanation"])
          : "";
      // The adapters' own fallback for a model that explained nothing is the
      // vendor name and the objective handed back. The objective is already
      // the thread's title, so that is the canned line with extra steps —
      // better to say the plain thing than to dress it up as a summary.
      const isAdapterFallback =
        /^(?:claude|codex|gemini|cursor|copilot|kiro)\s+completed\s/iu.test(
          written,
        );
      if (written.length === 0 || isAdapterFallback) {
        return CHANNEL_TERMINAL_EVENTS[type];
      }
      // Whole: this is the one line most people read of a task, and a bound
      // low enough to shape it was a bound it kept being cut at mid-word.
      // Changed files already have their own structured block immediately
      // above this ending. Repeating their paths or count here makes the
      // agent's answer noisier without adding anything the reader cannot see.
      return shortenEnding(written);
    }
    case "task_reported": {
      // The agent's own words are the deliverable here — the report *is* the
      // outcome, where for a change the outcome is the diff.
      const explanation = data["explanation"];
      return typeof explanation === "string" && explanation.trim().length > 0
        ? explanation.trim()
        : "Finished without needing to change anything.";
    }
    case "task_failed": {
      // Two shapes reach here. Most emitters record `error`; the integration
      // path records `explanation` and a `status`. Reading only the first left
      // the most common ending — a run that finished and could not land —
      // reported as a bare "I could not finish this."
      const detail =
        typeof data["error"] === "string" && data["error"].length > 0
          ? data["error"]
          : typeof data["explanation"] === "string" &&
              data["explanation"].length > 0
            ? data["explanation"]
            : // Read last, and only for the rows already written. The remote
              // worker path recorded its reason here rather than under
              // `error` — the one emitter of six that did — so every failure
              // it reported reached the room as a bare sentence. The emitter
              // is fixed; this keeps the failures already on the record able
              // to explain themselves rather than staying mute forever.
              typeof data["detail"] === "string"
              ? data["detail"]
              : "";
      return explainTaskFailure(
        detail,
        typeof data["status"] === "string" ? data["status"] : undefined,
      );
    }
    case "task_cancelled":
      // A channel-level /stop or /cancel already posts one system summary
      // describing every task it stopped. Repeating a canned ending from
      // each affected agent adds noise without telling the room anything new.
      return data["reason"] === "Stopped from the channel"
        ? undefined
        : CHANNEL_TERMINAL_EVENTS[type];
    case "approval_decided":
      return undefined;
    default:
      return CHANNEL_TERMINAL_EVENTS[type];
  }
}

/**
 * The single key one agent's channel override is stored under.
 *
 * `${userId}:${provider}` identifies an agent; a bare provider id identifies
 * only a vendor, and every agent on that vendor answered to it. A bare id
 * reaching a write can only be the caller's own agent — that is the sole
 * shape `myAgents` in data.js mints, and a person manages nobody else's
 * agents through that route — so it is resolved against them rather than
 * left ambiguous.
 */
export function normalizeChannelAgentId(agentId: string, viewerId: string): string {
  return agentId.includes(":") ? agentId : `${viewerId}:${agentId}`;
}

/**
 * One agent's channel presentation, resolved from the overrides table.
 *
 * The precedence is the contract between this server and the browser: the
 * name shown on screen has to be the name a mention is matched against, or
 * people @mention what they can see and nothing answers. It lives here, is
 * sent out resolved on the roster, and `channelAgentsFor` in data.js reads
 * that rather than resolving a second time — two implementations of one
 * order was exactly how the two came to disagree.
 *
 * Specific beats general: an override naming this one agent wins over the
 * account's own call sign, which in turn wins over a legacy bare-provider row
 * that names every agent on the vendor.
 */
export function resolveChannelAgentPresentation(
  overrides: Record<
    string,
    { name?: string; role?: string; model?: string; effort?: string } | undefined
  >,
  agent: { userId: string; provider: string; callSign?: string },
  defaultName: string,
): { name: string; role: string; model?: string; effort?: string } {
  const specific = overrides[`${agent.userId}:${agent.provider}`];
  const legacy = overrides[agent.provider];
  // Model and effort travel with name and role because they are the same kind
  // of fact — what this channel decided about this agent — and resolving them
  // anywhere else would mean a second copy of the specific-beats-legacy rule.
  // They used to be stored by the roster's pickers and read by nothing, so
  // choosing a model changed a control and not one thing about the run.
  const model = specific?.model ?? legacy?.model;
  const effort = specific?.effort ?? legacy?.effort;
  // A legacy row names a vendor, not an agent, so it must not outrank the name
  // the account itself holds. `clearChannelAgentNameOverrides` only ever clears
  // the `${userId}:${provider}` rows — it cannot delete a bare-provider row
  // without renaming every other person's agent on that vendor in that channel
  // — so a deployment that wrote one before agent-specific keys existed kept
  // answering to the old name in that room after an account-wide rename. That
  // is the "renamed it here and the other repositories kept the old name"
  // report. A historical row naming *this one agent* still wins until that
  // agent's owner renames it and clears those old room-specific names.
  const legacyName = agent.callSign === undefined ? legacy?.name : undefined;
  return {
    name: specific?.name ?? legacyName ?? defaultName,
    // No vendor-guessed default: an agent is unlabeled until this channel
    // actually names its role.
    role: specific?.role ?? legacy?.role ?? "",
    ...(model === undefined || model === "" ? {} : { model }),
    ...(effort === undefined || effort === "" ? {} : { effort }),
  };
}

/**
 * A request to change the machine rather than the repository.
 *
 * Narrow on purpose. It matches a system package manager being invoked —
 * `apt-get install`, `brew install`, `yum install` — and nothing else,
 * because that is the class that provably cannot work: the control plane
 * runs unprivileged (the entrypoint drops to `node` before serving), so
 * there is no root to install with, and a container is rebuilt from its image
 * every deploy, so anything installed would not outlive the run that did it.
 *
 * Everything adjacent is left alone. "install the eslint plugin" edits
 * package.json and is an ordinary change; guessing at intent from the word
 * "install" would refuse real work, which is worse than the ten minutes this
 * saves. A word list that refuses tasks has to be much more certain than one
 * that merely routes them.
 */
