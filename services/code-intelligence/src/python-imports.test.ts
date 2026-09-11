/**
 * Python's dependency graph, and above all the edges it must refuse to draw.
 *
 * Every non-TypeScript file was indexed with `imports: []`, so "who am I
 * about to break" had no answer and the cross-branch contract guard was
 * structurally inert for a Python repository — silently, with a flag set in
 * the index that nothing above it read.
 *
 * The asymmetry that shapes all of this: a missed edge costs a warning, and a
 * false edge makes two unrelated branches contend and blocks work that should
 * have run. So the interesting tests here are the ones that assert *nothing*
 * is resolved.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolvePythonImport } from "./python-imports.js";

const STDLIB = new Set(["os", "sys", "json", "email", "typing"]);

function repo(...files: string[]) {
  return { files: new Set(files), stdlib: STDLIB };
}

/* ------------------------------------------------------------- relative -- */

test("a relative import lands in the importing file's own package", () => {
  const context = repo("pkg/__init__.py", "pkg/mod.py", "pkg/models.py");
  assert.equal(
    resolvePythonImport("pkg/mod.py", ".models", context),
    "pkg/models.py",
  );
});

test("each extra dot is one package further up", () => {
  const context = repo(
    "pkg/__init__.py",
    "pkg/sub/__init__.py",
    "pkg/sub/mod.py",
    "pkg/shared.py",
  );
  assert.equal(
    resolvePythonImport("pkg/sub/mod.py", "..shared", context),
    "pkg/shared.py",
  );
});

test("a package shadows a module of the same name, as Python loads it", () => {
  // `a/b/__init__.py` is what `import a.b` executes; pointing the edge at
  // `a/b.py` would attribute it to a file Python never loads.
  const context = repo("pkg/__init__.py", "pkg/mod.py", "pkg/thing.py", "pkg/thing/__init__.py");
  assert.equal(
    resolvePythonImport("pkg/mod.py", ".thing", context),
    "pkg/thing/__init__.py",
  );
});

test("a relative import that walks out of the repository resolves to nothing", () => {
  const context = repo("pkg/__init__.py", "pkg/mod.py");
  assert.equal(resolvePythonImport("pkg/mod.py", "...way.up", context), undefined);
});

test("a file does not depend on itself", () => {
  const context = repo("pkg/__init__.py", "pkg/mod.py");
  assert.equal(resolvePythonImport("pkg/mod.py", ".mod", context), undefined);
});

/* ------------------------------------------------------------- absolute -- */

test("an absolute import finds a package under a root above the importer", () => {
  const context = repo("app/__init__.py", "app/main.py", "app/util.py");
  assert.equal(
    resolvePythonImport("app/main.py", "app.util", context),
    "app/util.py",
  );
});

test("a src layout is searched, because it is where packages are put", () => {
  const context = repo("src/app/__init__.py", "src/app/main.py", "src/app/db.py", "pyproject.toml");
  assert.equal(
    resolvePythonImport("src/app/main.py", "app.db", context),
    "src/app/db.py",
  );
});

/* ---------------------------------------------------------- refusals ----- */

test("the standard library is never matched against a file of the same name", () => {
  // `import email` in a repository that happens to contain `email.py` is a
  // coincidence, and an edge drawn on it points a warning at a file nobody
  // touched.
  const context = repo("email.py", "app/main.py");
  assert.equal(resolvePythonImport("app/main.py", "email", context), undefined);
  // But a dotted name is somebody's actual package, not a coincidence.
  const nested = repo("email/__init__.py", "email/mime/__init__.py", "email/mime/text.py", "app/main.py");
  assert.equal(
    resolvePythonImport("app/main.py", "email.mime.text", nested),
    "email/mime/text.py",
  );
});

test("two roots that both answer means there is no answer", () => {
  // The backstop, and the reason the root set can be generous. In a monorepo
  // holding both of these there is no honest answer to `import utils`, and
  // guessing one makes a branch contend with a file nobody edited.
  const context = repo(
    "services/billing/main.py",
    "services/billing/utils.py",
    "libs/common/utils.py",
    "libs/pyproject.toml",
    "services/pyproject.toml",
  );
  assert.equal(
    resolvePythonImport("services/billing/main.py", "utils", context),
    "services/billing/utils.py",
  );
  // And when two project roots each hold a `utils.py`, there is no answer.
  // Proximity is not the rule Python uses — `sys.path` order is, and that is
  // a runtime value nothing here can read — so preferring the nearer one
  // would be a guess dressed as a fact.
  const ambiguous = repo(
    "a/main.py",
    "a/pyproject.toml",
    "b/pyproject.toml",
    "a/utils.py",
    "b/utils.py",
  );
  assert.equal(resolvePythonImport("a/main.py", "utils", ambiguous), undefined);
});

test("a vendored copy does not become an edge to the real package", () => {
  // The measured failure. A vendored package imports itself by its own
  // top-level name, and without this every vendored file grows an edge to
  // the real one beside it.
  const context = repo(
    "poetry/core/_vendor/lark/parser.py",
    "poetry/core/_vendor/lark/__init__.py",
    "lark/__init__.py",
  );
  assert.equal(
    resolvePythonImport("poetry/core/_vendor/lark/parser.py", "lark", context),
    undefined,
  );
});

test("a package's own directory is not a root for top-level names", () => {
  // `pkg/thing.py` is `pkg.thing`, never `thing`. Treating `pkg/` as a root
  // would resolve an unrelated `import thing` onto it.
  const context = repo("pkg/__init__.py", "pkg/main.py", "pkg/thing.py");
  assert.equal(resolvePythonImport("pkg/main.py", "thing", context), undefined);
});

test("an installed package resolves to nothing, and that is the ordinary case", () => {
  const context = repo("app/main.py");
  for (const specifier of ["requests", "django.db.models", "numpy"]) {
    assert.equal(resolvePythonImport("app/main.py", specifier, context), undefined);
  }
});

test("an empty or malformed specifier resolves to nothing rather than to the root", () => {
  const context = repo("app/__init__.py", "app/main.py");
  for (const specifier of ["", ".", "..", "...."]) {
    const answer = resolvePythonImport("app/main.py", specifier, context);
    assert.notEqual(answer, "", `${specifier} should not resolve to the root`);
  }
  assert.equal(resolvePythonImport("app/main.py", "", context), undefined);
});
