import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseClientMessage } from "./protocol.js";
import { CollabError } from "./text-operation.js";

function rejects(raw: string, note: string): void {
  assert.throws(
    () => parseClientMessage(raw),
    (error: unknown) => error instanceof CollabError,
    note,
  );
}

describe("parsing client messages", () => {
  it("reads an operation with a caret", () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: "op",
        revision: 3,
        operation: [2, "hi", -1],
        selection: { anchor: 4, head: 4 },
      }),
    );
    assert.equal(message.type, "op");
    assert.ok(message.type === "op");
    assert.equal(message.revision, 3);
    assert.equal(message.operation.baseLength, 3);
    assert.deepEqual(message.selection, { anchor: 4, head: 4 });
  });

  it("leaves the caret absent rather than undefined when omitted", () => {
    const message = parseClientMessage(
      JSON.stringify({ type: "op", revision: 0, operation: [1] }),
    );
    assert.ok(message.type === "op");
    // exactOptionalPropertyTypes: the key must not exist at all.
    assert.ok(!("selection" in message));
  });

  it("reads a caret update", () => {
    const message = parseClientMessage(
      JSON.stringify({ type: "selection", revision: 2, selection: { anchor: 1, head: 5 } }),
    );
    assert.ok(message.type === "selection");
    assert.deepEqual(message.selection, { anchor: 1, head: 5 });
  });

  it("reads save and resync", () => {
    assert.equal(parseClientMessage('{"type":"save"}').type, "save");
    assert.equal(parseClientMessage('{"type":"resync"}').type, "resync");
  });

  it("rejects anything malformed", () => {
    rejects("not json", "non-JSON");
    rejects("[]", "array rather than object");
    rejects("null", "null");
    rejects('"hello"', "string");
    rejects('{"type":"nope"}', "unknown type");
    rejects('{"type":"op","revision":-1,"operation":[1]}', "negative revision");
    rejects('{"type":"op","revision":1.5,"operation":[1]}', "fractional revision");
    rejects('{"type":"op","operation":[1]}', "missing revision");
    rejects('{"type":"op","revision":0,"operation":"nope"}', "non-array operation");
    rejects('{"type":"op","revision":0,"operation":[0]}', "zero-length run");
    rejects(
      '{"type":"selection","revision":0,"selection":{"anchor":-1,"head":0}}',
      "negative caret",
    );
    rejects('{"type":"selection","revision":0}', "missing selection");
    rejects(
      '{"type":"op","revision":0,"operation":[1],"selection":{"anchor":0}}',
      "half a selection",
    );
  });

  it("does not let a prototype-polluting payload through", () => {
    const message = parseClientMessage(
      '{"type":"save","__proto__":{"polluted":true}}',
    );
    assert.equal(message.type, "save");
    assert.equal(
      (Object.prototype as unknown as Record<string, unknown>)["polluted"],
      undefined,
    );
  });
});
