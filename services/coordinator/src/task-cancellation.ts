/**
 * Stop requests crossing from the API surface into a live run.
 *
 * A run is one long awaited call: the gateway that hears "stop" holds no
 * reference to the coordinator executing the task, and the coordinator has
 * no reason to poll the store mid-session. This registry is the bridge, in
 * the mold of `ConversationRegistry`: the host process makes one, hands the
 * same instance to every run it starts and to whatever serves its API, and
 * a cancel then reaches the exact session it names.
 *
 * Only the in-process half lives here. A task executing on a remote worker
 * is stopped by revoking its work lease — the worker's heartbeat answers
 * `lease_lost` and the worker cancels its own session — which is the kill
 * switch that path has always had. Callers do both; whichever applies acts.
 */
/**
 * Whether a stop is meant to be undone.
 *
 * Public because it is what {@link TaskCancellationRegistry.intentFor}
 * answers, and a run checkpoint reading that answer has to be able to name
 * the two cases it is choosing between.
 */
export type StopIntent = "cancel" | "pause";

/** A recorded stop: why, and which kind. */
interface RecordedStop {
  reason: string;
  intent: StopIntent;
}

export class TaskCancellationRegistry {
  /** Live aborts, registered while a task has a session to reach. */
  private readonly handlers = new Map<
    string,
    (reason: string) => Promise<void>
  >();
  /**
   * Why each stopped task was stopped. Consulted at run checkpoints, so a
   * cancel that lands between a task being leased and its session opening —
   * or while it waits, blocked, between waves — is still honoured. Bounded
   * because entries for tasks no run was holding are never read back.
   */
  private readonly reasons = new Map<string, RecordedStop>();

  private static readonly MAX_REASONS = 512;

  /**
   * Records the stop and aborts the live session when there is one.
   *
   * Returns whether a live abort ran, which is worth reporting: "stopped
   * mid-run" and "removed from the queue" read differently in a channel.
   */
  public async cancel(taskId: string, reason: string): Promise<boolean> {
    return await this.stop(taskId, reason, "cancel");
  }

  /**
   * The same stop, meant to be undone.
   *
   * Identical mechanics — record the reason, abort the live session — and a
   * different intent, which is the only thing the run's checkpoints read
   * differently: a paused task keeps its conversation session and workspace
   * so resuming continues the work, where a cancelled one tears both down.
   * Sharing the machinery is deliberate; two registries would be two places
   * for a stop to be lost.
   */
  public async pause(taskId: string, reason: string): Promise<boolean> {
    return await this.stop(taskId, reason, "pause");
  }

  private async stop(
    taskId: string,
    reason: string,
    intent: StopIntent,
  ): Promise<boolean> {
    this.reasons.set(taskId, { reason, intent });
    for (const key of this.reasons.keys()) {
      if (this.reasons.size <= TaskCancellationRegistry.MAX_REASONS) {
        break;
      }
      this.reasons.delete(key);
    }
    const abort = this.handlers.get(taskId);
    if (abort === undefined) {
      return false;
    }
    // The handler's own failure must not fail the stop: the reason is
    // recorded either way, and the run's checkpoints will still honour it.
    await abort(reason).catch(() => undefined);
    return true;
  }

  /** Why this task was stopped, or nothing if nobody stopped it. */
  public reasonFor(taskId: string): string | undefined {
    return this.reasons.get(taskId)?.reason;
  }

  /**
   * Whether this task was stopped for good or only for now.
   *
   * Separate from {@link reasonFor} so the reason keeps its old shape — a
   * plain string every existing caller reads — while a checkpoint that has
   * to choose between teardown and keeping the work can ask.
   */
  public intentFor(taskId: string): StopIntent | undefined {
    return this.reasons.get(taskId)?.intent;
  }

  /**
   * Registers the abort for a task's live session. The registration only
   * removes the handler, never the reason — a checkpoint reads the reason
   * *after* teardown to decide what the task's ending was.
   */
  public register(
    taskId: string,
    abort: (reason: string) => Promise<void>,
  ): void {
    this.handlers.set(taskId, abort);
  }

  /** Drops the live abort once a task's session is closed. */
  public release(taskId: string): void {
    this.handlers.delete(taskId);
  }
}
