import { apiData, ChangeDetail } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * `GET /v1/changes/:changeId` with the planned risk tier and record times (AGENTS.md section 16.1).
 * Mounted before `projects` (through activity.ts), so this handler answers and the older handler
 * in projects.ts, which returns the same fields minus these three, is no longer reached.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });

type ChangeRow = {
  id: string;
  project_id: string;
  goal: string;
  status: string;
  base_generation: number;
  risk_tier: string | null;
  budget_usd: number;
  acceptance_criteria_json: string;
  invariants_json: string;
  work_graph_ref: string | null;
  created_at: string;
  updated_at: string;
};

function toDetail(row: ChangeRow): ChangeDetail {
  return {
    id: row.id,
    projectId: row.project_id,
    goal: row.goal,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as string[],
    invariants: JSON.parse(row.invariants_json) as string[],
    status: ChangeDetail.shape.status.parse(row.status),
    baseGeneration: row.base_generation,
    ...(row.work_graph_ref ? { workGraphRef: row.work_graph_ref } : {}),
    budgetUsd: row.budget_usd,
    rolloutPolicy: { target: "preview" },
    riskTier: ChangeDetail.shape.riskTier.parse(row.risk_tier),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const changeDetail = new Hono<AppEnv>().get(
  "/v1/changes/:changeId",
  requireAuth,
  validate("param", ChangeIdParam),
  async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { changeId } = c.req.valid("param");
    const row = await c.env.DB.prepare(
      `SELECT id, project_id, goal, status, base_generation, risk_tier, budget_usd,
              acceptance_criteria_json, invariants_json, work_graph_ref, created_at, updated_at
       FROM changes WHERE id = ?`,
    )
      .bind(changeId)
      .first<ChangeRow>();
    if (!row || !(await canAccessProject(c.env.DB, userId, row.project_id))) {
      return fail(c, 404, "not_found", "Change not found");
    }
    return respond(c, apiData(ChangeDetail), { data: toDetail(row) });
  },
);
