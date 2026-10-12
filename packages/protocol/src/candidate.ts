import { z } from "zod";
import { CanonicalGeneration, Id, RiskTier, Timestamp } from "./common.ts";

/**
 * Candidates, verification, and promotion.
 * Only executable Evidence can advance the Canonical State; these schemas carry it.
 */

/**
 * The Intent an agent declared when it published a ChangeSet, as stored in `changesets.intent_json`.
 * `changeSet` is present when the Workspace committed source changes.
 */
export const ChangeSetIntent = z.object({
  summary: z.string(),
  semanticResources: z.array(z.string()).default([]),
  expectedFiles: z.array(z.string()).default([]),
  expectedContractChanges: z.array(z.string()).default([]),
  expectedDataChanges: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  acceptanceEvidence: z.array(z.string()).default([]),
  /**
   * A person, not an agent, wrote this ChangeSet (an edit on the Code page). Absent for
   * agent ChangeSets. Display only: authority comes from the API's membership check.
   */
  actor: z
    .object({ kind: z.literal("user"), id: z.string(), name: z.string().nullable() })
    .optional(),
  changeSet: z
    .object({
      fork: z.string(),
      commit: z.string(),
      baseCommit: z.string(),
      diffStat: z.string(),
      /** Every file that differs from `baseCommit`, inherited dependency changes included. */
      files: z.array(z.string()),
      /**
       * Stacked workspace lineage: ChangeSets of the Task's dependencies (transitive, in merge
       * order) merged onto `baseCommit` before the agent's first edit. This commit descends from
       * theirs, so composition merges them as shared history, not as concurrent edits.
       */
      stackedOn: z.array(z.string()).default([]),
      /** HEAD after the stacked merges: the agent's starting point. Absent when nothing stacked. */
      startCommit: z.string().optional(),
      /** Files this Task itself changed (diff from `startCommit`). Absent when nothing stacked. */
      ownFiles: z.array(z.string()).optional(),
      /**
       * R2 key of the stored `git diff`, from `startCommit` when stacked, else from
       * `baseCommit`. Absent on ChangeSets published before patches were stored.
       */
      patchRef: z.string().optional(),
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
  /** The composed patch meets every acceptance criterion of the Change, with cited quotes. */
  "acceptance",
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

/** One check in a Verification Plan. Exactly one of `command` or `procedure`. */
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

/** Only `checked_supported` can satisfy a required check. */
export const EvidenceCoverage = z.enum(["not_checked", "checked_no_signal", "checked_supported"]);
export type EvidenceCoverage = z.infer<typeof EvidenceCoverage>;

/** Machine-verifiable result of one verification check. */
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

/** Result of the acceptance check for one criterion (`candidates.acceptance_json`). */
export const AcceptanceCitation = z.object({ path: z.string(), quote: z.string() });
export type AcceptanceCitation = z.infer<typeof AcceptanceCitation>;

export const AcceptanceStatus = z.enum(["met", "not_met", "unclear"]);
export type AcceptanceStatus = z.infer<typeof AcceptanceStatus>;

/**
 * One criterion as the acceptance check judged it. `met` always carries at least one citation that
 * application code found in the Candidate patch or composed files; a `met` claim without a valid
 * citation is stored as `unclear`.
 */
export const AcceptanceResult = z.object({
  criterion: z.string(),
  status: AcceptanceStatus,
  citations: z.array(AcceptanceCitation),
});
export type AcceptanceResult = z.infer<typeof AcceptanceResult>;

/** Sibling selection outcome for one Candidate (`candidates.selection_json`, ADR 0026). */
export const CandidateSelectionView = z.object({
  winnerCandidateId: z.string(),
  reason: z.string(),
});
export type CandidateSelectionView = z.infer<typeof CandidateSelectionView>;

/** Closed verdict vocabulary of the Integration Judge. */
export const JudgeVerdict = z.enum([
  "prefer_candidate",
  "reject_candidate",
  "needs_more_evidence",
  "escalate_to_human",
]);
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/** A possible integrated future of the Project, composed from ChangeSets. */
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

/** Check names a Project policy can require per risk tier. */
export const PolicyCheck = z.enum(["build", "targeted", "contract", "security", "browser"]);
export type PolicyCheck = z.infer<typeof PolicyCheck>;

/** Machine-readable, versioned Project policy. */
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

/**
 * Promotion request for one verified Candidate. Built by the integration Worker from authoritative rows, never from the browser.
 * `expectedCanonicalTree` is absent only for Candidates verified before the base tree was recorded,
 * which turns the optional tree check off for them.
 */
export const PromotionRequest = z.object({
  projectId: Id,
  changeId: Id,
  candidateId: Id,
  expectedCanonicalGeneration: CanonicalGeneration,
  expectedCanonicalTree: z.string().min(1).optional(),
  candidateTree: z.string().min(1),
  requiredEvidenceIds: z.array(Id).min(1),
  policyVersion: z.string().min(1),
});
export type PromotionRequest = z.infer<typeof PromotionRequest>;

/** Why a Candidate cannot be promoted now. `detail` is for humans. */
export const PromotionBlockView = z.object({
  kind: z.enum([
    "not_verified",
    "stale",
    "missing_plan",
    "evidence_gap",
    "approval_pending",
    "approval_rejected",
    "policy_mismatch",
    "artifact_missing",
    /** A sibling Candidate on the same base is still verifying; selection has not run yet. */
    "selection_pending",
  ]),
  detail: z.string(),
});
export type PromotionBlockView = z.infer<typeof PromotionBlockView>;

/** Result of a promotion request (`POST /v1/candidates/:candidateId/promote`). */
export const PromotionOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("promoted"),
    candidateId: Id,
    fromGeneration: CanonicalGeneration,
    generation: CanonicalGeneration,
    /** A retry of a promotion that already succeeded (idempotency key: Candidate + base). */
    alreadyPromoted: z.boolean(),
    treeSha: z.string(),
    /** The canonical repo's `main` points at the composed commit and its file index exists. */
    sourceSynced: z.boolean(),
    sourceCommit: z.string().nullable(),
  }),
  z.object({
    status: z.literal("stale"),
    candidateId: Id,
    baseGeneration: CanonicalGeneration,
    canonicalGeneration: CanonicalGeneration,
    reason: z.string(),
  }),
  z.object({
    status: z.literal("blocked"),
    candidateId: Id,
    blocks: z.array(PromotionBlockView).min(1),
  }),
]);
export type PromotionOutcome = z.infer<typeof PromotionOutcome>;

/** `POST /v1/changes/:changeId/approve` request. */
export const ApprovalRequest = z.object({
  candidateId: z.string().regex(/^cand_[a-z0-9]+$/),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().max(1000).optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** One recorded human decision on a Candidate (migration 0008). */
export const ApprovalView = z.object({
  id: Id,
  candidateId: Id,
  changeId: Id,
  decision: z.enum(["granted", "rejected"]),
  approverUserId: Id,
  /** Display name of the approver (their email) when the users table has one. Read side only. */
  approverName: z.string().nullable().optional(),
  candidateTree: z.string(),
  policyVersion: z.string(),
  reason: z.string().nullable(),
  createdAt: Timestamp,
});
export type ApprovalView = z.infer<typeof ApprovalView>;

export const ApprovalOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("recorded"), approval: ApprovalView, repeated: z.boolean() }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum(["not_verified", "not_required", "already_decided"]),
    approval: ApprovalView.nullable(),
  }),
]);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcome>;
