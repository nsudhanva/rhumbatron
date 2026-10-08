/** Pure migration planning for scripts/d1-migrate.ts. No I/O, so it is unit tested. */

export type LocalMigration = { name: string; sha256: string; sql: string };
export type AppliedMigration = { name: string; sha256: string | null };

export type MigrationPlan = { pending: LocalMigration[]; errors: string[] };

export const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Returns the migrations to apply, in order, or errors that must stop the run:
 * a bad file name, an applied migration whose file is gone, or an applied migration that was edited.
 */
export function planMigrations(
  local: LocalMigration[],
  applied: AppliedMigration[],
): MigrationPlan {
  const errors: string[] = [];
  const localByName = new Map(local.map((m) => [m.name, m]));
  const appliedNames = new Set(applied.map((m) => m.name));

  for (const m of local) {
    if (!MIGRATION_NAME.test(m.name))
      errors.push(`${m.name}: name must match NNNN_description.sql`);
  }
  for (const a of applied) {
    const file = localByName.get(a.name);
    if (!file) errors.push(`${a.name}: applied remotely but missing locally`);
    else if (a.sha256 && a.sha256 !== file.sha256)
      errors.push(`${a.name}: edited after it was applied`);
  }

  const pending = local
    .filter((m) => !appliedNames.has(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { pending, errors };
}
