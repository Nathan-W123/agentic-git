/**
 * Java, Kotlin and Scala, where an import names a *type* rather than a file.
 *
 * `import com.acme.billing.Money` says nothing about where `Money` lives. The
 * package is a namespace, not a directory — Java conventionally mirrors it in
 * the tree and Kotlin explicitly does not, and either way the source root
 * (`src/main/java`, `app/src/main/kotlin`, whatever Gradle was told) is build
 * configuration this never reads. So the only honest way to resolve one is to
 * read every file first, learn which type each one declares, and look the
 * name up.
 *
 * That is what the declaration index is, and it is why resolution had to
 * become a repository-wide pass rather than a function of one file.
 *
 * The bar is the same as everywhere else here: a missed edge costs a warning,
 * a false edge blocks work that should have run. Every rule below is a rule
 * about refusing.
 */

import { posixBasename } from "./import-resolution.js";

export type JvmLanguage = "java" | "kotlin" | "scala";

/** One compilation unit, as far as resolving other people's imports needs. */
export interface JvmUnit {
  packageName: string;
  /** Specifiers exactly as written, minus the `import` keyword. */
  imports: string[];
}

/**
 * Reads the header: the package clause and the imports, and nothing else.
 *
 * Only the header, for the reason the Go reader takes only the prologue —
 * it is small, it has a defined end, and it cannot contain a method body. The
 * end is the first line that is neither blank, a comment, an annotation, a
 * package clause nor an import.
 *
 * Abandons the whole file rather than return a partial answer: if a `package`
 * or `import` token survives after every clause this understood has been
 * removed, this reader has mis-parsed something and everything it would say
 * about the file is suspect.
 */
export function readJvmHeader(
  source: string,
  language: JvmLanguage,
): JvmUnit | undefined {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  let at = 0;
  let depth = 0;
  const packages: string[] = [];
  const imports: string[] = [];

  const lines = text.split("\n");
  for (const raw of lines) {
    // Comments are read left to right, in order: the first version stripped
    // `//.*$` first and then counted `/*` and `*/`, so the `*/` closing a
    // one-line `/** See https://acme.example/x */` was cut away with the
    // URL and the header never closed. A Javadoc with a link in it emptied
    // the file's import list.
    const read = codeOf(raw, depth, language !== "java");
    depth = read.depth;
    const line = read.code.trim();
    if (line === "") {
      continue;
    }
    // A `"""` anywhere in the header is a shape this does not model at all.
    if (line.includes('"""')) {
      return undefined;
    }
    // An annotation or a Kotlin file-level target sits in the header and says
    // nothing this needs — unless a clause is glued to it, which is a line
    // this cannot split.
    if (line.startsWith("@")) {
      if (/\b(?:package|import)\b/u.test(line)) {
        return undefined;
      }
      continue;
    }
    // Scala's `package object` opens a declaration, not a package clause.
    if (language === "scala" && /^package\s+object\b/u.test(line)) {
      break;
    }

    // Interior whitespace is collapsed first: the earlier pattern let two
    // whitespace quantifiers overlap, and a `package` followed by a run of
    // spaces and a stray brace took seconds per kilobyte to reject.
    const compact = line.replace(/\s+/gu, " ");
    const pkg = /^package ([\w`]+(?: ?\. ?[\w`]+)*) ?;?$/u.exec(compact);
    if (pkg !== null) {
      const name = normalizeName(pkg[1] ?? "");
      if (name === "") {
        return undefined;
      }
      // Scala's consecutive clauses join; Java and Kotlin have exactly one.
      if (language !== "scala" && packages.length > 0) {
        return undefined;
      }
      packages.push(name);
      continue;
    }
    const imported = /^import (static |module )?(.+?) ?;?$/u.exec(compact);
    if (imported !== null) {
      const clause = (imported[2] ?? "").trim();
      // Several directives on one line is legal, and a pattern that reaches
      // to end-of-line swallows them all into one specifier that names
      // nothing. A surviving separator means this line holds more than the
      // one clause this understood.
      if (clause === "" || /;|\bimport\b/u.test(clause)) {
        return undefined;
      }
      // `import module java.base` names a module, which is not a type and
      // not a file; the header is still readable.
      if (imported[1] === "module ") {
        continue;
      }
      // Scala lets one `import` carry several clauses: `import a.B, c.D`.
      const clauses = language === "scala" ? splitOutsideBraces(clause) : [clause];
      for (const written of clauses) {
        // `import a.B as C` names `a.B`; the alias is local to this file.
        // Kotlin's syntax, and Scala 3's.
        const specifier =
          language === "java"
            ? written
            : written.replace(/\s+as\s+(?:\w+|`[^`]+`)$/u, "");
        // A specifier that ends in a dot is the first line of a directive
        // that continues on the next, and a slash is not a name at all:
        // both mean this reader has lost its place. So does whitespace
        // anywhere but around a dot or inside a brace group: an alias this
        // did not strip would otherwise collapse into a name nobody
        // declares.
        if (
          specifier === "" ||
          /\.$/u.test(specifier) ||
          specifier.includes("/") ||
          !/^[\w.`{},=> *_]+$/u.test(specifier) ||
          /\s/u.test(specifier.replace(/\s*\.\s*/gu, ".").replace(/\{[^}]*\}/gu, ""))
        ) {
          return undefined;
        }
        imports.push(specifier);
      }
      continue;
    }
    // The header is over. Anything still carrying one of the two keywords
    // means a clause this did not understand — a multi-line directive, two
    // on one line, a `package` inside a string.
    if (/\b(?:package|import)\b/u.test(line)) {
      return undefined;
    }
    break;
  }
  if (depth !== 0) {
    return undefined;
  }
  return { packageName: packages.join("."), imports };
}

