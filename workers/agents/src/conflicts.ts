import {
  type DeclaredIntent,
  detectConflicts,
  type ForkDecision,
  forkDecision,
  type IntentMeta,
  intentFromDeclaration,
} from "@rhumbatron/conflict";
import type { ResourceShardDO } from "@rhumbatron/coordinator";
import { shardKey } from "@rhumbatron/coordinator/shard-key";
import type { ChangeContext } from "@rhumbatron/integration/events";
import type {
  Challenge,
  ConflictAction,
  ConflictReport,
  ConflictState,
  Intent,
} from "@rhumbatron/protocol";

/**
 * Intent declaration and semantic-conflict detection for one Change (AGENTS.md sections 26 and 32,
 * P9-04 and P9-07). Every Intent of a Change lives on the ResourceShardDO that owns
 * `change:<id>`, so one `listIntents` call sees the whole Change. Detection is deterministic: no
 * model call decides a conflict here. A model review plugs in through `ConflictReviewer`.
 */

/** Protected resources until Project policies are stored (section 53 example policy). */
const DEFAULT_PROTECTED_RESOURCES = ["cart", "checkout", "identity"];

/** Candidate statuses that no longer count against `max_candidate_count` (section 44). */
const INACTIVE_CANDIDATE_STATUSES = ["rejected", "stale", "promoted"];

export type ConflictReview = {
  state: ConflictState;
  recommendedAction: ConflictAction;
  decidedBy: "rules" | "sonnet" | "opus";
  rationale?: string;
};

/**
 * Second opinion on a deterministic report (section 32.3 steps 6-7). A reviewer can dismiss or
 * downgrade a report, or ask for review; it must not confirm a conflict without a hard signal
 * from the detector. Sonnet review (P9-05) and Opus escalation (P9-06) implement this type.
 */
export type ConflictReviewer = (
  report: ConflictReport,
  pair: readonly [Intent, Intent],
) => Promise<ConflictReview>;

/** The current reviewer: the deterministic result, unchanged. */
const reviewConflict: ConflictReviewer = async (report) => ({
  state: report.state,
  recommendedAction: report.recommendedAction,
  decidedBy: "rules",
});

export type IntentSide = {
  intentId: string;
  taskId: string;
  taskKey: string;
  title: string;
  agentId: string;
  summary: string;
  semanticResources: string[];
  assumptions: string[];
  createdAt: string;
};

