import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCodexRateLimits,
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
  const snapshot = await readCodexSubscriptionUsage({
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
  const missing = await readCodexSubscriptionUsage({
    command: `missing-codex-${process.pid}`,
    timeoutMs: 100,
  });
  assert.equal(missing, undefined);

  const malformed = await readCodexSubscriptionUsage({
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("not json\\n"); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 1_000,
  });
  assert.equal(malformed, undefined);

  const startedAt = Date.now();
  const timedOut = await readCodexSubscriptionUsage({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000);"],
    timeoutMs: 30,
  });
  assert.equal(timedOut, undefined);
  assert.ok(Date.now() - startedAt < 1_000);
});
