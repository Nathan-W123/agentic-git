/**
 * Ruby and PHP, where telling code from not-code is the whole difficulty.
 *
 * A `require` inside a heredoc, a `%w[]` list or the HTML above a `<?php` is
 * a sentence rather than a dependency, and an edge invented from one makes
 * two unrelated branches contend over a file nobody touched.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  maskPhp,
  maskRuby,
  phpTypes,
  readPhpFile,
  readRubyRequires,
  resolvePhpRequire,
  resolvePhpUse,
  resolveRubyRequire,
  rubyLoadRoots,
  type PhpUnit,
} from "./script-imports.js";

/* ----------------------------------------------------------------- ruby -- */

test("a require inside a heredoc is not a require", () => {
  const requires = readRubyRequires(
    [
      "require 'real'",
      "sql = <<~SQL",
      "  require 'ghost'",
      "SQL",
      "require 'also_real'",
    ].join("\n"),
  );
  assert.deepEqual(
    requires?.map((entry) => entry.specifier),
    ["real", "also_real"],
  );
});

test("comments, =begin blocks and __END__ hold no requires", () => {
  const requires = readRubyRequires(
    [
      "# require 'commented'",
      "=begin",
      "require 'blocked'",
      "=end",
      "require 'real'",
      "__END__",
      "require 'data'",
    ].join("\n"),
  );
  assert.deepEqual(
    requires?.map((entry) => entry.specifier),
    ["real"],
  );
});

test("a percent literal is not code, whatever is inside it", () => {
  const masked = maskRuby("names = %w[require ghost]\nrequire 'real'\n");
  assert.notEqual(masked, undefined);
  assert.deepEqual(
    readRubyRequires("names = %w[require ghost]\nrequire 'real'\n")?.map(
      (entry) => entry.specifier,
    ),
    ["real"],
  );
});

test("a file the masker loses its place in is abandoned", () => {
  assert.equal(maskRuby("=begin\nnever closed\n"), undefined);
  assert.equal(maskRuby("x = <<~SQL\n  body with no terminator\n"), undefined);
  assert.equal(readRubyRequires("s = 'unterminated\n"), undefined);
});

test("a computed require is dropped rather than guessed at", () => {
  // `require File.join(...)` is a run-time value. Nothing in a file set can
  // say what it names.
  const requires = readRubyRequires(
    ["require File.join(__dir__, 'x')", "require 'literal'"].join("\n"),
  );
  assert.deepEqual(
    requires?.map((entry) => entry.specifier),
    ["literal"],
  );
});

test("require_relative measures from the file, require from the load path", () => {
  const files = new Set([
    "Gemfile",
    "lib/billing.rb",
    "lib/billing/money.rb",
    "app/services/charge.rb",
  ]);
  const roots = rubyLoadRoots(files);
  assert.deepEqual(roots, ["lib"]);
  assert.deepEqual(
    resolveRubyRequire(
      "lib/billing.rb",
      { relative: true, specifier: "billing/money" },
      { files, roots },
    ),
    ["lib/billing/money.rb"],
  );
  assert.deepEqual(
    resolveRubyRequire(
      "app/services/charge.rb",
      { relative: false, specifier: "billing/money" },
      { files, roots },
    ),
    ["lib/billing/money.rb"],
  );
});

test("two load roots that both answer means the load path decides, so this does not", () => {
  const files = new Set([
    "Gemfile",
    "lib/util.rb",
    "spec/spec_helper.rb",
    "spec/util.rb",
    "app/x.rb",
  ]);
  const roots = rubyLoadRoots(files);
  assert.deepEqual(
    resolveRubyRequire("app/x.rb", { relative: false, specifier: "util" }, {
      files,
      roots,
    }),
    [],
  );
});

/* ------------------------------------------------------------------ php -- */

test("markup above the opening tag is not code", () => {
  const unit = readPhpFile(
    ["<html>", "<?php echo 'x'; ?>", "use A\\B\\Ghost;", "<?php", "use A\\B\\Real;"].join("\n"),
  );
  // The middle line is outside a tag: it is HTML output, not a use clause.
  assert.deepEqual(unit?.uses, ["A\\B\\Real"]);
});

test("a use inside a heredoc or a comment is not a use", () => {
  const unit = readPhpFile(
    [
      "<?php",
      "// use A\\B\\Commented;",
      "/* use A\\B\\Blocked; */",
      "$sql = <<<SQL",
      "use A\\B\\Ghost;",
      "SQL;",
      "use A\\B\\Real;",
    ].join("\n"),
  );
  assert.deepEqual(unit?.uses, ["A\\B\\Real"]);
});

