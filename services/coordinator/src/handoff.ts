import {
  type AgentContextPressure,
  type ChangeSet,
  type CoordinatorDecision,
  type DeferredResource,
  type HandoffDecision,
  type HandoffEvidence,
  type HandoffOpenItem,
  type HandoffReason,
  type IntegrationResult,
  type PlanAdmission,
  type TaskHandoff,
} from "@coord/shared-types";

/**
 * Writing down what a task learned, for whoever picks it up next.
 *
 * The temptation is to summarise. A summary of a session is unverifiable and
 * ages badly: it records what someone thought was important, at an altitude
 * they chose, with no way for a reader to check any of it. Worse, seeding a
 * fresh session with one launders guesses into established fact.
 *
 * So nothing here is written from memory. Every line is projected from
 * evidence the control plane already holds — the integration result, the
 * validation commands and their exit codes, the resources ownership withheld
 * and who held them, the constraints the coordinator attached and why. The
 * handoff is a *view* over the run record, which means a reader can check it
 * and a stale one is obviously stale rather than quietly wrong.
 *
 * What an agent cannot derive, it does not claim. There is deliberately no
 * free-text "what I was thinking" field.
 */

export interface HandoffInput {
  taskId: string;
  objective: string;
  repositoryId: string;
  projectId?: string;
  runId?: string;
  canonicalRevision: string;
  /** The decision the task executed under, when it got that far. */
  decision?: CoordinatorDecision;
  /** The admission, which is where withheld resources are recorded. */
  admission?: PlanAdmission;
  /** What actually reached canonical. */
  integration?: IntegrationResult;
  /** The changeset that was promoted, if any. */
  changeSet?: ChangeSet;
  /** Tasks queued to carry on this task's unfinished scope. */
  followUpTaskIds?: string[];
  /** Files whose patches were held back rather than applied. */
  withheldFiles?: string[];
  /** Set when the task did not settle cleanly. */
  failure?: string;
  /**
   * The figures a session stopped itself on, as the control plane recorded
   * them on `task_handed_off` before projecting anything from them.
   *
   * Numbers and the lease that carries them, never the adapter's own words:
   * the rule at the top of this file is that a reader can check every line
   * against the run record, and the adapter's verdict text is prose nothing
   * in the store can be checked against. `attempt` and `budget` come from the
   * driver, which counts the handoffs already on the log.
   */
  contextPressure?: AgentContextPressure & {
    attempt: number;
    budget: number;
    /** The lease the figures were reported on. Absent in-process, where there is none. */
    leaseId?: string;
  };
  reason: HandoffReason;
  now?: () => Date;
}

/**
 * How long one rendered line may be before it is cut, in code points.
 *
 * A handoff field is prose from the run record — an objective somebody typed,
 * a validation command's last output — and nothing upstream bounds it. A
 * single enormous field would otherwise crowd every other handoff out of the
 * window it is being read in, which loses the rest of the memory to say one
 * thing at length. Cut with the cut announced: a reader who can see that a
 * line was truncated knows to go and read the record, whereas a silent cut is
 * a sentence that means something other than what was written.
 */
const RENDERED_LINE_LIMIT = 2_000;

/**
 * One stored field, as one line of the seed.
 *
 * The seed is a structured document — headings, then bullets — and it is read
 * by an agent that will act on it. A stored field carrying newlines therefore
 * does not merely look untidy: `\n### task_b — completed` inside an objective
 * renders as a section of the document, attributed to a task that never
 * wrote it, and nothing downstream can tell the forgery from the record. Every
 * value goes through here, so a field can only ever be the line it was put on.
 */
function oneLine(value: string): string {
  const flattened = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const points = [...flattened];
  if (points.length <= RENDERED_LINE_LIMIT) {
    return flattened;
  }
  // Sliced by code point rather than by unit: a cut through a surrogate pair
  // would put a lone half of a character into a prompt.
  return (
    `${points.slice(0, RENDERED_LINE_LIMIT).join("")}… ` +
    `[cut here; the recorded value is ${points.length} characters]`
  );
}

/**
 * A field that was never recorded, said out loud.
 *
 * The rule this file is written to is that a reader can check every line.
 * Rendering an empty field as an empty string breaks it in the quietest
 * possible way: `Objective: ` reads as a handoff whose objective was nothing,
 * and a successor cannot tell that apart from a field nobody filled in.
 */
function stated(value: string | undefined, missing: string): string {
  const text = value === undefined ? "" : oneLine(value);
  return text.length === 0 ? missing : text;
}

