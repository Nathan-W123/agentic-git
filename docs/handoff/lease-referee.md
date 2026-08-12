# Handoff — the lease referee never fires, and the repro that will find out why

Written at the end of a long session, at the edge of its context. Everything
below was read out of the code or observed in production runs today; where I
am guessing, it says so.

Deployed at `440889c` on `main`. Branch `chats-channels-and-agent-sign-in` is
level with it. Production is Railway, **SQLite store** (the FK error text
proved it), in-process runner, git **2.39** (bookworm — this mattered once
already, see "solved on the way" below).

## The bug, in one paragraph

Two agents given overlapping work are both admitted into execution, in both
orders, every time. The plan-lease arbitration — the product's core claim —
has never once engaged in production. Correctness survives because the
exact-base integration check catches the collision at landing time (the
loser replans on top of the winner), but that wastes a full agent execution
per collision and the coordinator looks asleep while it happens.

## The evidence (three production runs, one day)

1. **Calculator pair, back-to-back**: both planned `calculator.py` +
   `README.md`, both executed, A landed, B hit "Something moved underneath
   me; re-planning" (exact-base referee). Lease referee: silent.
2. **Calculator pair, ~60s gap** (A demonstrably admitted and executing
   before B planned): same outcome. B approved despite A's active lease.
3. **Taskman pair (7–8 files each, `models.py`/`storage.py`/`cli.py`
   overlap), 60s gap**: both approved into concurrent execution — *in both
   orders* (the Codex extension task planned first in one run, the Claude
   core task first in another). Both directions of the check failed, which
   rules out timing as the explanation.

Additional tell: **neither thread ever showed a `plan_admitted` narration** —
no "Plan approved — starting on the code", no ⚖️ line. The narration case
exists (`narrateTaskEvent`, `services/api-gateway/src/server.ts`) and the
watcher polls by taskId. If the event were emitted with the task id, a line
should appear. It did not. This is the strongest clue: **the admission path
the deployed runner actually takes may not be the one that traces
`plan_admitted` and records lease plans.**

## What is verified present and correct (do not re-derive)

- `saveWorkLeasePlan` (`services/persistence/src/store.ts` ~1114, sqlite impl
  ~932 `UPDATE work_leases SET plan_json`): persists a plan+admission onto an
  active lease, **serialized against concurrent admissions in the same
  repository** — its doc says two workers evaluating overlapping plans at the
  same moment cannot both be approved; the loser re-decides.
- Four call sites in `apps/cli/src/worker-operations.ts` (~1398 solo path,
  ~1458, ~1611 full admission loop, ~2069).
- `executingPlans` (`worker-operations.ts` ~1122): reads active leases for
  the repository, keeps those with `plan !== undefined &&
  planAdmissionApproved`, feeds them to `admissions.admit({plan, active…})`.
- `plan_admitted` traced at ~1487 and ~1647 with status / blockedBy /
  grantedFiles / deferredResources.
- The narration and room announcements for every outcome are built and
  deployed (see "landed this session").

So every piece exists. The question is purely **which code path the deployed
in-process runner takes**, and why it either skips admission, skips the
trace, or runs admission with an empty `active` set every time.

## Suspects, in order

1. **The dispatch flow bypasses worker-operations admission.** Channel
   dispatch → `operations.runRepository` → `runPendingTasks`
   (`apps/cli/src/commands.ts` ~679). Trace what that actually invokes.
   If it drives the `Coordinator` class (`services/coordinator/src/
   coordinator.ts`) directly, each dispatch gets its **own coordinator
   instance seeing only its own task** — solo everywhere, wave assessment
   vacuous, and if that path doesn't call `saveWorkLeasePlan`/re-read leases,
   the cross-invocation referee never exists. The missing `plan_admitted`
   narration is consistent with this: the coordinator path may trace
   plan events under different types or without the submitted-task id.