test("a class name declared twice has no file", () => {
  // Composer maps names to paths through configuration this never reads, so
  // the declaring file is the only source — and two of them is no answer.
  const units = new Map<string, PhpUnit>([
    ["a/Money.php", { namespace: "Acme", declared: ["Money"], uses: [], requires: [] }],
    ["b/Money.php", { namespace: "Acme", declared: ["Money"], uses: [], requires: [] }],
    ["c/Ledger.php", { namespace: "Acme", declared: ["Ledger"], uses: [], requires: [] }],
  ]);
  const types = phpTypes(units);
  assert.equal(types.has("acme\\money"), false);
  assert.equal(types.get("acme\\ledger"), "c/Ledger.php");
});

test("a use resolves case-insensitively, as PHP itself does", () => {
  const types = new Map([["acme\\money", "src/Money.php"]]);
  const context = { files: new Set(["src/Money.php", "src/App.php"]), types };
  assert.deepEqual(resolvePhpUse("src/App.php", "Acme\\Money", context), [
    "src/Money.php",
  ]);
  assert.deepEqual(resolvePhpUse("src/App.php", "ACME\\MONEY", context), [
    "src/Money.php",
  ]);
  assert.deepEqual(resolvePhpUse("src/App.php", "Acme\\Missing", context), []);
});

test("a literal require resolves against the file, and a computed one does not", () => {
  const context = {
    files: new Set(["src/App.php", "src/helpers.php"]),
    types: new Map<string, string>(),
  };
  assert.deepEqual(
    resolvePhpRequire("src/App.php", "helpers.php", context),
    ["src/helpers.php"],
  );
  // Nothing outside the repository, and never an absolute path.
  assert.deepEqual(resolvePhpRequire("src/App.php", "../../etc/passwd", context), []);
  const unit = readPhpFile("<?php\nrequire __DIR__ . '/helpers.php';\n");
  // The literal half of a concatenation is not the specifier, so the whole
  // expression is dropped rather than half-read.
  assert.deepEqual(unit?.requires, []);
  // And the literal form really is read — through the reader, not only
  // through the resolver. The masker blanks a quoted argument because it is
  // a string, so a reader that matched against the masked text would find
  // nothing here and would have looked correct doing it.
  assert.deepEqual(
    readPhpFile("<?php\nrequire 'helpers.php';\ninclude_once \"other.php\";\n")
      ?.requires,
    ["helpers.php", "other.php"],
  );
  // A require inside a heredoc is still not one.
  assert.deepEqual(
    readPhpFile(
      ["<?php", "$s = <<<SQL", "require 'ghost.php';", "SQL;", "require 'real.php';"].join(
        "\n",
      ),
    )?.requires,
    ["real.php"],
  );
});

/* ------------------------------------------------------------ second pass -- */

test("Ruby: a heredoc opens wherever a value is expected, and the rest of its line is still code", () => {
  // After `[`, `(`, `,` and a method name alike — and two on one line each
  // get their own body, in order.
  assert.deepEqual(readRubyRequires("x = [<<~A]\n  require 'ghost'\nA\nrequire 'real'\n"), [
    { relative: false, specifier: "real" },
  ]);
  assert.deepEqual(
    readRubyRequires("foo(<<~A, <<~B)\n  a\nA\n  require 'ghost'\nB\nrequire 'real'\n"),
    [{ relative: false, specifier: "real" }],
  );
  assert.deepEqual(
    readRubyRequires("puts <<~EOS\n  require 'ghost'\nEOS\nrequire 'real'\n"),
    [{ relative: false, specifier: "real" }],
  );
  // A comment on the opener line is a comment, not part of the body.
  assert.deepEqual(
    readRubyRequires("sql = <<~SQL # TODO: require 'ghost' here\n  select 1\nSQL\nrequire 'real'\n"),
    [{ relative: false, specifier: "real" }],
  );
  // A terminator with trailing whitespace is not the terminator.
  assert.deepEqual(
    readRubyRequires("x = <<~SQL\n  line\n  SQL   \n  require 'ghost'\nSQL\nrequire 'real'\n"),
    [{ relative: false, specifier: "real" }],
  );
  // `class <<self` is not a heredoc, and `arr << x` is a shift.
  assert.deepEqual(
    readRubyRequires("class Foo\n  class <<self\n  end\nend\narr << x\nrequire 'real'\n"),
    [{ relative: false, specifier: "real" }],
  );
});

