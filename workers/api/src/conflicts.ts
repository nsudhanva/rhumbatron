import { ConflictReport, type ConflictSeverity } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Semantic conflicts of one Change (AGENTS.md sections 32 and 38.2). The agents Worker records
 * them in D1 when a Task declares its Intent; this route only reads them.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });

type ConflictRow = {
  id: string;
  change_id: string;
  resource: string;
  state: string;
  recommended_action: string;
  report_json: string;
  intents_json: string;
  review_json: string;
  fork_decision_json: string;
  challenge_id: string | null;
  created_at: string;
  updated_at: string;
};

const SEVERITY_RANK: Record<ConflictSeverity, number> = { hard: 0, soft: 1, benign: 2 };

export const conflicts = new Hono<AppEnv>().get(
  "/v1/changes/:changeId/conflicts",
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
      "SELECT * FROM conflicts WHERE change_id = ? ORDER BY created_at, id",
    )
      .bind(changeId)
      .all<ConflictRow>();
    const data = (rows.results ?? []).map((r) => {
      const report = ConflictReport.parse(JSON.parse(r.report_json));
      return {
        id: r.id,
        changeId: r.change_id,
        resource: r.resource,
        state: r.state,
        recommendedAction: r.recommended_action,
        // Both sides in report order: task key and title, agent, summary, assumptions, resources.
        intents: JSON.parse(r.intents_json) as unknown[],
        // Hard signals first, then soft, then benign; the detector's order within a severity.
        signals: report.signals
          .map((s, i) => ({ s, i }))
          .sort((x, y) => SEVERITY_RANK[x.s.severity] - SEVERITY_RANK[y.s.severity] || x.i - y.i)
          .map(({ s }) => s),
        review: JSON.parse(r.review_json) as unknown,
        forkDecision: JSON.parse(r.fork_decision_json) as unknown,
        challengeId: r.challenge_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
    return c.json({ data });
  },
);
