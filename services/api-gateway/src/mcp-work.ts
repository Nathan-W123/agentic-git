/**
 * The tools an editor uses to do the work itself.
 *
 * The five tools in `mcp-tools.ts` are about *filing* work: somebody in an
 * editor wants Kumi to do something, and a machine somewhere picks it up.
 * These three are the other half. The person is already in Claude Code or
 * Cursor with the repository checked out, and the agent in front of them is
 * perfectly capable of doing the task itself. What it lacks is everything
 * Kumi holds: which task is next, what revision to start from, permission to
 * touch those files while other agents are touching others, and somewhere for
 * the result to land.
 *
 * So: `take_task` hands over one task and a hold on it, `report_task` files
 * what came back, and `extend_task` keeps the hold alive across a long turn.
 * No CLI is installed, no worker process runs, and nothing executes on the
 * control plane — the agent doing the work is the one the person is already
 * paying for.
 *
 * ### The one rule that is not obvious
 *
 * The hold is taken up front and the *plan is admitted at the end*. A worker
 * declares its scope before it moves and is arbitrated against that; an
 * editor has already moved by the time Kumi hears from it, so the claim it
 * makes is the set of files its diff actually touched. That is narrower than
 * anything it could have promised in advance, and it is decidable at the
 * moment it is made rather than guessed thirty minutes earlier.
 */

import type { FilePatch, FilePatchStatus } from "@coord/shared-types";

import {
  McpArgumentError,
  mcpRefusal,
  mcpText,
  optionalChoice,
  optionalString,
  requiredString,
  type McpTool,
} from "./mcp.js";

/** The vendors an editor may say it is. */
export const EDITOR_VENDORS = [
  "claude",
  "codex",
  "cursor",
  "copilot",
  "gemini",
  "kiro",
] as const;

export type EditorVendor = (typeof EDITOR_VENDORS)[number];

/** How each vendor's editor is named in the fleet, and to the person. */
export const EDITOR_LABELS: Record<EditorVendor, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  gemini: "Gemini",
  kiro: "Kiro",
};

/**
 * Which editor is on the other end of this request.
 *
 * Recorded on the token at mint, so it needs no cooperation from the model
 * and cannot be got wrong by one. The name is the fallback, because every
 * editor connected before that column existed has only a name — the app
 * writes "Codex on <device>", so the label is there to be read. A name is
 * editable, which is exactly why it is the fallback rather than the source.
 *
 * Answering `undefined` is a real answer and the tools treat it as one: it
 * means "an ordinary token, not an editor", and the right response to that is
 * to ask who the work is for rather than to guess.
 */
export function editorBehind(token?: {
  readonly name?: string | undefined;
  readonly editorVendor?: string | undefined;
}): EditorVendor | undefined {
  const recorded = EDITOR_VENDORS.find(
    (vendor) => vendor === token?.editorVendor,
  );
  if (recorded !== undefined) {
    return recorded;
  }
  const name = (token?.name ?? "").toLowerCase();
  if (name === "") {
    return undefined;
  }
  // Matched on the label the app writes rather than the vendor id, and
  // anchored to the start, because that is the shape it mints: "Claude Code
  // on <device>". Substring matching anywhere in the string would read a
  // laptop called "Claude" as an editor.
  const matched = EDITOR_VENDORS.filter((vendor) =>
    name.startsWith(EDITOR_LABELS[vendor].toLowerCase()),
  );
  // "Claude Code" and "Codex" cannot both prefix one name, but a future label
  // that prefixed another would make this ambiguous, and guessing between two
  // agents is the fault this whole function exists to remove.
  return matched.length === 1 ? matched[0] : undefined;
}

/** What `take_task` found, in the terms the tool has to describe it in. */
export interface McpTakenTask {
  readonly taskId: string;
  readonly objective: string;
  readonly repository: string;
  readonly branch: string;
  readonly baseRevision: string;
  readonly expiresAt: string;
  readonly bundleUrl: string;
  readonly validationCommands: readonly string[];
}

