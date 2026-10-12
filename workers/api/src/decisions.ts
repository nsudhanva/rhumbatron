import { apiData } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Decision Receipts of one Change, for the Flight Control decisions panel.
 * Read-only, D1 only: `decision_receipts` joined to `tasks` through idx_tasks_change_id and
 * idx_decision_receipts_task_id, capped at RECEIPT_LIMIT rows (oldest first; `truncated` says
 * when newer rows were dropped). A receipt holds routing inputs and outputs only, never
 * reasoning, so the stored JSON is returned as is.
 *
 *   GET /v1/changes/:changeId/decisions
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });

/** Receipts returned per Change. One per attempt, so this covers hundreds of attempts. */
const RECEIPT_LIMIT = 200;

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

const DecisionReceiptView = z.object({
  id: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  decisionType: z.string(),
  decidedBy: z.enum(["rules", "clef"]),
  selectedTier: z.enum(["haiku", "sonnet", "opus"]),
  receipt: z.record(z.string(), JsonValue),
  createdAt: z.string(),
});

const ChangeDecisions = z.object({
  receipts: z.array(DecisionReceiptView),
  truncated: z.boolean(),
});

type ReceiptRow = {
  id: string;
  task_id: string;
  agent_id: string;
  decision_type: string;
  decided_by: "rules" | "clef";
  selected_tier: "haiku" | "sonnet" | "opus";
  receipt_json: string;
  created_at: string;
};

function parseReceipt(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export const decisions = new Hono<AppEnv>().get(
  "/v1/changes/:changeId/decisions",
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
      `SELECT d.id, d.task_id, d.agent_id, d.decision_type, d.decided_by, d.selected_tier,
              d.receipt_json, d.created_at
       FROM tasks t JOIN decision_receipts d ON d.task_id = t.id
       WHERE t.change_id = ? ORDER BY d.created_at, d.id LIMIT ?`,
    )
      .bind(changeId, RECEIPT_LIMIT + 1)
      .all<ReceiptRow>();
    const all = rows.results ?? [];
    const receipts = all.slice(0, RECEIPT_LIMIT).map((r) => ({
      id: r.id,
      taskId: r.task_id,
      agentId: r.agent_id,
      decisionType: r.decision_type,
      decidedBy: r.decided_by,
      selectedTier: r.selected_tier,
      receipt: parseReceipt(r.receipt_json),
      createdAt: r.created_at,
    }));
    return respond(c, apiData(ChangeDecisions), {
      data: { receipts, truncated: all.length > RECEIPT_LIMIT },
    });
  },
);
