# Lines-of-code audit

Where the tracked lines in this repository actually are, and which of them
anybody wrote. Generated at revision `7a6f962c6c961196ac5bd183e03029db54b8a520`.

Regenerate with:

```
npm run audit:loc          # markdown to stdout
node scripts/loc-audit.mjs --write   # overwrite this file
```

The numbers below come from `scripts/loc-audit.mjs`, which enumerates with
`git ls-files` (so `dist/` and `node_modules/` are out by construction),
excludes binary assets from every line total, and separates hand-written lines
from generated and captured ones before adding anything up. Comment counts are
a scanner over `//`, `/* */`, and `#` — good enough to read a ratio from,
not exact. Only tracked files are counted, so a file added in the same change
as a regeneration first appears in the following one.

## Headline

| Slice | Files | Lines | Share of tracked |
| --- | --- | --- | --- |
| Hand-written | 330 | 174,800 | 43.7% |
| Generated / captured | 117 | 225,228 | 56.3% |
| **All tracked text** | **447** | **400,028** | **100%** |

Plus 21 binary assets (images and fonts), excluded from every line count
above.

Of the hand-written lines, 113,294 are program text (TypeScript, browser
modules, and harness scripts) and 49,981 are tests — a test-to-source ratio of
0.44:1. Blank lines are 7.1% of the hand-written total and comments are 14.9%.

## By category

| Category | Files | Lines | Code | Comment | Blank | Share |
| --- | --- | --- | --- | --- | --- | --- |
| benchmark-data | 116 | 224,627 | 224,627 | 0 | 0 | 56.2% |
| source | 106 | 80,766 | 61,525 | 15,585 | 3,656 | 20.2% |
| test | 91 | 49,981 | 41,882 | 4,262 | 3,837 | 12.5% |
| browser | 14 | 23,022 | 17,069 | 4,209 | 1,744 | 5.8% |
| docs | 39 | 10,232 | 7,784 | 0 | 2,448 | 2.6% |
| script | 32 | 9,506 | 7,015 | 1,854 | 637 | 2.4% |
| config | 44 | 1,060 | 1,033 | 10 | 17 | 0.3% |
| lockfile | 1 | 601 | 601 | 0 | 0 | 0.2% |
| other | 4 | 233 | 172 | 50 | 11 | 0.1% |

`lockfile` is `package-lock.json`; `benchmark-data` is the recorded
experiment output under `docs/benchmarks/data/`. Both are generated, and
together they are the reason an undifferentiated `wc -l` over this repository
reports a number several times larger than the code anybody maintains.

## By package

Hand-written lines only, one row per workspace package plus the top-level
directories that are not packages.

| Package | Files | Lines | Program | Tests | Other |
| --- | --- | --- | --- | --- | --- |
| `apps/web` | 36 | 36,481 | 31,263 | 5,177 | 41 |
| `services/api-gateway` | 17 | 27,995 | 17,135 | 10,827 | 33 |
| `apps/cli` | 40 | 19,414 | 11,135 | 8,209 | 70 |
| `services/coordinator` | 41 | 19,330 | 10,216 | 9,073 | 41 |
| `services/persistence` | 16 | 19,010 | 14,768 | 4,201 | 41 |
| `apps/worker` | 22 | 8,216 | 6,829 | 1,342 | 45 |
| `docs` | 36 | 8,212 | 0 | 0 | 8,212 |
| `services/workspace-manager` | 16 | 5,485 | 3,213 | 2,237 | 35 |
| `services/repository-service` | 11 | 3,841 | 2,272 | 1,535 | 34 |
| `adapters/prompt-cli` | 7 | 3,693 | 2,476 | 1,181 | 36 |
| `scripts` | 12 | 3,479 | 3,479 | 0 | 0 |
| `services/code-intelligence` | 8 | 3,008 | 1,998 | 976 | 34 |
| `adapters/codex` | 4 | 2,921 | 1,576 | 1,308 | 37 |
| `packages/shared-types` | 4 | 2,540 | 1,891 | 617 | 32 |
| `packages/collab` | 14 | 2,413 | 1,392 | 990 | 31 |
| `(root)` | 13 | 2,351 | 0 | 0 | 2,351 |
| `services/integration-service` | 7 | 2,275 | 762 | 1,477 | 36 |
| `adapters/generic-cli` | 6 | 1,858 | 1,207 | 614 | 37 |
| `packages/intent-analysis` | 11 | 1,101 | 850 | 217 | 34 |
| `infrastructure` | 6 | 784 | 473 | 0 | 311 |
| `packages/agent-protocol` | 3 | 393 | 359 | 0 | 34 |

