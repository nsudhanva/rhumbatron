import type { CommandEnvelope } from "@rhumbatron/protocol";

/**
 * Daily maintenance on the existing safety-net cron (AGENTS.md section 43, HOM-195). Once a day it
 * queues one `forks.sweep` and re-queues `project.cleanup` for archived Projects that still have
 * leftovers. The integration Worker does the work, bounded per message.
 * Cost per day: one D1 read and at most 11 Queue messages. Subrequests: 2 on that one tick.
 */

/** 04:17 UTC: one tick of the every-minute cron. A missed tick skips one day, nothing else. */
const MAINTENANCE_MINUTE_UTC = 4 * 60 + 17;
const MAX_CLEANUPS_PER_DAY = 10;

export function isMaintenanceTick(scheduledTime: number): boolean {
  const at = new Date(scheduledTime);
  return at.getUTCHours() * 60 + at.getUTCMinutes() === MAINTENANCE_MINUTE_UTC;
}

export async function queueMaintenance(
  env: Pick<Env, "DB" | "INTEGRATION_COMMANDS">,
  scheduledTime: number,
): Promise<{ cleanups: number }> {
  const createdAt = new Date(scheduledTime).toISOString();
  const day = createdAt.slice(0, 10);
  const rows = await env.DB.prepare(
    `SELECT id FROM projects WHERE status = 'archived' AND cleaned_at IS NULL
     ORDER BY archived_at LIMIT ?`,
  )
    .bind(MAX_CLEANUPS_PER_DAY)
    .all<{ id: string }>();
  const commands: CommandEnvelope<Record<string, never>>[] = [
    {
      commandId: `cmd_forks-sweep_${day}`,
      commandType: "forks.sweep",
      // Not a Project command: the sweep covers every active Project.
      projectId: "system",
      attempt: 0,
      createdAt,
      payload: {},
    },
    ...(rows.results ?? []).map((row) => ({
      commandId: `cmd_${row.id.slice(5)}_cleanup_${day}`,
      commandType: "project.cleanup",
      projectId: row.id,
      attempt: 0,
      createdAt,
      payload: {},
    })),
  ];
  await env.INTEGRATION_COMMANDS.sendBatch(
    commands.map((body) => ({ body, contentType: "json" as const })),
  );
  return { cleanups: commands.length - 1 };
}
