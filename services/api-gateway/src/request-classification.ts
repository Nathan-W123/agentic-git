/**
 * Reading what a channel message is asking for.
 *
 * The distinction these draw - a question to answer, work to do, or chatter
 * to leave alone - decides whether a thread is opened at all, so it lives in
 * one place rather than being re-derived at each call site. The regexes are
 * deliberately conservative: mistaking work for a question loses the work
 * silently, which is the failure nobody reports.
 */

import {
  createChatterFilter,
  createLocalSummariser,
  type ChatterFilter,
  type LocalSummariser,
} from "@coord/local-triage";

import { CATCH_UP_SUMMARY_TIMEOUT_MS } from "./catch-up.js";

export function textMentionsName(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`@${escaped}(?=$|[\\s,.:;!?()\\[\\]{}])`, "iu").test(content);
}

/* ------------------------------------------------- no-mention auto-claim --
 *
 * When a channel message carries no "@" at all, `maybeAutoClaimTask` (near
 * `dispatchChannelMentions`) decides whether exactly one connected agent is
 * a clear enough fit to hand it to, and then asks that agent what to do
 * about it: take it, propose something and wait for a yes, or say nothing.
 *
 * "Is this a task" used to be answered here, by a word list. It no longer
 * is — the agent reads the sentence, because the difference between "update
 * the readme" and "the update went out" is not in the words. What is left
 * below is the half a list can answer: who fits, scored deterministically
 * and kept as free functions so it stays independently testable.
 */

/**
 * A message that is only an acknowledgment, greeting, or filler — never a
 * task, regardless of anything else in it (there is nothing else in it).
 */
export const ACK_ONLY_RE =
  /^(hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|k|kk|cool|nice|great|awesome|sounds good|sounds great|got it|no problem|np|sure|yep|yeah|yes|no|nope|lol|haha|\+1|👍)[\s!.,?]*$/iu;

/**
 * Verbs and verb phrases that read as a request for work, in the base form
 * and the inflections a channel message actually uses ("fix", "fixed",
 * "fixing", …). Deliberately concrete build/change/fix vocabulary — see
 * {@link looksLikeTaskRequest} for why this stays a word list.
 *
 * The examine family — audit, analyse, inspect, scan, assess — was missing,
 * so "can you audit the codebase" was not a request for work at all. It fell
 * through to being *answered*: a model with no repository in front of it
 * discussed the idea of an audit instead of one being run. Reading code is
 * work in this product even when it changes nothing, and the auditor exists
 * precisely to do it.
 */
export const TASK_VERB_RE =
  /\b(make|makes|made|making|fix|fixe[sd]|fixing|add|adds|added|adding|update|updates|updated|updating|change|changes|changed|changing|remove|removes|removed|removing|delete|deletes|deleted|deleting|implement|implements|implemented|implementing|build|builds|built|building|create|creates|created|creating|refactor|refactors|refactored|refactoring|investigate|investigates|investigated|investigating|debug|debugs|debugged|debugging|patch|patches|patched|patching|migrate|migrates|migrated|migrating|rename|renames|renamed|renaming|adjust|adjusts|adjusted|adjusting|tweak|tweaks|tweaked|tweaking|animate|animates|animated|animating|write|writes|wrote|writing|move|moves|moved|moving|deploy|deploys|deployed|deploying|revert|reverts|reverted|reverting|upgrade|upgrades|upgraded|upgrading|optimi[sz]e[sd]?|optimi[sz]ing|clean ?up|handle|handles|handled|handling|support|supports|supported|supporting|enable|enables|enabled|enabling|disable|disables|disabled|disabling|hook ?up|wire ?up|set ?up|review|reviews|reviewed|reviewing|swap|swaps|swapped|swapping|replace|replaces|replaced|replacing|bump|bumps|bumped|bumping|revise|revises|revised|revising|look into|check into|audit|audits|audited|auditing|analy[sz]e|analy[sz]es|analy[sz]ed|analy[sz]ing|inspect|inspects|inspected|inspecting|scan|scans|scanned|scanning|assess|assesses|assessed|assessing|examine|examines|examined|examining|diagnose|diagnoses|diagnosed|diagnosing|help|helps|helped|helping|solve|solves|solved|solving|address|addresses|addressed|addressing|finish|finishes|finished|finishing|complete|completes|completed|completing|test|tests|tested|testing|verify|verifies|verified|verifying|tackle|tackles|tackled|tackling|improve|improves|improved|improving|figure ?out|take (?:a look|care of)|pick ?up|put|puts|putting|get rid of|gets rid of|got rid of|getting rid of|hide|hides|hid|hiding|drop|drops|dropped|dropping|take out|takes out|took out|taking out|turn on|turn off|turns o[nf]f?|turned o[nf]f?|turning o[nf]f?|shrink|shrinks|shrank|shrunk|shrinking|enlarge|enlarges|enlarged|enlarging)\b/iu;

