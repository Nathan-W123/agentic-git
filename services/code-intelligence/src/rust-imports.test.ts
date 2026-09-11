/**
 * Rust, where the masker is most of the difficulty.
 *
 * Block comments nest, raw strings have no escapes, and a lone `'` is a
 * lifetime far more often than a character literal — read one as a quote and
 * everything after it is blanked away, which silently costs every declaration
 * in the rest of the file.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  cargoTargets,
  maskRust,
  readRustFile,
  resolveRustModule,
  resolveRustUse,
} from "./rust-imports.js";

const repo = (...files: string[]) => ({ files: new Set(files) });

/* -------------------------------------------------------------- masking -- */

test("a lifetime is not a string", () => {
  // The one that costs everything after it. `'a` opens no literal, so a
  // masker that treats it as a quote blanks the rest of the file and the
  // declarations below simply vanish.
  // A single lifetime, deliberately: two of them pair up and the damage is
  // contained, which is how a masker this broken can still pass a test. One
  // leaves an unclosed quote that swallows the rest of the file.
  const masked = maskRust("struct S<'a> { name: &'a str }\nmod real;\n");
  assert.notEqual(masked, undefined);
  assert.match(masked ?? "", /mod real;/u);
  const odd = maskRust("fn f<'a>(x: &str) {}\nmod real;\n");
  assert.notEqual(odd, undefined);
  assert.match(odd ?? "", /mod real;/u);
  // And the declaration really is read back out, not merely present in the
  // masked text.
  assert.deepEqual(
    readRustFile("fn f<'a>(x: &str) {}\nmod real;\n")?.modules,
    ["real"],
  );
});

test("block comments nest, which the shared masker cannot do", () => {
  const masked = maskRust("/* outer /* inner */ still comment */\nmod real;\n");
  assert.notEqual(masked, undefined);
  assert.match(masked ?? "", /mod real;/u);
  assert.doesNotMatch(masked ?? "", /still comment/u);
});

test("a raw string has no escapes and its hashes set the terminator", () => {
  const masked = maskRust('let s = r#"a \\ " b"#;\nmod real;\n');
  assert.notEqual(masked, undefined);
  assert.match(masked ?? "", /mod real;/u);
});

test("a file the masker loses its place in is abandoned", () => {
  assert.equal(maskRust("/* never closed\nmod x;\n"), undefined);
  assert.equal(maskRust('let s = "unterminated\n'), undefined);
  assert.equal(readRustFile("/* never closed\nmod x;\n"), undefined);
});

/* -------------------------------------------------------------- reading -- */

test("only a semicolon form of mod names a file", () => {
  const facts = readRustFile(
    [
      "mod billing;",
      "pub mod store;",
      "pub(crate) mod internal;",
      "mod inline { pub fn f() {} }",
      "// mod commented;",
      'let s = "mod in_a_string;";',
    ].join("\n"),
  );
  // The inline module refers to nothing on disk, and neither does a comment
  // or a string.
  assert.deepEqual(facts?.modules, ["billing", "store", "internal"]);
});

test("a use tree expands to one path per leaf", () => {
  const facts = readRustFile(
    [
      "use crate::billing::{money::Money, ledger::Ledger};",
      "use super::shared as helper;",
      "use crate::util::*;",
    ].join("\n"),
  );
  assert.deepEqual(facts?.uses, [
    "crate::billing::money::Money",
    "crate::billing::ledger::Ledger",
    "super::shared",
    "crate::util",
  ]);
});

/* ------------------------------------------------------------ resolving -- */

test("mod finds the file it names, in either shape", () => {
  const context = repo(
    "Cargo.toml",
    "src/lib.rs",
    "src/billing.rs",
    "src/store/mod.rs",
  );
  assert.deepEqual(resolveRustModule("src/lib.rs", "billing", context), [
    "src/billing.rs",
  ]);
  assert.deepEqual(resolveRustModule("src/lib.rs", "store", context), [
    "src/store/mod.rs",
  ]);
});

test("both shapes at once is a crate that does not compile, so neither is picked", () => {
  // rustc E0761. There is nothing to choose between.
  const context = repo(
    "Cargo.toml",
    "src/lib.rs",
    "src/billing.rs",
    "src/billing/mod.rs",
  );
  assert.deepEqual(resolveRustModule("src/lib.rs", "billing", context), []);
});

