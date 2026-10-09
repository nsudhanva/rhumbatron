import { createClerkClient } from "@clerk/backend";
import {
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalView,
  apiData,
  EvidenceRecord,
  PromotionOutcome,
  ReleaseView,
  VerificationPlan,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { errorBody, fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Candidates and their Evidence (AGENTS.md sections 15.5, 16.1, 33, 34). Creating a Candidate is
 * an RPC to the integration Worker, which owns the one Candidate-creation implementation (also
 * used when a Work Graph completes) and starts CandidateVerificationWorkflow. Reads come from D1. Approval and promotion (section 36) are
 * RPCs to the integration Worker after this Worker authenticated the user and checked membership.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Internal RPC on the integration Worker (service binding `INTEGRATION`, ADR 0013). */
type IntegrationRpc = {
  createCandidate(input: { changeId: string; changeSetIds?: string[] | undefined }): Promise<
    | { status: "created" | "existing"; candidateId: string; changeSetIds: string[] }
    | {
        status: "refused";
        reason:
          | "not_found"
          | "change_closed"
          | "archived"
          | "no_source"
          | "not_proposed"
          | "candidate_limit";
        detail: string;
      }
  >;
  promoteCandidate(input: { candidateId: string; actorUserId: string }): Promise<unknown>;
  decideApproval(input: {
    candidateId: string;
    approverUserId: string;
    decision: "granted" | "rejected";
    reason: string | null;
  }): Promise<unknown>;
};
const integration = (env: Env) => env.INTEGRATION as unknown as IntegrationRpc;

const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });
const CandidateIdParam = z.object({ candidateId: z.string().regex(/^cand_[a-z0-9]+$/) });
/** Optional create body: compose only these proposed ChangeSets (competing designs, P9-08). */
const CandidateSubset = z.object({
  changeSetIds: z
    .array(z.string().regex(/^cs_[A-Za-z0-9_-]+$/))
    .min(1)
    .max(20)
    .optional(),
});

const Gap = z.object({ checkId: z.string(), reason: z.string() });

/** Candidate read model for the UI. `gate` is null until verification finishes. */
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
      gaps: z.array(Gap),
      humanApprovalRequired: z.boolean().optional(),
      p95Ms: z.number().optional(),
    })
    .nullable(),
  /** The plan gates this Candidate on a human decision (section 36 rule 4). */
  approvalRequired: z.boolean(),
  approval: ApprovalView.nullable(),
  baseTree: z.string().nullable(),
  promotedGeneration: z.number().int().nullable(),
  /** Release of the promoted generation (ADR 0018). Null until promotion starts one. */
  release: ReleaseView.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type CandidateView = z.infer<typeof CandidateView>;

type CandidateRow = {
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
  approval_id: string | null;
  approval_decision: "granted" | "rejected" | null;
  approval_user_id: string | null;
  approval_tree: string | null;
  approval_policy: string | null;
  approval_reason: string | null;
  approval_at: string | null;
  /** Approver email from the users table, when known (see recordApproverEmail). */
  approval_email: string | null;
  release_id: string | null;
  release_status: ReleaseView["status"] | null;
  release_generation: number | null;
  release_commit: string | null;
  release_build: string | null;
  release_version: string | null;
  release_started: string | null;
  release_finished: string | null;
  release_reason: string | null;
  release_evidence_id: string | null;
  release_evidence_key: string | null;
  release_url: string | null;
  release_worker: string | null;
};

const CANDIDATE_COLUMNS = `c.id, c.change_id, ch.project_id, c.status, c.status_reason, c.base_generation,
  c.artifact_ref, c.composed_commit, c.composed_tree, c.change_set_ids_json, c.plan_json,
  c.score_json, c.base_tree, c.promoted_generation, c.created_at, c.updated_at,
  a.id AS approval_id, a.decision AS approval_decision, a.approver_user_id AS approval_user_id,
  a.candidate_tree AS approval_tree, a.policy_version AS approval_policy,
  a.reason AS approval_reason, a.created_at AS approval_at, u.email AS approval_email,
  r.id AS release_id, r.status AS release_status, r.generation AS release_generation,
  r.commit_sha AS release_commit, r.build_uuid AS release_build, r.version_id AS release_version,
  r.started_at AS release_started, r.finished_at AS release_finished,
  r.failure_reason AS release_reason, r.evidence_id AS release_evidence_id,
  r.evidence_r2_key AS release_evidence_key, rt.url AS release_url, rt.worker_name AS release_worker`;

