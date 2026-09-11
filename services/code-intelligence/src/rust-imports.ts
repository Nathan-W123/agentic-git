/**
 * Rust, where `mod` is a file reference and `use` is a walk through a module
 * tree the filesystem only half describes.
 *
 * Two kinds of dependency, and the first is the valuable one. `mod billing;`
 * literally says "the file `billing.rs` or `billing/mod.rs` is part of this
 * crate, here" — an exact file reference with no ambiguity, which is more
 * than most languages offer. `use crate::billing::Money` is the other kind: a
 * path through the module tree, resolvable only once the tree is known, and
 * where the tree is rooted depends on which file is asking.
 *
 * Rust needs its own masker. The shared one cannot read it: block comments
 * *nest*, raw strings (`r#"..."#`) have no escapes at all, and a lone `'` is
 * a lifetime far more often than it is a character literal — treat one as a
 * quote and everything after it is blanked away.
 */

import { posixBasename, posixDirname, posixJoin } from "./import-resolution.js";

/** Everything a Rust file says about which other files it needs. */
export interface RustFileFacts {
  /** `mod name;` — a declaration that another file is part of this crate. */
  modules: string[];
  /** `use` paths, as written, one per leaf of any brace tree. */
  uses: string[];
}

/**
 * Blanks comments, strings and char literals, keeping every offset.
 *
 * Returns nothing for a file it loses its place in, which for Rust means an
 * unclosed nested comment or an unterminated string. The contract the symbol
 * scanners keep: a partial answer that reads as complete is the one genuinely
 * harmful outcome.
 */
