import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CollabDocument, diffOperation } from "./document.js";
import { randomOperation, randomText, seededRandom } from "./random.js";
import {
  applyOperation,
  CollabError,
  OperationBuilder,
} from "./text-operation.js";

describe("the authoritative document", () => {
  it("starts at revision zero", () => {
    const document = new CollabDocument("hello");
    assert.equal(document.revision, 0);
    assert.equal(document.content, "hello");
  });

  it("applies an operation from a current client", () => {
    const document = new CollabDocument("hello");
    const applied = document.receive(
      0,
      new OperationBuilder().retain(5).insert("!").build(),
    );
    assert.equal(applied.revision, 1);
    assert.equal(document.content, "hello!");
  });

  it("rebases an operation from a client that is behind", () => {
    const document = new CollabDocument("hello");
    document.receive(0, new OperationBuilder().insert(">").retain(5).build());
    assert.equal(document.content, ">hello");
    // This client never saw the ">" and still describes the old document.
    const applied = document.receive(
      0,
      new OperationBuilder().retain(5).insert("!").build(),
    );
    assert.equal(document.content, ">hello!");
    assert.equal(applied.revision, 2);
    // The broadcast form is expressed against revision 1, not the client's.
    assert.equal(applied.operation.baseLength, 6);
  });

  it("refuses a revision the server has not reached", () => {
    const document = new CollabDocument("hi");
    assert.throws(
      () => document.receive(4, new OperationBuilder().retain(2).build()),
      (error: unknown) =>
        error instanceof CollabError && error.code === "invalid_revision",
    );
  });

  it("refuses a negative or fractional revision", () => {
    const document = new CollabDocument("hi");
    for (const revision of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () => document.receive(revision, new OperationBuilder().retain(2).build()),
        (error: unknown) =>
          error instanceof CollabError && error.code === "invalid_revision",
      );
    }
  });

  it("tells a client that fell outside the history window to resynchronize", () => {
    const document = new CollabDocument("", 3);
    for (let index = 0; index < 5; index += 1) {
      document.receive(
        document.revision,
        new OperationBuilder().retain(index).insert("x").build(),
      );
    }
    assert.equal(document.revision, 5);
    assert.equal(document.oldestRebasableRevision, 2);
    assert.throws(
      () => document.receive(1, new OperationBuilder().retain(1).build()),
      (error: unknown) =>
        error instanceof CollabError && error.code === "revision_too_old",
    );
    // Still inside the window, so this one is rebased rather than refused.
    assert.doesNotThrow(() =>
      document.receive(2, new OperationBuilder().retain(2).insert("y").build()),
    );
  });

  it("composes the catch-up operation for a lagging client", () => {
    const document = new CollabDocument("abc");
    document.receive(0, new OperationBuilder().retain(3).insert("d").build());
    document.receive(1, new OperationBuilder().retain(4).insert("e").build());
    const catchUp = document.since(0);
    assert.ok(catchUp !== undefined);
    assert.equal(applyOperation("abc", catchUp), "abcde");
    assert.equal(document.since(2)?.components.length, 1);
    assert.equal(document.since(9), undefined);
  });

  it("expresses an external file change as a minimal edit", () => {
    const document = new CollabDocument("const a = 1;\nconst b = 2;\n");
    const applied = document.replace("const a = 1;\nconst c = 2;\n");
    assert.ok(applied !== undefined);
    assert.equal(document.content, "const a = 1;\nconst c = 2;\n");
    // Only the one changed character is touched, so carets elsewhere survive.
    assert.deepEqual(applied.operation.components, [19, "c", -1, 6]);
  });

  it("ignores an external change that matches the current text", () => {
    const document = new CollabDocument("same");
    assert.equal(document.replace("same"), undefined);
    assert.equal(document.revision, 0);
  });

  it("keeps content and revision consistent under random traffic", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = seededRandom(seed * 17);
      const document = new CollabDocument(randomText(random, 20));
      let mirror = document.content;
      for (let step = 0; step < 20; step += 1) {
        const operation = randomOperation(random, document.content);
        const applied = document.receive(document.revision, operation);
        mirror = applyOperation(mirror, applied.operation);
        assert.equal(mirror, document.content, `seed ${seed} step ${step}`);
      }
      assert.equal(document.revision, 20);
    }
  });
});

describe("minimal diffs", () => {
  it("finds a pure insertion", () => {
    assert.deepEqual(diffOperation("ac", "abc").components, [1, "b", 1]);
  });

  it("finds a pure deletion", () => {
    assert.deepEqual(diffOperation("abc", "ac").components, [1, -1, 1]);
  });

  it("handles empty sides", () => {
    assert.deepEqual(diffOperation("", "abc").components, ["abc"]);
    assert.deepEqual(diffOperation("abc", "").components, [-3]);
  });

  it("reproduces the target for random pairs", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = seededRandom(seed * 41);
      const before = randomText(random, Math.floor(random() * 30));
      const after = randomText(random, Math.floor(random() * 30));
      assert.equal(
        applyOperation(before, diffOperation(before, after)),
        after,
        `diff failed for seed ${seed}`,
      );
    }
  });
});
