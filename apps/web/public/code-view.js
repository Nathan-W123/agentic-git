/**
 * Rendering source and unified diffs.
 *
 * The editor surface is built here rather than delegated to a full editor
 * because what the Code screen shows is mostly a *review* artefact: the
 * unified patch the coordinator actually recorded for a changeset. Rendering
 * that directly keeps the gutters, the +/- markers, and the line numbering
 * honest to the patch instead of re-deriving them from two buffers.
 */

import { esc } from "./ui.js";

/* ---------------------------------------------------------- highlight ---- */

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "default", "delete", "do", "else", "enum", "export", "extends", "finally",
  "for", "from", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "of", "private", "public", "readonly", "return",
  "static", "super", "switch", "this", "throw", "try", "type", "typeof", "var",
  "void", "while", "yield", "true", "false", "null", "undefined",
]);

const TYPES = new Set([
  "string", "number", "boolean", "object", "any", "unknown", "never", "Promise",
  "Array", "Record", "Map", "Set", "Error", "Router", "Date", "JSON", "Math",
]);

/**
 * A deliberately small tokenizer.
 *
 * It handles strings, comments, numbers, keywords, types, and call sites —
 * enough that TypeScript, JavaScript, JSON, and SQL read correctly. It is not
 * a parser and does not pretend to be: anything it cannot classify is left
 * as plain text rather than guessed at.
 */
export function highlight(line) {
  if (line === "") {
    return "";
  }
  const pattern =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:?=<>+\-*/%!&|]+)/gu;
  let out = "";
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    out += esc(line.slice(last, index));
    last = index + match[0].length;
    const [, comment, str, num, word, punctuation] = match;
    if (comment !== undefined) {
      out += `<span class="tk-com">${esc(comment)}</span>`;
    } else if (str !== undefined) {
      out += `<span class="tk-str">${esc(str)}</span>`;
    } else if (num !== undefined) {
      out += `<span class="tk-num">${esc(num)}</span>`;
    } else if (word !== undefined) {
      const after = line.slice(last);
      if (KEYWORDS.has(word)) {
        out += `<span class="tk-key">${esc(word)}</span>`;
      } else if (TYPES.has(word) || /^[A-Z]/u.test(word)) {
        out += `<span class="tk-typ">${esc(word)}</span>`;
      } else if (/^\s*\(/u.test(after)) {
        out += `<span class="tk-fn">${esc(word)}</span>`;
      } else {
        out += esc(word);
      }
    } else if (punctuation !== undefined) {
      out += `<span class="tk-pun">${esc(punctuation)}</span>`;
    }
  }
  return out + esc(line.slice(last));
}

/* --------------------------------------------------------------- diff ---- */

/**
 * Parses a unified diff into positioned rows.
 *
 * Headers and hunk markers are kept as `gap` rows rather than dropped: a
 * reader needs to see that the patch skipped a region, otherwise consecutive
 * line numbers imply a continuity the file does not have.
 */
export function parsePatch(patch) {
  const rows = [];
  if (typeof patch !== "string" || patch.length === 0) {
    return rows;
  }
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ")
    ) {
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "gap", text: hunk[3].trim() || "…" });
      continue;
    }
    if (line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", newNo: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo: oldLine, text: line.slice(1) });
      oldLine += 1;
    } else {
      rows.push({
        kind: "ctx",
        oldNo: oldLine,
        newNo: newLine,
        text: line.startsWith(" ") ? line.slice(1) : line,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

export function patchStats(patch) {
  let additions = 0;
  let deletions = 0;
  for (const row of parsePatch(patch)) {
    if (row.kind === "add") {
      additions += 1;
    } else if (row.kind === "del") {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

export function changeSetStats(changeSet) {
  let additions = 0;
  let deletions = 0;
  for (const file of changeSet?.patches ?? []) {
    const stats = patchStats(file.patch);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return {
    additions,
    deletions,
    files: changeSet?.patches?.length ?? 0,
  };
}

function diffRow(row) {
  const oldNo = row.oldNo === undefined ? "" : row.oldNo;
  const newNo = row.newNo === undefined ? "" : row.newNo;
  return `<div class="dline ${row.kind}"><span class="ln">${oldNo}</span><span class="ln">${newNo}</span><span class="src">${highlight(
    row.text,
  )}</span></div>`;
}

export function renderUnified(rows) {
  if (rows.length === 0) {
    return `<div class="dline ctx"><span class="ln"></span><span class="ln"></span><span class="src">No textual diff was recorded for this file.</span></div>`;
  }
  return rows.map(diffRow).join("");
}

/** Side-by-side: deletions on the left, additions on the right. */
export function renderSplit(rows) {
  const left = [];
  const right = [];
  for (const row of rows) {
    if (row.kind === "add") {
      right.push(row);
      left.push({ kind: "gap", text: "" });
    } else if (row.kind === "del") {
      left.push(row);
      right.push({ kind: "gap", text: "" });
    } else {
      left.push(row);
      right.push(row);
    }
  }
  const column = (entries) =>
    `<div class="side">${entries
      .map(
        (row) =>
          `<div class="dline ${row.kind}"><span class="ln">${
            row.kind === "add" ? (row.newNo ?? "") : (row.oldNo ?? "")
          }</span><span class="ln"></span><span class="src">${highlight(row.text)}</span></div>`,
      )
      .join("")}</div>`;
  return column(left) + column(right);
}

/** Plain source, numbered, for a file with no recorded patch. */
export function renderSource(content) {
  const lines = String(content ?? "").split("\n");
  return lines
    .map(
      (line, index) =>
        `<div class="dline ctx"><span class="ln">${index + 1}</span><span class="ln"></span><span class="src">${highlight(
          line,
        )}</span></div>`,
    )
    .join("");
}

/* --------------------------------------------------------------- tree ---- */

/** Groups flat paths into the nested directory shape the tree renders. */
export function buildTree(paths) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const entry of paths) {
    const path = typeof entry === "string" ? entry : entry.path;
    const parts = String(path).split("/").filter(Boolean);
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      const full = parts.slice(0, index + 1).join("/");
      if (!node.dirs.has(name)) {
        node.dirs.set(name, { name, path: full, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(name);
    }
    node.files.push({
      name: parts[parts.length - 1] ?? path,
      path,
      flag: typeof entry === "string" ? undefined : entry.flag,
    });
  }
  return root;
}

export function languageOf(path) {
  const extension = String(path).split(".").pop()?.toLowerCase();
  return (
    {
      ts: "TypeScript",
      tsx: "TypeScript",
      js: "JavaScript",
      jsx: "JavaScript",
      json: "JSON",
      md: "Markdown",
      sql: "SQL",
      yml: "YAML",
      yaml: "YAML",
      css: "CSS",
      html: "HTML",
      sh: "Shell",
      py: "Python",
    }[extension] ?? "Plain Text"
  );
}

export const FLAG_FOR_STATUS = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "M",
};
