/**
 * Slash commands in a channel message.
 *
 * Everything here is pure — text in, a parsed command out — so what a
 * message *means* can be tested without a server, a store or a model. The
 * wiring that acts on one lives in `server.ts`.
 *
 * A command says how to treat the request; an "@" says who it is for. They
 * are answering different questions, so they compose rather than compete:
 * `/plan @Eos rework the retry loop` is one command, one mention and one
 * objective, and each is read by the part that cares about it.
 */

/** What a command does, and what to draw in the picker. */
export interface SlashCommand {
  name: string;
  /** One line, shown beside the name in the lookup. */
  summary: string;
  /** How it is typed, shown under the summary. */
  usage: string;
  /**
   * Whether the rest of the message is the objective for an agent, as
   * against arguments for the channel itself. Drives whether the picker
   * offers an "@" next.
   */
  takesObjective: boolean;
}

/**
 * The commands this channel knows.
 *
 * Deliberately short. Every entry has to earn a name people must remember,
 * and anything that reads naturally as a sentence to an agent — "have a look
 * at the retry loop" — should stay a sentence rather than become syntax.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "plan",
    summary: "Plan it first, and wait for your go-ahead before touching code",
    usage: "/plan @agent what you want done",
    takesObjective: true,
  },
  {
    name: "ask",
    summary: "Ask without starting work — an answer, not a task",
    usage: "/ask @agent your question",
    takesObjective: true,
  },
  {
    name: "retry",
    summary: "Run the failed task in this thread again",
    usage: "/retry",
    takesObjective: false,
  },
  {
    name: "cancel",
    summary: "Stop the task this thread is following",
    usage: "/cancel",
    takesObjective: false,
  },
  {
    name: "help",
    summary: "List what you can type here",
    usage: "/help",
    takesObjective: false,
  },
];

export interface ParsedSlashCommand {
  command: SlashCommand;
  /** The message with the command word removed, mentions and all. */
  rest: string;
}

/**
 * Reads a leading command, or nothing.
 *
 * Only at the very start of a message, for the same reason `ADDRESSED_RE`
 * anchors an "@": a slash appears in the middle of ordinary text all the
 * time — paths, dates, "and/or" — and treating any of those as a command
 * would turn a sentence into a syntax error nobody typed.
 *
 * An unknown word after the slash is not a command either. `/usr/bin/env is
 * on the path` is a sentence, and guessing at it would be worse than reading
 * it literally, which is what the channel already does well.
 */
export function parseSlashCommand(
  content: string,
): ParsedSlashCommand | undefined {
  const match = /^\s*\/([a-z][a-z0-9-]*)(?=\s|$)/iu.exec(content);
  if (match === null) {
    return undefined;
  }
  const name = (match[1] ?? "").toLowerCase();
  const command = SLASH_COMMANDS.find((entry) => entry.name === name);
  if (command === undefined) {
    return undefined;
  }
  return { command, rest: content.slice(match[0].length).trim() };
}

/**
 * The commands matching what has been typed so far, for the lookup.
 *
 * Prefix rather than substring: a picker that offers `/cancel` while
 * somebody types `/can` is helping, and one that offers it for `/el` is
 * guessing. Returns everything for a bare slash, which is how somebody finds
 * out what exists.
 */
export function slashCommandsMatching(prefix: string): SlashCommand[] {
  const typed = prefix.replace(/^\s*\//u, "").trim().toLowerCase();
  return SLASH_COMMANDS.filter((entry) => entry.name.startsWith(typed));
}

/** The answer to `/help`, as one channel message. */
export function formatSlashHelp(): string {
  return [
    "You can type:",
    ...SLASH_COMMANDS.map(
      (entry) => `\`${entry.usage}\` — ${entry.summary}`,
    ),
    "",
    "A command and an @mention go in the same message: the command says how " +
      "to treat the request, the mention says who it is for.",
  ].join("\n");
}
