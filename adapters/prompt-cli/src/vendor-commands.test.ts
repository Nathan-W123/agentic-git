import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_PROFILE,
  COPILOT_PROFILE,
  CURSOR_PROFILE,
  GEMINI_PROFILE,
  KIRO_PROFILE,
} from "./index.js";

/**
 * Each profile's default is the name the vendor's installer puts on PATH.
 *
 * Cursor's was `agent`, which is not a program anyone ships. Because the
 * default is only reached when no command is configured — and the desktop
 * only configures one for a CLI it found — the wrong name surfaced as
 * "spawn agent ENOENT" on exactly the machines where Cursor was working
 * fine, and read as a missing install rather than as a wrong name.
 */
test("every vendor profile defaults to the binary that vendor installs", () => {
  assert.equal(CLAUDE_PROFILE.defaultCommand, "claude");
  // `agent`, per Cursor's own docs, which verify with `agent --version`.
  // Pinned because this was briefly changed to `cursor-agent` on the strength
  // of an ENOENT that turned out to mean the CLI was simply not installed.
  assert.equal(CURSOR_PROFILE.defaultCommand, "agent");
  assert.equal(GEMINI_PROFILE.defaultCommand, "gemini");
  assert.equal(COPILOT_PROFILE.defaultCommand, "copilot");
  assert.equal(KIRO_PROFILE.defaultCommand, "kiro-cli");

  // Every default is a name its vendor actually installs. That is the whole
  // property worth pinning here — not whether a name looks generic, which is
  // the reasoning that produced the wrong answer for Cursor.
  for (const profile of [
    CLAUDE_PROFILE,
    CURSOR_PROFILE,
    GEMINI_PROFILE,
    COPILOT_PROFILE,
    KIRO_PROFILE,
  ]) {
    assert.ok((profile.defaultCommand ?? "").length > 0);
  }
});

/**
 * Cursor sends the prompt as argv, and that is load-bearing for Windows.
 *
 * A prompt contains quotes and newlines, and `process-runner` will not put
 * either on a cmd.exe command line. So a Cursor that resolved to a `.cmd`
 * shim could never run — which is a reason to keep this delivery mode
 * visible, not a reason to change it: it exists because a single prompt can
 * exceed Linux's per-argument limit.
 */
test("cursor delivers its prompt through arguments", () => {
  assert.equal(CURSOR_PROFILE.promptDelivery, "arguments");
});
