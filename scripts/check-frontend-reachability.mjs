#!/usr/bin/env node
/**
 * Every control the web app paints, and every path it asks for, checked for
 * somewhere to land.
 *
 * `apps/web/public/*.js` is shipped verbatim — nothing compiles it, typechecks
 * it or lints it — and the gateway it talks to is a hand-rolled router in
 * another package. So the two halves of every feature are joined by a string,
 * and a string can be wrong in silence: a button renders and takes a click, a
 * `fetch` goes out and comes back 404, and both look to the person using it
 * exactly like nothing happening.
 *
 * That is not hypothetical. `POST .../workspace/move` had a handler, an entry
 * on the operations interface, an implementation in the overlay and a caller
 * in the browser — and `move` was missing from the one regex that decides
 * which workspace actions the route matches, so dragging a file onto a folder
 * answered "Route was not found" for as long as the feature had existed.
 *
 * Three questions, none of which any other check in this repo asks:
 *
 *   1. Does every `data-act` the UI paints have a case that answers it?
 *   2. Does every path the browser asks for match a route the gateway serves?
 *   3. Does every navigation target name a route or settings section?
 *
 * Reported, not thrown, for the shapes this cannot decide from source alone —
 * an element identified by `data-act` for a `querySelector` rather than for a
 * click is not a dead control, and there is no way to tell them apart without
 * running the app. The exit code is about the answers that are unambiguous.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "apps/web/public");
const routesDir = path.join(root, "services/api-gateway/src/routes");

const modules = new Map(
  readdirSync(publicDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => [name, readFileSync(path.join(publicDir, name), "utf8")]),
);

const add = (map, key, where) => {
  const seen = map.get(key) ?? new Set();
  seen.add(where);
  map.set(key, seen);
};

/* ------------------------------------------------ 1. painted controls ---- */

const painted = new Map();
const handled = new Map();
for (const [name, text] of modules) {
  for (const match of text.matchAll(/data-act="([^"$]+)"/gu)) {
    add(painted, match[1], name);
  }
  // The row and menu helpers take the action as a property and write the
  // attribute themselves, so a control declared that way is just as painted.
  for (const match of text.matchAll(/\bact:\s*"([^"]+)"/gu)) {
    add(painted, match[1], name);
  }
  for (const match of text.matchAll(/^\s*case "([^"]+)":/gmu)) {
    add(handled, match[1], name);
  }
}

// A control the dispatcher never sees a case for, and that nothing else
// looks up either. The second half is what keeps inputs and popover anchors
// out of this: those carry `data-act` so something can *find* them, not so
// something can answer them. A menu row marked `disabled: true` is inert on
// purpose and is not a dead end either.
const orphans = [...painted.keys()]
  .filter((act) => {
    if (handled.has(act)) {
      return false;
    }
    return ![...modules.values()].some(
      (text) =>
        text.includes(`[data-act="${act}"]`) ||
        text.includes(`=== "${act}"`) ||
        text.includes(`!== "${act}"`) ||
        new RegExp(`act: "${act}"[\\s\\S]{0,200}disabled: true`, "u").test(text) ||
        // A key in a lookup table is data, not a control. The colour swatches
        // carry their field name in `data-value` and dispatch through one
        // shared action, so the name never reaches the switch and is not
        // supposed to.
        text.includes(`"${act}":`),
    );
  })
  .sort();

/* ---------------------------------------------------- 2. asked paths ---- */

const called = new Map();
for (const [name, text] of modules) {
  for (const match of text.matchAll(
    /\b(?:api|apiOptional|apiRaw)\(\s*[`"]([^`"]+)[`"]/gu,
  )) {
    const raw = match[1];
    if (!raw.startsWith("/")) {
      continue;
    }
    const shape = raw.replace(/\$\{[^}]*\}/gu, "*").split("?")[0].replace(/\/$/u, "");
    add(called, shape, `${name}:${text.slice(0, match.index).split("\n").length}`);
  }
}

