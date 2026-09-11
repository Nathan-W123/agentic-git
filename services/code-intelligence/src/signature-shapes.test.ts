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
  // Code-point order, which no process locale can change.
  assert.deepEqual(symbols(shapes), ["Kind", "Money", "Store", "charge", "new"]);
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
    "public class Money implements Comparable<Money> {public <T> List<T> convert(List<T> in, String... rest) throws IOException; public Money(int amount); public int getAmount(); public static final int MAX}",
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
    "public class Money : IComparable<Money> {public Money(int amount); public int Amount; public int Double(); public static Money Parse(string text, out bool ok)}",
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
  assert.deepEqual(symbols(shapes), ["Money", "Util", "format", "helper", "initialize", "shown", "top_level"]);
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
  assert.deepEqual(symbols(shapes), ["Money", "charge", "fetch", "posonly"]);
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

/** Whether two sources hash one symbol the same, which is the whole question. */
function sameDigest(language: Parameters<typeof braceShapes>[1], before: string, after: string, symbol: string): boolean {
  const left = digestOf(braceShapes(before, language), symbol);
  const right = digestOf(braceShapes(after, language), symbol);
  assert.ok(left !== undefined && right !== undefined, `${symbol} must be read on both sides`);
  return left === right;
}

test("wrapping a parameter list, a throws clause or an initializer moves nothing", () => {
  // gofmt, ktfmt and PSR-12 all break a long parameter list one per line
  // with a trailing comma; the head used to be hashed with that whitespace.
  assert.ok(sameDigest("go",
    "package p\n\nfunc Charge(amount int, currency string) (int, error) {\n\treturn 0, nil\n}\n",
    "package p\n\nfunc Charge(\n\tamount int,\n\tcurrency string,\n) (int, error) {\n\treturn 0, nil\n}\n", "Charge"));
  assert.ok(sameDigest("kotlin", "fun foo(x: Int): Int {\n    return x\n}\n", "fun foo(x : Int) : Int {\n    return x\n}\n", "foo"));
  assert.ok(sameDigest("csharp", "public static int F(int x)\n{\n    return x;\n}\n", "public static int F( int x )\n{\n    return x;\n}\n", "F"));
  // Inside a type body the members used to be split on every newline, so a
  // wrapped member became several garbage members.
  assert.ok(sameDigest("java",
    "public class Money {\n    public int add(int a, int b) throws IOException {\n        return a + b;\n    }\n    public static final List<Integer> P = List.of(2, 3);\n}\n",
    "public class Money {\n    public int add(\n            int a,\n            int b)\n            throws IOException {\n        return a + b;\n    }\n    public static final List<Integer> P = List.of(\n        2,\n        3);\n}\n", "Money"));
  assert.equal(
    shapeOf(braceShapes("package p\ntype Store interface {\n\tGet(\n\t\tid string,\n\t\topts Options,\n\t) (Money, error)\n}\n", "go"), "Store"),
    "type Store interface {Get(id string, opts Options) (Money, error)}",
  );
  assert.ok(sameDigest("kotlin", "class R {\n    fun build(): Foo = Foo(1)\n}\n", "class R {\n    fun build(): Foo =\n        Foo(1)\n}\n", "R"));
  assert.ok(sameDigest("csharp", "public class C\n{\n    public int X => Compute(1);\n}\n", "public class C\n{\n    public int X =>\n        Compute(1);\n}\n", "C"));
});

test("members and symbols are ordered by code point, which no process locale can change", () => {
  // `localeCompare` put `alpha` before `Zeta` under en_US and `aardvark`
  // after `zebra` under da_DK, so one file had a different digest on each
  // developer's machine. Code-point order puts upper case first everywhere.
  const shapes = braceShapes("public class S {\n    public void alpha() {}\n    public void Zeta() {}\n}\n", "java");
  assert.equal(shapeOf(shapes, "S"), "public class S {public void Zeta(); public void alpha()}");
  assert.deepEqual(symbols(shapes), ["S", "Zeta", "alpha"]);
});

