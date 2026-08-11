import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuditPrompt,
  buildInvestigationPrompt,
  findingsReferencedBy,
  isInvestigatorRole,
  parseFailureVerdict,
  fixObjectiveFor,
  formatAuditSummary,
  formatFinding,
  isAuditorRole,
  NO_FINDINGS_MARKER,
  parseAuditFindings,
  parseFindingReply,
  readsAsApproval,
  type AuditFinding,
} from "./auditor.js";

const FINDING: AuditFinding = {
  index: 1,
  severity: "high",
  title: "Inverted permission check lets viewers delete",
  detail:
    "The guard in deleteRepository tests `!canManage` where it should test " +
    "`canManage`, so anyone with view access can delete a repository.",
  files: ["services/api-gateway/src/server.ts"],
  selfFixable: false,
};

test("the reserved role is matched trimmed and case-insensitively", () => {
  assert.equal(isAuditorRole("auditor"), true);
  assert.equal(isAuditorRole("  Auditor "), true);
  assert.equal(isAuditorRole("AUDITOR"), true);
  assert.equal(isAuditorRole("auditor of things"), false);
  assert.equal(isAuditorRole(""), false);
  assert.equal(isAuditorRole(undefined), false);
});

test("the audit prompt carries the diff, the file list, and the format", () => {
  const prompt = buildAuditPrompt({
    repositoryId: "relay",
    fromRevision: "abcdef1234567890",
    toRevision: "1234567890abcdef",
    files: ["src/a.ts", "src/b.ts"],
    patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
    truncated: false,
  });
  assert.match(prompt, /relay/u);
  assert.match(prompt, /abcdef123456/u);
  assert.match(prompt, /- src\/a\.ts/u);
  assert.match(prompt, /\+const a = 2;/u);
  assert.match(prompt, /FINDING/u);
  assert.match(prompt, new RegExp(NO_FINDINGS_MARKER, "u"));
  // A clean audit has to be an acceptable answer, or the model invents work.
  assert.match(prompt, /clean audit is a useful audit/u);
  assert.doesNotMatch(prompt, /truncated because/u);
});

test("a truncated diff says so in the prompt", () => {
  const prompt = buildAuditPrompt({
    repositoryId: "relay",
    fromRevision: "a".repeat(40),
    toRevision: "b".repeat(40),
    files: ["src/a.ts"],
    patch: "@@ -1 +1 @@",
    truncated: true,
  });
  assert.match(prompt, /truncated because the change is large/u);
});

test("a clean audit parses to no findings, however the model says it", () => {
  assert.deepEqual(parseAuditFindings("NO FINDINGS"), []);
  assert.deepEqual(parseAuditFindings("  no findings  "), []);
  assert.deepEqual(parseAuditFindings("`NO FINDINGS`"), []);
  assert.deepEqual(parseAuditFindings("**NO FINDINGS.**"), []);
  assert.deepEqual(parseAuditFindings(""), []);
});

test("findings parse out of the requested block format", () => {
  const findings = parseAuditFindings(
    [
      "FINDING",
      "severity: high",
      "files: src/server.ts, src/auth.ts",
      "selffix: no",
      "title: Inverted permission check",
      "detail: The guard tests the negation of what it means.",
      "It lets a viewer delete a repository.",
      "END",
      "FINDING",
      "severity: low",
      "files: src/util.ts",
      "selffix: yes",
      "title: Off-by-one in the retry counter",
      "detail: Retries once more than configured.",
      "END",
    ].join("\n"),
  );
  assert.equal(findings.length, 2);
  const [first, second] = findings;
  assert.equal(first?.index, 1);
  assert.equal(first?.severity, "high");
  assert.equal(first?.title, "Inverted permission check");
  assert.deepEqual(first?.files, ["src/server.ts", "src/auth.ts"]);
  assert.equal(first?.selfFixable, false);
  // The detail runs past its own line and keeps going to the block end.
  assert.match(first?.detail ?? "", /viewer delete a repository/u);
  assert.equal(second?.index, 2);
  assert.equal(second?.severity, "low");
  assert.equal(second?.selfFixable, true);
});

