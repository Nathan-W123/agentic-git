import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";
import type { AgentPlan } from "@coord/shared-types";

import { CodeIntelligenceService } from "./index.js";

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
 * `listFiles` is called exactly once per build, so this counts the builds the
 * cache is supposed to have made unnecessary as well as the ones it allowed.
 */
function countBuilds(repositories: RepositoryService): { builds: number } {
  const counter = { builds: 0 };
  const listFiles = repositories.listFiles.bind(repositories);
  (repositories as unknown as { listFiles: typeof listFiles }).listFiles =
    async (...args: Parameters<typeof listFiles>) => {
      counter.builds += 1;
      return await listFiles(...args);
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
