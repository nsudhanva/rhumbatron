import { apiData, changeTitle } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { isPlatformAdmin } from "./access.ts";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { respond, validate } from "./http.ts";
import { ensureIdentity } from "./identity.ts";

/**
 * In-app inbox. Notifications are derived on each read
 * from authoritative D1 rows; there is no separate event pipeline and nothing to fall out of
 * sync. An action item exists exactly while its condition holds: an `approval_required` item
 * disappears once the approval is recorded. The only stored state is the per-user read mark
 * (`notification_reads`, migration 0012), which clears the unread dot and never hides an item.
 *
 * Access: every query joins `memberships` on the caller's user ID, the same rule as
 * `canAccessProject`, so a user never sees another tenant's rows. Archived Projects are skipped.
 *
 * Cost: one D1 batch of 16 capped SELECTs per read, 17 for a platform admin (list and count share
 * it), plus the 3-statement `ensureIdentity` batch. Each SELECT starts from a rare state (verified Candidates, open dead
 * letters, blocked Changes, confirmed conflicts, requests that need input or review) or a 7-day window through an index, so rows read
 * scale with open and recent items, not with history. Marking read writes one row per new mark.
 * Promotion still re-checks everything: a notification is a pointer, never a gate.
 *
 * Platform access (ADR 0033): a platform admin also gets `access_request` for each pending person
 * (one more SELECT through `idx_users_access_created`). Each person gets `access_decided` for 7
 * days after an admin decides their access (one primary-key read). These items have no Project:
 * `projectId` is empty and `projectName` is "Rhumbatron".
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const NotificationKind = z.enum([
  "approval_required",
  "promotion_ready",
  "dead_letter",
  "budget_blocked",
  "candidate_rejected",
  "conflict_open",
  "change_completed",
  "promoted",
  "release_failed",
  "release_deployed",
  "request_not_selected",
  "request_needs_input",
  "request_proposed",
  "request_included",
  "request_declined",
  "request_choice_needed",
  "request_choice_made",
  "access_request",
  "access_decided",
]);
type NotificationKind = z.infer<typeof NotificationKind>;

const NotificationSeverity = z.enum(["action", "attention", "info"]);
type NotificationSeverity = z.infer<typeof NotificationSeverity>;

export const NotificationView = z.object({
  /** Stable: `<kind>:<entity id>`, plus an occurrence suffix for items that can reopen. */
  id: z.string(),
  kind: NotificationKind,
  severity: NotificationSeverity,
  title: z.string(),
  body: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  changeId: z.string().optional(),
  candidateId: z.string().optional(),
  /** App path to open, for example `/candidates/<id>`. */
  href: z.string(),
  createdAt: z.string(),
  read: z.boolean(),
});
export type NotificationView = z.infer<typeof NotificationView>;

const CountView = z.object({
  /** Items without a read mark, all severities. */
  unread: z.number().int(),
  /** Open action items (read or not): they need a person until their condition clears. */
  action: z.number().int(),
});

/** Rows per kind. More than this many open items of one kind is an incident, not an inbox. */
const PER_KIND = 50;
/** Info and attention items about finished work stay listed this long. */
const RECENT_DAYS = 7;
/** Read marks older than this are deleted when the user marks items read. */
const READ_RETENTION_DAYS = 30;
const MAX_MARK = 200;

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const NotificationId = z
  .string()
  .max(160)
  .regex(/^[a-z_]+:[A-Za-z0-9_:-]+$/);
const ReadBody = z.object({
  ids: z.union([z.literal("all"), z.array(NotificationId).min(1).max(MAX_MARK)]),
});

/* ------------------------------------------------------------------------------------------ */
/* Derivation                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Caller scope, joined after the driving table. `?1` is the user ID. Organization membership or a
 * shared-Project membership, both primary-key lookups: the same rule as `canAccessProject`.
 *
 * `CROSS JOIN` pins SQLite's join order (it never reorders across one). D1 has no statistics for
 * the planner, which otherwise starts from every active Project of every tenant. Each query
 * starts instead from the rarest side: a status or window index, or the caller's memberships.
 * The unary `+` on `p.status` keeps the planner off the low-selectivity status index.
 */
const MINE = (projectColumn: string) => `CROSS JOIN projects p ON p.id = ${projectColumn}
  AND +p.status = 'active'
  AND (EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = p.org_id AND m.user_id = ?1)
    OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?1))`;
/** Change statuses after which nothing in the Change can still be decided or promoted. */
const CLOSED = `('completed', 'cancelled', 'failed', 'promoting', 'releasing')`;
const ENDED = `('completed', 'cancelled', 'failed')`;
const read = (alias: string, idSql: string) =>
  `LEFT JOIN notification_reads ${alias} ON ${alias}.user_id = ?1 AND ${alias}.notification_id = ${idSql}`;

