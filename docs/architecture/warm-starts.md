# Warm starts

Two things a repository's next task should not have to pay for again: the
checkout it is about to work in, and the index of the revision it is about to
plan against. Both exist already, moments before, and both were thrown away.

Built. This page is what is in the code, the rules that make reuse safe, and
what is deliberately not warmed.

## What a task pays for before an agent does anything

On the control plane, in-process:

- **A checkout per task.** `GitWorktreeWorkspaceManager.create` runs
  `git worktree add --detach` for every task, and `cleanupTask` destroys the
  directory when the task settles. Measured at about 3.6 s of a scripted run
  (see [performance](../benchmarks/performance.md)).
- **Dependencies, never.** Nothing installs into a task workspace. Whatever
  the agent installs for itself is removed with the directory.
- **An index build on the critical path.** The code index is keyed by
  repository path and revision. A promotion moves canonical, and the next run's
  planning is the first thing to ask for the new revision — so it waits for a
  full walk and parse of the repository. `describeCanonicalAdvance` builds a
  new revision only when some task is already waiting on it, so a promotion
  that lands with nobody waiting was never indexed until somebody needed it.

On the remote worker — which is the primary executor, because agents run on
people's own machines rather than in a cloud sandbox:

- **A local clone per lease.** The bare repository cache is already warm and
  `materialise` clones from it in about 0.2 s, which is cheap. What is not
  cheap is what the clone does not contain: the agent installs its
  dependencies into the lease's scratch directory, and the `finally` that ends
  the lease removes the lot.

## Two mechanisms

### A warm index per repository

`CodeIntelligenceService.prewarm(repository, version)` builds the index for a
revision that has just become canonical, and writes it out. It is called after
every live promotion — from the coordinator, and from `acceptWorkResult` on the
worker path. Nothing waits for it and every error is swallowed: a promotion
that failed because an index could not be built would be a worse outcome than
a cold start.

The file lives at `<project>/.coordinator/index/<repository id>.json`, beside
the scratch roots rather than in them, because crash recovery clears those and
this is a cache of something still true. It records the index, the canonical
`sequence` and `revision` it was built for, the size bounds in force, and the
object id of every indexed path.

The blob ids are the half that keeps paying. A parse is addressed by content,
so reading the file back seeds the parse cache as well as the index — and the
first build after a restart then re-reads only the files that changed, even
when canonical moved several times while the process was down.

Three rules keep it honest:

- **Only `prewarm` writes.** Builds for older revisions run concurrently with
  builds for newer ones — replans and replayed results index arbitrary
  base/current pairs — so "write after every build" would mean "last build to
  finish wins", which is not the same as "latest canonical wins". `prewarm` is
  called with the promoted version, so it has a sequence to compare.
- **A write is refused for a sequence at or below what is already on disk**,
  and writes for one repository are chained so two cannot interleave their
  temp files. The file is written to a temp name and renamed, so a reader
  never sees half of one.
- **Anything that does not match exactly is treated as absent** — a different
  `INDEX_PERSISTENCE_VERSION`, a different set of size bounds, an unreadable or
  truncated file. A cache that can always be rebuilt is never worth repairing,
  and a wrong index would ground plans against symbols that no longer exist and
  be believed. Changing `IndexedFile`, `RepositoryIndex` or what any analyzer
  puts in them means bumping the constant.

### A warm workspace pool per repository

`WarmWorkspacePool` (in `@coord/workspace-manager`) holds a bounded number of
directories per repository. A task that integrated offers its directory
through `retain`; the next task in that repository is given it through `take`.
Both hosts use the same class: the control plane passes its own workspace
manager as the backend, and the worker passes a small adapter over the lease's
git client.

The rules are the whole design:

- **Only success keeps anything.** A failed or cancelled task's agent process
  can outlive the cancel that was sent to it, so its directory may still be
  being written to while anything else looks at it. Every other caller of
  `cleanupTask` — a planning refusal, an execution failure, the park fallback
  — retains nothing.
