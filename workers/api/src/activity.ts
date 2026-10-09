import {
  apiData,
  ChangeClaims,
  type ClaimFact,
  type FeedEvent,
  FeedPage,
  FeedQuery,
  foldClaims,
  ProjectStats,
  planFeedQuery,
  RunProgress,
  toFeedPage,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { changeDetail } from "./changes.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Activity reads for the UI (AGENTS.md sections 16.1, 39, 41, 58). All read D1 only, through
 * indexes, with capped row counts; none calls a Durable Object.
 *
 *   GET /v1/projects/:projectId/events   feed page (project_events, migration 0010)
 *   GET /v1/projects/:projectId/stats    Change, Candidate, and model-call aggregates
 *   GET /v1/changes/:changeId            Change detail with risk tier and times (changes.ts)
 *   GET /v1/changes/:changeId/events     feed page of one Change
 *   GET /v1/changes/:changeId/claims     Claim facts and last state, from `claim.*` feed rows
 *   GET /v1/changes/:changeId/progress   live progress of running attempts
 *
 * The feed is a projection of K2 events written by the event-router, so it lags the
 * authoritative state by the projector delay (eventual consistency, section 59).
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });

/** Claim facts returned per Change. Older facts are dropped first (`truncated`). */
const CLAIM_FEED_LIMIT = 200;
/** Running attempts returned per Change. */
const PROGRESS_LIMIT = 50;

/** Must match the WHERE term of idx_project_events_change_claims exactly to use that index. */
const CLAIM_TYPES_SQL =
  "event_type IN ('claim.acquired', 'claim.renewed', 'claim.released', 'claim.expired')";

const ACTIVE_CHANGE_SQL =
  "status IN ('created', 'compiling', 'running', 'verifying', 'awaiting_approval', 'promoting', 'releasing')";

type FeedRowDb = {
  seq: number;
  event_id: string;
  event_type: string;
  event_version: number;
  change_id: string | null;
  task_id: string | null;
  candidate_id: string | null;
  resource: string | null;
  actor_kind: "user" | "agent" | "system";
  actor_id: string;
  occurred_at: string;
  recorded_at: string;
  summary: string;
  data_json: string;
};

const FEED_COLUMNS = `seq, event_id, event_type, event_version, change_id, task_id, candidate_id,
  resource, actor_kind, actor_id, occurred_at, recorded_at, summary, data_json`;

function toFeedEvent(row: FeedRowDb): FeedEvent {
  return {
    seq: row.seq,
    eventId: row.event_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actor: { kind: row.actor_kind, id: row.actor_id },
    changeId: row.change_id,
    taskId: row.task_id,
    candidateId: row.candidate_id,
    resource: row.resource,
    summary: row.summary,
    data: JSON.parse(row.data_json) as FeedEvent["data"],
  };
}

/** One feed page. Rows read: at most `limit + 1`, through the (scope, seq) index. */
async function readFeed(
  db: D1Database,
  scope: "project_id" | "change_id",
  id: string,
  query: FeedQuery,
): Promise<FeedPage> {
  const plan = planFeedQuery(query);
  const cursor = plan.op ? ` AND seq ${plan.op} ?` : "";
  const rows = await db
    .prepare(
      `SELECT ${FEED_COLUMNS} FROM project_events WHERE ${scope} = ?${cursor}
       ORDER BY seq ${plan.order} LIMIT ?`,
    )
    .bind(id, ...(plan.op ? [plan.value] : []), plan.take)
    .all<FeedRowDb>();
  const page = toFeedPage(rows.results ?? [], query);
  return { ...page, events: page.events.map(toFeedEvent) };
}

/** The Change's Project when the caller may read it, else null. */
async function changeProject(env: Env, userId: string, changeId: string) {
  const change = await env.DB.prepare("SELECT project_id FROM changes WHERE id = ?")
    .bind(changeId)
    .first<{ project_id: string }>();
  if (!change || !(await canAccessProject(env.DB, userId, change.project_id))) return null;
  return change.project_id;
}

const toClaimFact = (row: {
  seq: number;
  event_id: string;
  event_type: string;
  resource: string | null;
  occurred_at: string;
  data_json: string;
}): ClaimFact | null => {
  const data = JSON.parse(row.data_json) as Record<string, unknown>;
  const action = row.event_type.slice("claim.".length);
  if (typeof data.claimId !== "string" || typeof data.agentId !== "string") return null;
  if (!["acquired", "renewed", "released", "expired"].includes(action)) return null;
  return {
    seq: row.seq,
    eventId: row.event_id,
    action: action as ClaimFact["action"],
    claimId: data.claimId,
    agentId: data.agentId,
    resource: row.resource ?? "",
    leaseExpiresAt: typeof data.leaseExpiresAt === "string" ? data.leaseExpiresAt : null,
    occurredAt: row.occurred_at,
  };
};

