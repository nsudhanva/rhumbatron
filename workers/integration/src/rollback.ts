import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { approvalRequired } from "@rhumbatron/evidence";
import {
  type EventEnvelope,
  type EvidenceRecord,
  type RollbackOutcome,
  sourceIndexKey,
} from "@rhumbatron/protocol";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createFsFromVolume, Volume } from "memfs";
import {
  decideRollback,
  ROLLBACK_CHECK_ID,
  rollbackPlan,
  rollbackRiskTier,
} from "./app-release-model.ts";
import { forkCandidate } from "./candidate-sandbox.ts";
import { repoAccess } from "./canonical-source.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { loadProjectPolicy } from "./policy.ts";
import { promoteCandidate } from "./promotion.ts";

/**
 * Roll back to Sk. A rollback is never a deletion:
 * it is the new canonical transition Sn -> Sn+1 whose tree equals Sk's tree, and it takes the same
 * path as every promotion.
 *
 * 1. `decideRollback` (pure, unit tested) checks the transition rule.
 * 2. A rollback Change and Candidate are created (idempotency key: Project, Sn, Sk).
 * 3. The Candidate fork gets one commit on top of Sn's commit whose tree is Sk's tree (isomorphic-git
 *    in the Worker, no Sandbox). Commit dates are fixed per Candidate, so a retry makes the same
 *    commit.
 * 4. Evidence: Artifacts reports that commit's tree, and it must equal Sk's tree. That is the one
 *    required check; Sk's own verification Evidence is cited.
 * 5. Policy decides the human gate from the riskiest Change being undone. Gated: the Candidate
 *    waits for an approval, then promotes like any other. Not gated: it promotes at once.
 * 6. ProjectRootDO compare-and-swap, the source sync, and the release run as for any Candidate:
 *    the release points production at Sk's bundle (no rebuild).
 *
 * Deterministic. No model call decides a rollback.
 */

const DIR = "/repo";
const AUTHOR = { name: "Rhumbatron", email: "bot@rhumbatron.com" };
const ACTOR = { kind: "system", id: "rollback" } as const;

type Target = { generation: number; treeSha: string; commit: string; candidateId: string | null };

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sk's tree and commit: the promoted Candidate of Sk, or the provisioned tree for S0. */
async function resolveTarget(
  env: Env,
  projectId: string,
  generation: number,
): Promise<Target | null> {
  if (generation === 0) {
    const first = await env.DB.prepare(
      `SELECT c.base_tree FROM candidates c JOIN changes ch ON ch.id = c.change_id
       WHERE ch.project_id = ? AND c.promoted_generation = 1 AND c.status = 'promoted' LIMIT 1`,
    )
      .bind(projectId)
      .first<{ base_tree: string | null }>();
    if (!first?.base_tree) return null;
    const index = await env.EVIDENCE.get(sourceIndexKey(projectId, first.base_tree));
    const commit = index ? ((await index.json()) as { commit?: string }).commit : undefined;
    return commit ? { generation: 0, treeSha: first.base_tree, commit, candidateId: null } : null;
  }
  const row = await env.DB.prepare(
    `SELECT c.id, c.composed_tree, c.composed_commit FROM candidates c
     JOIN changes ch ON ch.id = c.change_id
     WHERE ch.project_id = ? AND c.promoted_generation = ? AND c.status = 'promoted' LIMIT 1`,
  )
    .bind(projectId, generation)
    .first<{ id: string; composed_tree: string | null; composed_commit: string | null }>();
  if (!row?.composed_tree || !row.composed_commit) return null;
  return {
    generation,
    treeSha: row.composed_tree,
    commit: row.composed_commit,
    candidateId: row.id,
  };
}

/**
 * Pushes one commit onto the fork's `main`: parent = the fork head (Sn's commit), tree = Sk's
 * tree. Sk is an ancestor of Sn (canonical `main` only fast-forwards), so its tree is in the
 * fetched history. Returns the commit and its tree as Artifacts reports them.
 */