export type PlannedConflict = {
  id: string;
  report: ConflictReport;
  review: ConflictReview;
  intents: [IntentSide, IntentSide];
  forkDecision: ForkDecision;
  /** Set for a confirmed conflict. Its content depends only on the report and the two Intents. */
  challenge: Challenge | null;
};

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Stable conflict ID: the same pair and resource always map to the same ID, in any order. */
export async function conflictId(report: Pick<ConflictReport, "intentIds" | "resource">) {
  const key = [...report.intentIds].sort().join("\u0000");
  const bytes = new TextEncoder().encode(`${key}\u0000${report.resource}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `cfl_${hex(digest.slice(0, 12))}`;
}

/**
 * The Challenge for a confirmed conflict. The earlier Intent's agent objects to the later Intent.
 * Deterministic, so two agents that detect the same conflict write an identical Challenge and the
 * shard treats the second write as a duplicate.
 */
function challengeFor(
  id: string,
  report: ConflictReport,
  pair: readonly [Intent, Intent],
): Challenge {
  const [earlier, later] = [...pair].sort((x, y) =>
    x.createdAt === y.createdAt
      ? x.intentId < y.intentId
        ? -1
        : 1
      : x.createdAt < y.createdAt
        ? -1
        : 1,
  ) as [Intent, Intent];
  const hard = report.signals.filter((s) => s.severity === "hard");
  return {
    challengeId: `chl_${id.slice(4)}`,
    sourceAgentId: earlier.agentId,
    targetIntentId: later.intentId,
    semanticResource: report.resource,
    // Signals are ordered strongest first; only contract and data-model signals are hard.
    kind: hard[0]?.kind === "contract_conflict" ? "contract_conflict" : "data_semantics_conflict",
    summary: `${report.resource}: ${hard.map((s) => s.detail).join("; ")}`.slice(0, 2000),
    evidenceRefs: [...new Set(hard.flatMap((s) => s.evidenceRefs))]
      .filter((r) => r.length <= 128)
      .slice(0, 20),
    ...(report.recommendedAction === "fork_candidates"
      ? { proposedResolution: "Fork 2 Candidates and let executable evidence decide." }
      : {}),
  };
}

/**
 * Pure planning step: detect, review, and keep each suspected or confirmed pair that is not in
 * `done`. `activeCandidates` grows by two for every fork planned here, so the Candidate limit
 * holds across several conflicts of one Change.
 */
export async function planConflicts(input: {
  intents: readonly Intent[];
  tasks: ReadonlyMap<string, { key: string; title: string }>;
  dependsOn: Readonly<Record<string, readonly string[]>>;
  protectedResources: readonly string[];
  /** Conflict IDs already fully recorded. */
  done: ReadonlySet<string>;
  activeCandidates: number;
  review?: ConflictReviewer;
}): Promise<PlannedConflict[]> {
  const byId = new Map(input.intents.map((i) => [i.intentId, i]));
  const reports = detectConflicts(input.intents, {
    protectedResources: input.protectedResources,
    dependsOn: input.dependsOn,
    includeDismissed: false,
  });
  const side = (intent: Intent): IntentSide => ({
    intentId: intent.intentId,
    taskId: intent.taskId,
    taskKey: input.tasks.get(intent.taskId)?.key ?? "",
    title: input.tasks.get(intent.taskId)?.title ?? "",
    agentId: intent.agentId,
    summary: intent.summary,
    semanticResources: intent.semanticResources,
    assumptions: intent.assumptions,
    createdAt: intent.createdAt,
  });
  let activeCandidates = input.activeCandidates;
  const planned: PlannedConflict[] = [];
  for (const report of reports) {
    const a = byId.get(report.intentIds[0]);
    const b = byId.get(report.intentIds[1]);
    if (!a || !b) continue;
    const id = await conflictId(report);
    if (input.done.has(id)) continue;
    const review = await (input.review ?? reviewConflict)(report, [a, b]);
    if (review.state !== "suspected" && review.state !== "confirmed") continue;
    const reviewed = {
      ...report,
      state: review.state,
      recommendedAction: review.recommendedAction,
    };
    const fork = forkDecision(reviewed, { activeCandidates });
    if (fork.kind === "fork") activeCandidates += 2;
    planned.push({
      id,
      report,
      review,
      intents: [side(a), side(b)],
      forkDecision: fork,
      challenge: review.state === "confirmed" ? challengeFor(id, reviewed, [a, b]) : null,
    });
  }
  return planned;
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** The `complete_task` arguments as a DeclaredIntent. Missing fields become empty lists. */
function declaredFrom(raw: Record<string, unknown>): DeclaredIntent {
  return {
    summary: typeof raw.summary === "string" ? raw.summary : "",
    semanticResources: strings(raw.semanticResources),
    expectedFiles: strings(raw.expectedFiles),
    expectedContractChanges: strings(raw.expectedContractChanges),
    expectedDataChanges: strings(raw.expectedDataChanges),
    assumptions: strings(raw.assumptions),
    expectedSymbols: strings(raw.expectedSymbols),
    expectedSideEffects: strings(raw.expectedSideEffects),
  };
}

/**
 * Declares the Intent on the Change's shard (one `intent.declared` per Intent), then runs the
 * deterministic conflict pass over every Intent of the Change. New suspected and confirmed
 * conflicts go to D1; a confirmed conflict also records a Challenge on the shard. Safe to repeat:
 * the Intent, the Challenge, and the conflict row are idempotent on their IDs.
 */
export async function declareIntentAndDetect(
  env: Env,
  ctx: ChangeContext,
  raw: Record<string, unknown>,
  meta: IntentMeta,
): Promise<{ intentId: string; conflicts: PlannedConflict[] }> {
  const intent = intentFromDeclaration(declaredFrom(raw), meta);
  const ns = env.RESOURCE_SHARD as DurableObjectNamespace<ResourceShardDO>;
  const shard = ns.get(ns.idFromName(shardKey(ctx.projectId, `change:${ctx.changeId}`)));
  const scope = {
    projectId: ctx.projectId,
    changeId: ctx.changeId,
    projectSlug: ctx.projectSlug,
    canonicalGeneration: ctx.baseGeneration,
  };
  const declared = await shard.declareIntent({ ...scope, intent });
  if (!declared.ok) throw new Error(`intent ${intent.intentId}: ${declared.reason}`);

  const [tasks, deps, recorded, candidates] = await env.DB.batch([
    env.DB.prepare("SELECT id, task_key, title FROM tasks WHERE change_id = ?").bind(ctx.changeId),
    env.DB.prepare(
      `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id WHERE t.change_id = ?`,
    ).bind(ctx.changeId),
    env.DB.prepare(
      "SELECT id, state, challenge_id, fork_decision_json FROM conflicts WHERE change_id = ?",
    ).bind(ctx.changeId),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM candidates WHERE change_id = ? AND status NOT IN (${INACTIVE_CANDIDATE_STATUSES.map(() => "?").join(", ")})`,
    ).bind(ctx.changeId, ...INACTIVE_CANDIDATE_STATUSES),
  ]);
  const taskRows = (tasks?.results ?? []) as {
    id: string;
    task_key: string | null;
    title: string | null;
  }[];
  const taskMap = new Map(
    taskRows.map((t) => [t.id, { key: t.task_key ?? "", title: t.title ?? "" }]),
  );
  const dependsOn: Record<string, string[]> = {};
  for (const e of (deps?.results ?? []) as { task_id: string; depends_on_task_id: string }[]) {
    dependsOn[e.task_id] = [...(dependsOn[e.task_id] ?? []), e.depends_on_task_id];
  }
  const rows = (recorded?.results ?? []) as {
    id: string;
    state: string;
    challenge_id: string | null;
    fork_decision_json: string;
  }[];
  // A confirmed row without a Challenge is retried; every other recorded row is done.
  const done = new Set(
    rows.filter((r) => r.state !== "confirmed" || r.challenge_id !== null).map((r) => r.id),
  );
  const plannedForks = rows.filter(
    (r) => (JSON.parse(r.fork_decision_json) as ForkDecision).kind === "fork",
  ).length;
  const active = (candidates?.results?.[0] as { n: number } | undefined)?.n ?? 0;

  // The shard can hold other Changes' Intents; keep this Change's Tasks only.
  const intents = (await shard.listIntents()).filter((i) => taskMap.has(i.taskId));
  const planned = await planConflicts({
    intents,
    tasks: taskMap,
    dependsOn,
    protectedResources: DEFAULT_PROTECTED_RESOURCES,
    done,
    activeCandidates: Math.max(active, plannedForks * 2),
  });
  if (planned.length === 0) return { intentId: intent.intentId, conflicts: [] };

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const conflict of planned) {
    let challengeId: string | null = null;
    if (conflict.challenge) {
      const created = await shard.createChallenge({ ...scope, challenge: conflict.challenge });
      if (created.ok) challengeId = conflict.challenge.challengeId;
      else console.warn(JSON.stringify({ event: "agent.challenge_rejected", id: conflict.id }));
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO conflicts (id, change_id, resource, state, recommended_action, report_json, intents_json,
           review_json, fork_decision_json, challenge_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET challenge_id = excluded.challenge_id, updated_at = excluded.updated_at
         WHERE conflicts.challenge_id IS NULL AND excluded.challenge_id IS NOT NULL`,
      ).bind(
        conflict.id,
        ctx.changeId,
        conflict.report.resource,
        conflict.review.state,
        conflict.review.recommendedAction,
        JSON.stringify(conflict.report),
        JSON.stringify(conflict.intents),
        JSON.stringify(conflict.review),
        JSON.stringify(conflict.forkDecision),
        challengeId,
        now,
        now,
      ),
    );
    env.METRICS.writeDataPoint({
      blobs: ["conflict_detected", conflict.review.state, conflict.report.resource],
      doubles: [1],
      indexes: [ctx.projectId],
    });
  }
  await env.DB.batch(statements);
  return { intentId: intent.intentId, conflicts: planned };
}
