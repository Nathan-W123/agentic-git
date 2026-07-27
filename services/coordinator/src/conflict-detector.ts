import type {
  AgentPlan,
  ConflictAssessment,
  ConflictDisposition,
} from "@coord/shared-types";

export interface ConflictThresholds {
  concurrentMaximum: number;
  notifyMaximum: number;
  sequenceMaximum: number;
}

export interface ConflictDetectorOptions {
  fileOverlapWeight: number;
  thresholds: ConflictThresholds;
}

export const DEFAULT_CONFLICT_OPTIONS: ConflictDetectorOptions = {
  fileOverlapWeight: 20,
  thresholds: {
    concurrentMaximum: 20,
    notifyMaximum: 45,
    sequenceMaximum: 70,
  },
};

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

export function overlappingFiles(
  first: AgentPlan,
  second: AgentPlan,
): string[] {
  const secondFiles = new Set(second.expectedFiles);
  return first.expectedFiles.filter((file) => secondFiles.has(file)).sort();
}

export class ConflictDetector {
  public constructor(
    private readonly options: ConflictDetectorOptions =
      DEFAULT_CONFLICT_OPTIONS,
  ) {}

  public assess(
    first: AgentPlan,
    second: AgentPlan,
  ): ConflictAssessment | undefined {
    const files = overlappingFiles(first, second);
    if (files.length === 0) {
      return undefined;
    }

    const score = Math.min(100, files.length * this.options.fileOverlapWeight);
    const disposition = dispositionFor(score, this.options.thresholds);
    return {
      taskIds: [first.taskId, second.taskId],
      score,
      disposition,
      evidence: [
        {
          kind: "file_overlap",
          resources: files,
          taskIds: [first.taskId, second.taskId],
          score,
        },
      ],
      explanation:
        `${files.length} planned file overlap(s): ${files.join(", ")}. ` +
        "Exclusive file ownership may require sequencing independently of the score.",
    };
  }

  public assessAll(plans: readonly AgentPlan[]): ConflictAssessment[] {
    const assessments: ConflictAssessment[] = [];
    for (let left = 0; left < plans.length; left += 1) {
      for (let right = left + 1; right < plans.length; right += 1) {
        const first = plans[left];
        const second = plans[right];
        if (first === undefined || second === undefined) {
          continue;
        }
        const assessment = this.assess(first, second);
        if (assessment !== undefined) {
          assessments.push(assessment);
        }
      }
    }
    return assessments;
  }
}

