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
];
