import {
  apiData,
  CHOICE_DAYS,
  ChangeStatus,
  ChooseOutcome,
  ChooseRequest,
  canChooseFirstCome,
  changeTitle,
  type ProjectRole,
  RequestWait,
  RequestWaitChoice,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { errorBody, fail, respond, validate } from "./http.ts";
import { ensureIdentity, projectRole } from "./identity.ts";
import { requesterName } from "./members.ts";

/**
 * First-come conflicts between requests of different people (ADR 0032).
 *
 * - `GET /v1/changes/:changeId/request-waits`: the waits where the Change is the earlier or the
 *   later request, newest first, with both requests, the conflicting criteria, and the choice.
 * - `POST /v1/changes/:changeId/choose`: the earlier requester chooses for the waiting (later)
 *   request `:changeId`: `keep_mine` or `apply_theirs`. Only that person; the owner, the admins,
 *   and the later requester get 403. The integration Worker owns the transition.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Internal RPC on the integration Worker (service binding `INTEGRATION`). */
type IntegrationRpc = {
  chooseFirstCome(input: {
    changeId: string;
    actorUserId: string;
    choice: ChooseRequest["choice"];
  }): Promise<unknown>;
};
const integration = (env: Env) => env.INTEGRATION as unknown as IntegrationRpc;

const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });

type WaitRow = {
  id: string;
  project_id: string;
  first_change_id: string;
  later_change_id: string;
  conflict_id: string;
  asked_user_id: string;
  choice: string | null;
  chosen_at: string | null;
  created_at: string;
  f_goal: string | null;
  f_title: string | null;
  f_by: string | null;
  f_name: string | null;
  f_email: string | null;
  l_goal: string;
  l_title: string | null;
  l_status: string;
  l_by: string;
  l_name: string | null;
  l_email: string | null;
  criteria_json: string | null;
  review_json: string | null;
  change_a: string | null;
};

const WAITS_SQL = `SELECT w.id, w.project_id, w.first_change_id, w.later_change_id, w.conflict_id,
    w.asked_user_id, w.choice, w.chosen_at, w.created_at,
    f.goal AS f_goal, f.title AS f_title, f.created_by AS f_by,
    uf.display_name AS f_name, uf.email AS f_email,
    l.goal AS l_goal, l.title AS l_title, l.status AS l_status, l.created_by AS l_by,
    ul.display_name AS l_name, ul.email AS l_email,
    r.criteria_json, r.review_json, r.change_a
  FROM request_choices w
  JOIN changes l ON l.id = w.later_change_id
  LEFT JOIN changes f ON f.id = w.first_change_id
  LEFT JOIN users uf ON uf.id = w.asked_user_id
  LEFT JOIN users ul ON ul.id = l.created_by
  LEFT JOIN request_conflicts r ON r.id = w.conflict_id`;

/**
 * Conflicting criterion pairs as text, oriented first then later. `criteria_json` holds
 * `{ a, b, why }` with criterion IDs where `a` belongs to `change_a`; the review inputs hold the
 * text of each side.
 */
function conflictTexts(row: WaitRow): RequestWait["conflicts"] {
  try {
    const pairs = JSON.parse(row.criteria_json ?? "[]") as {
      a?: string;
      b?: string;
      why?: string;
    }[];
    const inputs = (
      JSON.parse(row.review_json ?? "{}") as {
        inputs?: Record<
          "a" | "b",
          { changeId?: string; criteria?: { id: string; text: string }[] }
        >;
      }
    ).inputs;
    const text = new Map<string, string>();
    for (const side of [inputs?.a, inputs?.b])
      for (const c of side?.criteria ?? []) text.set(`${side?.changeId}:${c.id}`, c.text);
    const firstIsA = row.change_a === row.first_change_id;
    return pairs.slice(0, 3).map((p) => {
      const [firstId, laterId] = firstIsA ? [p.a, p.b] : [p.b, p.a];
      return {
        first: text.get(`${row.first_change_id}:${firstId}`) ?? firstId ?? "",
        later: text.get(`${row.later_change_id}:${laterId}`) ?? laterId ?? "",
        why: p.why ?? "",
      };
    });
  } catch {
    return [];
  }
}

