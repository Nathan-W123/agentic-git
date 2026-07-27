# Coordination Architecture

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
| `intent_conflict` | Objectives contain a known incompatible intent pair |

Structural evidence can notify, sequence, or block according to configurable
weights and thresholds. Intent evidence remains advisory even at a high score.
Every assessment stores its score, resources, explanation, and disposition.

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
