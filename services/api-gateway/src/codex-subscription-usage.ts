import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

/**
 * A quota lookup must never make the agents screen wait indefinitely. The
 * app-server call is local and normally answers immediately; five seconds is
 * enough to cover startup without turning an optional usage card into a slow
 * API request.
 */
export const CODEX_USAGE_TIMEOUT_MS = 5_000;

/** One subscription window returned by `account/rateLimits/read`. */
export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

/**
 * The useful, stable portion of Codex's account quota response.
 *
 * The credits object stays opaque: it has changed shape between CLI releases,
 * so preserving it verbatim is what lets a caller distinguish a subscription
 * snapshot from an API-key account without this file promising a shape it
 * cannot keep. `creditBalance` is the one field inside it that has been
 * constant, lifted out because it is the part a person reads.
 */
export interface CodexRateLimitSnapshot {
  limitId?: string;
  primary: CodexRateLimitWindow;
  secondary: CodexRateLimitWindow;
  planType?: string;
  credits?: unknown;
  /** Credits remaining, when the account holds a credit balance at all. */
  creditBalance?: number;
  rateLimitReachedType?: string;
}

/** Injectable seam used by the gateway and its tests. */
export type CodexUsageReader = () => Promise<
  CodexRateLimitSnapshot | undefined
>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function property(
  value: UnknownRecord,
  camelCase: string,
  snakeCase: string,
): unknown {
  return value[camelCase] ?? value[snakeCase];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeWindow(value: unknown): CodexRateLimitWindow | undefined {
  const candidate = record(value);
  if (candidate === undefined) {
    return undefined;
  }
  const used = finiteNumber(
    property(candidate, "usedPercent", "used_percent"),
  );
  if (used === undefined) {
    return undefined;
  }
  const duration = finiteNumber(
    property(candidate, "windowDurationMins", "window_duration_mins"),
  );
  const resetsAt = finiteNumber(
    property(candidate, "resetsAt", "resets_at"),
  );
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    ...(duration === undefined || duration <= 0
      ? {}
      : { windowDurationMins: duration }),
    ...(resetsAt === undefined || resetsAt < 0 ? {} : { resetsAt }),
  };
}

/**
 * Reads the balance out of the credits object, when there is one.
 *
 * A credits object that is present but carries no number is absent, not a
 * zero balance: telling somebody they have no credits left when the CLI never
 * said so is worse than showing nothing.
 */
function normalizeCreditBalance(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const credits = record(value);
  return credits === undefined
    ? undefined
    : finiteNumber(property(credits, "balance", "balance"));
}

/**
 * Validates the app-server response and extracts a complete subscription
 * snapshot. API-key accounts return no `rateLimits`, and partial responses
 * are treated the same way: unavailable rather than a guessed quota.
 */
export function normalizeCodexRateLimits(
  value: unknown,
): CodexRateLimitSnapshot | undefined {
  const envelope = record(value);
  if (envelope === undefined) {
    return undefined;
  }
  const result = record(envelope["result"]) ?? envelope;
  const limitsValue =
    result["rateLimits"] ?? result["rate_limits"] ?? result;
  const limits = record(limitsValue);
  if (limits === undefined) {
    return undefined;
  }
  const primary = normalizeWindow(limits["primary"]);
  const secondary = normalizeWindow(limits["secondary"]);
  // A subscription snapshot has both its short and long windows. Returning a
  // lone window makes an API-key/partial response look like a complete plan.
  if (primary === undefined || secondary === undefined) {
    return undefined;
  }

  const limitId = property(limits, "limitId", "limit_id");
  const planType = property(limits, "planType", "plan_type");
  const reachedType = property(
    limits,
    "rateLimitReachedType",
    "rate_limit_reached_type",
  );
  const hasCredits = Object.hasOwn(limits, "credits");
  // The already-lifted number is accepted too: the gateway re-normalizes a
  // snapshot it was handed, and a round trip must not lose the balance.
  const creditBalance =
    normalizeCreditBalance(limits["credits"]) ??
    finiteNumber(property(limits, "creditBalance", "credit_balance"));
  return {
    primary,
    secondary,
    ...(typeof limitId === "string" ? { limitId } : {}),
    ...(typeof planType === "string" ? { planType } : {}),
    ...(hasCredits ? { credits: limits["credits"] } : {}),
    ...(creditBalance === undefined ? {} : { creditBalance }),
    ...(typeof reachedType === "string"
      ? { rateLimitReachedType: reachedType }
      : {}),
  };
}

function statusNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/%$/u, "");
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function statusWindow(
  value: unknown,
  fallbackDurationMins: number,
): CodexRateLimitWindow | undefined {
  const candidate = record(value);
  if (candidate === undefined) {
    return undefined;
  }
  const used = statusNumber(
    candidate["usedPercent"] ??
      candidate["used_percent"] ??
      candidate["percentUsed"] ??
      candidate["percent_used"],
  );
  const remaining = statusNumber(
    candidate["remainingPercent"] ??
      candidate["remaining_percent"] ??
      candidate["remainingPercentage"] ??
      candidate["remaining_percentage"] ??
      candidate["percentRemaining"] ??
      candidate["percent_remaining"],
  );
  if (used === undefined && remaining === undefined) {
    return undefined;
  }
  const duration =
    statusNumber(
      candidate["windowDurationMins"] ??
        candidate["window_duration_mins"] ??
        candidate["windowMinutes"] ??
        candidate["window_minutes"] ??
        candidate["durationMins"] ??
        candidate["duration_mins"],
    ) ?? fallbackDurationMins;
  const resetsAt = statusNumber(
    candidate["resetsAt"] ??
      candidate["resets_at"] ??
      candidate["resetAt"] ??
      candidate["reset_at"],
  );
  return {
    usedPercent: Math.max(
      0,
      Math.min(100, used !== undefined ? used : 100 - (remaining ?? 100)),
    ),
    ...(duration > 0 ? { windowDurationMins: duration } : {}),
    ...(resetsAt === undefined || resetsAt < 0 ? {} : { resetsAt }),
  };
}

/**
 * Parses the JSON form of Codex's native status display.
 *
 * The native display calls the subscription buckets five-hour and weekly and
 * may report percentage remaining; the gateway contract calls them primary
 * and secondary and stores percentage used. Both casing conventions emitted
 * by CLI releases are accepted, while a partial answer remains unavailable.
 */
export function parseCodexStatusOutput(
  stdout: string,
): CodexRateLimitSnapshot | undefined {
  let root: UnknownRecord;
  try {
    const parsed = record(JSON.parse(stdout.trim()));
    if (parsed === undefined) {
      return undefined;
    }
    root = parsed;
  } catch {
    return undefined;
  }

  const envelope =
    record(root["status"]) ?? record(root["result"]) ?? root;
  const limits =
    record(envelope["rateLimits"] ?? envelope["rate_limits"]) ??
    record(envelope["limits"]) ??
    record(envelope["usage"]) ??
    envelope;
  const primary = statusWindow(
    limits["primary"] ??
      limits["fiveHour"] ??
      limits["five_hour"] ??
      limits["fiveHourUsage"] ??
      limits["five_hour_usage"] ??
      limits["5h"] ??
      limits["5-hour"],
    300,
  );
  const secondary = statusWindow(
    limits["secondary"] ??
      limits["weekly"] ??
      limits["week"] ??
      limits["weeklyUsage"] ??
      limits["weekly_usage"],
    10_080,
  );
  if (primary === undefined || secondary === undefined) {
    return undefined;
  }

  const account = record(envelope["account"]) ?? record(root["account"]);
  const planType =
    limits["planType"] ??
    limits["plan_type"] ??
    envelope["planType"] ??
    envelope["plan_type"] ??
    root["planType"] ??
    root["plan_type"] ??
    account?.["planType"] ??
    account?.["plan_type"];
  const credits =
    limits["credits"] ?? envelope["credits"] ?? root["credits"];
  const creditBalance =
    normalizeCreditBalance(credits) ??
    statusNumber(
      limits["creditBalance"] ??
        limits["credit_balance"] ??
        envelope["creditBalance"] ??
        envelope["credit_balance"] ??
        root["creditBalance"] ??
        root["credit_balance"],
    );
  const limitId =
    property(limits, "limitId", "limit_id") ??
    property(envelope, "limitId", "limit_id");
  const reachedType =
    property(limits, "rateLimitReachedType", "rate_limit_reached_type") ??
    property(envelope, "rateLimitReachedType", "rate_limit_reached_type");
  return {
    primary,
    secondary,
    ...(typeof limitId === "string" ? { limitId } : {}),
    ...(typeof planType === "string" && planType.trim() !== ""
      ? { planType: planType.trim() }
      : {}),
    ...(credits === undefined ? {} : { credits }),
    ...(creditBalance === undefined ? {} : { creditBalance }),
    ...(typeof reachedType === "string"
      ? { rateLimitReachedType: reachedType }
      : {}),
  };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

interface CodexProcessOptions {
  command?: string;
  args?: readonly string[];
  timeoutMs?: number;
}

/** Runs `codex --status --json` and contains every subprocess failure. */
export async function readCodexStatusSubscriptionUsage(
  options: CodexProcessOptions = {},
): Promise<CodexRateLimitSnapshot | undefined> {
  const command = options.command ?? "codex";
  const args = options.args ?? ["--status", "--json"];
  const timeoutMs = options.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }

  let settled = false;
  let buffer = "";
  const finish = (
    resolve: (value: CodexRateLimitSnapshot | undefined) => void,
    value: CodexRateLimitSnapshot | undefined,
  ): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolve(value);
  };

  try {
    return await new Promise<CodexRateLimitSnapshot | undefined>((resolve) => {
      const timer = setTimeout(() => finish(resolve, undefined), timeoutMs);
      timer.unref();
      const settle = (value: CodexRateLimitSnapshot | undefined): void => {
        clearTimeout(timer);
        finish(resolve, value);
      };

      child.once("error", () => settle(undefined));
      child.once("close", (exitCode) =>
        settle(exitCode === 0 ? parseCodexStatusOutput(buffer) : undefined),
      );
      child.stdin.on("error", () => settle(undefined));
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1_048_576) {
          settle(undefined);
        }
      });
      child.stdin.end();
    });
  } finally {
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // It exited between the state check and the signal.
      }
    }
  }
}

