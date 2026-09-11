/**
 * Where each declaration lives in a file, for languages the TypeScript
 * compiler cannot read.
 *
 * Symbol-level admission needs one thing from a file: the line span of each
 * declaration in it. TypeScript and JavaScript get that from a real AST, and
 * every other language got nothing — so two agents touching one Python or Go
 * file could only ever be arbitrated at the path, and one of them queued.
 *
 * The contract every extractor here keeps is the one the callers already
 * depend on, and it is asymmetric on purpose:
 *
 *   - an array, possibly empty, means "this file was read and these are its
 *     declarations". Empty is a statement: the file declares nothing.
 *   - `undefined` means "no idea". Callers treat that pessimistically and
 *     withhold the whole file, which is exactly what happens today.
 *
 * So an extractor that is unsure must say so rather than guess. A range that
 * is too small is the one genuinely harmful answer: it grants a second agent
 * lines the holder is working in. Every scanner below therefore abandons the
 * whole file on anything it cannot account for — unbalanced brackets, a
 * declaration whose body it cannot find — rather than returning a partial
 * answer that reads as complete.
 */

// Type-only, so the cycle with `index.ts` is erased at compile time.
import type { SymbolRange } from "./index.js";

/** Languages whose declarations are delimited by braces. */
export type BraceLanguage =
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "c"
  | "cpp"
  | "php"
  | "swift"
  | "kotlin"
  | "scala";

/*
 * Leading indentation is `[ \t]*`, never `\s*`.
 *
 * `\s` matches a newline, so under the `m` flag `^\s*func` anchors at the
 * start of some earlier blank line and runs forward into the declaration —
 * which dates the symbol from the blank line above it, or from a comment that
 * blanking turned into whitespace. The span is then too large rather than too
 * small, so it withholds more than it should instead of less, but it is still
 * wrong and it reads as deliberate.
 */
interface BraceDialect {
  /** Sequences that begin a comment running to end of line. */
  lineComments: readonly string[];
  /** Quote characters that begin a string literal. */
  quotes: readonly string[];
  /**
   * Declarations worth owning, each capturing the name in group 1.
   *
   * Deliberately anchored to a line start with optional leading whitespace:
   * a declaration is a statement, and matching mid-line finds the same words
   * inside expressions.
   */
  declarations: readonly RegExp[];
  /**
   * Lines that belong to the declaration below them — decorators, attributes,
   * annotations. Editing one is editing the thing it is attached to, so the
   * range starts at the first of them rather than at the keyword.
   */
  attached: RegExp;
}

