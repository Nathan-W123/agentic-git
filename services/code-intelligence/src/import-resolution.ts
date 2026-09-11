/**
 * Turning an import into the file it names, once per repository.
 *
 * This used to be one function — a specifier, the importing file, the set of
 * repository paths, and a single path back. That signature is a TypeScript
 * shape and cannot state what the other languages mean:
 *
 *   - A **Go** import names a *directory*. `import "example.com/m/billing"`
 *     depends on every `.go` file in `billing/`, so the answer is a list and
 *     one specifier becomes several edges.
 *   - A **JVM** import names a *type*, not a path. `import com.acme.Money`
 *     can only be resolved against a map of fully-qualified name to declaring
 *     file, which does not exist until every file in the repository has been
 *     read.
 *   - **Python** needs the interpreter's own standard-library list, and
 *     **Ruby** and **PHP** need roots and class tables derived from the whole
 *     file set.
 *
 * All of those are facts about the repository rather than about the file, and
 * they can only be gathered once every file has been scanned. So resolution
 * moved here: the indexer builds one {@link ResolutionContext} after the scan
 * and hands it to a per-language resolver.
 *
 * **A wrong edge is far worse than a missing one**, and every resolver here
 * is written around that. A missed edge costs a warning nobody sees. A false
 * edge makes two unrelated branches contend and blocks work that should have
 * run — invisibly, because nothing on any screen explains why a plan was
 * sequenced behind a file it has no relationship with. So where a language
 * leaves the answer genuinely ambiguous, every resolver here returns nothing
 * rather than its best guess.
 */

import type { SupportedLanguage } from "./index.js";
import { resolveGoImport, type GoFileFacts } from "./go-imports.js";
import {
  resolveJvmImport,
  type JvmContext,
  type JvmLanguage,
} from "./jvm-imports.js";
import { resolvePythonImport } from "./python-imports.js";
import { resolveRustModule, resolveRustUse } from "./rust-imports.js";
import {
  resolvePhpRequire,
  resolvePhpUse,
  resolveRubyRequire,
} from "./script-imports.js";

/**
 * Everything about the repository that resolving needs and one file cannot
 * supply.
 *
 * Assembled once per index build. Languages that need nothing beyond the path
 * set simply ignore the rest.
 */
export interface ResolutionContext {
  /** Every path at this revision, indexed or not — a `.sql` file is a valid
   *  target even though nothing parses it. */
  files: ReadonlySet<string>;
  /** The running interpreter's `sys.stdlib_module_names`. */
  pythonStdlib: ReadonlySet<string>;
  /** Module path to the directory its `go.mod` sits in. */
  goModuleRoots: ReadonlyMap<string, string>;
  /** What each `.go` file says about itself: its package, and its imports. */
  goFacts: ReadonlyMap<string, GoFileFacts>;
  /** Ruby's load-path roots, derived from layout alone. */
  rubyRoots: readonly string[];
  /** Lowercased PHP class name to its declaring file. */
  phpTypes: ReadonlyMap<string, string>;
  /** Qualified name to declaring file, for the languages that import types. */
  jvm: JvmContext;
}

/** A resolver answers with every file the specifier names. Empty is normal. */
export type ImportResolver = (
  fromFile: string,
  specifier: string,
  context: ResolutionContext,
) => readonly string[];

/**
 * Relative specifiers only, which is the whole of what a bundler-free
 * TypeScript project can be resolved without reading its `tsconfig`.
 *
 * A bare specifier is a package. Dropping it is the same answer this has
 * always given and the same one every other resolver here gives for the
 * standard library.
 */
const resolveScriptImport: ImportResolver = (fromFile, specifier, context) => {
  if (!specifier.startsWith(".")) {
    return [];
  }
  const base = posixJoin(posixDirname(fromFile), specifier);
  const withoutExtension = /\.(?:c|m)?jsx?$/u.test(base)
    ? base.replace(/\.(?:c|m)?jsx?$/u, "")
    : base;
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map(
      (extension) => `${withoutExtension}${extension}`,
    ),
    ...[".ts", ".tsx", ".js", ".jsx", ".json"].map(
      (extension) => `${base}/index${extension}`,
    ),
  ];
  const hit = candidates.find((candidate) => context.files.has(candidate));
  return hit === undefined || hit === fromFile ? [] : [hit];
};

