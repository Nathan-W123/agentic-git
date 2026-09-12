import assert from "node:assert/strict";
import test from "node:test";

import {
  clippedEntriesNotice,
  elidedHistoryNotice,
  estimateTokens,
  selectThreadContext,
  truncateToTokens,
  THREAD_CONTEXT_MAX_ENTRY_TOKENS,
  THREAD_CONTEXT_RELEVANCE_MIN,
  THREAD_CONTEXT_TOKEN_BUDGET,
} from "./thread-context.js";
import { textOverlap } from "./text.js";

/** What a selection actually costs, the way the budget counts it. */
const spend = (lines: readonly string[]): number =>
  lines.reduce((sum, line) => sum + estimateTokens(line), 0);

/** An entry too long to sit in any budget worth testing against. */
const PASTE = `a long paste ${"padding ".repeat(40).trim()}`;

/**
 * One thread, reused wherever the question is which of its parts survive.
 *
 * Deliberately shaped: an opening question, a decision taken early, a faint
 * line, one entry far too long to carry, and two short recent ones. Every
 * rule this module has shows up as a different answer on these six lines.
 */
const THREAD = [
  "root: how should the importer handle duplicates?",
  "we decided duplicates are merged on the external id",
  "merge the css files",
  PASTE,
  "so the importer merges",
  "and then we ship",
] as const;

const ASKED = "does the importer still merge duplicates on the external id?";

test("estimateTokens counts four characters to the token and nothing for blank text", () => {
  // The budget is spent on what a model reads, so text that says nothing
  // must not be charged for - a thread padded with blank lines would
  // otherwise elide real history to pay for whitespace.
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("   \n\t "), 0);
  assert.equal(estimateTokens("abcd"), 1);
  // Rounded up: a fifth character costs a whole token rather than none.
  assert.equal(estimateTokens("abcde"), 2);
  // Surrounding whitespace is not part of what was said.
  assert.equal(estimateTokens("  abcd  "), 1);
});

test("truncateToTokens returns a short entry untouched", () => {
  // Identity matters here: most entries are short, and a selection that
  // rewrote them would change what the thread says for no gain.
  const short = "already short enough";
  assert.equal(truncateToTokens(short, 50), short);
  // Exactly on the budget is not over it.
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(truncateToTokens("abcd", 1), "abcd");
});

test("truncateToTokens cuts an over-long entry at a word boundary and says it was cut", () => {
  const long = "alpha bravo charlie delta echo foxtrot golf hotel india";
  const cut = truncateToTokens(long, 6);
  assert.notEqual(cut, long);
  assert.ok(estimateTokens(cut) <= 6, cut);
  // The marker is the whole point: a message that visibly stops is read as
  // a message that stops, where one that trails off is read as a thought
  // the model is free to finish for itself.
  assert.ok(cut.endsWith(" …"), cut);
  for (const word of cut.slice(0, -2).split(" ")) {
    assert.ok(long.split(" ").includes(word), `partial word: ${word}`);
  }
});

test("truncateToTokens shortens a single enormous word rather than emptying it", () => {
  // There is no word boundary to honour in a stack trace or a base64 blob.
  // Cutting it to nothing would drop the entry silently; a clipped entry at
  // least still says what it was about.
  const blob = "x".repeat(400);
  const cut = truncateToTokens(blob, 10);
  assert.ok(cut.startsWith("xxxxx"), cut);
  assert.ok(cut.endsWith(" …"), cut);
  assert.ok(estimateTokens(cut) <= 10, cut);
});

test("truncateToTokens with no budget at all keeps nothing", () => {
  const long = "alpha bravo charlie delta echo foxtrot";
  assert.equal(truncateToTokens(long, 0), "");
  assert.equal(truncateToTokens(long, -1), "");
});

test("elidedHistoryNotice names the count and agrees with itself", () => {
  // The notice is the only thing standing between a model and a thread it
  // cannot see, so it has to read as a sentence a person wrote.
  assert.ok(elidedHistoryNotice(1).includes("1 earlier message "), "singular");
  assert.ok(elidedHistoryNotice(4).includes("4 earlier messages"), "plural");
  for (const count of [1, 2, 17]) {
    assert.ok(
      elidedHistoryNotice(count).includes(String(count)),
      elidedHistoryNotice(count),
    );
  }
});