export const activity = new Hono<AppEnv>()
  .route("/", changeDetail)

  .get(
    "/v1/projects/:projectId/events",
    requireAuth,
    validate("param", ProjectIdParam),
    validate("query", FeedQuery),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      if (!(await canAccessProject(c.env.DB, userId, projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }
      const page = await readFeed(c.env.DB, "project_id", projectId, c.req.valid("query"));
      return respond(c, apiData(FeedPage), { data: page });
    },
  )

  /**
   * One D1 batch of four aggregate reads. Rows read: the Project's Changes (twice), their
   * Candidates, their Tasks and runs, plus one index row for the latest feed position.
   */
  .get(
    "/v1/projects/:projectId/stats",
    requireAuth,
    validate("param", ProjectIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      if (!(await canAccessProject(c.env.DB, userId, projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }
      const db = c.env.DB;
      const [changes, candidates, runs, events] = await db.batch([
        db
          .prepare(
            `SELECT COUNT(*) AS total, COALESCE(SUM(${ACTIVE_CHANGE_SQL}), 0) AS active
             FROM changes WHERE project_id = ?`,
          )
          .bind(projectId),
        db
          .prepare(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(c.status IN ('verified', 'promoted')), 0) AS verified,
                    COALESCE(SUM(c.status = 'promoted'), 0) AS promoted,
                    COALESCE(SUM(c.status = 'rejected'), 0) AS rejected
             FROM candidates c JOIN changes ch ON ch.id = c.change_id WHERE ch.project_id = ?`,
          )
          .bind(projectId),
        db
          .prepare(
            `SELECT COUNT(*) AS runs, COALESCE(SUM(r.status = 'running'), 0) AS running,
                    COALESCE(SUM(r.model_calls), 0) AS calls,
                    COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(r.cost_usd), 0) AS cost_usd
             FROM changes ch JOIN tasks t ON t.change_id = ch.id JOIN task_runs r ON r.task_id = t.id
             WHERE ch.project_id = ?`,
          )
          .bind(projectId),
        db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS latest FROM project_events WHERE project_id = ?",
          )
          .bind(projectId),
      ]);
      type Row = Record<string, number>;
      const one = (r: D1Result | undefined) => ((r?.results ?? [])[0] ?? {}) as Row;
      const ch = one(changes);
      const ca = one(candidates);
      const ru = one(runs);
      const ev = one(events);
      return respond(c, apiData(ProjectStats), {
        data: {
          changes: { total: ch.total ?? 0, active: ch.active ?? 0 },
          candidates: {
            total: ca.total ?? 0,
            verified: ca.verified ?? 0,
            promoted: ca.promoted ?? 0,
            rejected: ca.rejected ?? 0,
          },
          model: {
            runs: ru.runs ?? 0,
            running: ru.running ?? 0,
            calls: ru.calls ?? 0,
            inputTokens: ru.input_tokens ?? 0,
            outputTokens: ru.output_tokens ?? 0,
            costUsd: Math.max(0, ru.cost_usd ?? 0),
          },
          events: { latestSeq: ev.latest ?? 0 },
        },
      });
    },
  )

  .get(
    "/v1/changes/:changeId/events",
    requireAuth,
    validate("param", ChangeIdParam),
    validate("query", FeedQuery),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      if (!(await changeProject(c.env, userId, changeId))) {
        return fail(c, 404, "not_found", "Change not found");
      }
      const page = await readFeed(c.env.DB, "change_id", changeId, c.req.valid("query"));
      return respond(c, apiData(FeedPage), { data: page });
    },
  )

  /**
   * Claims of one Change (section 13.2). ResourceShardDO writes `claim.*` events to its outbox in
   * the same transaction as the lease change, so the feed carries every Claim fact without a fan-out
   * to the shards. Reads at most CLAIM_FEED_LIMIT + 1 rows through a partial index.
   */
  .get("/v1/changes/:changeId/claims", requireAuth, validate("param", ChangeIdParam), async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { changeId } = c.req.valid("param");
    if (!(await changeProject(c.env, userId, changeId))) {
      return fail(c, 404, "not_found", "Change not found");
    }
    const rows = await c.env.DB.prepare(
      `SELECT seq, event_id, event_type, resource, occurred_at, data_json FROM project_events
         WHERE change_id = ? AND ${CLAIM_TYPES_SQL} ORDER BY seq DESC LIMIT ?`,
    )
      .bind(changeId, CLAIM_FEED_LIMIT + 1)
      .all<{
        seq: number;
        event_id: string;
        event_type: string;
        resource: string | null;
        occurred_at: string;
        data_json: string;
      }>();
    const all = rows.results ?? [];
    const facts = all
      .slice(0, CLAIM_FEED_LIMIT)
      .reverse()
      .map(toClaimFact)
      .filter((f): f is ClaimFact => f !== null);
    return respond(c, apiData(ChangeClaims), {
      data: {
        facts,
        claims: foldClaims(facts, Date.now()),
        truncated: all.length > CLAIM_FEED_LIMIT,
      },
    });
  })

  /** Running attempts of one Change, updated by AgentDO once per model call. */
  .get(
    "/v1/changes/:changeId/progress",
    requireAuth,
    validate("param", ChangeIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { changeId } = c.req.valid("param");
      if (!(await changeProject(c.env, userId, changeId))) {
        return fail(c, 404, "not_found", "Change not found");
      }
      const rows = await c.env.DB.prepare(
        `SELECT r.task_id, r.attempt, r.tier, r.model_calls, r.input_tokens, r.output_tokens,
                r.cost_usd, r.last_step, r.started_at, r.progress_at
         FROM tasks t JOIN task_runs r ON r.task_id = t.id
         WHERE t.change_id = ? AND r.status = 'running' ORDER BY r.started_at LIMIT ?`,
      )
        .bind(changeId, PROGRESS_LIMIT)
        .all<{
          task_id: string;
          attempt: number;
          tier: RunProgress["tier"];
          model_calls: number;
          input_tokens: number;
          output_tokens: number;
          cost_usd: number;
          last_step: string | null;
          started_at: string;
          progress_at: string | null;
        }>();
      const data: RunProgress[] = (rows.results ?? []).map((r) => ({
        taskId: r.task_id,
        attempt: r.attempt,
        tier: r.tier,
        modelCalls: r.model_calls,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costUsd: Math.max(0, r.cost_usd),
        lastStep: r.last_step,
        startedAt: r.started_at,
        progressAt: r.progress_at,
      }));
      return respond(c, apiData(z.array(RunProgress)), { data });
    },
  );
