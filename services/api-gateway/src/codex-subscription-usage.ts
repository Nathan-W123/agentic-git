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
 * Credits are intentionally opaque here. They have changed shape between CLI
 * releases and are not part of the browser's provider-neutral usage contract;
 * preserving the value is enough for callers which need to distinguish a
 * subscription snapshot from an API-key account.
 */
export interface CodexRateLimitSnapshot {
  limitId?: string;
  primary: CodexRateLimitWindow;
  secondary: CodexRateLimitWindow;
  planType?: string;
  credits?: unknown;
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
  return {
    primary,
    secondary,
    ...(typeof limitId === "string" ? { limitId } : {}),
    ...(typeof planType === "string" ? { planType } : {}),
    ...(hasCredits ? { credits: limits["credits"] } : {}),
    ...(typeof reachedType === "string"
      ? { rateLimitReachedType: reachedType }
      : {}),
  };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Starts Codex's stdio app-server, performs its initialize handshake, and
 * asks the authenticated account for current rate limits. Every failure is
 * contained as `undefined`: subscription usage is supplementary and must not
 * turn the existing usage route into an API error.
 */
export async function readCodexSubscriptionUsage(
  options: {
    command?: string;
    args?: readonly string[];
    timeoutMs?: number;
  } = {},
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
