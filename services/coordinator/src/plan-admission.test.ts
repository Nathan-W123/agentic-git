import assert from "node:assert/strict";
import test from "node:test";

import {
  mergePlanScope,
  planAdmissionApproved,
  planAdmissionPartial,
  type AgentPlan,
  type ScopeChangeRequest,
} from "@coord/shared-types";

import {
  BLOCKED_ATTEMPTS_BEFORE_SEQUENCING,
  PlanAdmissionController,
  approvedSchemaResources,
  structuralConflict,
  type PlanAdmissionInput,
} from "./plan-admission.js";
import { ConflictDetector, relatedObjectives } from "./conflict-detector.js";

/**
 * Arbitration of a single plan against the work already running — the answer a
 * remote worker gets before it is allowed to edit anything.
 */

function plan(taskId: string, overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    taskId,
    objective: `objective for ${taskId}`,
    expectedFiles: ["src/value.ts"],
    expectedSymbols: ["value"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    ...overrides,
  };
}

/** Scores nothing, leaving ownership as the only judge. */
function silentDetector(): ConflictDetector {
  return new ConflictDetector({
    fileOverlapWeight: 0,
    symbolOverlapWeight: 0,
    dependencyImpactWeight: 0,
    apiOverlapWeight: 0,
    schemaOverlapWeight: 0,
    configurationOverlapWeight: 0,
    testOverlapWeight: 0,
    semanticConflictWeight: 0,
    thresholds: { concurrentMaximum: 20, notifyMaximum: 45, sequenceMaximum: 70 },
  });
}

function admit(
  candidate: AgentPlan,
  active: readonly AgentPlan[],
  controller = new PlanAdmissionController(),
  overrides: Partial<
    Pick<
      PlanAdmissionInput,
      | "partialAdmission"
      | "resourcesInFile"
      | "symbolRangesInFile"
      | "blockedAttempts"
    >
  > = {},
) {
  return controller.admit({
    plan: candidate,
    agentId: "agent-a",
    baseRevision: "a".repeat(40),
    baseVersion: 1,
    active: active.map((entry) => ({
      taskId: entry.taskId,
      agentId: "agent-b",
      plan: entry,
    })),
    ...overrides,
  });
}

/** `type:id` for every lease an admission handed out, sorted. */
function grantedResources(admission: {
  ownershipGrants: readonly { resourceType: string; resourceId: string }[];
}): string[] {
  return admission.ownershipGrants
    .map((lease) => `${lease.resourceType}:${lease.resourceId}`)
    .sort();
}

test("a plan with nothing running is approved and granted ownership", () => {
  const admission = admit(plan("task_a"), []);

  assert.equal(admission.status, "approved");
  assert.deepEqual(admission.blockedBy, []);
  assert.equal(admission.conflicts.length, 0);
  assert.equal(admission.baseRevision, "a".repeat(40));
  // Ownership is real: the file and the symbol are both claimed.
  assert.deepEqual(
    admission.ownershipGrants
      .map((lease) => `${lease.resourceType}:${lease.resourceId}`)
      .sort(),
    ["file:src/value.ts", "symbol:value"],
  );
  assert.equal(admission.ownershipGrants[0]?.taskId, "task_a");
  assert.equal(admission.retryAfterMs, undefined);
});

test("a plan overlapping executing work is sequenced behind it, not approved", () => {
  const admission = admit(plan("task_a"), [plan("task_b")]);

  assert.equal(admission.status, "sequenced");
  assert.deepEqual(admission.blockedBy, ["task_b"]);
  assert.equal(admission.ownershipGrants.length, 0);
  assert.ok((admission.retryAfterMs ?? 0) > 0);
  assert.ok(admission.conflicts.every(structuralConflict));
  assert.match(admission.explanation, /file_overlap/u);
});

test("disjoint plans run concurrently", () => {
  const admission = admit(
    plan("task_a", {
      expectedFiles: ["src/a.ts"],
      expectedSymbols: ["alpha"],
    }),
    [plan("task_b", { expectedFiles: ["src/b.ts"], expectedSymbols: ["beta"] })],
  );

  assert.equal(admission.status, "approved");
  assert.deepEqual(admission.blockedBy, []);
  assert.equal(admission.ownershipGrants.length, 2);
});

test("evidence past the sequencing threshold blocks rather than orders", () => {
  // Enough overlapping resources that ordering the two would only relocate
  // the collision; the detector reports "block" and admission refuses.
  const files = Array.from({ length: 6 }, (_, index) => `src/f${index}.ts`);
  const admission = admit(
    plan("task_a", { expectedFiles: files, expectedSymbols: [] }),
    [plan("task_b", { expectedFiles: files, expectedSymbols: [] })],
  );

  assert.equal(admission.status, "blocked");
  assert.deepEqual(admission.blockedBy, ["task_b"]);
  assert.equal(admission.ownershipGrants.length, 0);
});

test("a plan refused twice on the same collision is sequenced, not blocked again", () => {
  // The livelock this exists to break: "plan again with a narrower scope" is
  // advice a task that must change one contended function cannot take, so it
  // returns the same plan and is refused identically, forever, paying a
  // planning round each turn. Past the bound the answer becomes "wait".
  const files = Array.from({ length: 6 }, (_, index) => `src/f${index}.ts`);
  const candidate = plan("task_a", {
    expectedFiles: files,
    expectedSymbols: [],
  });
  const active = [plan("task_b", { expectedFiles: files, expectedSymbols: [] })];

  const first = admit(candidate, active, new PlanAdmissionController(), {
    blockedAttempts: 0,
  });
  assert.equal(first.status, "blocked");

  const escalated = admit(candidate, active, new PlanAdmissionController(), {
    blockedAttempts: BLOCKED_ATTEMPTS_BEFORE_SEQUENCING,
  });

  assert.equal(escalated.status, "sequenced");
  // Sequencing is a stricter promise than blocking, not a weaker one: the
  // task still gets nothing to run with, it is merely told to wait for a
  // named holder instead of to think again.
  assert.deepEqual(escalated.blockedBy, ["task_b"]);
  assert.equal(escalated.ownershipGrants.length, 0);
  assert.equal(planAdmissionApproved(escalated), false);
  assert.match(escalated.explanation, /narrowing has already been asked for/u);
  // The evidence that justified refusing is carried forward rather than
  // dropped, so escalating cannot launder a conflict out of the record.
  assert.equal(escalated.conflicts.length, first.conflicts.length);
  assert.ok(escalated.conflicts.every(structuralConflict));
});

test("escalation never turns a clean plan into a conflicted one", () => {
  // The bound is a liveness rule and must not manufacture contention: a plan
  // with nothing to collide against is approved no matter how many times some
  // earlier plan for this task was refused.
  const admission = admit(
    plan("task_a", { expectedFiles: ["src/a.ts"], expectedSymbols: ["a"] }),
    [plan("task_b", { expectedFiles: ["src/b.ts"], expectedSymbols: ["b"] })],
    new PlanAdmissionController(),
    { blockedAttempts: 99 },
  );

  assert.equal(planAdmissionApproved(admission), true);
  assert.deepEqual(admission.blockedBy, []);
});

test("ownership refuses an overlap that conflict scoring lets through", () => {
  // A file only one plan names cannot produce overlap evidence, so scoring is
  // silent. The enriched symbol both plans touch is what ownership catches —
  // which is why admission consults both rather than either alone.
  const admission = admit(
    plan("task_a", { expectedFiles: ["src/a.ts"] }),
    [plan("task_b", { expectedFiles: ["src/b.ts"] })],
    new PlanAdmissionController(silentDetector()),
  );

  assert.equal(admission.status, "sequenced");
  assert.deepEqual(admission.blockedBy, ["task_b"]);
  assert.match(admission.explanation, /Ownership is held by task_b/u);
});

test("shared-mode resources do not collide in ownership", () => {
  // Two plans on the same markdown file: conflict scoring still sequences
  // them, but ownership on its own does not, because prose is shared rather
  // than exclusive. Silencing the detector isolates that half.
  const admission = admit(
    plan("task_a", { expectedFiles: ["docs/guide.md"], expectedSymbols: [] }),
    [plan("task_b", { expectedFiles: ["docs/guide.md"], expectedSymbols: [] })],
    new PlanAdmissionController(silentDetector()),
  );

  assert.equal(admission.status, "approved");
  assert.deepEqual(admission.blockedBy, []);
  assert.equal(admission.ownershipGrants[0]?.mode, "shared");
});

