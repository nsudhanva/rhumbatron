/**
 * Transactional outbox shared by the coordinator Durable Objects (AGENTS.md sections 18 and 42.6).
 * State changes insert outbox rows in the same transaction; an alarm publishes due rows to K2.
 * Retries are bounded: exponential backoff up to 5 minutes, then the row is marked failed.
 */
import { fnv1a32 } from "./shard-key.ts";

/**
 * K2 producer bindings EVENTS_00..EVENTS_07 come from Terraform with stream IDs that wrangler.jsonc
 * does not know, so they are typed here. They are absent in local dev; the outbox then accumulates.
 */
export type K2SendResult = { success: boolean; error?: { message: string; retryable: boolean } };
export type K2Producer = {
  send(records: { content: Uint8Array; headers?: Record<string, string> }[]): Promise<K2SendResult>;
};
type K2Env = Partial<Record<string, unknown>>;

/** Service binding to the event router's `nudge` RPC (absent in local dev). */
type EventRouterBinding = { nudge(streamIndex: number): Promise<unknown> };

const K2_STREAM_COUNT = 8;
export const MAX_PUBLISH_ATTEMPTS = 10;
const BATCH_LIMIT = 100;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Backoff before attempt `attempt + 1`: 1 s, 2 s, 4 s ... capped at 5 minutes. */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

/** Stable stream index for a project. Every producer must use this rule (section 19). */
export function streamIndex(projectId: string, count = K2_STREAM_COUNT): number {
  return fnv1a32(projectId) % count;
}

function producerFor(env: Env, projectId: string): K2Producer | undefined {
  const key = `EVENTS_${String(streamIndex(projectId)).padStart(2, "0")}`;
  return (env as unknown as K2Env)[key] as K2Producer | undefined;
}

export type PublishOutcome =
  | { kind: "published" }
  | { kind: "retry"; attemptCount: number; nextAttemptAt: number; error: string }
  | { kind: "failed"; attemptCount: number; error: string };

/** Decides what happens to a row after a send attempt. Pure, so it is unit tested. */
export function decideOutcome(
  previousAttempts: number,
  result: K2SendResult,
  now: number,
): PublishOutcome {
  if (result.success) return { kind: "published" };
  const attemptCount = previousAttempts + 1;
  const error = `${result.error?.retryable ? "retryable" : "non-retryable"}: ${result.error?.message ?? "unknown"}`;
  // Non-retryable failures may have an unknown outcome; consumers dedupe by eventId, so a bounded
  // retry is still safe. Stop after MAX_PUBLISH_ATTEMPTS and keep the row visible as failed.
  if (attemptCount >= MAX_PUBLISH_ATTEMPTS) return { kind: "failed", attemptCount, error };
  return { kind: "retry", attemptCount, nextAttemptAt: now + retryDelayMs(attemptCount), error };
}