test("a thread that fits its budget is carried whole and in order", () => {
  const lines = ["root", "then this", "then that", "newest"];
  const selected = selectThreadContext({ lines, budgetTokens: 100 });
  assert.deepEqual(selected.lines, lines);
  assert.equal(selected.elided, 0);
});

test("a thread is read back oldest first, whatever the budget kept", () => {
  const selected = selectThreadContext({
    lines: THREAD,
    focus: ASKED,
    budgetTokens: 40,
  });
  // Relevance reaches back past the recent stretch, so the kept entries do
  // not arrive in the order they were chosen. A thread replayed out of
  // order is a different conversation - the answer comes before the
  // question it answers.
  const positions = selected.lines.map((line) => THREAD.indexOf(line as never));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(!positions.includes(-1), JSON.stringify(selected.lines));
});

test("lines that say nothing are dropped without being counted as history", () => {
  // Blank entries are not messages anybody sent, so reporting them as
  // elided would tell a model there is history to ask after when there is
  // none - an invented gap is as misleading as a hidden one.
  const selected = selectThreadContext({
    lines: ["root", "", "   ", "\n\t", "newest"],
    budgetTokens: 100,
  });
  assert.deepEqual(selected.lines, ["root", "newest"]);
  assert.equal(selected.elided, 0);
});

test("every entry is collapsed to one line before it is carried", () => {
  // Each entry becomes one bullet in the prompt. An entry that wrapped
  // would read as several separate things somebody said.
  const selected = selectThreadContext({
    lines: ["root", "first line\nsecond line\n\tthird"],
    budgetTokens: 100,
  });
  assert.deepEqual(selected.lines, ["root", "first line second line third"]);
});

test("the opening message survives even when the newest one cannot", () => {
  // The root is what the thread is about. A window that drops it leaves a
  // model reading replies to a question it cannot see, and answering them.
  const root = `root: ${"context ".repeat(30).trim()}`;
  assert.ok(estimateTokens(root) > 20);
  const selected = selectThreadContext({
    lines: [root, "tiny", "and the newest thing anybody said"],
    budgetTokens: 20,
  });
  assert.equal(selected.lines.length, 1);
  assert.ok(selected.lines[0]?.startsWith("root: context"), selected.lines[0]);
  assert.equal(selected.elided, 2);
});

test("a root longer than the whole budget is cut down to it, never dropped", () => {
  const root = `root: ${"context ".repeat(200).trim()}`;
  const selected = selectThreadContext({
    lines: [root, "newest"],
    budgetTokens: 20,
  });
  assert.equal(selected.lines.length, 1);
  // Cut, and saying so - not absent, and not silently whole.
  assert.ok(selected.lines[0]?.endsWith(" …"), selected.lines[0]);
  assert.ok(spend(selected.lines) <= 20, String(spend(selected.lines)));
  assert.equal(selected.elided, 1);
});

test("the newest stretch is kept contiguous rather than filled in around a long entry", () => {
  // Skipping over the long paste to collect the small entries behind it
  // would leave the recent conversation with holes in it, which reads as a
  // different conversation. What falls the far side of the cut is reported
  // as elided and can still come back on relevance.
  const selected = selectThreadContext({ lines: THREAD, budgetTokens: 40 });
  assert.deepEqual(selected.lines, [
    THREAD[0],
    "so the importer merges",
    "and then we ship",
  ]);
  // "merge the css files" costs 5 tokens and would have fit - it is left
  // out because it sits behind the paste, not because there was no room.
  assert.ok(estimateTokens("merge the css files") + spend(selected.lines) <= 40);
  assert.equal(selected.elided, 3);
});

test("an older entry the request is about is carried on the budget recency left over", () => {
  // Pure recency silently forgets the decision taken thirty messages back
  // that the current question is entirely about.
  const selected = selectThreadContext({
    lines: THREAD,
    focus: ASKED,
    budgetTokens: 40,
  });
  assert.ok(
    selected.lines.includes("we decided duplicates are merged on the external id"),
    JSON.stringify(selected.lines),
  );
  // With nothing to score against there is no way to know it mattered, so
  // recency alone decides and the decision drops off.
  const blind = selectThreadContext({ lines: THREAD, budgetTokens: 40 });
  assert.ok(
    !blind.lines.includes("we decided duplicates are merged on the external id"),
    JSON.stringify(blind.lines),
  );
});

