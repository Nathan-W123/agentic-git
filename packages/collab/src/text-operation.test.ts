import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { randomOperation, randomText, seededRandom } from "./random.js";
import {
  applyOperation,
  composeOperations,
  createOperation,
  identityOperation,
  isIdentityOperation,
  parseOperation,
  transformOperations,
  transformPosition,
  transformSelection,
  CollabError,
  OperationBuilder,
  MAX_OPERATION_COMPONENTS,
} from "./text-operation.js";

describe("operation construction", () => {
  it("merges adjacent components of the same kind", () => {
    const operation = new OperationBuilder()
      .retain(2)
      .retain(3)
      .insert("ab")
      .insert("cd")
      .delete(1)
      .delete(2)
      .build();
    assert.deepEqual(operation.components, [5, "abcd", -3]);
    assert.equal(operation.baseLength, 8);
    assert.equal(operation.targetLength, 9);
  });

  it("drops empty components", () => {
    const operation = new OperationBuilder()
      .retain(0)
      .insert("")
      .delete(0)
      .retain(4)
      .build();
    assert.deepEqual(operation.components, [4]);
  });

  it("emits an insert before an adjacent delete so equal edits serialize alike", () => {
    const deleteFirst = new OperationBuilder().delete(3).insert("hi").build();
    const insertFirst = new OperationBuilder().insert("hi").delete(3).build();
    assert.deepEqual(deleteFirst.components, insertFirst.components);
    assert.deepEqual(deleteFirst.components, ["hi", -3]);
    assert.equal(applyOperation("abc", deleteFirst), "hi");
    assert.equal(applyOperation("abc", insertFirst), "hi");
  });

  it("round-trips through createOperation", () => {
    const original = new OperationBuilder()
      .retain(3)
      .insert("xy")
      .delete(2)
      .retain(1)
      .build();
    assert.deepEqual(createOperation(original.components), original);
  });

  it("recognizes the identity operation", () => {
    assert.ok(isIdentityOperation(identityOperation(12)));
    assert.ok(isIdentityOperation(identityOperation(0)));
    assert.ok(
      !isIdentityOperation(new OperationBuilder().retain(2).insert("a").build()),
    );
  });
});

describe("applying operations", () => {
  it("retains, inserts, and deletes", () => {
    const operation = new OperationBuilder()
      .retain(6)
      .insert("beautiful ")
      .retain(5)
      .delete(1)
      .build();
    assert.equal(
      applyOperation("hello world!", operation),
      "hello beautiful world",
    );
  });

  it("refuses a document of the wrong length", () => {
    const operation = new OperationBuilder().retain(3).build();
    assert.throws(
      () => applyOperation("hello", operation),
      (error: unknown) =>
        error instanceof CollabError && error.code === "length_mismatch",
    );
  });

  it("counts UTF-16 code units, matching the editor's offsets", () => {
    // An astral-plane character is two code units; retaining one would split
    // the pair, so the offsets Monaco reports must be the ones used here.
    const text = "a\u{1F600}b";
    assert.equal(text.length, 4);
    const operation = new OperationBuilder().retain(3).insert("!").retain(1).build();
    assert.equal(applyOperation(text, operation), "a\u{1F600}!b");
  });
});

describe("composition", () => {
  it("is equivalent to applying both operations in turn", () => {
    const first = new OperationBuilder().retain(5).insert(" there").build();
    const second = new OperationBuilder().delete(5).retain(6).build();
    const composed = composeOperations(first, second);
    assert.equal(applyOperation("hello", composed), " there");
    assert.equal(
      applyOperation(applyOperation("hello", first), second),
      applyOperation("hello", composed),
    );
  });

  it("cancels an insert that the next operation deletes", () => {
    const first = new OperationBuilder().retain(2).insert("xyz").build();
    const second = new OperationBuilder().retain(2).delete(3).build();
    assert.deepEqual(composeOperations(first, second).components, [2]);
  });

  it("refuses operations whose lengths do not line up", () => {
    const first = new OperationBuilder().retain(3).build();
    const second = new OperationBuilder().retain(9).build();
    assert.throws(
      () => composeOperations(first, second),
      (error: unknown) =>
        error instanceof CollabError && error.code === "compose_mismatch",
    );
  });

  it("holds for randomly generated pairs", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const random = seededRandom(seed);
      const document = randomText(random, Math.floor(random() * 40));
      const first = randomOperation(random, document);
      const intermediate = applyOperation(document, first);
      const second = randomOperation(random, intermediate);
      assert.equal(
        applyOperation(document, composeOperations(first, second)),
        applyOperation(intermediate, second),
        `compose diverged for seed ${seed}`,
      );
    }
  });
});

