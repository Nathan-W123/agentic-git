import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CALL_SIGNS,
  deriveCallSign,
  rankTouchedFiles,
  arbitrationFiles,
  arbitrationSymbols,
  assertAgentPlan,
  assertChangeSet,
  assertProjectPolicy,
  claimCoversPath,
  claimOccupiesPath,
  claimedDirectories,
  deferredFilePaths,
  isBlanketClaim,
  normalizeRepositoryPath,
  planAdmissionApproved,
  substituteGroundedNames,
  planAdmissionPartial,
  ANSWER_NOT_STATUS_DIRECTIVE,
  COORDINATOR_DIRECTIVES,
  DO_NOT_CODE_DIRECTIVE,
  FORCE_QUESTION_MARKER,
  KEEP_IT_SIMPLE_DIRECTIVE,
  planGroundingConfidence,
  projectBudgets,
  readsAsReportRequest,
  reducePlanScope,
  requestFromObjective,
  ROLE_CONTEXT_PREFIX,
  uniqueRepositoryPaths,
  withoutRoleContext,
  type AgentPlan,
  type PlanAdmission,
  boundCommandOutput,
  summariseGrants,
  type ResourceLease,
} from "./index.js";

test("normalizes and deduplicates repository paths", () => {
  assert.deepEqual(
    uniqueRepositoryPaths(["src\\index.ts", "src/index.ts", "./test/a.ts"]),
    ["src/index.ts", "test/a.ts"],
  );
});

test("rejects paths outside the repository", () => {
  assert.throws(() => normalizeRepositoryPath("../secret.txt"), /escapes/u);
  assert.throws(() => normalizeRepositoryPath("C:\\secret.txt"), /Invalid/u);
});

test("preserves whitespace that is part of a legal Git filename", () => {
  assert.equal(
    normalizeRepositoryPath(" src/filename .ts "),
    " src/filename .ts ",
  );
});

test("validates and normalizes an agent plan", () => {
  const plan: unknown = {
    taskId: "task_1",
    objective: "Change a file",
    expectedFiles: ["src\\index.ts"],
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };

  assertAgentPlan(plan);
  assert.deepEqual(plan.expectedFiles, ["src/index.ts"]);
});

test("rejects malformed validation commands in an agent plan", () => {
  assert.throws(() =>
    assertAgentPlan({
      taskId: "task_1",
      objective: "Change a file",
      expectedFiles: ["src/index.ts"],
      expectedSymbols: [],
      dependencies: [],
      commands: [{ executable: "node", args: "bad", label: "tests" }],
      externalAccess: [],
      riskLevel: "low",
    }),
  );
});