test("relevance never displaces a recent entry", () => {
  const blind = selectThreadContext({ lines: THREAD, budgetTokens: 40 });
  const focused = selectThreadContext({
    lines: THREAD,
    focus: ASKED,
    budgetTokens: 40,
  });
  // Everything recency chose is still there; relevance only spends what
  // recency left unused.
  for (const line of blind.lines) {
    assert.ok(focused.lines.includes(line), line);
  }
  assert.ok(focused.lines.length > blind.lines.length);
  assert.ok(spend(focused.lines) <= 40, String(spend(focused.lines)));
});

test("an older entry that merely shares a stray word stays out", () => {
  // The floor is what stops relevance from becoming "anything at all",
  // which would spend the leftover budget on whichever old line happened
  // to use the word "merge".
  const faint = "merge the css files";
  assert.ok(textOverlap(ASKED, faint) < THREAD_CONTEXT_RELEVANCE_MIN);
  const selected = selectThreadContext({
    lines: THREAD,
    focus: ASKED,
    budgetTokens: 40,
  });
  assert.ok(!selected.lines.includes(faint), JSON.stringify(selected.lines));
  // It is the score that kept it out and not the budget: it would have fit
  // in what was left after the relevant decision was carried.
  assert.ok(spend(selected.lines) + estimateTokens(faint) <= 40);
});

test("a request made of nothing but whitespace scores nothing", () => {
  // An empty focus is not a request that matches everything. Treating it
  // as one would let a blank string pull arbitrary old entries forward.
  const blank = selectThreadContext({
    lines: THREAD,
    focus: "   \n ",
    budgetTokens: 40,
  });
  const blind = selectThreadContext({ lines: THREAD, budgetTokens: 40 });
  assert.deepEqual(blank.lines, blind.lines);
  assert.equal(blank.elided, blind.elided);
});

test("one entry can never take more than its share of the budget", () => {
  // A single pasted log can be longer than the whole conversation around
  // it. Clipped, it still says what it was about; whole, it pushes
  // everything else out.
  const giant = "x".repeat(40_000);
  const selected = selectThreadContext({
    lines: ["root", giant],
    budgetTokens: 100_000,
  });
  assert.equal(selected.elided, 0);
  assert.equal(selected.lines.length, 2);
  assert.equal(
    estimateTokens(selected.lines[1] ?? ""),
    THREAD_CONTEXT_MAX_ENTRY_TOKENS,
  );
  assert.ok(selected.lines[1]?.endsWith(" …"), "the clip is visible");
});

test("a thread with no budget at all reports all of itself as elided", () => {
  // Nothing carried is not the same as nothing said. Returning an empty
  // selection with nothing elided would tell the caller the thread was
  // empty, and the prompt would carry no notice at all.
  for (const budgetTokens of [0, -1]) {
    const selected = selectThreadContext({
      lines: ["root", "middle", "newest"],
      budgetTokens,
    });
    assert.deepEqual(selected.lines, []);
    assert.equal(selected.elided, 3);
  }
});

test("an empty thread is empty rather than elided", () => {
  // The mirror of the case above: there is no history here to ask after,
  // so a notice claiming some was omitted would be an invention.
  for (const lines of [[], ["", "  "]]) {
    const selected = selectThreadContext({ lines });
    assert.deepEqual(selected.lines, []);
    assert.equal(selected.elided, 0);
  }
});

test("what was left out is always the difference between what was said and what was kept", () => {
  // The count goes straight into the notice the model reads, so it has to
  // account for the whole gap - an undercount is a model told less history
  // is missing than really is.
  const said = THREAD.filter((line) => line.trim().length > 0).length;
  for (const budgetTokens of [1, 5, 12, 20, 40, 80, 200, 10_000]) {
    for (const focus of [undefined, ASKED]) {
      const selected = selectThreadContext({
        lines: THREAD,
        ...(focus === undefined ? {} : { focus }),
        budgetTokens,
      });
      assert.equal(
        selected.lines.length + selected.elided,
        said,
        `budget ${String(budgetTokens)}`,
      );
      assert.ok(
        spend(selected.lines) <= budgetTokens,
        `budget ${String(budgetTokens)} spent ${String(spend(selected.lines))}`,
      );
    }
  }
});

