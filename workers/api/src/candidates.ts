import { createClerkClient } from "@clerk/backend";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalView,
  apiData,
  EvidenceRecord,
  PromotionOutcome,
  VerificationPlan,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { errorBody, fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Candidates and their Evidence (AGENTS.md sections 15.5, 16.1, 33, 34). Creating a Candidate is
 * a command: the API records it and queues `candidate.verify`; the integration Worker runs
 * CandidateVerificationWorkflow. Reads come from D1 only. Approval and promotion (section 36) are
 * RPCs to the integration Worker after this Worker authenticated the user and checked membership.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Internal RPC on the integration Worker (service binding `INTEGRATION`, ADR 0013). */
type IntegrationRpc = {
  promoteCandidate(input: { candidateId: string; actorUserId: string }): Promise<unknown>;
  decideApproval(input: {
    candidateId: string;
    approverUserId: string;
    decision: "granted" | "rejected";
    reason: string | null;
  }): Promise<unknown>;
};
const integration = (env: Env) => env.INTEGRATION as unknown as IntegrationRpc;

/** Policy `maxCandidates` (section 53). */
const MAX_CANDIDATES = 3;

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
};

const CANDIDATE_COLUMNS = `c.id, c.change_id, ch.project_id, c.status, c.status_reason, c.base_generation,
  c.artifact_ref, c.composed_commit, c.composed_tree, c.change_set_ids_json, c.plan_json,
  c.score_json, c.base_tree, c.promoted_generation, c.created_at, c.updated_at,
  a.id AS approval_id, a.decision AS approval_decision, a.approver_user_id AS approval_user_id,
  a.candidate_tree AS approval_tree, a.policy_version AS approval_policy,
  a.reason AS approval_reason, a.created_at AS approval_at, u.email AS approval_email`;

const CANDIDATE_FROM = `candidates c JOIN changes ch ON ch.id = c.change_id
  LEFT JOIN approvals a ON a.candidate_id = c.id
  LEFT JOIN users u ON u.id = a.approver_user_id`;

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
   * Creates the Candidate of a Change from all its `proposed` ChangeSets on the Change base and
   * queues verification. A Change with no ChangeSets yields the canonical baseline Candidate. The
   * Candidate ID is the composition key (section 60), so a retry returns the same Candidate.
   */
  .post(
    "/v1/changes/:changeId/candidates",
    requireAuth,
    validate("param", ChangeIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      const change = await c.env.DB.prepare(
        "SELECT project_id, status, base_generation FROM changes WHERE id = ?",
      )
        .bind(changeId)
        .first<{ project_id: string; status: string; base_generation: number }>();
      if (!change || !(await canAccessProject(c.env.DB, userId, change.project_id))) {
        return fail(c, 404, "not_found", "Change not found");
      }
      if (["cancelled", "failed", "completed"].includes(change.status)) {
        return fail(c, 409, "conflict", `Change is ${change.status}`);
      }
      const root = c.env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
      const canonical = await root.get(root.idFromName(change.project_id)).getCanonical();
      if (!canonical || canonical.artifactRef === "unassigned") {
        return fail(c, 409, "conflict", "Project has no source to compose on");
      }

      const sets = await c.env.DB.prepare(
        "SELECT id FROM changesets WHERE change_id = ? AND status = 'proposed' ORDER BY id",
      )
        .bind(changeId)
        .all<{ id: string }>();
      const proposed = (sets.results ?? []).map((r) => r.id);
      // No body (or no `changeSetIds`) composes every proposed ChangeSet, as before.
      const subset = CandidateSubset.safeParse(await c.req.json().catch(() => ({})));
      if (!subset.success) return fail(c, 400, "invalid_request", "Invalid json");
      const wanted = subset.data.changeSetIds;
      if (wanted?.some((id) => !proposed.includes(id))) {
        return fail(c, 409, "conflict", "changeSetIds must be proposed ChangeSets of this Change");
      }
      const changeSetIds = wanted ? proposed.filter((id) => wanted.includes(id)) : proposed;
      const compositionKey = await hex(
        `${changeId}\n${change.base_generation}\n${changeSetIds.join(",")}`,
      );
      const candidateId = `cand_${compositionKey.slice(0, 24)}`;

      let row = await loadCandidate(c.env, candidateId);
      if (!row) {
        const count = await c.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM candidates WHERE change_id = ?",
        )
          .bind(changeId)
          .first<{ n: number }>();
        if ((count?.n ?? 0) >= MAX_CANDIDATES) {
          return fail(c, 409, "conflict", `A Change can have at most ${MAX_CANDIDATES} Candidates`);
        }
        const now = new Date().toISOString();
        await c.env.DB.prepare(
          `INSERT OR IGNORE INTO candidates (id, change_id, base_generation, status, created_at,
             updated_at, composition_key, change_set_ids_json)
           VALUES (?, ?, ?, 'composing', ?, ?, ?, ?)`,
        )
          .bind(
            candidateId,
            changeId,
            change.base_generation,
            now,
            now,
            compositionKey,
            JSON.stringify(changeSetIds),
          )
          .run();
        row = await loadCandidate(c.env, candidateId);
        if (!row) throw new Error("Candidate was not readable after creation");
      }
      // Safe to repeat: the command ID is stable and the workflow instance ID is the Candidate ID.
      await c.env.INTEGRATION_COMMANDS.send(
        {
          commandId: `cmd_${candidateId}_verify`,
          commandType: "candidate.verify",
          projectId: change.project_id,
          changeId,
          attempt: 0,
          createdAt: new Date().toISOString(),
          payload: { candidateId },
        },
        { contentType: "json" },
      );
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
        "SELECT * FROM evidence_index WHERE candidate_id = ? ORDER BY created_at",
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