test("a child module of a plain file lives in a directory named after it", () => {
  const context = repo(
    "Cargo.toml",
    "src/lib.rs",
    "src/billing.rs",
    "src/billing/money.rs",
  );
  assert.deepEqual(resolveRustModule("src/billing.rs", "money", context), [
    "src/billing/money.rs",
  ]);
});

test("a file called lib.rs that is not a crate root is an ordinary module", () => {
  // Anchored on a sibling Cargo.toml rather than on the name, which is what
  // keeps `src/utils/lib.rs` from being read as a crate root and resolving
  // everybody's `crate::` to the wrong place.
  const context = repo(
    "Cargo.toml",
    "src/lib.rs",
    "src/utils/lib.rs",
    "src/utils/lib/inner.rs",
  );
  assert.deepEqual(resolveRustModule("src/utils/lib.rs", "inner", context), [
    "src/utils/lib/inner.rs",
  ]);
});

test("crate, self and super are anchored, and a bare path is not", () => {
  const context = repo(
    "Cargo.toml",
    "src/lib.rs",
    "src/billing.rs",
    "src/billing/money.rs",
    "src/shared.rs",
  );
  assert.deepEqual(
    resolveRustUse("src/billing/money.rs", "crate::shared::Thing", context),
    ["src/shared.rs"],
  );
  assert.deepEqual(
    resolveRustUse("src/billing/money.rs", "super::money::Money", context),
    ["src/billing/money.rs"].filter((file) => file !== "src/billing/money.rs"),
  );
  // A bare path may be an external crate, or a name another `use` brought
  // into scope. Rust's own rules do not let a file set decide, so it drops.
  assert.deepEqual(
    resolveRustUse("src/billing/money.rs", "serde::Deserialize", context),
    [],
  );
});

test("a workspace member resolves inside its own crate", () => {
  const context = repo(
    "Cargo.toml",
    "crates/billing/Cargo.toml",
    "crates/billing/src/lib.rs",
    "crates/billing/src/money.rs",
    "crates/store/Cargo.toml",
    "crates/store/src/lib.rs",
  );
  assert.deepEqual(
    resolveRustUse("crates/billing/src/lib.rs", "crate::money::Money", context),
    ["crates/billing/src/money.rs"],
  );
  // And `crate::` never escapes into a sibling crate.
  assert.deepEqual(
    resolveRustUse("crates/billing/src/lib.rs", "crate::store::Thing", context),
    [],
  );
});

/* ------------------------------------------------------------ second pass -- */

test("a binary target is its own crate, and crate:: inside it never reaches the library", () => {
  // Bins and libraries share module names like `config` and `cli` all the
  // time; `src/bin/tool.rs` saying `crate::config` means `src/bin/config.rs`.
  const context = repo("Cargo.toml", "src/lib.rs", "src/config.rs", "src/bin/tool.rs", "src/bin/config.rs");
  assert.deepEqual(resolveRustModule("src/bin/tool.rs", "config", context), ["src/bin/config.rs"]);
  assert.deepEqual(resolveRustUse("src/bin/tool.rs", "crate::config::Settings", context), [
    "src/bin/config.rs",
  ]);
  const nested = repo("Cargo.toml", "src/lib.rs", "src/cli.rs", "src/bin/tool/main.rs", "src/bin/tool/cli.rs");
  assert.deepEqual(resolveRustUse("src/bin/tool/main.rs", "crate::cli::Args", nested), [
    "src/bin/tool/cli.rs",
  ]);
});