test("an = inside an operator name does not cut the member, and = delete is kept", () => {
  // Every non-enum member was cut at its first `=`, so `bool operator==(...)`
  // became `bool operator` and deleting a copy constructor was invisible.
  const cpp = braceShapes(
    "class NC {\npublic:\n    NC(const NC&) = delete;\n    NC& operator=(const NC&) = default;\n    bool operator==(const NC& o) const;\n    NC& operator+=(int n);\n    virtual int pure() = 0;\n    int n = 0;\n    using Ptr = std::shared_ptr<NC>;\n};\n",
    "cpp",
  );
  // A constructor shares its class's name, so the symbol is both pieces.
  assert.equal(
    shapeOf(cpp, "NC"),
    "NC(const NC&) = delete | class NC {NC& operator+=(int n); NC& operator=(const NC&) = default; NC(const NC&) = delete; bool operator==(const NC& o) const; int n; using Ptr = std::shared_ptr<NC>; virtual int pure() = 0}",
  );
  assert.equal(shapeOf(cpp, "pure"), "virtual int pure() = 0");
  assert.ok(!sameDigest("cpp", "class NC {\npublic:\n    NC(const NC&) = delete;\n};\n", "class NC {\npublic:\n    NC(const NC&);\n};\n", "NC"));
  assert.ok(!sameDigest("csharp",
    "public struct M\n{\n    public static bool operator ==(M a, M b) => true;\n}\n",
    "public struct M\n{\n    public static bool operator ==(M a, object b) => true;\n}\n", "M"));
  assert.equal(shapeOf(braceShapes("class V {\n  def ==(o: V): Boolean = true\n  def +=(x: Int): this.type = this\n}\n", "scala"), "V"), "class V {def +=(x: Int): this.type; def ==(o: V): Boolean}");
  assert.equal(shapeOf(braceShapes("public struct P: Equatable {\n    public static func == (lhs: P, rhs: P) -> Bool { true }\n}\n", "swift"), "P"), "public struct P: Equatable {public static func == (lhs: P, rhs: P) -> Bool}");
});

test("the > of an arrow is not a closing bracket", () => {
  // Counting it as one drove the depth negative, after which commas stopped
  // splitting and `=` stopped cutting: a closure parameter's default vanished
  // and a positional rename after an `impl Fn(..) -> ..` parameter moved.
  assert.ok(!sameDigest("kotlin",
    "class L {\n    fun load(onError: (Throwable) -> Unit = {}, retries: Int) {}\n}\n",
    "class L {\n    fun load(onError: (Throwable) -> Unit, retries: Int) {}\n}\n", "L"));
  assert.ok(sameDigest("rust",
    "pub fn fold(f: impl Fn(u8) -> u8, init: u8) -> u8 {\n    init\n}\n",
    "pub fn fold(f: impl Fn(u8) -> u8, acc: u8) -> u8 {\n    acc\n}\n", "fold"));
  assert.equal(shapeOf(braceShapes("class Ops {\n  val g: Int => String = _.toString\n  def apply(f: Int => Int): Int = f(1)\n}\n", "scala"), "Ops"), "class Ops {def apply(f: Int => Int): Int; val g: Int => String}");
});

test("a C parameter keeps its pointer when it loses its name", () => {
  // Dropping the last whitespace-separated token took `*s` with it, so
  // `char *s` and `char s` hashed the same, while the spacing styles
  // `char *s` and `char* s` hashed differently.
  assert.ok(!sameDigest("c", "int f(char *s, void *ctx) {\n    return 0;\n}\n", "int f(char s, void ctx) {\n    return 0;\n}\n", "f"));
  assert.ok(!sameDigest("c", "int g(void *ctx) {\n    return 0;\n}\n", "int g(void) {\n    return 0;\n}\n", "g"));
  assert.ok(!sameDigest("cpp", "int h(const Money &m) {\n    return 0;\n}\n", "int h(const Money m) {\n    return 0;\n}\n", "h"));
  assert.ok(sameDigest("c", "int f(char *s, unsigned u, int a[]) {\n    return 0;\n}\n", "int f(char* t, unsigned v, int b[]) {\n    return 0;\n}\n", "f"));
});

