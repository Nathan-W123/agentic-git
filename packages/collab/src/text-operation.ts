/**
 * Operational transformation over plain text.
 *
 * Why OT rather than a CRDT: the coordinator is a documented
 * single-control-plane deployment (see the crash-recovery comment in the web
 * entry point), so one process can serialize every edit to a file. That is
 * exactly the precondition server-authoritative OT needs, and it buys a far
 * smaller trusted core than a CRDT — no per-character identifiers, no
 * tombstones, no garbage collection, and a document whose on-the-wire state is
 * just `(revision, text)`. The whole engine is pure and dependency-free, which
 * is what lets the *same compiled module* run in the gateway and in the
 * browser (the dashboard has no bundler; `dist` is served same-origin).
 *
 * An operation is a sequence of components applied left to right against a
 * base document:
 *
 * - a positive number retains that many UTF-16 code units,
 * - a negative number deletes that many,
 * - a string inserts itself.
 *
 * UTF-16 code units — not code points — because that is what Monaco's model
 * offsets count, and a mismatch would silently corrupt any document
 * containing an emoji.
 */

export class CollabError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CollabError";
  }
}

export type OperationComponent = number | string;

export interface TextOperation {
  readonly components: readonly OperationComponent[];
  /** Length of the document this operation may be applied to. */
  readonly baseLength: number;
  /** Length of the document it produces. */
  readonly targetLength: number;
}

/**
 * Accumulates components in canonical form: adjacent components of the same
 * kind merge, empty components vanish, and an insert that lands next to a
 * delete is emitted *before* it. Canonical form matters because equality of
 * operations is compared structurally in the tests and on the wire — two
 * operations with the same effect must serialize identically.
 */
export class OperationBuilder {
  private readonly components: OperationComponent[] = [];
  private base = 0;
  private target = 0;

  public retain(count: number): this {
    if (count <= 0) {
      return this;
    }
    this.base += count;
    this.target += count;
    const last = this.components.at(-1);
    if (typeof last === "number" && last > 0) {
      this.components[this.components.length - 1] = last + count;
    } else {
      this.components.push(count);
    }
    return this;
  }

  public insert(text: string): this {
    if (text.length === 0) {
      return this;
    }
    this.target += text.length;
    const last = this.components.at(-1);
    if (typeof last === "string") {
      this.components[this.components.length - 1] = last + text;
      return this;
    }
    if (typeof last === "number" && last < 0) {
      // Insert-then-delete and delete-then-insert have the same effect; always
      // emitting the insert first keeps the canonical form unique.
      const previous = this.components.at(-2);
      if (typeof previous === "string") {
        this.components[this.components.length - 2] = previous + text;
      } else {
        this.components[this.components.length - 1] = text;
        this.components.push(last);
      }
      return this;
    }
    this.components.push(text);
    return this;
  }

  public delete(count: number): this {
    if (count <= 0) {
      return this;
    }
    this.base += count;
    const last = this.components.at(-1);
    if (typeof last === "number" && last < 0) {
      this.components[this.components.length - 1] = last - count;
    } else {
      this.components.push(-count);
    }
    return this;
  }

  public build(): TextOperation {
    return {
      components: this.components,
      baseLength: this.base,
      targetLength: this.target,
    };
  }
}

/** Rebuilds an operation from raw components, normalizing as it goes. */
export function createOperation(
  components: readonly OperationComponent[],
): TextOperation {
  const builder = new OperationBuilder();
  for (const component of components) {
    if (typeof component === "string") {
      builder.insert(component);
    } else if (component > 0) {
      builder.retain(component);
    } else {
      builder.delete(-component);
    }
  }
  return builder.build();
}

/** The identity operation over a document of `length` code units. */
export function identityOperation(length: number): TextOperation {
  return new OperationBuilder().retain(length).build();
}

export function isIdentityOperation(operation: TextOperation): boolean {
  return (
    operation.baseLength === operation.targetLength &&
    operation.components.every(
      (component) => typeof component === "number" && component > 0,
    )
  );
}