/**
 * The code on one header line, with comments removed and the block-comment
 * depth carried across lines.
 *
 * Left to right, one token at a time: inside a block comment a `//` is
 * text; outside one a `//` ends the line, a `/*` opens a block, and a
 * quoted string — an annotation's argument — is copied through so that a
 * `//` inside it opens nothing. Kotlin and Scala nest block comments and
 * Java does not, so `nests` says whether a `/*` inside one counts.
 */
function codeOf(raw: string, depth: number, nests: boolean): { code: string; depth: number } {
  let code = "";
  let at = 0;
  while (at < raw.length) {
    if (depth > 0) {
      const open = nests ? raw.indexOf("/*", at) : -1;
      const close = raw.indexOf("*/", at);
      if (open !== -1 && (close === -1 || open < close)) {
        depth += 1;
        at = open + 2;
      } else if (close !== -1) {
        depth -= 1;
        at = close + 2;
        code += " ";
      } else {
        break;
      }
      continue;
    }
    const next = /\/\/|\/\*|"/u.exec(raw.slice(at));
    if (next === null) {
      code += raw.slice(at);
      break;
    }
    const found = at + next.index;
    code += raw.slice(at, found);
    if (next[0] === "//") {
      break;
    }
    if (next[0] === "/*") {
      depth += 1;
      at = found + 2;
      continue;
    }
    // A string: copied whole, up to its closing quote or the line's end.
    const end = /^"(?:[^"\\]|\\.)*"/u.exec(raw.slice(found));
    const length = end === null ? raw.length - found : end[0].length;
    code += raw.slice(found, found + length);
    at = found + length;
  }
  return { code, depth };
}