test("that a parameter has a default is contract; what it defaults to is not", () => {
  // The rule the Python reader already kept: a default's value is replaced
  // by a marker in the comparable form, for every language.
  assert.ok(sameDigest("kotlin", "fun retry(times: Int = 3) {}\n", "fun retry(times: Int = 5) {}\n", "retry"));
  assert.ok(!sameDigest("kotlin", "fun retry(times: Int = 3) {}\n", "fun retry(times: Int) {}\n", "retry"));
  assert.ok(sameDigest("csharp", "public class D\n{\n    public void Retry(int times = 3) {}\n}\n", "public class D\n{\n    public void Retry(int times = 5) {}\n}\n", "D"));
  assert.ok(sameDigest("php", "<?php\nfunction retry(int $times = 3): void {}\n", "<?php\nfunction retry(int $times = 5): void {}\n", "retry"));
  assert.ok(sameDigest("cpp", "void f(int x = 5, std::vector<int> v = {}) {\n}\n", "void f(int y = 6, std::vector<int> w = {1}) {\n}\n", "f"));
  // A property's initializer is a value even when its type has an arrow.
  assert.ok(sameDigest("kotlin", "class P {\n    val f: (Int) -> Int = ::double\n}\n", "class P {\n    val f: (Int) -> Int = ::triple\n}\n", "P"));
});

test("a private member is private wherever its modifier sits, and an attribute hides nothing", () => {
  // Reachability looked at the first word only: `@Inject private`,
  // `static private` and `[JsonIgnore] private` were hashed as public, and a
  // Rust `#[serde(default)] pub` field was dropped for not starting with `pub`.
  assert.equal(shapeOf(braceShapes("public class Svc {\n    @Inject private Repo repo;\n    static private int helper(int x) { return x; }\n    public void run() {}\n}\n", "java"), "Svc"), "public class Svc {public void run()}");
  assert.equal(shapeOf(braceShapes("public class Dto\n{\n    [JsonIgnore] private string secret;\n    public string Name { get; set; }\n}\n", "csharp"), "Dto"), "public class Dto {public string Name}");
  assert.equal(shapeOf(braceShapes("pub struct Cfg {\n    #[serde(default)] pub retries: u32,\n    pub name: String,\n}\n", "rust"), "Cfg"), "pub struct Cfg {pub name: String; pub retries: u32}");
  // Swift's `private(set)` hides only the setter.
  assert.equal(shapeOf(braceShapes("public struct Counter {\n    private(set) var count: Int = 0\n}\n", "swift"), "Counter"), "public struct Counter {private(set) var count: Int}");
});

test("preprocessor lines are not members, and a C++ label applies to the rest of its line", () => {
  assert.ok(sameDigest("csharp",
    "public class Svc\n{\n    #region Public API\n    public int Get() => 1;\n    #endregion\n}\n",
    "public class Svc\n{\n    #region Api\n    public int Get() => 1;\n    #endregion\n}\n", "Svc"));
  assert.equal(shapeOf(braceShapes("public struct Cfg {\n#if DEBUG\n    public let verbose: Bool\n#endif\n}\n", "swift"), "Cfg"), "public struct Cfg {public let verbose: Bool}");
  // `public: int get() const;` used to leave everything after it private.
  assert.equal(shapeOf(braceShapes("class W {\npublic: int get() const;\n    int x;\n};\n", "cpp"), "W"), "class W {int get() const; int x}");
});

test("an enum's raw values are contract even when they are strings", () => {
  // Strings are blanked before reading, so `case Hearts = 'H'` read as
  // `case Hearts =` and a change of the serialized value shipped unnoticed.
  assert.equal(shapeOf(braceShapes("<?php\nenum Suit: string {\n    case Hearts = 'H';\n    case Spades = 'S';\n}\n", "php"), "Suit"), "enum Suit: string {case Hearts = 'H'; case Spades = 'S'}");
  assert.ok(!sameDigest("swift",
    "public enum Suit: String {\n    case hearts = \"hearts\"\n}\n",
    "public enum Suit: String {\n    case hearts = \"H\"\n}\n", "Suit"));
});

