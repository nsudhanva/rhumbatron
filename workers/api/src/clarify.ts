import { apiData, ClarifyChangeOutcome, ClarifyChangeRequest } from "@rhumbatron/protocol";
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
 * Only the requester (`created_by`) or the Project owner may answer; another collaborator gets 403.
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

/** True when the caller may answer: the requester, or the Project owner. */
export function mayClarify(
  role: "owner" | "collaborator" | null,
  requesterUserId: string,
  userId: string,
): boolean {
  return role === "owner" || (role !== null && requesterUserId === userId);
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
    if (!mayClarify(role, change.created_by, userId)) {
      return fail(
        c,
        403,
        "forbidden",
        "Only the person who made the request or the project owner can answer it.",
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
