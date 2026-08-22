import {
  arbitrationFiles,
  claimCoversPath,
  completeAgentPlan,
  isBlanketClaim,
  planAdmissionApproved,
  planGroundingConfidence,
  planResourceKey,
  reducePlanScope,
  uniqueRepositoryPaths,
  type AgentPlan,
  type ConflictAssessment,
  type ConflictEvidence,
  type DeferredResource,
  type DeferredResourceLocation,
  type PlanAdmission,
  type PlanResourceRef,
  type ResourceLease,
  type ResourceType,
  type TaskId,
} from "@coord/shared-types";

import type { NamedRange } from "./hunks.js";

import {
  ConflictDetector,
  type IntentConflictAssessment,
  relatedObjectives,
  type FileOccupancy,
} from "./conflict-detector.js";
import {
  OwnershipApprovalRequiredError,
  OwnershipConflictError,
  OwnershipService,
  type PlanFileClaim,
} from "./ownership-service.js";
import {
  WHOLE_FILE,
  normalizeRanges,
  subtractRanges,
  type LineRange,
} from "./ranges.js";

/**
 * Arbitration of one plan against the work already running.
 *
 * The local coordinator answers this question inside its wave scheduler: it
 * holds every plan in memory, assesses them pairwise, and only then hands a
 * workspace to an agent. A remote worker has no such vantage point — it holds
 * one plan and knows nothing about the others — so the same question has to be
 * answerable from a single candidate plus the set of plans currently executing.
 *
 * That is all this is: the same {@link ConflictDetector} and
 * {@link OwnershipService} the local path uses, driven from one side instead of
 * from above. Nothing here re-implements conflict scoring or ownership modes.
 */

/** A plan that has already been admitted and is being executed. */
export interface ActivePlan {
  taskId: TaskId;
  agentId: string;
  plan: AgentPlan;
}

export interface PlanAdmissionInput {
  plan: AgentPlan;
  agentId: string;
  /** Canonical revision the plan was written against. */
  baseRevision: string;
  /** Canonical sequence, used as the ownership lease base. */
  baseVersion: number;
  active: readonly ActivePlan[];
  planRevision?: number;
  /** How long a deferred holder should wait before resubmitting. */
  retryAfterMs?: number;
  /**
   * How many times this task has already been refused outright on this same
   * collision, counted by the caller from the admission record.
   *
   * A `blocked` answer tells the holder to plan again with a narrower scope.
   * That is sound advice exactly once, and only for a task that has scope to
   * shed. A task whose whole purpose is to change one contended function has
   * none: it replans, produces a materially identical plan, collides
   * identically, and is told to narrow again — forever, at the price of a full
   * planning round each time. A ten-task live run stalled four tasks that way
   * and spent 75% of its tokens on planning before the budget ran out.
   *
   * Past {@link BLOCKED_ATTEMPTS_BEFORE_SEQUENCING} the answer changes from
   * "plan again" to "wait your turn". See {@link PlanAdmissionController.decide}.
   */
  blockedAttempts?: number;
  /**
   * Whether a plan that only partly collides may be admitted on the rest of
   * its declared resources. Defaults to on. Turning it off restores strict
   * all-or-nothing arbitration, which is what a follow-up task gets: splitting
   * an already-split task again is how a task could keep shedding scope
   * forever.
   */
  partialAdmission?: boolean;
  /**
   * Resources the repository index attributes to one file.
   *
   * Plans reaching admission have been enriched: naming a file makes the plan
   * claim that file's symbols, APIs and schemas too. Withholding the file
   * without withholding those claims would leave the reduced plan asking for
   * the very things the other holder owns, and partial admission would almost
   * never apply. Supplying this lets a withheld file take its own derived
   * claims with it — and only its own: a symbol that also lives in a granted
   * file stays claimed, because the holder really may still edit it.
   */
  resourcesInFile?: (file: string) => readonly PlanResourceRef[];
  /**
   * Where each symbol lives in one file, or `undefined` when that file cannot
   * be parsed.
   *
   * Supplying this is what lets a *symbol* be withheld while the file holding
   * it is granted. Without it, a withheld symbol would be an instruction with
   * nothing behind it: the result is a set of file patches, and only line
   * positions make "did this patch touch that symbol" a question with an
   * answer. A single unreadable file among those being granted withdraws the
   * option entirely — half an answer is not one.
   */
  symbolRangesInFile?: (file: string) => readonly NamedRange[] | undefined;
  /**
   * A grounded reading of whether two plans' intents concern the same code.
   *
   * Supplying this swaps the hardcoded-antonym intent check for one that
   * resolves each intent sentence against the repository index. Its evidence
   * is advisory either way and cannot reach `sequence` or `block`; what
   * changes is the quality of the note a human is asked to look at.
   *
   * It is deliberately optional. The signal is wired in ahead of the live
   * validation that would justify it — `docs/benchmarks/intent-grounding-wired.md`
   * — so every path that arbitrates without it must keep working unchanged.
   */
  intentAssessment?: IntentConflictAssessment;
}

/**
 * Long enough that a resubmission is not a busy-wait, short enough that a
 * worker picks up a freed slot well inside one lease period.
 */
export const DEFAULT_PLAN_RETRY_MS = 15_000;

/**
 * Refusals to spend on "plan again with a narrower scope" before giving up on
 * narrowing and simply making the task wait.
 *
 * Two, because the first refusal is information the agent has not had yet —
 * it did not know the resource was held — and the second establishes that
 * knowing did not change the plan. A third would cost another planning round
 * to learn the same thing.
 *
 * This is a liveness bound, not a safety valve. Escalating goes from refusing
 * the plan to *sequencing* it behind the holder, which is a stricter promise
 * about ordering, not a weaker one: the task still does not run until the
 * blocker integrates. What stops is the pointless replanning while it waits.
 */
export const BLOCKED_ATTEMPTS_BEFORE_SEQUENCING = 2;

/**
 * Outright refusals a task may accumulate over its whole life before it is
 * sequenced regardless of how they were spaced.
 *
 * The consecutive bound above is the ordinary path and it has one blind spot:
 * a task whose refusals are interleaved with other non-approving answers never
 * builds an unbroken run, so the count keeps resetting while the planning
 * rounds keep being paid for. This is the backstop for that, and it is
 * deliberately loose — four refusals is already twice the point at which
 * narrowing was shown not to work, so reaching it means something stranger is
 * happening and waiting is the safe response.
 *
 * Like the consecutive bound this only ever converts a refusal into a wait. It
 * cannot admit anything.
 */
export const BLOCKED_ADMISSION_LIFETIME_CAP = 4;

/**
 * Resources a plan may claim in `approval_required` mode.
 *
 * Naming a schema in the plan is what makes the claim legitimate: the change
 * was declared to the coordinator up front rather than discovered mid-edit.
 * Shared by both scheduling paths so they grant ownership on identical terms.
 */
export function approvedSchemaResources(plan: AgentPlan): ReadonlySet<string> {
  return new Set(
    (plan.expectedSchemas ?? []).map((resource) => `schema\0${resource}`),
  );
}

/** Every resource a plan claims, other than the files themselves. */
function declaredResources(plan: AgentPlan): PlanResourceRef[] {
  const complete = completeAgentPlan(plan);
  const refs = (
    resourceType: PlanResourceRef["resourceType"],
    ids: readonly string[],
  ): PlanResourceRef[] =>
    ids.map((resourceId) => ({ resourceType, resourceId }));
  return [
    ...refs("symbol", complete.expectedSymbols),
    ...refs("api", complete.expectedApis),
    ...refs("schema", complete.expectedSchemas),
    ...refs("configuration", complete.expectedConfigKeys),
    ...refs("test", complete.expectedTests),
    ...refs("service", complete.expectedServices),
  ];
}

