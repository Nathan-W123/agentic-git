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

test("Ruby: a parameter list that spans lines is read to its closing parenthesis", () => {
  // Only the def line was read, so a wrapped signature hashed as "(" and
  // adding or removing a parameter on its own line moved nothing.
  const wrapped = rubyShapes('class Money\n  def initialize(\n    amount,\n    currency: "usd"\n  )\n    @amount = amount\n  end\nend\n');
  const added = rubyShapes('class Money\n  def initialize(\n    amount,\n    currency: "usd",\n    precision: 2\n  )\n  end\nend\n');
  const removed = rubyShapes("class Money\n  def initialize(\n    amount\n  )\n  end\nend\n");
  const oneLine = rubyShapes('class Money\n  def initialize(amount, currency: "usd")\n  end\nend\n');
  assert.equal(shapeOf(wrapped, "initialize"), '(amount, currency: "usd")');
  assert.notEqual(digestOf(wrapped, "initialize"), digestOf(added, "initialize"));
  assert.notEqual(digestOf(wrapped, "Money"), digestOf(added, "Money"));
  assert.notEqual(digestOf(wrapped, "initialize"), digestOf(removed, "initialize"));
  // And wrapping is formatting: the one-line form is the same contract.
  assert.equal(digestOf(wrapped, "initialize"), digestOf(oneLine, "initialize"));
  // The paren-less form continues on a trailing comma.
  assert.equal(digestOf(rubyShapes("def f a,\n      b = 1\nend\n"), "f"), digestOf(rubyShapes("def f(a, b = 1)\nend\n"), "f"));
});

test("Ruby: a `#` or `;` inside a default is part of the default, not the end of the head", () => {
  // Comment and statement stripping was done on the raw text, so the head
  // was cut inside the string and every parameter after it vanished.
  const url = rubyShapes('def url(path, anchor = "#top")\nend\n');
  const urlMore = rubyShapes('def url(path, anchor = "#top", scheme)\nend\n');
  const greet = rubyShapes('def greet(name, tpl = "hi #{name}")\nend\n');
  const greetMore = rubyShapes('def greet(name, tpl = "hi #{name}", punct)\nend\n');
  const sep = rubyShapes('def sep(a, s = ";")\nend\n');
  const sepMore = rubyShapes('def sep(a, s = ";", t)\nend\n');
  assert.equal(shapeOf(url, "url"), '(path, anchor = "#top")');
  assert.equal(shapeOf(sepMore, "sep"), '(a, s = ";", t)');
  assert.notEqual(digestOf(url, "url"), digestOf(urlMore, "url"));
  assert.notEqual(digestOf(greet, "greet"), digestOf(greetMore, "greet"));
  assert.notEqual(digestOf(sep, "sep"), digestOf(sepMore, "sep"));
  // A real comment after the head is still not part of it, and a real `;`
  // still ends it.
  assert.equal(digestOf(rubyShapes("def f(a) # (b, c)\nend\n"), "f"), digestOf(rubyShapes("def f(a)\nend\n"), "f"));
  assert.equal(shapeOf(rubyShapes("def f(a); a; end\n"), "f"), "(a)");
});

test("Ruby: a bare private applies to its own scope, and never to def self", () => {
  // The old scan walked every line between the outermost enclosing range
  // and the def, nested scopes included: a `private` inside a nested class
  // hid the outer class's later public methods, so adding an Error class
  // above an unchanged method reported the method as removed.
  const nested = rubyShapes(
    [
      "class Account",
      "  class Error < StandardError",
      "    private",
      "    def detail",
      "    end",
      "  end",
      "  def deposit(amount, memo)",
      "  end",
      "end",
    ].join("\n"),
  );
  const plain = rubyShapes("class Account\n  def deposit(amount, memo)\n  end\nend\n");
  assert.equal(shapeOf(nested, "Account"), "{deposit(amount, memo)}");
  assert.equal(digestOf(nested, "Account"), digestOf(plain, "Account"));
  assert.equal(shapeOf(nested, "Error"), "< StandardError {}");
  assert.equal(symbols(nested)?.includes("detail"), false);
  // The other direction: an outer `private` does not reach into a nested class.
  const outer = rubyShapes("class A\n  private\n  class B\n    def pub_in_b(x)\n    end\n  end\n  def priv_in_a\n  end\nend\n");
  assert.equal(shapeOf(outer, "B"), "{pub_in_b(x)}");
  assert.equal(shapeOf(outer, "A"), "{}");
  // `private` in a class body leaves `def self.x` public — only one inside
  // `class << self` hides a class method, and it hides nothing outside.
  assert.equal(shapeOf(rubyShapes("class P\n  private\n  def self.build(x)\n  end\nend\n"), "P"), "{self.build(x)}");
  const singleton = rubyShapes(
    "class S\n  class << self\n    private\n    def helper\n    end\n    def make(x)\n    end\n    public\n    def shown\n    end\n  end\n  def pub(x)\n  end\nend\n",
  );
  assert.equal(shapeOf(singleton, "S"), "{pub(x); self.shown}");
  // A `private` inside a method body runs when the method does; it says
  // nothing about the defs after it.
  assert.equal(shapeOf(rubyShapes("class M\n  def a\n    private\n  end\n  def b(x)\n  end\nend\n"), "M"), "{a; b(x)}");
});

