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
