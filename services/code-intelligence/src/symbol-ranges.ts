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
      const open = code.indexOf("{", match.index);
      if (open === -1) {
        continue;
      }
      // A brace further away than the end of the declaration's own statement
      // belongs to something else — an interface method with no body, a
      // forward declaration, an abstract member.
      const semicolon = code.indexOf(";", match.index);
      if (semicolon !== -1 && semicolon < open) {
        continue;
      }
      let inner = 0;
      let close = -1;
      for (let at = open; at < code.length; at += 1) {
        if (code[at] === "{") {
          inner += 1;
        } else if (code[at] === "}") {
          inner -= 1;
          if (inner === 0) {
            close = at;
            break;
          }
        }
      }
      if (close === -1) {
        continue;
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

def spans(source):
    tree = ast.parse(source)
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

payload = json.loads(sys.stdin.read())
out = {}
for path, source in payload.items():
    try:
        out[path] = spans(source)
    except Exception:
        out[path] = None
sys.stdout.write(json.dumps(out))
`;

/** How long the whole batch may take before its answers are given up on. */
const PYTHON_READ_TIMEOUT_MS = 30_000;

export async function pythonSymbolRanges(
  sources: ReadonlyMap<string, string>,
): Promise<Map<string, SymbolRange[]>> {
  const answers = new Map<string, SymbolRange[]>();
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
  let parsed: Record<string, SymbolRange[] | null>;
  try {
    parsed = JSON.parse(raw) as Record<string, SymbolRange[] | null>;
  } catch {
    return answers;
  }
  for (const [filePath, ranges] of Object.entries(parsed)) {
    if (ranges !== null) {
      answers.set(filePath, ranges);
    }
  }
  return answers;
}
