# One Repository Index Per Process

`CodeIntelligenceService` has always cached a built index on
`(repository path, revision)`, bounded at 100 entries. The cache was correct
and nearly useless: almost every caller constructed its own service, so
almost every caller began with an empty cache and rebuilt the index for a
revision another caller had just finished indexing. The one place that did
keep a service — the hosted worker binding — shared it with nothing else in
the process.

`docs/benchmarks/plan-grounding.md` records what that costs — full
arbitration at a 10,270 ms median against 232 ms for the solo fast path, on a
300-file repository, "fresh services per sample so every admission pays the
cold-index cost". The index build is the difference.

## The change

The control plane now builds one service in `serve()` and hands it to every
path that used to make its own:

- `workerOperations(project, store, { repositories, intelligence })` — the
  remote worker protocol's admission, scope arbitration and result
  acceptance. This seam is new; that factory previously had no injection
  point at all.
- `runPendingTasks(..., { intelligence })` — which passes it to the
  coordinator it builds and to the `LeasePlanAuthority` that admits plans.
- Overlay submission and canonical rollback, which each ground a plan the
  same way.

Every construction site keeps its `?? new CodeIntelligenceService(...)`
fallback, so the bare CLI and every existing test behave exactly as before.

Nothing about *what* is built changed. The key still carries the canonical
revision, so a repository that moves misses the cache and rebuilds; there is
no invalidation logic to get wrong, and no widened key that could serve a
stale index.

Two properties that a per-call service never had to satisfy do now:

- **The entry bound is finally reachable.** A long-lived instance
  accumulates, so `maxCacheEntries` is what keeps a process indexing many
  repositories from growing without limit. Covered by a test that fills a
  one-entry cache and watches the older index get rebuilt after eviction.
- **Concurrent callers must share, not race.** Tasks plan in parallel, so two
  can now ask for the same uncached index at once. `index()` records the
  in-flight build under the same key and hands each caller its own clone of
  the single result, so three simultaneous callers cost one walk of the
  repository and receive three equal, independent indexes.

## Measured

**Build counts.** Counted directly, by counting the repository listing that
begins every build.

Per-service behaviour, asserted in
`services/code-intelligence/src/index.test.ts`:

| Requests for one `(repository, revision)` | Builds before | Builds after |
| --- | --- | --- |
| 3 sequential, one service | 1 | 1 |
| 3 concurrent, one service | 3 | 1 |
| A request after canonical moves | 1 | 1 (new key, as before) |

The cache already handled the sequential case; what is new is the concurrent
one, which used to duplicate the whole walk once per caller. The entry bound
is tested separately: with room for one index, indexing a second repository
evicts the first, and asking for the first again rebuilds it — the eviction
loop's first exercise, since no instance used to live long enough to reach
it.

Per-process behaviour, which is where the change actually pays:

| Work at one revision | Builds before | Builds after |
| --- | --- | --- |
| One local run of N tasks (coordinator grounding *and* lease admission) | 2 | 1 |
| A second local run at the same revision | 2 | 0 |
| An overlay submission | 1 | 0 |
| A canonical rollback | 1 | 0 |
| Remote-worker admissions through the hosted binding | 1 | 1 |

The last row is honest about what was already true: the control plane builds
its worker binding once, so those admissions already shared one service
between themselves. Everything else built its own and threw it away — the
coordinator and the lease authority inside a *single* run held two separate
caches of the same index — and none of them shared with the worker binding.
Now all of it is one cache, so the first thing to index a revision pays and
nothing else at that revision pays again.

**What one build costs.** Replaying the I/O half of a build against this
repository at `432f7d9` — one `git ls-tree`, then one `git show` per source
file, 16 at a time, exactly as the service reads them — over 406 source files
and 12.3 MB: **525 ms / 568 ms / 681 ms** across three runs on a warm page
cache. That is the floor, not the total: it excludes parsing every TypeScript
file into an AST, which is the larger share and the reason the arbitration
figure above is measured in seconds rather than in hundreds of milliseconds.
A cache hit does neither — it is a `structuredClone` of an index already in
memory.

**What was not measured.** The end-to-end before/after wall-clock for a
repeated multi-task run was not run here: this workspace has no installed
dependencies and no network access, so the suite could not be built or
executed. The claim being made is therefore the narrow one the numbers above
support — one build per `(repository, revision)` instead of one per request,
each build costing at least half a second of git I/O on a repository this
size — and not a measured end-to-end speedup. Run `npx turbo test` for the
build-count assertions, and re-time a multi-task run in an environment with
dependencies installed to put a wall-clock figure on it.
