/**
 * Go, where a package is a directory and one import is several edges.
 *
 * The expensive mistakes here are all edges that should not exist: to a
 * `_test.go` file no importer can see, to a generator script marked
 * `//go:build ignore`, to a `package main` that is not importable at all, or
 * — the one that catches people — from `import "fmt"` into a repository whose
 * own module is called `myapp`, because a module path is allowed to have no
 * dot in it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  goModuleRoots,
  readGoFile,
  resolveGoImport,
  type GoFileFacts,
} from "./go-imports.js";

function facts(...entries: [string, Partial<GoFileFacts>][]) {
  return new Map<string, GoFileFacts>(
    entries.map(([file, over]) => [
      file,
      { packageName: "billing", buildIgnored: false, imports: [], ...over },
    ]),
  );
}

/* ------------------------------------------------------------- reading -- */

test("the prologue gives the package clause and every import shape", () => {
  const read = readGoFile(
    [
      "// a leading comment",
      "package billing",
      "",
      "import (",
      '\t"fmt"',
      '\talias "example.com/m/store"',
      '\t_ "example.com/m/driver"',
      '\t. "example.com/m/dot"',
      ")",
      "",
      'import "example.com/m/single"',
      "",
      "func Charge() {}",
    ].join("\n"),
  );
  assert.equal(read?.packageName, "billing");
  assert.deepEqual(read?.imports, [
    "fmt",
    "example.com/m/store",
    "example.com/m/driver",
    "example.com/m/dot",
    "example.com/m/single",
  ]);
});

test("a generator script marked ignore says so", () => {
  const read = readGoFile(
    ["//go:build ignore", "", "package main", "", "func main() {}"].join("\n"),
  );
  assert.equal(read?.buildIgnored, true);
});

test("a file the reader loses its place in is abandoned whole", () => {
  // The house rule. A partial answer that reads as complete is the one
  // genuinely harmful outcome, so anything unaccounted for returns nothing.
  for (const source of [
    'package billing\n\nimport (\n\t"unterminated\n)\n',
    "package billing\n\nimport (\n\t/* never closed\n",
    'import "no/package/clause"\n',
    'package billing\n\nimport "a"\n\nnonsense here\n',
    'package billing\n\nimport "esc\\x41ped"\n\nfunc F() {}\n',
  ]) {
    assert.equal(readGoFile(source), undefined, source.slice(0, 30));
  }
});

test("a comment holding an import is not an import", () => {
  const read = readGoFile(
    [
      "package billing",
      "",
      "/*",
      'import "example.com/m/ghost"',
      "*/",
      'import "example.com/m/real"',
      "",
      "func F() {}",
    ].join("\n"),
  );
  assert.deepEqual(read?.imports, ["example.com/m/real"]);
});

/* -------------------------------------------------------------- roots --- */

test("a module path claimed twice is dropped rather than picked between", () => {
  const roots = goModuleRoots(
    new Map([
      ["go.mod", "module example.com/m\n"],
      ["a/go.mod", "module example.com/dup\n"],
      ["b/go.mod", "module example.com/dup\n"],
    ]),
  );
  assert.equal(roots.get("example.com/m"), "");
  assert.equal(roots.has("example.com/dup"), false);
});

/* ----------------------------------------------------------- resolving -- */

const ROOTS = new Map([["example.com/m", ""]]);

test("one import resolves to every non-test file of the package", () => {
  const targets = resolveGoImport("cmd/app/main.go", "example.com/m/billing", {
    files: new Set([
      "billing/money.go",
      "billing/doc.go",
      "billing/money_test.go",
      "cmd/app/main.go",
    ]),
    moduleRoots: ROOTS,
    facts: facts(["billing/money.go", {}], ["billing/doc.go", {}]),
  });
  // Both real members, and never the test file — an importer cannot see it.
  assert.deepEqual(targets, ["billing/doc.go", "billing/money.go"]);
});

test("a file marked ignore is in the directory and not in the package", () => {
  const targets = resolveGoImport("cmd/app/main.go", "example.com/m/billing", {
    files: new Set(["billing/money.go", "billing/gen.go", "cmd/app/main.go"]),
    moduleRoots: ROOTS,
    facts: facts(
      ["billing/money.go", {}],
      ["billing/gen.go", { packageName: "main", buildIgnored: true }],
    ),
  });
  assert.deepEqual(targets, ["billing/money.go"]);
});

