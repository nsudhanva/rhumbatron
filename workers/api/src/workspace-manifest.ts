import {
  apiData,
  WorkspaceManifest,
  workspaceManifestKey,
  workspaceManifestPrefix,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

type AppEnv = { Bindings: Env; Variables: AuthVariables };
const TaskParam = z.object({ taskId: z.string().regex(/^tsk_[A-Za-z0-9_-]{1,124}$/) });
const MAX_MANIFESTS = 100;
const MAX_LIST_PAGES = 5;
const MAX_MANIFEST_BYTES = 3_000_000;

/** Read-only metadata; no Artifacts or Sandbox access. A capped scan must never claim an older run is latest. */
export const workspaceManifest = new Hono<AppEnv>().get(
  "/v1/tasks/:taskId/workspace",
  requireAuth,
  validate("param", TaskParam),
  async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { taskId } = c.req.valid("param");
    const task = await c.env.DB.prepare(
      "SELECT t.change_id, ch.project_id FROM tasks t JOIN changes ch ON ch.id = t.change_id WHERE t.id = ?",
    )
      .bind(taskId)
      .first<{ change_id: string; project_id: string }>();
    if (!task || !(await canAccessProject(c.env.DB, userId, task.project_id))) {
      return fail(c, 404, "not_found", "Task not found");
    }
    const identity = { projectId: task.project_id, changeId: task.change_id, taskId };
    const prefix = workspaceManifestPrefix(identity);
    let cursor: string | undefined;
    let scanned = 0;
    let latest: R2Object | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await c.env.EVIDENCE.list({
        prefix,
        limit: MAX_MANIFESTS - scanned,
        ...(cursor ? { cursor } : {}),
        include: ["customMetadata"],
      });
      scanned += listed.objects.length;
      for (const object of listed.objects) {
        if (!object.key.endsWith(".json")) continue;
        const openedAt = object.customMetadata?.openedAt;
        // Every manifest writer supplies this timestamp. Reject ambiguous metadata rather than
        // sort by upload time (an older run can close after a newer run opened).
        if (!openedAt || !Number.isFinite(Date.parse(openedAt))) {
          return fail(c, 503, "internal", "Workspace manifest metadata unavailable");
        }
        if (
          !latest ||
          Date.parse(openedAt) > Date.parse(latest.customMetadata?.openedAt ?? "") ||
          (openedAt === latest.customMetadata?.openedAt && object.key > latest.key)
        )
          latest = object;
      }
      if (!listed.truncated) break;
      if (scanned >= MAX_MANIFESTS || page === MAX_LIST_PAGES - 1) {
        return fail(c, 503, "internal", "Workspace manifest lookup limit reached");
      }
      cursor = listed.cursor;
    }
    if (!latest) return fail(c, 404, "not_found", "Workspace manifest not found");
    const object = await c.env.EVIDENCE.get(latest.key);
    if (!object) return fail(c, 404, "not_found", "Workspace manifest not found");
    if (object.size > MAX_MANIFEST_BYTES)
      return fail(c, 503, "internal", "Workspace manifest too large");
    const parsed = WorkspaceManifest.safeParse(await object.json().catch(() => null));
    if (
      !parsed.success ||
      parsed.data.projectId !== identity.projectId ||
      parsed.data.changeId !== identity.changeId ||
      parsed.data.taskId !== taskId ||
      parsed.data.sandbox.openedAt !== latest.customMetadata?.openedAt ||
      workspaceManifestKey(parsed.data) !== latest.key
    ) {
      return fail(c, 503, "internal", "Invalid workspace manifest");
    }
    c.header("cache-control", "private, no-store");
    return respond(c, apiData(WorkspaceManifest), { data: parsed.data });
  },
);
