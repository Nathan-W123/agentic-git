/**
 * A Python import, turned into a file in this repository — or dropped.
 *
 * The dependency graph is what answers "who am I about to break", and until
 * now it answered nothing outside TypeScript: every non-TS file was indexed
 * with `imports: []`, so the whole contract layer above it — who consumes a
 * changed symbol, whether a branch's work crosses into another's — was
 * structurally inert for a Python repository. Nothing said so.
 *
 * **A wrong edge is far worse than a missing one.** A missed edge costs a
 * warning nobody sees. A false edge makes two unrelated branches contend and
 * blocks work that should have run, invisibly. Every rule below is shaped by
 * that asymmetry: where Python leaves the answer genuinely ambiguous, this
 * drops the specifier rather than picking.
 *
 * It is ambiguous more often than it looks. `sys.path` is a runtime value —
 * PYTHONPATH, a `.pth` file, an editable install, a pytest rootdir, a bare
 * `sys.path.insert` — and none of it is readable from a set of file paths. So
 * the roots this will search are only ever an ancestor of the importing file
 * or a directory that declares itself a project, and where two roots both
 * produce a hit, neither is used.
 */
import path from "node:path";

/** Where a module can live, in the order CPython itself would find it. */
function candidates(base: string): string[] {
  return [
    // The package first: `a/b/__init__.py` shadows `a/b.py`, and probing the
    // module first would attribute an edge to the file Python would not load.
    // A module beats a stub-only directory, though: `x/__init__.pyi` with no
    // `__init__.py` beside it is a namespace package as far as the
    // interpreter is concerned, and `x.py` wins over a namespace package.
    `${base}/__init__.py`,
    `${base}.py`,
    `${base}/__init__.pyi`,
    `${base}.pyi`,
  ];
}

/**
 * Whether a dotted path is cut off by a plain module on the way down.
 *
 * `import foo.bar` with `foo.py` and `foo/bar.py` but no `foo/__init__.py`
 * loads `foo.py` — a regular module beats a namespace package — and then
 * fails, because a module has no submodules. Pointing the edge at
 * `foo/bar.py` would name a file Python never opens.
 */