export function applyOperation(text: string, operation: TextOperation): string {
  if (text.length !== operation.baseLength) {
    throw new CollabError(
      "length_mismatch",
      `Operation expects a document of ${operation.baseLength} units, got ${text.length}`,
    );
  }
  const parts: string[] = [];
  let index = 0;
  for (const component of operation.components) {
    if (typeof component === "string") {
      parts.push(component);
    } else if (component > 0) {
      parts.push(text.slice(index, index + component));
      index += component;
    } else {
      index -= component;
    }
  }
  return parts.join("");
}

/**
 * Returns the single operation equivalent to applying `first` then `second`.
 *
 * Used on the client to squash keystrokes that pile up while an earlier
 * operation is still unacknowledged, and on the server to fast-forward a
 * client that is several revisions behind.
 */
export function composeOperations(
  first: TextOperation,
  second: TextOperation,
): TextOperation {
  if (first.targetLength !== second.baseLength) {
    throw new CollabError(
      "compose_mismatch",
      "The second operation does not apply to the first operation's output",
    );
  }
  const builder = new OperationBuilder();
  const left = first.components;
  const right = second.components;
  let leftIndex = 0;
  let rightIndex = 0;
  let a = left[leftIndex++];
  let b = right[rightIndex++];
  for (;;) {
    if (a === undefined && b === undefined) {
      break;
    }
    // A delete in the first operation removes text the second never saw, and
    // an insert in the second adds text the first never produced; both pass
    // straight through without consuming from the other side.
    if (typeof a === "number" && a < 0) {
      builder.delete(-a);
      a = left[leftIndex++];
      continue;
    }
    if (typeof b === "string") {
      builder.insert(b);
      b = right[rightIndex++];
      continue;
    }
    if (a === undefined || b === undefined) {
      throw new CollabError(
        "compose_mismatch",
        "The operations have inconsistent lengths",
      );
    }
    if (typeof a === "number" && typeof b === "number" && b > 0) {
      // retain / retain
      const shared = Math.min(a, b);
      builder.retain(shared);
      a = a === shared ? left[leftIndex++] : a - shared;
      b = b === shared ? right[rightIndex++] : b - shared;
    } else if (typeof a === "string" && typeof b === "number" && b < 0) {
      // insert / delete: the second operation eats what the first inserted
      const shared = Math.min(a.length, -b);
      a = a.length === shared ? left[leftIndex++] : a.slice(shared);
      b = -b === shared ? right[rightIndex++] : b + shared;
    } else if (typeof a === "string" && typeof b === "number") {
      // insert / retain
      const shared = Math.min(a.length, b);
      builder.insert(a.slice(0, shared));
      a = a.length === shared ? left[leftIndex++] : a.slice(shared);
      b = b === shared ? right[rightIndex++] : b - shared;
    } else if (typeof a === "number" && typeof b === "number") {
      // retain / delete
      const shared = Math.min(a, -b);
      builder.delete(shared);
      a = a === shared ? left[leftIndex++] : a - shared;
      b = -b === shared ? right[rightIndex++] : b + shared;
    } else {
      throw new CollabError(
        "compose_mismatch",
        "The operations could not be composed",
      );
    }
  }
  return builder.build();
}

/**
 * The transformation property, and the reason any of this converges:
 * given concurrent `first` and `second` over the same base document, returns
 * `[firstPrime, secondPrime]` such that
 *
 *   compose(first, secondPrime) === compose(second, firstPrime)
 *
 * so both sites reach the same text no matter which arrived first.
 *
 * Insertions at the same offset are ordered by *argument position*: whatever
 * is passed as `first` wins. Every caller must therefore agree on which side
 * is which. The convention here is that the operation being rebased — the one
 * arriving from a client, or the client's own outstanding work — is always
 * `first`; see the callers in `document.ts` and `client.ts`.
 */