/**
 * The named spans a plan occupies inside one file, or `undefined` for all of
 * it.
 *
 * This is the judgement the whole of sub-file arbitration rests on, and it is
 * deliberately reluctant. `undefined` — the whole file — is returned wherever
 * the plan's reach cannot be bounded by something the index actually placed,
 * because a claim narrower than the truth hands another task lines this one
 * will edit.
 *
 * Two cases are bounded, and they are the ones where the plan never asked for
 * the file:
 *
 * - A file the plan **named** is the plan's, all of it. An agent told to edit
 *   a file edits it wherever it needs to, including the lines between the
 *   symbols an index can name, and including lines that did not exist when the
 *   index was built. Narrowing here would be reading a limit into a claim that
 *   never stated one — and after plan enrichment, where naming a file makes
 *   the plan claim that file's symbols, it would not even be narrower.
 * - A file a **misnamed file** declaration grounds to is the same case: the
 *   plan meant to edit that whole file, it just called it something else.
 *
 * What is left is the file a plan reaches *only* because verification mapped a
 * symbol it declared onto code living there. That plan never said the word
 * `total.js`; what it said was `calculateTotal`, and the index knows exactly
 * which lines that is. So the claim is those lines — provided every symbol
 * reaching in can be placed. One that cannot leaves lines unaccounted for, and
 * an unaccounted line is one this plan might edit while another task is being
 * told it owns it, so the whole file is the answer again.
 */
function occupiedSpans(
  plan: AgentPlan,
  file: string,
  locate: ((file: string) => readonly NamedRange[] | undefined) | undefined,
): readonly NamedRange[] | undefined {
  if (locate === undefined) {
    return undefined;
  }
  if (uniqueRepositoryPaths(plan.expectedFiles).includes(file)) {
    return undefined;
  }
  const grounding = plan.grounding;
  if (grounding === undefined) {
    return undefined;
  }
  if (grounding.fileReferents.some((entry) => entry.resolved === file)) {
    return undefined;
  }
  const reaching = new Set(
    grounding.symbolReferents
      .filter((entry) => entry.files.includes(file))
      .map((entry) => entry.resolved.toLowerCase()),
  );
  if (reaching.size === 0) {
    return undefined;
  }
  const ranges = locate(file);
  if (ranges === undefined) {
    return undefined;
  }
  const found = ranges.filter((range) => reaching.has(range.name.toLowerCase()));
  const placed = new Set(found.map((range) => range.name.toLowerCase()));
  return placed.size < reaching.size ? undefined : found;
}

/**
 * The lines a plan's own declared symbols occupy inside a file it declared.
 *
 * {@link occupiedSpans} deliberately reads a declared path as the whole file,
 * and that stays the ordinary reading: an agent told to edit a file edits it
 * wherever it needs to, so narrowing every such claim to the symbols the plan
 * happened to list would hand away lines its holder will use. This asks the
 * other question — where *inside* a declared file does this plan actually
 * work — and there is exactly one caller, for the one case where the answer
 * to the ordinary question is "then nobody else runs at all".
 *
 * It answers only when the answer is complete. Every symbol the plan declares
 * has to be placeable somewhere among the files it declared: a symbol the
 * index cannot find is one the plan is about to write from scratch, at a line
 * nobody can predict, and a footprint with an unplaced symbol in it is not
 * known to be smaller than the file.
 */
function declaredSpans(
  plan: AgentPlan,
  file: string,
  locate: (file: string) => readonly NamedRange[] | undefined,
): readonly NamedRange[] | undefined {
  const complete = completeAgentPlan(plan);
  const files = uniqueRepositoryPaths(complete.expectedFiles);
  // What the agent said, not what enrichment widened it to.
  //
  // `enrichPlan` puts every symbol of every declared file into
  // `expectedSymbols`. Read here, that makes a holder occupy the whole of any
  // file it named, so the only thing left to grant a second agent is the
  // space between the declarations — it is admitted to the file, writes the
  // function it came for, and has every hunk deferred back out again. The
  // split fired and bought nothing.
  //
  // `declaredSymbols` is the same plan's pre-enrichment words. Absent means
  // the plan was never enriched, so `expectedSymbols` is already those words;
  // empty means the agent named no symbols, which still takes the file whole.
  const claimed = plan.declaredSymbols ?? complete.expectedSymbols;
  if (!files.includes(file) || claimed.length === 0) {
    return undefined;
  }
  const referents = plan.grounding?.symbolReferents ?? [];
  // A declaration stands for its referent where verification found one, and
  // for itself where it did not.
  const wanted = claimed.map((symbol) => {
    const resolved = referents
      .filter((entry) => entry.declared === symbol)
      .map((entry) => entry.resolved.toLowerCase());
    return resolved.length === 0 ? [symbol.toLowerCase()] : resolved;
  });
  const placed = new Set<string>();
  for (const declared of files) {
    const ranges = locate(declared);
    if (ranges === undefined) {
      return undefined;
    }
    for (const range of ranges) {
      placed.add(range.name.toLowerCase());
    }
  }
  const occupies = new Set(wanted.flat());
  const all = locate(file) ?? [];
  const own = all.filter((range) => occupies.has(range.name.toLowerCase()));
  // Declarations this plan made that the index cannot place are functions it
  // is going to write, not mistakes. Nobody can say which lines they will
  // occupy, because they do not exist yet — but the places they *could*
  // occupy are exactly the parts of the file that are not already somebody's
  // declaration, and those can be withheld.
  const unwritten = claimed.filter((symbol, at) => {
    const names = wanted[at] ?? [];
    return !names.every((name) => placed.has(name));
  });
  if (unwritten.length === 0) {
    return own;
  }
  const zones = insertionZones(all);
  if (zones.length === 0) {
    // Nothing to withhold the new code to, so nothing can be promised about
    // where it lands. The whole file, as before.
    return undefined;
  }
  // Attributed to the symbol that is going to be written, which is the honest
  // reading and the one that renders: "newHelper is held by task X", and its
  // locations are every place newHelper might turn up.
  const first = unwritten[0] ?? "pending declaration";
  return [
    ...own,
    ...zones.map((zone) => ({
      name: first,
      startLine: zone.startLine,
      endLine: zone.endLine,
    })),
  ];
}

/**
 * Where a declaration that does not exist yet could be written.
 *
 * Everything inside the part of the file the index describes that is not
 * already the body of an innermost declaration: the preamble above the first
 * one, the gaps between them, the space inside a class between its methods,
 * and the tail after the last.
 *
 * Innermost is the whole of the rule. A class is a range containing other
 * ranges, and a new method lands *inside* it — but between its existing
 * members, never inside one of their bodies. So containers are treated as
 * open ground and only leaf declarations are closed, which is what lets a
 * second agent still be granted a method of a class its holder is adding to.
 *
 * The bound is the last line the index accounts for rather than the end of
 * the file, for the same reason {@link leavesGround} uses it: granting the
 * space past everything anyone declared is not a grant of anything.
 */
function insertionZones(all: readonly NamedRange[]): LineRange[] {
  const known = all.reduce((end, range) => Math.max(end, range.endLine), 0);
  if (known === 0) {
    return [];
  }
  const leaves = all.filter(
    (range) =>
      !all.some(
        (other) =>
          other !== range &&
          other.startLine >= range.startLine &&
          other.endLine <= range.endLine &&
          (other.startLine > range.startLine || other.endLine < range.endLine),
      ),
  );
  return subtractRanges([{ startLine: 1, endLine: known }], leaves);
}

/**
 * Whether what a holder leaves of a file is a share of it or only its tail.
 *
 * Reading a declared file as its declared symbols is only honest where those
 * symbols do not add up to the file. Enrichment makes a plan that names a file
 * claim every symbol in it, so on a file that is nothing but declarations the
 * derived ranges cover the whole thing and what would be "granted" is the
 * space past the last line anyone placed — permission to append to a file
 * whose every known line belongs to somebody else, arbitrated against nothing.
 * That is the illusory split, and this is what declines it: the holders have
 * to leave a hole in what the index describes, not merely an end to it.
 */
function leavesGround(
  placed: readonly NamedRange[],
  withheld: readonly LineRange[],
): boolean {
  const known = placed.reduce((end, range) => Math.max(end, range.endLine), 0);
  return (
    known > 0 &&
    subtractRanges([{ startLine: 1, endLine: known }], withheld).length > 0
  );
}