async function writeRollbackCommit(
  env: Env,
  input: {
    fork: string;
    baseTree: string;
    targetTree: string;
    targetGeneration: number;
    baseGeneration: number;
    time: number;
  },
): Promise<{ commit: string; tree: string }> {
  const fs = createFsFromVolume(new Volume()) as unknown as Parameters<typeof git.init>[0]["fs"];
  await git.init({ fs, dir: DIR, defaultBranch: "main" });
  const access = await repoAccess(env, input.fork, "write");
  try {
    await git.addRemote({ fs, dir: DIR, remote: "origin", url: access.remote, force: true });
    await git.fetch({
      fs,
      http,
      dir: DIR,
      remote: "origin",
      url: access.remote,
      ref: "main",
      singleBranch: true,
      tags: false,
      onAuth: access.onAuth,
    });
    const head = await git.resolveRef({ fs, dir: DIR, ref: "refs/remotes/origin/main" });
    const headCommit = await git.readCommit({ fs, dir: DIR, oid: head });
    let commit = head;
    if (headCommit.commit.tree === input.targetTree) {
      // A retry after the push: the fork already holds the rollback commit.
    } else {
      if (headCommit.commit.tree !== input.baseTree) {
        throw new Error("the fork head is not the canonical tree; the source is not synced yet");
      }
      // Throws when Sk's tree is not in the history.
      await git.readTree({ fs, dir: DIR, oid: input.targetTree });
      const signature = { ...AUTHOR, timestamp: input.time, timezoneOffset: 0 };
      commit = await git.commit({
        fs,
        dir: DIR,
        message: `Roll back to S${input.targetGeneration}\n\nRhumbatron rollback: S${input.baseGeneration} -> S${input.baseGeneration + 1} with the tree of S${input.targetGeneration}. History is kept.\n`,
        author: signature,
        committer: signature,
        tree: input.targetTree,
        parent: [head],
        ref: "refs/heads/rollback",
      });
      const result = await git.push({
        fs,
        http,
        dir: DIR,
        url: access.remote,
        ref: "refs/heads/rollback",
        remoteRef: "refs/heads/main",
        onAuth: access.onAuth,
      });
      if (!result.ok) {
        throw new Error(`push rejected: ${JSON.stringify(result.refs).slice(0, 200)}`);
      }
    }
    // Evidence comes from Artifacts, not from the local object store.
    using repo = await env.ARTIFACTS.get(input.fork);
    const stored = await repo.readCommit(commit);
    if (!stored) throw new Error("the rollback commit is not readable in the fork");
    return { commit, tree: stored.treeHash };
  } finally {
    await access.revoke();
  }
}

