/** What an audit event's payload keeps, and what it admits it lost. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  summariseAuditData,
  AUDIT_SUMMARY_CLIP_MARK,
  AUDIT_SUMMARY_MAX_CHARS,
  AUDIT_SUMMARY_UNREAD_MARK,
} from "./audit-summary.js";

/**
 * The summary read back as the fields it claims to carry.
 *
 * Anything that is not a whole `key=value` and not the clip mark is a
 * fragment of one, which is the failure this file exists to catch.
 */
const fields = (summary: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const token of summary.split(" ")) {
    const split = token.indexOf("=");
    if (split <= 0) {
      continue;
    }
    const key = token.slice(0, split);
    // Values may contain spaces, so a token with no "=" belongs to the value
    // of the key before it; only the first "=" starts a field.
    found.set(key, token.slice(split + 1));
  }
  return found;
};

test("the fields that carry the story come first and in a fixed order", () => {
  // A trail of a dozen events is read down the page, so the same kind of
  // event has to read the same way every time whatever order the emitting
  // site happened to write its payload in.
  const summary = summariseAuditData({
    gate: "typecheck",
    message: "gate output attached",
    status: "validation_failed",
    reason: "the compiler exited non-zero",
  });
  assert.ok(summary.startsWith("status=validation_failed"), summary);
  assert.ok(
    summary.indexOf("reason=") < summary.indexOf("message="),
    summary,
  );
  assert.ok(summary.indexOf("message=") < summary.indexOf("gate="), summary);
});

test("whitespace inside a value is collapsed so one event stays one line", () => {
  // Each summary becomes one line of a trail. A value that wrapped would
  // read as several events.
  const summary = summariseAuditData({
    explanation: "the   typecheck\n\tgate failed",
  });
  assert.equal(summary, "explanation=the typecheck gate failed");
});

test("an empty payload summarises to nothing rather than to a shape", () => {
  assert.equal(summariseAuditData({}), "");
});

test("bulk payload fields and identifiers never reach the summary", () => {
  // Plan JSON and patch text are what the summary exists to keep out, and
  // ids differ on every run so they say nothing about what happened.
  const summary = summariseAuditData({
    status: "completed",
    patch: "diff --git a/x b/x\n".repeat(200),
    stdout: "noise".repeat(500),
    taskId: "task_123",
    prompt: "the whole prompt",
  });
  assert.equal(summary, "status=completed");
});

test("a value too long for its field says that it was cut", () => {
  // This is the failure that matters most here. An investigator reading
  // "error=the gate passed on the" decides the run recovered, when the
  // sentence went on to say it did not. A clipped value is not a shorter
  // value, it is a value whose end is unknown.
  const sentence = `the gate passed on the second attempt ${"and then ".repeat(40)}`;
  const summary = summariseAuditData({ error: sentence });
  assert.ok(summary.length < sentence.length, summary);
  assert.ok(summary.endsWith(AUDIT_SUMMARY_CLIP_MARK), summary);
  // And a value that fits is left exactly as it was recorded.
  assert.equal(
    summariseAuditData({ error: "boom" }),
    "error=boom",
  );
});

test("a clipped value never ends in half a character", () => {
  // The cut is counted in UTF-16 units, so it can land between the halves of
  // an emoji. Half a character reaches the reader as a replacement glyph -
  // the trail would end on a character nobody wrote.
  // Every prefix length, because the cut only lands between the halves when
  // the offset happens to be odd - one lucky prefix would prove nothing.
  for (const prefix of ["b", "bo", "boo", "boom", "boom!"]) {
    for (const key of ["error", "detail"]) {
      const summary = summariseAuditData({
        [key]: `${prefix} ${"\u{1F4A5}".repeat(300)}`,
      });
      const orphan = [...summary].some(
        (character) =>
          character.length === 1 &&
          character.charCodeAt(0) >= 0xd800 &&
          character.charCodeAt(0) <= 0xdfff,
      );
      assert.ok(!orphan, `${key} after ${prefix}: ${JSON.stringify(summary.slice(-6))}`);
    }
  }
});