test("the default budget is the one a thread is carried under when the caller names none", () => {
  // Both callers in the gateway omit the budget, so the default is the
  // real one - a thread of a couple of hundred lines is what it has to
  // survive.
  const unit = "we talked about the importer and then moved on to the next thing";
  const many = Array.from({ length: 200 }, (_, index) => `${String(index)} ${unit}`);
  const selected = selectThreadContext({ lines: many });
  assert.ok(selected.elided > 0);
  assert.ok(
    spend(selected.lines) <= THREAD_CONTEXT_TOKEN_BUDGET,
    String(spend(selected.lines)),
  );
  // And the same thread short enough to fit arrives whole under it.
  const few = many.slice(0, 5);
  assert.deepEqual(selectThreadContext({ lines: few }).lines, few);
});

/**
 * Any half of a surrogate pair left standing on its own after a cut.
 *
 * Spreading walks code points, so a whole emoji arrives as one two-unit
 * string and an orphaned half as a one-unit string in the surrogate range.
 */
const loneSurrogate = (value: string): boolean =>
  [...value].some(
    (character) =>
      character.length === 1 &&
      character.charCodeAt(0) >= 0xd800 &&
      character.charCodeAt(0) <= 0xdfff,
  );

test("truncateToTokens never cuts a character in half", () => {
  // The budget is counted in UTF-16 units, so the cut lands wherever the
  // arithmetic puts it - including between the two halves of an emoji. Half
  // a character is not a shortened message: it reaches the model as a
  // replacement glyph, so the last thing a clipped log line says is a
  // character nobody wrote.
  const value = `a${"\u{1F600}".repeat(50)}`;
  for (const maxTokens of [1, 2, 3, 5, 8, 13, 21]) {
    const cut = truncateToTokens(value, maxTokens);
    assert.ok(!loneSurrogate(cut), `${String(maxTokens)}: ${JSON.stringify(cut)}`);
    assert.ok(estimateTokens(cut) <= maxTokens, cut);
  }
  // And the same through the selection, which is where real threads meet it.
  const selected = selectThreadContext({
    lines: ["root", `log ${"\u{1F4A5}".repeat(4000)}`],
    budgetTokens: 500,
  });
  for (const line of selected.lines) {
    assert.ok(!loneSurrogate(line), JSON.stringify(line.slice(-4)));
  }
});

test("a message that was shortened to fit is reported as shortened", () => {
  // The whole point. One pasted log clipped to its share of the budget
  // leaves a selection with nothing elided - so a caller that only looks at
  // the elided count sends a partial thread and calls it complete, and the
  // model answers about the log from the first quarter of it with no reason
  // to hedge.
  const giant = `the deploy log ${"x".repeat(40_000)}`;
  const selected = selectThreadContext({
    lines: ["root: why did the deploy fail?", giant],
    budgetTokens: 100_000,
  });
  assert.equal(selected.elided, 0);
  assert.equal(selected.clipped, 1);
  assert.equal(selected.lines.length, 2);
});

test("a thread carried whole reports nothing shortened and nothing elided", () => {
  // The mirror: claiming a clip that did not happen would have the model
  // hedging about a thread it can see all of.
  const selected = selectThreadContext({
    lines: ["root", "then this", "newest"],
    budgetTokens: 100,
  });
  assert.equal(selected.elided, 0);
  assert.equal(selected.clipped, 0);
});

test("a root cut down to the whole budget is reported as shortened", () => {
  // The root is never dropped, so the only way to say it arrived incomplete
  // is the clip count. Silence here reads as a root that fit. Deliberately
  // short enough to pass the per-entry cap untouched: the only thing that
  // shortens it is the budget, which is the cut being tested.
  const root = `root: ${"context ".repeat(40).trim()}`;
  assert.equal(
    truncateToTokens(root, THREAD_CONTEXT_MAX_ENTRY_TOKENS),
    root,
    "the per-entry cap must not be what cut this",
  );
  const selected = selectThreadContext({ lines: [root, "newest"], budgetTokens: 20 });
  assert.equal(selected.lines.length, 1);
  assert.ok(selected.lines[0]?.endsWith(" …"), selected.lines[0]);
  assert.equal(selected.clipped, 1);
  assert.equal(selected.elided, 1);
});

