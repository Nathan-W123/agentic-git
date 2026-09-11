/**
 * What a file *is about*, for the languages the compiler cannot read.
 *
 * The TypeScript indexer answers four questions from a real AST: which
 * declarations are services, which are schemas, which routes a file serves,
 * and which configuration keys it reads. Those four are exactly what
 * `claimCrossesBranches` compares, so a language that answers none of them
 * has a branch that never crosses — and a blanket claim that is never
 * refused on its account, however much it reaches into another branch's
 * contract.
 *
 * Two of the four are questions about *names*, and a name is a name in any
 * language. `PaymentService` is a service and `UserSchema` is a schema by
 * the same rule the TypeScript side applies, so those two come free for every
 * language the symbol scanners already cover, with identical semantics.
 *
 * The other two are questions about *calls*: a route registration and an
 * environment read. Those are framework-shaped and language-shaped, and are
 * matched here per language against literal arguments only, on positions the
 * masker says are code. A route in a comment is prose; a key built by
 * concatenation is a run-time value. Both are dropped rather than guessed.
 *
 * As everywhere: a missed resource costs a warning; an invented one makes two
 * branches contend over nothing.
 */

import type { SupportedLanguage } from "./index.js";
import { maskNative } from "./native-imports.js";
import { maskRust } from "./rust-imports.js";
import { maskPhp, maskRuby } from "./script-imports.js";
import { blankBraceLanguage, type BraceLanguage } from "./symbol-ranges.js";

export interface ScannedResources {
  apis: string[];
  schemas: string[];
  configKeys: string[];
  services: string[];
}

/** The same rules the TypeScript indexer applies to a declaration's name. */
const SERVICE_NAME = /(?:Service|Client|Repository|Gateway|Worker)$/u;
const SCHEMA_NAME = /(?:Schema|Entity|Model|Record|Payload|Input|Migration)$/u;
const SCHEMA_PATH = /(?:schema|migration|model)/iu;

/** Classifies declarations by name alone, which needs no parser. */
export function resourcesFromNames(
  filePath: string,
  symbols: readonly string[],
): Pick<ScannedResources, "schemas" | "services"> {
  const schemas = new Set<string>();
  const services = new Set<string>();
  for (const name of symbols) {
    if (SERVICE_NAME.test(name)) {
      services.add(name);
    }
    if (SCHEMA_NAME.test(name) || SCHEMA_PATH.test(filePath)) {
      schemas.add(name);
    }
  }
  return { schemas: [...schemas], services: [...services] };
}

/* ------------------------------------------------------------- masking -- */

