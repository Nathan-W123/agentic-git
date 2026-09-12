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

import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from "./schema.js";
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

/* --------------------------------------- the schema the two lists end with */

/**
 * The fourth way these lists drift, and the one no test above can see: they
 * both apply, both in the right order, with the same versions and the same
 * names — and describe two different databases.
 *
 * A column that exists on one backend and not the other is a feature that
 * works in development and 500s in production. A column that exists on both
 * but is nullable on one is a row that saves on SQLite and is rejected by
 * Postgres. A default of `0` against a default of `1` is worse than either,
 * because nothing fails: the two deployments simply disagree about what a
 * new row means, and neither can tell.
 *
 * So the migrations are replayed here — no server, no driver, just the
 * statements read in version order — and the two resulting schemas are
 * compared column by column and index by index.
 */

/** What one migration list leaves a column looking like. */
interface ColumnFacts {
  /** Everything after the column name in the statement that introduced it. */
  declaration: string;
  version: number;
}

type TableFacts = Map<string, ColumnFacts>;

/** A `DROP TABLE [IF EXISTS] name`. */
const DROP_TABLE_RE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/iu;
/** An `ALTER TABLE old RENAME TO new`. */
const RENAME_TABLE_RE = /ALTER\s+TABLE\s+(\w+)\s+RENAME\s+TO\s+(\w+)/iu;
/** An `ALTER TABLE name DROP COLUMN [IF EXISTS] column`. */
const DROP_COLUMN_RE =
  /ALTER\s+TABLE\s+(\w+)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(\w+)/iu;
/** An `ALTER TABLE name ALTER COLUMN column SET|DROP NOT NULL|DEFAULT …`. */
const ALTER_COLUMN_RE =
  /ALTER\s+TABLE\s+(\w+)\s+ALTER\s+(?:COLUMN\s+)?(\w+)\s+(SET|DROP)\s+(NOT\s+NULL|DEFAULT\s*[^;]*)/iu;
/** An `ALTER TABLE name ADD COLUMN [IF NOT EXISTS] column <the rest>`. */
const ADD_COLUMN_DECLARATION_RE =
  /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)([\s\S]*)/iu;

/** Replays one dialect's migrations into the tables they leave behind. */
function schemaOf(migrations: readonly Migration[]): Map<string, TableFacts> {
  const tables = new Map<string, TableFacts>();
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    for (const raw of migration.statements) {
      const statement = raw.replaceAll(/--[^\n]*/gu, "");

      const created = TABLE_RE.exec(statement);
      if (created !== null) {
        const name = created[1] ?? "";
        const columns = tables.get(name) ?? new Map<string, ColumnFacts>();
        for (const item of topLevelItems(created[2] ?? "")) {
          const column = /^(\w+)/u.exec(item)?.[1] ?? "";
          if (column === "" || NOT_A_COLUMN.has(column.toLowerCase())) {
            continue;
          }
          if (!columns.has(column)) {
            columns.set(column, {
              declaration: item.slice(column.length).trim(),
              version: migration.version,
            });
          }
        }
        tables.set(name, columns);
        continue;
      }

      const added = ADD_COLUMN_DECLARATION_RE.exec(statement);
      if (added !== null) {
        const name = added[1] ?? "";
        const columns = tables.get(name) ?? new Map<string, ColumnFacts>();
        if (!columns.has(added[2] ?? "")) {
          columns.set(added[2] ?? "", {
            declaration: (added[3] ?? "").trim(),
            version: migration.version,
          });
        }
        tables.set(name, columns);
        continue;
      }

      // Postgres can tighten a column in place; SQLite rebuilds the table
      // instead. Both end somewhere, and the model has to follow either or it
      // reports a difference that is not there.
      const altered = ALTER_COLUMN_RE.exec(statement);
      if (altered !== null) {
        const facts = tables.get(altered[1] ?? "")?.get(altered[2] ?? "");
        if (facts !== undefined) {
          const set = (altered[3] ?? "").toUpperCase() === "SET";
          const what = (altered[4] ?? "").trim();
          if (/^NOT\s+NULL$/iu.test(what)) {
            facts.declaration = set
              ? `${facts.declaration} NOT NULL`
              : facts.declaration.replaceAll(/\s*NOT\s+NULL\b/giu, "");
          } else {
            facts.declaration = set
              ? `${facts.declaration} ${what}`
              : facts.declaration.replaceAll(/\s*DEFAULT\s+('[^']*'|[\w.]+)/giu, "");
          }
        }
        continue;
      }

      const dropped = DROP_COLUMN_RE.exec(statement);
      if (dropped !== null) {
        tables.get(dropped[1] ?? "")?.delete(dropped[2] ?? "");
        continue;
      }

      const goneTable = DROP_TABLE_RE.exec(statement);
      if (goneTable !== null) {
        tables.delete(goneTable[1] ?? "");
        continue;
      }

      // A rebuild: SQLite cannot widen a primary key in place, so a table is
      // recreated under another name and renamed over the original. What the
      // database ends up with is the new table under the old name.
      const renamed = RENAME_TABLE_RE.exec(statement);
      if (renamed !== null) {
        const from = renamed[1] ?? "";
        const to = renamed[2] ?? "";
        const columns = tables.get(from);
        if (columns !== undefined) {
          tables.delete(from);
          tables.set(to, columns);
        }
      }
    }
  }
  return tables;
}

