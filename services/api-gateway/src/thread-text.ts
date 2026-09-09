/**
 * The words: naming a thread, shortening an objective, spotting a mention.
 *
 * All of it is text in and text out. None of it touches a store, a socket or
 * a request, and the only reason it lived in `server.ts` is that `server.ts`
 * is where everything lived — which meant that changing how a thread gets
 * named meant opening a fifteen-thousand-line file, and that reading any of
 * these to check what it does meant scrolling past the HTTP layer to find it.
 *
 * Two of these reach a model and are still here on purpose:
 * `summariseThreadTitle` asks a local summariser for a name and falls back to
 * the deterministic one, which is a decision about wording rather than about
 * inference, and it belongs beside the fallback it depends on.
 */

import {
  ANSWER_NOT_STATUS_DIRECTIVE,
  ROLE_CONTEXT_PREFIX,
} from "@coord/shared-types";

import type { CatchUpSummariser } from "./catch-up.js";
import { withoutMentions } from "./request-classification.js";

/**
 * An "@" that is addressing somebody, rather than one inside a word.
 *
 * Anchored to the start of the message or to whitespace, so
 * `nathan@example.com` is not read as one. The token must also reach a space
 * or the end without a slash in it, which is what separates `@Notus` from
 * `npm i @scope/package` — a name is a word, a scoped package is a path.
 * Names containing spaces are still caught: this only has to notice that
 * somebody was addressed, not capture who.
 */
export const ADDRESSED_RE = /(?:^|\s)@[A-Za-z][^\s/]*(?=\s|$)/u;

/**
 * The broadcast address for the room's people.
 *
 * `@agents` addresses every agent; this is the other half of the same idea,
 * and the half a person reaches for first, because it is the word every
 * other chat tool uses for it. It resolves to a ping for each human in the
 * channel and to no work at all: mentioning a person has never submitted a
 * task on their behalf (see `dispatchChannelMentions`), and addressing all
 * of them at once cannot mean something different from addressing them one
 * at a time.
 *
 * Written like `@agents` above it — no leading boundary, a trailing `\b` so
 * `@everyoneelse` is somebody's unusual call sign rather than a broadcast.
 */
export const EVERYONE_RE = /@everyone\b/iu;

/**
 * The headings `/plan` asks for, so a plan that opens on one is not mistaken
 * for a plan whose first line is its title.
 */
export const PLAN_SECTION_HEADING =
  /^(what this means|approach|files to change|steps|risks|how it gets checked)\b/iu;

/**
 * How much of a plan is worth keeping.
 *
 * A plan is a document and is displayed as one, so it is not held to the
 * sentence-length caps the channel's other model calls use. This is only the
 * backstop against a model that never stops: past this, the reader is
 * scrolling rather than reading, and the plan still has to fit in the context
 * of the run it is about to authorise.
 */
export const PLAN_MAX_CHARS = 12_000;

/**
 * The command word's directive, behind the one every reply carries.
 *
 * `/simple` reads last on purpose: brevity is the outer instruction, and the
 * shortest true answer still satisfies everything above it.
 */
export const withAnswerDirective = (directive?: string): string =>
  directive === undefined
    ? ANSWER_NOT_STATUS_DIRECTIVE
    : `${ANSWER_NOT_STATUS_DIRECTIVE}\n\n${directive}`;

/**
 * Politeness and preamble, which carry no information about the work.
 *
 * Stripped so an opening line reads as a summary rather than as the request
 * repeated back. Somebody who has just typed a sentence does not need it
 * quoted at them; they need to see that the part that matters was understood.
 */
export const REQUEST_PREAMBLE_RE =
  /^(hi|hey|hello|ok|okay|so|and|also|please|pls|can you|could you|would you|will you|can we|could we|i want you to|i'd like you to|i would like you to|lets|let's|we should|we need to|do you think you can|are you able to)\b[\s,:-]*/iu;