function shadowedByModule(
  root: string,
  parts: readonly string[],
  files: ReadonlySet<string>,
): boolean {
  for (let depth = 1; depth < parts.length; depth += 1) {
    const prefix = join(root, parts.slice(0, depth));
    if (
      files.has(`${prefix}.py`) &&
      !files.has(`${prefix}/__init__.py`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a directory sits inside a package, at any depth.
 *
 * A root inside a package cannot supply top-level names: its children are
 * `pkg.child`, not `child`. The first version only asked whether the root
 * itself held an `__init__.py`, so `app/utils/` — a namespace directory
 * inside `app/` — was read as a script directory, and `import user` from
 * inside it resolved to `app/utils/user.py`, which is `app.utils.user` and
 * not importable by that name at all.
 */
function insidePackage(dir: string, files: ReadonlySet<string>): boolean {
  let current = dir;
  while (current !== "") {
    if (
      files.has(`${current}/__init__.py`) ||
      files.has(`${current}/__init__.pyi`)
    ) {
      return true;
    }
    const parent = path.posix.dirname(current);
    current = parent === "." ? "" : parent;
  }
  return false;
}

/**
 * What the repository's layout says about where roots are, read once.
 *
 * Read once because the resolver used to walk every path in the repository
 * for every specifier in every file — a project-marker search inside the
 * hot loop — and fifty thousand files times ten imports each is a build that
 * never finishes.
 */
export interface PythonLayout {
  /** Directories holding a `pyproject.toml`, `setup.py` or `setup.cfg`. */
  markerDirs: readonly string[];
  hasSrc: boolean;
}

/**
 * Directories whose project markers describe a fixture, not the project.
 *
 * A `setup.py` under `tests/fixtures/sample/` is something a test installs
 * into a temporary environment; read as a root it would make that fixture's
 * `settings.py` the answer to `import settings` from anywhere in the
 * repository.
 */
const FIXTURE_DIRS = new Set([
  "test",
  "tests",
  "testing",
  "testdata",
  "fixture",
  "fixtures",
  "__fixtures__",
]);

const LAYOUTS = new WeakMap<ReadonlySet<string>, PythonLayout>();

export function pythonLayout(files: ReadonlySet<string>): PythonLayout {
  const known = LAYOUTS.get(files);
  if (known !== undefined) {
    return known;
  }
  const markerDirs = new Set<string>();
  let hasSrc = false;
  for (const file of files) {
    if (file.startsWith("src/")) {
      hasSrc = true;
    }
    if (PROJECT_MARKERS.includes(path.posix.basename(file))) {
      const dir = path.posix.dirname(file);
      if (dir.split("/").some((segment) => FIXTURE_DIRS.has(segment))) {
        continue;
      }
      markerDirs.add(dir === "." ? "" : dir);
    }
  }
  const layout = { markerDirs: [...markerDirs].sort(), hasSrc };
  LAYOUTS.set(files, layout);
  return layout;
}

/**
 * Directories whose contents are somebody else's code.
 *
 * A vendored copy of a package imports itself by its own top-level name, so
 * without this a repository that vendors anything grows an edge from every
 * vendored file to the real package beside it. `build` is deliberately absent
 * — it is a real package name on PyPI, and excluding it drops correct edges.
 */
const VENDOR = new Set([
  "node_modules",
  "site-packages",
  ".venv",
  "venv",
  "vendor",
  "third_party",
  ".tox",
  "dist",
  ".eggs",
  "__pycache__",
  ".git",
]);

const PROJECT_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg"];

function vendored(candidate: string): boolean {
  return candidate.split("/").some((segment) => VENDOR.has(segment));
}

/** Every directory at or above `file`, nearest first, including "". */
function ancestors(file: string): string[] {
  const out: string[] = [];
  let dir = path.posix.dirname(file);
  while (dir !== "." && dir !== "/" && dir !== "") {
    out.push(dir);
    dir = path.posix.dirname(dir);
  }
  out.push("");
  return out;
}

function join(root: string, parts: readonly string[]): string {
  return root === "" ? parts.join("/") : `${root}/${parts.join("/")}`;
}

export interface PythonResolution {
  files: ReadonlySet<string>;
  /**
   * The interpreter's own standard-library names, or `undefined` when no
   * interpreter answered. Unknown is not empty: with no list to check
   * against, every absolute import is dropped rather than matched against a
   * repository file that happens to be called `json.py`.
   */
  stdlib: ReadonlySet<string> | undefined;
  /** Computed from `files` when absent; pass it in when resolving many. */
  layout?: PythonLayout;
}

/**
 * The importing file's own package chain, for a relative import.
 *
 * `from . import x` inside `pkg/sub/mod.py` means `pkg/sub`, and each extra
 * dot is one package further up. Landing outside the repository, or on a root
 * that is not a package at all, means the import either escapes this tree or
 * is broken — either way there is nothing here to point at.
 */
function relativeBase(fromFile: string, dots: number, files: ReadonlySet<string>): string | undefined {
  let dir = path.posix.dirname(fromFile);
  if (dir === ".") {
    dir = "";
  }
  for (let step = 1; step < dots; step += 1) {
    if (dir === "") {
      return undefined;
    }
    dir = path.posix.dirname(dir);
    if (dir === ".") {
      dir = "";
    }
  }
  if (dir === "" && !files.has("__init__.py") && !files.has("__init__.pyi")) {
    return undefined;
  }
  return dir;
}

/**
 * One specifier, or nothing.
 *
 * Nothing is the ordinary answer and carries no suspicion: the standard
 * library and every installed package resolve to nothing here, exactly as an
 * npm specifier does on the TypeScript side.
 */
export function resolvePythonImport(
  fromFile: string,
  specifier: string,
  context: PythonResolution,
): string | undefined {
  const { files, stdlib } = context;
  const dots = /^\.*/u.exec(specifier)?.[0].length ?? 0;
  const parts = specifier
    .slice(dots)
    .split(".")
    .filter((part) => part.length > 0);

  if (dots > 0) {
    const dir = relativeBase(fromFile, dots, files);
    if (dir === undefined) {
      return undefined;
    }
    const base = parts.length === 0 ? dir : join(dir, parts);
    if (base === "" || shadowedByModule(dir, parts, files)) {
      return undefined;
    }
    const hit = candidates(base).find((candidate) => files.has(candidate));
    // Never a self-edge: `from . import mod` inside `pkg/mod.py` resolves to
    // the file it was written in, which is not a dependency on anything.
    return hit === fromFile ? undefined : hit;
  }

  if (parts.length === 0 || stdlib === undefined) {
    return undefined;
  }
  // `import email` against a repository file called `email.py` is a plausible
  // accident. `from email.mime import text` matching `email/mime/text.py` is
  // somebody's actual package, so only the single-segment form is dropped.
  if (parts.length === 1 && stdlib.has(parts[0] ?? "")) {
    return undefined;
  }

  const layout = context.layout ?? pythonLayout(files);
  const fromVendored = vendored(fromFile);
  const roots = new Set<string>();
  if (fromVendored) {
    // A vendored file imports its own package by its top-level name, and the
    // copy it means is the one it sits inside. Its roots are the vendored
    // directories above it and nothing else — not the repository root, or
    // `vendor/lark/parser.py` resolves `import lark` to the real `lark/`
    // beside `vendor/`, which is precisely the edge the VENDOR list exists
    // to prevent.
    for (const dir of ancestors(fromFile)) {
      if (dir !== "" && vendored(dir)) {
        roots.add(dir);
      }
    }
  } else {
    roots.add("");
    for (const dir of ancestors(fromFile)) {
      roots.add(dir);
    }
    if (layout.hasSrc) {
      roots.add("src");
    }
    // A project marker makes its directory a root for every importer, not
    // only the files under it: in a monorepo `libs/` is installed into the
    // same environment `services/` runs in, and the cross-project edge is
    // the one worth having. The ambiguity backstop below is what keeps that
    // generosity safe.
    for (const dir of layout.markerDirs) {
      roots.add(dir);
      roots.add(dir === "" ? "src" : `${dir}/src`);
    }
  }

  const hits = new Set<string>();
  for (const root of roots) {
    if (!fromVendored && root !== "" && vendored(root)) {
      continue;
    }
    if (root !== "" && insidePackage(root, files)) {
      continue;
    }
    if (shadowedByModule(root, parts, files)) {
      continue;
    }
    const hit = candidates(join(root, parts)).find(
      (candidate) => files.has(candidate) && (fromVendored || !vendored(candidate)),
    );
    if (hit !== undefined && hit !== fromFile) {
      hits.add(hit);
    }
  }
  // Uniqueness is the backstop, and the whole reason this is safe to ship.
  // In a repository with `services/billing/utils.py` and `libs/common/utils.py`
  // there is no honest answer to `import utils`, and guessing one would point
  // a warning at a file nobody touched.
  return hits.size === 1 ? [...hits][0] : undefined;
}
