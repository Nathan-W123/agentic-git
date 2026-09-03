import assert from "node:assert/strict";
import test from "node:test";

import {
  BundleTickets,
  EDITOR_PRESENCE_MS,
  EditorPresence,
} from "./editor-sessions.js";

test("presence is declared per vendor and lapses on its own", () => {
  const presence = new EditorPresence();
  const start = 1_000_000;
  presence.declare({ userId: "user-1", vendor: "claude", now: start });
  presence.declare({ userId: "user-1", vendor: "codex", now: start });
  presence.declare({ userId: "user-2", vendor: "cursor", now: start });

  const now = presence.owners(start);
  assert.deepEqual([...(now.get("user-1") ?? [])].sort(), ["claude", "codex"]);
  assert.deepEqual([...(now.get("user-2") ?? [])], ["cursor"]);

  // One second before the window closes it still counts; one after, nothing
  // does. The whole point of a declared window is that it ends without
  // anybody having to say so.
  assert.equal(presence.owners(start + EDITOR_PRESENCE_MS - 1).size, 2);
  assert.equal(presence.owners(start + EDITOR_PRESENCE_MS + 1).size, 0);
});

test("a later declaration extends the window rather than adding a second one", () => {
  const presence = new EditorPresence();
  presence.declare({ userId: "user-1", vendor: "claude", now: 0 });
  presence.declare({
    userId: "user-1",
    vendor: "claude",
    now: EDITOR_PRESENCE_MS - 1,
  });
  // Still one vendor, and still live well past where the first would have
  // ended. An editor that keeps working keeps its presence; it does not
  // accumulate entries for each call it makes.
  const live = presence.owners(EDITOR_PRESENCE_MS + 1);
  assert.deepEqual([...(live.get("user-1") ?? [])], ["claude"]);
});

test("withdrawing takes one vendor away and leaves the rest", () => {
  const presence = new EditorPresence();
  presence.declare({ userId: "user-1", vendor: "claude", now: 0 });
  presence.declare({ userId: "user-1", vendor: "codex", now: 0 });
  presence.withdraw("user-1", "claude");
  assert.deepEqual([...(presence.owners(1).get("user-1") ?? [])], ["codex"]);
});

test("a bundle ticket is spent by being used, and by waiting", () => {
  const tickets = new BundleTickets();
  const id = tickets.issue({ leaseId: "lease-1", userId: "user-1", now: 0 });
  assert.deepEqual(tickets.redeem(id, 1_000), {
    leaseId: "lease-1",
    userId: "user-1",
  });
  // The second attempt is the one that matters: the URL travels through a
  // model's transcript and somebody's shell history, so it has to stop
  // working the moment it has been used once.
  assert.equal(tickets.redeem(id, 1_001), undefined);

  const later = tickets.issue({ leaseId: "lease-2", userId: "user-1", now: 0 });
  assert.equal(tickets.redeem(later, 60 * 60 * 1000), undefined);
});

test("tickets are told apart, and an invented one is worth nothing", () => {
  const tickets = new BundleTickets();
  const first = tickets.issue({ leaseId: "lease-1", userId: "user-1", now: 0 });
  const second = tickets.issue({ leaseId: "lease-2", userId: "user-2", now: 0 });
  assert.notEqual(first, second);
  assert.equal(tickets.redeem("not-a-ticket", 0), undefined);
  assert.equal(tickets.redeem(second, 0)?.leaseId, "lease-2");
  // Spending one leaves the other alone.
  assert.equal(tickets.redeem(first, 0)?.leaseId, "lease-1");
});
