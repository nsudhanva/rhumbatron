import { ApprovalView, apiData, EvidenceRecord, VerificationPlan } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Project-wide verification read model (AGENTS.md sections 34, 38): the most recent Candidates of
 * one Project with their Evidence rows, so the Verification page can apply the same gate rules as
 * the Candidate pages. Reads come from D1 only, over indexed columns, with fixed caps:
 *
 * - the newest `LIMIT` Candidates by creation time, plus the older Candidates of the same Changes
 *   (at most `maxCandidates - 1` extra rows), so per-Change names (Baseline, Candidate A, B) stay
 *   stable;
 * - their Evidence rows, capped at `EVIDENCE_LIMIT`.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const LIMIT = 50;
const EVIDENCE_LIMIT = 1000;

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });

/** Same shape as the Candidate read model in candidates.ts. */
const CandidateView = z.object({
  id: z.string(),
  changeId: z.string(),
  projectId: z.string(),
  status: z.string(),
  statusReason: z.string().nullable(),
  baseGeneration: z.number().int(),
  artifactRef: z.string().nullable(),
  composedCommit: z.string().nullable(),
  composedTree: z.string().nullable(),
  changeSetIds: z.array(z.string()),
  plan: VerificationPlan.nullable(),
  gate: z
    .object({
      promotable: z.boolean(),
      gaps: z.array(z.object({ checkId: z.string(), reason: z.string() })),
      humanApprovalRequired: z.boolean().optional(),
      p95Ms: z.number().optional(),
    })
    .nullable(),
  approvalRequired: z.boolean(),
  approval: ApprovalView.nullable(),
  baseTree: z.string().nullable(),
  promotedGeneration: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type CandidateView = z.infer<typeof CandidateView>;

const ChangeRef = z.object({
  id: z.string(),
  goal: z.string(),
  status: z.string(),
  riskTier: z.string().nullable(),
});

const ProjectVerification = z.object({
  /** Newest first. */
  candidates: z.array(CandidateView),
  evidence: z.array(EvidenceRecord),
  changes: z.array(ChangeRef),
  limit: z.number().int(),
  /** True when the Evidence cap cut rows; the page then shows those checks as gaps, not passes. */
  evidenceTruncated: z.boolean(),
});

type Row = {
  id: string;
  change_id: string;
  project_id: string;
  status: string;
  status_reason: string | null;
  base_generation: number;
  artifact_ref: string | null;
  composed_commit: string | null;
  composed_tree: string | null;
  change_set_ids_json: string;
  plan_json: string | null;
  score_json: string | null;
  base_tree: string | null;
  promoted_generation: number | null;
  created_at: string;
  updated_at: string;
  change_goal: string;
  change_status: string;
  change_risk_tier: string | null;
  approval_id: string | null;
  approval_decision: "granted" | "rejected" | null;
  approval_user_id: string | null;
  approval_tree: string | null;
  approval_policy: string | null;
  approval_reason: string | null;
  approval_at: string | null;
};

type EvidenceRow = {
  id: string;
  candidate_id: string;
  check_id: string | null;
  kind: string;
  status: EvidenceRecord["status"];
  coverage: EvidenceRecord["coverage"];
  summary: string;
  r2_key: string | null;
  content_hash: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  metrics_json: string | null;
  source_refs_json: string;
};

function toView(row: Row): CandidateView {
  const plan = row.plan_json ? (JSON.parse(row.plan_json) as VerificationPlan) : null;
  return {
    id: row.id,
    changeId: row.change_id,
    projectId: row.project_id,
    status: row.status,
    statusReason: row.status_reason,
    baseGeneration: row.base_generation,
    artifactRef: row.artifact_ref,
    composedCommit: row.composed_commit,
    composedTree: row.composed_tree,
    changeSetIds: JSON.parse(row.change_set_ids_json) as string[],
    plan,
    gate: row.score_json ? (JSON.parse(row.score_json) as CandidateView["gate"]) : null,
    approvalRequired: plan?.humanApprovalRequired ?? false,
    approval:
      row.approval_id && row.approval_decision && row.approval_user_id && row.approval_at
        ? {
            id: row.approval_id,
            candidateId: row.id,
            changeId: row.change_id,
            decision: row.approval_decision,
            approverUserId: row.approval_user_id,
            candidateTree: row.approval_tree ?? "",
            policyVersion: row.approval_policy ?? "",
            reason: row.approval_reason,
            createdAt: row.approval_at,
          }
        : null,
    baseTree: row.base_tree,
    promotedGeneration: row.promoted_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvidence(r: EvidenceRow): EvidenceRecord {
  return {
    evidenceId: r.id,
    candidateId: r.candidate_id,
    checkId: r.check_id ?? r.kind,
    kind: r.kind,
    status: r.status,
    coverage: r.coverage,
    startedAt: r.started_at ?? r.created_at,
    completedAt: r.completed_at ?? r.created_at,
    summary: r.summary,
    contentHash: r.content_hash,
    ...(r.r2_key ? { r2Key: r.r2_key } : {}),
    ...(r.metrics_json ? { metrics: JSON.parse(r.metrics_json) as Record<string, number> } : {}),
    sourceRefs: JSON.parse(r.source_refs_json) as string[],
  };
}

export const verification = new Hono<AppEnv>().get(
  "/v1/projects/:projectId/verification",
  requireAuth,
  validate("param", ProjectIdParam),
  async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { projectId } = c.req.valid("param");
    if (!(await canAccessProject(c.env.DB, userId, projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }

    // idx_changes_project_id narrows to this Project; idx_candidates_change_id joins.
    const rows = await c.env.DB.prepare(
      `WITH recent AS (
         SELECT c.change_id FROM candidates c JOIN changes ch ON ch.id = c.change_id
         WHERE ch.project_id = ? ORDER BY c.created_at DESC LIMIT ${LIMIT}
       )
       SELECT c.id, c.change_id, ch.project_id, c.status, c.status_reason, c.base_generation,
         c.artifact_ref, c.composed_commit, c.composed_tree, c.change_set_ids_json, c.plan_json,
         c.score_json, c.base_tree, c.promoted_generation, c.created_at, c.updated_at,
         ch.goal AS change_goal, ch.status AS change_status, ch.risk_tier AS change_risk_tier,
         a.id AS approval_id, a.decision AS approval_decision, a.approver_user_id AS approval_user_id,
         a.candidate_tree AS approval_tree, a.policy_version AS approval_policy,
         a.reason AS approval_reason, a.created_at AS approval_at
       FROM candidates c JOIN changes ch ON ch.id = c.change_id
         LEFT JOIN approvals a ON a.candidate_id = c.id
       WHERE ch.project_id = ? AND c.change_id IN (SELECT DISTINCT change_id FROM recent)
       ORDER BY c.created_at DESC`,
    )
      .bind(projectId, projectId)
      .all<Row>();
    const candidateRows = rows.results ?? [];

    let evidence: EvidenceRecord[] = [];
    let evidenceTruncated = false;
    if (candidateRows.length > 0) {
      const ids = candidateRows.map((r) => r.id);
      // At most LIMIT + 2 IDs, well under the D1 bound-parameter limit (idx_evidence_index_candidate_id).
      const result = await c.env.DB.prepare(
        `SELECT id, candidate_id, check_id, kind, status, coverage, summary, r2_key, content_hash,
           started_at, completed_at, created_at, metrics_json, source_refs_json
         FROM evidence_index WHERE candidate_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY created_at DESC LIMIT ${EVIDENCE_LIMIT + 1}`,
      )
        .bind(...ids)
        .all<EvidenceRow>();
      const evidenceRows = result.results ?? [];
      evidenceTruncated = evidenceRows.length > EVIDENCE_LIMIT;
      evidence = evidenceRows.slice(0, EVIDENCE_LIMIT).map(toEvidence);
    }

    const changes = new Map<string, z.infer<typeof ChangeRef>>();
    for (const r of candidateRows) {
      if (!changes.has(r.change_id)) {
        changes.set(r.change_id, {
          id: r.change_id,
          goal: r.change_goal,
          status: r.change_status,
          riskTier: r.change_risk_tier,
        });
      }
    }

    return respond(c, apiData(ProjectVerification), {
      data: {
        candidates: candidateRows.map(toView),
        evidence,
        changes: [...changes.values()],
        limit: LIMIT,
        evidenceTruncated,
      },
    });
  },
);
