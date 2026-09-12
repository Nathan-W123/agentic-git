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
 * Two forms are kept of everything. The `shape` is for a person: whitespace
 * collapsed, otherwise as written. The `comparable` is what is hashed, and
 * it is canonical: no whitespace beside punctuation, no parameter names
 * where a caller cannot use them, a default's *value* replaced by a marker
 * that says only that there is one. A change to a caller-visible contract
 * must move the digest; a change to formatting, a body, a private member, a
 * positional parameter's name or a default value must not.
 *
 * The contract is the one `symbol-ranges.ts` keeps. An array means "these are
 * the shapes"; `undefined` means the masker could not read the file, and the
 * caller must keep saying the shapes are unknown rather than empty.
 */

import { digestOf, type ShapeKind, type SymbolShape } from "./contract-shape.js";
import {
  blankBraceLanguage,
  braceDeclarations,
  isAssignment,
  looksLikeTypeArgument,
  rubyDeclarations,
  type BraceLanguage,
  type PythonShape,
  type RubyDeclaration,
} from "./symbol-ranges.js";

/**
 * Languages where a caller passes by position, so a parameter's name is not
 * contract. Go has no named arguments either.
 */
const POSITIONAL = new Set<BraceLanguage>(["java", "c", "cpp", "rust", "go"]);

/** Languages whose types are written before the name, `Type name`. */
const TYPE_FIRST = new Set<BraceLanguage>(["java", "c", "cpp"]);

/**
 * Code-point order. `String#localeCompare` follows the process locale, and
 * under da_DK or cs_CZ the same file sorted its members differently from
 * the same file under en_US; a digest is a function of the source only.
 */
function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The readable form: whitespace collapsed, a wrapped parameter list pulled
 * back onto one line, a trailing comma or separator dropped.
 */
function normalize(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .replace(/([(\[])\s+/gu, "$1")
    .replace(/\s+([)\],;])/gu, "$1")
    .replace(/,(?=[)\]])/gu, "")
    .replace(/,(?! |$)/gu, ", ")
    .replace(/\s*([,;])\s*$/u, "")
    .trim();
}

/**
 * The hashed form: no whitespace beside punctuation at all, so `char *s`,
 * `char* s`, `x : Int` and a gofmt'd multi-line parameter list compare as
 * what they are. Whitespace between two words stays: `unsigned int` is not
 * `unsignedint`.
 */
function canonical(text: string): string {
  return normalize(text).replace(/\s*([^\w\s$])\s*/gu, "$1");
}

/**
 * Bracket depth, the way `headEndOf` counts it: a stack, so a `<` that was
 * a comparison is discarded when the parenthesis around it closes; `<` only
 * where a type argument could follow; the `>` of `->` and `=>` never a
 * closer. The first version counted every `<` and `>`, and the `>` of an
 * arrow drove the depth negative — after which commas stopped splitting and
 * `=` stopped cutting, so a closure parameter's default vanished from the
 * comparable and a Scala function type was cut off at its arrow.
 */
class Brackets {
  private readonly openers: string[] = [];

  get depth(): number {
    return this.openers.length;
  }

  /** Whether the stack holds only braces, so a `(` here is still a parameter list. */
  get onlyBraces(): boolean {
    return this.openers.every((opener) => opener === "{");
  }

  step(text: string, at: number, angles = true): void {
    const character = text[at];
    if (character === "(" || character === "[" || character === "{") {
      this.openers.push(character);
      return;
    }
    if (angles && character === "<" && looksLikeTypeArgument(text, at)) {
      this.openers.push("<");
      return;
    }
    if (character === ")" || character === "]" || character === "}") {
      const wanted = character === ")" ? "(" : character === "]" ? "[" : "{";
      if (!this.openers.includes(wanted)) {
        return;
      }
      while (this.openers.length > 0 && this.openers.pop() !== wanted) {
        // Unclosed angle brackets inside are not brackets.
      }
      return;
    }
    if (
      character === ">" &&
      this.openers.at(-1) === "<" &&
      text[at - 1] !== "-" &&
      text[at - 1] !== "="
    ) {
      this.openers.pop();
    }
  }
}

/** Split on a separator at bracket depth zero. */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  const brackets = new Brackets();
  let current = "";
  for (let at = 0; at < text.length; at += 1) {
    brackets.step(text, at);
    if (text[at] === separator && brackets.depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += text[at];
  }
  out.push(current);
  return out.map((part) => part.trim()).filter((part) => part !== "");
}

/** The first `needle` at bracket depth zero, or -1. */
function topLevelIndex(text: string, needle: string): number {
  const brackets = new Brackets();
  for (let at = 0; at < text.length; at += 1) {
    brackets.step(text, at);
    if (brackets.depth === 0 && text[at] === needle) {
      return at;
    }
  }
  return -1;
}

/**
 * The index of the `=` that begins a value — an initializer, a default, an
 * expression body — or -1. Not one inside brackets, and not one that is
 * part of an operator: `isAssignment` knows `==`, `+=`, `operator=` and
 * the two readings of `=>`.
 */