/** A contested file the candidate can still be granted the rest of. */
interface PartiallyHeldFile {
  file: string;
  /** The lines its holders occupy, withheld from the candidate. */
  ranges: LineRange[];
  /**
   * The same withholding stated as the holders' symbols.
   *
   * This is what reaches the admission, because it is the shape enforcement
   * already understands: a withheld symbol with `locations` in a granted file
   * is divided out of that file's patch at the hunk.
   */
  symbols: DeferredResource[];
}

/**
 * Whether a holder named this symbol itself, rather than inheriting it.
 *
 * Only meaningful for symbols, and only for an enriched plan: `undefined`
 * `declaredSymbols` means nothing widened this plan, so `expectedSymbols` is
 * already what the agent asked for and every entry in it counts.
 */
function holdsSymbolItself(
  resourceType: ResourceType,
  plan: AgentPlan,
  resourceId: string,
): boolean {
  if (resourceType !== "symbol" || plan.declaredSymbols === undefined) {
    return true;
  }
  const wanted = resourceId.toLowerCase();
  return plan.declaredSymbols.some((name) => name.toLowerCase() === wanted);
}

/** One withheld resource per symbol a holder occupies in a shared file. */
function withheldSymbolsFor(
  file: string,
  spans: readonly NamedRange[],
  contest: DeferredResource,
): DeferredResource[] {
  const placed = new Map<string, DeferredResourceLocation[]>();
  for (const span of spans) {
    placed.set(span.name, [
      ...(placed.get(span.name) ?? []),
      { file, startLine: span.startLine, endLine: span.endLine },
    ]);
  }
  return [...placed]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, locations]): DeferredResource => ({
      resourceType: "symbol",
      resourceId: name,
      heldBy: contest.heldBy,
      reason:
        `held inside ${file} by ${contest.heldBy.join(", ")}, which is the ` +
        `only part of that file being withheld: ${contest.reason}`,
      locations,
    }));
}

/** Intent evidence is advisory; only structural evidence controls scheduling. */
export function structuralConflict(assessment: ConflictAssessment): boolean {
  return assessment.evidence.some(
    (entry) => entry.advisory !== true && entry.score > 0,
  );
}

function otherTask(assessment: ConflictAssessment, taskId: TaskId): TaskId {
  return assessment.taskIds.find((id) => id !== taskId) ?? taskId;
}

/**
 * The agent-facing half of a partial admission.
 *
 * It reaches the agent through the coordinator decision the worker sends
 * before execution, so a well-behaved agent simply never writes to these
 * files. The control plane does not rely on that: a changeset that touches a
 * deferred file is split apart rather than applied.
 */
export function deferralConstraints(
  deferred: readonly DeferredResource[],
): string[] {
  if (deferred.length === 0) {
    return [];
  }
  return [
    "Do not modify these deferred resources; they are owned by other " +
      `executing tasks and will be handled by a follow-up task: ${deferred
        .map((resource) => `${resource.resourceType}:${resource.resourceId}`)
        .join(", ")}`,
    ...deferred.map(
      (resource) =>
        `${resource.resourceType}:${resource.resourceId} — ${resource.reason}`,
    ),
    // A resource withheld inside a file the agent *was* granted is the one
    // case where the instruction is genuinely hard to follow from the name
    // alone: the file is open in front of it and the forbidden part is not
    // marked. Naming the lines makes it followable, and the enforcement pass
    // holds the result to exactly those lines either way.
    ...deferred
      .filter((resource) => (resource.locations ?? []).length > 0)
      .map(
        (resource) =>
          `${resource.resourceType}:${resource.resourceId} occupies ` +
          (resource.locations ?? [])
            .map(
              (location) =>
                `${location.file} lines ${String(location.startLine)}-` +
                String(location.endLine),
            )
            .join(", ") +
          "; edits elsewhere in those files are yours to make",
      ),
  ];
}

/**
 * The decision a successful split returns.
 *
 * Both splits end the same way and have to: the difference between them is
 * where the line was drawn, not what a partial admission means once it is
 * drawn. One shape here is what keeps the audit trail and the agent-facing
 * constraints identical whichever half produced them.
 */
function partiallyAdmitted(
  whole: PlanAdmission,
  partial: PlanAdmission,
  reduced: AgentPlan,
  deferred: readonly DeferredResource[],
): PlanAdmission {
  return {
    ...partial,
    status: "approved_with_constraints",
    // Not blocked: this holder is executing. What is held up is named
    // per-resource in `deferredResources`, alongside who holds it.
    blockedBy: [],
    deferredResources: [...deferred],
    constraints: [...partial.constraints, ...deferralConstraints(deferred)],
    conflicts: [
      ...partial.conflicts,
      ...whole.conflicts.filter(structuralConflict),
    ],
    explanation:
      `Partially admitted: granted ${reduced.expectedFiles.join(", ")}; ` +
      `deferred ` +
      deferred
        .map(
          (resource) =>
            `${resource.resourceId} (held by ${resource.heldBy.join(", ")})`,
        )
        .join(", "),
  };
}

export class PlanAdmissionController {
  public constructor(
    private readonly conflicts: ConflictDetector = new ConflictDetector(),
    /**
     * Ownership is evaluated from scratch on every admission rather than held
     * across calls: the durable set of active plans is the store's, and a
     * long-lived in-memory lease table would drift from it whenever a lease
     * lapsed or a control-plane process restarted.
     */
    private readonly ownershipFor: () => OwnershipService = () =>
      new OwnershipService(),
  ) {}

  /**
   * Decides one plan against the work already running.
   *
   * All-or-nothing first, because that is the answer that needs no
   * qualification. Only when the whole plan is refused is the finer question
   * asked: is *some* of it free right now? A plan that names five files and
   * collides on one has four files nobody is touching, and making the holder
   * wait for all five is throughput thrown away for no safety gained.
   */
  public admit(input: PlanAdmissionInput): PlanAdmission {
    // Answered before anything is scored, because a coordinator-issued claim
    // is not a set of declarations conflict scoring could compare with: a
    // blanket claim holds the whole repository, and a claim frozen from
    // observation holds directories its holder is still working through. Both
    // are refusals of overlap rather than judgements about it, and both leave
    // everything outside them to be decided exactly as it always was.
    const claimed = this.claimBlocked(input);
    const blanketClaimed = input.active.some(
      (entry) =>
        entry.taskId !== input.plan.taskId && isBlanketClaim(entry.plan),
    );
    // A blanket claim has no free portion to identify: until it is frozen,
    // every candidate path is held. A frozen claim is different. Its covered
    // directories can be withheld just like overlapping planned files while
    // the candidate's paths outside those directories are admitted.
    if (claimed !== undefined && blanketClaimed) {
      return claimed;
    }
    const whole =
      claimed ?? this.decide(input.plan, input, this.occupancy(input));
    if (planAdmissionApproved(whole) || input.partialAdmission === false) {
      return whole;
    }
    // A plan whose declarations verification could not connect to the
    // repository has no trustworthy *line* to split along — but it still has
    // paths. Ranges and symbols come from the index and an ungrounded plan
    // has none, so those splits stay refused. Declared-path disjointness
    // needs no index at all: "you name filters.py and nobody else does" is
    // checkable on the declarations alone, and if the agent then writes
    // outside what it named, scope enforcement catches that exactly as it
    // does for a grounded plan.
    //
    // This is the greenfield case, not a corner: in an empty repository
    // *every* file is being created and *every* plan is ungrounded, so
    // refusing all splitting here meant partial admission could never fire
    // during the phase of a project when tasks overlap most.
    if (planGroundingConfidence(input.plan) === "ungrounded") {
      return this.admitDeclaredPaths(input, whole) ?? whole;
    }
    return this.admitPartially(input, whole) ?? whole;
  }

