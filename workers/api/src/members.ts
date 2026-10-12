import { createClerkClient } from "@clerk/backend";
import { ChangeClarification, changeTitle } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { clarify } from "./clarify.ts";
import { fail, validate } from "./http.ts";
import { ensureIdentity, ownerOnlyMessage, projectRole } from "./identity.ts";

/**
 * Shared Projects (docs/architecture/shared-projects.md).
 *
 * The owner shares a Project by email. An invitation binds only to a Clerk-verified email of the
 * signed-in user, and the membership binds to the immutable user ID. `rank` only orders the member
 * list (the owner is 0, a collaborator 10). No build decision reads it: the system decides
 * between requests (ADR 0025).
 *
 * Also the request views: who asked for a Change, how the intake gate and the cross-request check
 * decided it, and the clarification route (clarify.ts, mounted here).
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const COLLABORATOR_RANK = 10;
const INVITATION_DAYS = 7;

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });
const InvitationParam = z.object({ invitationId: z.string().regex(/^inv_[a-f0-9]{32}$/) });
const MemberParam = ProjectIdParam.extend({ userId: z.string().regex(/^usr_[A-Za-z0-9_]+$/) });
const InviteRequest = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

/** Internal RPC on the integration Worker (service binding `INTEGRATION`). */
type IntegrationRpc = {
  cancelChange(input: { changeId: string; actorUserId: string }): Promise<unknown>;
};
const integration = (env: Env) => env.INTEGRATION as unknown as IntegrationRpc;

/* ------------------------------------------------------------------------------------------ */
/* Profiles                                                                                   */
/* ------------------------------------------------------------------------------------------ */

type Profile = { name: string | null; primaryEmail: string | null; verifiedEmails: string[] };

/** The caller's Clerk profile. Verified emails only: the invitation match uses nothing else. */
async function clerkProfile(env: Env, authSubject: string): Promise<Profile> {
  const user = await createClerkClient({ secretKey: env.CLERK_SECRET_KEY }).users.getUser(
    authSubject,
  );
  const verifiedEmails = user.emailAddresses
    .filter((e) => e.verification?.status === "verified")
    .map((e) => e.emailAddress.toLowerCase());
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return {
    name: fullName || user.username || null,
    primaryEmail: user.primaryEmailAddress?.emailAddress ?? null,
    verifiedEmails,
  };
}

/** Stores the display name and email, so requests and member lists show a person. */
async function rememberProfile(env: Env, userId: string, profile: Profile) {
  await env.DB.prepare(
    `UPDATE users SET display_name = COALESCE(?, display_name), email = COALESCE(?, email),
       updated_at = ? WHERE id = ?`,
  )
    .bind(
      profile.name?.slice(0, 120) ?? null,
      profile.primaryEmail?.slice(0, 254) ?? null,
      new Date().toISOString(),
      userId,
    )
    .run();
}

/**
 * Fills the caller's display name once (no Clerk call when it is known). Display data only; a
 * failure never blocks the request.
 */
export async function ensureProfile(env: Env, userId: string, authSubject: string) {
  try {
    const row = await env.DB.prepare("SELECT display_name, email FROM users WHERE id = ?")
      .bind(userId)
      .first<{ display_name: string | null; email: string | null }>();
    if (!row || (row.display_name && row.email)) return;
    await rememberProfile(env, userId, await clerkProfile(env, authSubject));
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "profile.lookup_failed", message: String(error).slice(0, 200) }),
    );
  }
}

/** A person's label: display name, else the email's local part, else null. */
function requesterName(name: string | null, email: string | null): string | null {
  return name ?? (email ? (email.split("@")[0] ?? email) : null);
}

/* ------------------------------------------------------------------------------------------ */
/* Request fields on Change rows                                                              */
/* ------------------------------------------------------------------------------------------ */

/** The Change columns the request fields need (join `users u ON u.id = c.created_by`). */
export type RequestColumns = {
  created_by: string;
  /** Role snapshot at request time, display only. */
  requester_rank: number | null;
  /** Set while the Change is `needs_input`. A query that does not select it reads null. */
  clarification_json?: string | null;
  /** Stored title of the clarification's related Change. A query that does not select it reads null. */
  related_title?: string | null;
  outcome: string | null;
  outcome_reason: string | null;
  outcome_winner_change_id: string | null;
  outcome_decided_by: string | null;
  supersedes_change_id: string | null;
  display_name: string | null;
  email: string | null;
};

/** Select expression for `related_title` on a Change row aliased `c`. */
export const RELATED_TITLE = `(SELECT o.title FROM changes o
  WHERE o.id = json_extract(c.clarification_json, '$.relatedChangeId')) AS related_title`;