/** A request, short enough to read back in a chat line. */
export function summariseObjective(objective: string): string {
  let text = objective.replace(/\s+/gu, " ").trim();
  // Context sentences come before the ask often enough to be worth dropping:
  // "this is a greenfield project, the end goal is X. can you get started"
  // is a request to get started, and the first clause is background.
  const sentences = text.split(/(?<=[.!?])\s+/u).filter((part) => part.trim().length > 0);
  const asking = sentences.find((part) => REQUEST_PREAMBLE_RE.test(part.trim()));
  text = (asking ?? sentences.at(-1) ?? text).trim();
  // Peel politeness repeatedly: "so please can you fix…" is three layers.
  for (let round = 0; round < 4; round += 1) {
    const stripped = text.replace(REQUEST_PREAMBLE_RE, "").trim();
    if (stripped === text || stripped.length === 0) {
      break;
    }
    text = stripped;
  }
  if (text.length <= 90) {
    return text;
  }
  // Cut on a word boundary; a summary that ends mid-word reads as breakage.
  const clipped = text.slice(0, 90);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
}

/** The most a generated thread name may contain. */
export const THREAD_TITLE_MAX_WORDS = 6;

export const THREAD_TITLE_MAX_CHARS = 64;

/**
 * Turns a model's first line into the compact noun phrase the thread library
 * needs, falling back to a bounded reading of the request when it did not
 * follow the format.
 */