/** Blanks Python comments and every string form, keeping offsets. */
export function maskPython(source: string): string | undefined {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== "\n") {
        out[at] = " ";
      }
    }
  };
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (character === "#") {
      const end = source.indexOf("\n", index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }
    // String prefixes: r, b, f, u and their combinations, any case.
    const opener = /^(?:[rRbBfFuU]{0,2})("""|'''|"|')/u.exec(source.slice(index));
    if (opener !== null && !/\w/u.test(source[index - 1] ?? "")) {
      const quote = opener[1] ?? '"';
      const raw = /[rR]/u.test(opener[0].slice(0, -quote.length));
      let at = index + opener[0].length;
      for (;;) {
        if (at >= source.length) {
          return undefined;
        }
        if (source[at] === "\\" && !raw) {
          at += 2;
          continue;
        }
        if (source[at] === "\\" && raw) {
          // A raw string still cannot end on an escaped quote.
          at += 2;
          continue;
        }
        if (source.startsWith(quote, at)) {
          at += quote.length;
          break;
        }
        if (source[at] === "\n" && quote.length === 1) {
          return undefined;
        }
        at += 1;
      }
      blank(index, at);
      index = at;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/** Code-only text for one language, or nothing when it cannot be trusted. */
export function maskForLanguage(
  source: string,
  language: SupportedLanguage,
): string | undefined {
  switch (language) {
    case "python":
      return maskPython(source);
    case "rust":
      return maskRust(source);
    case "ruby":
      return maskRuby(source);
    case "php":
      return maskPhp(source);
    case "c":
    case "cpp":
    case "csharp":
      return maskNative(source)?.text;
    case "go":
    case "java":
    case "kotlin":
    case "scala":
    case "swift":
      return blankBraceLanguage(source, language as BraceLanguage);
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------ patterns -- */

/**
 * A call whose *first* literal string argument is the thing wanted.
 *
 * Each pattern matches the call's head in the masked text and the argument
 * in the original, because the masker blanked the argument — it is a string.
 * The trick is the one the require readers use: the head has to survive
 * masking, which proves it was code, and the argument is read from where the
 * head points.
 */
interface LiteralCall {
  /** Matches the head, ending just before the literal. */
  head: RegExp;
  /** Turns the captured literal (and the head match) into the recorded name. */
  record: (literal: string, head: RegExpExecArray) => string | undefined;
}

const QUOTED = /^\s*(?:\(\s*)?(?:[rRbBfFuU@$]{0,2})(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/u;

function literalCalls(
  source: string,
  masked: string,
  patterns: readonly LiteralCall[],
): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const head of masked.matchAll(new RegExp(pattern.head.source, "gu"))) {
      // The head is matched in the masked text and the literal is read from
      // the original at the offset the head ends on. A head must therefore
      // never end in greedy whitespace: the literal has been blanked to
      // spaces in the masked text, and `\s*` would eat straight through it
      // and leave the offset past its closing quote.
      const at = (head.index ?? 0) + head[0].length;
      const rest = source.slice(at);
      const literal = QUOTED.exec(rest);
      if (literal === null) {
        continue;
      }
      const prefix = literal[0].slice(0, literal[0].indexOf(literal[1] ?? '"'));
      const value = literal[2] ?? "";
      if (value === "") {
        continue;
      }
      // Interpolated, so a run-time value: a template, a Ruby `#{}`, or a
      // Python f-string with a substitution in it.
      if (
        value.includes("${") ||
        value.includes("#{") ||
        (/[fF]/u.test(prefix) && value.includes("{"))
      ) {
        continue;
      }
      // Concatenated onto something, so also a run-time value. `"PREFIX_" +
      // name` is a real key nobody can name from here.
      const after = rest.slice(literal[0].length);
      if (/^\s*[+.]/u.test(after) && !/^\s*\.\s*$/u.test(after)) {
        continue;
      }
      const name = pattern.record(value, head);
      if (name !== undefined) {
        out.add(name);
      }
    }
  }
  return [...out];
}

const asRoute = (method: string) => (path: string): string | undefined =>
  path.startsWith("/") ? `${method.toUpperCase()} ${path}` : undefined;

const METHOD = "(get|post|put|patch|delete|head|options|all|any)";

const CONFIG_PATTERNS: Partial<Record<SupportedLanguage, LiteralCall[]>> = {
  python: [
    { head: /\bos\.environ\s*\[/u, record: (key) => key },
    { head: /\bos\.environ\.get\s*\(/u, record: (key) => key },
    { head: /\bos\.getenv\s*\(/u, record: (key) => key },
    { head: /\benviron\s*\[/u, record: (key) => key },
    { head: /\benviron\.get\s*\(/u, record: (key) => key },
  ],
  go: [
    { head: /\bos\.(?:Getenv|LookupEnv)\s*\(/u, record: (key) => key },
    { head: /\bviper\.(?:GetString|GetInt|GetBool|Get)\s*\(/u, record: (key) => key },
  ],
  java: [{ head: /\bSystem\.(?:getenv|getProperty)\s*\(/u, record: (key) => key }],
  kotlin: [{ head: /\bSystem\.(?:getenv|getProperty)\s*\(/u, record: (key) => key }],
  scala: [
    { head: /\bSystem\.(?:getenv|getProperty)\s*\(/u, record: (key) => key },
    { head: /\bsys\.env\s*\(/u, record: (key) => key },
  ],
  rust: [
    { head: /\b(?:std::)?env::(?:var|var_os)\s*\(/u, record: (key) => key },
    { head: /\b(?:option_)?env!\s*\(/u, record: (key) => key },
  ],
  ruby: [
    { head: /\bENV\s*\[/u, record: (key) => key },
    { head: /\bENV\.fetch\s*\(/u, record: (key) => key },
  ],
  php: [
    { head: /\bgetenv\s*\(/u, record: (key) => key },
    { head: /\$_(?:ENV|SERVER)\s*\[/u, record: (key) => key },
    { head: /\benv\s*\(/u, record: (key) => key },
  ],
  c: [{ head: /\bgetenv\s*\(/u, record: (key) => key }],
  cpp: [{ head: /\b(?:std::)?getenv\s*\(/u, record: (key) => key }],
  csharp: [
    { head: /\bEnvironment\.GetEnvironmentVariable\s*\(/u, record: (key) => key },
  ],
  swift: [
    { head: /\bProcessInfo\.processInfo\.environment\s*\[/u, record: (key) => key },
  ],
};

const API_PATTERNS: Partial<Record<SupportedLanguage, LiteralCall[]>> = {
  python: [
    // Flask / FastAPI / Sanic / Quart decorators: @app.get("/x"), @router.post("/x")
    {
      head: new RegExp(`@\\w+(?:\\.\\w+)*\\.${METHOD}\\s*\\(`, "u"),
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
    // @app.route("/x") — method unknown until the kwargs, which are not read.
    { head: /@\w+(?:\.\w+)*\.route\s*\(/u, record: asRoute("route") },
    // Django: path("x/", view) — no leading slash by convention.
    {
      head: /\b(?:re_)?path\s*\(/u,
      record: (path) => (path === "" ? undefined : `ROUTE /${path.replace(/^\//u, "")}`),
    },
  ],
  go: [
    // gin / echo / fiber / chi / gorilla: r.GET("/x"), mux.HandleFunc("/x")
    {
      head: /\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete|Head|Options)\s*\(/u,
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
    { head: /\.(?:HandleFunc|Handle)\s*\(/u, record: asRoute("route") },
    { head: /\bhttp\.HandleFunc\s*\(/u, record: asRoute("route") },
  ],
  java: [
    {
      head: /@(Get|Post|Put|Patch|Delete)Mapping\s*\((?:\s*(?:value|path)\s*=)?/u,
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
    { head: /@RequestMapping\s*\((?:\s*(?:value|path)\s*=)?/u, record: asRoute("route") },
    { head: /@Path\s*\(/u, record: asRoute("route") },
  ],
  kotlin: [
    {
      head: /@(Get|Post|Put|Patch|Delete)Mapping\s*\((?:\s*(?:value|path)\s*=)?/u,
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
    { head: /@RequestMapping\s*\((?:\s*(?:value|path)\s*=)?/u, record: asRoute("route") },
    // Ktor: get("/x") { }, route("/x") { }
    {
      head: new RegExp(`(?:^|[\\s{;])${METHOD}\\s*\\(`, "u"),
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
    { head: /(?:^|[\s{;])route\s*\(/u, record: asRoute("route") },
  ],
  scala: [
    { head: /@(Get|Post|Put|Patch|Delete)Mapping\s*\(/u, record: (p, h) => asRoute(h[1] ?? "route")(p) },
  ],
  rust: [
    // actix / rocket: #[get("/x")]
    {
      head: new RegExp(`#\\[${METHOD}\\s*\\(`, "u"),
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
    // axum / warp / actix builder: .route("/x", ...)
    { head: /\.route\s*\(/u, record: asRoute("route") },
  ],
  ruby: [
    // Rails routes and Sinatra: get '/x', post '/x'
    {
      // Ends on the keyword itself: the literal that follows has been
      // blanked, and a trailing `\s+` would eat it. A required space is
      // checked from the original instead, in QUOTED's own leading `\s*`.
      head: new RegExp(`(?:^|[\\s;])${METHOD}(?=[ \\t])`, "u"),
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
    { head: /(?:^|[\s;])match(?=[ \t])/u, record: asRoute("route") },
  ],
  php: [
    // Laravel: Route::get('/x')
    {
      head: new RegExp(`\\bRoute::${METHOD}\\s*\\(`, "u"),
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
    // Symfony / Slim: #[Route('/x')], $app->get('/x')
    { head: /#\[Route\s*\(/u, record: asRoute("route") },
    {
      head: new RegExp(`->${METHOD}\\s*\\(`, "u"),
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
  ],
  csharp: [
    // ASP.NET: [HttpGet("/x")], app.MapGet("/x")
    {
      head: /\[Http(Get|Post|Put|Patch|Delete)\s*\(/u,
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
    {
      head: /\.Map(Get|Post|Put|Patch|Delete)\s*\(/u,
      record: (path, head) => asRoute(head[1] ?? "route")(path),
    },
    { head: /\[Route\s*\(/u, record: asRoute("route") },
  ],
  swift: [
    // Vapor: app.get("x"), routes.post("x") — no leading slash by convention.
    {
      head: new RegExp(`\\.${METHOD}\\s*\\(`, "u"),
      record: (path, head) =>
        `${(head[1] ?? "route").toUpperCase()} /${path.replace(/^\//u, "")}`,
    },
  ],
};

/**
 * The route and configuration surface of one file, from its text.
 *
 * Returns nothing when the file could not be masked, so a caller can tell
 * "reads no configuration" from "could not look" — and never invents a
 * resource from a comment or a string.
 */
export function resourcesFromText(
  source: string,
  language: SupportedLanguage,
): Pick<ScannedResources, "apis" | "configKeys"> | undefined {
  const masked = maskForLanguage(source, language);
  if (masked === undefined) {
    return undefined;
  }
  return {
    apis: literalCalls(source, masked, API_PATTERNS[language] ?? []),
    configKeys: literalCalls(source, masked, CONFIG_PATTERNS[language] ?? []),
  };
}