function assignmentAt(text: string, language: BraceLanguage): number {
  const brackets = new Brackets();
  for (let at = 0; at < text.length; at += 1) {
    brackets.step(text, at);
    if (brackets.depth === 0 && text[at] === "=" && isAssignment(text, at, language === "csharp")) {
      return at;
    }
  }
  return -1;
}

/**
 * Whether the text after a C++ declarator's `=` is a specifier a caller
 * depends on rather than a value: `= delete`, `= default`, and the `= 0`
 * of a pure virtual function — only after a parameter list, since a
 * field's `= 0` is an initializer like any other.
 */
function isSpecifier(declarator: string, value: string): boolean {
  if (value === "delete" || value === "default") {
    return true;
  }
  return value === "0" && /\)(?:\s*(?:const|volatile|noexcept|override|final|&&?))*$/u.test(declarator);
}

/**
 * A member with its value cut. An initializer or an expression body is a
 * value, not a contract — except a C++ `= delete`, `= default` or `= 0`,
 * which say what a caller may do, and an alias, whose target is the whole
 * point.
 */
function withoutInitializer(line: string, language: BraceLanguage): string {
  const at = assignmentAt(line, language);
  if (at === -1) {
    return line;
  }
  const value = line.slice(at + 1).trim();
  if (language === "cpp" && isSpecifier(line.slice(0, at).trim(), value)) {
    return line;
  }
  if (
    /^(?:using|typedef)\b/u.test(line) ||
    (language === "rust" && /^(?:pub(?:\([^)]*\))?\s+)?type\b/u.test(line)) ||
    (language === "go" && /^type\b/u.test(line))
  ) {
    return line;
  }
  return line.slice(0, at).trim();
}

/**
 * Leading annotations, attributes and the like removed: `@Inject`,
 * `[JsonIgnore]`, `#[serde(default)]`, `[[nodiscard]]`,
 * `__attribute__((...))`. They are not what a caller writes, and the
 * modifier that decides reachability may hide behind one.
 */
function stripAttributes(text: string): string {
  let rest = text.trimStart();
  for (;;) {
    const marker = /^(?:@[\w.:]+|#\[|\[\[|\[|__attribute__\s*\()/u.exec(rest);
    if (marker === null) {
      return rest;
    }
    let at = marker[0].length;
    if (marker[0].startsWith("@")) {
      if (rest[at] === "(") {
        at = balancedEnd(rest, at);
      }
    } else {
      at = balancedEnd(rest, at - 1);
      if (marker[0] === "[[" && rest[at] === "]") {
        at += 1;
      }
    }
    rest = rest.slice(at).trimStart();
  }
}

/** The offset just past the bracket group opening at `open`. */
function balancedEnd(text: string, open: number): number {
  const opener = text[open] ?? "";
  const closer = opener === "(" ? ")" : opener === "[" ? "]" : "}";
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === opener) {
      depth += 1;
    } else if (text[at] === closer) {
      depth -= 1;
      if (depth === 0) {
        return at + 1;
      }
    }
  }
  return text.length;
}

/** The C-family keywords that are complete types on their own. */
const TYPE_KEYWORDS = new Set([
  "int",
  "char",
  "short",
  "long",
  "float",
  "double",
  "void",
  "bool",
  "boolean",
  "byte",
  "signed",
  "unsigned",
  "auto",
  "size_t",
  "wchar_t",
  "_Bool",
]);

/** The C-family words that qualify a type without being one. */
const QUALIFIERS = new Set([
  "const",
  "volatile",
  "struct",
  "union",
  "enum",
  "restrict",
  "register",
  "static",
  "inline",
  "final",
  "typename",
  "class",
]);

/** Go's type-introducing keywords, which are never a parameter's name. */
const GO_TYPE_KEYWORDS = /^(?:chan|func|map|struct|interface)\b/u;

/**
 * A parameter with its name taken out, for a language where a caller
 * cannot use the name.
 *
 * `Type name` languages drop the trailing identifier and only that: the
 * `*` of `char *s` and the `&` of `const Money &m` stay on the type (the
 * first version dropped the last whitespace-separated token, so `char *s`
 * and `char s` hashed the same), an `int a[]` becomes `int[]`, and `void
 * (*f)(int)` is left as written. A parameter that is only a type — `int`,
 * `unsigned int`, `const Money` — is left alone. Rust drops everything
 * before the `:`.
 */
