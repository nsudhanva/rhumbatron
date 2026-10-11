import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  type ApprovalRecord,
  approvalRequired,
  checkApprovalDecision,
  checkPromotion,
  type PromotionBlock,
} from "@rhumbatron/evidence";
import {
  type Actor,
  type ApprovalOutcome,
  type ApprovalView,
  type ChangeStatus,
  type PromotionBlockView,
  type PromotionOutcome,
  PromotionRequest,
  RiskTier,
  VerificationPlan,
} from "@rhumbatron/protocol";
import { hasLiveApp } from "./app-release.ts";
import { candidateFork } from "./candidate-sandbox.ts";
import { pendingSiblings } from "./candidate-selection.ts";
import { syncCanonicalSource } from "./canonical-source.ts";
import { releaseRequestScope } from "./change-commands.ts";
import { changeAfterPromotion, PROMOTABLE_FROM } from "./change-status.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { type EvidenceRow, toRecord } from "./evidence-rows.ts";
import { loadProjectPolicy } from "./policy.ts";
import { recomposeQuietly } from "./recompose.ts";
import { changeEndedEvent, startRelease } from "./release.ts";

/**
 * Human approval and promotion (AGENTS.md sections 36, 40.2, 42.9, 60; ADR 0013). Called only by
 * the API over a service binding, after it authenticated the user and checked project membership.
 * Deterministic: authoritative D1 rows and Artifacts decide the preconditions, ProjectRootDO
 * decides the compare-and-swap. No model call and no cached gate score is trusted here.
 */

type CandidateRow = {
  id: string;
  change_id: string;
  base_generation: number;
  status: string;
  composed_commit: string | null;
  composed_tree: string | null;
  base_tree: string | null;
  plan_json: string | null;
  promoted_generation: number | null;
  project_id: string;
  change_status: ChangeStatus;
  risk_tier: string | null;
  org_id: string;
  slug: string;
};

type ApprovalRow = {
  id: string;
  candidate_id: string;
  change_id: string;
  decision: "granted" | "rejected";
  approver_user_id: string;
  candidate_tree: string;
  policy_version: string;
  reason: string | null;
  created_at: string;
};

async function loadCandidate(env: Env, candidateId: string) {
  return env.DB.prepare(
    `SELECT c.id, c.change_id, c.base_generation, c.status, c.composed_commit, c.composed_tree,
            c.base_tree, c.plan_json, c.promoted_generation, ch.project_id,
            ch.status AS change_status, ch.risk_tier,
            p.org_id, p.slug
     FROM candidates c JOIN changes ch ON ch.id = c.change_id
     JOIN projects p ON p.id = ch.project_id WHERE c.id = ?`,
  )
    .bind(candidateId)
    .first<CandidateRow>();
}

const loadApproval = (env: Env, candidateId: string) =>
  env.DB.prepare("SELECT * FROM approvals WHERE candidate_id = ?")
    .bind(candidateId)
    .first<ApprovalRow>();

const contextOf = (row: CandidateRow): ChangeContext => ({
  projectId: row.project_id,
  orgId: row.org_id,
  projectSlug: row.slug,
  changeId: row.change_id,
  baseGeneration: row.base_generation,
});

const planOf = (row: CandidateRow) =>
  row.plan_json ? (VerificationPlan.safeParse(JSON.parse(row.plan_json)).data ?? null) : null;

const riskOf = (row: CandidateRow) => RiskTier.catch("medium").parse(row.risk_tier ?? "medium");

const toApprovalRecord = (row: ApprovalRow): ApprovalRecord => ({
  approvalId: row.id,
  decision: row.decision,
  approverId: row.approver_user_id,
  candidateTree: row.candidate_tree,
});

const toApprovalView = (row: ApprovalRow): ApprovalView => ({
  id: row.id,
  candidateId: row.candidate_id,
  changeId: row.change_id,
  decision: row.decision,
  approverUserId: row.approver_user_id,
  candidateTree: row.candidate_tree,
  policyVersion: row.policy_version,
  reason: row.reason,
  createdAt: row.created_at,
});

const projectRoot = (env: Env, projectId: string) => {
  const ns = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  return ns.get(ns.idFromName(projectId));
};

/** Section 36 rule 8: the composed commit still exists in the Candidate fork with its tree. */
async function artifactPresent(env: Env, row: CandidateRow): Promise<boolean> {
  if (!row.composed_commit || !row.composed_tree) return false;
  try {
    using fork = await env.ARTIFACTS.get(candidateFork(row.id));
    const commit = await fork.readCommit(row.composed_commit);
    return commit?.treeHash === row.composed_tree;
  } catch {
    return false;
  }
}