  /**
   * The path-granularity half of partial admission, for plans the index
   * cannot vouch for.
   *
   * Same discipline as `admitPartially` — the reduced plan is re-decided, not
   * waved through — but only whole declared files are ever withheld: no line
   * ranges, no symbol claims, because both would be statements about contents
   * this admission has no way to read.
   */
  private admitDeclaredPaths(
    input: PlanAdmissionInput,
    whole: PlanAdmission,
  ): PlanAdmission | undefined {
    const occupancy = this.occupancy(input);
    const contested = this.contestedFiles(input, occupancy);
    if (contested.length === 0) {
      // The refusal was not about file overlap, so there is no path split
      // that answers it.
      return undefined;
    }
    const deferred = [...contested, ...this.derivedFrom(input, contested)];
    const reduced = reducePlanScope(input.plan, deferred);
    if (reduced.expectedFiles.length === 0) {
      return undefined;
    }
    const partial = this.decide(reduced, input, occupancy, true);
    if (!planAdmissionApproved(partial)) {
      return undefined;
    }
    // The evidence recorded is the collision this split was an answer to, and
    // `whole` may not carry it: where the refusal came from the unverifiability
    // gate, that branch returns before anything is assessed and its `conflicts`
    // are empty. Assessing the whole plan structurally is what puts the file
    // overlap back in the audit trail, rather than reporting a partial
    // admission with nothing to say what was partial about it.
    const structural = this.decide(input.plan, input, occupancy, true);
    return {
      ...partial,
      status: "approved_with_constraints",
      blockedBy: [],
      deferredResources: deferred,
      constraints: [...partial.constraints, ...deferralConstraints(deferred)],
      conflicts: [
        ...partial.conflicts,
        ...structural.conflicts.filter(structuralConflict),
        ...whole.conflicts.filter(structuralConflict),
      ].filter(
        (assessment, index, all) =>
          all.findIndex(
            (other) =>
              other.taskIds.join("\0") === assessment.taskIds.join("\0"),
          ) === index,
      ),
      explanation:
        `Partially admitted on declared paths: granted ` +
        `${reduced.expectedFiles.join(", ")}; deferred ` +
        deferred
          .map(
            (resource) =>
              `${resource.resourceId} (held by ${resource.heldBy.join(", ")})`,
          )
          .join(", "),
    };
  }

  /**
   * Admits the uncontested remainder of a plan, or nothing.
   *
   * The reduced plan is put through the same arbitration as any other plan
   * rather than being waved through: partial admission decides *what to ask*,
   * it never decides the answer. If the remainder is refused for any reason —
   * a symbol both plans still claim, a schema awaiting approval, dependency
   * impact that no resource removal can undo — the original all-or-nothing
   * answer stands.
   *
   * Files are settled first, because a file can always be held to: the result
   * is a set of file patches, and a patch on a file that was not granted is
   * refused on its path alone. A contested file is not automatically a lost
   * one, though — where its holders occupy lines the index can place, only
   * those lines are withheld and the path is granted. Only when what is left
   * still collides — a symbol both plans claim, typically — is the finer
   * withholding tried, and only where the index can say which lines that
   * symbol occupies in every file being granted. Where it cannot, the plan
   * waits, because an instruction the control plane cannot check is not one.
   *
   * The cost is one the repository parallelism bound already accepts. This
   * turns "the second plan waits" into "the second plan runs concurrently", so
   * the two now race to integrate — and where the advance turns out to be
   * disjoint from the loser's work, the loser is replayed rather than
   * discarded. It is only ever reached where concurrent leases are enabled:
   * with parallelism of one, no two plans are active in a repository at once
   * and nothing here can fire.
   */
  private admitPartially(
    input: PlanAdmissionInput,
    whole: PlanAdmission,
  ): PlanAdmission | undefined {
    const occupancy = this.occupancy(input);
    const contested = this.contestedFiles(input, occupancy);
    // A contested file is not automatically a file lost. Where every holder of
    // it occupies known lines and the candidate really named the path, the
    // contest is over those lines and not over the file, so what is withheld
    // is the holder's own code and the rest of the file is granted.
    const { whole: lost, partial: shared } = this.partitionContested(
      input,
      contested,
    );
    const narrowed = this.occupancy(
      input,
      new Map(shared.map((entry) => [entry.file, entry.ranges])),
    );
    // No contested file is not the end of it: what collides may be finer than
    // a file, and often is — two plans naming one symbol in a file only one of
    // them declared is exactly what ownership exists to catch.
    let deferred = [
      ...(lost.length === 0
        ? []
        : [
            ...lost,
            ...this.derivedFrom(input, lost),
            ...this.carriedSymbols(input, lost, occupancy),
          ]),
      ...shared.flatMap((entry) => entry.symbols),
    ];
    let reduced =
      deferred.length === 0 ? input.plan : reducePlanScope(input.plan, deferred);
    // Nothing left to work on at path granularity — every file this plan
    // named is held by somebody. Dropping them all would leave an agent run
    // producing an empty changeset, which is strictly worse than waiting its
    // turn, so the only thing left to try is a line drawn inside the files
    // rather than around them.
    if (reduced.expectedFiles.length === 0) {
      return this.admitWithinFiles(input, whole, contested);
    }
    let partial =
      deferred.length === 0
        ? whole
        : this.decide(reduced, input, narrowed, true);

    // Dropping the contested files was not enough, or there were none to drop.
    // Withholding a symbol is only offered when every file still being granted
    // can be read closely enough to tell whether a patch reached into it.
    if (!planAdmissionApproved(partial)) {
      const symbols = this.contestedSymbols(input, reduced, narrowed);
      if (symbols.length === 0) {
        return undefined;
      }
      deferred = [...deferred, ...symbols];
      reduced = reducePlanScope(input.plan, deferred);
      if (reduced.expectedFiles.length === 0) {
        return undefined;
      }
      partial = this.decide(reduced, input, narrowed, true);
    }
    if (!planAdmissionApproved(partial) || deferred.length === 0) {
      return undefined;
    }
    return partiallyAdmitted(whole, partial, reduced, deferred);
  }

