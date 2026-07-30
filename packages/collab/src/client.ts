/**
 * The client half of the OT loop.
 *
 * A client is always in one of three states:
 *
 * - **synchronized** — nothing in flight; a local edit is sent immediately.
 * - **awaiting** — one operation is in flight, waiting for the server's ack.
 * - **awaiting with buffer** — one in flight, and later local edits composed
 *   into a single buffered operation that goes out when the ack lands.
 *
 * Keeping at most one operation in flight is what makes the server's job
 * tractable: it only ever transforms against the history since the revision
 * the client named, and a client can never get ahead of its own ack.
 *
 * This module is pure and runs in the browser; the transport lives elsewhere.
 */

import {
  composeOperations,
  transformOperations,
  transformSelection,
  type SelectionRange,
  type TextOperation,
  CollabError,
} from "./text-operation.js";

/** What the caller should do after handing an event to the client. */
export interface ClientAction {
  /** Send this operation to the server at `revision`. */
  readonly send?: { readonly operation: TextOperation; readonly revision: number };
  /** Apply this operation to the local editor model. */
  readonly apply?: TextOperation;
}

export class CollaborativeClient {
  private outstanding: TextOperation | undefined;
  private buffer: TextOperation | undefined;

  public constructor(private serverRevision: number) {
    if (!Number.isSafeInteger(serverRevision) || serverRevision < 0) {
      throw new CollabError("invalid_revision", "Revision must be a non-negative integer");
    }
  }

  public get revision(): number {
    return this.serverRevision;
  }

  /** True when every local edit has been acknowledged by the server. */
  public get synchronized(): boolean {
    return this.outstanding === undefined;
  }

  /**
   * Records an operation the user just performed locally.
   *
   * Returns what to send, or nothing when an earlier operation is still in
   * flight — in that case the edit is buffered and goes out on the next ack.
   */
  public applyLocal(operation: TextOperation): ClientAction {
    if (this.outstanding === undefined) {
      this.outstanding = operation;
      return { send: { operation, revision: this.serverRevision } };
    }
    this.buffer =
      this.buffer === undefined
        ? operation
        : composeOperations(this.buffer, operation);
    return {};
  }

  /**
   * Records an operation broadcast by the server that some other client made.
   *
   * The local unsent work is rebased onto it, and the returned operation is
   * the remote edit rebased onto the local work — which is what the editor
   * model must actually apply.
   */
  public applyServer(operation: TextOperation): ClientAction {
    this.serverRevision += 1;
    if (this.outstanding === undefined) {
      return { apply: operation };
    }
    // Local work is always the `first` argument, matching what the server does
    // when it rebases an arriving operation onto its history. Both sides must
    // break insert ties the same way or the documents diverge.
    const [outstandingPrime, remoteAfterOutstanding] = transformOperations(
      this.outstanding,
      operation,
    );
    this.outstanding = outstandingPrime;
    if (this.buffer === undefined) {
      return { apply: remoteAfterOutstanding };
    }
    const [bufferPrime, remoteAfterBuffer] = transformOperations(
      this.buffer,
      remoteAfterOutstanding,
    );
    this.buffer = bufferPrime;
    return { apply: remoteAfterBuffer };
  }

  /** Records the server's acknowledgement of the operation in flight. */
  public acknowledge(): ClientAction {
    if (this.outstanding === undefined) {
      throw new CollabError(
        "unexpected_ack",
        "The server acknowledged an operation that was never sent",
      );
    }
    this.serverRevision += 1;
    if (this.buffer === undefined) {
      this.outstanding = undefined;
      return {};
    }
    this.outstanding = this.buffer;
    this.buffer = undefined;
    return {
      send: { operation: this.outstanding, revision: this.serverRevision },
    };
  }

  /**
   * Maps a remote selection, expressed against the server document, into this
   * client's local coordinates by pushing it through the unacknowledged work.
   */
  public selectionToLocal(selection: SelectionRange): SelectionRange {
    let result = selection;
    if (this.outstanding !== undefined) {
      result = transformSelection(result, this.outstanding);
    }
    if (this.buffer !== undefined) {
      result = transformSelection(result, this.buffer);
    }
    return result;
  }

  /**
   * Discards local state so the caller can restart from a server snapshot.
   *
   * The socket resubscribes with a fresh `welcome` after any error the client
   * cannot rebase past (for example a history window that has scrolled past
   * the revision it holds).
   */
  public reset(revision: number): void {
    this.serverRevision = revision;
    this.outstanding = undefined;
    this.buffer = undefined;
  }
}
