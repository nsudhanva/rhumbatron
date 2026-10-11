import type { ForkDecision } from "@rhumbatron/conflict";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { COMPOSITION_RULES_VERSION } from "@rhumbatron/evidence";
import { ChangeSetIntent, MAX_TASKS_PER_CHANGE } from "@rhumbatron/protocol";
import { requestCannotShip } from "./app-release-model.ts";
import type { TaskEdge } from "./candidate-composer.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import {
  applyIntegration,
  type IntegrateConflict,
  loadIntegratedPairs,
  pickIntegration,
} from "./integrate.ts";
import {
  requestWorkflowStart,
  startWorkflowOnce,
  verificationCommand,
} from "./workflow-commands.ts";

/**
 * Candidate creation (AGENTS.md sections 21.1 step 7, 32.4, 33, 44, 60). The one implementation
 * behind both the API route (`createCandidate` RPC) and the automatic composition after a Work
 * Graph completes (`candidate.create` command). Deterministic: no model calls.
 *
 * A Candidate is a row plus a CandidateVerificationWorkflow instance. Its ID is derived from the
 * composition key (Change, base generation, sorted ChangeSet IDs, composition rules version), so a
 * repeated request returns the same Candidate and the workflow instance ID (= Candidate ID) is
 * unique per composition.
 */

/**
 * Policy `maxCandidates` (section 53). Counts every Candidate of the Change, in any state, except
 * recompositions of a stale Candidate (P16-14): they replace their root, bounded per lineage.
 */
export const MAX_CANDIDATES = 3;

const ACTOR = { kind: "system", id: "candidate-composer" } as const;

