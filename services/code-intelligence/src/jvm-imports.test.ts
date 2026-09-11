/**
 * Java, Kotlin and Scala, where an import names a type and the package is a
 * namespace rather than a directory.
 *
 * The refusals are the interesting half. A wildcard names a package and not a
 * file. A nested type must not be indexed at the top level, or an import of a
 * same-named external type lands on it. And two files declaring one qualified
 * name — a build-variant source set, a vendored copy — has no answer at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  jvmDeclarations,
  readJvmHeader,
  resolveJvmImport,
  topLevelNames,
  type JvmUnit,
} from "./jvm-imports.js";

function context(
  declared: Record<string, { packageName: string; topLevelNames: string[] }>,
  units: Record<string, JvmUnit> = {},
) {
  const paths = Object.keys(declared);
  const basenames = new Map<string, string[]>();
  for (const file of paths) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    basenames.set(name, [...(basenames.get(name) ?? []), file]);
  }
  return {
    declarations: jvmDeclarations(new Map(Object.entries(declared))),
    basenames,
    units: new Map(Object.entries(units)),
  };
}

/* -------------------------------------------------------------- header -- */

test("the header gives the package and every import, whatever the spacing", () => {
  const unit = readJvmHeader(
    [
      "/* a licence header",
      "   spanning lines */",
      "package com.acme.billing;",
      "",
      "// a note",
      "import com.acme.store.Ledger;",
      "import static com.acme.util.Math.round;",
      "import com . acme . spaced . Thing;",
      "",
      "public class Money {}",
    ].join("\n"),
    "java",
  );
  assert.equal(unit?.packageName, "com.acme.billing");
  assert.deepEqual(unit?.imports, [
    "com.acme.store.Ledger",
    "com.acme.util.Math.round",
    "com . acme . spaced . Thing",
  ]);
});

test("Scala's consecutive package clauses join", () => {
  const unit = readJvmHeader(
    ["package com", "package acme", "", "import foo.Bar", "", "class X"].join("\n"),
    "scala",
  );
  assert.equal(unit?.packageName, "com.acme");
});

test("a header the reader cannot account for abandons the file", () => {
  for (const [source, language] of [
    // Two clauses on one line, which is legal and which this does not model.
    ["package a;\nimport b.C; import d.E;\nclass X {}", "java"],
    // A triple-quoted string in the header is a shape this does not model.
    ['package a\nval s = """x"""\nimport b.C', "kotlin"],
    // A block comment that never closes.
    ["/* open\npackage a;\n", "java"],
    // Two package clauses where only one is legal.
    ["package a;\npackage b;\nclass X {}", "java"],
  ] as const) {
    assert.equal(readJvmHeader(source, language), undefined, source.slice(0, 24));
  }
});

/* ------------------------------------------------------- declarations --- */

test("only top-level names are indexed", () => {
  // A nested type indexed at the top level means an import of a same-named
  // external type resolves onto it. Nothing is lost: a nested type is reached
  // through its outer one, which truncation already walks to.
  assert.deepEqual(
    topLevelNames([
      { name: "Money", startLine: 1, endLine: 40 },
      { name: "Builder", startLine: 10, endLine: 20 },
      { name: "Ledger", startLine: 42, endLine: 50 },
    ]),
    ["Money", "Ledger"],
  );
});

test("a file with no package clause contributes nothing", () => {
  // A default-package type is unimportable from a named package anyway, and
  // indexing bare names would put `Service` in the map as a top-level name,
  // where it collides with half the repository.
  const declarations = jvmDeclarations(
    new Map([["Loose.java", { packageName: "", topLevelNames: ["Service"] }]]),
  );
  assert.equal(declarations.size, 0);
});

/* ---------------------------------------------------------- resolving --- */

test("an import of a type finds the file declaring it", () => {
  const ctx = context({
    "src/main/java/com/acme/store/Ledger.java": {
      packageName: "com.acme.store",
      topLevelNames: ["Ledger"],
    },
    "src/main/java/com/acme/billing/Money.java": {
      packageName: "com.acme.billing",
      topLevelNames: ["Money"],
    },
  });
  assert.deepEqual(
    resolveJvmImport(
      "src/main/java/com/acme/billing/Money.java",
      "com.acme.store.Ledger",
      "java",
      ctx,
    ),
    ["src/main/java/com/acme/store/Ledger.java"],
  );
});

