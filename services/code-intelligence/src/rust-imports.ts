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
      const literal = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]{1,12}\}|.)|[^\\'])'/u.exec(
        source.slice(index),
      );
      if (literal !== null) {
        blank(index, index + literal[0].length);
        index += literal[0].length;
        continue;
      }
      // An escape this did not recognise is still a literal, not a
      // lifetime: skip to its closing quote rather than re-enter it midway
      // and take the quote inside for the start of a string.
      if (source[index + 1] === "\\") {
        const end = source.indexOf("'", index + 2);
        if (end !== -1 && end - index <= 16) {
          blank(index, end + 1);
          index = end + 1;
          continue;
        }
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/**
 * Reads the `mod` declarations and `use` paths from one file.
 *
 * Inline modules matter here. `mod tests { use super::error::E; mod
 * helpers; }` is in nearly every Rust file, and inside it `super` is the
 * file's own module rather than its parent, `self` is `tests`, and `mod
 * helpers;` names `tests/helpers.rs`. Every path is rewritten to what it
 * means from the file's point of view before it is recorded, so a resolver
 * that knows nothing about inline modules still lands on the right file.
 *
 * A `#[path = "..."]` attribute replaces the name's own file rule with a
 * literal path, recorded as `modpath:` so the resolver reads it as one.
 */
export function readRustFile(source: string): RustFileFacts | undefined {
  const code = maskRust(source);
  if (code === undefined) {
    return undefined;
  }
  const modules: string[] = [];
  const uses: string[] = [];
  // Only a `mod name;` declares a file. `mod name { ... }` is inline and
  // refers to nothing on disk, so the semicolon is load-bearing. Anchored
  // by a lookbehind rather than a consumed delimiter, so `mod g;mod h;` and
  // `#[cfg(test)]mod d;` are read whole.
  const MODULE = /(?<![\w#$])(?:pub(?:\s*\([^)]*\))?\s*)?mod\s+([A-Za-z_]\w*)\s*;/gu;
  const USE = /(?<![\w#$])(?:pub(?:\s*\([^)]*\))?\s*)?use\s+([^;]+);/gu;
  const found: Array<{ at: number; kind: "mod" | "use"; match: RegExpMatchArray }> = [];
  for (const match of code.matchAll(MODULE)) {
    if (match.index !== undefined) {
      found.push({ at: match.index, kind: "mod", match });
    }
  }
  for (const match of code.matchAll(USE)) {
    if (match.index !== undefined) {
      found.push({ at: match.index, kind: "use", match });
    }
  }
  found.sort((left, right) => left.at - right.at);

  // One pass over the code, keeping the stack of inline modules open at each
  // recorded match. A `macro_rules!` body is a frame of its own: what it
  // says is said at the expansion site, not here.
  const stack: Array<{ name: string; depth: number; macro: boolean }> = [];
  let depth = 0;
  let cursor = 0;
  for (const entry of found) {
    for (; cursor < entry.at; cursor += 1) {
      const character = code[cursor];
      if (character === "{") {
        const window = code.slice(Math.max(0, cursor - 80), cursor);
        const opener = /(?<![\w#$])mod\s+([A-Za-z_]\w*)\s*$/u.exec(window);
        if (opener?.[1] !== undefined) {
          stack.push({ name: opener[1], depth, macro: false });
        } else if (/(?<![\w#$])macro_rules!\s*[A-Za-z_]\w*\s*$/u.test(window)) {
          stack.push({ name: "", depth, macro: true });
        }
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (stack.at(-1)?.depth === depth) {
          stack.pop();
        }
      }
    }
    // A literal `mod generated;` inside a macro definition declares a file
    // only where the macro is invoked, which may be another file, or
    // nowhere: recording it here resolved to a stale `generated.rs` whether
    // or not anything expanded the macro.
    if (stack.some((frame) => frame.macro)) {
      continue;
    }
    const inline = stack.filter((frame) => !frame.macro).map((frame) => frame.name);
    if (entry.kind === "mod") {
      const name = entry.match[1];
      if (name === undefined) {
        continue;
      }
      const explicit = pathAttribute(source, code, entry.at);
      if (explicit !== undefined) {
        // A literal path inside an inline module is measured from a
        // directory this does not model; dropping it is the safe answer.
        if (inline.length === 0 && explicit !== "") {
          modules.push(`path:${explicit}`);
        }
        continue;
      }
      modules.push([...inline, name].join("/"));
      continue;
    }
    const tree = entry.match[1];
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
    for (const path of expanded) {
      const rewritten = fromInline(path, inline);
      if (rewritten !== undefined) {
        uses.push(rewritten);
      }
    }
  }
  return { modules: [...new Set(modules)], uses: [...new Set(uses)] };
}

/**
 * A `use` path as the file sees it, from inside `inline` modules.
 *
 * `self::x` two modules down is `self::a::b::x`; one `super` per level of
 * inline nesting climbs back to the file itself, and any left over climb
 * from there as they always did. `crate::` and bare paths mean the same
 * thing at every depth.
 */
function fromInline(path: string, inline: readonly string[]): string | undefined {
  if (inline.length === 0) {
    return path;
  }
  const segments = path.split("::");
  if (segments[0] === "self") {
    return ["self", ...inline, ...segments.slice(1)].join("::");
  }
  if (segments[0] === "super") {
    let supers = 0;
    while (segments[supers] === "super") {
      supers += 1;
    }
    const rest = segments.slice(supers);
    if (supers <= inline.length) {
      return ["self", ...inline.slice(0, inline.length - supers), ...rest].join("::");
    }
    return [...Array<string>(supers - inline.length).fill("super"), ...rest].join("::");
  }
  return path;
}

/**
 * The literal of a `#[path = "..."]` attribute immediately above a `mod`
 * declaration, read from the raw source at the offsets the mask preserved.
 * Empty when the attribute is there and its literal could not be read.
 */
function pathAttribute(source: string, code: string, modAt: number): string | undefined {
  const from = Math.max(
    code.lastIndexOf(";", modAt),
    code.lastIndexOf("{", modAt),
    code.lastIndexOf("}", modAt),
    0,
  );
  const before = code.slice(from, modAt);
  // The mask blanked the literal, quotes and all, so what follows `=` is a
  // run of spaces exactly where the string was.
  const attribute = /#\[\s*path\s*=( *)\](?:\s*#\[[^\]]*\])*\s*$/u.exec(before);
  if (attribute === null || attribute.index === undefined) {
    return undefined;
  }
  const blankStart = attribute.index + attribute[0].indexOf("=") + 1;
  const literal = source
    .slice(from + blankStart, from + blankStart + (attribute[1] ?? "").length)
    .trim()
    .replace(/^"|"$/gu, "");
  return /^[\w./-]+\.rs$/u.test(literal) && !literal.includes("..") ? literal : "";
}

/** `a::{b, c::{d, e}}` into `a::b`, `a::c::d`, `a::c::e`. */
function expandUseTree(tree: string): string[] | undefined {
  // `as` is stripped before whitespace is, or the space that delimits it is
  // gone and `shared as helper` becomes the identifier `sharedashelper`.
  const text = tree.replace(/\s+as\s+(?:\w+|_)/gu, "").replace(/\s+/gu, "");
  // Bounded: a tree nobody would write can still be handed to this, and a
  // recursion that overflows the stack takes the whole index build with it.
  if (text.length > 4096 || !/^[\w:{},*]*$/u.test(text)) {
    return undefined;
  }
  const walk = (input: string, prefix: string, nested = 0): string[] | undefined => {
    if (nested > 32) {
      return undefined;
    }
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
      const inner = walk(
        part.slice(brace + 1, -1),
        `${prefix}${part.slice(0, brace)}`,
        nested + 1,
      );
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
  /**
   * The crate roots the manifests name explicitly — see {@link cargoTargets}.
   * Absent means no manifest was read, and only the conventional roots count.
   */
  rustTargets?: ReadonlySet<string>;
}

/** The tables of a Cargo manifest whose `path` names a crate root. */
const TARGET_TABLES = new Set(["lib", "bin", "example", "test", "bench"]);

/**
 * The target files the Cargo manifests name explicitly, repository-relative.
 *
 * Cargo's layout is a convention, not a rule. `[lib] path = "src/acme.rs"`
 * and `[[bin]] path = "src/tools/tool.rs"` put a crate root wherever the
 * manifest says, and a file the convention reads as an ordinary module of
 * the library is then a root whose `crate::` is its own directory. Nothing
 * on disk says so; only the manifest does, which is why it is read.
 *
 * A deliberately small reading of TOML: table headers, and a `path` key on a
 * line of its own under one of the target tables, or `build` under
 * `[package]`. An inline-table array (`bin = [{ path = ".." }]`) is not read,
 * and a root it would have named is treated as the convention treats it — a
 * missed root, never a wrong one.
 */
export function cargoTargets(manifests: ReadonlyMap<string, string>): Set<string> {
  const targets = new Set<string>();
  for (const [file, source] of manifests) {
    if (posixBasename(file) !== "Cargo.toml") {
      continue;
    }
    const dir = posixDirname(file);
    let table = "";
    for (const raw of source.split("\n")) {
      const line = withoutTomlComment(raw).trim();
      if (line.startsWith("[")) {
        // Every header changes the table, including one this cannot read
        // (`[target.'cfg(unix)'.dependencies]`): a `path` under it must not
        // be charged to the target table before it.
        table = /^\[\[?\s*([\w-]+)\s*\]\]?$/u.exec(line)?.[1] ?? "";
        continue;
      }
      const key = /^(path|build)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*$/u.exec(line);
      if (key === null) {
        continue;
      }
      const wanted = key[1] === "path" ? TARGET_TABLES.has(table) : table === "package";
      const value = key[2] ?? key[3] ?? "";
      if (!wanted || !value.endsWith(".rs")) {
        continue;
      }
      const target = posixJoin(dir, value);
      if (target !== "") {
        targets.add(target);
      }
    }
  }
  return targets;
}

/** A TOML line up to its `#`, which is a comment only outside a string. */
function withoutTomlComment(line: string): string {
  let quote: string | undefined;
  for (let at = 0; at < line.length; at += 1) {
    const character = line[at];
    if (quote !== undefined) {
      if (character === "\\" && quote === '"') {
        at += 1;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, at);
    }
  }
  return line;
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
 * called `lib` — from being read as a crate root. A file the manifest names
 * as a target is one wherever it sits.
 */
function isTargetRoot(file: string, context: RustContext): boolean {
  if (context.rustTargets?.has(file) === true) {
    return true;
  }
  const { files } = context;
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
function childDir(file: string, context: RustContext): string {
  if (posixBasename(file) === "mod.rs" || isTargetRoot(file, context)) {
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

/**
 * The file a `mod name;` declaration refers to.
 *
 * `name` may carry the inline modules it was declared inside, as `a/b/name`
 * — those are directories under the file's own child directory. A
 * `path:` prefix is a `#[path]` literal, measured from the directory the
 * declaring file is in, which is rustc's rule for a declaration outside any
 * inline module.
 */
export function resolveRustModule(
  fromFile: string,
  name: string,
  context: RustContext,
): readonly string[] {
  if (name.startsWith("path:")) {
    const hit = posixJoin(posixDirname(fromFile), name.slice(5));
    return hit !== "" && hit !== fromFile && context.files.has(hit) ? [hit] : [];
  }
  const segments = name.split("/");
  const leaf = segments.pop() ?? "";
  const dir = [childDir(fromFile, context), ...segments].filter((part) => part !== "").join("/");
  const hit = moduleFile(dir, leaf, context.files);
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
    dir = crateRootDir(fromFile, context);
  } else if (head === "self") {
    dir = childDir(fromFile, context);
  } else if (head === "super") {
    dir = parentDir(fromFile, context);
    // Each further `super` climbs one more module, which is one directory —
    // and never above the crate root, where `build.rs` is a different crate
    // and rustc would have refused the path anyway.
    const root = crateRootDir(fromFile, context);
    const inside = (candidate: string | undefined): boolean =>
      candidate !== undefined &&
      (root === undefined
        ? candidate !== ""
        : candidate === root || candidate.startsWith(`${root}/`));
    if (!inside(dir)) {
      dir = undefined;
    }
    while (remaining[0] === "super" && dir !== undefined) {
      const climbed = dir === "" ? undefined : posixDirname(dir);
      dir = inside(climbed) ? climbed : undefined;
      remaining = remaining.slice(1);
    }
  } else {
    return [];
  }
  if (dir === undefined) {
    return [];
  }
  if (head === "super" && remaining.length === 0) {
    // `use super::*` names the parent module itself, and the file that
    // holds it is a real dependency of this one — the walk below needs a
    // segment to land on, so without this the commonest `use` in a Rust
    // module tree recorded nothing.
    const owner = moduleOwner(dir, fromFile, context);
    return owner === undefined || owner === fromFile ? [] : [owner];
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

function parentDir(file: string, context: RustContext): string | undefined {
  if (isTargetRoot(file, context)) {
    return undefined;
  }
  return posixBasename(file) === "mod.rs"
    ? posixDirname(posixDirname(file))
    : posixDirname(file);
}

/**
 * The file whose module has `dir` as its child directory: the crate root
 * when `dir` is the root's own directory, else `<dir>.rs` or `<dir>/mod.rs`.
 * Nothing when more than one file could be it — a crate with both `lib.rs`
 * and `main.rs` may declare `mod foo;` in either.
 */
function moduleOwner(dir: string, fromFile: string, context: RustContext): string | undefined {
  const root = crateRootDir(fromFile, context);
  if (root === undefined) {
    return undefined;
  }
  if (dir !== root) {
    return moduleFile(posixDirname(dir), posixBasename(dir), context.files);
  }
  const candidates = new Set<string>();
  for (const name of ["lib.rs", "main.rs"]) {
    const candidate = posixJoin(root, name);
    if (context.files.has(candidate) && isTargetRoot(candidate, context)) {
      candidates.add(candidate);
    }
  }
  for (const target of context.rustTargets ?? []) {
    if (posixDirname(target) === root && context.files.has(target)) {
      candidates.add(target);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

/**
 * The directory `crate::` names from this file.
 *
 * A declared target is its own root. For any other file the conventional
 * root and the directory of every declared target above the file are the
 * candidates: `src/tools/config.rs` beside a `[[bin]] path = "src/tools/
 * tool.rs"` may be the library's `tools::config` or the tool's `config`,
 * and the file set cannot say which, so two candidates is no answer.
 */
function crateRootDir(file: string, context: RustContext): string | undefined {
  const { files } = context;
  if (context.rustTargets?.has(file) === true) {
    return posixDirname(file);
  }
  const crate = crateManifestDir(file, files);
  if (crate === undefined) {
    return undefined;
  }
  const candidates = new Set<string>();
  const conventional = conventionalRootDir(file, crate, files);
  if (conventional !== undefined) {
    candidates.add(conventional);
  }
  for (const target of context.rustTargets ?? []) {
    const dir = posixDirname(target);
    // A target's directory competes only from within the conventional
    // root: a `build.rs` or a `main.rs` at the crate's own directory holds
    // every file of the crate, and `src/foo.rs` is the library's for all
    // that.
    const above =
      conventional !== undefined &&
      conventional !== dir &&
      (dir === "" || conventional.startsWith(`${dir}/`));
    if (
      !above &&
      (dir === "" || file.startsWith(`${dir}/`)) &&
      crateManifestDir(target, files) === crate
    ) {
      candidates.add(dir);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

/** The root Cargo's layout convention gives a file, by its path alone. */
function conventionalRootDir(
  file: string,
  crate: string,
  files: ReadonlySet<string>,
): string | undefined {
  const rel = crate === "" ? file : file.slice(crate.length + 1);
  if (rel === "build.rs") {
    return crate;
  }
  // A binary target is its own crate: `crate::` inside `src/bin/tool.rs`
  // is `src/bin/`, not the library's `src/`, and bins and libraries share
  // module names like `config` and `cli` all the time.
  if (/^src\/bin\/[^/]+\.rs$/u.test(rel)) {
    return posixJoin(crate, "src/bin");
  }
  const bin = /^src\/bin\/([^/]+)\//u.exec(rel);
  if (bin !== null) {
    const dir = posixJoin(crate, "src/bin", bin[1] ?? "");
    return files.has(posixJoin(dir, "main.rs")) ? dir : undefined;
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