async function recordEvidence(
  env: Env,
  ctx: ChangeContext,
  candidateId: string,
  input: { passed: boolean; summary: string; output: string; sourceRefs: string[] },
): Promise<EvidenceRecord> {
  const prefix = `evidence/${ctx.projectId}/${ctx.changeId}/${candidateId}/${ROLLBACK_CHECK_ID}`;
  const now = new Date().toISOString();
  const contentHash = `sha256:${await sha256(input.output)}`;
  const record: EvidenceRecord = {
    evidenceId: `ev_${candidateId.slice(5)}_${ROLLBACK_CHECK_ID}`,
    candidateId,
    checkId: ROLLBACK_CHECK_ID,
    kind: "static-analysis",
    status: input.passed ? "pass" : "fail",
    coverage: "checked_supported",
    startedAt: now,
    completedAt: now,
    summary: input.summary.slice(0, 500),
    contentHash,
    r2Key: `${prefix}/report.json`,
    sourceRefs: input.sourceRefs,
  };
  await env.EVIDENCE.put(`${prefix}/stdout.txt`, input.output, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { contentHash },
  });
  await env.EVIDENCE.put(
    `${prefix}/report.json`,
    JSON.stringify({ record, stdoutKey: `${prefix}/stdout.txt` }, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );
  await env.DB.prepare(
    `INSERT OR REPLACE INTO evidence_index (id, candidate_id, kind, status, summary, r2_key,
       content_hash, created_at, check_id, coverage, started_at, completed_at, metrics_json,
       source_refs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(
      record.evidenceId,
      candidateId,
      record.kind,
      record.status,
      record.summary,
      record.r2Key ?? null,
      contentHash,
      now,
      record.checkId,
      record.coverage,
      record.startedAt,
      record.completedAt,
      JSON.stringify(record.sourceRefs),
    )
    .run();
  return record;
}

const refuse = (
  reason: Extract<RollbackOutcome, { status: "refused" }>["reason"],
  detail: string,
): RollbackOutcome => ({ status: "refused", reason, detail });

/**
 * Requests a rollback of the Project to Sk. The API authenticated the user and checked project
 * membership. Safe to repeat with the same generations: it finds the same Change and Candidate,
 * and after an approval a repeat promotes it.
 */
export async function requestRollback(
  env: Env,
  input: {
    projectId: string;
    targetGeneration: number;
    expectedGeneration: number;
    actorUserId: string;
  },
): Promise<RollbackOutcome> {
  const project = await env.DB.prepare("SELECT org_id, slug, status FROM projects WHERE id = ?")
    .bind(input.projectId)
    .first<{ org_id: string; slug: string; status: string }>();
  if (!project) return refuse("not_found", "Project not found.");
  if (project.status !== "active") return refuse("archived", "The Project is archived.");
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(input.projectId)).getCanonical();
  if (!canonical || canonical.artifactRef === "unassigned") {
    return refuse("no_source", "The Project has no canonical source.");
  }

  const clientRequestId = `rollback-s${input.expectedGeneration}-to-s${input.targetGeneration}`;
  const existing = await env.DB.prepare(
    "SELECT id FROM changes WHERE project_id = ? AND client_request_id = ?",
  )
    .bind(input.projectId, clientRequestId)
    .first<{ id: string }>();
  const candidateId = `cand_${(
    await sha256(
      `rollback\n${input.projectId}\n${input.expectedGeneration}\n${input.targetGeneration}`,
    )
  ).slice(0, 24)}`;

  const target =
    input.targetGeneration < input.expectedGeneration
      ? await resolveTarget(env, input.projectId, input.targetGeneration)
      : null;
  // A repeat of a rollback that already ran skips the rule: it reports the rollback, or promotes
  // it after its approval.
  if (!existing) {
    const decision = decideRollback({
      current: { generation: canonical.generation, treeSha: canonical.treeSha },
      expectedGeneration: input.expectedGeneration,
      targetGeneration: input.targetGeneration,
      target,
    });
    if (decision.kind === "refuse") return refuse(decision.reason, decision.detail);
  }
  if (!target) return refuse("unknown_target", `S${input.targetGeneration} has no recorded tree.`);
  const undone = await env.DB.prepare(
    `SELECT ch.risk_tier FROM candidates c JOIN changes ch ON ch.id = c.change_id
     WHERE ch.project_id = ? AND c.status = 'promoted'
       AND c.promoted_generation > ? AND c.promoted_generation <= ?`,
  )
    .bind(input.projectId, input.targetGeneration, input.expectedGeneration)
    .all<{ risk_tier: string | null }>();
  const riskTier = rollbackRiskTier(undone.results.map((r) => r.risk_tier));
  const policy = await loadProjectPolicy(env, input.projectId);

  // The rollback Change: no Work Graph, no agents. Its one Candidate carries Sk's tree.
  const now = new Date().toISOString();
  const goal = `Roll back to S${input.targetGeneration}`;
  await env.DB.prepare(
    `INSERT INTO changes (id, project_id, goal, status, base_generation, risk_tier, budget_usd,
       client_request_id, created_by, created_at, updated_at, acceptance_criteria_json)
     VALUES (?, ?, ?, 'verifying', ?, ?, 0, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, client_request_id) DO NOTHING`,
  )
    .bind(
      `chg_${crypto.randomUUID()}`,
      input.projectId,
      goal,
      input.expectedGeneration,
      riskTier,
      clientRequestId,
      input.actorUserId,
      now,
      now,
      JSON.stringify([
        `The new version's tree equals S${input.targetGeneration}'s tree.`,
        `S${input.expectedGeneration} and every earlier version stay in the history.`,
      ]),
    )
    .run();
  const change = await env.DB.prepare(
    "SELECT id, created_at FROM changes WHERE project_id = ? AND client_request_id = ?",
  )
    .bind(input.projectId, clientRequestId)
    .first<{ id: string; created_at: string }>();
  if (!change) throw new Error("rollback Change was not readable after insert");
  const ctx: ChangeContext = {
    projectId: input.projectId,
    orgId: project.org_id,
    projectSlug: project.slug,
    changeId: change.id,
    baseGeneration: input.expectedGeneration,
  };
  await env.DB.prepare(
    `INSERT INTO candidates (id, change_id, base_generation, status, created_at, updated_at,
       composition_key, change_set_ids_json, rollback_of_generation, base_tree)
     VALUES (?, ?, ?, 'composing', ?, ?, ?, '[]', ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(
      candidateId,
      change.id,
      input.expectedGeneration,
      now,
      now,
      clientRequestId,
      input.targetGeneration,
      canonical.treeSha,
    )
    .run();
  const candidate = await env.DB.prepare("SELECT status FROM candidates WHERE id = ?")
    .bind(candidateId)
    .first<{ status: string }>();
  const ids = { changeId: change.id, candidateId, targetGeneration: input.targetGeneration };

  if (candidate?.status === "composing") {
    if (canonical.generation !== input.expectedGeneration) {
      return refuse("stale", `Canonical moved to S${canonical.generation}. Reload and try again.`);
    }
    const actor = { kind: "user" as const, id: input.actorUserId };
    const plan = rollbackPlan({
      candidateId,
      targetGeneration: input.targetGeneration,
      policyVersion: canonical.policyVersion,
      humanApprovalRequired: false,
    });
    const gated = approvalRequired(plan, riskTier, policy);
    const fork = await forkCandidate(env, input.projectId, candidateId);
    const written = await writeRollbackCommit(env, {
      fork,
      baseTree: canonical.treeSha,
      targetTree: target.treeSha,
      targetGeneration: input.targetGeneration,
      baseGeneration: input.expectedGeneration,
      time: Math.floor(Date.parse(change.created_at) / 1000),
    });
    const passed = written.tree === target.treeSha;
    const cited = target.candidateId
      ? (
          await env.DB.prepare(
            "SELECT id FROM evidence_index WHERE candidate_id = ? AND status = 'pass' LIMIT 20",
          )
            .bind(target.candidateId)
            .all<{ id: string }>()
        ).results.map((r) => r.id)
      : [];
    const record = await recordEvidence(env, ctx, candidateId, {
      passed,
      summary: passed
        ? `Commit ${written.commit.slice(0, 12)} has tree ${written.tree.slice(0, 12)}, the tree S${input.targetGeneration} promoted.`
        : `Commit ${written.commit.slice(0, 12)} has tree ${written.tree.slice(0, 12)}, not S${input.targetGeneration}'s ${target.treeSha.slice(0, 12)}.`,
      output: [
        `rollback S${input.expectedGeneration} -> S${input.expectedGeneration + 1} with the tree of S${input.targetGeneration}`,
        `S${input.targetGeneration}: commit ${target.commit} tree ${target.treeSha}${target.candidateId ? ` (Candidate ${target.candidateId})` : " (provisioned source)"}`,
        `rollback commit ${written.commit} in ${fork}: tree ${written.tree} (read from Artifacts)`,
        `parent: S${input.expectedGeneration} tree ${canonical.treeSha}`,
        `result: ${passed ? "pass" : "FAIL"}`,
        `risk tier ${riskTier} (riskiest undone Change); human approval ${gated ? "required" : "not required"} by policy ${policy.version}`,
      ].join("\n"),
      sourceRefs: [
        `artifacts://${fork}@${written.commit}`,
        `artifacts://${input.projectId}@${target.commit}`,
        ...cited,
      ],
    });
    const status = passed ? "verified" : "rejected";
    await env.DB.prepare(
      `UPDATE candidates SET status = ?, status_reason = ?, artifact_ref = ?, composed_commit = ?,
         composed_tree = ?, plan_json = ?, score_json = ?, updated_at = ?
       WHERE id = ? AND status = 'composing'`,
    )
      .bind(
        status,
        passed ? null : record.summary,
        `artifacts://${fork}@${written.commit}`,
        written.commit,
        written.tree,
        JSON.stringify({ ...plan, humanApprovalRequired: gated }),
        JSON.stringify({
          promotable: passed,
          gaps: passed ? [] : [{ checkId: ROLLBACK_CHECK_ID, reason: "failed" }],
          humanApprovalRequired: gated,
          rollbackOf: { generation: input.targetGeneration, commit: target.commit },
        }),
        new Date().toISOString(),
        candidateId,
      )
      .run();
    if (passed && gated) {
      await env.DB.prepare(
        "UPDATE changes SET status = 'awaiting_approval', updated_at = ? WHERE id = ? AND status = 'verifying'",
      )
        .bind(new Date().toISOString(), change.id)
        .run();
    }
    const events: EventEnvelope[] = [
      await changeEvent(
        ctx,
        "change.created",
        { goal, rollbackOf: input.targetGeneration },
        {
          actor,
        },
      ),
      await changeEvent(
        ctx,
        "candidate.forked",
        {
          candidateId,
          baseGeneration: input.expectedGeneration,
          changeSetIds: [],
          trigger: "rollback",
          rollbackOf: input.targetGeneration,
        },
        { key: candidateId, actor: ACTOR },
      ),
      await changeEvent(
        ctx,
        "candidate.composed",
        {
          candidateId,
          artifactRef: `artifacts://${fork}@${written.commit}`,
          composedTree: written.tree,
          changeSetIds: [],
          requiredCheckIds: plan.requiredCheckIds,
        },
        { key: candidateId, actor: ACTOR },
      ),
      await changeEvent(
        ctx,
        "verification.completed",
        { candidateId, status, promotable: passed, humanApprovalRequired: gated },
        { key: candidateId, actor: ACTOR },
      ),
      ...(passed && gated
        ? [
            await changeEvent(
              ctx,
              "approval.requested",
              { candidateId, riskTier, policyVersion: plan.policyVersion },
              { key: candidateId, actor: ACTOR },
            ),
          ]
        : []),
    ];
    await appendChangeEvents(env.RESOURCE_SHARD, ctx, events);
    if (!passed) return refuse("unknown_target", record.summary);
  }

  const after = await env.DB.prepare(
    `SELECT c.status, c.promoted_generation, c.plan_json, ch.status AS change_status
     FROM candidates c JOIN changes ch ON ch.id = c.change_id WHERE c.id = ?`,
  )
    .bind(candidateId)
    .first<{
      status: string;
      promoted_generation: number | null;
      plan_json: string | null;
      change_status: string;
    }>();
  if (after?.status === "promoted" && after.promoted_generation !== null) {
    return {
      status: "promoted",
      ...ids,
      generation: after.promoted_generation,
      alreadyPromoted: true,
    };
  }
  if (after?.status !== "verified") {
    return refuse(
      after?.status === "stale" ? "stale" : "in_progress",
      `The rollback Candidate is ${after?.status ?? "missing"}.`,
    );
  }
  const approval = await env.DB.prepare("SELECT decision FROM approvals WHERE candidate_id = ?")
    .bind(candidateId)
    .first<{ decision: string }>();
  const plan = after.plan_json
    ? (JSON.parse(after.plan_json) as { humanApprovalRequired?: boolean })
    : {};
  if (plan.humanApprovalRequired && approval?.decision !== "granted") {
    return { status: "awaiting_approval", ...ids };
  }
  const outcome = await promoteCandidate(env, {
    candidateId,
    trigger: "manual",
    actor: { kind: "user", id: input.actorUserId },
  });
  if (outcome.status === "promoted") {
    return {
      status: "promoted",
      ...ids,
      generation: outcome.generation,
      alreadyPromoted: outcome.alreadyPromoted,
    };
  }
  if (outcome.status === "stale") return refuse("stale", outcome.reason);
  return refuse("in_progress", outcome.blocks.map((b) => b.detail).join(" "));
}
