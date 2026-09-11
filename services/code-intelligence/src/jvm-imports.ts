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
  const text = source.startsWith("﻿") ? source.slice(1) : source;
  let at = 0;
  let depth = 0;
  const packages: string[] = [];
  const imports: string[] = [];

  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    // A block comment spanning lines is tracked crudely and conservatively:
    // anything that opens one and does not close it on the same line puts the
    // reader inside a comment, and a `"""` anywhere in the header is a shape
    // this does not model at all.
    if (line.includes('"""')) {
      return undefined;
    }
    if (depth > 0) {
      const closes = (line.match(/\*\//gu) ?? []).length;
      const opens = (line.match(/\/\*/gu) ?? []).length;
      depth += opens - closes;
      if (depth < 0) {
        return undefined;
      }
      continue;
    }
    if (line.startsWith("//")) {
      continue;
    }
    if (line.startsWith("/*")) {
      const opens = (line.match(/\/\*/gu) ?? []).length;
      const closes = (line.match(/\*\//gu) ?? []).length;
      depth = opens - closes;
      if (depth < 0) {
        return undefined;
      }
      continue;
    }
    // An annotation or a Kotlin file-level target sits in the header and says
    // nothing this needs.
    if (line.startsWith("@")) {
      continue;
    }

    const pkg = /^package\s+([\w.`\s]+?)\s*;?\s*$/u.exec(line);
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
    const imported = /^import\s+(?:static\s+)?(.+?)\s*;?\s*$/u.exec(line);
    if (imported !== null) {
      const specifier = (imported[1] ?? "").trim();
      // Several directives on one line is legal, and a pattern that reaches
      // to end-of-line swallows them all into one specifier that names
      // nothing. A surviving separator means this line holds more than the
      // one clause this understood.
      if (specifier === "" || /;|\bimport\b/u.test(specifier)) {
        return undefined;
      }
      imports.push(specifier);
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
  /** Every repository path by basename, for the Java filename convention. */
  basenames: ReadonlyMap<string, readonly string[]>;
  units: ReadonlyMap<string, JvmUnit>;
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
 * confident wrong answer.
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
  const cleaned = normalizeName(specifier);
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
  const limit = language === "scala" ? 1 : 2;
  return lookUp(
    fromFile,
    bases.flatMap((base) => candidates(base, limit)),
    language,
    context,
  );
}

function lookUp(
  fromFile: string,
  names: readonly string[],
  language: JvmLanguage,
  context: JvmContext,
): readonly string[] {
  const hits = new Set<string>();
  for (const name of names) {
    for (const file of context.declarations.get(name) ?? []) {
      hits.add(file);
    }
  }
  if (hits.size === 0 && language === "java") {
    // Java alone requires a public type to live in a file of its own name,
    // so a repository whose package layout this could not read still has one
    // reliable clue. Only when the basename is unique: two `Money.java` under
    // different packages is exactly the case where guessing is wrong.
    for (const name of names) {
      const tail = name.split(".").at(-1);
      const paths = context.basenames.get(`${tail ?? ""}.java`) ?? [];
      if (paths.length === 1 && paths[0] !== undefined) {
        hits.add(paths[0]);
      }
    }
  }
  hits.delete(fromFile);
  // Uniqueness is the backstop, as everywhere here. Two files declaring one
  // qualified name means the repository holds the same type twice — a
  // build-variant source set, a vendored copy — and there is no way to say
  // which one the importer compiles against.
  return hits.size === 1 ? [...hits] : [];
}

/** The declarations not contained inside another one. */
export function topLevelNames(
  ranges: readonly { name: string; startLine: number; endLine: number }[],
): string[] {
  return ranges
    .filter(
      (range, position) =>
        !ranges.some(
          (other, otherPosition) =>
            otherPosition !== position &&
            other.startLine <= range.startLine &&
            other.endLine >= range.endLine &&
            // A tie on both ends would otherwise make two identical ranges
            // each swallow the other and leave neither top level.
            (other.startLine < range.startLine || other.endLine > range.endLine),
        ),
    )
    .map((range) => range.name);
}

export { posixBasename };
