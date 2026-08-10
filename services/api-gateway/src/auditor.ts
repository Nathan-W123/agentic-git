/**
 * The auditor: the one agent role this system knows the meaning of.
 *
 * Everything here is pure — prompt text in, parsed findings out — so the
 * parts that decide *what the auditor says* and *what a human meant by
 * "yes"* can be tested without a server, a store, or a model. The wiring
 * that watches canonical, posts threads and dispatches fixes lives in
 * `server.ts`, which is the only thing that needs any of those.
 */

/** The single reserved role name. Compared trimmed and lower-cased. */
export const AUDITOR_ROLE = "auditor";

export function isAuditorRole(role: string | undefined): boolean {
  return role !== undefined && role.trim().toLowerCase() === AUDITOR_ROLE;
}

/**
 * How bad the auditor thinks something is. Its own claim, not a verdict —
 * a human approves every finding before anything is done about it.
 */
export type FindingSeverity = "high" | "medium" | "low";

const SEVERITIES: readonly FindingSeverity[] = ["high", "medium", "low"];

export interface AuditFinding {
  /** 1-based, and the number a person types to approve it. */
  index: number;
  severity: FindingSeverity;
  title: string;
  detail: string;
  files: string[];
  /**
   * Whether the auditor claims it could fix this itself without judgement
   * calls. Only ever consulted after a human approves the finding — it
   * decides *who* does the work, never *whether* work happens.
   */
  selfFixable: boolean;
}

/** What the model is told to say when it found nothing. */
export const NO_FINDINGS_MARKER = "NO FINDINGS";

/**
 * The audit request.
 *
 * Scoped to a diff rather than a tree, which is the difference between a
 * bounded cost per promotion and re-reading a whole repository every time
 * anybody merges anything. It also gives "nothing changed, nothing to say"
 * for free.
 *
 * The output format is specified rather than requested loosely because the
 * findings are parsed and turned into approvable items; free prose would
 * have to be re-read by another model call to be actionable, and that call
 * would be a second thing to pay for and a second thing to get wrong.
 */
export function buildAuditPrompt(input: {
  repositoryId: string;
  fromRevision: string;
  toRevision: string;
  files: string[];
  patch: string;
  truncated: boolean;
}): string {
  const shortFrom = input.fromRevision.slice(0, 12);
  const shortTo = input.toRevision.slice(0, 12);
  const fileList =
    input.files.length === 0
      ? "(none reported)"
      : input.files.map((file) => `- ${file}`).join("\n");
  return [
    `You are the auditor for the repository "${input.repositoryId}". Nobody `,
    `asked you to look at this: canonical advanced from ${shortFrom} to `,
    `${shortTo}, and you audit every advance.\n\n`,
    `Your job is to find real defects a reviewer would want to know about `,
    `before they reach anyone. Concentrate on:\n`,
    `- backend logic errors: wrong conditions, off-by-one, inverted checks, `,
    `unhandled error paths, race conditions, incorrect state transitions;\n`,
    `- places the frontend and the backend disagree: a route, request shape, `,
    `response field, status code or error code changed on one side and not `,
    `the other; a client reading a field the server no longer sends;\n`,
    `- data and security mistakes: missing authorization checks, unvalidated `,
    `input reaching a query, secrets or personal data in logs or URLs.\n\n`,
    `Do not report style, formatting, naming, test coverage, or "consider `,
    `refactoring". Do not report something you cannot point at a line for. `,
    `If the change is fine, say so — a clean audit is a useful audit, and `,
    `inventing a finding to look busy is the worst thing you can do here.\n\n`,
    `Changed files:\n${fileList}\n\n`,
    input.truncated
      ? `The diff below was truncated because the change is large. Audit what ` +
        `you can see and say plainly that you did not see all of it.\n\n`
      : "",
    `Diff:\n\`\`\`diff\n${input.patch}\n\`\`\`\n\n`,
    `Reply in exactly this format and nothing else.\n\n`,
    `If you found nothing, reply with the single line:\n`,
    `${NO_FINDINGS_MARKER}\n\n`,
    `Otherwise, for each finding, one block:\n`,
    `FINDING\n`,
    `severity: high|medium|low\n`,
    `files: comma-separated paths from the list above\n`,
    `selffix: yes|no\n`,
    `title: one line, under 12 words, what is wrong\n`,
    `detail: what is wrong, where, what happens as a result, and what the `,
    `fix is. Two or three sentences.\n`,
    `END\n\n`,
    `Set "selffix: yes" only when the fix is small, obvious, and needs no `,
    `judgement about product behaviour — a wrong operator, a missing null `,
    `check. Anything needing a decision is "no".`,
  ].join("");
}

/** One `key: value` line from a finding block, or undefined. */
function fieldOf(lines: string[], key: string): string | undefined {
  const prefix = `${key}:`;
  const line = lines.find(
    (entry) => entry.trim().toLowerCase().startsWith(prefix),
  );
  return line === undefined
    ? undefined
    : line.slice(line.indexOf(":") + 1).trim();
}