/** Composition key (section 60) and the Candidate ID derived from it. */
export async function compositionKeyFor(
  changeId: string,
  baseGeneration: number,
  changeSetIds: readonly string[],
): Promise<{ compositionKey: string; candidateId: string }> {
  const ids = [...changeSetIds].sort();
  const text = `${changeId}\n${baseGeneration}\n${ids.join(",")}\nrules=${COMPOSITION_RULES_VERSION}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const compositionKey = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { compositionKey, candidateId: `cand_${compositionKey.slice(0, 24)}` };
}

/** A proposed ChangeSet, the Task whose run published it (null when no run row matches), and the
 * ChangeSets whose commits it carries (`intent_json.changeSet.stackedOn`, transitive). */
export type ProposedChangeSet = {
  id: string;
  taskId: string | null;
  stackedOn?: readonly string[];
};

/**
 * An open conflict whose recommended action is `fork_candidates`: the Task IDs of each side.
 * `fork_required` means the review asked for more evidence (`needs_more_evidence`), not that the
 * two sides are incompatible; `confirmed` means they are. Absent reads as `confirmed`.
 */
export type ForkConflict = {
  id: string;
  sides: readonly [readonly string[], readonly string[]];
  state?: "confirmed" | "fork_required";
  /** The recorded fork decision is `integrate` (complementary Tasks, integrate.ts). */
  integrate?: IntegrateConflict;
};

/** A ChangeSet left out of every Candidate this round, and why. */
export type DeferredChangeSet = { id: string; reason: string };

export type CandidatePlan = {
  /** ChangeSet ID sets, one per Candidate, each sorted. */
  sets: string[][];
  /** The conflict the Candidates fork on, or null for a single Candidate. */
  forkConflictId: string | null;
  /** ChangeSets no Candidate of this round can include, sorted by ID. */
  deferred: DeferredChangeSet[];
};

/** Lineage includes stacked ancestors and transitive Task dependencies, including paths through
 * Tasks without a proposed ChangeSet. Follow both kinds of dependency to keep compositions whole. */
function lineages(
  proposed: readonly ProposedChangeSet[],
  edges: readonly TaskEdge[],
): Map<string, Set<string>> {
  const byId = new Map(proposed.map((c) => [c.id, c]));
  const byTask = new Map<string, string[]>();
  for (const c of proposed) {
    if (c.taskId === null) continue;
    byTask.set(c.taskId, [...(byTask.get(c.taskId) ?? []), c.id]);
  }
  const taskDeps = new Map<string, string[]>();
  for (const e of edges) {
    taskDeps.set(e.task_id, [...(taskDeps.get(e.task_id) ?? []), e.depends_on_task_id]);
  }
  const result = new Map<string, Set<string>>();
  for (const c of proposed) {
    const out = new Set<string>();
    const tasks = new Set<string>();
    const pending: { kind: "changeset" | "task"; id: string }[] = [{ kind: "changeset", id: c.id }];
    while (pending.length > 0) {
      const next = pending.pop();
      if (!next) break;
      if (next.kind === "changeset") {
        if (out.has(next.id)) continue;
        out.add(next.id);
        const row = byId.get(next.id);
        for (const id of row?.stackedOn ?? []) pending.push({ kind: "changeset", id });
        if (row?.taskId) pending.push({ kind: "task", id: row.taskId });
      } else {
        if (tasks.has(next.id)) continue;
        tasks.add(next.id);
        for (const id of taskDeps.get(next.id) ?? []) {
          pending.push({ kind: "task", id });
          for (const cs of byTask.get(id) ?? []) pending.push({ kind: "changeset", id: cs });
        }
      }
    }
    result.set(c.id, out);
  }
  return result;
}

/**
 * Candidate fork rule (section 32.4). Selection, in order:
 * 1. A fork conflict counts only when both sides have at least one proposed ChangeSet; otherwise
 *    nothing competes and its ChangeSets compose normally.
 * 2. No counting fork conflict: one Candidate from every proposed ChangeSet.
 * 3. Otherwise the first counting conflict (input order: oldest first) is the fork axis. Every
 *    ChangeSet goes where its lineage (itself, stacked ancestors, and Task dependencies) allows,
 *    because composition rejects it without its required ChangeSets:
 *    - lineage meets one axis side: that side's Candidate only;
 *    - lineage meets both axis sides: deferred, it fits neither Candidate;
 *    - lineage meets a side of a further counting conflict: deferred (rule 4);
 *    - lineage meets no side: shared, in both Candidates.
 *    Each axis side with at least one ChangeSet left gives one Candidate: shared plus that side.
 * 4. Combined Candidate (ADR 0026): when the axis conflict is `fork_required` (the review asked
 *    for more evidence) and both sides have ChangeSets, a third Candidate holds shared plus both
 *    sides plus the ChangeSets whose lineage meets both sides. It gives the evidence the review
 *    asked for: whether the two sides work together. A `confirmed` conflict keeps two Candidates,
 *    and a ChangeSet that needs both of its sides is deferred.
 * 5. A further counting conflict is not paired: a further design would exceed MAX_CANDIDATES, so
 *    its ChangeSets, and every ChangeSet stacked on or dependent on them, wait for a later round.
 */
export function planCandidateSets(
  proposed: readonly ProposedChangeSet[],
  forkConflicts: readonly ForkConflict[],
  edges: readonly TaskEdge[] = [],
): CandidatePlan {
  const all = proposed.map((c) => c.id).sort();
  const onSide = (side: readonly string[]) =>
    proposed
      .filter((c) => c.taskId !== null && side.includes(c.taskId))
      .map((c) => c.id)
      .sort();
  const counting = forkConflicts
    .map((f) => ({
      id: f.id,
      a: onSide(f.sides[0]),
      b: onSide(f.sides[1]),
      combine: f.state === "fork_required",
    }))
    .filter((f) => f.a.length > 0 && f.b.length > 0);
  const axis = counting[0];
  if (!axis) return { sets: [all], forkConflictId: null, deferred: [] };

  const sideA = new Set(axis.a);
  const sideB = new Set(axis.b);
  // ChangeSets on a further conflict, and not on the axis: the first such conflict per ChangeSet.
  const later = new Map<string, string>();
  for (const f of counting.slice(1)) {
    for (const id of [...f.a, ...f.b]) {
      if (!sideA.has(id) && !sideB.has(id) && !later.has(id)) later.set(id, f.id);
    }
  }

  const lineage = lineages(proposed, edges);
  const shared: string[] = [];
  const own: [string[], string[]] = [[], []];
  const deferred: DeferredChangeSet[] = [];
  /** Lineage meets both axis sides: only a combined Candidate can include it. */
  const both: DeferredChangeSet[] = [];
  for (const id of all) {
    const line = [...(lineage.get(id) ?? [id])].sort();
    const inA = line.filter((x) => sideA.has(x));
    const inB = line.filter((x) => sideB.has(x));
    const waiting = line.filter((x) => later.has(x));
    if (inA.length > 0 && inB.length > 0) {
      const entry = {
        id,
        reason: `requires both sides of fork conflict ${axis.id} (${inA.join(", ")} and ${inB.join(", ")}); no Candidate of the fork can include it`,
      };
      if (axis.combine && waiting.length === 0) both.push(entry);
      else deferred.push(entry);
    } else if (waiting.length > 0) {
      const first = waiting[0] as string;
      deferred.push({
        id,
        reason:
          first === id
            ? `on a side of fork conflict ${later.get(id)}, which waits for a later round`
            : `stacked on ${waiting.join(", ")} or depends on their Tasks, on a side of fork conflict ${later.get(first)}, which waits for a later round`,
      });
    } else if (inA.length > 0) own[0].push(id);
    else if (inB.length > 0) own[1].push(id);
    else shared.push(id);
  }

  const sides = own.filter((side) => side.length > 0).map((side) => [...shared, ...side].sort());
  if (axis.combine && own[0].length > 0 && own[1].length > 0) {
    sides.push([...shared, ...own[0], ...own[1], ...both.map((b) => b.id)].sort());
  } else if (both.length > 0) {
    deferred.push(...both);
    deferred.sort((x, y) => x.id.localeCompare(y.id));
  }
  const sets = sides.filter((s, i) => sides.findIndex((t) => t.join() === s.join()) === i);
  return { sets: sets.slice(0, MAX_CANDIDATES), forkConflictId: axis.id, deferred };
}

export type CreateRefusal =
  | "not_found"
  | "change_closed"
  | "archived"
  | "no_source"
  | "not_proposed"
  | "candidate_limit";

export type CreateCandidateOutcome =
  | { status: "created" | "existing"; candidateId: string; changeSetIds: string[] }
  | { status: "refused"; reason: CreateRefusal; detail: string };

export type ComposeOutcome =
  | { status: "skipped"; reason: string }
  /** A conflict review is still running; composing now could miss its fork decision. */
  | { status: "waiting"; reason: string }
  /** Complementary Tasks: the dependent Task re-runs on the other's ChangeSet first (integrate.ts). */
  | { status: "integrating"; conflictId: string; rerunTaskIds: string[] }
  | {
      status: "composed";
      forkConflictId: string | null;
      deferred: DeferredChangeSet[];
      candidates: CreateCandidateOutcome[];
    };

type ChangeRow = {
  id: string;
  project_id: string;
  status: string;
  base_generation: number;
  org_id: string;
  slug: string;
  project_status: string;
  outcome: string | null;
};

async function loadChange(env: Env, changeId: string) {
  return env.DB.prepare(
    `SELECT c.id, c.project_id, c.status, c.outcome, c.base_generation, p.org_id, p.slug,
            p.status AS project_status
     FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
  )
    .bind(changeId)
    .first<ChangeRow>();
}

