import assert from "node:assert/strict";
import test from "node:test";

import {
  planAdmissionApproved,
  planAdmissionPartial,
  type AgentPlan,
} from "@coord/shared-types";

import {
  PlanAdmissionController,
  approvedSchemaResources,
  structuralConflict,
  type PlanAdmissionInput,
} from "./plan-admission.js";
import { ConflictDetector } from "./conflict-detector.js";

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
      "partialAdmission" | "resourcesInFile" | "symbolRangesInFile"
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
