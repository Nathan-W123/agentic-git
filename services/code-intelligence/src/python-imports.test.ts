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

import { pythonLayout, resolvePythonImport } from "./python-imports.js";

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
  // the real one beside it. `_vendor` is the name pip, setuptools and
  // poetry-core use; until it was in the vendor list this layout passed
  // only because two roots answered and neither was used.
  const vendored = [
    "poetry/core/_vendor/lark/parser.py",
    "poetry/core/_vendor/lark/__init__.py",
    "lark/__init__.py",
  ];
  assert.equal(
    resolvePythonImport("poetry/core/_vendor/lark/parser.py", "lark", repo(...vendored)),
    "poetry/core/_vendor/lark/__init__.py",
  );
  // poetry-core really has `poetry/core/__init__.py`. With it, every
  // ancestor root is inside a package and the repository root was the sole
  // hit — the vendored copy pointed at the real package beside it, the very
  // edge the list exists to prevent. Nothing is the honest answer.
  assert.equal(
    resolvePythonImport(
      "poetry/core/_vendor/lark/parser.py",
      "lark",
      repo(...vendored, "poetry/core/__init__.py"),
    ),
    undefined,
  );
  // A frozen copy of a monorepo library inside a service's own package is
  // the same case, with the library's marker root as the wrong answer.
  const frozen = repo(
    "libs/pyproject.toml",
    "libs/common/__init__.py",
    "services/api/api/__init__.py",
    "services/api/api/_vendor/common/__init__.py",
    "services/api/api/_vendor/common/util.py",
  );
  assert.equal(
    resolvePythonImport("services/api/api/_vendor/common/util.py", "common", frozen),
    undefined,
  );
  // botocore's spelling.
  const botocore = repo(
    "botocore/vendored/requests/__init__.py",
    "botocore/vendored/requests/api.py",
    "requests/__init__.py",
  );
  assert.equal(
    resolvePythonImport("botocore/vendored/requests/api.py", "requests", botocore),
    "botocore/vendored/requests/__init__.py",
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

/* ------------------------------------------------------------- second pass -- */

test("a vendored file's own package is the copy it sits inside", () => {
  // Vendored roots were skipped and the repository root was not, which
  // resolved `import lark` from inside `vendor/lark/` to the real `lark/`
  // beside it — the very edge the vendor list exists to prevent.
  const context = repo(
    "vendor/lark/__init__.py",
    "vendor/lark/tree.py",
    "vendor/lark/parser.py",
    "lark/__init__.py",
    "lark/tree.py",
  );
  assert.equal(
    resolvePythonImport("vendor/lark/parser.py", "lark", context),
    "vendor/lark/__init__.py",
  );
  assert.equal(
    resolvePythonImport("vendor/lark/parser.py", "lark.tree", context),
    "vendor/lark/tree.py",
  );
  // And the real package still never reaches into the vendored copy.
  assert.equal(resolvePythonImport("lark/tree.py", "lark", context), "lark/__init__.py");
});

test("a namespace directory inside a package is not a script root", () => {
  // `app/utils/user.py` is `app.utils.user`; nothing can `import user` and
  // land on it. Asking only whether `app/utils/` itself held an `__init__`
  // missed that the package is one level up.
  const context = repo("app/__init__.py", "app/utils/helpers.py", "app/utils/user.py");
  assert.equal(resolvePythonImport("app/utils/helpers.py", "user", context), undefined);
});

test("a module beats a stub-only directory, and a module cuts off a dotted path", () => {
  // `x.py` beside `x/__init__.pyi`: the stub directory is a namespace package
  // to the interpreter, and a regular module wins over one.
  assert.equal(
    resolvePythonImport("main.py", "x", repo("main.py", "x.py", "x/__init__.pyi")),
    "x.py",
  );
  // `foo.py` beside `foo/bar.py` with no `foo/__init__.py`: Python loads
  // foo.py and then fails, because a module has no submodules.
  assert.equal(
    resolvePythonImport("main.py", "foo.bar", repo("main.py", "foo.py", "foo/bar.py")),
    undefined,
  );
  assert.equal(
    resolvePythonImport(
      "pkg/mod.py",
      ".sub.x",
      repo("pkg/__init__.py", "pkg/mod.py", "pkg/sub.py", "pkg/sub/x.py"),
    ),
    undefined,
  );
  // With the package marker present, the directory is the package.
  assert.equal(
    resolvePythonImport(
      "main.py",
      "foo.bar",
      repo("main.py", "foo.py", "foo/__init__.py", "foo/bar.py"),
    ),
    "foo/bar.py",
  );
});

test("a project marker inside a test fixture is not a root", () => {
  const context = repo(
    "app/main.py",
    "tests/fixtures/sample/setup.py",
    "tests/fixtures/sample/settings.py",
  );
  assert.equal(resolvePythonImport("app/main.py", "settings", context), undefined);
  // Whereas a real sibling project is, because that is what a monorepo is.
  const monorepo = repo("services/api/main.py", "libs/pyproject.toml", "libs/common/__init__.py");
  assert.equal(
    resolvePythonImport("services/api/main.py", "common", monorepo),
    "libs/common/__init__.py",
  );
});

test("with no interpreter to name the standard library, absolute imports are dropped", () => {
  // Unknown is not empty. An empty list would match `import json` against a
  // repository file called `json.py`, which is the edge that appeared on
  // warm builds and vanished on cold ones.
  const context = { files: new Set(["app/main.py", "app/x.py", "json.py"]), stdlib: undefined };
  assert.equal(resolvePythonImport("app/main.py", "json", context), undefined);
  assert.equal(resolvePythonImport("app/main.py", ".x", context), "app/x.py");
});

test("the layout is read once and handed in, not rediscovered per specifier", () => {
  const files = new Set(["src/app/__init__.py", "libs/pyproject.toml", "tests/fixtures/x/setup.py"]);
  const layout = pythonLayout(files);
  assert.deepEqual(layout, { markerDirs: ["libs"], hasSrc: true });
  // The same Set answers with the same object, so a resolver asked fifty
  // thousand times does not walk the tree fifty thousand times.
  assert.equal(pythonLayout(files), layout);
});

test("a plain module under any root cuts a dotted path off under every root", () => {
  // `src/config.py` beside a top-level `config/dev.py` with no `__init__`:
  // the import system reads every sys.path entry, and a regular module on
  // any of them beats a namespace directory on any other, so `import
  // config.dev` fails with "'config' is not a package" whichever order the
  // entries are in. Checked per root, the shadow only removed `src` from
  // the search, and the repository root handed out `config/dev.py` — a file
  // Python never opens — while `import config` from the same file answered
  // `src/config.py`.
  const context = repo(
    "pyproject.toml",
    "src/app/__init__.py",
    "src/config.py",
    "config/dev.py",
    "scripts/x.py",
  );
  assert.equal(resolvePythonImport("scripts/x.py", "config", context), "src/config.py");
  assert.equal(resolvePythonImport("scripts/x.py", "config.dev", context), undefined);
  // The same through a project marker's root.
  const marker = repo("libs/pyproject.toml", "libs/config.py", "config/dev.py", "app/main.py");
  assert.equal(resolvePythonImport("app/main.py", "config.dev", marker), undefined);
  // A root that is not searched casts no shadow: `app/config.py` is
  // `app.config`, and says nothing about `config.dev` at the top level.
  const packaged = repo("app/__init__.py", "app/main.py", "app/config.py", "config/dev.py");
  assert.equal(resolvePythonImport("app/main.py", "config.dev", packaged), "config/dev.py");
});

test("a project marker under an examples directory is not a root for everyone", () => {
  // Django's `try: from local_settings import *` names a file that is
  // gitignored and so absent from the tree. The example project's marker
  // made `examples/demo/` a root for every importer, and its
  // `local_settings.py` — the only file of that name — was the answer.
  // One layout per spelling, so that each name in the list is doing its own
  // work: `examples/demo/` would be caught by either of two.
  for (const project of ["examples/blog", "demo", "samples/kitchen"]) {
    const context = repo(
      "app/__init__.py",
      "app/settings.py",
      `${project}/pyproject.toml`,
      `${project}/local_settings.py`,
      `${project}/manage.py`,
    );
    assert.equal(
      resolvePythonImport("app/settings.py", "local_settings", context),
      undefined,
      project,
    );
    assert.deepEqual(pythonLayout(context.files).markerDirs, [], project);
    // The example still resolves its own imports, through its own ancestors.
    assert.equal(
      resolvePythonImport(`${project}/manage.py`, "local_settings", context),
      `${project}/local_settings.py`,
      project,
    );
  }
});