const contextOf = (row: ChangeRow): ChangeContext => ({
  projectId: row.project_id,
  orgId: row.org_id,
  projectSlug: row.slug,
  changeId: row.id,
  baseGeneration: row.base_generation,
});

/** `stackedOn` of a stored ChangeSet, or none for a row that does not parse (rejected later). */
function stackedOnOf(intentJson: string | null): string[] {
  try {
    const parsed = ChangeSetIntent.safeParse(JSON.parse(intentJson ?? "null"));
    return parsed.success ? (parsed.data.changeSet?.stackedOn ?? []) : [];
  } catch {
    return [];
  }
}

async function loadProposed(env: Env, changeId: string): Promise<ProposedChangeSet[]> {
  // ChangeSet `cs_<run>` is published by run `run_<run>` (agents and the Wishlist fixture).
  const rows = await env.DB.prepare(
    `SELECT cs.id, r.task_id, cs.intent_json FROM changesets cs
     LEFT JOIN task_runs r ON r.id = 'run_' || substr(cs.id, 4)
     WHERE cs.change_id = ? AND cs.status = 'proposed' ORDER BY cs.id`,
  )
    .bind(changeId)
    .all<{ id: string; task_id: string | null; intent_json: string | null }>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    taskId: r.task_id,
    stackedOn: stackedOnOf(r.intent_json),
  }));
}

