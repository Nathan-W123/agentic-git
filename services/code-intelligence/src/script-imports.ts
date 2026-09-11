/**
 * Ruby and PHP, where the text is harder to read than the imports are.
 *
 * Neither language is difficult to resolve once you can tell code from
 * not-code. Getting to that point is the work: Ruby has heredocs, `=begin`
 * blocks and `%w[...]` literals with arbitrary delimiters, and PHP's file is
 * HTML until a `<?php` says otherwise. A `require` inside any of those is a
 * sentence, not a dependency, and an edge invented from one is exactly the
 * false edge everything here is built to avoid.
 *
 * The granularity differs from the symbol scanners on purpose. They abandon a
 * whole file on anything unaccounted for, because a range that is too small
 * hands another agent lines somebody is editing. Here a specifier that cannot
 * be resolved is simply dropped — a missing edge costs a warning — and the
 * whole file is abandoned only when the *masker* fails, because that is the
 * state in which a `require` in a heredoc reads as code.
 */

import { posixDirname, posixJoin } from "./import-resolution.js";

/* ----------------------------------------------------------------- ruby -- */

const RUBY_PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/**
 * Words after which Ruby expects a value, so a `/` or `<<` that follows one
 * begins a literal rather than an operator.
 */
const RUBY_VALUE_EXPECTED = new Set([
  "if", "unless", "while", "until", "when", "and", "or", "not", "return",
  "yield", "puts", "print", "p", "raise", "elsif", "case", "then", "else",
  "do", "begin", "rescue", "ensure", "in", "class", "module", "def",
]);

/**
 * Blanks Ruby comments, strings, heredocs, regexes and percent literals.
 *
 * The one thing this has to know that a character scanner does not is
 * whether Ruby is expecting a *value* at each point: after one, `<<` is a
 * shift and `/` is a division; before one, they open a heredoc and a regex.
 * The first version asked only what the previous character was, and
 * `x = [<<~SQL]` — a heredoc after a bracket — or `A = /'/` — a regex with
 * an apostrophe in it — put the scanner in the wrong state, and a `require`
 * in prose read as code.
 *
 * Several heredocs can open on one line, and the rest of that line is still
 * code; each body is blanked from the line after, in the order opened.
 */
