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
    `${base}/__init__.py`,
    `${base}/__init__.pyi`,
    `${base}.py`,
    `${base}.pyi`,
  ];
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
  stdlib: ReadonlySet<string>;
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
    if (base === "") {
      return undefined;
    }
    const hit = candidates(base).find((candidate) => files.has(candidate));
    // Never a self-edge: `from . import mod` inside `pkg/mod.py` resolves to
    // the file it was written in, which is not a dependency on anything.
    return hit === fromFile ? undefined : hit;
  }

  if (parts.length === 0) {
    return undefined;
  }
  // `import email` against a repository file called `email.py` is a plausible
  // accident. `from email.mime import text` matching `email/mime/text.py` is
  // somebody's actual package, so only the single-segment form is dropped.
  if (parts.length === 1 && stdlib.has(parts[0] ?? "")) {
    return undefined;
  }

  const roots = new Set<string>(["", ...ancestors(fromFile)]);
  if (files.has("src/__init__.py") || [...files].some((file) => file.startsWith("src/"))) {
    roots.add("src");
  }
  for (const file of files) {
    const name = path.posix.basename(file);
    if (!PROJECT_MARKERS.includes(name)) {
      continue;
    }
    const dir = path.posix.dirname(file);
    const root = dir === "." ? "" : dir;
    roots.add(root);
    roots.add(root === "" ? "src" : `${root}/src`);
  }

  const hits = new Set<string>();
  for (const root of roots) {
    if (root !== "" && vendored(root)) {
      continue;
    }
    // A root that is itself inside a package cannot supply top-level names:
    // its children are `pkg.child`, not `child`.
    if (
      root !== "" &&
      (files.has(`${root}/__init__.py`) || files.has(`${root}/__init__.pyi`))
    ) {
      continue;
    }
    const hit = candidates(join(root, parts)).find(
      (candidate) => files.has(candidate) && !vendored(candidate),
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