  /**
   * The last thing tried before a plan is made to wait: granting the contested
   * paths themselves and withholding only the lines their holders occupy.
   *
   * Withholding whole files answers nothing when every file the plan named is
   * contested, and that is not a corner — it is the case worth splitting most.
   * Two tasks working on different functions of one seven-thousand-line file
   * collide on the path and nowhere else, and arbitration that can only reason
   * about paths has nothing to offer them but a queue.
   *
   * What this reads differently is a holder's claim on a file it declared.
   * Everywhere else that claim is the whole path, and deliberately so; here
   * the alternative is not a slightly smaller grant but no grant at all, so
   * the holder is held to the lines the index actually places its declared
   * symbols at. The standing objection to reading a declared file that way is
   * that enrichment makes a plan naming a file claim every symbol in it, so
   * the derived ranges would cover the file and the grant would be illusory —
   * which is exactly the condition {@link leavesGround} declines on. Where
   * they do not cover it, the hole they leave is real and the candidate can
   * work in it.
   *
   * Everything else is unchanged, because the result is enforced by the same
   * machinery: withheld symbols with locations, divided out of the granted
   * file's patch at the hunk. Wherever the index cannot answer — an unreadable
   * file among those being granted, a holder whose symbols it cannot place, a
   * path the candidate only reached through a misname — this offers nothing
   * and the plan waits, exactly as it does today. An instruction the control
   * plane cannot check is not one.
   */
  private admitWithinFiles(
    input: PlanAdmissionInput,
    whole: PlanAdmission,
    contested: readonly DeferredResource[],
  ): PlanAdmission | undefined {
    const locate = input.symbolRangesInFile;
    if (locate === undefined || contested.length === 0) {
      return undefined;
    }
    // Every declared file is still being granted here — that is the point —
    // so every one of them has to be readable. One that is not withdraws the
    // option entirely: half an answer is not one.
    const granted = uniqueRepositoryPaths(input.plan.expectedFiles);
    if (
      granted.length === 0 ||
      granted.some((file) => locate(file) === undefined)
    ) {
      return undefined;
    }
    const declared = new Set(granted);
    const misnamed = new Set(
      (input.plan.grounding?.fileReferents ?? []).map((entry) => entry.declared),
    );
    const shared: PartiallyHeldFile[] = [];
    const occupied = new Map<TaskId, Map<string, readonly LineRange[]>>();

    for (const entry of contested) {
      const file = entry.resourceId;
      // A path the plan only reached through a misname carries no patch to
      // divide, and a contested file that cannot be shared is a file lost —
      // which is what emptied the reduced plan to begin with. Either way there
      // is no split here, only the wait the caller already decided on.
      if (
        !declared.has(file) ||
        misnamed.has(file) ||
        entry.heldBy.length === 0
      ) {
        return undefined;
      }
      const spans: NamedRange[] = [];
      for (const holder of entry.heldBy) {
        const active = input.active.find((plan) => plan.taskId === holder);
        // A claim is a statement about what a task is allowed to reach rather
        // than about what it declared, so a frozen claim over this path has no
        // lines to withhold and takes the file whole.
        const held =
          active === undefined || claimCoversPath(active.plan, file)
            ? undefined
            : declaredSpans(active.plan, file, locate);
        if (held === undefined || held.length === 0) {
          return undefined;
        }
        spans.push(...held);
        const byFile =
          occupied.get(holder) ?? new Map<string, readonly LineRange[]>();
        byFile.set(file, normalizeRanges(held));
        occupied.set(holder, byFile);
      }
      shared.push({
        file,
        ranges: normalizeRanges(spans),
        symbols: withheldSymbolsFor(file, spans, entry),
      });
    }

    // Granting a plan the tail of a file whose every placed line is somebody
    // else's is not a split, and it is what the enriched symbol claim produces
    // on a file made only of declarations. At least one of these files has to
    // leave real ground behind, or the plan waits as it did before.
    if (
      !shared.some((entry) =>
        leavesGround(locate(entry.file) ?? [], entry.ranges),
      )
    ) {
      return undefined;
    }
    const within = this.occupancy(
      input,
      new Map(shared.map((entry) => [entry.file, entry.ranges])),
      occupied,
    );
    let deferred = shared.flatMap((entry) => entry.symbols);
    if (deferred.length === 0) {
      return undefined;
    }
    let reduced = reducePlanScope(input.plan, deferred);
    let partial = this.decide(reduced, input, within, true);
    // The holders' lines were not the whole of it: something the candidate
    // declares in its own right is held too. Same finer withholding as the
    // path-level split, under the same enforceability test.
    if (!planAdmissionApproved(partial)) {
      const symbols = this.contestedSymbols(input, reduced, within);
      if (symbols.length === 0) {
        return undefined;
      }
      deferred = [...deferred, ...symbols];
      reduced = reducePlanScope(input.plan, deferred);
      if (reduced.expectedFiles.length === 0) {
        return undefined;
      }
      partial = this.decide(reduced, input, within, true);
    }
    if (!planAdmissionApproved(partial)) {
      return undefined;
    }
    return partiallyAdmitted(whole, partial, reduced, deferred);
  }

  /**
   * A refusal when an executing task holds a claim over something this plan
   * wants, or nothing when it does not.
   *
   * Deliberately not folded into conflict scoring. A claim is a statement
   * about what a task is *allowed* to reach, not evidence about what it
   * intends, and scoring it would let a high-confidence disjointness argument
   * talk its way past a lease that has already been granted.
   */
  private claimBlocked(input: PlanAdmissionInput): PlanAdmission | undefined {
    const candidate = input.plan.taskId;
    const others = input.active.filter((entry) => entry.taskId !== candidate);
    if (others.length === 0) {
      return undefined;
    }
    const wanted = arbitrationFiles(input.plan);
    const blocking = others.filter(
      (entry) =>
        isBlanketClaim(entry.plan) ||
        wanted.some((file) => claimCoversPath(entry.plan, file)),
    );
    if (blocking.length === 0) {
      return undefined;
    }
    const blanket = blocking.some((entry) => isBlanketClaim(entry.plan));
    return {
      taskId: candidate,
      planRevision: input.planRevision ?? 1,
      baseRevision: input.baseRevision,
      decidedAt: new Date().toISOString(),
      status: "sequenced",
      ownershipGrants: [],
      constraints: [
        blanket
          ? "Resubmit once the repository-wide claim is narrowed or released"
          : "Plan around the directories the executing task is working in, " +
            "or resubmit once it integrates",
      ],
      blockedBy: blocking.map((entry) => entry.taskId).sort(),
      conflicts: [],
      explanation: blanket
        ? "A task already executing holds a repository-wide claim, so nothing " +
          "else can be admitted until it is narrowed to what it has touched"
        : "Executing work holds " +
          blocking
            .flatMap((entry) =>
              (entry.plan.claim?.kind === "frozen"
                ? entry.plan.claim.directories
                : []
              ).filter((directory) =>
                wanted.some((file) => file.startsWith(directory)),
              ),
            )
            .filter((value, index, all) => all.indexOf(value) === index)
            .sort()
            .join(", "),
      retryAfterMs: input.retryAfterMs ?? DEFAULT_PLAN_RETRY_MS,
    };
  }

  /**
   * How every plan in this admission is read at sub-file granularity.
   *
   * One function serves both halves of arbitration deliberately. Conflict
   * scoring and ownership have to agree about what a plan occupies, or a file
   * cleared by one would be refused by the other and partial admission would
   * offer something it could not deliver.
   *
   * `narrowed` is the candidate's side of a partial grant: the lines withheld
   * from it in a file it is otherwise being given. Subtracting them is what
   * turns "this plan wants total.js" into "this plan wants total.js except
   * lines 40–80", which is the claim that no longer intersects the holder's.
   * An empty remainder is left empty — nothing of the file survived, and the
   * caller must not read that as an unrestricted claim.
   */
  private occupancy(
    input: PlanAdmissionInput,
    narrowed: ReadonlyMap<string, readonly LineRange[]> = new Map(),
    occupied: ReadonlyMap<
      TaskId,
      ReadonlyMap<string, readonly LineRange[]>
    > = new Map(),
  ): FileOccupancy {
    const locate = input.symbolRangesInFile;
    const candidate = input.plan.taskId;
    return (plan, file) => {
      // A holder's side of a sub-file split. Its lease has to say the same
      // lines the candidate's withholding says, or the candidate would be
      // granted a remainder the holder's own claim still covers whole and
      // ownership would refuse the very split that was just decided.
      const stated =
        plan.taskId === candidate
          ? undefined
          : occupied.get(plan.taskId)?.get(file);
      if (stated !== undefined) {
        return normalizeRanges(stated);
      }
      const spans = occupiedSpans(plan, file, locate);
      const held = plan.taskId === candidate ? narrowed.get(file) : undefined;
      if (held === undefined || held.length === 0) {
        return spans === undefined ? undefined : normalizeRanges(spans);
      }
      return subtractRanges(spans ?? [WHOLE_FILE], held);
    };
  }

  /**
   * The file claims ownership should issue leases against, beyond the bare
   * paths a plan declared.
   *
   * Two shapes come out of this. A file the plan reaches only through a
   * grounded symbol referent gets a lease it would not otherwise have had, in
   * ranged form — it can never refuse anything a whole-file lease would have
   * let through, because there was no lease before. And a declared file whose
   * claim has been narrowed by a partial grant gets its existing lease cut
   * down to the lines actually being granted.
   */
  private fileClaims(
    plan: AgentPlan,
    occupancy: FileOccupancy,
  ): PlanFileClaim[] {
    const claims: PlanFileClaim[] = [];
    for (const file of arbitrationFiles(plan)) {
      const ranges = occupancy(plan, file);
      if (ranges === undefined) {
        continue;
      }
      claims.push({ file, ranges });
    }
    return claims;
  }