/**
 * Findings out of whatever the model actually replied with.
 *
 * Lenient on purpose. A model that drifts from the requested format must not
 * cause an audit to be silently dropped — that is precisely the "every layer
 * reported success and nothing happened" failure this agent exists to catch,
 * and it would be happening in the agent itself. So: blocks are parsed when
 * they are there, missing fields fall back to defensible defaults, and a
 * reply that parses to nothing at all but is not the no-findings marker is
 * kept whole as a single finding rather than discarded.
 */
export function parseAuditFindings(reply: string): AuditFinding[] {
  const text = reply.trim();
  if (text.length === 0) {
    return [];
  }
  // Tolerates the marker appearing alone, fenced, or with trailing
  // punctuation — every way a model has of saying one short line.
  if (
    text
      .replaceAll("`", "")
      .replaceAll("*", "")
      .trim()
      .toUpperCase()
      .replace(/[.!]+$/u, "") === NO_FINDINGS_MARKER
  ) {
    return [];
  }
  const blocks = text
    .split(/^\s*FINDING\s*$/imu)
    .slice(1)
    .map((block) => block.split(/^\s*END\s*$/imu)[0] ?? block);
  const findings: AuditFinding[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u);
    const title = fieldOf(lines, "title");
    const detail = fieldOf(lines, "detail");
    if (title === undefined && detail === undefined) {
      continue;
    }
    const severityText = (fieldOf(lines, "severity") ?? "").toLowerCase();
    const severity =
      SEVERITIES.find((entry) => severityText.startsWith(entry)) ?? "medium";
    const files = (fieldOf(lines, "files") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry !== "(none reported)");
    // "detail:" may run past its own line; everything after it up to the next
    // recognised key belongs to it, because that is how a model writes two or
    // three sentences.
    const detailIndex = lines.findIndex((entry) =>
      entry.trim().toLowerCase().startsWith("detail:"),
    );
    const detailBody =
      detailIndex === -1
        ? (detail ?? "")
        : [
            detail ?? "",
            ...lines
              .slice(detailIndex + 1)
              .filter(
                (entry) =>
                  !/^\s*(severity|files|selffix|title)\s*:/iu.test(entry),
              ),
          ]
            .join("\n")
            .trim();
    findings.push({
      index: findings.length + 1,
      severity,
      title: (title ?? detailBody.split(/\r?\n/u)[0] ?? "Finding").trim(),
      detail: detailBody.length > 0 ? detailBody : (title ?? "").trim(),
      files,
      selfFixable: /^y(es)?\b/iu.test(fieldOf(lines, "selffix") ?? "no"),
    });
  }
  if (findings.length === 0) {
    // Unparseable, but it said *something* and it was not "no findings".
    // Reported as one finding rather than thrown away.
    return [
      {
        index: 1,
        severity: "medium",
        title: "Audit report",
        detail: text,
        files: [],
        selfFixable: false,
      },
    ];
  }
  return findings;
}

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** One finding as it appears in the auditor's thread. */
export function formatFinding(finding: AuditFinding): string {
  const where =
    finding.files.length === 0 ? "" : `\n\`${finding.files.join("`, `")}\``;
  const offer = finding.selfFixable
    ? "\n\nSmall enough that I can fix it myself if you approve."
    : "";
  return (
    `**${String(finding.index)}. ${finding.title}** — ` +
    `${SEVERITY_LABEL[finding.severity]}${where}\n\n${finding.detail}${offer}`
  );
}

/**
 * A finding read back out of the thread reply that {@link formatFinding}
 * wrote.
 *
 * The thread is the record. There is no findings table: a finding is a thing
 * somebody reads and answers, which is exactly what a channel message is,
 * and giving it a second home in the database would mean two records of the
 * same conversation that could disagree. The cost is this function — the
 * inverse of one this module also owns, so the two move together.
 *
 * Returns undefined for any reply that is not a formatted finding, which is
 * most of them: acknowledgements, questions, and the humans talking.
 */
export function parseFindingReply(content: string): AuditFinding | undefined {
  const match = /^\*\*(\d{1,2})\.\s+(.+?)\*\*\s+—\s+(High|Medium|Low)\s*$/mu.exec(
    content,
  );
  if (match === null) {
    return undefined;
  }
  const [, indexText = "", title = "", severityText = ""] = match;
  const rest = content.slice(match.index + match[0].length).trim();
  const lines = rest.split(/\r?\n/u);
  const first = lines[0]?.trim() ?? "";
  // The file line, when present, is the backticked list `formatFinding` puts
  // immediately after the heading and nothing else looks like.
  const hasFiles = first.startsWith("`") && first.endsWith("`");
  const files = hasFiles
    ? first
        .split(",")
        .map((entry) => entry.trim().replaceAll("`", ""))
        .filter((entry) => entry.length > 0)
    : [];
  const selfFixable = rest.includes("I can fix it myself");
  const detail = (hasFiles ? lines.slice(1).join("\n") : rest)
    .replace(/\n*Small enough that I can fix it myself if you approve\.\s*$/u, "")
    .trim();
  return {
    index: Number(indexText),
    severity: severityText.toLowerCase() as FindingSeverity,
    title: title.trim(),
    detail,
    files,
    selfFixable,
  };
}

