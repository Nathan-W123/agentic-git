# Coordination Architecture

## Intake

Everything below this section handles conflict once a task exists. Intake is
the one stage that can decline to create it. Before a task is queued, its
footprint is estimated from the objective text against the canonical index, and
if that footprint spans several structurally independent modules — and other
work is already competing for part of it — the objective enters the queue as
several narrower tasks instead of one. The estimate is deterministic and weak
by design, and every ambiguity resolves toward not splitting. See
`docs/architecture/task-decomposition.md`.

## Planning

Every adapter starts in planning mode against an explicit canonical revision.
The coordinator validates and normalizes the returned plan before any execution
workspace is granted. Plans declare files, symbols, dependencies, APIs,
schemas, configuration keys, tests, services, commands, external access, risk,
and optional intent.

The code-intelligence service indexes the canonical Git tree at that revision.
It uses deterministic syntax analysis and bounded reads; it does not require an
LLM on the scheduling path.

## Conflict Evidence

`ConflictDetector` evaluates each plan pair and records transparent evidence:

| Kind | Typical relationship |
| --- | --- |
| `file_overlap` | Both tasks plan the same path |
| `symbol_overlap` | Both tasks change the same symbol |
| `dependency_impact` | One task produces a resource consumed by the other |
| `api_impact` | API ownership or use overlaps |
| `schema_impact` | Schema ownership or use overlaps |
| `config_overlap` | Configuration keys overlap |
| `test_overlap` | Test ownership or affected coverage overlaps |
| `intent_conflict` | Stated intents are judged to concern the same code |
| `intent_independent` | Both intents resolved to real modules with nothing connecting them |

Structural evidence can notify, sequence, or block according to configurable
weights and thresholds. Intent evidence is advisory: it is scored and recorded,
and it can raise a pair to `concurrent_with_notification` so a human looks, but
it is excluded from the total the thresholds are read against and so can never
sequence or block. Every assessment stores its score, resources, explanation,
and disposition; the explanation names the structural subtotal the disposition
was actually computed from.

Until 2026-07-31 this was only half true. The advisory score was summed into
the same total as the structural scores, and the guard that kept intent
evidence from blocking applied only to pairs with no structural evidence
whatsoever — so on a pair with any structural evidence at all, intent could
push the total across a threshold. Measured against the team-queue runs, the
shipped intent signal fired on four pairs and was wrong on all four, so the
only thing that behaviour bought was lost parallelism. See
`docs/benchmarks/intent-signal.md`.

How `intent_conflict` is produced depends on what the caller supplies.
`ConflictDetector.assess` takes an optional `IntentConflictAssessment`; without
one it falls back to comparing objectives against a hardcoded list of opposing
verb pairs. The CLI supplies a grounded assessor that resolves each intent
sentence against the repository index at the base revision, so two plans that
describe the same module in different words are judged on where those words
point rather than on whether the sentences resemble each other.

That grounded assessor is **switched on ahead of the run that would validate
it**, at a measured 70% precision against a bar of 80% it did not clear. It is
survivable only because of the advisory scoping described above, and it is
disabled by `COORD_DISABLE_INTENT_GROUNDING=1`. The reasoning, the numbers, and
the outstanding validation are in `docs/benchmarks/intent-grounding-wired.md`.
If the advisory guard is ever removed, that signal must be removed with it.

The same grounding also produces `intent_independent`: both intents resolved to
real modules and nothing in the repository connects them. It is recorded at
score zero and does exactly one thing — withholds the notification bump other
advisory evidence would add to a pair already scheduled as `concurrent`. It
cannot clear a pair structural evidence flagged, and it never creates an
assessment on its own, because assessments are persisted as conflict records
and a pair judged unrelated does not belong in that table.

## Scheduling And Ownership

Directed dependency evidence is converted into producer-before-consumer edges.
The scheduler rejects cycles, creates runnable waves, and executes independent
tasks concurrently. Resource leases prevent unsafe concurrent ownership and
expire automatically.

The final decision stored for a successful task is `approved`, because
decisions are refreshed when each scheduling wave becomes runnable. Conflict
records and increasing plan revision numbers retain why a task was previously
blocked.

If a producer fails planning, execution, validation, approval, or integration,
its explicit dependency descendants are cancelled rather than run against a
contract that never became canonical.

## Replanning

Before a sequenced task executes, the coordinator compares its planning
revision with current canonical. When canonical moved:

1. Both revisions are indexed so additions, changes, and removals are visible.
2. A canonical change notice is created for every supported resource class.
3. The adapter receives the previous plan and a fresh planning worktree.
4. The new plan is validated and conflict analysis is recalculated.
5. The revision and its reason are persisted before execution.

This is plan replacement, not patch replay. The agent is responsible for
adapting its implementation intent to the accepted producer contract.

## Live Scope Negotiation

An executing agent may request additional files, symbols, APIs, schemas,
configuration, tests, or services. The coordinator:

- rejects malformed or conflicting expansion,
- waits for a human when protected resources or risk require it,
- acquires new leases for accepted resources,
- persists the revised plan and scope decision,
- sends the decision back to the agent before it proceeds.

The final host-collected changeset must remain within the resulting approved
plan. An agent cannot make an undeclared patch acceptable by claiming it in a
completion message.

## Integration

Accepted work never writes canonical directly:

1. Freeze and collect the task overlay.
2. Check scope and approval policy.
3. Apply the patch to a temporary worktree at latest canonical.
4. Run configured validation without a shell.
5. Commit the candidate with hooks disabled.
6. Compare-and-swap the canonical branch.
7. Persist integration and canonical version records.
8. release leases and remove temporary workspaces.

A stale compare-and-swap or failed command leaves canonical unchanged. Cleanup
errors are recorded without rewriting an already-known integration outcome.

### Approvals are off by default

Step 2 consults the project's approval policy, and **a project that has not
configured one stops for nobody.** As of 2026-08-06 the platform runs
unattended by default: plans proceed on the coordinator's own evidence, and no
human is asked.

That is a reversal. The previous default gated any plan declaring a schema
change, touching a protected path (`database/migrations/**`, `secrets/**`,
`.github/workflows/**`, `package.json`, …), or rated `high`/`critical`, and
then waited up to 24 hours for a decision while the worker held its lease for
up to 8. Unattended, that is a deadlock rather than a review — the first live
`team-queue-wired` benchmark gated 8 of 10 plans and spent its whole budget
waiting for an approval nobody was there to give.

**What an unconfigured deployment now does without asking:** applies schema
changes, edits protected paths, acts on `critical`-risk plans, and **rolls
canonical back**. A rollback is high risk by construction and used to be gated
by the default alone.

**Turning review back on is one field**, per project:

```json
{ "version": 1, "approvals": { "enabled": true } }
```

Everything else is unchanged and only consulted once that switch is on — schema
review, the protected-path list, the risk levels, the 24-hour timeout. Nothing
was removed from the approval machinery; only the answer to "what happens when
nobody has said" changed. Narrower configurations still work: a project can
enable approvals and then set `riskLevels`, `protectedPaths`,
`requireSchemaReview`, `requireChangesetReview`, `requireRemotePlanReview`, and
`approvalTimeoutMs` to taste.