/** True for the Project owner or an admin (`change.manageAny`, `change.review`). `?1` = user. */
const MANAGES = `(EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = p.org_id AND m.user_id = ?1)
  OR EXISTS (SELECT 1 FROM project_members pm
             WHERE pm.project_id = p.id AND pm.user_id = ?1 AND pm.role IN ('owner', 'admin')))`;

/**
 * Verified Candidates of open Changes: `approval_required` (plan gates on a human, no decision
 * yet) or `promotion_ready` (approved, or no gate). A rejected approval yields neither. A
 * Candidate whose base is behind a later promotion in the same Project is stale-to-be: skipped.
 * (D1 `projects.canonical_generation` is not the canonical truth; ProjectRootDO is. Promotion
 * re-checks it with compare-and-swap.) Audience: the people who can approve and ship (the
 * Project owner and the admins, `candidate.promote`), and the requester. `status_reason` states
 * why the Candidate waits.
 */
const VERIFIED_SQL = `
SELECT c.id AS candidate_id, c.change_id, ch.project_id, p.name AS project_name, ch.goal, ch.title,
       ch.risk_tier, c.base_generation, c.updated_at, c.status_reason, ${MANAGES} AS manages,
       json_extract(c.plan_json, '$.humanApprovalRequired') AS approval_required,
       json_extract(c.score_json, '$.promotable') AS promotable,
       a.decision AS approval_decision, a.created_at AS approval_at,
       ra.read_at AS approval_read, rp.read_at AS promote_read
FROM candidates c
CROSS JOIN changes ch ON ch.id = c.change_id
${MINE("ch.project_id")}
LEFT JOIN approvals a ON a.candidate_id = c.id
${read("ra", `'approval_required:' || c.id`)}
${read("rp", `'promotion_ready:' || c.id`)}
WHERE c.status = 'verified' AND ch.status NOT IN ${CLOSED}
  AND (ch.created_by = ?1 OR ${MANAGES})
  AND NOT EXISTS (
    SELECT 1 FROM candidates c2 CROSS JOIN changes ch2 ON ch2.id = c2.change_id
    WHERE c2.status = 'promoted' AND c2.updated_at >= c.created_at
      AND ch2.project_id = ch.project_id AND c2.promoted_generation > c.base_generation)
ORDER BY c.updated_at DESC LIMIT ${PER_KIND}`;

/**
 * Open dead letters, from the caller's Projects (the open-row index is per Project). The id
 * carries `dead_count`: a retried command that fails again is a new item.
 */
const DEAD_LETTER_SQL = `
SELECT d.id, d.command_type, d.change_id, d.project_id, p.name AS project_name, d.error,
       d.dead_count, d.last_seen_at, t.title AS task_title, r.read_at
FROM memberships m
CROSS JOIN projects p ON p.org_id = m.org_id AND +p.status = 'active'
CROSS JOIN dead_letters d ON d.project_id = p.id
LEFT JOIN tasks t ON t.id = d.task_id
${read("r", `'dead_letter:' || d.id || ':' || d.dead_count`)}
WHERE m.user_id = ?1 AND d.resolved_at IS NULL
ORDER BY d.last_seen_at DESC LIMIT ${PER_KIND}`;

/**
 * Changes a budget or another Project limit stopped. Dead-letter blocks are the dead letter's own
 * item. The id carries the limit, so a new stop on the same Change is a new item.
 */
const blockedPart = (where: string) => `
SELECT ch.id, ch.project_id, p.name AS project_name, ch.goal, ch.title, ch.status, ch.blocked_limit,
       ch.blocked_reason, ch.budget_usd, ch.updated_at AS updated_at, r.read_at
FROM changes ch
${MINE("ch.project_id")}
${read("r", `'budget_blocked:' || ch.id || ':' || COALESCE(ch.blocked_limit, 'budget')`)}
WHERE ${where}`;
const BLOCKED_SQL = `${blockedPart("ch.status = 'budget_blocked'")}
UNION ALL${blockedPart(
  `ch.blocked_limit IS NOT NULL AND ch.blocked_limit != 'dead_letter'
  AND ch.status NOT IN ('budget_blocked', 'completed', 'cancelled', 'failed')`,
)}
ORDER BY updated_at DESC LIMIT ${PER_KIND}`;