test("Ruby: two classes with one name are each shaped from their own defs", () => {
  // Merged into one range, `Client::Error` and `Server::Error` spanned both
  // modules, and every def between them — Client.get, Server.listen —
  // became a member of Error. Retyping Server.listen then moved Error.
  const of = (listen: string) =>
    rubyShapes(
      [
        "module Client",
        "  class Error < StandardError",
        "    def code(x)",
        "    end",
        "  end",
        "  def self.get(url)",
        "  end",
        "end",
        "module Server",
        `  def self.listen(${listen})`,
        "  end",
        "  class Error < StandardError",
        "    def code(y, z)",
        "    end",
        "  end",
        "end",
      ].join("\n"),
    );
  assert.equal(shapeOf(of("port"), "Error"), "< StandardError {code(x)} | < StandardError {code(y, z)}");
  assert.equal(shapeOf(of("port"), "Client"), "{self.get(url)}");
  assert.equal(shapeOf(of("port"), "Server"), "{self.listen(port)}");
  assert.equal(digestOf(of("port"), "Error"), digestOf(of("port, backlog"), "Error"));
  assert.notEqual(digestOf(of("port"), "Server"), digestOf(of("port, backlog"), "Server"));
});

test("Ruby: an operator method is a member whose arity is contract", () => {
  const of = (equals: string) => rubyShapes(`class V\n  def ==(${equals})\n    true\n  end\n  def [](i)\n    i\n  end\n  def <=>(o); 0; end\n  def plain(a)\n  end\nend\n`);
  assert.equal(shapeOf(of("other"), "V"), "{[](i); <=>(o); ==(other); plain(a)}");
  assert.notEqual(digestOf(of("other"), "V"), digestOf(of("other, strict"), "V"));
});

test("Ruby: a default's value is not contract; that there is one is", () => {
  // The house rule every other reader keeps: `size = 20` and `size = 50`
  // accept exactly the same calls. The readable shape keeps the value.
  const twenty = rubyShapes("def page(n, size = 20)\nend\n");
  assert.equal(shapeOf(twenty, "page"), "(n, size = 20)");
  assert.equal(digestOf(twenty, "page"), digestOf(rubyShapes("def page(n, size = 50)\nend\n"), "page"));
  assert.equal(digestOf(twenty, "page"), digestOf(rubyShapes("def page(n, size = [1, 2])\nend\n"), "page"));
  // Whereas making it required, or optional, changes what a call may be...
  assert.notEqual(digestOf(twenty, "page"), digestOf(rubyShapes("def page(n, size)\nend\n"), "page"));
  // ...and the same holds for a keyword parameter, whose value is also a value.
  const keyword = rubyShapes('def f(k:, o: "a")\nend\n');
  assert.equal(digestOf(keyword, "f"), digestOf(rubyShapes('def f(k:, o: "b")\nend\n'), "f"));
  assert.notEqual(digestOf(keyword, "f"), digestOf(rubyShapes('def f(k: 1, o: "a")\nend\n'), "f"));
  assert.notEqual(digestOf(keyword, "f"), digestOf(rubyShapes('def f(k:, o:)\nend\n'), "f"));
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
  // A public method of a public class is a name a caller reaches, and is
  // published in its own right the way every other scanned language does.
  assert.deepEqual(symbols(shapes), ["__init__", "add", "charge", "fetch", "formatted", "Money", "posonly"]);
  assert.equal(shapeOf(shapes, "charge"), "(amount: int, currency: str?, *, force: bool?) -> bool");
  assert.equal(shapes.find((entry) => entry.symbol === "charge")?.inferred, undefined);
  assert.equal(shapeOf(shapes, "fetch"), "async (url)");
  assert.equal(shapes.find((entry) => entry.symbol === "fetch")?.inferred, true);
  assert.equal(shapeOf(shapes, "posonly"), "(a, b, /, c, *args, d, **kw) -> None");
  assert.equal(
    shapeOf(shapes, "Money"),
    "(Base, metaclass=Meta) {@property formatted(self) -> str; RATE; __init__(self, amount: int) -> None; add(self, other); amount: int}",
  );
  // A default's value and a body are not contract; a parameter's type is.
  const changed = pythonShapes(read.files.get("changed.py")?.shapes ?? []);
  const body = pythonShapes(read.files.get("body.py")?.shapes ?? []);
  assert.equal(digestOf(body, "charge"), digestOf(shapes, "charge"));
  assert.notEqual(digestOf(changed, "charge"), digestOf(shapes, "charge"));
});