const RESOLVERS: Partial<Record<SupportedLanguage, ImportResolver>> = {
  typescript: resolveScriptImport,
  javascript: resolveScriptImport,
  // A Go import names a directory, so one specifier becomes several edges —
  // the reason a resolver answers with a list at all.
  go: (fromFile, specifier, context) =>
    resolveGoImport(fromFile, specifier, {
      files: context.files,
      moduleRoots: context.goModuleRoots,
      facts: context.goFacts,
    }),
  java: (fromFile, specifier, context) =>
    resolveJvmImport(fromFile, specifier, "java" as JvmLanguage, context.jvm),
  kotlin: (fromFile, specifier, context) =>
    resolveJvmImport(fromFile, specifier, "kotlin" as JvmLanguage, context.jvm),
  scala: (fromFile, specifier, context) =>
    resolveJvmImport(fromFile, specifier, "scala" as JvmLanguage, context.jvm),
  // `mod name;` is a file reference and is marked as one on the way in, so
  // the two kinds of Rust dependency do not have to be told apart by shape.
  rust: (fromFile, specifier, context) =>
    specifier.startsWith("mod:")
      ? resolveRustModule(fromFile, specifier.slice(4), context)
      : resolveRustUse(fromFile, specifier, context),
  // `require` and `require_relative` measure from different bases, so which
  // one it was is marked on the way in rather than guessed at here.
  ruby: (fromFile, specifier, context) =>
    resolveRubyRequire(
      fromFile,
      { relative: specifier.startsWith("rel:"), specifier: specifier.slice(4) },
      { files: context.files, roots: context.rubyRoots },
    ),
  // A `use` names a class and a `require` names a file; nothing but the
  // keyword tells them apart.
  php: (fromFile, specifier, context) =>
    specifier.startsWith("use:")
      ? resolvePhpUse(fromFile, specifier.slice(4), {
          files: context.files,
          types: context.phpTypes,
        })
      : resolvePhpRequire(fromFile, specifier.slice(4), {
          files: context.files,
          types: context.phpTypes,
        }),
  python: (fromFile, specifier, context) => {
    const hit = resolvePythonImport(fromFile, specifier, {
      files: context.files,
      stdlib: context.pythonStdlib,
    });
    return hit === undefined ? [] : [hit];
  },
};

/**
 * Every file this import names, in this repository.
 *
 * An empty array is the ordinary answer and means "nothing here" — the
 * standard library, an installed package, a language with no resolver yet. It
 * is never a claim that the importing file depends on nothing.
 */
export function resolveImportedFiles(
  language: SupportedLanguage | undefined,
  fromFile: string,
  specifier: string,
  context: ResolutionContext,
): readonly string[] {
  const resolver = language === undefined ? undefined : RESOLVERS[language];
  return resolver === undefined
    ? []
    : resolver(fromFile, specifier, context).filter(
        (target) => target !== fromFile,
      );
}

/* ------------------------------------------------------- path helpers ---- */
//
// Written out rather than taken from `node:path`, because every path here is
// a repository-relative POSIX path whatever platform the control plane runs
// on, and `path.win32` semantics leaking in would resolve `a/b` against `a\b`.

export function posixDirname(file: string): string {
  const cut = file.lastIndexOf("/");
  return cut <= 0 ? "" : file.slice(0, cut);
}

export function posixBasename(file: string): string {
  const cut = file.lastIndexOf("/");
  return cut === -1 ? file : file.slice(cut + 1);
}

/** Joins and normalises `.`/`..`, refusing to climb out of the repository. */
export function posixJoin(base: string, ...parts: string[]): string {
  const segments: string[] = [];
  for (const piece of [base, ...parts].join("/").split("/")) {
    if (piece === "" || piece === ".") {
      continue;
    }
    if (piece === "..") {
      if (segments.length === 0) {
        // Out of the tree. Every caller treats "" as "no answer", which is
        // the right one: a path above the repository root is not a file this
        // index can name.
        return "";
      }
      segments.pop();
      continue;
    }
    segments.push(piece);
  }
  return segments.join("/");
}