/**
 * Starts Codex's stdio app-server, performs its initialize handshake, and
 * asks the authenticated account for current rate limits. Every failure is
 * contained as `undefined`: subscription usage is supplementary and must not
 * turn the existing usage route into an API error.
 */
export async function readCodexAppServerSubscriptionUsage(
  options: CodexProcessOptions = {},
): Promise<CodexRateLimitSnapshot | undefined> {
  const command = options.command ?? "codex";
  const args = options.args ?? ["app-server", "--stdio"];
  const timeoutMs = options.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }

  let settled = false;
  let buffer = "";
  let initialized = false;
  const finish = (
    resolve: (value: CodexRateLimitSnapshot | undefined) => void,
    value: CodexRateLimitSnapshot | undefined,
  ): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolve(value);
  };

  try {
    return await new Promise<CodexRateLimitSnapshot | undefined>((resolve) => {
      const timer = setTimeout(() => finish(resolve, undefined), timeoutMs);
      timer.unref();

      const settle = (value: CodexRateLimitSnapshot | undefined): void => {
        clearTimeout(timer);
        finish(resolve, value);
      };

      child.once("error", () => settle(undefined));
      child.once("exit", () => settle(undefined));
      child.stdin.on("error", () => settle(undefined));
      // stderr is diagnostic only. Draining it prevents a noisy CLI from
      // blocking while stdout remains the JSON-RPC transport.
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1_048_576) {
          settle(undefined);
          return;
        }
        while (!settled) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) {
            break;
          }
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length === 0) {
            continue;
          }
          let message: UnknownRecord;
          try {
            const parsed = record(JSON.parse(line));
            if (parsed === undefined) {
              settle(undefined);
              return;
            }
            message = parsed;
          } catch {
            settle(undefined);
            return;
          }

          if (message["id"] === 0) {
            if (
              message["error"] !== undefined ||
              !Object.hasOwn(message, "result") ||
              initialized
            ) {
              settle(undefined);
              return;
            }
            initialized = true;
            try {
              child.stdin.write(
                jsonLine({
                  jsonrpc: "2.0",
                  method: "initialized",
                  params: {},
                }),
              );
              child.stdin.write(
                jsonLine({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "account/rateLimits/read",
                  params: {},
                }),
              );
            } catch {
              settle(undefined);
            }
          } else if (message["id"] === 1) {
            if (!initialized || message["error"] !== undefined) {
              settle(undefined);
              return;
            }
            settle(normalizeCodexRateLimits(message));
          }
        }
      });

      try {
        child.stdin.write(
          jsonLine({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              clientInfo: {
                name: "coord-api-gateway",
                title: "Coordinator API Gateway",
                version: "0.0.0",
              },
            },
          }),
        );
      } catch {
        settle(undefined);
      }
    });
  } finally {
    // The app-server is intentionally long-lived. This request needs one
    // snapshot, so leaving it alive after success, malformed output, or a
    // timeout would leak one subprocess per hover of the usage card.
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // It exited between the state check and the signal.
      }
    }
  }
}

/** Native status with the app-server retained as a compatibility fallback. */
export async function readCodexSubscriptionUsage(
  options: {
    command?: string;
    /** Backward-compatible spelling for appServerArgs. */
    args?: readonly string[];
    statusArgs?: readonly string[];
    appServerArgs?: readonly string[];
    timeoutMs?: number;
  } = {},
): Promise<CodexRateLimitSnapshot | undefined> {
  const appServerArgs = options.appServerArgs ?? options.args;
  const status = await readCodexStatusSubscriptionUsage({
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.statusArgs === undefined ? {} : { args: options.statusArgs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (status !== undefined) {
    return status;
  }
  return await readCodexAppServerSubscriptionUsage({
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(appServerArgs === undefined ? {} : { args: appServerArgs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