test("advisory-only overlap approves with the evidence attached", () => {
  const admission = admit(
    plan("task_a", {
      objective: "enable feature flags",
      intent: "enable feature flags",
      expectedFiles: ["src/a.ts"],
      expectedSymbols: ["alpha"],
    }),
    [
      plan("task_b", {
        objective: "disable feature flags",
        intent: "disable feature flags",
        expectedFiles: ["src/b.ts"],
        expectedSymbols: ["beta"],
      }),
    ],
  );

  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(admission.blockedBy, []);
  assert.ok(admission.ownershipGrants.length > 0);
  assert.equal(admission.conflicts.length, 1);
  assert.equal(admission.conflicts[0]?.evidence[0]?.advisory, true);
  assert.match(admission.constraints[0] ?? "", /Advisory overlap with task_b/u);
});

test("a resubmitted plan is not sequenced behind its own earlier admission", () => {
  // The deferral loop resubmits the same plan repeatedly; matching task ids
  // must not read as a conflict with itself.
  const admission = admit(plan("task_a"), [plan("task_a")]);

  assert.equal(admission.status, "approved");
  assert.deepEqual(admission.blockedBy, []);
});

/**
 * Partial admission: a plan that collides on part of what it declared is
 * admitted on the rest instead of waiting for all of it.
 */

/** Five files, one of which an executing task is holding. */
function partiallyContested(): { candidate: AgentPlan; running: AgentPlan } {
  return {
    candidate: plan("task_a", {
      expectedFiles: [
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
        "src/d.ts",
        "src/shared.ts",
      ],
      expectedSymbols: ["alpha"],
    }),
    running: plan("task_b", {
      expectedFiles: ["src/shared.ts"],
      expectedSymbols: ["beta"],
    }),
  };
}

test("a plan colliding on one file is admitted on the four that are free", () => {
  const { candidate, running } = partiallyContested();
  const admission = admit(candidate, [running]);

  assert.equal(admission.status, "approved_with_constraints");
  assert.ok(planAdmissionApproved(admission));
  assert.ok(planAdmissionPartial(admission));
  // The four uncontested files are owned now, and so is the symbol that came
  // with them. The contested file is not.
  assert.deepEqual(grantedResources(admission), [
    "file:src/a.ts",
    "file:src/b.ts",
    "file:src/c.ts",
    "file:src/d.ts",
    "symbol:alpha",
  ]);
  assert.deepEqual(admission.deferredResources, [
    {
      resourceType: "file",
      resourceId: "src/shared.ts",
      heldBy: ["task_b"],
      reason: admission.deferredResources?.[0]?.reason ?? "",
    },
  ]);
  assert.match(
    admission.deferredResources?.[0]?.reason ?? "",
    /task_b/u,
  );
  // Nothing is blocking this holder — it is executing right now.
  assert.deepEqual(admission.blockedBy, []);
  assert.equal(admission.retryAfterMs, undefined);
});

test("a partial admission tells the agent exactly what to leave alone", () => {
  const { candidate, running } = partiallyContested();
  const admission = admit(candidate, [running]);

  assert.ok(
    admission.constraints.some((constraint) =>
      /Do not modify.*file:src\/shared\.ts/u.test(constraint),
    ),
    admission.constraints.join(" | "),
  );
  // The structural evidence that caused the deferral is still reported, so the
  // audit trail shows a conflict was found rather than an unqualified approval.
  assert.ok(admission.conflicts.some(structuralConflict));
});

test("all-or-nothing arbitration is what happens with partial admission off", () => {
  const { candidate, running } = partiallyContested();
  const admission = admit(candidate, [running], new PlanAdmissionController(), {
    partialAdmission: false,
  });

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.ownershipGrants.length, 0);
  assert.equal(admission.deferredResources, undefined);
  assert.deepEqual(admission.blockedBy, ["task_b"]);
});

test("a plan whose every file is contested is sequenced, not admitted empty", () => {
  // Nothing would be left to work on, so admitting would buy an agent run that
  // could only produce an empty changeset.
  const admission = admit(
    plan("task_a", { expectedFiles: ["src/shared.ts"], expectedSymbols: [] }),
    [plan("task_b", { expectedFiles: ["src/shared.ts"], expectedSymbols: [] })],
  );

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.ownershipGrants.length, 0);
});

test("a remainder that still collides is refused rather than half-granted", () => {
  // Both plans claim the symbol `common`, which lives somewhere neither plan
  // pinned down. Dropping the shared file does not release the symbol, so the
  // reduced plan fails the same arbitration and the whole plan waits.
  const admission = admit(
    plan("task_a", {
      expectedFiles: ["src/a.ts", "src/shared.ts"],
      expectedSymbols: ["common"],
    }),
    [
      plan("task_b", {
        expectedFiles: ["src/shared.ts"],
        expectedSymbols: ["common"],
      }),
    ],
  );

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.ownershipGrants.length, 0);
  assert.equal(admission.deferredResources, undefined);
});

test("a symbol is not deferred when nothing can say where it lives", () => {
  // Ownership holds the symbol, not any file the two plans share. With no
  // symbol positions supplied, a withheld symbol could not be held to, so the
  // plan waits instead of being admitted on a promise nobody can check.
  const admission = admit(
    plan("task_a", { expectedFiles: ["src/a.ts"], expectedSymbols: ["shared"] }),
    [plan("task_b", { expectedFiles: ["src/b.ts"], expectedSymbols: ["shared"] })],
    new PlanAdmissionController(silentDetector()),
  );

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.deferredResources, undefined);
});

test("a file held only in shared mode is not deferred", () => {
  // Prose is shared, so two plans on the same markdown file are not competing
  // for it. Conflict scoring still sequences them; the reduced plan proves the
  // file was never the problem by being granted in full.
  const admission = admit(
    plan("task_a", {
      expectedFiles: ["docs/guide.md", "src/a.ts"],
      expectedSymbols: [],
    }),
    [
      plan("task_b", {
        expectedFiles: ["docs/guide.md"],
        expectedSymbols: [],
      }),
    ],
  );

  // docs/guide.md is contested by conflict scoring even though ownership is
  // happy with it, so it is deferred and src/a.ts is granted.
  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(grantedResources(admission), ["file:src/a.ts"]);
  assert.deepEqual(
    admission.deferredResources?.map((resource) => resource.resourceId),
    ["docs/guide.md"],
  );
});

test("two executing holders of different files are both named", () => {
  const admission = admit(
    plan("task_a", {
      expectedFiles: ["src/a.ts", "src/x.ts", "src/y.ts"],
      expectedSymbols: [],
    }),
    [
      plan("task_b", { expectedFiles: ["src/x.ts"], expectedSymbols: [] }),
      plan("task_c", { expectedFiles: ["src/y.ts"], expectedSymbols: [] }),
    ],
  );

  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(grantedResources(admission), ["file:src/a.ts"]);
  assert.deepEqual(
    admission.deferredResources?.map((resource) => ({
      id: resource.resourceId,
      heldBy: resource.heldBy,
    })),
    [
      { id: "src/x.ts", heldBy: ["task_b"] },
      { id: "src/y.ts", heldBy: ["task_c"] },
    ],
  );
});

/**
 * Plans reaching admission are enriched, so a file drags its symbols into the
 * plan with it. Withholding the file has to withhold those too, or the reduced
 * plan asks for exactly what the other holder owns.
 */
const INDEX: Record<string, { resourceType: "symbol"; resourceId: string }[]> = {
  "src/a.ts": [{ resourceType: "symbol", resourceId: "alpha" }],
  "src/shared.ts": [
    { resourceType: "symbol", resourceId: "sharedFn" },
    // Also lives in src/a.ts, so it belongs to work that is being granted.
    { resourceType: "symbol", resourceId: "alpha" },
  ],
};

