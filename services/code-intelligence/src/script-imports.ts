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

/** Blanks Ruby comments, strings, heredocs and percent literals. */
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
  const atLineStart = (at: number): boolean =>
    at === 0 || source[at - 1] === "\n";
  while (index < source.length) {
    const character = source[index] ?? "";
    // Everything below `__END__` is data, and is a complete answer above it.
    if (atLineStart(index) && source.startsWith("__END__", index)) {
      blank(index, source.length);
      break;
    }
    if (atLineStart(index) && source.startsWith("=begin", index)) {
      const end = source.indexOf("\n=end", index);
      if (end === -1) {
        return undefined;
      }
      const lineEnd = source.indexOf("\n", end + 1);
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
    // A heredoc runs from the line *after* the opener to its terminator.
    const heredoc = /^<<([~-]?)(["'`]?)([A-Za-z_]\w*)\2/u.exec(source.slice(index));
    if (heredoc !== null && /[=(,\s]|^$/u.test(source[index - 1] ?? "")) {
      const tag = heredoc[3] ?? "";
      const squiggly = heredoc[1] !== "";
      const bodyStart = source.indexOf("\n", index);
      if (bodyStart === -1) {
        return undefined;
      }
      const terminator = new RegExp(
        `^${squiggly ? "[ \\t]*" : ""}${tag}[ \\t]*$`,
        "mu",
      );
      const after = source.slice(bodyStart + 1);
      const found = terminator.exec(after);
      if (found === null) {
        return undefined;
      }
      const end = bodyStart + 1 + found.index + found[0].length;
      blank(index, index + heredoc[0].length);
      blank(bodyStart + 1, end);
      index = end;
      continue;
    }
    const percent = /^%([wWiIqQrsx]?)(.)/u.exec(source.slice(index));
    if (
      percent !== null &&
      (percent[1] !== "" || /[([{<|!/]/u.test(percent[2] ?? "")) &&
      !/[\w)\]}]/u.test(source[index - 1] ?? "")
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
      continue;
    }
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
    /(?:^|[\s;(])(require|require_relative)[\s(]+(["'])([^"'\n]+)\2/gu,
  )) {
    const specifier = match[3];
    // Matched against the original, because the masker blanks the quoted
    // argument itself — it is a string, and that is the whole point of it.
    // The mask decides only whether the *keyword* was code: a `require`
    // inside a heredoc or a comment has been blanked away there.
    if (specifier !== undefined && keywordIsCode(source, code, match)) {
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
  const withExtension = (base: string): string | undefined => {
    if (base === "") {
      return undefined;
    }
    for (const candidate of [base.endsWith(".rb") ? base : `${base}.rb`, base]) {
      if (files.has(candidate)) {
        return candidate;
      }
    }
    return undefined;
  };
  if (request.relative) {
    const hit = withExtension(
      posixJoin(posixDirname(fromFile), request.specifier),
    );
    return hit === undefined || hit === fromFile ? [] : [hit];
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
      const open = source.indexOf("<?php", index);
      const short = source.indexOf("<?=", index);
      const at = open === -1 ? short : short === -1 ? open : Math.min(open, short);
      if (at === -1) {
        blank(index, source.length);
        break;
      }
      // Everything before the tag is markup, not code.
      blank(index, at);
      index = at + (at === open ? 5 : 3);
      inCode = true;
      continue;
    }
    if (source.startsWith("?>", index)) {
      inCode = false;
      index += 2;
      continue;
    }
    // `#[` opens a PHP 8 attribute, not a comment — and `#[Route('/x')]` is
    // exactly the line a route reader needs to see.
    if (
      source.startsWith("//", index) ||
      (source[index] === "#" && !source.startsWith("#[", index))
    ) {
      const end = source.indexOf("\n", index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
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
    const heredoc = /^<<<(["']?)([A-Za-z_]\w*)\1/u.exec(source.slice(index));
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
  const namespace = /(?:^|[\s;{])namespace\s+([\w\\]+)\s*[;{]/u
    .exec(code)?.[1]
    ?.replace(/^\\/u, "") ?? "";
  const declared = [
    ...code.matchAll(
      /(?:^|[\s;{}])(?:final\s+|abstract\s+|readonly\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/gu,
    ),
  ]
    .map((match) => match[1] ?? "")
    .filter((name) => name !== "");
  const uses = [
    ...code.matchAll(/(?:^|[\s;{}])use\s+(?:function\s+|const\s+)?([\w\\]+)\s*(?:;|\sas\s)/gu),
  ]
    .map((match) => (match[1] ?? "").replace(/^\\/u, ""))
    .filter((name) => name !== "");
  // Against the original for the same reason Ruby's is: the argument is a
  // string, so the masker has already blanked it.
  const requires = [
    ...source.matchAll(
      /(?:^|[\s;({])(require|include)(?:_once)?[\s(]+(["'])([^"'\n]+)\2/gu,
    ),
  ]
    .filter((match) => keywordIsCode(source, code, match))
    .map((match) => match[3] ?? "")
    .filter((name) => name !== "");
  return { namespace, declared, uses, requires };
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
  const hit = posixJoin(posixDirname(fromFile), specifier);
  return hit !== "" && hit !== fromFile && context.files.has(hit) ? [hit] : [];
}