/**
 * A revision, short enough to read and never blank.
 *
 * Twelve characters is what a person compares; `unknown` is what an unset
 * revision has to say, because a bare `Canonical at handoff:` with nothing
 * after it invites a reader to assume the repository was empty.
 */
function shortRevision(revision: string): string {
  const trimmed = revision.trim();
  return trimmed.length === 0 ? "unknown" : trimmed.slice(0, 12);
}

/** How full the window got, in the words the figures allow. */
function occupancyPhrase(pressure: AgentContextPressure): string {
  const occupied = pressure.occupiedTokens ?? pressure.peakTokens;
  return pressure.maximumContextTokens === undefined
    ? `${occupied} tokens`
    : `${occupied} of ${pressure.maximumContextTokens} tokens`;
}

function validationEvidence(
  integration: IntegrationResult | undefined,
): HandoffEvidence[] {
  return (integration?.validation ?? []).map((entry) => ({
    kind: "validation" as const,
    reference: entry.command.label,
    detail:
      entry.exitCode === 0
        ? `passed (${entry.command.executable} ${entry.command.args.join(" ")})`
        : `FAILED with exit ${entry.exitCode}`,
  }));
}

function completedEvidence(input: HandoffInput): HandoffEvidence[] {
  const evidence: HandoffEvidence[] = [];
  const integration = input.integration;

  if (integration?.status === "integrated") {
    evidence.push({
      kind: "canonical_promotion",
      reference: integration.canonicalVersion.revision,
      detail:
        `promoted from ${shortRevision(integration.previousVersion.revision)} ` +
        `to ${shortRevision(integration.canonicalVersion.revision)}`,
    });
  } else if (integration !== undefined) {
    evidence.push({
      kind: "integration",
      reference: integration.status,
      detail: integration.explanation,
    });
  }

  if (input.changeSet !== undefined && input.changeSet.patches.length > 0) {
    evidence.push({
      kind: "changeset",
      reference: input.changeSet.id,
      detail: `changed ${input.changeSet.patches
        .map((patch) => patch.path)
        .sort()
        .join(", ")}`,
    });
  }

  evidence.push(...validationEvidence(integration));

  for (const grant of input.decision?.ownershipGrants ?? []) {
    evidence.push({
      kind: "ownership",
      reference: `${grant.resourceType}:${grant.resourceId}`,
      detail: `held in ${grant.mode} mode for this task`,
    });
  }

  for (const followUp of input.followUpTaskIds ?? []) {
    evidence.push({
      kind: "follow_up_task",
      reference: followUp,
      detail: "queued to carry the remaining scope",
    });
  }
  return evidence;
}

function openItems(input: HandoffInput): HandoffOpenItem[] {
  const items: HandoffOpenItem[] = [];

  // A withheld resource is the clearest possible "not done, and here is who
  // is in the way" — it is recorded per-resource with its holder already.
  for (const resource of input.admission?.deferredResources ?? []) {
    items.push({
      item: `${resource.resourceType}:${resource.resourceId} was not modified`,
      blockedBy: [...resource.heldBy],
      reason: resource.reason,
    });
  }

  for (const file of input.withheldFiles ?? []) {
    items.push({
      item: `edits to ${file} were produced but never applied`,
      blockedBy: [],
      reason:
        "the patch reached a resource this task was not granted, so it was " +
        "split off rather than promoted",
    });
  }

  for (const blocker of input.decision?.blockedBy ?? []) {
    items.push({
      item: "execution was ordered behind another task",
      blockedBy: [blocker],
      reason: input.decision?.explanation ?? "sequenced by the coordinator",
    });
  }

  // Projected from the numbers on the record rather than from what the
  // adapter said: the audit event names the lease, so every figure in this
  // sentence can be looked up.
  const pressure = input.contextPressure;
  if (pressure !== undefined) {
    items.push({
      item: "the run stopped itself before finishing",
      blockedBy: [],
      reason:
        `context occupancy reached ${occupancyPhrase(pressure)} after ` +
        `${pressure.turns} turns` +
        (pressure.compactions > 0
          ? `, with ${pressure.compactions} compaction(s) discarding ` +
            `${pressure.droppedTokens} tokens`
          : "") +
        (pressure.stale
          ? ", and a tool result had landed since that figure was reported"
          : "") +
        "; recorded as task_handed_off" +
        (pressure.leaseId === undefined ? "" : ` on lease ${pressure.leaseId}`) +
        "; workspace edits from that attempt were discarded",
    });
  }

  if (input.failure !== undefined) {
    items.push({
      item: "the task did not settle cleanly",
      blockedBy: [],
      // A failure recorded with no text still happened. Saying so beats a
      // line that trails off, which reads as a failure nobody could name.
      reason: stated(input.failure, "no failure text was recorded"),
    });
  }
  return items;
}