test("a withheld file takes the symbols only it accounts for", () => {
  const admission = admit(
    plan("task_a", {
      expectedFiles: ["src/a.ts", "src/shared.ts"],
      expectedSymbols: ["alpha", "sharedFn"],
    }),
    [
      plan("task_b", {
        expectedFiles: ["src/shared.ts"],
        expectedSymbols: ["sharedFn"],
      }),
    ],
    new PlanAdmissionController(),
    {
      resourcesInFile: (file: string) => INDEX[file] ?? [],
    },
  );

  assert.equal(admission.status, "approved_with_constraints");
  // `sharedFn` went with the file it came from. `alpha` did not: src/a.ts is
  // granted and the holder may still edit it there.
  assert.deepEqual(grantedResources(admission), [
    "file:src/a.ts",
    "symbol:alpha",
  ]);
  assert.deepEqual(
    admission.deferredResources?.map(
      (resource) => `${resource.resourceType}:${resource.resourceId}`,
    ),
    ["file:src/shared.ts", "symbol:sharedFn"],
  );
});

test("without the index the same plan waits, rather than over-claiming", () => {
  // No attribution means no way to tell `sharedFn` apart from `alpha`, so the
  // reduced plan still claims a symbol the other task owns and is refused.
  const admission = admit(
    plan("task_a", {
      expectedFiles: ["src/a.ts", "src/shared.ts"],
      expectedSymbols: ["alpha", "sharedFn"],
    }),
    [
      plan("task_b", {
        expectedFiles: ["src/shared.ts"],
        expectedSymbols: ["sharedFn"],
      }),
    ],
  );

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.ownershipGrants.length, 0);
});

test("a plan's own schemas are the approval for claiming them", () => {
  const withSchema = plan("task_a", { expectedSchemas: ["users"] });
  assert.ok(approvedSchemaResources(withSchema).has("schema\0users"));

  const admission = admit(withSchema, []);
  assert.equal(admission.status, "approved");
  assert.ok(
    admission.ownershipGrants.some(
      (lease) =>
        lease.resourceType === "schema" && lease.mode === "approval_required",
    ),
  );
});

/**
 * Withholding something finer than a file. Ownership could always name a
 * symbol; what was missing was any way to hold a result to one, so the plan
 * waited instead. With line positions the question has an answer.
 */

/** src/a.ts holds both symbols; only one of them is contested. */
const SYMBOL_RANGES: Record<string, { name: string; startLine: number; endLine: number }[]> = {
  "src/a.ts": [
    { name: "alpha", startLine: 1, endLine: 5 },
    { name: "shared", startLine: 10, endLine: 20 },
  ],
};

function contestedSymbolPlans(): { candidate: AgentPlan; running: AgentPlan } {
  return {
    // Nothing this plan declares is contested at the file level: task_b names
    // a different file. What collides is the symbol.
    candidate: plan("task_a", {
      expectedFiles: ["src/a.ts", "src/contested.ts"],
      expectedSymbols: ["alpha", "shared"],
    }),
    running: plan("task_b", {
      expectedFiles: ["src/contested.ts"],
      expectedSymbols: ["shared"],
    }),
  };
}

test("a symbol is withheld while the file holding it is granted", () => {
  const { candidate, running } = contestedSymbolPlans();
  const admission = admit(candidate, [running], new PlanAdmissionController(), {
    symbolRangesInFile: (file: string) => SYMBOL_RANGES[file] ?? [],
  });

  assert.equal(admission.status, "approved_with_constraints");
  // src/a.ts is granted even though a symbol inside it is not, and `alpha`
  // stays claimed because nobody else wants it.
  assert.deepEqual(grantedResources(admission), [
    "file:src/a.ts",
    "symbol:alpha",
  ]);
  assert.deepEqual(
    admission.deferredResources?.map(
      (resource) => `${resource.resourceType}:${resource.resourceId}`,
    ),
    ["file:src/contested.ts", "symbol:shared"],
  );
});

test("a withheld symbol says which lines it occupies in the granted file", () => {
  // The file is open in front of the agent and the forbidden part is not
  // marked. Naming the lines is what makes the instruction followable — and
  // it is the same range the enforcement pass divides the patch at, so what
  // the agent is told and what it is held to are the same claim.
  const { candidate, running } = contestedSymbolPlans();
  const admission = admit(candidate, [running], new PlanAdmissionController(), {
    symbolRangesInFile: (file: string) => SYMBOL_RANGES[file] ?? [],
  });

  const withheld = admission.deferredResources?.find(
    (resource) => resource.resourceType === "symbol",
  );
  assert.deepEqual(withheld?.locations, [
    { file: "src/a.ts", startLine: 10, endLine: 20 },
  ]);
  assert.ok(
    admission.constraints.some((entry) =>
      entry.includes("src/a.ts lines 10-20"),
    ),
    `constraints did not name the lines: ${admission.constraints.join(" | ")}`,
  );
  // A withheld *file* has no location: the whole file is the answer.
  const withheldFile = admission.deferredResources?.find(
    (resource) => resource.resourceType === "file",
  );
  assert.equal(withheldFile?.locations, undefined);
});

test("a symbol is not withheld when a granted file cannot be read", () => {
  // src/a.ts has no line positions, so "did this patch touch `shared`" has no
  // answer for it. Withholding the symbol would be an instruction with nothing
  // behind it, so the plan waits for the whole thing instead.
  const { candidate, running } = contestedSymbolPlans();
  const admission = admit(candidate, [running], new PlanAdmissionController(), {
    symbolRangesInFile: () => undefined,
  });

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.ownershipGrants.length, 0);
  assert.equal(admission.deferredResources, undefined);
});

test("a symbol is not withheld when the index has no range for it", () => {
  const { candidate, running } = contestedSymbolPlans();
  const admission = admit(candidate, [running], new PlanAdmissionController(), {
    // The file parsed, but the contested symbol is absent from its ranges.
    // Treating an empty range set as enforceable would make partial admission
    // fail open when the index is incomplete.
    symbolRangesInFile: () => [
      { name: "alpha", startLine: 1, endLine: 5 },
    ],
  });

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.ownershipGrants.length, 0);
  assert.equal(admission.deferredResources, undefined);
});

test("without any symbol positions at all the plan still waits", () => {
  const { candidate, running } = contestedSymbolPlans();
  const admission = admit(candidate, [running]);

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.deferredResources, undefined);
});

test("files are withheld before symbols, and only symbols still held follow", () => {
  // The contested file goes first. `shared` lives in it *and* in a granted
  // file, so dropping the file does not release it and it is withheld too.
  const admission = admit(
    plan("task_a", {
      expectedFiles: ["src/a.ts", "src/contested.ts"],
      expectedSymbols: ["alpha", "shared"],
    }),
    [
      plan("task_b", {
        expectedFiles: ["src/contested.ts"],
        expectedSymbols: ["shared"],
      }),
    ],
    new PlanAdmissionController(),
    {
      symbolRangesInFile: (file: string) => SYMBOL_RANGES[file] ?? [],
      resourcesInFile: (file: string) =>
        file === "src/contested.ts"
          ? [{ resourceType: "symbol" as const, resourceId: "shared" }]
          : [],
    },
  );

  // `shared` is attributed to the deferred file too, but it also lives in the
  // granted one, so it is not dropped as merely derived — it is withheld in
  // its own right, and the granted file keeps its patch checked against it.
  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(grantedResources(admission), [
    "file:src/a.ts",
    "symbol:alpha",
  ]);
  assert.ok(
    admission.deferredResources?.some(
      (resource) =>
        resource.resourceType === "symbol" && resource.resourceId === "shared",
    ),
  );
});

/** An ungrounded verification record: nothing the plan declares exists. */
function ungrounded(candidate: AgentPlan): AgentPlan {
  return {
    ...candidate,
    grounding: {
      confidence: "ungrounded",
      revision: "a".repeat(40),
      missingFiles: candidate.expectedFiles,
      unresolvedSymbols: candidate.expectedSymbols,
      fileReferents: [],
      symbolReferents: [],
      notes: ["nothing this plan declares exists in the repository"],
    },
  };
}

test("an unverifiable plan with nothing running is approved: it runs alone", () => {
  const admission = admit(
    ungrounded(plan("task_a", { expectedFiles: ["src/ghost.ts"] })),
    [],
  );

  assert.equal(admission.status, "approved");
});