/**
 * A question about the status of existing work — asked *with* a task verb
 * present ("is the login fix deployed yet?" contains "fix" and "deploy")
 * but not itself a request for new work. Checked after {@link TASK_VERB_RE}
 * matches, to veto exactly that overlap.
 */
export const STATUS_QUESTION_RE =
  /\b(is|are|was|were|did|does|do|has|have|any|what'?s|when'?s)\b[^?]*\b(done|finished|fixed|ready|status|progress|update|updated|merged|deployed|live|working)\b[^?]*\?\s*$/iu;

/**
 * Phrasings that make an interrogative a request rather than a question.
 * "Can you fix the retry loop?" is an imperative wearing a question mark;
 * {@link asksAboutWork} must not veto it.
 */
export const REQUEST_MARKER_RE =
  /\b(please|can you|could you|would you|will you|can we|could we|should we|let'?s|i need you to|we need to|go ahead and)\b/iu;

/**
 * Auxiliaries that put a sentence in the past or the perfect, which is the
 * grammar of asking *about* work: "what did you fix?", "has anyone updated
 * the readme?". Modals — can, could, would, will — are deliberately absent:
 * those ask for work, and live in {@link REQUEST_MARKER_RE} instead.
 */
export const ASKING_ABOUT_RE = /\b(did|has|have|had|was|were)\b/iu;

/** Past-tense members of {@link TASK_VERB_RE}, including its three irregulars. */
export const PAST_TENSE_VERB_RE = /(?:ed|made|built|wrote)$/iu;

/** {@link TASK_VERB_RE} again, global, for counting every verb in a sentence. */
export const TASK_VERB_RE_GLOBAL = new RegExp(TASK_VERB_RE.source, "giu");

/**
 * Whether this asks *about* work rather than *for* it.
 *
 * {@link TASK_VERB_RE} carries past-tense inflections — "changed", "fixed",
 * "updated" — so a question about work already done matched it and was
 * dispatched as new work. "Which key changed?" in a thread checked out the
 * repository and ran a whole task to answer three words, and every question
 * of that shape spent an account the same way.
 *
 * Three conditions, all required:
 *
 *  - It *ends* as a question, rather than merely opening like one. "Did you
 *    see the bug? Fix it" is a request with a question in front of it, and
 *    anchoring on the final `?` is what tells the two apart.
 *  - Nothing in it asks for work — see {@link REQUEST_MARKER_RE}.
 *  - And either it is phrased in the past or perfect, or every task verb in
 *    it is past tense. The second clause is what keeps a mixed sentence
 *    ("which key changed, and can you revert it?") on the work path.
 *
 * Questions are answered by provider chat, which receives a temporary
 * read-only checkout when it needs to inspect the repository. What this
 * removes is the case where a question about completed work starts new work.
 */
export function asksAboutWork(text: string): boolean {
  if (!text.endsWith("?")) {
    return false;
  }
  if (REQUEST_MARKER_RE.test(text)) {
    return false;
  }
  if (ASKING_ABOUT_RE.test(text)) {
    return true;
  }
  // `match` with a global regex ignores and resets `lastIndex`, so this
  // shared constant cannot carry state between calls.
  const verbs = text.match(TASK_VERB_RE_GLOBAL) ?? [];
  return (
    verbs.length > 0 &&
    verbs.every((verb) => PAST_TENSE_VERB_RE.test(verb.trim()))
  );
}

/**
 * The message with its @mentions removed.
 *
 * Strips `@Name` and `@Name (Owner)` and nothing more. Allowing whitespace
 * inside the name made an earlier version greedy enough to swallow the whole
 * sentence, which read as "not a question" and turned every question into a
 * task.
 *
 * Used for the objective as well as the question test: a task called
 * "@Claude (Nathan) this is a greenfield project…" is named after the routing
 * rather than the work, and that name is what a person has to recognise it by
 * later.
 */
export function withoutMentions(content: string): string {
  return content.replace(/@[\w.-]+(?:\s*\([^)]*\))?/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Openers that make a sentence a question even without a question mark. */
export const INTERROGATIVE_RE =
  /^(what|why|how|when|who|where|which|is|are|was|were|do|does|did|can|could|would|will|should|have|has|any)\b/iu;

/**
 * A polite request: "can you condense the top bar" is an instruction with
 * manners, not a question about whether the agent is able to.
 *
 * Openers alone cannot tell the two apart — "can you" starts both — and the
 * task-verb list cannot either, because the verbs people reach for
 * (condense, tailor, tidy, reword) are open-ended. What separates them is
 * the question mark: a person asking whether something is possible writes
 * one, and a person telling an agent what to do does not. So a message that
 * opens this way and does not end in "?" is work. "Can you take reference
 * from Slack to condense the top bar" was being answered in the channel,
 * three minutes later, by an agent describing what it would do instead of
 * doing it — and when that answer failed, by nothing at all.
 */
export const POLITE_REQUEST_RE =
  /^(?:please\s+)?(?:can|could|would|will)\s+(?:you|u|ya)\b/iu;

/**
 * Terse requests whose answer is the deliverable, even though they are not
 * phrased as questions.
 *
 * `/simple @Hades summary of the codebase` used to miss both question tests
 * and become an edit task. The task correctly found no diff, then reported
 * that implementation detail in front of the answer. These openers describe
 * an answer rather than repository work; the task-verb guard below still wins
 * for requests that actually ask to build, fix, audit, or change something.
 */
export const ANSWER_REQUEST_RE =
  /^(?:(?:give|show|tell)\s+me\s+(?:an?\s+)?(?:summary|overview)\b|summari[sz]e\b|describe\b|explain\b|outline\b|(?:an?\s+)?(?:summary|overview)\b|(?:status|progress)\s+report\b)/iu;

/**
 * Whether a message addressed to an agent by name asks for an answer rather
 * than work.
 *
 * The bias here is the opposite of {@link looksLikeTaskRequest}'s, and
 * deliberately so. That one guards the no-mention path, where a false
 * positive spends somebody's account on work nobody asked for, so it demands
 * positive evidence of a task. Naming an agent is already that evidence: the
 * sender chose it on purpose. So a mention is treated as work unless it
 * reads as a question, rather than only when it matches a verb list — a
 * whitelist miss on this path would answer "kick off the release checklist"
 * with chat instead of doing it.
 *
 * A question containing a real task verb ("can we make a chess game?") is
 * still work; the question mark is grammar, not intent.
 */
export function readsAsQuestion(content: string): boolean {
  const text = withoutMentions(content);
  if (text.length === 0) {
    return false;
  }
  if (TASK_VERB_RE.test(text)) {
    return false;
  }
  if (POLITE_REQUEST_RE.test(text) && !text.endsWith("?")) {
    return false;
  }
  return (
    text.endsWith("?") ||
    INTERROGATIVE_RE.test(text) ||
    ANSWER_REQUEST_RE.test(text)
  );
}

/**
 * How an unnamed request is offered, and how the acceptance below finds it
 * again. A prefix rather than a stored flag: a channel message carries no
 * metadata of its own, and the offer has to be recognisable in the transcript
 * by the same reading a person gives it.
 */
export const AUTO_CLAIM_OFFER_OPENING = "Want me to take this";

export const AUTO_CLAIM_OFFER_TAIL =
  'Say "yes" and I\'ll ask you what I need before I start — or @mention ' +
  "someone else.";

/** Marks a pending question as an offer rather than a run's own question. */
export const AUTO_CLAIM_QUESTION_PREFIX = "offer:";

export const AUTO_CLAIM_QUESTION_YES = "Yes, go ahead";
export const AUTO_CLAIM_QUESTION_NO = "No thanks";

/**
 * The local filter this deployment runs, or one that decides nothing.
 *
 * On by default. `COORD_LOCAL_TRIAGE=0` turns it off, which puts every
 * unaddressed message back in front of an agent — the behaviour before the
 * filter existed, and the setting to reach for if a room is ever quiet about
 * something it should have answered.
 */
export function defaultChatterFilter(): ChatterFilter {
  const raw = process.env["COORD_LOCAL_TRIAGE"]?.trim().toLowerCase() ?? "";
  if (["0", "false", "off", "no"].includes(raw)) {
    return {
      readsAsChatter: async () => false,
      readsAsWork: async () => false,
      classify: async () => ({ chatter: false, work: false }),
      available: async () => false,
    };
  }
  // Tunable without a code change, because the right value is a property of a
  // channel's own phrasing rather than of this repository: the bar starts at
  // "leans to work at all", and the lean is written to the log every time a
  // message is passed over, so raising it is a decision somebody can make from
  // their own numbers.
  const configured = Number.parseFloat(
    process.env["COORD_TRIAGE_WORK_MARGIN"]?.trim() ?? "",
  );
  return createChatterFilter(
    Number.isFinite(configured) ? { workMargin: configured } : {},
  );
}

/**
 * The local text model shared by catch-up prose and thread names, or nothing.
 *
 * Shares `COORD_LOCAL_TRIAGE` with the chatter filter: both are the same
 * bargain — a small model on the machine, no network, no vendor bill — so a
 * deployment that has turned local models off should not quietly keep one.
 * Switched off, both callers keep their deterministic wording, which is what
 * every failure produces anyway. One instance matters: loading a second ONNX
 * session solely to name threads would double the memory cost of the feature.
 */
export function defaultLocalSummariser(): LocalSummariser | undefined {
  const raw = process.env["COORD_LOCAL_TRIAGE"]?.trim().toLowerCase() ?? "";
  if (["0", "false", "off", "no"].includes(raw)) {
    return undefined;
  }
  return createLocalSummariser({
    budgetMs: CATCH_UP_SUMMARY_TIMEOUT_MS,
  });
}

/** The proposal out of an offer message, or nothing if this is not one. */
export function autoClaimProposal(content: string): string | undefined {
  const at = content.indexOf(AUTO_CLAIM_OFFER_TAIL);
  if (at < 0) {
    return undefined;
  }
  const proposal = content.slice(0, at).trim();
  return proposal.length === 0 ? undefined : proposal;
}

/**
 * What an agent decided to do about a message nobody addressed to it.
 *
 * Three outcomes rather than two, because the middle one is where a message
 * that is genuinely unclear belongs — not where every unspelled-out detail
 * belongs. "The gray background looks rough" is neither a request nor
 * chatter: it is a person noticing something, and it is closer to "act" now
 * than it once was — a reasonable colour is a judgment call, not a fork in
 * the work, and the agent is expected to make it rather than ask. What still
 * offers is a message that could mean two substantially different pieces of
 * work, or that touches something costly or hard to undo. Offering costs one
 * line; acting uncalled for costs somebody's usage; ignoring wastes the
 * remark — and of the three, an offer nobody answers is the one where real
 * work simply never happens, which is why the bar for reaching it went up.
 */
export type AutoClaimVerdict =
  | { verdict: "act" }
  | { verdict: "offer"; proposal: string }
  | { verdict: "ignore" };

/**
 * Reads the classifier's reply.
 *
 * Deliberately forgiving about shape and unforgiving about meaning: a model
 * that answers with a paragraph, an empty string, a refusal, or a word that
 * is none of the three lands on `ignore`. That is the direction that costs
 * nothing — silence, and the sender can still @mention anybody by hand,
 * which always works. An `OFFER` with no question after it is not an offer
 * either; there would be nothing to show the reader.
 */
export function parseAutoClaimVerdict(text: string | undefined): AutoClaimVerdict {
  const first =
    (text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (/^act\b/iu.test(first)) {
    return { verdict: "act" };
  }
  const offer = /^offer\b\s*:?\s*(.*)$/iu.exec(first);
  if (offer !== null) {
    // Quotes and leading bullets are what a model reaches for when asked for
    // a sentence; none of them belong in the room.
    const proposal = (offer[1] ?? "")
      .trim()
      .replace(/^["'\u201c\u2018\-\u2022\s]+/u, "")
      .replace(/["'\u201d\u2019\s]+$/u, "")
      .trim();
    return proposal.length === 0
      ? { verdict: "ignore" }
      : { verdict: "offer", proposal };
  }
  return { verdict: "ignore" };
}

/**
 * Separates the answer somebody should see from an optional task suggestion.
 *
 * A task is accepted only from one well-formed directive on the final
 * non-empty line. Missing, malformed, duplicated and explicitly empty
 * directives all fail closed. Any line containing the private marker is
 * still removed from the visible answer, including malformed output: a
 * provider formatting mistake must not leak coordinator syntax into chat.
 */
export function parseAnswerTaskDirective(text: string | undefined): {
  answer: string | undefined;
  taskObjective: string | undefined;
} {
  if (text === undefined) {
    return { answer: undefined, taskObjective: undefined };
  }

  const lines = text.split("\n");
  const directives: Array<{ index: number; value: string | undefined }> = [];
  const visible: string[] = [];
  const marker = /\bANSWER_TASK\b/iu;
  const exact = /^\s*ANSWER_TASK\s*:\s*(.*?)\s*$/iu;

  for (const [index, line] of lines.entries()) {
    const at = line.search(marker);
    if (at < 0) {
      visible.push(line);
      continue;
    }

    // Preserve any prose before a marker the provider accidentally appended
    // to an answer line, but never the marker or anything after it.
    const before = line.slice(0, at).trimEnd();
    if (before.trim().length > 0) {
      visible.push(before);
    }
    const match = exact.exec(line);
    directives.push({ index, value: match?.[1]?.trim() });
    if ((line.match(/\bANSWER_TASK\b/giu)?.length ?? 0) > 1) {
      // Two markers crammed onto one line are still two competing
      // directives, not one unusually long objective.
      directives.push({ index, value: undefined });
    }
  }

  const answer = visible.join("\n").trim() || undefined;
  let finalNonEmpty = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").trim().length > 0) {
      finalNonEmpty = index;
      break;
    }
  }
  const only = directives.length === 1 ? directives[0] : undefined;
  const value = only?.value;
  const taskObjective =
    answer !== undefined &&
    only?.index === finalNonEmpty &&
    value !== undefined &&
    value.length > 0 &&
    value.length <= 2_000 &&
    /^[\p{L}\p{N}]/u.test(value) &&
    !/^(?:none|no[_ -]?task)(?:\b|$)/iu.test(value)
      ? value
      : undefined;

  return { answer, taskObjective };
}

/**
 * Whether a channel message reads as a request for work, conservatively.
 *
 * This is not NLP — a small, documented word list, biased hard toward false
 * negatives on purpose. A message that should have triggered but didn't
 * costs nothing: the sender can still @mention the right agent by hand,
 * which always works. A message that shouldn't have triggered but did
 * spends someone's real API/subscription usage on unwanted work. Those two
 * failure modes are not symmetric, so the rule requires *positive* evidence
 * — a concrete task verb — rather than merely the *absence* of a chatter
 * marker, and a status question about existing work is excluded even when
 * it contains a verb.
 */
export function looksLikeTaskRequest(content: string): boolean {
  const text = content.trim();
  if (text.length < 6) {
    return false;
  }
  if (ACK_ONLY_RE.test(text)) {
    return false;
  }
  if (!TASK_VERB_RE.test(text)) {
    return false;
  }
  if (STATUS_QUESTION_RE.test(text)) {
    return false;
  }
  if (asksAboutWork(text)) {
    return false;
  }
  return true;
}
