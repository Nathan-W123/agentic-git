/**
 * The written contract of a declaration, for languages the TypeScript
 * compiler cannot read.
 *
 * `contract-shape.ts` reads a TypeScript syntax tree and reduces each export
 * to what a caller depends on. Every other language got nothing — an empty
 * shape list and a flag saying so — which left the contract layer above it
 * inert for a Go, Python, Java or Rust repository: two branches that left
 * `Charge` with different parameters were indistinguishable from two that
 * never met.
 *
 * What is read here is the *signature*: the declaration from its first
 * keyword to where its body begins, and for a type the members of that body
 * with nested bodies removed. That is the whole of what a scanner can read
 * with confidence, and it is most of what a caller depends on — parameters,
 * return type, fields, method heads. What it is not is a type checker: an
 * unannotated Python parameter, a Kotlin function with no written return
 * type, and every Ruby method are marked `inferred`, the same flag the
 * TypeScript side raises for a `const` with no annotation.
 *
 * The contract is the one `symbol-ranges.ts` keeps. An array means "these are
 * the shapes"; `undefined` means the masker could not read the file, and the
 * caller must keep saying the shapes are unknown rather than empty.
 */

import { digestOf, type ShapeKind, type SymbolShape } from "./contract-shape.js";
import {
  blankBraceLanguage,
  braceDeclarations,
  rubySymbolRanges,
  type BraceLanguage,
  type PythonShape,
} from "./symbol-ranges.js";

/** Languages where a caller passes by position, so a parameter's name is not contract. */
const POSITIONAL = new Set<BraceLanguage>(["java", "c", "cpp", "rust"]);

/** Languages whose types are written before the name, `Type name`. */
const TYPE_FIRST = new Set<BraceLanguage>(["java", "c", "cpp"]);

/** Whitespace and trailing separators are not contract. */
function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").replace(/\s*([,;])\s*$/u, "").trim();
}

/** Split on a separator at bracket depth zero. */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if ("([<{".includes(character)) {
      depth += 1;
    } else if (")]>}".includes(character)) {
      depth -= 1;
    }
    if (character === separator && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * The parameter list of a head with the names taken out, for the languages
 * where a name is not something a caller can depend on.
 *
 * `Type name` languages drop the last token of each parameter; Rust drops
 * everything before the `:`. Where the parameter list cannot be found the
 * head is compared as written, which errs toward reporting a rename as a
 * change rather than hiding a real one.
 */
function withoutParameterNames(head: string, language: BraceLanguage): string {
  const open = head.indexOf("(");
  if (open === -1) {
    return head;
  }
  let depth = 0;
  let close = -1;
  for (let at = open; at < head.length; at += 1) {
    if (head[at] === "(") {
      depth += 1;
    } else if (head[at] === ")") {
      depth -= 1;
      if (depth === 0) {
        close = at;
        break;
      }
    }
  }
  if (close === -1) {
    return head;
  }
  const parameters = splitTopLevel(head.slice(open + 1, close), ",").map(
    (parameter) => {
      if (language === "rust") {
        if (/^(?:&\s*(?:mut\s+)?)?(?:mut\s+)?self$/u.test(parameter)) {
          return parameter;
        }
        const colon = parameter.indexOf(":");
        return colon === -1 ? parameter : parameter.slice(colon + 1).trim();
      }
      if (TYPE_FIRST.has(language)) {
        const tokens = parameter.split(/\s+/u);
        // `int` alone is an unnamed parameter; `int a[]` and `void (*f)(int)`
        // are left as written rather than mangled.
        if (tokens.length < 2 || /[\])]$/u.test(tokens.at(-1) ?? "")) {
          return parameter;
        }
        return tokens.slice(0, -1).join(" ");
      }
      return parameter;
    },
  );
  return `${head.slice(0, open + 1)}${parameters.join(", ")}${head.slice(close)}`;
}