function blockView(block: PromotionBlock): PromotionBlockView {
  switch (block.kind) {
    case "not_verified":
      return { kind: block.kind, detail: `Candidate is ${block.status}, not verified.` };
    case "stale":
      return {
        kind: block.kind,
        detail: `Base S${block.baseGeneration} is behind canonical S${block.canonicalGeneration}.`,
      };
    case "missing_plan":
      return { kind: block.kind, detail: "No Verification Plan is recorded for this Candidate." };
    case "evidence_gap":
      return {
        kind: block.kind,
        detail: `Required checks not satisfied: ${block.gaps.map((g) => `${g.checkId} (${g.reason})`).join(", ")}`,
      };
    case "approval_pending":
      return { kind: block.kind, detail: "A human approval is required and not recorded yet." };
    case "approval_rejected":
      return { kind: block.kind, detail: "A human approver rejected this Candidate." };
    case "policy_mismatch":
      return {
        kind: block.kind,
        detail: `Verified under ${block.planPolicyVersion}; active policy is ${block.activePolicyVersion}.`,
      };
    case "artifact_missing":
      return {
        kind: block.kind,
        detail: "The composed commit is missing from the Candidate fork.",
      };
    case "selection_pending":
      return {
        kind: block.kind,
        detail: `Sibling Candidates are still verifying (${block.pendingCandidateIds.join(", ")}); the winner is selected when they finish.`,
      };
  }
}

/** Section 42.9: a stale Candidate is not retried blind. It needs a new Candidate on the new base. */
async function markStale(
  env: Env,
  row: CandidateRow,
  canonicalGeneration: number,
  treeMismatch = false,
) {
  const reason = treeMismatch
    ? `Canonical tree changed at S${canonicalGeneration} since this Candidate was composed.`
    : `Canonical advanced to S${canonicalGeneration} before promotion from S${row.base_generation}.`;
  const updated = await env.DB.prepare(
    `UPDATE candidates SET status = 'stale', status_reason = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('stale', 'promoted', 'rejected')`,
  )
    .bind(reason, new Date().toISOString(), row.id)
    .run();
  if (updated.meta.changes > 0) {
    const ctx = contextOf(row);
    await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
      await changeEvent(
        ctx,
        "candidate.stale",
        { candidateId: row.id, status: "stale", reason, canonicalGeneration },
        { key: row.id, actor: { kind: "system", id: "promotion" } },
      ),
    ]);
  }
  return reason;
}

/** Verified Candidates per promotion that the sweep marks stale (bounded work per request). */
const STALE_SWEEP_LIMIT = 10;

/**
 * Marks verified Candidates of this Project whose base is behind `generation` stale, settles their
 * Changes out of `awaiting_approval`, and recomposes them (P16-14). Never fails the caller.
 */
async function staleBehind(env: Env, projectId: string, generation: number) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT c.id FROM candidates c JOIN changes ch ON ch.id = c.change_id
       WHERE ch.project_id = ? AND c.status = 'verified' AND c.base_generation < ?
       ORDER BY c.updated_at LIMIT ?`,
    )
      .bind(projectId, generation, STALE_SWEEP_LIMIT)
      .all<{ id: string }>();
    for (const { id } of results) await markCandidateStale(env, id, generation);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "promotion.stale_sweep_failed",
        message: String(error).slice(0, 200),
      }),
    );
  }
}

/**
 * Section 42.9 for a Candidate that cannot promote because canonical moved: stale, its Change out
 * of `awaiting_approval`, then recomposed on the new canonical state (at most twice per lineage).
 * Used by the promotion sweep and by verification when canonical moved during the checks.
 */
export async function markCandidateStale(
  env: Env,
  candidateId: string,
  canonicalGeneration: number,
) {
  const row = await loadCandidate(env, candidateId);
  if (!row || ["promoted", "rejected"].includes(row.status)) return;
  // Already stale (the event router's sweep got there first): still recompose it, or nothing will.
  if (row.status !== "stale") await markStale(env, row, canonicalGeneration);
  await settleAwaitingApproval(env, row.change_id, new Date().toISOString()).run();
  await recomposeQuietly(env, candidateId);
}

/** Product metadata mirrors of the authoritative transition. Safe to repeat. */
async function recordPromoted(env: Env, row: CandidateRow, generation: number) {
  const now = new Date().toISOString();
  // With a live app the Change is `releasing` until ReleaseWorkflow finishes (release.ts);
  // without one, promotion completes it. A Change already past promotion keeps its status.
  const next = changeAfterPromotion(await hasLiveApp(env, row.project_id));
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE candidates SET status = 'promoted', promoted_generation = ?, status_reason = NULL,
         updated_at = ? WHERE id = ?`,
    ).bind(generation, now, row.id),
    env.DB.prepare(
      `UPDATE changes SET status = ?, updated_at = ?
       WHERE id = ? AND status IN (SELECT value FROM json_each(?))`,
    ).bind(next, now, row.change_id, JSON.stringify(PROMOTABLE_FROM)),
    env.DB.prepare(
      `UPDATE projects SET canonical_generation = MAX(canonical_generation, ?), updated_at = ?
       WHERE id = ?`,
    ).bind(generation, now, row.project_id),
    env.DB.prepare("SELECT status FROM changes WHERE id = ?").bind(row.change_id),
  ]);
  // Without a live app, promotion ends the Change: say so, so the live view leaves
  // `promoting` (section 13.3). A `releasing` Change ends with its release (release.ts).
  const status = (results.at(-1)?.results?.[0] as { status?: string } | undefined)?.status;
  if (next === "completed" && status === "completed") {
    await releaseRequestScope(env, row.project_id, row.change_id);
    const ctx = contextOf(row);
    await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
      await changeEndedEvent(ctx, "completed", { candidateId: row.id, generation }),
    ]);
  }
}