test("inside an inline module, super is the file and self is the module", () => {
  const context = repo(
    "Cargo.toml", "src/lib.rs", "src/main.rs", "src/error.rs", "src/helpers.rs",
    "src/parser.rs", "src/parser/error.rs", "src/tests/helpers.rs",
  );
  // `mod tests { use super::error::E }` in parser.rs means parser's own
  // `error` — parser/error.rs — not the crate's error.rs beside it.
  const parser = readRustFile("mod error;\n#[cfg(test)]\nmod tests {\n    use super::error::ParseError;\n    use super::*;\n}\n");
  assert.deepEqual(parser?.uses, ["self::error::ParseError", "self"]);
  assert.deepEqual(resolveRustUse("src/parser.rs", "self::error::ParseError", context), ["src/parser/error.rs"]);
  // And `mod helpers;` inside it names tests/helpers.rs.
  const lib = readRustFile("#[cfg(test)]\nmod tests {\n    mod helpers;\n    use self::helpers::fixture;\n}\n");
  assert.deepEqual(lib?.modules, ["tests/helpers"]);
  assert.deepEqual(resolveRustModule("src/lib.rs", "tests/helpers", context), ["src/tests/helpers.rs"]);
  // Two levels down, one `super` is the outer inline module.
  const deep = readRustFile("mod a {\n    mod b {\n        use super::x::Y;\n        use super::super::z::W;\n    }\n}\n");
  assert.deepEqual(deep?.uses, ["self::a::x::Y", "self::z::W"]);
});

test("a #[path] attribute names the file itself", () => {
  const context = repo("Cargo.toml", "src/lib.rs", "src/sys.rs", "src/unix.rs", "src/windows.rs");
  const facts = readRustFile(
    '#[cfg(unix)] #[path = "unix.rs"] mod sys;\n#[cfg(windows)]\n#[path = "windows.rs"]\nmod sys;\n#[path = "../escape.rs"] mod bad;\n',
  );
  // The stale sys.rs is not what either declaration means, and a literal
  // that walks out of the directory is dropped rather than followed.
  assert.deepEqual(facts?.modules, ["path:unix.rs", "path:windows.rs"]);
  assert.deepEqual(resolveRustModule("src/lib.rs", "path:unix.rs", context), ["src/unix.rs"]);
  assert.deepEqual(resolveRustModule("src/lib.rs", "path:windows.rs", context), ["src/windows.rs"]);
});

test("a use tree nobody would write is dropped, not a stack overflow", () => {
  const depth = 8000;
  assert.deepEqual(
    readRustFile(`use a::${"{".repeat(depth)}b${"}".repeat(depth)};\nmod real;\n`),
    { modules: ["real"], uses: [] },
  );
});

test("a char literal the masker does not recognise is still a literal", () => {
  // `'\u{1_F600}'` is valid Rust; read as a lifetime it left the `'"'` after
  // it to open a string that swallowed `mod real;`.
  const facts = readRustFile("let x = ('\\u{1_F600}','\"');\nlet s = \"mod fake;\";\nlet q = '\"';\nmod real;\n");
  assert.deepEqual(facts, { modules: ["real"], uses: [] });
});

test("adjacent declarations are each read, and a repeated one is recorded once", () => {
  assert.deepEqual(
    readRustFile("mod g;mod h;\nuse x::a;use x::b;\npub(crate)mod c;\n#[cfg(test)]mod d;\n#[allow(unused)]use crate::a::B;\n"),
    { modules: ["g", "h", "c", "d"], uses: ["x::a", "x::b", "crate::a::B"] },
  );
  assert.deepEqual(readRustFile("#[cfg(unix)] mod sys;\n#[cfg(windows)] mod sys;\n"), {
    modules: ["sys"],
    uses: [],
  });
});

test("super never climbs past the crate root", () => {
  // build.rs is a different crate, and rustc refuses the path anyway.
  const context = repo("Cargo.toml", "build.rs", "src/lib.rs", "src/foo.rs", "src/mod.rs");
  assert.deepEqual(resolveRustUse("src/foo.rs", "super::super::build::X", context), []);
  assert.deepEqual(resolveRustUse("src/mod.rs", "super::build::X", context), []);
});