function toRequestWait(
  row: WaitRow,
  viewerUserId: string,
  viewerRole: ProjectRole | null,
): RequestWait {
  const choice = row.choice ? RequestWaitChoice.parse(row.choice) : null;
  return {
    id: row.id,
    firstChangeId: row.first_change_id,
    firstTitle: changeTitle(row.f_title, row.f_goal ?? ""),
    firstRequester: {
      userId: row.asked_user_id,
      name: requesterName(row.f_name, row.f_email),
    },
    laterChangeId: row.later_change_id,
    laterTitle: changeTitle(row.l_title, row.l_goal),
    laterGoal: row.l_goal,
    laterRequester: { userId: row.l_by, name: requesterName(row.l_name, row.l_email) },
    conflicts: conflictTexts(row),
    choice,
    chosenAt: row.chosen_at,
    askedAt: row.created_at,
    expiresAt: new Date(Date.parse(row.created_at) + CHOICE_DAYS * 86_400_000).toISOString(),
    laterStatus: ChangeStatus.parse(row.l_status),
    canChoose:
      ["awaiting_choice", "queued"].includes(row.l_status) &&
      canChooseFirstCome({
        callerUserId: viewerUserId,
        askedUserId: row.asked_user_id,
        callerRole: viewerRole,
        choice,
      }),
  };
}

export const firstCome = new Hono<AppEnv>()
  .get(
    "/v1/changes/:changeId/request-waits",
    requireAuth,
    validate("param", ChangeIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      const change = await c.env.DB.prepare("SELECT project_id FROM changes WHERE id = ?")
        .bind(changeId)
        .first<{ project_id: string }>();
      const role = change ? await projectRole(c.env.DB, userId, change.project_id) : null;
      if (!change || !role) return fail(c, 404, "not_found", "Change not found");
      const rows = await c.env.DB.prepare(
        `${WAITS_SQL} WHERE w.first_change_id = ?1 OR w.later_change_id = ?1
         ORDER BY w.created_at DESC LIMIT 10`,
      )
        .bind(changeId)
        .all<WaitRow>();
      return respond(c, apiData(z.array(RequestWait)), {
        data: (rows.results ?? []).map((row) => toRequestWait(row, userId, role)),
      });
    },
  )

  .post(
    "/v1/changes/:changeId/choose",
    requireAuth,
    validate("param", ChangeIdParam),
    validate("json", ChooseRequest),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      const { choice } = c.req.valid("json");
      const row = await c.env.DB.prepare(
        `SELECT w.asked_user_id, w.choice, l.project_id FROM request_choices w
         JOIN changes l ON l.id = w.later_change_id
         WHERE w.later_change_id = ? ORDER BY w.created_at DESC LIMIT 1`,
      )
        .bind(changeId)
        .first<{ asked_user_id: string; choice: string | null; project_id: string }>();
      const role = row ? await projectRole(c.env.DB, userId, row.project_id) : null;
      if (!row || !role) return fail(c, 404, "not_found", "No choice is open for this request");
      const allowed = canChooseFirstCome({
        callerUserId: userId,
        askedUserId: row.asked_user_id,
        callerRole: role,
        choice: null,
      });
      if (!allowed) {
        return fail(
          c,
          403,
          "forbidden",
          "Only the person who made the earlier request can choose.",
        );
      }
      const outcome = ChooseOutcome.parse(
        await integration(c.env).chooseFirstCome({ changeId, actorUserId: userId, choice }),
      );
      if (outcome.result === "refused") {
        const status = outcome.reason === "not_found" ? 404 : 409;
        return c.json(
          errorBody(status === 404 ? "not_found" : "conflict", outcome.detail, outcome),
          status,
        );
      }
      return respond(c, apiData(ChooseOutcome), { data: outcome });
    },
  );
