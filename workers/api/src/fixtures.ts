import { apiData } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { DESIGNS, fixtureIds, type WishlistDesign } from "../../../fixtures/wishlist/manifest.ts";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Dev-only Wishlist design-conflict fixture (AGENTS.md sections 32.4, 54; P9-08). Publishing is a
 * command: the API checks the caller and the Change, then queues `fixture.publish`; the
 * integration Worker commits each design to an Artifacts fork and records fixture-sourced
 * ChangeSets and Intents. No model call. The routes answer only where the `FIXTURES_ENABLED`
 * binding is "true" (dev and prod, ADR 0017) or the environment is dev or local; elsewhere 404, as
 * if absent.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const DEV_ENVIRONMENTS: readonly string[] = ["dev", "local"];

export const fixturesEnabled = (env: Env) =>
  env.FIXTURES_ENABLED === "true" || DEV_ENVIRONMENTS.includes(env.ENVIRONMENT as string);

const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });
const PublishRequest = z.object({ design: z.enum(["a", "b", "both"]) });

const FixtureChangeSet = z.object({
  design: z.enum(["a", "b"]),
  taskKey: z.string(),
  title: z.string(),
  changeSetId: z.string(),
  /** Null until the integration Worker has published it. */
  status: z.string().nullable(),
  artifactRef: z.string().nullable(),
});
const FixtureView = z.object({ changeId: z.string(), changeSets: z.array(FixtureChangeSet) });

const designsOf = (design: "a" | "b" | "both"): WishlistDesign[] =>
  design === "both" ? ["a", "b"] : [design];

/** The Change when the caller may use it, or null. */
async function changeFor(env: Env, authSubject: string, changeId: string) {
  const { userId } = await ensureIdentity(env.DB, authSubject);
  const change = await env.DB.prepare(
    `SELECT c.project_id, c.status, p.status AS project_status
     FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
  )
    .bind(changeId)
    .first<{ project_id: string; status: string; project_status: string }>();
  if (!change || !(await canAccessProject(env.DB, userId, change.project_id))) return null;
  return change;
}

async function view(env: Env, changeId: string): Promise<z.infer<typeof FixtureView>> {
  const designs = Object.values(DESIGNS);
  const ids = designs.map((d) => fixtureIds(changeId, d.design).changeSetId);
  const rows = await env.DB.prepare(
    `SELECT id, status, artifact_ref FROM changesets
     WHERE change_id = ? AND id IN (SELECT value FROM json_each(?))`,
  )
    .bind(changeId, JSON.stringify(ids))
    .all<{ id: string; status: string; artifact_ref: string | null }>();
  const byId = new Map((rows.results ?? []).map((r) => [r.id, r]));
  return {
    changeId,
    changeSets: designs.map((d) => {
      const changeSetId = fixtureIds(changeId, d.design).changeSetId;
      const row = byId.get(changeSetId);
      return {
        design: d.design,
        taskKey: d.taskKey,
        title: d.title,
        changeSetId,
        status: row?.status ?? null,
        artifactRef: row?.artifact_ref ?? null,
      };
    }),
  };
}

export const fixtures = new Hono<AppEnv>()
  .use("/v1/changes/:changeId/fixture-changesets", async (c, next) => {
    if (!fixturesEnabled(c.env)) {
      return fail(c, 404, "not_found", "Route not found");
    }
    await next();
  })

  /** Queues publication of design A, B, or both as fixture ChangeSets on a Change. */
  .post(
    "/v1/changes/:changeId/fixture-changesets",
    requireAuth,
    validate("param", ChangeIdParam),
    validate("json", PublishRequest),
    async (c) => {
      const { changeId } = c.req.valid("param");
      const change = await changeFor(c.env, c.get("authSubject"), changeId);
      if (!change) return fail(c, 404, "not_found", "Change not found");
      if (change.project_status !== "active") {
        return fail(c, 409, "conflict", "Project is archived");
      }
      // A planned Change has its own Tasks; fixture designs go only on an unplanned one.
      if (!["created", "verifying"].includes(change.status)) {
        return fail(c, 409, "conflict", `Change is ${change.status}`);
      }
      const designs = designsOf(c.req.valid("json").design);
      // Stable command ID: a retried request is one logical publication (section 60).
      await c.env.INTEGRATION_COMMANDS.send(
        {
          commandId: `cmd_${changeId.slice(4)}_fixture_${designs.join("")}`,
          commandType: "fixture.publish",
          projectId: change.project_id,
          changeId,
          attempt: 0,
          createdAt: new Date().toISOString(),
          payload: { designs },
        },
        { contentType: "json" },
      );
      return respond(c, apiData(FixtureView), { data: await view(c.env, changeId) }, 202);
    },
  )

  /** Which fixture ChangeSets of the Change are published. */
  .get(
    "/v1/changes/:changeId/fixture-changesets",
    requireAuth,
    validate("param", ChangeIdParam),
    async (c) => {
      const { changeId } = c.req.valid("param");
      if (!(await changeFor(c.env, c.get("authSubject"), changeId))) {
        return fail(c, 404, "not_found", "Change not found");
      }
      return respond(c, apiData(FixtureView), { data: await view(c.env, changeId) });
    },
  );
