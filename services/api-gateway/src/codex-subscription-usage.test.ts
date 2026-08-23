import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCodexRateLimits,
  parseCodexStatusOutput,
  readCodexAppServerSubscriptionUsage,
  readCodexStatusSubscriptionUsage,
  readCodexSubscriptionUsage,
} from "./codex-subscription-usage.js";

test("Codex account rate limits preserve both windows and account metadata", () => {
  const snapshot = normalizeCodexRateLimits({
    jsonrpc: "2.0",
    id: 1,
    result: {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 17,
          windowDurationMins: 300,
          resetsAt: 1_787_000_000,
        },
        secondary: {
          usedPercent: 42,
          windowDurationMins: 10_080,
          resetsAt: 1_787_400_000,
        },
        planType: "plus",
        credits: { hasCredits: true, unlimited: false, balance: "12.5" },
        rateLimitReachedType: "rate_limit_reached",
      },
    },
  });

  assert.deepEqual(snapshot, {
    limitId: "codex",
    primary: {
      usedPercent: 17,
      windowDurationMins: 300,
      resetsAt: 1_787_000_000,
    },
    secondary: {
      usedPercent: 42,
      windowDurationMins: 10_080,
      resetsAt: 1_787_400_000,
    },
    planType: "plus",
    credits: { hasCredits: true, unlimited: false, balance: "12.5" },
    rateLimitReachedType: "rate_limit_reached",
  });
});

test("partial and API-key account responses have no subscription snapshot", () => {
  assert.equal(
    normalizeCodexRateLimits({
      result: {
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300 },
          secondary: null,
        },
      },
    }),
    undefined,
  );
  assert.equal(
    normalizeCodexRateLimits({ result: { rateLimits: null } }),
    undefined,
  );
});

test("native status output returns a normalized live snapshot", () => {
  const snapshot = parseCodexStatusOutput(
    JSON.stringify({
      status: {
        usage: {
          five_hour: {
            remaining_percent: 91,
            resets_at: 1_787_000_000,
          },
          weekly: {
            remaining_percentage: "69%",
            window_minutes: 10_080,
            reset_at: 1_787_400_000,
          },
        },
        plan_type: "team",
        credits: { balance: 12.5 },
      },
    }),
  );

  assert.deepEqual(snapshot, {
    primary: {
      usedPercent: 9,
      windowDurationMins: 300,
      resetsAt: 1_787_000_000,
    },
    secondary: {
      usedPercent: 31,
      windowDurationMins: 10_080,
      resetsAt: 1_787_400_000,
    },
    planType: "team",
    credits: { balance: 12.5 },
    creditBalance: 12.5,
  });
  assert.equal(parseCodexStatusOutput("not json"), undefined);
  assert.equal(
    parseCodexStatusOutput(
      JSON.stringify({ five_hour: { remaining_percent: 90 } }),
    ),
    undefined,
  );
});

const successfulAppServer = String.raw`
let buffer = "";
let initialized = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.id === 0 && message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }) + "\n");
    } else if (message.method === "initialized") {
      initialized = true;
    } else if (message.id === 1 && message.method === "account/rateLimits/read" && initialized) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: 1787000000 },
            secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1787400000 },
            planType: "team"
          }
        }
      }) + "\n");
    }
  }
});
setInterval(() => {}, 1000);
`;

test("the stdio app-server handshake returns a normalized live snapshot", async () => {
  const snapshot = await readCodexAppServerSubscriptionUsage({
    command: process.execPath,
    args: ["-e", successfulAppServer],
    timeoutMs: 1_000,
  });

  assert.deepEqual(snapshot, {
    limitId: "codex",
    primary: {
      usedPercent: 9,
      windowDurationMins: 300,
      resetsAt: 1_787_000_000,
    },
    secondary: {
      usedPercent: 31,
      windowDurationMins: 10_080,
      resetsAt: 1_787_400_000,
    },
    planType: "team",
  });
});

test("startup failures, malformed output, and timeouts stay unavailable", async () => {
  const missing = await readCodexStatusSubscriptionUsage({
    command: `missing-codex-${process.pid}`,
    timeoutMs: 100,
  });
  assert.equal(missing, undefined);

  const malformed = await readCodexStatusSubscriptionUsage({
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("not json\\n"); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 1_000,
  });
  assert.equal(malformed, undefined);

  const rejected = await readCodexStatusSubscriptionUsage({
    command: process.execPath,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          rate_limits: {
            primary: { used_percent: 1 },
            secondary: { used_percent: 2 },
          },
        }),
      )}); process.exit(2);`,
    ],
    timeoutMs: 1_000,
  });
  assert.equal(rejected, undefined);

  const oversized = await readCodexStatusSubscriptionUsage({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("x".repeat(1048577));'],
    timeoutMs: 1_000,
  });
  assert.equal(oversized, undefined);

  const startedAt = Date.now();
  const timedOut = await readCodexStatusSubscriptionUsage({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000);"],
    timeoutMs: 30,
  });
  assert.equal(timedOut, undefined);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("status failures retain the app-server fallback", async () => {
  const snapshot = await readCodexSubscriptionUsage({
    command: process.execPath,
    statusArgs: ["-e", "process.exit(2);"],
    appServerArgs: ["-e", successfulAppServer],
    timeoutMs: 1_000,
  });

  assert.equal(snapshot?.primary.usedPercent, 9);
  assert.equal(snapshot?.secondary.usedPercent, 31);
  assert.equal(snapshot?.planType, "team");
});

test("a numeric credit balance is lifted out of the opaque credits object", () => {
  const snapshot = normalizeCodexRateLimits({
    result: {
      rate_limits: {
        primary: { used_percent: 8, window_duration_mins: 300 },
        secondary: { used_percent: 61, window_duration_mins: 10_080 },
        plan_type: "pro",
        credits: { has_credits: true, unlimited: false, balance: 42.5 },
      },
    },
  });

  assert.equal(snapshot?.creditBalance, 42.5);
  assert.equal(snapshot?.planType, "pro");
  // The whole object survives beside the lifted number, so a caller that
  // needs a field this file does not promise can still find it.
  assert.deepEqual(snapshot?.credits, {
    has_credits: true,
    unlimited: false,
    balance: 42.5,
  });
});

test("credits that carry no number are absent rather than a zero balance", () => {
  const noNumber = normalizeCodexRateLimits({
    result: {
      rateLimits: {
        primary: { usedPercent: 8, windowDurationMins: 300 },
        secondary: { usedPercent: 61, windowDurationMins: 10_080 },
        credits: { hasCredits: false, unlimited: true },
      },
    },
  });
  assert.equal(noNumber?.creditBalance, undefined);
  assert.ok(Object.hasOwn(noNumber ?? {}, "credits"));

  const noCredits = normalizeCodexRateLimits({
    result: {
      rateLimits: {
        primary: { usedPercent: 8, windowDurationMins: 300 },
        secondary: { usedPercent: 61, windowDurationMins: 10_080 },
      },
    },
  });
  assert.equal(noCredits?.creditBalance, undefined);
});