test("validates and normalizes a changeset received over the wire", () => {
  const changeSet: unknown = {
    id: " change_1 ",
    taskId: " task_1 ",
    baseVersion: 1,
    baseRevision: "abc123",
    patches: [
      {
        path: "src\\index.ts",
        status: "modified",
        patch: "diff --git a/src/index.ts b/src/index.ts\n",
      },
    ],
    commandsRun: [],
    tests: [],
    dependenciesChanged: [" dep ", "dep"],
    symbolsChanged: ["main"],
    riskAssessment: { level: "low", reasons: [" safe ", "safe"] },
    agentExplanation: "Updated the entry point",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  assertChangeSet(changeSet);
  assert.equal(changeSet.id, "change_1");
  assert.equal(changeSet.taskId, "task_1");
  assert.equal(changeSet.patches[0]?.path, "src/index.ts");
  assert.deepEqual(changeSet.dependenciesChanged, ["dep"]);
  assert.deepEqual(changeSet.riskAssessment.reasons, ["safe"]);
});

test("rejects malformed or escaping changesets", () => {
  const valid = {
    id: "change_1",
    taskId: "task_1",
    baseVersion: 1,
    baseRevision: "abc123",
    patches: [],
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "low", reasons: [] },
    agentExplanation: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  assert.throws(() =>
    assertChangeSet({
      ...valid,
      patches: [{ path: "../secret", status: "added", patch: "content" }],
    }),
  );
  assert.throws(() =>
    assertChangeSet({
      ...valid,
      tests: [{ name: "test", status: "unknown", durationMs: 0, output: "" }],
    }),
  );
});

test("project policy accepts budgets and rejects malformed ones", () => {
  const policy = {
    version: 1,
    budgets: { maxTaskRuntimeMs: 60_000, maxProjectRuntimeMsPerDay: 3_600_000 },
  };
  assertProjectPolicy(policy);
  assert.deepEqual(projectBudgets(policy as never), {
    maxTaskRuntimeMs: 60_000,
    maxProjectRuntimeMsPerDay: 3_600_000,
  });
  assert.deepEqual(projectBudgets(undefined), {});
  assert.deepEqual(projectBudgets({ version: 1 } as never), {});

  assert.throws(() =>
    assertProjectPolicy({ version: 1, budgets: { maxTaskRuntimeMs: 0 } }),
  );
  assert.throws(() =>
    assertProjectPolicy({ version: 1, budgets: { monthlyDollars: 5 } }),
  );
  assert.throws(() =>
    assertProjectPolicy({ version: 1, budgets: [] }),
  );
  // A corrupt policy must throw rather than read as "no budgets".
  assert.throws(() => projectBudgets({ version: 9 } as never));
});

test("reducing a plan's scope removes claims and nothing else", () => {
  const plan: AgentPlan = {
    taskId: "task_1",
    objective: "Widen the API",
    expectedFiles: ["src/a.ts", "src/shared.ts"],
    expectedSymbols: ["alpha"],
    expectedApis: ["GET /v1/a"],
    expectedTests: ["test/a.test.ts"],
    dependencies: ["src/shared.ts"],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };

  const reduced = reducePlanScope(plan, [
    { resourceType: "file", resourceId: "SRC/Shared.ts" },
    { resourceType: "api", resourceId: "GET /v1/a" },
  ]);

  assert.deepEqual(reduced.expectedFiles, ["src/a.ts"]);
  assert.deepEqual(reduced.expectedApis, []);
  // A dependency is something the plan reads, not something it claims, so
  // dropping the claim must not drop the dependency.
  assert.deepEqual(reduced.dependencies, ["src/shared.ts"]);
  // Identity and everything unrelated survive untouched: every check
  // downstream compares the objective to decide the plan is for this task.
  assert.equal(reduced.objective, plan.objective);
  assert.deepEqual(reduced.expectedSymbols, ["alpha"]);
  assert.deepEqual(reduced.expectedTests, ["test/a.test.ts"]);
  // The original is left alone.
  assert.equal(plan.expectedFiles.length, 2);
});

test("a partial admission is an approval, and says what it withheld", () => {
  const admission: PlanAdmission = {
    status: "approved_with_constraints",
    taskId: "task_1",
    planRevision: 1,
    baseRevision: "a".repeat(40),
    ownershipGrants: [],
    constraints: [],
    blockedBy: [],
    conflicts: [],
    explanation: "partial",
    decidedAt: new Date().toISOString(),
    deferredResources: [
      {
        resourceType: "file",
        resourceId: "src\\shared.ts",
        heldBy: ["task_2"],
        reason: "held by task_2",
      },
      {
        resourceType: "symbol",
        resourceId: "shared",
        heldBy: ["task_2"],
        reason: "held by task_2",
      },
    ],
  };

  assert.equal(planAdmissionApproved(admission), true);
  assert.equal(planAdmissionPartial(admission), true);
  // Deferred files come back in the form a changeset patch path takes.
  assert.deepEqual(deferredFilePaths(admission), ["src/shared.ts"]);

  const whole = { ...admission, deferredResources: [] };
  assert.equal(planAdmissionPartial(whole), false);
  assert.deepEqual(deferredFilePaths(whole), []);
  // A refusal is never partial, whatever it carries.
  assert.equal(
    planAdmissionPartial({ ...admission, status: "sequenced" }),
    false,
  );
});

test("arbitration views merge declared resources with grounded referents", () => {
  const plan: AgentPlan = {
    taskId: "task_1",
    objective: "Change pricing",
    expectedFiles: ["src/checkout.js"],
    expectedSymbols: ["calculateTotal"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    grounding: {
      confidence: "grounded",
      revision: "a".repeat(40),
      missingFiles: ["src/checkout.js"],
      unresolvedSymbols: ["calculateTotal"],
      fileReferents: [{ declared: "src/checkout.js", resolved: "src/order.js" }],
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

  assert.deepEqual(arbitrationFiles(plan), [
    "src/checkout.js",
    "src/order.js",
    "src/pricing/total.js",
  ]);
  assert.deepEqual(arbitrationSymbols(plan), ["calculateTotal", "orderTotal"]);
  assert.equal(planGroundingConfidence(plan), "grounded");
  // Legacy plans without a grounding record behave exactly as before.
  const { grounding: ignored, ...legacy } = plan;
  assert.deepEqual(arbitrationFiles(legacy), ["src/checkout.js"]);
  assert.equal(planGroundingConfidence(legacy), "verified");
});

test("reducing a plan's scope takes the withheld declaration's grounding with it", () => {
  const plan: AgentPlan = {
    taskId: "task_1",
    objective: "Change pricing",
    expectedFiles: ["src/checkout.js", "src/kept.js"],
    expectedSymbols: ["calculateTotal"],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    grounding: {
      confidence: "grounded",
      revision: "a".repeat(40),
      missingFiles: ["src/checkout.js"],
      unresolvedSymbols: ["calculateTotal"],
      fileReferents: [{ declared: "src/checkout.js", resolved: "src/order.js" }],
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

  const reduced = reducePlanScope(plan, [
    { resourceType: "file", resourceId: "src/checkout.js" },
    { resourceType: "symbol", resourceId: "calculateTotal" },
  ]);

  assert.deepEqual(reduced.expectedFiles, ["src/kept.js"]);
  assert.deepEqual(reduced.grounding?.missingFiles, []);
  assert.deepEqual(reduced.grounding?.fileReferents, []);
  assert.deepEqual(reduced.grounding?.symbolReferents, []);
  assert.deepEqual(arbitrationFiles(reduced), ["src/kept.js"]);
});

test("rejects a malformed grounding record on an agent plan", () => {
  assert.throws(() =>
    assertAgentPlan({
      taskId: "task_1",
      objective: "Change a file",
      expectedFiles: ["src/index.ts"],
      expectedSymbols: [],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "low",
      grounding: { confidence: "certain" },
    }),
  );
});

/**
 * Rewriting a plan to say what verification decided it meant.
 *
 * Arbitration already reasons over referents. This is the same mapping pointed
 * at the agent instead: the previous plan a replan is shown carries the real
 * names, not the invented ones it is being asked not to repeat.
 */

const HALLUCINATED: AgentPlan = {
  taskId: "task_1",
  objective: "Change pricing",
  expectedFiles: ["src/checkout.js", "src/pricing/total.js", "src/brand-new.js"],
  expectedSymbols: ["calculateTotal", "brandNewHelper"],
  dependencies: [],
  commands: [],
  externalAccess: [],
  riskLevel: "low",
  grounding: {
    confidence: "grounded",
    revision: "a".repeat(40),
    missingFiles: ["src/checkout.js", "src/brand-new.js"],
    unresolvedSymbols: ["calculateTotal", "brandNewHelper"],
    fileReferents: [
      { declared: "src/checkout.js", resolved: "src/order.js" },
    ],
    symbolReferents: [
      {
        declared: "calculateTotal",
        resolved: "orderTotal",
        files: ["src/pricing/total.js"],
      },
    ],
    notes: ["declared file src/checkout.js does not exist"],
  },
};

test("a resolvable misname is replaced by the name it really meant", () => {
  const view = substituteGroundedNames(HALLUCINATED);

  assert.ok(!view.plan.expectedFiles.includes("src/checkout.js"));
  assert.ok(view.plan.expectedFiles.includes("src/order.js"));
  assert.ok(!view.plan.expectedSymbols.includes("calculateTotal"));
  assert.ok(view.plan.expectedSymbols.includes("orderTotal"));
  // A declaration that already resolved is untouched.
  assert.ok(view.plan.expectedFiles.includes("src/pricing/total.js"));
});

test("a declaration that grounds to nothing is reported, not rewritten", () => {
  // A plan for a new module names files that do not exist yet. Correcting
  // those would be inventing a correction.
  const view = substituteGroundedNames(HALLUCINATED);

  assert.ok(view.plan.expectedFiles.includes("src/brand-new.js"));
  assert.ok(view.plan.expectedSymbols.includes("brandNewHelper"));
  assert.deepEqual(view.inventedFiles, ["src/brand-new.js"]);
  assert.deepEqual(view.inventedSymbols, ["brandNewHelper"]);
});

test("every substitution is reported with where the real code lives", () => {
  const view = substituteGroundedNames(HALLUCINATED);

  assert.deepEqual(view.substitutions, [
    {
      kind: "file",
      declared: "src/checkout.js",
      resolved: ["src/order.js"],
      files: [],
    },
    {
      kind: "symbol",
      declared: "calculateTotal",
      resolved: ["orderTotal"],
      files: ["src/pricing/total.js"],
    },
  ]);
});

test("the grounding record is dropped rather than carried forward", () => {
  // Its missingFiles list is a verbatim copy of exactly the names the agent
  // should not repeat, which is the last thing to put back in front of it.
  const view = substituteGroundedNames(HALLUCINATED);
  assert.equal(view.plan.grounding, undefined);
  assert.doesNotMatch(JSON.stringify(view.plan), /src\/checkout\.js/u);
});

test("an ambiguous misname keeps every candidate it could mean", () => {
  const view = substituteGroundedNames({
    ...HALLUCINATED,
    expectedFiles: ["order.js"],
    expectedSymbols: [],
    grounding: {
      ...HALLUCINATED.grounding!,
      missingFiles: ["order.js"],
      unresolvedSymbols: [],
      fileReferents: [
        { declared: "order.js", resolved: "src/order.js" },
        { declared: "order.js", resolved: "src/legacy/order.js" },
      ],
      symbolReferents: [],
    },
  });

  assert.deepEqual(view.plan.expectedFiles, [
    "src/legacy/order.js",
    "src/order.js",
  ]);
  assert.deepEqual(view.substitutions[0]?.resolved, [
    "src/order.js",
    "src/legacy/order.js",
  ]);
});

test("a plan with no grounding record is returned exactly as it came", () => {
  const { grounding: ignored, ...bare } = HALLUCINATED;
  void ignored;
  const view = substituteGroundedNames(bare);

  assert.equal(view.plan, bare);
  assert.deepEqual(view.substitutions, []);
  assert.deepEqual(view.inventedFiles, []);
});

test("running something and reporting the result is not a failed change", () => {
  // Asked to run, not to edit. The result is the output; an empty changeset is
  // what success looks like, and it was being recorded as a failure.
  for (const objective of [
    "run the test suite",
    "run the tests and tell me what fails",
    "execute the repository's tests",
    "verify the retry logic behaves",
    "reproduce the bug in the parser",
    "benchmark the hot path",
    "lint the codebase",
    "typecheck the project",
  ]) {
    assert.equal(readsAsReportRequest(objective), true, objective);
  }

  // The editing-verb veto still decides first, which is what lets the list
  // above be as permissive as it is. Asked to run *and* change, an empty
  // changeset is still the symptom of a sandbox refusing every write.
  for (const objective of [
    "run the tests and fix what fails",
    "run the formatter and commit the result",
    "lint the codebase and update the offending files",
  ]) {
    assert.equal(readsAsReportRequest(objective), false, objective);
  }

  // "List all files in this repo" was a report and "name all files in this
  // repo" was a failed task, which is not a distinction anybody typing either
  // sentence meant to draw. The formal words were there and the ordinary ones
  // were not.
  for (const objective of [
    "name all files in this repo",
    "show me all files",
    "tell me what this repository does",
    "enumerate the modules",
    "identify the entry points",
    "count the lines in the parser",
    "print the dependency tree",
  ]) {
    assert.equal(readsAsReportRequest(objective), true, objective);
  }

  // Still change requests: the added verbs must not swallow a task that names
  // an edit, or an empty changeset from a sandbox refusing every write would
  // be filed as a successful report.
  for (const objective of [
    "rename the helper to normalise_key",
    "add a name field to the user model",
    "show me the bug and then fix it",
  ]) {
    assert.equal(readsAsReportRequest(objective), false, objective);
  }
});

test("telling an agent not to change anything is not a request to change something", () => {
  // The plainest way to say a task is read-only names an editing verb to say
  // it, so the veto read "don't change anything" as a change request and
  // failed the task for changing nothing — which is exactly what that
  // sentence asked for.
  for (const objective of [
    "Look at this repository and describe what it is. Don't change anything.",
    "Describe the entry point. Do not edit any files.",
    "Summarise the architecture without changing anything",
    "Review the auth flow — never modify the code",
    "Explain what this service does, no need to change it",
  ]) {
    assert.equal(readsAsReportRequest(objective), true, objective);
  }

  // A real edit still reads as one. Negation only excuses the verb it negates,
  // so a request that forbids one change and asks for another is a change
  // request, and an empty changeset from it is still a failure.
  for (const objective of [
    "Don't change the schema, but fix the retry loop",
    "Without touching the tests, add a health endpoint",
  ]) {
    assert.equal(readsAsReportRequest(objective), false, objective);
  }
});

test("asking for the answer and nothing else is a report, whatever it asks about", () => {
  // Observed in a channel: `add` appears twice, both times inside the thing
  // being asked *about*, and the editing-verb veto reads an editing verb
  // anywhere in the sentence — so a question whose whole request was "just
  // answer this" ran as a change task, changed nothing, and came back as a
  // failure with the answer buried in the failure line.
  for (const objective of [
    "can you diagnose if this url means that everytime i add a photo to my " +
      "conversation, it adds the photo into the codebase and causes bloat? " +
      "just answer this question - https://example.test/a.png",
    "just tell me whether the migration removed the column",
    "answer this question: does the worker write into the repo?",
    "simply explain how the attachment route serves a file",
  ]) {
    assert.equal(readsAsReportRequest(objective), true, objective);
  }

  // The bypass is deliberately narrow: it wants the words "just answer",
  // "just tell me" and their kin, not any sentence with `answer` in it. An
  // ordinary imperative that happens to start with "just" is still work.
  for (const objective of [
    "look, just add the endpoint",
    "just fix the retry loop",
  ]) {
    assert.equal(readsAsReportRequest(objective), false, objective);
  }
});

test("the ordinary words for asking to be told something count as a report", () => {
  // The list began with the formal verbs — audit, analyse, diagnose — and
  // missed how people actually ask, so a plain "look at this and describe it"
  // was not recognised as a request to look.
  for (const objective of [
    "Look at this repository and tell me what language it is",
    "describe the entry point of this service",
    "review the changes on this branch",
    "investigate why the run is slow",
    "list the routes this app serves",
    "report on the state of the migration",
  ]) {
    assert.equal(readsAsReportRequest(objective), true, objective);
  }

  // `look` on its own is not enough: it is as often a filler word before an
  // instruction as it is a request to inspect something.
  assert.equal(readsAsReportRequest("look, just add the endpoint"), false);
});

test("a role preamble does not decide whether a request was a report", () => {
  // A channel dispatch prepends the agent's declared role to every objective
  // it submits. That sentence is the operator describing the agent, not
  // anybody asking for work — but the editing-verb veto read it anyway, so an
  // agent whose role happened to say "fixer" or "implementation" failed the
  // check on every task it was ever given, and every audit it ran came back
  // recorded as a failure.
  const roles = [
    "Codebase auditor and fixer",
    "Implementation engineer",
    "Reviewer who writes patches",
  ];
  for (const role of roles) {
    assert.equal(
      readsAsReportRequest(
        `${ROLE_CONTEXT_PREFIX} ${role}.\n\naudit the codebase`,
      ),
      true,
      role,
    );
  }

  // The veto still has to work on the request itself, which is the alarm
  // that catches a sandbox silently refusing every edit.
  assert.equal(
    readsAsReportRequest(
      `${ROLE_CONTEXT_PREFIX} Codebase auditor.\n\nfix the retry loop`,
    ),
    false,
  );

  // Every paragraph of the request is read, not just the first. Keeping only
  // the paragraph after the preamble would let "and fix what you find" hide
  // behind an opening "audit", and an empty changeset from a task that was
  // meant to write would pass for a report.
  assert.equal(
    readsAsReportRequest(
      `${ROLE_CONTEXT_PREFIX} Auditor.\n\naudit the codebase\n\n` +
        "and fix anything you find",
    ),
    false,
  );
  assert.equal(
    withoutRoleContext(
      `${ROLE_CONTEXT_PREFIX} Auditor.\n\nfirst para\n\nsecond para`,
    ),
    "first para\n\nsecond para",
  );

  // An objective with no preamble is untouched, and a preamble with no
  // request behind it is left alone rather than reduced to nothing.
  assert.equal(readsAsReportRequest("audit the codebase"), true);
  assert.equal(withoutRoleContext("audit the codebase"), "audit the codebase");
  assert.equal(
    withoutRoleContext(`${ROLE_CONTEXT_PREFIX} Auditor.`),
    `${ROLE_CONTEXT_PREFIX} Auditor.`,
  );
  assert.equal(
    withoutRoleContext(`${ROLE_CONTEXT_PREFIX} Auditor.\n\naudit the codebase`),
    "audit the codebase",
  );
});

test("a stored objective reads back as the request the person wrote", () => {
  // The gateway wraps a request front and back before it stores it: the role
  // preamble in front, and behind it whichever directives applied. Six places
  // read the result as if it were the request — some show it to people, some
  // compare it, and the adapters hand it to a model that has been asked for a
  // JSON plan. Everything the coordinator added has to come off first.
  const wrapped = [
    `${ROLE_CONTEXT_PREFIX} You are the implementation agent.`,
    "Add a retry to the checkout call",
    ANSWER_NOT_STATUS_DIRECTIVE,
    KEEP_IT_SIMPLE_DIRECTIVE,
  ].join("\n\n");
  assert.equal(
    requestFromObjective(wrapped),
    "Add a retry to the checkout call",
  );

  // Each directive on its own, so a new one added to the list is covered by
  // the list rather than by whichever combination this test happened to use.
  for (const directive of COORDINATOR_DIRECTIVES) {
    assert.equal(
      requestFromObjective(`Add a retry to the checkout call\n\n${directive}`),
      "Add a retry to the checkout call",
    );
  }

  // Every paragraph of the request survives, not just the first: a request
  // whose second paragraph says "and fix what you find" is still asking for
  // both halves.
  assert.equal(
    requestFromObjective(
      `${ROLE_CONTEXT_PREFIX} Auditor.\n\nfirst para\n\nsecond para\n\n` +
        ANSWER_NOT_STATUS_DIRECTIVE,
    ),
    "first para\n\nsecond para",
  );

  // Matched as whole paragraphs rather than by pattern, so a request that
  // happens to quote one of these sentences keeps its own words.
  const quoting = `Explain why we tell agents "${KEEP_IT_SIMPLE_DIRECTIVE}"`;
  assert.equal(requestFromObjective(quoting), quoting);

  // Never nothing: a bare directive with no request behind it is still the
  // only text a caller has to show.
  assert.equal(requestFromObjective(DO_NOT_CODE_DIRECTIVE), DO_NOT_CODE_DIRECTIVE);
  assert.equal(
    requestFromObjective(`${ROLE_CONTEXT_PREFIX} Auditor.`),
    `${ROLE_CONTEXT_PREFIX} Auditor.`,
  );

  // An objective that was never wrapped is untouched.
  assert.equal(
    requestFromObjective("audit the codebase"),
    "audit the codebase",
  );

  // The `/ask` marker is one of the directives, so it comes off with them —
  // but only as its own paragraph, which is how the gateway writes it. An
  // inline one is routing text the adapters take out themselves, on top of
  // this, because the exact-paragraph rule cannot see it.
  assert.equal(
    requestFromObjective(`Add an orchestrate command\n\n${FORCE_QUESTION_MARKER}`),
    "Add an orchestrate command",
  );
  assert.equal(
    requestFromObjective(`Add an orchestrate command ${FORCE_QUESTION_MARKER}`),
    `Add an orchestrate command ${FORCE_QUESTION_MARKER}`,
  );
});

test("a declared claim is read back as one, and a malformed one is refused", () => {
  // The claim a repository-wide holder is turned into once it has been asked
  // what the rest of its work needs. What it *keeps* holding whole is `held`
  // and nothing else — the files it was seen writing in and did not mention —
  // so the files it declared can be shared around its declarations.
  const plan: unknown = {
    taskId: "task_1",
    objective: "Change a file",
    expectedFiles: ["src/a.ts", "src/b.ts"],
    expectedSymbols: ["alpha"],
    declared: { symbols: ["alpha"] },
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    claim: {
      kind: "declared",
      declaredAt: "2026-01-01T00:00:00.000Z",
      held: ["src/b.ts"],
    },
  };
  assertAgentPlan(plan);

  assert.equal(isBlanketClaim(plan), false);
  assert.deepEqual(claimedDirectories(plan), []);
  // The line the whole mechanism rests on: a declared file is not occupied by
  // the claim, so arbitration reads the plan's words instead of exempting it.
  assert.equal(claimOccupiesPath(plan, "src/a.ts"), false);
  assert.equal(claimOccupiesPath(plan, "src/b.ts"), true);
  // And no directory latitude: a holder that has just said where it is going
  // does not need room arbitration cannot see.
  assert.equal(claimCoversPath(plan, "src/a.ts"), false);
  assert.equal(claimCoversPath(plan, "src/b.ts"), true);
  assert.equal(claimCoversPath(plan, "src/c.ts"), false);

  // Checked rather than trusted: a plan is read back out of storage, and these
  // paths decide which files another task is refused.
  assert.throws(() =>
    assertAgentPlan({
      ...(plan as unknown as Record<string, unknown>),
      claim: { kind: "declared", declaredAt: "2026-01-01T00:00:00.000Z" },
    }),
  );
  assert.throws(() =>
    assertAgentPlan({
      ...(plan as unknown as Record<string, unknown>),
      claim: { kind: "declared", held: ["src/b.ts"] },
    }),
  );
});

test("recent edits outrank frequent old ones", () => {
  // Frequency alone recommends the file every feature passes through, which is
  // the one nobody needs told. Recency alone recommends whatever landed last,
  // including a one-off. Each edit is worth a point decayed by its age, so the
  // two are weighed against each other rather than one winning outright.
  const now = Date.parse("2026-03-10T12:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;
  const ranked = rankTouchedFiles(
    [
      // Edited twice in the last day.
      { path: "src/checkout.js", at: new Date(now - day * 0.5).toISOString() },
      { path: "src/checkout.js", at: new Date(now - day * 1).toISOString() },
      // The barrel file: five edits, all a month old.
      ...Array.from({ length: 5 }, (_unused, index) => ({
        path: "src/index.js",
        at: new Date(now - day * (30 + index)).toISOString(),
      })),
    ],
    now,
  );

  assert.equal(ranked[0]?.path, "src/checkout.js");
  assert.equal(ranked[0]?.changes, 2);
  assert.ok(
    (ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0),
    "five stale edits outweighed two fresh ones",
  );
  // The count is still reported honestly even where it lost.
  assert.equal(ranked[1]?.changes, 5);
});

test("ranking the same sample twice gives the same order", () => {
  // Two files with identical evidence must not swap places between calls: this
  // list is read by an agent, and a hint that reorders itself is a hint that
  // cannot be trusted or tested.
  const now = Date.parse("2026-03-10T12:00:00.000Z");
  const at = new Date(now - 1000).toISOString();
  const sample = [
    { path: "src/b.js", at },
    { path: "src/a.js", at },
    { path: "src/c.js", at },
  ];

  assert.deepEqual(
    rankTouchedFiles(sample, now).map((file) => file.path),
    ["src/a.js", "src/b.js", "src/c.js"],
  );
  assert.deepEqual(
    rankTouchedFiles(sample, now).map((file) => file.path),
    rankTouchedFiles([...sample].reverse(), now).map((file) => file.path),
  );
});

test("a malformed timestamp is counted but never ranked first", () => {
  // The edit demonstrably happened; when it happened is unknown. Dropping it
  // loses evidence, trusting it lets one bad row outrank real work.
  const now = Date.parse("2026-03-10T12:00:00.000Z");
  const ranked = rankTouchedFiles(
    [
      { path: "src/broken.js", at: "not a date" },
      { path: "src/broken.js", at: "also not a date" },
      { path: "src/real.js", at: new Date(now - 60_000).toISOString() },
    ],
    now,
  );

  assert.equal(ranked[0]?.path, "src/real.js");
  assert.equal(ranked[1]?.path, "src/broken.js");
  assert.equal(ranked[1]?.changes, 2, "the unplaceable edits were dropped");
});

/**
 * The largest thing a task used to write, and nothing read it.
 *
 * `ownership_granted` carried the whole `ResourceLease[]`, which scales with
 * how many symbols plan enrichment pulled out of the declared files rather
 * than with the size of the change — so an eight-file plan wrote hundreds of
 * entries for a change that touched eight files. The grants that are actually
 * read back have three other durable homes; this copy had none.
 */
test("a grant summary keeps the files and counts the rest", () => {
  const lease = (resourceType: string, resourceId: string) =>
    ({
      leaseId: "lease_1",
      resourceType,
      resourceId,
      principalId: "agent_1",
      taskId: "task_1",
      mode: "observe",
      baseVersion: 1,
      expiresAt: "2026-01-01T00:00:00.000Z",
    }) as unknown as ResourceLease;

  const summary = summariseGrants([
    lease("file", "src/a.ts"),
    lease("file", "src/b.ts"),
    // The same file twice is one file, not two.
    lease("file", "src/a.ts"),
    ...Array.from({ length: 120 }, (_unused, index) =>
      lease("symbol", `src/a.ts#sym${String(index)}`),
    ),
  ]);

  assert.equal(summary.count, 123, "how many were granted is still on record");
  assert.deepEqual(summary.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(summary.symbols, 120, "counted, not listed");
});

test("a grant summary cannot itself become the unbounded field", () => {
  const summary = summariseGrants(
    Array.from(
      { length: 400 },
      (_unused, index) =>
        ({
          leaseId: "lease_1",
          resourceType: "file",
          resourceId: `src/file${String(index)}.ts`,
          principalId: "agent_1",
          taskId: "task_1",
          mode: "exclusive",
          baseVersion: 1,
          expiresAt: "2026-01-01T00:00:00.000Z",
        }) as unknown as ResourceLease,
    ),
  );
  assert.equal(summary.count, 400, "the true number survives the cap");
  assert.equal(summary.files.length, 50);
});

test("bounded output keeps the end, which is where a failure says why", () => {
  const text = `${"noise ".repeat(5_000)}Error: the actual reason`;
  const bounded = boundCommandOutput(text);
  assert.ok(bounded.length < text.length);
  assert.match(bounded, /Error: the actual reason$/u);
  assert.match(bounded, /earlier characters dropped/u);
  // Short output is left exactly alone.
  assert.equal(boundCommandOutput("fine"), "fine");
});

/**
 * An agent's name is how a person addresses it, so a name that changes is a
 * name that stops working. Both ends used to draw one at random and store it,
 * which made the name a property of the *storage* rather than of the agent —
 * and every way the storage could be lost was a way the name could change: a
 * disconnect (which clears the record), the reconnect after it, a control
 * plane restarted onto a filesystem that did not outlive the container.
 */
test("an agent's name is derived from its identity, so it cannot drift", () => {
  const first = deriveCallSign("user_nathan", "anthropic");
  assert.notEqual(first, undefined);
  // The property that matters, stated as the loop it replaces: asking again,
  // in another process, after the record is gone, gives the same answer.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(deriveCallSign("user_nathan", "anthropic"), first);
  }
  // Different agent, different name — the vendor is part of the identity, so
  // one person's two agents are two people in the room.
  assert.notEqual(deriveCallSign("user_nathan", "openai"), first);
  assert.notEqual(deriveCallSign("user_someone_else", "anthropic"), first);
});

test("a name already taken is resolved the same way every time", () => {
  const wanted = deriveCallSign("user_nathan", "anthropic") as string;
  const taken = new Set([wanted]);
  const second = deriveCallSign("user_nathan", "anthropic", taken);
  assert.notEqual(second, wanted);
  assert.equal(deriveCallSign("user_nathan", "anthropic", taken), second);
  // Case is not identity: a set holding "athena" still claims "Athena".
  assert.notEqual(
    deriveCallSign("user_nathan", "anthropic", new Set([wanted.toLowerCase()])),
    wanted,
  );
  // An exhausted pantheon is undefined rather than a collision, which is the
  // caller's cue to fall back to the vendor label.
  assert.equal(
    deriveCallSign("u", "p", new Set(AGENT_CALL_SIGNS)),
    undefined,
  );
});

/**
 * Order must not be identity. Walking the list made every deployment produce
 * Zeus, then Hera, then Poseidon — so the name said which account connected
 * first and nothing else.
 */
test("names spread across the whole list rather than clustering at its head", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 3_000; index += 1) {
    const name = deriveCallSign(`user_${String(index)}`, "anthropic");
    if (name !== undefined) {
      seen.add(name);
    }
  }
  assert.equal(seen.size, AGENT_CALL_SIGNS.length);
});

/**
 * Two agents in one room must not be named after the same god.
 *
 * The list carried the Roman counterparts beside the Greek — Jupiter beside
 * Zeus, Proserpina beside Persephone — which is twenty pairs of synonyms, and
 * it produced exactly the confusion it looks like it would: somebody
 * @mentioned Proserpina and read Persephone's reply as the wrong agent
 * answering.
 */
test("no two call signs are the same deity under two spellings", () => {
  const synonyms = [
    ["Zeus", "Jupiter"], ["Hera", "Juno"], ["Poseidon", "Neptune"],
    ["Demeter", "Ceres"], ["Athena", "Minerva"], ["Ares", "Mars"],
    ["Aphrodite", "Venus"], ["Hephaestus", "Vulcan"], ["Hermes", "Mercury"],
    ["Hestia", "Vesta"], ["Dionysus", "Bacchus"], ["Hades", "Pluto"],
    ["Persephone", "Proserpina"], ["Cronus", "Saturn"], ["Rhea", "Ops"],
    ["Helios", "Sol"], ["Selene", "Luna"], ["Eos", "Aurora"],
    ["Nike", "Victoria"], ["Tyche", "Fortuna"], ["Artemis", "Diana"],
  ];
  const names = new Set<string>(AGENT_CALL_SIGNS);
  const both = synonyms.filter(([greek, roman]) =>
    names.has(greek as string) && names.has(roman as string),
  );
  assert.deepEqual(both, [], "these pairs name one god twice");

  // And no plain duplicates either, in any casing.
  const lower = AGENT_CALL_SIGNS.map((name) => name.toLowerCase());
  assert.equal(new Set(lower).size, lower.length);
});
