import {
  appendChangeEvents,
  type ChangeContext,
  changeEvent,
} from "@rhumbatron/integration/events";
import { AnyCommandEnvelope, type CommandEnvelope } from "@rhumbatron/protocol";

/**
 * Dead-letter consumer (AGENTS.md sections 20 and 42.7, P13-10). A command reaches
 * `rhumbatron-dead-letter-<env>` after its consumer's bounded retries. For each one this records
 * the command in D1 (`dead_letters`, migration 0011), marks the related Task `blocked` (or names
 * the failure on the Change when there is no Task), and records `task.failed` through the Change's
 * shard outbox. An operator then retries or dismisses it (workers/api dead-letters.ts).
 *
 * Idempotent on `command_id`: a redelivered dead-letter message (same body) changes nothing. A
 * different copy of the same command (an operator retry has a higher `attempt`; a re-dispatch has a
 * new `createdAt`) that dead-letters again reopens the row and counts it.
 *
 * Cost per message: at most 2 D1 batches, 1 D1 read, and 1 shard call (4 subrequests).
 */

/** Queues whose consumers send poison commands here (Terraform `cloudflare_queue_consumer`). */
export type OriginQueue = "agent-wakeups" | "integration" | "verification" | "release";

/** The Queue a command type travels on. Retry sends the command back to it. */
export const originQueue = (commandType: string): OriginQueue => {
  if (commandType === "agent.wake") return "agent-wakeups";
  // Workflow start commands (AGENTS.md section 20, HOM-202).
  if (commandType === "verification.start") return "verification";
  if (commandType === "release.start") return "release";
  return "integration";
};

/** Queues hide the consumer's error from the dead-letter copy; Workers Logs has the details. */
const errorText = (commandType: string, queue: OriginQueue) =>
  `${commandType} failed on every delivery from rhumbatron-${queue} (consumer max_retries 3) and moved to the dead-letter Queue. The consumer error is in Workers Logs.`;

export type DeadLetterOutcome = "recorded" | "reopened" | "duplicate" | "invalid";

type DeadLetterEnv = Pick<Env, "DB" | "RESOURCE_SHARD">;

type Row = { id: string; dead_count: number; resolved_at: string | null };
type ChangeRow = { project_id: string; org_id: string; slug: string; base_generation: number };

const newId = () => `dl_${crypto.randomUUID().replaceAll("-", "")}`;

/** Records one dead-lettered command. Throws only on a storage failure, so the message retries. */
export async function recordDeadLetter(
  env: DeadLetterEnv,
  body: unknown,
  now: string,
): Promise<DeadLetterOutcome> {
  const parsed = AnyCommandEnvelope.safeParse(body);
  // Consumers acknowledge malformed commands, so one here cannot be retried either.
  if (!parsed.success) return "invalid";
  const command = parsed.data as CommandEnvelope;
  const queue = originQueue(command.commandType);
  const payloadJson = JSON.stringify(command);

  const [upsert, read] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dead_letters (id, command_id, command_type, queue, project_id, change_id, task_id,
         payload_json, error, attempt, dead_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (command_id) DO UPDATE SET
         payload_json = excluded.payload_json, attempt = excluded.attempt, error = excluded.error,
         dead_count = dead_letters.dead_count + 1, last_seen_at = excluded.last_seen_at,
         resolved_at = NULL, resolved_by = NULL, resolution = NULL
       WHERE excluded.payload_json != dead_letters.payload_json`,
    ).bind(
      newId(),
      command.commandId,
      command.commandType,
      queue,
      command.projectId,
      command.changeId ?? null,
      command.taskId ?? null,
      payloadJson,
      errorText(command.commandType, queue),
      command.attempt,
      now,
      now,
    ),
    env.DB.prepare(
      "SELECT id, dead_count, resolved_at FROM dead_letters WHERE command_id = ?",
    ).bind(command.commandId),
  ]);
  const row = (read?.results as Row[] | undefined)?.[0];
  if (!row) throw new Error("dead letter row missing after upsert");
  // No change: the same copy was already recorded (a redelivery of the dead-letter message).
  const fresh = (upsert?.meta.changes ?? 0) > 0;
  // Resolved: an operator already retried or dismissed this copy. Nothing more to do.
  if (row.resolved_at) return "duplicate";

  // Unresolved: apply the block. Every statement is conditional, so a redelivery repeats nothing.
  const reason = `Dead-lettered: ${command.commandType} (${command.commandId}) failed after its retries. Retry or dismiss it.`;
  let taskBlocked = false;
  if (command.taskId) {
    // A Task that waits to start stops visibly. A running Task keeps running: its agent is alive
    // and the dead letter is only a lost notification, shown in the operator banner.
    const [, task] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE tasks SET status = 'blocked', blocked_limit = 'dead_letter', blocked_reason = ?,
           updated_at = ? WHERE id = ? AND status IN ('ready', 'assigned')`,
      ).bind(reason, now, command.taskId),
      env.DB.prepare("SELECT status, blocked_limit FROM tasks WHERE id = ?").bind(command.taskId),
    ]);
    const state = (task?.results as { status: string; blocked_limit: string }[] | undefined)?.[0];
    taskBlocked = state?.status === "blocked" && state.blocked_limit === "dead_letter";
  } else if (command.changeId) {
    await env.DB.prepare(
      `UPDATE changes SET blocked_limit = 'dead_letter', blocked_reason = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')
         AND (blocked_limit IS NULL OR blocked_limit = 'dead_letter')`,
    )
      .bind(reason, now, command.changeId)
      .run();
  }

  if (taskBlocked && command.changeId && command.taskId) {
    const change = await env.DB.prepare(
      `SELECT c.project_id, p.org_id, p.slug, c.base_generation
       FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
    )
      .bind(command.changeId)
      .first<ChangeRow>();
    if (change) {
      const ctx: ChangeContext = {
        projectId: change.project_id,
        orgId: change.org_id,
        projectSlug: change.slug,
        changeId: command.changeId,
        baseGeneration: change.base_generation,
      };
      // Stable event ID per dead-lettered copy: the shard outbox ignores a repeat.
      await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
        await changeEvent(
          ctx,
          "task.failed",
          {
            reason: "dead_lettered",
            kind: "dead_letter",
            commandId: command.commandId,
            commandType: command.commandType,
            summary: reason,
          },
          {
            taskId: command.taskId,
            actor: { kind: "system", id: "dead-letter-consumer" },
            key: `dead_letter:${command.commandId}:${row.dead_count}`,
          },
        ),
      ]);
    }
  }
  if (!fresh) return "duplicate";
  return row.dead_count > 1 ? "reopened" : "recorded";
}

type DeadLetterMessage = {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

/**
 * Consumes one dead-letter batch. Storage failures retry (bounded by the consumer's max_retries;
 * this Queue has no dead-letter Queue of its own). Everything else is acknowledged.
 */
export async function consumeDeadLetters(
  env: DeadLetterEnv,
  messages: readonly DeadLetterMessage[],
  log: (line: Record<string, unknown>) => void,
): Promise<void> {
  for (const message of messages) {
    try {
      const outcome = await recordDeadLetter(env, message.body, new Date().toISOString());
      const body = message.body as { commandId?: unknown; commandType?: unknown } | null;
      log({
        event: "dead_letter.recorded",
        outcome,
        commandId: typeof body?.commandId === "string" ? body.commandId : null,
        commandType: typeof body?.commandType === "string" ? body.commandType : null,
      });
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({ event: "dead_letter.failed", message: String(error).slice(0, 200) }),
      );
      message.retry({ delaySeconds: 60 });
    }
  }
}