async function promoted(
  env: Env,
  row: CandidateRow,
  generation: number,
  alreadyPromoted: boolean,
): Promise<PromotionOutcome> {
  const commit = row.composed_commit ?? "";
  const treeSha = row.composed_tree ?? "";
  const sync = await syncCanonicalSource(env, {
    projectId: row.project_id,
    candidateId: row.id,
    commit,
    treeSha,
  });
  if (!sync.synced) {
    console.error(
      JSON.stringify({
        event: "promotion.source_sync_failed",
        candidateId: row.id,
        generation,
        detail: sync.detail,
      }),
    );
  } else {
    // Canonical `main` is at the promoted commit. Only a Project with a live app releases (ADR 0020). Idempotent per generation; never fails promotion.
    await startRelease(env, {
      projectId: row.project_id,
      changeId: row.change_id,
      candidateId: row.id,
      generation,
      commit: sync.commit,
    });
  }
  // P16-14: verified Candidates of other Changes on an older base can no longer promote. Mark them
  // stale now and recompose them on this generation, so parallel Changes ship without a person.
  await staleBehind(env, row.project_id, generation);
  return {
    status: "promoted",
    candidateId: row.id,
    fromGeneration: generation - 1,
    generation,
    alreadyPromoted,
    treeSha,
    sourceSynced: sync.synced,
    sourceCommit: sync.commit,
  };
}

/**
 * A Change in `awaiting_approval` whose Candidates are no longer verified (rejected or stale) is
 * back to `verifying`: no decision is pending, and a new Candidate can still be verified.
 */
const settleAwaitingApproval = (env: Env, changeId: string, now: string) =>
  env.DB.prepare(
    `UPDATE changes SET status = 'verifying', updated_at = ?
     WHERE id = ? AND status = 'awaiting_approval'
       AND NOT EXISTS (SELECT 1 FROM candidates WHERE change_id = ? AND status = 'verified')`,
  ).bind(now, changeId, changeId);

/** A refused compare-and-swap leaves promotion: the Change returns to its status before it. */
async function leavePromoting(env: Env, row: CandidateRow) {
  const now = new Date().toISOString();
  // A retry after a crash read `promoting` as the prior status; `verifying` is the open fallback.
  const prior = row.change_status === "promoting" ? "verifying" : row.change_status;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE changes SET status = ?, updated_at = ? WHERE id = ? AND status = 'promoting'",
    ).bind(prior, now, row.change_id),
    settleAwaitingApproval(env, row.change_id, now),
  ]);
}

/**
 * Who asked for a promotion. `manual` is a person in the UI. `auto` is the verification workflow
 * applying policy `autoPromoteRiskTiers` (actor kind `system`). Both take the same path below.
 */
export type PromotionTrigger = {
  trigger: "manual" | "auto";
  actor: { kind: Exclude<Actor["kind"], "agent">; id: string };
};

/**
 * Promotes a verified Candidate by compare-and-swap. Idempotency key: Candidate ID + base
 * generation (section 60). A retry after success returns `alreadyPromoted` and repairs the source
 * sync if it did not finish. The Change is `promoting` from the precondition check until the
 * compare-and-swap decides; then `releasing` or `completed`, or back to its prior status.
 */