  /**
   * Splits the contested files into the ones that must be lost whole and the
   * ones that can be granted with the holder's lines cut out.
   *
   * Three things have to hold before a file can be shared, and each of them is
   * about being able to *enforce* the split rather than merely announce it:
   *
   * - the candidate must have declared the path itself. What a division holds
   *   back are hunks of a patch on that path, and a path the plan only reached
   *   through a misname is not one any patch will carry;
   * - every holder must be visible and occupy known lines. A holder whose
   *   plan this admission cannot see, or who owns the whole file, leaves the
   *   remainder undefined;
   * - the holder's lines must belong to symbols the index can name, because
   *   the enforcement pass re-derives them from the base index by name rather
   *   than trusting a decision that travelled over the wire.
   *
   * The withholding is then expressed as those symbols, not as the file. That
   * is not a presentational choice: a withheld symbol carrying `locations` is
   * exactly the shape `splitChangeSet` already divides a granted file's patch
   * by, so the sub-file grant is enforced by machinery that was already there
   * and already tested against real `git apply`.
   */
  private partitionContested(
    input: PlanAdmissionInput,
    contested: readonly DeferredResource[],
  ): { whole: DeferredResource[]; partial: PartiallyHeldFile[] } {
    const locate = input.symbolRangesInFile;
    const declared = new Set(uniqueRepositoryPaths(input.plan.expectedFiles));
    const misnamed = new Set(
      (input.plan.grounding?.fileReferents ?? []).map((entry) => entry.declared),
    );
    const lost: DeferredResource[] = [];
    const shared: PartiallyHeldFile[] = [];

    for (const entry of contested) {
      const file = entry.resourceId;
      if (!declared.has(file) || misnamed.has(file)) {
        lost.push(entry);
        continue;
      }
      const spans: NamedRange[] = [];
      let bounded = entry.heldBy.length > 0;
      for (const holder of entry.heldBy) {
        const active = input.active.find((plan) => plan.taskId === holder);
        const held =
          active === undefined
            ? undefined
            : occupiedSpans(active.plan, file, locate);
        if (held === undefined || held.length === 0) {
          bounded = false;
          break;
        }
        spans.push(...held);
      }
      if (!bounded || spans.length === 0) {
        lost.push(entry);
        continue;
      }
      shared.push({
        file,
        ranges: normalizeRanges(spans),
        symbols: withheldSymbolsFor(file, spans, entry),
      });
    }
    return { whole: lost, partial: shared };
  }

  /**
   * Claims the plan only carries because of a file being withheld.
   *
   * A resource that also belongs to a granted file is not returned: the holder
   * keeps working in that file, so it keeps the claim. What is returned is
   * exactly the set no granted file accounts for, which is what makes
   * withholding it enforceable — no patch that reaches canonical can be in a
   * file these live in.
   */
  private derivedFrom(
    input: PlanAdmissionInput,
    contested: readonly DeferredResource[],
  ): DeferredResource[] {
    const locate = input.resourcesInFile;
    if (locate === undefined) {
      return [];
    }
    const withheld = new Set(contested.map((entry) => entry.resourceId));
    const retained = new Set(
      input.plan.expectedFiles
        .filter((file) => !withheld.has(file))
        .flatMap((file) => locate(file))
        .map((resource) =>
          planResourceKey(resource.resourceType, resource.resourceId),
        ),
    );
    const claimed = new Set(
      declaredResources(input.plan).map((resource) =>
        planResourceKey(resource.resourceType, resource.resourceId),
      ),
    );

    const derived = new Map<string, DeferredResource>();
    for (const file of contested) {
      for (const resource of locate(file.resourceId)) {
        const key = planResourceKey(
          resource.resourceType,
          resource.resourceId,
        );
        if (retained.has(key) || !claimed.has(key) || derived.has(key)) {
          continue;
        }
        derived.set(key, {
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
          heldBy: file.heldBy,
          reason:
            `claimed only through the deferred file ${file.resourceId}`,
        });
      }
    }
    return [...derived.values()].sort((left, right) =>
      `${left.resourceType}:${left.resourceId}`.localeCompare(
        `${right.resourceType}:${right.resourceId}`,
      ),
    );
  }

  /**
   * Declared symbols whose contest exists only through grounding, withheld
   * alongside the files that made them contested.
   *
   * A hallucinated plan's symbol claim (`calculateTotal`, grounded to
   * `orderTotal`) collides through its referent, and the ordinary
   * symbol-withholding stage cannot touch it: that stage requires the
   * withheld symbol to be locatable in a granted file, and a misname is
   * locatable nowhere. But when the referent is provably absent from every
   * file still being granted — the granted files all parse, and none of them
   * declares it — no patch this plan is allowed to produce can reach the real
   * symbol's definition, so withholding the misnamed declaration is sound:
   * reduction strips the declaration and its referents together, and the
   * remainder genuinely stops claiming the contested code. A patch could
   * still *introduce* a fresh definition under the withheld name in a granted
   * file; that is new code, not an edit to what the other holder owns.
   */
  private carriedSymbols(
    input: PlanAdmissionInput,
    withheldFiles: readonly DeferredResource[],
    occupancy: FileOccupancy,
  ): DeferredResource[] {
    const grounding = input.plan.grounding;
    const locate = input.symbolRangesInFile;
    if (grounding === undefined || locate === undefined) {
      return [];
    }
    const withheld = new Set(withheldFiles.map((entry) => entry.resourceId));
    const remaining = input.plan.expectedFiles.filter(
      (file) => !withheld.has(file),
    );
    const ranges = remaining.map((file) => locate(file));
    if (ranges.some((entry) => entry === undefined)) {
      return [];
    }
    const located = new Set(
      ranges
        .flatMap((entry) => entry ?? [])
        .map((range) => range.name.toLowerCase()),
    );
    const contested = this.contested(
      input,
      input.plan,
      {
        resourceType: "symbol",
        evidence: "symbol_overlap",
        declared: input.plan.expectedSymbols,
      },
      occupancy,
    );
    return contested.filter((resource) => {
      const referents = grounding.symbolReferents.filter(
        (entry) => entry.declared === resource.resourceId,
      );
      return (
        referents.length > 0 &&
        !located.has(resource.resourceId.toLowerCase()) &&
        referents.every(
          (entry) => !located.has(entry.resolved.toLowerCase()),
        )
      );
    });
  }

  /** Declared files that executing work is holding, with who holds each. */
  private contestedFiles(
    input: PlanAdmissionInput,
    occupancy: FileOccupancy,
  ): DeferredResource[] {
    const contested = this.contested(
      input,
      input.plan,
      {
        resourceType: "file",
        evidence: "file_overlap",
        declared: uniqueRepositoryPaths(input.plan.expectedFiles),
      },
      occupancy,
    );
    const byFile = new Map(
      contested.map((entry) => [entry.resourceId, entry]),
    );

    // Frozen claims deliberately widen touched files to their directories.
    // Those paths do not appear as ordinary plan declarations, so conflict
    // scoring and ownership cannot discover them. Add them explicitly to the
    // same contested-resource set partial admission already knows how to
    // reduce and enforce.
    for (const file of uniqueRepositoryPaths(input.plan.expectedFiles)) {
      for (const holder of input.active) {
        if (
          holder.taskId === input.plan.taskId ||
          holder.plan.claim?.kind !== "frozen" ||
          !claimCoversPath(holder.plan, file)
        ) {
          continue;
        }
        const existing = byFile.get(file);
        const heldBy = new Set(existing?.heldBy ?? []);
        heldBy.add(holder.taskId);
        byFile.set(file, {
          resourceType: "file",
          resourceId: file,
          heldBy: [...heldBy].sort(),
          reason: [
            ...(existing === undefined ? [] : [existing.reason]),
            `covered by frozen claim held by ${holder.taskId}`,
          ]
            .filter((reason, index, all) => all.indexOf(reason) === index)
            .sort()
            .join("; "),
        });
      }
    }

    return [...byFile.values()].sort((left, right) =>
      left.resourceId.localeCompare(right.resourceId),
    );
  }