function withoutName(parameter: string, language: BraceLanguage): string {
  if (language === "rust") {
    if (/^(?:&\s*(?:'\w+\s+)?(?:mut\s+)?)?(?:mut\s+)?self$/u.test(parameter)) {
      return parameter;
    }
    const colon = topLevelIndex(parameter, ":");
    return colon === -1 ? parameter : parameter.slice(colon + 1).trim();
  }
  if (!TYPE_FIRST.has(language) || /[()]/u.test(parameter)) {
    return parameter;
  }
  // `final` on a Java parameter binds the local name and says nothing to a
  // caller — but it left the name in the comparable form, so adding it, or
  // renaming a parameter that had it, moved the digest.
  if (language === "java") {
    parameter = parameter.replace(/^(?:final\s+|@[\w.]+(?:\([^)]*\))?\s+)+/u, "");
  }
  const array = /^(.*?)((?:\s*\[[^\]]*\])+)$/u.exec(parameter);
  const core = (array?.[1] ?? parameter).trim();
  const suffix = array?.[2]?.replace(/\s+/gu, "") ?? "";
  const split = /^(.*?[\s*&])([A-Za-z_]\w*)$/u.exec(core);
  if (split?.[1] === undefined || split[2] === undefined || TYPE_KEYWORDS.has(split[2])) {
    return parameter;
  }
  const prefix = split[1].split(/[\s*&]+/u).filter((token) => token !== "");
  if (prefix.every((token) => QUALIFIERS.has(token) || token.startsWith("@"))) {
    return parameter;
  }
  return `${split[1].trim()}${suffix}`;
}

/**
 * A Go parameter list with the names out. Names come in groups — `a, b
 * int` — where a bare identifier takes the type of the next parameter
 * that has one, and a list is either all named or all unnamed.
 */
function goParameters(parts: readonly string[]): string[] {
  const named = parts.some(
    (part) => /^[A-Za-z_]\w*\s+\S/u.test(part) && !GO_TYPE_KEYWORDS.test(part),
  );
  if (!named) {
    return [...parts];
  }
  return parts.map((part, index) => {
    if (/^[A-Za-z_]\w*$/u.test(part)) {
      const typed = parts.slice(index + 1).find((later) => /\s/u.test(later));
      return typed === undefined ? part : typed.replace(/^[A-Za-z_]\w*\s+/u, "");
    }
    return part.replace(/^[A-Za-z_]\w*\s+/u, "");
  });
}

/**
 * A parameter as it is compared: the name out where it is not contract,
 * and a default's value replaced by a marker. That a parameter is optional
 * is contract; what it defaults to is a value, the same rule the Python
 * reader keeps.
 */