test("an ungrounded plan splits along declared paths it does not share", () => {
  // Greenfield: nothing exists yet, so nothing grounds, and refusing every
  // split meant partial admission could never fire in an empty repository —
  // the phase when tasks overlap most. Paths need no index: "you name
  // report.py and nobody else does" is checkable on declarations alone.
  const admission = admit(
    ungrounded(
      plan("task_a", {
        objective: "generate weekly PDF invoices for accounting",
        expectedFiles: ["src/store.py", "src/report.py"],
        expectedSymbols: [],
      }),
    ),
    [
      plan("task_b", {
        objective: "cache session tokens in the key-value store",
        expectedFiles: ["src/store.py"],
        expectedSymbols: [],
      }),
    ],
  );

  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(
    (admission.deferredResources ?? []).map((entry) => entry.resourceId),
    ["src/store.py"],
  );
});

test("an ungrounded plan splits along declared paths even when the objectives are related", () => {
  // Two halves of one small tool, handed out separately: an ingest half and a
  // render half, sharing exactly one file. This is the shape somebody reaches
  // for to watch partial admission work, and it is the shape that did not.
  //
  // The split above passes only because those two objectives share no words.
  // Here they do — they are halves of the same tool, so of course they do —
  // and relatedness is a whole-plan judgement that narrowing the file set
  // cannot clear. Withdrawing the one contested file has to be enough: the
  // remaining paths are disjoint by declaration, and scope enforcement holds
  // the agent to them whether or not the objectives sound alike.
  const admission = admit(
    ungrounded(
      plan("task_render", {
        objective: "align terminal display width for the python data tool",
        expectedFiles: ["src/tool/render.py", "src/tool/shared.py"],
        expectedSymbols: [],
      }),
    ),
    [
      plan("task_ingest", {
        objective: "parse comma separated input rows for the python data tool",
        expectedFiles: ["src/tool/ingest.py", "src/tool/shared.py"],
        expectedSymbols: [],
      }),
    ],
  );

  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(
    (admission.deferredResources ?? []).map((entry) => entry.resourceId),
    ["src/tool/shared.py"],
  );
});

test("the split survives a shared word in two agent-written intents", () => {
  // The same shape as above with both halves unverifiable, which is what a
  // greenfield repository actually produces — nothing exists yet, so nothing
  // grounds on either side. And the text the gate reads is not the objective
  // here but `intent`, the field the planning schema requires of the agent:
  // the run this was written from shared "shared" and "helper" there, and one
  // shared word is the whole test.
  const candidate = ungrounded(
    plan("task_a", {
      objective: "Align terminal display width",
      intent: "Add aligned table rendering and a shared cell-padding helper",
      expectedFiles: ["src/tool/render.py", "src/tool/shared.py"],
      expectedSymbols: [],
    }),
  );
  const holder = ungrounded(
    plan("task_b", {
      objective: "Parse comma separated input rows",
      intent: "Add CSV row parsing and a shared key-normalisation helper",
      expectedFiles: ["src/tool/ingest.py", "src/tool/shared.py"],
      expectedSymbols: [],
    }),
  );
  // The precondition the test rests on: these two really are "related", so the
  // gate really does fire on the whole plan. Without this the test would pass
  // for the wrong reason the moment somebody changed the word list.
  assert.equal(relatedObjectives(candidate, holder), true);

  const admission = admit(candidate, [holder]);

  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(
    (admission.deferredResources ?? []).map((entry) => entry.resourceId),
    ["src/tool/shared.py"],
  );
  assert.deepEqual(admission.blockedBy, []);
  // The file overlap is still on the record. The gate returns before anything
  // is assessed, so without assessing the whole plan separately this would be
  // a partial admission with nothing saying what was partial about it.
  assert.equal(
    admission.conflicts.some((assessment) =>
      assessment.evidence.some(
        (entry) =>
          entry.kind === "file_overlap" &&
          entry.resources.includes("src/tool/shared.py"),
      ),
    ),
    true,
  );
});

test("a greenfield plan with nothing of its own to work on still waits", () => {
  // The exemption is for a plan that keeps something. One whose only declared
  // file is the contested one has no remainder to be granted, so the gate's
  // answer stands rather than being talked around.
  const admission = admit(
    ungrounded(
      plan("task_a", {
        objective: "Align terminal display width",
        intent: "Add aligned table rendering and a shared cell-padding helper",
        expectedFiles: ["src/tool/shared.py"],
        expectedSymbols: [],
      }),
    ),
    [
      ungrounded(
        plan("task_b", {
          objective: "Parse comma separated input rows",
          intent: "Add CSV row parsing and a shared key-normalisation helper",
          expectedFiles: ["src/tool/ingest.py", "src/tool/shared.py"],
          expectedSymbols: [],
        }),
      ),
    ],
  );

  assert.equal(admission.status, "sequenced");
  assert.deepEqual(admission.blockedBy, ["task_b"]);
  assert.equal(admission.deferredResources, undefined);
});

test("an unverifiable plan is sequenced behind executing work about the same objective", () => {
  const admission = admit(
    ungrounded(
      plan("task_a", {
        objective: "charge a checkout handling fee on orders",
        expectedFiles: ["src/ghost.ts"],
        expectedSymbols: ["ghostSymbol"],
      }),
    ),
    [
      plan("task_b", {
        objective: "waive checkout delivery charges on large orders",
        expectedFiles: ["src/other.ts"],
        expectedSymbols: [],
      }),
      plan("task_c", {
        objective: "round checkout totals for orders",
        expectedFiles: ["src/third.ts"],
        expectedSymbols: [],
      }),
    ],
  );

  assert.equal(admission.status, "sequenced");
  assert.deepEqual(admission.blockedBy, ["task_b", "task_c"]);
  assert.equal(admission.ownershipGrants.length, 0);
  assert.match(admission.explanation, /cannot be proven disjoint|found none/u);
  // No partial admission either: there is no trustworthy line to split along.
  assert.equal(admission.deferredResources, undefined);
});

test("an unverifiable plan about something else entirely keeps its concurrency", () => {
  // A task creating a new module declares only files that do not exist yet —
  // indistinguishable, statically, from a hallucinated plan. What separates
  // them is the objective, and scope enforcement holds the plan to its
  // declared files either way.
  const admission = admit(
    ungrounded(
      plan("task_a", {
        objective: "add a brand-new telemetry module",
        expectedFiles: ["src/telemetry.ts"],
        expectedSymbols: ["recordEvent"],
      }),
    ),
    [
      plan("task_b", {
        objective: "raise the configured widget limit",
        expectedFiles: ["src/other.ts"],
        expectedSymbols: [],
      }),
    ],
  );

  assert.equal(admission.status, "approved");
});

test("a verified plan is sequenced while unverifiable work on the same objective executes", () => {
  const admission = admit(
    plan("task_a", {
      objective: "adjust checkout pricing for orders",
      expectedFiles: ["src/other.ts"],
      expectedSymbols: [],
    }),
    [
      ungrounded(
        plan("task_b", {
          objective: "charge a checkout handling fee on orders",
          expectedFiles: ["src/ghost.ts"],
          expectedSymbols: ["ghostSymbol"],
        }),
      ),
    ],
  );

  assert.equal(admission.status, "sequenced");
  assert.deepEqual(admission.blockedBy, ["task_b"]);
  assert.match(admission.explanation, /could not be verified/u);
});

test("grounded referents sequence plans whose declared names never overlap", () => {
  const groundedTo = (
    candidate: AgentPlan,
    declared: string,
  ): AgentPlan => ({
    ...candidate,
    grounding: {
      confidence: "grounded",
      revision: "a".repeat(40),
      missingFiles: candidate.expectedFiles,
      unresolvedSymbols: [declared],
      fileReferents: [],
      symbolReferents: [
        { declared, resolved: "orderTotal", files: ["src/pricing/total.js"] },
      ],
      notes: [],
    },
  });
  const admission = admit(
    groundedTo(
      plan("task_a", {
        expectedFiles: ["src/checkout.js"],
        expectedSymbols: ["calculateTotal"],
      }),
      "calculateTotal",
    ),
    [
      groundedTo(
        plan("task_b", {
          expectedFiles: ["src/order.js"],
          expectedSymbols: ["computeOrderTotal"],
        }),
        "computeOrderTotal",
      ),
    ],
  );

  assert.equal(admission.status, "sequenced");
  assert.deepEqual(admission.blockedBy, ["task_b"]);
});