async function pythonShapesOf(files: Record<string, string>) {
  const read = await pythonSymbolRanges(new Map(Object.entries(files)));
  return (file: string) => pythonShapes(read.files.get(file)?.shapes ?? []);
}

test("Python: an overload set is one contract, so an unchanged file does not drift against itself", async () => {
  // One entry per definition arrived at the differ as three shapes under one
  // name, and each `before` entry was compared to whichever `after` entry
  // came last: a module using the standard @overload idiom drifted against
  // an identical copy of itself on every check.
  const of = await pythonShapesOf({
    "a.py": "from typing import overload\n@overload\ndef parse(x: int) -> int: ...\n@overload\ndef parse(x: str) -> str: ...\ndef parse(x):\n    return x\n",
    "moved.py": "from typing import overload\n@overload\ndef parse(x: int) -> str: ...\n@overload\ndef parse(x: str) -> str: ...\ndef parse(x):\n    return x\n",
    "reordered.py": "from typing import overload\n@overload\ndef parse(x: str) -> str: ...\n@overload\ndef parse(x: int) -> int: ...\ndef parse(x):\n    return x\n",
  });
  assert.deepEqual(symbols(of("a.py")), ["parse"]);
  assert.equal(shapeOf(of("a.py"), "parse"), "(x: int) -> int | (x: str) -> str | (x)");
  // The set is one contract: its digest moves when one signature moves and
  // stays when the overloads are merely written in another order.
  assert.notEqual(digestOf(of("moved.py"), "parse"), digestOf(of("a.py"), "parse"));
  assert.equal(digestOf(of("reordered.py"), "parse"), digestOf(of("a.py"), "parse"));
});

test("Python: one signature on every branch of a module-level if is one signature, not one per branch", async () => {
  // A platform switch writes `sep` on both branches with one signature.
  // Read as a piece per branch it hashed as "() -> str | () -> str", so
  // dropping the else branch moved the digest while a caller saw nothing
  // change — and a stale-contract warning showed the signature twice.
  const of = await pythonShapesOf({
    "switch.py": "import sys\nif sys.platform == 'win32':\n    def sep() -> str: ...\nelse:\n    def sep() -> str: ...\n",
    "single.py": "def sep() -> str: ...\n",
    "differs.py": "import sys\nif sys.platform == 'win32':\n    def sep() -> str: ...\nelse:\n    def sep(joiner: str) -> str: ...\n",
  });
  assert.equal(shapeOf(of("switch.py"), "sep"), "() -> str");
  assert.equal(digestOf(of("switch.py"), "sep"), digestOf(of("single.py"), "sep"));
  // Branches that disagree are both contract: a caller may be handed either.
  assert.equal(shapeOf(of("differs.py"), "sep"), "() -> str | (joiner: str) -> str");
  assert.notEqual(digestOf(of("differs.py"), "sep"), digestOf(of("switch.py"), "sep"));
});