  /**
   * Symbols still held once the contested files are gone, if and only if they
   * can be enforced.
   *
   * Enforcement means being able to answer "did this patch reach into that
   * symbol" for every file being granted, which needs line positions for all
   * of them. One unreadable file among them and the answer is no symbol at
   * all: a withheld symbol the control plane cannot check is an instruction to
   * the agent and nothing more, and this feature does not rest on agents
   * following instructions.
   */
  private contestedSymbols(
    input: PlanAdmissionInput,
    reduced: AgentPlan,
    occupancy: FileOccupancy,
  ): DeferredResource[] {
    const locate = input.symbolRangesInFile;
    if (locate === undefined) {
      return [];
    }
    const ranges = reduced.expectedFiles.map((file) => locate(file));
    if (ranges.some((entry) => entry === undefined)) {
      return [];
    }
    const contested = this.contested(
      input,
      reduced,
      {
        resourceType: "symbol",
        evidence: "symbol_overlap",
        declared: reduced.expectedSymbols,
      },
      occupancy,
    );
    const placed = new Map<string, DeferredResourceLocation[]>();
    reduced.expectedFiles.forEach((file, index) => {
      for (const range of ranges[index] ?? []) {
        const key = planResourceKey("symbol", range.name);
        placed.set(key, [
          ...(placed.get(key) ?? []),
          { file, startLine: range.startLine, endLine: range.endLine },
        ]);
      }
    });
    // A parseable file is not enough: the index must actually locate every
    // withheld symbol. Otherwise a patch could edit that symbol while the
    // enforcement pass sees no matching range and incorrectly lets it through.
    return contested.every((resource) =>
      placed.has(planResourceKey("symbol", resource.resourceId)),
    )
      ? contested.map((resource) => ({
          ...resource,
          // Carried on the decision so the agent is told which lines, and so
          // an audit trail records what the withholding actually meant. The
          // enforcement pass re-derives the same ranges from the same base
          // index rather than trusting a value that travelled over the wire.
          locations: placed.get(
            planResourceKey("symbol", resource.resourceId),
          ) as DeferredResourceLocation[],
        }))
      : [];
  }

