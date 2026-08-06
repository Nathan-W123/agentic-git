import {
  arbitrationFiles,
  arbitrationSymbols,
  completeAgentPlan,
  uniqueStrings,
  type AgentPlan,
  type CompleteAgentPlan,
  type ConflictAssessment,
  type ConflictDisposition,
  type ConflictEvidence,
} from "@coord/shared-types";

import { rangesIntersect, type LineRange } from "./ranges.js";

export interface ConflictThresholds {
  concurrentMaximum: number;
  notifyMaximum: number;
  sequenceMaximum: number;
}

export interface ConflictDetectorOptions {
  fileOverlapWeight: number;
  symbolOverlapWeight?: number;
  dependencyImpactWeight?: number;
  apiOverlapWeight?: number;
  schemaOverlapWeight?: number;
  configurationOverlapWeight?: number;
  testOverlapWeight?: number;
  semanticConflictWeight?: number;
  thresholds: ConflictThresholds;
}

interface ResolvedConflictOptions {
  fileOverlapWeight: number;
  symbolOverlapWeight: number;
  dependencyImpactWeight: number;
  apiOverlapWeight: number;
  schemaOverlapWeight: number;
  configurationOverlapWeight: number;
  testOverlapWeight: number;
  semanticConflictWeight: number;
  thresholds: ConflictThresholds;
}

export const DEFAULT_CONFLICT_OPTIONS: ResolvedConflictOptions = {
  fileOverlapWeight: 20,
  symbolOverlapWeight: 35,
  dependencyImpactWeight: 25,
  apiOverlapWeight: 30,
  schemaOverlapWeight: 40,
  configurationOverlapWeight: 15,
  testOverlapWeight: 10,
  semanticConflictWeight: 30,
  thresholds: {
    concurrentMaximum: 20,
    notifyMaximum: 45,
    sequenceMaximum: 70,
  },
};

const OPPOSING_ACTIONS: ReadonlyArray<readonly [string, string]> = [
  ["add", "remove"],
  ["allow", "deny"],
  ["create", "delete"],
  ["enable", "disable"],
  ["expand", "restrict"],
  ["introduce", "eliminate"],
  ["migrate", "rollback"],
  ["publish", "hide"],
  ["require", "optional"],
  ["start", "stop"],
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function dispositionFor(
  score: number,
  thresholds: ConflictThresholds,
): ConflictDisposition {
  if (score <= thresholds.concurrentMaximum) {
    return "concurrent";
  }
  if (score <= thresholds.notifyMaximum) {
    return "concurrent_with_notification";
  }
  if (score <= thresholds.sequenceMaximum) {
    return "sequence";
  }
  return "block";
}

function overlap(first: readonly string[], second: readonly string[]): string[] {
  const right = new Set(second.map((value) => value.toLowerCase()));
  return uniqueStrings(
    first.filter((value) => right.has(value.toLowerCase())),
  );
}

/**
 * What a plan occupies inside one file, or `undefined` when it occupies all of
 * it — which is what naming a file means, and what every plan meant before
 * anything finer could be expressed.
 *
 * Supplying one of these is what lets arbitration ask whether two plans want
 * the same *code* rather than merely the same path. It is deliberately a
 * function of the plan rather than a field on it: the answer comes from the
 * repository index at the base revision, which is not something a plan carries
 * and not something the detector can reach on its own.
 */
export type FileOccupancy = (
  plan: AgentPlan,
  file: string,
) => readonly LineRange[] | undefined;

/**
 * Files two plans collide on, judged on each plan's grounded footprint.
 *
 * Arbitrating on the declared lists alone means arbitrating on whatever the
 * agents happened to type: two plans that misname the same real file in
 * different ways would pass as disjoint. The grounded view adds the real files
 * verification mapped those misnames to, so the collision is judged where it
 * would actually happen.
 *
 * Sharing a path is where the question starts, not where it ends. Given an
 * {@link FileOccupancy} that can say which lines each side reaches, a path
 * both plans name but neither meets the other inside is not a collision, and
 * is dropped. Without one — or where either side reaches the whole file, which
 * is the ordinary case of a plan that simply declared the path — the shared
 * path is the answer, exactly as before.
 */
export function overlappingFiles(
  first: AgentPlan,
  second: AgentPlan,
  occupancy?: FileOccupancy,
): string[] {
  const shared = overlap(arbitrationFiles(first), arbitrationFiles(second));
  if (occupancy === undefined) {
    return shared;
  }
  return shared.filter((file) => {
    const left = occupancy(first, file);
    const right = occupancy(second, file);
    return (
      left === undefined ||
      right === undefined ||
      rangesIntersect(left, right)
    );
  });
}

function resourceNames(plan: CompleteAgentPlan): Set<string> {
  return new Set(
    [
      ...plan.expectedFiles.flatMap((value) => [value, `file:${value}`]),
      ...plan.expectedSymbols.flatMap((value) => [value, `symbol:${value}`]),
      ...plan.expectedApis.flatMap((value) => [value, `api:${value}`]),
      ...plan.expectedSchemas.flatMap((value) => [value, `schema:${value}`]),
      ...plan.expectedServices.flatMap((value) => [value, `service:${value}`]),
    ].map((value) => value.toLowerCase()),
  );
}

function dependencyImpact(first: AgentPlan, second: AgentPlan): string[] {
  const left = completeAgentPlan(first);
  const right = completeAgentPlan(second);
  const leftResources = resourceNames(left);
  const rightResources = resourceNames(right);
  const impacts = [
    ...left.dependencies.filter((value) =>
      rightResources.has(value.toLowerCase()),
    ),
    ...right.dependencies.filter((value) =>
      leftResources.has(value.toLowerCase()),
    ),
    ...overlap(left.expectedServices, right.expectedServices).map(
      (value) => `service:${value}`,
    ),
  ];
  return uniqueStrings(impacts);
}

function consumes(consumer: AgentPlan, producer: AgentPlan): boolean {
  const resources = resourceNames(completeAgentPlan(producer));
  return completeAgentPlan(consumer).dependencies.some((dependency) =>
    resources.has(dependency.toLowerCase()),
  );
}

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]*/gu)
      ?.filter((word) => !STOP_WORDS.has(word)) ?? [],
  );
}

