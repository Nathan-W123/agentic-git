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

import { posixBasename, posixDirname, posixJoin } from "./import-resolution.js";

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

/** The same rule for a file: `_gen.go` and `.hidden.go` are never built. */
function goFileIsIgnored(file: string): boolean {
  return /^[._]/u.test(posixBasename(file));
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
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;

  let at = 0;
  // Every line comment the walker steps over before the package clause, with
  // where it ended. Build constraints are read from these and nowhere else:
  // the first version sliced the text at the first occurrence of the word
  // "package", so a licence header saying "distributed with the other
  // packages" ended the region before `//go:build ignore` was reached, and a
  // constraint inside a block comment counted as one.
  const lineComments: Array<{ body: string; end: number }> = [];
  let packageAt: number | undefined;
  const skipTrivia = (): boolean => {
    for (;;) {
      while (at < text.length && /\s/u.test(text[at] ?? "")) {
        at += 1;
      }
      if (text.startsWith("//", at)) {
        const end = text.indexOf("\n", at);
        const stop = end === -1 ? text.length : end;
        if (packageAt === undefined) {
          lineComments.push({ body: text.slice(at, stop), end: stop });
        }
        at = stop;
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
  packageAt = at;
  const buildIgnored = constrainedToIgnore(text, lineComments, packageAt);
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
 * Whether the constraint comments above the package clause exclude the file
 * from every build.
 *
 * `//go:build` is authoritative when present, and only the expression that is
 * exactly `ignore` is honoured: `!ignore` builds everywhere, and anything with
 * an operator in it depends on tags this cannot see. The older `// +build`
 * form is a list of OR-ed terms, each a comma list of AND-ed tags, and it
 * only counts as a constraint when a blank line separates it from the
 * package clause — without one the go tool reads it as a doc comment.
 */
function constrainedToIgnore(
  text: string,
  comments: readonly { body: string; end: number }[],
  packageAt: number,
): boolean {
  const goBuild = comments.filter((comment) =>
    /^\/\/go:build\b/u.test(comment.body),
  );
  if (goBuild.length > 0) {
    return goBuild.some(
      (comment) => comment.body.slice("//go:build".length).trim() === "ignore",
    );
  }
  return comments.some((comment) => {
    const match = /^\/\/[ \t]*\+build\b(.*)$/u.exec(comment.body);
    if (match === null) {
      return false;
    }
    if (!/\n[ \t]*\n/u.test(text.slice(comment.end, packageAt))) {
      return false;
    }
    return (match[1] ?? "")
      .trim()
      .split(/\s+/u)
      .some((term) => term.split(",").includes("ignore"));
  });
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
      const dir = posixDirname(file);
      // A fixture under testdata/ is a go.mod the tool never reads, and one
      // that repeats the root's path would otherwise mark the root ambiguous
      // and delete it.
      if (goDirectoryIsIgnored(dir)) {
        continue;
      }
      const modulePath = modulePathOf(source);
      if (modulePath === undefined) {
        continue;
      }
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

/**
 * The `module` directive's path, as `go mod` reads it.
 *
 * Comments are stripped first because a trailing `// the module` is legal and
 * common; the block form `module (\n\tpath\n)` is legal and rare; and a BOM
 * is neither but appears anyway.
 */
function modulePathOf(source: string): string | undefined {
  const lines = source
    .replace(/^\uFEFF/u, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/u, "").trim());
  for (const [position, line] of lines.entries()) {
    const match = /^module(?:\s+(.*))?$/u.exec(line);
    if (match === null) {
      continue;
    }
    let rest = (match[1] ?? "").trim();
    if (rest === "(") {
      rest = lines.slice(position + 1).find((next) => next !== "") ?? "";
    }
    const unquoted = /^(?:"([^"]+)"|`([^`]+)`|(\S+))$/u.exec(rest);
    const modulePath = unquoted?.[1] ?? unquoted?.[2] ?? unquoted?.[3];
    if (modulePath === undefined || modulePath === "(" || modulePath === ")") {
      return undefined;
    }
    return modulePath;
  }
  return undefined;
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
  if (
    goDirectoryIsIgnored(posixDirname(fromFile)) ||
    goFileIsIgnored(fromFile)
  ) {
    return [];
  }
  // `C` is cgo, and an element that is empty, `.` or `..` is a path the go
  // tool refuses outright — normalising it would aim the edge at whatever
  // directory the `..` happened to walk into.
  if (
    specifier === "C" ||
    specifier.startsWith("/") ||
    specifier.split("/").some((element) => ["", ".", ".."].includes(element))
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
  // A nested go.mod excludes its subtree from the parent module whatever
  // path it declares. Longest-prefix matching on the *specifier* only sees a
  // nested module whose path extends the parent's; one called something
  // else entirely still owns its directory, and `example.com/m/sub/lib`
  // does not compile when `sub/` is `example.com/other`.
  for (const otherDir of context.moduleRoots.values()) {
    if (
      otherDir !== matched.dir &&
      otherDir.length > matched.dir.length &&
      (dir === otherDir || dir.startsWith(`${otherDir}/`))
    ) {
      return [];
    }
  }

  const members: string[] = [];
  const packages = new Set<string>();
  for (const file of context.files) {
    if (
      !file.endsWith(".go") ||
      file.endsWith("_test.go") ||
      goFileIsIgnored(file)
    ) {
      // A `_test.go` file is never visible to an importer, so an edge to one
      // is always false; a `_template.go` or `.hidden.go` is never built.
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
