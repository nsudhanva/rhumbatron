import { z } from "zod";
import { CanonicalGeneration, Id, RiskTier, Timestamp } from "./common.ts";

/**
 * Candidates, verification, and promotion (AGENTS.md sections 15.5, 34, 36, 53).
 * Only executable Evidence can advance the Canonical State; these schemas carry it.
 */

/**
 * The Intent an agent declared when it published a ChangeSet, as stored in `changesets.intent_json`
 * (section 26.1). `changeSet` is present when the Workspace committed source changes.
 */
export const ChangeSetIntent = z.object({
  summary: z.string(),
  semanticResources: z.array(z.string()).default([]),
  expectedFiles: z.array(z.string()).default([]),
  expectedContractChanges: z.array(z.string()).default([]),
  expectedDataChanges: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  acceptanceEvidence: z.array(z.string()).default([]),
  changeSet: z
    .object({
      fork: z.string(),
      commit: z.string(),
      baseCommit: z.string(),
      diffStat: z.string(),
      files: z.array(z.string()),
    })
    .optional(),
});
export type ChangeSetIntent = z.infer<typeof ChangeSetIntent>;

export const VerificationCheckKind = z.enum([
  "build",
  "unit",
  "integration",
  "contract",
  "browser",
  "security",
  "performance",
  "migration",
  "protected-invariant",
  "static-analysis",
  "smoke",
]);
export type VerificationCheckKind = z.infer<typeof VerificationCheckKind>;

/** Machine-checkable expected result, so a later evaluator does not need a model to read it. */
export const CheckExpectation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exit_code"), code: z.number().int() }),
  z.object({
    kind: z.literal("metric_below"),
    metric: z.string().min(1),
    threshold: z.number(),
  }),
  z.object({ kind: z.literal("procedure"), description: z.string().min(1) }),
]);
export type CheckExpectation = z.infer<typeof CheckExpectation>;

/** One check in a Verification Plan (section 34.2). Exactly one of `command` or `procedure`. */
export const VerificationCheck = z
  .object({
    checkId: Id,
    kind: VerificationCheckKind,
    reason: z.string().min(1),
    command: z.string().min(1).optional(),
    procedure: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive(),
    required: z.boolean(),
    expected: CheckExpectation,
    /** Evidence files the check writes under `evidence/<project>/<change>/<candidate>/<check>/`. */
    evidenceOutput: z.array(z.string().min(1)).min(1),
  })
  .refine((c) => (c.command === undefined) !== (c.procedure === undefined), {
    message: "a check needs exactly one of command or procedure",
  });
export type VerificationCheck = z.infer<typeof VerificationCheck>;

export const VerificationPlan = z.object({
  candidateId: Id,
  checks: z.array(VerificationCheck),
  requiredCheckIds: z.array(Id),
  humanApprovalRequired: z.boolean(),
  policyVersion: z.string().min(1),
});
export type VerificationPlan = z.infer<typeof VerificationPlan>;

export const EvidenceStatus = z.enum(["pass", "fail", "error", "skipped"]);
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;

/** Section 34.4.1: only `checked_supported` can satisfy a required check. */
export const EvidenceCoverage = z.enum(["not_checked", "checked_no_signal", "checked_supported"]);
export type EvidenceCoverage = z.infer<typeof EvidenceCoverage>;

/** Section 34.3. */
export const EvidenceRecord = z.object({
  evidenceId: Id,
  candidateId: Id,
  checkId: Id,
  kind: z.string().min(1),
  status: EvidenceStatus,
  coverage: EvidenceCoverage,
  startedAt: Timestamp,
  completedAt: Timestamp,
  summary: z.string(),
  contentHash: z.string().min(1),
  r2Key: z.string().optional(),
  metrics: z.record(z.string(), z.number()).optional(),
  sourceRefs: z.array(z.string()),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

export const CandidateStatus = z.enum([
  "composing",
  "composed",
  "verifying",
  "verified",
  "rejected",
  "stale",
  "promoted",
]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

/** Section 15.5. */
export const Candidate = z.object({
  id: Id,
  changeId: Id,
  baseGeneration: CanonicalGeneration,
  changeSetIds: z.array(Id).min(1),
  artifactRef: z.string(),
  composedTree: z.string(),
  verificationPlan: VerificationPlan,
  evidenceRefs: z.array(Id),
  status: CandidateStatus,
});
export type Candidate = z.infer<typeof Candidate>;

/** Check names a Project policy can require per risk tier (section 53). */
export const PolicyCheck = z.enum(["build", "targeted", "contract", "security", "browser"]);
export type PolicyCheck = z.infer<typeof PolicyCheck>;

/** Machine-readable, versioned Project policy (section 53). */
export const ProjectPolicy = z.object({
  version: z.string().min(1),
  maxCostUsdPerChange: z.number().nonnegative(),
  maxActiveAgents: z.number().int().positive(),
  maxActiveSandboxes: z.number().int().nonnegative(),
  maxCandidates: z.number().int().positive(),
  humanGateRiskTiers: z.array(RiskTier),
  protectedResources: z.array(z.string()),
  networkPolicy: z.string(),
  autoPromoteRiskTiers: z.array(RiskTier),
  requiredChecksByRisk: z.partialRecord(RiskTier, z.array(PolicyCheck)),
});
export type ProjectPolicy = z.infer<typeof ProjectPolicy>;

/** Section 36. ProjectRootDO verifies every precondition before one atomic transition. */
export const PromotionRequest = z.object({
  projectId: Id,
  changeId: Id,
  candidateId: Id,
  expectedCanonicalGeneration: CanonicalGeneration,
  expectedCanonicalTree: z.string(),
  candidateTree: z.string(),
  requiredEvidenceIds: z.array(Id),
  policyVersion: z.string().min(1),
});
export type PromotionRequest = z.infer<typeof PromotionRequest>;