/**
 * Whether two plans are even about the same thing, judged from their stated
 * intent alone.
 *
 * This is the only signal available against a plan whose resource claims
 * verification could not connect to the repository: its declarations are
 * fiction, but its objective is still an honest sentence about what it wants.
 * Two tasks that both talk about checkout charges are plausibly after the
 * same code however differently they misname it; a task about raising a value
 * and a task about adding a new module share nothing worth serialising over.
 */
export function relatedObjectives(first: AgentPlan, second: AgentPlan): boolean {
  const left = words(first.intent ?? first.objective);
  const right = words(second.intent ?? second.objective);
  return [...left].some((word) => word.length > 2 && right.has(word));
}

export interface IntentResult {
  probability: number;
  resources: string[];
  explanation: string;
  /**
   * The verdict is that the two plans are *unrelated*, not that they collide.
   *
   * Recorded as `intent_independent` evidence rather than scored: it says a
   * pair is safe to run concurrently, which is what a pair with no evidence
   * does anyway. The value is in the audit trail being able to tell "the
   * coordinator resolved both intents and found nothing joining the modules"
   * apart from "the coordinator had no opinion", which are the same silence
   * today and very different facts.
   */
  independent?: boolean;
}

/**
 * A verdict on whether two plans' stated intents are after the same code.
 *
 * Injected rather than imported, for the same reason {@link FileOccupancy} is:
 * answering it well needs the repository index at the base revision, which is
 * not something a plan carries and not something this module can reach. When
 * one is supplied it replaces {@link analyzeIntent} outright rather than
 * adding to it — two intent signals scoring the same pair would double-count
 * one fact.
 *
 * Whatever is supplied, its evidence is recorded as advisory and is excluded
 * from the score the disposition is computed from. That is not a property of
 * the implementation passed in; it is enforced here, in {@link
 * ConflictDetector.assess}.
 */