function comparableParameter(
  parameter: string,
  language: BraceLanguage,
  stripNames: boolean,
): string {
  const at = assignmentAt(parameter, language);
  let type = at === -1 ? parameter : parameter.slice(0, at).trim();
  if (stripNames) {
    type = withoutName(type, language);
    // A Go function-typed parameter has parameters of its own.
    if (language === "go" && /\(/u.test(type)) {
      type = comparableHead(type, language, true, false);
    }
  }
  return at === -1 ? type : `${type} = ?`;
}

/**
 * What follows an `=`, to the end of the statement it belongs to: the rest
 * of the line, and every line after it while a bracket is still open.
 */
function statementAfter(code: string, at: number): string {
  const lines = code.slice(at + 1).split("\n");
  const brackets = new Brackets();
  let out = "";
  for (const line of lines) {
    out += (out === "" ? "" : " ") + line;
    for (let index = 0; index < line.length; index += 1) {
      brackets.step(line, index);
    }
    if (brackets.depth === 0) {
      break;
    }
  }
  return normalize(out);
}

/**
 * A head or a member in its comparable form: every parameter list rebuilt
 * from its parameters, then canonicalised.
 */
function comparableHead(
  text: string,
  language: BraceLanguage,
  stripNames: boolean,
  finish = true,
): string {
  const brackets = new Brackets();
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "(" && brackets.onlyBraces) {
      const close = balancedEnd(text, at);
      const inner = text.slice(at + 1, close - 1);
      const parts = splitTopLevel(inner, ",").map((part) =>
        comparableParameter(part, language, stripNames),
      );
      out += `(${(language === "go" && stripNames ? goParameters(parts) : parts).join(", ")})`;
      at = close - 1;
      continue;
    }
    brackets.step(text, at);
    out += text[at];
  }
  return finish ? canonical(out) : out;
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
 *
 * The modifier is looked for anywhere before the parameter list, not only
 * as the first word: `static private`, `final private` and `@Inject
 * private` are all private. Swift's `private(set)` hides only the setter.
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
  const modifiers = head
    .replace(/\b(?:private|protected|internal|fileprivate|public|open)\s*\(set\)/gu, "")
    .split(/[(=<{:]/u)[0] ?? "";
  return !/\b(?:private|protected|fileprivate)\b/u.test(modifiers);
}

/** What ends a member line and what may continue it onto the next. */
const CONTINUES_AFTER =
  /(?:[,=:.&|+<\[(]|->|=>|\b(?:throws|where|extends|implements|with|permits))$/u;
const CONTINUES_BEFORE =
  /(?:[{:.?&|+)\]>,=]|->|=>|(?:throws|where|extends|implements|with|permits)\b)/uy;
const BLANK = /\s*/uy;

/** Whether the next non-blank text after `at` continues the member before it. */
function continuesBefore(body: string, at: number): boolean {
  BLANK.lastIndex = at;
  BLANK.exec(body);
  CONTINUES_BEFORE.lastIndex = BLANK.lastIndex;
  return CONTINUES_BEFORE.test(body);
}

/**
 * Text of a nested body `{...}` where a member keeps one level of it: a
 * Go field of anonymous struct type, a Rust enum's struct variant, a
 * Kotlin companion object, an inline C struct. Their fields are contract
 * and have no declaration of their own to be read from.
 */
function nestedRendering(
  before: string,
  inner: string,
  literal: string | undefined,
  after: string,
  language: BraceLanguage,
  kind: ShapeKind,
  budget: number,
): string | undefined {
  if (budget === 0) {
    return undefined;
  }
  const head = stripAttributes(before).trim();
  let innerKind: ShapeKind | undefined;
  let publicByDefault = false;
  if (language === "go" && /\b(?:struct|interface)$/u.test(head)) {
    innerKind = "type";
  } else if (language === "rust" && kind === "enum" && /(?:^|\s)[A-Za-z_]\w*$/u.test(head)) {
    innerKind = "type";
    publicByDefault = true;
  } else if (language === "kotlin" && /\bcompanion\s+object$/u.test(head)) {
    innerKind = "class";
  } else if (
    (language === "c" || language === "cpp") &&
    /\b(?:struct|union|enum)(?:\s+[A-Za-z_]\w*)?$/u.test(head) &&
    (after !== "" || /\b(?:struct|union|enum)$/u.test(head))
  ) {
    // An inline definition — anonymous, or with a declarator after it — is
    // not a declaration of its own, so its fields are read here.
    innerKind = /\benum$/u.test(head) ? "enum" : "type";
  }
  if (innerKind === undefined) {
    return undefined;
  }
  const { members } = membersOf(
    inner,
    literal,
    language,
    innerKind,
    "public",
    true,
    budget - 1,
    publicByDefault,
  );
  return members.length === 0 ? undefined : `{${members.join("; ")}}`;
}

/**
 * The members of a type body, one per line, nested bodies removed.
 *
 * A member ends at a `;`, at a `,` where the language separates members
 * with one, or at a newline — but only at bracket depth zero and only where
 * neither the line's end nor the next line's start says the member goes
 * on. The first version split every newline, so a wrapped parameter list
 * became several garbage members and the digest moved on a reformat.
 *
 * Sorted, because moving a field is not a contract change — except for an
 * enum, where a member with no explicit value takes it from its position.
 * `literal` is the body with its string literals restored: an enum's raw
 * values are its contract, and a line that ends in a string does not end
 * in the `=` before it.
 */
function membersOf(
  body: string,
  literal: string | undefined,
  language: BraceLanguage,
  kind: ShapeKind,
  defaultAccess: string,
  classLike: boolean,
  budget = 1,
  publicByDefault = false,
): { members: string[]; comparable: string[] } {
  const segments: string[] = [];
  // `current` is the blanked text and decides structure; `shown` has the
  // literals back and is what an enum member is read from — and what says
  // whether a line ends in `=`, since a blanked `= "x"` ends in spaces.
  let current = "";
  let shown = "";
  let afterAssign = false;
  let brackets = new Brackets();
  const flush = (): void => {
    if (current.trim() !== "") {
      segments.push(kind === "enum" ? shown : current);
    }
    current = "";
    shown = "";
    afterAssign = false;
    brackets = new Brackets();
  };
  const commaSeparates = (): boolean => {
    if (language === "rust") {
      // Fields and variants end in commas; a `where` clause has some too.
      return !/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern)\s+)*fn\b/u.test(current);
    }
    return kind === "enum" && language !== "swift";
  };
  for (let at = 0; at < body.length; at += 1) {
    const character = body[at] ?? "";
    if (brackets.depth === 0 && character === "{") {
      const close = balancedEnd(body, at);
      const after = /^[ \t]*([A-Za-z_]\w*)?/u.exec(body.slice(close))?.[1] ?? "";
      const nested =
        nestedRendering(
          current,
          body.slice(at + 1, close - 1),
          literal?.slice(at + 1, close - 1),
          after,
          language,
          kind,
          budget,
        ) ?? "{}";
      current += nested;
      shown += nested;
      at = close - 1;
      // A body ends its member: `void a() {} void b() {}` is two. Only a C
      // struct definition carries on into a declarator, `struct { } in;`.
      if (
        /^[ \t]*[A-Za-z_@#\[]/u.test(body.slice(close)) &&
        !((language === "c" || language === "cpp") && /\b(?:struct|union|enum)\b/u.test(current))
      ) {
        flush();
      }
      continue;
    }
    if (brackets.depth === 0) {
      if (character === ";" || (character === "," && commaSeparates())) {
        flush();
        continue;
      }
      if (character === "\n") {
        const trimmed = shown.trimEnd();
        if (
          trimmed !== "" &&
          !CONTINUES_AFTER.test(trimmed) &&
          !continuesBefore(body, at + 1)
        ) {
          flush();
          continue;
        }
        current += " ";
        shown += " ";
        continue;
      }
      if (character === "=" && kind !== "enum" && isAssignment(body, at, language === "csharp")) {
        afterAssign = true;
      }
    }
    // Past an `=` the text is a value, where `a < b` is a comparison.
    brackets.step(body, at, !afterAssign);
    current += character;
    shown += literal?.[at] ?? character;
  }
  flush();

  const members: string[] = [];
  const comparable: string[] = [];
  let access = defaultAccess;
  for (const raw of segments) {
    let line = normalize(stripAttributes(raw));
    // `#region`, `#if`, `#include`: not members.
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    // C++ access labels apply to everything after them, on their own line
    // or as a prefix of the first member.
    const label = /^(public|private|protected)\s*:(?!:)\s*/u.exec(line);
    if (label?.[1] !== undefined) {
      access = label[1];
      line = line.slice(label[0].length);
    }
    if (kind !== "enum") {
      line = withoutInitializer(line, language);
    }
    // A trailing body is the one thing that is never contract.
    line = normalize(line.replace(/\s*\{\}$/u, ""));
    if (language === "kotlin") {
      // A property's accessors are read with the property, on the same
      // line or the next; an `init` block is only a body.
      if (/^(?:(?:private|protected|internal)\s+)?(?:get|set)\b/u.test(line) || line === "init") {
        continue;
      }
      line = line.replace(/\s+get\(\)$/u, "");
    }
    // PHP's default visibility is spelled out, so the two spellings agree.
    if (language === "php" && /^(?:(?:static|final|abstract)\s+)*function\b/u.test(line)) {
      line = `public ${line}`;
    }
    if (line === "") {
      continue;
    }
    // Every variant of an enum, every item of a trait and every item of a
    // trait impl is as public as the type; a struct field or an inherent
    // impl item needs its own `pub`.
    if (
      language === "rust" &&
      kind !== "enum" &&
      kind !== "interface" &&
      !publicByDefault &&
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
    // Go's grouped fields, `X, Y int`, are the fields `X int` and `Y int`.
    for (const member of language === "go" ? goFields(line) : [line]) {
      members.push(member);
      comparable.push(
        comparableHead(member, language, POSITIONAL.has(language) && !/\brecord\b/u.test(member)),
      );
    }
  }
  if (kind !== "enum") {
    members.sort(byCodePoint);
    comparable.sort(byCodePoint);
  }
  return { members, comparable };
}

/** A Go field line as the fields it declares. */
function goFields(line: string): string[] {
  if (!/,/u.test(line)) {
    return [line];
  }
  const parts = splitTopLevel(line, ",");
  const last = parts.at(-1) ?? "";
  const type = /^[A-Za-z_]\w*\s+(.+)$/u.exec(last)?.[1];
  if (type === undefined || !parts.slice(0, -1).every((part) => /^[A-Za-z_]\w*$/u.test(part))) {
    return [line];
  }
  return parts.map((part, index) => (index === parts.length - 1 ? part : `${part} ${type}`));
}

function kindOf(head: string, declared: "function" | "type"): ShapeKind {
  if (declared === "function") {
    return "function";
  }
  if (/^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\b/u.test(head)) {
    return "variable";
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
  head: string;
  comparableHead: string;
  /** Absent for a function or a variable; a type's members and their comparable forms. */
  members?: string[];
  comparableMembers?: string[];
  /** Whether member order is contract (an enum). */
  ordered: boolean;
  inferred: boolean;
}

/**
 * Several declarations under one name — overloads, a struct and its impl
 * blocks, a prototype and its definition — are one contract, in an order
 * that does not depend on where each was written.
 *
 * Blocks with the same head are one block: an inherent `impl` split in two,
 * a C# `partial class` in two halves, a Swift `extension` of a type declared
 * beside it. A caller sees the same members either way.
 */
function assemble(symbol: string, pieces: readonly Piece[], language?: BraceLanguage): SymbolShape {
  let list = pieces.map((piece) => ({
    ...piece,
    members: piece.members === undefined ? undefined : [...piece.members],
    comparableMembers:
      piece.comparableMembers === undefined ? undefined : [...piece.comparableMembers],
  }));
  if (language === "swift") {
    const primary = list.find(
      (piece) => piece.members !== undefined && !/^extension\b/u.test(piece.head),
    );
    if (primary?.members !== undefined && primary.comparableMembers !== undefined) {
      const kept: typeof list = [];
      for (const piece of list) {
        if (piece === primary || piece.members === undefined || !/^extension\b/u.test(piece.head)) {
          kept.push(piece);
          continue;
        }
        primary.members.push(...piece.members);
        primary.comparableMembers.push(...(piece.comparableMembers ?? []));
        // A conformance or a constraint is contract of its own; a bare
        // extension is only where its members were written.
        if (/:|\bwhere\b/u.test(piece.head)) {
          kept.push({ ...piece, members: [], comparableMembers: [] });
        }
      }
      list = kept;
    }
  }
  const merged = new Map<string, (typeof list)[number]>();
  for (const piece of list) {
    const key = `${piece.kind}\0${piece.comparableHead}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, piece);
      continue;
    }
    if (existing.members !== undefined && piece.members !== undefined) {
      existing.members = piece.ordered
        ? [...existing.members, ...piece.members]
        : [...new Set([...existing.members, ...piece.members])];
      existing.comparableMembers = piece.ordered
        ? [...(existing.comparableMembers ?? []), ...(piece.comparableMembers ?? [])]
        : [...new Set([...(existing.comparableMembers ?? []), ...(piece.comparableMembers ?? [])])];
    }
    existing.inferred = existing.inferred || piece.inferred;
  }
  const rendered = [...merged.values()].map((piece) => {
    if (piece.members === undefined) {
      return { ...piece, shape: piece.head, comparable: piece.comparableHead };
    }
    const members = piece.ordered ? piece.members : [...piece.members].sort(byCodePoint);
    const comparable = piece.ordered
      ? (piece.comparableMembers ?? [])
      : [...(piece.comparableMembers ?? [])].sort(byCodePoint);
    // A Ruby module has no heritage, so its head may be empty.
    return {
      ...piece,
      shape: `${piece.head} {${members.join("; ")}}`.trim(),
      comparable: `${piece.comparableHead} {${comparable.join("; ")}}`.trim(),
    };
  });
  const sorted = rendered.sort((left, right) => byCodePoint(left.comparable, right.comparable));
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

/** `code` between `from` and `to`, with the string literals inside put back. */
function restoreStrings(
  source: string,
  code: string,
  strings: readonly [number, number][],
  from: number,
  to: number,
): string {
  let out = "";
  let span = 0;
  for (let at = from; at < to; at += 1) {
    while (span < strings.length && (strings[span]?.[1] ?? 0) <= at) {
      span += 1;
    }
    const inside = strings[span];
    out += inside !== undefined && inside[0] <= at ? source[at] : code[at];
  }
  return out;
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
  const { code, declarations, strings } = read;
  const pieces = new Map<string, Piece[]>();
  for (const declaration of declarations) {
    let head = normalize(stripAttributes(code.slice(declaration.start, declaration.headEnd)));
    const kind = kindOf(head, declaration.declared);
    // A PHP method with no modifier is public; the two spellings are one
    // head, as they are one member of the class above.
    if (
      language === "php" &&
      kind === "function" &&
      /^(?:(?:static|final|abstract)\s+)*function\b/u.test(head) &&
      declarations.some(
        (other) =>
          other.declared === "type" &&
          other.open !== undefined &&
          other.close !== undefined &&
          other.open < declaration.start &&
          other.close > declaration.start,
      )
    ) {
      head = `public ${head}`;
    }
    // C++ members are private until a label says otherwise — in a class. A
    // struct, a union and a namespace start public.
    const enclosingAccess =
      language === "cpp" && /^(?:template\s*<[^>]*>\s*)?class\b/u.test(head)
        ? "private"
        : "public";
    if (!reachable(head, declaration.name, language, declaration.access, false)) {
      continue;
    }
    // A C++ function's head ends at its `=`; what follows is contract when
    // it is `delete`, `default` or a pure virtual's `0`.
    if (language === "cpp" && kind === "function" && declaration.terminator === "=") {
      const end = code.indexOf(";", declaration.headEnd);
      const value = code.slice(declaration.headEnd + 1, end === -1 ? undefined : end).trim();
      if (isSpecifier(head, value)) {
        head = `${head} = ${value}`;
      }
    }
    // A type alias is what it stands for. `type Id = String` has no body, so
    // read as an ordinary type it hashed as `type Id {}` — the same for
    // every alias in the file, and unmoved when the aliased type changed.
    if (declaration.terminator === "=" && /(?:^|\s)type\s/u.test(head)) {
      const aliased = `${head} = ${statementAfter(code, declaration.headEnd)}`;
      pieces.set(declaration.name, [
        ...(pieces.get(declaration.name) ?? []),
        {
          kind: "type",
          head: aliased,
          comparableHead: canonical(aliased),
          ordered: false,
          inferred: false,
        },
      ]);
      continue;
    }
    // A Java record's components are its accessors, so their names stay.
    const stripNames = POSITIONAL.has(language) && !/\brecord\b/u.test(head);
    const comparable = comparableHead(head, language, stripNames);
    if (kind === "function" || kind === "variable") {
      pieces.set(declaration.name, [
        ...(pieces.get(declaration.name) ?? []),
        {
          kind,
          head,
          comparableHead: comparable,
          ordered: false,
          inferred: returnInferred(head, language, declaration.terminator, declaration.name),
        },
      ]);
      continue;
    }
    const { open, close } = declaration;
    const body = open === undefined || close === undefined ? "" : code.slice(open + 1, close);
    const literal =
      open === undefined || close === undefined
        ? undefined
        : restoreStrings(source, code, strings, open + 1, close);
    const { members, comparable: comparableMembers } = membersOf(
      body,
      literal,
      language,
      kind,
      enclosingAccess,
      !/\bnamespace\b/u.test(head),
      1,
      language === "rust" && /^impl\b.*\bfor\b/u.test(head),
    );
    pieces.set(declaration.name, [
      ...(pieces.get(declaration.name) ?? []),
      {
        kind,
        head,
        comparableHead: comparable,
        members,
        comparableMembers,
        ordered: kind === "enum",
        inferred: false,
      },
    ]);
  }
  return [...pieces]
    .map(([symbol, list]) => assemble(symbol, list, language))
    .sort((left, right) => byCodePoint(left.symbol, right.symbol));
}

/** Offsets of every `separator` at bracket depth zero. */
function topLevelOffsets(text: string, separator: string): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at] ?? "";
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (character === separator && depth === 0) {
      out.push(at);
    }
  }
  return out;
}

/**
 * A source line with its comment blanked, given the masked line beside it.
 *
 * The masker blanks comments and strings alike, and the readable shape
 * wants the strings back. A blanked run that begins with `#` in the source
 * was a comment; any other began with a quote, a `%` or a `/` and is kept.
 * A comment that directly follows a string with nothing but space between
 * them is one run with the string and survives — in the readable form only.
 */
function rubyWithoutComments(raw: string, code: string): string {
  const out = raw.split("");
  let at = 0;
  while (at < raw.length) {
    if (code[at] !== " " || raw[at] === " ") {
      at += 1;
      continue;
    }
    let end = at;
    while (end < raw.length && code[end] === " ") {
      end += 1;
    }
    if (raw[at] === "#") {
      for (let blank = at; blank < end; blank += 1) {
        out[blank] = " ";
      }
    }
    at = end;
  }
  return out.join("");
}

/** A Ruby parameter list: as written, and with default values reduced to `?`. */
function rubySignature(
  rawRest: string,
  codeRest: string,
): { shape: string; comparable: string } {
  const start = codeRest.search(/\S/u);
  if (start === -1) {
    return { shape: "", comparable: "" };
  }
  let end = codeRest.length;
  while (end > start && /\s/u.test(codeRest[end - 1] ?? "")) {
    end -= 1;
  }
  let raw = rawRest.slice(start, end);
  let code = codeRest.slice(start, end);
  if (code.startsWith("(") && code.endsWith(")")) {
    raw = raw.slice(1, -1);
    code = code.slice(1, -1);
  }
  const shapes: string[] = [];
  const comparables: string[] = [];
  let from = 0;
  for (const to of [...topLevelOffsets(code, ","), code.length]) {
    const parameterRaw = raw.slice(from, to);
    const parameterCode = code.slice(from, to);
    from = to + 1;
    const shape = normalize(parameterRaw);
    if (shape === "") {
      continue;
    }
    shapes.push(shape);
    // A default's value is not contract; that there is one is. `size = 20`
    // and `size = 50` accept the same calls, and so do `currency: "usd"`
    // and `currency: "eur"`. The parameter list is read from the masked
    // text, so a `,` or `=` inside the default is not a boundary.
    const equals = topLevelOffsets(parameterCode, "=")[0];
    if (equals !== undefined) {
      comparables.push(`${normalize(parameterRaw.slice(0, equals))}?`);
      continue;
    }
    const keyword = /^\s*([A-Za-z_]\w*[?!]?):/u.exec(parameterCode);
    if (keyword?.[1] !== undefined) {
      const given = parameterRaw.slice(keyword[0].length).trim() !== "";
      comparables.push(`${keyword[1]}:${given ? "?" : ""}`);
      continue;
    }
    comparables.push(shape);
  }
  return {
    shape: `(${shapes.join(", ")})`,
    comparable: `(${comparables.join(", ")})`,
  };
}

/**
 * Ruby: the `def` line is the signature and there are no types to read, so
 * every method is `inferred`. A method the scanner marked unreachable — a
 * bare `private` or `protected` line in its own scope, or `private def` —
 * is left out.
 *
 * The head is read from the masked text beside the source, so a `#` or a
 * `;` inside a default string is neither a comment nor the end of the
 * head, and a parameter list that continues over several lines is read to
 * its closing parenthesis. Each class is shaped from the defs written
 * directly inside that occurrence of it, so two classes with one name in
 * two modules do not lend each other members.
 *
 * Not read: `attr_reader` and friends, and `private :name` after the fact.
 * Both are real contract and both are metaprogramming a line scanner cannot
 * follow; leaving them out under-reports rather than misreports.
 */
export function rubyShapes(source: string): SymbolShape[] | undefined {
  const read = rubyDeclarations(source);
  if (read === undefined) {
    return undefined;
  }
  const { code, declarations } = read;
  const text = source
    .split("\n")
    .map((line, at) => rubyWithoutComments(line, code[at] ?? ""));
  /** What follows the name: the parameter list or the heritage, to the body. */
  const restOf = (declaration: RubyDeclaration): { raw: string; code: string } => {
    let raw = "";
    let masked = "";
    for (let line = declaration.startLine; line <= declaration.endLine; line += 1) {
      raw += `${raw === "" ? "" : "\n"}${text[line - 1] ?? ""}`;
      masked += `${masked === "" ? "" : "\n"}${code[line - 1] ?? ""}`;
      // A `;` at depth zero ends the head; the body follows it.
      const semicolon = topLevelOffsets(masked.slice(declaration.nameEnd), ";")[0];
      if (semicolon !== undefined) {
        raw = raw.slice(0, declaration.nameEnd + semicolon);
        masked = masked.slice(0, declaration.nameEnd + semicolon);
        break;
      }
      // An open bracket, a trailing comma or a backslash continue the head
      // on the next line.
      let depth = 0;
      for (const character of masked.slice(declaration.nameEnd)) {
        if ("([{".includes(character)) {
          depth += 1;
        } else if (")]}".includes(character)) {
          depth -= 1;
        }
      }
      if (depth <= 0 && !/[,\\]$/u.test(masked.trimEnd())) {
        break;
      }
    }
    return { raw: raw.slice(declaration.nameEnd), code: masked.slice(declaration.nameEnd) };
  };
  const signatureOf = (declaration: RubyDeclaration) => {
    const rest = restOf(declaration);
    return rubySignature(rest.raw, rest.code);
  };
  const pieces = new Map<string, Piece[]>();
  for (const [index, declaration] of declarations.entries()) {
    if (declaration.keyword === "def") {
      if (!declaration.reachable) {
        continue;
      }
      const signature = signatureOf(declaration);
      // A method has no members, so it carries none: a piece with a member
      // list renders as `(x) {}`, which is not a signature anyone wrote.
      pieces.set(declaration.name, [
        ...(pieces.get(declaration.name) ?? []),
        {
          kind: "function",
          head: signature.shape,
          comparableHead: signature.comparable,
          ordered: false,
          inferred: true,
        },
      ]);
      continue;
    }
    const members = declarations
      .filter(
        (other) => other.parent === index && other.keyword === "def" && other.reachable,
      )
      .map((other) => {
        const signature = signatureOf(other);
        const prefix = `${other.singleton ? "self." : ""}${other.name}`;
        return { shape: prefix + signature.shape, comparable: prefix + signature.comparable };
      })
      // Code-point order, as everywhere else, and on the pair together so
      // the readable form lists its members in the order the hashed one does.
      .sort((left, right) => byCodePoint(left.comparable, right.comparable));
    const heritage = normalize(restOf(declaration).raw);
    // The body is rendered here rather than handed to `assemble` as members:
    // `assemble` folds pieces that share a head into one, and two classes
    // with one name in two modules are two contracts, not one reopened
    // class. Rendered, their heads differ and both survive.
    pieces.set(declaration.name, [
      ...(pieces.get(declaration.name) ?? []),
      {
        kind: declaration.keyword === "class" ? "class" : "type",
        head: `${heritage} {${members.map((member) => member.shape).join("; ")}}`.trim(),
        comparableHead: `${heritage} {${members
          .map((member) => member.comparable)
          .join("; ")}}`.trim(),
        ordered: false,
        inferred: false,
      },
    ]);
  }
  return [...pieces]
    .map(([symbol, list]) => assemble(symbol, list))
    .sort((left, right) => byCodePoint(left.symbol, right.symbol));
}

/**
 * The Python reader's declarations, hashed the way every other shape is.
 *
 * Several definitions under one name — an `@overload` set, a def on each
 * branch of a module-level `if` — are one contract, assembled the way a
 * brace language's overloads are. Left as several entries they compared
 * each `before` entry to whichever `after` entry came last, and an
 * unchanged file drifted against itself.
 *
 * The reader renders a class body itself, members and their order included,
 * so every entry arrives as one head with nothing left for `assemble` to
 * join or sort — an enum's members stay where the file put them.
 */
export function pythonShapes(read: readonly PythonShape[]): SymbolShape[] {
  const pieces = new Map<string, Piece[]>();
  for (const entry of read) {
    // The same signature written on each branch of a platform switch is one
    // signature. Kept once per branch it hashed as "() -> str | () -> str",
    // and dropping a branch moved the digest while a caller saw no change.
    // `assemble` keeps one piece per kind and head, so the repeat falls away
    // there, and two branches that disagree are both still contract.
    pieces.set(entry.symbol, [
      ...(pieces.get(entry.symbol) ?? []),
      {
        kind: entry.kind,
        head: entry.shape,
        comparableHead: entry.comparable,
        ordered: false,
        inferred: entry.inferred,
      },
    ]);
  }
  return [...pieces]
    .map(([symbol, list]) => assemble(symbol, list))
    .sort((left, right) => byCodePoint(left.symbol, right.symbol));
}

// Re-exported so a caller with a masked file in hand can share it.
export { blankBraceLanguage };
