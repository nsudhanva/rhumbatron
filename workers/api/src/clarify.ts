import {
  apiData,
  ClarifyChangeOutcome,
  ClarifyChangeRequest,
  can,
  type ProjectRole,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { errorBody, fail, respond, validate } from "./http.ts";
import { ensureIdentity, projectRole } from "./identity.ts";

/**
 * `POST /v1/changes/:changeId/clarify` (ADR 0025). A Change in `needs_input` waits for an answer:
 *
 * - `{ answers: [{ questionId, text }] }` adds the answers to the goal context; the workflow runs
 *   the intake gate and the planner again with them.
 * - `{ action: "proceed_anyway" }` plans without another question this round.
 * - `{ action: "withdraw" }` cancels the Change with the reason "Withdrawn by the requester".
 *
 * The requester (`created_by`, any role that may submit) or the owner or an admin may answer;
 * anyone else gets 403 (`change.manageOwn`, `change.manageAny`).
 * The integration Worker owns the transition and the workflow event (`clarifyChange`).
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Internal RPC on the integration Worker (service binding `INTEGRATION`). */
type IntegrationRpc = {
  clarifyChange(input: {
    changeId: string;
    actorUserId: string;
    request: ClarifyChangeRequest;
  }): Promise<unknown>;
};
const integration = (env: Env) => env.INTEGRATION as unknown as IntegrationRpc;

const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });

/**
 * True when the caller may act on a request as its requester or as a manager: answer, withdraw,
 * or cancel it. The requester needs `change.manageOwn`, anyone else `change.manageAny`.
 */
export function mayActOnRequest(
  role: ProjectRole | null,
  requesterUserId: string,
  userId: string,
): boolean {
  return requesterUserId === userId ? can(role, "change.manageOwn") : can(role, "change.manageAny");
}

export const clarify = new Hono<AppEnv>().post(
  "/v1/changes/:changeId/clarify",
  requireAuth,
  validate("param", ChangeIdParam),
  validate("json", ClarifyChangeRequest),
  async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { changeId } = c.req.valid("param");
    const request = c.req.valid("json");
    const change = await c.env.DB.prepare("SELECT project_id, created_by FROM changes WHERE id = ?")
      .bind(changeId)
      .first<{ project_id: string; created_by: string }>();
    const role = change ? await projectRole(c.env.DB, userId, change.project_id) : null;
    if (!change || !role) return fail(c, 404, "not_found", "Change not found");
    if (!mayActOnRequest(role, change.created_by, userId)) {
      return fail(
        c,
        403,
        "forbidden",
        "Only the person who made the request, the project owner, or an admin can answer it.",
      );
    }
    const outcome = ClarifyChangeOutcome.parse(
      await integration(c.env).clarifyChange({ changeId, actorUserId: userId, request }),
    );
    if (outcome.status === "refused") {
      const status =
        outcome.reason === "not_found" ? 404 : outcome.reason === "unknown_question" ? 400 : 409;
      const code = status === 404 ? "not_found" : status === 400 ? "invalid_request" : "conflict";
      return c.json(errorBody(code, outcome.detail, outcome), status);
    }
    return respond(c, apiData(ClarifyChangeOutcome), { data: outcome });
  },
);