/** Everything the work tools may do. Small, and deliberately not the gateway. */
export interface McpWorkDeps {
  /** Refuses unless the caller's token carries this permission. */
  assertScope(permission: string): void;
  /** Which editor is calling, from its own token. See {@link editorBehind}. */
  callerEditor(): EditorVendor | undefined;
  /** Takes one queued task for this editor, or answers that there is none. */
  take(input: {
    vendor: EditorVendor;
    label: string;
    repository?: string;
    /** One named task, when the caller has just filed it. */
    taskId?: string;
  }): Promise<McpTakenTask | undefined>;
  /** Files a result against the hold this caller has on a task. */
  report(input: {
    taskId: string;
    status: "completed" | "failed" | "released";
    patches: readonly FilePatch[];
    summary: string;
    detail?: string;
  }): Promise<
    | { outcome: "accepted"; note: string }
    | { outcome: "refused"; reason: string }
    | { outcome: "not_held"; reason: string }
  >;
  /** Pushes this caller's hold on a task out, and re-issues its bundle link. */
  extend(input: {
    taskId: string;
    minutes: number;
  }): Promise<{ expiresAt: string; bundleUrl: string } | undefined>;
}

/**
 * Splits one `git diff` into the per-file patches a changeset is made of.
 *
 * Written here rather than asking the model for structured patches, because
 * the model would have to reproduce by hand something `git diff` already
 * prints exactly right, and every character it retyped would be a chance to
 * get a hunk header wrong. Asking for the raw diff means the thing that lands
 * in canonical is the thing git produced.
 *
 * Only what a unified diff actually tells us is read: the path, and whether
 * the file was created or removed. Everything else in the header (modes,
 * blob hashes, similarity indexes) travels through untouched inside the patch
 * text, because integration applies the patch rather than interpreting it.
 */
export function splitUnifiedDiff(diff: string): FilePatch[] {
  const lines = diff.split("\n");
  const patches: FilePatch[] = [];
  let current: string[] | undefined;
  const flush = (): void => {
    if (current === undefined) {
      return;
    }
    const body = current;
    current = undefined;
    const path = pathOf(body);
    if (path === undefined) {
      return;
    }
    patches.push({
      path,
      status: body.some((line) => line.startsWith("new file mode"))
        ? "added"
        : body.some((line) => line.startsWith("deleted file mode"))
          ? "deleted"
          : "modified",
      // A trailing newline, because that is what git emits and what `git
      // apply` expects; a patch that ends mid-line is refused by it.
      patch: `${body.join("\n").replace(/\n+$/u, "")}\n`,
    });
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [line];
      continue;
    }
    if (current === undefined) {
      // Anything before the first header is not part of a patch: `git log`
      // output pasted along with the diff, a shell prompt, a stray blank.
      continue;
    }
    current.push(line);
  }
  flush();
  return patches;
}

/**
 * Which file one section of a diff is about.
 *
 * Not read off the `diff --git a/X b/Y` line, and that is the whole point of
 * this function. Paths are not quoted for spaces, so that line is genuinely
 * ambiguous: `a/src/a b/c.ts b/src/new.ts` can be split at either ` b/` and
 * nothing in the line says which. Git's own tools do not try, and neither
 * does this.
 *
 * The unambiguous statements come later in the section, each on its own line
 * with exactly one path on it, so they are what is read: `rename to` when
 * there is one, then the `+++` side, then the `---` side for a file the diff
 * deletes. The header is a last resort for the sections that carry none of
 * those, which is a mode change and nothing else.
 */
function pathOf(body: readonly string[]): string | undefined {
  for (const line of body) {
    const renamed = /^rename to (.+)$/u.exec(line);
    if (renamed?.[1] !== undefined) {
      return renamed[1];
    }
  }
  for (const line of body) {
    const added = /^\+\+\+ b\/(.+)$/u.exec(line);
    if (added?.[1] !== undefined) {
      return added[1];
    }
  }
  for (const line of body) {
    const removed = /^--- a\/(.+)$/u.exec(line);
    if (removed?.[1] !== undefined) {
      return removed[1];
    }
  }
  // Nothing but a header. Ambiguous by construction, so the longest `a/` side
  // is taken: that is right whenever the *new* name has no ` b/` in it, which
  // covers every path anybody actually has.
  const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(body[0] ?? "");
  return header?.[2];
}