/** Open conflicts that call for competing Candidates, oldest first. */
async function loadForkConflicts(env: Env, changeId: string): Promise<ForkConflict[]> {
  const rows = await env.DB.prepare(
    `SELECT id, state, intents_json, fork_decision_json FROM conflicts
     WHERE change_id = ? AND state IN ('confirmed', 'fork_required')
       AND recommended_action = 'fork_candidates'
     ORDER BY created_at, id`,
  )
    .bind(changeId)
    .all<{ id: string; state: string; intents_json: string; fork_decision_json: string }>();
  const out: ForkConflict[] = [];
  for (const row of rows.results ?? []) {
    const sides = JSON.parse(row.intents_json) as { taskId?: unknown }[];
    const a = sides[0]?.taskId;
    const b = sides[1]?.taskId;
    if (typeof a === "string" && typeof b === "string" && a !== b) {
      const fork = JSON.parse(row.fork_decision_json || "{}") as Partial<ForkDecision>;
      out.push({
        id: row.id,
        sides: [[a], [b]],
        state: row.state === "fork_required" ? "fork_required" : "confirmed",
        ...(fork.kind === "integrate" &&
        fork.dependentTaskId &&
        fork.dependsOnTaskId &&
        typeof fork.reason === "string"
          ? {
              integrate: {
                id: row.id,
                dependentTaskId: fork.dependentTaskId,
                dependsOnTaskId: fork.dependsOnTaskId,
                reason: fork.reason,
              },
            }
          : {}),
      });
    }
  }
  return out;
}

/** One bounded query for the Work Graph. Never classify sides using a truncated dependency graph. */
async function loadTaskDependencies(env: Env, changeId: string): Promise<TaskEdge[]> {
  const cap = MAX_TASKS_PER_CHANGE * MAX_TASKS_PER_CHANGE;
  const rows = await env.DB.prepare(
    `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
     JOIN tasks t ON t.id = d.task_id WHERE t.change_id = ?
     ORDER BY d.task_id, d.depends_on_task_id LIMIT ?`,
  )
    .bind(changeId, cap + 1)
    .all<TaskEdge>();
  const edges = rows.results ?? [];
  if (edges.length > cap) throw new Error(`Task dependency limit exceeded for Change ${changeId}`);
  return edges;
}

/**
 * Starts CandidateVerificationWorkflow (section 21.2). The instance ID is the Candidate ID, so a
 * repeat finds the existing instance; the workflow itself ignores a Candidate in a final state.
 */
export async function startCandidateVerification(env: Env, candidateId: string) {
  await startWorkflowOnce(env.CANDIDATE_WORKFLOW, candidateId, { candidateId });
}

/**
 * Inserts one Candidate (or finds it) and starts its verification. The insert and the limit check
 * are one statement, so concurrent requests cannot exceed MAX_CANDIDATES.
 */