/** What a column declaration says, stripped of how each dialect says it. */
interface ColumnShape {
  type: string;
  notNull: boolean;
  dflt: string;
}

function columnShape(declaration: string): ColumnShape {
  const text = declaration.replaceAll(/\s+/gu, " ").trim();
  const type = (/^(\w+)/u.exec(text)?.[1] ?? "").toUpperCase();
  const dflt = /\bDEFAULT\s+('[^']*'|[\w.]+)/iu.exec(text)?.[1] ?? "";
  return {
    type,
    // A primary key is not nullable on either backend in practice — SQLite's
    // historical `TEXT PRIMARY KEY` loophole is not something any of these
    // tables relies on — so counting it keeps the comparison about what the
    // two lists actually disagree on.
    notNull: /\bNOT\s+NULL\b/iu.test(text) || /\bPRIMARY\s+KEY\b/iu.test(text),
    dflt: dflt.toUpperCase().replaceAll("'", ""),
  };
}

/**
 * Types that are the same type said twice.
 *
 * SQLite has no boolean, so a flag is an INTEGER holding 0 or 1 there and a
 * BOOLEAN holding FALSE or TRUE in Postgres; SQLite's `INTEGER PRIMARY KEY
 * AUTOINCREMENT` is Postgres's `BIGSERIAL`. Everything outside these
 * groupings is a real disagreement.
 */
const TYPE_CLASS = new Map<string, string>([
  ["TEXT", "text"],
  ["INTEGER", "integer"],
  ["BIGINT", "integer"],
  ["BIGSERIAL", "integer"],
  ["BOOLEAN", "integer"],
  ["REAL", "real"],
  ["DOUBLE", "real"],
  ["BLOB", "binary"],
  ["BYTEA", "binary"],
]);

/** `0`/`FALSE` and `1`/`TRUE` are the same default written twice. */
const DEFAULT_CLASS = new Map<string, string>([
  ["0", "0"],
  ["FALSE", "0"],
  ["1", "1"],
  ["TRUE", "1"],
]);

function classOf(map: Map<string, string>, value: string): string {
  return map.get(value) ?? value;
}

test("a fresh database of either dialect holds the same tables and columns", () => {
  const sqlite = schemaOf(MIGRATIONS);
  const postgres = schemaOf(POSTGRES_MIGRATIONS);
  const complaints: string[] = [];

  for (const table of new Set([...sqlite.keys(), ...postgres.keys()])) {
    const here = sqlite.get(table);
    const there = postgres.get(table);
    if (here === undefined) {
      complaints.push(`table ${table} exists only in Postgres`);
      continue;
    }
    if (there === undefined) {
      complaints.push(`table ${table} exists only in SQLite`);
      continue;
    }
    for (const column of here.keys()) {
      if (!there.has(column)) {
        complaints.push(`${table}.${column} exists only in SQLite`);
      }
    }
    for (const column of there.keys()) {
      // `seq` is Postgres's stand-in for SQLite's `rowid`: the arrival order
      // every "…, rowid DESC" ordering depends on, which Postgres has no
      // implicit column for. It is deliberately on one side only.
      if (column !== "seq" && !here.has(column)) {
        complaints.push(`${table}.${column} exists only in Postgres`);
      }
    }
  }
  assert.deepEqual(complaints, [], `\n${complaints.join("\n")}\n`);
});