test("names are contract where a caller can write them: a record's components, not a Go parameter", () => {
  // A Java record's components are its accessor names; Go has no named
  // arguments at all, and `X, Y int` declares the same two fields as two lines.
  assert.ok(!sameDigest("java", "public record Point(int x, int y) {}\n", "public record Point(int px, int py) {}\n", "Point"));
  assert.ok(sameDigest("go", "package p\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n", "package p\n\nfunc Add(x, y int) int {\n\treturn x + y\n}\n", "Add"));
  assert.ok(sameDigest("go", "package p\n\nfunc (m Money) Add(o Money) Money {\n\treturn m\n}\n", "package p\n\nfunc (money Money) Add(o Money) Money {\n\treturn money\n}\n", "Add"));
  assert.ok(!sameDigest("go", "package p\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n", "package p\n\nfunc Add(a int, b int64) int {\n\treturn a\n}\n", "Add"));
  assert.equal(shapeOf(braceShapes("package p\n\ntype Pt struct {\n\tX, Y int\n}\n", "go"), "Pt"), "type Pt struct {X int; Y int}");
});

test("a type split across blocks in one file is one contract", () => {
  // An inherent impl in two halves, a method moved into an extension and a
  // partial class merged all show a caller the same members.
  assert.ok(sameDigest("rust",
    "pub struct M;\nimpl M {\n    pub fn a(&self) -> u8 { 1 }\n    pub fn b(&self) -> u8 { 2 }\n}\n",
    "pub struct M;\nimpl M {\n    pub fn a(&self) -> u8 { 1 }\n}\nimpl M {\n    pub fn b(&self) -> u8 { 2 }\n}\n", "M"));
  assert.ok(sameDigest("swift",
    "public struct Money {\n    public let amount: Int\n    public func format() -> String { \"\" }\n}\n",
    "public struct Money {\n    public let amount: Int\n}\nextension Money {\n    public func format() -> String { \"\" }\n}\n", "Money"));
  // But a conformance added by an extension is contract of its own.
  assert.ok(!sameDigest("swift",
    "public struct Money {\n    public let amount: Int\n}\n",
    "public struct Money {\n    public let amount: Int\n}\nextension Money: Equatable {}\n", "Money"));
  assert.ok(sameDigest("csharp",
    "public partial class P { public void A() {} }\npublic partial class P { public void B() {} }\n",
    "public partial class P { public void A() {} public void B() {} }\n", "P"));
});

test("a nested body with no declaration of its own keeps its fields", () => {
  // A Go field of anonymous struct type, a Rust struct variant, an inline C
  // struct and a Kotlin companion object were flattened to `{}`, so a change
  // to their fields hashed identically.
  assert.equal(shapeOf(braceShapes("package p\n\ntype R struct {\n\tMeta struct {\n\t\tID int\n\t}\n}\n", "go"), "R"), "type R struct {Meta struct {ID int}}");
  assert.equal(shapeOf(braceShapes("pub enum Ev {\n    Click { x: i32, y: i32 },\n    Key(u8),\n}\n", "rust"), "Ev"), "pub enum Ev {Click {x: i32; y: i32}; Key(u8)}");
  assert.equal(shapeOf(braceShapes("struct outer { struct inner { int y; } in; int z; };\n", "c"), "outer"), "struct outer {int z; struct inner {int y} in}");
  assert.equal(shapeOf(braceShapes("class C {\n    companion object {\n        const val LIMIT: Int = 1\n    }\n}\n", "kotlin"), "C"), "class C {companion object {const val LIMIT: Int}}");
});

test("smaller spellings that are not contract: an annotation line, PHP's implicit public, a Kotlin getter's line", () => {
  assert.ok(sameDigest("java",
    "public class O {\n    public String toString() { return \"\"; }\n}\n",
    "public class O {\n    @Override\n    public String toString() { return \"\"; }\n}\n", "O"));
  assert.ok(sameDigest("php",
    "<?php\nclass A {\n    function foo(int $x): int { return $x; }\n}\n",
    "<?php\nclass A {\n    public function foo(int $x): int { return $x; }\n}\n", "A"));
  assert.ok(sameDigest("php",
    "<?php\nclass A {\n    function foo(int $x): int { return $x; }\n}\n",
    "<?php\nclass A {\n    public function foo(int $x): int { return $x; }\n}\n", "foo"));
  assert.ok(sameDigest("kotlin", "class G {\n    val x: Int get() = 5\n}\n", "class G {\n    val x: Int\n        get() = 5\n}\n", "G"));
  assert.equal(shapeOf(braceShapes("class G {\n    val x: Int\n        get() = 5\n}\n", "kotlin"), "G"), "class G {val x: Int}");
});
