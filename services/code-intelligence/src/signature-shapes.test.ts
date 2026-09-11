/**
 * Contracts read from signatures, for the languages the compiler cannot read.
 *
 * Each language gets the same three questions: is the signature what a
 * caller depends on; does a change to the body, the formatting or a private
 * member leave the digest alone; does a change to the contract move it.
 * The digest is the whole point — it is what two branch claims are compared
 * by — so most assertions are about it rather than about the readable form.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { braceShapes, pythonShapes, rubyShapes } from "./signature-shapes.js";
import { pythonSymbolRanges } from "./symbol-ranges.js";

function shapeOf(shapes: { symbol: string; shape: string }[] | undefined, symbol: string): string | undefined {
  return shapes?.find((entry) => entry.symbol === symbol)?.shape;
}

function digestOf(shapes: { symbol: string; digest: string }[] | undefined, symbol: string): string | undefined {
  return shapes?.find((entry) => entry.symbol === symbol)?.digest;
}

function symbols(shapes: { symbol: string }[] | undefined): string[] | undefined {
  return shapes?.map((entry) => entry.symbol);
}

test("a Go function's contract is its parameters and results, not its body or its case", () => {
  const before = braceShapes(
    [
      "package billing",
      "",
      "// Charge charges. func NotThis()",
      "func Charge(amount int, currency string) (int, error) {",
      "\treturn amount, nil",
      "}",
      "",
      "func helper() {}",
      "",
      "type Money struct {",
      "\tAmount   int",
      "\tcurrency string",
      "}",
    ].join("\n"),
    "go",
  );
  assert.deepEqual(symbols(before), ["Charge", "Money"], "lower-case names are package-private");
  assert.equal(shapeOf(before, "Charge"), "func Charge(amount int, currency string) (int, error)");
  // A struct's fields are its contract, and inside a package the lower-case
  // ones are read by other files too.
  assert.equal(shapeOf(before, "Money"), "type Money struct {Amount int; currency string}");

  const bodyChanged = braceShapes(
    "package billing\n\nfunc Charge(amount int,\n\tcurrency string) (int, error) {\n\treturn 0, errors.New(\"no\")\n}\n",
    "go",
  );
  assert.equal(digestOf(bodyChanged, "Charge"), digestOf(before, "Charge"));
  const contractChanged = braceShapes(
    "package billing\n\nfunc Charge(amount float64, currency string) (int, error) {\n\treturn 0, nil\n}\n",
    "go",
  );
  assert.notEqual(digestOf(contractChanged, "Charge"), digestOf(before, "Charge"));
});

test("Rust: only pub is contract, and a struct with its impl blocks is one shape", () => {
  const shapes = braceShapes(
    [
      "pub fn charge(amount: u32, currency: &str) -> Result<(), Error> {",
      "    Ok(())",
      "}",
      "fn private_fn(x: i32) {}",
      "pub struct Money { pub amount: u32, currency: String }",
      "impl Money {",
      "    pub fn new(amount: u32) -> Self {",
      '        Money { amount, currency: "usd".into() }',
      "    }",
      "    fn secret(&self) {}",
      "}",
      "pub enum Kind { A, B = 3, C }",
      "pub trait Store {",
      "    fn get(&self, id: &str) -> Option<Money>;",
      "}",
    ].join("\n"),
    "rust",
  );
  assert.deepEqual(symbols(shapes), ["charge", "Kind", "Money", "new", "Store"]);
  assert.equal(
    shapeOf(shapes, "Money"),
    "impl Money {pub fn new(amount: u32) -> Self} | pub struct Money {pub amount: u32}",
  );
  // Variants and trait items are as public as the type.
  assert.equal(shapeOf(shapes, "Kind"), "pub enum Kind {A; B = 3; C}");
  assert.equal(shapeOf(shapes, "Store"), "pub trait Store {fn get(&self, id: &str) -> Option<Money>}");
  // A caller passes by position, so renaming a parameter moves nothing.
  const renamed = braceShapes("pub fn charge(amt: u32, cur: &str) -> Result<(), Error> {\n}\n", "rust");
  assert.equal(digestOf(renamed, "charge"), digestOf(shapes, "charge"));
  const retyped = braceShapes("pub fn charge(amount: u64, currency: &str) -> Result<(), Error> {\n}\n", "rust");
  assert.notEqual(digestOf(retyped, "charge"), digestOf(shapes, "charge"));
  // An associated-type binding is not an expression body.
  const generic = braceShapes(
    "pub fn generic<T: Iterator<Item = u8>>(it: T) -> usize where T: Clone {\n    0\n}\n",
    "rust",
  );
  assert.equal(
    shapeOf(generic, "generic"),
    "pub fn generic<T: Iterator<Item = u8>>(it: T) -> usize where T: Clone",
  );
});

test("Java: the public surface, with parameter names out of the digest and initializers out of the shape", () => {
  const shapes = braceShapes(
    [
      "package com.acme;",
      "public class Money implements Comparable<Money> {",
      "    private int amount;",
      "    public static final int MAX = 1;",
      "    public Money(int amount) {",
      "        this.amount = amount;",
      "    }",
      "    public int getAmount() {",
      "        return amount;",
      "    }",
      "    private void secret() {}",
      "    public <T> List<T> convert(List<T> in, String... rest) throws IOException {",
      "        return in;",
      "    }",
      "}",
      "public enum Color { RED, GREEN, BLUE; public int code() { return 1; } }",
    ].join("\n"),
    "java",
  );
  assert.equal(
    shapeOf(shapes, "Money"),
    "public class Money implements Comparable<Money> {public <T> List<T> convert(List<T> in, String... rest) throws IOException; public int getAmount(); public Money(int amount); public static final int MAX}",
  );
  // Enum constants keep their order: an ordinal is a position.
  assert.equal(shapeOf(shapes, "Color"), "public enum Color {RED; GREEN; BLUE; public int code()}");
  const reordered = braceShapes("public enum Color { GREEN, RED, BLUE; public int code() { return 1; } }", "java");
  assert.notEqual(digestOf(reordered, "Color"), digestOf(shapes, "Color"));
  const renamed = braceShapes(
    "public class Money {\n    public Money(int value) {\n    }\n    public int getAmount() {\n        return 0;\n    }\n    public <T> List<T> convert(List<T> input, String... more) throws IOException {\n        return input;\n    }\n    public static final int MAX = 2;\n}\n",
    "java",
  );
  // Same members, different parameter names and initializer, no heritage
  // clause: only the last of those is a contract change.
  assert.notEqual(digestOf(renamed, "Money"), digestOf(shapes, "Money"));
  const renamedWithHeritage = braceShapes(
    "public class Money implements Comparable<Money> {\n    public Money(int value) {\n    }\n    public int getAmount() {\n        return 0;\n    }\n    public <T> List<T> convert(List<T> input, String... more) throws IOException {\n        return input;\n    }\n    public static final int MAX = 2;\n}\n",
    "java",
  );
  assert.equal(digestOf(renamedWithHeritage, "Money"), digestOf(shapes, "Money"));
});

test("Kotlin: an expression body is cut, and only it leaves the return type to inference", () => {
  const shapes = braceShapes(
    [
      "class Money(val amount: Int) : Comparable<Money> {",
      "    fun plus(other: Money) = Money(amount + other.amount)",
      "    fun format(): String { return \"x\" }",
      "    fun unit(x: Int) { println(x) }",
      "    private fun secret() {}",
      "}",
      "interface Store {",
      "    fun get(id: String): Money?",
      "    fun put(m: Money)",
      "}",
    ].join("\n"),
    "kotlin",
  );
  assert.equal(
    shapeOf(shapes, "Money"),
    "class Money(val amount: Int) : Comparable<Money> {fun format(): String; fun plus(other: Money); fun unit(x: Int)}",
  );
  assert.equal(shapes?.find((entry) => entry.symbol === "plus")?.inferred, true);
  assert.equal(shapes?.find((entry) => entry.symbol === "unit")?.inferred, undefined);
  // Body-less interface members end at the next declaration, not at the
  // next brace in the file.
  assert.equal(shapeOf(shapes, "get"), "fun get(id: String): Money?");
  assert.equal(shapeOf(shapes, "Store"), "interface Store {fun get(id: String): Money?; fun put(m: Money)}");
});

test("C#: an Allman brace and an expression body both end the head", () => {
  const shapes = braceShapes(
    [
      "public class Money : IComparable<Money>",
      "{",
      "    public int Amount { get; set; }",
      "    private int secret;",
      "    public Money(int amount)",
      "    {",
      "        Amount = amount;",
      "    }",
      "    public int Double() => Amount * 2;",
      "    public static Money Parse(string text, out bool ok)",
      "    {",
      "        ok = true; return new Money(1);",
      "    }",
      "}",
    ].join("\n"),
    "csharp",
  );
  assert.equal(shapeOf(shapes, "Parse"), "public static Money Parse(string text, out bool ok)");
  assert.equal(shapeOf(shapes, "Double"), "public int Double()");
  assert.equal(
    shapeOf(shapes, "Money"),
    "public class Money : IComparable<Money> {public int Amount; public int Double(); public Money(int amount); public static Money Parse(string text, out bool ok)}",
  );
});

test("C and C++: static is file-private at file scope and a member inside a class", () => {
  const c = braceShapes(
    [
      "static int helper(int x) {",
      "    return x;",
      "}",
      "int charge(int amount, const char *currency) {",
      "    return amount;",
      "}",
      "int callback(void (*fn)(int), int arr[]) {",
      "    return 0;",
      "}",
      "struct money { int amount; char currency[4]; };",
    ].join("\n"),
    "c",
  );
  assert.deepEqual(symbols(c), ["callback", "charge", "money"]);
  // A function-pointer parameter is left as written rather than mangled.
  assert.equal(shapeOf(c, "callback"), "int callback(void (*fn)(int), int arr[])");
  const renamed = braceShapes("int charge(int a, const char *c) {\n    return a;\n}\n", "c");
  assert.equal(digestOf(renamed, "charge"), digestOf(c, "charge"));

  const cpp = braceShapes(
    [
      "namespace acme {",
      "class Money {",
      "    int amount;",
      "    void hidden();",
      "public:",
      "    int get() const { return amount; }",
      "    static Money parse(const std::string& text) { return Money(1); }",
      "protected:",
      "    void guarded() {}",
      "};",
      "struct Point { int x; int y; };",
      "static int filePrivate(int x) {",
      "    return x;",
      "}",
      "}",
    ].join("\n"),
    "cpp",
  );
  assert.equal(
    shapeOf(cpp, "Money"),
    "class Money {int get() const; static Money parse(const std::string& text)}",
  );
  assert.equal(shapeOf(cpp, "Point"), "struct Point {int x; int y}");
  assert.equal(shapeOf(cpp, "acme"), "namespace acme {class Money; struct Point}");
});

test("PHP, Swift and Scala: return types that may be omitted are marked inferred only where the language infers", () => {
  const php = braceShapes(
    [
      "<?php",
      "class Money {",
      "    private int $amount;",
      "    public function __construct(int $amount) { $this->amount = $amount; }",
      "    public function add(Money $other): Money { return $this; }",
      "    public function untyped($x) { return $x; }",
      "    private function secret() {}",
      "}",
    ].join("\n"),
    "php",
  );
  assert.equal(
    shapeOf(php, "Money"),
    "class Money {public function __construct(int $amount); public function add(Money $other): Money; public function untyped($x)}",
  );
  assert.equal(php?.find((entry) => entry.symbol === "untyped")?.inferred, true);
  assert.equal(php?.find((entry) => entry.symbol === "__construct")?.inferred, undefined);

  const swift = braceShapes(
    [
      "public struct Money: Comparable {",
      "    public let amount: Int",
      "    private var secret: Int = 0",
      "    public func format(with style: Style, precision: Int) -> String { \"\" }",
      "    func untyped(x: Int) { }",
      "}",
    ].join("\n"),
    "swift",
  );
  // Argument labels are what a caller writes, so they stay in the digest.
  assert.equal(shapeOf(swift, "format"), "public func format(with style: Style, precision: Int) -> String");
  const relabelled = braceShapes("public func format(using style: Style, precision: Int) -> String { \"\" }", "swift");
  assert.notEqual(digestOf(relabelled, "format"), digestOf(swift, "format"));
  assert.equal(swift?.find((entry) => entry.symbol === "untyped")?.inferred, undefined);

  const scala = braceShapes(
    [
      "class Money(val amount: Int) extends Ordered[Money] {",
      "  def +(other: Money): Money = Money(amount + other.amount)",
      "  def format: String = \"x\"",
      "  def guess(x: Int) = x + 1",
      "  private def secret(): Unit = ()",
      "}",
      "object Money { def apply(a: Int): Money = new Money(a) }",
    ].join("\n"),
    "scala",
  );
  assert.equal(
    shapeOf(scala, "Money"),
    "class Money(val amount: Int) extends Ordered[Money] {def +(other: Money): Money; def format: String; def guess(x: Int)} | object Money {def apply(a: Int): Money}",
  );
  assert.equal(scala?.find((entry) => entry.symbol === "format")?.inferred, undefined);
  assert.equal(scala?.find((entry) => entry.symbol === "guess")?.inferred, true);
});

test("Ruby: the def line, minus whatever a bare private line hides", () => {
  const shapes = rubyShapes(
    [
      "class Money < Struct",
      "  attr_reader :amount",
      '  def initialize(amount, currency: "usd")',
      "    @amount = amount",
      "  end",
      "  def format a, b = 1",
      '    "x"',
      "  end",
      "  private",
      "  def secret",
      "  end",
      "  public",
      "  def shown; 1; end",
      "  private def also_secret(x)",
      "  end",
      "end",
      "def top_level(x)",
      "end",
      "module Util",
      "  def self.helper(y)",
      "  end",
      "end",
    ].join("\n"),
  );
  assert.deepEqual(symbols(shapes), ["format", "helper", "initialize", "Money", "shown", "top_level", "Util"]);
  assert.equal(shapeOf(shapes, "initialize"), '(amount, currency: "usd")');
  assert.equal(shapeOf(shapes, "format"), "(a, b = 1)");
  assert.equal(
    shapeOf(shapes, "Money"),
    '< Struct {format(a, b = 1); initialize(amount, currency: "usd"); shown}',
  );
  assert.equal(shapeOf(shapes, "Util"), "{self.helper(y)}");
  // Nothing is typed, so everything is inferred.
  assert.ok(shapes?.filter((entry) => entry.kind === "function").every((entry) => entry.inferred));
});

test("Python: the interpreter reads the signature, with defaults as optionality and names kept", async () => {
  const read = await pythonSymbolRanges(
    new Map([
      [
        "m.py",
        [
          "import os",
          'def charge(amount: int, currency: str = "usd", *, force: bool = False) -> bool:',
          "    return True",
          "async def fetch(url):",
          "    pass",
          "def _private(x):",
          "    pass",
          "class Money(Base, metaclass=Meta):",
          "    amount: int",
          "    RATE = 1",
          "    _hidden = 2",
          "    def __init__(self, amount: int) -> None:",
          "        self.amount = amount",
          "    def add(self, other):",
          "        return self",
          "    def _secret(self):",
          "        pass",
          "    @property",
          "    def formatted(self) -> str:",
          '        return ""',
          "def posonly(a, b, /, c, *args, d, **kw) -> None:",
          "    pass",
        ].join("\n"),
      ],
      ["changed.py", "def charge(amount: float, currency: str = \"usd\", *, force: bool = False) -> bool:\n    return False\n"],
      ["body.py", "def charge(amount: int, currency: str = \"eur\", *, force: bool = True) -> bool:\n    return not force\n"],
    ]),
  );
  const shapes = pythonShapes(read.files.get("m.py")?.shapes ?? []);
  assert.deepEqual(symbols(shapes), ["charge", "fetch", "Money", "posonly"]);
  assert.equal(shapeOf(shapes, "charge"), "(amount: int, currency: str?, *, force: bool?) -> bool");
  assert.equal(shapes.find((entry) => entry.symbol === "charge")?.inferred, undefined);
  assert.equal(shapeOf(shapes, "fetch"), "async (url)");
  assert.equal(shapes.find((entry) => entry.symbol === "fetch")?.inferred, true);
  assert.equal(shapeOf(shapes, "posonly"), "(a, b, /, c, *args, d, **kw) -> None");
  assert.equal(
    shapeOf(shapes, "Money"),
    "(Base, metaclass=Meta) {RATE; __init__(self, amount: int) -> None; add(self, other); amount: int; formatted(self) -> str}",
  );
  // A default's value and a body are not contract; a parameter's type is.
  const changed = pythonShapes(read.files.get("changed.py")?.shapes ?? []);
  const body = pythonShapes(read.files.get("body.py")?.shapes ?? []);
  assert.equal(digestOf(body, "charge"), digestOf(shapes, "charge"));
  assert.notEqual(digestOf(changed, "charge"), digestOf(shapes, "charge"));
});

test("a file the masker cannot follow has unknown shapes, not empty ones", () => {
  assert.equal(braceShapes('func Broken() { s := "unterminated\n}\n', "go"), undefined);
  assert.equal(braceShapes("class Unbalanced {\n", "java"), undefined);
  assert.equal(rubyShapes("class Open\n  def never_closed\nend\n"), undefined);
  // Whereas a file that declares nothing has, honestly, no shapes.
  assert.deepEqual(braceShapes("package empty\n", "go"), []);
});