test("a column means the same thing in both dialects", () => {
  const sqlite = schemaOf(MIGRATIONS);
  const postgres = schemaOf(POSTGRES_MIGRATIONS);
  const complaints: string[] = [];

  for (const [table, here] of sqlite) {
    const there = postgres.get(table);
    if (there === undefined) {
      continue;
    }
    for (const [column, facts] of here) {
      const other = there.get(column);
      if (other === undefined) {
        continue;
      }
      const a = columnShape(facts.declaration);
      const b = columnShape(other.declaration);
      const where = `${table}.${column}`;
      if (classOf(TYPE_CLASS, a.type) !== classOf(TYPE_CLASS, b.type)) {
        complaints.push(
          `${where} is ${a.type} in SQLite and ${b.type} in Postgres`,
        );
      }
      if (a.notNull !== b.notNull) {
        complaints.push(
          `${where} is ${a.notNull ? "NOT NULL" : "nullable"} in SQLite and ` +
            `${b.notNull ? "NOT NULL" : "nullable"} in Postgres — a row one ` +
            "backend accepts is one the other refuses",
        );
      }
      if (classOf(DEFAULT_CLASS, a.dflt) !== classOf(DEFAULT_CLASS, b.dflt)) {
        complaints.push(
          `${where} defaults to ${a.dflt === "" ? "nothing" : a.dflt} in ` +
            `SQLite and ${b.dflt === "" ? "nothing" : b.dflt} in Postgres — ` +
            "nothing fails, the two deployments simply disagree about what a " +
            "new row means",
        );
      }
    }
  }
  assert.deepEqual(complaints, [], `\n${complaints.join("\n")}\n`);
});

/* -------------------------------------------------------- one at a time */

test("no migration adds a NOT NULL column that an existing row could not fill", () => {
  const complaints: string[] = [];
  for (const [dialect, migrations] of [
    ["sqlite", MIGRATIONS],
    ["postgres", POSTGRES_MIGRATIONS],
  ] as const) {
    for (const migration of migrations) {
      for (const raw of migration.statements) {
        const statement = raw.replaceAll(/--[^\n]*/gu, "");
        const added = ADD_COLUMN_DECLARATION_RE.exec(statement);
        if (added === null) {
          continue;
        }
        const rest = added[3] ?? "";
        if (/\bNOT\s+NULL\b/iu.test(rest) && !/\bDEFAULT\b/iu.test(rest)) {
          // Empty on a fresh database, which is the only one the tests see.
          // On a live one every existing row would have to hold a value this
          // statement does not supply, and the migration fails there and only
          // there.
          complaints.push(
            `${dialect} migration ${String(migration.version)}: ` +
              `${added[1] ?? ""}.${added[2] ?? ""} is NOT NULL with no ` +
              "DEFAULT, which no database with rows in it can apply",
          );
        }
      }
    }
  }
  assert.deepEqual(complaints, [], `\n${complaints.join("\n")}\n`);
});

test("no migration creates a table or an index a live database already has", () => {
  const complaints: string[] = [];
  for (const [dialect, migrations] of [
    ["sqlite", MIGRATIONS],
    ["postgres", POSTGRES_MIGRATIONS],
  ] as const) {
    const tables = new Map<string, number>();
    const indexes = new Map<string, number>();
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      for (const raw of migration.statements) {
        const statement = raw.replaceAll(/--[^\n]*/gu, "");
        const created = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/iu.exec(
          statement,
        );
        if (created !== null) {
          const name = created[1] ?? "";
          const first = tables.get(name);
          if (first !== undefined) {
            complaints.push(
              `${dialect}: table ${name} is created by migration ` +
                `${String(first)} and again by ${String(migration.version)}`,
            );
          }
          tables.set(name, migration.version);
        }
        const dropped = DROP_TABLE_RE.exec(statement);
        if (dropped !== null) {
          tables.delete(dropped[1] ?? "");
        }
        const renamed = RENAME_TABLE_RE.exec(statement);
        if (renamed !== null) {
          tables.delete(renamed[1] ?? "");
          tables.set(renamed[2] ?? "", migration.version);
        }
        INDEX_RE.lastIndex = 0;
        for (const index of statement.matchAll(INDEX_RE)) {
          const name = index[1] ?? "";
          const first = indexes.get(name);
          if (first !== undefined) {
            complaints.push(
              `${dialect}: index ${name} is created by migration ` +
                `${String(first)} and again by ${String(migration.version)}`,
            );
          }
          indexes.set(name, migration.version);
        }
        const goneIndex = /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(\w+)/iu.exec(
          statement,
        );
        if (goneIndex !== null) {
          indexes.delete(goneIndex[1] ?? "");
        }
      }
    }
  }
  assert.deepEqual(complaints, [], `\n${complaints.join("\n")}\n`);
});

