import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  MAX_RECOMPOSES,
  recomposeBlockedReason,
  recomposeDecision,
  requestCannotShip,
} from "./app-release-model.ts";
import { compositionKeyFor } from "./candidate-create.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { requestWorkflowStart, verificationCommand } from "./workflow-commands.ts";

/**
 * Stale Candidate recomposition (P16-14; AGENTS.md sections 13.1, 42.9, 60). A Candidate whose
 * base fell behind canonical is not retried blind: the same ChangeSets are composed again on the
 * new canonical state as a new Candidate, which runs the full verification again. At most
 * MAX_RECOMPOSES times per lineage; then the stale Candidate is marked blocked for a person.
 *
 * Bounded and idempotent: the new Candidate's ID is its composition key (Change, new base, the
 * same ChangeSets), so a repeat finds it; the verification start travels on the verification Queue
 * with the Candidate ID as its instance ID. Deterministic: no model call.
 */

const ACTOR = { kind: "system", id: "candidate-recompose" } as const;

type Row = {
  id: string;
  change_id: string;
  status: string;
  base_generation: number;
  change_set_ids_json: string;
  recompose_count: number;
  recomposed_from: string | null;
  rollback_of_generation: number | null;
  change_status: string;
  change_outcome: string | null;
  project_id: string;
  project_status: string;
  org_id: string;
  slug: string;
  sibling_promoted: number;
};

export type RecomposeOutcome =
  | { status: "recomposed"; candidateId: string; baseGeneration: number; count: number }
  | { status: "blocked" | "skipped"; reason?: string };

