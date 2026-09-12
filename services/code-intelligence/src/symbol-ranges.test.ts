import assert from "node:assert/strict";
import test from "node:test";

import {
  braceDeclarations,
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

test("ruby: a modifier if, unless, while or until is not a block, and a one-line block is not one either", () => {
  // A guard clause is in nearly every Ruby method. Counting `return nil if
  // x.nil?` as a block opener left the depth one short at the end of every
  // such file, which refused the file — honest, but it made the Ruby shape
  // path inert for real code.
  assert.deepEqual(
    spans(
      rubySymbolRanges(
        [
          "class A",
          "  def go(x)",
          "    return nil if x.nil?",
          "    raise ArgumentError unless x.respond_to?(:to_s)",
          "    x += 1 while x < 3",
          "    y = if x then 1 else 2 end",
          "    [x].each do |v| v end",
          "    z = if x",
          "      1",
          "    end",
          "    [z].map do |v|",
          "      v",
          "    end.each do |v|",
          "      v",
          "    end",
          "    x",
          "  end",
          "end",
        ].join("\n"),
      ),
    ),
    ["A:1-18", "go:2-17"],
  );
  // The block form still opens, and a file that never closes it is still refused.
  assert.deepEqual(spans(rubySymbolRanges("def go(x)\n  if x\n    1\n  end\nend\n")), ["go:1-5"]);
  assert.equal(rubySymbolRanges("def go(x)\n  if x\n    1\nend\n"), undefined);
});

test("ruby: an operator method is a declaration, and a string is not code", () => {
  // `def ==(other)` was not a declaration at all, so the method had no
  // range and its class shape had no such member; its one-line form
  // `def <=>(o); 0; end` closed the enclosing class early and refused the
  // file. The scanner now reads the masked text, so `puts "the end"` and a
  // heredoc holding `end` are not closers and `# end` is not one either.
  assert.deepEqual(
    spans(
      rubySymbolRanges(
        [
          "class V",
          "  def ==(other)",
          '    puts "the end"',
          "  end",
          "  def <=>(o); 0; end",
          "  def [](i)",
          "    <<~SQL",
          "      end",
          "    SQL",
          "  end",
          "  def -@ # end",
          "  end",
          "  def []=(k, v)",
          "  end",
          "end",
        ].join("\n"),
      ),
    ),
    ["V:1-15", "==:2-4", "<=>:5-5", "[]:6-10", "-@:11-12", "[]=:13-14"],
  );
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

/** The names of a file's declarations as the shape reader would see them. */
function declared(source: string, language: Parameters<typeof braceDeclarations>[1]): string[] | undefined {
  return braceDeclarations(source, language)?.declarations.map(
    (declaration) => `${declaration.name}:${declaration.declared}`,
  );
}

test("a C function whose body has no semicolon does not swallow the function after it", () => {
  // The old function pattern ran from the `(` to the last line end before
  // the first `;`, so an empty stub, an Allman brace or a same-line overload
  // took the next head with it and that function was never read. A one-line
  // definition and a prototype, whose `;` is on the same line, were never
  // read at all.
  assert.deepEqual(
    spans(braceSymbolRanges("void noop(void) {}\nint add(int a, int b) {\n    return a + b;\n}\n", "c")),
    ["noop:1-1", "add:2-4"],
  );
  assert.deepEqual(
    spans(braceSymbolRanges("void init(void)\n{\n}\n\nint add(int a, int b)\n{\n    return a + b;\n}\n", "c")),
    ["init:1-3", "add:5-8"],
  );
  assert.deepEqual(
    spans(braceSymbolRanges("inline int sq(int x) { return x * x; }\nint proto(int a, int b);\n", "c")),
    ["sq:1-1", "proto:2-2"],
  );
  assert.deepEqual(
    spans(braceSymbolRanges("public class O {\n    public void f(int a) {}\n    public void f(String s) {}\n}\n", "java")),
    ["O:1-4", "f:2-3"],
  );
  // But a statement is not a declaration: `return frobnicate(` has the same
  // shape as `int frobnicate(`.
  assert.deepEqual(
    declared("int run() {\n    auto r = compute(1, 2);\n    return frobnicate(\n        r);\n}\n", "cpp"),
    ["run:function"],
  );
  assert.deepEqual(
    declared("void f(int a) {\n    if (a)\n    {\n        return;\n    }\n    else if (a > 1)\n    {\n        return;\n    }\n}\n", "c"),
    ["f:function"],
  );
});

test("a body-less head ends before a line that cannot continue it", () => {
  // `val DEFAULT` is not a declaration the patterns know, so the head of the
  // data class above it used to run on into it, and renaming the value moved
  // the class's digest.
  assert.deepEqual(
    spans(braceSymbolRanges("data class Foo(val x: Int)\n\nval DEFAULT = Foo(1)\n", "kotlin")),
    ["Foo:1-1"],
  );
  assert.deepEqual(
    spans(braceSymbolRanges("abstract class Base {\n    abstract fun render(): String\n    private val cache = 1\n}\n", "kotlin")),
    ["Base:1-4", "render:2-2"],
  );
  // A GNU-style return type on its own line is still one head.
  assert.deepEqual(
    spans(braceSymbolRanges("int\nmain(int argc, char **argv)\n{\n    return 0;\n}\n", "c")),
    ["main:1-5"],
  );
});

test("the = of an operator name or a function type does not end a head", () => {
  // `def ==` is a name; the head runs on to its expression body. `=>` names
  // a function type in Scala and opens an expression body in C#.
  assert.deepEqual(
    spans(braceSymbolRanges("class V {\n  def ==(o: V): Boolean = true\n  def +=(x: Int): this.type = this\n}\n", "scala")),
    ["V:1-4", "==:2-2", "+=:3-3"],
  );
  const heads = (source: string, language: Parameters<typeof braceDeclarations>[1]): string[] => {
    const read = braceDeclarations(source, language);
    return (read?.declarations ?? []).map((declaration) =>
      read?.code.slice(declaration.start, declaration.headEnd).trim() ?? "",
    );
  };
  assert.deepEqual(
    heads("class V {\n  def +=(x: Int): this.type = this\n  def f: Int => String = x => x.toString\n}\n", "scala"),
    ["class V", "def +=(x: Int): this.type", "def f: Int => String"],
  );
  assert.deepEqual(
    heads("class Money {\npublic:\n    Money& operator=(const Money& o);\n    bool operator==(const Money& o) const;\n};\n", "cpp"),
    ["class Money", "Money& operator=(const Money& o)", "bool operator==(const Money& o) const"],
  );
  assert.deepEqual(
    spans(braceSymbolRanges("public class C\n{\n    public int X() => Compute(1);\n    public int Y() => 2;\n}\n", "csharp")),
    ["C:1-5", "X:3-3", "Y:4-4"],
  );
});

test("a file cut off inside a parameter list has unknown declarations, not a truncated head", () => {
  // Its braces balance because there are none, so only the brackets say the
  // file is not whole. The ranges keep answering, never too small.
  assert.equal(braceDeclarations("int f(int a,\n      int b", "cpp"), undefined);
  assert.equal(braceDeclarations("package p\nfunc F(a int,\n\tb int", "go"), undefined);
  assert.deepEqual(declared("int f(int a, int b) {\n}\n", "c"), ["f:function"]);
});

test("a character literal is not a brace, and a PHP attribute is not a comment", () => {
  // `'{'` counted as a brace put the `open` body's text into `Lexer`'s
  // members; a Rust lifetime, written with the same quote, must still not
  // be read as a string.
  assert.deepEqual(
    spans(braceSymbolRanges("impl Lexer {\n    pub fn open(&self, c: char) -> bool {\n        if c == '}' { return false; }\n        c == '{'\n    }\n}\nfn after<'a>(x: &'a str) -> &'a str { x }\n", "rust")),
    ["Lexer:1-6", "open:2-5", "after:7-7"],
  );
  assert.deepEqual(
    spans(braceSymbolRanges("<?php\nclass Ctl {\n    #[Route('/x')] public function index(): string { return ''; }\n    # a real comment { with a brace\n    public function other(): int { return 1; }\n}\n", "php")),
    ["Ctl:2-6", "index:3-3", "other:5-5"],
  );
});

test("declarations the patterns used to miss", () => {
  // The ABI string of `extern "C"` is blanked before matching, so the
  // pattern has to accept the blank; `[[nodiscard]]` and `__attribute__`
  // precede a return type; a Go type need not be a struct.
  assert.deepEqual(
    declared("pub extern \"C\" fn add(a: u32, b: u32) -> u32 {\n    a + b\n}\npub type Id = u32;\npub const MAX: u32 = 1;\n", "rust"),
    ["add:function", "Id:type", "MAX:type"],
  );
  assert.deepEqual(
    declared("[[nodiscard]] int compute(int x) {\n    return x;\n}\nstd::ostream& operator<<(std::ostream& os, const Money& m) {\n    return os;\n}\nclass Fwd;\n", "cpp"),
    ["compute:function", "operator<<:function"],
  );
  assert.deepEqual(
    declared("typedef struct {\n    int amount;\n} money_t;\nint stat_it(void) {\n    struct stat st;\n    return 0;\n}\n", "c"),
    ["money_t:type", "stat_it:function"],
  );
  assert.deepEqual(
    declared("package p\n\ntype (\n\tMoney struct {\n\t\tAmount int\n\t}\n)\ntype List[T any] struct {\n\tMeta struct {\n\t\tID int\n\t}\n}\ntype ID string\ntype Alias = List[int]\n", "go"),
    ["Money:type", "List:type", "ID:type", "Alias:type"],
  );
  const alias = braceDeclarations("package p\ntype Alias = List[int]\n", "go");
  assert.equal(
    alias?.code.slice(alias.declarations[0]?.start, alias.declarations[0]?.headEnd).trim(),
    "type Alias = List[int]",
    "an alias's = is its contract, not a value",
  );
  assert.deepEqual(
    declared("enum class Color { RED, GREEN }\nfun <T : Comparable<T>> maxOf(a: T, b: T): T = a\ninfix fun Int.times(x: Int): Int = this * x\nfun <K, V> Map<K, V>.toQuery(): String = \"\"\nfun interface Handler {\n    fun handle(x: Int): String\n}\n", "kotlin"),
    ["Color:type", "maxOf:function", "times:function", "toQuery:function", "Handler:type", "handle:function"],
  );
  assert.deepEqual(
    declared("open class Factory {\n    open class func make(count: Int) -> Factory {\n        return Factory()\n    }\n    public static func == (lhs: Factory, rhs: Factory) -> Bool { true }\n}\n", "swift"),
    ["Factory:type", "make:function", "==:function"],
  );
});
