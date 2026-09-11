import assert from "node:assert/strict";
import test from "node:test";

import {
  braceSymbolRanges,
  pythonSymbolRanges,
  rubySymbolRanges,
} from "./symbol-ranges.js";

/** `name:start-end` for each span, which is the whole of what callers use. */
function spans(
  ranges: { name: string; startLine: number; endLine: number }[] | undefined,
): string[] | undefined {
  return ranges?.map(
    (range) => `${range.name}:${range.startLine}-${range.endLine}`,
  );
}

test("a brace language places its declarations past comments and blank lines", () => {
  assert.deepEqual(
    spans(
      braceSymbolRanges(
        [
          "package main",
          "",
          'import "fmt"',
          "",
          "// Greet says hello. func NotThis()",
          "func Greet(name string) string {",
          '\treturn fmt.Sprintf("hi %s { }", name)',
          "}",
          "",
          "func Farewell() {",
          '\tfmt.Println("bye")',
          "}",
        ].join("\n"),
        "go",
      ),
    ),
    ["Greet:6-8", "Farewell:10-12"],
  );
});

test("a brace in a string or a comment does not move the spans", () => {
  // Both bodies contain a lone brace inside a literal. Counted as code they
  // would swallow everything after them.
  const ranges = braceSymbolRanges(
    [
      "class Greeter {",
      "    public String greet(String name) {",
      '        return "hi {" + name;',
      "    }",
      "",
      "    // a trailing } in a comment",
      "    private void quiet() {",
      '        System.out.println("}");',
      "    }",
      "}",
    ].join("\n"),
    "java",
  );
  assert.deepEqual(spans(ranges), [
    "Greeter:1-10",
    "greet:2-4",
    "quiet:7-9",
  ]);
});

test("an annotation belongs to the declaration under it", () => {
  // Editing `#[derive(Debug)]` is editing the thing it is attached to, so the
  // span has to start there rather than at the keyword.
  assert.deepEqual(
    spans(
      braceSymbolRanges(
        [
          "#[derive(Debug)]",
          "pub fn alpha(x: i32) -> i32 {",
          "    x + 1",
          "}",
        ].join("\n"),
        "rust",
      ),
    ),
    ["alpha:1-4"],
  );
});

test("a file whose braces do not balance is refused rather than guessed", () => {
  // The one genuinely harmful answer is a span that is too small, because it
  // grants a second agent lines the holder is working in. Saying nothing puts
  // the file back to whole-file arbitration, which is where it was.
  assert.equal(braceSymbolRanges("func Broken() {\n  if x {\n", "go"), undefined);
  assert.equal(braceSymbolRanges("}\nfunc After() {}\n", "go"), undefined);
});

test("ruby closes its declarations on the matching end", () => {
  assert.deepEqual(
    spans(
      rubySymbolRanges(
        [
          "class Greeter",
          "  def greet(name)",
          '    "hi #{name}"',
          "  end",
          "",
          "  def quiet",
          '    puts "end"',
          "  end",
          "end",
        ].join("\n"),
      ),
    ),
    ["Greeter:1-9", "greet:2-4", "quiet:6-8"],
  );
});

test("ruby refuses a file whose blocks do not close", () => {
  assert.equal(rubySymbolRanges("class Greeter\n  def greet\n"), undefined);
});

test("python is read by python, decorators and all", async () => {
  // The reader is the interpreter's own `ast`, so the cases a scanner gets
  // wrong are all covered at once: a `def` inside a docstring is a string, a
  // signature may span lines, and a decorator is part of what it decorates.
  const answers = await pythonSymbolRanges(
    new Map([
      [
        "m.py",
        [
          "import os",
          "",
          "",
          "def alpha():",
          '    """def not_this(): still a docstring"""',
          "    return 1",
          "",
          "",
          "@decorated",
          "def beta(",
          "    a,",
          "    b,",
          "):",
          "    return a + b",
          "",
          "",
          "class Gamma:",
          "    def method(self):",
          "        return 2",
        ].join("\n"),
      ],
    ]),
  );
  assert.deepEqual(spans(answers.files.get("m.py")?.ranges), [
    "alpha:4-6",
    "beta:9-14",
    "Gamma:17-19",
    "method:18-19",
  ]);
});

test("python that does not parse is left unanswered", async () => {
  // No entry at all, which the index records as "could not read" rather than
  // as "declares nothing" — the difference between withholding the whole file
  // and withholding none of it.
  const answers = await pythonSymbolRanges(new Map([["b.py", "def broken(:\n"]]));
  assert.equal(answers.files.has("b.py"), false);
});

test("asking for nothing spawns nothing", async () => {
  assert.equal((await pythonSymbolRanges(new Map())).files.size, 0);
});

test("a byte-order mark does not make a Python file unreadable", async () => {
  const read = await pythonSymbolRanges(
    new Map([["bom.py", "﻿import os\ndef f():\n    pass\n"]]),
  );
  assert.deepEqual(spans(read.files.get("bom.py")?.ranges), ["f:2-3"]);
});

test("a body-less declaration ends at the next declaration, not at the next brace in the file", () => {
  // `data class Ok(...) : Result()` has no body. Taking the next `{` in the
  // file for it swallowed `class Repo`, so Repo read as nested and vanished
  // from the top level.
  const sealed = braceSymbolRanges(
    [
      "package com.acme",
      "sealed class Result {",
      "  data class Ok(val v: Int) : Result()",
      "  object Loading : Result()",
      "}",
      "class Repo {",
      "  fun load(): Result = Loading",
      "}",
    ].join("\n"),
    "kotlin",
  );
  assert.deepEqual(spans(sealed), ["Result:2-5", "Ok:3-3", "Loading:4-5", "Repo:6-8", "load:7-7"]);
  // A lambda as a default value is not the class body.
  assert.deepEqual(
    spans(
      braceSymbolRanges(
        "class Widget(val onClick: () -> Unit = {}) {\n  class State {\n    val x = 1\n  }\n}\n",
        "kotlin",
      ),
    ),
    ["Widget:1-5", "State:2-4"],
  );
  // An expression body runs to the next declaration, never shorter.
  assert.deepEqual(
    spans(braceSymbolRanges("fun a(x: Int) =\n    x +\n    1\nfun b() {\n}\n", "kotlin")),
    ["a:1-3", "b:4-5"],
  );
});
