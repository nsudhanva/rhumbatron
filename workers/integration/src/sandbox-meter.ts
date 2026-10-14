/**
 * The monthly Sandbox meter (`usage_counters`, counter `sandbox-seconds`, ADR 0017). One container
 * per Project (`proj-<project>`) serves the agents' workspaces, the Candidate checks, and the code
 * sessions, and Cloudflare bills its awake time. A use reserves seconds before it starts (the cap
 * stops new work), and its settle refunds the reservation and charges only the time the use adds
 * to the container's awake block (`sandbox_awake`): overlapping uses and their idle tails count
 * once. One D1 batch, so concurrent settles of one container serialize.
 */

const month = () => new Date().toISOString().slice(0, 7);

/** Idle time a container stays awake after its last use, before it sleeps. */
export const SANDBOX_SLEEP_TAIL_SECONDS = 120;
/** The fallback cap when the `SANDBOX_MONTHLY_SECONDS` binding is absent: 10 hours. */
const FALLBACK_MONTHLY_SECONDS = 36_000;

export const sandboxMonthlySeconds = (configured?: string) => {
  const n = Number(configured);
  return configured && Number.isInteger(n) && n > 0 ? n : FALLBACK_MONTHLY_SECONDS;
};

/** The container name of a Project (`getSandbox` key). */
export const sandboxContainer = (projectId: string) => `proj-${projectId.slice(5)}`;

/** Reserves seconds on the monthly meter. False when the cap would be passed. */
export async function reserveSandboxSeconds(
  db: D1Database,
  seconds: number,
  configuredMonthlySeconds?: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?1, 'sandbox-seconds', ?2)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + ?2 WHERE count + ?2 <= ?3
       RETURNING count`,
    )
    .bind(month(), seconds, sandboxMonthlySeconds(configuredMonthlySeconds))
    .first<{ count: number }>();
  return row !== null;
}

/**
 * Pure: the seconds a use [startedAt, endedAt] (plus the idle tail) adds to an awake block, and
 * the block after it. A use that starts after the block ended opens a new block.
 */
export function awakeCharge(
  block: { from: number; until: number } | null,
  use: { startedAt: number; endedAt: number },
): { seconds: number; block: { from: number; until: number } } {
  const until = use.endedAt + SANDBOX_SLEEP_TAIL_SECONDS * 1000;
  if (!block || use.startedAt > block.until) {
    return {
      seconds: Math.ceil(Math.max(0, until - use.startedAt) / 1000),
      block: { from: use.startedAt, until },
    };
  }
  const added = Math.max(0, block.from - use.startedAt) + Math.max(0, until - block.until);
  return {
    seconds: Math.ceil(added / 1000),
    block: { from: Math.min(block.from, use.startedAt), until: Math.max(block.until, until) },
  };
}

/**
 * Settles one use of a Project's container: refunds `reservedSeconds` and charges the awake time
 * the use adds (`awakeCharge`), in one batch. The meter never goes below zero.
 */
export async function settleSandboxUse(
  db: D1Database,
  input: { projectId: string; startedAt: number; endedAt: number; reservedSeconds: number },
): Promise<void> {
  const container = sandboxContainer(input.projectId);
  const until = input.endedAt + SANDBOX_SLEEP_TAIL_SECONDS * 1000;
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO sandbox_awake (container, awake_from, awake_until) VALUES (?1, ?2, ?2)",
      )
      .bind(container, input.startedAt),
    db
      .prepare(
        `UPDATE usage_counters SET count = MAX(0, count - ?1 + (
           SELECT CAST((CASE WHEN ?2 > awake_until THEN MAX(0, ?3 - ?2)
             ELSE MAX(0, awake_from - ?2) + MAX(0, ?3 - awake_until) END + 999) / 1000 AS INTEGER)
           FROM sandbox_awake WHERE container = ?4))
         WHERE day = ?5 AND counter = 'sandbox-seconds'`,
      )
      .bind(input.reservedSeconds, input.startedAt, until, container, month()),
    db
      .prepare(
        `UPDATE sandbox_awake SET
           awake_from = CASE WHEN ?1 > awake_until THEN ?1 ELSE MIN(awake_from, ?1) END,
           awake_until = CASE WHEN ?1 > awake_until THEN ?2 ELSE MAX(awake_until, ?2) END
         WHERE container = ?3`,
      )
      .bind(input.startedAt, until, container),
  ]);
}

/** Returns a reservation whose use never started. The meter never goes below zero. */
export async function refundSandboxSeconds(db: D1Database, seconds: number): Promise<void> {
  if (seconds <= 0) return;
  await db
    .prepare(
      "UPDATE usage_counters SET count = MAX(0, count - ?1) WHERE day = ?2 AND counter = 'sandbox-seconds'",
    )
    .bind(seconds, month())
    .run();
}
