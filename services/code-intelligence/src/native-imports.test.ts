/**
 * C, C++ and C#, where the difficulty is that the specifier lives inside a
 * string and the strings are the hardest part of the language to read.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  pathSuffixes,
  readCSharpLoads,
  readIncludes,
  resolveCSharpLoad,
  resolveInclude,
} from "./native-imports.js";

const repo = (...files: string[]) => {
  const set = new Set(files);
  return { files: set, suffixes: pathSuffixes(set) };
};

/* ------------------------------------------------------------- reading -- */

test("a quoted include is a path and an angled one is not", () => {
  assert.deepEqual(
    readIncludes(
      ['#include "billing/money.h"', "#include <stdio.h>", '# include   "spaced.h"'].join(
        "\n",
      ),
    ),
    ["billing/money.h", "spaced.h"],
  );
});

test("a digit separator does not open a character literal", () => {
  // Without a preprocessing-number rule, `0x8000'0000ull` reads as an opening
  // quote and swallows everything after it — including every include below.
  const includes = readIncludes(
    ["const auto mask = 0x8000'0000ull;", '#include "real.h"'].join("\n"),
  );
  assert.deepEqual(includes, ["real.h"]);
  // And a genuine character literal still reads as one.
  assert.deepEqual(
    readIncludes(["char c = 'x';", "char n = L'\\n';", '#include "real.h"'].join("\n")),
    ["real.h"],
  );
});

test("an include inside a raw string or a comment is not an include", () => {
  assert.deepEqual(
    readIncludes(
      [
        'const char* s = R"cpp(',
        '#include "ghost.h"',
        ')cpp";',
        "/*",
        '#include "blocked.h"',
        "*/",
        '#include "real.h"',
      ].join("\n"),
    ),
    ["real.h"],
  );
});

test("a file whose text cannot be trusted is abandoned", () => {
  // include_alias silently remaps every include in the translation unit, so
  // nothing in the file means what it says.
  assert.equal(
    readIncludes(['#pragma include_alias("a.h", "b.h")', '#include "a.h"'].join("\n")),
    undefined,
  );
  assert.equal(readIncludes('/* never closed\n#include "x.h"\n'), undefined);
  assert.equal(readIncludes('const char* s = R"cpp(\nno terminator\n'), undefined);
});

/* ----------------------------------------------------------- resolving -- */

test("a quoted include is resolved beside the including file first", () => {
  const context = repo("src/billing/money.c", "src/billing/money.h", "vendor/money.h");
  assert.deepEqual(resolveInclude("src/billing/money.c", "money.h", context), [
    "src/billing/money.h",
  ]);
});

test("the search path is a compiler flag, so a suffix stands in for it", () => {
  const context = repo("src/app/main.c", "src/billing/money.h");
  assert.deepEqual(resolveInclude("src/app/main.c", "billing/money.h", context), [
    "src/billing/money.h",
  ]);
});

test("a name several files carry is not resolved to one of them", () => {
  // Two `config.h` is exactly the case where the search path decides and the
  // search path is not in the repository.
  const context = repo("a/config.h", "b/config.h", "src/main.c");
  assert.deepEqual(resolveInclude("src/main.c", "config.h", context), []);
});

test("a system header resolves to nothing, which is the ordinary case", () => {
  const context = repo("src/main.c");
  assert.deepEqual(resolveInclude("src/main.c", "stdio.h", context), []);
});

/* -------------------------------------------------------------- csharp -- */

test("a using names a namespace, and only #load names a file", () => {
  const source = ["using System.Text;", 'using Acme.Billing;', '#load "helpers.csx"'].join(
    "\n",
  );
  // A namespace is spread across as many files as anybody likes, so there is
  // no file to point at. `#load` is a real path.
  assert.deepEqual(readCSharpLoads(source), ["helpers.csx"]);
  const context = repo("src/Script.csx", "src/helpers.csx");
  assert.deepEqual(resolveCSharpLoad("src/Script.csx", "helpers.csx", context), [
    "src/helpers.csx",
  ]);
  assert.deepEqual(resolveCSharpLoad("src/Script.csx", "missing.csx", context), []);
});