const ATTACHED_ANNOTATION = /^[ \t]*(?:@[\w.]|#\[|\[[A-Z])/u;

const DIALECTS: Record<BraceLanguage, BraceDialect> = {
  go: {
    lineComments: ["//"],
    quotes: ['"', "'", "`"],
    declarations: [
      /^[ \t]*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/gmu,
      /^[ \t]*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/gmu,
    ],
    attached: ATTACHED_ANNOTATION,
  },
  rust: {
    lineComments: ["//"],
    quotes: ['"'],
    declarations: [
      /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+|extern\s+"[^"]*"\s+)*fn\s+([A-Za-z_]\w*)/gmu,
      /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/gmu,
      /^[ \t]*impl(?:\s*<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/gmu,
    ],
    attached: ATTACHED_ANNOTATION,
  },
  java: {
    lineComments: ["//"],
    quotes: ['"', "'"],
    declarations: [
      /^[ \t]*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|synchronized|native|strictfp|default)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gmu,
      /^[ \t]*(?:(?:public|private|protected|static|final|abstract|synchronized|native|strictfp|default)\s+)+(?:<[^>]*>\s*)?[\w.<>\[\],? ]+\s+([A-Za-z_]\w*)\s*\([^;]*$/gmu,
    ],
    attached: ATTACHED_ANNOTATION,
  },
  csharp: {
    lineComments: ["//"],
    quotes: ['"', "'"],
    declarations: [
      /^[ \t]*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|record)\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/gmu,
      /^[ \t]*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|partial)\s+)+[\w.<>\[\],? ]+\s+([A-Za-z_]\w*)\s*\(/gmu,
    ],
    attached: ATTACHED_ANNOTATION,
  },
  c: {
    lineComments: ["//"],
    quotes: ['"', "'"],
    declarations: [
      /^[ \t]*(?:(?:static|inline|extern|const|unsigned|signed|struct|enum)\s+)*[A-Za-z_]\w*[\w \t*]*\s+\*?([A-Za-z_]\w*)\s*\([^;]*$/gmu,
      /^[ \t]*(?:typedef\s+)?(?:struct|union|enum)\s+([A-Za-z_]\w*)\s*\{/gmu,
    ],
    attached: /^[ \t]*#\s*\w/u,
  },
  cpp: {
    lineComments: ["//"],
    quotes: ['"', "'"],
    declarations: [
      /^[ \t]*(?:(?:static|inline|virtual|explicit|constexpr|const|extern|friend|template\s*<[^>]*>)\s+)*[\w:<>~ \t*&]*?([A-Za-z_~]\w*)\s*\([^;]*$/gmu,
      /^[ \t]*(?:class|struct|union|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/gmu,
      /^[ \t]*namespace\s+([A-Za-z_]\w*)/gmu,
    ],
    attached: /^[ \t]*(?:#\s*\w|\[\[)/u,
  },
  php: {
    lineComments: ["//", "#"],
    quotes: ['"', "'"],
    declarations: [
      /^[ \t]*(?:(?:final|abstract|public|private|protected|static|readonly)\s+)*function\s+&?([A-Za-z_]\w*)/gmu,
      /^[ \t]*(?:(?:final|abstract|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/gmu,
    ],
    attached: ATTACHED_ANNOTATION,
  },
  swift: {
    lineComments: ["//"],
    quotes: ['"'],
    declarations: [
      /^[ \t]*(?:(?:public|private|internal|fileprivate|open|static|final|override|mutating|convenience|required|@\w+)\s+)*func\s+([A-Za-z_]\w*)/gmu,
      /^[ \t]*(?:(?:public|private|internal|fileprivate|open|final|indirect)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/gmu,
    ],
    attached: ATTACHED_ANNOTATION,
  },
  kotlin: {
    lineComments: ["//"],
    quotes: ['"'],
    declarations: [
      /^[ \t]*(?:(?:public|private|internal|protected|open|final|abstract|override|suspend|inline|operator|tailrec|external|sealed|data|inner|companion)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.<>]+\.)?([A-Za-z_]\w*)/gmu,
      /^[ \t]*(?:(?:public|private|internal|protected|open|final|abstract|sealed|data|inner|value|annotation|companion)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/gmu,
    ],
    attached: ATTACHED_ANNOTATION,
  },
  scala: {
    lineComments: ["//"],
    quotes: ['"'],
    declarations: [
      /^[ \t]*(?:(?:private|protected|final|override|implicit|sealed|abstract|case|lazy)\s+)*def\s+([A-Za-z_]\w*)/gmu,
      /^[ \t]*(?:(?:private|protected|final|sealed|abstract|case|implicit)\s+)*(?:class|trait|object)\s+([A-Za-z_]\w*)/gmu,
    ],
    attached: ATTACHED_ANNOTATION,
  },
};

/**
 * What each dialect's declaration patterns declare, in the same order.
 *
 * A shape reads a function's head and a type's members, so the reader of a
 * match has to know which it found — and the C function pattern can contain
 * the word `struct` in a return type, so the keyword is not enough.
 */
const DECLARED: Record<BraceLanguage, readonly ("function" | "type")[]> = {
  go: ["function", "type"],
  rust: ["function", "type", "type"],
  java: ["type", "function"],
  csharp: ["type", "function"],
  c: ["function", "type"],
  cpp: ["function", "type", "type"],
  php: ["function", "type"],
  swift: ["function", "type"],
  kotlin: ["function", "type"],
  scala: ["function", "type"],
};

/**
 * Replaces every string and comment body with spaces, keeping line structure.
 *
 * Brace matching and declaration matching both have to happen on code rather
 * than on text that merely looks like code — a brace in a string literal or a
 * `func` in a comment would otherwise move every range after it. Blanking
 * rather than deleting keeps every offset and line number identical to the
 * original, so a match found here points at the real file.
 *
 * Returns `undefined` for a file that ends inside a string or block comment,
 * which means the dialect guessed wrong about how this file is quoted and
 * nothing after that point can be trusted.
 */
function blankNonCode(
  source: string,
  dialect: BraceDialect,
): string | undefined {
  const out = source.split("");
  let index = 0;
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== "\n") {
        out[at] = " ";
      }
    }
  };
  while (index < source.length) {
    const rest = source.slice(index);
    const line = dialect.lineComments.find((marker) => rest.startsWith(marker));
    if (line !== undefined) {
      const end = source.indexOf("\n", index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        return undefined;
      }
      blank(index, end + 2);
      index = end + 2;
      continue;
    }
    const quote = dialect.quotes.find((mark) => rest.startsWith(mark));
    if (quote !== undefined) {
      let at = index + quote.length;
      for (;;) {
        if (at >= source.length) {
          return undefined;
        }
        if (source[at] === "\\") {
          at += 2;
          continue;
        }
        if (source.startsWith(quote, at)) {
          at += quote.length;
          break;
        }
        // A newline inside a single-quoted literal means this was not a string
        // at all — an apostrophe in a comment the dialect does not know about,
        // or a Rust lifetime. Refusing the file is better than swallowing the
        // rest of it.
        if (source[at] === "\n" && quote !== "`") {
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

/** 1-based line number of an offset, from a prefix scan of newlines. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let at = 0; at < source.length; at += 1) {
    if (source[at] === "\n") {
      starts.push(at + 1);
    }
  }
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

/**
 * Declaration spans for a brace-delimited language.
 *
 * Each declaration is matched on blanked source, its body found by matching
 * the brace that opens it, and its start extended back over any annotation
 * lines immediately above. A declaration whose body cannot be found is
 * skipped; a file whose braces do not balance is abandoned entirely.
 */
/**
 * The blanker, for a caller that needs code rather than ranges.
 *
 * Same contract as everything above it: `undefined` means the dialect
 * guessed wrong about how this file is quoted, and nothing read from it can
 * be trusted.
 */
export function blankBraceLanguage(
  source: string,
  language: BraceLanguage,
): string | undefined {
  return blankNonCode(source, DIALECTS[language]);
}

export function braceSymbolRanges(
  source: string,
  language: BraceLanguage,
): SymbolRange[] | undefined {
  const dialect = DIALECTS[language];
  const code = blankNonCode(source, dialect);
  if (code === undefined) {
    return undefined;
  }
  let depth = 0;
  for (const character of code) {
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
    }
  }
  if (depth !== 0) {
    return undefined;
  }

  const starts = lineStarts(source);
  const lines = source.split("\n");
  const found = new Map<string, SymbolRange>();
  for (const pattern of dialect.declarations) {
    // Each pattern carries its own lastIndex across calls when reused, so it
    // is reset rather than trusted.
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined || match.index === undefined) {
        continue;
      }
      // Where the head ends decides what the body is. A `{` opens one; an
      // `=` opens an expression body that runs to the next declaration; a
      // `;`, a newline before another declaration, or the `}` of the
      // enclosing block means there is no body at all. The first version
      // took the next `{` in the file, so a body-less Kotlin declaration
      // swallowed whatever braced declaration came after it — a nested
      // type surfaced as top level, a real top-level type vanished, and the
      // duplicate-name refusal that depends on both was defeated.
      const headEnd = headEndOf(code, match.index, dialect);
      let close: number;
      if (code[headEnd] === "{") {
        const found = closingBrace(code, headEnd);
        if (found === undefined) {
          continue;
        }
        close = found;
      } else if (code[headEnd] === "=") {
        close = expressionBodyEnd(code, headEnd + 1, dialect);
      } else {
        close = Math.min(headEnd, code.length - 1);
      }
      let startLine = lineOf(starts, match.index);
      while (
        startLine > 1 &&
        dialect.attached.test(lines[startLine - 2] ?? "")
      ) {
        startLine -= 1;
      }
      const endLine = lineOf(starts, close);
      const existing = found.get(name);
      // Overloads and same-named members in different scopes collapse to one
      // span covering both, which is the honest reading: a plan naming that
      // symbol means all of them.
      found.set(name, {
        name,
        startLine: Math.min(existing?.startLine ?? startLine, startLine),
        endLine: Math.max(existing?.endLine ?? endLine, endLine),
      });
    }
  }
  return [...found.values()].sort((a, b) => a.startLine - b.startLine);
}

/** One declaration as the shape reader needs it: where its head and body are. */
export interface BraceDeclaration {
  name: string;
  declared: "function" | "type";
  /** Offset of the first keyword, in the masked code. */
  start: number;
  /** Offset the head stops at: the body's `{`, a `;`, an `=`, or a newline. */
  headEnd: number;
  /** The character at `headEnd`: `{`, `;`, `=`, `}` or `\n`. */
  terminator: string;
  open?: number;
  close?: number;
  /** C++ only: the access section this sits in. `public` everywhere else. */
  access: "public" | "private" | "protected";
}

/**
 * Where a declaration's head ends.
 *
 * The first, at bracket depth zero, of: the `{` that opens its body; a `;`
 * (a prototype, an abstract member); an `=` (an expression body, `fun f() =
 * 1`); a `}` closing the block it sits in; or a newline whose next
 * non-blank line begins another declaration or an annotation — a Kotlin
 * interface method has no terminator of its own. Angle brackets count as
 * depth so `Iterator<Item = u8>` does not end a Rust head, and the `>` of an
 * arrow does not close one.
 */
function headEndOf(code: string, start: number, dialect: BraceDialect): number {
  // A stack rather than a counter, so a `<` that was a comparison inside a
  // default value is discarded when the parenthesis around it closes.
  const openers: string[] = [];
  for (let at = start; at < code.length; at += 1) {
    const character = code[at];
    if (character === "(" || character === "[") {
      openers.push(character);
      continue;
    }
    if (character === "<" && looksLikeTypeArgument(code, at)) {
      openers.push("<");
      continue;
    }
    if (character === ")" || character === "]") {
      const wanted = character === ")" ? "(" : "[";
      while (openers.length > 0 && openers.pop() !== wanted) {
        // Unclosed angle brackets inside are not brackets.
      }
      continue;
    }
    if (character === ">") {
      if (openers.at(-1) === "<" && code[at - 1] !== "-" && code[at - 1] !== "=") {
        openers.pop();
      }
      continue;
    }
    if (openers.length !== 0) {
      continue;
    }
    if (character === "{" || character === ";" || character === "}") {
      return at;
    }
    if (character === "=" && code[at + 1] !== "=" && code[at - 1] !== "=") {
      return at;
    }
    if (character === "\n" && startsDeclaration(code, at + 1, dialect)) {
      return at;
    }
  }
  return code.length;
}

/** `<` opens a type argument when a type could follow it; `<<` and `<(` do not. */
function looksLikeTypeArgument(code: string, at: number): boolean {
  return /^<[ \t]*(?:[A-Za-z_?*&'\[]|>)/u.test(code.slice(at, at + 3));
}

/** Whether the next non-blank line begins a declaration or an annotation. */
function startsDeclaration(code: string, from: number, dialect: BraceDialect): boolean {
  const rest = code.slice(from).replace(/^(?:[ \t]*\n)*/u, "");
  return (
    dialect.attached.test(rest) ||
    dialect.declarations.some((pattern) => new RegExp(pattern.source, "u").test(rest))
  );
}

/**
 * Where an expression body ends: the next declaration, or the brace that
 * closes the block this sits in. Everything up to there belongs to the
 * declaration, which is the reading the ranges need — never too small.
 */
function expressionBodyEnd(code: string, from: number, dialect: BraceDialect): number {
  let depth = 0;
  for (let at = from; at < code.length; at += 1) {
    const character = code[at];
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]") {
      depth = Math.max(0, depth - 1);
    } else if (character === "}") {
      if (depth === 0) {
        return Math.max(from, at - 1);
      }
      depth -= 1;
    } else if (character === "\n" && depth === 0 && startsDeclaration(code, at + 1, dialect)) {
      return at;
    }
  }
  return code.length - 1;
}

/**
 * Every declaration in a brace-delimited file, with its head and body
 * located, for the shape reader.
 *
 * Kept beside {@link braceSymbolRanges} rather than folded into it: the two
 * agree on what a declaration is and differ on what they need from it, and
 * a span that is too small is the one wrong answer the ranges must never
 * give, so their walk is left exactly as it is.
 */
export function braceDeclarations(
  source: string,
  language: BraceLanguage,
): { code: string; declarations: BraceDeclaration[] } | undefined {
  const dialect = DIALECTS[language];
  const code = blankNonCode(source, dialect);
  if (code === undefined || !bracesBalance(code)) {
    return undefined;
  }
  const byStart = new Map<number, BraceDeclaration>();
  for (const [position, pattern] of dialect.declarations.entries()) {
    const declared = DECLARED[language][position] ?? "type";
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined || match.index === undefined) {
        continue;
      }
      // Two patterns can match one declaration — a Java `record` is both a
      // type and, to the method pattern, a name followed by a parenthesis.
      // The type reading wins because it was listed first.
      if (byStart.has(match.index)) {
        continue;
      }
      const headEnd = headEndOf(code, match.index, dialect);
      const declaration: BraceDeclaration = {
        name,
        declared,
        start: match.index,
        headEnd,
        terminator: code[headEnd] ?? "",
        access: "public",
      };
      if (code[headEnd] === "{") {
        const close = closingBrace(code, headEnd);
        if (close === undefined) {
          continue;
        }
        declaration.open = headEnd;
        declaration.close = close;
      }
      byStart.set(match.index, declaration);
    }
  }
  const declarations = [...byStart.values()].sort((a, b) => a.start - b.start);
  if (language === "cpp") {
    for (const declaration of declarations) {
      const enclosing = declarations
        .filter(
          (other) =>
            other.declared === "type" &&
            other.open !== undefined &&
            other.close !== undefined &&
            other.open < declaration.start &&
            other.close > declaration.start,
        )
        .sort((a, b) => b.start - a.start)[0];
      if (enclosing?.open === undefined) {
        continue;
      }
      const head = code.slice(enclosing.start, enclosing.headEnd);
      declaration.access = /^(?:template\s*<[^>]*>\s*)?class\b/u.test(head.trim())
        ? "private"
        : "public";
      // Labels at the body's own depth only: a `protected:` inside a nested
      // class's body says nothing about what follows that class.
      let depth = 0;
      for (let at = enclosing.open + 1; at < declaration.start; at += 1) {
        const character = code[at];
        if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
        } else if (depth === 0 && /[\s;{}]/u.test(code[at - 1] ?? "")) {
          const label = /^(public|private|protected)\s*:(?!:)/u.exec(code.slice(at, at + 12));
          if (label?.[1] !== undefined) {
            declaration.access = label[1] as BraceDeclaration["access"];
          }
        }
      }
    }
  }
  return { code, declarations };
}

function bracesBalance(code: string): boolean {
  let depth = 0;
  for (const character of code) {
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function closingBrace(code: string, open: number): number | undefined {
  let inner = 0;
  for (let at = open; at < code.length; at += 1) {
    if (code[at] === "{") {
      inner += 1;
    } else if (code[at] === "}") {
      inner -= 1;
      if (inner === 0) {
        return at;
      }
    }
  }
  return undefined;
}

/**
 * Declaration spans for Ruby, whose blocks close with `end`.
 *
 * Counted rather than parsed, and abandoned on the first thing that does not
 * add up. Ruby has more ways to open a block than are worth enumerating —
 * modifiers, blocks passed to methods, heredocs — so this recognises the ones
 * that appear in ordinary declaration bodies and refuses the file when the
 * depth does not return to zero.
 */
export function rubySymbolRanges(source: string): SymbolRange[] | undefined {
  const lines = source.split("\n");
  const opensDeclaration = /^[ \t]*(?:(?:private|public|protected)\s+)?(def|class|module)\s+(?:self\.)?([A-Za-z_][\w?!=]*)/u;
  const opensBlock =
    /(?:^|\s)(?:def|class|module|do|begin|case)\b|(?:^|\s)(?:if|unless|while|until|for)\b(?!.*\bend\b)/u;
  const closesBlock = /^[ \t]*end\b|(?:^|\s)end\s*$/u;
  const found = new Map<string, SymbolRange>();
  const open: { name: string; startLine: number; depth: number }[] = [];
  let depth = 0;

  for (const [offset, raw] of lines.entries()) {
    const line = raw.replace(/#.*$/u, "");
    if (line.trim().length === 0) {
      continue;
    }
    const declaration = opensDeclaration.exec(line);
    // A one-line body (`def size; @n; end`) opens and closes on the same line
    // and never enters the stack.
    const oneLine =
      declaration !== null && /;\s*end\s*$/u.test(line.trim());
    if (declaration !== null && !oneLine) {
      const name = declaration[2];
      if (name === undefined) {
        return undefined;
      }
      open.push({ name, startLine: offset + 1, depth });
      depth += 1;
      continue;
    }
    if (oneLine && declaration?.[2] !== undefined) {
      found.set(declaration[2], {
        name: declaration[2],
        startLine: offset + 1,
        endLine: offset + 1,
      });
      continue;
    }
    if (closesBlock.test(line)) {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
      const closed = open.at(-1);
      if (closed !== undefined && closed.depth === depth) {
        open.pop();
        const existing = found.get(closed.name);
        found.set(closed.name, {
          name: closed.name,
          startLine: Math.min(existing?.startLine ?? closed.startLine, closed.startLine),
          endLine: Math.max(existing?.endLine ?? offset + 1, offset + 1),
        });
      }
      continue;
    }
    if (opensBlock.test(line)) {
      depth += 1;
    }
  }
  if (depth !== 0 || open.length > 0) {
    return undefined;
  }
  return [...found.values()].sort((a, b) => a.startLine - b.startLine);
}

/**
 * Declaration spans for Python, read by Python itself.
 *
 * Every other extractor here is a scanner, and for Python that would be a
 * poor trade: the interpreter is already installed wherever this runs, its
 * `ast` module gives exact spans including decorators, and the failure modes
 * a scanner would have here — a `def` inside a docstring, a multi-line
 * signature, a body ending on a blank line — are precisely the ones that
 * produce a range that is too small, which is the one wrong answer that costs
 * a wasted agent run rather than a queue.
 *
 * Batched: one interpreter for the whole index rather than one per file, with
 * the sources handed over on stdin. A repository of any size is a single
 * spawn.
 *
 * Every failure is the same answer — no entry, so the caller sees `undefined`
 * and withholds the file whole. A missing interpreter, a syntax error, a
 * timeout and a crash are all "no idea", which is what this deployment did
 * for Python before any of this existed.
 */
const PYTHON_READER = `
import ast, json, sys

def spans(tree):
    found = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        end = getattr(node, "end_lineno", None)
        if end is None:
            return None
        # A decorator is part of the thing it decorates: editing @app.route
        # is editing the handler under it, so the span starts at the first one.
        start = min([node.lineno] + [d.lineno for d in node.decorator_list])
        previous = found.get(node.name)
        if previous is None:
            found[node.name] = {"name": node.name, "startLine": start, "endLine": end}
        else:
            previous["startLine"] = min(previous["startLine"], start)
            previous["endLine"] = max(previous["endLine"], end)
    return sorted(found.values(), key=lambda entry: entry["startLine"])

def signature(node):
    # Parameters as a caller sees them: name, annotation, and whether a
    # default makes it optional — but not the default itself, which is a
    # value and not a contract. Names are kept because a keyword caller
    # depends on them.
    a = node.args
    out = []
    inferred = node.returns is None
    def one(arg, default, prefix=""):
        nonlocal inferred
        text = prefix + arg.arg
        if arg.annotation is not None:
            text += ": " + ast.unparse(arg.annotation)
        elif arg.arg not in ("self", "cls"):
            inferred = True
        if default:
            text += "?"
        return text
    positional = a.posonlyargs + a.args
    defaults = [None] * (len(positional) - len(a.defaults)) + list(a.defaults)
    for arg, default in zip(positional, defaults):
        out.append(one(arg, default is not None))
    if a.posonlyargs:
        out.insert(len(a.posonlyargs), "/")
    if a.vararg is not None:
        out.append(one(a.vararg, False, "*"))
    elif a.kwonlyargs:
        out.append("*")
    for arg, default in zip(a.kwonlyargs, a.kw_defaults):
        out.append(one(arg, default is not None))
    if a.kwarg is not None:
        out.append(one(a.kwarg, False, "**"))
    text = "(" + ", ".join(out) + ")"
    if node.returns is not None:
        text += " -> " + ast.unparse(node.returns)
    if isinstance(node, ast.AsyncFunctionDef):
        text = "async " + text
    return text, inferred

def public(name):
    return not name.startswith("_") or (name.startswith("__") and name.endswith("__"))

def shapes(tree):
    out = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not public(node.name):
                continue
            text, inferred = signature(node)
            out.append({"symbol": node.name, "kind": "function", "shape": text, "comparable": text, "inferred": inferred})
        elif isinstance(node, ast.ClassDef):
            if not public(node.name):
                continue
            bases = [ast.unparse(b) for b in node.bases] + [k.arg + "=" + ast.unparse(k.value) for k in node.keywords if k.arg]
            members = []
            inferred = False
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and public(child.name):
                    text, sub = signature(child)
                    members.append(child.name + text)
                    inferred = inferred or sub
                elif isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name) and public(child.target.id):
                    members.append(child.target.id + ": " + ast.unparse(child.annotation))
                elif isinstance(child, ast.Assign):
                    for target in child.targets:
                        if isinstance(target, ast.Name) and public(target.id):
                            members.append(target.id)
            members.sort()
            text = ("(" + ", ".join(bases) + ")" if bases else "") + " {" + "; ".join(members) + "}"
            out.append({"symbol": node.name, "kind": "class", "shape": text, "comparable": text, "inferred": inferred})
    return out

def imports(tree):
    # Dotted module names exactly as written, relative ones keeping their
    # leading dots. A scanner would have to decide whether a line inside a
    # docstring is an import; the parser already knows it is not.
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            base = ("." * node.level) + (node.module or "")
            out.append(base)
            # \`from pkg import name\` is genuinely ambiguous between an
            # attribute of pkg/__init__.py and the submodule pkg/name.py.
            # Both are emitted; the resolver keeps whichever is a real file,
            # so the guess is made against the tree rather than here.
            for alias in node.names:
                if alias.name == "*":
                    continue
                out.append(base + ("" if base.endswith(".") else ".") + alias.name)
    seen = []
    for name in out:
        if name and name not in seen:
            seen.append(name)
    return seen

payload = json.loads(sys.stdin.read())
out = {}
for path, source in payload.items():
    try:
        # A byte-order mark is not a token, and ast.parse on a str does not
        # strip it the way the tokenizer does for bytes.
        tree = ast.parse(source[1:] if source.startswith("\\ufeff") else source)
        found = spans(tree)
        out[path] = None if found is None else {"ranges": found, "imports": imports(tree), "shapes": shapes(tree)}
    except Exception:
        out[path] = None
# The standard library's own top-level names, so a single-segment \`import
# email\` is not matched against a repository file that happens to be called
# email.py. Free here; guesswork anywhere else.
out["//stdlib"] = sorted(getattr(sys, "stdlib_module_names", ()))
sys.stdout.write(json.dumps(out))
`;

/** How long the whole batch may take before its answers are given up on. */
const PYTHON_READ_TIMEOUT_MS = 30_000;

/** One declaration's contract as the Python reader wrote it; hashed in TS. */
export interface PythonShape {
  symbol: string;
  kind: "function" | "class";
  shape: string;
  comparable: string;
  inferred: boolean;
}

/** What one spawn of the reader learned about the whole repository. */
export interface PythonRead {
  /** Per file, only for files the interpreter could parse. */
  files: Map<
    string,
    { ranges: SymbolRange[]; imports: string[]; shapes: PythonShape[] }
  >;
  /**
   * The interpreter's own `sys.stdlib_module_names`.
   *
   * Read from the running Python rather than written down, because the list
   * differs by version and a stale copy is the difference between dropping
   * `import email` and matching it against somebody's `email.py`.
   */
  stdlib: ReadonlySet<string>;
}

export async function pythonSymbolRanges(
  sources: ReadonlyMap<string, string>,
): Promise<PythonRead> {
  const answers: PythonRead = { files: new Map(), stdlib: new Set() };
  if (sources.size === 0) {
    return answers;
  }
  const { spawn } = await import("node:child_process");
  const raw = await new Promise<string | undefined>((resolve) => {
    let child;
    try {
      child = spawn("python3", ["-c", PYTHON_READER], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, PYTHON_READ_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => {
      finish(undefined);
    });
    child.on("close", (code) => {
      finish(code === 0 ? out : undefined);
    });
    child.stdin.on("error", () => {
      finish(undefined);
    });
    child.stdin.end(JSON.stringify(Object.fromEntries(sources)), "utf8");
  });
  if (raw === undefined) {
    return answers;
  }
  let parsed: Record<
    string,
    | { ranges: SymbolRange[]; imports: string[]; shapes: PythonShape[] }
    | string[]
    | null
  >;
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return answers;
  }
  const stdlib = parsed["//stdlib"];
  const read: PythonRead = {
    files: new Map(),
    stdlib: new Set(Array.isArray(stdlib) ? stdlib : []),
  };
  for (const [filePath, answer] of Object.entries(parsed)) {
    if (filePath === "//stdlib" || answer === null || Array.isArray(answer)) {
      continue;
    }
    read.files.set(filePath, {
      ranges: answer.ranges,
      imports: answer.imports,
      shapes: answer.shapes,
    });
  }
  return read;
}