test("a static member walks back up to the type that holds it", () => {
  const ctx = context({
    "a/Math.java": { packageName: "com.acme.util", topLevelNames: ["Math"] },
    "a/Use.java": { packageName: "com.acme.app", topLevelNames: ["Use"] },
  });
  assert.deepEqual(
    resolveJvmImport("a/Use.java", "com.acme.util.Math.round", "java", ctx),
    ["a/Math.java"],
  );
});

test("a wildcard names a package, which is not a file", () => {
  const ctx = context({
    "a/Ledger.java": { packageName: "com.acme.store", topLevelNames: ["Ledger"] },
    "a/Use.java": { packageName: "com.acme.app", topLevelNames: ["Use"] },
  });
  assert.deepEqual(
    resolveJvmImport("a/Use.java", "com.acme.store.*", "java", ctx),
    [],
  );
  // `import static a.b.C.*` is the exception, because it names the type C.
  const withType = context({
    "a/Math.java": { packageName: "com.acme.util", topLevelNames: ["Math"] },
    "a/Use.java": { packageName: "com.acme.app", topLevelNames: ["Use"] },
  });
  assert.deepEqual(
    resolveJvmImport("a/Use.java", "com.acme.util.Math.*", "java", withType),
    ["a/Math.java"],
  );
});

test("one qualified name declared twice has no answer", () => {
  // A build-variant source set, or a vendored copy. There is no way to say
  // which one the importer compiles against, so neither is named.
  const ctx = context({
    "main/Money.java": { packageName: "com.acme", topLevelNames: ["Money"] },
    "variant/Money.java": { packageName: "com.acme", topLevelNames: ["Money"] },
    "a/Use.java": { packageName: "com.acme.app", topLevelNames: ["Use"] },
  });
  assert.deepEqual(
    resolveJvmImport("a/Use.java", "com.acme.Money", "java", ctx),
    [],
  );
});

test("truncation stops before it reaches a package name", () => {
  // Unbounded truncation reaches `com.example`, and anything declaring a
  // top-level `example` in package `com` then becomes a confident wrong hit.
  const ctx = context({
    "a/example.java": { packageName: "com", topLevelNames: ["example"] },
    "a/Use.java": { packageName: "com.acme", topLevelNames: ["Use"] },
  });
  assert.deepEqual(
    resolveJvmImport("a/Use.java", "com.example.deep.nested.Thing", "java", ctx),
    [],
  );
});

test("Kotlin puts a type wherever it likes, and an alias changes nothing", () => {
  const ctx = context({
    "app/util/helpers.kt": {
      packageName: "com.acme.util",
      topLevelNames: ["formatMoney"],
    },
    "app/Main.kt": { packageName: "com.acme.app", topLevelNames: ["Main"] },
  });
  // The file name has nothing to do with the package or the type: that is
  // exactly why the index has to be built from what each file declares.
  assert.deepEqual(
    resolveJvmImport("app/Main.kt", "com.acme.util.formatMoney", "kotlin", ctx),
    ["app/util/helpers.kt"],
  );
});

test("a Scala import is scope-relative as well as absolute", () => {
  const ctx = context(
    {
      "s/Ledger.scala": { packageName: "com.acme.store", topLevelNames: ["Ledger"] },
      "s/Use.scala": { packageName: "com.acme.store", topLevelNames: ["Use"] },
    },
    {
      "s/Use.scala": { packageName: "com.acme.store", imports: ["Ledger"] },
    },
  );
  assert.deepEqual(resolveJvmImport("s/Use.scala", "Ledger", "scala", ctx), [
    "s/Ledger.scala",
  ]);
});

test("Java's filename convention is a fallback, and only when it is unique", () => {
  // Nothing declared a package this could read — an unreadable header, a
  // layout it abandoned — but a public Java type must live in a file of its
  // own name, which is one reliable clue.
  const unique = context({ "src/com/acme/Money.java": { packageName: "", topLevelNames: [] } });
  assert.deepEqual(
    resolveJvmImport("a/Use.java", "com.acme.Money", "java", unique),
    ["src/com/acme/Money.java"],
  );
  // Two of them is the case where guessing is wrong.
  const ambiguous = context({
    "main/Money.java": { packageName: "", topLevelNames: [] },
    "variant/Money.java": { packageName: "", topLevelNames: [] },
  });
  assert.deepEqual(
    resolveJvmImport("a/Use.java", "com.acme.Money", "java", ambiguous),
    [],
  );
  // And Kotlin gets no such fallback, because it has no such rule.
  assert.deepEqual(
    resolveJvmImport("a/Use.kt", "com.acme.Money", "kotlin", unique),
    [],
  );
});