test("an entry that was shortened and then dropped is counted once, as elided", () => {
  // A message that is not there at all is a gap, not a clip. Counting it as
  // both would tell the reader the same loss twice and imply there is a
  // shortened line above to go looking at.
  const paste = `paste ${"padding ".repeat(200).trim()}`;
  const selected = selectThreadContext({
    lines: ["root", paste, paste, "and then we ship"],
    budgetTokens: 30,
  });
  assert.ok(!selected.lines.includes(paste), JSON.stringify(selected.lines));
  assert.equal(selected.elided, 2);
  assert.equal(selected.clipped, 0);
});

test("nothing is reported as shortened when there was no budget at all", () => {
  // Nothing was carried, so there is no shortened line above for a notice
  // to point at - every one of them is simply missing.
  const selected = selectThreadContext({
    lines: ["root", `x${"y".repeat(40_000)}`],
    budgetTokens: 0,
  });
  assert.deepEqual(selected.lines, []);
  assert.equal(selected.elided, 2);
  assert.equal(selected.clipped, 0);
});

test("clippedEntriesNotice names the count and points at the mark it left", () => {
  // A reader has to be able to connect the notice to the "…" in the lines
  // above it, or the notice is just a warning about nothing in particular.
  assert.ok(clippedEntriesNotice(1).includes("1 message"), clippedEntriesNotice(1));
  assert.ok(clippedEntriesNotice(1).includes(" was "), clippedEntriesNotice(1));
  assert.ok(clippedEntriesNotice(3).includes("3 messages"), clippedEntriesNotice(3));
  assert.ok(clippedEntriesNotice(3).includes(" were "), clippedEntriesNotice(3));
  for (const count of [1, 2, 9]) {
    assert.ok(clippedEntriesNotice(count).includes("…"), clippedEntriesNotice(count));
  }
});

test("a thread of one enormous message is a shortened message, not an empty thread", () => {
  // Adversarial, and the shape a pasted stack trace really arrives in. The
  // answer that matters is that something comes back and it says it is cut -
  // an empty selection here would have the caller drop the thread entirely.
  const selected = selectThreadContext({ lines: ["z".repeat(200_000)] });
  assert.equal(selected.lines.length, 1);
  assert.equal(selected.elided, 0);
  assert.equal(selected.clipped, 1);
  assert.ok(selected.lines[0]?.endsWith(" …"), "the clip is visible in the line");
  assert.ok(
    estimateTokens(selected.lines[0] ?? "") <= THREAD_CONTEXT_MAX_ENTRY_TOKENS,
  );
});

test("the order the caller gave is the order the thread is read back in", () => {
  // This module does not sort. A store that hands back replies out of
  // timestamp order gets them back in that same order rather than silently
  // rearranged - reordering here would invent a conversation that never
  // happened, and is the caller's decision to make with the timestamps it
  // has and this module does not.
  const shuffled = ["root", "third", "first", "second"];
  assert.deepEqual(
    selectThreadContext({ lines: shuffled, budgetTokens: 100 }).lines,
    shuffled,
  );
});

test("repeated identical messages are each carried, not collapsed into one", () => {
  // "ok" said three times by three people is three messages. Deduplicating
  // would shorten the thread by facts the reader is entitled to, and the
  // elided count would then have to lie about which.
  const selected = selectThreadContext({
    lines: ["root", "ok", "ok", "ok"],
    budgetTokens: 100,
  });
  assert.deepEqual(selected.lines, ["root", "ok", "ok", "ok"]);
  assert.equal(selected.elided, 0);
});

test("a thread in a script the scorer cannot read still comes back on recency", () => {
  // `relevanceTokens` strips everything outside a-z0-9, so a thread written
  // in Japanese scores zero against any request and the relevance pass can
  // never reach back into it. Recency still has to carry it: the failure to
  // score must cost the reader older lines, never the recent ones.
  const lines = [
    "ルート: インポーターの重複はどう扱う?",
    "重複は外部IDでマージすると決めた",
    "それで出荷します",
  ];
  const selected = selectThreadContext({
    lines,
    focus: "インポーターは重複をマージしますか?",
    budgetTokens: 100,
  });
  assert.deepEqual(selected.lines, lines);
  assert.equal(selected.elided, 0);
});
