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

/** The caller's role in a Project (docs/architecture/shared-projects.md). */
export type ProjectRole = "owner" | "collaborator";

/**
 * `owner` for the Project's owner row or a member of the organization that owns it (personal
 * organizations have one member). `collaborator` for a user the owner shared the Project with.
 * Null when the user cannot open the Project. One D1 read.
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
  if (row?.member_role === "collaborator") return "collaborator";
  return null;
}

/** True when the user can open the Project: its owner or a collaborator. */
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

/** The reply for an action only the Project owner can take. */
export function ownerOnlyMessage(action: string): string {
  return `Only the project owner can ${action}. Ask the owner, or send a request instead.`;
}
