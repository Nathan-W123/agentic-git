import type { AgentContextPressure } from "@coord/shared-types";

/**
 * Watching how full an agent's context window is, while it is still running.
 *
 * The adapters here invoke their CLIs once and read the answer at exit, which
 * is fine for recording what a run cost and useless for deciding anything
 * during it. A task that is filling its context has already filled it by the
 * time the process closes.
 *
 * Claude Code's `--output-format stream-json` emits one JSON object per line as
 * the run proceeds, and every `assistant` event carries the `usage` block for
 * the request that produced it. That is the signal: it is the vendor's own
 * accounting, not an estimate this file invented, and it arrives per turn.
 *
 * Two things are deliberately *not* claimed here.
 *
 * The context window itself is not in the stream. It appears only in the final
 * `result` event's `modelUsage`, which is exactly when it stops being useful.
 * So this module reports occupancy and leaves the limit to the caller, which
 * already has somewhere to put it — `AgentCapabilities.maximumContextTokens`.
 * A window guessed from the model name would be a number no one checked.
 *
 * And occupancy lags. A turn's usage is reported when the request is *sent*, so
 * a large tool result that has landed since is not in it yet. Measured against
 * a real run, the last reported occupancy read 48,153 tokens at the moment the
 * tool's own pre-compaction measurement said 69,478 — a blind spot the size of
 * one pending tool result. Thresholds built on this signal need headroom for
 * that gap; see {@link ContextPressure.staleAfterToolResult}.
 *
 * ---
 *
 * This is wired in. The Claude profile runs `--output-format stream-json` in
 * both phases and attaches a monitor per spawn, so occupancy and billed usage
 * are readable while the agent is still working; during execution a verdict
 * here stops the round at a tool boundary and the control plane requeues the
 * task with a `long_running` handoff. Planning rounds are observed and never
 * stopped — handing off a plan buys nothing.
 *
 * What each vendor can actually support, as measured rather than assumed:
 *
 * - **Claude Code** — works today. Per-turn `usage` and `compact_boundary` both
 *   arrive mid-run; verified live against a real compaction and recorded in
 *   `recorded-stream.fixture.ts`.
 * - **Gemini** — blocked on the vendor, not on effort. Its stream-json emits
 *   `init`/`message`/`tool_use`/`tool_result`/`error`/`result`, and token
 *   counts attach *only* to the terminal `result` event. `message` events carry
 *   no usage at all, so there is nothing to sample while a task runs. No
 *   threshold, no polling and no prompt wording changes that; it needs a
 *   capability the CLI does not currently expose.
 * - **Codex** — unverified, not ruled out. It could not be exercised on the
 *   machine where this was written: the CLI is absent and its sandbox helper
 *   install is broken, so any claim about what `codex exec` streams would be a
 *   guess. What the adapter reads today is `turn.completed`, one event per
 *   exec, which says what a round cost rather than how full the window is —
 *   hence `contextObservation: "per_round"` there and `"live"` only here.
 *
 * The asymmetry is declared rather than left to behaviour: every adapter
 * reports a `contextObservation`, so a driver can tell a vendor that will
 * never ask to be handed off from one that has not asked yet. See the Protocol
 * section of docs/architecture/context-window-handoff.md.
 */

/** Occupancy at one turn, as the CLI reported it. */
export interface ContextTurn {
  /**
   * Tokens the request occupied in the context window.
   *
   * Fresh input, newly cached input, and cache reads all occupy the window, so
   * all three are counted. Output is excluded: it is billed, but it is not yet
   * context when the request is made. This is a different question from cost,
   * which is why it is a different number from the totals the adapters record.
   */
  contextTokens: number;
  outputTokens: number;
}

/** A compaction the CLI performed to keep going. */
export interface ContextCompaction {
  /** `auto` is the tool deciding it had to; `manual` is someone asking. */
  trigger: "auto" | "manual";
  preTokens: number;
  postTokens?: number;
  /** What compaction discarded, cumulatively, when the CLI says. */
  droppedTokens?: number;
}