const served = new Set();
for (const name of readdirSync(routesDir).filter((entry) => entry.endsWith(".ts"))) {
  const text = readFileSync(path.join(routesDir, name), "utf8");
  for (const match of text.matchAll(/path === `\$\{API_PREFIX\}([^`]*)`/gu)) {
    served.add(match[1].replace(/\/$/u, ""));
  }
  for (const match of text.matchAll(/path\.startsWith\(`\$\{API_PREFIX\}([^`]*)`/gu)) {
    served.add(`${match[1].replace(/\/$/u, "")}/**`);
  }
  // A route regex may be split across concatenated template literals, which is
  // how the workspace family is written — so the pieces are joined before the
  // shape is read, and an alternation group is expanded into one shape each.
  for (const match of text.matchAll(
    /new RegExp\(\s*((?:`[^`]*`(?:\s*\+\s*)?)+)\s*,/gu,
  )) {
    const joined = [...match[1].matchAll(/`([^`]*)`/gu)].map((m) => m[1]).join("");
    if (!joined.startsWith("^${API_PREFIX}")) {
      continue;
    }
    const shape = joined
      .slice("^${API_PREFIX}".length)
      .replace(/\(\[\^\/\]\+\)/gu, "*")
      .replace(/\(\[\^\/\]\*\)/gu, "*")
      .replace(/\$$/u, "")
      .replace(/\/$/u, "");
    const alternation = /\(([a-z|-]+)\)/u.exec(shape);
    if (alternation !== null && alternation[1].includes("|")) {
      for (const option of alternation[1].split("|")) {
        served.add(
          shape.slice(0, alternation.index) +
            option +
            shape.slice(alternation.index + alternation[0].length),
        );
      }
    } else {
      served.add(shape);
    }
  }
}

const answers = (shape) => {
  const target = shape.startsWith("/api/v1") ? shape.slice("/api/v1".length) : shape;
  for (const entry of served) {
    if (entry === target) {
      return true;
    }
    if (entry.endsWith("/**") && target.startsWith(entry.slice(0, -3))) {
      return true;
    }
    const a = entry.split("/");
    const b = target.split("/");
    if (
      a.length === b.length &&
      a.every((part, index) => part === "*" || b[index] === "*" || part === b[index])
    ) {
      return true;
    }
  }
  return false;
};

const unserved = [...called.keys()].filter((shape) => !answers(shape)).sort();

/* --------------------------------------------- 3. navigation targets ---- */

const app = modules.get("app.js") ?? "";
const routeSet = new Set(
  [...(/const ROUTES = new Set\(\[([\s\S]*?)\]\)/u.exec(app)?.[1] ?? "").matchAll(
    /"([^"]+)"/gu,
  )].map((match) => match[1]),
);
const targets = new Map();
for (const [name, text] of modules) {
  for (const match of text.matchAll(/\bnavigate\(\s*"([^"]+)"\s*\)/gu)) {
    add(targets, match[1], name);
  }
}
const strays = [...targets.keys()]
  .filter(
    (target) =>
      !routeSet.has(target) && target !== "settings" && target !== "advanced",
  )
  .sort();

/* ------------------------------------------------------------ report ---- */

const say = (label, rows, detail) => {
  if (rows.length === 0) {
    return 0;
  }
  console.error(`\n${label}`);
  for (const row of rows) {
    console.error(`  ${row}${detail(row)}`);
  }
  return rows.length;
};

let failures = 0;
failures += say(
  "Paths the browser asks for that no route serves:",
  unserved,
  (shape) => ` <- ${[...(called.get(shape) ?? [])].join(", ")}`,
);
let warnings = say(
  "Navigation targets that fall back rather than resolve:",
  strays,
  (target) => ` <- ${[...(targets.get(target) ?? [])].join(", ")}`,
);
warnings += say(
  "Controls painted with nothing that answers them:",
  orphans,
  (act) => ` <- ${[...(painted.get(act) ?? [])].join(", ")}`,
);

console.log(
  `\npublic/*.js: ${painted.size} controls painted, ${handled.size} answered; ` +
    `${called.size} paths asked of ${served.size} route shapes; ` +
    `${targets.size} navigation targets`,
);
if (failures > 0) {
  console.error(`\n${failures} unreachable path(s).`);
  process.exit(1);
}
if (warnings > 0) {
  console.log(`${warnings} thing(s) above are worth a look, none of them fatal.`);
}