const OUTCOMES = new Set([
  "selected",
  "partially_selected",
  "not_selected",
  "replaces",
  "duplicate",
]);

/** The stored clarification, or null when there is none or it does not parse. */
function clarificationOf(
  json: string | null | undefined,
  relatedTitle: string | null | undefined,
): ChangeClarification | null {
  if (!json) return null;
  try {
    const parsed = ChangeClarification.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    const { relatedGoal } = parsed.data;
    return {
      ...parsed.data,
      relatedTitle: relatedGoal ? changeTitle(relatedTitle, relatedGoal) : null,
    };
  } catch {
    return null;
  }
}

export function requestFields(row: RequestColumns, viewerUserId: string) {
  return {
    requester: {
      userId: row.created_by,
      name: requesterName(row.display_name, row.email),
      rank: row.requester_rank,
      isYou: row.created_by === viewerUserId,
    },
    outcome:
      row.outcome && OUTCOMES.has(row.outcome)
        ? {
            kind: row.outcome as
              | "selected"
              | "partially_selected"
              | "not_selected"
              | "replaces"
              | "duplicate",
            reason: row.outcome_reason,
            winnerChangeId: row.outcome_winner_change_id,
            decidedBy: row.outcome_decided_by,
          }
        : null,
    supersedesChangeId: row.supersedes_change_id,
    clarification: clarificationOf(row.clarification_json, row.related_title),
  };
}

/**
 * Conflicting criterion pairs with their text. `criteria_json` holds `{ a, b, why }` with criterion
 * IDs (a is change_a); the review inputs hold each side's `{ id, text }` list.
 */
function citedCriteria(
  criteriaJson: string | null,
  reviewJson: string | null,
  changeA: string | null,
  changeB: string | null,
) {
  type Pair = { a?: unknown; b?: unknown; why?: unknown };
  type Side = { changeId?: string; criteria?: { id?: unknown; text?: unknown }[] };
  let pairs: Pair[] = [];
  let inputs: { a?: Side; b?: Side } = {};
  try {
    pairs = JSON.parse(criteriaJson ?? "[]") as Pair[];
    const stored = JSON.parse(reviewJson ?? "{}") as {
      inputs?: typeof inputs;
      review?: { verdict?: string; covered?: { a?: unknown; b?: unknown; quote?: unknown }[] };
    };
    inputs = stored.inputs ?? {};
    // A duplicate cites, for each criterion of the later request, the earlier criterion that
    // already delivers it. Orient it like criteria_json: `a` belongs to change_a.
    if (stored.review?.verdict === "duplicate" && Array.isArray(stored.review.covered)) {
      const flip = inputs.a?.changeId !== changeA;
      pairs = stored.review.covered.map((c) => ({
        a: flip ? c.b : c.a,
        b: flip ? c.a : c.b,
        why: typeof c.quote === "string" ? `Already covered: "${c.quote}"` : "Already covered",
      }));
    }
  } catch {
    return [];
  }
  const text = new Map<string, string>();
  for (const side of [inputs.a, inputs.b]) {
    for (const c of side?.criteria ?? []) {
      if (typeof c.id === "string" && typeof c.text === "string") {
        text.set(`${side?.changeId}:${c.id}`, c.text);
      }
    }
  }
  // Both sides number criteria c1..cn, so the lookup is per Change: `a` IDs belong to change_a.
  const find = (changeId: string | null, id: unknown) =>
    typeof id === "string" ? (text.get(`${changeId}:${id}`) ?? null) : null;
  return (Array.isArray(pairs) ? pairs : []).slice(0, 30).map((p) => ({
    a: typeof p.a === "string" ? p.a : "",
    b: typeof p.b === "string" ? p.b : "",
    why: typeof p.why === "string" ? p.why : "",
    aText: find(changeA, p.a),
    bText: find(changeB, p.b),
  }));
}

/* ------------------------------------------------------------------------------------------ */
/* Routes                                                                                     */
/* ------------------------------------------------------------------------------------------ */

const newInvitationId = () => `inv_${crypto.randomUUID().replaceAll("-", "")}`;

