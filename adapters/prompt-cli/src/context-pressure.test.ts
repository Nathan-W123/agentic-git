import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextPressureMonitor,
  assessContextPressure,
  readContextSignal,
} from "./context-pressure.js";
import { RECORDED_COMPACTION_STREAM } from "./recorded-stream.fixture.js";

test("occupancy counts every part of the request that occupies the window", () => {
  const signal = readContextSignal({
    type: "assistant",
    message: {
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 7284,
        cache_read_input_tokens: 18478,
        output_tokens: 4,
      },
    },
  });
  assert.deepEqual(signal, {
    kind: "turn",
    contextTokens: 25772,
    outputTokens: 4,
  });
});

test("output tokens are excluded from occupancy", () => {
  // Output is billed but is not context at the moment the request is sent.
  // Folding it in would overstate occupancy and trip handoffs early.
  const signal = readContextSignal({
    type: "assistant",
    message: { usage: { input_tokens: 100, output_tokens: 9_000 } },
  });
  assert.equal(signal?.kind === "turn" ? signal.contextTokens : -1, 100);
});

test("events that say nothing about context are ignored, not rejected", () => {
  // The stream gains event types between releases. An unfamiliar one must not
  // become a failed task.
  for (const event of [
    { type: "system", subtype: "init", tools: [] },
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 5 },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    { type: "some_event_invented_next_release" },
    null,
    "not an object",
  ]) {
    assert.equal(readContextSignal(event), undefined);
  }
});

test("a compaction is read with what it cost", () => {
  const signal = readContextSignal({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "auto",
      pre_tokens: 69_478,
      post_tokens: 22_823,
      cumulative_dropped_tokens: 46_655,
    },
  });
  assert.deepEqual(signal, {
    kind: "compaction",
    trigger: "auto",
    preTokens: 69_478,
    postTokens: 22_823,
    droppedTokens: 46_655,
  });
});

test("chunks are reassembled into lines across arbitrary boundaries", () => {
  const monitor = new ContextPressureMonitor();
  const line = JSON.stringify({
    type: "assistant",
    message: { usage: { input_tokens: 1_000, output_tokens: 5 } },
  });
  // Split mid-token, the way a pipe really delivers it.
  const cut = Math.floor(line.length / 2);
  assert.deepEqual(monitor.write(line.slice(0, cut)), []);
  const signals = monitor.write(`${line.slice(cut)}\n`);
  assert.equal(signals.length, 1);
  assert.equal(monitor.pressure().latestTokens, 1_000);
});

test("a malformed line is skipped rather than thrown on", () => {
  const monitor = new ContextPressureMonitor();
  const signals = monitor.write(
    'not json at all\n{"type":"assistant","message":{"usage":{"input_tokens":42}}}\n',
  );
  assert.equal(signals.length, 1);
  assert.equal(monitor.pressure().latestTokens, 42);
});

test("the peak survives the compaction that resets occupancy", () => {
  // A run that peaked and was compacted back down looks calm in the latest
  // figure and was not. Losing that is losing the reason to hand off.
  const monitor = new ContextPressureMonitor();
  monitor.write(
    `${JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 150_000 } },
    })}\n`,
  );
  monitor.write(
    `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 180_000,
        post_tokens: 20_000,
        cumulative_dropped_tokens: 160_000,
      },
    })}\n`,
  );
  monitor.write(
    `${JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 21_000 } },
    })}\n`,
  );

  const pressure = monitor.pressure();
  assert.equal(pressure.latestTokens, 21_000);
  assert.equal(pressure.peakTokens, 180_000);
  assert.equal(pressure.droppedTokens, 160_000);
});

test("a real recorded run is read end to end", () => {
  // The fixture is a genuine `claude -p --output-format stream-json` run that
  // compacted mid-task. Delivered in one chunk here; chunking is covered above.
  const monitor = new ContextPressureMonitor();
  monitor.write(`${RECORDED_COMPACTION_STREAM}\n`);
  const pressure = monitor.pressure();

  // Three distinct turns, though the CLI repeated each assistant event once
  // per content block.
  assert.equal(pressure.turns, 3);
  assert.equal(pressure.latestTokens, 48_483);

  // The tool's own pre-compaction measurement beats anything turn usage saw,
  // and it is the honest peak.
  assert.equal(pressure.peakTokens, 69_478);
  assert.equal(pressure.compactions.length, 1);
  assert.equal(pressure.compactions[0]?.trigger, "auto");
  assert.equal(pressure.droppedTokens, 46_655);
});

