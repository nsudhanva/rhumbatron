import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { MAX_RECOMPOSES, recomposeBlockedReason, recomposeDecision } from "./app-release-model.ts";
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
  project_id: string;
  project_status: string;
  org_id: string;
  slug: string;
  sibling_promoted: number;
};

export type RecomposeOutcome =
  | { status: "recomposed"; candidateId: string; baseGeneration: number; count: number }
  | { status: "blocked" | "skipped"; reason?: string };

async function recomposeStaleCandidate(env: Env, candidateId: string): Promise<RecomposeOutcome> {
  const row = await env.DB.prepare(
    `SELECT c.id, c.change_id, c.status, c.base_generation, c.change_set_ids_json,
            c.recompose_count, c.recomposed_from, c.rollback_of_generation,
            ch.status AS change_status, ch.project_id, p.status AS project_status, p.org_id, p.slug,
            EXISTS (SELECT 1 FROM candidates s WHERE s.change_id = c.change_id
                      AND s.status = 'promoted') AS sibling_promoted
     FROM candidates c JOIN changes ch ON ch.id = c.change_id JOIN projects p ON p.id = ch.project_id
     WHERE c.id = ?`,
  )
    .bind(candidateId)
    .first<Row>();
  if (!row) return { status: "skipped", reason: "missing" };
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
     VALUES (?, ?, ?, 'composing', ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
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
    )
    .run();
  await env.DB.prepare(
    `UPDATE candidates SET status_reason = ?, updated_at = ? WHERE id = ? AND status = 'stale'`,
  )
    .bind(
      `Canonical advanced to S${canonical.generation}. Recomposed as ${next} (${decision.nextCount} of ${MAX_RECOMPOSES}).`,
      now,
      row.id,
    )
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

/** Recomposition never fails its caller (a promotion or a verification step): it logs instead. */
export async function recomposeQuietly(env: Env, candidateId: string) {
  try {
    const outcome = await recomposeStaleCandidate(env, candidateId);
    console.warn(JSON.stringify({ event: "candidate.recompose", candidateId, ...outcome }));
    return outcome;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "candidate.recompose_failed",
        candidateId,
        message: String(error).slice(0, 200),
      }),
    );
    return { status: "skipped" as const, reason: "error" };
  }
}