export async function promoteCandidate(
  env: Env,
  input: { candidateId: string } & PromotionTrigger,
): Promise<PromotionOutcome> {
  const row = await loadCandidate(env, input.candidateId);
  if (!row) throw new Error(`Candidate ${input.candidateId} not found`);
  if (row.status === "promoted" && row.promoted_generation !== null) {
    // Repairs the Change status too, if the first attempt stopped after the compare-and-swap.
    await recordPromoted(env, row, row.promoted_generation);
    return promoted(env, row, row.promoted_generation, true);
  }

  const root = projectRoot(env, row.project_id);
  const [canonical, evidence, approval, present, policy, pendingSiblingIds] = await Promise.all([
    root.getCanonical(),
    env.DB.prepare("SELECT * FROM evidence_index WHERE candidate_id = ?")
      .bind(row.id)
      .all<EvidenceRow>(),
    loadApproval(env, row.id),
    artifactPresent(env, row),
    // Stored policy through the KV snapshot; DEFAULT_POLICY without a row. It can only add a gate.
    loadProjectPolicy(env, row.project_id),
    // ADR 0026: no Candidate is the winner while a sibling on the same base still verifies.
    pendingSiblings(env.DB, row.id),
  ]);
  if (!canonical || canonical.artifactRef === "unassigned") {
    throw new Error(`Project ${row.project_id} has no canonical source`);
  }
  // The CAS already succeeded but D1 did not record it (crash between the two): repair the mirror.
  if (canonical.lastPromotedCandidateId === row.id) {
    await recordPromoted(env, row, row.base_generation + 1);
    return promoted(env, row, row.base_generation + 1, true);
  }
  const plan = planOf(row);
  const check = checkPromotion({
    candidate: {
      id: row.id,
      status: row.status,
      baseGeneration: row.base_generation,
      composedTree: row.composed_tree,
      plan,
    },
    riskTier: riskOf(row),
    policy,
    evidence: (evidence.results ?? []).map(toRecord),
    approval: approval ? toApprovalRecord(approval) : null,
    canonical: { generation: canonical.generation, policyVersion: canonical.policyVersion },
    artifactPresent: present,
    pendingSiblingIds,
  });

  if (!check.ok) {
    // A rejected Candidate stays rejected; any other Candidate on an old base is stale.
    if (row.status !== "rejected" && check.blocks.some((b) => b.kind === "stale")) {
      const reason = await markStale(env, row, canonical.generation);
      await settleAwaitingApproval(env, row.change_id, new Date().toISOString()).run();
      await recomposeQuietly(env, row.id);
      return {
        status: "stale",
        candidateId: row.id,
        baseGeneration: row.base_generation,
        canonicalGeneration: canonical.generation,
        reason,
      };
    }
    return { status: "blocked", candidateId: row.id, blocks: check.blocks.map(blockView) };
  }

  // Section 36 runs on an open Change only. The guard also loses a race against a cancel cleanly.
  const now = new Date().toISOString();
  const entered = await env.DB.prepare(
    `UPDATE changes SET status = 'promoting', updated_at = ?
     WHERE id = ? AND status IN (SELECT value FROM json_each(?))`,
  )
    .bind(now, row.change_id, JSON.stringify(PROMOTABLE_FROM))
    .run();
  if (!entered.meta.changes) {
    const change = await env.DB.prepare("SELECT status FROM changes WHERE id = ?")
      .bind(row.change_id)
      .first<{ status: string }>();
    return {
      status: "blocked",
      candidateId: row.id,
      blocks: [
        {
          kind: "not_verified",
          detail: `The Change is ${change?.status ?? "missing"}; its Candidates cannot promote.`,
        },
      ],
    };
  }

  const ctx = contextOf(row);
  const request = PromotionRequest.parse({
    projectId: row.project_id,
    changeId: row.change_id,
    candidateId: row.id,
    expectedCanonicalGeneration: row.base_generation,
    ...(row.base_tree ? { expectedCanonicalTree: row.base_tree } : {}),
    candidateTree: row.composed_tree,
    requiredEvidenceIds: check.requiredEvidenceIds,
    policyVersion: plan?.policyVersion,
  });
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "canonical.promotion.requested",
      {
        ...request,
        approvalId: check.approvalId,
        trigger: input.trigger,
        ...(input.trigger === "auto"
          ? { riskTier: riskOf(row), policy: "autoPromoteRiskTiers" }
          : {}),
      },
      { key: `${row.id}:${row.base_generation}`, actor: input.actor },
    ),
  ]);

  const result = await root.promote({
    candidateId: request.candidateId,
    expectedGeneration: request.expectedCanonicalGeneration,
    ...(request.expectedCanonicalTree ? { expectedTreeSha: request.expectedCanonicalTree } : {}),
    candidateArtifactRef: `artifacts://${row.project_id}@${row.composed_commit}`,
    candidateTreeSha: request.candidateTree,
    policyVersion: request.policyVersion,
    changeId: request.changeId,
    actor: input.actor,
    correlationId: request.changeId,
    requiredEvidenceIds: request.requiredEvidenceIds,
    approvalId: check.approvalId,
  });

  if (result.ok) {
    await recordPromoted(env, row, result.generation);
    return promoted(env, row, result.generation, result.alreadyPromoted);
  }
  if (result.reason === "policy_mismatch") {
    await leavePromoting(env, row);
    return {
      status: "blocked",
      candidateId: row.id,
      blocks: [
        blockView({
          kind: "policy_mismatch",
          planPolicyVersion: request.policyVersion,
          activePolicyVersion: result.activePolicyVersion,
        }),
      ],
    };
  }
  const reason = await markStale(
    env,
    row,
    result.detail.current.generation,
    result.detail.reason === "tree_mismatch",
  );
  await leavePromoting(env, row);
  // After the Change left `promoting`: recomposition skips a closed Change.
  await recomposeQuietly(env, row.id);
  return {
    status: "stale",
    candidateId: row.id,
    baseGeneration: row.base_generation,
    canonicalGeneration: result.detail.current.generation,
    reason,
  };
}