## Largest hand-written files

The 25 longest files anybody maintains. Generated artefacts are excluded —
they are longer, and nothing about their length is a decision. This is the
table to read when deciding what to split.

| File | Lines | Code | Category |
| --- | --- | --- | --- |
| `services/api-gateway/src/server.ts` | 13,319 | 9,649 | source |
| `services/api-gateway/src/server.test.ts` | 8,911 | 7,231 | test |
| `apps/web/public/styles.css` | 7,304 | 5,515 | browser |
| `apps/web/public/app.js` | 4,642 | 3,514 | browser |
| `apps/cli/src/worker-operations.test.ts` | 4,186 | 3,574 | test |
| `services/persistence/src/sqlite-store.ts` | 4,162 | 3,830 | source |
| `services/persistence/src/postgres-store.ts` | 4,094 | 3,752 | source |
| `apps/web/src/providers.ts` | 4,053 | 3,036 | source |
| `services/coordinator/src/coordinator.ts` | 3,740 | 2,704 | source |
| `services/persistence/src/store-contract.test.ts` | 3,577 | 3,134 | test |
| `apps/web/public/data.js` | 3,487 | 2,216 | browser |
| `apps/web/public/screen-chats.js` | 3,348 | 2,383 | browser |
| `apps/cli/src/worker-operations.ts` | 3,109 | 2,394 | source |
| `services/persistence/src/memory-store.ts` | 2,536 | 2,279 | source |
| `services/coordinator/src/coordinator.test.ts` | 2,126 | 1,793 | test |
| `adapters/prompt-cli/src/index.ts` | 2,102 | 1,654 | source |
| `packages/shared-types/src/index.ts` | 1,891 | 1,242 | source |
| `instructions.md` | 1,843 | 1,045 | docs |
| `apps/web/src/providers.test.ts` | 1,763 | 1,509 | test |
| `services/persistence/src/store.ts` | 1,722 | 947 | source |
| `services/repository-service/src/repository-service.ts` | 1,713 | 1,313 | source |
| `adapters/codex/src/index.ts` | 1,576 | 1,265 | source |
| `apps/worker/scripts/team-queue-experiment.mjs` | 1,486 | 1,019 | script |
| `apps/cli/src/commands.ts` | 1,470 | 1,084 | source |
| `apps/web/public/ui.js` | 1,369 | 1,025 | browser |

## Size distribution

Hand-written files at or above each threshold, and what share of the
hand-written total they account for.

| At least | Files | Lines | Share of hand-written |
| --- | --- | --- | --- |
| 3,000 lines | 13 | 67,932 | 38.9% |
| 2,000 lines | 16 | 74,696 | 42.7% |
| 1,000 lines | 35 | 101,916 | 58.3% |
| 500 lines | 71 | 127,366 | 72.9% |

## What this says

The single largest hand-written file is `services/api-gateway/src/server.ts`
at 13,319 lines — 7.6% of everything written in this repository, in one file,
and its own test file is the next largest. Nothing in the build forces a split
at any size, and the distribution above shows this is a habit rather than one
outlier: 16 files of 2,000 lines or more carry 42.7% of the hand-written
total.

Tests are 28.6% of hand-written lines, and the four largest packages
(`apps/web`, `services/api-gateway`, `apps/cli`, `services/coordinator`) hold
59.1% of them — growth is concentrated in a few packages rather than spread
across the workspace graph.

## Generated artefacts

The largest captured outputs, for scale. These are committed on purpose — the
benchmark documents cite them as evidence — but they dominate any naive line
count of the repository and should be excluded from one.

| File | Lines |
| --- | --- |
| `docs/benchmarks/data/team-queue/team-queue-coordinated-live3-1785450844838.json` | 57,372 |
| `docs/benchmarks/data/team-queue/team-queue-uncoordinated-live3-1785456902049.json` | 37,731 |
| `docs/benchmarks/data/team-queue/team-queue-coordinated-ab-legacy-1785514432087.json` | 29,489 |
| `docs/benchmarks/data/team-queue/team-queue-coordinated-livelockfix-1785480099807.json` | 14,392 |
| `docs/benchmarks/data/team-queue-wired/team-queue-coordinated-wired-coord-smoke-1786064268252.json` | 11,910 |