// A Candidate promotes once, so it has at most one release (one per generation, migration 0015).
const CANDIDATE_FROM = `candidates c JOIN changes ch ON ch.id = c.change_id
  LEFT JOIN approvals a ON a.candidate_id = c.id
  LEFT JOIN users u ON u.id = a.approver_user_id
  LEFT JOIN releases r ON r.candidate_id = c.id
  LEFT JOIN release_targets rt ON rt.project_id = r.project_id`;

function releaseOf(row: CandidateRow): ReleaseView | null {
  if (!row.release_id || !row.release_status || row.release_generation === null) return null;
  return {
    id: row.release_id,
    projectId: row.project_id,
    changeId: row.change_id,
    candidateId: row.id,
    generation: row.release_generation,
    commit: row.release_commit ?? "",
    status: row.release_status,
    buildUuid: row.release_build,
    versionId: row.release_version,
    url: row.release_url,
    workerName: row.release_worker,
    startedAt: row.release_started ?? row.updated_at,
    finishedAt: row.release_finished,
    failureReason: row.release_reason,
    evidenceId: row.release_evidence_id,
    evidenceR2Key: row.release_evidence_key,
  };
}

function toView(row: CandidateRow): CandidateView {
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
    // The plan already includes the policy's gated risk tiers (packages/evidence plan.ts).
    approvalRequired: plan?.humanApprovalRequired ?? false,
    approval:
      row.approval_id && row.approval_decision && row.approval_user_id && row.approval_at
        ? {
            id: row.approval_id,
            candidateId: row.id,
            changeId: row.change_id,
            decision: row.approval_decision,
            approverUserId: row.approval_user_id,
            approverName: row.approval_email,
            candidateTree: row.approval_tree ?? "",
            policyVersion: row.approval_policy ?? "",
            reason: row.approval_reason,
            createdAt: row.approval_at,
          }
        : null,
    baseTree: row.base_tree,
    promotedGeneration: row.promoted_generation,
    release: releaseOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Stores the approver's primary email once, so approvals show a person and not an internal ID.
 * Runs only on the approval path, only while the users row has no email: at most one Clerk
 * Backend API call per approver. Display data only; never used for authorization.
 */
async function recordApproverEmail(env: Env, userId: string, authSubject: string) {
  try {
    const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
      .bind(userId)
      .first<{ email: string | null }>();
    if (!row || row.email) return;
    const user = await createClerkClient({ secretKey: env.CLERK_SECRET_KEY }).users.getUser(
      authSubject,
    );
    const email = user.primaryEmailAddress?.emailAddress;
    if (!email) return;
    await env.DB.prepare(
      "UPDATE users SET email = ?, updated_at = ? WHERE id = ? AND email IS NULL",
    )
      .bind(email.slice(0, 254), new Date().toISOString(), userId)
      .run();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "approval.approver_email_failed",
        message: String(error).slice(0, 200),
      }),
    );
  }
}

async function loadCandidate(env: Env, candidateId: string) {
  return env.DB.prepare(`SELECT ${CANDIDATE_COLUMNS} FROM ${CANDIDATE_FROM} WHERE c.id = ?`)
    .bind(candidateId)
    .first<CandidateRow>();
}

