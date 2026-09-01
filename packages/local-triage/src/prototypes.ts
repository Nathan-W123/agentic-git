/**
 * What the two ends of a channel sound like, as sentences rather than words.
 *
 * These are compared against by meaning, not matched against. That is the
 * whole reason they exist: a word list could not tell "the update went out"
 * from "update the readme", because the difference is not in the words, and
 * no amount of adding to the list ever reaches it. Sentence embeddings put
 * those two a long way apart, which is what makes this worth its 22 MB.
 *
 * They are examples, not rules. Nothing here has to appear in a message for
 * it to be recognised, and adding a line changes the shape of a region rather
 * than adding a case — which is why the lists stay short and varied instead
 * of long and exhaustive. Reaching for a new line because one message went
 * the wrong way is how this turns back into a word list.
 */

/** Things people say to each other, which are never work for an agent. */
export const CHATTER_PROTOTYPES: readonly string[] = [
  "hi there",
  "good morning everyone",
  "hey, how's it going",
  "thanks, that helps",
  "thank you!",
  "ok, sounds good",
  "got it",
  "nice work on that",
  "that looks great",
  "haha same",
  "I'm heading out, back later",
  "the deploy went out this morning",
  "I finished the readme yesterday",
  "that migration broke the build last week",
  "is the login fix live yet?",
  "any update on the release?",
  "what time is standup",
  "welcome to the team!",
  // Owning a mistake, which is conversation and reads like a bug report.
  //
  // Also measured: "that was my fault, sorry" leaned +0.111 and "my mistake"
  // +0.078 against the list without these, so an apology was already on the
  // wrong side before anything here changed — it names a fault, and every
  // other way of naming a fault in this file is work.
  "that was my fault, sorry",
  "my mistake, ignore that",
  "sorry, wrong channel",
];

/** Things people say when they want something done to the repository. */
export const WORK_PROTOTYPES: readonly string[] = [
  "change the background to blue",
  "please fix the retry loop",
  "add a dark mode toggle",
  "can you update the readme",
  "remove the unused imports in that module",
  "the gray background looks rough",
  "this page loads far too slowly",
  "we should probably refactor the auth module",
  "the button is misaligned on mobile",
  "the error message there is confusing",
  "can someone start building a chess engine",
  "audit the codebase for unused dependencies",
  "look into why the tests are flaky",
  "migrate the sessions table to postgres",
  "it would be good to have keyboard shortcuts here",
  // Where a thing sits, rather than how it looks or what it does.
  //
  // Measured, not guessed. A real report — "my name also appears right under
  // the agent tab, that should be all the way at the bottom" — leaned -0.052
  // in production and was passed over, while every phrasing about appearance
  // ("the send button is the wrong colour", +0.246) or behaviour ("the
  // dropdown closes when you click inside it", +0.097) already scored well.
  // Probing variations narrowed it to placement and ordering specifically:
  // "the agent tab shows the wrong thing at the bottom" was -0.029 and
  // "people should be listed at the bottom, not under agents" -0.037, against
  // "the user list shows my name twice" at +0.020. The list knew what a bug
  // looks like and what a bug does, and nothing about where a bug is.
  "my name is listed under the agents section instead of with the people",
  "these items are in the wrong order",
  "that panel should be at the bottom of the sidebar, not the top",
  "the save button belongs below the form, not above it",
  "the sidebar sections are in a strange order",
];