/** Candidates in a final state within the window: `rejected` and `promoted`. `?2` = since. */
const finishedCandidates = (status: "rejected" | "promoted", kind: NotificationKind) => `
SELECT c.id AS candidate_id, c.change_id, ch.project_id, p.name AS project_name, ch.goal, ch.title,
       c.status_reason, c.promoted_generation, c.base_generation, c.updated_at, r.read_at
FROM candidates c
CROSS JOIN changes ch ON ch.id = c.change_id
${MINE("ch.project_id")}
${read("r", `'${kind}:' || c.id`)}
WHERE c.status = '${status}' AND c.updated_at >= ?2
ORDER BY c.updated_at DESC LIMIT ${PER_KIND}`;

/** Confirmed semantic conflicts of Changes that can still act on them. */
const CONFLICT_SQL = `
SELECT cf.id, cf.change_id, ch.project_id, p.name AS project_name, cf.resource, cf.updated_at,
       json_extract(cf.intents_json, '$[0].summary') AS left_summary,
       json_extract(cf.intents_json, '$[1].summary') AS right_summary, r.read_at
FROM conflicts cf
CROSS JOIN changes ch ON ch.id = cf.change_id
${MINE("ch.project_id")}
${read("r", `'conflict_open:' || cf.id`)}
WHERE cf.state IN ('confirmed', 'fork_required') AND ch.status NOT IN ${ENDED}
ORDER BY cf.updated_at DESC LIMIT ${PER_KIND}`;

/** Changes completed within the window. */
const COMPLETED_SQL = `
SELECT ch.id, ch.project_id, p.name AS project_name, ch.goal, ch.title, ch.updated_at, r.read_at
FROM changes ch
${MINE("ch.project_id")}
${read("r", `'change_completed:' || ch.id`)}
WHERE ch.status = 'completed' AND ch.updated_at >= ?2
ORDER BY ch.updated_at DESC LIMIT ${PER_KIND}`;

/**
 * Releases that finished within the window (ADR 0020): deployed, or failed (no bundle, a
 * pointer that did not move, or smoke failure). Superseded releases are not news. `?2` = since.
 * Starts from `idx_releases_status_finished`.
 */
const RELEASES_SQL = `
SELECT r.id, r.project_id, p.name AS project_name, r.change_id, r.candidate_id, r.generation,
       r.status, r.failure_reason, r.version_id, r.finished_at, r.read_at
FROM (
  SELECT rel.*, rr.read_at FROM releases rel
  LEFT JOIN notification_reads rr ON rr.user_id = ?1 AND rr.notification_id =
    (CASE WHEN rel.status = 'deployed' THEN 'release_deployed:' ELSE 'release_failed:' END) || rel.id
  WHERE rel.status IN ('deployed', 'failed', 'smoke_failed') AND rel.finished_at >= ?2
) r
${MINE("r.project_id")}
ORDER BY r.finished_at DESC LIMIT ${PER_KIND}`;

/**
 * Shared-Project requests (docs/architecture/shared-projects.md). Starts from the Change status
 * index. `request_not_selected`: the requester only (`ch.created_by = ?1`). Within the window.
 * `?2` = since.
 */
const NOT_SELECTED_SQL = `
SELECT ch.id, ch.project_id, p.name AS project_name, ch.goal, ch.title, ch.outcome_reason, ch.updated_at,
       r.read_at
FROM changes ch
${MINE("ch.project_id")}
${read("r", `'request_not_selected:' || ch.id`)}
WHERE ch.status = 'not_selected' AND ch.outcome = 'not_selected' AND ch.created_by = ?1
  AND ch.updated_at >= ?2
ORDER BY ch.updated_at DESC LIMIT ${PER_KIND}`;

/**
 * request_needs_input (ADR 0025): the requester; for a conflict also the Project owner and the
 * admins (owner or admin member row, or organization member: the `projectRole` rule). An action
 * item while the status holds. The ID carries the round, so a new question of the same Change is
 * a new item.
 */
const NEEDS_INPUT_SQL = `
SELECT ch.id, ch.project_id, p.name AS project_name, ch.goal, ch.title, ch.updated_at,
       ch.clarification_json, r.read_at
FROM changes ch
${MINE("ch.project_id")}
${read("r", `'request_needs_input:' || ch.id || ':' || COALESCE(json_extract(ch.clarification_json, '$.round'), 1)`)}
WHERE ch.status = 'needs_input'
  AND (ch.created_by = ?1
    OR (json_extract(ch.clarification_json, '$.kind') = 'conflict' AND ${MANAGES}))
ORDER BY ch.updated_at DESC LIMIT ${PER_KIND}`;

/**
 * request_proposed (ADR 0028): a member's request waits for review. The Project owner and the
 * admins, not the requester. An action item while the Change is `proposed`.
 */
