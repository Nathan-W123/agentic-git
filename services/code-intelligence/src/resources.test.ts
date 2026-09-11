/**
 * What a file is about, in every language the compiler cannot read.
 *
 * The four resources here are exactly what `claimCrossesBranches` compares,
 * so a language that produced none of them had a branch that never crossed.
 * The valuable assertions are the refusals: a route in a comment, a key
 * built by concatenation, a `get` that is a hash lookup and not a router.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  maskPython,
  resourcesFromNames,
  resourcesFromText,
} from "./resources.js";

/* --------------------------------------------------------------- names -- */

test("services and schemas are classified by name, as TypeScript does", () => {
  const found = resourcesFromNames("app/billing.py", [
    "PaymentService",
    "UserSchema",
    "OrderModel",
    "helper",
    "InvoiceRepository",
  ]);
  assert.deepEqual(found.services, ["PaymentService", "InvoiceRepository"]);
  assert.deepEqual(found.schemas, ["UserSchema", "OrderModel"]);
});

test("a migration path makes every declaration in it a schema", () => {
  const found = resourcesFromNames("db/migrations/0003_add_index.py", ["upgrade", "downgrade"]);
  assert.deepEqual(found.schemas, ["upgrade", "downgrade"]);
});

/* -------------------------------------------------------------- python -- */

test("python masks every string form and abandons an unterminated one", () => {
  const masked = maskPython(
    ['x = "a # not a comment"', "y = '''multi\nline'''", "z = f\"{k}\"", "# real comment", "w = 1"].join(
      "\n",
    ),
  );
  assert.notEqual(masked, undefined);
  assert.doesNotMatch(masked ?? "", /not a comment/u);
  assert.doesNotMatch(masked ?? "", /real comment/u);
  assert.match(masked ?? "", /w = 1/u);
  assert.equal(maskPython('s = "unterminated\n'), undefined);
  assert.equal(maskPython("s = '''never closed\n"), undefined);
});

test("python routes and config keys, and the ones that are not", () => {
  const found = resourcesFromText(
    [
      "import os",
      "",
      '@app.get("/users")',
      "def list_users(): ...",
      "",
      '@router.post("/orders")',
      "def create(): ...",
      "",
      '@app.route("/health")',
      "def health(): ...",
      "",
      "# @app.get('/commented')",
      'DOCS = """@app.get("/in_a_docstring")"""',
      "",
      'DB = os.environ["DATABASE_URL"]',
      'KEY = os.getenv("API_KEY")',
      'REGION = os.environ.get("AWS_REGION")',
      'DYNAMIC = os.environ["PREFIX_" + name]',
      'FSTR = os.getenv(f"{svc}_TOKEN")',
    ].join("\n"),
    "python",
  );
  assert.deepEqual(found?.apis, ["GET /users", "POST /orders", "ROUTE /health"]);
  // Order is pattern order and carries no meaning.
  assert.deepEqual([...(found?.configKeys ?? [])].sort(), ["API_KEY", "AWS_REGION", "DATABASE_URL"]);
});

/* ------------------------------------------------------------------ go -- */

test("go routes from the common routers, and getenv", () => {
  const found = resourcesFromText(
    [
      "package main",
      "",
      "func main() {",
      '\tr.GET("/users", list)',
      '\tr.POST("/orders", create)',
      '\tmux.HandleFunc("/health", health)',
      '\thttp.HandleFunc("/metrics", metrics)',
      '\t// r.GET("/commented", nil)',
      '\tport := os.Getenv("PORT")',
      '\t_, ok := os.LookupEnv("DEBUG")',
      '\tname := os.Getenv("PREFIX_" + suffix)',
      "}",
    ].join("\n"),
    "go",
  );
  assert.deepEqual(found?.apis, ["GET /users", "POST /orders", "ROUTE /health", "ROUTE /metrics"]);
  assert.deepEqual(found?.configKeys, ["PORT", "DEBUG"]);
});

/* -------------------------------------------------------------- jvm ---- */