test("a grounded plan is partially admitted with only its misnamed piece withheld", () => {
  // The candidate hallucinated: src/checkout.js does not exist and grounding
  // mapped it (and calculateTotal) to the real total.js/orderTotal that the
  // executing task holds. Its second declared file is real and uncontested.
  // Minimal withholding means: defer the misnamed carrier and its symbol,
  // grant the free file — not refuse the whole plan, and not withhold the
  // free file too.
  const candidate: AgentPlan = {
    ...plan("task_a", {
      objective: "charge a checkout handling fee on orders",
      expectedFiles: ["src/checkout.js", "src/format/currency.js"],
      expectedSymbols: ["calculateTotal", "formatPrice"],
    }),
    grounding: {
      confidence: "grounded",
      revision: "a".repeat(40),
      missingFiles: ["src/checkout.js"],
      unresolvedSymbols: ["calculateTotal"],
      fileReferents: [
        { declared: "src/checkout.js", resolved: "src/pricing/total.js" },
      ],
      symbolReferents: [
        {
          declared: "calculateTotal",
          resolved: "orderTotal",
          files: ["src/pricing/total.js"],
        },
      ],
      notes: [],
    },
  };
  const holder = plan("task_b", {
    objective: "waive checkout delivery charges on orders",
    expectedFiles: ["src/pricing/total.js"],
    expectedSymbols: ["orderTotal"],
  });

  const admission = admit(candidate, [holder], new PlanAdmissionController(), {
    // Both granted-file range lookups succeed; neither declares the referent.
    symbolRangesInFile: (file) =>
      file === "src/format/currency.js"
        ? [{ name: "formatPrice", startLine: 1, endLine: 3 }]
        : [],
  });

  assert.equal(admission.status, "approved_with_constraints");
  const deferred = (admission.deferredResources ?? []).map(
    (resource) => `${resource.resourceType}:${resource.resourceId}`,
  );
  assert.deepEqual(deferred.sort(), [
    "file:src/checkout.js",
    "symbol:calculateTotal",
  ]);
  // The withholding names the real code it protects.
  assert.match(
    (admission.deferredResources ?? [])
      .map((resource) => resource.reason)
      .join(" "),
    /via grounded referent/u,
  );
});

/**
 * Withholding part of a file the candidate does *not* own.
 *
 * The finer withholding above only ever applied inside a file the plan was
 * being granted anyway. A file another task held was lost whole, on its path
 * alone, however little of it that task actually occupied. What changed is
 * that a holder's claim can now be narrower than a path — so the contest can
 * be over lines, and only the lines need be withheld.
 */

/** src/pricing/total.js at the base revision: two functions, well apart. */
const TOTAL_RANGES: Record<
  string,
  { name: string; startLine: number; endLine: number }[]
> = {
  "src/pricing/total.js": [
    { name: "orderTotal", startLine: 40, endLine: 80 },
    { name: "formatTotal", startLine: 100, endLine: 140 },
  ],
};

/**
 * A holder that reaches into total.js without ever naming it: it declared
 * `calcTotal`, which does not exist, and verification mapped that to
 * `orderTotal`, which lives there. Its claim on the file is those lines and
 * nothing else — which is the whole premise of granting the rest of it.
 */
function groundedHolder(): AgentPlan {
  return {
    ...plan("task_b", {
      objective: "correct rounding when an order is totalled",
      expectedFiles: ["src/audit/log.js"],
      expectedSymbols: ["calcTotal"],
    }),
    grounding: {
      confidence: "grounded",
      revision: "a".repeat(40),
      missingFiles: [],
      unresolvedSymbols: ["calcTotal"],
      fileReferents: [],
      symbolReferents: [
        {
          declared: "calcTotal",
          resolved: "orderTotal",
          files: ["src/pricing/total.js"],
        },
      ],
      notes: [],
    },
  };
}

/** The candidate wants the same file, for a part of it nobody is holding. */
function sharedFileCandidate(): AgentPlan {
  return plan("task_a", {
    objective: "render a currency prefix when a price is displayed",
    expectedFiles: ["src/pricing/total.js"],
    expectedSymbols: ["formatTotal"],
  });
}

/** The index every one of these reads the base revision through. */
function placed(): Partial<PlanAdmissionInput> {
  return { symbolRangesInFile: (file: string) => TOTAL_RANGES[file] ?? [] };
}

test("a contested file is granted apart from the lines its holder occupies", () => {
  const admission = admit(
    sharedFileCandidate(),
    [groundedHolder()],
    new PlanAdmissionController(),
    placed(),
  );

  assert.equal(admission.status, "approved_with_constraints");
  // The file itself is granted — the thing that could not happen before, when
  // a contested path was withheld whole.
  assert.deepEqual(grantedResources(admission), [
    "file:src/pricing/total.js",
    "symbol:formatTotal",
  ]);
  assert.deepEqual(
    admission.deferredResources?.map(
      (resource) => `${resource.resourceType}:${resource.resourceId}`,
    ),
    ["symbol:orderTotal"],
  );
});

test("the withheld part of a contested file is stated as lines", () => {
  const admission = admit(
    sharedFileCandidate(),
    [groundedHolder()],
    new PlanAdmissionController(),
    placed(),
  );

  // Enforcement divides the patch at exactly these lines, and the agent is
  // told the same ones, so what it is asked for and what it is held to match.
  assert.deepEqual(admission.deferredResources?.[0]?.locations, [
    { file: "src/pricing/total.js", startLine: 40, endLine: 80 },
  ]);
  assert.ok(
    admission.constraints.some((entry) =>
      entry.includes("src/pricing/total.js lines 40-80"),
    ),
    `constraints did not name the lines: ${admission.constraints.join(" | ")}`,
  );
  assert.deepEqual(admission.deferredResources?.[0]?.heldBy, ["task_b"]);
});

test("the granted lease on a shared file excludes the holder's lines", () => {
  const admission = admit(
    sharedFileCandidate(),
    [groundedHolder()],
    new PlanAdmissionController(),
    placed(),
  );

  // The lease is the durable half of the promise: a later admission arbitrates
  // against it, so it has to say what the decision said.
  const lease = admission.ownershipGrants.find(
    (entry) => entry.resourceType === "file",
  );
  assert.deepEqual(lease?.ranges, [
    { startLine: 1, endLine: 39 },
    { startLine: 81, endLine: Number.MAX_SAFE_INTEGER },
  ]);
});

/** A holder that simply named the file, as most plans do. */
function declaringHolder(
  symbols: readonly string[] = ["orderTotal"],
): AgentPlan {
  return plan("task_b", {
    expectedFiles: ["src/pricing/total.js"],
    expectedSymbols: [...symbols],
  });
}

test("a holder whose footprint cannot be read still takes the whole file", () => {
  // This test used to state a broader rule: a holder that named a file took
  // all of it whenever the candidate had anything else to be granted. That was
  // never a safety rule — `admitWithinFiles` has always read a holder's own
  // declarations as its footprint when every declared file was contested — it
  // was an accident of which stage happened to run, and it is the accident the
  // section at the end of this file removes. What survives is the part that
  // was doing the protecting: where the holder said nothing a line can be
  // drawn from, the file is its own, all of it.
  //
  // task_b named the file, named no function, and its objective says nothing
  // about the file's contents. There is no footprint to narrow to, so the
  // contested path is withheld whole and the candidate keeps only the file
  // nobody holds — the answer path-level withholding always gave.
  const admission = admit(
    plan("task_a", {
      objective: "render a currency prefix when a price is displayed",
      expectedFiles: ["src/pricing/total.js", "src/format/currency.js"],
      expectedSymbols: ["showPrice"],
    }),
    [
      plan("task_b", {
        objective: "general cleanup",
        expectedFiles: ["src/pricing/total.js"],
        expectedSymbols: [],
      }),
    ],
    new PlanAdmissionController(),
    placed(),
  );

  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(grantedResources(admission), [
    "file:src/format/currency.js",
    "symbol:showPrice",
  ]);
  assert.deepEqual(
    admission.deferredResources?.map(
      (resource) => `${resource.resourceType}:${resource.resourceId}`,
    ),
    ["file:src/pricing/total.js"],
  );
});

