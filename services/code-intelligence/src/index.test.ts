import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
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
      // Named without an extension, and spelt without the usual one.
      "Rakefile": 'require_relative "rb/lib/greeter"\n',
      "tpl/view.phtml": "<?php require 'inc/conf.inc'; ?>\n",
      "tpl/inc/conf.inc": "<?php\n$x = 1;\n",
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
      ["Rakefile", "rb/lib/greeter.rb"],
      ["tpl/view.phtml", "tpl/inc/conf.inc"],
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

/** A repository seeded with `files`, and a way to advance it one commit. */
/** What a seeded file holds: text, raw bytes, or a link to another path. */
type SeededFile = string | Buffer | { symlink: string };

async function seededRepository(files: Record<string, SeededFile>, name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `coord-${name}-`));
  const source = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(source);
  const write = async (entries: Record<string, SeededFile>) => {
    for (const [relative, content] of Object.entries(entries)) {
      await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
      if (typeof content === "object" && !Buffer.isBuffer(content)) {
        await symlink(content.symlink, path.join(source, relative));
      } else {
        await writeFile(path.join(source, relative), content);
      }
    }
  };
  await write(files);
  await repositories.commitAll(source, "seed");
  const repository = await repositories.importLocalRepository(
    source,
    path.join(root, "canonical.git"),
    name,
  );
  const revision = (await repositories.getCanonicalVersion(repository)).revision;
  const advance = async (entries: Record<string, SeededFile>, message: string) => {
    await write(entries);
    await repositories.commitAll(source, message);
    await execFile("git", ["-C", source, "push", "-q", repository.path, "main:main"]);
    return (await repositories.getCanonicalVersion(repository)).revision;
  };
  return {
    repositories,
    repository,
    revision,
    source,
    advance,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test("a file the reader refuses at canonical's tip is unknown there, not removed", async () => {
  // Readable at the merge base, unreadable at the tip: the Python file gains
  // a syntax error, the Ruby one a construct the scanner does not follow.
  // The old comparison dropped unreadable files from `after`, which made
  // "could not read" look exactly like "deleted", and every contract the
  // file had was reported as removed and pushed to its consumers.
  const repo = await seededRepository(
    {
      "billing/__init__.py": "",
      "billing/money.py": "class Money:\n    def add(self, other: int) -> 'Money':\n        return self\n\ndef parse(x: int) -> int:\n    return x\n",
      "billing/app.py": "from billing.money import Money, parse\n",
      "lib/money.rb": "class Money\n  def initialize(amount)\n    @amount = amount\n  end\nend\n",
      "lib/app.rb": 'require_relative "money"\n',
      "lib/gone.rb": "class Gone\n  def away(x)\n  end\nend\n",
      "lib/keeps.rb": 'require_relative "gone"\n',
    },
    "unreadable-after",
  );
  try {
    const service = new CodeIntelligenceService(repo.repositories);
    const before = await service.index(repo.repository, repo.revision);
    await rm(path.join(repo.source, "lib", "gone.rb"));
    const tip = await repo.advance(
      {
        "billing/money.py": "class Money:\n    def add(self, other: int) -> 'Money':\n        return self\n\ndef parse(x: int) -> int:\n    return (x\n",
        "lib/money.rb": "class Money\n  def initialize(amount)\n    while amount\n  end\nend\n",
      },
      "break the readers, delete a file",
    );
    const after = await service.index(repo.repository, tip);
    for (const file of ["billing/money.py", "lib/money.rb"]) {
      assert.equal(after.files.find((entry) => entry.path === file)?.exportedShapesUnknown, true, file);
    }
    // Only the file that is actually gone has taken its contracts with it.
    const drift = service.contractDrift(before, after);
    assert.deepEqual(
      drift.map((change) => [change.file, change.symbol, change.after, change.consumers]),
      [
        ["lib/gone.rb", "away", "(removed)", ["lib/keeps.rb"]],
        ["lib/gone.rb", "Gone", "(removed)", ["lib/keeps.rb"]],
      ],
    );
    const stale = await service.staleContracts(repo.repository, {
      mergeBase: repo.revision,
      baseHead: tip,
      files: ["billing/app.py", "lib/app.rb", "lib/keeps.rb"],
    });
    assert.deepEqual(stale.map((entry) => entry.file), ["lib/gone.rb", "lib/gone.rb"]);
    // The mirror image — unreadable at the base, readable at the tip — has
    // nothing to compare against and reports nothing either.
    assert.deepEqual(service.contractDrift(after, before), []);
  } finally {
    await repo.dispose();
  }
});

test("a file the parse cache lost mid-build is unreadable, not empty, and is not remembered", async () => {
  // Two builds overlap and the cache is at capacity, so an entry present at
  // the chunk's pre-check is gone by the per-entry lookup. The first version
  // then indexed the file as empty — no symbols, no unknown flag — and
  // remembered that under the real blob, so every later build served it and
  // contractDrift reported every export as removed.
  const repo = await seededRepository(
    {
      "a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "b.ts": "export const b = 1;\nexport function bee() { return 2; }\n",
    },
    "evict",
  );
  try {
    const service = new CodeIntelligenceService(repo.repositories, { maxParsedFiles: 1 });
    await service.index(repo.repository, repo.revision);
    const r2 = await repo.advance({ "README.md": "1\n" }, "r2");
    const r3 = await repo.advance({ "README.md": "2\n" }, "r3");
    const overlapping = await Promise.all([
      service.index(repo.repository, r2),
      service.index(repo.repository, r3),
    ]);
    for (const index of overlapping) {
      for (const file of index.files) {
        // Either read properly or marked unreadable; never "declares nothing".
        assert.ok(
          file.symbols.length > 0 || file.symbolRangesUnknown === true,
          `${file.path} must not be indexed as empty`,
        );
      }
    }
    const r4 = await repo.advance({ "README.md": "3\n" }, "r4");
    const later = await service.index(repo.repository, r4);
    assert.deepEqual(later.files.find((file) => file.path === "b.ts")?.symbols, ["b", "bee"]);
    assert.deepEqual(service.contractDrift(overlapping[0], later).map((change) => change.symbol), []);
  } finally {
    await repo.dispose();
  }
});

test("a file named with a backslash is indexed under its own name, never aliased onto another", async () => {
  const repo = await seededRepository(
    {
      "lone\\file.ts": "export const REAL_BACKSLASH = 1;\n",
      "bs/x/y.ts": "export const slash = 1;\n",
      "bs/x\\y.ts": "export const only_in_backslash_file = 1;\n",
      "user.ts": 'import { slash } from "./bs/x/y.js";\nexport const u = slash;\n',
    },
    "backslash",
  );
  try {
    const index = await new CodeIntelligenceService(repo.repositories).index(repo.repository, repo.revision);
    const paths = index.files.map((file) => file.path);
    assert.equal(new Set(paths).size, paths.length, "no path is indexed twice");
    assert.ok(paths.includes("lone\\file.ts"));
    assert.ok(!paths.includes("lone/file.ts"));
    assert.deepEqual(
      index.files.find((file) => file.path === "bs/x\\y.ts")?.exportedSymbols,
      ["only_in_backslash_file"],
    );
    assert.deepEqual(
      index.files.find((file) => file.path === "bs/x/y.ts")?.exportedSymbols,
      ["slash"],
    );
  } finally {
    await repo.dispose();
  }
});

test("a manifest is not charged against the budgets that bound the index", async () => {
  const goMod = `module example.com/m\n\ngo 1.22\n\nrequire (\n${Array.from(
    { length: 60 },
    (_, i) => `\texample.org/dep${i} v1.0.${i}\n`,
  ).join("")})\n`;
  const repo = await seededRepository(
    {
      "go.mod": goMod,
      "app/main.go": 'package main\n\nimport "example.com/m/billing"\n\nfunc main() { billing.Charge() }\n',
      "billing/money.go": "package billing\n\nfunc Charge() {}\n",
    },
    "budget",
  );
  try {
    for (const options of [{ maxFileBytes: 512 }, { maxFiles: 2 }, { maxTotalBytes: 400 }]) {
      const index = await new CodeIntelligenceService(repo.repositories, options).index(
        repo.repository,
        repo.revision,
      );
      assert.ok(
        index.edges.some(
          (edge) => edge.fromFile === "app/main.go" && edge.toFile === "billing/money.go",
        ),
        `${JSON.stringify(options)}: go.mod must still be read`,
      );
    }
  } finally {
    await repo.dispose();
  }
});

test("one dependency imported several ways is one edge, and a specifier is shown as written", async () => {
  const repo = await seededRepository(
    {
      "src/dir/index.ts": "export const d = 1;\n",
      "src/useDir.ts": 'import { d } from "./dir";\nimport "./dir/";\nimport "./dir/index";\nimport "./dir/index.js";\nexport const ud = d;\n',
      "go.mod": "module example.com/m\n",
      "main.go": 'package main\n\nimport (\n\ta "example.com/m/billing"\n\tb "example.com/m/billing"\n)\n\nfunc main() { a.Charge(); b.Charge() }\n',
      "billing/money.go": "package billing\n\nfunc Charge() {}\n",
      "lib/app.rb": "require 'json'\nrequire_relative 'zzz'\n",
      "src/main.rs": "mod nothere;\nuse serde::Serialize;\n",
      "Cargo.toml": '[package]\nname = "x"\n',
      "php/A.php": "<?php\nuse Vendor\\Thing;\nrequire 'nope.php';\n",
    },
    "dupes",
  );
  try {
    const index = await new CodeIntelligenceService(repo.repositories).index(repo.repository, repo.revision);
    const to = (from: string, target: string) =>
      index.edges.filter((edge) => edge.fromFile === from && edge.toFile === target).length;
    assert.equal(to("src/useDir.ts", "src/dir/index.ts"), 1);
    assert.equal(to("main.go", "billing/money.go"), 1);
    assert.deepEqual(index.files.find((file) => file.path === "main.go")?.imports, ["example.com/m/billing"]);
    // Ruby, Rust and PHP carry how each import was written beside it, not
    // inside it: the specifier the index shows is the one the file wrote.
    const imports = (file: string) => index.files.find((entry) => entry.path === file)?.imports;
    assert.deepEqual(imports("lib/app.rb"), ["json", "zzz"]);
    assert.deepEqual(imports("src/main.rs"), ["nothere", "serde::Serialize"]);
    assert.deepEqual(imports("php/A.php"), ["Vendor\\Thing", "nope.php"]);
    const unresolved = index.edges
      .filter((edge) => edge.kind === "import" && edge.toFile === undefined)
      .map((edge) => edge.resource);
    assert.ok(unresolved.includes("json") && unresolved.includes("nothere") && unresolved.includes("Vendor\\Thing"));
    assert.ok(!unresolved.some((resource) => /^(?:lib|rel|mod|use|req):/u.test(resource)));
    // And the kinds still steer resolution: require_relative found its file.
    assert.deepEqual(index.files.find((file) => file.path === "lib/app.rb")?.dependencies, ["json", "zzz"]);
  } finally {
    await repo.dispose();
  }
});

test("a script import resolves the way TypeScript resolves it", async () => {
  const repo = await seededRepository(
    {
      "src/both.js": "module.exports = 1;\n",
      "src/both.ts": "export const both = 1;\n",
      "src/useBoth.ts": 'import { both } from "./both.js";\nexport const ub = both;\n',
      "src/onlym.mts": "export const m = 1;\n",
      "src/useOnlym.ts": 'import { m } from "./onlym.mjs";\nimport { m as m2 } from "./onlym";\nexport const um = m;\n',
      "src/script": "#!/bin/sh\necho hi\n",
      "src/useScript.ts": 'import "./script";\nexport const us = 1;\n',
      "index.ts": "export const rootIndex = 1;\n",
      "root.ts": 'import ".";\nimport "./";\nimport "../outside.js";\nexport const r = 1;\n',
      ".ts": "trap\n",
      "src/styles.css": "body {}\n",
      "src/data.json": "{}",
      "src/useCss.ts": 'import "./styles.css";\nimport data from "./data.json";\nexport const uc = 1;\n',
    },
    "scriptres",
  );
  try {
    const index = await new CodeIntelligenceService(repo.repositories).index(repo.repository, repo.revision);
    const target = (from: string, resource: string) =>
      index.edges.find((edge) => edge.fromFile === from && (edge.resource === resource || edge.toFile === resource))?.toFile;
    // `./both.js` is the source beside the build output.
    assert.equal(target("src/useBoth.ts", "src/both.ts"), "src/both.ts");
    assert.equal(index.edges.some((edge) => edge.fromFile === "src/useBoth.ts" && edge.toFile === "src/both.js"), false);
    // `.mjs` is `.mts`; an extensionless specifier never is.
    assert.equal(target("src/useOnlym.ts", "src/onlym.mts"), "src/onlym.mts");
    assert.equal(index.edges.filter((edge) => edge.fromFile === "src/useOnlym.ts" && edge.toFile !== undefined).length, 1);
    // A file with no extension is not a module.
    assert.equal(index.edges.some((edge) => edge.fromFile === "src/useScript.ts" && edge.toFile !== undefined), false);
    // `.` from a root file is the root index; climbing out is nothing — and
    // never the dotfile called `.ts`.
    assert.equal(index.edges.filter((edge) => edge.fromFile === "root.ts" && edge.toFile === "index.ts").length, 1);
    assert.equal(index.edges.some((edge) => edge.fromFile === "root.ts" && edge.toFile === ".ts"), false);
    assert.equal(target("src/useCss.ts", "src/styles.css"), "src/styles.css");
    assert.equal(target("src/useCss.ts", "src/data.json"), "src/data.json");
  } finally {
    await repo.dispose();
  }
});

test("one script the parser cannot walk is one unreadable file, not a failed build", async () => {
  // A generated string table — thousands of terms joined with `+` — nests
  // deeper than the call stack allows, though the parser reads it fine. The
  // walk used to recurse, so this one file threw a RangeError out of
  // `index()` for the whole repository, on every build, and `staleContracts`
  // and every coordinator path built on it rejected with it.
  const line = "A".repeat(76);
  const table =
    'export const table = "" +\n' +
    Array.from({ length: 3000 }, () => `  "${line}" +`).join("\n") +
    '\n  "";\n';
  // Past what the parser itself can take: this one is unreadable, and must
  // say so rather than take the build down.
  const nested = `var s = ${"[".repeat(6000)}${"]".repeat(6000)};\n`;
  const files: Record<string, SeededFile> = {
    "vendor/table.ts": table,
    "vendor/nested.js": nested,
    "src/good.ts": "export function fine(a: number): string { return String(a); }\n",
    "src/user.ts": 'import { fine } from "./good.js";\nexport const u = fine(1);\n',
  };
  // Enough scripts that a warmed service hands the batch to its threads,
  // which must report one bad file the same way the calling thread does.
  for (let n = 0; n < 70; n += 1) {
    files[`src/mod_${String(n)}.ts`] = `export const m${String(n)} = ${String(n)};\n`;
  }
  const repo = await seededRepository(files, "deep");
  try {
    const single = new CodeIntelligenceService(repo.repositories, { maxParseWorkers: 1 });
    const index = await single.index(repo.repository, repo.revision);
    const read = index.files.find((file) => file.path === "vendor/table.ts");
    assert.equal(read?.symbolRangesUnknown, undefined, "a deep but legal file is read");
    assert.deepEqual(read?.exportedSymbols, ["table"]);
    const refused = index.files.find((file) => file.path === "vendor/nested.js");
    assert.equal(refused?.symbolRangesUnknown, true);
    assert.equal(refused?.exportedShapesUnknown, true);
    assert.equal(single.symbolRangesInFile(index, "vendor/nested.js"), undefined);
    assert.deepEqual(
      index.files.find((file) => file.path === "src/good.ts")?.exportedSymbols,
      ["fine"],
    );
    assert.ok(
      index.edges.some((edge) => edge.fromFile === "src/user.ts" && edge.toFile === "src/good.ts"),
    );

    const threaded = new CodeIntelligenceService(repo.repositories, { maxParseWorkers: 3 });
    await threaded.warmUp();
    const across = await threaded.index(repo.repository, repo.revision);
    const comparable = (entry: RepositoryIndex): string =>
      JSON.stringify({ ...entry, generatedAt: "" });
    assert.equal(comparable(across), comparable(index));

    // The refusal is this build's, not the blob's: a later build reads the
    // file again rather than serving the refusal from the parse cache.
    const r2 = await repo.advance({ "README.md": "docs\n" }, "docs");
    const later = await single.index(repo.repository, r2);
    assert.equal(
      later.files.find((file) => file.path === "vendor/table.ts")?.symbolRangesUnknown,
      undefined,
    );
    assert.deepEqual(
      await single.staleContracts(repo.repository, {
        mergeBase: repo.revision,
        baseHead: r2,
        files: ["src/user.ts"],
      }),
      [],
    );
  } finally {
    await repo.dispose();
  }
});

test("a budget that leaves out a second declaration of a name resolves the name to nothing", async () => {
  // Two files declaring one qualified name — a build-variant source set, a
  // vendored copy, a test double — is the case the resolvers refuse on
  // purpose: no way to say which one the importer compiles against. The
  // tables were rebuilt from the files the budget kept, so once the second
  // copy fell past `maxFiles` or over `maxFileBytes` the refusal turned into
  // a confident edge to the surviving copy. A budget may lose an edge and
  // must never add one.
  const files = {
    "php/a/App.php": "<?php\nnamespace Acme;\nuse Acme\\Money;\nclass App { public function run(Money $m) {} }\n",
    "php/b/Money.php": "<?php\nnamespace Acme;\nclass Money { public function amount(): int { return 1; } }\n",
    "php/z/Money.php": "<?php\nnamespace Acme;\nclass Money { public function amount(): int { return 2; } }\n",
    "kt/app/Entry.kt": "package com.acme.app\n\nimport com.acme.cfg.Config\n\nclass Entry { fun run() = Config() }\n",
    "kt/debug/Config.kt": "package com.acme.cfg\n\nclass Config { val debug = true }\n",
    "kt/release/Config.kt": "package com.acme.cfg\n\nclass Config { val debug = false }\n",
    "java/app/Main.java": "package com.acme.app;\nimport com.acme.cfg.Flags;\npublic class Main {}\n",
    "java/debug/Flags.java": "package com.acme.cfg;\npublic class Flags {}\n",
    "java/release/Flags.java": "package com.acme.cfg;\npublic class Flags {}\n",
  };
  const repo = await seededRepository(files, "budget-unique");
  try {
    const resolved = (index: RepositoryIndex): string[] =>
      index.edges
        .filter((edge) => edge.kind === "import" && edge.toFile !== undefined)
        .map((edge) => `${edge.fromFile} -> ${edge.toFile ?? ""}`)
        .sort();
    assert.deepEqual(
      resolved(await new CodeIntelligenceService(repo.repositories).index(repo.repository, repo.revision)),
      [],
      "with every file read, each name is declared twice and resolves to nothing",
    );
    // Sorted, the cutoffs drop php/z, then kt/release too, then java/release.
    for (const options of [{ maxFiles: 8 }, { maxFiles: 5 }, { maxFiles: 2 }]) {
      const limited = await new CodeIntelligenceService(repo.repositories, options).index(
        repo.repository,
        repo.revision,
      );
      assert.equal(limited.truncated, true);
      assert.deepEqual(resolved(limited), [], JSON.stringify(options));
    }
    const padded = await repo.advance(
      {
        "php/z/Money.php": `<?php\nnamespace Acme;\n${"// padding\n".repeat(200)}class Money {}\n`,
        "kt/release/Config.kt": `package com.acme.cfg\n\n${"// pad\n".repeat(300)}class Config\n`,
      },
      "pad",
    );
    const overSize = await new CodeIntelligenceService(repo.repositories, { maxFileBytes: 1500 }).index(
      repo.repository,
      padded,
    );
    assert.equal(overSize.truncated, true);
    assert.deepEqual(resolved(overSize), []);
  } finally {
    await repo.dispose();
  }

  // The rule is per language: a budget that leaves out a file in some other
  // language says nothing about whether a PHP name is unique, and the edge
  // stays.
  const unique = await seededRepository(
    {
      "php/a/App.php": "<?php\nnamespace Acme;\nuse Acme\\Money;\nclass App {}\n",
      "php/b/Money.php": "<?php\nnamespace Acme;\nclass Money {}\n",
      "zz/late.ts": "export const late = 1;\n",
    },
    "budget-other",
  );
  try {
    const index = await new CodeIntelligenceService(unique.repositories, { maxFiles: 2 }).index(
      unique.repository,
      unique.revision,
    );
    assert.equal(index.truncated, true);
    assert.ok(
      index.edges.some((edge) => edge.fromFile === "php/a/App.php" && edge.toFile === "php/b/Money.php"),
    );
  } finally {
    await unique.dispose();
  }
});

test("a file the budget left out at canonical's tip is unknown there, not removed", async () => {
  // Exactly `maxFiles` files fit at the merge base. Two unrelated files that
  // sort earlier are added, and a file nobody touched falls past the cutoff.
  // It is at the tip and unread there; the old comparison had nothing for
  // it in `after` and reported every contract in it as removed, through
  // every consumer, for a file that did not change.
  const files: Record<string, SeededFile> = {
    "src/m/lib.ts": "export function f(a: number): string { return String(a); }\nexport interface Shape { w: number }\n",
    "src/m/user.ts": 'import { f } from "./lib.js";\nexport const u = f(1);\n',
  };
  for (let n = 0; n < 6; n += 1) {
    files[`src/a/file${String(n)}.ts`] = `export const a${String(n)} = ${String(n)};\n`;
  }
  const repo = await seededRepository(files, "cutoff");
  try {
    const service = new CodeIntelligenceService(repo.repositories, { maxFiles: 8 });
    const before = await service.index(repo.repository, repo.revision);
    assert.equal(before.truncated, false);
    const r2 = await repo.advance(
      { "src/a/extra1.ts": "export const e1 = 1;\n", "src/a/extra2.ts": "export const e2 = 2;\n" },
      "grow",
    );
    const after = await service.index(repo.repository, r2);
    assert.equal(after.files.some((file) => file.path === "src/m/lib.ts"), false);
    assert.ok(after.paths.includes("src/m/lib.ts"));
    assert.deepEqual(service.contractDrift(before, after), []);
    assert.deepEqual(
      await service.staleContracts(repo.repository, {
        mergeBase: repo.revision,
        baseHead: r2,
        files: ["src/m/user.ts"],
      }),
      [],
    );
    // A file that really is gone is still reported as gone.
    const r3 = await repo.advance({ "src/a/file0.ts": "export const a0 = 0;\n" }, "same");
    await execFile("git", ["-C", repo.source, "rm", "-q", "src/a/file1.ts"]);
    const r4 = await repo.advance({}, "delete");
    assert.notEqual(r3, r4);
    const deleted = await service.index(repo.repository, r4);
    assert.deepEqual(
      service.contractDrift(before, deleted).map((change) => `${change.file}#${change.symbol} ${change.after}`),
      ["src/a/file1.ts#a1 (removed)"],
    );
  } finally {
    await repo.dispose();
  }
});

test("a symbolic link is unreadable, and an import through it lands nowhere", async () => {
  // Git lists a link as a blob whose contents are the target path, so the
  // index read `../src/foo.h` as a header and recorded one that declares
  // nothing — no unknown flag — with the consumer resolved onto the link.
  // The real header then had no consumers, and the link's empty contract
  // never moved.
  const repo = await seededRepository(
    {
      "src/foo.h": "int foo(int a);\nstruct Foo { int x; };\n",
      "include/foo.h": { symlink: "../src/foo.h" },
      "app/main.c": '#include "../include/foo.h"\nint main(void) { return foo(1); }\n',
      "shared/types.ts": "export interface User { id: string }\nexport function mk(): User { return { id: '' }; }\n",
      "pkg/a/src/types.ts": { symlink: "../../../shared/types.ts" },
      "pkg/a/src/use.ts": 'import { mk } from "./types.js";\nexport const u = mk();\n',
      "go.mod": "module example.com/m\n",
      "lib/real.go": "package lib\n\nfunc Real() {}\n",
      "lib/link.go": { symlink: "real.go" },
      "cmd/main.go": 'package main\n\nimport "example.com/m/lib"\n\nfunc main() { lib.Real() }\n',
      "Money.kt": "package com.acme\n\nclass Money(val amount: Int)\n",
      "kt/link/Money.kt": { symlink: "../../Money.kt" },
    },
    "symlink",
  );
  try {
    const service = new CodeIntelligenceService(repo.repositories);
    const index = await service.index(repo.repository, repo.revision);
    for (const link of ["include/foo.h", "pkg/a/src/types.ts", "lib/link.go", "kt/link/Money.kt"]) {
      const file = index.files.find((entry) => entry.path === link);
      assert.equal(file?.symbolRangesUnknown, true, link);
      assert.equal(file?.exportedShapesUnknown, true, link);
      assert.equal(service.symbolRangesInFile(index, link), undefined, link);
    }
    const resolved = index.edges
      .filter((edge) => edge.kind === "import" && edge.toFile !== undefined)
      .map((edge) => `${edge.fromFile} -> ${edge.toFile ?? ""}`)
      .sort();
    // The Go package resolves to the file in it and not to the link beside
    // it; the include and the script import name the link and so name
    // nothing this index can point at.
    assert.deepEqual(resolved, ["cmd/main.go -> lib/real.go"]);
    assert.ok(
      index.edges.some((edge) => edge.fromFile === "app/main.c" && edge.toFile === undefined),
      "the include is still recorded, unresolved",
    );
    assert.deepEqual(service.consumersOf(index, { file: "include/foo.h" }), []);
    // The real header is read under its own name, and the link is still a
    // path that exists.
    assert.deepEqual(index.files.find((entry) => entry.path === "src/foo.h")?.symbols, ["Foo"]);
    assert.ok(index.paths.includes("include/foo.h"));
  } finally {
    await repo.dispose();
  }
});

test("a UTF-16 source is decoded, a BOM does not hide the first line, and bytes that are not text are unreadable", async () => {
  // Visual Studio writes some .cs and .cpp files as UTF-16 with a byte-order
  // mark. Read as UTF-8 they were NUL-interleaved strings every scanner found
  // nothing in — "declares nothing", with no unknown flag — so a contract
  // change in such a file was invisible and a commit converting it to UTF-8
  // made every export appear. A UTF-8 BOM, handed to the scanners as-is,
  // glued itself to the first token and erased a line-1 declaration in
  // Rust, Swift, C++ and C#.
  const utf16 = (text: string): Buffer =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const utf16be = (text: string): Buffer =>
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
  const BOM = "﻿";
  const repo = await seededRepository(
    {
      "u16/Money.java": utf16("package com.acme.u16;\npublic class Money { public int amount; }\n"),
      "u16/main.cpp": utf16("class Big { public: int go(); };\nint main() { return 0; }\n"),
      "u16/a.ts": utf16("export const a = 1;\nexport function fa(x: number): string { return String(x); }\n"),
      "u16/m.py": utf16("def f(a: int) -> int:\n    return a\n"),
      "u16/Wide.swift": utf16be("struct Wide { var x: Int }\n"),
      "bom/util.rs": `${BOM}pub fn helper() -> i32 { 1 }\npub struct S { pub x: u32 }\n`,
      "bom/Point.swift": `${BOM}struct Point { var x: Int }\nfunc go(_ p: Point) -> Int { return p.x }\n`,
      "bom/lib.cpp": `${BOM}class Lib { public: int go(); };\n`,
      "bom/Program.cs": `${BOM}namespace Acme;\npublic class Program { public static void Main() {} }\n`,
      "plain/util.rs": "pub fn helper() -> i32 { 1 }\npub struct S { pub x: u32 }\n",
      // UTF-16 without a mark: NUL bytes, and no encoding this reads.
      "bad/nul.ts": Buffer.from("export const nul = 1;\n", "utf16le"),
      // Not UTF-8 at all.
      "bad/latin.ts": Buffer.concat([Buffer.from("export const caf"), Buffer.from([0xe9]), Buffer.from(" = 1;\n")]),
    },
    "encoding",
  );
  try {
    const service = new CodeIntelligenceService(repo.repositories);
    const index = await service.index(repo.repository, repo.revision);
    const symbolsOf = (file: string): string[] | undefined =>
      index.files.find((entry) => entry.path === file)?.symbols;
    assert.deepEqual(symbolsOf("u16/Money.java"), ["Money"]);
    assert.deepEqual(symbolsOf("u16/main.cpp"), ["Big"]);
    assert.deepEqual(symbolsOf("u16/a.ts"), ["a", "fa"]);
    assert.deepEqual(symbolsOf("u16/m.py"), ["f"]);
    assert.deepEqual(symbolsOf("u16/Wide.swift"), ["Wide"]);
    assert.deepEqual(symbolsOf("bom/util.rs"), ["helper", "S"]);
    assert.deepEqual(symbolsOf("bom/Point.swift"), ["Point", "go"]);
    assert.deepEqual(symbolsOf("bom/lib.cpp"), ["Lib"]);
    assert.deepEqual(symbolsOf("bom/Program.cs"), ["Program"]);
    // Identical contracts with and without the mark, which is what keeps a
    // commit that adds or drops one from moving anything.
    const shapesOf = (file: string): string[] | undefined =>
      index.files.find((entry) => entry.path === file)?.exportedShapes.map((shape) => shape.digest);
    assert.deepEqual(shapesOf("bom/util.rs"), shapesOf("plain/util.rs"));
    for (const bad of ["bad/nul.ts", "bad/latin.ts"]) {
      const file = index.files.find((entry) => entry.path === bad);
      assert.equal(file?.symbolRangesUnknown, true, bad);
      assert.equal(file?.exportedShapesUnknown, true, bad);
    }
  } finally {
    await repo.dispose();
  }
});

test("a manifest is read wherever the budget runs out", async () => {
  // Three hundred Go files sort before go.mod, and a budget small enough
  // that the chunk loop stops before the chunk holding it. The manifest was
  // read inside that loop, so whether a Go import resolved depended on which
  // 256-entry chunk go.mod fell in.
  const files: Record<string, SeededFile> = {
    "a/app/main.go": 'package main\n\nimport "example.com/m/a/p000"\n\nfunc main() { p000.F0() }\n',
    "go.mod": "module example.com/m\n",
  };
  for (let n = 0; n < 300; n += 1) {
    const id = String(n).padStart(3, "0");
    files[`a/p${id}/f.go`] = `package p${id}\n\nfunc F${String(n)}() {}\n`;
  }
  const repo = await seededRepository(files, "gomod-late");
  try {
    for (const options of [{ maxFiles: 100 }, { maxFiles: 260 }]) {
      const index = await new CodeIntelligenceService(repo.repositories, options).index(
        repo.repository,
        repo.revision,
      );
      assert.equal(index.truncated, true);
      assert.ok(
        index.edges.some((edge) => edge.fromFile === "a/app/main.go" && edge.toFile === "a/p000/f.go"),
        `${JSON.stringify(options)}: go.mod must be read`,
      );
    }
  } finally {
    await repo.dispose();
  }
});

test("which changed files an index could not read the contracts of", async () => {
  // The question the coordinator has to ask before comparing a branch's
  // shapes against canonical's: `shapesIn` answers from what the index
  // holds, and a file it holds nothing for looks exactly like a file with
  // nothing in it. Unreadable is: shapes or ranges unknown, or a source file
  // at this revision that never made it into `files`. Not unreadable is: a
  // file that is not at this revision, a file with no language, and a data
  // file whose unknown-shapes flag is structural.
  const fake = await mkdtemp(path.join(os.tmpdir(), "coord-fakepy-"));
  const originalPath = process.env["PATH"];
  const repo = await seededRepository(
    {
      "app/lib.py": "def f(a: int) -> int:\n    return a\n",
      "config.json": '{ "key": 1 }\n',
      "src/a.ts": "export const a = 1;\n",
      "README.md": "docs\n",
    },
    "unreadable",
  );
  try {
    await writeFile(path.join(fake, "python3"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    // Sorted: README.md, app/lib.py, config.json, src/a.ts — three slots
    // leave src/a.ts out.
    const service = new CodeIntelligenceService(repo.repositories, { maxFiles: 2 });
    process.env["PATH"] = `${fake}${path.delimiter}${originalPath ?? ""}`;
    const index = await service.index(repo.repository, repo.revision);
    process.env["PATH"] = originalPath;
    assert.equal(index.files.find((file) => file.path === "app/lib.py")?.exportedShapesUnknown, true);
    assert.deepEqual(
      service.unreadableIn(
        ["app/lib.py", "config.json", "src/a.ts", "README.md", "gone.ts"],
        index,
      ),
      ["app/lib.py", "src/a.ts"],
    );
    const readable = await new CodeIntelligenceService(repo.repositories).index(repo.repository, repo.revision);
    assert.deepEqual(service.unreadableIn(["app/lib.py", "config.json", "src/a.ts"], readable), []);
  } finally {
    process.env["PATH"] = originalPath;
    await rm(fake, { recursive: true, force: true });
    await repo.dispose();
  }
});

/**
 * A python3 that logs how many files each run was fed, refuses a run whose
 * payload names `poison`, and otherwise defers to the real interpreter.
 */
async function pythonShim(poison?: string): Promise<{ dir: string; spawns: () => Promise<number[]> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coord-pyshim-"));
  const log = path.join(dir, "spawns.log");
  const refuse = poison === undefined ? "" : `if grep -q '"${poison}"' "$tmp"; then exit 1; fi\n`;
  await writeFile(
    path.join(dir, "python3"),
    [
      "#!/bin/sh",
      `real=$(PATH="${process.env["PATH"] ?? ""}" command -v python3)`,
      "tmp=$(mktemp)",
      'cat > "$tmp"',
      `n=$("$real" -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$tmp")`,
      `echo "$n" >> "${log}"`,
      refuse,
      'exec "$real" "$@" < "$tmp"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(log, "");
  return {
    dir,
    spawns: async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map(Number),
  };
}

test("a Python batch that is lost loses its own files and no others", async () => {
  // One interpreter run answered for the whole repository, all or nothing,
  // against a fixed timeout that a budget-sized batch came within reach of.
  // Runs are bounded now, so a run that fails — here, refused by the shim —
  // is that run's files unknown, and every other file is read.
  const files: Record<string, SeededFile> = {};
  // Five files of 1.2 MB each: four fit the 5 MB bound, the fifth and the
  // poisoned file after it make a second run.
  for (let n = 0; n < 5; n += 1) {
    files[`pkg/big${String(n)}.py`] = `"""${"x".repeat(1_200_000)}"""\n\ndef f${String(n)}(a: int) -> int:\n    return a\n`;
  }
  files["pkg/zz_poison.py"] = "def poisoned() -> None:\n    pass\n";
  const repo = await seededRepository(files, "pybatch");
  const shim = await pythonShim("pkg/zz_poison.py");
  const originalPath = process.env["PATH"];
  try {
    process.env["PATH"] = `${shim.dir}${path.delimiter}${originalPath ?? ""}`;
    const index = await new CodeIntelligenceService(repo.repositories).index(repo.repository, repo.revision);
    process.env["PATH"] = originalPath;
    assert.deepEqual(await shim.spawns(), [4, 2]);
    for (let n = 0; n < 4; n += 1) {
      assert.deepEqual(index.files.find((file) => file.path === `pkg/big${String(n)}.py`)?.symbols, [`f${String(n)}`]);
    }
    for (const lost of ["pkg/big4.py", "pkg/zz_poison.py"]) {
      assert.equal(index.files.find((file) => file.path === lost)?.symbolRangesUnknown, true, lost);
    }
  } finally {
    process.env["PATH"] = originalPath;
    await rm(shim.dir, { recursive: true, force: true });
    await repo.dispose();
  }
});

test("two builds asking about the same Python blobs share one interpreter run", async () => {
  // Nothing is remembered until a build ends, so a cold `staleContracts` —
  // both revisions indexed at once — fed the whole corpus to two
  // interpreters at the same instant. A build that finds a blob already
  // being asked about joins that run.
  const files: Record<string, SeededFile> = { "README.md": "1\n", "pkg/__init__.py": "" };
  for (let n = 0; n < 8; n += 1) {
    files[`pkg/mod${String(n)}.py`] = `def f${String(n)}(a: int) -> int:\n    return a\n`;
  }
  files["pkg/user.py"] = "from .mod0 import f0\n\ndef g(): return f0(1)\n";
  const repo = await seededRepository(files, "pyshare");
  const shim = await pythonShim();
  const originalPath = process.env["PATH"];
  try {
    const r2 = await repo.advance({ "README.md": "2\n" }, "docs");
    process.env["PATH"] = `${shim.dir}${path.delimiter}${originalPath ?? ""}`;
    const service = new CodeIntelligenceService(repo.repositories);
    const stale = await service.staleContracts(repo.repository, {
      mergeBase: repo.revision,
      baseHead: r2,
      files: ["pkg/user.py"],
    });
    process.env["PATH"] = originalPath;
    assert.deepEqual(stale, []);
    assert.deepEqual(await shim.spawns(), [10]);
    // Both builds got the answer, not only the one that ran the interpreter.
    for (const revision of [repo.revision, r2]) {
      const index = await service.index(repo.repository, revision);
      assert.deepEqual(index.files.find((file) => file.path === "pkg/mod3.py")?.symbols, ["f3"]);
      assert.ok(index.edges.some((edge) => edge.fromFile === "pkg/user.py" && edge.toFile === "pkg/mod0.py"));
    }
  } finally {
    process.env["PATH"] = originalPath;
    await rm(shim.dir, { recursive: true, force: true });
    await repo.dispose();
  }
});
