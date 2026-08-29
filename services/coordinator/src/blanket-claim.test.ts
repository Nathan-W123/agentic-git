import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgentPlan,
  claimCoversPath,
  claimOccupiesPath,
  isBlanketClaim,
  type AgentPlan,
  type ChangeSet,
  type TaskDefinition,
} from "@coord/shared-types";

import {
  blanketPlan,
  declaredPlanFromClaim,
  filesOutsideClaim,
  freezePlanFromWorkingChanges,
  frozenTouchedRanges,
  releaseFromBlanketClaim,
} from "./blanket-claim.js";
import { PlanAdmissionController } from "./plan-admission.js";
import {
  ScopeExpansionError,
  assertChangeSetWithinPlan,
} from "./scope-validator.js";

/**
 * A task alone in its repository is handed all of it without an agent ever
 * being asked what it intends to touch, and keeps that claim until somebody
 * else turns up. These cover the two moments that matter: the claim, and the
 * narrowing that ends it.
 */

const TASK: TaskDefinition = {
  id: "task_solo",
  objective: "rename the widget",
  agentId: "agent-a",
  validationCommands: [{ executable: "npm", args: ["test"], label: "test" }],
};

function changeSet(paths: readonly string[]): ChangeSet {
  return {
    id: "cs_1",
    taskId: TASK.id,
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    patches: paths.map((path) => ({
      path,
      status: "modified" as const,
      patch: "diff",
    })),
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function plan(taskId: string, files: string[]): AgentPlan {
  return {
    taskId,
    objective: `objective for ${taskId}`,
    expectedFiles: files,
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

test("a blanket claim is a real plan that names no files", () => {
  const claim = blanketPlan(TASK);

  // Everything downstream is handed an ordinary plan; only the marker says
  // the empty declarations mean "all of it" rather than "none of it".
  assertAgentPlan(claim);
  assert.equal(claim.taskId, TASK.id);
  assert.deepEqual(claim.expectedFiles, []);
  assert.deepEqual(claim.commands, TASK.validationCommands);
  assert.ok(isBlanketClaim(claim));
});

test("a blanket claim approves every file the agent writes", () => {
  const claim = blanketPlan(TASK);

  // The task that never planned must still settle: collection validates its
  // changeset against a plan that declared nothing, and that has to pass.
  assertChangeSetWithinPlan(claim, changeSet(["src/a.ts", "docs/b.md"]));
});

test("freezing derives the claim from what was touched, not from a guess", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
    { path: "src/render/shader.ts", status: "added" },
    { path: "README.md", status: "modified" },
  ]);

  assert.equal(frozen.claim?.kind, "frozen");
  assert.deepEqual(frozen.expectedFiles, [
    "README.md",
    "src/render/canvas.ts",
    "src/render/shader.ts",
  ]);
  // Directories, so a sweep frozen halfway through keeps moving inside the
  // directory it is working in — and the repository root is never a
  // directory, or the narrowing would give nothing back.
  assert.deepEqual(frozen.claim?.kind === "frozen" ? frozen.claim.directories : [], [
    "src/render/",
  ]);
  assert.ok(!isBlanketClaim(frozen));
});

test("a frozen claim covers the rest of its directories and nothing else", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);

  // The next file of the sweep, written a second after the freeze.
  assert.ok(claimCoversPath(frozen, "src/render/mesh.ts"));
  assertChangeSetWithinPlan(frozen, changeSet(["src/render/mesh.ts"]));
  // Somewhere else entirely is outside it, and stays outside it.
  assert.ok(!claimCoversPath(frozen, "src/audio/mixer.ts"));
  assert.throws(
    () => assertChangeSetWithinPlan(frozen, changeSet(["src/audio/mixer.ts"])),
    ScopeExpansionError,
  );
});

