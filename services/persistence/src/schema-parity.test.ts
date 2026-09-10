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

/* ------------------------------------------- migrations against their past */

/** A `CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table(columns)`. */
const INDEX_RE =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:WHERE|;|$)/giu;
/** A `CREATE TABLE [IF NOT EXISTS] name ( body )`. */
const TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*)\)/iu;
/** An `ALTER TABLE name ADD COLUMN [IF NOT EXISTS] column`. */
const ADD_COLUMN_RE =
  /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/giu;

/** Row-level constraint clauses, which are not columns however they parse. */
const NOT_A_COLUMN = new Set([
  "primary",
  "unique",
  "foreign",
  "check",
  "constraint",
  "exclude",
  "like",
]);

/** Splits a parenthesised list at its own commas, ignoring nested ones. */
function topLevelItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    }
    if (character === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

/** The column names a `CREATE TABLE` body declares. */
function declaredColumns(body: string): string[] {
  return topLevelItems(body)
    .map((item) => /^(\w+)/u.exec(item)?.[1] ?? "")
    .filter((name) => name !== "" && !NOT_A_COLUMN.has(name.toLowerCase()));
}

/**
 * Every index is built on columns that exist by the time it is built.
 *
 * The third way these two lists drift, after "a migration is missing" and "a
 * migration means something else": *an already-shipped migration is edited*.
 * It is the quietest of the three and it fails in both directions at once.
 *
 * It happened. A unique index on `sub_channels(repository_id, branch)` was
 * added to migration 49, which creates that table — nine migrations before 58
 * gives it a `branch` column. A live database had run 49 long ago, saw no new
 * version, and never built the index, so the rule stopping two channels
 * owning one branch was simply absent in production. And a database created
 * afterwards ran 49 from the top and died on `column "branch" does not
 * exist`, which meant no new deployment could boot at all. Neither schema
 * file looked wrong, and no test read the migration list in order.
 *
 * This does, without a server, in both dialects: walk the migrations in
 * version order accumulating what each table holds, and refuse an index over
 * a column that is not there yet. Expression indexes (`LOWER(email)`) are
 * skipped rather than half-parsed — they are rare, and a guard that guesses
 * at SQL is a guard that fails on correct code.
 */
for (const [dialect, migrations] of [
  ["sqlite", MIGRATIONS],
  ["postgres", POSTGRES_MIGRATIONS],
] as const) {
  test(`${dialect}: no migration indexes a column that does not exist yet`, () => {
    const columns = new Map<string, Map<string, number>>();
    const complaints: string[] = [];
    const ordered = [...migrations].sort((a, b) => a.version - b.version);

    for (const migration of ordered) {
      for (const statement of migration.statements) {
        const table = TABLE_RE.exec(statement);
        if (table !== null) {
          const known = columns.get(table[1] ?? "") ?? new Map<string, number>();
          for (const name of declaredColumns(table[2] ?? "")) {
            if (!known.has(name)) {
              known.set(name, migration.version);
            }
          }
          columns.set(table[1] ?? "", known);
        }
        ADD_COLUMN_RE.lastIndex = 0;
        for (const added of statement.matchAll(ADD_COLUMN_RE)) {
          const known = columns.get(added[1] ?? "") ?? new Map<string, number>();
          if (!known.has(added[2] ?? "")) {
            known.set(added[2] ?? "", migration.version);
          }
          columns.set(added[1] ?? "", known);
        }
      }

      // Indexes second, so an index created in the same migration as its
      // table is judged against that table — which is the common and correct
      // case, and the one the bug above was hiding among.
      for (const statement of migration.statements) {
        INDEX_RE.lastIndex = 0;
        for (const index of statement.matchAll(INDEX_RE)) {
          const [, name = "", table = "", list = ""] = index;
          const known = columns.get(table);
          if (known === undefined) {
            complaints.push(
              `migration ${String(migration.version)}: index ${name} is on ` +
                `${table}, which no migration up to here creates`,
            );
            continue;
          }
          for (const item of topLevelItems(list)) {
            // `LOWER(email)`, `(a || b)` and anything else with a call in it.
            // Skipped deliberately: see the note above.
            if (item.includes("(")) {
              continue;
            }
            const column = /^(\w+)/u.exec(item)?.[1] ?? "";
            if (column === "" || known.has(column)) {
              continue;
            }
            const later = ordered.find((candidate) =>
              candidate.statements.some(
                (text) =>
                  new RegExp(
                    `ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${column}\\b`,
                    "iu",
                  ).test(text),
              ),
            );
            complaints.push(
              `migration ${String(migration.version)}: index ${name} is on ` +
                `${table}.${column}, which ${
                  later === undefined
                    ? "no migration ever adds"
                    : `migration ${String(later.version)} adds — a database ` +
                      `that already ran ${String(migration.version)} will ` +
                      `never build this index, and a fresh one dies here`
                }`,
            );
          }
        }
      }
    }
    assert.deepEqual(complaints, [], `\n${complaints.join("\n")}\n`);
  });
}