/** Creates the outbox table and adds columns that older instances are missing. */
export function migrateOutbox(sql: SqlStorage) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
  const columns = new Set(
    sql
      .exec<{ name: string }>("PRAGMA table_info(outbox)")
      .toArray()
      .map((c) => c.name),
  );
  if (!columns.has("next_attempt_at")) {
    sql.exec("ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("failed_at")) sql.exec("ALTER TABLE outbox ADD COLUMN failed_at TEXT");
  sql.exec(
    "CREATE INDEX IF NOT EXISTS outbox_due ON outbox (next_attempt_at) WHERE published_at IS NULL AND failed_at IS NULL",
  );
}

type OutboxRow = { id: number; event_id: string; payload_json: string; attempt_count: number };

export class OutboxPublisher {
  constructor(
    private readonly sql: SqlStorage,
    private readonly env: Env,
  ) {}

  /** Earliest time a pending row is due, or null. Null when no K2 binding exists (local dev). */
  nextDueAt(): number | null {
    if (!(this.env as unknown as K2Env).EVENTS_00) return null;
    const row = this.sql
      .exec<{ at: number | null }>(
        "SELECT MIN(next_attempt_at) AS at FROM outbox WHERE published_at IS NULL AND failed_at IS NULL",
      )
      .toArray()[0];
    return row?.at ?? null;
  }

  /** Publishes every due row, one batch per project so each project stays on its stream. */
  async publishAllDue(now: number): Promise<number> {
    const projects = this.sql
      .exec<{ project_id: string }>(
        `SELECT DISTINCT json_extract(payload_json, '$.projectId') AS project_id FROM outbox
         WHERE published_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ?`,
        now,
      )
      .toArray();
    let published = 0;
    for (const { project_id } of projects) {
      published += (await this.publishDue(project_id, now)).published;
    }
    return published;
  }

  /** Sends due rows for one project in a single batch and records the outcome per row. */
  async publishDue(
    projectId: string,
    now: number,
  ): Promise<{ published: number; pending: number }> {
    const producer = producerFor(this.env, projectId);
    if (!producer) return { published: 0, pending: 0 };

    const rows = this.sql
      .exec<OutboxRow>(
        `SELECT id, event_id, payload_json, attempt_count FROM outbox
         WHERE published_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ?
           AND json_extract(payload_json, '$.projectId') = ?
         ORDER BY id LIMIT ?`,
        now,
        projectId,
        BATCH_LIMIT,
      )
      .toArray();
    if (rows.length === 0) return { published: 0, pending: 0 };

    const encoder = new TextEncoder();
    let result: K2SendResult;
    try {
      result = await producer.send(
        rows.map((r) => ({
          content: encoder.encode(r.payload_json),
          headers: { "event-id": r.event_id },
        })),
      );
    } catch (error) {
      result = { success: false, error: { message: String(error), retryable: true } };
    }

    const stamp = new Date(now).toISOString();
    for (const row of rows) {
      const outcome = decideOutcome(row.attempt_count, result, now);
      if (outcome.kind === "published") {
        this.sql.exec(
          "UPDATE outbox SET published_at = ?, last_error = NULL WHERE id = ?",
          stamp,
          row.id,
        );
      } else if (outcome.kind === "retry") {
        this.sql.exec(
          "UPDATE outbox SET attempt_count = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
          outcome.attemptCount,
          outcome.nextAttemptAt,
          outcome.error,
          row.id,
        );
      } else {
        this.sql.exec(
          "UPDATE outbox SET attempt_count = ?, failed_at = ?, last_error = ? WHERE id = ?",
          outcome.attemptCount,
          stamp,
          outcome.error,
          row.id,
        );
        console.error(
          JSON.stringify({ event: "outbox.failed", eventId: row.event_id, error: outcome.error }),
        );
      }
    }
    if (result.success) await this.nudgeRouter(projectId);
    return { published: result.success ? rows.length : 0, pending: rows.length };
  }

  /** Asks the event router to consume this project's stream now. Best effort: cron is the backstop. */
  private async nudgeRouter(projectId: string) {
    const router = (this.env as unknown as K2Env).EVENT_ROUTER as EventRouterBinding | undefined;
    if (!router) return;
    try {
      await router.nudge(streamIndex(projectId));
    } catch (error) {
      console.warn(
        JSON.stringify({ event: "outbox.nudge_failed", error: String(error).slice(0, 200) }),
      );
    }
  }

  /** Unpublished rows (pending or failed), oldest first, for operators and tests. */
  pending(limit = 50): { eventId: string; eventType: string; attempts: number; failed: boolean }[] {
    return this.sql
      .exec<{
        event_id: string;
        event_type: string;
        attempt_count: number;
        failed_at: string | null;
      }>(
        "SELECT event_id, event_type, attempt_count, failed_at FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT ?",
        limit,
      )
      .toArray()
      .map((r) => ({
        eventId: r.event_id,
        eventType: r.event_type,
        attempts: r.attempt_count,
        failed: r.failed_at !== null,
      }));
  }
}
