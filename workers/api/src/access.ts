import type { AccessStatus } from "@rhumbatron/protocol";
import type { Context } from "hono";
import type { AuthVariables } from "./auth.ts";
import { errorBody } from "./http.ts";

/**
 * Platform access (ADR 0033, docs/architecture/shared-projects.md "Access gate").
 *
 * - A platform admin is a user ID in the `PLATFORM_ADMIN_USER_IDS` binding (a JSON array). The API
 *   compares it with the user ID of the verified session only, never with a request field.
 * - `accessGate` runs in `requireAuth` after the session check. It creates the user row on the
 *   first request: `pending` while `signup_approval_required` is "true", else `approved`. A
 *   platform admin is always approved. A person who is not approved gets 403 `approval_required`
 *   on every route except `GET /v1/me`.
 *
 * Cost per authenticated request: one D1 query (two primary-key reads). A new user adds one
 * write and one read. `last_seen_at` is written at most once per hour per user.
 */

const USER_ID = /^usr_[A-Za-z0-9_]+$/;
const SEEN_INTERVAL_MS = 60 * 60 * 1000;

/** Setting key of the sign-up approval switch in `platform_settings`. */
export const SIGNUP_APPROVAL_KEY = "signup_approval_required";

/**
 * The platform admin user IDs. An unset, malformed, or non-array value gives no admin: the check
 * fails closed.
 */
export function platformAdminIds(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && USER_ID.test(id)));
  } catch {
    console.warn(JSON.stringify({ event: "platform_admin.config_invalid" }));
    return new Set();
  }
}

/** True when the session user is a platform admin. */
export const isPlatformAdmin = (env: Pick<Env, "PLATFORM_ADMIN_USER_IDS">, userId: string) =>
  platformAdminIds(env.PLATFORM_ADMIN_USER_IDS).has(userId);

/** The only route that a person who is not approved can call. */
const accessExempt = (method: string, path: string) => method === "GET" && path === "/v1/me";

type GateRow = { status: string | null; last_seen_at: string | null; approval: string | null };

const isStatus = (s: string | null): s is AccessStatus =>
  s === "approved" || s === "pending" || s === "declined";

/**
 * The access status of the user, after the user row exists. A new user row gets `pending` while
 * sign-up approval is on, unless the user is a platform admin. A concurrent first request inserts
 * nothing (the row already exists) and reads the stored status.
 */
async function resolveAccess(
  db: D1Database,
  input: { userId: string; authSubject: string; admin: boolean; now: Date },
): Promise<{ status: AccessStatus; lastSeenAt: string | null }> {
  const row = await db
    .prepare(
      `SELECT (SELECT access_status FROM users WHERE id = ?1) AS status,
              (SELECT last_seen_at FROM users WHERE id = ?1) AS last_seen_at,
              (SELECT value FROM platform_settings WHERE key = ?2) AS approval`,
    )
    .bind(input.userId, SIGNUP_APPROVAL_KEY)
    .first<GateRow>();
  if (row && isStatus(row.status)) {
    return { status: input.admin ? "approved" : row.status, lastSeenAt: row.last_seen_at };
  }
  if (row?.status != null) {
    // A stored value outside the enum: refuse, never approve.
    return { status: "declined", lastSeenAt: row.last_seen_at };
  }
  const at = input.now.toISOString();
  const initial: AccessStatus = !input.admin && row?.approval === "true" ? "pending" : "approved";
  await db
    .prepare(
      `INSERT INTO users (id, auth_subject, access_status, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(input.userId, input.authSubject, initial, at, at, at)
    .run();
  const stored = await db
    .prepare("SELECT access_status AS status FROM users WHERE id = ?")
    .bind(input.userId)
    .first<{ status: string | null }>();
  const status = isStatus(stored?.status ?? null) ? (stored?.status as AccessStatus) : "declined";
  return { status: input.admin ? "approved" : status, lastSeenAt: at };
}

/** Writes `last_seen_at` when it is older than one hour. Display data: a failure is logged. */
async function touchLastSeen(db: D1Database, userId: string, now: Date) {
  try {
    await db
      .prepare("UPDATE users SET last_seen_at = ? WHERE id = ?")
      .bind(now.toISOString(), userId)
      .run();
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "access.last_seen_failed", message: String(error).slice(0, 200) }),
    );
  }
}

function later(c: Context, task: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No ExecutionContext (tests): the task runs without a wait.
  }
}

/**
 * The access gate. Returns the 403 response for a refused request, or null to continue. The
 * caller has verified the session and passes its subject.
 */
export async function accessGate(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  authSubject: string,
): Promise<Response | null> {
  const userId = `usr_${authSubject}`;
  const now = new Date();
  const admin = isPlatformAdmin(c.env, userId);
  const { status, lastSeenAt } = await resolveAccess(c.env.DB, {
    userId,
    authSubject,
    admin,
    now,
  });
  if (!lastSeenAt || now.getTime() - Date.parse(lastSeenAt) > SEEN_INTERVAL_MS) {
    later(c, touchLastSeen(c.env.DB, userId, now));
  }
  if (status === "approved" || accessExempt(c.req.method, c.req.path)) return null;
  const message =
    status === "pending" ? "Your account is waiting for approval" : "Your account was not approved";
  return c.json(errorBody("approval_required", message, { status }), 403);
}

/* ------------------------------------------------------------------------------------------ */
/* Admin audit                                                                                 */
/* ------------------------------------------------------------------------------------------ */

const AUDIT_RETENTION_DAYS = 365;

/** Statements that record one admin action and delete audit rows past the retention. */
export function auditStatements(
  db: D1Database,
  input: { adminUserId: string; action: string; target: string | null; now: Date },
): D1PreparedStatement[] {
  const cutoff = new Date(input.now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000).toISOString();
  return [
    db
      .prepare(
        "INSERT INTO admin_audit (id, admin_user_id, action, target, at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        `aud_${crypto.randomUUID().replaceAll("-", "")}`,
        input.adminUserId,
        input.action,
        input.target?.slice(0, 300) ?? null,
        input.now.toISOString(),
      ),
    db.prepare("DELETE FROM admin_audit WHERE at < ?").bind(cutoff),
  ];
}
