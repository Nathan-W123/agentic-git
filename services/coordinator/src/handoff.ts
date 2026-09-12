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
        `promoted from ${integration.previousVersion.revision.slice(0, 12)} ` +
        `to ${integration.canonicalVersion.revision.slice(0, 12)}`,
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
      reason: input.failure,
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
      found.push(
        `"${entry.command.label}" fails here (exit ${entry.exitCode}); ` +
          `its output ends: ${entry.stderr.trim().slice(-300) || entry.stdout.trim().slice(-300)}`,
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
      `this result was written against ${integration.replayedFrom.slice(0, 12)} ` +
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
        `${input.canonicalRevision.slice(0, 12)}; nothing from the stopped ` +
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
 * Renders a handoff as the context a fresh session is seeded with.
 *
 * Plain text on purpose: it is going into a prompt, and a successor should be
 * able to read the same thing a human reviewer reads. References are kept
 * inline so any claim can be checked without another round trip.
 */
export function renderHandoffContext(
  handoffs: readonly TaskHandoff[],
): string {
  if (handoffs.length === 0) {
    return "";
  }
  const lines: string[] = [
    "## Handoff from earlier work on this repository",
    "",
    "Projected from the coordination record, not from anyone's recollection.",
    "Every reference below can be checked against the run it names.",
  ];
  for (const handoff of handoffs) {
    lines.push(
      "",
      `### ${handoff.taskId} — ${handoff.reason}`,
      `Objective: ${handoff.objective}`,
      `Canonical at handoff: ${handoff.canonicalRevision.slice(0, 12)}`,
    );
    const section = (title: string, entries: readonly string[]): void => {
      if (entries.length === 0) {
        return;
      }
      lines.push("", `**${title}**`);
      for (const entry of entries) {
        lines.push(`- ${entry}`);
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

/** Recognises a stored audit payload as a handoff record. */
export function isTaskHandoff(value: unknown): value is TaskHandoff {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<TaskHandoff>;
  return (
    candidate.version === 1 &&
    typeof candidate.taskId === "string" &&
    typeof candidate.objective === "string" &&
    Array.isArray(candidate.completed) &&
    Array.isArray(candidate.open) &&
    Array.isArray(candidate.nextSteps)
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