test("the two readings of a claim disagree, and are meant to", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);

  // The file it was seen working in is held under both readings.
  assert.ok(claimOccupiesPath(frozen, "src/render/canvas.ts"));
  assert.ok(claimCoversPath(frozen, "src/render/canvas.ts"));

  // Its neighbour is the case the two readings are for. The holder may write
  // it — that is what the directory is for — but it does not hold it, so a
  // second task asking for it is answered by conflict scoring rather than by
  // a directory prefix. Anything reading the wide one to decide who waits
  // reintroduces the lockout; anything reading the narrow one to decide what
  // the holder may write breaks the sweep it was frozen in the middle of.
  assert.ok(!claimOccupiesPath(frozen, "src/render/mesh.ts"));
  assert.ok(claimCoversPath(frozen, "src/render/mesh.ts"));

  // A claim nobody has narrowed yet is the one case with nothing finer to go
  // on, so both readings still give it the repository.
  assert.ok(claimOccupiesPath(blanketPlan(TASK), "src/render/mesh.ts"));
});

test("nothing is admitted while a repository-wide claim is held", () => {
  const controller = new PlanAdmissionController();
  const decided = controller.admit({
    plan: plan("task_second", ["docs/unrelated.md"]),
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [
      { taskId: TASK.id, agentId: "agent-a", plan: blanketPlan(TASK) },
    ],
  });

  // Refused outright rather than queued inside the decision: the answer comes
  // back with a retry, which is the caller's cue to come again later. Nothing
  // here waits on the holder.
  assert.equal(decided.status, "sequenced");
  assert.deepEqual(decided.blockedBy, [TASK.id]);
  assert.ok((decided.retryAfterMs ?? 0) > 0);
  assert.deepEqual(decided.ownershipGrants, []);
});

test("a frozen claim admits the arriving task to everything outside it", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);
  const controller = new PlanAdmissionController();
  const active = [{ taskId: TASK.id, agentId: "agent-a", plan: frozen }];

  const outside = controller.admit({
    plan: plan("task_second", ["src/audio/mixer.ts"]),
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active,
  });
  assert.equal(outside.status, "approved");

  // And to nothing the holder actually named. The neighbouring file it may
  // write but has not been given has its own test below.
  const inside = controller.admit({
    plan: plan("task_third", ["src/render/canvas.ts"]),
    agentId: "agent-c",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active,
  });
  assert.equal(inside.status, "sequenced");
  assert.deepEqual(inside.blockedBy, [TASK.id]);
});

test("a frozen claim does not hold the files beside the one it named", () => {
  // The directories a freeze carries are room for files the holder may still
  // create, not a hold over every file that already lives there. One task
  // touching one file of a directory must not queue everybody else behind the
  // rest of it.
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);
  const controller = new PlanAdmissionController();
  const decided = controller.admit({
    plan: plan("task_second", ["src/render/mesh.ts"]),
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [{ taskId: TASK.id, agentId: "agent-a", plan: frozen }],
  });

  assert.equal(decided.status, "approved");
  assert.deepEqual(decided.blockedBy, []);
  assert.deepEqual(
    decided.ownershipGrants
      .filter((grant) => grant.resourceType === "file")
      .map((grant) => grant.resourceId),
    ["src/render/mesh.ts"],
  );
  // The holder may still write there itself: what it is allowed to reach is
  // unchanged, and only arbitration reads the directories more narrowly.
  assertChangeSetWithinPlan(frozen, changeSet(["src/render/mesh.ts"]));
});

test("a frozen claim partially admits a plan with work outside its directories", () => {
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);
  const controller = new PlanAdmissionController();
  const decided = controller.admit({
    plan: plan("task_second", [
      "src/render/canvas.ts",
      "src/audio/mixer.ts",
    ]),
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [{ taskId: TASK.id, agentId: "agent-a", plan: frozen }],
  });

  assert.equal(decided.status, "approved_with_constraints");
  assert.deepEqual(decided.blockedBy, []);
  assert.deepEqual(
    decided.deferredResources?.map((resource) => resource.resourceId),
    ["src/render/canvas.ts"],
  );
  assert.deepEqual(
    decided.ownershipGrants
      .filter((grant) => grant.resourceType === "file")
      .map((grant) => grant.resourceId),
    ["src/audio/mixer.ts"],
  );

  // The file beside it is not deferred at all — there is nothing to reduce,
  // so the whole plan is granted.
  const beside = controller.admit({
    plan: plan("task_third", ["src/render/mesh.ts", "src/audio/mixer.ts"]),
    agentId: "agent-c",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [{ taskId: TASK.id, agentId: "agent-a", plan: frozen }],
  });
  assert.equal(beside.status, "approved");
});