export async function recomposeStaleCandidate(
  env: Env,
  candidateId: string,
): Promise<RecomposeOutcome> {
  const row = await env.DB.prepare(
    `SELECT c.id, c.change_id, c.status, c.base_generation, c.change_set_ids_json,
            c.recompose_count, c.recomposed_from, c.rollback_of_generation,
            ch.status AS change_status, ch.outcome AS change_outcome, ch.project_id, p.status AS project_status, p.org_id, p.slug,
            EXISTS (SELECT 1 FROM candidates s WHERE s.change_id = c.change_id
                      AND s.status = 'promoted') AS sibling_promoted
     FROM candidates c JOIN changes ch ON ch.id = c.change_id JOIN projects p ON p.id = ch.project_id
     WHERE c.id = ?`,
  )
    .bind(candidateId)
    .first<Row>();
  if (!row) return { status: "skipped", reason: "missing" };
  if (requestCannotShip(row.change_status, row.change_outcome))
    return { status: "skipped", reason: "change_closed" };
  if (row.project_status !== "active") return { status: "skipped", reason: "archived" };
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(row.project_id)).getCanonical();
  if (!canonical || canonical.artifactRef === "unassigned") {
    return { status: "skipped", reason: "no_source" };
  }
  const decision = recomposeDecision({
    candidateStatus: row.status,
    recomposeCount: row.recompose_count,
    changeStatus: row.change_status,
    changeOutcome: row.change_outcome,
    baseGeneration: row.base_generation,
    canonicalGeneration: canonical.generation,
    isRollback: row.rollback_of_generation !== null,
    siblingPromoted: row.sibling_promoted === 1,
  });
  const ctx: ChangeContext = {
    projectId: row.project_id,
    orgId: row.org_id,
    projectSlug: row.slug,
    changeId: row.change_id,
    baseGeneration: row.base_generation,
  };
  if (decision.kind === "skip") return { status: "skipped", reason: decision.reason };
  if (decision.kind === "blocked") {
    const reason = recomposeBlockedReason(canonical.generation);
    const updated = await env.DB.prepare(
      "UPDATE candidates SET status_reason = ?, updated_at = ? WHERE id = ? AND status = 'stale'",
    )
      .bind(reason, new Date().toISOString(), row.id)
      .run();
    if (updated.meta.changes > 0) {
      await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
        await changeEvent(
          ctx,
          "candidate.stale",
          {
            candidateId: row.id,
            status: "stale",
            blocked: true,
            reason,
            recomposeCount: row.recompose_count,
            maxRecomposes: MAX_RECOMPOSES,
          },
          { key: `${row.id}:blocked`, actor: ACTOR },
        ),
      ]);
    }
    return { status: "blocked", reason };
  }

  const ids = JSON.parse(row.change_set_ids_json) as string[];
  const { compositionKey, candidateId: next } = await compositionKeyFor(
    row.change_id,
    canonical.generation,
    ids,
  );
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO candidates (id, change_id, base_generation, status, created_at, updated_at,
       composition_key, change_set_ids_json, recomposed_from, recompose_count)
     SELECT ?, ?, ?, 'composing', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM changes WHERE id = ? AND status NOT IN ('not_selected', 'cancelled', 'awaiting_owner') AND COALESCE(outcome, '') NOT IN ('not_selected', 'overridden')) ON CONFLICT DO NOTHING`,
  )
    .bind(
      next,
      row.change_id,
      canonical.generation,
      now,
      now,
      compositionKey,
      JSON.stringify([...ids].sort()),
      row.recomposed_from ?? row.id,
      decision.nextCount,
      row.change_id,
    )
    .run();
  const created = await env.DB.prepare("SELECT id FROM candidates WHERE id = ?")
    .bind(next)
    .first<{ id: string }>();
  if (!created) return { status: "skipped", reason: "change_closed" };
  await env.DB.prepare(
    `UPDATE candidates SET status_reason = ?, updated_at = ? WHERE id = ? AND status = 'stale'`,
  )
    .bind(
      `Canonical advanced to S${canonical.generation}. Recomposed as ${next} (${decision.nextCount} of ${MAX_RECOMPOSES}).`,
      now,
      row.id,
    )
    .run();
  // A Change this module blocked for its stale Candidate is checking again (owner recovery).
  await env.DB.prepare(
    `UPDATE changes SET status = 'verifying', blocked_reason = NULL, updated_at = ?
     WHERE id = ? AND status = 'blocked' AND blocked_limit IS NULL
       AND blocked_reason IN (SELECT value FROM json_each(?))`,
  )
    .bind(now, row.change_id, JSON.stringify(STALE_BLOCKED_REASONS))
    .run();
  const nextCtx = { ...ctx, baseGeneration: canonical.generation };
  await appendChangeEvents(env.RESOURCE_SHARD, nextCtx, [
    await changeEvent(
      nextCtx,
      "candidate.forked",
      {
        candidateId: next,
        baseGeneration: canonical.generation,
        changeSetIds: [...ids].sort(),
        compositionKey,
        trigger: "recompose",
        recomposedFrom: row.id,
        recomposeCount: decision.nextCount,
        forkConflictId: null,
      },
      { key: next, actor: ACTOR },
    ),
  ]);
  await requestWorkflowStart(
    env,
    verificationCommand(next, { projectId: row.project_id, changeId: row.change_id }),
  );
  return {
    status: "recomposed",
    candidateId: next,
    baseGeneration: canonical.generation,
    count: decision.nextCount,
  };
}

/** Change reason when its stale Candidate could not be composed again on the new canonical state. */
export const STALE_BLOCKED_REASON =
  "Newer changes landed while this request was checked, and it could not be rebuilt on them. Raise the budget (the same amount is fine) to try again, or submit it again.";
/** Change reason when the stale Candidate already reached the recomposition bound. */
export const STALE_BOUND_REASON = `Newer changes landed again after this request was rebuilt ${MAX_RECOMPOSES} times. Submit it again.`;
const STALE_BLOCKED_REASONS = [STALE_BLOCKED_REASON, STALE_BOUND_REASON];

/**
 * A stale Candidate that was not composed again leaves its Change with nothing to verify. Unless
 * another Candidate of the Change is still active or promoted, or a Task still runs, the Change
 * leaves `verifying` for `blocked` with a plain reason (section 44: a visible stop, never a
 * silent wait). One guarded statement; safe to repeat.
 */
async function blockStaleChange(
  env: Pick<Env, "DB" | "RESOURCE_SHARD">,
  candidateId: string,
  reason: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const updated = await env.DB.prepare(
    `UPDATE changes SET status = 'blocked', blocked_limit = NULL, blocked_reason = ?, updated_at = ?
     WHERE id = (SELECT change_id FROM candidates WHERE id = ? AND status = 'stale')
       AND status = 'verifying'
       AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.change_id = changes.id
         AND c.status IN ('composing', 'composed', 'verifying', 'verified', 'promoted'))
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.change_id = changes.id
         AND t.status IN ('pending', 'ready', 'assigned', 'running'))`,
  )
    .bind(reason, now, candidateId)
    .run();
  if ((updated.meta.changes ?? 0) === 0) return false;
  const row = await env.DB.prepare(
    `SELECT c.change_id, c.base_generation, ch.project_id, p.org_id, p.slug
     FROM candidates c JOIN changes ch ON ch.id = c.change_id JOIN projects p ON p.id = ch.project_id
     WHERE c.id = ?`,
  )
    .bind(candidateId)
    .first<{
      change_id: string;
      base_generation: number;
      project_id: string;
      org_id: string;
      slug: string;
    }>();
  if (row) {
    const ctx: ChangeContext = {
      projectId: row.project_id,
      orgId: row.org_id,
      projectSlug: row.slug,
      changeId: row.change_id,
      baseGeneration: row.base_generation,
    };
    await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
      await changeEvent(
        ctx,
        "candidate.stale",
        { candidateId, status: "stale", blocked: true, changeStatus: "blocked", reason },
        { key: `${candidateId}:change_blocked:${now}`, actor: ACTOR },
      ),
    ]);
  }
  return true;
}

/**
 * Recomposition never fails its caller (a promotion or a verification step): it logs instead.
 * When it does not compose a new Candidate, `blockStaleChange` makes the stop visible.
 */
export async function recomposeQuietly(env: Env, candidateId: string): Promise<RecomposeOutcome> {
  let outcome: RecomposeOutcome;
  try {
    outcome = await recomposeStaleCandidate(env, candidateId);
    console.warn(JSON.stringify({ event: "candidate.recompose", candidateId, ...outcome }));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "candidate.recompose_failed",
        candidateId,
        message: String(error).slice(0, 200),
      }),
    );
    outcome = { status: "skipped", reason: "error" };
  }
  if (outcome.status === "recomposed") return outcome;
  try {
    await blockStaleChange(
      env,
      candidateId,
      outcome.status === "blocked" ? STALE_BOUND_REASON : STALE_BLOCKED_REASON,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "candidate.stale_block_failed",
        candidateId,
        message: String(error).slice(0, 200),
      }),
    );
  }
  return outcome;
}

/**
 * Owner recovery (the budget API) for a Change left with only a stale Candidate: compose its
 * newest stale Candidate again on the current canonical state. Only a `verifying` Change, or one
 * this module blocked, and only when no Candidate of the Change is active or promoted. Bounded
 * by MAX_RECOMPOSES per lineage, like the automatic path.
 */
export async function recoverStaleCandidates(env: Env, changeId: string) {
  const row = await env.DB.prepare(
    `SELECT c.id FROM candidates c JOIN changes ch ON ch.id = c.change_id
     WHERE ch.id = ? AND c.status = 'stale'
       AND (ch.status = 'verifying' OR (ch.status = 'blocked' AND ch.blocked_limit IS NULL
         AND ch.blocked_reason IN (SELECT value FROM json_each(?))))
       AND NOT EXISTS (SELECT 1 FROM candidates s WHERE s.change_id = ch.id
         AND s.status IN ('composing', 'composed', 'verifying', 'verified', 'promoted'))
     ORDER BY c.created_at DESC, c.id DESC LIMIT 1`,
  )
    .bind(changeId, JSON.stringify(STALE_BLOCKED_REASONS))
    .first<{ id: string }>();
  return row ? recomposeQuietly(env, row.id) : null;
}