export function transformOperations(
  first: TextOperation,
  second: TextOperation,
): [TextOperation, TextOperation] {
  if (first.baseLength !== second.baseLength) {
    throw new CollabError(
      "transform_mismatch",
      "Transformed operations must share a base document length",
    );
  }
  const firstPrime = new OperationBuilder();
  const secondPrime = new OperationBuilder();
  const left = first.components;
  const right = second.components;
  let leftIndex = 0;
  let rightIndex = 0;
  let a = left[leftIndex++];
  let b = right[rightIndex++];
  for (;;) {
    if (a === undefined && b === undefined) {
      break;
    }
    if (typeof a === "string") {
      firstPrime.insert(a);
      secondPrime.retain(a.length);
      a = left[leftIndex++];
      continue;
    }
    if (typeof b === "string") {
      firstPrime.retain(b.length);
      secondPrime.insert(b);
      b = right[rightIndex++];
      continue;
    }
    if (a === undefined || b === undefined) {
      throw new CollabError(
        "transform_mismatch",
        "The operations have inconsistent lengths",
      );
    }
    if (a > 0 && b > 0) {
      // retain / retain
      const shared = Math.min(a, b);
      firstPrime.retain(shared);
      secondPrime.retain(shared);
      a = a === shared ? left[leftIndex++] : a - shared;
      b = b === shared ? right[rightIndex++] : b - shared;
    } else if (a < 0 && b < 0) {
      // Both deleted the same text; neither side needs to delete it again.
      const shared = Math.min(-a, -b);
      a = -a === shared ? left[leftIndex++] : a + shared;
      b = -b === shared ? right[rightIndex++] : b + shared;
    } else if (a < 0) {
      // delete / retain: the delete still has to happen
      const shared = Math.min(-a, b);
      firstPrime.delete(shared);
      a = -a === shared ? left[leftIndex++] : a + shared;
      b = b === shared ? right[rightIndex++] : b - shared;
    } else {
      // retain / delete
      const shared = Math.min(a, -b);
      secondPrime.delete(shared);
      a = a === shared ? left[leftIndex++] : a - shared;
      b = -b === shared ? right[rightIndex++] : b + shared;
    }
  }
  return [firstPrime.build(), secondPrime.build()];
}

/**
 * Maps a caret offset through an operation.
 *
 * Text inserted exactly at the caret pushes it to the right, which is what
 * both a local typist and a remote observer expect.
 */
export function transformPosition(
  position: number,
  operation: TextOperation,
): number {
  let remaining = position;
  let result = position;
  for (const component of operation.components) {
    if (remaining < 0) {
      break;
    }
    if (typeof component === "string") {
      result += component.length;
    } else if (component > 0) {
      remaining -= component;
    } else {
      // A delete that straddles the caret drags it back to the cut point.
      result -= Math.min(remaining, -component);
      remaining += component;
    }
  }
  return result;
}

export interface SelectionRange {
  /** Where the selection started; may be after `head`. */
  readonly anchor: number;
  /** Where the caret is. */
  readonly head: number;
}

export function transformSelection(
  selection: SelectionRange,
  operation: TextOperation,
): SelectionRange {
  return {
    anchor: transformPosition(selection.anchor, operation),
    head: transformPosition(selection.head, operation),
  };
}

/** Ceiling on a single operation's component count, to bound transform cost. */
export const MAX_OPERATION_COMPONENTS = 8_192;
/** Ceiling on the total text a single operation may insert. */
export const MAX_OPERATION_INSERT_UNITS = 512 * 1024;

/**
 * Rebuilds an operation from untrusted JSON.
 *
 * Everything a client sends over the collaboration socket lands here first.
 * The checks are deliberately strict — a component array with a non-integer,
 * a zero-length run, or a length that disagrees with the document would
 * otherwise become a desynchronized document or an unbounded loop.
 */
export function parseOperation(value: unknown): TextOperation {
  if (!Array.isArray(value)) {
    throw new CollabError("invalid_operation", "Operation must be an array");
  }
  if (value.length > MAX_OPERATION_COMPONENTS) {
    throw new CollabError("invalid_operation", "Operation has too many components");
  }
  let inserted = 0;
  const components: OperationComponent[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      inserted += entry.length;
      if (inserted > MAX_OPERATION_INSERT_UNITS) {
        throw new CollabError(
          "invalid_operation",
          "Operation inserts more text than a single edit may carry",
        );
      }
      components.push(entry);
      continue;
    }
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry === 0
    ) {
      throw new CollabError(
        "invalid_operation",
        "Operation components must be non-zero integers or strings",
      );
    }
    components.push(entry);
  }
  return createOperation(components);
}

export function serializeOperation(
  operation: TextOperation,
): readonly OperationComponent[] {
  return operation.components;
}
