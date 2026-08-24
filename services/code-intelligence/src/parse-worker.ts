/**
 * A core that does nothing but parse scripts.
 *
 * The TypeScript parser is where an index build spends its time once reads
 * stop launching a process each — ~1.9s of a 2.4s build over 435 sources —
 * and it is pure CPU over files that know nothing about each other, which is
 * the one shape a thread pool suits exactly.
 *
 * This module is the worker's whole program: it imports the analyzer the main
 * thread uses, so there is one parser and not two that can disagree.
 */

import { parentPort } from "node:worker_threads";

import { analyzeScriptFile, type ScriptRequest } from "./index.js";
import type { IndexedFile } from "./index.js";

export interface ParseBatch {
  id: number;
  files: ScriptRequest[];
}

export interface ParseResult {
  id: number;
  files?: IndexedFile[];
  error?: string;
}

// Sent once this module — and the TypeScript compiler it pulls in — has
// finished loading. `online` fires when the thread starts, which is long
// before it can answer anything, so a pool that waited on that was warm in
// name only and paid the compiler load inside its first batch.
parentPort?.postMessage({ id: 0, files: [] } satisfies ParseResult);

parentPort?.on("message", (batch: ParseBatch) => {
  try {
    const files: IndexedFile[] = batch.files.map((request) =>
      analyzeScriptFile(request.path, request.source, request.language),
    );
    parentPort?.postMessage({ id: batch.id, files } satisfies ParseResult);
  } catch (error) {
    // Reported rather than thrown: a worker that dies takes its batch with it
    // and the caller has no way to tell that from a hang. The caller parses
    // the batch itself when it sees this.
    parentPort?.postMessage({
      id: batch.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ParseResult);
  }
});