function decisions(input: HandoffInput): HandoffDecision[] {
  const made: HandoffDecision[] = [];
  const admission = input.admission;

  if (admission !== undefined) {
    made.push({
      decision: `plan admitted as "${admission.status}"`,
      rationale: admission.explanation,
      reference: `planRevision ${admission.planRevision} at ${admission.baseRevision.slice(0, 12)}`,
    });
    for (const assessment of admission.conflicts) {
      made.push({
        decision: `conflict with ${assessment.taskIds
          .filter((id) => id !== input.taskId)
          .join(", ")} scored ${assessment.score} (${assessment.disposition})`,
        rationale: assessment.explanation,
      });
    }
  }

  // Constraints are the coordinator telling the agent what it may not do. That
  // is exactly the kind of thing a successor needs and would never infer.
  for (const constraint of input.decision?.constraints ?? []) {
    made.push({
      decision: "constraint applied to execution",
      rationale: constraint,
    });
  }
  return made;
}

/**
 * Traps found the hard way.
 *
 * Only things that actually went wrong in this run qualify. General advice is
 * not a gotcha, and a handoff full of it is noise that trains its readers to
 * skim.
 */
function gotchas(input: HandoffInput): string[] {
  const found: string[] = [];
  const integration = input.integration;

  for (const entry of integration?.validation ?? []) {
    if (entry.exitCode !== 0) {
      const output =
        entry.stderr.trim().slice(-300) || entry.stdout.trim().slice(-300);
      found.push(
        `"${entry.command.label}" fails here (exit ${entry.exitCode}); ` +
          (output.length === 0
            ? // A gate that failed silently is a different problem from one
              // whose output was never kept, and "its output ends:" followed
              // by nothing claims the first while meaning the second.
              "no output was captured from it"
            : `its output ends: ${output}`),
      );
    }
  }
  if (integration?.status === "stale") {
    found.push(
      "canonical moved while this task was executing, so its base was " +
        "overtaken — start from the promoted revision, not the one you were " +
        "handed",
    );
  }
  if (integration?.status === "conflict") {
    found.push(
      "the changeset would not apply to current canonical; the files it " +
        "touched have moved underneath it",
    );
  }
  if (integration?.replayedFrom !== undefined) {
    found.push(
      `this result was written against ${shortRevision(integration.replayedFrom)} ` +
        "and replayed onto a newer revision; the advance was checked as " +
        "unrelated, but a reader comparing revisions will see the gap",
    );
  }
  const pressure = input.contextPressure;
  if (pressure !== undefined) {
    found.push(
      `this objective filled ${
        pressure.maximumContextTokens === undefined
          ? "the context window"
          : `a ${pressure.maximumContextTokens}-token window`
      } once already (attempt ${pressure.attempt} of ${pressure.budget}); ` +
        "read narrowly and edit in place rather than re-reading whole files",
    );
  }
  for (const warning of integration?.cleanupWarnings ?? []) {
    found.push(warning);
  }
  return found;
}

function nextSteps(input: HandoffInput, open: HandoffOpenItem[]): string[] {
  const steps: string[] = [];
  for (const followUp of input.followUpTaskIds ?? []) {
    steps.push(
      `pick up ${followUp}, already queued with the scope this task could not take`,
    );
  }
  for (const item of open) {
    if (item.blockedBy.length > 0) {
      steps.push(
        `re-attempt ${item.item} once ${item.blockedBy.join(", ")} has settled`,
      );
    }
  }
  if (input.integration?.status === "stale") {
    steps.push("replan from current canonical before redoing any of the work");
  }
  if (input.contextPressure !== undefined) {
    steps.push(
      `continue the objective from a fresh workspace at ` +
        `${shortRevision(input.canonicalRevision)}; nothing from the stopped ` +
        "attempt was promoted",
    );
  }
  if (steps.length === 0 && open.length === 0) {
    steps.push("nothing outstanding from this task");
  }
  return [...new Set(steps)];
}

