import { assertProjectPolicy } from "@coord/shared-types";

import { ApprovalPolicy } from "./approval-service.js";

/**
 * Builds the approval policy a project's stored declarative policy asks for.
 *
 * No stored policy means the built-in defaults — a project that never
 * configured anything behaves exactly as before the policy engine existed.
 * A stored policy that fails validation throws rather than silently falling
 * back: an operator who tightened review must never have the tightening
 * ignored because a record was corrupted. Write-time validation at the API
 * makes that path unreachable in normal operation.
 */
export function approvalPolicyForProject(
  policy: Record<string, unknown> | undefined,
): ApprovalPolicy {
  if (policy === undefined) {
    return new ApprovalPolicy();
  }
  assertProjectPolicy(policy);
  const approvals = policy.approvals ?? {};
  return new ApprovalPolicy({
    ...(approvals.enabled === undefined
      ? {}
      : { enabled: approvals.enabled }),
    ...(approvals.requireSchemaReview === undefined
      ? {}
      : { requireSchemaReview: approvals.requireSchemaReview }),
    ...(approvals.requireChangesetReview === undefined
      ? {}
      : { requireChangesetReview: approvals.requireChangesetReview }),
    ...(approvals.requireRemotePlanReview === undefined
      ? {}
      : { requireRemotePlanReview: approvals.requireRemotePlanReview }),
    ...(approvals.requireRollbackReview === undefined
      ? {}
      : { requireRollbackReview: approvals.requireRollbackReview }),
    ...(approvals.riskLevels === undefined
      ? {}
      : { riskLevels: approvals.riskLevels }),
    ...(approvals.protectedPaths === undefined
      ? {}
      : { pathPatterns: approvals.protectedPaths }),
    ...(approvals.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: approvals.approvalTimeoutMs }),
  });
}