test("the per-event cap cuts between fields and never through a value", () => {
  // Slicing the joined line at the cap landed wherever it landed, so
  // "exitCode=137" arrived as "exitCode=1" and the reader had no way to
  // know. A wrong exit code sends an investigation somewhere else entirely;
  // a missing one only sends it back to the log.
  for (const count of [40, 55, 70]) {
    const payload: Record<string, unknown> = { status: "validation_failed" };
    for (let index = 0; index < count; index += 1) {
      payload[`gate${String(index)}`] = 1000 + index;
    }
    const summary = summariseAuditData(payload);
    assert.ok(
      summary.length <= AUDIT_SUMMARY_MAX_CHARS,
      `${String(count)}: ${String(summary.length)}`,
    );
    // Something had to be left off at this size, and the reader is told so.
    assert.ok(summary.endsWith(` ${AUDIT_SUMMARY_CLIP_MARK}`), summary);
    for (const token of summary.split(" ")) {
      if (token === AUDIT_SUMMARY_CLIP_MARK) {
        continue;
      }
      const split = token.indexOf("=");
      assert.ok(split > 0, `fragment ${JSON.stringify(token)} in ${summary}`);
      const key = token.slice(0, split);
      assert.equal(
        token.slice(split + 1),
        String(payload[key]),
        `${key} came back wrong in ${summary}`,
      );
    }
  }
  // And a payload that fits carries no mark: claiming a cut that did not
  // happen would have a reader going after a field that is already there.
  const small = summariseAuditData({ status: "completed", exitCode: 0 });
  assert.equal(small, "status=completed exitCode=0");
});

test("one field longer than the whole cap still names itself", () => {
  // Returning nothing at all would read as an event that recorded nothing.
  // The field's name is the part that is still true.
  const key = "g".repeat(AUDIT_SUMMARY_MAX_CHARS + 40);
  const summary = summariseAuditData({ [key]: 7 });
  assert.ok(summary.length <= AUDIT_SUMMARY_MAX_CHARS, String(summary.length));
  assert.ok(summary.startsWith("ggggg"), summary.slice(0, 10));
  assert.ok(summary.endsWith(AUDIT_SUMMARY_CLIP_MARK), summary);
});

test("a field this cannot read is named rather than dropped", () => {
  // A failure recorded in structured form - error: { code, where } - used to
  // summarise to the empty string, so the trail showed an event that carried
  // nothing. An unread field has to read as unread and never as absent.
  const summary = summariseAuditData({ verdict: { code: 500, where: "gate" } });
  assert.ok(summary.includes(`verdict=${AUDIT_SUMMARY_UNREAD_MARK}`), summary);
  // A field that is genuinely null is not an unread field: there is nothing
  // there to go looking for, so inventing a marker would send a reader after
  // a payload that was never written.
  assert.equal(summariseAuditData({ verdict: null }), "");
});

test("a list is worth its length, including when the length is zero", () => {
  // "This run changed no files" is a fact about the run. Omitting it made it
  // indistinguishable from an event that never said either way, which is the
  // one thing a trail must not do.
  assert.equal(summariseAuditData({ changedFiles: [] }), "changedFiles=0");
  assert.equal(summariseAuditData({ files: [] }), "files=0");
  const summary = summariseAuditData({
    status: "completed",
    files: ["a.ts", "b.ts"],
    gates: ["typecheck", "test", "lint"],
  });
  assert.equal(fields(summary).get("files"), "2");
  assert.equal(fields(summary).get("gates"), "3");
  // Never the contents: a file list is exactly the bulk this keeps out.
  assert.ok(!summary.includes("a.ts"), summary);
});

test("numbers and booleans outside the priority list still reach the reader", () => {
  // A strict allowlist meant the one field that explained a failure - an
  // exit code, a gate name, whether it was a retry - never got there when it
  // was exactly what the question was about.
  const found = fields(
    summariseAuditData({ status: "validation_failed", exitCode: 2, retried: true }),
  );
  assert.equal(found.get("exitCode"), "2");
  assert.equal(found.get("retried"), "true");
  // Including the falsy ones: "exitCode=0" and "retried=false" are answers.
  const falsy = fields(summariseAuditData({ exitCode: 0, retried: false }));
  assert.equal(falsy.get("exitCode"), "0");
  assert.equal(falsy.get("retried"), "false");
});

test("a priority field that is not text is carried once, not twice", () => {
  // The priority pass only reads strings. Whatever it skipped has to fall
  // through to the general pass rather than vanish, and must not then be
  // emitted alongside a second copy of itself.
  const summary = summariseAuditData({ status: 503, message: "  " });
  assert.equal(summary, "status=503");
});