/** Projects a handoff from what the run actually recorded. */
export function buildTaskHandoff(input: HandoffInput): TaskHandoff {
  const open = openItems(input);
  const now = input.now ?? (() => new Date());
  return {
    version: 1,
    taskId: input.taskId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    repositoryId: input.repositoryId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    reason: input.reason,
    objective: input.objective,
    canonicalRevision: input.canonicalRevision,
    completed: completedEvidence(input),
    open,
    decisions: decisions(input),
    gotchas: gotchas(input),
    nextSteps: nextSteps(input, open),
    createdAt: now().toISOString(),
  };
}

/**
 * What the reader should treat as unknown rather than as absent.
 *
 * The seed is the only thing a fresh session knows about the work before it,
 * and an agent told "nothing was handed over" behaves very differently from
 * one told "I could not read what was handed over" — the first starts from a
 * clean sheet on purpose, the second knows to go and look. A read that lost
 * part of the log therefore has to say so inside the text it produces; there
 * is nowhere else for a successor to find out.
 */
export interface HandoffContextNotes {
  /** Records on the log, under the handoff type, that could not be read. */
  unreadable?: number;
  /** A leg of the log could not be read at all, so its contents are unknown. */
  incomplete?: boolean;
}

function unknownNotice(unreadable: number, incomplete: boolean): string {
  const parts: string[] = [];
  if (unreadable > 0) {
    parts.push(
      `${unreadable} handoff record${unreadable === 1 ? "" : "s"} on this ` +
        `repository's log could not be read`,
    );
  }
  if (incomplete) {
    parts.push("part of the log could not be read at all");
  }
  return (
    `**Unknown:** ${parts.join(", and ")}. What those tasks left is missing ` +
    "from everything below, so this is an incomplete record rather than an " +
    "empty one: treat what it does not mention as unknown, not as settled."
  );
}

/**
 * Renders a handoff as the context a fresh session is seeded with.
 *
 * Plain text on purpose: it is going into a prompt, and a successor should be
 * able to read the same thing a human reviewer reads. References are kept
 * inline so any claim can be checked without another round trip.
 *
 * Every stored field is rendered through `oneLine`, because this is a
 * structured document being built out of values the control plane stored but
 * did not constrain: an objective carrying a newline and a `###` would
 * otherwise render as a section of the document attributed to a task that
 * never wrote one.
 */