/** Splits on commas outside `{...}`, trimmed, empties dropped. */
function splitOutsideBraces(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
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

/** Whitespace around dots is legal; backticks quote a segment. */
function normalizeName(raw: string): string {
  return raw
    .replace(/[ \t]+/gu, "")
    .replace(/`/gu, "")
    .replace(/^_root_\./u, "");
}

export interface JvmContext {
  /** Fully-qualified top-level name to the files declaring it. */
  declarations: ReadonlyMap<string, readonly string[]>;
  /**
   * The subset of {@link declarations} that are types. A truncated
   * specifier — `a.b.C.MEMBER` read as `a.b.C` — may only land on one of
   * these: walking `com.acme.ui.theme.Typography` back onto a Kotlin
   * top-level `fun theme()` in `com.acme.ui` was a confident wrong answer.
   * Absent means every declaration counts, for callers that never read
   * kinds.
   */
  types?: ReadonlyMap<string, readonly string[]>;
  /** Every repository path by basename, for the Java filename convention. */
  basenames: ReadonlyMap<string, readonly string[]>;
  units: ReadonlyMap<string, JvmUnit>;
  /**
   * Files whose header was read but whose declarations could not be — a
   * body the scanner lost its place in. They are in no table, so for Java
   * the filename convention is all that speaks for them.
   */
  unreadBodies?: ReadonlySet<string>;
}

/**
 * The map from a qualified name to the file that declares it.
 *
 * A file with no package clause contributes nothing. A default-package type
 * is unimportable from a named package anyway, and indexing bare names would
 * put `Service` and `Helpers` in here as top-level names, where they would
 * collide with half the repository.
 *
 * Top-level names only. A nested type indexed at the top level means an
 * import of a same-named external type resolves onto it, and nothing is lost
 * by leaving them out: a nested type is reached through its outer one, which
 * the truncation in {@link resolveJvmImport} already walks to.
 */
export function jvmDeclarations(
  units: ReadonlyMap<string, { packageName: string; topLevelNames: readonly string[] }>,
): Map<string, string[]> {
  const declarations = new Map<string, string[]>();
  for (const [file, unit] of units) {
    if (unit.packageName === "") {
      continue;
    }
    for (const name of unit.topLevelNames) {
      const fqn = `${unit.packageName}.${name}`;
      declarations.set(fqn, [...(declarations.get(fqn) ?? []), file]);
    }
  }
  return declarations;
}

/**
 * The names a specifier could be naming, longest first.
 *
 * `import a.b.C.D.MEMBER` might be a static member of a nested type, so the
 * lookup walks back up. Bounded at two steps, and never below two segments:
 * unbounded truncation eventually reaches `com.example`, and if anything in
 * the repository declares a top-level `example` in package `com`, that is a
 * confident wrong answer. Two steps in every language: Scala's
 * `Outer.Inner.member` is as common as Java's, and a truncation may only
 * land on a type, never on a package, whatever the language.
 */
function candidates(base: string, limit: number): string[] {
  const out: string[] = [];
  const parts = base.split(".");
  for (let dropped = 0; dropped <= limit; dropped += 1) {
    const kept = parts.slice(0, parts.length - dropped);
    if (kept.length < 2) {
      break;
    }
    out.push(kept.join("."));
  }
  return out;
}

/** Every file this import could be naming. Empty when it is not knowable. */
export function resolveJvmImport(
  fromFile: string,
  specifier: string,
  language: JvmLanguage,
  context: JvmContext,
): readonly string[] {
  // The header strips an alias; one that reaches here regardless still
  // names the type before it, and collapsed into the name it would have
  // walked back onto whatever `object b` the package held.
  const cleaned = normalizeName(
    language === "java" ? specifier : specifier.replace(/\s+as\s+(?:\w+|`[^`]+`)$/u, ""),
  );
  if (cleaned === "") {
    return [];
  }
  // A wildcard names a package, not a type, and a package is not a file.
  // Resolving it would mean picking one member of it at random.
  if (/[*_]$/u.test(cleaned) || cleaned.includes("{") || cleaned.includes("*")) {
    return language === "java" && cleaned.endsWith(".*")
      ? // `import static a.b.C.*` is the exception: it names the TYPE `C`,
        // which is a file. `import a.b.*` names a package and is not.
        lookUp(fromFile, candidates(cleaned.slice(0, -2), 0), language, context)
      : [];
  }
  const bases = [cleaned];
  if (language === "scala") {
    // A bare Scala specifier is scope-relative, so it may also be a name
    // inside the importing file's own package.
    const own = context.units.get(fromFile)?.packageName ?? "";
    if (own !== "") {
      bases.push(`${own}.${cleaned}`);
    }
  }
  return lookUp(
    fromFile,
    bases.flatMap((base) => candidates(base, 2)),
    language,
    context,
  );
}

