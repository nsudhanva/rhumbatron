import { ProjectRole } from "@rhumbatron/protocol";

/**
 * Maps a Clerk user to Rhumbatron identity rows. Each user gets one personal organization.
 * Access is per Project: `project_members` holds the role (ADR 0028).
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

/**
 * The caller's role in a Project (docs/architecture/shared-projects.md). `owner` for the owner row
 * or a member of the organization that owns the Project (personal organizations have one member).
 * Otherwise the role of the caller's `project_members` row: `admin`, `member`, or `viewer`. Null
 * when the user cannot open the Project. One D1 read. What a role may do is `can` in
 * `@rhumbatron/protocol` (roles.ts), the one permission matrix.
 */
export async function projectRole(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2) AS member_role,
         (SELECT 1 FROM projects p JOIN memberships m ON m.org_id = p.org_id
            WHERE p.id = ?1 AND m.user_id = ?2 LIMIT 1) AS org_member`,
    )
    .bind(projectId, userId)
    .first<{ member_role: string | null; org_member: number | null }>();
  if (row?.member_role === "owner" || row?.org_member) return "owner";
  const parsed = ProjectRole.safeParse(row?.member_role);
  return parsed.success ? parsed.data : null;
}

/** True when the user can open the Project: any role. */
export async function canAccessProject(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<boolean> {
  return (await projectRole(db, userId, projectId)) !== null;
}

/** SQL condition for "the user can open project p": bind the user ID twice. */
export const PROJECT_VISIBLE_SQL = `(EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = p.org_id AND m.user_id = ?)
  OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?))`;
