import assert from "node:assert/strict";
import test from "node:test";

import { formatCliError } from "./error-format.js";

test("formats every nested aggregate error cause", () => {
  const error = new AggregateError(
    [
      new Error("agent network unavailable"),
      new Error("session cleanup failed", {
        cause: new Error("process still running"),
      }),
    ],
    "planning failed",
  );

  const output = formatCliError(error);

  assert.match(output, /AggregateError: planning failed/u);
  assert.match(output, /Cause 1: Error: agent network unavailable/u);
  assert.match(output, /Cause 2: Error: session cleanup failed/u);
  assert.match(output, /Cause 1: Error: process still running/u);
});