test("the recorded run shows occupancy lagging a pending tool result", () => {
  // This is the gap thresholds must leave headroom for: the last figure the
  // stream reported before compacting was 48,153, while the tool measured
  // 69,478. The difference is one tool result that had landed and not yet
  // been billed to a request.
  const lines = RECORDED_COMPACTION_STREAM.split("\n");
  const boundary = lines.findIndex((line) =>
    line.includes("compact_boundary"),
  );
  assert.ok(boundary > 0, "fixture must contain a compaction");

  const monitor = new ContextPressureMonitor();
  monitor.write(`${lines.slice(0, boundary).join("\n")}\n`);
  const before = monitor.pressure();

  assert.equal(before.latestTokens, 48_153);
  assert.equal(
    before.staleAfterToolResult,
    true,
    "a tool result arrived after the last usage report",
  );
  assert.ok(
    69_478 - (before.latestTokens ?? 0) > 20_000,
    "the blind spot is large enough to matter",
  );
});

test("an automatic compaction alone justifies a handoff", () => {
  const monitor = new ContextPressureMonitor();
  monitor.write(`${RECORDED_COMPACTION_STREAM}\n`);
  const verdict = assessContextPressure(monitor.pressure());

  assert.equal(verdict.shouldHandOff, true);
  assert.match(verdict.reason ?? "", /compacted its own context at 69478/u);
  assert.match(verdict.reason ?? "", /46655 tokens of history/u);
});

test("occupancy is not judged without a window to judge it against", () => {
  // Guessing a window from the model name would be a number nobody checked.
  const monitor = new ContextPressureMonitor();
  monitor.write(
    `${JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 190_000 } },
    })}\n`,
  );
  assert.equal(assessContextPressure(monitor.pressure()).shouldHandOff, false);
  assert.equal(
    assessContextPressure(monitor.pressure(), {
      maximumContextTokens: 200_000,
    }).shouldHandOff,
    true,
  );
});

test("occupancy below the fraction does not trigger", () => {
  const monitor = new ContextPressureMonitor();
  monitor.write(
    `${JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 100_000 } },
    })}\n`,
  );
  const verdict = assessContextPressure(monitor.pressure(), {
    maximumContextTokens: 200_000,
  });
  assert.equal(verdict.shouldHandOff, false);
});

test("a manual compaction does not on its own force a handoff", () => {
  // Someone asking for a compaction is not the same event as the tool running
  // out of room, and treating it as one would requeue tasks nobody wanted
  // requeued.
  const monitor = new ContextPressureMonitor();
  monitor.write(
    `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 90_000 },
    })}\n`,
  );
  assert.equal(assessContextPressure(monitor.pressure()).shouldHandOff, false);
});

test("compaction handoff can be switched off without losing the occupancy check", () => {
  const monitor = new ContextPressureMonitor();
  monitor.write(`${RECORDED_COMPACTION_STREAM}\n`);
  const verdict = assessContextPressure(monitor.pressure(), {
    handOffOnCompaction: false,
    maximumContextTokens: 200_000,
  });
  assert.equal(verdict.shouldHandOff, false);
});

test("dropped tokens are derived when the CLI does not total them", () => {
  const monitor = new ContextPressureMonitor();
  monitor.write(
    `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 100_000,
        post_tokens: 30_000,
      },
    })}\n`,
  );
  assert.equal(monitor.pressure().droppedTokens, 70_000);
});

test("an unterminated oversized line cannot grow without bound", () => {
  const monitor = new ContextPressureMonitor();
  monitor.write("x".repeat(5 * 1024 * 1024));
  // The buffer was dropped, so a subsequent well-formed line still parses.
  const signals = monitor.write(
    '\n{"type":"assistant","message":{"usage":{"input_tokens":7}}}\n',
  );
  assert.equal(signals.length, 1);
  assert.equal(monitor.pressure().latestTokens, 7);
});