test("Ruby: regexes, character literals, special globals and nested quotes do not flip the string scanner", () => {
  assert.deepEqual(
    readRubyRequires("A = /'/\nHINT = 'You must require \"ghost\" first'\nB = /'/\nrequire 'real'\n"),
    [{ relative: false, specifier: "real" }],
  );
  assert.deepEqual(
    readRubyRequires("case x\nwhen /a'b/ then 1\nend\nx = a / b\nrequire 'real'\n"),
    [{ relative: false, specifier: "real" }],
  );
  assert.deepEqual(readRubyRequires("c = ?'\nd = $'\ny = a ? b : c\nrequire 'real'\n"), [
    { relative: false, specifier: "real" },
  ]);
  assert.deepEqual(
    readRubyRequires('puts "#{I18n.t("Add require \'ghost\' to the Gemfile")}"\nrequire \'real\'\n'),
    [{ relative: false, specifier: "real" }],
  );
  // `=ending` does not close a `=begin` block.
  assert.deepEqual(
    readRubyRequires("=begin\ndoc\n=ending here\nrequire 'ghost'\n=end\nrequire 'real'\n"),
    [{ relative: false, specifier: "real" }],
  );
});

test("Ruby: a computed or working-directory require is not a load-path lookup", () => {
  assert.deepEqual(readRubyRequires("require 'plugins/' + name\nrequire 'ok' if x\n"), [
    { relative: false, specifier: "ok" },
  ]);
  const files = new Set(["Gemfile", "lib/helpers.rb", "bin/helpers.rb", "bin/run.rb", "bin/cli"]);
  const context = { files, roots: rubyLoadRoots(files) };
  assert.deepEqual(resolveRubyRequire("bin/run.rb", { relative: false, specifier: "./helpers" }, context), []);
  assert.deepEqual(resolveRubyRequire("bin/run.rb", { relative: false, specifier: "/helpers" }, context), []);
  // And only a loadable file is a target: `bin/cli` is not `bin/cli.rb`.
  assert.deepEqual(resolveRubyRequire("lib/helpers.rb", { relative: true, specifier: "../bin/cli" }, context), []);
});

test("PHP: a use is an import only at the top level, and only of a class", () => {
  const units = new Map([
    ["legacy/Loggable.php", readPhpFile("<?php\ntrait Loggable {}\n")],
    ["src/Loggable.php", readPhpFile("<?php\nnamespace App;\ntrait Loggable {}\n")],
    ["src/Service.php", readPhpFile("<?php\nnamespace App;\nclass Service {\n  use Loggable;\n}\n")],
    ["src/Main.php", readPhpFile("<?php\nnamespace App;\nuse function App\\helper;\nuse const App\\X;\nuse App\\Real;\n")],
    ["src/Block.php", readPhpFile("<?php\nnamespace App {\n  use App\\Other;\n  class Block {}\n}\n")],
  ] as const);
  // A trait insertion inside a class body is not a top-level import, so it
  // never resolves to the global `Loggable` beside the namespaced one.
  assert.deepEqual(units.get("src/Service.php")?.uses, []);
  assert.deepEqual(units.get("src/Main.php")?.uses, ["App\\Real"]);
  // Directly inside a namespace block is the top level.
  assert.deepEqual(units.get("src/Block.php")?.uses, ["App\\Other"]);
});

test("PHP: the masker follows ?> out of a comment, a spaced heredoc, and a nested interpolation", () => {
  assert.deepEqual(
    readPhpFile("<?php // header ?>\n<p>Docs: add require 'ghost.php'; and use App\\Ghost; first.</p>\n<?php require 'real.php'; ?>\n"),
    { namespace: "", declared: [], uses: [], requires: ["real.php"] },
  );
  assert.deepEqual(
    readPhpFile("<?php\n$s = <<< EOT\nuse App\\Ghost;\nrequire 'ghost.php';\nEOT;\nuse App\\Real;\n")?.uses,
    ["App\\Real"],
  );
  assert.deepEqual(
    readPhpFile('<?php\n$m = "{$t(" use App\\Ghost; ")}";\nuse App\\Real;\n')?.uses,
    ["App\\Real"],
  );
  assert.deepEqual(readPhpFile("<?PHP\nuse App\\Real;\nrequire 'real.php';\n"), {
    namespace: "",
    declared: [],
    uses: ["App\\Real"],
    requires: ["real.php"],
  });
});

