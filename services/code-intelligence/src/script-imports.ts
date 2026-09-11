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
 * Keywords after which Ruby expects a value, so a `/` or `<<` that follows
 * one begins a literal rather than an operator — unconditionally, since a
 * keyword is never a receiver.
 *
 * `puts`, `p`, `print` and `raise` were listed here once. They are methods,
 * and a local may shadow any of them: `p = 3; c = p / r` is a division that
 * read as a regex to the end of the line and abandoned the file. They take
 * the rule every other identifier does, below.
 */
const RUBY_VALUE_EXPECTED = new Set([
  "if", "unless", "while", "until", "when", "and", "or", "not", "return",
  "yield", "elsif", "case", "then", "else", "do", "begin", "rescue", "ensure",
  "in", "class", "module", "def",
]);

/** An operator where a method name (`def /(other)`) or a symbol (`:/`) goes. */
const RUBY_OPERATOR =
  /^(?:\[\]=?|<=>|<=|>=|===?|=~|!~|!=|\*\*|<<|>>|[+\-*/%<>!~&|^]@?|`)/u;

/** Percent literals whose bodies interpolate: `%W[#{x}]` holds code. */
const RUBY_PERCENT_INTERPOLATES = new Set(["", "W", "I", "Q", "r", "x"]);

/**
 * A global that is punctuation after the `$`: `$/`, `$'`, `$"`, `` $` ``,
 * `$1`, `$-w`. Each is a value, and none of them opens a string, a regex or
 * a comment.
 */
const RUBY_SPECIAL_GLOBAL = /^\$(?:-\w|[~*$?!@/\\;,.=:<>"'`&+\d])/u;

/** Regex-escapes a heredoc tag, so `<<~'end;'` is looked for as written. */
const escapeTag = (tag: string): string =>
  tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
 * After an identifier the question is open, and Ruby settles it by spacing:
 * `assert_match /\d+/, x` and `sh %W[...]` — a space before, none after —
 * pass a literal, while `a / b`, `a/b` and `a /= b` divide. The one place
 * the spacing lies is a local variable, `count /2`, which Ruby knows to be a
 * division because it knows its locals; the names this file assigns to
 * stand in for that. A `<<` after an identifier asks one thing more, that
 * some later line closes the heredoc, since `buf <<line` on a method is a
 * heredoc nobody terminates.
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
  const pending: Array<{ tag: string; indented: boolean }> = [];
  /**
   * Identifiers this file assigns to, in any scope. Not scoped, which errs
   * toward reading an operator, and an operator misread costs at most one
   * literal's interior read as code; a literal misread can swallow lines.
   */
  const locals = new Set<string>();
  const atLineStart = (at: number): boolean => at === 0 || source[at - 1] === "\n";
  const terminator = (heredoc: { tag: string; indented: boolean }): RegExp =>
    new RegExp(
      `^${heredoc.indented ? "[ \\t]*" : ""}${escapeTag(heredoc.tag)}\r?$`,
      "mu",
    );
  /** Whether a line after the one holding `from` closes this heredoc. */
  const hasTerminator = (
    heredoc: { tag: string; indented: boolean },
    from: number,
  ): boolean => {
    const lineEnd = source.indexOf("\n", from);
    return lineEnd !== -1 && terminator(heredoc).test(source.slice(lineEnd + 1));
  };
  /** Blanks every heredoc body opened on the line that just ended. */
  const drainHeredocs = (lineEnd: number): number | undefined => {
    let cursor = lineEnd + 1;
    for (const heredoc of pending.splice(0)) {
      const found = terminator(heredoc).exec(source.slice(cursor));
      if (found === null) {
        return undefined;
      }
      const end = cursor + found.index + found[0].length;
      blank(cursor, end);
      cursor = end;
    }
    return cursor;
  };

  /**
   * Scans code from `from`. At the top level this runs to the end of the
   * source. Inside a `#{...}` it returns the offset after the brace that
   * closes the interpolation, so what is between the braces is read by the
   * rules of the code around it: `"#{CGI.unescape $'}"` holds a special
   * global there, not the start of a string that never ends.
   */
  const scan = (from: number, nested: boolean): number | undefined => {
    let index = from;
    /** Whether the last significant token ended a value. */
    let afterValue = false;
    /** The identifier the last token was, or "" when it was anything else. */
    let lastWord = "";
    /** Braces opened inside this interpolation and not yet closed. */
    let depth = 0;
    /** 1 when the next token names the method of a `def`; 2 after that name. */
    let defName = 0;
    const previousChar = (): string => source[index - 1] ?? "";
    /**
     * Ruby's rule for an ambiguous `/`, `%`, `<<` or `?` after an
     * identifier: with a space before it and none after, it opens a literal
     * passed as an argument; otherwise it is an operator. After a local it
     * is an operator whatever the spacing.
     */
    const spacedArgument = (next: string): boolean =>
      afterValue &&
      lastWord !== "" &&
      !locals.has(lastWord) &&
      /\s/u.test(previousChar()) &&
      !/[\s=]/u.test(next);
    /** Skips a `#{...}` interpolation from its `{`, returning the offset after `}`. */
    const skipInterpolation = (brace: number): number | undefined =>
      scan(brace + 1, true);
    /** Skips a quoted string opening at `start`, returning the offset after it. */
    const skipString = (start: number, quote: string): number | undefined => {
      let at = start + 1;
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
    /** Consumes a token that ends a value and is not a word. */
    const value = (length: number): void => {
      index += length;
      afterValue = true;
      lastWord = "";
      defName = 0;
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
        defName = 0;
        continue;
      }
      if (nested && character === "{") {
        depth += 1;
        index += 1;
        afterValue = false;
        lastWord = "";
        continue;
      }
      if (nested && character === "}") {
        if (depth === 0) {
          return index + 1;
        }
        depth -= 1;
        value(1);
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
      const global = RUBY_SPECIAL_GLOBAL.exec(source.slice(index, index + 3));
      if (global !== null) {
        value(global[0].length);
        continue;
      }
      // `def /(other)`, `` def `(cmd) `` and the symbol `:/` name an operator;
      // none of them opens a regex, a string or a percent literal.
      if (defName === 1 || (character === ":" && previousChar() !== ":")) {
        const at = defName === 1 ? index : index + 1;
        const operator = RUBY_OPERATOR.exec(source.slice(at, at + 3));
        if (operator !== null) {
          value(at - index + operator[0].length);
          continue;
        }
      }
      // A heredoc opener; the body is blanked when this line ends. After an
      // identifier it is one only if a later line closes it: `buf <<line`
      // with no `line` line is a shift, and so is any `<<` after a local.
      const heredoc = /^<<([~-]?)(?:(["'`])([^\n]+?)\2|([A-Za-z_]\w*))/u.exec(
        source.slice(index, index + 80),
      );
      if (heredoc !== null && lastWord !== "class") {
        const opener = { tag: heredoc[3] ?? heredoc[4] ?? "", indented: heredoc[1] !== "" };
        if (
          !afterValue ||
          (spacedArgument(source[index + 2] ?? "") && hasTerminator(opener, index))
        ) {
          pending.push(opener);
          blank(index, index + heredoc[0].length);
          value(heredoc[0].length);
          continue;
        }
      }
      const percent = /^%([wWiIqQrsx]?)([^\w\s])/u.exec(source.slice(index, index + 3));
      if (
        percent !== null &&
        (percent[1] !== "" || /[([{<|!/]/u.test(percent[2] ?? "")) &&
        (!afterValue || spacedArgument(source[index + 1] ?? ""))
      ) {
        const open = percent[2] ?? "";
        const close = RUBY_PAIRS[open] ?? open;
        const interpolates = RUBY_PERCENT_INTERPOLATES.has(percent[1] ?? "");
        let nesting = 1;
        let at = index + percent[0].length;
        for (;;) {
          if (at >= source.length) {
            return undefined;
          }
          if (source[at] === "\\") {
            at += 2;
            continue;
          }
          if (interpolates && source[at] === "#" && source[at + 1] === "{") {
            const end = skipInterpolation(at + 1);
            if (end === undefined) {
              return undefined;
            }
            at = end;
            continue;
          }
          if (source[at] === open && close !== open) {
            nesting += 1;
          } else if (source[at] === close) {
            nesting -= 1;
            if (nesting === 0) {
              at += 1;
              break;
            }
          }
          at += 1;
        }
        blank(index, at);
        value(at - index);
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        const end = skipString(index, character);
        if (end === undefined) {
          return undefined;
        }
        blank(index, end);
        value(end - index);
        continue;
      }
      // A regex, where a value is expected; a division where one just ended.
      // The literal may span lines — `/\n  \A(\d+)\n/x` is one regex — so
      // only the end of the file is a lost place.
      if (character === "/" && (!afterValue || spacedArgument(source[index + 1] ?? ""))) {
        let at = index + 1;
        for (;;) {
          if (at >= source.length) {
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
        value(at - index);
        continue;
      }
      // A character literal, `?'`, where a value is expected.
      const charLiteral = /^\?(?:\\.|[^\s\w])(?!\w)/u.exec(source.slice(index, index + 4));
      if (charLiteral !== null && (!afterValue || spacedArgument(source[index + 1] ?? ""))) {
        blank(index, index + charLiteral[0].length);
        value(charLiteral[0].length);
        continue;
      }
      const word = /^[A-Za-z_]\w*[?!]?/u.exec(source.slice(index, index + 80));
      if (word !== null) {
        const name = word[0];
        // An instance, class or global variable is a value and never a
        // method taking an argument, so nothing after it is spaced-argument
        // ambiguous.
        const variable = /[@$]/u.test(previousChar());
        if (
          !variable &&
          /^\s*(?:\|\||&&|\*\*|<<|>>|[+\-*/%|&^])?=(?![=~>])/u.test(
            source.slice(index + name.length, index + name.length + 8),
          )
        ) {
          locals.add(name);
        }
        defName = defName === 1 ? 2 : name === "def" ? 1 : 0;
        lastWord = variable ? "" : name;
        afterValue = variable || !RUBY_VALUE_EXPECTED.has(name);
        index += name.length;
        continue;
      }
      const number = /^\d[\w.]*/u.exec(source.slice(index, index + 40));
      if (number !== null) {
        value(number[0].length);
        continue;
      }
      afterValue = /[)\]}]/u.test(character);
      lastWord = "";
      // `def self.` still awaits the method's name.
      defName = character === "." && defName === 2 ? 1 : 0;
      index += 1;
    }
    return nested ? undefined : index;
  };

  if (scan(0, false) === undefined || pending.length > 0) {
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
    /(?:^|[\s;({])(require|require_relative)[\s(]+(["'])((?:[^"'\n#]|#(?!\{))+)\2(?=\s*(?:$|[;#)}]|\b(?:if|unless|rescue|end)\b))/gmu,
  )) {
    const specifier = match[3];
    // Matched against the original, because the masker blanks the quoted
    // argument itself — it is a string, and that is the whole point of it.
    // The mask decides only whether the *keyword* was code: a `require`
    // inside a heredoc or a comment has been blanked away there. The
    // lookahead is what keeps `require 'plugins/' + name` — computed at run
    // time — from being read as `plugins/`, and the specifier class refuses
    // `require "drb/#{name}"` for the same reason: an interpolation is a
    // run-time value, not a file, and never something to hand on as one. A
    // one-line block, `-> { require 'x' }`, is code like any other.
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
    // Everything after `__halt_compiler();` is data — a PHAR stub's payload,
    // an installer's archive — and PHP never reads it as code.
    if (
      source[index] === "_" &&
      !/[\w$\\>]/u.test(source[index - 1] ?? "") &&
      /^__halt_compiler\s*\(\s*\)/iu.test(source.slice(index, index + 40))
    ) {
      blank(index, source.length);
      break;
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
    // A backtick runs a shell command, and its text is a string like any
    // other: `echo it's` holds an apostrophe, not the start of a string.
    if (character === '"' || character === "'" || character === "`") {
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
          character !== "'" &&
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
  // A block with no name, `namespace { }`, is the global namespace and
  // counts as a block: beside a named one it is the second, and the
  // classes in it are not the named one's.
  const namespaces = [
    ...code.matchAll(/(?:^|[\s;{}])namespace(?:\s+([\w\\]+))?\s*[;{]/gu),
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
  //
  // The whole clause up to its `;` is read, because one clause can name
  // several classes: `use A\B\{C, D};` and `use A\C, A\D;` are both one
  // statement. A clause that is not a name list — a closure's `use ($x)`
  // reaches the same `;` — names nothing.
  const uses: string[] = [];
  for (const match of code.matchAll(
    /(?<=^|[\s;{}])use\s+(function\s+|const\s+)?([^;]+);/gu,
  )) {
    if (match[1] !== undefined || match.index === undefined) {
      continue;
    }
    if (insideNamespaceOnly(code, match.index)) {
      uses.push(...phpUseNames(match[2] ?? ""));
    }
  }
  // Against the original for the same reason Ruby's is: the argument is a
  // string, so the masker has already blanked it. The lookahead refuses a
  // computed path, `require 'f.php' . $ext`, rather than half-reading it.
  // `@include 'x.php'` is the same include with its errors suppressed, and
  // `require "$dir/x.php"` is computed: a variable in the string is not a
  // path, and is not handed on as one.
  const requires = [
    ...source.matchAll(
      /(?:^|[\s;({@])(require|include)(?:_once)?[\s(]+(["'])([^"'\n$]+)\2(?=\s*(?:[;)]|\?>|$))/gmu,
    ),
  ]
    .filter((match) => keywordIsCode(source, code, match))
    .map((match) => match[3] ?? "")
    .filter((name) => name !== "");
  return { namespace, declared, uses, requires };
}

/**
 * The classes one `use` clause names, with the group and list forms
 * expanded and aliases dropped, or nothing when the clause is not a list
 * of names at all.
 */
function phpUseNames(clause: string): string[] {
  const group = /^([\w\\]+\\)\{([^{}]*)\}$/u.exec(clause.trim());
  const prefix = group === null ? "" : (group[1] ?? "");
  const items = (group === null ? clause : (group[2] ?? "")).split(",");
  const names: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    // A trailing comma inside the braces is allowed and names nothing.
    if (item === "") {
      continue;
    }
    const parsed = /^(?:(function|const)\s+)?([\w\\]+)(?:\s+as\s+\w+)?$/iu.exec(item);
    if (parsed === null) {
      return [];
    }
    // `use A\{function f, const C, D}`: only `D` is a class.
    if (parsed[1] === undefined) {
      names.push(`${prefix}${parsed[2] ?? ""}`.replace(/^\\/u, ""));
    }
  }
  return names;
}

/** Whether every brace open at `offset` is a `namespace X {` or `namespace {` block. */
function insideNamespaceOnly(code: string, offset: number): boolean {
  const stack: boolean[] = [];
  for (let at = 0; at < offset; at += 1) {
    const character = code[at];
    if (character === "{") {
      stack.push(
        /(?:^|[\s;{}])namespace(?:\s+[\w\\]+)?\s*$/u.test(code.slice(Math.max(0, at - 120), at)),
      );
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
