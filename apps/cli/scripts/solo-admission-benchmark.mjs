#!/usr/bin/env node
/**
 * Measures what the solo fast path saves at plan admission.
 *
 * Builds a synthetic repository of N source files, then measures
 * `admitWorkPlan` wall time in two conditions:
 *
 * - solo: no other active work in the repository. After the fast path this
 *   answers without building the repository index.
 * - contended: one other admitted lease exists, so the full arbitration path
 *   runs — index build, enrichment, grounding, conflict scoring, ownership.
 *   This is, within a few milliseconds of conflict scoring, exactly what a
 *   solo admission paid before the fast path existed.
 *
 * Every measurement constructs fresh services, so the index cache never
 * carries between samples — each admission pays the cold cost a first
 * admission at a new revision pays in production.
 *
 * Usage: node apps/cli/scripts/solo-admission-benchmark.mjs [--files=300] [--samples=5]
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
} from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import { admitWorkPlan, leaseWork } from "../dist/worker-operations.js";

function flag(name, fallback) {
  const raw = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return raw === undefined ? fallback : Number(raw.slice(name.length + 3));
}

const fileCount = flag("files", 300);
const samples = flag("samples", 5);

async function createRepository(root) {
  const sourcePath = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(sourcePath);
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    const dir = path.join(sourcePath, "src", `module${String(i % 20)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `unit${String(i)}.js`),
      `export function unit${String(i)}Value(input) {\n` +
        `  return input + ${String(i)};\n` +
        `}\n` +
        `export const UNIT_${String(i)}_LIMIT = ${String(i)};\n`,
      "utf8",
    );
  }
  await repositories.commitAll(sourcePath, "seed");
  const canonical = await repositories.importLocalRepository(
    sourcePath,
    path.join(root, "canon.git"),
    "repo_bench",
    "main",
  );
  return { repositories, canonical };
}

async function prepare(store, repositories, canonical, objective) {
  await store.saveRepository({
    id: canonical.id,
    path: canonical.path,
    branch: canonical.branch,
  });
  const user = await store.createUser({
    email: "bench@example.com",
    displayName: "Bench",
    passwordDigest: "digest",
  });
  const worker = await store.registerWorker({
    userId: user.id,
    name: "worker-bench",
    adapters: ["generic-cli"],
    version: "1.0.0",
  });
  await store.submitTask({
    repositoryId: canonical.id,
    objective,
    agentId: "generic-cli",
    validationCommands: [],
  });
  return worker.id;
}

function planFor(taskId, objective, file, symbol) {
  return {
    taskId,
    objective,
    expectedFiles: [file],
    expectedSymbols: [symbol],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

async function measure(contended) {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-bench-"));
  try {
    const { repositories, canonical } = await createRepository(root);
    const store = new InMemoryCoordinationStore();
    const workerId = await prepare(
      store,
      repositories,
      canonical,
      "adjust unit0Value",
    );

    if (contended) {
      // A disjoint neighbour, admitted first, so the measured admission has
      // to run full arbitration — the cost a solo admission used to pay.
      await store.submitTask({
        repositoryId: canonical.id,
        objective: "adjust unit5Value",
        agentId: "generic-cli",
        validationCommands: [],
      });
    }

    const assignments = [];
    for (let i = 0; i < (contended ? 2 : 1); i += 1) {
      const assignment = await leaseWork(store, {
        workerId,
        projectId: DEFAULT_PROJECT_ID,
      });
      if (assignment === undefined) {
        throw new Error("lease unavailable");
      }
      assignments.push(assignment);
    }
    if (contended) {
      // Admit the neighbour (this one takes the fast path; not measured).
      const neighbour = assignments[1];
      await admitWorkPlan(
        store,
        {
          leaseId: neighbour.lease.id,
          actorId: "bench",
          plan: planFor(
            neighbour.task.id,
            neighbour.task.objective,
            "src/module5/unit5.js",
            "unit5Value",
          ),
        },
        { repositories },
      );
    }

    const target = assignments[0];
    const startedAt = performance.now();
    const outcome = await admitWorkPlan(
      store,
      {
        leaseId: target.lease.id,
        actorId: "bench",
        plan: planFor(
          target.task.id,
          target.task.objective,
          "src/module0/unit0.js",
          "unit0Value",
        ),
      },
      { repositories },
    );
    const elapsed = performance.now() - startedAt;
    if (outcome.outcome !== "admitted") {
      throw new Error(`Unexpected outcome: ${outcome.outcome}`);
    }
    return { elapsed, status: outcome.admission.status };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

const solo = [];
const contendedRuns = [];
for (let i = 0; i < samples; i += 1) {
  const fast = await measure(false);
  solo.push(fast.elapsed);
  console.log(
    `solo sample ${String(i + 1)}: ${fast.elapsed.toFixed(0)}ms (${fast.status})`,
  );
  const full = await measure(true);
  contendedRuns.push(full.elapsed);
  console.log(
    `full sample ${String(i + 1)}: ${full.elapsed.toFixed(0)}ms (${full.status})`,
  );
}

const soloStats = stats(solo);
const fullStats = stats(contendedRuns);
console.log(
  JSON.stringify(
    {
      files: fileCount,
      samples,
      soloAdmissionMs: soloStats,
      fullArbitrationMs: fullStats,
      medianSavedMs: Number(
        (fullStats.median - soloStats.median).toFixed(1),
      ),
    },
    undefined,
    2,
  ),
);