2. **Leases carry no plan when read back.** `executingPlans` requires
   `candidate.plan !== undefined`. If `saveWorkLeasePlan` is only reached on
   the *remote worker* path (`apps/worker`), in-process leases stay bare and
   `active` is always `[]`.
3. **Two dispatches, two `runPendingTasks` invocations, each claiming one
   task** — and admission inside each invocation only arbitrates against
   plans *it* knows. (Variant of 1.)

## The repro that settles it (do this before reading more code)

Gateway/CLI tests already have scripted agents. Write one test:

- One repository, two submitted tasks whose scripted plans both declare
  `same.py`.
- Run them through **the exact production entry point** —
  `operations.runRepository` / `runPendingTasks` as `apps/web/src/index.ts`
  wires it, two invocations, overlapping in time (the scripted agent can
  sleep between plan and execute to hold the window open).
- Assert: the second task's `plan_admitted` event exists and has
  `status: "sequenced"` (or partial), and only one `canonical_promoted`
  happens before the other starts executing.

The test will fail at a specific spot; that spot is the bug. Do not trust a
test that goes through `Coordinator.execute` or worker-operations helpers
directly — the whole point is that the *deployed wiring* may not reach them.

## Landed this session (working, do not re-do)

- Room + thread narration for every referee outcome: `conflict_detected`
  (wave), `plan_admitted` sequenced/blocked/partial (`announceArbitration`),
  canonical-moved replans (`announceReplay`) — all in
  `services/api-gateway/src/server.ts`, all currently starved of events by
  this bug (the replay one fires; it is how we know exact-base works).
- Active leases are injected into the planning prompt
  (`services/coordinator/src/coordinator.ts` ~600, `leaseNote`) — advisory,
  admission stays the authority. Same caveat: only helps if leases carry
  plans.
- Boot resume of the queue (`apps/web/src/index.ts` after listen): expires
  stale leases, runs every repository with `submitted` work. Fixed the
  eternal-dots orphans.
- Client `WORKING_STATUS` is now `{submitted, claimed}` (`data.js`) — was
  four impossible statuses and not `claimed`.
- `git reset --hard --quiet --end-of-options <sha>` fails on git 2.39
  (container) while fine on 2.5x (laptops). Salvage was dying on it —
  **misdiagnosed once as agent error; it was ours.** Fixed with a hash guard
  instead of the terminator (`services/integration-service/src/index.ts`).
  If another git incantation misbehaves in prod only: suspect the version.
- Repository deletion cascades run history now (9 children + `file_patches`
  grandchild + approvals/runs/leases/queue). The old "history refuses
  deletion" contract test asserts the new behaviour, with reasoning.
- Audit thread is one per repository ("Audit log" marker line, bumped);
  finding numbers resolve against the newest audit first.

## Working in this repository

- **Two sessions share the checkout.** Commit with explicit paths only.
  Twice today a *use* was pushed while its *definition* sat uncommitted in
  the tree (`outcome` ChannelEntryKind; `summariseChangedFiles`) and every
  Railway build failed for 90 minutes. **Build-verify `main` in the merge
  worktree (`C:\Users\nward\AppData\Local\Temp\bsm`) before pushing** —
  `npx turbo run build` there, 17/17, then push. Non-negotiable now.
- `/api/v1/health` carries `build.commit` + `startedAt`. Check it before
  debugging "my fix doesn't work" — twice today the fix simply wasn't
  serving yet.
- Escape sequences die in transit: python `-c`/heredocs and shell-quoted
  `\0`/`\n`/`\b` have produced literal NULs and broken regexes repeatedly.
  Write bytes numerically (`bytes([92, 48])`) or use the Edit tool; scan for
  NULs before every commit (`grep -a` sees them as binary).
- Suites: `--concurrency=1`, and the two known wall-clock flakes are not
  your diff.
- Production surprises today came from **environment deltas** (git version,
  SQLite-not-Postgres). When prod contradicts a local pass, diff the
  environment before the code.