/** Every proper prefix of a declared name is a package, and not a type. */
function packagesOf(declarations: ReadonlyMap<string, readonly string[]>): Set<string> {
  const packages = new Set<string>();
  for (const fqn of declarations.keys()) {
    const parts = fqn.split(".");
    for (let length = 1; length < parts.length; length += 1) {
      packages.add(parts.slice(0, length).join("."));
    }
  }
  return packages;
}

function lookUp(
  fromFile: string,
  names: readonly string[],
  language: JvmLanguage,
  context: JvmContext,
): readonly string[] {
  const hits = new Set<string>();
  const types = context.types ?? context.declarations;
  const packages = packagesOf(context.declarations);
  for (const [position, name] of names.entries()) {
    // The specifier as written may name anything; a truncation of it may
    // only name a type, and never a package.
    const table = position === 0 ? context.declarations : types;
    if (position > 0 && packages.has(name)) {
      continue;
    }
    for (const file of table.get(name) ?? []) {
      hits.add(file);
    }
  }
  const written = names[0];
  if (hits.size === 0 && language === "java" && written !== undefined) {
    // Java alone requires a public type to live in a file of its own name,
    // so a repository whose package layout this could not read still has one
    // reliable clue. Only for a file that is in no table: one whose header
    // could not be read, or whose header was read — so its package is known,
    // and must be the specifier's — over a body that could not be. Only
    // where the path ends in the package as directories, and only when that
    // leaves one file: `import java.util.List` must never land on the
    // repository's own `com/acme/ui/List.java`.
    const parts = written.split(".");
    const tail = parts.at(-1) ?? "";
    const suffix = `${parts.join("/")}.java`;
    const paths = (context.basenames.get(`${tail}.java`) ?? []).filter((path) => {
      const unit = context.units.get(path);
      const headerless = unit === undefined || unit.packageName === "";
      const bodyless =
        context.unreadBodies?.has(path) === true &&
        unit?.packageName === parts.slice(0, -1).join(".");
      return (headerless || bodyless) && (path === suffix || path.endsWith(`/${suffix}`));
    });
    if (paths.length === 1 && paths[0] !== undefined) {
      hits.add(paths[0]);
    }
  }
  hits.delete(fromFile);
  // Uniqueness is the backstop, as everywhere here. Two files declaring one
  // qualified name means the repository holds the same type twice — a
  // build-variant source set, a vendored copy — and there is no way to say
  // which one the importer compiles against.
  return hits.size === 1 ? [...hits] : [];
}

/** What the declaration index needs of one brace-language declaration. */
export interface TopLevelCandidate {
  name: string;
  declared: "function" | "type";
  /** Offset of the declaration's first keyword. */
  start: number;
  /** Offsets of the body's braces, when it has a body. */
  open?: number;
  close?: number;
}

/**
 * The declarations no other declaration's body encloses, by name: every
 * one, and the types alone.
 *
 * Read from the declarations rather than from the symbol ranges. The ranges
 * merge same-named declarations into one span, and a span is not a body:
 * two overloads of a Kotlin top-level `format` became one range from the
 * first to the last, the class declared between them lay inside it and was
 * not top level; two nested `Builder`s in one Java file merged into a span
 * that neither outer class held, and became a phantom top-level type that
 * made the real `Builder` in the package ambiguous. Only a body encloses,
 * and only a declaration knows where its body is.
 */
export function topLevelDeclarations(
  declarations: readonly TopLevelCandidate[],
): { names: string[]; types: string[] } {
  const outermost = declarations.filter(
    (declaration) =>
      !declarations.some(
        (other) =>
          other !== declaration &&
          other.open !== undefined &&
          other.close !== undefined &&
          other.open < declaration.start &&
          other.close > declaration.start,
      ),
  );
  const names = new Set<string>();
  const types = new Set<string>();
  for (const declaration of outermost) {
    names.add(declaration.name);
    if (declaration.declared === "type") {
      types.add(declaration.name);
    }
  }
  return { names: [...names], types: [...types] };
}

export { posixBasename };