/**
 * Splitting a file both plans named.
 *
 * Withholding contested paths answers nothing when the candidate named
 * nothing else: the reduced plan is empty and the task waits, however far
 * apart the two are working. That is the ordinary shape of the collision —
 * two agents in different functions of one very long file — so it is the one
 * worth drawing the line inside rather than around.
 */

test("two plans working on different functions of one file both run", () => {
  const admission = admit(
    sharedFileCandidate(),
    [declaringHolder()],
    new PlanAdmissionController(),
    placed(),
  );

  assert.equal(admission.status, "approved_with_constraints");
  // The path is granted to both. What the candidate does not get is the forty
  // lines the holder's own function occupies.
  assert.deepEqual(grantedResources(admission), [
    "file:src/pricing/total.js",
    "symbol:formatTotal",
  ]);
  assert.deepEqual(
    admission.deferredResources?.map(
      (resource) => `${resource.resourceType}:${resource.resourceId}`,
    ),
    ["symbol:orderTotal"],
  );
  assert.deepEqual(admission.deferredResources?.[0]?.locations, [
    { file: "src/pricing/total.js", startLine: 40, endLine: 80 },
  ]);
  assert.deepEqual(admission.deferredResources?.[0]?.heldBy, ["task_b"]);
  // The lease is the durable half of it, and it says the same thing.
  const lease = admission.ownershipGrants.find(
    (entry) => entry.resourceType === "file",
  );
  assert.deepEqual(lease?.ranges, [
    { startLine: 1, endLine: 39 },
    { startLine: 81, endLine: Number.MAX_SAFE_INTEGER },
  ]);
});

test("a symbol the index cannot place withholds the room it could take", () => {
  // `roundingRule` is nowhere in the file task_b named, so task_b is about to
  // write it at a line nobody can predict. That used to end the matter — the
  // footprint was not known to be smaller than the file, so the candidate
  // waited — and it cost the commonest shape there is, an agent editing one
  // function while adding another beside it.
  //
  // Unpredictable is not unbounded. New code lands in the parts of a file
  // that are not already a declaration: above the first, between them, inside
  // a class between its members, after the last. Withholding those leaves the
  // bodies the holder did not name still grantable, and there is nowhere left
  // for `roundingRule` to appear that the candidate was given.
  const admission = admit(
    sharedFileCandidate(),
    [declaringHolder(["orderTotal", "roundingRule"])],
    new PlanAdmissionController(),
    placed(),
  );

  assert.equal(admission.status, "approved_with_constraints");
  const withheld = new Map(
    (admission.deferredResources ?? []).map((resource) => [
      resource.resourceId,
      (resource.locations ?? []).map(
        (location) => `${location.startLine}-${location.endLine}`,
      ),
    ]),
  );
  // The function it named, at the lines the index placed it at.
  assert.deepEqual(withheld.get("orderTotal"), ["40-80"]);
  // And the one it has not written yet, at every line that is not already
  // somebody's declaration: before `orderTotal`, between the two, and nothing
  // after `formatTotal`, which is the last line the index accounts for.
  assert.deepEqual(withheld.get("roundingRule"), ["1-39", "81-99"]);
  // `formatTotal` is what the candidate came for, and it is still its own.
  assert.equal(withheld.has("formatTotal"), false);
});

test("a holder that occupies every line the index placed keeps the file", () => {
  // The file is nothing but the holder's function, so "the rest of it" is the
  // space after the last line anyone can place. Granting that is permission to
  // append to a file whose every known line is somebody else's, which is the
  // illusory split the enriched symbol claim would otherwise produce.
  const admission = admit(
    sharedFileCandidate(),
    [declaringHolder()],
    new PlanAdmissionController(),
    {
      symbolRangesInFile: () => [
        { name: "orderTotal", startLine: 1, endLine: 80 },
      ],
    },
  );

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.deferredResources, undefined);
});

test("a file both plans named is not split when it cannot be read", () => {
  // No line positions, so "did this patch touch the holder's function" has no
  // answer, and a withholding the control plane cannot check is not one.
  const admission = admit(
    sharedFileCandidate(),
    [declaringHolder()],
    new PlanAdmissionController(),
    { symbolRangesInFile: () => undefined },
  );

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.deferredResources, undefined);
});

test("a holder whose lines cannot be placed takes the file whole", () => {
  // The index parses the file but has no range for `orderTotal`. Withholding
  // "the lines it occupies" would then withhold nothing, and the rest of the
  // file would be granted over the top of a task that is editing it.
  const admission = admit(
    sharedFileCandidate(),
    [groundedHolder()],
    new PlanAdmissionController(),
    {
      symbolRangesInFile: () => [
        { name: "formatTotal", startLine: 100, endLine: 140 },
      ],
    },
  );

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.deferredResources, undefined);
});

test("an unreadable file is contested whole, as it always was", () => {
  const admission = admit(
    sharedFileCandidate(),
    [groundedHolder()],
    new PlanAdmissionController(),
    { symbolRangesInFile: () => undefined },
  );

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.deferredResources, undefined);
});

test("two holders of different parts both keep their own lines", () => {
  const second: AgentPlan = {
    ...plan("task_c", {
      objective: "rename the total formatter",
      expectedFiles: ["src/report/summary.js"],
      expectedSymbols: ["renderTotal"],
    }),
    grounding: {
      confidence: "grounded",
      revision: "a".repeat(40),
      missingFiles: [],
      unresolvedSymbols: ["renderTotal"],
      fileReferents: [],
      symbolReferents: [
        {
          declared: "renderTotal",
          resolved: "formatTotal",
          files: ["src/pricing/total.js"],
        },
      ],
      notes: [],
    },
  };
  const admission = admit(
    plan("task_a", {
      objective: "add a discount line to the pricing module",
      expectedFiles: ["src/pricing/total.js"],
      expectedSymbols: ["applyDiscount"],
    }),
    [groundedHolder(), second],
    new PlanAdmissionController(),
    placed(),
  );

  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(
    admission.deferredResources?.map((resource) => resource.resourceId).sort(),
    ["formatTotal", "orderTotal"],
  );
  // What is left of the file is the gap between the two holders, plus the head
  // and the tail.
  const lease = admission.ownershipGrants.find(
    (entry) => entry.resourceType === "file",
  );
  assert.deepEqual(lease?.ranges, [
    { startLine: 1, endLine: 39 },
    { startLine: 81, endLine: 99 },
    { startLine: 141, endLine: Number.MAX_SAFE_INTEGER },
  ]);
});

test("a file reached only through a misnamed path is still lost whole", () => {
  // The candidate declared src/checkout.js, which does not exist. A division
  // holds back hunks of a patch on a path, and no patch will ever carry that
  // one, so there is nothing to enforce a partial grant against.
  const candidate: AgentPlan = {
    ...plan("task_a", {
      objective: "render a currency prefix when a price is displayed",
      expectedFiles: ["src/checkout.js"],
      expectedSymbols: ["formatTotal"],
    }),
    grounding: {
      confidence: "grounded",
      revision: "a".repeat(40),
      missingFiles: ["src/checkout.js"],
      unresolvedSymbols: [],
      fileReferents: [
        { declared: "src/checkout.js", resolved: "src/pricing/total.js" },
      ],
      symbolReferents: [],
      notes: [],
    },
  };
  const admission = admit(
    candidate,
    [groundedHolder()],
    new PlanAdmissionController(),
    placed(),
  );

  assert.equal(admission.status, "sequenced");
  assert.equal(admission.deferredResources, undefined);
});