export function renderHandoffContext(
  handoffs: readonly TaskHandoff[],
  notes: HandoffContextNotes = {},
): string {
  const unreadable = notes.unreadable ?? 0;
  const incomplete = notes.incomplete ?? false;
  if (handoffs.length === 0 && unreadable === 0 && !incomplete) {
    return "";
  }
  const lines: string[] = [
    "## Handoff from earlier work on this repository",
    "",
    "Projected from the coordination record, not from anyone's recollection.",
    "Every reference below can be checked against the run it names.",
  ];
  // Ahead of the handoffs themselves, and not as a footnote: what is missing
  // changes how everything after it should be read.
  if (unreadable > 0 || incomplete) {
    lines.push("", unknownNotice(unreadable, incomplete));
  }
  for (const handoff of handoffs) {
    lines.push(
      "",
      // Dated in the heading, because staleness is the failure this file
      // cannot detect for the reader: a note and the revision it names are
      // both facts about a moment, and without that moment a successor has no
      // way to weigh a month-old plan against what it can see now.
      `### ${oneLine(handoff.taskId)} — ${oneLine(handoff.reason)} ` +
        `(recorded ${stated(handoff.createdAt, "at an unrecorded time")})`,
      `Objective: ${stated(handoff.objective, "not recorded")}`,
      `Canonical at handoff: ${shortRevision(handoff.canonicalRevision)}`,
    );
    const section = (title: string, entries: readonly string[]): void => {
      if (entries.length === 0) {
        return;
      }
      lines.push("", `**${title}**`);
      for (const entry of entries) {
        lines.push(`- ${oneLine(entry)}`);
      }
    };
    section(
      "Done",
      handoff.completed.map(
        (entry) => `${entry.kind} [${entry.reference}] — ${entry.detail}`,
      ),
    );
    section(
      "Still open",
      handoff.open.map(
        (entry) =>
          `${entry.item}${
            entry.blockedBy.length > 0
              ? ` (blocked by ${entry.blockedBy.join(", ")})`
              : ""
          } — ${entry.reason}`,
      ),
    );
    section(
      "Decisions",
      handoff.decisions.map(
        (entry) =>
          `${entry.decision} — ${entry.rationale}${
            entry.reference === undefined ? "" : ` [${entry.reference}]`
          }`,
      ),
    );
    section("Gotchas", handoff.gotchas);
    section("Next steps", handoff.nextSteps);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Recognises a stored audit payload as a handoff record.
 *
 * Every required field is checked, not a representative few, because saying
 * yes here is what licenses the rest of this file to dereference them: the
 * renderer slices `canonicalRevision`, the store keys its deduplication on
 * `createdAt`, and a heading is built from `reason`. A payload recognised on
 * a partial match is therefore not read half-well, it throws part-way through
 * seeding — and every caller treats a throw from the seed as "no handoffs",
 * so a truncated record would quietly take the whole repository's memory with
 * it. Refusing it instead costs exactly that one record, the read reports it
 * as one it could not read, and the rest of the log still reaches the
 * successor.
 *
 * "Every field" includes what is inside the lists: see `isListOf`.
 */
export function isTaskHandoff(value: unknown): value is TaskHandoff {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<TaskHandoff>;
  return (
    candidate.version === 1 &&
    typeof candidate.taskId === "string" &&
    typeof candidate.objective === "string" &&
    typeof candidate.repositoryId === "string" &&
    typeof candidate.reason === "string" &&
    typeof candidate.canonicalRevision === "string" &&
    typeof candidate.createdAt === "string" &&
    isListOf(candidate.completed, isEvidence) &&
    isListOf(candidate.open, isOpenItem) &&
    isListOf(candidate.decisions, isDecision) &&
    isListOf(candidate.gotchas, isString) &&
    isListOf(candidate.nextSteps, isString)
  );
}

/**
 * The same question, one level down.
 *
 * An array is not a checked field; it is a promise about twelve more. The
 * renderer walks `completed` for `kind`, `reference` and `detail`, calls
 * `blockedBy.join` on every open item, and reads `decision` and `rationale`
 * off every decision — so a record whose lists are the right shape and whose
 * *entries* are not is accepted here and then throws in the middle of
 * rendering a seed. The coordinator renders its own task's note outside the
 * guard it wraps the read in, so that throw does not cost a seed, it costs
 * the run. Checking an array without checking what is in it is the same bug
 * as checking six fields out of twelve, one level down.
 */
function isListOf<T>(
  value: unknown,
  entry: (candidate: unknown) => candidate is T,
): value is T[] {
  return Array.isArray(value) && value.every((element) => entry(element));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isEvidence(value: unknown): value is HandoffEvidence {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<HandoffEvidence>;
  return (
    typeof entry.kind === "string" &&
    typeof entry.reference === "string" &&
    typeof entry.detail === "string"
  );
}

function isOpenItem(value: unknown): value is HandoffOpenItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<HandoffOpenItem>;
  return (
    typeof entry.item === "string" &&
    typeof entry.reason === "string" &&
    isListOf(entry.blockedBy, isString)
  );
}

function isDecision(value: unknown): value is HandoffDecision {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<HandoffDecision>;
  return (
    typeof entry.decision === "string" &&
    typeof entry.rationale === "string" &&
    (entry.reference === undefined || typeof entry.reference === "string")
  );
}

/**
 * A resource this handoff concerns, for matching against a new task's plan.
 *
 * Follow-up work is "related" when it touches something the earlier task
 * touched or was blocked on — that is a checkable relation, unlike topical
 * similarity, which would surface a handoff because two objectives share a
 * word.
 */
export function handoffResources(handoff: TaskHandoff): string[] {
  const resources = new Set<string>();
  for (const entry of handoff.completed) {
    if (entry.kind === "changeset") {
      for (const file of entry.detail.replace("changed ", "").split(", ")) {
        if (file.trim().length > 0) {
          resources.add(file.trim());
        }
      }
    }
    if (entry.kind === "ownership") {
      resources.add(entry.reference.split(":").slice(1).join(":"));
    }
  }
  for (const item of handoff.open) {
    const match = /^(?:file|symbol|api|schema|configuration|test|service):(\S+)/u.exec(
      item.item,
    );
    if (match?.[1] !== undefined) {
      resources.add(match[1]);
    }
    const edits = /^edits to (\S+)/u.exec(item.item);
    if (edits?.[1] !== undefined) {
      resources.add(edits[1]);
    }
  }
  return [...resources].sort();
}

export const HANDOFF_AUDIT_TYPE = "handoff_recorded" as const;

export type { DeferredResource };
