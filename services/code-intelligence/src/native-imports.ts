/**
 * C, C++ and Swift — and C#, which is the odd one out.
 *
 * `#include "money.h"` is a path, and a quoted include is resolved relative
 * to the including file first, then by searching. The search path is a
 * compiler flag this never reads, so the fallback is a suffix match over the
 * repository: `#include "billing/money.h"` finds `src/billing/money.h`, but
 * only when exactly one file ends that way.
 *
 * `import Foundation` in Swift and `using System.Text` in C# name *modules*
 * and *namespaces*, which are compilation units rather than files. A Swift
 * module is a whole build target and a C# namespace is spread across as many
 * files as anybody likes, so neither has a file to point at and neither
 * resolves. What C# does have is `#load "x.csx"`, which is a real path.
 *
 * Nothing here guesses. A missed edge costs a warning; a false edge blocks
 * work that should have run.
 */

import { posixDirname, posixJoin } from "./import-resolution.js";

/** Which lexer rules apply: C and C++ share one, C# has its own strings. */
export type NativeDialect = "c" | "csharp";

/**
 * Blanks comments, keeping string bodies — the header name lives in one.
 *
 * Lines that *begin* inside a raw string or a block comment are reported so
 * the caller can skip them: that is what stops a `#include` written inside
 * `R"cpp( ... )cpp"` from becoming an edge. So is every physical line that
 * continues the one above it — in C and C++ a line ending in `\` is spliced
 * onto the next before the preprocessor ever looks for a directive, so a
 * `//` comment ending in a Windows path, a `#define` body, or an `#include`
 * with a stray backslash all swallow the following line, and an `#include`
 * on that line is text to the compiler.
 *
 * The prose after `#error`, `#warning`, `#region` and `#pragma` is not
 * lexed: an apostrophe in "don't" is not a character literal. Nor is an
 * apostrophe that is not closed on its own line anywhere else — the
 * preprocessor treats one as a stray character, and so does this.
 */
