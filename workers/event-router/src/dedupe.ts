/**
 * Consumer-side dedupe in D1 (AGENTS.md sections 17.4 and 42.1). K2 delivers at least once.
 * One D1 batch is one subrequest, however many events it holds.
 */

/**
 * Records (consumer, eventId) rows with INSERT OR IGNORE and returns the event IDs whose row was
 * new. Only those events may be applied. An ID repeated inside one call is fresh only once.
 */
export async function claimEvents(
  db: D1Database,
  consumer: string,
  eventIds: readonly string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  const fresh = new Set<string>();
  if (eventIds.length === 0) return fresh;
  const processedAt = now.toISOString();
  const statements = eventIds.map((eventId) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO processed_events (consumer, event_id, processed_at) VALUES (?, ?, ?)",
      )
      .bind(consumer, eventId, processedAt),
  );
  const results = await db.batch(statements);
  results.forEach((result, index) => {
    const eventId = eventIds[index];
    if (eventId !== undefined && result.meta.changes > 0) fresh.add(eventId);
  });
  return fresh;
}

/**
 * Removes claims for events that were not applied (deferred by the subrequest cap, or the apply
 * failed), so redelivery can apply them. Without this a nacked batch would be skipped as duplicate.
 */
export async function releaseEvents(
  db: D1Database,
  consumer: string,
  eventIds: readonly string[],
): Promise<void> {
  if (eventIds.length === 0) return;
  await db.batch(
    eventIds.map((eventId) =>
      db
        .prepare("DELETE FROM processed_events WHERE consumer = ? AND event_id = ?")
        .bind(consumer, eventId),
    ),
  );
}