export function normaliseThreadTitle(
  written: string | null | undefined,
  fallback: string,
): string {
  const clean = (value: string): string =>
    (value.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "")
      .replace(/^\s*(?:[-*#]+|\d+[.)])\s*/u, "")
      .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/gu, "")
      .replace(/^\s*(?:task|thread|title)\s*:\s*/iu, "")
      .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/gu, "")
      .replace(/[.!?:;,\s]+$/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
  const fallbackWords = clean(fallback)
    .split(" ")
    .filter((word) => word.length > 0)
    .slice(0, THREAD_TITLE_MAX_WORDS);
  const boundedFallback: string[] = [];
  for (const word of fallbackWords) {
    const next = [...boundedFallback, word].join(" ");
    if (next.length > THREAD_TITLE_MAX_CHARS) {
      break;
    }
    boundedFallback.push(word);
  }
  const candidate = clean(written ?? "");
  const words = candidate === "" ? [] : candidate.split(" ");
  return candidate !== "" &&
    words.length <= THREAD_TITLE_MAX_WORDS &&
    candidate.length <= THREAD_TITLE_MAX_CHARS
    ? candidate
    : boundedFallback.join(" ") || "Software task";
}

/**
 * Names a thread with the small in-process text model. This is presentation,
 * so every model failure falls back to deterministic, bounded text rather
 * than delaying or failing the task that the thread follows.
 */
export async function summariseThreadTitle(
  objective: string,
  summariser: CatchUpSummariser | undefined,
): Promise<string> {
  const fallback = summariseObjective(objective);
  if (summariser === undefined) {
    return normaliseThreadTitle(undefined, fallback);
  }
  const prompt =
    "Name this software-work thread. Reply with only a three-to-six-word " +
    "noun phrase describing its topic, not a quote or restatement of the " +
    "request. Use no label, bullets, quotation marks, or ending punctuation." +
    `\n\nRequest:\n${objective}`;
  try {
    return normaliseThreadTitle(await summariser(prompt), fallback);
  } catch {
    return normaliseThreadTitle(undefined, fallback);
  }
}

/**
 * Who the agent is, said to the agent, before anything else.
 *
 * Without this an agent reads its own name in a message as a third party.
 * Asked "@Apollo can you audit the codebase", Codex — which *is* Apollo —
 * answered that "the Apollo integration isn't installed" and that it had
 * requested installation, because to a model with no other context Apollo is
 * a product you install. Every call sign this system hands out has the same
 * problem: Icarus, Atlas and Apollo are all things before they are anybody.
 *
 * The owner's name is included because a channel holds several people's
 * agents, and "you belong to Nathan" is what makes "what are you working on"
 * answerable about the right person's work.
 */
export function agentIdentity(candidate: {
  name: string;
  role: string;
  userName: string;
}): string {
  const role = candidate.role.trim();
  return (
    `You are "${candidate.name}", an AI agent in a team chat for a software ` +
    `project. People address you by that name — a message beginning ` +
    `"@${candidate.name}" is addressed to you, and is not a reference to some ` +
    `product or integration of that name. You belong to ${candidate.userName}.` +
    (role === "" ? "" : ` Your role in this channel is: ${role}.`)
  );
}

export function withRoleContext(role: string, objective: string): string {
  const trimmedRole = role.trim();
  if (trimmedRole === "") {
    return objective;
  }
  // `ROLE_CONTEXT_PREFIX` rather than the literal, because
  // `readsAsReportRequest` takes this preamble back off before deciding
  // whether an empty changeset is a report or a failure. If the two spellings
  // drifted the reader would silently stop recognising what this writes, and
  // every read-only task would go back to being recorded as failed.
  return `${ROLE_CONTEXT_PREFIX} ${trimmedRole}.\n\n${objective}`;
}

/**
 * How well a spoken thread name must match before it is believed.
 *
 * Higher than the accidental-merge bar: naming a thread is deliberate, and
 * attaching the wrong one to a deliberate reference is worse than attaching
 * none — the agent would answer confidently about work nobody asked about.
 */
export const THREAD_NAME_MIN_OVERLAP = 0.55;

/* The words that carry no subject: an address, a verb, an article. Stripped
   from the front of a spoken thread name so "look at the codebase improvement
   review thread" is scored on "codebase improvement review" rather than on a
   phrase three quarters of which is instruction. */

export const THREAD_NAME_FILLER = new Set([
  "a", "about", "an", "and", "at", "check", "explore", "for", "from", "go",
  "in", "inspect", "into", "look", "on", "open", "please", "read", "review",
  "see", "the", "then", "to", "up",
]);

/**
 * The thread a sentence names, if it names one.
 *
 * Bounded to the six words before "thread" rather than everything before it:
 * the name sits directly in front of the word, and taking the whole preamble
 * meant scoring the instruction along with the subject and diluting both.
 * "review" is filler at the front and meaningful in the middle — "codebase
 * improvement review" keeps it, "review the X thread" does not — which is why
 * stripping runs from the left and stops at the first real word.
 */
export function threadNameIn(content: string): string | undefined {
  const text = withoutMentions(content);
  const trailing = /([\w'-]+(?:\s+[\w'-]+){0,5})\s+thread/iu.exec(text);
  const leading = /thread\s+(?:about|on|for|called|named)\s+([\w][\w\s'-]{2,60})/iu.exec(
    text,
  );
  for (const candidate of [trailing?.[1], leading?.[1]]) {
    if (candidate === undefined) {
      continue;
    }
    const words = candidate.trim().split(/\s+/u);
    while (
      words.length > 0 &&
      THREAD_NAME_FILLER.has((words[0] ?? "").toLowerCase())
    ) {
      words.shift();
    }
    const phrase = words.join(" ");
    if (phrase.length >= 3) {
      return phrase;
    }
  }
  return undefined;
}

/**
 * How alike a request and an existing thread must be before new work joins it
 * rather than starting its own.
 *
 * Deliberately high. Merging wrongly buries work in a thread nobody is
 * reading, which is worse than the duplicate thread it was trying to avoid —
 * the same reasoning that kept this explicit-only until now. Two requests
 * about the same file, in the same words, clear it; two requests that merely
 * mention the repository do not.
 */
export const THREAD_MERGE_MIN_OVERLAP = 0.42;

/** Threads older than this are finished business, however well they match. */
export const THREAD_MERGE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
