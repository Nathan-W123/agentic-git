/**
 * The server's authoritative copy of one shared document.
 *
 * Every operation is serialized here: a client names the revision it was
 * looking at, the document rebases the operation onto everything that landed
 * since, applies it, and hands back the rebased form to broadcast. Because a
 * single process owns the document, that rebase is the only concurrency
 * control the system needs.
 */

import {
  applyOperation,
  composeOperations,
  identityOperation,
  transformOperations,
  CollabError,
  OperationBuilder,
  type TextOperation,
} from "./text-operation.js";

export interface AppliedOperation {
  /** The document's revision *after* the operation was applied. */
  readonly revision: number;
  /** The operation rebased onto revision - 1, ready to broadcast. */
  readonly operation: TextOperation;
}

/**
 * How many operations to remember. A client that falls further behind than
 * this cannot be rebased and is told to resynchronize from a fresh snapshot,
 * which is correct but expensive — hence a window generous enough that only a
 * genuinely stalled socket hits it.
 */
const DEFAULT_HISTORY_LIMIT = 2_000;

export class CollabDocument {
  private text: string;
  /** `history[i]` carries revision `historyBase + i` to `historyBase + i + 1`. */
  private readonly history: TextOperation[] = [];
  private historyBase = 0;

  public constructor(
    content: string,
    private readonly historyLimit: number = DEFAULT_HISTORY_LIMIT,
  ) {
    this.text = content;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
      throw new RangeError("History limit must be a positive integer");
    }
  }

  public get content(): string {
    return this.text;
  }

  public get revision(): number {
    return this.historyBase + this.history.length;
  }

  /** The oldest revision a client may still name when sending an operation. */
  public get oldestRebasableRevision(): number {
    return this.historyBase;
  }

  /**
   * Rebases and applies one client operation.
   *
   * Throws `revision_too_old` when the client is beyond the history window and
   * `transform_mismatch` when the operation does not fit the document it
   * claims to be based on — both of which the caller turns into a resync.
   */
  public receive(
    clientRevision: number,
    operation: TextOperation,
  ): AppliedOperation {
    if (!Number.isSafeInteger(clientRevision) || clientRevision < 0) {
      throw new CollabError(
        "invalid_revision",
        "Revision must be a non-negative integer",
      );
    }
    if (clientRevision > this.revision) {
      throw new CollabError(
        "invalid_revision",
        "The client claims a revision the server has not reached",
      );
    }
    if (clientRevision < this.historyBase) {
      throw new CollabError(
        "revision_too_old",
        "The client is too far behind to be rebased; resynchronize",
      );
    }
    let rebased = operation;
    for (const concurrent of this.history.slice(clientRevision - this.historyBase)) {
      // The arriving operation is always `first`, so its insertions win ties
      // against history. `client.ts` uses the same convention for its own
      // outstanding work, which is what keeps the two sides in step.
      [rebased] = transformOperations(rebased, concurrent);
    }
    this.text = applyOperation(this.text, rebased);
    this.append(rebased);
    return { revision: this.revision, operation: rebased };
  }

  /**
   * Replaces the whole document because something outside the collaboration
   * session changed the file — a sandbox command, a workspace reset, or a
   * submitted change landing in canonical.
   *
   * Expressed as a minimal edit rather than a wholesale replacement so that
   * carets outside the changed region survive.
   */
  public replace(content: string): AppliedOperation | undefined {
    if (content === this.text) {
      return undefined;
    }
    const operation = diffOperation(this.text, content);
    this.text = applyOperation(this.text, operation);
    this.append(operation);
    return { revision: this.revision, operation };
  }

  /**
   * Composes everything since `revision` into one operation, for a client that
   * reconnected with stale state but is still inside the history window.
   */
  public since(revision: number): TextOperation | undefined {
    if (revision < this.historyBase || revision > this.revision) {
      return undefined;
    }
    const window = this.history.slice(revision - this.historyBase);
    if (window.length === 0) {
      return identityOperation(this.text.length);
    }
    return window.reduce((left, right) => composeOperations(left, right));
  }

  private append(operation: TextOperation): void {
    this.history.push(operation);
    const excess = this.history.length - this.historyLimit;
    if (excess > 0) {
      this.history.splice(0, excess);
      this.historyBase += excess;
    }
  }
}

/**
 * The smallest single-splice operation turning `before` into `after`.
 *
 * A real diff would be finer grained, but external file changes are rare and a
 * common-prefix/suffix splice keeps the whole thing linear and obviously
 * correct.
 */
export function diffOperation(before: string, after: string): TextOperation {
  let prefix = 0;
  const maximumPrefix = Math.min(before.length, after.length);
  while (prefix < maximumPrefix && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  const maximumSuffix = maximumPrefix - prefix;
  while (
    suffix < maximumSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return new OperationBuilder()
    .retain(prefix)
    .delete(before.length - prefix - suffix)
    .insert(after.slice(prefix, after.length - suffix))
    .retain(suffix)
    .build();
}