export type ContextSignal =
  | ({ kind: "turn" } & ContextTurn)
  | ({ kind: "compaction" } & ContextCompaction);

/** What the stream has said about context so far. */
export interface ContextPressure {
  /** Occupancy at the most recent reported turn, if any turn was reported. */
  latestTokens?: number;
  /**
   * The highest occupancy seen.
   *
   * Kept separately because compaction resets occupancy: a run that peaked at
   * 190k and was compacted back to 30k looks calm in `latestTokens` and was
   * not, and the difference is the whole point of watching.
   */
  peakTokens: number;
  turns: number;
  compactions: ContextCompaction[];
  /**
   * Context the tool discarded to keep the run alive.
   *
   * This is the cost the feature exists to notice. Compaction does not fail —
   * it silently drops history chosen by a generic summariser that has never
   * seen the coordination record.
   */
  droppedTokens: number;
  /**
   * Whether a tool result has arrived since the last usage report.
   *
   * When true, `latestTokens` understates the truth by however large that
   * result was, and a threshold check should treat the figure as a floor
   * rather than a measurement.
   */
  staleAfterToolResult: boolean;
}

/**
 * A line longer than this is not a stream-json event.
 *
 * Without a cap, a CLI that emits a large payload with no newline would grow
 * this buffer without bound. Dropping the oversized line loses one observation;
 * retaining it could exhaust the worker.
 */
const MAX_PENDING_LINE_BYTES = 4 * 1024 * 1024;