test("spring annotations in java and kotlin, and a ktor route", () => {
  const java = resourcesFromText(
    [
      "package com.acme;",
      "",
      '@RequestMapping("/api")',
      "public class Controller {",
      '  @GetMapping("/users")',
      "  public List<User> list() { return null; }",
      '  @PostMapping(value = "/orders")',
      "  public void create() {}",
      '  String home = System.getenv("HOME");',
      "}",
    ].join("\n"),
    "java",
  );
  assert.deepEqual(java?.apis, ["GET /users", "POST /orders", "ROUTE /api"]);
  assert.deepEqual(java?.configKeys, ["HOME"]);

  const kotlin = resourcesFromText(
    [
      "package com.acme",
      "",
      "fun Application.module() {",
      "    routing {",
      '        get("/users") { }',
      '        post("/orders") { }',
      "    }",
      '    val token = System.getenv("TOKEN")',
      "}",
    ].join("\n"),
    "kotlin",
  );
  assert.deepEqual(kotlin?.apis, ["GET /users", "POST /orders"]);
  assert.deepEqual(kotlin?.configKeys, ["TOKEN"]);
});

/* -------------------------------------------------------------- rust ---- */

test("rust route attributes and env reads", () => {
  const found = resourcesFromText(
    [
      '#[get("/users")]',
      "async fn list() {}",
      "",
      '#[post("/orders")]',
      "async fn create() {}",
      "",
      "fn build() {",
      '    let app = Router::new().route("/health", get(health));',
      '    let url = std::env::var("DATABASE_URL");',
      '    let key = env::var("API_KEY");',
      '    let built = env!("CARGO_PKG_NAME");',
      '    // #[get("/commented")]',
      "}",
    ].join("\n"),
    "rust",
  );
  assert.deepEqual(found?.apis, ["GET /users", "POST /orders", "ROUTE /health"]);
  assert.deepEqual(found?.configKeys, ["DATABASE_URL", "API_KEY", "CARGO_PKG_NAME"]);
});

/* -------------------------------------------------------------- ruby ---- */

test("rails and sinatra routes, and ENV", () => {
  const found = resourcesFromText(
    [
      "Rails.application.routes.draw do",
      "  get '/users', to: 'users#index'",
      "  post '/orders', to: 'orders#create'",
      "  # get '/commented'",
      "end",
      "",
      "db = ENV['DATABASE_URL']",
      "key = ENV.fetch('API_KEY')",
      'dyn = ENV["PREFIX_#{name}"]',
    ].join("\n"),
    "ruby",
  );
  assert.deepEqual(found?.apis, ["GET /users", "POST /orders"]);
  assert.deepEqual(found?.configKeys, ["DATABASE_URL", "API_KEY"]);
});

/* -------------------------------------------------------------- php ----- */

test("laravel and symfony routes, and getenv", () => {
  const found = resourcesFromText(
    [
      "<?php",
      "Route::get('/users', [UserController::class, 'index']);",
      "Route::post('/orders', fn() => 1);",
      "#[Route('/health')]",
      "function health() {}",
      "$db = getenv('DATABASE_URL');",
      "$key = $_ENV['API_KEY'];",
      "$app = env('APP_NAME');",
      "// Route::get('/commented');",
    ].join("\n"),
    "php",
  );
  assert.deepEqual(found?.apis, ["GET /users", "POST /orders", "ROUTE /health"]);
  assert.deepEqual(found?.configKeys, ["DATABASE_URL", "API_KEY", "APP_NAME"]);
});

/* ------------------------------------------------------------ csharp ---- */

test("asp.net attributes and minimal apis", () => {
  const found = resourcesFromText(
    [
      "using Microsoft.AspNetCore.Mvc;",
      "",
      '[Route("/api")]',
      "public class Users : ControllerBase {",
      '  [HttpGet("/users")] public IActionResult List() => Ok();',
      '  [HttpPost("/orders")] public IActionResult Create() => Ok();',
      '  string home = Environment.GetEnvironmentVariable("HOME");',
      "}",
      'app.MapGet("/health", () => "ok");',
    ].join("\n"),
    "csharp",
  );
  assert.deepEqual(found?.apis, ["GET /users", "POST /orders", "GET /health", "ROUTE /api"]);
  assert.deepEqual(found?.configKeys, ["HOME"]);
});

/* ---------------------------------------------------------- c family ---- */

