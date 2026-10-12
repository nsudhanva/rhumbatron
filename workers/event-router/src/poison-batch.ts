import type { EventEnvelope } from "@rhumbatron/protocol";

/**
 * Bounded delivery for a K2 batch that keeps failing. K2 has no
 * delivery limit of its own: a nacked batch redelivers on every sweep and nudge, forever. The
 * router counts failed deliveries per (consumer, batch key) in D1 (migration 0016). At
 * MAX_BATCH_FAILURES it records the batch on the dead-letter path the Queues already use
 * (`dead_letters`, shown in the operator banner, dismiss only), marks the batch's events processed
 * so a redelivery is a duplicate, and acknowledges it.
 *
 * Idempotent: the dead-letter row is keyed by consumer and batch key and is written once; the
 * processed-event claims are INSERT OR IGNORE. A crash between the writes and the ack redelivers a
 * batch whose events are all duplicates, which the router then acknowledges as a no-op.
 * Cost: one D1 batch per failed delivery, one more when the batch is dead-lettered.
 */

/** Failed deliveries before a batch is skipped: about 5 sweeps, under an hour per stream. */
export const MAX_BATCH_FAILURES = 5;

/** Queue key of a K2 batch in `dead_letters`. The API cannot retry it; an operator dismisses it. */
export const deadLetterQueue = (consumer: string) => `k2-${consumer}`;

/** Skip the batch once it has failed this often. */
export const shouldSkipBatch = (failures: number) => failures >= MAX_BATCH_FAILURES;

/**
 * Stable key of a delivered batch: SHA-256 of its first record. K2 redelivers from the oldest
 * unacknowledged record, so later records joining the batch do not change the key.
 */
export async function batchKey(records: readonly { content: string }[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(records[0]?.content ?? ""),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Counts one failed delivery and returns the total so far. One D1 batch. */
export async function countBatchFailure(
  db: D1Database,
  consumer: string,
  key: string,
  error: string,
  now: string,
): Promise<number> {
  const [, read] = await db.batch([
    db
      .prepare(
        `INSERT INTO k2_batch_failures (consumer, batch_key, failures, first_failed_at, last_failed_at, last_error)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT (consumer, batch_key) DO UPDATE SET
           failures = k2_batch_failures.failures + 1, last_failed_at = excluded.last_failed_at,
           last_error = excluded.last_error`,
      )
      .bind(consumer, key, now, now, error.slice(0, 500)),
    db
      .prepare("SELECT failures FROM k2_batch_failures WHERE consumer = ? AND batch_key = ?")
      .bind(consumer, key),
  ]);
  const row = (read?.results as { failures: number }[] | undefined)?.[0];
  if (!row) throw new Error("k2 batch failure row missing after upsert");
  return row.failures;
}

export type PoisonBatch = {
  consumer: string;
  stream: number;
  key: string;
  events: readonly EventEnvelope[];
  records: number;
  failures: number;
  error: string;
};

/**
 * Records a skipped batch in `dead_letters` and marks its events processed for `consumer`, in one
 * D1 batch (one transaction). Safe to repeat.
 */
export async function deadLetterBatch(db: D1Database, batch: PoisonBatch, now: string) {
  const eventIds = [...new Set(batch.events.map((e) => e.eventId))];
  const payload = {
    consumer: batch.consumer,
    stream: batch.stream,
    batchKey: batch.key,
    records: batch.records,
    eventIds,
  };
  const error = `K2 batch on stream ${batch.stream} failed ${batch.failures} deliveries to ${batch.consumer} and was skipped. Last error: ${batch.error.slice(0, 300)}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO dead_letters (id, command_id, command_type, queue, project_id, change_id, task_id,
           payload_json, error, attempt, dead_count, first_seen_at, last_seen_at)
         VALUES (?, ?, 'k2.batch', ?, ?, NULL, NULL, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (command_id) DO NOTHING`,
      )
      .bind(
        `dl_${crypto.randomUUID().replaceAll("-", "")}`,
        `k2:${batch.consumer}:${batch.key}`,
        deadLetterQueue(batch.consumer),
        batch.events[0]?.projectId ?? null,
        JSON.stringify(payload),
        error,
        batch.failures,
        now,
        now,
      ),
    ...eventIds.map((eventId) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO processed_events (consumer, event_id, processed_at) VALUES (?, ?, ?)",
        )
        .bind(batch.consumer, eventId, now),
    ),
  ]);
}