- **Scrub, then verify, then hand over.** `WorkspaceManager.scrub` resets to
  the base commit hash, runs `git clean -fdxq` with one `-e` per
  `EPHEMERAL_CLEAN_EXCLUDES` entry, and verifies with
  `git status --porcelain=v1 -z --ignored --untracked-files=all`. The `-x` and
  the `--ignored` are both load-bearing and were found empirically: without
  `-x`, `clean` honours `.gitignore` and leaves a landed task's `.env` and logs
  in place, and without `--ignored`, `status` cannot even see them to report
  the leak. A single `-f` is deliberate — a nested git repository an agent
  created survives it and is then caught by the verification, and the directory
  destroyed, which is safer than deleting somebody's clone.
- **The two halves of the scrub must agree.** `EPHEMERAL_CLEAN_EXCLUDES` is
  what `clean` spares and `isEphemeralWorkspacePath` is what the verification
  ignores. If `clean` removes something the filter spares the pool merely loses
  it; if `clean` spares something the filter flags, every retained directory
  fails verification and is destroyed — safe, and completely useless. A table
  test in `change-set.test.ts` pins the agreement.
- **Re-base on take, not invalidate on promotion.** A take always ends in
  `backend.advance(entry, { taskId, baseVersion })`, so canonical moving while
  a directory sits in the pool costs nothing and needs no listener.
- **Ownership moves before any await.** `retain` and `take` decide and record
  synchronously; the scrub and any install run afterwards in the entry's own
  settling promise, with the entry marked pending so a concurrent take passes
  over it. Waiting on somebody else's install is strictly worse than the cold
  checkout the caller would otherwise do, so a pending entry is a miss.
- **Validation is untouched.** It runs in the integration worktree, against
  exactly canonical plus the patch, and never in a task workspace.

Scope is process lifetime. Nothing durable describes a slot: the control plane
keeps its directories under the workspace root that crash recovery clears at
boot, and the worker clears `workspaceRoot/warm/` when it starts.

#### Dependencies

The pool takes an optional `prepare` step, run once per retained directory in
the background, and reports what it did on the next take:

| `dependencies` | Meaning |
| --- | --- |
| `present` | A manifest and an installed tree were both already there. The common retained case — the landed agent's own `node_modules` survives the scrub. |
| `installed` | The project's `installCommands`/`installCommand`, or the preview service's `detectInstallCommand`, ran and exited zero. |
| `absent` | There was nothing to install. |
| `skipped` | No prepare step was configured, or it could not be run here. |
| `failed` | It ran and failed. The directory is still kept: a checkout hit without dependencies is a hit. |

The control plane skips prepare entirely for a project whose sandbox has no
egress and defaults to `network: none`, because an install inside such a
container cannot reach a registry and would fail on every single landing —
deterministically, and reported as an error somebody then has to explain. Such
a project gets the checkout hit and `skipped`. The install runs through the
backend rather than on the host, so a sandboxed project that *has* configured
egress installs inside its own container.

The worker has no prepare step at all in this slice: the worker never
installs, the agent does, and the agent's own `node_modules` surviving the
scrub is precisely what retention is for.

#### On the worker

A slot is a retained local clone at `workspaceRoot/warm/<repository>/<slot>`,
outside every lease's scratch so the `finally` that ends a lease leaves it
alone. Taking one happens inside `plan()`, after `updateCache`, because a slot
catches up by fetching from the bare cache and the cache has to have absorbed
this lease's revision first. Every ref is fetched rather than the lease's own:
a slot outlives the lease that retained it, so it cannot know the ref name of
the lease that will take it next, and a fetch by bare object id is not
something a git remote will generally answer. The result is verified against
the revision that was asked for before anything is reset to it, and the refs
the fetch landed are deleted again once it has been: the cache accumulates one
`refs/coord/leases/<lease id>` per lease and drops none, so a slot that kept
what each catch-up copied would grow a ref for every lease the machine ever
ran and pin the objects behind them.

A question is never handed a slot. It reports no changeset, so nothing about
it reaches canonical and it can never give one back — and questions are served
ahead of work, so a take they could only discard would spend the repository's
warm directory on the leases least able to use it.