test("a command is not importable, so it is not an edge", () => {
  const targets = resolveGoImport("cmd/app/main.go", "example.com/m/tool", {
    files: new Set(["tool/main.go", "cmd/app/main.go"]),
    moduleRoots: ROOTS,
    facts: facts(["tool/main.go", { packageName: "main" }]),
  });
  assert.deepEqual(targets, []);
});

test("two package clauses in one directory is not an answer", () => {
  const targets = resolveGoImport("cmd/app/main.go", "example.com/m/mixed", {
    files: new Set(["mixed/a.go", "mixed/b.go", "cmd/app/main.go"]),
    moduleRoots: ROOTS,
    facts: facts(
      ["mixed/a.go", { packageName: "one" }],
      ["mixed/b.go", { packageName: "two" }],
    ),
  });
  assert.deepEqual(targets, []);
});

test("a dotless module never swallows the standard library", () => {
  // A module path needs no dot in it — `module internal` is legal, and an
  // internal repository is exactly where somebody writes one. It then
  // matches `import "internal/..."`, which the toolchain resolves to GOROOT,
  // and without the guard every standard-library import in the repository
  // would land on a local directory instead.
  const context = {
    files: new Set(["thing/thing.go", "pkg/store/store.go", "main.go"]),
    moduleRoots: new Map([["internal", ""]]),
    facts: facts(
      ["thing/thing.go", { packageName: "thing" }],
      ["pkg/store/store.go", { packageName: "store" }],
    ),
  };
  assert.deepEqual(resolveGoImport("main.go", "internal/thing", context), []);
  // And the repository's own packages still resolve, which is why the module
  // match has to be tried before the standard-library guard: reversing them
  // would drop every path whose first element happened to look like std.
  const dotted = {
    ...context,
    moduleRoots: new Map([["example.com/m", ""]]),
  };
  assert.deepEqual(resolveGoImport("main.go", "example.com/m/pkg/store", dotted), [
    "pkg/store/store.go",
  ]);
});

test("a nested module owns its own subtree", () => {
  const context = {
    files: new Set(["sub/lib/lib.go", "main.go"]),
    moduleRoots: new Map([
      ["example.com/m", ""],
      ["example.com/m/sub", "sub"],
    ]),
    facts: facts(["sub/lib/lib.go", { packageName: "lib" }]),
  };
  // The longest prefix wins, so this is `sub` + `lib`, not root + `sub/lib`.
  assert.deepEqual(resolveGoImport("main.go", "example.com/m/sub/lib", context), [
    "sub/lib/lib.go",
  ]);
});

test("directories the go tool ignores are neither end of an edge", () => {
  const context = {
    files: new Set([
      "testdata/bad/bad.go",
      "vendor/x/x.go",
      "billing/money.go",
      "main.go",
    ]),
    moduleRoots: ROOTS,
    facts: facts(
      ["testdata/bad/bad.go", {}],
      ["vendor/x/x.go", {}],
      ["billing/money.go", {}],
    ),
  };
  assert.deepEqual(resolveGoImport("main.go", "example.com/m/testdata/bad", context), []);
  assert.deepEqual(resolveGoImport("main.go", "example.com/m/vendor/x", context), []);
  // And nothing under testdata imports anything, either.
  assert.deepEqual(
    resolveGoImport("testdata/bad/bad.go", "example.com/m/billing", context),
    [],
  );
});

test("a module nobody declared resolves to nothing", () => {
  // No go.mod means no import path for this repository, so every specifier
  // is a third-party module as far as anything here can tell.
  assert.deepEqual(
    resolveGoImport("main.go", "example.com/m/billing", {
      files: new Set(["billing/money.go", "main.go"]),
      moduleRoots: new Map(),
      facts: facts(["billing/money.go", {}]),
    }),
    [],
  );
});