/**
 * Where the index says three functions live in one file, for the tests below.
 * The middle one is what a frozen holder is caught working in.
 */
const PLACED = [
  { name: "renderChannel", startLine: 100, endLine: 200 },
  { name: "renameAgent", startLine: 300, endLine: 400 },
  { name: "agentIdentityFor", startLine: 500, endLine: 600 },
];
const BIG_FILE = "services/api-gateway/src/server.ts";

function askAgainstFrozen(frozen: AgentPlan): ReturnType<
  PlanAdmissionController["admit"]
> {
  return new PlanAdmissionController().admit({
    plan: {
      ...plan("task_waiter", [BIG_FILE]),
      expectedSymbols: ["renameAgent", "agentIdentityFor"],
    },
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [{ taskId: TASK.id, agentId: "agent-a", plan: frozen }],
    symbolRangesInFile: (file) => (file === BIG_FILE ? PLACED : undefined),
    resourcesInFile: (file) =>
      file === BIG_FILE
        ? PLACED.map((span) => ({
            resourceType: "symbol" as const,
            resourceId: span.name,
          }))
        : [],
  });
}

test("a freeze keeps the lines it was shown, and says nothing where it saw none", () => {
  const watched = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: BIG_FILE, status: "modified", ranges: [{ startLine: 120, endLine: 140 }] },
    // Observed as changed, but nowhere located inside — a created file has no
    // base to diff against.
    { path: "src/brand-new.ts", status: "added" },
  ]);

  assert.deepEqual(frozenTouchedRanges(watched, BIG_FILE), [
    { startLine: 120, endLine: 140 },
  ]);
  // The absence has to read as "anywhere in this file", never as "nowhere".
  assert.equal(frozenTouchedRanges(watched, "src/brand-new.ts"), undefined);

  const unwatched = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: BIG_FILE, status: "modified" },
  ]);
  assert.equal(unwatched.claim?.kind === "frozen" ? unwatched.claim.touched : "x", undefined);
  assert.equal(frozenTouchedRanges(unwatched, BIG_FILE), undefined);
});

test("a watched holder is not split around, however well it was watched", () => {
  // This asserted the opposite, and the opposite was the bug.
  //
  // Splitting a waiter around the function a holder had been *seen* in reads
  // presence as absence. A plan frozen from a worktree declares no symbols and
  // never will — nobody wrote it — so the lines it has produced so far bound
  // where it has been and say nothing about where it goes next. Granting the
  // rest of the file hands over every function it has not opened yet,
  // including the one it is about to, and nothing catches the overlap: the
  // file is already inside the claim so no scope request fires, and hunks
  // divide on old-side lines so both agents' edits apply cleanly over each
  // other.
  //
  // The evidence is also in the wrong coordinate system to be trusted even
  // about presence. A watched range is a new-side hunk number; the spans it
  // was matched against come from an index at the base revision. Insert lines
  // above a function and the edit is attributed to its neighbour — withholding
  // a function the holder is not in and granting the one it is.
  const decided = askAgainstFrozen(
    freezePlanFromWorkingChanges(blanketPlan(TASK), [
      { path: BIG_FILE, status: "modified", ranges: [{ startLine: 120, endLine: 140 }] },
    ]),
  );

  assert.equal(decided.status, "sequenced");
  assert.deepEqual(decided.blockedBy, [TASK.id]);
});

test("an edit that lands outside every symbol still takes the whole file", () => {
  // Imports, top-level statements, the space between functions. An edit no
  // name contains is an edit this cannot bound, and a claim narrower than the
  // truth hands another task lines the holder will overwrite.
  const decided = askAgainstFrozen(
    freezePlanFromWorkingChanges(blanketPlan(TASK), [
      { path: BIG_FILE, status: "modified", ranges: [{ startLine: 50, endLine: 55 }] },
    ]),
  );

  assert.equal(decided.status, "sequenced");
  assert.deepEqual(decided.blockedBy, [TASK.id]);
});