test("a missing severity falls back rather than dropping the finding", () => {
  const [finding] = parseAuditFindings(
    ["FINDING", "title: Something is wrong", "detail: Here is why.", "END"].join(
      "\n",
    ),
  );
  assert.equal(finding?.severity, "medium");
  assert.deepEqual(finding?.files, []);
  assert.equal(finding?.selfFixable, false);
});

test("an unparseable non-empty reply is kept whole, never discarded", () => {
  // The failure this guards against is the one the auditor exists to catch:
  // every layer reporting success while the finding silently vanishes.
  const findings = parseAuditFindings(
    "I looked at the diff and the retry loop in worker.ts runs one time too many.",
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", /one time too many/u);
});

test("a finding survives the round trip through its thread reply", () => {
  const parsed = parseFindingReply(formatFinding(FINDING));
  assert.notEqual(parsed, undefined);
  assert.equal(parsed?.index, FINDING.index);
  assert.equal(parsed?.title, FINDING.title);
  assert.equal(parsed?.severity, FINDING.severity);
  assert.deepEqual(parsed?.files, FINDING.files);
  assert.equal(parsed?.detail, FINDING.detail);
  assert.equal(parsed?.selfFixable, false);
});

test("a self-fixable finding round-trips its offer, not its wording", () => {
  const parsed = parseFindingReply(
    formatFinding({ ...FINDING, selfFixable: true, files: [] }),
  );
  assert.equal(parsed?.selfFixable, true);
  assert.deepEqual(parsed?.files, []);
  // The offer is presentation and must not leak into the objective an agent
  // is later given.
  assert.doesNotMatch(parsed?.detail ?? "", /fix it myself/u);
});

test("ordinary thread replies are not findings", () => {
  assert.equal(parseFindingReply("yes, fix 1"), undefined);
  assert.equal(parseFindingReply("Taking finding 1 myself."), undefined);
  assert.equal(parseFindingReply(""), undefined);
});

test("approvals that the channel's task classifier misses are recognised", () => {
  // Every one of these returns false from `looksLikeTaskRequest`, which is
  // why this predicate exists at all.
  for (const reply of [
    "yes",
    "yes, do it",
    "do it",
    "go ahead",
    "ship it",
    "approved",
    "sounds good",
    "lgtm",
    "agreed",
    "sure",
    "ok",
    "+1",
    "please do",
  ]) {
    assert.equal(readsAsApproval(reply), true, reply);
  }
});

test("rejections and hedges are never approvals", () => {
  for (const reply of [
    "no",
    "nope",
    "don't",
    "do not fix that",
    "skip it",
    "ignore this one",
    "false positive",
    "leave it for now",
    // Both an approval word and a refusal: the safe reading wins, because
    // doing nothing is recoverable and spending an account is not.
    "yes, but not now",
    "ok, skip it",
  ]) {
    assert.equal(readsAsApproval(reply), false, reply);
  }
  assert.equal(readsAsApproval("   "), false);
});

test("a question in an auditor thread is not an approval", () => {
  assert.equal(readsAsApproval("what file is that in?"), false);
  assert.equal(readsAsApproval("why do you think that is wrong?"), false);
});

test("which findings an approval refers to", () => {
  const findings: AuditFinding[] = [
    { ...FINDING, index: 1 },
    { ...FINDING, index: 2 },
    { ...FINDING, index: 3 },
  ];
  assert.deepEqual(
    findingsReferencedBy("yes, fix 2", findings).map((f) => f.index),
    [2],
  );
  assert.deepEqual(
    findingsReferencedBy("approved #3", findings).map((f) => f.index),
    [3],
  );
  assert.deepEqual(
    findingsReferencedBy("do all of them", findings).map((f) => f.index),
    [1, 2, 3],
  );
  assert.deepEqual(
    findingsReferencedBy("yes to 1 and 3", findings).map((f) => f.index),
    [1, 3],
  );
  // Ambiguous against three findings: the caller asks rather than guessing.
  assert.deepEqual(findingsReferencedBy("yes, do it", findings), []);
  // Unambiguous against one, which is the common case.
  assert.deepEqual(
    findingsReferencedBy("yes, do it", [FINDING]).map((f) => f.index),
    [1],
  );
  // A number nobody offered refers to nothing.
  assert.deepEqual(findingsReferencedBy("fix 9", findings), []);
});

test("a version number in an approval is not a finding number", () => {
  const findings: AuditFinding[] = [
    { ...FINDING, index: 1 },
    { ...FINDING, index: 2 },
  ];
  assert.deepEqual(findingsReferencedBy("yes, do it in v1.2", findings), []);
});

test("the summary says what was audited and how to approve", () => {
  const summary = formatAuditSummary({
    findings: [FINDING, { ...FINDING, index: 2, severity: "low" }],
    fromRevision: "abcdef1234567890",
    toRevision: "1234567890abcdef",
    fileCount: 3,
    truncated: false,
  });
  assert.match(summary, /abcdef12/u);
  assert.match(summary, /3 files/u);
  assert.match(summary, /2 things/u);
  assert.match(summary, /highest high/u);
  assert.match(summary, /yes, fix 1/u);
});

test("the fix objective is self-contained, since another agent receives it", () => {
  const objective = fixObjectiveFor(FINDING);
  assert.match(objective, /Inverted permission check/u);
  assert.match(objective, /services\/api-gateway\/src\/server\.ts/u);
  assert.match(objective, /approved by/u);
  // It must not invite the receiving agent to tidy up while it is in there.
  assert.match(objective, /do not reformat, rename, or/u);
});

test("a verdict is read back, or refused rather than guessed", () => {
  const verdict = parseFailureVerdict(
    [
      "VERDICT",
      "class: flaky_gate",
      "retry: yes",
      "detail: The gate failed on a wall-clock assertion that passed on the",
      "previous two runs.",
      "END",
    ].join("\n"),
  );
  assert.equal(verdict?.failureClass, "flaky_gate");
  assert.equal(verdict?.retryWorthwhile, true);
  assert.match(verdict?.detail ?? "", /wall-clock/u);

  // Anything that is not a clear yes is a no. A retry spends somebody's
  // account, so an unreadable answer must not read as encouragement.
  for (const retry of ["maybe", "possibly, if the gate settles", "no", ""]) {
    assert.equal(
      parseFailureVerdict(
        `VERDICT\nclass: conflict\nretry: ${retry}\ndetail: two tasks want the same file\nEND`,
      )?.retryWorthwhile,
      false,
      retry,
    );
  }

  // An unclassifiable class is "unknown", not a crash and not a guess.
  assert.equal(
    parseFailureVerdict(
      "VERDICT\nclass: gremlins\nretry: no\ndetail: something odd\nEND",
    )?.failureClass,
    "unknown",
  );

  // A reply with no detail says nothing worth posting. Undefined rather than
  // an empty verdict: a thread with no extra line is honest, an invented
  // classification is not.
  for (const reply of ["", "I am not sure what happened", "VERDICT\nclass: conflict\nEND"]) {
    assert.equal(parseFailureVerdict(reply), undefined, reply);
  }
});

test("the investigation asks about the trail it was given", () => {
  const prompt = buildInvestigationPrompt({
    objective: "raise the retry ceiling",
    trail: [
      { type: "plan_received", detail: "files=2" },
      { type: "task_failed", detail: "status=validation_failed" },
    ],
    suspected: "flaky_gate",
    priorSimilar: 3,
  });
  assert.match(prompt, /raise the retry ceiling/u);
  assert.match(prompt, /plan_received/u);
  // The deterministic reading is offered rather than withheld, so the model
  // can agree cheaply and spend its attention on what a regex cannot read.
  assert.match(prompt, /"flaky_gate"/u);
  // A failure that keeps happening the same way is rarely this task's fault.
  assert.match(prompt, /3 other failure/u);

  // With nothing suspected and nothing prior, neither claim is invented.
  const bare = buildInvestigationPrompt({
    objective: "x",
    trail: [{ type: "task_failed", detail: "" }],
    suspected: undefined,
    priorSimilar: 0,
  });
  assert.doesNotMatch(bare, /An automatic check/u);
  assert.doesNotMatch(bare, /other failure/u);
});

test("investigator is a reserved role name, matched like auditor", () => {
  assert.equal(isInvestigatorRole("investigator"), true);
  assert.equal(isInvestigatorRole("  Investigator  "), true);
  assert.equal(isInvestigatorRole("investigations"), false);
  assert.equal(isInvestigatorRole(undefined), false);
  // The two reserved roles are distinct; holding one is not holding the other.
  assert.equal(isInvestigatorRole("auditor"), false);
});