/**
 * Whether a function head leaves its return type to inference.
 *
 * Only where the language would infer one. Go, Java, C, C++ and C# always
 * write it; a Rust or Swift function with no arrow returns unit by
 * construction, as does a Kotlin or Scala function with a block body — it is
 * the expression body, `fun f() = ...`, whose type is worked out from the
 * expression. A PHP function with no `:` returns `mixed`, except a
 * constructor, which is not allowed a type at all.
 */
function returnInferred(
  head: string,
  language: BraceLanguage,
  terminator: string,
  name: string,
): boolean {
  const close = head.lastIndexOf(")");
  // A Scala `def format: String` has no parameter list at all; the type is
  // then whatever follows the name.
  const tail =
    close === -1
      ? head.replace(/^.*?\b(?:def|fun|function|func)\s+[^\s(:]+/u, "")
      : head.slice(close + 1);
  switch (language) {
    case "kotlin":
    case "scala":
      return terminator === "=" && !/:/u.test(tail);
    case "php":
      return !/:/u.test(tail) && name !== "__construct" && name !== "__destruct";
    default:
      return false;
  }
}

/**
 * Whether a declaration is reachable from outside the file it is in.
 *
 * Errs toward "yes": a declaration is private only when its language spells
 * that out — a Go name in lower case, a Rust item without `pub`, a C
 * function marked `static`, a `private`/`protected` member elsewhere. A
 * package-visible Java method is shared with every other file in the
 * package, which is the same shape of dependency the graph tracks.
 */
function reachable(
  head: string,
  name: string,
  language: BraceLanguage,
  access: string,
  member: boolean,
): boolean {
  if (language === "go") {
    return member || /^[A-Z]/u.test(name);
  }
  if (language === "rust") {
    return /^\s*pub\b/u.test(head) || /^\s*impl\b/u.test(head);
  }
  if (language === "c") {
    return !/^\s*static\b/u.test(head);
  }
  if (language === "cpp") {
    // `static` on a free function is file-private; on a member it is a class
    // function anybody can call.
    return (
      access !== "private" &&
      access !== "protected" &&
      (member || !/^\s*static\b/u.test(head))
    );
  }
  return !/^\s*(?:private|protected|fileprivate)\b/u.test(head);
}

/**
 * The members of a type body, one per line, nested bodies removed.
 *
 * Sorted, because moving a field is not a contract change — except for an
 * enum, where a member with no explicit value takes it from its position.
 */
function membersOf(
  body: string,
  language: BraceLanguage,
  kind: ShapeKind,
  defaultAccess: string,
  classLike: boolean,
): { members: string[]; comparable: string[] } {
  let flattened = "";
  let depth = 0;
  for (const character of body) {
    if (character === "{") {
      depth += 1;
      if (depth === 1) {
        flattened += "{}";
      }
      continue;
    }
    if (character === "}") {
      depth -= 1;
      continue;
    }
    if (depth === 0) {
      flattened += character;
    }
  }
  const members: string[] = [];
  const comparable: string[] = [];
  let access = defaultAccess;
  // Fields end in commas, statements in semicolons, and a Go struct's in
  // newlines; all three separate members. An initializer or an expression
  // body after `=` is a value, not a contract, and is cut — except in an
  // enum, where `B = 3` is exactly the contract.
  const lines = flattened
    .split(/[;\n]/u)
    .flatMap((statement) => splitTopLevel(statement, ","));
  for (const raw of lines) {
    let line = normalize(raw.replace(/\{\}/gu, ""));
    if (kind !== "enum") {
      line = normalize(splitTopLevel(line, "=")[0] ?? "");
    }
    if (line === "") {
      continue;
    }
    // C++ access labels apply to everything after them.
    const label = /^(public|private|protected)\s*:$/u.exec(line);
    if (label?.[1] !== undefined) {
      access = label[1];
      continue;
    }
    // Every variant of an enum and every item of a trait is as public as
    // the type; a struct field or an impl item needs its own `pub`.
    if (
      language === "rust" &&
      kind !== "enum" &&
      kind !== "interface" &&
      !/^pub\b/u.test(line)
    ) {
      continue;
    }
    // A `static` inside a namespace body is file-private the way one at
    // file scope is; inside a class it is a member anybody can call.
    if (
      language !== "rust" &&
      !reachable(line, line, language, access, classLike)
    ) {
      continue;
    }
    members.push(line);
    comparable.push(
      POSITIONAL.has(language) ? withoutParameterNames(line, language) : line,
    );
  }
  if (kind !== "enum") {
    members.sort((left, right) => left.localeCompare(right));
    comparable.sort((left, right) => left.localeCompare(right));
  }
  return { members, comparable };
}

function kindOf(head: string, declared: "function" | "type"): ShapeKind {
  if (declared === "function") {
    return "function";
  }
  const keyword = /\b(class|struct|interface|enum|trait|record|object|protocol|extension|actor|union|namespace|impl)\b/u.exec(
    head,
  )?.[1];
  switch (keyword) {
    case "class":
    case "record":
    case "object":
    case "actor":
      return "class";
    case "interface":
    case "trait":
    case "protocol":
      return "interface";
    case "enum":
      return "enum";
    default:
      return "type";
  }
}

interface Piece {
  kind: ShapeKind;
  shape: string;
  comparable: string;
  inferred: boolean;
}

function assemble(symbol: string, pieces: readonly Piece[]): SymbolShape {
  const sorted = [...pieces].sort((left, right) =>
    left.comparable.localeCompare(right.comparable),
  );
  // Several declarations under one name — overloads, a struct and its impl
  // blocks — are one contract, in an order that does not depend on where
  // each was written.
  const kind = sorted.find((piece) => piece.kind !== "function")?.kind ?? "function";
  const shape = sorted.map((piece) => piece.shape).join(" | ");
  const comparable = sorted.map((piece) => piece.comparable).join(" | ");
  const inferred = sorted.some((piece) => piece.inferred);
  return {
    symbol,
    kind,
    shape,
    digest: digestOf(`${kind} ${comparable}`),
    ...(inferred ? { inferred: true } : {}),
  };
}

/**
 * Every reachable declaration's signature in a brace-delimited file.
 *
 * `undefined` when the masker could not read the file; the caller keeps
 * reporting the shapes as unknown.
 */
export function braceShapes(
  source: string,
  language: BraceLanguage,
): SymbolShape[] | undefined {
  const read = braceDeclarations(source, language);
  if (read === undefined) {
    return undefined;
  }
  const { code, declarations } = read;
  const pieces = new Map<string, Piece[]>();
  for (const declaration of declarations) {
    const head = normalize(code.slice(declaration.start, declaration.headEnd));
    const kind = kindOf(head, declaration.declared);
    // C++ members are private until a label says otherwise — in a class. A
    // struct, a union and a namespace start public.
    const enclosingAccess =
      language === "cpp" && /^(?:template\s*<[^>]*>\s*)?class\b/u.test(head)
        ? "private"
        : "public";
    if (!reachable(head, declaration.name, language, declaration.access, false)) {
      continue;
    }
    const strippedHead = POSITIONAL.has(language)
      ? withoutParameterNames(head, language)
      : head;
    if (kind === "function") {
      pieces.set(declaration.name, [
        ...(pieces.get(declaration.name) ?? []),
        {
          kind,
          shape: head,
          comparable: strippedHead,
          inferred: returnInferred(
            head,
            language,
            declaration.terminator,
            declaration.name,
          ),
        },
      ]);
      continue;
    }
    const body =
      declaration.open === undefined || declaration.close === undefined
        ? ""
        : code.slice(declaration.open + 1, declaration.close);
    const { members, comparable } = membersOf(
      body,
      language,
      kind,
      enclosingAccess,
      !/\bnamespace\b/u.test(head),
    );
    pieces.set(declaration.name, [
      ...(pieces.get(declaration.name) ?? []),
      {
        kind,
        shape: `${head} {${members.join("; ")}}`,
        comparable: `${strippedHead} {${comparable.join("; ")}}`,
        inferred: false,
      },
    ]);
  }
  return [...pieces]
    .map(([symbol, list]) => assemble(symbol, list))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

/**
 * Ruby: the `def` line is the signature and there are no types to read, so
 * every method is `inferred`. A method under a bare `private` or
 * `protected` line, or written `private def`, is not reachable.
 *
 * Not read: `attr_reader` and friends, and `private :name` after the fact.
 * Both are real contract and both are metaprogramming a line scanner cannot
 * follow; leaving them out under-reports rather than misreports.
 */
export function rubyShapes(source: string): SymbolShape[] | undefined {
  const ranges = rubySymbolRanges(source);
  if (ranges === undefined) {
    return undefined;
  }
  const stripped = source.split("\n").map((line) => line.replace(/#.*$/u, ""));
  const headOf = (line: number): string => normalize(stripped[line - 1] ?? "");
  const DECLARATION =
    /^(?:(private|protected|public)\s+)?(def|class|module)\s+(self\.)?([A-Za-z_][\w?!=]*|[-+*\/%<>=!~^&|\[\]]+)(.*)$/u;
  const parse = (head: string) => {
    const match = DECLARATION.exec(head);
    return match === null
      ? undefined
      : {
          modifier: match[1],
          keyword: match[2] ?? "",
          singleton: match[3] !== undefined,
          rest: (match[5] ?? "").replace(/;.*$/u, ""),
        };
  };
  /** Whether a `def` is reachable, given the bare access lines above it. */
  const isPublic = (range: (typeof ranges)[number]): boolean => {
    const head = parse(headOf(range.startLine));
    if (head === undefined || head.modifier === "private" || head.modifier === "protected") {
      return false;
    }
    const enclosing = ranges.find(
      (other) =>
        other !== range &&
        other.startLine < range.startLine &&
        other.endLine >= range.endLine,
    );
    let access = "public";
    for (let line = (enclosing?.startLine ?? 0) + 1; line < range.startLine; line += 1) {
      const marker = /^\s*(private|protected|public)\s*$/u.exec(stripped[line - 1] ?? "");
      if (marker?.[1] !== undefined) {
        access = marker[1];
      }
    }
    return access === "public";
  };
  const signatureOf = (rest: string): string => {
    const parameters = normalize(rest);
    return parameters === "" || parameters.startsWith("(") ? parameters : `(${parameters})`;
  };
  const pieces = new Map<string, Piece[]>();
  for (const range of ranges) {
    const head = parse(headOf(range.startLine));
    if (head === undefined) {
      continue;
    }
    if (head.keyword === "def") {
      if (!isPublic(range)) {
        continue;
      }
      const signature = signatureOf(head.rest);
      pieces.set(range.name, [
        ...(pieces.get(range.name) ?? []),
        { kind: "function", shape: signature, comparable: signature, inferred: true },
      ]);
      continue;
    }
    const members = ranges
      .filter(
        (other) =>
          other !== range &&
          other.startLine > range.startLine &&
          other.endLine <= range.endLine &&
          parse(headOf(other.startLine))?.keyword === "def" &&
          isPublic(other),
      )
      .map((other) => {
        const member = parse(headOf(other.startLine));
        return `${member?.singleton === true ? "self." : ""}${other.name}${signatureOf(member?.rest ?? "")}`;
      })
      .sort((left, right) => left.localeCompare(right));
    const heritage = normalize(head.rest);
    const shape = `${heritage} {${members.join("; ")}}`.trim();
    pieces.set(range.name, [
      ...(pieces.get(range.name) ?? []),
      {
        kind: head.keyword === "class" ? "class" : "type",
        shape,
        comparable: shape,
        inferred: false,
      },
    ]);
  }
  return [...pieces]
    .map(([symbol, list]) => assemble(symbol, list))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

/** The Python reader's declarations, hashed the way every other shape is. */
export function pythonShapes(read: readonly PythonShape[]): SymbolShape[] {
  return read
    .map((entry) => ({
      symbol: entry.symbol,
      kind: entry.kind,
      shape: entry.shape,
      digest: digestOf(`${entry.kind} ${entry.comparable}`),
      ...(entry.inferred ? { inferred: true } : {}),
    }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

// Re-exported so a caller with a masked file in hand can share it.
export { blankBraceLanguage };