  /**
   * Resources of one kind that executing work is holding, with who holds each.
   *
   * Both halves of arbitration are asked, because they catch different things:
   * conflict scoring sees two plans naming the same resource, ownership sees a
   * live lease on one. A resource either of them names is contested.
   */
  private contested(
    input: PlanAdmissionInput,
    candidate: AgentPlan,
    kind: {
      resourceType: ResourceType;
      evidence: ConflictEvidence["kind"];
      declared: readonly string[];
    },
    occupancy: FileOccupancy,
  ): DeferredResource[] {
    const taskId = candidate.taskId;
    const others = input.active.filter((entry) => entry.taskId !== taskId);
    const contested = new Map<
      string,
      { heldBy: Set<TaskId>; reasons: Set<string> }
    >();
    const note = (id: string, holder: TaskId, reason: string): void => {
      const entry = contested.get(id) ?? {
        heldBy: new Set<TaskId>(),
        reasons: new Set<string>(),
      };
      entry.heldBy.add(holder);
      entry.reasons.add(reason);
      contested.set(id, entry);
    };

    for (const entry of others) {
      const assessment = this.conflicts.assess(
        candidate,
        entry.plan,
        occupancy,
      );
      if (assessment === undefined || !structuralConflict(assessment)) {
        continue;
      }
      for (const item of assessment.evidence) {
        if (item.advisory === true || item.kind !== kind.evidence) {
          continue;
        }
        for (const id of item.resources) {
          if (holdsSymbolItself(kind.resourceType, entry.plan, id) === false) {
            // The overlap is real, but it is an overlap with enrichment. A
            // plan that names a file is given every symbol in that file, so
            // scoring finds this symbol on both sides whenever the holder
            // named the file at all — which says the holder wants the file,
            // not that it wants this function. Withholding on it hands the
            // candidate a file with every function in it withheld, and the
            // file-level contest below already covers what the holder
            // genuinely reserved.
            continue;
          }
          note(
            id,
            entry.taskId,
            `also declared by executing task ${entry.taskId}`,
          );
        }
      }
    }
    for (const lease of this.seededOwnership(
      input,
      others,
      occupancy,
    ).blockersFor(candidate, {
      fileClaims: this.fileClaims(candidate, occupancy),
    })) {
      if (lease.resourceType !== kind.resourceType) {
        continue;
      }
      note(
        lease.resourceId,
        lease.taskId,
        `owned by ${lease.taskId} in ${lease.mode} mode until ${lease.expiresAt}`,
      );
    }

    // A grounded plan's conflicts surface under the *real* names verification
    // mapped its declarations to, but the only thing withholding can act on
    // is a declaration — that is what reduction removes and enforcement holds
    // the agent to. So a contested referent is charged to the declaration
    // that carries it: withhold `src/checkout.js` because the `total.js` it
    // really names is held by someone else.
    const carriers = new Map<string, string>();
    const grounding = candidate.grounding;
    if (grounding !== undefined) {
      if (kind.resourceType === "file") {
        for (const entry of grounding.fileReferents) {
          carriers.set(entry.resolved.toLowerCase(), entry.declared);
        }
      }
      if (kind.resourceType === "symbol") {
        for (const entry of grounding.symbolReferents) {
          carriers.set(entry.resolved.toLowerCase(), entry.declared);
        }
      }
    }

    const declared = new Set(kind.declared);
    const withholdable = new Map<
      string,
      { heldBy: Set<TaskId>; reasons: Set<string> }
    >();
    for (const [id, entry] of contested) {
      const carrier = declared.has(id)
        ? id
        : carriers.get(id.toLowerCase());
      if (carrier === undefined || !declared.has(carrier)) {
        continue;
      }
      const merged = withholdable.get(carrier) ?? {
        heldBy: new Set<TaskId>(),
        reasons: new Set<string>(),
      };
      for (const holder of entry.heldBy) {
        merged.heldBy.add(holder);
      }
      for (const reason of entry.reasons) {
        merged.reasons.add(
          carrier === id ? reason : `via grounded referent ${id}: ${reason}`,
        );
      }
      withholdable.set(carrier, merged);
    }
    return [...withholdable]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, entry]): DeferredResource => ({
        resourceType: kind.resourceType,
        resourceId: id,
        heldBy: [...entry.heldBy].sort(),
        reason: [...entry.reasons].sort().join("; "),
      }));
  }

  /**
   * An ownership view holding every executing plan's leases.
   *
   * Seeding failures are swallowed for the same reason as in {@link decide}:
   * one executing plan colliding with another is someone else's problem, and
   * the candidate is arbitrated against whatever seeded successfully.
   */
  private seededOwnership(
    input: PlanAdmissionInput,
    others: readonly ActivePlan[],
    occupancy: FileOccupancy,
  ): OwnershipService {
    const ownership = this.ownershipFor();
    for (const entry of others) {
      try {
        ownership.acquire(entry.plan, entry.agentId, input.baseVersion, {
          approvedResources: approvedSchemaResources(entry.plan),
          // Every plan is leased at the same granularity, not just the
          // candidate. A holder narrowed only on the way in is a holder whose
          // lease still says the whole file, and the second half of this
          // change would have nothing to read.
          fileClaims: this.fileClaims(entry.plan, occupancy),
        });
      } catch {
        // See decide(): a collision between two already-admitted plans is not
        // this candidate's to resolve.
      }
    }
    return ownership;
  }

  private decide(
    plan: AgentPlan,
    input: PlanAdmissionInput,
    occupancy: FileOccupancy = () => undefined,
    /**
     * Whether `plan` is what is left of a plan after every contested resource
     * was withdrawn from it, rather than a plan as an agent submitted it.
     *
     * The objective-relatedness gates below exist because an unverifiable
     * plan's declarations say nothing trustworthy, leaving the objective as
     * the only signal about what it will really touch. A reduction supplies
     * something better: `contested` drops every path that any executing plan
     * declares or holds a lease on, so what remains is disjoint by
     * construction — a direct answer where the objective was a proxy for one.
     *
     * Left applying, those gates make the reduction pointless. They are
     * whole-plan judgements and narrowing the file set cannot clear them, so
     * the reduced plan is refused for the same reason the whole plan was and
     * partial admission can never succeed against related work.
     */
    reduced = false,
  ): PlanAdmission {
    const taskId = plan.taskId;
    const retryAfterMs = input.retryAfterMs ?? DEFAULT_PLAN_RETRY_MS;
    const shared = {
      taskId,
      planRevision: input.planRevision ?? 1,
      baseRevision: input.baseRevision,
      decidedAt: new Date().toISOString(),
    };
    const others = input.active.filter((entry) => entry.taskId !== taskId);

    // Verification is a precondition for concurrency with *related* work, not
    // for running. A plan that names nothing real says nothing usable about
    // what it will touch, so conflict scoring against it is theatre: the
    // scores would compare fiction with fact and find no overlap. But an
    // unverifiable plan is not automatically a lying one — a task creating a
    // new module declares only files that do not exist yet, and its write
    // scope is still enforced against exactly those declarations. What
    // separates the two cases is the objective: two tasks talking about the
    // same thing plausibly want the same code however differently they
    // misname it, so those are serialised; work about something else entirely
    // keeps its concurrency. The same rule holds from the other side, against
    // executing plans that could not be verified.
    if (
      !reduced &&
      others.length > 0 &&
      planGroundingConfidence(plan) === "ungrounded"
    ) {
      const related = others.filter((entry) =>
        relatedObjectives(plan, entry.plan),
      );
      if (related.length > 0) {
        return {
          ...shared,
          status: "sequenced",
          ownershipGrants: [],
          constraints: [
            "Plan again naming files and symbols that exist in the repository, " +
              "or resubmit once the executing tasks integrate",
          ],
          blockedBy: related.map((entry) => entry.taskId).sort(),
          conflicts: [],
          explanation:
            "Plan verification found none of this plan's declared files or " +
            "symbols in the repository, and executing work shares its stated " +
            `objective, so the two cannot be proven disjoint: ${(plan.grounding?.notes ?? []).join("; ")}`,
          retryAfterMs,
        };
      }
    }
    const ungroundedActive = reduced
      ? []
      : others.filter(
          (entry) =>
            planGroundingConfidence(entry.plan) === "ungrounded" &&
            relatedObjectives(plan, entry.plan),
        );
    if (ungroundedActive.length > 0) {
      return {
        ...shared,
        status: "sequenced",
        ownershipGrants: [],
        constraints: [
          "Start from canonical state after the unverifiable tasks integrate",
        ],
        blockedBy: ungroundedActive.map((entry) => entry.taskId).sort(),
        conflicts: [],
        explanation:
          "Executing work about the same objective could not be verified " +
          "against the repository, so its real footprint is unknown: " +
          ungroundedActive.map((entry) => entry.taskId).join(", "),
        retryAfterMs,
      };
    }

    const assessments = others
      .map((entry) =>
        this.conflicts.assess(
          plan,
          entry.plan,
          occupancy,
          input.intentAssessment,
        ),
      )
      .filter((entry): entry is ConflictAssessment => entry !== undefined);
    const structural = assessments.filter(structuralConflict);
    const blocking = structural.filter(
      (assessment) => assessment.disposition === "block",
    );

    // A "block" disposition is the detector saying the two plans are not
    // separable by ordering. Sequencing would just move the collision later,
    // so the plan is refused outright and the holder must plan again.
    //
    // Unless it has already been told that, twice, and come back with the same
    // collision. Then "plan again" has been shown not to work for this task,
    // and repeating it is a loop with no exit: the run that exposed this
    // stranded four tasks replanning identically until the budget expired.
    // Waiting is the answer that terminates, because the blocker does
    // eventually integrate, and it concedes nothing — the task is still
    // refused permission to run now.
    if (blocking.length > 0) {
      const exhausted =
        (input.blockedAttempts ?? 0) >= BLOCKED_ATTEMPTS_BEFORE_SEQUENCING;
      const blockedBy = blocking.map((assessment) =>
        otherTask(assessment, taskId),
      );
      const collisions = blocking
        .map(
          (assessment) =>
            `${otherTask(assessment, taskId)} (${assessment.score})`,
        )
        .join(", ");
      if (exhausted) {
        return {
          ...shared,
          status: "sequenced",
          ownershipGrants: [],
          constraints: [
            "Start from canonical state after the blocking tasks integrate",
            "Do not narrow this plan further; it is queued behind the " +
              "conflicting work rather than competing with it",
          ],
          blockedBy,
          conflicts: blocking,
          explanation:
            "Plan collides beyond the sequencing threshold with " +
            `${collisions}, and narrowing has already been asked for ` +
            `${String(input.blockedAttempts ?? 0)} times without separating ` +
            "them. Sequenced behind the holder instead of replanned again.",
          retryAfterMs,
        };
      }
      return {
        ...shared,
        status: "blocked",
        ownershipGrants: [],
        constraints: [
          "Plan again with a narrower scope, or wait for the conflicting task to settle",
        ],
        blockedBy,
        conflicts: blocking,
        explanation:
          "Plan collides with executing work beyond the sequencing threshold: " +
          collisions,
        retryAfterMs,
      };
    }

    if (structural.length > 0) {
      return {
        ...shared,
        status: "sequenced",
        ownershipGrants: [],
        constraints: [
          "Start from canonical state after the blocking tasks integrate",
        ],
        blockedBy: structural.map((assessment) => otherTask(assessment, taskId)),
        conflicts: structural,
        explanation:
          "Sequenced behind executing work on the same resources: " +
          structural
            .map(
              (assessment) =>
                `${otherTask(assessment, taskId)} — ${assessment.explanation}`,
            )
            .join("; "),
        retryAfterMs,
      };
    }

    // Ownership is the second, finer check. Conflict scoring answers "should
    // these run together"; ownership answers "may this exact resource be held
    // in this mode", which is where shared files and intent-mode resources
    // stop being conflicts at all.
    //
    // Two admitted plans can only collide while seeding if one was admitted
    // while the other was invisible — a lapsed lease, say. Conflict assessment
    // above already covered the candidate against both, so seeding continues
    // rather than failing the admission on someone else's state.
    const ownership = this.seededOwnership(input, others, occupancy);

    let grants: ResourceLease[];
    try {
      grants = ownership.acquire(plan, input.agentId, input.baseVersion, {
        approvedResources: approvedSchemaResources(plan),
        fileClaims: this.fileClaims(plan, occupancy),
      });
    } catch (error) {
      if (error instanceof OwnershipConflictError) {
        const blocker = error.blockingLease.taskId;
        return {
          ...shared,
          status: "sequenced",
          ownershipGrants: [],
          constraints: [
            "Start from canonical state after the blocking tasks integrate",
          ],
          blockedBy: [blocker],
          conflicts: assessments,
          explanation: `Ownership is held by ${blocker}: ${error.message}`,
          retryAfterMs,
        };
      }
      if (error instanceof OwnershipApprovalRequiredError) {
        return {
          ...shared,
          status: "blocked",
          ownershipGrants: [],
          constraints: ["Human approval is required before this plan can run"],
          blockedBy: [],
          conflicts: assessments,
          explanation: error.message,
          retryAfterMs,
        };
      }
      throw error;
    }

    // Advisory evidence never blocks, but the holder is told about it: an
    // intent collision the detector cannot prove is exactly the case a human
    // reading the audit trail wants to see.
    const advisory = assessments.filter(
      (assessment) => !structuralConflict(assessment),
    );
    const constraints = advisory.map(
      (assessment) =>
        `Advisory overlap with ${otherTask(assessment, taskId)}: ` +
        assessment.explanation,
    );
    return {
      ...shared,
      status: advisory.length > 0 ? "approved_with_constraints" : "approved",
      ownershipGrants: grants,
      constraints,
      blockedBy: [],
      conflicts: advisory,
      explanation:
        advisory.length > 0
          ? "Approved; advisory overlap with executing work was recorded"
          : "Approved: no structural conflict with executing work, ownership granted",
    };
  }
}