export type IntentConflictAssessment = (
  first: AgentPlan,
  second: AgentPlan,
) => IntentResult | undefined;

function analyzeIntent(first: AgentPlan, second: AgentPlan): IntentResult | undefined {
  const left = words(first.intent ?? first.objective);
  const right = words(second.intent ?? second.objective);
  const targets = [...left]
    .filter((word) => right.has(word))
    .filter(
      (word) =>
        !OPPOSING_ACTIONS.some(
          ([positive, negative]) => word === positive || word === negative,
        ),
    )
    .sort();
  if (targets.length === 0) {
    return undefined;
  }

  for (const [positive, negative] of OPPOSING_ACTIONS) {
    const opposed =
      (left.has(positive) && right.has(negative)) ||
      (left.has(negative) && right.has(positive));
    if (opposed) {
      return {
        probability: 0.9,
        resources: targets,
        explanation:
          `Objectives use opposing actions (${positive}/${negative}) ` +
          `for shared intent terms: ${targets.join(", ")}`,
      };
    }
  }
  return undefined;
}

function evidence(
  kind: ConflictEvidence["kind"],
  resources: string[],
  taskIds: [string, string],
  score: number,
  options: Pick<ConflictEvidence, "advisory" | "explanation"> = {},
): ConflictEvidence | undefined {
  if (resources.length === 0 || score <= 0) {
    return undefined;
  }
  return {
    kind,
    resources,
    taskIds,
    score,
    ...(options.advisory === undefined
      ? {}
      : { advisory: options.advisory }),
    ...(options.explanation === undefined
      ? {}
      : { explanation: options.explanation }),
  };
}

export class ConflictDetector {
  private readonly options: ResolvedConflictOptions;