test("a plan reaching only its own lines of a file runs beside the holder", () => {
  // Neither side named the path and neither reaches the other's code, so there
  // is no contest to resolve and nothing has to be withheld at all. On shared
  // paths alone this pair was sequenced.
  const admission = admit(
    {
      ...plan("task_a", {
        objective: "render a currency prefix when a price is displayed",
        expectedFiles: ["src/format/currency.js"],
        expectedSymbols: ["showPrice"],
      }),
      grounding: {
        confidence: "grounded",
        revision: "a".repeat(40),
        missingFiles: [],
        unresolvedSymbols: ["showPrice"],
        fileReferents: [],
        symbolReferents: [
          {
            declared: "showPrice",
            resolved: "formatTotal",
            files: ["src/pricing/total.js"],
          },
        ],
        notes: [],
      },
    },
    [groundedHolder()],
    new PlanAdmissionController(),
    placed(),
  );

  assert.equal(admission.status, "approved");
  assert.equal(admission.deferredResources, undefined);
});

test("a holder that named a file and no functions still shares it", () => {
  // The shape production actually produces, and the reason symbol-level
  // arbitration never fired on a real repository: agents name files reliably
  // and functions rarely, and a plan with no declarations occupies the whole
  // file by definition — so the whole file was the only thing anyone else
  // could be told about.
  //
  // Both of these named `total.js` and neither named a function. Their
  // objectives are about different halves of it.
  const holder: AgentPlan = plan("task_b", {
    objective: "round the order total before it is stored",
    expectedFiles: ["src/pricing/total.js"],
    expectedSymbols: [],
  });
  const admission = admit(
    plan("task_a", {
      objective: "format the total for display with a currency prefix",
      expectedFiles: ["src/pricing/total.js"],
      expectedSymbols: [],
    }),
    [holder],
    new PlanAdmissionController(),
    placed(),
  );

  assert.equal(admission.status, "approved_with_constraints");
  const withheld = (admission.deferredResources ?? []).map(
    (resource) => resource.resourceId,
  );
  // The holder's half, read out of its objective. `formatTotal` is what the
  // candidate came for and is not among them.
  assert.equal(withheld.includes("orderTotal"), true);
  assert.equal(withheld.includes("formatTotal"), false);
});

test("a holder whose objective matches nothing keeps the whole file", () => {
  // The guess only ever narrows a claim that would have been the entire file.
  // When it has nothing to say, the answer is the one that was already given.
  const admission = admit(
    sharedFileCandidate(),
    [
      plan("task_b", {
        objective: "general cleanup",
        expectedFiles: ["src/pricing/total.js"],
        expectedSymbols: [],
      }),
    ],
    new PlanAdmissionController(),
    placed(),
  );
  assert.equal(admission.status, "sequenced");
});

/**
 * Splitting a file when only *part* of what the plan named is contested.
 *
 * Everything above draws its line inside a file only where *every* file the
 * plan named is held — that is the one case where withholding paths answers
 * nothing, so it is the only case the finer reading was ever reached from. One
 * free file switched all of it off: the contested path went whole to its
 * holder, the free one to the candidate, and two agents working in different
 * functions of it were separated by a file boundary neither of them needed.
 *
 * Which is backwards. A plan that names one file is the corner; a plan that
 * names three and collides on one is the ordinary shape of the collision, so
 * the split was firing everywhere except where it was wanted. The holder is
 * read here exactly as it is read there — its own declarations, never its
 * watched ranges, never a claim — and a file whose holders cover every placed
 * line is put back to being lost whole rather than granted its tail.
 */

/** Names a contested file and a free one, and a function in each. */
function mixedCandidate(): AgentPlan {
  return plan("task_a", {
    objective: "render a currency prefix when a price is displayed",
    expectedFiles: ["src/pricing/total.js", "src/format/currency.js"],
    expectedSymbols: ["formatTotal", "showPrice"],
  });
}

test("a contested file is shared even when the plan has a free file to fall back on", () => {
  // The mixed case, and the one partial admission was reported never to fire
  // on. Before, task_a was handed currency.js and told to come back for
  // total.js later; the forty lines of it that task_b actually occupies were
  // costing it the other hundred.
  const admission = admit(
    mixedCandidate(),
    [declaringHolder()],
    new PlanAdmissionController(),
    placed(),
  );

  assert.equal(admission.status, "approved_with_constraints");
  // Both paths are granted. Only `orderTotal` — the function the holder
  // declared — is held back, and `formatTotal` is what the candidate came for.
  assert.deepEqual(grantedResources(admission), [
    "file:src/format/currency.js",
    "file:src/pricing/total.js",
    "symbol:formatTotal",
    "symbol:showPrice",
  ]);
  assert.deepEqual(
    admission.deferredResources?.map(
      (resource) => `${resource.resourceType}:${resource.resourceId}`,
    ),
    ["symbol:orderTotal"],
  );
  assert.deepEqual(admission.deferredResources?.[0]?.locations, [
    { file: "src/pricing/total.js", startLine: 40, endLine: 80 },
  ]);
  assert.deepEqual(admission.deferredResources?.[0]?.heldBy, ["task_b"]);
});

test("the lease on a shared file is the exact complement of what was withheld", () => {
  // The invariant, stated as directly as it can be stated from outside: not
  // one line is both granted to the candidate and withheld from it. The two
  // sides are computed from a single set of ranges — the lease is the
  // whole file minus the holder's lines, the withholding is the holder's
  // lines — so they cannot intersect whatever the split was derived from, and
  // this is what would notice if that stopped being true.
  const admission = admit(
    mixedCandidate(),
    [declaringHolder()],
    new PlanAdmissionController(),
    placed(),
  );

  const lease = admission.ownershipGrants.find(
    (entry) =>
      entry.resourceType === "file" && entry.resourceId === "src/pricing/total.js",
  );
  const withheld = (admission.deferredResources ?? [])
    .flatMap((resource) => resource.locations ?? [])
    .filter((location) => location.file === "src/pricing/total.js");
  assert.ok((lease?.ranges ?? []).length > 0, "the shared file was not leased");
  assert.ok(withheld.length > 0, "nothing was withheld to test against");
  for (const granted of lease?.ranges ?? []) {
    for (const held of withheld) {
      assert.ok(
        granted.endLine < held.startLine || granted.startLine > held.endLine,
        `granted ${granted.startLine}-${granted.endLine} overlaps withheld ` +
          `${held.startLine}-${held.endLine}`,
      );
    }
  }
  // And the two together account for every line the index knows about. The
  // grant stops at 140, the last line anything is placed at, rather than
  // running to Number.MAX_SAFE_INTEGER: past there is where a function gets
  // appended, the holder declared this file too, and an index built before
  // either of them ran cannot say which of them is going to use it. So it
  // goes to neither — withheld from the candidate, and not in the holder's
  // lease either.
  assert.deepEqual(lease?.ranges, [
    { startLine: 1, endLine: 39 },
    { startLine: 81, endLine: 140 },
  ]);
});

test("a holder that occupies every placed line of a shared file keeps it whole", () => {
  // The illusory split, in the mixed case. The file is nothing but the
  // holder's function, so what would be "granted" is the space after the last
  // line anyone can place — permission to append to a file whose every known
  // line is somebody else's. The file goes back to being lost whole, which is
  // what it is today, and the candidate still keeps the free one.
  const admission = admit(
    mixedCandidate(),
    [declaringHolder()],
    new PlanAdmissionController(),
    {
      symbolRangesInFile: (file: string) =>
        file === "src/pricing/total.js"
          ? [{ name: "orderTotal", startLine: 1, endLine: 80 }]
          : [],
    },
  );

  assert.equal(admission.status, "approved_with_constraints");
  // `formatTotal` keeps its lease: the candidate declared it in its own right
  // and nobody else wants it, so losing the file does not lose the symbol.
  assert.deepEqual(grantedResources(admission), [
    "file:src/format/currency.js",
    "symbol:formatTotal",
    "symbol:showPrice",
  ]);
  assert.deepEqual(
    admission.deferredResources?.map(
      (resource) => `${resource.resourceType}:${resource.resourceId}`,
    ),
    ["file:src/pricing/total.js"],
  );
});