test("an index means the same thing in both dialects", () => {
  /** One index as its `CREATE` statement declares it. */
  interface IndexFacts {
    unique: boolean;
    table: string;
    columns: string;
    predicate: string;
  }

  const collect = (
    migrations: readonly Migration[],
  ): Map<string, IndexFacts> => {
    const found = new Map<string, IndexFacts>();
    for (const migration of migrations) {
      for (const raw of migration.statements) {
        const statement = raw.replaceAll(/--[^\n]*/gu, "").replaceAll(/\s+/gu, " ");
        const parsed =
          /CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+) ON (\w+) ?\(([^)]*(?:\([^)]*\)[^)]*)*)\) ?(WHERE .*)?$/iu.exec(
            statement.trim(),
          );
        if (parsed === null) {
          continue;
        }
        found.set(parsed[2] ?? "", {
          unique: parsed[1] !== undefined,
          table: parsed[3] ?? "",
          // `DESC` is ordering, `COLLATE` is how each dialect spells
          // case-insensitivity; neither changes which rows the index covers
          // or which pairs it refuses.
          columns: (parsed[4] ?? "")
            .toLowerCase()
            .replaceAll(/\s+/gu, "")
            .replaceAll(/desc|asc/gu, "")
            .replaceAll(/collatenocase|collate"c"/gu, ""),
          predicate: (parsed[5] ?? "").toLowerCase().replaceAll(/\s+/gu, ""),
        });
      }
    }
    return found;
  };

  const sqlite = collect(MIGRATIONS);
  const postgres = collect(POSTGRES_MIGRATIONS);
  const complaints: string[] = [];

  for (const name of new Set([...sqlite.keys(), ...postgres.keys()])) {
    const here = sqlite.get(name);
    const there = postgres.get(name);
    // `LOWER(column)` is how Postgres spells SQLite's `COLLATE NOCASE`, and
    // SQLite writes that on the column rather than in an index of its own. So
    // an expression index on one side alone is the two dialects agreeing.
    if (here === undefined) {
      if (there !== undefined && !there.columns.includes("lower(")) {
        complaints.push(`index ${name} exists only in Postgres`);
      }
      continue;
    }
    if (there === undefined) {
      if (!here.columns.includes("lower(")) {
        complaints.push(`index ${name} exists only in SQLite`);
      }
      continue;
    }
    if (here.unique !== there.unique) {
      complaints.push(
        `index ${name} is ${here.unique ? "UNIQUE" : "not unique"} in SQLite ` +
          `and ${there.unique ? "UNIQUE" : "not unique"} in Postgres — one ` +
          "backend refuses a duplicate the other accepts",
      );
    }
    if (here.table !== there.table) {
      complaints.push(
        `index ${name} is on ${here.table} in SQLite and ${there.table} in Postgres`,
      );
    }
    if (here.columns !== there.columns) {
      complaints.push(
        `index ${name} covers (${here.columns}) in SQLite and ` +
          `(${there.columns}) in Postgres`,
      );
    }
    if (here.predicate !== there.predicate) {
      complaints.push(
        `index ${name} is limited to "${here.predicate}" in SQLite and ` +
          `"${there.predicate}" in Postgres — a partial unique index that ` +
          "covers different rows enforces a different rule",
      );
    }
  }
  assert.deepEqual(complaints, [], `\n${complaints.join("\n")}\n`);
});