describe("transformation", () => {
  it("lets both sites converge on concurrent inserts", () => {
    const mine = new OperationBuilder().retain(5).insert("!").build();
    const theirs = new OperationBuilder().insert(">").retain(5).build();
    const [minePrime, theirsPrime] = transformOperations(mine, theirs);
    assert.equal(
      applyOperation(applyOperation("hello", mine), theirsPrime),
      applyOperation(applyOperation("hello", theirs), minePrime),
    );
  });

  it("breaks insert ties by argument position", () => {
    const mine = new OperationBuilder().retain(2).insert("A").retain(2).build();
    const theirs = new OperationBuilder().retain(2).insert("B").retain(2).build();
    const [minePrime, theirsPrime] = transformOperations(mine, theirs);
    // Whichever operation is passed first wins the tie, in both directions.
    assert.equal(applyOperation(applyOperation("abcd", mine), theirsPrime), "abABcd");
    assert.equal(applyOperation(applyOperation("abcd", theirs), minePrime), "abABcd");
    const [theirsFirst] = transformOperations(theirs, mine);
    assert.equal(applyOperation(applyOperation("abcd", mine), theirsFirst), "abBAcd");
  });

  it("survives both sides deleting the same range", () => {
    const mine = new OperationBuilder().retain(1).delete(3).retain(1).build();
    const theirs = new OperationBuilder().retain(1).delete(3).retain(1).build();
    const [minePrime, theirsPrime] = transformOperations(mine, theirs);
    assert.equal(applyOperation(applyOperation("abcde", mine), theirsPrime), "ae");
    assert.equal(applyOperation(applyOperation("abcde", theirs), minePrime), "ae");
  });

  it("survives overlapping deletes", () => {
    const mine = new OperationBuilder().delete(3).retain(3).build();
    const theirs = new OperationBuilder().retain(2).delete(3).retain(1).build();
    const [minePrime, theirsPrime] = transformOperations(mine, theirs);
    assert.equal(applyOperation(applyOperation("abcdef", mine), theirsPrime), "f");
    assert.equal(applyOperation(applyOperation("abcdef", theirs), minePrime), "f");
  });

  it("refuses operations over different base documents", () => {
    assert.throws(
      () =>
        transformOperations(
          new OperationBuilder().retain(2).build(),
          new OperationBuilder().retain(7).build(),
        ),
      (error: unknown) =>
        error instanceof CollabError && error.code === "transform_mismatch",
    );
  });

  it("satisfies the transformation property for random pairs", () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const random = seededRandom(seed * 7);
      const document = randomText(random, Math.floor(random() * 40));
      const mine = randomOperation(random, document);
      const theirs = randomOperation(random, document);
      const [minePrime, theirsPrime] = transformOperations(mine, theirs);
      const viaMine = applyOperation(applyOperation(document, mine), theirsPrime);
      const viaTheirs = applyOperation(
        applyOperation(document, theirs),
        minePrime,
      );
      assert.equal(viaMine, viaTheirs, `transform diverged for seed ${seed}`);
      // The stronger form: the two compositions are the same operation, not
      // merely the same result on this one document.
      assert.deepEqual(
        composeOperations(mine, theirsPrime).components,
        composeOperations(theirs, minePrime).components,
        `compositions differ for seed ${seed}`,
      );
    }
  });
});

describe("carets", () => {
  it("pushes a caret right when text lands on it", () => {
    const operation = new OperationBuilder().retain(3).insert("xx").retain(2).build();
    assert.equal(transformPosition(3, operation), 5);
    assert.equal(transformPosition(2, operation), 2);
    assert.equal(transformPosition(4, operation), 6);
  });

  it("drags a caret back to the cut when its text is deleted", () => {
    const operation = new OperationBuilder().retain(1).delete(3).retain(1).build();
    assert.equal(transformPosition(0, operation), 0);
    assert.equal(transformPosition(1, operation), 1);
    assert.equal(transformPosition(3, operation), 1);
    assert.equal(transformPosition(4, operation), 1);
    assert.equal(transformPosition(5, operation), 2);
  });

  it("moves both ends of a selection", () => {
    const operation = new OperationBuilder().insert("ab").retain(5).build();
    assert.deepEqual(transformSelection({ anchor: 1, head: 4 }, operation), {
      anchor: 3,
      head: 6,
    });
  });

  it("keeps carets inside the document for random operations", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = seededRandom(seed * 13);
      const document = randomText(random, 1 + Math.floor(random() * 30));
      const operation = randomOperation(random, document);
      const result = applyOperation(document, operation);
      for (let caret = 0; caret <= document.length; caret += 1) {
        const moved = transformPosition(caret, operation);
        assert.ok(
          moved >= 0 && moved <= result.length,
          `caret ${caret} left the document for seed ${seed}`,
        );
      }
    }
  });
});

describe("parsing untrusted operations", () => {
  it("accepts a well-formed component array", () => {
    const operation = parseOperation([3, "hi", -2]);
    assert.equal(operation.baseLength, 5);
    assert.equal(operation.targetLength, 5);
  });

  it("rejects non-arrays", () => {
    assert.throws(
      () => parseOperation({ retain: 3 }),
      (error: unknown) =>
        error instanceof CollabError && error.code === "invalid_operation",
    );
  });

  it("rejects zero, fractional, and non-finite runs", () => {
    for (const bad of [[0], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [true]]) {
      assert.throws(
        () => parseOperation(bad),
        (error: unknown) =>
          error instanceof CollabError && error.code === "invalid_operation",
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });

  it("bounds the component count", () => {
    const components = Array.from(
      { length: MAX_OPERATION_COMPONENTS + 1 },
      () => 1,
    );
    assert.throws(
      () => parseOperation(components),
      (error: unknown) =>
        error instanceof CollabError && error.code === "invalid_operation",
    );
  });

  it("bounds the total inserted text", () => {
    const chunk = "x".repeat(64 * 1024);
    const components = Array.from({ length: 9 }, () => chunk);
    assert.throws(
      () => parseOperation(components),
      (error: unknown) =>
        error instanceof CollabError && error.code === "invalid_operation",
    );
  });
});
