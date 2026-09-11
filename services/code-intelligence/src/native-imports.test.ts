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

/* ------------------------------------------------------------ second pass -- */

test("a line spliced onto the one above it cannot begin a directive", () => {
  // C splices a backslash-newline before it looks for directives, so the
  // `#include` under a comment ending in a Windows path is comment text.
  assert.deepEqual(
    readIncludes('// path C:\\dir\\\n#include "ghost.h"\n#include "real.h"\n'),
    ["real.h"],
  );
  assert.deepEqual(readIncludes('// c \\ \n#include "ghost.h"\n'), []);
  assert.deepEqual(readIncludes('// c\\\r\n#include "ghost.h"\r\n'), []);
  assert.deepEqual(readIncludes('#define STAMP \\\n#include "ghost.h"\nint x;\n'), []);
  assert.deepEqual(readIncludes('#include "real.h" \\\n#include "ghost.h"\n'), ["real.h"]);
  // C# has no such splice, and a `#load` after a backslash line is live.
  assert.deepEqual(readCSharpLoads('var p = "x\\\\";\n#load "a.csx"\n'), ["a.csx"]);
});

test("an #if 0 group is dead, and what comes after its #else is not", () => {
  assert.deepEqual(readIncludes('#if 0\n#include "dead.h"\n#endif\n#include "real.h"\n'), ["real.h"]);
  assert.deepEqual(
    readIncludes('#if 0\n#include "dead.h"\n#else\n#include "live.h"\n#endif\n'),
    ["live.h"],
  );
  assert.deepEqual(
    readIncludes('#if 0\n#ifdef X\n#include "deeper.h"\n#endif\n#endif\n#include "real.h"\n'),
    ["real.h"],
  );
  // Any other condition is somebody's flag, and left alone.
  assert.deepEqual(readIncludes('#ifdef DEBUG\n#include "debug.h"\n#endif\n'), ["debug.h"]);
  assert.deepEqual(readCSharpLoads('#if false\n#load "ghost.csx"\n#endif\n#load "real.csx"\n'), ["real.csx"]);
});

test("a dead group is dead with Windows line endings too", () => {
  // The masked text keeps each line's `\r`, and a constant test anchored at
  // the end of the line has to see past it — or every `#if 0` in a
  // Windows-authored file is live, and its disabled include is an edge.
  assert.deepEqual(
    readIncludes('#if 0\r\n#include "dead.h"\r\n#endif\r\n#include "real.h"\r\n'),
    ["real.h"],
  );
  assert.deepEqual(readCSharpLoads('#if false\r\n#load "ghost.csx"\r\n#endif\r\n'), []);
});

test("the other arm of a constant toggle is dead", () => {
  // `#if 1 ... #else ... #endif` is the everyday way of switching between
  // two implementations; the compiler never enters the other arm.
  assert.deepEqual(
    readIncludes('#if 1\n#include "live.h"\n#else\n#include "dead.h"\n#endif\n'),
    ["live.h"],
  );
  assert.deepEqual(
    readIncludes('#ifdef FOO\n#include "a.h"\n#elif 0\n#include "dead.h"\n#endif\n'),
    ["a.h"],
  );
  assert.deepEqual(
    readIncludes(
      '#if 0\n#include "dead1.h"\n#elif 1\n#include "live.h"\n#else\n#include "dead2.h"\n#endif\n',
    ),
    ["live.h"],
  );
  // An arm after a taken one is dead whatever its own condition says.
  assert.deepEqual(
    readIncludes('#if 1\n#include "live.h"\n#elif FOO\n#include "dead.h"\n#endif\n'),
    ["live.h"],
  );
  // A flag nobody can see still leaves both arms alone.
  assert.deepEqual(
    readIncludes('#if 0\n#include "dead.h"\n#elif FOO\n#include "a.h"\n#else\n#include "b.h"\n#endif\n'),
    ["a.h", "b.h"],
  );
  assert.deepEqual(
    readCSharpLoads('#if true\n#load "live.csx"\n#else\n#load "ghost.csx"\n#endif\n'),
    ["live.csx"],
  );
  assert.deepEqual(
    readCSharpLoads('#if false\n#load "g1.csx"\n#elif false\n#load "g2.csx"\n#endif\n'),
    [],
  );
});