test("PHP: two namespace blocks declare nothing, an anonymous class is not named, a computed require is dropped", () => {
  const blocks = readPhpFile("<?php\nnamespace A {\n  class X {}\n}\nnamespace B {\n  class Y {}\n}\n");
  assert.deepEqual(blocks?.declared, []);
  assert.deepEqual(readPhpFile("<?php\n$x = new class extends Base {};\nclass Real {}\n")?.declared, ["Real"]);
  assert.deepEqual(readPhpFile("<?php\nrequire 'f.php' . $ext;\nrequire 'g.php';\nrequire('h.php');\n")?.requires, [
    "g.php",
    "h.php",
  ]);
  assert.deepEqual(
    resolvePhpRequire("index.php", "/lib/x.php", { files: new Set(["index.php", "lib/x.php"]), types: new Map() }),
    [],
  );
});

/* ------------------------------------------------------------- third pass -- */

const rubyRequires = (source: string): string[] | undefined =>
  readRubyRequires(source)?.map(
    (entry) => `${entry.relative ? "rel:" : ""}${entry.specifier}`,
  );

test("Ruby: a regex literal may span lines", () => {
  // Thirty of the stdlib's files hold a `/x` regex written over several
  // lines. Abandoning the file at the first newline lost every require in
  // each of them, which is a missing edge per require for the commonest
  // way to write a long pattern.
  assert.deepEqual(
    rubyRequires("PATTERN = /\n  \\A(\\d+)   # digits\n/x\nrequire 'real'\n"),
    ["real"],
  );
  assert.deepEqual(rubyRequires("if /\\A\\s*\n   foo/x =~ s\nend\nrequire 'real'\n"), ["real"]);
  // The end of the file is still a lost place.
  assert.equal(maskRuby("x = /never closed\nrequire 'ghost'\n"), undefined);
});