export function maskRust(source: string): string | undefined {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== "\n") {
        out[at] = " ";
      }
    }
  };
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      // Nested, unlike every other language here.
      let depth = 0;
      let at = index;
      for (;;) {
        if (at >= source.length) {
          return undefined;
        }
        if (source.startsWith("/*", at)) {
          depth += 1;
          at += 2;
          continue;
        }
        if (source.startsWith("*/", at)) {
          depth -= 1;
          at += 2;
          if (depth === 0) {
            break;
          }
          continue;
        }
        at += 1;
      }
      blank(index, at);
      index = at;
      continue;
    }
    // A raw string has no escapes, and its hash count sets its terminator.
    const raw = /^(?:b|c)?r(#*)"/u.exec(source.slice(index));
    if (raw !== null) {
      const hashes = raw[1] ?? "";
      const terminator = `"${hashes}`;
      const end = source.indexOf(terminator, index + raw[0].length);
      if (end === -1) {
        return undefined;
      }
      blank(index, end + terminator.length);
      index = end + terminator.length;
      continue;
    }
    const quote = /^(?:b|c)?"/u.exec(source.slice(index));
    if (quote !== null) {
      let at = index + quote[0].length;
      for (;;) {
        if (at >= source.length) {
          return undefined;
        }
        if (source[at] === "\\") {
          at += 2;
          continue;
        }
        if (source[at] === '"') {
          at += 1;
          break;
        }
        at += 1;
      }
      blank(index, at);
      index = at;
      continue;
    }
    if (source[index] === "'") {
      // A character literal, or a lifetime, or a loop label. Only the first
      // is a literal; advancing one character on the others is what keeps a
      // lifetime from blanking the rest of the file.
      const literal = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'])'/u.exec(
        source.slice(index),
      );
      if (literal !== null) {
        blank(index, index + literal[0].length);
        index += literal[0].length;
        continue;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/** Reads the `mod` declarations and `use` paths from one file. */
export function readRustFile(source: string): RustFileFacts | undefined {
  const code = maskRust(source);
  if (code === undefined) {
    return undefined;
  }
  const modules: string[] = [];
  // Only a `mod name;` declares a file. `mod name { ... }` is inline and
  // refers to nothing on disk, so the semicolon is load-bearing.
  for (const match of code.matchAll(
    /(?:^|[;{}\s])(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gu,
  )) {
    const name = match[1];
    if (name !== undefined) {
      modules.push(name);
    }
  }
  const uses: string[] = [];
  for (const match of code.matchAll(
    /(?:^|[;{}\s])(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+);/gu,
  )) {
    const tree = match[1];
    if (tree === undefined) {
      continue;
    }
    const expanded = expandUseTree(tree);
    if (expanded === undefined) {
      // A tree this could not expand. Dropping the one `use` rather than the
      // whole file: a brace group it cannot read says nothing about the
      // declarations around it.
      continue;
    }
    uses.push(...expanded);
  }
  return { modules, uses };
}

/** `a::{b, c::{d, e}}` into `a::b`, `a::c::d`, `a::c::e`. */
function expandUseTree(tree: string): string[] | undefined {
  // `as` is stripped before whitespace is, or the space that delimits it is
  // gone and `shared as helper` becomes the identifier `sharedashelper`.
  const text = tree.replace(/\s+as\s+(?:\w+|_)/gu, "").replace(/\s+/gu, "");
  if (!/^[\w:{},*]*$/u.test(text)) {
    return undefined;
  }
  const walk = (input: string, prefix: string): string[] | undefined => {
    const out: string[] = [];
    for (const part of splitTop(input)) {
      const brace = part.indexOf("{");
      if (brace === -1) {
        // A glob names the module it sits under, not an item in it, and
        // `self` is the prefix that is already recorded. Both answer with
        // the path so far — never with the empty string, which would read
        // as the crate root and resolve to whatever is at the top of it.
        const stem =
          part === "*" || part === "self"
            ? prefix.replace(/::$/u, "")
            : part.endsWith("::*")
              ? `${prefix}${part.slice(0, -3)}`
              : part.endsWith("::self")
                ? `${prefix}${part.slice(0, -6)}`
                : `${prefix}${part}`;
        if (stem !== "") {
          out.push(stem);
        }
        continue;
      }
      if (!part.endsWith("}")) {
        return undefined;
      }
      const inner = walk(part.slice(brace + 1, -1), `${prefix}${part.slice(0, brace)}`);
      if (inner === undefined) {
        return undefined;
      }
      out.push(...inner);
    }
    return out;
  };
  return walk(text, "");
}

/** Splits on commas at brace depth zero. */
function splitTop(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of input) {
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) {
        return [];
      }
    }
    if (character === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter((part) => part !== "");
}

export interface RustContext {
  files: ReadonlySet<string>;
}

function crateManifestDir(file: string, files: ReadonlySet<string>): string | undefined {
  let dir = posixDirname(file);
  for (;;) {
    if (files.has(posixJoin(dir, "Cargo.toml"))) {
      return dir;
    }
    if (dir === "") {
      return undefined;
    }
    dir = posixDirname(dir);
  }
}

/**
 * Whether this file is a crate root — a target rustc compiles directly.
 *
 * Anchored on a sibling `Cargo.toml` rather than on the file's name, which is
 * what keeps `src/utils/lib.rs` — an ordinary module that happens to be
 * called `lib` — from being read as a crate root.
 */
function isTargetRoot(file: string, files: ReadonlySet<string>): boolean {
  const crate = crateManifestDir(file, files);
  if (crate === undefined) {
    return false;
  }
  const rel = crate === "" ? file : file.slice(crate.length + 1);
  return (
    rel === "build.rs" ||
    rel === "src/lib.rs" ||
    rel === "src/main.rs" ||
    /^src\/bin\/[^/]+\.rs$/u.test(rel) ||
    /^src\/bin\/[^/]+\/main\.rs$/u.test(rel) ||
    /^(?:tests|benches|examples)\/[^/]+\.rs$/u.test(rel) ||
    /^(?:tests|benches|examples)\/[^/]+\/main\.rs$/u.test(rel)
  );
}

/** Where this file's own child modules live. */
function childDir(file: string, files: ReadonlySet<string>): string {
  if (posixBasename(file) === "mod.rs" || isTargetRoot(file, files)) {
    return posixDirname(file);
  }
  return posixJoin(posixDirname(file), posixBasename(file).replace(/\.rs$/u, ""));
}

/** The file backing one module segment, or nothing when it is not singular. */
function moduleFile(
  dir: string,
  name: string,
  files: ReadonlySet<string>,
): string | undefined {
  const hits = [posixJoin(dir, `${name}.rs`), posixJoin(dir, name, "mod.rs")].filter(
    (candidate) => files.has(candidate),
  );
  // Two is rustc E0761: the crate does not compile, and there is nothing to
  // pick between.
  return hits.length === 1 ? hits[0] : undefined;
}

/** The file a `mod name;` declaration refers to. */
export function resolveRustModule(
  fromFile: string,
  name: string,
  context: RustContext,
): readonly string[] {
  const hit = moduleFile(childDir(fromFile, context.files), name, context.files);
  return hit === undefined || hit === fromFile ? [] : [hit];
}

/**
 * The file a `use` path names, when it starts somewhere this can locate.
 *
 * `crate::`, `self::` and `super::` are anchored and resolvable. A bare
 * `use foo::Bar` is not: it may be an external crate, an item brought into
 * scope by another `use`, or a module of this one, and Rust's 2018 rules do
 * not let a file set decide which. Those are dropped.
 */
export function resolveRustUse(
  fromFile: string,
  usePath: string,
  context: RustContext,
): readonly string[] {
  const segments = usePath.split("::").filter((part) => part !== "");
  const [head, ...rest] = segments;
  if (head === undefined) {
    return [];
  }
  const files = context.files;
  let dir: string | undefined;
  let remaining = rest;
  if (head === "crate") {
    dir = crateRootDir(fromFile, files);
  } else if (head === "self") {
    dir = childDir(fromFile, files);
  } else if (head === "super") {
    dir = parentDir(fromFile, files);
    // Each further `super` climbs one more module, which is one directory.
    while (remaining[0] === "super" && dir !== undefined) {
      dir = dir === "" ? undefined : posixDirname(dir);
      remaining = remaining.slice(1);
    }
  } else {
    return [];
  }
  if (dir === undefined) {
    return [];
  }
  // Walk while each segment is a module; the first that is not is the item
  // being imported, and the file holding it is the answer.
  let current = dir;
  let landed: string | undefined;
  for (const segment of remaining) {
    const hit = moduleFile(current, segment, files);
    if (hit === undefined) {
      break;
    }
    landed = hit;
    current =
      posixBasename(hit) === "mod.rs"
        ? posixDirname(hit)
        : hit.replace(/\.rs$/u, "");
  }
  return landed === undefined || landed === fromFile ? [] : [landed];
}

function parentDir(file: string, files: ReadonlySet<string>): string | undefined {
  if (isTargetRoot(file, files)) {
    return undefined;
  }
  return posixBasename(file) === "mod.rs"
    ? posixDirname(posixDirname(file))
    : posixDirname(file);
}

function crateRootDir(file: string, files: ReadonlySet<string>): string | undefined {
  const crate = crateManifestDir(file, files);
  if (crate === undefined) {
    return undefined;
  }
  const rel = crate === "" ? file : file.slice(crate.length + 1);
  if (rel === "build.rs") {
    return crate;
  }
  if (rel.startsWith("src/")) {
    return files.has(posixJoin(crate, "src/lib.rs")) ||
      files.has(posixJoin(crate, "src/main.rs"))
      ? posixJoin(crate, "src")
      : undefined;
  }
  const target = /^(tests|benches|examples)\/(.+)$/u.exec(rel);
  if (target !== null) {
    const base = posixJoin(crate, target[1] ?? "");
    const rest = target[2] ?? "";
    if (!rest.includes("/")) {
      return base;
    }
    const first = rest.split("/")[0] ?? "";
    return files.has(posixJoin(base, first, "main.rs"))
      ? posixJoin(base, first)
      : undefined;
  }
  return undefined;
}
