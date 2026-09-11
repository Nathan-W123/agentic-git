/**
 * Go imports, where one specifier names a directory rather than a file.
 *
 * `import "example.com/m/billing"` depends on every non-test `.go` file in
 * `billing/`, because a Go package *is* its directory. That is why resolution
 * had to stop returning a single path: there is no one file to point at, and
 * picking one would be a fiction.
 *
 * Two things have to be true before any of it can be resolved, and neither is
 * knowable from a single file. The repository's own import path lives in
 * `go.mod` — nowhere in the source, and not in the clone path either — so
 * without reading those, every Go specifier is a third-party module as far as
 * this can tell. And whether a candidate file is really in the package
 * depends on its own `package` clause and build constraints.
 *
 * The bar throughout is the one the rest of this service keeps: a missed edge
 * costs a warning, a false edge blocks work that should have run. Everything
 * below drops rather than guesses.
 */

import { posixDirname, posixJoin } from "./import-resolution.js";

/** What one `.go` file says about itself, or nothing if it could not be read. */
export interface GoFileFacts {
  packageName: string;
  /** `//go:build ignore` — present in a directory, member of no package. */
  buildIgnored: boolean;
  imports: string[];
}

/**
 * The top-level names the standard library occupies.
 *
 * A module path is allowed to have no dot in it — `module myapp` is legal and
 * common in internal repositories — and such a path would otherwise match
 * `import "fmt"` and resolve the standard library into somebody's source
 * tree. The toolchain resolves std first; so does this.
 */
const STD_ROOTS = new Set([
  "archive", "arena", "bufio", "builtin", "bytes", "cmd", "cmp", "compress",
  "container", "context", "crypto", "database", "debug", "embed", "encoding",
  "errors", "expvar", "flag", "fmt", "go", "hash", "html", "image", "index",
  "internal", "io", "iter", "log", "maps", "math", "mime", "net", "os",
  "path", "plugin", "reflect", "regexp", "runtime", "slices", "sort",
  "strconv", "strings", "structs", "sync", "syscall", "testing", "text",
  "time", "unicode", "unique", "unsafe", "weak",
]);

/** Directories the go tool never builds, as either end of an edge. */
const IGNORED_DIR =
  /(?:^|\/)(?:testdata|vendor)(?:\/|$)|(?:^|\/)[._][^/]*(?:\/|$)/u;

export function goDirectoryIsIgnored(dir: string): boolean {
  return IGNORED_DIR.test(`${dir}/`);
}

/**
 * Reads a `.go` file's prologue: its package clause and its imports.
 *
 * Only the prologue, and that is what makes a scanner safe here. Go requires
 * the package clause first and every import before any declaration, so the
 * region this reads is small, has a defined end, and cannot contain a
 * function body. Anything unexpected inside it — an unterminated string, a
 * comment that never closes, a token that cannot legally be there — means the
 * reader has lost its place, and the whole file is abandoned.
 */
export function readGoFile(source: string): GoFileFacts | undefined {
  const text = source.startsWith("﻿") ? source.slice(1) : source;
  // `//go:build ignore` is a whole-file constraint and is only meaningful
  // above the package clause, which is where both forms are required to be.
  const head = text.slice(0, Math.max(0, text.indexOf("package")));
  const buildIgnored =
    /^\/\/(?:go:build|[ \t]*\+build)\b[^\n]*\bignore\b/mu.test(head);

  let at = 0;
  const skipTrivia = (): boolean => {
    for (;;) {
      while (at < text.length && /\s/u.test(text[at] ?? "")) {
        at += 1;
      }
      if (text.startsWith("//", at)) {
        const end = text.indexOf("\n", at);
        at = end === -1 ? text.length : end;
        continue;
      }
      if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2);
        if (end === -1) {
          return false;
        }
        at = end + 2;
        continue;
      }
      return true;
    }
  };
  /** One import path, or undefined for "this is not a string here". */
  const readString = (): string | undefined => {
    if (text[at] === "`") {
      const end = text.indexOf("`", at + 1);
      if (end === -1) {
        return undefined;
      }
      const value = text.slice(at + 1, end);
      at = end + 1;
      return value;
    }
    if (text[at] !== '"') {
      return undefined;
    }
    let cursor = at + 1;
    let value = "";
    for (;;) {
      if (cursor >= text.length) {
        return undefined;
      }
      const character = text[cursor];
      if (character === "\n") {
        return undefined;
      }
      if (character === "\\") {
        // Go's escapes are not JSON's, and a hand-rolled decoder would be
        // subtly wrong in ways nobody would notice. An import path with an
        // escape in it is not a thing anybody writes; refuse the file.
        return undefined;
      }
      if (character === '"') {
        at = cursor + 1;
        return value;
      }
      value += character;
      cursor += 1;
    }
  };

  if (!skipTrivia() || !text.startsWith("package", at)) {
    return undefined;
  }
  at += "package".length;
  if (!skipTrivia()) {
    return undefined;
  }
  const name = /^[A-Za-z_]\w*/u.exec(text.slice(at))?.[0];
  if (name === undefined) {
    return undefined;
  }
  at += name.length;

  const imports: string[] = [];
  for (;;) {
    if (!skipTrivia()) {
      return undefined;
    }
    if (at >= text.length) {
      break;
    }
    if (!text.startsWith("import", at) || /\w/u.test(text[at + 6] ?? "")) {
      // The prologue ends here. Only a declaration may follow it, and
      // anything else means this reader mis-parsed something above.
      const next = /^[A-Za-z_]\w*/u.exec(text.slice(at))?.[0];
      return next !== undefined &&
        ["func", "type", "const", "var"].includes(next)
        ? { packageName: name, buildIgnored, imports }
        : undefined;
    }
    at += "import".length;
    if (!skipTrivia()) {
      return undefined;
    }
    const grouped = text[at] === "(";
    if (grouped) {
      at += 1;
    }
    for (;;) {
      if (!skipTrivia()) {
        return undefined;
      }
      if (grouped && text[at] === ")") {
        at += 1;
        break;
      }
      // An optional name: `_`, `.`, or an identifier alias.
      const alias = /^(?:_|\.|[A-Za-z_]\w*)/u.exec(text.slice(at))?.[0];
      if (alias !== undefined && text[at] !== '"' && text[at] !== "`") {
        at += alias.length;
        if (!skipTrivia()) {
          return undefined;
        }
      }
      const specifier = readString();
      if (specifier === undefined) {
        return undefined;
      }
      imports.push(specifier);
      if (!grouped) {
        break;
      }
    }
  }
  return { packageName: name, buildIgnored, imports };
}