test("c# is read by its own string rules, not c's", () => {
  // A verbatim path ends in a backslash that is not an escape, and a raw
  // string opens with three quotes. Read by C's rules either makes the
  // file unreadable, and an unreadable controller declares no routes.
  const found = resourcesFromText(
    [
      "using Microsoft.AspNetCore.Mvc;",
      'string p = @"C:\\dir\\";',
      'string q = """',
      "  raw text",
      '  """;',
      "public class U : ControllerBase {",
      '  [HttpGet("/users")] public IActionResult L() => Ok();',
      '  string h = Environment.GetEnvironmentVariable("HOME");',
      "}",
    ].join("\n"),
    "csharp",
  );
  assert.deepEqual(found?.apis, ["GET /users"]);
  assert.deepEqual(found?.configKeys, ["HOME"]);
});

test("a c string body and a dead group are not code", () => {
  // A clang-style test fixture carries whole programs inside raw strings,
  // and `getenv` in one of them is text; so is the `getenv` under `#if 0`,
  // which nothing ever calls. The one live read beside them is still found.
  const found = resourcesFromText(
    [
      'const char *fixture = R"cpp(',
      '  const char *h = getenv("PATH");',
      ')cpp";',
      "char *m = \"use getenv('HOME')\";",
      "#if 0",
      'char *o = getenv("OLD");',
      "#endif",
      'char *v = "[Route(\'/ghost\')]";',
      'char *live = getenv("LIVE");',
    ].join("\n"),
    "cpp",
  );
  assert.deepEqual(found, { apis: [], configKeys: ["LIVE"] });
  const cs = resourcesFromText(
    'var s = @"[HttpGet(""/ghost"")]";\n#if false\napp.MapGet("/dead", h);\n#endif\napp.MapGet("/live", h);\n',
    "csharp",
  );
  assert.deepEqual(cs?.apis, ["GET /live"]);
});

/* ----------------------------------------------------------- refusals --- */

test("a route that does not start with a slash is not a route", () => {
  // `.get("key")` on a map, a config, a header — the method name alone is
  // not evidence, and recording it would make every dictionary lookup a
  // route that two branches could collide on.
  const go = resourcesFromText('func f() { v := m.Get("key"); r.GET("/real", h) }', "go");
  assert.deepEqual(go?.apis, ["GET /real"]);
  const rb = resourcesFromText("x = h.get 'key'\nget '/real'\n", "ruby");
  assert.deepEqual(rb?.apis, ["GET /real"]);
});

test("a file the masker cannot read yields nothing, not a guess", () => {
  assert.equal(resourcesFromText('s = "unterminated\n@app.get("/x")', "python"), undefined);
  assert.equal(resourcesFromText("/* open\nr.GET(\"/x\")", "go"), undefined);
});

/* ------------------------------------------------------------- third pass -- */

test("C# is masked by C#'s rules, and a verbatim path does not hide the routes after it", () => {
  assert.deepEqual(
    resourcesFromText(
      [
        "using X;",
        "public class U : ControllerBase {",
        '  string p = @"C:\\dir\\";',
        '  [HttpGet("/users")] public IActionResult L() => Ok();',
        "}",
      ].join("\n"),
      "csharp",
    ),
    { apis: ["GET /users"], configKeys: [] },
  );
});

test("a key or a route inside a string body or a dead group is not one", () => {
  // A clangd-style test fixture holds source text in a raw string; reading
  // its `getenv` as a configuration key makes every fixture contend with the
  // code it is a fixture for.
  assert.deepEqual(
    resourcesFromText(
      [
        'const char *fixture = R"cpp(',
        '  const char *h = getenv("PATH");',
        ')cpp";',
        'char *m = "use getenv(\'HOME\')";',
        "#if 0",
        'char *o = getenv("OLD");',
        "#endif",
        'char *real = getenv("REAL");',
      ].join("\n"),
      "cpp",
    ),
    { apis: [], configKeys: ["REAL"] },
  );
});

test("request metadata is not configuration", () => {
  // Every WSGI middleware reads environ['PATH_INFO'] and every PHP front
  // controller reads $_SERVER['REQUEST_URI']; nobody configures either.
  assert.deepEqual(
    resourcesFromText(
      'def app(environ, start_response):\n    path = environ["PATH_INFO"]\n    k = os.getenv("REAL")\n    return []\n',
      "python",
    ),
    { apis: [], configKeys: ["REAL"] },
  );
  assert.deepEqual(
    resourcesFromText(
      '<?php\n$u = $_SERVER["REQUEST_URI"];\n$e = $_ENV["REAL"];\n$g = getenv("ALSO");\n',
      "php",
    ),
    { apis: [], configKeys: ["ALSO", "REAL"] },
  );
});