test("a holder whose claim covers the path takes it whole however it planned", () => {
  // A claim says what a task is *allowed* to reach, not what it declared, so
  // it has no lines to withhold — and a frozen claim is added to a file's
  // holders by `contestedFiles` whether or not conflict scoring found
  // anything. Reading this holder's declarations as its footprint would hand
  // the candidate the rest of a file the coordinator has already frozen for
  // it.
  const admission = admit(
    mixedCandidate(),
    [
      {
        ...declaringHolder(),
        claim: {
          kind: "frozen" as const,
          directories: ["src/pricing/"],
          frozenAt: new Date().toISOString(),
        },
      },
    ],
    new PlanAdmissionController(),
    placed(),
  );

  assert.deepEqual(grantedResources(admission), [
    "file:src/format/currency.js",
    "symbol:formatTotal",
    "symbol:showPrice",
  ]);
  assert.ok(
    admission.deferredResources?.some(
      (resource) =>
        resource.resourceType === "file" &&
        resource.resourceId === "src/pricing/total.js",
    ),
  );
});

/** src/api/reply.js, whose declarations are named in ordinary English. */
const REPLY_RANGES: Record<
  string,
  { name: string; startLine: number; endLine: number }[]
> = {
  "src/api/reply.js": [
    { name: "responseCache", startLine: 10, endLine: 30 },
    { name: "listOrders", startLine: 60, endLine: 90 },
  ],
};

test("an objective made of ordinary words still locates the holder's function", () => {
  // Where the split lands rests on reading the holder's objective, and that
  // reading used to borrow the stop list `estimateScope` uses to pick *files*.
  // Words are dropped there for being spread evenly over a repository's paths
  // — "response", "update", "error", "result" — which is true of the
  // repository and false inside one file: with two declarations, one of them
  // `responseCache`, the word "response" says exactly which. Borrowed here, it
  // left "update the response builder" with nothing to match at all, and the
  // holder took all of reply.js.
  // Every file the candidate names is contested, which is what puts this
  // through `admitWithinFiles` — the one path that still reads a guessed
  // footprint. `partitionContested` does not: there the alternative to a guess
  // is the wait that shipped, and a guess that names the wrong declaration
  // hands away the one the holder is really in. Here the alternative is that
  // nobody runs at all, and the stop list is what decides whether the guess
  // finds anything to run on.
  const admission = admit(
    plan("task_a", {
      objective: "paginate the order list",
      expectedFiles: ["src/api/reply.js"],
      expectedSymbols: ["listOrders"],
    }),
    [
      plan("task_b", {
        objective: "update the response builder",
        expectedFiles: ["src/api/reply.js"],
        expectedSymbols: [],
      }),
    ],
    new PlanAdmissionController(),
    { symbolRangesInFile: (file: string) => REPLY_RANGES[file] ?? [] },
  );

  assert.equal(admission.status, "approved_with_constraints");
  assert.deepEqual(grantedResources(admission), [
    "file:src/api/reply.js",
    "symbol:listOrders",
  ]);
  // The holder's half, and only it: `listOrders` is what the candidate came
  // for and is never withheld.
  assert.deepEqual(
    admission.deferredResources?.map(
      (resource) => `${resource.resourceType}:${resource.resourceId}`,
    ),
    ["symbol:responseCache"],
  );
  // Its function, plus the room a task that declared nothing is likeliest of
  // all to write something new into: everything before `responseCache` and
  // the gap between the two declarations. `listOrders` and its body are not
  // among them.
  assert.deepEqual(admission.deferredResources?.[0]?.locations, [
    { file: "src/api/reply.js", startLine: 10, endLine: 30 },
    { file: "src/api/reply.js", startLine: 1, endLine: 9 },
    { file: "src/api/reply.js", startLine: 31, endLine: 59 },
  ]);
  const lease = admission.ownershipGrants.find(
    (entry) =>
      entry.resourceType === "file" && entry.resourceId === "src/api/reply.js",
  );
  assert.deepEqual(lease?.ranges, [
    { startLine: 60, endLine: Number.MAX_SAFE_INTEGER },
  ]);
});

test("an approved expansion cannot shrink a holder that named no symbols", () => {
  // Widening `declared.symbols` after a scope approval is right for a plan
  // that named functions — it stops the holder being read as the smaller plan
  // it arrived as. It is wrong for one that named none. Empty means the agent
  // took the file whole, so writing the approved symbol into an empty list
  // does not enlarge that claim, it replaces it: a holder of every line
  // becomes a holder of one function, and the rest of the file is handed to
  // whoever asked next. The expansion is recorded in `expectedSymbols`
  // regardless, so nothing is lost by leaving the empty list alone.
  const widened = mergePlanScope(
    plan("task_b", {
      expectedFiles: ["src/pricing/total.js"],
      expectedSymbols: [],
      declared: { symbols: [] },
    }),
    {
      id: "scope_1" as ScopeChangeRequest["id"],
      taskId: "task_b" as ScopeChangeRequest["taskId"],
      additionalFiles: [],
      additionalSymbols: ["auditNote"],
      additionalApis: [],
      additionalSchemas: [],
      additionalConfigKeys: [],
      additionalTests: [],
      additionalServices: [],
      reason: "the audit note belongs beside the total",
      occurredAt: new Date().toISOString(),
    },
  );
  assert.deepEqual(widened.declared?.symbols, []);

  const admission = admit(
    mixedCandidate(),
    [widened],
    new PlanAdmissionController(),
    placed(),
  );
  // Whole file to its holder, exactly as before the expansion.
  assert.equal(
    admission.ownershipGrants.find(
      (entry) => entry.resourceId === "src/pricing/total.js",
    ),
    undefined,
  );
});

/**
 * A file the index cannot read — a stylesheet, a Dockerfile, a markdown page —
 * used to withdraw within-file splitting for every file beside it. Two source
 * files that could have been divided were sequenced on a stylesheet's account,
 * and the stylesheet was not what anybody was arguing about.
 *
 * Measured on this repository's own history: of the agent-authored commits
 * touching more than one file, 56% carried at least one unreadable path
 * alongside readable ones, and `apps/web/public/styles.css` alone accounted
 * for 214 of them.
 */
const CHATS = "apps/web/public/screen-chats.js";
const SHEET = "apps/web/public/styles.css";
const SUITE = "apps/web/src/assets.test.ts";

/** `styles.css` is absent, exactly as the real index reports it. */
const MIXED_RANGES: Record<string, { name: string; startLine: number; endLine: number }[]> = {
  [CHATS]: [
    { name: "workspaceRail", startLine: 200, endLine: 400 },
    { name: "composerHtml", startLine: 1000, endLine: 1400 },
  ],
  [SUITE]: [
    { name: "railTest", startLine: 400, endLine: 700 },
    { name: "composerTest", startLine: 1, endLine: 300 },
  ],
};

function admitMixed(candidate: AgentPlan, holder: AgentPlan) {
  return admit(candidate, [holder], new PlanAdmissionController(), {
    partialAdmission: true,
    symbolRangesInFile: (file: string) => MIXED_RANGES[file],
  });
}

test("an unreadable file is withheld, not used to refuse the files beside it", () => {
  const admission = admitMixed(
    plan("task_a", {
      expectedFiles: [CHATS, SHEET, SUITE],
      expectedSymbols: ["composerHtml", "composerTest"],
    }),
    plan("task_b", {
      expectedFiles: [CHATS, SHEET, SUITE],
      expectedSymbols: ["workspaceRail", "railTest"],
    }),
  );

  assert.equal(
    admission.status,
    "approved_with_constraints",
    JSON.stringify(admission),
  );
  const files = admission.ownershipGrants
    .filter((lease) => lease.resourceType === "file")
    .map((lease) => lease.resourceId);
  // The two the index can read are shared; the one it cannot is left with its
  // holder, because a patch on it could not be checked against anything.
  assert.ok(files.includes(CHATS), JSON.stringify(files));
  assert.ok(files.includes(SUITE), JSON.stringify(files));
  assert.ok(
    !files.includes(SHEET),
    `the unreadable file must not be granted: ${JSON.stringify(files)}`,
  );
});

test("a plan of nothing but unreadable files still waits", () => {
  // Nothing here can be reasoned about, so there is no split to offer and the
  // previous answer — wait your turn — is the right one.
  const admission = admitMixed(
    plan("task_a", { expectedFiles: [SHEET], expectedSymbols: [] }),
    plan("task_b", { expectedFiles: [SHEET], expectedSymbols: [] }),
  );
  assert.notEqual(admission.status, "approved_with_constraints");
  assert.deepEqual(
    admission.ownershipGrants.filter((lease) => lease.resourceType === "file"),
    [],
  );
});
