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
  name:
    | "plan"
    | "queue"
    | "ask"
    | "dnc"
    | "simple"
    | "push"
    | "retry"
    | "cancel"
    | "stop"
    | "help";
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
    name: "queue",
    summary: "Run this after the agent finishes its current task",
    usage: "/queue @agent what should run next",
    takesObjective: true,
  },
  {
    name: "ask",
    // Questions first, then the work — both halves matter. `/ask` is not
    // `/dnc`: the agent asks what it would otherwise have guessed at, and
    // then builds what the answers describe in the same task.
    summary: "Ask 1–6 questions first, then do the work",
    usage: "/ask @agent what you want done",
    takesObjective: true,
  },
  {
    name: "dnc",
    // "Do not code." The guarantee is structural — the message is answered in
    // the channel and never becomes a task, so nothing can be written — and
    // the prompt says it to the agent in words as well, so the reply reads
    // like an answer rather than an offer to start work.
    summary: "Do not code — read and answer only, changing nothing",
    usage: "/dnc @agent your question",
    takesObjective: true,
  },
  {
    name: "simple",
    summary: "Answer as short and simple as it can be said",
    usage: "/simple @agent your message",
    takesObjective: true,
  },
  {
    name: "push",
    summary: "Publish canonical on a new GitHub branch",
    usage: "/push",
    takesObjective: false,
  },
  {
    name: "retry",
    summary: "Run the failed task in this thread again",
    usage: "/retry",
    takesObjective: false,
  },
  {
    name: "cancel",
    // Context decides the target: in a thread it stops that thread's task;
    // in the channel it stops everything here, or one agent's tasks when a
    // name follows. Running work included — the session is aborted, not
    // merely the queue row.
    summary: "Stop work — this thread's task, one agent's, or all of it",
    usage: "/cancel [@agent]",
    takesObjective: false,
  },
  {
    name: "stop",
    summary: "Stop an agent now and undo what its task changed",
    usage: "/stop @agent, or /stop on its own for everyone",
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
 * A word that could be a command: a slash starting a word, and letters after
 * it. The boundaries are what keep ordinary text out — `and/or` and
 * `src/plan.ts` have no whitespace before the slash, and `/usr/bin` has none
 * after `usr`. Sticky-free and global, because the scan below tries every
 * candidate in the message rather than only the first character of it.
 */
const SLASH_TOKEN_PATTERN = /(^|\s)\/([a-z][a-z0-9-]*)(?=\s|$)/giu;

/**
 * Reads the command in a message, wherever it is written, or nothing.
 *
 * It used to have to be the very first thing typed. That is a rule the
 * composer cannot teach anybody — somebody who has already written "@Eos "
 * and then thinks of `/plan` gets a slash that does nothing, with no way to
 * tell that position was the reason. So the whole message is scanned and the
 * first *known* command word in it wins.
 *
 * Being known is what carries the safety the anchor used to. A slash appears
 * in ordinary text constantly — paths, dates, "and/or" — and none of those
 * spell one of the command words in `SLASH_COMMANDS` with whitespace either
 * side.
 * `/usr/bin/env is on the path` is still a sentence, and so is "read
 * docs/plan.md": the price is that a message which genuinely means to *say*
 * `/help` as its own word is read as asking for it, which is the same trade
 * an "@" name already makes.
 *
 * `rest` is the message with only that one word taken out, so the mentions
 * and the objective around it reach the dispatcher exactly as written.
 */
export function parseSlashCommand(
  content: string,
): ParsedSlashCommand | undefined {
  for (const match of content.matchAll(SLASH_TOKEN_PATTERN)) {
    const name = (match[2] ?? "").toLowerCase();
    const command = SLASH_COMMANDS.find((entry) => entry.name === name);
    if (command === undefined) {
      continue;
    }
    const start = (match.index ?? 0) + (match[1] ?? "").length;
    const before = content.slice(0, start);
    const after = content.slice(start + 1 + name.length);
    // Lifting a word out of the middle of a line leaves the space on each
    // side of it. Only that seam is closed up — collapsing whitespace
    // anywhere else would reflow a message somebody laid out deliberately,
    // and the line breaks are left alone for the same reason.
    const rest = /\s$/u.test(before)
      ? before + after.replace(/^[ \t]+/u, "")
      : before + after;
    return { command, rest: rest.trim() };
  }
  return undefined;
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