export function maskNative(
  source: string,
  dialect: NativeDialect = "c",
): { text: string; dead: Set<number> } | undefined {
  if (source.startsWith("\uFEFF")) {
    source = source.slice(1);
  }
  const out = source.split("");
  const dead = new Set<number>();
  // The scanner only ever moves forward, so the current line is a counter
  // kept beside the index rather than a table of every offset — which a
  // large file overflowed.
  let line = 0;
  let index = 0;
  const advanceTo = (next: number): void => {
    for (let at = index; at < next && at < source.length; at += 1) {
      if (source[at] === "\n") {
        line += 1;
      }
    }
    index = next;
  };
  const markDead = (from: number, to: number): void => {
    let first = line + 1;
    for (let at = from; at < to && at < source.length; at += 1) {
      if (source[at] === "\n") {
        dead.add(first);
        first += 1;
      }
    }
  };
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < source.length; at += 1) {
      if (out[at] !== "\n") {
        out[at] = " ";
      }
    }
  };
  if (dialect === "c") {
    let at = 0;
    for (const [position, physical] of source.split("\n").entries()) {
      if (/\\[ \t]*\r?$/u.test(physical)) {
        dead.add(position + 1);
      }
      at += physical.length + 1;
    }
  }
  /** Where a line comment ends, following C's backslash splices. */
  const lineCommentEnd = (from: number): number => {
    let end = source.indexOf("\n", from);
    while (
      dialect === "c" &&
      end !== -1 &&
      /\\[ \t]*\r?$/u.test(source.slice(from, end))
    ) {
      from = end + 1;
      end = source.indexOf("\n", from);
    }
    return end === -1 ? source.length : end;
  };
  const atLineStart = (at: number): boolean =>
    /^[ \t]*$/u.test(source.slice(source.lastIndexOf("\n", at - 1) + 1, at));

  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = lineCommentEnd(index);
      markDead(index, end);
      blank(index, end);
      advanceTo(end);
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        return undefined;
      }
      markDead(index, end + 2);
      blank(index, end + 2);
      advanceTo(end + 2);
      continue;
    }
    // Directive prose: everything after these is a message, not code. A
    // `#pragma` is left alone except the ones that carry text, because
    // `#pragma include_alias` is something the reader has to see.
    if (
      source[index] === "#" &&
      atLineStart(index) &&
      /^#[ \t]*(?:error|warning|region|endregion|pragma[ \t]+(?:message|region|endregion))\b/u.test(
        source.slice(index, index + 32),
      )
    ) {
      const end = lineCommentEnd(index);
      blank(index + 1, end);
      advanceTo(end);
      continue;
    }
    // A preprocessing number, skipped whole. Without this `0x8000'0000ull`
    // reads as an opening character literal and everything after it is
    // swallowed as a string.
    if (
      /[0-9]/u.test(source[index] ?? "") &&
      !/[\w$'"]/u.test(source[index - 1] ?? "")
    ) {
      const number = /^[0-9](?:[\w.]|[eEpP][+-]|'\w)*/u.exec(source.slice(index));
      advanceTo(index + (number?.[0].length ?? 1));
      continue;
    }
    if (dialect === "csharp") {
      // A raw string ends at a run of quotes as long as the one that opened
      // it, and a verbatim one has no escapes except a doubled quote.
      const rawRun = /^\$*"{3,}/u.exec(source.slice(index, index + 40));
      if (rawRun !== null) {
        const quotes = rawRun[0].replace(/^\$*/u, "");
        const end = source.indexOf(quotes, index + rawRun[0].length);
        if (end === -1) {
          return undefined;
        }
        markDead(index, end + quotes.length);
        advanceTo(end + quotes.length);
        continue;
      }
      const verbatim = /^(?:@\$?|\$@)"/u.exec(source.slice(index, index + 3));
      if (verbatim !== null) {
        let at = index + verbatim[0].length;
        for (;;) {
          if (at >= source.length) {
            return undefined;
          }
          if (source[at] === '"') {
            if (source[at + 1] === '"') {
              at += 2;
              continue;
            }
            at += 1;
            break;
          }
          at += 1;
        }
        markDead(index, at);
        advanceTo(at);
        continue;
      }
    }
    const raw = /^(?:u8|u|U|L)?R"([^ ()\\\t\n]{0,16})\(/u.exec(source.slice(index, index + 24));
    if (dialect === "c" && raw !== null && !/\w/u.test(source[index - 1] ?? "")) {
      const terminator = `)${raw[1] ?? ""}"`;
      const end = source.indexOf(terminator, index + raw[0].length);
      if (end === -1) {
        return undefined;
      }
      markDead(index, end + terminator.length);
      advanceTo(end + terminator.length);
      continue;
    }
    const character = source[index] ?? "";
    if (character === '"' || character === "'") {
      let at = index + 1;
      let closed = false;
      for (;;) {
        if (at >= source.length || source[at] === "\n") {
          break;
        }
        if (source[at] === "\\") {
          at += 2;
          continue;
        }
        if (source[at] === character) {
          at += 1;
          closed = true;
          break;
        }
        at += 1;
      }
      if (!closed) {
        // An apostrophe with no partner on its line is a stray character;
        // an unterminated string is a file this cannot read.
        if (character === "'") {
          advanceTo(index + 1);
          continue;
        }
        return undefined;
      }
      // Left intact: the header name is inside it.
      advanceTo(at);
      continue;
    }
    advanceTo(index + 1);
  }
  return { text: out.join(""), dead };
}

/**
 * Whether each line sits inside a group the preprocessor never enters.
 *
 * Only `#if 0` (and C#'s `#if false`) is known to be dead; any other
 * condition depends on flags this cannot see and is left alone. An `#else`
 * or `#elif` after a dead opener is live, or at least not known dead.
 */
function excludedLines(lines: readonly string[], dialect: NativeDialect): Set<number> {
  const excluded = new Set<number>();
  const stack: boolean[] = [];
  const deadOpener = dialect === "c" ? /^[ \t]*#[ \t]*if[ \t]+0[ \t]*$/u : /^[ \t]*#[ \t]*if[ \t]+false[ \t]*$/u;
  for (const [position, line] of lines.entries()) {
    const directive = /^[ \t]*#[ \t]*(if|ifdef|ifndef|elif|else|endif)\b/u.exec(line)?.[1];
    if (directive === "if" || directive === "ifdef" || directive === "ifndef") {
      stack.push(deadOpener.test(line));
    } else if (directive === "elif" || directive === "else") {
      if (stack.length > 0) {
        stack[stack.length - 1] = false;
      }
    } else if (directive === "endif") {
      stack.pop();
    }
    if (stack.some(Boolean)) {
      excluded.add(position);
    }
  }
  return excluded;
}

