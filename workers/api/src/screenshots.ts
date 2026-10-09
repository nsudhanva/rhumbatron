import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Browser check screenshots (AGENTS.md sections 34.4, 35). Read-only. The R2 key is derived from
 * the authoritative Evidence row (its `r2_key` directory plus `screenshot-<n>.png`), never from the
 * request, and `n` must be within the screenshot count the Evidence recorded.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Mirrors MAX_SCREENSHOTS in workers/integration/src/browser-check.ts. */
const MAX_SCREENSHOTS = 8;

const Params = z.object({
  candidateId: z.string().regex(/^cand_[a-z0-9]+$/),
  checkId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  n: z.coerce.number().int().min(1).max(MAX_SCREENSHOTS),
});

export const screenshots = new Hono<AppEnv>().get(
  "/v1/candidates/:candidateId/evidence/:checkId/screenshots/:n",
  requireAuth,
  validate("param", Params),
  async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { candidateId, checkId, n } = c.req.valid("param");
    const candidate = await c.env.DB.prepare(
      `SELECT ch.project_id FROM candidates c JOIN changes ch ON ch.id = c.change_id
       WHERE c.id = ?`,
    )
      .bind(candidateId)
      .first<{ project_id: string }>();
    if (!candidate || !(await canAccessProject(c.env.DB, userId, candidate.project_id))) {
      return fail(c, 404, "not_found", "Candidate not found");
    }
    const row = await c.env.DB.prepare(
      `SELECT r2_key, metrics_json FROM evidence_index WHERE candidate_id = ? AND check_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(candidateId, checkId)
      .first<{ r2_key: string | null; metrics_json: string | null }>();
    const metrics = row?.metrics_json
      ? (JSON.parse(row.metrics_json) as Record<string, unknown>)
      : {};
    const count = typeof metrics.screenshots === "number" ? metrics.screenshots : 0;
    if (!row?.r2_key || n > count) return fail(c, 404, "not_found", "No such screenshot");
    const prefix = row.r2_key.slice(0, row.r2_key.lastIndexOf("/"));
    const object = await c.env.EVIDENCE.get(`${prefix}/screenshot-${n}.png`);
    if (!object) return fail(c, 404, "not_found", "No such screenshot");
    return new Response(object.body, {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
        ...(object.customMetadata?.contentHash
          ? { "x-content-hash": object.customMetadata.contentHash }
          : {}),
      },
    });
  },
);
