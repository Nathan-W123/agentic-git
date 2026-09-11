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