export const candidates = new Hono<AppEnv>()
  /**
   * Creates the Candidate of a Change from all its `proposed` ChangeSets (or the `changeSetIds`
   * subset) on the Change base and starts verification, through the integration Worker. A Change
   * with no ChangeSets yields the canonical baseline Candidate. The Candidate ID is the composition
   * key (section 60, includes the composition rules version), so a retry returns the same one.
   */
  .post(
    "/v1/changes/:changeId/candidates",
    requireAuth,
    validate("param", ChangeIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      const change = await c.env.DB.prepare("SELECT project_id FROM changes WHERE id = ?")
        .bind(changeId)
        .first<{ project_id: string }>();
      if (!change || !(await canAccessProject(c.env.DB, userId, change.project_id))) {
        return fail(c, 404, "not_found", "Change not found");
      }
      // No body (or no `changeSetIds`) composes every proposed ChangeSet.
      const subset = CandidateSubset.safeParse(await c.req.json().catch(() => ({})));
      if (!subset.success) return fail(c, 400, "invalid_request", "Invalid json");
      const outcome = await integration(c.env).createCandidate({
        changeId,
        changeSetIds: subset.data.changeSetIds,
      });
      if (outcome.status === "refused") {
        return outcome.reason === "not_found"
          ? fail(c, 404, "not_found", outcome.detail)
          : fail(c, 409, "conflict", outcome.detail);
      }
      const row = await loadCandidate(c.env, outcome.candidateId);
      if (!row) throw new Error("Candidate was not readable after creation");
      return respond(c, apiData(CandidateView), { data: toView(row) }, 202);
    },
  )

  .get(
    "/v1/changes/:changeId/candidates",
    requireAuth,
    validate("param", ChangeIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      const change = await c.env.DB.prepare("SELECT project_id FROM changes WHERE id = ?")
        .bind(changeId)
        .first<{ project_id: string }>();
      if (!change || !(await canAccessProject(c.env.DB, userId, change.project_id))) {
        return fail(c, 404, "not_found", "Change not found");
      }
      const rows = await c.env.DB.prepare(
        `SELECT ${CANDIDATE_COLUMNS} FROM ${CANDIDATE_FROM}
       WHERE c.change_id = ? ORDER BY c.created_at`,
      )
        .bind(changeId)
        .all<CandidateRow>();
      return respond(c, apiData(z.array(CandidateView)), {
        data: (rows.results ?? []).map(toView),
      });
    },
  )

  .get(
    "/v1/candidates/:candidateId",
    requireAuth,
    validate("param", CandidateIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { candidateId } = c.req.valid("param");
      const row = await loadCandidate(c.env, candidateId);
      if (!row || !(await canAccessProject(c.env.DB, userId, row.project_id))) {
        return fail(c, 404, "not_found", "Candidate not found");
      }
      return respond(c, apiData(CandidateView), { data: toView(row) });
    },
  )

  /**
   * P11-02: one human decision on a gated Candidate of this Change (section 16.1). The approver is
   * the authenticated member; the body cannot name anyone else. The first decision is final.
   */
  .post(
    "/v1/changes/:changeId/approve",
    requireAuth,
    validate("param", ChangeIdParam),
    validate("json", ApprovalRequest),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      const body = c.req.valid("json");
      const candidate = await loadCandidate(c.env, body.candidateId);
      if (
        !candidate ||
        candidate.change_id !== changeId ||
        !(await canAccessProject(c.env.DB, userId, candidate.project_id))
      ) {
        return fail(c, 404, "not_found", "Candidate not found");
      }
      const outcome = ApprovalOutcome.parse(
        await integration(c.env).decideApproval({
          candidateId: body.candidateId,
          approverUserId: userId,
          decision: body.decision === "approve" ? "granted" : "rejected",
          reason: body.reason || null,
        }),
      );
      if (outcome.status === "recorded" && !outcome.repeated) {
        c.executionCtx.waitUntil(recordApproverEmail(c.env, userId, c.get("authSubject")));
      }
      if (outcome.status === "refused") {
        const message = {
          not_verified: "Only a verified Candidate can be approved or rejected",
          not_required: "This Candidate does not require a human approval",
          already_decided: "A decision is already recorded for this Candidate",
        }[outcome.reason];
        return c.json(errorBody("conflict", message, outcome), 409);
      }
      return respond(c, apiData(ApprovalOutcome), { data: outcome });
    },
  )

  /**
   * P11-03/P11-04: promote a verified Candidate (section 36). The integration Worker re-checks
   * every precondition from authoritative rows; ProjectRootDO runs the compare-and-swap. Safe to
   * retry: a repeat returns `alreadyPromoted`. Stale and blocked outcomes return 409 with details.
   */
  .post(
    "/v1/candidates/:candidateId/promote",
    requireAuth,
    validate("param", CandidateIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { candidateId } = c.req.valid("param");
      const candidate = await loadCandidate(c.env, candidateId);
      if (!candidate || !(await canAccessProject(c.env.DB, userId, candidate.project_id))) {
        return fail(c, 404, "not_found", "Candidate not found");
      }
      const outcome = PromotionOutcome.parse(
        await integration(c.env).promoteCandidate({ candidateId, actorUserId: userId }),
      );
      if (outcome.status === "stale") {
        return c.json(errorBody("conflict", outcome.reason, outcome), 409);
      }
      if (outcome.status === "blocked") {
        const message = outcome.blocks.map((b) => b.detail).join(" ");
        return c.json(errorBody("conflict", message, outcome), 409);
      }
      return respond(c, apiData(PromotionOutcome), { data: outcome });
    },
  )

  // Evidence records (section 34.3). Full output stays in R2 under `r2Key`.
  .get(
    "/v1/candidates/:candidateId/evidence",
    requireAuth,
    validate("param", CandidateIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { candidateId } = c.req.valid("param");
      const candidate = await loadCandidate(c.env, candidateId);
      if (!candidate || !(await canAccessProject(c.env.DB, userId, candidate.project_id))) {
        return fail(c, 404, "not_found", "Candidate not found");
      }
      const rows = await c.env.DB.prepare(
        // Release smoke Evidence (`release-*`, ADR 0018) is not a verification check: the
        // releases endpoint and the Candidate's `release` field show it.
        `SELECT * FROM evidence_index WHERE candidate_id = ?
           AND COALESCE(check_id, '') NOT LIKE 'release-%' ORDER BY created_at`,
      )
        .bind(candidateId)
        .all<{
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
        }>();
      const data: EvidenceRecord[] = (rows.results ?? []).map((r) => ({
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
        ...(r.metrics_json
          ? { metrics: JSON.parse(r.metrics_json) as Record<string, number> }
          : {}),
        sourceRefs: JSON.parse(r.source_refs_json) as string[],
      }));
      return respond(c, apiData(z.array(EvidenceRecord)), { data });
    },
  )

  /**
   * Stored output of one check (stdout and stderr), as plain text. Read-only; the R2 key is
   * derived from the authoritative Evidence row, never from the request.
   */
  .get(
    "/v1/candidates/:candidateId/evidence/:checkId/output",
    requireAuth,
    validate("param", CandidateIdParam.extend({ checkId: z.string().regex(/^[a-z0-9-]{1,64}$/) })),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { candidateId, checkId } = c.req.valid("param");
      const candidate = await loadCandidate(c.env, candidateId);
      if (!candidate || !(await canAccessProject(c.env.DB, userId, candidate.project_id))) {
        return fail(c, 404, "not_found", "Candidate not found");
      }
      const row = await c.env.DB.prepare(
        "SELECT r2_key FROM evidence_index WHERE candidate_id = ? AND check_id = ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(candidateId, checkId)
        .first<{ r2_key: string | null }>();
      if (!row?.r2_key) return fail(c, 404, "not_found", "No stored output for this check");
      const prefix = row.r2_key.slice(0, row.r2_key.lastIndexOf("/"));
      const object = await c.env.EVIDENCE.get(`${prefix}/stdout.txt`);
      if (!object) return fail(c, 404, "not_found", "No stored output for this check");
      // Check output is capped when stored; the cap here guards the response size.
      const text = (await object.text()).slice(0, 200_000);
      return c.text(text, 200, { "cache-control": "private, max-age=300" });
    },
  );
