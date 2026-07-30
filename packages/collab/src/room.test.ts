import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CollabRoom,
  CollabRoomRegistry,
  colorForUser,
  roomKey,
  type RoomScope,
} from "./room.js";
import { CollabError, OperationBuilder } from "./text-operation.js";

const scope: RoomScope = {
  projectId: "proj",
  repositoryId: "repo",
  ownerUserId: "alice",
  path: "src/app.ts",
};

function room(content = "hello world"): CollabRoom {
  const created = new CollabRoom(scope, content);
  created.join({ participantId: "c1", userId: "alice", displayName: "Alice" });
  created.join({ participantId: "c2", userId: "bob", displayName: "Bob" });
  return created;
}

describe("room identity", () => {
  it("separates scopes that differ only in a path containing a separator", () => {
    // A space-joined key would collide these two.
    assert.notEqual(
      roomKey({ ...scope, path: "a b" }),
      roomKey({ ...scope, ownerUserId: "alice a", path: "b" }),
    );
  });

  it("gives a user the same colour every time", () => {
    assert.equal(colorForUser("alice"), colorForUser("alice"));
    assert.match(colorForUser("alice"), /^#[0-9a-f]{6}$/u);
  });
});

describe("participants", () => {
  it("marks the overlay owner", () => {
    const shared = room();
    assert.equal(shared.participant("c1")?.owner, true);
    assert.equal(shared.participant("c2")?.owner, false);
  });

  it("treats two tabs of one user as two carets", () => {
    const shared = room();
    shared.join({ participantId: "c3", userId: "alice", displayName: "Alice" });
    assert.equal(shared.size, 3);
    assert.equal(
      shared.participant("c3")?.color,
      shared.participant("c1")?.color,
    );
  });

  it("removes a participant on leave", () => {
    const shared = room();
    assert.ok(shared.leave("c2"));
    assert.equal(shared.size, 1);
    assert.ok(!shared.leave("c2"));
  });

  it("refuses an operation from someone who is not in the room", () => {
    const shared = room();
    assert.throws(
      () => shared.receive("ghost", 0, new OperationBuilder().retain(11).build()),
      (error: unknown) =>
        error instanceof CollabError && error.code === "unknown_participant",
    );
  });
});

describe("caret tracking", () => {
  it("carries another participant's caret across an edit", () => {
    const shared = room();
    shared.setSelection("c2", 0, { anchor: 6, head: 11 });
    shared.receive("c1", 0, new OperationBuilder().insert(">> ").retain(11).build());
    assert.deepEqual(shared.participant("c2")?.selection, { anchor: 9, head: 14 });
  });

  it("takes the sender's caret from the operation it sent", () => {
    const shared = room();
    shared.receive(
      "c1",
      0,
      new OperationBuilder().retain(11).insert("!").build(),
      { anchor: 12, head: 12 },
    );
    assert.deepEqual(shared.participant("c1")?.selection, { anchor: 12, head: 12 });
  });

  it("catches a caret up through edits the reporter had not seen", () => {
    const shared = room();
    shared.receive("c1", 0, new OperationBuilder().insert("xx").retain(11).build());
    // Bob reports against revision 0, before the two characters landed.
    const placed = shared.setSelection("c2", 0, { anchor: 0, head: 5 });
    assert.deepEqual(placed, { anchor: 2, head: 7 });
  });

  it("clamps a caret to the document", () => {
    const shared = room("abc");
    const placed = shared.setSelection("c2", 0, { anchor: 0, head: 99 });
    assert.deepEqual(placed, { anchor: 0, head: 3 });
  });

  it("declines a caret from outside the history window", () => {
    const shared = new CollabRoom(scope, "");
    shared.join({ participantId: "c1", userId: "alice", displayName: "Alice" });
    assert.equal(shared.setSelection("c1", 5, { anchor: 0, head: 0 }), undefined);
    assert.equal(shared.setSelection("nobody", 0, { anchor: 0, head: 0 }), undefined);
  });

  it("moves carets when the file changes underneath the session", () => {
    const shared = room("alpha beta");
    shared.setSelection("c2", 0, { anchor: 6, head: 10 });
    shared.replaceContent("XXalpha beta");
    assert.deepEqual(shared.participant("c2")?.selection, { anchor: 8, head: 12 });
  });
});

describe("dirty tracking", () => {
  it("is clean until an edit lands", () => {
    const shared = room();
    assert.equal(shared.dirty, false);
    const applied = shared.receive(
      "c1",
      0,
      new OperationBuilder().retain(11).insert("!").build(),
    );
    assert.equal(shared.dirty, true);
    shared.markSaved(applied.revision);
    assert.equal(shared.dirty, false);
  });

  it("treats content read back from disk as saved", () => {
    const shared = room();
    shared.receive("c1", 0, new OperationBuilder().retain(11).insert("!").build());
    assert.equal(shared.dirty, true);
    shared.replaceContent("something else entirely");
    assert.equal(shared.dirty, false);
  });

  it("stays dirty when an edit lands after the save was recorded", () => {
    const shared = room();
    const first = shared.receive(
      "c1",
      0,
      new OperationBuilder().retain(11).insert("!").build(),
    );
    shared.markSaved(first.revision);
    shared.receive("c2", first.revision, new OperationBuilder().retain(12).insert("?").build());
    assert.equal(shared.dirty, true);
  });
});

describe("in-flight agent work", () => {
  const activity = {
    taskId: "task_1",
    agentId: "codex",
    stage: "planned" as const,
    objective: "Rename the handler",
    occurredAt: "2026-07-30T00:00:00.000Z",
  };

  it("records a plan claiming the file", () => {
    const shared = room();
    assert.ok(shared.noteAgentActivity(activity));
    assert.equal(shared.agentActivity.length, 1);
  });

  it("ignores a repeat of the same stage", () => {
    const shared = room();
    shared.noteAgentActivity(activity);
    assert.ok(!shared.noteAgentActivity(activity));
  });

  it("promotes planned to changed but never back", () => {
    const shared = room();
    shared.noteAgentActivity(activity);
    assert.ok(shared.noteAgentActivity({ ...activity, stage: "changed" }));
    assert.equal(shared.agentActivity[0]?.stage, "changed");
    assert.ok(!shared.noteAgentActivity(activity));
    assert.equal(shared.agentActivity[0]?.stage, "changed");
  });

  it("forgets a task once it resolves", () => {
    const shared = room();
    shared.noteAgentActivity(activity);
    assert.ok(shared.clearAgentActivity("task_1"));
    assert.equal(shared.agentActivity.length, 0);
  });
});

describe("the room registry", () => {
  it("keys rooms by their full scope", () => {
    const registry = new CollabRoomRegistry();
    registry.create(scope, "a");
    assert.ok(registry.get(scope) !== undefined);
    // A different overlay owner is a different room over the same path.
    assert.equal(registry.get({ ...scope, ownerUserId: "bob" }), undefined);
    assert.equal(registry.size, 1);
  });

  it("drops a room on delete", () => {
    const registry = new CollabRoomRegistry();
    registry.create(scope, "a");
    registry.delete(scope);
    assert.equal(registry.size, 0);
    assert.deepEqual(registry.all(), []);
  });
});
