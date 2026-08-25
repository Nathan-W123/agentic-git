import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A function you can call but never imported is a crash waiting for a route.
 *
 * The dashboard is plain ES modules with no bundler and no type checking over
 * `public/`, so nothing objects when one module calls another's export and
 * forgets to import it. Parsing succeeds. Loading succeeds. Every screen that
 * does not reach that line works. The failure arrives the first time somebody
 * renders the one branch that does, as a `ReferenceError` that takes the whole
 * page down — which is how `canManageOrganization` reached production: called
 * twice in `app.js`, exported from `data.js`, imported by `screen-chats.js`,
 * and missing from `app.js` entirely.
 *
 * Deliberately narrow. It does not attempt to resolve every identifier — that
 * is a type checker's job and this is a 10,000-line browser module. It asks
 * one question: of the names these modules export to each other, is any of
 * them *called* somewhere that neither imports nor defines it?
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

/**
 * The source with its comments blanked out, and nothing else touched.
 *
 * This file's prose is full of `render()` and `canManageOrganization()` —
 * naming a function is how the comments explain anything — and a check that
 * reads those as calls reports the documentation instead of the code. Strings
 * and template literals are deliberately kept: template literals are where
 * most of this codebase's real calls live, inside `${...}`.
 */
function withoutComments(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at] as string;
    const next = source[at + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
      } else if (char === "/" && next === "*") {
        state = "block";
      } else if (char === "'" || char === '"' || char === "`") {
        state = char;
        out += char;
        continue;
      } else {
        out += char;
        continue;
      }
      out += "  ";
      at += 1;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
      }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        at += 1;
        out += "  ";
      }
      continue;
    }
    // Inside a string or template: copy through, minding escapes.
    out += char;
    if (char === "\\") {
      out += source[at + 1] ?? "";
      at += 1;
    } else if (char === state) {
      state = "code";
    }
  }
  return out;
}

/** Every `export function x` / `export const x` a module offers. */
function exportsOf(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gmu,
  )) {
    names.add(match[1] as string);
  }
  return names;
}

/** Everything a module pulls in, from any module, plus what it declares itself. */
function availableIn(source: string): Set<string> {
  const known = new Set<string>();
  for (const block of source.matchAll(/import\s*\{([^}]*)\}\s*from/gu)) {
    for (const entry of (block[1] as string).split(",")) {
      const name = entry.trim().split(/\s+as\s+/u).pop()?.trim();
      if (name !== undefined && name !== "") {
        known.add(name);
      }
    }
  }
  // Declared locally counts too — a module may define its own `render`.
  for (const match of source.matchAll(
    /(?:^|\s)(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gmu,
  )) {
    known.add(match[1] as string);
  }
  return known;
}

test("every shared function a module calls is one it can actually reach", async () => {
  const files = (await readdir(publicDir)).filter((name) => name.endsWith(".js"));
  const sources = new Map<string, string>();
  for (const file of files) {
    sources.set(
      file,
      withoutComments(await readFile(path.join(publicDir, file), "utf8")),
    );
  }

  // The pool of names modules share with each other.
  const shared = new Map<string, string>();
  for (const [file, source] of sources) {
    for (const name of exportsOf(source)) {
      shared.set(name, file);
    }
  }

  const unreachable: string[] = [];
  for (const [file, source] of sources) {
    const known = availableIn(source);
    for (const [name, from] of shared) {
      if (from === file || known.has(name)) {
        continue;
      }
      // Called, rather than merely mentioned in a comment or a string.
      const called = new RegExp(`(?<![.\\w$])${name}\\s*\\(`, "u");
      if (called.test(source)) {
        unreachable.push(`${file} calls ${name}() but never imports it (${from} exports it)`);
      }
    }
  }

  assert.deepEqual(unreachable, [], unreachable.join("\n"));
});