test("a freeze nobody watched behaves exactly as it did before", () => {
  const decided = askAgainstFrozen(
    freezePlanFromWorkingChanges(blanketPlan(TASK), [
      { path: BIG_FILE, status: "modified" },
    ]),
  );

  assert.equal(decided.status, "sequenced");
  assert.deepEqual(decided.blockedBy, [TASK.id]);
});

test("a waiter is not let into the rest of a file the holder is inside", () => {
  // The same inversion, from the waiter's side. It declared two symbols and
  // the holder was watched inside one of them; the old answer granted it the
  // other and the file with it. What that actually bought was two agents in
  // one file, one of which had never said where it was working.
  const decided = askAgainstFrozen(
    freezePlanFromWorkingChanges(blanketPlan(TASK), [
      { path: BIG_FILE, status: "modified", ranges: [{ startLine: 310, endLine: 320 }] },
    ]),
  );

  assert.equal(decided.status, "sequenced");
  assert.deepEqual(decided.blockedBy, [TASK.id]);
  // Nothing at all is granted in that file — not the symbol the holder was
  // never seen in, and not the file itself.
  assert.deepEqual(
    decided.ownershipGrants.filter(
      (grant) => grant.resourceId === BIG_FILE,
    ),
    [],
  );
});

test("a repository-wide holder can hand back a file it never named", () => {
  // The half of the mechanism that was missing. A blanket claim declares only
  // the lexical estimate its objective produced, while it holds every file in
  // the repository — so the release path, which resolves against declarations,
  // answered "nothing to release" for everything the estimator had not
  // guessed. The holder was being told somebody was queued behind it and
  // asked to hand files back, and refused when it tried.
  const claim = blanketPlan(TASK, undefined, ["src/estimated.ts"]);
  assert.equal(claimCoversPath(claim, "src/never-guessed.ts"), true);

  const after = releaseFromBlanketClaim(claim, ["src/never-guessed.ts"]);

  // Given back, and only that one.
  assert.equal(claimCoversPath(after, "src/never-guessed.ts"), false);
  assert.equal(claimOccupiesPath(after, "src/never-guessed.ts"), false);
  // The claim still covers the repository. This holder has not finished, and
  // narrowing it wholesale on the strength of one release would take away
  // everything it has not yet been seen in.
  assert.equal(claimCoversPath(after, "src/estimated.ts"), true);
  assert.equal(claimCoversPath(after, "src/anything-else.ts"), true);
  assert.ok(isBlanketClaim(after));
});

test("releases accumulate, and say nothing about a plan that was written", () => {
  const claim = blanketPlan(TASK, undefined, []);
  const once = releaseFromBlanketClaim(claim, ["src/a.ts"]);
  const twice = releaseFromBlanketClaim(once, ["src/b.ts", "src/a.ts"]);
  assert.deepEqual(
    (twice.claim as { released?: string[] }).released,
    ["src/a.ts", "src/b.ts"],
  );

  // A plan somebody wrote gives files back by having them removed from its
  // declarations, which is `reducePlanScope`'s job. Recording them here as
  // well would say the same thing twice in two vocabularies.
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK, undefined, []), [
    { path: "src/a.ts", status: "modified" },
  ]);
  assert.equal(releaseFromBlanketClaim(frozen, ["src/a.ts"]), frozen);
});

test("a released file survives being read back out of storage", () => {
  // The claim is persisted on the lease and parsed again by whichever process
  // picks it up, so these paths decide what another task may have.
  const released = releaseFromBlanketClaim(
    blanketPlan(TASK, undefined, []),
    ["src/a.ts"],
  );
  const roundTripped = JSON.parse(JSON.stringify(released)) as typeof released;
  assertAgentPlan(roundTripped);
  assert.equal(claimCoversPath(roundTripped, "src/a.ts"), false);

  // And a claim written before releases existed still parses, still covering
  // everything.
  const older = JSON.parse(
    JSON.stringify(blanketPlan(TASK, undefined, [])),
  ) as ReturnType<typeof blanketPlan>;
  assertAgentPlan(older);
  assert.equal(claimCoversPath(older, "src/a.ts"), true);
});