test("Python: a decorator that changes how a member is called is contract; a route or a cache is not", async () => {
  const of = await pythonShapesOf({
    "decorated.py": "class M:\n    @property\n    def total(self) -> int: ...\n    @staticmethod\n    def parse(text: str) -> 'M': ...\n    @classmethod\n    def make(cls, n: int) -> 'M': ...\n",
    "plain.py": "class M:\n    def total(self) -> int: ...\n    def parse(text: str) -> 'M': ...\n    def make(cls, n: int) -> 'M': ...\n",
    "dc.py": "from dataclasses import dataclass\n@dataclass(frozen=True)\nclass P:\n    x: int\n",
    "nodc.py": "class P:\n    x: int\n",
    "route.py": "@app.route('/x')\n@functools.lru_cache(maxsize=8)\ndef handler(q: str) -> str: ...\n",
    "reroute.py": "@app.route('/y')\n@lru_cache(maxsize=16)\ndef handler(q: str) -> str: ...\n",
  });
  // `m.total` stops working when @property goes; `M.parse("x")` when
  // @staticmethod goes; `P(1)` when @dataclass goes.
  assert.equal(
    shapeOf(of("decorated.py"), "M"),
    "{@classmethod make(cls, n: int) -> M; @property total(self) -> int; @staticmethod parse(text: str) -> M}",
  );
  assert.notEqual(digestOf(of("decorated.py"), "M"), digestOf(of("plain.py"), "M"));
  assert.notEqual(digestOf(of("decorated.py"), "total"), digestOf(of("plain.py"), "total"));
  assert.equal(shapeOf(of("dc.py"), "P"), "@dataclass(frozen=True) {x: int}");
  assert.notEqual(digestOf(of("dc.py"), "P"), digestOf(of("nodc.py"), "P"));
  // Whereas a route's path and a cache's size are values: changing them is
  // not changing how `handler` is called.
  assert.equal(shapeOf(of("route.py"), "handler"), "(q: str) -> str");
  assert.equal(digestOf(of("route.py"), "handler"), digestOf(of("reroute.py"), "handler"));
});

test("Python: an enum's values and order are contract, and so is a dataclass's or NamedTuple's field order", async () => {
  const of = await pythonShapesOf({
    "e1.py": "from enum import Enum\nclass Color(Enum):\n    RED = 1\n    GREEN = 2\n",
    "e2.py": "from enum import Enum\nclass Color(Enum):\n    RED = 2\n    GREEN = 1\n",
    "e3.py": "from enum import Enum, auto\nclass Color(Enum):\n    RED = auto()\n    GREEN = auto()\n",
    "e4.py": "from enum import Enum, auto\nclass Color(Enum):\n    GREEN = auto()\n    RED = auto()\n",
    "d1.py": "from dataclasses import dataclass\n@dataclass\nclass P:\n    x: int\n    y: str\n",
    "d2.py": "from dataclasses import dataclass\n@dataclass\nclass P:\n    y: str\n    x: int\n",
    "k1.py": "from dataclasses import dataclass\n@dataclass(kw_only=True)\nclass P:\n    x: int\n    y: str\n",
    "k2.py": "from dataclasses import dataclass\n@dataclass(kw_only=True)\nclass P:\n    y: str\n    x: int\n",
    "n1.py": "from typing import NamedTuple\nclass Row(NamedTuple):\n    id: int\n    name: str\n",
    "n2.py": "from typing import NamedTuple\nclass Row(NamedTuple):\n    name: str\n    id: int\n",
    "c1.py": "class C:\n    x: int\n    y: str\n",
    "c2.py": "class C:\n    y: str\n    x: int\n",
  });
  // A member's value is what a caller compares against, and an auto() takes
  // its value from its position; both are kept, in the order written.
  assert.equal(shapeOf(of("e1.py"), "Color"), "(Enum) {RED = 1; GREEN = 2}");
  assert.equal(of("e1.py").find((entry) => entry.symbol === "Color")?.kind, "enum");
  assert.notEqual(digestOf(of("e1.py"), "Color"), digestOf(of("e2.py"), "Color"));
  assert.notEqual(digestOf(of("e3.py"), "Color"), digestOf(of("e4.py"), "Color"));
  // P(1, "a") and Row(1, "a") bind by position, so swapping two fields
  // changes what a call means...
  assert.notEqual(digestOf(of("d1.py"), "P"), digestOf(of("d2.py"), "P"));
  assert.notEqual(digestOf(of("n1.py"), "Row"), digestOf(of("n2.py"), "Row"));
  // ...but a keyword-only dataclass and a plain class have no positions, and
  // there moving a field is still not a contract change.
  assert.equal(digestOf(of("k1.py"), "P"), digestOf(of("k2.py"), "P"));
  assert.equal(digestOf(of("c1.py"), "C"), digestOf(of("c2.py"), "C"));
});