/**
 * Where each module path lives in this repository, from its `go.mod` files.
 *
 * A module path claimed by two directories is dropped entirely rather than
 * picked between: a guess here mis-aims every edge underneath it.
 */
export function goModuleRoots(
  manifests: ReadonlyMap<string, string>,
): Map<string, string> {
  const roots = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [file, source] of manifests) {
    if (posixBasenameIs(file, "go.mod")) {
      const module = /^[ \t]*module[ \t]+(?:"([^"\n]+)"|(\S+))[ \t]*$/mu.exec(
        source,
      );
      const modulePath = module?.[1] ?? module?.[2];
      if (modulePath === undefined) {
        continue;
      }
      const dir = posixDirname(file);
      const already = roots.get(modulePath);
      if (already !== undefined && already !== dir) {
        ambiguous.add(modulePath);
        continue;
      }
      roots.set(modulePath, dir);
    }
  }
  for (const path of ambiguous) {
    roots.delete(path);
  }
  return roots;
}

function posixBasenameIs(file: string, name: string): boolean {
  return file === name || file.endsWith(`/${name}`);
}

export interface GoContext {
  files: ReadonlySet<string>;
  moduleRoots: ReadonlyMap<string, string>;
  facts: ReadonlyMap<string, GoFileFacts>;
}

/** Every file that is the package this specifier names. Often none. */
export function resolveGoImport(
  fromFile: string,
  specifier: string,
  context: GoContext,
): readonly string[] {
  // The go tool never builds these, and `testdata` is routinely invalid Go on
  // purpose — so they are neither end of an edge.
  if (goDirectoryIsIgnored(posixDirname(fromFile))) {
    return [];
  }
  if (
    specifier === "" ||
    specifier === "C" ||
    specifier === "." ||
    specifier === ".." ||
    /^\.{1,2}\//u.test(specifier) ||
    specifier.startsWith("/")
  ) {
    return [];
  }

  // Longest prefix wins, which makes a nested module correct for free: a
  // nested `go.mod` genuinely excludes its subtree from its parent.
  let matched: { path: string; dir: string } | undefined;
  for (const [modulePath, dir] of context.moduleRoots) {
    if (specifier !== modulePath && !specifier.startsWith(`${modulePath}/`)) {
      continue;
    }
    if (matched === undefined || modulePath.length > matched.path.length) {
      matched = { path: modulePath, dir };
    }
  }
  if (matched === undefined) {
    return [];
  }
  // A dotless module path can shadow the standard library. The module match
  // has to come first or `myapp/pkg/store` would be dropped as std-shaped.
  const firstOfModule = matched.path.split("/")[0] ?? "";
  const firstOfSpec = specifier.split("/")[0] ?? "";
  if (!firstOfModule.includes(".") && STD_ROOTS.has(firstOfSpec)) {
    return [];
  }

  const rest = specifier.slice(matched.path.length).replace(/^\//u, "");
  const dir = rest === "" ? matched.dir : posixJoin(matched.dir, rest);
  if (goDirectoryIsIgnored(dir)) {
    return [];
  }

  const members: string[] = [];
  const packages = new Set<string>();
  for (const file of context.files) {
    if (!file.endsWith(".go") || file.endsWith("_test.go")) {
      // A `_test.go` file is never visible to an importer, so an edge to one
      // is always false.
      continue;
    }
    if (posixDirname(file) !== dir) {
      continue;
    }
    const facts = context.facts.get(file);
    // A file nothing could read is left out rather than assumed in: leaving
    // it out costs an edge, assuming it in risks a false one.
    if (facts === undefined || facts.buildIgnored) {
      continue;
    }
    packages.add(facts.packageName);
    members.push(file);
  }
  // Two package clauses in one directory is not valid Go and there is no way
  // to tell which subset was meant. A command is not importable at all.
  if (packages.size !== 1 || packages.has("main")) {
    return [];
  }
  return members.sort();
}