/**
 * What a blanket claim becomes when its holder is asked rather than watched.
 *
 * The freeze above is derived from behaviour alone: it never adds a symbol and
 * it keeps a claim over every file it names. Both of those independently stop
 * the arriving task being split into those files, which is why chunk admission
 * could never fire between the first and second task in a repository. These
 * cover the shape that replaces it and, above all, what it must never give
 * away.
 */

test("a declared plan carries the words a freeze could never produce", () => {
  const converted = declaredPlanFromClaim(
    blanketPlan(TASK),
    { files: ["src/render/canvas.ts"], symbols: ["drawFrame"] },
    [],
    "2026-01-01T00:00:00.000Z",
  );

  assert.notEqual(converted, undefined);
  assert.equal(isBlanketClaim(converted!), false);
  assert.equal(converted?.claim?.kind, "declared");
  assert.deepEqual(converted?.expectedFiles, ["src/render/canvas.ts"]);
  assert.deepEqual(converted?.expectedSymbols, ["drawFrame"]);
  // The plan's own words, which is what arbitration reads before enrichment
  // widens `expectedSymbols` to every symbol in every file it named.
  assert.deepEqual(converted?.declared?.symbols, ["drawFrame"]);
  // And the line the whole change rests on: the declared files are *not*
  // occupied by the claim, so they can be shared around those declarations.
  assert.equal(claimOccupiesPath(converted!, "src/render/canvas.ts"), false);
  // It is still a valid plan after a round trip through storage.
  assertAgentPlan(JSON.parse(JSON.stringify(converted)));
});

test("the footprint is the union of what was said and what was touched", () => {
  const converted = declaredPlanFromClaim(
    blanketPlan(TASK),
    { files: ["src/render/canvas.ts"], symbols: ["drawFrame"] },
    [{ path: "src/audio/mixer.ts" }],
  );

  // Never just the answer. A holder that has already written in a function it
  // forgets to mention must keep it, or its work is handed to somebody else
  // and silently overwritten.
  assert.deepEqual(converted?.expectedFiles, [
    "src/audio/mixer.ts",
    "src/render/canvas.ts",
  ]);
  assert.deepEqual(
    converted?.claim?.kind === "declared" ? converted.claim.held : [],
    ["src/audio/mixer.ts"],
  );
  // Held whole, because a line range read off a worktree is a new-side hunk
  // number and the spans it would be matched against are base-side positions.
  assert.equal(claimOccupiesPath(converted!, "src/audio/mixer.ts"), true);
  assert.equal(claimCoversPath(converted!, "src/audio/mixer.ts"), true);
  // And nothing beyond what it holds: a declared claim carries no directory
  // latitude, so it grants nothing the declarations do not already say.
  assert.equal(claimCoversPath(converted!, "src/audio/other.ts"), false);
});

test("an answer with no usable symbol is not a conversion", () => {
  // An ordinary plan with no symbols is refused by every splitting path
  // anyway, so converting would cost the holder its directory latitude and
  // buy the arrival nothing. The caller falls back to the freeze.
  assert.equal(
    declaredPlanFromClaim(
      blanketPlan(TASK),
      { files: ["src/render/canvas.ts"], symbols: [] },
      [],
    ),
    undefined,
  );
  assert.equal(
    declaredPlanFromClaim(blanketPlan(TASK), { files: [], symbols: ["x"] }, []),
    undefined,
  );
  // Absolute paths, escapes and directories are dropped in normalization; if
  // nothing survives there is no answer left to convert.
  assert.equal(
    declaredPlanFromClaim(
      blanketPlan(TASK),
      { files: ["/etc/passwd", "../escape.ts", "src/"], symbols: ["x"] },
      [],
    ),
    undefined,
  );
  // And a plan that is not a blanket claim is never converted at all.
  assert.equal(
    declaredPlanFromClaim(
      plan("task_x", ["src/a.ts"]),
      { files: ["src/a.ts"], symbols: ["x"] },
      [],
    ),
    undefined,
  );
});