/** A quoted `#include`, which is the only kind with a path in it. */
export function readIncludes(source: string): string[] | undefined {
  const masked = maskNative(source, "c");
  if (masked === undefined) {
    return undefined;
  }
  const out: string[] = [];
  const lines = masked.text.split("\n");
  const excluded = excludedLines(lines, "c");
  for (const [position, line] of lines.entries()) {
    if (masked.dead.has(position) || excluded.has(position)) {
      continue;
    }
    // Digraphs, trigraphs, and MSVC's include_alias, which silently remaps
    // every include in the translation unit. Any of them and nothing in this
    // file can be trusted.
    if (/^[ \t]*(?:%:|\?\?=)/u.test(line)) {
      return undefined;
    }
    if (/^[ \t]*#[ \t]*pragma[ \t]+include_alias[ \t]*\(/u.test(line)) {
      return undefined;
    }
    const quoted = /^[ \t]*#[ \t]*include[ \t]*"([^"\n]+)"/u.exec(line);
    if (quoted?.[1] !== undefined) {
      out.push(quoted[1]);
    }
    // An angled include names a system or search-path header. The search path
    // is a compiler flag; there is nothing here to resolve it against.
  }
  return out;
}

/** An absolute path is not in this repository, whatever it happens to match. */
function absolute(specifier: string): boolean {
  return specifier.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(specifier);
}

export interface NativeContext {
  files: ReadonlySet<string>;
  /** Path suffix to the single file carrying it; absent when several do. */
  suffixes: ReadonlyMap<string, string>;
}

/** Every path suffix that exactly one file has, for the include fallback. */
export function pathSuffixes(files: ReadonlySet<string>): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const file of files) {
    const segments = file.split("/");
    for (let at = 0; at < segments.length; at += 1) {
      const suffix = segments.slice(at).join("/");
      seen.set(suffix, seen.has(suffix) ? null : file);
    }
  }
  const unique = new Map<string, string>();
  for (const [suffix, file] of seen) {
    if (file !== null) {
      unique.set(suffix, file);
    }
  }
  return unique;
}

export function resolveInclude(
  fromFile: string,
  specifier: string,
  context: NativeContext,
): readonly string[] {
  if (absolute(specifier)) {
    return [];
  }
  // Relative to the including file first, which is what a quoted include
  // means before any search path is consulted.
  const beside = posixJoin(posixDirname(fromFile), specifier);
  if (beside !== "" && context.files.has(beside) && beside !== fromFile) {
    return [beside];
  }
  // Then the search path, which is a compiler flag. A suffix match stands in
  // for it, and only when exactly one file in the repository ends that way —
  // two `config.h` is precisely the case where guessing is wrong.
  const hit = context.suffixes.get(specifier.replace(/^\.\//u, ""));
  return hit === undefined || hit === fromFile ? [] : [hit];
}

/* ------------------------------------------------------------ C# ------- */

/** `#load "x.csx"` is a path; `using A.B` is a namespace and is not. */
export function readCSharpLoads(source: string): string[] | undefined {
  const masked = maskNative(source, "csharp");
  if (masked === undefined) {
    return undefined;
  }
  const out: string[] = [];
  const lines = masked.text.split("\n");
  const excluded = excludedLines(lines, "csharp");
  const raw = source.replace(/^\uFEFF/u, "").split("\n");
  for (const [position, line] of lines.entries()) {
    if (masked.dead.has(position) || excluded.has(position)) {
      continue;
    }
    // A directive must be the first thing on its line in the source as
    // written — a comment before it, blanked here, still disqualifies it.
    if (!/^[ \t]*#load\b/u.test(raw[position] ?? "")) {
      continue;
    }
    const load = /^[ \t]*#load[ \t]+"([^"\n]+)"/u.exec(line);
    if (load?.[1] !== undefined) {
      out.push(load[1]);
    }
  }
  return out;
}

export function resolveCSharpLoad(
  fromFile: string,
  specifier: string,
  context: NativeContext,
): readonly string[] {
  if (absolute(specifier)) {
    return [];
  }
  const beside = posixJoin(posixDirname(fromFile), specifier);
  return beside !== "" && beside !== fromFile && context.files.has(beside)
    ? [beside]
    : [];
}