/** The audit's opening message, which is also what the thread hangs off. */
export function formatAuditSummary(input: {
  findings: AuditFinding[];
  fromRevision: string;
  toRevision: string;
  fileCount: number;
  truncated: boolean;
}): string {
  const count = input.findings.length;
  const files = `${String(input.fileCount)} file${input.fileCount === 1 ? "" : "s"}`;
  const highest = SEVERITIES.find((severity) =>
    input.findings.some((finding) => finding.severity === severity),
  );
  return (
    `Audited \`${input.fromRevision.slice(0, 8)}\`…\`${input.toRevision.slice(0, 8)}\` ` +
    `(${files}) and found ${String(count)} ` +
    `${count === 1 ? "thing" : "things"} worth looking at` +
    `${highest === undefined ? "" : `, highest ${SEVERITY_LABEL[highest].toLowerCase()}`}. ` +
    `${input.truncated ? "The change was too large to read in full. " : ""}` +
    `Reply to approve one — "yes, fix 1", or name an agent to hand it to.`
  );
}

/**
 * Whether a thread reply approves a finding.
 *
 * Needed because `looksLikeTaskRequest` — which decides answer-versus-work
 * everywhere else in a channel — was written for people *describing* work
 * and keys on concrete verbs ("fix", "add", "investigate"). It returns false
 * for "yes, do it", and the reply then falls through to the agent simply
 * answering: the auditor would discuss its own finding and never dispatch
 * the fix, which reads exactly like it worked.
 *
 * Deliberately scoped to auditor threads by its only caller. In an ordinary
 * channel "sure" and "go ahead" are conversation; here they are the entire
 * approval mechanism, because the work is already written down in the
 * message being replied to and the reply does not have to restate it.
 */
// `+1` and `👍` sit outside the `\b…\b` group on purpose: neither starts
// with a word character, so a word boundary can never match in front of
// them and both would silently never fire from inside it.
const APPROVAL_RE =
  /\b(y|yes|yep|yeah|yup|ok|okay|sure|approved?|accept(ed)?|agreed?|confirm(ed)?|proceed|go ahead|go for it|do it|take it|make it so|ship it|please do|sounds good|lgtm)\b|\+1|👍/iu;

const REJECTION_RE =
  /\b(no|nope|nah|don'?t|do not|skip|ignore|reject(ed)?|dismiss(ed)?|leave it|not now|later|won'?t fix|wontfix|false positive)\b/iu;

export function readsAsApproval(reply: string): boolean {
  const text = reply.trim();
  if (text.length === 0) {
    return false;
  }
  // Checked first and allowed to win: "no, don't fix that" contains no
  // approval word, but "yes, but not now" and "ok, skip it" contain both,
  // and the safe reading of an ambiguous reply is to do nothing. Doing
  // nothing is recoverable by saying so again; spending someone's account
  // on work they just declined is not.
  if (REJECTION_RE.test(text)) {
    return false;
  }
  return APPROVAL_RE.test(text);
}

/**
 * Which findings a reply approves.
 *
 * "all"/"both" take everything; explicit numbers take those; a bare approval
 * with exactly one finding on the table takes that one, because there is
 * nothing else it could mean. A bare approval against several findings is
 * ambiguous and takes nothing — the caller asks which.
 */
export function findingsReferencedBy(
  reply: string,
  findings: AuditFinding[],
): AuditFinding[] {
  if (findings.length === 0) {
    return [];
  }
  if (/\b(all|every|everything|both)\b/iu.test(reply)) {
    return [...findings];
  }
  // `#2`, `finding 2`, `fix 2`, `number 2`, or a bare `2`. Anchored on a word
  // boundary so a version number or a path fragment does not read as one.
  const numbers = new Set(
    [...reply.matchAll(/(?:^|[^\w.])#?(\d{1,2})(?![\w.])/gu)]
      .map((match) => Number(match[1]))
      .filter((value) => value >= 1 && value <= findings.length),
  );
  if (numbers.size > 0) {
    return findings.filter((finding) => numbers.has(finding.index));
  }
  return findings.length === 1 ? [...findings] : [];
}

/**
 * The objective an approved finding becomes.
 *
 * Written as an instruction to fix a specific thing rather than as a copy of
 * the finding, because it arrives at the receiving agent through the same
 * path an @mention does and will be read as a request for work. The file
 * list travels with it: the agent that fixes this is not the agent that
 * found it and has none of its context.
 */
export function fixObjectiveFor(finding: AuditFinding): string {
  const where =
    finding.files.length === 0
      ? ""
      : ` The relevant files are ${finding.files.join(", ")}.`;
  return (
    `Fix this audit finding: ${finding.title}.\n\n${finding.detail}${where}\n\n` +
    `This was found by an automated audit of a recent change and approved by ` +
    `a maintainer. Fix the defect itself; do not reformat, rename, or ` +
    `restructure anything else while you are in there.`
  );
}
