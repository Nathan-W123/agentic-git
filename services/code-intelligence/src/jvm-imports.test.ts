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
  topLevelDeclarations,
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

test("only top-level names are indexed, and only a body encloses", () => {
  // A nested type indexed at the top level means an import of a same-named
  // external type resolves onto it. Nothing is lost: a nested type is reached
  // through its outer one, which truncation already walks to.
  assert.deepEqual(
    topLevelDeclarations([
      { name: "Money", declared: "type", start: 0, open: 12, close: 400 },
      { name: "Builder", declared: "type", start: 100, open: 120, close: 200 },
      { name: "Ledger", declared: "type", start: 420, open: 432, close: 500 },
    ]),
    { names: ["Money", "Ledger"], types: ["Money", "Ledger"] },
  );
  // Two overloads of a top-level Kotlin function around a class: the symbol
  // ranges merge the overloads into one span from the first to the last, and
  // read from those the class lay inside it and left the index. Neither
  // overload has a body that holds it.
  assert.deepEqual(
    topLevelDeclarations([
      { name: "format", declared: "function", start: 17 },
      { name: "Money", declared: "type", start: 51 },
      { name: "format", declared: "function", start: 80 },
    ]),
    { names: ["format", "Money"], types: ["Money"] },
  );
  // Two nested `Builder`s in one Java file: merged into one span, they were
  // held by neither outer class and became a phantom top-level type that made
  // the real `Builder` in the package ambiguous.
  assert.deepEqual(
    topLevelDeclarations([
      { name: "A", declared: "type", start: 0, open: 8, close: 40 },
      { name: "Builder", declared: "type", start: 10, open: 30, close: 31 },
      { name: "B", declared: "type", start: 42, open: 50, close: 80 },
      { name: "Builder", declared: "type", start: 52, open: 70, close: 71 },
    ]),
    { names: ["A", "B"], types: ["A", "B"] },
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

/* ------------------------------------------------------------ second pass -- */

test("the filename fallback never lands a library import on a repository file", () => {
  // `com/acme/ui/List.java` declares com.acme.ui.List, readably. It is not
  // java.util.List, whatever its basename says.
  const ctx = context({
    "src/main/java/com/acme/ui/List.java": { packageName: "com.acme.ui", topLevelNames: ["List"] },
    "src/test/java/com/acme/Assert.java": { packageName: "com.acme", topLevelNames: ["Assert"] },
  });
  assert.deepEqual(resolveJvmImport("src/main/java/com/acme/app/Main.java", "java.util.List", "java", ctx), []);
  assert.deepEqual(
    resolveJvmImport("src/main/java/com/acme/app/Main.java", "org.junit.Assert.assertEquals", "java", ctx),
    [],
  );
  assert.deepEqual(
    resolveJvmImport("src/main/java/com/acme/app/Main.java", "com.acme.ui.List", "java", ctx),
    ["src/main/java/com/acme/ui/List.java"],
  );
  // Unreadable header, but the path does not end in the package: no clue.
  const elsewhere = context({ "lib/Money.java": { packageName: "", topLevelNames: [] } });
  assert.deepEqual(resolveJvmImport("a/Use.java", "org.joda.money.Money", "java", elsewhere), []);
});

test("a truncated specifier may land on a type, never on a function or a package", () => {
  // `fun theme()` in com.acme.ui declares com.acme.ui.theme; the import
  // names something inside the *package* com.acme.ui.theme.
  const declared = new Map([
    ["ui/Theme.kt", { packageName: "com.acme.ui", topLevelNames: ["theme"] }],
  ]);
  const ctx = {
    declarations: jvmDeclarations(declared),
    types: jvmDeclarations(new Map([["ui/Theme.kt", { packageName: "com.acme.ui", topLevelNames: [] }]])),
    basenames: new Map(),
    units: new Map(),
  };
  assert.deepEqual(resolveJvmImport("app/Main.kt", "com.acme.ui.theme.Typography", "kotlin", ctx), []);
  // Whereas a member of a type still walks up to the type.
  const typed = {
    ...ctx,
    declarations: jvmDeclarations(new Map([["m/Money.kt", { packageName: "com.acme", topLevelNames: ["Money"] }]])),
    types: jvmDeclarations(new Map([["m/Money.kt", { packageName: "com.acme", topLevelNames: ["Money"] }]])),
  };
  assert.deepEqual(resolveJvmImport("app/Main.kt", "com.acme.Money.Companion", "kotlin", typed), ["m/Money.kt"]);
});

test("a header with a run of whitespace is rejected in no time", () => {
  const started = Date.now();
  assert.equal(readJvmHeader(`package ${" ".repeat(2000)}{\n`, "java"), undefined);
  assert.ok(Date.now() - started < 200, "no catastrophic backtracking");
});

test("a Kotlin alias names the type, and a trailing comment is not part of the specifier", () => {
  assert.deepEqual(readJvmHeader("package a\nimport com.acme.Money as M\nclass X\n", "kotlin"), {
    packageName: "a",
    imports: ["com.acme.Money"],
  });
  assert.deepEqual(readJvmHeader("package a\nimport b.C // used below\nclass X\n", "kotlin"), {
    packageName: "a",
    imports: ["b.C"],
  });
});

test("a directive the reader cannot finish abandons the file rather than inventing a name", () => {
  // `import b.` continued on the next line used to become the specifier `b.`.
  assert.equal(readJvmHeader("package a;\nimport b.\n    C;\nimport d.E;\nclass X {}\n", "java"), undefined);
  // A clause glued to a file annotation is one line this cannot split.
  assert.equal(readJvmHeader('@file:JvmName("U") package com.acme\nimport a.B\nclass X\n', "kotlin"), undefined);
});

test("the clause after a licence block's closing line is still the header", () => {
  assert.deepEqual(readJvmHeader("/* licence\n */ package com.acme;\nimport a.B;\nclass X {}\n", "java"), {
    packageName: "com.acme",
    imports: ["a.B"],
  });
  // Scala's `package object` opens a declaration and ends the header.
  assert.deepEqual(readJvmHeader("package com.acme\npackage object billing\n{\n  def x = 1\n}\n", "scala"), {
    packageName: "com.acme",
    imports: [],
  });
});

test("a comment is read where it is, so a URL in one does not end the header", () => {
  // `//.*$` was stripped before `/*` and `*/` were counted, so the `*/` closing
  // a one-line Javadoc with a link in it went with the URL, the block never
  // closed, and the file's imports were reported as none at all.
  assert.deepEqual(
    readJvmHeader("package com.acme.store\nimport com.acme.util.Ids\n/** See https://acme.example/ledger */\nclass Ledger\n", "kotlin"),
    { packageName: "com.acme.store", imports: ["com.acme.util.Ids"] },
  );
  assert.deepEqual(
    readJvmHeader("/* Licence: https://acme.example/lic */\npackage a;\nimport x.Y;\nclass X {}\n", "java"),
    { packageName: "a", imports: ["x.Y"] },
  );
  // A trailing block comment after a complete clause is a comment.
  assert.deepEqual(readJvmHeader("package a; /* note */\nimport x.Y; // used\nclass X {}\n", "java"), {
    packageName: "a",
    imports: ["x.Y"],
  });
  // A `//` inside a block comment is text, and an annotation's string
  // argument opens no comment.
  assert.deepEqual(
    readJvmHeader('/*\n * see http://x\n */\n@SuppressWarnings("http://y")\npackage a;\nimport x.Y;\nclass X {}\n', "java"),
    { packageName: "a", imports: ["x.Y"] },
  );
  // Kotlin and Scala nest block comments; Java does not, so the same text
  // is a closed comment followed by the clause in Java and a comment that
  // never closes in Kotlin.
  assert.deepEqual(readJvmHeader("/* a /* b */ still */\npackage a\nimport x.Y\n", "kotlin"), {
    packageName: "a",
    imports: ["x.Y"],
  });
  assert.deepEqual(readJvmHeader("/* a /* b */ package a;\nimport x.Y;\n", "java"), {
    packageName: "a",
    imports: ["x.Y"],
  });
  assert.equal(readJvmHeader("/* a /* b */ package a\nimport x.Y\n", "kotlin"), undefined);
  // And a block that never closes is still abandoned.
  assert.equal(readJvmHeader("/* open http://x\npackage a;\n", "java"), undefined);
});

test("a Scala alias names the type, and one import may carry several clauses", () => {
  // `import a.b.C as D` is Scala 3; kept whole, the alias collapsed into the
  // specifier `a.b.CasD`, which names nothing.
  assert.deepEqual(readJvmHeader("package q\nimport a.b.C as D\nimport a.B, c.D\nclass Use\n", "scala"), {
    packageName: "q",
    imports: ["a.b.C", "a.B", "c.D"],
  });
  const ctx = context({
    "s/C.scala": { packageName: "a.b", topLevelNames: ["C"] },
    "s/Use.scala": { packageName: "q", topLevelNames: ["Use"] },
  });
  assert.deepEqual(resolveJvmImport("s/Use.scala", "a.b.C as D", "scala", ctx), ["s/C.scala"]);
  // Whitespace the alias rule did not account for is a line this mis-read,
  // not a name; a backticked alias with a space in it is still an alias.
  assert.equal(readJvmHeader("package q\nimport a.b.C D\nclass Use\n", "scala"), undefined);
  assert.deepEqual(readJvmHeader("package a\nimport a.b.C as `D E`\nclass X\n", "kotlin"), {
    packageName: "a",
    imports: ["a.b.C"],
  });
  // Java 25's `import module` names a module, not a type: skipped, and the
  // header is still readable rather than abandoned for its whitespace.
  assert.deepEqual(readJvmHeader("package a;\nimport module java.base;\nimport x.Y;\nclass X {}\n", "java"), {
    packageName: "a",
    imports: ["x.Y"],
  });
});

test("a Scala member of a nested object walks two steps back to the type", () => {
  // `import a.b.Outer.Inner.member` was bounded at one step for Scala alone,
  // so it never reached `object Outer`. The package guard is what keeps a
  // truncation off a package, and it applies in every language.
  const ctx = context(
    {
      "s/Outer.scala": { packageName: "a.b", topLevelNames: ["Outer"] },
      "s/Use.scala": { packageName: "q", topLevelNames: ["Use"] },
    },
    { "s/Use.scala": { packageName: "q", imports: ["a.b.Outer.Inner.member"] } },
  );
  assert.deepEqual(resolveJvmImport("s/Use.scala", "a.b.Outer.Inner.member", "scala", ctx), ["s/Outer.scala"]);
});

test("the filename clue also speaks for a Java body the scanner could not read", () => {
  // The header was read — the package is known — but the declaration pass
  // lost its place in the body, so the file is in no table. Java's rule that
  // a public type lives in a file of its own name still holds, and the
  // package must be the specifier's own.
  const ctx = {
    ...context({
      "src/com/acme/db/Queries.java": { packageName: "com.acme.db", topLevelNames: [] },
      "src/com/acme/app/Main.java": { packageName: "com.acme.app", topLevelNames: ["Main"] },
    }, {
      "src/com/acme/db/Queries.java": { packageName: "com.acme.db", imports: [] },
    }),
    unreadBodies: new Set(["src/com/acme/db/Queries.java"]),
  };
  assert.deepEqual(
    resolveJvmImport("src/com/acme/app/Main.java", "com.acme.db.Queries", "java", ctx),
    ["src/com/acme/db/Queries.java"],
  );
  // A different package in the same-named file is not that type.
  assert.deepEqual(resolveJvmImport("src/com/acme/app/Main.java", "org.other.db.Queries", "java", ctx), []);
  // And a readable body that simply declares nothing of the name gets no clue.
  assert.deepEqual(
    resolveJvmImport("src/com/acme/app/Main.java", "com.acme.db.Queries", "java", { ...ctx, unreadBodies: new Set() }),
    [],
  );
});