test("a target the manifest names is a crate root wherever it sits", () => {
  // `[[bin]] path = "src/tools/tool.rs"` puts a root where the convention
  // sees an ordinary module of the library; read by path alone, its
  // `crate::config` landed on the library's `src/config.rs`.
  const manifests = new Map([
    [
      "Cargo.toml",
      [
        "[package]",
        'name = "acme"',
        'build = "build.rs" # the default, spelt out',
        "",
        "[lib]",
        'path = "src/acme.rs"',
        "",
        "[[bin]]",
        'name = "tool"',
        'path = "src/tools/tool.rs"',
        "",
        "[target.'cfg(unix)'.dependencies.foo]",
        'path = "../foo.rs"',
        "",
        "[[example]]",
        "path = 'examples/demo/run.rs'",
      ].join("\n"),
    ],
    ["notes/Cargo.toml.bak", '[[bin]]\npath = "stale.rs"\n'],
  ]);
  // A dependency's `path` is not a target, and neither is a manifest that is
  // not one.
  assert.deepEqual(
    [...cargoTargets(manifests)],
    ["build.rs", "src/acme.rs", "src/tools/tool.rs", "examples/demo/run.rs"],
  );
  const context = {
    files: new Set(["Cargo.toml", "src/lib.rs", "src/config.rs", "src/tools/tool.rs", "src/tools/config.rs"]),
    rustTargets: new Set(["src/tools/tool.rs"]),
  };
  assert.deepEqual(resolveRustModule("src/tools/tool.rs", "config", context), ["src/tools/config.rs"]);
  assert.deepEqual(resolveRustUse("src/tools/tool.rs", "crate::config::Settings", context), [
    "src/tools/config.rs",
  ]);
  // `src/tools/config.rs` may be the library's `tools::config` or the
  // tool's `config`, and the file set cannot say which: no answer.
  assert.deepEqual(resolveRustUse("src/tools/config.rs", "crate::config::Settings", context), []);
  // A `[lib] path` root makes `crate::` its directory for the whole crate.
  const custom = {
    files: new Set(["Cargo.toml", "src/acme.rs", "src/config.rs", "src/net.rs"]),
    rustTargets: new Set(["src/acme.rs"]),
  };
  assert.deepEqual(resolveRustModule("src/acme.rs", "config", custom), ["src/config.rs"]);
  assert.deepEqual(resolveRustUse("src/net.rs", "crate::config::Settings", custom), ["src/config.rs"]);
  // A build script at the crate's own directory holds every file of the
  // crate; it must not make the library's modules ambiguous.
  const build = {
    files: new Set(["Cargo.toml", "build.rs", "src/lib.rs", "src/foo.rs", "src/bar.rs"]),
    rustTargets: new Set(["build.rs"]),
  };
  assert.deepEqual(resolveRustUse("src/foo.rs", "crate::bar::X", build), ["src/bar.rs"]);
});

test("use super::* names the parent module's file", () => {
  // The commonest `use` in a module tree, and it recorded nothing: the walk
  // needed a segment to land on. The parent is a real dependency.
  const context = repo(
    "Cargo.toml", "src/lib.rs", "src/foo.rs", "src/billing.rs", "src/billing/money.rs",
    "src/store/mod.rs", "src/store/item.rs",
  );
  assert.deepEqual(resolveRustUse("src/foo.rs", "super", context), ["src/lib.rs"]);
  assert.deepEqual(resolveRustUse("src/billing/money.rs", "super", context), ["src/billing.rs"]);
  assert.deepEqual(resolveRustUse("src/store/item.rs", "super", context), ["src/store/mod.rs"]);
  assert.deepEqual(resolveRustUse("src/billing/money.rs", "super::super", context), ["src/lib.rs"]);
  // With both `lib.rs` and `main.rs`, either may have declared `mod foo;`.
  const both = repo("Cargo.toml", "src/lib.rs", "src/main.rs", "src/foo.rs");
  assert.deepEqual(resolveRustUse("src/foo.rs", "super", both), []);
  // `tests/common/mod.rs` is declared by any of the test targets beside it.
  const tests = repo("Cargo.toml", "src/lib.rs", "tests/it.rs", "tests/common/mod.rs");
  assert.deepEqual(resolveRustUse("tests/common/mod.rs", "super", tests), []);
});

test("a mod inside a macro_rules! body declares nothing here", () => {
  // The expansion site decides what a macro's `mod generated;` means, and it
  // may be another file or nowhere; recorded here it resolved to a stale
  // `generated.rs` whether or not anything invoked the macro.
  assert.deepEqual(
    readRustFile(
      "macro_rules! m {\n    () => {\n        mod generated;\n        use crate::generated::X;\n    };\n}\nmod real;\nuse crate::real::Y;\n",
    ),
    { modules: ["real"], uses: ["crate::real::Y"] },
  );
});
