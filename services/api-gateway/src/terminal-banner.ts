/**
 * What a shell says before it says anything else.
 *
 * A terminal is the one surface in this system that arbitrates nothing. The
 * shell runs on somebody's own machine, under their own login, and Kumi sees
 * exactly none of what it edits — no lease is taken, no hold is checked, and
 * a file rewritten here turns up as a conflict at merge with nothing anywhere
 * explaining where it came from.
 *
 * That hole is not closable from this side; a shell is a shell. What is
 * closable is the surprise. Somebody about to work in a checkout should be
 * told, in the terminal, before the first prompt, that two agents are holding
 * lines in it and that nothing here will stop them colliding. Said once, at
 * the top, where it is read — not in a banner in a browser tab they are not
 * looking at.
 *
 * Deliberately free of the store, the request and the session: this is text,
 * and what makes it worth testing is what it says and what it refuses to
 * imply.
 */

import type { FileHolder } from "./editor-holds.js";

/** Terminals want CRLF; a bare newline leaves the cursor mid-line. */
const EOL = "\r\n";

/** Dim, so the shell's own first prompt is still the brightest thing there. */
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

/** How many holders are listed before the rest become a count. */
const MAX_LISTED = 6;

/** A holder as one line, or undefined for one there is nothing to say about. */
function line(holder: FileHolder, nameOf: (holder: FileHolder) => string): string {
  const where =
    holder.ranges.length === 0
      ? holder.file === ""
        ? ""
        : ` ${holder.file}`
      : ` ${holder.file} ${holder.ranges
          .map(
            (range) =>
              // Half-open on the wire, inclusive to a reader: a range ending
              // at 21 covers line 20, and "9-21" in a terminal would send
              // somebody to the wrong line.
              `${String(range.start)}-${String(Math.max(range.start, range.end - 1))}`,
          )
          .join(", ")}`;
  const verb =
    holder.kind === "agent"
      ? "holds"
      : holder.kind === "shell"
        ? "has a shell open on"
        : "is editing";
  return holder.kind === "shell"
    ? `  ${nameOf(holder)} ${verb} this branch`
    : `  ${nameOf(holder)} ${verb}${where === "" ? " this branch" : where}`;
}

/**
 * The lines written into a terminal when it opens.
 *
 * Returns an empty string when there is nothing to warn about *and* no branch
 * — an unattached shell on somebody's own machine has not earned a banner.
 * With a branch it always says something, because "nobody else is here" is a
 * fact worth having too, and its absence would read as "Kumi did not check".
 */
export function terminalBanner(input: {
  branch?: string;
  repositoryName?: string;
  holders: readonly FileHolder[];
  /** How a holder is named — the caller knows people's names, this does not. */
  nameOf: (holder: FileHolder) => string;
}): string {
  const { branch, holders } = input;
  if (branch === undefined && holders.length === 0) {
    return "";
  }
  const where =
    branch === undefined
      ? (input.repositoryName ?? "this repository")
      : `${input.repositoryName === undefined ? "" : `${input.repositoryName} · `}${branch}`;

  const out: string[] = [`${BOLD}Kumi${RESET}${DIM} · ${where}${RESET}`];
  if (holders.length === 0) {
    out.push(`${DIM}  Nobody else is holding anything on this branch.${RESET}`);
  } else {
    for (const holder of holders.slice(0, MAX_LISTED)) {
      out.push(`${DIM}${line(holder, input.nameOf)}${RESET}`);
    }
    if (holders.length > MAX_LISTED) {
      const rest = holders.length - MAX_LISTED;
      out.push(
        `${DIM}  and ${String(rest)} other${rest === 1 ? "" : "s"}${RESET}`,
      );
    }
  }
  // The part that is always true and is the reason this exists at all. A
  // reader who takes the list above as protection has been misled by it.
  out.push(
    `${DIM}  Nothing you do in here is arbitrated. Kumi cannot see what a` +
      ` shell edits.${RESET}`,
  );
  return `${out.join(EOL)}${EOL}${EOL}`;
}
