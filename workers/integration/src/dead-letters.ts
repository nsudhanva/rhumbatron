/**
 * A command that later succeeds closes its dead letter (AGENTS.md section 42.7): the operator
 * banner must not ask for a decision about work that already happened. Lifts only the blocks the
 * dead letter itself set. Never throws: a failure here must not fail the command.
 */
export async function resolveDeadLetter(db: D1Database, body: unknown) {
  const commandId = (body as { commandId?: unknown } | null)?.commandId;
  if (typeof commandId !== "string") return;
  try {
    const now = new Date().toISOString();
    const row = await db
      .prepare(
        `UPDATE dead_letters SET resolved_at = ?, resolved_by = 'system', resolution = 'succeeded'
         WHERE command_id = ? AND resolved_at IS NULL RETURNING change_id, task_id`,
      )
      .bind(now, commandId)
      .first<{ change_id: string | null; task_id: string | null }>();
    if (!row) return;
    const lifts: D1PreparedStatement[] = [];
    if (row.task_id) {
      lifts.push(
        db
          .prepare(
            `UPDATE tasks SET status = 'ready', blocked_limit = NULL, blocked_reason = NULL,
               updated_at = ?
             WHERE id = ? AND status = 'blocked' AND blocked_limit = 'dead_letter'`,
          )
          .bind(now, row.task_id),
      );
    }
    if (row.change_id) {
      lifts.push(
        db
          .prepare(
            `UPDATE changes SET blocked_limit = NULL, blocked_reason = NULL, updated_at = ?
             WHERE id = ? AND blocked_limit = 'dead_letter'
               AND NOT EXISTS (SELECT 1 FROM dead_letters
                 WHERE change_id = ? AND resolved_at IS NULL)`,
          )
          .bind(now, row.change_id, row.change_id),
      );
    }
    if (lifts.length > 0) await db.batch(lifts);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "dead_letter.resolve_failed",
        commandId,
        message: String(error).slice(0, 200),
      }),
    );
  }
}
