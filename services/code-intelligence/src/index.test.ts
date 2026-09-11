import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

import { RepositoryService } from "@coord/repository-service";
import { crossesBranches, type AgentPlan } from "@coord/shared-types";

import { CodeIntelligenceService, type RepositoryIndex } from "./index.js";

test("indexes symbols, imports, APIs, schemas, configuration, tests, and services", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-index-"));
  try {
    const source = path.join(root, "source");
    const canonicalPath = path.join(root, "canonical.git");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(
      path.join(source, "src", "service.ts"),
      [
        'import { helper } from "./util.js";',
        "export interface UserSchema { id: string }",
        "export class UserService {",
        '  route(app: any) { app.get("/users", helper); }',
        "}",
        'test("lists users", () => process.env.API_URL);',
      ].join("\n"),
    );
    await writeFile(
      path.join(source, "src", "util.ts"),
      "export function helper() { return true; }\n",
    );
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      canonicalPath,
      "example",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const service = new CodeIntelligenceService(repositories);
    const index = await service.index(repository, version.revision);
    const file = index.files.find((entry) => entry.path === "src/service.ts");
    assert.ok(file);
    assert.ok(file.symbols.includes("UserService"));
    assert.ok(file.schemas.includes("UserSchema"));
    assert.ok(file.services.includes("UserService"));
    assert.ok(file.apis.includes("GET /users"));
    assert.ok(file.configKeys.includes("API_URL"));
    assert.ok(file.tests.includes("lists users"));
    assert.equal(
      index.edges.find((edge) => edge.fromFile === "src/service.ts")?.toFile,
      "src/util.ts",
    );

    const plan: AgentPlan = {
      taskId: "task",
      objective: "Change the user route",
      expectedFiles: ["src/service.ts"],
      expectedSymbols: [],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "medium",
    };
    const enriched = service.enrichPlan(plan, index);
    assert.ok(enriched.expectedSymbols.includes("UserService"));
    assert.ok(enriched.dependencies.includes("file:src/util.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records which declarations leave their file, and which do not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-index-"));
  try {
    const source = path.join(root, "source");
    const canonicalPath = path.join(root, "canonical.git");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(
      path.join(source, "src", "session.ts"),
      [
        // Every shape the `export` keyword takes, because they reach
        // `getCombinedModifierFlags` through different amounts of TypeScript.
        "export interface SessionToken { id: string }",
        "export class SessionStore {}",
        "export function issue() { return 1; }",
        "export const TTL_MS = 60;",
        "export default function boot() { return 2; }",
        // And the ones that do not leave the file.
        "interface Clock { now(): number }",
        "function clampWidth(n: number) { return n; }",
        "const scratch = 3;",
        // Published without a modifier, from somewhere else in the file.
        "function readCookie() { return \"\"; }",
        "export { readCookie as cookie };",
      ].join("\n"),
    );
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      canonicalPath,
      "exports",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const service = new CodeIntelligenceService(repositories);
    const index = await service.index(repository, version.revision);
    const file = index.files.find((entry) => entry.path === "src/session.ts");
    assert.ok(file);

    for (const published of [
      "SessionToken",
      "SessionStore",
      "issue",
      "TTL_MS",
      "boot",
      "readCookie",
      "cookie",
    ]) {
      assert.ok(
        file.exportedSymbols.includes(published),
        `${published} should be exported`,
      );
    }
    for (const kept of ["Clock", "clampWidth", "scratch"]) {
      assert.ok(file.symbols.includes(kept), `${kept} should be indexed`);
      assert.ok(
        !file.exportedSymbols.includes(kept),
        `${kept} should not be exported`,
      );
    }

    // The whole point of recording it: a symbol nobody outside its file can
    // name is local to the branch editing it, and an exported one belongs to
    // every branch at once.
    const symbols = service.symbolVisibility(index);
    assert.equal(
      crossesBranches({ resourceType: "symbol", resourceId: "SessionToken" }, symbols),
      true,
    );
    assert.equal(
      crossesBranches({ resourceType: "symbol", resourceId: "clampWidth" }, symbols),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexes deterministic schema, configuration, and service data files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-index-"));
  try {
    const source = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "db"), { recursive: true });
    await writeFile(
      path.join(source, "settings.json"),
      '{"auth":{"issuer":"relay"},"features":{"replan":true}}\n',
    );
    await writeFile(
      path.join(source, "compose.yaml"),
      "services:\n  api:\n    image: relay-api\n  worker:\n    image: relay-worker\n",
    );
    await writeFile(
      path.join(source, "db", "migration.sql"),
      "CREATE TABLE approvals (id TEXT PRIMARY KEY);\nALTER TABLE tasks ADD COLUMN plan_revision INT;\n",
    );
    await writeFile(
      path.join(source, "db", "schema.prisma"),
      "model User {\n  id String @id\n}\nmodel Project {\n  id String @id\n}\n",
    );
    await repositories.commitAll(source, "data files");
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "data",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const index = await new CodeIntelligenceService(repositories).index(
      repository,
      version.revision,
    );

    assert.deepEqual(
      index.files.find((file) => file.path === "settings.json")?.configKeys,
      ["auth", "auth.issuer", "features", "features.replan"],
    );
    assert.deepEqual(
      index.files.find((file) => file.path === "compose.yaml")?.services,
      ["api", "worker"],
    );
    assert.deepEqual(
      index.files.find((file) => file.path === "db/migration.sql")?.schemas,
      ["table:approvals", "table:tasks"],
    );
    assert.deepEqual(
      index.files.find((file) => file.path === "db/schema.prisma")?.schemas,
      ["model:Project", "model:User"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource limits mark an index as truncated without reading unbounded files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-index-"));
  try {
    const source = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await writeFile(path.join(source, "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(source, "b.ts"), "export const b = 2;\n");
    await repositories.commitAll(source, "limits");
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "limits",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const service = new CodeIntelligenceService(repositories, { maxFiles: 1 });
    const index = await service.index(repository, version.revision);

    assert.equal(index.files.length, 1);
    assert.equal(index.truncated, true);
    assert.equal(index.skippedFiles, 1);
    const cached = await service.index(repository, version.revision);
    cached.files[0]?.symbols.push("mutated");
    assert.equal(
      (await service.index(repository, version.revision)).files[0]?.symbols.includes(
        "mutated",
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-positive resource and cache limits", () => {
  assert.throws(
    () => new CodeIntelligenceService(undefined, { maxFiles: 0 }),
    RangeError,
  );
  assert.throws(
    () => new CodeIntelligenceService(undefined, { maxCacheEntries: -1 }),
    RangeError,
  );
});

test("records where each symbol lives, and admits when it cannot", async () => {
  // Line positions are what let ownership withhold a symbol while granting the
  // file it lives in: they are the only thing a diff hunk can be compared
  // against without re-reading the file.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-ranges-"));
  try {
    const source = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(
      path.join(source, "src", "shapes.ts"),
      [
        "export const alpha = 1;", // line 1
        "", // 2
        "export function beta() {", // 3
        "  return alpha;", // 4
        "}", // 5
        "", // 6
        "export interface Gamma {", // 7
        "  id: string;", // 8
        "}", // 9
      ].join("\n"),
    );
    await writeFile(
      path.join(source, "data", "config.yaml"),
      "service:\n  name: example\n",
    ).catch(async () => {
      await mkdir(path.join(source, "data"), { recursive: true });
      await writeFile(
        path.join(source, "data", "config.yaml"),
        "service:\n  name: example\n",
      );
    });
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "shapes",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const service = new CodeIntelligenceService(repositories);
    const index = await service.index(repository, version.revision);

    const ranges = service.symbolRangesInFile(index, "src/shapes.ts");
    assert.ok(ranges);
    const byName = new Map(ranges.map((range) => [range.name, range]));
    // 1-based and inclusive, so they line up with a diff hunk's old side.
    assert.deepEqual(byName.get("alpha"), {
      name: "alpha",
      startLine: 1,
      endLine: 1,
    });
    assert.deepEqual(byName.get("beta"), {
      name: "beta",
      startLine: 3,
      endLine: 5,
    });
    assert.deepEqual(byName.get("Gamma"), {
      name: "Gamma",
      startLine: 7,
      endLine: 9,
    });
    // Every symbol the index reports is locatable, or enforcement would have
    // gaps it could not see.
    const file = index.files.find((entry) => entry.path === "src/shapes.ts");
    assert.deepEqual(
      [...byName.keys()].sort(),
      [...(file?.symbols ?? [])].sort(),
    );

    // A file that is not parsed into an AST says so, rather than reporting an
    // empty list that would read as "declares nothing".
    assert.equal(
      service.symbolRangesInFile(index, "data/config.yaml"),
      undefined,
    );
    assert.equal(service.symbolRangesInFile(index, "src/missing.ts"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A canonical repository with two source files, ready to index. */
async function seedRepository(
  root: string,
  name: string,
  repositories: RepositoryService,
) {
  const source = path.join(root, `source-${name}`);
  await repositories.initializeWorkingRepository(source);
  await writeFile(
    path.join(source, "alpha.ts"),
    `export const ${name} = 1;\nexport function use_${name}() { return ${name}; }\n`,
  );
  await writeFile(path.join(source, "beta.ts"), "export const beta = 2;\n");
  await repositories.commitAll(source, "seed");
  const repository = await repositories.importLocalRepository(
    source,
    path.join(root, `canonical-${name}.git`),
    name,
  );
  const version = await repositories.getCanonicalVersion(repository);
  return { repository, revision: version.revision };
}

/**
 * Counts index builds by counting the listing every build starts with.
 *
 * `listFileEntries` is called exactly once per build, so this counts the
 * builds the cache is supposed to have made unnecessary as well as the ones it
 * allowed. It counts builds and not parses on purpose: reusing a parsed file
 * across revisions is an optimisation *inside* a build, and the cache this
 * measures is the one that stops the build happening at all.
 */
function countBuilds(repositories: RepositoryService): { builds: number } {
  const counter = { builds: 0 };
  const listEntries = repositories.listFileEntries.bind(repositories);
  (
    repositories as unknown as { listFileEntries: typeof listEntries }
  ).listFileEntries = async (...args: Parameters<typeof listEntries>) => {
    counter.builds += 1;
    return await listEntries(...args);
  };
  return counter;
}

test("one service builds an index once and serves the rest from its cache", async () => {
  // The point of sharing a service between callers: the cache is an instance
  // field, so a service constructed per call could never hit it.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-index-reuse-"));
  try {
    const repositories = new RepositoryService();
    const { repository, revision } = await seedRepository(
      root,
      "reuse",
      repositories,
    );
    const counter = countBuilds(repositories);
    const service = new CodeIntelligenceService(repositories);

    const first = await service.index(repository, revision);
    const second = await service.index(repository, revision);
    const third = await service.index(repository, revision);

    assert.equal(counter.builds, 1);
    // Same index, not merely a cheaper one.
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    // Each caller holds its own copy, so one mutating what it was handed
    // cannot change what the next one sees.
    second.files[0]?.symbols.push("mutated");
    assert.deepEqual(await service.index(repository, revision), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent callers asking for the same uncached index share one build", async () => {
  // Tasks plan in parallel, so with one shared service two callers can now
  // want the same index before either has it. That must cost one build and
  // produce one answer, not two of each.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-index-race-"));
  try {
    const repositories = new RepositoryService();
    const { repository, revision } = await seedRepository(
      root,
      "race",
      repositories,
    );
    const counter = countBuilds(repositories);
    const service = new CodeIntelligenceService(repositories);

    const [one, two, three] = await Promise.all([
      service.index(repository, revision),
      service.index(repository, revision),
      service.index(repository, revision),
    ]);

    assert.equal(counter.builds, 1);
    assert.deepEqual(two, one);
    assert.deepEqual(three, one);
    // Shared work, separate copies.
    one.files[0]?.symbols.push("mutated");
    assert.deepEqual(await service.index(repository, revision), two);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the cache bound evicts the oldest index once the service is long-lived", async () => {
  // Never exercised while every caller built its own service and threw it
  // away. A shared one accumulates, so the bound is what keeps a process that
  // indexes many repositories from growing without limit.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-index-evict-"));
  try {
    const repositories = new RepositoryService();
    const first = await seedRepository(root, "one", repositories);
    const second = await seedRepository(root, "two", repositories);
    const counter = countBuilds(repositories);
    const service = new CodeIntelligenceService(repositories, {
      maxCacheEntries: 1,
    });

    await service.index(first.repository, first.revision);
    assert.equal(counter.builds, 1);
    await service.index(second.repository, second.revision);
    assert.equal(counter.builds, 2);
    // The first entry was evicted to make room, so this one is paid for again.
    await service.index(first.repository, first.revision);
    assert.equal(counter.builds, 3);
    // And the one still held is free.
    await service.index(first.repository, first.revision);
    assert.equal(counter.builds, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Moves canonical on, the way a promotion does, from a working clone. */
async function advanceCanonical(
  source: string,
  repository: { path: string; branch: string },
): Promise<void> {
  await execFile("git", [
    "-C",
    source,
    "push",
    repository.path,
    `HEAD:${repository.branch}`,
  ]);
}

test("a revision that changed three files does not re-parse the rest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-incremental-"));
  try {
    const source = path.join(root, "source");
    const canonicalPath = path.join(root, "canonical.git");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    for (let n = 0; n < 12; n += 1) {
      await writeFile(
        path.join(source, "src", `mod_${String(n)}.ts`),
        `export function fn_${String(n)}() { return ${String(n)}; }\n`,
      );
    }
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      canonicalPath,
      "example",
    );
    const before = await repositories.getCanonicalVersion(repository);

    // A service that has read the repository once, as the coordinator's has
    // by the time anything lands.
    const warm = new CodeIntelligenceService(repositories);
    const first = await warm.index(repository, before.revision);
    assert.equal(first.files.length, 12);

    await writeFile(
      path.join(source, "src", "mod_0.ts"),
      "export function renamed() { return 0; }\n",
    );
    await repositories.commitAll(source, "change one file");
    await advanceCanonical(source, repository);
    const after = await repositories.getCanonicalVersion(repository);
    assert.notEqual(after.revision, before.revision);

    const advanced = await warm.index(repository, after.revision);
    // A service with no memory at all, at the same revision. The index is the
    // contract: reuse is an implementation detail and may not show up in it.
    const cold = new CodeIntelligenceService(repositories);
    const rebuilt = await cold.index(repository, after.revision);

    const comparable = (index: RepositoryIndex): string =>
      JSON.stringify({ ...index, generatedAt: "" });
    assert.equal(comparable(advanced), comparable(rebuilt));
    assert.ok(
      advanced.files
        .find((entry) => entry.path === "src/mod_0.ts")
        ?.symbols.includes("renamed"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file that moved is re-parsed, because its path is part of the parse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-moved-"));
  try {
    const source = path.join(root, "source");
    const canonicalPath = path.join(root, "canonical.git");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(
      path.join(source, "src", "here.ts"),
      "export function moved() { return 1; }\n",
    );
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      canonicalPath,
      "example",
    );
    const before = await repositories.getCanonicalVersion(repository);
    const service = new CodeIntelligenceService(repositories);
    await service.index(repository, before.revision);

    // Same bytes, different path. Keying the memory on contents alone would
    // hand this back still claiming to be `src/here.ts`.
    await rm(path.join(source, "src", "here.ts"));
    await writeFile(
      path.join(source, "src", "there.ts"),
      "export function moved() { return 1; }\n",
    );
    await repositories.commitAll(source, "move it");
    await advanceCanonical(source, repository);
    const after = await repositories.getCanonicalVersion(repository);

    const index = await service.index(repository, after.revision);
    assert.deepEqual(
      index.files.map((entry) => entry.path),
      ["src/there.ts"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parsing across threads produces exactly what one thread produces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-threads-"));
  try {
    const source = path.join(root, "source");
    const canonicalPath = path.join(root, "canonical.git");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    // Above PARALLEL_PARSE_THRESHOLD, or the pool is never reached and this
    // asserts nothing.
    for (let n = 0; n < 80; n += 1) {
      await writeFile(
        path.join(source, "src", `mod_${String(n)}.ts`),
        [
          `import { dep } from "./mod_${String((n + 1) % 80)}.js";`,
          `export interface Shape_${String(n)} { id: string }`,
          `export class Service_${String(n)} {`,
          `  route(app: { get: (p: string, h: unknown) => void }) {`,
          `    app.get("/thing_${String(n)}", dep);`,
          "  }",
          "}",
          `export function fn_${String(n)}() { return process.env.KEY_${String(n)}; }`,
        ].join("\n"),
      );
    }
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      canonicalPath,
      "example",
    );
    const { revision } = await repositories.getCanonicalVersion(repository);

    const threaded = new CodeIntelligenceService(repositories, {
      maxParseWorkers: 3,
    });
    await threaded.warmUp();
    const across = await threaded.index(repository, revision);

    // `maxParseWorkers: 1` is below the width the pool needs, so this one
    // never leaves its own thread.
    const single = new CodeIntelligenceService(repositories, {
      maxParseWorkers: 1,
    });
    await single.warmUp();
    const here = await single.index(repository, revision);

    const comparable = (index: RepositoryIndex): string =>
      JSON.stringify({ ...index, generatedAt: "" });
    assert.equal(comparable(across), comparable(here));
    assert.equal(across.files.length, 80);
    // Order is the part a split can silently lose: slots are claimed as the
    // budget loop runs and filled afterwards.
    assert.deepEqual(
      across.files.map((entry) => entry.path),
      here.files.map((entry) => entry.path),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interface reached through an alias is still a recorded reference", async () => {
  // The case that produced no relation at all. `implements AuditStore` used to
  // contribute nothing to the index, and `resolveImport` gives up on any
  // specifier that is not relative — so with a path alias the class and the
  // interface it implements were two unconnected modules, which is what the
  // decomposer splits and the conflict detector then scores at zero.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-heritage-"));
  try {
    const source = path.join(root, "source");
    const canonicalPath = path.join(root, "canonical.git");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(
      path.join(source, "src", "store.ts"),
      "export interface AuditStore { read(): void }\n",
    );
    await writeFile(
      path.join(source, "src", "postgres.ts"),
      [
        'import type { AuditStore } from "@app/store";',
        "export class PostgresStore implements AuditStore {",
        "  read() { return undefined; }",
        "}",
        "export function build() { return new PostgresStore(); }",
      ].join("\n"),
    );
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      canonicalPath,
      "aliased",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const index = await new CodeIntelligenceService(repositories).index(
      repository,
      version.revision,
    );
    const file = index.files.find((entry) => entry.path === "src/postgres.ts");
    assert.ok(file);
    assert.ok(
      file.referencedSymbols.includes("AuditStore"),
      "implements should be a reference",
    );
    assert.ok(
      file.referencedSymbols.includes("PostgresStore"),
      "new X() should be a reference",
    );
    // The alias really did fail to resolve — otherwise this test would be
    // passing on the import edge rather than on the change it is pinning.
    assert.equal(
      index.edges.find(
        (edge) =>
          edge.fromFile === "src/postgres.ts" && edge.resource === "@app/store",
      )?.toFile,
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan enrichment could not see through says so", async () => {
  // Every source `dependencies` draws on hangs off the declared files being in
  // the index. When none of them are, the result is indistinguishable from a
  // plan that depends on nothing — and downstream that reads as independence.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-blind-"));
  try {
    const source = path.join(root, "source");
    const canonicalPath = path.join(root, "canonical.git");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(
      path.join(source, "src", "util.ts"),
      "export function helper() { return true; }\n",
    );
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      canonicalPath,
      "blind",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const service = new CodeIntelligenceService(repositories);
    const index = await service.index(repository, version.revision);

    const base = {
      taskId: "task_1",
      objective: "add a module",
      expectedSymbols: [],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "low" as const,
    };
    const blind = service.enrichPlan(
      { ...base, expectedFiles: ["src/brand-new.ts"] },
      index,
    );
    assert.equal(blind.dependenciesUnknown, true);

    const seeing = service.enrichPlan(
      { ...base, expectedFiles: ["src/util.ts"] },
      index,
    );
    assert.equal(seeing.dependenciesUnknown, undefined);

    // A plan declaring nothing is not blind — it asked for nothing, which is a
    // different statement from asking for something unreadable.
    const empty = service.enrichPlan({ ...base, expectedFiles: [] }, index);
    assert.equal(empty.dependenciesUnknown, undefined);

    // Nor is a plan over files that never had an import graph to miss. Prose
    // has no dependencies, so an empty read set for it is the answer rather
    // than the absence of one — and treating it as blind would put every
    // documentation task on the pessimistic path for good.
    const prose = service.enrichPlan(
      { ...base, expectedFiles: ["docs/guide.md", "notes.txt"] },
      index,
    );
    assert.equal(prose.dependenciesUnknown, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a contract change and who was consuming it, across two revisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-contract-"));
  try {
    const source = path.join(root, "source");
    const canonicalPath = path.join(root, "canonical.git");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    // The shape of the whole problem in three files: one publishes a
    // contract, one imports it, one merely says the name.
    await writeFile(
      path.join(source, "src", "auth.ts"),
      "export function sign(password: string): string { return password; }\n",
    );
    await writeFile(
      path.join(source, "src", "login.ts"),
      'import { sign } from "./auth.js";\nexport const go = () => sign("secret");\n',
    );
    // Calls it without importing it — the name path, on its own.
    await writeFile(
      path.join(source, "src", "report.ts"),
      "export const summary = () => sign(1 as never);\n",
    );
    // Mentions the name and never calls it. Not a consumer, and this is the
    // edge of what the name path can see: nothing records a bare value
    // reference, so a file like this is caught only if it imported the file.
    await writeFile(
      path.join(source, "src", "docs.ts"),
      "export const note = `call sign() first`;\n",
    );
    await writeFile(path.join(source, "src", "idle.ts"), "export const idle = 1;\n");
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      canonicalPath,
      "contracts",
    );
    const service = new CodeIntelligenceService(repositories);
    const before = await service.index(
      repository,
      (await repositories.getCanonicalVersion(repository)).revision,
    );

    // A shape is read off the declaration, and it is the written one.
    const auth = before.files.find((file) => file.path === "src/auth.ts");
    assert.deepEqual(
      auth?.exportedShapes.map((shape) => [shape.symbol, shape.kind]),
      [["sign", "function"]],
    );
    // Readable, because this is what a warning shows somebody.
    assert.equal(auth?.exportedShapes[0]?.shape, "(password: string): string");
    assert.equal(auth?.exportedShapesUnknown, undefined);

    // Who depends on it, both ways in: `login.ts` imports the file, `docs.ts`
    // only mentions the name. Neither was reachable before — the edges were
    // only ever walked from a plan outwards to what it depends on.
    assert.deepEqual(
      service.consumersOf(before, { file: "src/auth.ts", symbol: "sign" }),
      ["src/login.ts", "src/report.ts"],
    );
    // The file itself is never its own consumer; an unrelated file is not
    // one; and neither is a file that only says the name in prose.
    for (const path_ of ["src/auth.ts", "src/idle.ts", "src/docs.ts"]) {
      assert.equal(
        service
          .consumersOf(before, { file: "src/auth.ts", symbol: "sign" })
          .includes(path_),
        false,
        path_,
      );
    }
    // Without a symbol it is the import edge alone, which is the certain half.
    assert.deepEqual(service.consumersOf(before, { file: "src/auth.ts" }), [
      "src/login.ts",
    ]);

    // Now the change git will not report: the type moves, the name does not.
    await writeFile(
      path.join(source, "src", "auth.ts"),
      "export function sign(password: number): string { return String(password); }\n",
    );
    await writeFile(
      path.join(source, "src", "idle.ts"),
      "export const idle = 2;\nexport function added(): void {}\n",
    );
    await repositories.commitAll(source, "retype");
    await advanceCanonical(source, repository);
    const after = await service.index(
      repository,
      (await repositories.getCanonicalVersion(repository)).revision,
    );

    const drift = service.contractDrift(before, after);
    assert.deepEqual(
      drift.map((change) => [change.file, change.symbol, change.consumers]),
      [["src/auth.ts", "sign", ["src/login.ts", "src/report.ts"]]],
    );
    assert.match(drift[0]?.before ?? "", /string/u);
    assert.match(drift[0]?.after ?? "", /number/u);
    // `added` arrived and `idle`'s value moved: neither is a contract change.
    // A mechanism that reported new exports would fire on every branch.
    assert.equal(drift.length, 1);

    // And what a branch claim records when this lands on it.
    assert.deepEqual(
      service
        .shapesIn(["src/auth.ts"], after)
        .map((shape) => [shape.file, shape.symbol]),
      [["src/auth.ts", "sign"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a language whose shapes cannot be read says so rather than reporting stability", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-unshaped-"));
  try {
    const source = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    // Unreadable — a syntax error the interpreter refuses — so its contracts
    // cannot be read, and that is a different fact from "declares nothing":
    // an empty shape list read as "no contracts here" would report this file
    // as unchanging through every rewrite it ever gets.
    await writeFile(
      path.join(source, "service.py"),
      "def sign(password: str -> str:\n    return password\n",
    );
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "unshaped",
    );
    const service = new CodeIntelligenceService(repositories);
    const index = await service.index(
      repository,
      (await repositories.getCanonicalVersion(repository)).revision,
    );
    const file = index.files.find((entry) => entry.path === "service.py");
    assert.deepEqual(file?.exportedShapes, []);
    assert.equal(file?.exportedShapesUnknown, true);

    // And the drift comparison leaves it out entirely rather than treating
    // "unknown" as "unchanged".
    assert.deepEqual(service.contractDrift(index, index), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("what a branch is built on that canonical has moved under it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-stale-"));
  try {
    const source = path.join(root, "source");
    const canonicalPath = path.join(root, "canonical.git");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(
      path.join(source, "src", "auth.ts"),
      "export function sign(password: string): string { return password; }\n",
    );
    await writeFile(
      path.join(source, "src", "login.ts"),
      'import { sign } from "./auth.js";\nexport const go = () => sign("secret");\n',
    );
    await writeFile(
      path.join(source, "src", "unrelated.ts"),
      "export const spacing = 4;\n",
    );
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      canonicalPath,
      "stale",
    );
    // Where the branch cut.
    const mergeBase = (await repositories.getCanonicalVersion(repository))
      .revision;

    // Canonical moves: `sign` now takes a number. Nothing about the name
    // changes, so nothing textual will disagree with anybody.
    await writeFile(
      path.join(source, "src", "auth.ts"),
      "export function sign(password: number): string { return String(password); }\n",
    );
    await writeFile(
      path.join(source, "src", "unrelated.ts"),
      "export const spacing = 8;\n",
    );
    await repositories.commitAll(source, "retype sign");
    await advanceCanonical(source, repository);
    const baseHead = (await repositories.getCanonicalVersion(repository))
      .revision;

    const service = new CodeIntelligenceService(repositories);

    // A branch that edited the consumer. This is the whole case: two clean
    // diffs, no shared file, no shared symbol name, and a merge that
    // compiles on neither side afterwards.
    assert.deepEqual(
      await service.staleContracts(repository, {
        mergeBase,
        baseHead,
        files: ["src/login.ts"],
      }),
      [
        {
          file: "src/auth.ts",
          symbol: "sign",
          before: "(password: string): string",
          after: "(password: number): string",
          through: "src/login.ts",
        },
      ],
    );

    // A branch that touched something else is not held up by it. A contract
    // moving on canonical is an ordinary landing; reporting it to everybody
    // would make every merge wait on every other merge.
    assert.deepEqual(
      await service.staleContracts(repository, {
        mergeBase,
        baseHead,
        files: ["src/unrelated.ts"],
      }),
      [],
    );

    // And the property that makes this a gate rather than a wall: once the
    // branch has the change, the base is past it and the answer empties.
    // Read as "the branch brought the latest in" — its merge base is now
    // canonical's tip.
    assert.deepEqual(
      await service.staleContracts(repository, {
        mergeBase: baseHead,
        baseHead,
        files: ["src/login.ts"],
      }),
      [],
    );

    // The revisions are not interchangeable, which is the thing most easily
    // got backwards: comparing canonical against the base asks "what did
    // this branch's base have that canonical lost", which is a different
    // question with a different answer.
    const backwards = await service.staleContracts(repository, {
      mergeBase: baseHead,
      baseHead: mergeBase,
      files: ["src/login.ts"],
    });
    assert.equal(backwards[0]?.after, "(password: string): string");
    assert.equal(backwards[0]?.before, "(password: number): string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Python repository has a dependency graph, and consumers can be found in it", async () => {
  // Until this existed, every non-TypeScript file was indexed with
  // `imports: []`. The graph was empty, so `consumersOf` — "who am I about
  // to break" — returned nothing for a Python repository, and the contract
  // layer above it was inert. Nothing said so: the index set a flag meaning
  // "I could not read this file's contract" and nothing above it read the
  // flag.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-pyindex-"));
  try {
    const source = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "billing"), { recursive: true });
    await writeFile(path.join(source, "billing", "__init__.py"), "");
    await writeFile(
      path.join(source, "billing", "money.py"),
      "def charge(amount):\n    return amount\n",
    );
    await writeFile(
      path.join(source, "billing", "api.py"),
      [
        "import os",
        "from .money import charge",
        "",
        'KEY = os.environ["STRIPE_KEY"]',
        "",
        "class PaymentService:",
        "    pass",
        "",
        '@app.post("/charge")',
        "def handler(request):",
        "    return charge(request['amount'])",
      ].join("\n"),
    );
    // A line that looks exactly like an import and is not one. A scanner
    // would have to decide; the interpreter already did.
    await writeFile(
      path.join(source, "billing", "docs.py"),
      ['"""', "from .money import charge", '"""', "", "VALUE = 1", ""].join("\n"),
    );
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "pyexample",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const service = new CodeIntelligenceService(repositories);
    const index = await service.index(repository, version.revision);

    const api = index.files.find((entry) => entry.path === "billing/api.py");
    assert.ok(api, "billing/api.py should be indexed");
    // The relative import resolved to the file it names.
    assert.equal(
      index.edges.find(
        (edge) =>
          edge.fromFile === "billing/api.py" &&
          edge.toFile === "billing/money.py",
      )?.kind,
      "import",
      "the import edge to money.py should exist",
    );
    // And the question the whole graph exists to answer.
    assert.deepEqual(
      service.consumersOf(index, { file: "billing/money.py" }),
      ["billing/api.py"],
    );
    // `import os` is the standard library and resolves to nothing, which is
    // the ordinary case and carries no suspicion.
    assert.equal(
      index.edges.some(
        (edge) => edge.fromFile === "billing/api.py" && edge.toFile === "os",
      ),
      false,
    );
    // The docstring is not an import. This is the false edge that matters:
    // it would make a branch editing money.py contend with a file that only
    // mentions it in prose.
    assert.equal(
      index.edges.some(
        (edge) =>
          edge.fromFile === "billing/docs.py" &&
          edge.toFile === "billing/money.py",
      ),
      false,
      "a docstring must not produce a dependency",
    );

    // And the resources the cross-branch guard reads. This is the whole
    // point: `claimCrossesBranches` compares routes, schemas, config keys and
    // services, so a language that produced none of them had a branch that
    // never crossed — a blanket claim that was never refused on its account,
    // however far it reached into another branch's contract.
    const changed = service.changedResources(["billing/api.py"], index);
    assert.deepEqual(changed.apis, ["POST /charge"]);
    assert.deepEqual(changed.configKeys, ["STRIPE_KEY"]);
    assert.deepEqual(changed.services, ["PaymentService"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Go repository resolves a package to every file in it", async () => {
  // A Go import names a directory, so one specifier is several edges — the
  // reason resolution answers with a list. And none of it works without
  // go.mod: a module's own import path is written there and nowhere else, so
  // a repository whose go.mod is never read has no resolvable Go imports at
  // all.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-goindex-"));
  try {
    const source = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await writeFile(path.join(source, "go.mod"), "module example.com/m\n\ngo 1.22\n");
    await mkdir(path.join(source, "billing"), { recursive: true });
    await writeFile(
      path.join(source, "billing", "money.go"),
      "package billing\n\nfunc Charge(amount int) int {\n\treturn amount\n}\n",
    );
    await writeFile(
      path.join(source, "billing", "doc.go"),
      "package billing\n\n// Package billing does things.\n",
    );
    await writeFile(
      path.join(source, "billing", "money_test.go"),
      "package billing\n\nfunc TestCharge(t *testing.T) {}\n",
    );
    await mkdir(path.join(source, "cmd", "app"), { recursive: true });
    await writeFile(
      path.join(source, "cmd", "app", "main.go"),
      [
        "package main",
        "",
        "import (",
        '\t"fmt"',
        '\t"example.com/m/billing"',
        ")",
        "",
        "func main() { fmt.Println(billing.Charge(1)) }",
      ].join("\n"),
    );
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "goexample",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const index = await new CodeIntelligenceService(repositories).index(
      repository,
      version.revision,
    );

    const from = "cmd/app/main.go";
    const targets = index.edges
      .filter((edge) => edge.fromFile === from && edge.toFile !== undefined)
      .map((edge) => edge.toFile)
      .sort();
    // Both members of the package, and never the test file: an importer
    // cannot see a `_test.go`, so an edge to one is always false.
    assert.deepEqual(targets, ["billing/doc.go", "billing/money.go"]);
    // `fmt` is the standard library and resolves to nothing, which is the
    // ordinary answer for anything not in this repository.
    assert.equal(
      index.edges.some(
        (edge) => edge.fromFile === from && edge.toFile?.startsWith("fmt"),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Kotlin repository resolves an import to the file declaring the type", async () => {
  // A JVM import names a type, and the package is a namespace rather than a
  // directory — Kotlin especially, where a file's name and location have
  // nothing to do with what it declares. The only honest way to resolve one
  // is to read every file first and look the name up.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-jvmindex-"));
  try {
    const source = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "app", "money"), { recursive: true });
    // Deliberately not `Money.kt`, and deliberately not under a directory
    // matching its package.
    await writeFile(
      path.join(source, "app", "money", "helpers.kt"),
      [
        "package com.acme.util",
        "",
        "class Money(val amount: Int) {",
        "    class Builder {",
        "        fun build() = Money(0)",
        "    }",
        "}",
      ].join("\n"),
    );
    await mkdir(path.join(source, "app", "main"), { recursive: true });
    await writeFile(
      path.join(source, "app", "main", "Entry.kt"),
      [
        "package com.acme.app",
        "",
        "import com.acme.util.Money",
        "",
        "class Entry {",
        "    fun run() = Money(1)",
        "}",
      ].join("\n"),
    );
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "kotlinexample",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const service = new CodeIntelligenceService(repositories);
    const index = await service.index(repository, version.revision);

    assert.equal(
      index.edges.find(
        (edge) =>
          edge.fromFile === "app/main/Entry.kt" && edge.toFile !== undefined,
      )?.toFile,
      "app/money/helpers.kt",
    );
    assert.deepEqual(
      service.consumersOf(index, { file: "app/money/helpers.kt" }),
      ["app/main/Entry.kt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every scanned language puts its imports into the graph, not just its reader's tests", async () => {
  // The readers and resolvers each have a unit suite, and PHP's passed while
  // no PHP file ever got an import: its branch in the scan loop sat behind
  // the brace-language branch that already matched it, and was dead. This
  // goes through the front door for every language whose resolution the
  // unit suites cover, one repository, one edge each, so a wiring mistake
  // fails here even when every piece it wires is fine.
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-wiring-"));
  try {
    const source = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    const files: Record<string, string> = {
      "rb/lib/greeter.rb": "class Greeter\nend\n",
      "rb/lib/app.rb": 'require_relative "greeter"\nclass App\nend\n',
      "php/src/Money.php": "<?php\nnamespace Acme;\nclass Money {}\n",
      "php/src/App.php":
        "<?php\nnamespace Acme\\App;\nuse Acme\\Money;\nclass App {}\n",
      // A crate root is only a crate root beside a manifest.
      "rs/Cargo.toml": '[package]\nname = "rs"\n',
      "rs/src/lib.rs": "mod util;\n",
      "rs/src/util.rs": "pub fn util() {}\n",
      "c/main.c": '#include "util.h"\nint main(void) { return util(); }\n',
      "c/util.h": "int util(void);\n",
      "cpp/main.cpp": '#include "lib.hpp"\nint main() { return 0; }\n',
      "cpp/lib.hpp": "int lib();\n",
      "cs/Program.cs": '#load "Helpers.cs"\nclass Program {}\n',
      "cs/Helpers.cs": "static class Helpers {}\n",
      "java/util/Money.java": "package com.acme.util;\npublic class Money {}\n",
      "java/app/Main.java":
        "package com.acme.app;\nimport com.acme.util.Money;\npublic class Main {}\n",
      "scala/util/Money.scala": "package com.acme.sutil\nobject Money {}\n",
      "scala/app/Main.scala":
        "package com.acme.sapp\nimport com.acme.sutil.Money\nobject Main {}\n",
    };
    for (const [relative, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
      await writeFile(path.join(source, relative), text);
    }
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "wiring",
    );
    const version = await repositories.getCanonicalVersion(repository);
    const service = new CodeIntelligenceService(repositories);
    const index = await service.index(repository, version.revision);

    const expected: Array<[string, string]> = [
      ["rb/lib/app.rb", "rb/lib/greeter.rb"],
      ["php/src/App.php", "php/src/Money.php"],
      ["rs/src/lib.rs", "rs/src/util.rs"],
      ["c/main.c", "c/util.h"],
      ["cpp/main.cpp", "cpp/lib.hpp"],
      ["cs/Program.cs", "cs/Helpers.cs"],
      ["java/app/Main.java", "java/util/Money.java"],
      ["scala/app/Main.scala", "scala/util/Money.scala"],
    ];
    const missing = expected.filter(
      ([from, to]) =>
        !index.edges.some(
          (edge) =>
            edge.kind === "import" && edge.fromFile === from && edge.toFile === to,
        ),
    );
    assert.deepEqual(missing, [], "every language's import should become an edge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Two builds of one repository by the same service, the second with every
 * source file already in the parse cache, plus a cold service's view of the
 * second revision for comparison.
 */
async function warmAndCold(
  files: Record<string, string>,
  name: string,
): Promise<{ warm: RepositoryIndex; cold: RepositoryIndex }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `coord-${name}-`));
  try {
    const source = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(source);
    for (const [relative, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
      await writeFile(path.join(source, relative), text);
    }
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      name,
    );
    const service = new CodeIntelligenceService(repositories);
    await service.index(
      repository,
      (await repositories.getCanonicalVersion(repository)).revision,
    );
    // A revision that touches no source, so every blob is served from cache.
    await writeFile(path.join(source, "README.md"), "touched\n");
    await repositories.commitAll(source, "docs");
    await execFile("git", ["-C", source, "push", "-q", repository.path, "main:main"]);
    const second = (await repositories.getCanonicalVersion(repository)).revision;
    return {
      warm: await service.index(repository, second),
      cold: await new CodeIntelligenceService(repositories).index(repository, second),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const edgeLines = (index: RepositoryIndex): string[] =>
  index.edges
    .filter((edge) => edge.kind === "import")
    .map((edge) => `${edge.fromFile} -> ${edge.toFile ?? `(${edge.resource})`}`)
    .sort();

test("a build served from the parse cache resolves what a cold build resolves", async () => {
  // Resolution needs facts the scan loop learns — a Go package clause, a JVM
  // package, a PHP namespace, the interpreter's standard-library list — and
  // the loop is skipped for every file already in the cache. The first
  // version kept those facts beside the loop, so the second build in a
  // process lost nearly every Go, Kotlin and PHP edge and gained a false one
  // from `import json` to a file called json.py.
  const { warm, cold } = await warmAndCold(
    {
      "go.mod": "module example.com/m\n",
      "main.go": 'package main\n\nimport "example.com/m/billing"\n\nfunc main() { billing.Charge() }\n',
      "billing/money.go": "package billing\n\nfunc Charge() {}\n",
      "app/__init__.py": "",
      "app/main.py": "import json\nfrom . import x\n",
      "app/x.py": "VALUE = 1\n",
      "json.py": "TRAP = True\n",
      "kt/util/Money.kt": "package com.acme.util\n\nclass Money(val amount: Int) {}\n",
      "kt/app/Entry.kt": "package com.acme.app\n\nimport com.acme.util.Money\n\nclass Entry {\n    fun run() = Money(1)\n}\n",
      "php/src/Money.php": "<?php\nnamespace Acme;\nclass Money {}\n",
      "php/src/App.php": "<?php\nnamespace Acme\\App;\nuse Acme\\Money;\nclass App {}\n",
    },
    "warm",
  );
  const expected = [
    "app/main.py -> (json)",
    "app/main.py -> app/__init__.py",
    "app/main.py -> app/x.py",
    "kt/app/Entry.kt -> kt/util/Money.kt",
    "main.go -> billing/money.go",
    "php/src/App.php -> php/src/Money.php",
  ];
  assert.deepEqual(edgeLines(cold), expected);
  assert.deepEqual(edgeLines(warm), expected);
});

test("a transient interpreter failure is not cached as a file's contract", async () => {
  // The first build runs with a python3 that fails; the second, with the
  // interpreter back, touches no Python file. The placeholder from the first
  // build must not be what the second one serves.
  const fake = await mkdtemp(path.join(os.tmpdir(), "coord-fakepy-"));
  const originalPath = process.env["PATH"];
  try {
    await writeFile(path.join(fake, "python3"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const root = await mkdtemp(path.join(os.tmpdir(), "coord-poison-"));
    try {
      const source = path.join(root, "source");
      const repositories = new RepositoryService();
      await repositories.initializeWorkingRepository(source);
      await mkdir(path.join(source, "app"), { recursive: true });
      await writeFile(path.join(source, "app", "__init__.py"), "");
      await writeFile(path.join(source, "app", "main.py"), "from . import x\ndef f():\n    pass\n");
      await writeFile(path.join(source, "app", "x.py"), "VALUE = 1\n");
      await repositories.commitAll(source, "seed");
      const repository = await repositories.importLocalRepository(
        source,
        path.join(root, "canonical.git"),
        "poison",
      );
      const service = new CodeIntelligenceService(repositories);
      process.env["PATH"] = `${fake}${path.delimiter}${originalPath ?? ""}`;
      const first = await service.index(
        repository,
        (await repositories.getCanonicalVersion(repository)).revision,
      );
      process.env["PATH"] = originalPath;
      assert.equal(
        first.files.find((file) => file.path === "app/main.py")?.symbolRangesUnknown,
        true,
        "with no interpreter the file is unreadable, and says so",
      );
      await writeFile(path.join(source, "README.md"), "touched\n");
      await repositories.commitAll(source, "docs");
      await execFile("git", ["-C", source, "push", "-q", repository.path, "main:main"]);
      const second = await service.index(
        repository,
        (await repositories.getCanonicalVersion(repository)).revision,
      );
      const main = second.files.find((file) => file.path === "app/main.py");
      assert.deepEqual(main?.symbols, ["f"]);
      assert.equal(main?.symbolRangesUnknown, undefined);
      assert.ok(
        second.edges.some(
          (edge) => edge.fromFile === "app/main.py" && edge.toFile === "app/x.py",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    process.env["PATH"] = originalPath;
    await rm(fake, { recursive: true, force: true });
  }
});