The take is recorded on the run (`Run.warmRetention`) the moment it resolves,
not on what `plan()` returns. The pool splices its entry out before it hands
anything over, and the directory sits outside the lease's scratch, so anything
thrown in the rest of `plan()` would otherwise leave a full checkout with
nothing anywhere that knew to remove it.

Retention happens after the result is reported, and reads `integrationStatus`
off the acceptance rather than `accepted`: an accepted result whose integration
conflicted or failed validation leaves a directory nobody has verified anything
about. The gateway has always relayed the whole acceptance; the worker's client
simply stopped reading it. A control plane too old to say sends nothing, which
reads as "not landed" and costs a cold start.

A lease that started in scratch and landed has its directory `rename`d into a
slot — same workspace root, same filesystem, so the move is atomic and costs
nothing, which matters because what is being moved is a checkout plus whatever
the agent installed into it.

## What is deliberately not warmed

- **Containers.** Every sandboxed command is its own `docker run --rm`. A kept
  container would hold a mount of a directory the next task owns, which is the
  leak the scrub exists to prevent. See
  [vendor CLI sandboxing](vendor-cli-sandboxing.md).
- **The integration worktree.** Validation must run on exactly canonical plus
  the patch, which is a fresh tree by definition.
- **A failed task's directory.** See above; a knob for it is worth having only
  if measurement ever shows failures dominating.
- **Overlay and rollback promotions.** They do not prewarm the index. Cheap to
  add; left out to keep the first slice to the two live task paths.

## Reading it back

`task_started` carries three fields:

- `workspaceStart`: `warm` (a pooled directory), `cold` (a fresh checkout) or
  `resumed` (a conversational turn keeping its own directory, which is a
  different mechanism with different rules — it keeps untracked files on
  purpose).
- `indexStart`: `warm` or `cold`, read once per run from
  `CodeIntelligenceService.isWarm` against the revision the run starts from.
- `dependencies`: the table above, present only when a pooled directory was
  taken.

`coord metrics` prints these as a **Warm starts** block, and `--json` carries
them under `warmStarts`. They are counted **per task start**, not per run:
`task_started` is the only event carrying them and there is no run-level event,
so a five-task run whose starting revision was indexed contributes five to
`indexWarm`. Nobody should read those numbers as runs.

The control plane also prints one line per take — `[warm] <repository>
workspace hit (dependencies present)`, or a miss, or a discard naming what
survived the scrub. The worker's one-line `Laps` summary marks a warm lease's
checkout as `checkout(warm)` instead of `checkout`.

## Knobs

`COORD_WARM_WORKSPACES_PER_REPOSITORY` (default 1, `0` disables),
`COORD_WARM_WORKSPACE_IDLE_MS` (default six hours) and `COORD_WARM_INDEX`
(`0` disables the persisted index). All three are documented in
[deployment](../deployment.md) and forwarded by `docker-compose.yml`.

Note that the workspace knobs are read by the control plane **and** separately
by every worker, so a fleet of ten machines at `1` is holding ten directories
per repository, each a full checkout plus its dependencies. Per-repository
per-worker disk is the real bound, and a global cap is a plausible follow-up if
a multi-repository laptop ever finds one directory per repository to be the
wrong unit.

## Known limits

- **Stale dependencies after a lockfile change.** A directory kept across a
  landing that changed a manifest has an install one revision behind until the
  agent reinstalls. The validation gate is unaffected — it runs elsewhere — so
  this costs an agent's own `npm test`, which is the trade a conversational
  turn already makes. Re-running prepare when the revisions between retain and
  take touch a manifest is the obvious next step.
- **Serialisation cost.** One `JSON.stringify` of a `RepositoryIndex` bounded
  by `maxFiles` (default 5,000) runs on the control plane's event loop once per
  promotion. Acceptable for a first slice; moving it to a parse worker is the
  fix if a large repository measures badly.
- **Nothing survives a restart but the index.** By design, and stated here so
  nobody plans capacity around warm directories persisting.