const PROPOSED_SQL = `
SELECT ch.id, ch.project_id, p.name AS project_name, ch.goal, ch.title, ch.updated_at,
       u.display_name, u.email, r.read_at
FROM changes ch
${MINE("ch.project_id")}
LEFT JOIN users u ON u.id = ch.created_by
${read("r", `'request_proposed:' || ch.id`)}
WHERE ch.status = 'proposed' AND ch.created_by <> ?1 AND ${MANAGES}
ORDER BY ch.updated_at DESC LIMIT ${PER_KIND}`;

/**
 * request_included and request_declined: the requester, within the window, after an owner or
 * admin decided. `?2` = since. Starts from `idx_changes_review_decided`.
 */
const reviewedPart = (state: "included" | "declined") => `
SELECT ch.id, ch.project_id, p.name AS project_name, ch.goal, ch.title,
       ch.review_decided_at AS updated_at, ch.review_reason AS outcome_reason, r.read_at
FROM changes ch
${MINE("ch.project_id")}
${read("r", `'request_${state}:' || ch.id`)}
WHERE ch.review_state = '${state}' AND ch.review_decided_at >= ?2 AND ch.created_by = ?1
ORDER BY ch.review_decided_at DESC LIMIT ${PER_KIND}`;

type Base = { project_id: string; project_name: string; read_at?: string | null };
type VerifiedRow = Base & {
  candidate_id: string;
  change_id: string;
  goal: string;
  title: string | null;
  risk_tier: string | null;
  base_generation: number;
  updated_at: string;
  status_reason: string | null;
  /** 1 when the caller is the Project owner or an admin: they approve and ship. */
  manages: number;
  approval_required: number | null;
  promotable: number | null;
  approval_decision: "granted" | "rejected" | null;
  approval_at: string | null;
  approval_read: string | null;
  promote_read: string | null;
};
type DeadLetterRow = Base & {
  id: string;
  command_type: string;
  change_id: string | null;
  error: string;
  dead_count: number;
  last_seen_at: string;
  task_title: string | null;
};
type BlockedRow = Base & {
  id: string;
  goal: string;
  title: string | null;
  status: string;
  blocked_limit: string | null;
  blocked_reason: string | null;
  budget_usd: number;
  updated_at: string;
};
type FinishedRow = Base & {
  candidate_id: string;
  change_id: string;
  goal: string;
  title: string | null;
  status_reason: string | null;
  promoted_generation: number | null;
  base_generation: number;
  updated_at: string;
};
type ConflictRow = Base & {
  id: string;
  change_id: string;
  resource: string;
  updated_at: string;
  left_summary: string | null;
  right_summary: string | null;
};
type CompletedRow = Base & { id: string; goal: string; title: string | null; updated_at: string };
type NeedsInputRow = CompletedRow & { clarification_json: string | null };
type ReleaseRow = Base & {
  id: string;
  change_id: string;
  candidate_id: string;
  generation: number;
  status: "deployed" | "failed" | "smoke_failed";
  failure_reason: string | null;
  version_id: string | null;
  finished_at: string;
};

type NotSelectedRow = Base & {
  id: string;
  goal: string;
  title: string | null;
  outcome_reason: string | null;
  updated_at: string;
};

const clip = (text: string, max = 180) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
const joinParts = (...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => !!p && p.trim() !== "").join(" · ");

const project = (row: Base) => ({ projectId: row.project_id, projectName: row.project_name });

function verifiedItem(row: VerifiedRow): NotificationView | null {
  if (row.promotable === 0) return null;
  const gated = row.approval_required === 1;
  const manages = row.manages === 1;
  // The requester who cannot ship is told what the request waits for; an owner or admin acts.
  const severity = manages ? ("action" as const) : ("attention" as const);
  const base = {
    ...project(row),
    changeId: row.change_id,
    candidateId: row.candidate_id,
    href: `/changes/${row.change_id}`,
  };
  if (gated && row.approval_decision === null) {
    const tier = row.risk_tier ?? "this";
    return {
      ...base,
      id: `approval_required:${row.candidate_id}`,
      kind: "approval_required",
      severity,
      title: manages
        ? "Approval needed to ship a Candidate"
        : "Your request waits for an owner or admin to approve it",
      body: joinParts(
        changeTitle(row.title, row.goal),
        clip(row.status_reason ?? `Policy requires a human decision for ${tier}-risk Changes`, 200),
      ),
      createdAt: row.updated_at,
      read: row.approval_read !== null,
    };
  }
  if (gated && row.approval_decision !== "granted") return null;
  const next = row.base_generation + 1;
  return {
    ...base,
    id: `promotion_ready:${row.candidate_id}`,
    kind: "promotion_ready",
    severity,
    title: manages
      ? `Ready to ship: S${row.base_generation} → S${next}`
      : `Your request waits for an owner or admin to ship it: S${row.base_generation} → S${next}`,
    body: joinParts(
      changeTitle(row.title, row.goal),
      gated ? "Approved" : clip(row.status_reason ?? "Verified, no approval required", 200),
    ),
    createdAt:
      row.approval_at && row.approval_at > row.updated_at ? row.approval_at : row.updated_at,
    read: row.promote_read !== null,
  };
}

