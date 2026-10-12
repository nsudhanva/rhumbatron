import {
  apiData,
  ChangeCommandOutcome,
  ChangeDetail,
  changeTitle,
  RaiseBudgetRequest,
} from "@rhumbatron/protocol";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { errorBody, fail, respond, validate } from "./http.ts";
import { ensureIdentity, ownerOnlyMessage, projectRole } from "./identity.ts";
import { RELATED_TITLE, type RequestColumns, requestFields } from "./members.ts";

/**
 * `GET /v1/changes/:changeId` with the planned risk tier and record times (AGENTS.md section 16.1).
 * Mounted before `projects` (through activity.ts), so this handler answers and the older handler
 * in projects.ts, which returns the same fields minus these three, is no longer reached.
 *
 * `POST /v1/changes/:changeId/cancel` and `POST /v1/changes/:changeId/budget` are a person's
 * commands on one Change (sections 16.1, 44). The integration Worker owns the transitions.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Internal RPC on the integration Worker (service binding `INTEGRATION`). */
type IntegrationRpc = {
  cancelChange(input: { changeId: string; actorUserId: string }): Promise<unknown>;
  raiseChangeBudget(input: {
    changeId: string;
    budgetUsd: number;
    actorUserId: string;
  }): Promise<unknown>;
};
const integration = (env: Env) => env.INTEGRATION as unknown as IntegrationRpc;

const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });

type ChangeRow = {
  id: string;
  project_id: string;
  goal: string;
  title: string | null;
  status: string;
  base_generation: number;
  risk_tier: string | null;
  budget_usd: number;
  acceptance_criteria_json: string;
  invariants_json: string;
  work_graph_ref: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
} & RequestColumns;

function toDetail(row: ChangeRow, viewerUserId: string): ChangeDetail {
  return {
    id: row.id,
    projectId: row.project_id,
    goal: row.goal,
    title: changeTitle(row.title, row.goal),
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as string[],
    invariants: JSON.parse(row.invariants_json) as string[],
    status: ChangeDetail.shape.status.parse(row.status),
    baseGeneration: row.base_generation,
    ...(row.work_graph_ref ? { workGraphRef: row.work_graph_ref } : {}),
    budgetUsd: row.budget_usd,
    blockedReason: row.blocked_reason,
    rolloutPolicy: { target: "preview" },
    riskTier: ChangeDetail.shape.riskTier.parse(row.risk_tier),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...requestFields(row, viewerUserId),
  };
}

/** The Change's Project and the caller's role, when the caller can open the Project. */
async function memberChange(env: Env, userId: string, changeId: string) {
  const row = await env.DB.prepare("SELECT project_id, created_by FROM changes WHERE id = ?")
    .bind(changeId)
    .first<{ project_id: string; created_by: string }>();
  const role = row ? await projectRole(env.DB, userId, row.project_id) : null;
  return row && role ? { ...row, role } : null;
}

/** A refused command: 404 when the Change is gone, 409 when its status does not allow it. */
function refused(c: Context, outcome: Extract<ChangeCommandOutcome, { status: "refused" }>) {
  return outcome.reason === "not_found"
    ? c.json(errorBody("not_found", outcome.detail, outcome), 404)
    : c.json(errorBody("conflict", outcome.detail, outcome), 409);
}

export const changeDetail = new Hono<AppEnv>()
  .get("/v1/changes/:changeId", requireAuth, validate("param", ChangeIdParam), async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { changeId } = c.req.valid("param");
    const row = await c.env.DB.prepare(
      `SELECT c.id, c.project_id, c.goal, c.title, c.status, c.base_generation, c.risk_tier,
              c.budget_usd, c.acceptance_criteria_json, c.invariants_json, c.work_graph_ref,
              c.blocked_reason, c.created_at, c.updated_at, c.created_by, c.requester_rank,
              c.outcome, c.outcome_reason, c.outcome_winner_change_id, c.outcome_decided_by,
              c.supersedes_change_id, c.clarification_json, u.display_name, u.email,
              ${RELATED_TITLE}
       FROM changes c LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?`,
    )
      .bind(changeId)
      .first<ChangeRow>();
    if (!row || !(await projectRole(c.env.DB, userId, row.project_id))) {
      return fail(c, 404, "not_found", "Change not found");
    }
    return respond(c, apiData(ChangeDetail), { data: toDetail(row, userId) });
  })

  /** Cancels the Change before promotion starts; no new Task is dispatched. Safe to repeat. */
  .post(
    "/v1/changes/:changeId/cancel",
    requireAuth,
    validate("param", ChangeIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      const change = await memberChange(c.env, userId, changeId);
      if (!change) return fail(c, 404, "not_found", "Change not found");
      // A collaborator can cancel only their own request (phase 17a, decision S-04).
      if (change.role !== "owner" && change.created_by !== userId) {
        return fail(c, 403, "forbidden", ownerOnlyMessage("cancel another person's request"));
      }
      const outcome = ChangeCommandOutcome.parse(
        await integration(c.env).cancelChange({ changeId, actorUserId: userId }),
      );
      if (outcome.status === "refused") return refused(c, outcome);
      return respond(c, apiData(ChangeCommandOutcome), { data: outcome });
    },
  )

  /**
   * Section 44 rule 5: a person raises the Change budget. A `budget_blocked` Change resumes and
   * its ready Tasks are dispatched again. The budget can only go up. Safe to repeat.
   */
  .post(
    "/v1/changes/:changeId/budget",
    requireAuth,
    validate("param", ChangeIdParam),
    validate("json", RaiseBudgetRequest),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      const { budgetUsd } = c.req.valid("json");
      const change = await memberChange(c.env, userId, changeId);
      if (!change) return fail(c, 404, "not_found", "Change not found");
      if (change.role !== "owner") {
        return fail(c, 403, "forbidden", ownerOnlyMessage("raise a budget"));
      }
      const outcome = ChangeCommandOutcome.parse(
        await integration(c.env).raiseChangeBudget({ changeId, budgetUsd, actorUserId: userId }),
      );
      if (outcome.status === "refused") return refused(c, outcome);
      return respond(c, apiData(ChangeCommandOutcome), { data: outcome });
    },
  );
