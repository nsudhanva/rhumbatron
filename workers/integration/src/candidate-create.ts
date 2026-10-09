import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { COMPOSITION_RULES_VERSION } from "@rhumbatron/evidence";
import { ChangeSetIntent } from "@rhumbatron/protocol";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";

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

/** Policy `maxCandidates` (section 53). Counts every Candidate of the Change, in any state. */
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

/** An open conflict whose recommended action is `fork_candidates`: the Task IDs of each side. */
export type ForkConflict = { id: string; sides: readonly [readonly string[], readonly string[]] };

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

/** Each ChangeSet's lineage: itself plus every ChangeSet it is stacked on, transitively. */
function lineages(proposed: readonly ProposedChangeSet[]): Map<string, Set<string>> {
  const direct = new Map(proposed.map((c) => [c.id, c.stackedOn ?? []]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, path: Set<string>): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    const out = new Set([id]);
    for (const parent of direct.get(id) ?? []) {
      if (path.has(parent)) continue; // A cycle cannot come from real commits; do not loop.
      for (const a of visit(parent, new Set([...path, parent]))) out.add(a);
    }
    memo.set(id, out);
    return out;
  };
  for (const c of proposed) visit(c.id, new Set([c.id]));
  return memo;
}

/**
 * Candidate fork rule (section 32.4). Selection, in order:
 * 1. A fork conflict counts only when both sides have at least one proposed ChangeSet; otherwise
 *    nothing competes and its ChangeSets compose normally.
 * 2. No counting fork conflict: one Candidate from every proposed ChangeSet.
 * 3. Otherwise the first counting conflict (input order: oldest first) is the fork axis. Every
 *    ChangeSet goes where its lineage (itself plus its `stackedOn` ancestors) allows, because a
 *    stacked commit already carries its ancestors' source and composition rejects it without them:
 *    - lineage meets one axis side: that side's Candidate only;
 *    - lineage meets both axis sides: deferred, it fits neither Candidate;
 *    - lineage meets a side of a further counting conflict: deferred (rule 4);
 *    - lineage meets no side: shared, in both Candidates.
 *    Each axis side with at least one ChangeSet left gives one Candidate: shared plus that side.
 *    Two Candidates at most, within MAX_CANDIDATES.
 * 4. A further counting conflict is not paired: a third design would exceed the limit, so its
 *    ChangeSets, and every ChangeSet stacked on them, wait for a later round.
 */
export function planCandidateSets(
  proposed: readonly ProposedChangeSet[],
  forkConflicts: readonly ForkConflict[],
): CandidatePlan {
  const all = proposed.map((c) => c.id).sort();
  const onSide = (side: readonly string[]) =>
    proposed
      .filter((c) => c.taskId !== null && side.includes(c.taskId))
      .map((c) => c.id)
      .sort();
  const counting = forkConflicts
    .map((f) => ({ id: f.id, a: onSide(f.sides[0]), b: onSide(f.sides[1]) }))
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

  const lineage = lineages(proposed);
  const shared: string[] = [];
  const own: [string[], string[]] = [[], []];
  const deferred: DeferredChangeSet[] = [];
  for (const id of all) {
    const line = [...(lineage.get(id) ?? [id])].sort();
    const inA = line.filter((x) => sideA.has(x));
    const inB = line.filter((x) => sideB.has(x));
    const waiting = line.filter((x) => later.has(x));
    if (inA.length > 0 && inB.length > 0) {
      deferred.push({
        id,
        reason: `carries both sides of fork conflict ${axis.id} (${inA.join(", ")} and ${inB.join(", ")}); no Candidate of the fork can include it`,
      });
    } else if (waiting.length > 0) {
      const first = waiting[0] as string;
      deferred.push({
        id,
        reason:
          first === id
            ? `on a side of fork conflict ${later.get(id)}, which waits for a later round`
            : `stacked on ${waiting.join(", ")}, on a side of fork conflict ${later.get(first)}, which waits for a later round`,
      });
    } else if (inA.length > 0) own[0].push(id);
    else if (inB.length > 0) own[1].push(id);
    else shared.push(id);
  }

  const sides = own.filter((side) => side.length > 0).map((side) => [...shared, ...side].sort());
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
};

async function loadChange(env: Env, changeId: string) {
  return env.DB.prepare(
    `SELECT c.id, c.project_id, c.status, c.base_generation, p.org_id, p.slug,
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
    `SELECT id, intents_json FROM conflicts
     WHERE change_id = ? AND state IN ('confirmed', 'fork_required')
       AND recommended_action = 'fork_candidates'
     ORDER BY created_at, id`,
  )
    .bind(changeId)
    .all<{ id: string; intents_json: string }>();
  const out: ForkConflict[] = [];
  for (const row of rows.results ?? []) {
    const sides = JSON.parse(row.intents_json) as { taskId?: unknown }[];
    const a = sides[0]?.taskId;
    const b = sides[1]?.taskId;
    if (typeof a === "string" && typeof b === "string" && a !== b) {
      out.push({ id: row.id, sides: [[a], [b]] });
    }
  }
  return out;
}

/**
 * Starts CandidateVerificationWorkflow (section 21.2). The instance ID is the Candidate ID, so a
 * repeat finds the existing instance; the workflow itself ignores a Candidate in a final state.
 */
export async function startCandidateVerification(env: Env, candidateId: string) {
  try {
    await env.CANDIDATE_WORKFLOW.create({ id: candidateId, params: { candidateId } });
  } catch (error) {
    // Already started by an earlier request or delivery: nothing to do. Anything else throws.
    const existing = await env.CANDIDATE_WORKFLOW.get(candidateId).catch(() => null);
    if (!existing) throw error;
  }
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
       composition_key, change_set_ids_json)
     SELECT ?, ?, ?, 'composing', ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM candidates WHERE change_id = ?) < ?
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
  await startCandidateVerification(env, candidateId);
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
  if (["cancelled", "failed", "completed"].includes(change.status)) {
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
  const [proposed, forks] = await Promise.all([
    loadProposed(env, change.id),
    loadForkConflicts(env, change.id),
  ]);
  if (proposed.length === 0) return { status: "skipped", reason: "no proposed ChangeSets" };
  const plan = planCandidateSets(proposed, forks);
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
