/**
 * The two schemas have to describe the same database.
 *
 * There are two migration lists — SQLite's and Postgres's — because the two
 * dialects disagree about enough (`IF NOT EXISTS` on a column, `BOOLEAN`
 * versus `INTEGER`, collations) that one list of statements could not run on
 * both. What they must never disagree about is *which* migrations exist.
 *
 * They did. Three migrations were added to SQLite and the columns were put
 * into Postgres's historical `CREATE TABLE` instead of into a new migration
 * of their own. A fresh Postgres database was fine, because it builds every
 * table from the top. A *live* one — which is what the hosted deployment is —
 * had already run that `CREATE TABLE` long ago, saw no migration numbered
 * above what it had, and simply never grew the columns. Every branch feature
 * would have failed there, on rows the tests never look at, with nothing in
 * either schema file looking wrong.
 *
 * So this compares the lists rather than the tables: a version present in one
 * and absent from the other is the whole bug, and it is cheap to see.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./schema.js";
import { POSTGRES_MIGRATIONS } from "./postgres-schema.js";

test("every migration exists in both dialects, once, in order", () => {
  const versionsOf = (migrations: readonly { version: number }[]): number[] =>
    migrations.map((migration) => migration.version);
  const sqlite = versionsOf(MIGRATIONS);
  const postgres = versionsOf(POSTGRES_MIGRATIONS);

  // Postgres starts at a baseline that folds SQLite's first several
  // migrations into one `CREATE TABLE` pass, because there was never a
  // Postgres database that predated it — nothing to migrate, so nothing to
  // replay. Below that line the two lists are deliberately different shapes
  // and comparing them says nothing; at and above it, every migration is a
  // change to a database that already exists on both.
  const baseline = Math.min(...postgres);
  assert.ok(baseline > 0, "Postgres has no migrations at all");

  // Named individually rather than as a set difference: "Postgres is missing
  // 58, 59, 60" is a sentence somebody can act on, and "these arrays differ"
  // is not.
  const missingFromPostgres = sqlite
    .filter((v) => v >= baseline)
    .filter((v) => !postgres.includes(v));
  assert.deepEqual(
    missingFromPostgres,
    [],
    `Postgres is missing migration(s) ${missingFromPostgres.join(", ")}. ` +
      "A column added only to Postgres's CREATE TABLE reaches a fresh " +
      "database and never reaches a live one.",
  );
  const missingFromSqlite = postgres.filter((v) => !sqlite.includes(v));
  assert.deepEqual(
    missingFromSqlite,
    [],
    `SQLite is missing migration(s) ${missingFromSqlite.join(", ")}.`,
  );

  // Applied in ascending order and each version used once, on both sides.
  // The runner compares against `MAX(version)` applied, so a list out of
  // order silently skips everything below its own high-water mark.
  for (const [dialect, versions] of [
    ["sqlite", sqlite],
    ["postgres", postgres],
  ] as const) {
    assert.deepEqual(
      versions,
      [...versions].sort((a, b) => a - b),
      `${dialect} migrations are not in ascending order`,
    );
    assert.equal(
      new Set(versions).size,
      versions.length,
      `${dialect} has two migrations sharing a version`,
    );
  }

  // And the constant every runner refuses a newer database against is the
  // real high-water mark rather than a number somebody has to remember to
  // bump.
  assert.equal(LATEST_SCHEMA_VERSION, Math.max(...sqlite));
  assert.equal(LATEST_SCHEMA_VERSION, Math.max(...postgres));
});

test("a migration means the same thing in both dialects", () => {
  const names = new Map(MIGRATIONS.map((m) => [m.version, m.name]));
  const baseline = Math.min(...POSTGRES_MIGRATIONS.map((m) => m.version));
  for (const migration of POSTGRES_MIGRATIONS) {
    if (migration.version === baseline) {
      // The baseline is several of SQLite's migrations at once and shares a
      // number with only the last of them, so it has a name of its own.
      continue;
    }
    // The name is the only description either list carries, so two
    // migrations sharing a number and meaning different things is a mistake
    // nothing else would catch — and one that would apply cleanly on both
    // backends while leaving them describing different databases.
    assert.equal(
      migration.name,
      names.get(migration.version),
      `migration ${migration.version} is "${migration.name}" in Postgres ` +
        `and "${names.get(migration.version) ?? "absent"}" in SQLite`,
    );
    assert.ok(
      migration.statements.length > 0,
      `migration ${migration.version} has no statements`,
    );
  }
});