export const members = new Hono<AppEnv>()
  /** `POST /v1/changes/:changeId/clarify` (clarify.ts). */
  .route("/", clarify)
  /** Members of a shared Project. The owner also sees pending invitations. */
  .get(
    "/v1/projects/:projectId/members",
    requireAuth,
    validate("param", ProjectIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      const role = await projectRole(c.env.DB, userId, projectId);
      if (!role) return fail(c, 404, "not_found", "Project not found");
      const [rows, invites] = await c.env.DB.batch([
        c.env.DB.prepare(
          `SELECT pm.user_id, pm.role, pm.rank, pm.created_at, u.display_name, u.email
           FROM project_members pm LEFT JOIN users u ON u.id = pm.user_id
           WHERE pm.project_id = ? ORDER BY pm.rank, pm.created_at`,
        ).bind(projectId),
        c.env.DB.prepare(
          `SELECT id, email, created_at, expires_at FROM project_invitations
           WHERE project_id = ? AND status = 'pending' AND expires_at > ?
           ORDER BY created_at`,
        ).bind(projectId, new Date().toISOString()),
      ]);
      type MemberRow = {
        user_id: string;
        role: string;
        rank: number;
        created_at: string;
        display_name: string | null;
        email: string | null;
      };
      type InviteRow = { id: string; email: string; created_at: string; expires_at: string };
      return c.json({
        data: {
          role,
          members: ((rows?.results ?? []) as MemberRow[]).map((m) => ({
            userId: m.user_id,
            name: requesterName(m.display_name, m.email),
            email: role === "owner" || m.user_id === userId ? m.email : null,
            role: m.role,
            rank: m.rank,
            isYou: m.user_id === userId,
            addedAt: m.created_at,
          })),
          invitations:
            role === "owner"
              ? ((invites?.results ?? []) as InviteRow[]).map((i) => ({
                  id: i.id,
                  email: i.email,
                  createdAt: i.created_at,
                  expiresAt: i.expires_at,
                }))
              : [],
        },
      });
    },
  )

  /** The owner invites a person by email. A repeat for the same pending email returns it. */
  .post(
    "/v1/projects/:projectId/invitations",
    requireAuth,
    validate("param", ProjectIdParam),
    validate("json", InviteRequest),
    async (c) => {
      const authSubject = c.get("authSubject");
      const { userId } = await ensureIdentity(c.env.DB, authSubject);
      const { projectId } = c.req.valid("param");
      const { email } = c.req.valid("json");
      const role = await projectRole(c.env.DB, userId, projectId);
      if (!role) return fail(c, 404, "not_found", "Project not found");
      if (role !== "owner") return fail(c, 403, "forbidden", ownerOnlyMessage("share it"));
      const project = await c.env.DB.prepare("SELECT status FROM projects WHERE id = ?")
        .bind(projectId)
        .first<{ status: string }>();
      if (project?.status !== "active") {
        return fail(c, 409, "conflict", "Project is archived");
      }
      const already = await c.env.DB.prepare(
        `SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ? AND lower(u.email) = ?`,
      )
        .bind(projectId, email)
        .first();
      if (already) return fail(c, 409, "conflict", `${email} already has access`);
      await ensureProfile(c.env, userId, authSubject);
      const now = new Date();
      const expires = new Date(now.getTime() + INVITATION_DAYS * 86_400_000);
      // Expired pending rows would block the partial unique index: revoke them first.
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE project_invitations SET status = 'revoked'
           WHERE project_id = ? AND email = ? AND status = 'pending' AND expires_at <= ?`,
        ).bind(projectId, email, now.toISOString()),
        c.env.DB.prepare(
          `INSERT INTO project_invitations
             (id, project_id, email, role, rank, invited_by, status, created_at, expires_at)
           VALUES (?, ?, ?, 'collaborator', ?, ?, 'pending', ?, ?)
           ON CONFLICT DO NOTHING`,
        ).bind(
          newInvitationId(),
          projectId,
          email,
          COLLABORATOR_RANK,
          userId,
          now.toISOString(),
          expires.toISOString(),
        ),
      ]);
      const row = await c.env.DB.prepare(
        `SELECT id, email, created_at, expires_at FROM project_invitations
         WHERE project_id = ? AND email = ? AND status = 'pending'`,
      )
        .bind(projectId, email)
        .first<{ id: string; email: string; created_at: string; expires_at: string }>();
      if (!row) throw new Error("Invitation was not readable after creation");
      return c.json(
        {
          data: {
            id: row.id,
            email: row.email,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          },
        },
        201,
      );
    },
  )

  /** The owner revokes a pending invitation. Safe to repeat. */
  .delete(
    "/v1/projects/:projectId/invitations/:invitationId",
    requireAuth,
    validate("param", ProjectIdParam.merge(InvitationParam)),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId, invitationId } = c.req.valid("param");
      const role = await projectRole(c.env.DB, userId, projectId);
      if (!role) return fail(c, 404, "not_found", "Project not found");
      if (role !== "owner") return fail(c, 403, "forbidden", ownerOnlyMessage("manage sharing"));
      const revoked = await c.env.DB.prepare(
        `UPDATE project_invitations SET status = 'revoked'
         WHERE id = ? AND project_id = ? AND status = 'pending'`,
      )
        .bind(invitationId, projectId)
        .run();
      if ((revoked.meta.changes ?? 0) === 0) {
        // A repeat on an already revoked invitation of this Project stays 200.
        const prior = await c.env.DB.prepare(
          `SELECT 1 AS found FROM project_invitations
           WHERE id = ? AND project_id = ? AND status = 'revoked'`,
        )
          .bind(invitationId, projectId)
          .first();
        if (!prior) return fail(c, 404, "not_found", "Invitation not found");
      }
      return c.json({ data: { id: invitationId, status: "revoked" } });
    },
  )

  /**
   * The owner removes a collaborator, or a collaborator removes themselves (leaves). The owner row
   * cannot be removed. A leaver's open requests are cancelled through the same integration command
   * as `POST /v1/changes/:changeId/cancel`; their past Changes stay with the Project.
   */
  .delete(
    "/v1/projects/:projectId/members/:userId",
    requireAuth,
    validate("param", MemberParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId, userId: member } = c.req.valid("param");
      const role = await projectRole(c.env.DB, userId, projectId);
      if (!role) return fail(c, 404, "not_found", "Project not found");
      const leaving = role === "collaborator" && member === userId;
      if (role !== "owner" && !leaving) {
        return fail(c, 403, "forbidden", ownerOnlyMessage("manage sharing"));
      }
      if (leaving) {
        const open = await c.env.DB.prepare(
          `SELECT id FROM changes WHERE project_id = ? AND created_by = ?
             AND status NOT IN ('completed', 'cancelled', 'failed', 'not_selected',
                                'promoting', 'releasing')`,
        )
          .bind(projectId, userId)
          .all<{ id: string }>();
        // A refused cancel (the Change moved on) is fine; a thrown error fails the leave, so a
        // retry cancels the rest while the membership still exists.
        for (const { id } of open.results ?? []) {
          await integration(c.env).cancelChange({ changeId: id, actorUserId: userId });
        }
      }
      const removed = await c.env.DB.prepare(
        `DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role = 'collaborator'`,
      )
        .bind(projectId, member)
        .run();
      if ((removed.meta.changes ?? 0) === 0) {
        return fail(c, 404, "not_found", "Collaborator not found");
      }
      return c.json({ data: { userId: member, removed: true } });
    },
  )

  /** Pending invitations for the caller's verified emails. */
  .get("/v1/invitations", requireAuth, async (c) => {
    const authSubject = c.get("authSubject");
    const { userId } = await ensureIdentity(c.env.DB, authSubject);
    const profile = await clerkProfile(c.env, authSubject);
    await rememberProfile(c.env, userId, profile);
    if (profile.verifiedEmails.length === 0) return c.json({ data: [] });
    const marks = profile.verifiedEmails.map(() => "?").join(", ");
    const rows = await c.env.DB.prepare(
      `SELECT i.id, i.project_id, i.created_at, i.expires_at, p.name AS project_name,
              u.display_name, u.email AS inviter_email
       FROM project_invitations i
       JOIN projects p ON p.id = i.project_id AND p.status = 'active'
       LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.status = 'pending' AND i.expires_at > ? AND i.email IN (${marks})
         AND NOT EXISTS (SELECT 1 FROM project_members pm
                         WHERE pm.project_id = i.project_id AND pm.user_id = ?)
       ORDER BY i.created_at DESC LIMIT 20`,
    )
      .bind(new Date().toISOString(), ...profile.verifiedEmails, userId)
      .all<{
        id: string;
        project_id: string;
        created_at: string;
        expires_at: string;
        project_name: string;
        display_name: string | null;
        inviter_email: string | null;
      }>();
    return c.json({
      data: (rows.results ?? []).map((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectName: r.project_name,
        invitedBy: requesterName(r.display_name, r.inviter_email),
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      })),
    });
  })

  /** Accepts an invitation addressed to one of the caller's verified emails. Idempotent. */
  .post(
    "/v1/invitations/:invitationId/accept",
    requireAuth,
    validate("param", InvitationParam),
    async (c) => {
      const authSubject = c.get("authSubject");
      const { userId } = await ensureIdentity(c.env.DB, authSubject);
      const { invitationId } = c.req.valid("param");
      const invite = await c.env.DB.prepare(
        `SELECT id, project_id, email, rank, invited_by, status, accepted_user_id, expires_at
         FROM project_invitations WHERE id = ?`,
      )
        .bind(invitationId)
        .first<{
          id: string;
          project_id: string;
          email: string;
          rank: number;
          invited_by: string;
          status: string;
          accepted_user_id: string | null;
          expires_at: string;
        }>();
      if (!invite) return fail(c, 404, "not_found", "Invitation not found");
      if (invite.status === "accepted" && invite.accepted_user_id === userId) {
        return c.json({ data: { projectId: invite.project_id, role: "collaborator" } });
      }
      const profile = await clerkProfile(c.env, authSubject);
      // Not addressed to a verified email of this user: the same answer as a missing invitation.
      if (!profile.verifiedEmails.includes(invite.email)) {
        return fail(c, 404, "not_found", "Invitation not found");
      }
      const now = new Date().toISOString();
      if (invite.status !== "pending" || invite.expires_at <= now) {
        return fail(c, 409, "conflict", "This invitation is no longer valid. Ask for a new one.");
      }
      await rememberProfile(c.env, userId, profile);
      // The status guard makes acceptance happen once; the member insert is idempotent.
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO project_members (project_id, user_id, role, rank, added_by, created_at)
           SELECT ?, ?, 'collaborator', ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM project_invitations WHERE id = ? AND status = 'pending')`,
        ).bind(invite.project_id, userId, invite.rank, invite.invited_by, now, invite.id),
        c.env.DB.prepare(
          `UPDATE project_invitations SET status = 'accepted', accepted_user_id = ?, accepted_at = ?
           WHERE id = ? AND status = 'pending'`,
        ).bind(userId, now, invite.id),
      ]);
      const role = await projectRole(c.env.DB, userId, invite.project_id);
      if (!role) return fail(c, 409, "conflict", "This invitation is no longer valid.");
      return c.json({ data: { projectId: invite.project_id, role } });
    },
  )

  /** Cross-request conflicts and duplicates of one Change: both goals and titles, and the cited criteria. */
  .get(
    "/v1/changes/:changeId/request-conflicts",
    requireAuth,
    validate("param", ChangeIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      const change = await c.env.DB.prepare("SELECT project_id FROM changes WHERE id = ?")
        .bind(changeId)
        .first<{ project_id: string }>();
      if (!change || !(await projectRole(c.env.DB, userId, change.project_id))) {
        return fail(c, 404, "not_found", "Change not found");
      }
      const rows = await c.env.DB.prepare(
        `SELECT r.id, r.verdict, r.round, r.criteria_json, r.review_json, r.policy, r.winner_change_id, r.loser_change_id,
                r.decided_by, r.decided_at, r.created_at,
                a.id AS a_id, a.goal AS a_goal, a.title AS a_title, a.status AS a_status, a.created_by AS a_by,
                ua.display_name AS a_name, ua.email AS a_email,
                b.id AS b_id, b.goal AS b_goal, b.title AS b_title, b.status AS b_status, b.created_by AS b_by,
                ub.display_name AS b_name, ub.email AS b_email
         FROM request_conflicts r
         JOIN changes a ON a.id = r.change_a LEFT JOIN users ua ON ua.id = a.created_by
         JOIN changes b ON b.id = r.change_b LEFT JOIN users ub ON ub.id = b.created_by
         WHERE (r.change_a = ?1 OR r.change_b = ?1) AND r.verdict IN ('conflicting', 'duplicate')
         ORDER BY r.created_at DESC LIMIT 10`,
      )
        .bind(changeId)
        .all<Record<string, string | null>>();
      const side = (r: Record<string, string | null>, k: "a" | "b") => ({
        changeId: r[`${k}_id`],
        goal: r[`${k}_goal`],
        title: changeTitle(r[`${k}_title`], r[`${k}_goal`] ?? ""),
        status: r[`${k}_status`],
        requester: {
          userId: r[`${k}_by`],
          name: requesterName(r[`${k}_name`] ?? null, r[`${k}_email`] ?? null),
          isYou: r[`${k}_by`] === userId,
        },
      });
      return c.json({
        data: (rows.results ?? []).map((r) => ({
          id: r.id,
          verdict: r.verdict,
          /** Clarification round of the later request when the pair was compared (0 first). */
          round: Number(r.round ?? 0),
          criteria: citedCriteria(
            r.criteria_json ?? null,
            r.review_json ?? null,
            r.a_id ?? null,
            r.b_id ?? null,
          ),
          policy: r.policy,
          winnerChangeId: r.winner_change_id,
          loserChangeId: r.loser_change_id,
          decidedBy: r.decided_by,
          decidedAt: r.decided_at,
          a: side(r, "a"),
          b: side(r, "b"),
        })),
      });
    },
  );
