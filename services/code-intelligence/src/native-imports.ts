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

/**
 * Blanks comments, keeping string bodies — the header name lives in one.
 *
 * Lines that *begin* inside a raw string or a block comment are reported so
 * the caller can skip them: that is what stops a `#include` written inside
 * `R"cpp( ... )cpp"` from becoming an edge.
 */
export function maskNative(source: string): { text: string; dead: Set<number> } | undefined {
  const out = source.split("");
  const dead = new Set<number>();
  let line = 0;
  const lineOf = new Map<number, number>();
  for (let at = 0; at < source.length; at += 1) {
    lineOf.set(at, line);
    if (source[at] === "\n") {
      line += 1;
    }
  }
  const markDead = (from: number, to: number): void => {
    let first = (lineOf.get(from) ?? 0) + 1;
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
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
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
      markDead(index, end + 2);
      blank(index, end + 2);
      index = end + 2;
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
      index += number?.[0].length ?? 1;
      continue;
    }
    const raw = /^(?:u8|u|U|L)?R"([^ ()\\\t\n]{0,16})\(/u.exec(source.slice(index));
    if (raw !== null && !/\w/u.test(source[index - 1] ?? "")) {
      const terminator = `)${raw[1] ?? ""}"`;
      const end = source.indexOf(terminator, index + raw[0].length);
      if (end === -1) {
        return undefined;
      }
      markDead(index, end + terminator.length);
      index = end + terminator.length;
      continue;
    }
    const character = source[index] ?? "";
    if (character === '"' || character === "'") {
      let at = index + 1;
      for (;;) {
        if (at >= source.length || source[at] === "\n") {
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
      // Left intact: the header name is inside it.
      index = at;
      continue;
    }
    index += 1;
  }
  return { text: out.join(""), dead };
}

/** A quoted `#include`, which is the only kind with a path in it. */
export function readIncludes(source: string): string[] | undefined {
  const masked = maskNative(source);
  if (masked === undefined) {
    return undefined;
  }
  const out: string[] = [];
  const lines = masked.text.split("\n");
  for (const [position, line] of lines.entries()) {
    if (masked.dead.has(position)) {
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
  const masked = maskNative(source);
  if (masked === undefined) {
    return undefined;
  }
  const out: string[] = [];
  for (const [position, line] of masked.text.split("\n").entries()) {
    if (masked.dead.has(position)) {
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
  const beside = posixJoin(posixDirname(fromFile), specifier);
  return beside !== "" && beside !== fromFile && context.files.has(beside)
    ? [beside]
    : [];
}