/**
 * What an editor is told when a task becomes its own to do.
 *
 * Written once and used twice: by `take_task`, and by `submit_task` when the
 * work was filed by the very editor that will do it. Two copies of these
 * instructions would drift, and the half that drifted would be the one
 * telling somebody how to reach a revision they cannot otherwise get.
 */
export function takenTaskBrief(taken: McpTakenTask): string {
  const lines = [
    `Task ${taken.taskId} is yours until ${taken.expiresAt}.`,
    "",
    taken.objective,
    "",
    `Repository: ${taken.repository} (branch ${taken.branch})`,
    `Start from revision ${taken.baseRevision}.`,
    "",
    "Before you change anything, make sure your checkout has that " +
      `revision: run \`git cat-file -e ${taken.baseRevision}^{commit}\`. ` +
      "If that fails, Kumi is holding work your remote has never seen, " +
      "and this is the only place to get it:",
    // A bundle is a file, not a Git server, so it is downloaded and then
    // fetched from on disk. `git fetch <https url>` would try to speak
    // the smart-HTTP protocol to it and fail with something unhelpful.
    `  curl -fsSL "${taken.bundleUrl}" -o /tmp/kumi-${taken.taskId}.bundle`,
    `  git fetch /tmp/kumi-${taken.taskId}.bundle`,
    "",
    "That link works once and expires; extend_task issues another.",
    "",
    "Then do the work, and report it with:",
    `  report_task task_id="${taken.taskId}" diff="$(git diff ${taken.baseRevision})"`,
  ];
  if (taken.validationCommands.length > 0) {
    lines.push(
      "",
      "This repository expects these to pass before anything lands:",
      ...taken.validationCommands.map((command) => `  ${command}`),
    );
  }
  lines.push(
    "",
    "If you cannot do this one, call report_task with status=\"released\" " +
      "so somebody else can.",
  );
  return lines.join("\n");
}

function positiveMinutes(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new McpArgumentError('"minutes" must be a positive number');
  }
  return Math.trunc(value);
}