test("a route is registered on a router, not fetched from a client", () => {
  // `keychain.get`, `redis.get` and an HTTP client are the same shape as a
  // Vapor route; so are an SDK's `c.Get` and a feature test's `$this->get`.
  assert.deepEqual(
    resourcesFromText(
      [
        'let t = try keychain.get("token")',
        'let v = try await req.redis.get("session:x")',
        'let r = try client.get("https://api.example.com/users")',
        'app.get("/users") { }',
      ].join("\n"),
      "swift",
    ),
    { apis: ["GET /users"], configKeys: [] },
  );
  assert.deepEqual(
    resourcesFromText('func (c *Client) Users() { c.Get("/v1/users") }\n', "go", "sdk/client.go")?.apis,
    [],
  );
  assert.deepEqual(
    resourcesFromText('func main() { r.GET("/v1/users", h) }\n', "go", "cmd/main.go")?.apis,
    ["GET /v1/users"],
  );
  assert.deepEqual(
    resourcesFromText('<?php\n$r = $this->get("/users");\n$app->get("/orders", $h);\n', "php")?.apis,
    ["GET /orders"],
  );
  // A request spec calls `get "/users"` in exactly the shape routes.rb
  // registers one; only one of them serves it.
  assert.deepEqual(
    resourcesFromText('RSpec.describe "Users" do\n  it "lists" do\n    get "/users"\n  end\nend\n', "ruby", "spec/users_spec.rb")?.apis,
    [],
  );
  assert.deepEqual(
    resourcesFromText('get "/users", to: "users#index"\n', "ruby", "config/routes.rb")?.apis,
    ["GET /users"],
  );
  // And Django's own `path(...)`, not somebody's method called path.
  assert.deepEqual(
    resourcesFromText('p = self.path("assets")\nurlpatterns = [path("users/", v)]\n', "python")?.apis,
    ["ROUTE /users/"],
  );
});

test("an interpolated literal is a run-time value in every spelling", () => {
  const keys = (source: string, language: Parameters<typeof resourcesFromText>[1]) =>
    resourcesFromText(source, language)?.configKeys;
  assert.deepEqual(
    keys('Environment.GetEnvironmentVariable($"{svc}_TOKEN");\nEnvironment.GetEnvironmentVariable("REAL");\n', "csharp"),
    ["REAL"],
  );
  assert.deepEqual(keys('System.getenv("PREFIX_$name")\nSystem.getenv("REAL")\n', "kotlin"), ["REAL"]);
  assert.deepEqual(
    keys('let a = ProcessInfo.processInfo.environment["PREFIX_\\(name)"]\nlet b = ProcessInfo.processInfo.environment["REAL"]\n', "swift"),
    ["REAL"],
  );
  assert.deepEqual(keys('<?php\ngetenv("PREFIX_$name");\ngetenv("{$p}_X");\ngetenv("REAL");\n', "php"), ["REAL"]);
  // Python's `%` formatting and its adjacent-literal concatenation: the
  // first half of a key is not the key.
  assert.deepEqual(keys('os.getenv("%s_TOKEN" % svc)\nos.getenv("A" "B")\nos.getenv("REAL")\n', "python"), ["REAL"]);
  assert.deepEqual(
    resourcesFromText('app.MapGet($"/{prefix}/users", h);\napp.MapGet("/real", h);\n', "csharp")?.apis,
    ["GET /real"],
  );
});

test("a schema and a service are types, so their names are capitalised", () => {
  // `validateInput` is a function and `getClient` is a call; reading them as
  // a schema and a service put two unrelated branches in contention.
  assert.deepEqual(resourcesFromNames("src/util.py", ["validateInput", "getClient", "UserSchema", "PaymentService"]), {
    schemas: ["UserSchema"],
    services: ["PaymentService"],
  });
  // The path rule is not narrowed: a declaration in a migrations directory
  // is the migration, whatever it is called.
  assert.deepEqual(
    resourcesFromNames("db/migrations/0003_add_index.py", ["upgrade"]).schemas,
    ["upgrade"],
  );
});
