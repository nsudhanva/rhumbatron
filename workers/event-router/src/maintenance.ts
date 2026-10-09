import type { CommandEnvelope } from "@rhumbatron/protocol";

/**
 * Daily maintenance on the existing safety-net cron (AGENTS.md section 43, HOM-195). Once a day it
 * queues one `forks.sweep` and re-queues `project.cleanup` for archived Projects that still have
 * leftovers. The integration Worker does the work, bounded per message. The same Projects get an
 * `index.purge` for rhumbatron-indexer (stored indexes and vectors), and up to 10 active Projects
 * without a ready index get a backfill `index.build`.
 * Cost per day: two D1 reads and at most 31 Queue messages. Subrequests: 4 on that one tick.
 */

/** 04:17 UTC: one tick of the every-minute cron. A missed tick skips one day, nothing else. */
const MAINTENANCE_MINUTE_UTC = 4 * 60 + 17;
const MAX_CLEANUPS_PER_DAY = 10;
/** Active Projects with no ready index that get an `index.build` backfill per day. */
const MAX_INDEX_BACKFILLS_PER_DAY = 10;

export function isMaintenanceTick(scheduledTime: number): boolean {
  const at = new Date(scheduledTime);
  return at.getUTCHours() * 60 + at.getUTCMinutes() === MAINTENANCE_MINUTE_UTC;
}

export async function queueMaintenance(
  env: Pick<Env, "DB" | "INTEGRATION_COMMANDS" | "INDEXING">,
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
  // The same archived Projects lose their stored indexes and Vectorize vectors (indexer). Active
  // Projects that have no ready index (source provisioned before the indexer existed, or a build
  // that failed) get a backfill build of their current canonical tree (no `treeSha`).
  const unindexed = await env.DB.prepare(
    `SELECT p.id FROM projects p WHERE p.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM project_indexes i WHERE i.project_id = p.id AND i.status = 'ready')
     ORDER BY p.created_at DESC LIMIT ?`,
  )
    .bind(MAX_INDEX_BACKFILLS_PER_DAY)
    .all<{ id: string }>();
  const indexing: CommandEnvelope<Record<string, never>>[] = [
    ...(rows.results ?? []).map((row) => ({
      commandId: `cmd_${row.id.slice(5)}_index-purge_${day}`,
      commandType: "index.purge",
      projectId: row.id,
      attempt: 0,
      createdAt,
      payload: {},
    })),
    ...(unindexed.results ?? []).map((row) => ({
      commandId: `cmd_${row.id.slice(5)}_index-backfill_${day}`,
      commandType: "index.build",
      projectId: row.id,
      attempt: 0,
      createdAt,
      payload: {},
    })),
  ];
  if (indexing.length > 0) {
    await env.INDEXING.sendBatch(indexing.map((body) => ({ body, contentType: "json" as const })));
  }
  return { cleanups: commands.length - 1 };
}
