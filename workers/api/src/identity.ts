/**
 * Maps a Clerk user to Rhumbatron identity rows. Each user gets one personal organization.
 * Organization membership and RBAC come later (AGENTS.md section 52).
 */

export type Identity = { userId: string; orgId: string };

/** Deterministic IDs keep the upsert idempotent across concurrent first requests. */
export async function ensureIdentity(db: D1Database, authSubject: string): Promise<Identity> {
  const userId = `usr_${authSubject}`;
  const orgId = `org_${authSubject}`;
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO users (id, auth_subject, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(userId, authSubject, now, now),
    db
      .prepare(
        "INSERT OR IGNORE INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(orgId, "Personal", now, now),
    db
      .prepare(
        "INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
      .bind(orgId, userId, now),
  ]);
  return { userId, orgId };
}

/** True when the user belongs to the organization that owns the project. */
export async function canAccessProject(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM projects p JOIN memberships m ON m.org_id = p.org_id
       WHERE p.id = ? AND m.user_id = ? LIMIT 1`,
    )
    .bind(projectId, userId)
    .first();
  return row !== null;
}