export function maskRuby(source: string): string | undefined {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== "\n") {
        out[at] = " ";
      }
    }
  };
  let index = 0;
  /** Whether the last significant token ended a value. */
  let afterValue = false;
  /** The last identifier seen, for `class <<self` and keyword arguments. */
  let lastWord = "";
  const pending: Array<{ tag: string; indented: boolean }> = [];
  const atLineStart = (at: number): boolean => at === 0 || source[at - 1] === "\n";
  const previousChar = (): string => source[index - 1] ?? "";

  /** Skips a `#{...}` interpolation, nested strings and braces included. */
  const skipInterpolation = (from: number): number | undefined => {
    let depth = 0;
    let at = from;
    while (at < source.length) {
      const character = source[at] ?? "";
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          return at + 1;
        }
      } else if (character === '"' || character === "'" || character === "`") {
        const end = skipString(at, character);
        if (end === undefined) {
          return undefined;
        }
        at = end;
        continue;
      }
      at += 1;
    }
    return undefined;
  };
  /** Skips a quoted string starting at `from`, returning the offset after it. */
  const skipString = (from: number, quote: string): number | undefined => {
    let at = from + 1;
    for (;;) {
      if (at >= source.length) {
        return undefined;
      }
      const character = source[at];
      if (character === "\\") {
        at += 2;
        continue;
      }
      if (quote !== "'" && character === "#" && source[at + 1] === "{") {
        const end = skipInterpolation(at + 1);
        if (end === undefined) {
          return undefined;
        }
        at = end;
        continue;
      }
      if (character === quote) {
        return at + 1;
      }
      at += 1;
    }
  };
  /** Blanks every heredoc body opened on the line that just ended. */
  const drainHeredocs = (lineEnd: number): number | undefined => {
    let cursor = lineEnd + 1;
    for (const heredoc of pending.splice(0)) {
      const terminator = new RegExp(
        `^${heredoc.indented ? "[ \\t]*" : ""}${heredoc.tag}\r?$`,
        "mu",
      );
      const found = terminator.exec(source.slice(cursor));
      if (found === null) {
        return undefined;
      }
      const end = cursor + found.index + found[0].length;
      blank(cursor, end);
      cursor = end;
    }
    return cursor;
  };

  while (index < source.length) {
    const character = source[index] ?? "";
    if (character === "\n") {
      if (pending.length > 0) {
        const resumed = drainHeredocs(index);
        if (resumed === undefined) {
          return undefined;
        }
        index = resumed;
      } else {
        index += 1;
      }
      afterValue = false;
      lastWord = "";
      continue;
    }
    // Everything below `__END__` is data, and is a complete answer above it.
    if (atLineStart(index) && /^__END__\r?$/mu.test(source.slice(index, index + 9))) {
      blank(index, source.length);
      break;
    }
    if (atLineStart(index) && /^=begin(?:[ \t]|\r?$)/mu.test(source.slice(index, index + 8))) {
      const end = /^=end(?:[ \t]|\r?$)/mu.exec(source.slice(index));
      if (end === null) {
        return undefined;
      }
      const lineEnd = source.indexOf("\n", index + end.index);
      blank(index, lineEnd === -1 ? source.length : lineEnd);
      index = lineEnd === -1 ? source.length : lineEnd;
      continue;
    }
    if (character === "#") {
      const end = source.indexOf("\n", index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    // A special global is not a string opener.
    if (character === "$" && /["'`]/u.test(source[index + 1] ?? "")) {
      index += 2;
      afterValue = true;
      continue;
    }
    // A heredoc opener; the body is blanked when this line ends.
    const heredoc = /^<<([~-]?)(["'`]?)([A-Za-z_]\w*)\2/u.exec(source.slice(index, index + 80));
    if (
      heredoc !== null &&
      lastWord !== "class" &&
      (!afterValue || /\s/u.test(previousChar()))
    ) {
      pending.push({ tag: heredoc[3] ?? "", indented: heredoc[1] !== "" });
      blank(index, index + heredoc[0].length);
      index += heredoc[0].length;
      afterValue = true;
      continue;
    }
    const percent = /^%([wWiIqQrsx]?)(.)/u.exec(source.slice(index, index + 3));
    if (
      percent !== null &&
      (percent[1] !== "" || /[([{<|!/]/u.test(percent[2] ?? "")) &&
      !afterValue
    ) {
      const open = percent[2] ?? "";
      const close = RUBY_PAIRS[open] ?? open;
      let depth = 1;
      let at = index + percent[0].length;
      for (;;) {
        if (at >= source.length) {
          return undefined;
        }
        if (source[at] === "\\") {
          at += 2;
          continue;
        }
        if (source[at] === open && close !== open) {
          depth += 1;
        } else if (source[at] === close) {
          depth -= 1;
          if (depth === 0) {
            at += 1;
            break;
          }
        }
        at += 1;
      }
      blank(index, at);
      index = at;
      afterValue = true;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const end = skipString(index, character);
      if (end === undefined) {
        return undefined;
      }
      blank(index, end);
      index = end;
      afterValue = true;
      continue;
    }
    // A regex, where a value is expected; a division where one just ended.
    if (character === "/" && (!afterValue || (/\s/u.test(previousChar()) && !/[\s=]/u.test(source[index + 1] ?? "") && RUBY_VALUE_EXPECTED.has(lastWord)))) {
      let at = index + 1;
      for (;;) {
        if (at >= source.length || source[at] === "\n") {
          return undefined;
        }
        if (source[at] === "\\") {
          at += 2;
          continue;
        }
        if (source[at] === "#" && source[at + 1] === "{") {
          const end = skipInterpolation(at + 1);
          if (end === undefined) {
            return undefined;
          }
          at = end;
          continue;
        }
        if (source[at] === "/") {
          at += 1;
          break;
        }
        at += 1;
      }
      while (/[imxounse]/u.test(source[at] ?? "")) {
        at += 1;
      }
      blank(index, at);
      index = at;
      afterValue = true;
      continue;
    }
    // A character literal, `?'`, where a value is expected.
    const charLiteral = /^\?(?:\\.|[^\s\w])(?!\w)/u.exec(source.slice(index, index + 4));
    if (charLiteral !== null && !afterValue) {
      blank(index, index + charLiteral[0].length);
      index += charLiteral[0].length;
      afterValue = true;
      continue;
    }
    const word = /^[A-Za-z_]\w*[?!]?/u.exec(source.slice(index, index + 80));
    if (word !== null) {
      lastWord = word[0];
      afterValue = !RUBY_VALUE_EXPECTED.has(word[0]);
      index += word[0].length;
      continue;
    }
    const number = /^\d[\w.]*/u.exec(source.slice(index, index + 40));
    if (number !== null) {
      index += number[0].length;
      afterValue = true;
      continue;
    }
    afterValue = /[)\]}]/u.test(character);
    if (!/[)\]}]/u.test(character)) {
      lastWord = "";
    }
    index += 1;
  }
  if (pending.length > 0) {
    return undefined;
  }
  return out.join("");
}

/** One `require`, with the base it is measured from. */
export interface ScriptRequire {
  relative: boolean;
  specifier: string;
}

/**
 * Reads Ruby's requires.
 *
 * Literal single- or double-quoted arguments only. `require File.join(...)`
 * and `require __dir__ + "/x"` are computed at run time and are not
 * resolvable from a file set; they are dropped rather than guessed at, which
 * costs a warning and never invents an edge.
 *
 * The masker is run first and the requires are read back out of the original
 * text at the offsets it left intact, so a `require` inside a heredoc or a
 * comment is not one.
 */
export function readRubyRequires(source: string): ScriptRequire[] | undefined {
  const code = maskRuby(source);
  if (code === undefined) {
    return undefined;
  }
  const out: ScriptRequire[] = [];
  for (const match of source.matchAll(
    /(?:^|[\s;(])(require|require_relative)[\s(]+(["'])([^"'\n]+)\2(?=\s*(?:$|[;#)]|\b(?:if|unless|rescue)\b))/gmu,
  )) {
    const specifier = match[3];
    // Matched against the original, because the masker blanks the quoted
    // argument itself — it is a string, and that is the whole point of it.
    // The mask decides only whether the *keyword* was code: a `require`
    // inside a heredoc or a comment has been blanked away there. The
    // lookahead is what keeps `require 'plugins/' + name` — computed at run
    // time — from being read as `plugins/`.
    if (
      specifier !== undefined &&
      !specifier.endsWith("/") &&
      keywordIsCode(source, code, match)
    ) {
      out.push({ relative: match[1] === "require_relative", specifier });
    }
  }
  return out;
}

/** Whether the keyword this match found survived masking, and so was code. */
function keywordIsCode(
  source: string,
  masked: string,
  match: RegExpExecArray | RegExpMatchArray,
): boolean {
  const start = match.index ?? -1;
  if (start < 0) {
    return false;
  }
  const keyword = match[1] ?? "";
  const at = source.indexOf(keyword, start);
  return at >= 0 && masked.startsWith(keyword, at);
}

/**
 * Ruby's load path, as far as a set of paths can say.
 *
 * Derived from layout alone, never from a `.gemspec`'s contents: `$LOAD_PATH`
 * is a run-time value and a gemspec can name any directory. These are the
 * conventions that hold almost everywhere, and anything outside them simply
 * does not resolve.
 */
export function rubyLoadRoots(files: ReadonlySet<string>): string[] {
  const roots = new Set<string>();
  const under = (dir: string): boolean => {
    for (const file of files) {
      if (file.startsWith(`${dir}/`)) {
        return true;
      }
    }
    return false;
  };
  for (const file of files) {
    if (/(?:^|\/)[^/]+\.gemspec$/u.test(file)) {
      const lib = posixJoin(posixDirname(file), "lib");
      if (under(lib)) {
        roots.add(lib);
      }
    }
  }
  if (
    (files.has("Gemfile") || files.has("Rakefile") || files.has("config/application.rb")) &&
    under("lib")
  ) {
    roots.add("lib");
  }
  if (files.has("spec/spec_helper.rb") || files.has("spec/rails_helper.rb")) {
    roots.add("spec");
  }
  if (files.has("test/test_helper.rb")) {
    roots.add("test");
  }
  return [...roots];
}

export interface RubyContext {
  files: ReadonlySet<string>;
  roots: readonly string[];
}

export function resolveRubyRequire(
  fromFile: string,
  request: ScriptRequire,
  context: RubyContext,
): readonly string[] {
  const { files } = context;
  // Only a loadable file: `bin/cli` with no extension is not what
  // `require_relative "../bin/cli"` loads, whatever sits at that path.
  const withExtension = (base: string): string | undefined => {
    if (base === "") {
      return undefined;
    }
    const candidate = /\.(?:rb|so)$/u.test(base) ? base : `${base}.rb`;
    return files.has(candidate) ? candidate : undefined;
  };
  if (request.relative) {
    const hit = withExtension(
      posixJoin(posixDirname(fromFile), request.specifier),
    );
    return hit === undefined || hit === fromFile ? [] : [hit];
  }
  // `require './x'` is measured from the process's working directory, which
  // is a run-time fact; `require '/x'` and `require '~/x'` name nothing in
  // a repository. None of them is a load-path lookup.
  if (/^(?:\.{1,2}\/|\/|~)/u.test(request.specifier)) {
    return [];
  }
  const hits = new Set<string>();
  for (const root of context.roots) {
    const hit = withExtension(posixJoin(root, request.specifier));
    if (hit !== undefined && hit !== fromFile) {
      hits.add(hit);
    }
  }
  // The backstop everywhere here: two roots that both answer means the load
  // path decides, and the load path is a run-time value.
  return hits.size === 1 ? [...hits] : [];
}

/* ------------------------------------------------------------------ php -- */

/** Blanks PHP's non-code, including everything outside `<?php`. */
export function maskPhp(source: string): string | undefined {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== "\n") {
        out[at] = " ";
      }
    }
  };
  let index = 0;
  let inCode = false;
  while (index < source.length) {
    if (!inCode) {
      // The tag is case-insensitive: `<?PHP` opens code too.
      const tag = /<\?(?:php\b|=)/giu;
      tag.lastIndex = index;
      const found = tag.exec(source);
      if (found === null) {
        blank(index, source.length);
        break;
      }
      // Everything before the tag is markup, not code.
      blank(index, found.index);
      index = found.index + found[0].length;
      inCode = true;
      continue;
    }
    if (source.startsWith("?>", index)) {
      inCode = false;
      index += 2;
      continue;
    }
    // `#[` opens a PHP 8 attribute, not a comment — and `#[Route('/x')]` is
    // exactly the line a route reader needs to see. A line comment ends at
    // the newline or at a `?>`, whichever is first: `// header ?>` leaves
    // code mode, and what follows is markup.
    if (
      source.startsWith("//", index) ||
      (source[index] === "#" && !source.startsWith("#[", index))
    ) {
      const newline = source.indexOf("\n", index);
      const close = source.indexOf("?>", index);
      const end =
        close !== -1 && (newline === -1 || close < newline)
          ? close
          : newline === -1
            ? source.length
            : newline;
      blank(index, end);
      index = end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        return undefined;
      }
      blank(index, end + 2);
      index = end + 2;
      continue;
    }
    const heredoc = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1/u.exec(source.slice(index, index + 80));
    if (heredoc !== null) {
      const tag = heredoc[2] ?? "";
      const bodyStart = source.indexOf("\n", index);
      if (bodyStart === -1) {
        return undefined;
      }
      const found = new RegExp(`^[ \\t]*${tag}\\b`, "mu").exec(
        source.slice(bodyStart + 1),
      );
      if (found === null) {
        return undefined;
      }
      const end = bodyStart + 1 + found.index + found[0].length;
      blank(index, end);
      index = end;
      continue;
    }
    const character = source[index] ?? "";
    if (character === '"' || character === "'") {
      let at = index + 1;
      for (;;) {
        if (at >= source.length) {
          return undefined;
        }
        if (source[at] === "\\") {
          at += 2;
          continue;
        }
        // `"{$t("...")}"`: a nested string inside an interpolation does not
        // end the outer one.
        if (
          character === '"' &&
          (source.startsWith("{$", at) || source.startsWith("${", at))
        ) {
          const end = skipPhpInterpolation(source, at);
          if (end === undefined) {
            return undefined;
          }
          at = end;
          continue;
        }
        if (source[at] === character) {
          at += 1;
          break;
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

/** The offset after a `{$...}` or `${...}` interpolation, nested strings included. */
function skipPhpInterpolation(source: string, from: number): number | undefined {
  let depth = 0;
  let at = from;
  while (at < source.length) {
    const character = source[at] ?? "";
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return at + 1;
      }
    } else if (character === '"' || character === "'") {
      at += 1;
      while (at < source.length && source[at] !== character) {
        at += source[at] === "\\" ? 2 : 1;
      }
      if (at >= source.length) {
        return undefined;
      }
    }
    at += 1;
  }
  return undefined;
}

export interface PhpUnit {
  namespace: string;
  /** Class-like names this file declares at any depth. */
  declared: string[];
  /** `use A\B\C;` — a type import. */
  uses: string[];
  /** `require`/`include` with a literal argument. */
  requires: string[];
}

export function readPhpFile(source: string): PhpUnit | undefined {
  const code = maskPhp(source);
  if (code === undefined) {
    return undefined;
  }
  const namespaces = [
    ...code.matchAll(/(?:^|[\s;{}])namespace\s+([\w\\]+)\s*[;{]/gu),
  ].map((match) => (match[1] ?? "").replace(/^\\/u, ""));
  // Two namespace blocks in one file put each declaration under a different
  // name, and this records one namespace per file. Rather than file every
  // class under the first, the file declares nothing: its imports still
  // resolve, and nothing resolves wrongly onto it.
  const namespace = namespaces.length === 1 ? (namespaces[0] ?? "") : "";
  const declared =
    namespaces.length > 1
      ? []
      : [
          ...code.matchAll(
            /(?<!\bnew\s+)(?:^|[\s;{}])(?:final\s+|abstract\s+|readonly\s+)*(?:class|interface|trait|enum)\s+(?!(?:extends|implements)\b)([A-Za-z_]\w*)/gu,
          ),
        ]
          .map((match) => match[1] ?? "")
          .filter((name) => name !== "");
  // A `use` is an import only at the top of the file — or directly inside a
  // `namespace X { }` block. Inside a class body it inserts a trait, whose
  // bare name is relative to the namespace and not something to look up as
  // written. `use function` and `use const` name things that are not
  // classes and have no file in the class table.
  const uses: string[] = [];
  for (const match of code.matchAll(
    /(?:^|[\s;{}])use\s+(function\s+|const\s+)?([\w\\]+)\s*(?:;|\sas\s)/gu,
  )) {
    const name = (match[2] ?? "").replace(/^\\/u, "");
    if (name === "" || match[1] !== undefined || match.index === undefined) {
      continue;
    }
    if (insideNamespaceOnly(code, match.index)) {
      uses.push(name);
    }
  }
  // Against the original for the same reason Ruby's is: the argument is a
  // string, so the masker has already blanked it. The lookahead refuses a
  // computed path, `require 'f.php' . $ext`, rather than half-reading it.
  const requires = [
    ...source.matchAll(
      /(?:^|[\s;({])(require|include)(?:_once)?[\s(]+(["'])([^"'\n]+)\2(?=\s*(?:[;)]|\?>|$))/gmu,
    ),
  ]
    .filter((match) => keywordIsCode(source, code, match))
    .map((match) => match[3] ?? "")
    .filter((name) => name !== "");
  return { namespace, declared, uses, requires };
}

/** Whether every brace open at `offset` is a `namespace X {` block. */
function insideNamespaceOnly(code: string, offset: number): boolean {
  const stack: boolean[] = [];
  for (let at = 0; at < offset; at += 1) {
    const character = code[at];
    if (character === "{") {
      stack.push(/namespace\s+[\w\\]*\s*$/u.test(code.slice(Math.max(0, at - 120), at)));
    } else if (character === "}") {
      stack.pop();
    }
  }
  return stack.every(Boolean);
}

export interface PhpContext {
  files: ReadonlySet<string>;
  /** Lowercased fully-qualified class name to its file; absent when doubled. */
  types: ReadonlyMap<string, string>;
}

/** The class table, dropping any name two files declare. */
export function phpTypes(
  units: ReadonlyMap<string, PhpUnit>,
): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const [file, unit] of units) {
    for (const name of unit.declared) {
      const fqcn = (
        unit.namespace === "" ? name : `${unit.namespace}\\${name}`
      ).toLowerCase();
      seen.set(fqcn, seen.has(fqcn) ? null : file);
    }
  }
  const types = new Map<string, string>();
  for (const [fqcn, file] of seen) {
    if (file !== null) {
      types.set(fqcn, file);
    }
  }
  return types;
}

export function resolvePhpUse(
  fromFile: string,
  specifier: string,
  context: PhpContext,
): readonly string[] {
  // PHP is case-insensitive about class names and Composer's autoloader maps
  // them to paths through configuration this never reads — so the declaring
  // file is the only honest source.
  const hit = context.types.get(specifier.toLowerCase());
  return hit === undefined || hit === fromFile ? [] : [hit];
}

export function resolvePhpRequire(
  fromFile: string,
  specifier: string,
  context: PhpContext,
): readonly string[] {
  // An absolute path is not in this repository, whatever it happens to match.
  if (/^(?:\/|\\|[A-Za-z]:[\\/])/u.test(specifier)) {
    return [];
  }
  const hit = posixJoin(posixDirname(fromFile), specifier);
  return hit !== "" && hit !== fromFile && context.files.has(hit) ? [hit] : [];
}
