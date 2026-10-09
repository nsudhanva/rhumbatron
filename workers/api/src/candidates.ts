import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { apiData, EvidenceRecord, VerificationPlan } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Candidates and their Evidence (AGENTS.md sections 15.5, 16.1, 33, 34). Creating a Candidate is
 * a command: the API records it and queues `candidate.verify`; the integration Worker runs
 * CandidateVerificationWorkflow. Reads come from D1 only.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Policy `maxCandidates` (section 53). */
const MAX_CANDIDATES = 3;

const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });
const CandidateIdParam = z.object({ candidateId: z.string().regex(/^cand_[a-z0-9]+$/) });

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
  created_at: string;
  updated_at: string;
};

const CANDIDATE_COLUMNS = `c.id, c.change_id, ch.project_id, c.status, c.status_reason, c.base_generation,
  c.artifact_ref, c.composed_commit, c.composed_tree, c.change_set_ids_json, c.plan_json,
  c.score_json, c.created_at, c.updated_at`;

function toView(row: CandidateRow): CandidateView {
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
    plan: row.plan_json ? (JSON.parse(row.plan_json) as VerificationPlan) : null,
    gate: row.score_json ? (JSON.parse(row.score_json) as CandidateView["gate"]) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadCandidate(env: Env, candidateId: string) {
  return env.DB.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM candidates c JOIN changes ch ON ch.id = c.change_id WHERE c.id = ?`,
  )
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
      const changeSetIds = (sets.results ?? []).map((r) => r.id);
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
        `SELECT ${CANDIDATE_COLUMNS} FROM candidates c JOIN changes ch ON ch.id = c.change_id
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
  );