/** The three work tools, bound to one caller. */
export function createMcpWorkTools(deps: McpWorkDeps): McpTool[] {
  const takeTask: McpTool = {
    name: "take_task",
    title: "Take a Kumi task and do it here",
    description:
      "Picks up the next Kumi task waiting for you and hands it to this " +
      "editor to do, rather than to a machine running the Kumi desktop app. " +
      "You get the objective, the exact revision to start from and a hold on " +
      "the task so nothing else picks it up. Do the work in the repository " +
      "you already have open, then call report_task with the diff. If the " +
      "hold is about to run out and you are still working, call extend_task.",
    inputSchema: {
      type: "object",
      properties: {
        editor: {
          type: "string",
          enum: [...EDITOR_VENDORS],
          description:
            "Which agent you are. Usually unnecessary: Kumi knows which " +
            "editor is calling from the connection itself. Only pass this if " +
            "Kumi says it could not tell.",
        },
        repository: {
          type: "string",
          description:
            "Optional. Restricts the search to one repository, by the name " +
            "list_repositories reports.",
        },
      },
      additionalProperties: false,
    },
    async run(args) {
      // `submit_task`, never `run_task`. That scope also admits
      // `POST /workers/leases`, so a token given to an editor for doing its
      // own work could register as a worker and take everybody else's.
      deps.assertScope("submit_task");
      // The connection first, the argument second. Kumi knows which editor
      // holds this token, so asking the model to tell us was asking it to
      // report something we already had and could get wrong.
      const vendor = optionalChoice(args, "editor", EDITOR_VENDORS) ??
        deps.callerEditor();
      if (vendor === undefined) {
        return mcpRefusal(
          "Kumi cannot tell which agent this connection is for. That happens " +
            "when the token was made by hand rather than by connecting an " +
            "editor from Kumi's settings. Call take_task again with " +
            `editor set to one of: ${EDITOR_VENDORS.join(", ")}.`,
        );
      }
      const repository = optionalString(args, "repository", 200);
      const taken = await deps.take({
        vendor,
        label: `${EDITOR_LABELS[vendor]} (editor)`,
        ...(repository === undefined ? {} : { repository }),
      });
      if (taken === undefined) {
        return mcpText(
          "Nothing is waiting for you right now. Anything filed for this " +
            "agent will be here next time you ask.",
        );
      }
      return mcpText(takenTaskBrief(taken));
    },
  };

  const reportTask: McpTool = {
    name: "report_task",
    title: "File the work you did on a Kumi task",
    description:
      "Hands back what you did on a task you took with take_task. Send the " +
      "output of `git diff <base revision>` as the diff; Kumi checks it " +
      "against everything else running in that repository, then integrates " +
      "it and posts the outcome in the task's thread. Use status=\"failed\" " +
      "if you tried and could not, and status=\"released\" if you have not " +
      "started and want to give the task back.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The id take_task gave you.",
        },
        diff: {
          type: "string",
          description:
            "The unified diff of your work, exactly as `git diff <base>` " +
            "printed it. Leave it out only if nothing changed.",
        },
        summary: {
          type: "string",
          description:
            "What you did, in a sentence or two. This is what the thread " +
            "shows the person who asked.",
        },
        status: {
          type: "string",
          enum: ["done", "failed", "released"],
          description: "Defaults to done.",
        },
        detail: {
          type: "string",
          description: "Why, when this failed.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async run(args) {
      deps.assertScope("submit_task");
      const taskId = requiredString(args, "task_id", 200);
      const status = optionalChoice(args, "status", [
        "done",
        "failed",
        "released",
      ] as const);
      const diff = optionalString(args, "diff", 2_000_000);
      const summary = optionalString(args, "summary", 4_000);
      const detail = optionalString(args, "detail", 4_000);
      const patches = diff === undefined ? [] : splitUnifiedDiff(diff);
      if (
        (status ?? "done") === "done" &&
        diff !== undefined &&
        diff.trim().length > 0 &&
        patches.length === 0
      ) {
        // The diff was sent and nothing came out of it. Reporting success
        // here would land an empty changeset and tell the room the work was
        // done, which is the one answer that must never be given by accident.
        return mcpRefusal(
          "That does not look like a diff: no `diff --git` headers in it. " +
            "Send the output of `git diff <base revision>` unchanged, or " +
            "leave diff out if nothing actually changed.",
        );
      }
      if ((status ?? "done") === "done" && summary === undefined) {
        throw new McpArgumentError(
          '"summary" is needed: it is what the thread shows the person who asked',
        );
      }
      const reported = await deps.report({
        taskId,
        status:
          status === "failed"
            ? "failed"
            : status === "released"
              ? "released"
              : "completed",
        patches,
        summary: summary ?? "",
        ...(detail === undefined ? {} : { detail }),
      });
      if (reported.outcome === "accepted") {
        return mcpText(reported.note);
      }
      return mcpRefusal(reported.reason);
    },
  };

  const extendTask: McpTool = {
    name: "extend_task",
    title: "Keep your hold on a Kumi task",
    description:
      "Pushes out the hold you have on a task you took with take_task, so a " +
      "long piece of work does not lose it. Call this when you are still " +
      "working and the hold is close to running out.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The id take_task gave you." },
        minutes: {
          type: "number",
          description: "How much longer you need. Defaults to 30, capped at 60.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async run(args) {
      deps.assertScope("submit_task");
      const taskId = requiredString(args, "task_id", 200);
      const minutes = positiveMinutes(args["minutes"], 30);
      const extended = await deps.extend({ taskId, minutes });
      if (extended === undefined) {
        return mcpRefusal(
          `You are not holding ${taskId} any more. It either finished, was ` +
            "stopped, or the hold ran out and it went back in the queue. " +
            "Call take_task to pick work up again.",
        );
      }
      // With a fresh download link, because the old one is spent the moment
      // it is used and lives for ten minutes against a hold that runs for
      // thirty. An editor that needed the bundle late would otherwise have to
      // give the task back to get one.
      return mcpText(
        [
          `Yours until ${extended.expiresAt}.`,
          "",
          "If you still need the base revision, this link replaces the one " +
            "take_task gave you:",
          `  curl -fsSL "${extended.bundleUrl}" -o /tmp/kumi-${taskId}.bundle`,
          `  git fetch /tmp/kumi-${taskId}.bundle`,
        ].join("\n"),
      );
    },
  };

  return [takeTask, reportTask, extendTask];
}