function deadLetterItem(row: DeadLetterRow): NotificationView {
  return {
    ...project(row),
    ...(row.change_id ? { changeId: row.change_id } : {}),
    id: `dead_letter:${row.id}:${row.dead_count}`,
    kind: "dead_letter",
    severity: "action",
    title: `Command failed after retries: ${row.command_type}`,
    body: joinParts(row.task_title, clip(row.error, 140), "Retry or dismiss it"),
    href: row.change_id ? `/changes/${row.change_id}` : `/projects/${row.project_id}`,
    createdAt: row.last_seen_at,
    read: !!row.read_at,
  };
}

function blockedItem(row: BlockedRow): NotificationView {
  const limit = row.blocked_limit ?? "budget";
  const reason =
    row.blocked_reason ??
    (row.blocked_limit
      ? `Stopped by limit ${row.blocked_limit}`
      : `Change budget of $${row.budget_usd.toFixed(2)} reached`);
  return {
    ...project(row),
    changeId: row.id,
    id: `budget_blocked:${row.id}:${limit}`,
    kind: "budget_blocked",
    severity: "attention",
    title:
      row.status === "budget_blocked"
        ? "Change stopped: budget reached"
        : "Change stopped by a limit",
    body: joinParts(clip(reason, 160), changeTitle(row.title, row.goal)),
    href: `/changes/${row.id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

function rejectedItem(row: FinishedRow): NotificationView {
  return {
    ...project(row),
    changeId: row.change_id,
    candidateId: row.candidate_id,
    id: `candidate_rejected:${row.candidate_id}`,
    kind: "candidate_rejected",
    severity: "attention",
    title: "Candidate rejected",
    body: joinParts(
      clip(row.status_reason ?? "Rejected by verification", 160),
      changeTitle(row.title, row.goal),
    ),
    href: `/candidates/${row.candidate_id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

function promotedItem(row: FinishedRow): NotificationView {
  const to = row.promoted_generation ?? row.base_generation + 1;
  return {
    ...project(row),
    changeId: row.change_id,
    candidateId: row.candidate_id,
    id: `promoted:${row.candidate_id}`,
    kind: "promoted",
    severity: "info",
    title: `Promoted: S${to - 1} → S${to}`,
    body: changeTitle(row.title, row.goal),
    href: `/candidates/${row.candidate_id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

function conflictItem(row: ConflictRow): NotificationView {
  const versus =
    row.left_summary && row.right_summary
      ? `${clip(row.left_summary, 80)} vs ${clip(row.right_summary, 80)}`
      : null;
  return {
    ...project(row),
    changeId: row.change_id,
    id: `conflict_open:${row.id}`,
    kind: "conflict_open",
    severity: "attention",
    title: `Design conflict on ${row.resource}`,
    body: versus ?? "Two Intents make incompatible assumptions",
    href: `/changes/${row.change_id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

function completedItem(row: CompletedRow): NotificationView {
  return {
    ...project(row),
    changeId: row.id,
    id: `change_completed:${row.id}`,
    kind: "change_completed",
    severity: "info",
    title: "Change completed",
    body: changeTitle(row.title, row.goal),
    href: `/changes/${row.id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

function releaseItem(row: ReleaseRow): NotificationView {
  const base = {
    ...project(row),
    changeId: row.change_id,
    candidateId: row.candidate_id,
    href: `/candidates/${row.candidate_id}`,
    createdAt: row.finished_at,
    read: !!row.read_at,
  };
  if (row.status === "deployed") {
    return {
      ...base,
      id: `release_deployed:${row.id}`,
      kind: "release_deployed",
      severity: "info",
      title: `Released S${row.generation}`,
      body: joinParts(
        row.version_id ? `Version ${row.version_id.slice(0, 8)}` : null,
        "Smoke check passed",
      ),
    };
  }
  return {
    ...base,
    id: `release_failed:${row.id}`,
    kind: "release_failed",
    severity: "attention",
    title:
      row.status === "smoke_failed"
        ? `Release of S${row.generation} failed its smoke check`
        : `Release of S${row.generation} did not deploy`,
    body: joinParts(
      clip(row.failure_reason ?? "No reason recorded", 160),
      `S${row.generation} stays canonical; recover with a new promotion`,
    ),
  };
}

function notSelectedItem(row: NotSelectedRow): NotificationView {
  return {
    ...project(row),
    changeId: row.id,
    id: `request_not_selected:${row.id}`,
    kind: "request_not_selected",
    severity: "attention",
    title: "Your request was not selected",
    body: joinParts(
      clip(row.outcome_reason ?? "Another request was chosen instead", 160),
      changeTitle(row.title, row.goal),
    ),
    href: `/changes/${row.id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

function needsInputItem(row: NeedsInputRow): NotificationView {
  let clarification: { kind?: string; round?: number; summary?: string } = {};
  try {
    clarification = JSON.parse(row.clarification_json ?? "{}") as typeof clarification;
  } catch {
    clarification = {};
  }
  const title =
    clarification.kind === "duplicate"
      ? "Your request looks like one that exists"
      : clarification.kind === "conflict"
        ? "A request conflicts with another request"
        : "Your request needs more detail";
  return {
    ...project(row),
    changeId: row.id,
    id: `request_needs_input:${row.id}:${clarification.round ?? 1}`,
    kind: "request_needs_input",
    severity: "action",
    title,
    body: joinParts(clip(clarification.summary ?? "", 160), changeTitle(row.title, row.goal)),
    href: `/changes/${row.id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

type ProposedRow = CompletedRow & { display_name: string | null; email: string | null };

function proposedItem(row: ProposedRow): NotificationView {
  const who = row.display_name ?? (row.email ? (row.email.split("@")[0] ?? null) : null);
  return {
    ...project(row),
    changeId: row.id,
    id: `request_proposed:${row.id}`,
    kind: "request_proposed",
    severity: "action",
    title: "A request waits for your review",
    body: joinParts(who ? `From ${who}` : null, changeTitle(row.title, row.goal)),
    href: `/changes/${row.id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

function reviewedItem(row: NotSelectedRow, state: "included" | "declined"): NotificationView {
  return {
    ...project(row),
    changeId: row.id,
    id: `request_${state}:${row.id}`,
    kind: state === "included" ? "request_included" : "request_declined",
    severity: state === "included" ? "info" : "attention",
    title: state === "included" ? "Your request was included" : "Your request was declined",
    body: joinParts(
      state === "declined" ? clip(row.outcome_reason ?? "No reason given", 160) : null,
      changeTitle(row.title, row.goal),
    ),
    href: `/changes/${row.id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

/**
 * request_choice_needed (ADR 0032): a later request of another person conflicts with the caller's
 * request and waits for the caller's choice. Only the earlier requester (`asked_user_id = ?1`). An
 * action item while the choice is open. Links to the caller's own Change, where the choice is made.
 */
const CHOICE_NEEDED_SQL = `
SELECT w.id, w.first_change_id, w.later_change_id, l.project_id, p.name AS project_name,
       l.goal, l.title, w.created_at AS updated_at, ul.display_name, ul.email, r.read_at
FROM request_choices w
CROSS JOIN changes l ON l.id = w.later_change_id
${MINE("l.project_id")}
LEFT JOIN users ul ON ul.id = l.created_by
${read("r", `'request_choice_needed:' || w.id`)}
WHERE w.asked_user_id = ?1 AND w.choice IS NULL AND l.status IN ('awaiting_choice', 'queued')
ORDER BY w.created_at DESC LIMIT ${PER_KIND}`;

/**
 * request_choice_made: the later requester, within the window, after the earlier requester chose
 * "apply theirs", or after the system queued a request that builds on the earlier one
 * (`chosen_by` = `system:builds_on`). "Keep mine" ends the request: `request_not_selected` covers
 * it. `?2` = since.
 */
const CHOICE_MADE_SQL = `
SELECT w.id, w.later_change_id, l.project_id, p.name AS project_name, l.goal, l.title,
       w.chosen_at AS updated_at, w.chosen_by, uf.display_name, uf.email, r.read_at
FROM request_choices w
CROSS JOIN changes l ON l.id = w.later_change_id
${MINE("l.project_id")}
LEFT JOIN users uf ON uf.id = w.asked_user_id
${read("r", `'request_choice_made:' || w.id`)}
WHERE w.choice = 'apply_theirs' AND w.chosen_at >= ?2 AND l.created_by = ?1
ORDER BY w.chosen_at DESC LIMIT ${PER_KIND}`;

type ChoiceRow = Base & {
  id: string;
  first_change_id?: string;
  later_change_id: string;
  goal: string;
  title: string | null;
  updated_at: string;
  display_name: string | null;
  email: string | null;
  chosen_by?: string | null;
};
const personOf = (row: ChoiceRow) =>
  row.display_name ?? (row.email ? (row.email.split("@")[0] ?? null) : null);

function choiceNeededItem(row: ChoiceRow): NotificationView {
  const who = personOf(row) ?? "Another person";
  return {
    ...project(row),
    changeId: row.later_change_id,
    id: `request_choice_needed:${row.id}`,
    kind: "request_choice_needed",
    severity: "action",
    title: `${who}'s request conflicts with yours`,
    body: joinParts(
      "Keep your version, or apply theirs after yours",
      changeTitle(row.title, row.goal),
    ),
    href: `/changes/${row.first_change_id ?? row.later_change_id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

function choiceMadeItem(row: ChoiceRow): NotificationView {
  const who = personOf(row) ?? "The first requester";
  const follows = row.chosen_by === "system:builds_on";
  return {
    ...project(row),
    changeId: row.later_change_id,
    id: `request_choice_made:${row.id}`,
    kind: "request_choice_made",
    severity: "info",
    title: follows
      ? `Your request builds on ${who === "The first requester" ? "an earlier request" : `${who}'s request`}`
      : `${who} will apply your request after theirs`,
    body: joinParts("It plans when their request finishes", changeTitle(row.title, row.goal)),
    href: `/changes/${row.later_change_id}`,
    createdAt: row.updated_at,
    read: !!row.read_at,
  };
}

/** Pending people, for a platform admin only. `?1` = the admin (read marks). */
const ACCESS_REQUEST_SQL = `
SELECT u.id, u.display_name, u.email, u.created_at, r.read_at
FROM users u
${read("r", `'access_request:' || u.id`)}
WHERE u.access_status = 'pending'
ORDER BY u.created_at DESC LIMIT ${PER_KIND}`;

/** The caller's own access decision, within the window. `?1` = user, `?2` = since. */
const ACCESS_DECIDED_SQL = `
SELECT u.id, u.access_status, u.access_decided_at, r.read_at
FROM users u
${read("r", `'access_decided:' || u.id`)}
WHERE u.id = ?1 AND u.access_decided_at >= ?2 AND u.access_status IN ('approved', 'declined')`;

type AccessRequestRow = {
  id: string;
  display_name: string | null;
  email: string | null;
  created_at: string;
  read_at: string | null;
};
type AccessDecidedRow = {
  id: string;
  access_status: string;
  access_decided_at: string;
  read_at: string | null;
};

/** Platform items have no Project. */
const PLATFORM = { projectId: "", projectName: "Rhumbatron" };

function accessRequestItem(row: AccessRequestRow): NotificationView {
  const who = row.display_name ?? row.email ?? row.id;
  return {
    ...PLATFORM,
    id: `access_request:${row.id}`,
    kind: "access_request",
    severity: "action",
    title: "A person waits for access",
    body: joinParts(who, row.email && row.email !== who ? row.email : null),
    href: "/admin/access",
    createdAt: row.created_at,
    read: !!row.read_at,
  };
}

function accessDecidedItem(row: AccessDecidedRow): NotificationView {
  return {
    ...PLATFORM,
    id: `access_decided:${row.id}`,
    kind: "access_decided",
    severity: "info",
    title:
      row.access_status === "approved"
        ? "Your account was approved"
        : "Your account was not approved",
    body: row.access_status === "approved" ? "You can now use Rhumbatron" : "",
    href: "/",
    createdAt: row.access_decided_at,
    read: !!row.read_at,
  };
}

const RANK: Record<NotificationSeverity, number> = { action: 0, attention: 1, info: 2 };

/**
 * Every notification the user can see, action items first, each group newest first.
 * One D1 batch. `now` sets the 7-day window for finished work. `platformAdmin` comes from the
 * session check (`isPlatformAdmin`), never from the request.
 */
export async function deriveNotifications(
  db: D1Database,
  userId: string,
  now: Date,
  platformAdmin = false,
): Promise<NotificationView[]> {
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
  // Each statement binds only the ordinals it declares: ?1 user, ?2 window start.
  const statement = (sql: string) => db.prepare(sql).bind(userId, since);
  const userOnly = (sql: string) => db.prepare(sql).bind(userId);
  const [
    verified,
    letters,
    blocked,
    rejected,
    promoted,
    conflicts,
    completed,
    released,
    notSelected,
    needsInput,
    proposed,
    included,
    declined,
    choiceNeeded,
    choiceMade,
    accessDecided,
    accessRequests,
  ] = await db.batch([
    userOnly(VERIFIED_SQL),
    userOnly(DEAD_LETTER_SQL),
    userOnly(BLOCKED_SQL),
    statement(finishedCandidates("rejected", "candidate_rejected")),
    statement(finishedCandidates("promoted", "promoted")),
    userOnly(CONFLICT_SQL),
    statement(COMPLETED_SQL),
    statement(RELEASES_SQL),
    statement(NOT_SELECTED_SQL),
    userOnly(NEEDS_INPUT_SQL),
    userOnly(PROPOSED_SQL),
    statement(reviewedPart("included")),
    statement(reviewedPart("declined")),
    userOnly(CHOICE_NEEDED_SQL),
    statement(CHOICE_MADE_SQL),
    statement(ACCESS_DECIDED_SQL),
    ...(platformAdmin ? [userOnly(ACCESS_REQUEST_SQL)] : []),
  ]);
  const rows = <T>(result: D1Result | undefined) => (result?.results ?? []) as T[];
  const items: NotificationView[] = [
    ...rows<VerifiedRow>(verified)
      .map(verifiedItem)
      .filter((i): i is NotificationView => i !== null),
    ...rows<DeadLetterRow>(letters).map(deadLetterItem),
    ...rows<BlockedRow>(blocked).map(blockedItem),
    ...rows<FinishedRow>(rejected).map(rejectedItem),
    ...rows<ConflictRow>(conflicts).map(conflictItem),
    ...rows<FinishedRow>(promoted).map(promotedItem),
    ...rows<CompletedRow>(completed).map(completedItem),
    ...rows<ReleaseRow>(released).map(releaseItem),
    ...rows<NotSelectedRow>(notSelected).map(notSelectedItem),
    ...rows<NeedsInputRow>(needsInput).map(needsInputItem),
    ...rows<ProposedRow>(proposed).map(proposedItem),
    ...rows<NotSelectedRow>(included).map((row) => reviewedItem(row, "included")),
    ...rows<NotSelectedRow>(declined).map((row) => reviewedItem(row, "declined")),
    ...rows<ChoiceRow>(choiceNeeded).map(choiceNeededItem),
    ...rows<ChoiceRow>(choiceMade).map(choiceMadeItem),
    ...rows<AccessDecidedRow>(accessDecided).map(accessDecidedItem),
    ...rows<AccessRequestRow>(accessRequests).map(accessRequestItem),
  ];
  return items.sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] ||
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
  );
}

export function countNotifications(items: NotificationView[]) {
  return {
    unread: items.filter((i) => !i.read).length,
    action: items.filter((i) => i.severity === "action").length,
  };
}

/**
 * Marks notifications read for one user. `"all"` marks every item the user can see now. Marks
 * are keyed by user, so an ID the user cannot see only ever writes the caller's own row.
 * Also deletes the user's marks older than READ_RETENTION_DAYS.
 */
export async function markNotificationsRead(
  db: D1Database,
  userId: string,
  ids: string[] | "all",
  now: Date,
  platformAdmin = false,
): Promise<number> {
  const targets =
    ids === "all"
      ? (await deriveNotifications(db, userId, now, platformAdmin))
          .filter((i) => !i.read)
          .map((i) => i.id)
      : [...new Set(ids)];
  const at = now.toISOString();
  const cutoff = new Date(now.getTime() - READ_RETENTION_DAYS * 86_400_000).toISOString();
  await db.batch([
    db
      .prepare("DELETE FROM notification_reads WHERE user_id = ? AND read_at < ?")
      .bind(userId, cutoff),
    ...targets.slice(0, MAX_MARK).map((id) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO notification_reads (user_id, notification_id, read_at)
             VALUES (?, ?, ?)`,
        )
        .bind(userId, id, at),
    ),
  ]);
  return Math.min(targets.length, MAX_MARK);
}

/* ------------------------------------------------------------------------------------------ */
/* Routes                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export const notifications = new Hono<AppEnv>()
  .get("/v1/notifications/count", requireAuth, async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const items = await deriveNotifications(
      c.env.DB,
      userId,
      new Date(),
      isPlatformAdmin(c.env, userId),
    );
    return respond(c, apiData(CountView), { data: countNotifications(items) });
  })

  .get("/v1/notifications", requireAuth, validate("query", ListQuery), async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { limit } = c.req.valid("query");
    const items = await deriveNotifications(
      c.env.DB,
      userId,
      new Date(),
      isPlatformAdmin(c.env, userId),
    );
    return respond(c, apiData(z.object({ items: z.array(NotificationView), ...CountView.shape })), {
      data: { items: items.slice(0, limit), ...countNotifications(items) },
    });
  })

  .post("/v1/notifications/read", requireAuth, validate("json", ReadBody), async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { ids } = c.req.valid("json");
    const marked = await markNotificationsRead(
      c.env.DB,
      userId,
      ids,
      new Date(),
      isPlatformAdmin(c.env, userId),
    );
    return respond(c, apiData(z.object({ marked: z.number().int() })), { data: { marked } });
  });
