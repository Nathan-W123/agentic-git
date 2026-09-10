/**
 * Whether the dashboard's own JavaScript parses.
 *
 * Everything in `apps/web/public` is served to a browser exactly as it sits on
 * disk. There is no bundler, no transpile step and no `tsc` over it: these are
 * hand-written ES modules, and `turbo run build` never reads them. A stray
 * backtick inside a template literal, a missing brace at the end of a long
 * function — the kind of edit that a type checker catches in a second
 * everywhere else in this repository — compiles, tests, builds, deploys, and
 * then fails in the one place nobody is looking, at the browser's parser,
 * taking the whole screen with it because a module that will not parse fails
 * every module that imports it.
 *
 * That happened twice while this file's neighbours were being written, both
 * times the same way and both times found by a person loading the page. So
 * this is the parser, run over the served set, on every `npm run check`.
 *
 * Deliberately only syntax. What the modules *do* is pinned across a thousand
 * assertions in `assets.test.ts`, and which of them are served and whether
 * their imports resolve is pinned there too. The one thing nothing anywhere
 * asked was whether the file is JavaScript at all.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory, loadStaticAssets } from "./assets.js";

/**
 * Parses one module without running it.
 *
 * Through stdin with an explicit `--input-type`, rather than by handing the
 * path to `node --check`. Given a `.js` file Node has to *guess* whether it is
 * a script or a module, and when it guesses module the check silently returns
 * success on source that does not parse — `node --check` over a file
 * containing `export const a = ;` exits 0. It only reports the error when the
 * module-ness is settled before the parse, which `--input-type=module` does
 * and a file extension does not.
 *
 * The consequence if this is got wrong is not a worse message; it is a test
 * that passes over every possible input, which is the failure this whole file
 * exists to stop being possible.
 */
function parseError(source: string): string | undefined {
  const checked = spawnSync(
    process.execPath,
    ["--input-type=module", "--check"],
    { input: source, encoding: "utf8" },
  );
  if (checked.status === 0) {
    return undefined;
  }
  return (checked.stderr || checked.stdout || "node exited non-zero").trim();
}

test("every browser module the dashboard ships parses as JavaScript", async () => {
  const directory = defaultPublicDirectory();
  const scripts = (await readdir(directory))
    .filter((name) => name.endsWith(".js"))
    .sort();
  // A count, so that a public directory that somehow read as empty fails here
  // rather than passing vacuously with nothing to check.
  assert.ok(
    scripts.length >= 10,
    `expected the dashboard's modules in ${directory}, found ${String(scripts.length)}`,
  );

  const broken: string[] = [];
  for (const name of scripts) {
    const source = await readFile(path.join(directory, name), "utf8");
    const failure = parseError(source);
    if (failure !== undefined) {
      broken.push(`${name}\n${failure}`);
    }
  }
  assert.deepEqual(broken, [], `\n\n${broken.join("\n\n")}\n`);
});

test("the parser this runs is one that can actually fail", () => {
  // The guard on the guard. `node --check` over a path is the obvious way to
  // write the function above and is silently a no-op for exactly these files,
  // so "it reported no errors" is only worth anything if it can report one.
  assert.equal(parseError("export const ok = 1;\n"), undefined);
  assert.notEqual(parseError("export const broken = ;\n"), undefined);
  // The two ways the dashboard has actually broken: an unclosed template
  // literal, and a brace that never closes at the end of a long function.
  assert.notEqual(parseError("const t = `unterminated ${1}\n"), undefined);
  assert.notEqual(parseError("export function f() {\n  return 1;\n"), undefined);
  // And module syntax is not itself the error. A checker that rejected
  // `export` would report every file as broken and be just as useless.
  assert.equal(parseError("import { a } from './b.js';\nexport { a };\n"), undefined);
});

test("nothing served as JavaScript is unparseable, whatever it is named", async () => {
  // Read through the served set rather than the directory, because the
  // directory is not the contract — the gateway serves an allowlist, and a
  // module could be added to that list under any name.
  const assets = await loadStaticAssets();
  const broken: string[] = [];
  for (const [url, asset] of assets) {
    if (!asset.contentType.startsWith("text/javascript")) {
      continue;
    }
    // The vendored Monaco tree is somebody else's build product, shipped as
    // it was published. If it does not parse, that is not a thing anybody
    // here can fix by editing it.
    if (url.startsWith("/vendor/")) {
      continue;
    }
    const source =
      typeof asset.body === "string" ? asset.body : asset.body.toString("utf8");
    const failure = parseError(source);
    if (failure !== undefined) {
      broken.push(`${url}\n${failure}`);
    }
  }
  assert.deepEqual(broken, [], `\n\n${broken.join("\n\n")}\n`);
});