test("a declared holder is split around its declarations, not queued behind them", () => {
  const converted = declaredPlanFromClaim(
    blanketPlan(TASK),
    { files: ["src/pricing/total.js"], symbols: ["orderTotal"] },
    [],
  );
  const decided = new PlanAdmissionController().admit({
    plan: {
      ...plan("task_second", ["src/pricing/total.js"]),
      expectedSymbols: ["formatTotal"],
    },
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [{ taskId: TASK.id, agentId: "agent-a", plan: converted! }],
    symbolRangesInFile: (file) =>
      file === "src/pricing/total.js"
        ? [
            { name: "orderTotal", startLine: 40, endLine: 80 },
            { name: "formatTotal", startLine: 100, endLine: 140 },
          ]
        : [],
  });

  // The thing that could not happen before: the arrival is admitted into the
  // holder's own file, with only the holder's declarations withheld.
  assert.equal(decided.status, "approved_with_constraints");
  assert.deepEqual(
    decided.deferredResources?.map((resource) => resource.resourceId),
    ["orderTotal"],
  );
  assert.deepEqual(decided.deferredResources?.[0]?.locations, [
    { file: "src/pricing/total.js", startLine: 40, endLine: 80 },
  ]);
});

test("a file a declared holder holds whole is still lost whole", () => {
  const converted = declaredPlanFromClaim(
    blanketPlan(TASK),
    { files: ["src/pricing/total.js"], symbols: ["orderTotal"] },
    [{ path: "src/audit/log.js" }],
  );
  const decided = new PlanAdmissionController().admit({
    plan: {
      ...plan("task_second", ["src/audit/log.js"]),
      expectedSymbols: ["writeEntry"],
    },
    agentId: "agent-b",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: [{ taskId: TASK.id, agentId: "agent-a", plan: converted! }],
    symbolRangesInFile: (file) =>
      file === "src/audit/log.js"
        ? [{ name: "writeEntry", startLine: 10, endLine: 20 }]
        : [],
  });

  // The holder was writing here and forgot to say so. A claim is the only
  // vocabulary that says "whole, regardless of declarations", and this is the
  // one thing the conversion must never trade away.
  assert.equal(decided.status, "sequenced");
  assert.deepEqual(decided.blockedBy, [TASK.id]);
});

test("a converted holder is still bound to the plan it declared", () => {
  const converted = declaredPlanFromClaim(
    blanketPlan(TASK),
    { files: ["src/render/canvas.ts"], symbols: ["drawFrame"] },
    [{ path: "src/audio/mixer.ts" }],
  );
  // Both halves of the footprint are writable, which is what the union is for.
  assertChangeSetWithinPlan(
    converted!,
    changeSet(["src/render/canvas.ts", "src/audio/mixer.ts"]),
  );
  // And a file it never named is an escape, arbitrated mid-run through the
  // widening path rather than written silently.
  assert.throws(
    () => assertChangeSetWithinPlan(converted!, changeSet(["src/new/file.ts"])),
    ScopeExpansionError,
  );
});

test("a converted holder writing where it said it would is not an escape", () => {
  // The trap in reading a declared claim the way a frozen one is read. It
  // occupies only the files it never named — that is what lets everything it
  // *did* name be shared — so "not in the claim" would call every declared
  // file an escape, sending the holder back through arbitration on every
  // collection against a candidate that has since been admitted into the
  // other half of the same file. Refused, and the holder failed for doing
  // exactly what it said it would do.
  const converted = declaredPlanFromClaim(
    blanketPlan(TASK),
    { files: ["src/render/canvas.ts"], symbols: ["drawFrame"] },
    [{ path: "src/audio/mixer.ts" }],
  );

  assert.deepEqual(
    filesOutsideClaim(converted!, [
      "src/render/canvas.ts",
      "src/audio/mixer.ts",
    ]),
    [],
  );
  // A file it never named is still arbitrated, which is the path that keeps a
  // mid-run creation from being written over somebody else's grant.
  assert.deepEqual(filesOutsideClaim(converted!, ["src/new/thing.ts"]), [
    "src/new/thing.ts",
  ]);
  // And a frozen claim answers exactly as it did before.
  const frozen = freezePlanFromWorkingChanges(blanketPlan(TASK), [
    { path: "src/render/canvas.ts", status: "modified" },
  ]);
  assert.deepEqual(filesOutsideClaim(frozen, ["src/render/canvas.ts"]), []);
  assert.deepEqual(filesOutsideClaim(frozen, ["src/render/mesh.ts"]), [
    "src/render/mesh.ts",
  ]);
});
