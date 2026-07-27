import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentProtocolError,
  JsonLineDecoder,
  MAX_MESSAGE_BYTES,
  encodeHostMessage,
  parseAgentMessage,
} from "./protocol.js";

const canonicalVersion = {
  sequence: 1,
  revision: "a".repeat(40),
  branch: "main",
  createdAt: "2026-01-01T00:00:00Z",
};

test("host messages are framed as one JSON object per line", () => {
  const line = encodeHostMessage({ type: "plan_request", sessionId: "s1" });
  assert.equal(line, '{"type":"plan_request","sessionId":"s1"}\n');
});

test("multi-line host payloads stay on a single framed line", () => {
  const line = encodeHostMessage({
    type: "start",
    sessionId: "s1",
    taskId: "t1",
    objective: "Add a\nnewline to the objective",
    repositoryId: "repo",
    canonicalVersion,
    validationCommands: [],
  });
  assert.equal(line.split("\n").length, 2);
  assert.equal(
    (JSON.parse(line) as { objective: string }).objective,
    "Add a\nnewline to the objective",
  );
});

test("the decoder reassembles messages split across chunks", () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push('{"type":"do'), []);
  assert.deepEqual(decoder.push('ne"}\n{"type":"error"'), ['{"type":"done"}']);
  assert.deepEqual(decoder.push(',"message":"x"}\n'), [
    '{"type":"error","message":"x"}',
  ]);
});

test("the decoder tolerates CRLF endings and blank lines", () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push('{"a":1}\r\n\r\n  \n{"b":2}\r\n'), [
    '{"a":1}',
    '{"b":2}',
  ]);
});

test("the decoder returns unterminated trailing output on flush", () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push('{"type":"done"}'), []);
  assert.deepEqual(decoder.flush(), ['{"type":"done"}']);
  assert.deepEqual(decoder.flush(), []);
});

test("the decoder refuses an unbounded line", () => {
  const decoder = new JsonLineDecoder();
  assert.throws(
    () => decoder.push("x".repeat(MAX_MESSAGE_BYTES + 1)),
    AgentProtocolError,
  );
});

test("a plan reply is validated against the coordination schema", () => {
  const message = parseAgentMessage(
    JSON.stringify({
      type: "plan",
      plan: {
        taskId: "t1",
        objective: "Cap the value",
        expectedFiles: ["./src/b.js", "src/a.js", "src/a.js"],
        expectedSymbols: ["increment"],
        dependencies: [],
        commands: [],
        externalAccess: [],
        riskLevel: "low",
      },
    }),
  );

  assert.equal(message.type, "plan");
  assert.deepEqual(
    message.type === "plan" ? message.plan.expectedFiles : undefined,
    ["src/a.js", "src/b.js"],
  );
});

test("a plan with an escaping path is rejected", () => {
  assert.throws(() =>
    parseAgentMessage(
      JSON.stringify({
        type: "plan",
        plan: {
          taskId: "t1",
          objective: "Escape",
          expectedFiles: ["../outside.js"],
          expectedSymbols: [],
          dependencies: [],
          commands: [],
          externalAccess: [],
          riskLevel: "low",
        },
      }),
    ),
  );
});

test("a plan missing required fields is rejected", () => {
  assert.throws(
    () => parseAgentMessage(JSON.stringify({ type: "plan", plan: { taskId: "t1" } })),
    TypeError,
  );
});

test("done messages default their optional fields", () => {
  assert.deepEqual(parseAgentMessage('{"type":"done"}'), {
    type: "done",
    symbolsChanged: [],
    explanation: "",
  });
  assert.deepEqual(
    parseAgentMessage(
      '{"type":"done","symbolsChanged":["increment"],"explanation":"capped"}',
    ),
    { type: "done", symbolsChanged: ["increment"], explanation: "capped" },
  );
});

test("agent events are normalized and timestamped", () => {
  const message = parseAgentMessage(
    '{"type":"event","event":{"event":"progress","message":"editing"}}',
  );
  assert.equal(message.type, "event");
  if (message.type !== "event" || message.event.event !== "progress") {
    throw new Error("expected a progress event");
  }
  assert.equal(message.event.message, "editing");
  assert.ok(Date.parse(message.event.occurredAt) > 0);
});

test("scope change events keep their additional files", () => {
  const message = parseAgentMessage(
    JSON.stringify({
      type: "event",
      event: {
        event: "scope_change_requested",
        additionalFiles: ["src/email.ts"],
        reason: "missing template",
        occurredAt: "2026-01-01T00:00:00Z",
      },
    }),
  );
  assert.deepEqual(message.type === "event" ? message.event : undefined, {
    event: "scope_change_requested",
    additionalFiles: ["src/email.ts"],
    reason: "missing template",
    occurredAt: "2026-01-01T00:00:00Z",
  });
});

test("error messages require a reason", () => {
  assert.deepEqual(parseAgentMessage('{"type":"error","message":"boom"}'), {
    type: "error",
    message: "boom",
  });
  assert.throws(() => parseAgentMessage('{"type":"error"}'), AgentProtocolError);
});

test("non-JSON and unknown message types are protocol errors", () => {
  assert.throws(() => parseAgentMessage("not json"), AgentProtocolError);
  assert.throws(() => parseAgentMessage("[1,2,3]"), AgentProtocolError);
  assert.throws(() => parseAgentMessage('{"type":"chat"}'), AgentProtocolError);
  assert.throws(
    () => parseAgentMessage('{"type":"event","event":{"event":"unknown"}}'),
    AgentProtocolError,
  );
});