/**
 * Records one human decision on a gated Candidate (section 40.2). The approver is the
 * authenticated project member the API passes in; the browser cannot name another approver.
 * A rejection also rejects the Candidate, so it can never promote.
 */
export async function decideApproval(
  env: Env,
  input: {
    candidateId: string;
    approverUserId: string;
    decision: "granted" | "rejected";
    reason: string | null;
  },
): Promise<ApprovalOutcome> {
  const row = await loadCandidate(env, input.candidateId);
  if (!row) throw new Error(`Candidate ${input.candidateId} not found`);
  const existing = await loadApproval(env, row.id);
  const plan = planOf(row);
  const check = checkApprovalDecision({
    candidateStatus: row.status,
    required: plan
      ? approvalRequired(plan, riskOf(row), await loadProjectPolicy(env, row.project_id))
      : false,
    existing: existing ? toApprovalRecord(existing) : null,
    decision: input.decision,
    approverId: input.approverUserId,
  });
  if (check.kind === "refuse") {
    return {
      status: "refused",
      reason: check.reason,
      approval: existing ? toApprovalView(existing) : null,
    };
  }
  if (check.kind === "repeat" && existing) {
    return { status: "recorded", approval: toApprovalView(existing), repeated: true };
  }
  if (!plan || !row.composed_tree) throw new Error("A verified Candidate has a plan and a tree");

  const now = new Date().toISOString();
  // One row per Candidate: a concurrent second decision loses on the unique key.
  await env.DB.prepare(
    `INSERT INTO approvals (id, candidate_id, change_id, project_id, decision, approver_user_id,
       candidate_tree, policy_version, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (candidate_id) DO NOTHING`,
  )
    .bind(
      `apr_${row.id.slice(5)}`,
      row.id,
      row.change_id,
      row.project_id,
      input.decision,
      input.approverUserId,
      row.composed_tree,
      plan.policyVersion,
      input.reason,
      now,
    )
    .run();
  const stored = await loadApproval(env, row.id);
  if (!stored) throw new Error("Approval was not readable after insert");
  if (stored.decision !== input.decision || stored.approver_user_id !== input.approverUserId) {
    return { status: "refused", reason: "already_decided", approval: toApprovalView(stored) };
  }
  if (stored.decision === "rejected") {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE candidates SET status = 'rejected', status_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'verified'`,
      ).bind(
        `Rejected by a human approver${input.reason ? `: ${input.reason}` : "."}`.slice(0, 500),
        now,
        row.id,
      ),
      settleAwaitingApproval(env, row.change_id, now),
    ]);
  }
  const ctx = contextOf(row);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      stored.decision === "granted" ? "approval.granted" : "approval.rejected",
      {
        candidateId: row.id,
        approvalId: stored.id,
        candidateTree: stored.candidate_tree,
        policyVersion: stored.policy_version,
      },
      { key: row.id, actor: { kind: "user", id: input.approverUserId } },
    ),
  ]);
  return { status: "recorded", approval: toApprovalView(stored), repeated: false };
}