function finiteNumber(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(
  source: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = source[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads one stream-json event into a context signal, or nothing.
 *
 * Returns undefined for the many events that say nothing about context —
 * `init`, tool traffic, partial message deltas — rather than treating an
 * unrecognised event as an error. The stream is a vendor surface that gains
 * event types between releases, and a monitor that threw on an unfamiliar one
 * would convert a cosmetic upstream change into a failed task.
 */
export function readContextSignal(event: unknown): ContextSignal | undefined {
  const record = asRecord(event);
  if (record === undefined) {
    return undefined;
  }

  if (record["type"] === "assistant") {
    const usage = asRecord(asRecord(record["message"])?.["usage"]);
    if (usage === undefined) {
      return undefined;
    }
    return {
      kind: "turn",
      contextTokens:
        finiteNumber(usage, "input_tokens") +
        finiteNumber(usage, "cache_creation_input_tokens") +
        finiteNumber(usage, "cache_read_input_tokens"),
      outputTokens: finiteNumber(usage, "output_tokens"),
    };
  }

  if (record["type"] === "system" && record["subtype"] === "compact_boundary") {
    const metadata = asRecord(record["compact_metadata"]);
    if (metadata === undefined) {
      return undefined;
    }
    const postTokens = optionalNumber(metadata, "post_tokens");
    const droppedTokens = optionalNumber(metadata, "cumulative_dropped_tokens");
    return {
      kind: "compaction",
      trigger: metadata["trigger"] === "manual" ? "manual" : "auto",
      preTokens: finiteNumber(metadata, "pre_tokens"),
      ...(postTokens === undefined ? {} : { postTokens }),
      ...(droppedTokens === undefined ? {} : { droppedTokens }),
    };
  }

  return undefined;
}

/**
 * Tracks context pressure across a stream-json run.
 *
 * Fed raw stdout chunks, which do not align with lines: `write` reassembles
 * them. Every method is safe to call mid-run, which is the point — a worker
 * asks {@link pressure} on its heartbeat while the agent is still working.
 */
export class ContextPressureMonitor {
  private pending = "";
  private latest: number | undefined;
  private peak = 0;
  private turnCount = 0;
  private readonly seenCompactions: ContextCompaction[] = [];
  private dropped = 0;
  private toolResultSinceTurn = false;
  private readonly billedMessageIds = new Set<string>();
  private billedTotal = 0;
  private billedInput = 0;
  private billedOutput = 0;
  private billedCacheRead = 0;
  private billedCacheCreation = 0;

  /**
   * Consumes a chunk of stdout and returns the signals it completed.
   *
   * A malformed line is skipped rather than thrown on. This runs alongside a
   * live agent, and the alternative — failing a task because one line of
   * telemetry did not parse — trades a working run for a diagnostic.
   */
  public write(chunk: string): ContextSignal[] {
    this.pending += chunk;
    const signals: ContextSignal[] = [];
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      if (line.length > 0) {
        const signal = this.consumeLine(line);
        if (signal !== undefined) {
          signals.push(signal);
        }
      }
      newline = this.pending.indexOf("\n");
    }
    if (this.pending.length > MAX_PENDING_LINE_BYTES) {
      this.pending = "";
    }
    return signals;
  }

  private consumeLine(line: string): ContextSignal | undefined {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }

    // A tool result is not a context signal, but it is the reason the next one
    // will be late: it enters the context now and is only counted when the
    // following request is sent.
    const record = asRecord(event);
    if (record?.["type"] === "user") {
      this.toolResultSinceTurn = true;
      return undefined;
    }

    const signal = readContextSignal(event);
    if (signal === undefined) {
      return undefined;
    }
    if (signal.kind === "turn") {
      // Claude repeats an assistant event per content block, so the same turn
      // arrives more than once with identical usage. Counting each repeat
      // would inflate the turn count without changing occupancy.
      const fresh = this.latest !== signal.contextTokens;
      if (fresh) {
        this.turnCount += 1;
      }
      this.bill(record, signal, fresh);
      this.latest = signal.contextTokens;
      this.peak = Math.max(this.peak, signal.contextTokens);
      this.toolResultSinceTurn = false;
      return signal;
    }

    this.seenCompactions.push({
      trigger: signal.trigger,
      preTokens: signal.preTokens,
      ...(signal.postTokens === undefined
        ? {}
        : { postTokens: signal.postTokens }),
      ...(signal.droppedTokens === undefined
        ? {}
        : { droppedTokens: signal.droppedTokens }),
    });
    // The tool's own pre-compaction figure is authoritative and higher than
    // anything observed from turn usage, which lags. Fold it into the peak.
    this.peak = Math.max(this.peak, signal.preTokens);
    this.dropped =
      signal.droppedTokens ??
      this.dropped +
        Math.max(0, signal.preTokens - (signal.postTokens ?? signal.preTokens));
    return signal;
  }

  /**
   * Accumulates what the in-flight invocation has billed so far.
   *
   * Keyed on `message.id` rather than on the occupancy heuristic the turn
   * count uses, because the two questions differ: two consecutive requests can
   * legitimately cost the same and occupy the same window, and billing each
   * repeated content block would multiply a round's cost by however many
   * blocks the model happened to emit. When a release stops sending an id
   * there is nothing to key on and the occupancy heuristic stands in, which
   * under-counts two identical consecutive requests rather than over-counting
   * every block — the safer side for a figure a budget is enforced against.
   */
  private bill(
    record: Record<string, unknown> | undefined,
    signal: ContextTurn,
    fresh: boolean,
  ): void {
    const id = asRecord(record?.["message"])?.["id"];
    if (typeof id === "string" && id.length > 0) {
      if (this.billedMessageIds.has(id)) {
        return;
      }
      this.billedMessageIds.add(id);
    } else if (!fresh) {
      return;
    }
    const usage = asRecord(asRecord(record?.["message"])?.["usage"]);
    this.billedTotal += signal.contextTokens + signal.outputTokens;
    this.billedOutput += signal.outputTokens;
    if (usage === undefined) {
      return;
    }
    this.billedInput += finiteNumber(usage, "input_tokens");
    this.billedCacheRead += finiteNumber(usage, "cache_read_input_tokens");
    this.billedCacheCreation += finiteNumber(
      usage,
      "cache_creation_input_tokens",
    );
  }

  /**
   * What the invocation has billed so far, in the shape the adapters report.
   *
   * The same split `parseClaudeUsage` produces from the result envelope —
   * total counts cache traffic, `inputTokens` is fresh input only — so a round
   * read live from the stream and the same round read from its envelope are
   * the same number. That is what lets a heartbeat report a round that has not
   * finished without a budget seeing the spend twice when it does.
   */
  public usage(): {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  } {
    return {
      totalTokens: this.billedTotal,
      inputTokens: this.billedInput,
      outputTokens: this.billedOutput,
      cacheReadTokens: this.billedCacheRead,
      cacheCreationTokens: this.billedCacheCreation,
    };
  }

  public pressure(): ContextPressure {
    return {
      ...(this.latest === undefined ? {} : { latestTokens: this.latest }),
      peakTokens: this.peak,
      turns: this.turnCount,
      compactions: this.seenCompactions.map((entry) => ({ ...entry })),
      droppedTokens: this.dropped,
      staleAfterToolResult: this.toolResultSinceTurn,
    };
  }
}

/**
 * Whether a run should hand off rather than push on.
 *
 * Two independent reasons, because they catch different failures. Occupancy
 * crossing a fraction of the window is the early warning, and it only works
 * where the caller actually knows the window. A compaction that already
 * happened needs no window and no threshold: the tool has stated that it could
 * not fit the conversation and discarded part of it to continue.
 */
export interface ContextPressureVerdict {
  shouldHandOff: boolean;
  /** Absent when nothing triggered. */
  reason?: string;
}

export interface ContextPressureThresholds {
  /** The window, from adapter capabilities. Occupancy is not checked without it. */
  maximumContextTokens?: number;
  /** Fraction of the window that counts as "approaching". Defaults to 0.8. */
  occupancyFraction?: number;
  /** Whether an automatic compaction alone justifies handing off. Defaults to true. */
  handOffOnCompaction?: boolean;
}

export function assessContextPressure(
  pressure: ContextPressure,
  thresholds: ContextPressureThresholds = {},
): ContextPressureVerdict {
  const compaction = pressure.compactions.find(
    (entry) => entry.trigger === "auto",
  );
  if (compaction !== undefined && (thresholds.handOffOnCompaction ?? true)) {
    return {
      shouldHandOff: true,
      reason:
        `the agent compacted its own context at ${compaction.preTokens} tokens` +
        (pressure.droppedTokens > 0
          ? `, discarding ${pressure.droppedTokens} tokens of history`
          : "") +
        " — what it dropped was chosen without reference to the coordination record",
    };
  }

  const window = thresholds.maximumContextTokens;
  const fraction = thresholds.occupancyFraction ?? 0.8;
  if (window !== undefined && window > 0 && pressure.latestTokens !== undefined) {
    const limit = window * fraction;
    if (pressure.latestTokens >= limit) {
      return {
        shouldHandOff: true,
        reason:
          `context is ${Math.round((pressure.latestTokens / window) * 100)}% ` +
          `full (${pressure.latestTokens} of ${window} tokens)` +
          (pressure.staleAfterToolResult
            ? ", and a tool result has landed since that figure was reported, " +
              "so the true occupancy is higher"
            : ""),
      };
    }
  }

  return { shouldHandOff: false };
}

/**
 * The wire shape of a pressure reading, for the control plane to record.
 *
 * Pure and separate from {@link assessContextPressure} because the verdict is
 * the adapter's opinion and this is the evidence: the figures go into the
 * `task_handed_off` audit event, and the handoff the control plane projects
 * cites those rather than anything the adapter said in words.
 */
export function pressureSnapshot(
  pressure: ContextPressure,
  maximumContextTokens?: number,
): AgentContextPressure {
  return {
    ...(pressure.latestTokens === undefined
      ? {}
      : { occupiedTokens: pressure.latestTokens }),
    peakTokens: pressure.peakTokens,
    ...(maximumContextTokens === undefined ? {} : { maximumContextTokens }),
    turns: pressure.turns,
    compactions: pressure.compactions.length,
    droppedTokens: pressure.droppedTokens,
    stale: pressure.staleAfterToolResult,
  };
}
