import { type CommandEnvelope, RELEASE_STUCK_AFTER_MS } from "@rhumbatron/protocol";

/**
 * Daily maintenance on the safety-net cron. Once a day it queues one `forks.sweep` and re-queues
 * `project.cleanup` for archived Projects that still have leftovers. The integration Worker does
 * the work, bounded per message. The same Projects get an `index.purge` for rhumbatron-indexer
 * (stored indexes and vectors), and up to 10 active Projects without a ready index get a backfill
 * `index.build`.
 * Cost per day: three D1 reads and at most 31 Queue messages. Subrequests: 4 on that one tick.
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
  // Archived Projects whose cleanup is done but whose index rows remain: `purgeIndex` deletes those
  // rows last, so their presence means the vectors or index objects may still exist.
  const unpurged = await env.DB.prepare(
    `SELECT p.id FROM projects p WHERE p.status = 'archived' AND p.cleaned_at IS NOT NULL
       AND (EXISTS (SELECT 1 FROM project_indexes i WHERE i.project_id = p.id)
            OR EXISTS (SELECT 1 FROM project_vectors v WHERE v.project_id = p.id))
     ORDER BY p.archived_at LIMIT ?`,
  )
    .bind(MAX_CLEANUPS_PER_DAY)
    .all<{ id: string }>();
  const indexing: CommandEnvelope<Record<string, never>>[] = [
    ...[...(rows.results ?? []), ...(unpurged.results ?? [])].map((row) => ({
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
  // Consumer dedupe rows outlive K2 redelivery (7-day retention) by a margin, then go. Bounded so
  // one day never spends more than MAX_DEDUPE_PRUNE of the D1 daily write allowance.
  const cutoff = new Date(scheduledTime - DEDUPE_RETENTION_MS).toISOString();
  await env.DB.prepare(
    `DELETE FROM processed_events WHERE rowid IN
       (SELECT rowid FROM processed_events WHERE processed_at < ? ORDER BY processed_at LIMIT ?)`,
  )
    .bind(cutoff, MAX_DEDUPE_PRUNE)
    .run();
  return { cleanups: commands.length - 1 };
}

/** Twice the K2 retention: a redelivered event is still recognised. */
const DEDUPE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DEDUPE_PRUNE = 5000;

/**
 * Stuck-release sweep. Every 5 minutes (minute 4, 9, ... of the hour, never the daily maintenance
 * tick) one indexed read (`idx_changes_status_updated`) finds Changes still `releasing` after
 * RELEASE_STUCK_AFTER_MS, oldest first, and queues one `release.recover` per Change for the
 * integration Worker, which re-checks and decides.
 * Cost: 288 D1 reads per day; Queue messages only for stuck Changes. Subrequests: at most 2.
 */
const RELEASE_SWEEP_EVERY_MINUTES = 5;
const MAX_RELEASE_RECOVERIES_PER_SWEEP = 10;

export function isReleaseSweepTick(scheduledTime: number): boolean {
  const minute = new Date(scheduledTime).getUTCMinutes();
  return (
    minute % RELEASE_SWEEP_EVERY_MINUTES === RELEASE_SWEEP_EVERY_MINUTES - 1 &&
    !isMaintenanceTick(scheduledTime)
  );
}

export async function queueReleaseRecovery(
  env: Pick<Env, "DB" | "INTEGRATION_COMMANDS">,
  scheduledTime: number,
): Promise<{ stuck: number }> {
  const cutoff = new Date(scheduledTime - RELEASE_STUCK_AFTER_MS).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, project_id FROM changes WHERE status = 'releasing' AND updated_at < ?
     ORDER BY updated_at LIMIT ?`,
  )
    .bind(cutoff, MAX_RELEASE_RECOVERIES_PER_SWEEP)
    .all<{ id: string; project_id: string }>();
  const stuck = rows.results ?? [];
  if (stuck.length === 0) return { stuck: 0 };
  const createdAt = new Date(scheduledTime).toISOString();
  const tick = createdAt.slice(0, 16).replace(/[-:T]/g, "");
  const commands: CommandEnvelope<Record<string, never>>[] = stuck.map((row) => ({
    commandId: `cmd_${row.id.slice(4)}_release-recover_${tick}`,
    commandType: "release.recover",
    projectId: row.project_id,
    changeId: row.id,
    attempt: 0,
    createdAt,
    payload: {},
  }));
  await env.INTEGRATION_COMMANDS.sendBatch(
    commands.map((body) => ({ body, contentType: "json" as const })),
  );
  return { stuck: stuck.length };
}