test("Ruby: after an identifier, spacing decides whether a slash or percent opens a literal", () => {
  // Ruby's own rule: a space before and none after passes a literal as an
  // argument — `assert_match /\d+/, x` is the minitest idiom and abandoned
  // every test file that used it — while `a / b` and `a/b` divide.
  assert.deepEqual(rubyRequires("assert_match /\\d+/, body\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("s = str.gsub /\\s+/, ' '\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("uri = x.to_s.sub %r{/$},\"\"\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("sh %W[git commit -m it's]\nrequire 'real'\n"), ["real"]);
  // The other direction is the harmful one: `%q(...)` after `it` was read
  // as a modulo, and the sentence inside it produced an edge to `ghost`.
  assert.deepEqual(
    rubyRequires("it %q(does not require 'ghost') do\nend\nrequire 'real'\n"),
    ["real"],
  );
  // An operator, however the operands are spelled: neither reading opens a
  // literal that would swallow the require on the next line.
  assert.deepEqual(rubyRequires("z = a / b\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("z = a/b\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("total /= 2\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("z = a % b\nrequire 'real'\n"), ["real"]);
  // A local variable is a value whatever the spacing, as Ruby knows it to
  // be: `count /2` divides because `count` was assigned.
  assert.deepEqual(rubyRequires("count = 10\nhalf = count /2\nrequire 'real'\n"), ["real"]);
  // So is an instance or global variable, which is never a method taking
  // an argument: `@total /2` divides, and nothing runs to the end of the file.
  assert.deepEqual(rubyRequires("half = @total /2\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("half = $total /2\nrequire 'real'\n"), ["real"]);
});

test("Ruby: puts, p and print are methods, and a local variable may shadow them", () => {
  // They were listed with the keywords, so `p / r` opened a regex to the
  // end of the line. They take the spacing rule every method does now.
  assert.deepEqual(rubyRequires("p = 3\nc = p / r\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("puts 1 /2\nrequire 'real'\n"), ["real"]);
  // And a regex argument to them still is one.
  assert.deepEqual(rubyRequires("puts /it's/.source\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("p <<~EOS\n  require 'ghost'\nEOS\nrequire 'real'\n"), ["real"]);
});

test("Ruby: a punctuation global is a value, not the start of a regex or a string", () => {
  // `$/` is the record separator and abandoned seven stdlib files; the
  // rule that knew `$'` and `$\"` did not know it.
  assert.deepEqual(rubyRequires("lines = data.split($/)\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("def gets(eol=$/, limit=nil)\nend\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("$; = ','\n$-w = true\nx = $1\nrequire 'real'\n"), ["real"]);
});

test("Ruby: an operator is a method name after def and a symbol after a colon", () => {
  // `def /(other)` and `:/` are not regexes, and `` def `(cmd) `` is not a
  // string; each ran to the end of the line and abandoned the file.
  assert.deepEqual(rubyRequires("OPS = [:+, :-, :*, :/, :%]\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("avg = nums.reduce(:/)\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("class V\n  def /(other)\n    1\n  end\nend\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("def `(cmd)\n  run(cmd)\nend\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("def self.%(fmt)\n  1\nend\nrequire 'real'\n"), ["real"]);
  // A scope operator is not a symbol, and a method call after one is code.
  assert.deepEqual(rubyRequires("Foo::Bar.baz /x/\nrequire 'real'\n"), ["real"]);
});

test("Ruby: what is inside an interpolation is read by the rules of code", () => {
  // The interpolation skipper knew braces and quotes only, so a special
  // global or a regex holding a backtick inside `#{}` opened a string that
  // never closed.
  assert.deepEqual(rubyRequires("text = \"#{CGI.unescape $'} at\"\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(
    rubyRequires("d = \"x #{e.message[/throw \\`(\\w+?)\\'/, 1]}\"\nrequire 'real'\n"),
    ["real"],
  );
  // A require inside the interpolation is not code, and a nested string
  // holding a brace does not end it early.
  assert.deepEqual(
    rubyRequires('s = "#{h["}"]} #{require_relative "ghost"}"\nrequire \'real\'\n'),
    ["real"],
  );
  // Percent literals that interpolate hold code too.
  assert.deepEqual(rubyRequires("w = %W[#{$'} b]\nrequire 'real'\n"), ["real"]);
});

test("Ruby: a quoted heredoc tag holds any character, and its body is not code", () => {
  // rake, racc and forwardable write `<<-'end;'`. The opener wanted a word
  // between the quotes, so the tag lexed as a string and the body — prose
  // with a `require` in it — produced an edge.
  assert.deepEqual(
    rubyRequires("HELP = <<~'HELP;'\n  require 'ghost'\nHELP;\nrequire 'real'\n"),
    ["real"],
  );
  assert.deepEqual(
    rubyRequires("class_eval <<-'end;', __FILE__, __LINE__ + 1\n  require 'ghost'\nend;\nrequire 'real'\n"),
    ["real"],
  );
  // A tag that is a regex metacharacter is looked for as written.
  assert.deepEqual(
    rubyRequires("x = <<~'A.B'\n  require 'ghost'\nAxB\n  still require 'ghost'\nA.B\nrequire 'real'\n"),
    ["real"],
  );
});

test("Ruby: a shift with no space after it is not a heredoc", () => {
  // `buf <<line` is a shift onto a local variable. Reading it as a heredoc
  // opener found no `line` line and abandoned the file.
  assert.deepEqual(rubyRequires("buf = []\nbuf <<line\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("errors = []\nerrors <<\"Invalid\"\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(rubyRequires("@items <<item\nrequire 'real'\n"), ["real"]);
  // On a method with no line closing it, a shift too — and with one, a
  // heredoc whose body is prose, as before.
  assert.deepEqual(rubyRequires("out <<line\nrequire 'real'\n"), ["real"]);
  assert.deepEqual(
    rubyRequires("out <<~EOS\n  require 'ghost'\nEOS\nrequire 'real'\n"),
    ["real"],
  );
});

test("Ruby: a require in a one-line block is a require, and an interpolated one is computed", () => {
  assert.deepEqual(rubyRequires("hook = -> { require 'real' }\n"), ["real"]);
  assert.deepEqual(
    rubyRequires('Inspector.def_inspector([:pp], proc{require_relative "real"}){|v| v }\n'),
    ["rel:real"],
  );
  assert.deepEqual(rubyRequires('M.synchronize { require_relative "../real" }\n'), ["rel:../real"]);
  assert.deepEqual(rubyRequires("if x then require 'real' end\n"), ["real"]);
  // `require "drb/#{$1}"` is a run-time value. It was handed on as written,
  // source text in a specifier list, where `File.join(...)` is dropped.
  assert.deepEqual(rubyRequires('require "drb/#{$1}"\nrequire \'real\'\n'), ["real"]);
  assert.deepEqual(
    rubyRequires('require "rubygems/defaults/#{RUBY_ENGINE}"\nrequire \'real\'\n'),
    ["real"],
  );
});

test("PHP: one use clause can name several classes", () => {
  // Group and list forms are the ordinary shape of a Laravel file, and both
  // read as no import at all.
  assert.deepEqual(readPhpFile("<?php\nnamespace App;\nuse App\\Models\\{User, Post};\n")?.uses, [
    "App\\Models\\User",
    "App\\Models\\Post",
  ]);
  assert.deepEqual(readPhpFile("<?php\nnamespace App;\nuse App\\A, App\\B;\n")?.uses, ["App\\A", "App\\B"]);
  assert.deepEqual(readPhpFile("<?php\nnamespace App;\nuse App\\A as X, App\\B;\n")?.uses, ["App\\A", "App\\B"]);
  // A function or constant inside the braces is not a class, a trailing
  // comma names nothing, and a leading backslash is not part of the name.
  assert.deepEqual(
    readPhpFile("<?php\nuse \\App\\{function helper, const FLAG, Real, Other as O,};\n")?.uses,
    ["App\\Real", "App\\Other"],
  );
  // A closure's `use ($x)` reaches the same semicolon and is not a name
  // list — not even when a comma in the body leaves one item that would
  // read as a name on its own.
  assert.deepEqual(
    readPhpFile("<?php\n$f = function () use ($x) { return $x; };\nuse App\\Real;\n")?.uses,
    ["App\\Real"],
  );
  assert.deepEqual(
    readPhpFile("<?php\n$f = function () use ($x) { echo $x, Ghost; };\nuse App\\Real;\n")?.uses,
    ["App\\Real"],
  );
});

test("PHP: the global namespace block is a block, so beside a named one the file declares nothing", () => {
  // `namespace { }` had no name for the regex to match, so it was not
  // counted, and `Y` was filed under `A`: a `use A\Y` then resolved to a
  // class that does not exist.
  const unit = readPhpFile("<?php\nnamespace A {\n  class X {}\n}\nnamespace {\n  class Y {}\n}\n");
  assert.equal(unit?.namespace, "");
  assert.deepEqual(unit?.declared, []);
  // Alone, it is the global namespace, and a use directly inside it is top level.
  assert.deepEqual(readPhpFile("<?php\nnamespace {\n  use App\\Real;\n  class Y {}\n}\n"), {
    namespace: "",
    declared: ["Y"],
    uses: ["App\\Real"],
    requires: [],
  });
});

test("PHP: nothing after __halt_compiler() is code", () => {
  // A PHAR stub puts its payload there, and PHP lexes all of it as inline
  // data. Read as code, a `use` in the payload was an edge.
  assert.deepEqual(
    readPhpFile("<?php\nuse App\\Real;\n__halt_compiler();\nuse App\\Ghost; require 'ghost.php';\n"),
    { namespace: "", declared: [], uses: ["App\\Real"], requires: [] },
  );
  // A variable of that name is a variable.
  assert.deepEqual(
    readPhpFile("<?php\n$__halt_compiler() ;\nuse App\\Real;\n")?.uses,
    ["App\\Real"],
  );
});

test("PHP: a suppressed include is an include, and a shell string is a string", () => {
  assert.deepEqual(readPhpFile("<?php\n@include 'local.php';\n@require_once 'cfg.php';\n")?.requires, [
    "local.php",
    "cfg.php",
  ]);
  // A variable inside the quotes is interpolated at run time, so the string
  // is a computed path — dropped, as `. $ext` is, never recorded as written.
  assert.deepEqual(
    readPhpFile('<?php\nrequire "$dir/x.php";\nrequire "{$dir}/y.php";\nrequire \'z.php\';\n')?.requires,
    ["z.php"],
  );
  // The apostrophe inside the backticks opened a string that never closed.
  assert.deepEqual(readPhpFile("<?php\n$o = `echo it's`;\nuse App\\Real;\n")?.uses, ["App\\Real"]);
  // And it interpolates like a double-quoted one: a nested string holding
  // a backtick does not end it.
  assert.deepEqual(readPhpFile("<?php\n$o = `echo {$t(\"`\")}`;\nuse App\\Real;\n")?.uses, ["App\\Real"]);
});