  public constructor(options: ConflictDetectorOptions = DEFAULT_CONFLICT_OPTIONS) {
    this.options = {
      fileOverlapWeight: options.fileOverlapWeight,
      symbolOverlapWeight:
        options.symbolOverlapWeight ?? DEFAULT_CONFLICT_OPTIONS.symbolOverlapWeight,
      dependencyImpactWeight:
        options.dependencyImpactWeight ??
        DEFAULT_CONFLICT_OPTIONS.dependencyImpactWeight,
      apiOverlapWeight:
        options.apiOverlapWeight ?? DEFAULT_CONFLICT_OPTIONS.apiOverlapWeight,
      schemaOverlapWeight:
        options.schemaOverlapWeight ??
        DEFAULT_CONFLICT_OPTIONS.schemaOverlapWeight,
      configurationOverlapWeight:
        options.configurationOverlapWeight ??
        DEFAULT_CONFLICT_OPTIONS.configurationOverlapWeight,
      testOverlapWeight:
        options.testOverlapWeight ?? DEFAULT_CONFLICT_OPTIONS.testOverlapWeight,
      semanticConflictWeight:
        options.semanticConflictWeight ??
        DEFAULT_CONFLICT_OPTIONS.semanticConflictWeight,
      thresholds: { ...options.thresholds },
    };
    for (const [name, value] of Object.entries(this.options)) {
      if (name === "thresholds") {
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a finite non-negative number`);
      }
    }
    const { concurrentMaximum, notifyMaximum, sequenceMaximum } =
      this.options.thresholds;
    if (
      ![concurrentMaximum, notifyMaximum, sequenceMaximum].every(
        (value) => Number.isFinite(value) && value >= 0,
      ) ||
      concurrentMaximum > notifyMaximum ||
      notifyMaximum > sequenceMaximum
    ) {
      throw new RangeError(
        "Conflict thresholds must be finite, non-negative, and ordered",
      );
    }
  }

  public assess(
    first: AgentPlan,
    second: AgentPlan,
    occupancy?: FileOccupancy,
    intentAssessment?: IntentConflictAssessment,
  ): ConflictAssessment | undefined {
    const taskIds: [string, string] = [first.taskId, second.taskId];
    const left = completeAgentPlan(first);
    const right = completeAgentPlan(second);
    // A grounded assessor replaces the hardcoded-antonym reading rather than
    // supplementing it: both answer the same question, and scoring both would
    // count one fact twice.
    const intent =
      intentAssessment === undefined
        ? analyzeIntent(left, right)
        : intentAssessment(left, right);
    const fileOverlap = overlappingFiles(left, right, occupancy);
    const symbolOverlap = overlap(
      arbitrationSymbols(left),
      arbitrationSymbols(right),
    );
    // Overlap found only through grounding is called out in the evidence: a
    // reader of the audit trail should see that the agents never declared
    // these resources — verification did, from what the declarations misnamed.
    const groundedNote = (declared: string[], found: string[]) => {
      const owned = new Set(declared.map((entry) => entry.toLowerCase()));
      return found.some((entry) => !owned.has(entry.toLowerCase()))
        ? {
            explanation:
              "includes resources plan verification grounded unverifiable declarations to",
          }
        : {};
    };
    const items = [
      evidence(
        "file_overlap",
        fileOverlap,
        taskIds,
        fileOverlap.length * this.options.fileOverlapWeight,
        groundedNote(
          overlap(left.expectedFiles, right.expectedFiles),
          fileOverlap,
        ),
      ),
      evidence(
        "symbol_overlap",
        symbolOverlap,
        taskIds,
        symbolOverlap.length * this.options.symbolOverlapWeight,
        groundedNote(
          overlap(left.expectedSymbols, right.expectedSymbols),
          symbolOverlap,
        ),
      ),
      evidence(
        "dependency_impact",
        dependencyImpact(left, right),
        taskIds,
        dependencyImpact(left, right).length *
          this.options.dependencyImpactWeight,
      ),
      evidence(
        "api_overlap",
        overlap(left.expectedApis, right.expectedApis),
        taskIds,
        overlap(left.expectedApis, right.expectedApis).length *
          this.options.apiOverlapWeight,
      ),
      evidence(
        "schema_overlap",
        overlap(left.expectedSchemas, right.expectedSchemas),
        taskIds,
        overlap(left.expectedSchemas, right.expectedSchemas).length *
          this.options.schemaOverlapWeight,
      ),
      evidence(
        "configuration_overlap",
        overlap(left.expectedConfigKeys, right.expectedConfigKeys),
        taskIds,
        overlap(left.expectedConfigKeys, right.expectedConfigKeys).length *
          this.options.configurationOverlapWeight,
      ),
      evidence(
        "test_overlap",
        overlap(left.expectedTests, right.expectedTests),
        taskIds,
        overlap(left.expectedTests, right.expectedTests).length *
          this.options.testOverlapWeight,
      ),
      intent?.independent === true
        ? undefined
        : evidence(
            "intent_conflict",
            intent?.resources ?? [],
            taskIds,
            Math.round(
              (intent?.probability ?? 0) * this.options.semanticConflictWeight,
            ),
            {
              advisory: true,
              ...(intent === undefined
                ? {}
                : { explanation: intent.explanation }),
            },
          ),
      // A finding of independence, recorded at score zero.
      //
      // It cannot be routed through `evidence()`, which drops anything scoring
      // zero — correctly, because a conflict worth nothing is not a conflict.
      // This is the opposite claim and its whole point is to weigh nothing:
      // scoring it would be inventing a reason to schedule, and the guarantee
      // that matters is that it never changes what a pair was going to be
      // allowed to do.
      intent?.independent === true && intent.resources.length > 0
        ? {
            kind: "intent_independent" as const,
            resources: intent.resources,
            taskIds,
            score: 0,
            advisory: true,
            explanation: intent.explanation,
          }
        : undefined,
    ].filter((entry): entry is ConflictEvidence => entry !== undefined);

    // A finding of independence never brings an assessment into existence.
    //
    // Assessments are persisted as conflict records and traced as
    // `conflict_detected`. A pair the coordinator has just decided is
    // *unrelated* must not appear there — it would swamp the table with
    // non-conflicts and corrupt `conflictsDetected`, which benchmarks read. So
    // the "no evidence, no record" invariant is unchanged: independence rides
    // along in an assessment that exists for other reasons, and is silent
    // otherwise. Silence is already the coordinator granting free concurrency.
    const substantive = items.filter(
      (entry) => entry.kind !== "intent_independent",
    );
    if (substantive.length === 0) {
      return undefined;
    }
    const score = Math.min(
      100,
      items.reduce((total, entry) => total + entry.score, 0),
    );
    // Advisory evidence is reported but never priced into the disposition.
    //
    // It used to be summed into the same total the thresholds are read
    // against, and the guard meant to hold it back only caught pairs with *no*
    // structural evidence at all. So on a pair with some structural evidence,
    // advisory contribution could carry the total across a threshold and turn
    // a concurrent pair into a sequenced one. Measured on the team-queue runs,
    // the intent signal fired four times and was wrong four times, so what
    // that bought was lost parallelism on noise. Scheduling now reads only
    // evidence that has been shown to predict a collision.
    const schedulingScore = Math.min(
      100,
      items.reduce(
        (total, entry) => total + (entry.advisory === true ? 0 : entry.score),
        0,
      ),
    );
    const structural = items.some((entry) => entry.advisory !== true);
    const advisory = items.some(
      (entry) => entry.advisory === true && entry.score > 0,
    );
    const independent = items.some(
      (entry) => entry.kind === "intent_independent",
    );
    let disposition = dispositionFor(schedulingScore, this.options.thresholds);
    // Advisory evidence can still ask a human to look, which costs nothing and
    // keeps the signal visible while its accuracy is being established. It can
    // never take the next step to sequence or block.
    //
    // A grounded finding of independence withholds even that: there is no
    // point asking someone to check a pair the coordinator has just resolved
    // to two unconnected modules. Note the asymmetry — this only ever *removes*
    // a notification on a pair already scheduled as `concurrent`. It cannot
    // touch a disposition structural evidence produced, because clearing a
    // pair that real overlap flagged is exactly the kind of override the
    // advisory split exists to prevent, and a 95%-accurate reading measured on
    // 43 pairs is nowhere near strong enough to be given that power.
    if (advisory && !independent && disposition === "concurrent") {
      disposition = "concurrent_with_notification";
    }
    const explanation = items
      .map(
        (entry) =>
          `${entry.kind}: ${entry.resources.join(", ")} (+${entry.score})`,
      )
      .join("; ");
    return {
      taskIds,
      score,
      disposition,
      evidence: items,
      explanation:
        `${explanation}. ` +
        (structural
          ? `Structural evidence controls scheduling (${schedulingScore} of ${score}).`
          : "Intent-only evidence is advisory and never blocks automatically."),
    };
  }

  public assessAll(
    plans: readonly AgentPlan[],
    occupancy?: FileOccupancy,
    intentAssessment?: IntentConflictAssessment,
  ): ConflictAssessment[] {
    const assessments: ConflictAssessment[] = [];
    for (let left = 0; left < plans.length; left += 1) {
      for (let right = left + 1; right < plans.length; right += 1) {
        const first = plans[left];
        const second = plans[right];
        if (first === undefined || second === undefined) {
          continue;
        }
        const assessment = this.assess(
          first,
          second,
          occupancy,
          intentAssessment,
        );
        if (assessment !== undefined) {
          assessments.push(assessment);
        }
      }
    }
    return assessments;
  }

  public conflictsForScheduling(
    first: AgentPlan,
    second: AgentPlan,
    occupancy?: FileOccupancy,
  ): boolean {
    const assessment = this.assess(first, second, occupancy);
    if (assessment === undefined) {
      return false;
    }
    return assessment.evidence.some(
      (entry) => entry.advisory !== true && entry.score > 0,
    );
  }

  /**
   * Returns producer-before-consumer order when dependency evidence has one
   * unambiguous direction. Symmetric conflicts retain submission order.
   */
  public preferredOrder(
    first: AgentPlan,
    second: AgentPlan,
  ): [string, string] | undefined {
    const firstConsumesSecond = consumes(first, second);
    const secondConsumesFirst = consumes(second, first);
    if (firstConsumesSecond === secondConsumesFirst) {
      return undefined;
    }
    return firstConsumesSecond
      ? [second.taskId, first.taskId]
      : [first.taskId, second.taskId];
  }
}