test("a build constraint is read from the comments above the clause, wherever the word package appears", () => {
  // The first version sliced the text at the first occurrence of "package",
  // which a licence header is allowed to contain — and then never saw the
  // constraint under it. Go ignores this file; so must this.
  assert.equal(
    readGoFile(
      [
        "// Copyright 2024 Acme. Distributed with the other packages under MIT.",
        "",
        "//go:build ignore",
        "",
        "package cp",
        "",
        "var X = 1",
      ].join("\n"),
    )?.buildIgnored,
    true,
  );
  // A constraint inside a block comment is prose.
  assert.equal(
    readGoFile("/*\n//go:build ignore\n*/\n\npackage blk\n")?.buildIgnored,
    false,
  );
  // `!ignore` builds everywhere, and an expression with an operator depends
  // on tags this cannot see.
  assert.equal(readGoFile("//go:build !ignore\n\npackage neg\n")?.buildIgnored, false);
  assert.equal(
    readGoFile("//go:build ignore || linux\n\npackage or\n")?.buildIgnored,
    false,
  );
  // The old form needs a blank line before the clause, or it is a doc comment.
  assert.equal(readGoFile("// +build ignore\npackage under\n")?.buildIgnored, false);
  assert.equal(readGoFile("// +build ignore\n\npackage over\n")?.buildIgnored, true);
  assert.equal(
    readGoFile("// +build linux,ignore darwin\n\npackage and\n")?.buildIgnored,
    true,
  );
});

test("files the go tool never builds are neither end of an edge", () => {
  const F = (packageName: string): GoFileFacts => ({
    packageName,
    buildIgnored: false,
    imports: [],
  });
  const context = {
    files: new Set(["main.go", "_gen.go", "store/store.go", "store/_template.go", "store/.hidden.go"]),
    moduleRoots: new Map([["example.com/m", ""]]),
    facts: new Map([
      ["store/store.go", F("store")],
      ["store/_template.go", F("store")],
      ["store/.hidden.go", F("store")],
    ]),
  };
  assert.deepEqual(resolveGoImport("main.go", "example.com/m/store", context), [
    "store/store.go",
  ]);
  assert.deepEqual(resolveGoImport("_gen.go", "example.com/m/store", context), []);
});

test("a nested module with an unrelated path still owns its subtree", () => {
  // `sub/` is `example.com/other`, so `example.com/m/sub/lib` does not
  // compile — and the longest-prefix match on the specifier alone would have
  // aimed it at sub/lib anyway.
  assert.deepEqual(
    resolveGoImport("main.go", "example.com/m/sub/lib", {
      files: new Set(["sub/lib/lib.go", "sub/go.mod", "go.mod"]),
      moduleRoots: new Map([
        ["example.com/m", ""],
        ["example.com/other", "sub"],
      ]),
      facts: new Map([
        ["sub/lib/lib.go", { packageName: "lib", buildIgnored: false, imports: [] }],
      ]),
    }),
    [],
  );
});

test("a specifier with a dot element is refused rather than normalised", () => {
  const context = {
    files: new Set(["store/store.go"]),
    moduleRoots: new Map([["example.com/m", ""]]),
    facts: new Map([
      ["store/store.go", { packageName: "store", buildIgnored: false, imports: [] }],
    ]),
  };
  for (const specifier of [
    "example.com/m/billing/../store",
    "example.com/m/./store",
    "example.com/m//store",
  ]) {
    assert.deepEqual(resolveGoImport("main.go", specifier, context), [], specifier);
  }
});

test("go.mod is read the way go mod reads it", () => {
  for (const [source, expected] of [
    ["module example.com/m // the module\n\ngo 1.22\n", "example.com/m"],
    ["﻿module example.com/m\n", "example.com/m"],
    ["module (\n\texample.com/m\n)\n", "example.com/m"],
    ['module "example.com/q"\n', "example.com/q"],
  ] as const) {
    assert.deepEqual(
      [...goModuleRoots(new Map([["go.mod", source]]))],
      [[expected, ""]],
      JSON.stringify(source),
    );
  }
  // A block with nothing in it declares no path, and `(` is not one.
  assert.deepEqual([...goModuleRoots(new Map([["go.mod", "module (\n)\n"]]))], []);
});

test("a go.mod under testdata is a fixture, not a module root", () => {
  // A fixture repeating the root's own path used to mark it ambiguous and
  // delete it — every edge in the repository gone, over a test file.
  assert.deepEqual(
    [
      ...goModuleRoots(
        new Map([
          ["go.mod", "module example.com/m\n"],
          ["internal/testdata/mod/go.mod", "module example.com/m\n"],
        ]),
      ),
    ],
    [["example.com/m", ""]],
  );
});