async function insertCandidate(
  env: Env,
  change: ChangeRow,
  changeSetIds: string[],
  trigger: {
    kind: "api" | "work_graph_completed";
    forkConflictId: string | null;
    deferred?: readonly DeferredChangeSet[];
  },
): Promise<CreateCandidateOutcome> {
  const sorted = [...changeSetIds].sort();
  const { compositionKey, candidateId } = await compositionKeyFor(
    change.id,
    change.base_generation,
    sorted,
  );
  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(
    `INSERT INTO candidates (id, change_id, base_generation, status, created_at, updated_at,
       composition_key, change_set_ids_json, recomposed_from, recompose_count)
     SELECT ?, ?, ?, 'composing', ?, ?, ?, ?,
       (SELECT id FROM candidates WHERE change_id = ? AND json_extract(score_json, '$.rebase.requested') = 1
         ORDER BY json_extract(score_json, '$.rebase.count') DESC LIMIT 1),
       CASE WHEN EXISTS (SELECT 1 FROM candidates WHERE change_id = ? AND json_extract(score_json, '$.rebase.requested') = 1)
         THEN 1 ELSE 0 END
     WHERE (SELECT COUNT(*) FROM candidates c WHERE c.change_id = ?
       AND (c.recomposed_from IS NULL OR (c.recompose_count = 1 AND EXISTS
         (SELECT 1 FROM candidates origin WHERE origin.id = c.recomposed_from AND json_extract(origin.score_json, '$.rebase.requested') = 1)))
       AND c.created_at >= COALESCE((SELECT MAX(json_extract(r.score_json, '$.rebase.resetAt'))
         FROM candidates r WHERE r.change_id = c.change_id AND json_extract(r.score_json, '$.rebase.requested') = 1), '')) < ?
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      candidateId,
      change.id,
      change.base_generation,
      now,
      now,
      compositionKey,
      JSON.stringify(sorted),
      change.id,
      change.id,
      change.id,
      MAX_CANDIDATES,
    )
    .run();
  const created = (inserted.meta.changes ?? 0) > 0;
  if (!created) {
    const exists = await env.DB.prepare("SELECT id FROM candidates WHERE id = ?")
      .bind(candidateId)
      .first<{ id: string }>();
    if (!exists) {
      return {
        status: "refused",
        reason: "candidate_limit",
        detail: `A Change can have at most ${MAX_CANDIDATES} Candidates`,
      };
    }
  }
  // Also on a repeat: the event ID is stable and the shard outbox dedupes it, so a delivery that
  // failed after the insert still records the fork.
  const ctx = contextOf(change);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "candidate.forked",
      {
        candidateId,
        baseGeneration: change.base_generation,
        changeSetIds: sorted,
        compositionKey,
        compositionRulesVersion: COMPOSITION_RULES_VERSION,
        trigger: trigger.kind,
        forkConflictId: trigger.forkConflictId,
        // ChangeSets of this Change that this round left out of every Candidate, with the reason.
        ...(trigger.deferred?.length ? { deferred: trigger.deferred } : {}),
      },
      { key: candidateId, actor: ACTOR },
    ),
  ]);
  // Section 20: the start travels on the verification Queue (same instance ID; direct on failure).
  await requestWorkflowStart(
    env,
    verificationCommand(candidateId, { projectId: change.project_id, changeId: change.id }),
  );
  return { status: created ? "created" : "existing", candidateId, changeSetIds: sorted };
}

/** Preconditions shared by both entry points. Returns a refusal or the Change row. */
async function openChange(
  env: Env,
  changeId: string,
): Promise<ChangeRow | Extract<CreateCandidateOutcome, { status: "refused" }>> {
  const change = await loadChange(env, changeId);
  if (!change) return { status: "refused", reason: "not_found", detail: "Change not found" };
  if (change.project_status === "archived") {
    return { status: "refused", reason: "archived", detail: "Project is archived" };
  }
  // Past promotion, the Change already advanced canonical once: no second Candidate composes.
  if (
    requestCannotShip(change.status, change.outcome) ||
    ["failed", "completed", "promoting", "releasing"].includes(change.status)
  ) {
    return { status: "refused", reason: "change_closed", detail: `Change is ${change.status}` };
  }
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(change.project_id)).getCanonical();
  if (!canonical || canonical.artifactRef === "unassigned") {
    return {
      status: "refused",
      reason: "no_source",
      detail: "Project has no source to compose on",
    };
  }
  return change;
}

/**
 * API entry (RPC `createCandidate`): one Candidate from every proposed ChangeSet, or from the
 * given subset (competing designs, P9-08). No ChangeSets yields the canonical baseline Candidate.
 * The caller authenticated the user and checked Project membership.
 */
export async function createCandidate(
  env: Env,
  input: { changeId: string; changeSetIds?: readonly string[] | undefined },
): Promise<CreateCandidateOutcome> {
  const change = await openChange(env, input.changeId);
  if ("reason" in change) return change;
  const proposed = (await loadProposed(env, change.id)).map((c) => c.id);
  const wanted = input.changeSetIds;
  if (wanted?.some((id) => !proposed.includes(id))) {
    return {
      status: "refused",
      reason: "not_proposed",
      detail: "changeSetIds must be proposed ChangeSets of this Change",
    };
  }
  const changeSetIds = wanted ? proposed.filter((id) => wanted.includes(id)) : proposed;
  return insertCandidate(env, change, changeSetIds, { kind: "api", forkConflictId: null });
}

/**
 * Automatic composition when the Work Graph completed (section 21.1 step 7; `candidate.create`).
 * Applies the fork rule (`planCandidateSets`). Safe to repeat: every Candidate ID is its
 * composition key. A Change with no proposed ChangeSet is skipped: there is nothing to compose.
 */
export async function composeChangeCandidates(
  env: Env,
  changeId: string,
  options: { force?: boolean } = {},
): Promise<ComposeOutcome> {
  const change = await openChange(env, changeId);
  if ("reason" in change) return { status: "skipped", reason: change.reason };
  if (change.status !== "verifying") {
    return { status: "skipped", reason: `change is ${change.status}` };
  }
  // A model review can turn a suspected conflict into a fork (section 32.4). Wait for reviews
  // reserved in the last 10 minutes; an older reservation is a lost review and does not block.
  if (!options.force) {
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM conflicts WHERE change_id = ? AND state IN ('suspected', 'confirmed')
         AND ((json_extract(review_json, '$.reviews.sonnet.status') = 'reserved'
               AND json_extract(review_json, '$.reviews.sonnet.at') > ?)
           OR (json_extract(review_json, '$.reviews.opus.status') = 'reserved'
               AND json_extract(review_json, '$.reviews.opus.at') > ?))`,
    )
      .bind(
        change.id,
        new Date(Date.now() - 600_000).toISOString(),
        new Date(Date.now() - 600_000).toISOString(),
      )
      .first<{ n: number }>()
      .catch(() => null);
    if ((pending?.n ?? 0) > 0) {
      return { status: "waiting", reason: `${pending?.n} conflict review(s) still running` };
    }
  }
  const [proposed, forks, edges] = await Promise.all([
    loadProposed(env, change.id),
    loadForkConflicts(env, change.id),
    loadTaskDependencies(env, change.id),
  ]);
  if (proposed.length === 0) return { status: "skipped", reason: "no proposed ChangeSets" };
  // Complementary Tasks integrate before any Candidate exists; one integration per round.
  const integrate = forks.flatMap((f) => (f.integrate ? [f.integrate] : []));
  if (integrate.length > 0) {
    const integration = pickIntegration(
      integrate,
      proposed,
      edges,
      await loadIntegratedPairs(env, change.id),
    );
    if (integration && (await applyIntegration(env, change.id, integration))) {
      return {
        status: "integrating",
        conflictId: integration.id,
        rerunTaskIds: integration.rerunTaskIds,
      };
    }
  }
  const plan = planCandidateSets(proposed, forks, edges);
  const candidates: CreateCandidateOutcome[] = [];
  for (const set of plan.sets) {
    candidates.push(
      await insertCandidate(env, change, set, {
        kind: "work_graph_completed",
        forkConflictId: plan.forkConflictId,
        deferred: plan.deferred,
      }),
    );
  }
  return {
    status: "composed",
    forkConflictId: plan.forkConflictId,
    deferred: plan.deferred,
    candidates,
  };
}