test("a bare name is not resolved into somebody else's tree", () => {
  // The project's own config.h is written by ./configure and never
  // committed; the one config.h in the repository belongs to a vendored
  // zlib, and nothing in `#include "config.h"` ties main.c to it.
  const context = repo("src/main.c", "third_party/zlib/config.h", "third_party/zlib/deflate.c");
  assert.deepEqual(resolveInclude("src/main.c", "config.h", context), []);
  // A directory in the specifier is the evidence a bare name lacks, and a
  // file inside that tree includes its own header the ordinary way.
  assert.deepEqual(resolveInclude("src/main.c", "zlib/config.h", context), [
    "third_party/zlib/config.h",
  ]);
  assert.deepEqual(resolveInclude("third_party/zlib/test/x.c", "config.h", context), [
    "third_party/zlib/config.h",
  ]);
});

test("an absolute path is not in the repository, whatever it happens to match", () => {
  const context = repo("src/a.c", "src/abs.h", "s/a.csx", "s/x.csx");
  assert.deepEqual(resolveInclude("src/a.c", "/abs.h", context), []);
  assert.deepEqual(resolveInclude("src/a.c", "C:\\abs.h", context), []);
  assert.deepEqual(resolveCSharpLoad("s/a.csx", "/x.csx", context), []);
});

test("a byte-order mark does not hide the first directive", () => {
  assert.deepEqual(readIncludes('\uFEFF#include "first.h"\n#include "second.h"\n'), ["first.h", "second.h"]);
  assert.deepEqual(readCSharpLoads('\uFEFF#load "a.csx"\n'), ["a.csx"]);
});

test("directive prose and a stray apostrophe do not abandon the file", () => {
  assert.deepEqual(readIncludes("#warning don't\n#include \"a.h\"\n"), ["a.h"]);
  assert.deepEqual(readIncludes("#if 0\nthis doesn't work\n#endif\n#include \"a.h\"\n"), ["a.h"]);
  assert.deepEqual(readCSharpLoads("#region Don't touch\n#load \"a.csx\"\n#endregion\n"), ["a.csx"]);
});

test("C# verbatim and raw strings are read by their own rules", () => {
  // A verbatim path ending in a backslash is not an escape.
  assert.deepEqual(readCSharpLoads('var p = @"C:\\dir\\";\n#load "a.csx"\n'), ["a.csx"]);
  // A verbatim string spans lines, and a `#load` inside it is text.
  assert.deepEqual(readCSharpLoads('var s = @"line one\n#load ""ghost.csx""\nline two";\n#load "a.csx"\n'), ["a.csx"]);
  assert.deepEqual(readCSharpLoads('var s = $@"x{y}""z";\n#load "a.csx"\n'), ["a.csx"]);
  assert.deepEqual(readCSharpLoads('var r = """\n#load "ghost.csx"\n""";\n#load "a.csx"\n'), ["a.csx"]);
});

test("a #load must be the first thing on its line as written", () => {
  assert.deepEqual(readCSharpLoads('/* a */ #load "ghost.csx"\n'), []);
  assert.deepEqual(readCSharpLoads('/*\n#load "ghost.csx"\n*/\n#load "real.csx"\n'), ["real.csx"]);
});

test("a large file is read in linear time and memory", () => {
  const started = Date.now();
  const includes = readIncludes(`${"x".repeat(3 * 1024 * 1024)}\n#include "end.h"\n`);
  assert.deepEqual(includes, ["end.h"]);
  assert.ok(Date.now() - started < 3000);
});
