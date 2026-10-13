import { apiData, can, changeTitle, deniedMessage } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity, projectRole } from "./identity.ts";

/**
 * Operator actions for poison commands and Project budget limit stops. The event-router dead-letter consumer records each dead-lettered command in D1
 * (`dead_letters`, migration 0011) and blocks its Task. Here a member reads them, retries one (the
 * same command, same `command_id`, back to its original Queue; consumers are idempotent), or
 * dismisses it. The read also lists Tasks and Changes that a Project budget limit stopped or delays,
 * with the exact limit, so the UI can show it.
 *
 * Cost: a read is 3 D1 queries; a retry is at most 3 D1 writes and 1 Queue message.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const ChangeIdQuery = z.object({
  changeId: z
    .string()
    .regex(/^chg_[a-z0-9-]+$/)
    .optional(),
});
const DeadLetterIdParam = z.object({ id: z.string().regex(/^dl_[a-f0-9]{32}$/) });

/** Open dead letters shown per read. The banner lists them; more than this is an incident. */
const MAX_ROWS = 50;

const DeadLetterView = z.object({
  id: z.string(),
  commandId: z.string(),
  commandType: z.string(),
  queue: z.string(),
  changeId: z.string().nullable(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  error: z.string(),
  attempt: z.number().int(),
  deadCount: z.number().int(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});
export type DeadLetterView = z.infer<typeof DeadLetterView>;

/** A Task or Change that a Project budget limit stopped (or, for concurrency limits, delays). */
const LimitBlockView = z.object({
  scope: z.enum(["task", "change"]),
  id: z.string(),
  changeId: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  limit: z.string(),
  reason: z.string(),
});

const OperatorView = z.object({
  deadLetters: z.array(DeadLetterView),
  limits: z.array(LimitBlockView),
});

const ResolutionView = z.object({
  id: z.string(),
  resolution: z.enum(["retried", "dismissed", "succeeded", "superseded"]),
  commandId: z.string(),
  queue: z.string(),
});

export type DeadLetterRow = {
  id: string;
  command_id: string;
  command_type: string;
  queue: string;
  project_id: string | null;
  change_id: string | null;
  task_id: string | null;
  payload_json: string;
  error: string;
  attempt: number;
  dead_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
};

type Producers = Pick<Env, "DB" | "AGENT_WAKEUPS" | "INTEGRATION_COMMANDS">;

/** The original Queue of a dead-lettered command, by the key the consumer stored. */
function queueFor(env: Producers, queue: string): Queue | null {
  if (queue === "agent-wakeups") return env.AGENT_WAKEUPS;
  if (queue === "integration") return env.INTEGRATION_COMMANDS;
  // Workflow start commands. The integration Worker consumes the verification, release,
  // and integration Queues with one handler, so its main Queue starts the same instance.
  if (queue === "verification" || queue === "release") return env.INTEGRATION_COMMANDS;
  return null;
}

export type RetryOutcome =
  | { ok: true; command: Record<string, unknown> }
  | { ok: false; status: 409 | 502; message: string };

/**
 * Retries one dead letter. Order: claim the row (one winner under concurrent clicks), unblock the
 * Task so the command is relevant when it arrives, then send. A failed send undoes both.
 * The command keeps its `command_id`; only `attempt` grows, so a second dead-lettering of the
 * retried copy reopens the row instead of looking like a redelivery.
 */
export async function retryDeadLetter(
  env: Producers,
  row: DeadLetterRow,
  userId: string,
  now: string,
): Promise<RetryOutcome> {
  const queue = queueFor(env, row.queue);
  if (!queue) return { ok: false, status: 409, message: `Unknown original Queue ${row.queue}` };
  const claimed = await env.DB.prepare(
    `UPDATE dead_letters SET resolved_at = ?, resolved_by = ?, resolution = 'retried'
     WHERE id = ? AND resolved_at IS NULL`,
  )
    .bind(now, userId, row.id)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) {
    return { ok: false, status: 409, message: "This command was already retried or dismissed" };
  }

  const stored = JSON.parse(row.payload_json) as Record<string, unknown>;
  const command = { ...stored, attempt: Number(stored.attempt ?? 0) + 1 };
  await unblock(env.DB, row, now);
  try {
    await queue.send(command, { contentType: "json" });
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE dead_letters SET resolved_at = NULL, resolved_by = NULL, resolution = NULL
         WHERE id = ? AND resolution = 'retried' AND resolved_at = ?`,
      ).bind(row.id, now),
      ...reblock(env.DB, row, now),
    ]);
    console.error(
      JSON.stringify({ event: "dead_letter.retry_failed", id: row.id, message: String(error) }),
    );
    return { ok: false, status: 502, message: "The command could not be queued. Try again." };
  }
  return { ok: true, command };
}

/** Undoes the consumer's block: the Task is ready again with no agent, or the Change note clears. */
async function unblock(db: D1Database, row: DeadLetterRow, now: string) {
  if (row.task_id) {
    await db
      .prepare(
        `UPDATE tasks SET status = 'ready', assigned_agent_id = NULL, blocked_limit = NULL,
           blocked_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'blocked' AND blocked_limit = 'dead_letter'`,
      )
      .bind(now, row.task_id)
      .run();
  } else if (row.change_id) {
    await db
      .prepare(
        `UPDATE changes SET blocked_limit = NULL, blocked_reason = NULL, updated_at = ?
         WHERE id = ? AND blocked_limit = 'dead_letter'`,
      )
      .bind(now, row.change_id)
      .run();
  }
}

function reblock(db: D1Database, row: DeadLetterRow, now: string): D1PreparedStatement[] {
  const reason = `Dead-lettered: ${row.command_type} (${row.command_id}) failed after its retries. Retry or dismiss it.`;
  if (row.task_id) {
    return [
      db
        .prepare(
          `UPDATE tasks SET status = 'blocked', blocked_limit = 'dead_letter', blocked_reason = ?,
             updated_at = ? WHERE id = ? AND status = 'ready' AND assigned_agent_id IS NULL`,
        )
        .bind(reason, now, row.task_id),
    ];
  }
  if (row.change_id) {
    return [
      db
        .prepare(
          `UPDATE changes SET blocked_limit = 'dead_letter', blocked_reason = ?, updated_at = ?
           WHERE id = ? AND blocked_limit IS NULL`,
        )
        .bind(reason, now, row.change_id),
    ];
  }
  return [];
}

/**
 * Dismisses one dead letter: the operator accepts the failure. A blocked Task stays blocked (it
 * names the dismissal); a Change note clears. Nothing is sent.
 */
export async function dismissDeadLetter(
  db: D1Database,
  row: DeadLetterRow,
  userId: string,
  now: string,
): Promise<boolean> {
  const dismissed = await db
    .prepare(
      `UPDATE dead_letters SET resolved_at = ?, resolved_by = ?, resolution = 'dismissed'
       WHERE id = ? AND resolved_at IS NULL`,
    )
    .bind(now, userId, row.id)
    .run();
  if ((dismissed.meta.changes ?? 0) === 0) return false;
  if (row.task_id) {
    await db
      .prepare(
        `UPDATE tasks SET blocked_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'blocked' AND blocked_limit = 'dead_letter'`,
      )
      .bind(
        `Dead-lettered: ${row.command_type} (${row.command_id}) failed after its retries. An operator dismissed it.`,
        now,
        row.task_id,
      )
      .run();
  } else if (row.change_id) {
    await db
      .prepare(
        `UPDATE changes SET blocked_limit = NULL, blocked_reason = NULL, updated_at = ?
         WHERE id = ? AND blocked_limit = 'dead_letter'`,
      )
      .bind(now, row.change_id)
      .run();
  }
  return true;
}

const ROW_COLUMNS = `id, command_id, command_type, queue, project_id, change_id, task_id, payload_json,
  error, attempt, dead_count, first_seen_at, last_seen_at, resolved_at`;

async function loadRow(db: D1Database, id: string) {
  return db
    .prepare(`SELECT ${ROW_COLUMNS} FROM dead_letters WHERE id = ?`)
    .bind(id)
    .first<DeadLetterRow>();
}

export const deadLetters = new Hono<AppEnv>()
  .get(
    "/v1/projects/:projectId/dead-letters",
    requireAuth,
    validate("param", ProjectIdParam),
    validate("query", ChangeIdQuery),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      const { changeId } = c.req.valid("query");
      if (!(await canAccessProject(c.env.DB, userId, projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }
      const byChange = changeId ? " AND c.id = ?" : "";
      const scope = changeId ? [projectId, changeId] : [projectId];
      const [letters, tasks, changes] = await c.env.DB.batch([
        c.env.DB.prepare(
          `SELECT d.id, d.command_id, d.command_type, d.queue, d.change_id, d.task_id, d.error,
                  d.attempt, d.dead_count, d.first_seen_at, d.last_seen_at, t.title AS task_title
           FROM dead_letters d LEFT JOIN tasks t ON t.id = d.task_id
           WHERE d.project_id = ? AND d.resolved_at IS NULL${changeId ? " AND d.change_id = ?" : ""}
           ORDER BY d.first_seen_at DESC LIMIT ?`,
        ).bind(...scope, MAX_ROWS),
        c.env.DB.prepare(
          `SELECT t.id, t.change_id, t.title, t.status, t.blocked_limit, t.blocked_reason
           FROM tasks t JOIN changes c ON c.id = t.change_id
           WHERE c.project_id = ?${byChange} AND t.blocked_limit IS NOT NULL
             AND t.blocked_limit != 'dead_letter'
             AND t.status IN ('ready', 'assigned', 'running', 'blocked')
           ORDER BY t.updated_at DESC LIMIT ?`,
        ).bind(...scope, MAX_ROWS),
        c.env.DB.prepare(
          `SELECT c.id, c.goal, c.title, c.status, c.blocked_limit, c.blocked_reason
           FROM changes c
           WHERE c.project_id = ?${byChange} AND c.blocked_limit IS NOT NULL
             AND c.blocked_limit != 'dead_letter'
             AND c.status NOT IN ('completed', 'cancelled', 'failed')
           ORDER BY c.updated_at DESC LIMIT ?`,
        ).bind(...scope, MAX_ROWS),
      ]);
      const letterRows = (letters?.results ?? []) as (DeadLetterRow & {
        task_title: string | null;
      })[];
      type TaskBlock = {
        id: string;
        change_id: string;
        title: string | null;
        status: string;
        blocked_limit: string;
        blocked_reason: string | null;
      };
      type ChangeBlock = {
        id: string;
        goal: string;
        title: string | null;
        status: string;
        blocked_limit: string;
        blocked_reason: string | null;
      };
      return respond(c, apiData(OperatorView), {
        data: {
          deadLetters: letterRows.map((r) => ({
            id: r.id,
            commandId: r.command_id,
            commandType: r.command_type,
            queue: r.queue,
            changeId: r.change_id,
            taskId: r.task_id,
            taskTitle: r.task_title,
            error: r.error,
            attempt: r.attempt,
            deadCount: r.dead_count,
            firstSeenAt: r.first_seen_at,
            lastSeenAt: r.last_seen_at,
          })),
          limits: [
            ...((changes?.results ?? []) as ChangeBlock[]).map((r) => ({
              scope: "change" as const,
              id: r.id,
              changeId: r.id,
              title: changeTitle(r.title, r.goal),
              status: r.status,
              limit: r.blocked_limit,
              reason: r.blocked_reason ?? r.blocked_limit,
            })),
            ...((tasks?.results ?? []) as TaskBlock[]).map((r) => ({
              scope: "task" as const,
              id: r.id,
              changeId: r.change_id,
              title: r.title,
              status: r.status,
              limit: r.blocked_limit,
              reason: r.blocked_reason ?? r.blocked_limit,
            })),
          ],
        },
      });
    },
  )

  .post(
    "/v1/dead-letters/:id/retry",
    requireAuth,
    validate("param", DeadLetterIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { id } = c.req.valid("param");
      const row = await loadRow(c.env.DB, id);
      if (!row?.project_id || !(await canAccessProject(c.env.DB, userId, row.project_id))) {
        return fail(c, 404, "not_found", "Dead letter not found");
      }
      if (!can(await projectRole(c.env.DB, userId, row.project_id), "deadLetter.resolve")) {
        return fail(
          c,
          403,
          "forbidden",
          deniedMessage("deadLetter.resolve", "resolve stopped work"),
        );
      }
      const outcome = await retryDeadLetter(c.env, row, userId, new Date().toISOString());
      if (!outcome.ok) {
        return outcome.status === 409
          ? fail(c, 409, "conflict", outcome.message)
          : fail(c, 502, "internal", outcome.message);
      }
      return respond(c, apiData(ResolutionView), {
        data: { id, resolution: "retried", commandId: row.command_id, queue: row.queue },
      });
    },
  )

  .post(
    "/v1/dead-letters/:id/dismiss",
    requireAuth,
    validate("param", DeadLetterIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { id } = c.req.valid("param");
      const row = await loadRow(c.env.DB, id);
      if (!row?.project_id || !(await canAccessProject(c.env.DB, userId, row.project_id))) {
        return fail(c, 404, "not_found", "Dead letter not found");
      }
      if (!can(await projectRole(c.env.DB, userId, row.project_id), "deadLetter.resolve")) {
        return fail(
          c,
          403,
          "forbidden",
          deniedMessage("deadLetter.resolve", "resolve stopped work"),
        );
      }
      if (!(await dismissDeadLetter(c.env.DB, row, userId, new Date().toISOString()))) {
        return fail(c, 409, "conflict", "This command was already retried or dismissed");
      }
      return respond(c, apiData(ResolutionView), {
        data: { id, resolution: "dismissed", commandId: row.command_id, queue: row.queue },
      });
    },
  );