test("Python: a nested class is part of its outer class and a contract in its own right", async () => {
  const of = await pythonShapesOf({
    "a.py": "class Outer:\n    class Inner:\n        def run(self, a: int) -> None: ...\n    def go(self) -> None: ...\n",
    "retyped.py": "class Outer:\n    class Inner:\n        def run(self, a: str) -> None: ...\n    def go(self) -> None: ...\n",
    "gone.py": "class Outer:\n    def go(self) -> None: ...\n",
  });
  assert.equal(shapeOf(of("a.py"), "Outer"), "{Inner {run(self, a: int) -> None}; go(self) -> None}");
  // A caller of Outer.Inner().run(...) is broken by either change.
  assert.notEqual(digestOf(of("a.py"), "Outer"), digestOf(of("retyped.py"), "Outer"));
  assert.notEqual(digestOf(of("a.py"), "Outer"), digestOf(of("gone.py"), "Outer"));
  assert.equal(shapeOf(of("a.py"), "Inner"), "{run(self, a: int) -> None}");
  assert.equal(shapeOf(of("gone.py"), "Inner"), undefined);
});

test("Python: what a caller can reach is exported; only underscore names are known and local", async () => {
  // The interface tier reads a name the index knows but does not export as
  // branch-local. Public methods, nested classes and defs under a
  // module-level if or try are all reachable, so leaving them out of the
  // exported list handed two branches editing one method to Git alone.
  const read = await pythonSymbolRanges(
    new Map([
      [
        "m.py",
        [
          "import sys",
          "__all__ = ['_published']",
          "class Money:",
          "    def add(self, other: int) -> 'Money': ...",
          "    def _secret(self): ...",
          "    class Inner:",
          "        def run(self) -> None: ...",
          "if sys.platform == 'win32':",
          "    def sep() -> str: ...",
          "else:",
          "    def sep() -> str: ...",
          "try:",
          "    from fast import Parser",
          "except ImportError:",
          "    class Parser: ...",
          "def _published(): ...",
          "def _hidden(): ...",
        ].join("\n"),
      ],
    ]),
  );
  const file = read.files.get("m.py");
  const exported = symbols(pythonShapes(file?.shapes ?? [])) ?? [];
  const known = file?.ranges.map((range) => range.name) ?? [];
  for (const name of ["Money", "add", "Inner", "run", "sep", "Parser", "_published"]) {
    assert.ok(exported.includes(name), `${name} is reachable and must be exported`);
  }
  for (const name of ["_secret", "_hidden"]) {
    assert.ok(known.includes(name) && !exported.includes(name), `${name} is known and local`);
  }
});

test("Python: a class with no bases and an async method render as a person would write them", async () => {
  // Presentation only — the digests were already distinct — but it is what a
  // stale-contract warning shows somebody, and `fetchasync (` names a method
  // that does not exist.
  const of = await pythonShapesOf({
    "a.py": 'class Empty:\n    """doc"""\nclass S:\n    async def fetch(self, url: str) -> bytes: ...\n',
  });
  assert.equal(shapeOf(of("a.py"), "Empty"), "{}");
  assert.equal(shapeOf(of("a.py"), "S"), "{async fetch(self, url: str) -> bytes}");
});

test("Python: a quoted forward reference and the bare name are one contract; the strings in a Literal are not", async () => {
  const of = await pythonShapesOf({
    "quoted.py": "def f(x: 'Money', xs: 'list[Money]') -> 'Money': ...\n",
    "bare.py": "from __future__ import annotations\ndef f(x: Money, xs: list[Money]) -> Money: ...\n",
    "lit_a.py": "from typing import Literal\ndef mode(m: Literal['r', 'w']) -> None: ...\n",
    "lit_b.py": "from typing import Literal\ndef mode(m: Literal['r', 'a']) -> None: ...\n",
  });
  // Moving to `from __future__ import annotations` rewrites every quote in a
  // module and changes no contract; it must not move every digest.
  assert.equal(shapeOf(of("quoted.py"), "f"), "(x: Money, xs: list[Money]) -> Money");
  assert.equal(digestOf(of("quoted.py"), "f"), digestOf(of("bare.py"), "f"));
  // Whereas 'r' in a Literal is a value the caller passes, and 'a' is another.
  assert.equal(shapeOf(of("lit_a.py"), "mode"), "(m: Literal['r', 'w']) -> None");
  assert.notEqual(digestOf(of("lit_a.py"), "mode"), digestOf(of("lit_b.py"), "mode"));
});

test("a file the masker cannot follow has unknown shapes, not empty ones", () => {
  assert.equal(braceShapes('func Broken() { s := "unterminated\n}\n', "go"), undefined);
  assert.equal(braceShapes("class Unbalanced {\n", "java"), undefined);
  assert.equal(rubyShapes("class Open\n  def never_closed\nend\n"), undefined);
  // Whereas a file that declares nothing has, honestly, no shapes.
  assert.deepEqual(braceShapes("package empty\n", "go"), []);
});
