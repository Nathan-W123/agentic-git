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
