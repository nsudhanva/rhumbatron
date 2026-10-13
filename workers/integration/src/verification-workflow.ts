import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  approvalReason,
  autoPromoteDecision,
  buildVerificationPlan,
  type CheckGap,
  CLIENT_ASSETS_CHECK_ID,
  checkCompatibility,
  gateRequiredChecks,
  policyHoldReason,
} from "@rhumbatron/evidence";
import { type CompletionRequest, ModelCallError } from "@rhumbatron/model-router";
import {
  type AppCheckResult,
  ChangeSetIntent,
  CodeManifest,
  candidatePatchKey,
  codeManifestKey,
  type EventEnvelope,
  type EvidenceRecord,
  RiskTier,
  type VerificationCheck,
  type VerificationPlan,
} from "@rhumbatron/protocol";
import {
  ACCEPTANCE_SOURCE_CAP,
  type AcceptanceSource,
  acceptanceOutcome,
  acceptanceReport,
  acceptanceSource as buildAcceptanceSource,
  changeModelSpend,
  composedFileOrder,
  judgeAcceptance,
  takeDailyCall,
} from "./acceptance-check.ts";
import { requestAcceptanceRepair } from "./acceptance-repair.ts";
import { APP_BUILD_COMMAND, appBuildOutcome } from "./app-build.ts";
import {
  canonicalCommitOf,
  type PreviewOutcome,
  productionRow,
  publishPreview,
} from "./app-release.ts";
import { runBrowserCheck } from "./browser-check.ts";
import {
  acceptanceCriteriaToJudge,
  type ChangeSetRow,
  type CheckOutcome,
  classifyCheck,
  classifyContract,
  isAllowedCheckCommand,
  orderChangeSets,
  procedureGap,
  type TaskEdge,
  toComposable,
  verificationTouches,
} from "./candidate-composer.ts";
import {
  type Composition,
  candidateFork,
  composeCandidate,
  forkCandidate,
  removeCandidateDir,
  reserveSandbox,
  runCandidateCheck,
  runContractCheck,
  settleSandbox,
} from "./candidate-sandbox.ts";
import {
  applySelection,
  groupSize,
  holdForAcceptance,
  holdForPerson,
  type JudgeRun,
  prepareSelection,
  runIntegrationJudge,
} from "./candidate-selection.ts";
import { releaseRequestScope } from "./change-commands.ts";
import { changeComplete } from "./change-meter.ts";
import { CHANGE_CANCELLED_REASON, verificationDeadEnd, verificationHalt } from "./change-status.ts";
import { classifyBrowser, classifySecurity } from "./check-semantics.ts";
import { storeTreeCode, walkTree } from "./code-store.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { type EvidenceRow, toRecord } from "./evidence-rows.ts";
import { KEEP_PREFIX, loadKeptCriteria } from "./kept-criteria.ts";
import { policyForRun } from "./policy.ts";
import { runPreviewSmoke } from "./preview-smoke.ts";
import { promoteCandidate } from "./promotion.ts";
import { markCandidateStale, recomposeQuietly } from "./recompose.ts";
import {
  type CheckRunner,
  evaluateAppCheckOutcome,
  evaluateContractAppCheck,
  isAppCheckerEligible,
} from "./runner-selection.ts";

/**
 * CandidateVerificationWorkflow. One instance per Candidate
 * (instance ID = Candidate ID). It composes the Candidate's ChangeSets on its base commit in an
 * Artifacts fork, runs the Verification Plan in the Project Sandbox, stores Evidence in D1 and R2,
 * and gates the required checks. Every step is idempotent: IDs, R2 keys, and commits are stable.
 * Only `checked_supported` + `pass` satisfies a required check. Model calls: the acceptance check
 * (Haiku, Sonnet once on invalid output) and, on a tie between siblings, the Integration Judge.
 *
 * Sibling Candidates (same Change, same base) do not race (ADR 0026): after its gate, a run selects
 * only when no sibling is still composing or verifying; exactly one run claims the selection, and
 * only the winner takes the promotion path.
 */

export type CandidateVerificationParams = { candidateId: string };

type PolicyOf = ReturnType<typeof policyForRun>;

const ACTOR = { kind: "system", id: "candidate-verification" } as const;
/** Policy `autoPromoteRiskTiers` promotes as the system, never as a person. */
const AUTO_PROMOTION_ACTOR = { kind: "system", id: "auto-promotion" } as const;
/** States after which this workflow has nothing to do. */
const FINAL = new Set(["verified", "rejected", "stale", "promoted"]);
/** Remove the checkout only while the Sandbox is still awake; a sleeping one already lost it. */
const AWAKE_MS = 90_000;

/** A step that found the Change cancelled or the Candidate final before it did any work. */
type Halt = { halted: NonNullable<ReturnType<typeof verificationHalt>> };
const isHalt = (value: unknown): value is Halt =>
  typeof value === "object" && value !== null && "halted" in value;

type Loaded = {
  ctx: ChangeContext;
  status: string;
  /** Absent in a step result cached before this field existed. */
  changeStatus?: string;
  createdAt: string;
  goal: string;
  riskTier: RiskTier;
  invariants: string[];
  acceptanceCriteria: string[];
  touchesAuthorization: boolean;
  canonical: { generation: number; treeSha: string; commit: string | null } | null;
  /** Depth of recomposition. A cached step result can lack it. */
  recomposeCount?: number;
  changeSets: ChangeSetRow[];
  /** ChangeSet IDs the Candidate was created with. */
  changeSetIds: string[];
  edges: TaskEdge[];
};

type CandidateRow = {
  id: string;
  change_id: string;
  base_generation: number;
  status: string;
  change_set_ids_json: string;
  created_at: string;
  change_status: string;
  project_id: string;
  goal: string;
  risk_tier: string | null;
  invariants_json: string;
  acceptance_criteria_json: string;
  org_id: string;
  slug: string;
  recompose_count: number | null;
};

const evidenceIdFor = (candidateId: string, checkId: string) =>
  `ev_${candidateId.slice(5)}_${checkId}`;

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Ends a `verifying` Change as `failed` when none of its Candidates can ship any more
 * (`verificationDeadEnd`): the reason goes to `blocked_reason`, `change.failed` records it, and the
 * request scope is released. Idempotent: the update is conditional, the event ID is stable.
 */
async function endWithoutShippableCandidate(env: Env, candidateId: string): Promise<boolean> {
  const head = await env.DB.prepare(
    `SELECT ch.id AS change_id, ch.project_id, ch.base_generation, p.org_id, p.slug
     FROM candidates c JOIN changes ch ON ch.id = c.change_id JOIN projects p ON p.id = ch.project_id
     WHERE c.id = ?`,
  )
    .bind(candidateId)
    .first<{
      change_id: string;
      project_id: string;
      base_generation: number;
      org_id: string;
      slug: string;
    }>();
  if (!head) return false;
  const rows = await env.DB.prepare(
    "SELECT status, status_reason, base_generation FROM candidates WHERE change_id = ?",
  )
    .bind(head.change_id)
    .all<{ status: string; status_reason: string | null; base_generation: number }>();
  const reason = verificationDeadEnd(
    (rows.results ?? []).map((r) => ({
      status: r.status,
      statusReason: r.status_reason,
      baseGeneration: r.base_generation,
    })),
  );
  if (!reason) return false;
  const [, after] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE changes SET status = 'failed', blocked_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'verifying'`,
    ).bind(reason, new Date().toISOString(), head.change_id),
    env.DB.prepare("SELECT status, blocked_reason FROM changes WHERE id = ?").bind(head.change_id),
  ]);
  const row = after?.results?.[0] as { status: string; blocked_reason: string | null } | undefined;
  if (row?.status !== "failed" || row.blocked_reason !== reason) return false;
  const ctx: ChangeContext = {
    projectId: head.project_id,
    orgId: head.org_id,
    projectSlug: head.slug,
    changeId: head.change_id,
    baseGeneration: head.base_generation,
  };
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.failed",
      { status: "failed", phase: "verification", reason },
      { key: "verification", actor: ACTOR },
    ),
  ]);
  await releaseRequestScope(env, head.project_id, head.change_id);
  return true;
}

export class CandidateVerificationWorkflow extends WorkflowEntrypoint<
  Env,
  CandidateVerificationParams
> {
  override async run(
    event: Readonly<WorkflowEvent<CandidateVerificationParams>>,
    step: WorkflowStep,
  ) {
    const { candidateId } = event.payload;
    // The Project's stored policy, read once in this run.
    const policyOf = policyForRun(this.env, step);
    const result = await this.verify(candidateId, step, policyOf);
    // Only a settled Candidate (verified or rejected by its own checks) takes part in selection.
    // Stale, halted, cancelled, and missing Candidates leave the group to the others.
    const settled =
      "promotable" in result ||
      ("status" in result &&
        result.status === "rejected" &&
        !("reason" in result && result.reason === "change_cancelled"));
    if (!settled) return result;
    const selected = await this.settleSiblings(step, candidateId, result, policyOf);
    // A Change with no Candidate left that can ship ends here, not in `verifying` forever.
    if (!("promotable" in result && result.promotable === true)) {
      const ended = await step.do("end change without a shippable candidate", () =>
        endWithoutShippableCandidate(this.env, candidateId),
      );
      return { ...selected, changeEnded: ended };
    }
    return selected;
  }

  /**
   * After the gate (ADR 0026): a Candidate without siblings promotes alone. With siblings, the run
   * waits for none of them: when one is still composing or verifying, it ends, and the last run to
   * settle claims the selection. The claimant selects the winner (a model call only on a tie) and
   * sends only the winner down the promotion path.
   */
  private async settleSiblings<R extends object>(
    step: WorkflowStep,
    candidateId: string,
    result: R,
    policyOf: PolicyOf,
  ) {
    const prep = await step.do("prepare selection", () =>
      prepareSelection(this.env.DB, candidateId),
    );
    if (prep.kind === "single") {
      return "promotable" in result && result.promotable === true
        ? { ...result, ...(await this.promoteWinner(step, candidateId, policyOf)) }
        : result;
    }
    if (prep.kind === "waiting") return { ...result, selection: "waiting", pending: prep.pending };
    if (prep.kind === "not_mine") return { ...result, selection: "not_mine" };
    let judged: JudgeRun | null = null;
    const judge = prep.judge;
    if (prep.ranking.kind === "tie" && judge) {
      judged = await step.do(
        "integration judge",
        { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "3 minutes" },
        () =>
          runIntegrationJudge(this.env.DB, prep.ctx.changeId, judge, (req) =>
            this.complete(req, prep.ctx.changeId),
          ),
      );
    }
    const selected = await step.do("apply selection", () => applySelection(this.env, prep, judged));
    if (!selected.winner) return { ...result, selection: selected };
    return {
      ...result,
      selection: selected,
      ...(await this.promoteWinner(step, selected.winner, policyOf)),
    };
  }

  /** Anthropic call admitted by every budget of the Change (change-meter.ts), tagged with it. */
  private complete(req: CompletionRequest, changeId: string) {
    return changeComplete(this.env, changeId, req);
  }

  private async verify(candidateId: string, step: WorkflowStep, policyOf: PolicyOf) {
    // Step 1: confirm the Candidate and its base generation. Retries cover a
    // promotion whose source sync has not landed yet (see below).
    const loaded = await step.do(
      "load candidate",
      { retries: { limit: 5, delay: "15 seconds", backoff: "exponential" } },
      async (): Promise<Loaded | null> => {
        const row = await this.env.DB.prepare(
          `SELECT c.id, c.change_id, c.base_generation, c.status, c.change_set_ids_json, c.created_at,
                ch.status AS change_status, ch.project_id, ch.goal, ch.risk_tier,
                ch.invariants_json, ch.acceptance_criteria_json, p.org_id, p.slug,
                c.recompose_count
         FROM candidates c JOIN changes ch ON ch.id = c.change_id
         JOIN projects p ON p.id = ch.project_id WHERE c.id = ?`,
        )
          .bind(candidateId)
          .first<CandidateRow>();
        if (!row) return null;
        const ids = JSON.parse(row.change_set_ids_json) as string[];
        const [sets, edges, routes] = await this.env.DB.batch([
          this.env.DB.prepare(
            `SELECT cs.id, cs.base_generation, cs.artifact_ref, cs.intent_json, cs.created_at, r.task_id
           FROM changesets cs LEFT JOIN task_runs r ON r.id = 'run_' || substr(cs.id, 4)
           WHERE cs.change_id = ? AND cs.id IN (SELECT value FROM json_each(?))`,
          ).bind(row.change_id, JSON.stringify(ids)),
          this.env.DB.prepare(
            `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
           JOIN tasks t ON t.id = d.task_id WHERE t.change_id = ?`,
          ).bind(row.change_id),
          this.env.DB.prepare("SELECT route_json FROM tasks WHERE change_id = ?").bind(
            row.change_id,
          ),
        ]);
        const root = this.env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
        const snapshot = await root.get(root.idFromName(row.project_id)).getCanonical();
        let canonical: Loaded["canonical"] = null;
        if (snapshot && snapshot.artifactRef !== "unassigned") {
          const index = await this.env.EVIDENCE.get(
            `source/${row.project_id}/${snapshot.treeSha}/index.json`,
          );
          // A promoted generation writes its index after the canonical repo moves (ADR 0013).
          // Until then a Candidate on it cannot resolve its base: wait instead of composing on a
          // guess. A Candidate on an older base is stale below and needs no index.
          if (!index && snapshot.generation > 0 && row.base_generation === snapshot.generation) {
            throw new Error(`Canonical source of S${snapshot.generation} is not synced yet`);
          }
          const indexed = index ? ((await index.json()) as { commit?: string }).commit : undefined;
          // A rollback reuses an earlier tree with a new commit. The canonical ref names
          // the commit on `main`; until the source sync points the tree's index at it, wait.
          const named = canonicalCommitOf(snapshot.artifactRef);
          if (
            named &&
            indexed &&
            named !== indexed &&
            row.base_generation === snapshot.generation
          ) {
            throw new Error(`Canonical source of S${snapshot.generation} is not synced yet`);
          }
          canonical = {
            generation: snapshot.generation,
            treeSha: snapshot.treeSha,
            commit: named ?? indexed ?? null,
          };
        }
        const touchesAuthorization = ((routes?.results ?? []) as { route_json: string | null }[])
          .map((r) => (r.route_json ? (JSON.parse(r.route_json) as Record<string, unknown>) : {}))
          .some((r) => r.touchesAuthorization === true);
        return {
          ctx: {
            projectId: row.project_id,
            orgId: row.org_id,
            projectSlug: row.slug,
            changeId: row.change_id,
            baseGeneration: row.base_generation,
          },
          status: row.status,
          changeStatus: row.change_status,
          createdAt: row.created_at,
          goal: row.goal,
          riskTier: RiskTier.catch("medium").parse(row.risk_tier ?? "medium"),
          invariants: JSON.parse(row.invariants_json) as string[],
          acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as string[],
          touchesAuthorization,
          canonical,
          recomposeCount: row.recompose_count ?? 0,
          changeSets: (sets?.results ?? []) as ChangeSetRow[],
          changeSetIds: ids,
          edges: (edges?.results ?? []) as TaskEdge[],
        };
      },
    );
    if (!loaded) return { skipped: "missing" };
    // A Candidate marked stale before this run (the event router's `canonical.advanced` sweep) is
    // composed again here; recomposition is idempotent per composition key.
    if (loaded.status === "stale") {
      const recomposed = await step.do("recompose stale", () =>
        recomposeQuietly(this.env, candidateId),
      );
      return { skipped: loaded.status, recomposed };
    }
    if (FINAL.has(loaded.status)) return { skipped: loaded.status };
    const { ctx } = loaded;

    const finish = (status: "rejected" | "stale", reason: string, gaps: CheckGap[] = []) =>
      step.do(`mark ${status}`, async () => {
        const now = new Date().toISOString();
        await this.env.DB.prepare(
          `UPDATE candidates SET status = ?, status_reason = ?, score_json = ?, updated_at = ?
           WHERE id = ? AND status NOT IN ('verified', 'rejected', 'stale', 'promoted')`,
        )
          .bind(status, reason, JSON.stringify({ promotable: false, gaps }), now, candidateId)
          .run();
        await appendChangeEvents(this.env.RESOURCE_SHARD, ctx, [
          await changeEvent(
            ctx,
            status === "stale" ? "candidate.stale" : "verification.completed",
            { candidateId, status, reason, promotable: false, gaps },
            { key: candidateId, actor: ACTOR },
          ),
        ]);
        return status;
      });

    // Stop new expensive work: a cancelled Change starts no Sandbox or Browser Run time. Each later step checks
    // again before its work (`guard`), so an in-flight run stops at its next step boundary.
    const stop = async (halt: Halt) => {
      if (halt.halted === "candidate_final") {
        // The event router marks an in-flight Candidate stale after `canonical.advanced`, and
        // only this run notices it. Without a recomposition here the Change would sit in
        // `verifying` with nothing running.
        const recomposed = await step.do("recompose if stale", async () => {
          const row = await this.env.DB.prepare("SELECT status FROM candidates WHERE id = ?")
            .bind(candidateId)
            .first<{ status: string }>();
          return row?.status === "stale" ? recomposeQuietly(this.env, candidateId) : null;
        });
        return { skipped: halt.halted, ...(recomposed ? { recomposed } : {}) };
      }
      if (halt.halted !== "change_cancelled") return { skipped: halt.halted };
      await finish("rejected", CHANGE_CANCELLED_REASON);
      return { status: "rejected", reason: "change_cancelled" };
    };
    if (["cancelled", "not_selected", "needs_input"].includes(loaded.changeStatus ?? ""))
      return stop({ halted: "change_cancelled" });

    if (!loaded.canonical?.commit) {
      await finish("rejected", "Project has no canonical source to compose on.");
      return { status: "rejected" };
    }
    // A Candidate is valid only on the current Canonical Generation.
    if (loaded.canonical.generation !== ctx.baseGeneration) {
      await finish(
        "stale",
        `Base S${ctx.baseGeneration} is behind canonical S${loaded.canonical.generation}.`,
      );
      // Compose the same ChangeSets again on the new canonical state (bounded).
      const recomposed = await step.do("recompose stale", () =>
        recomposeQuietly(this.env, candidateId),
      );
      return { status: "stale", recomposed };
    }
    const baseCommit = loaded.canonical.commit;

    // Deterministic compatibility before any Sandbox time. A shared file is left to
    // the real merge below, which reports a real source conflict instead of a guess.
    const found = new Set(loaded.changeSets.map((c) => c.id));
    const missing = loaded.changeSetIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      await finish("rejected", `ChangeSets not found: ${missing.join(", ").slice(0, 200)}`);
      return { status: "rejected", reason: "missing_changeset" };
    }
    const { ordered, deps } = orderChangeSets(loaded.changeSets, loaded.edges);
    let parsed: ReturnType<typeof toComposable>;
    try {
      parsed = toComposable(ordered, deps);
    } catch (error) {
      await finish("rejected", `Malformed ChangeSet: ${String(error).slice(0, 200)}`);
      return { status: "rejected", reason: "malformed_changeset" };
    }
    const { sources } = parsed;
    // A recomposed Candidate carries ChangeSets written on an older canonical state. The
    // real merge onto the new base and the full check run decide; the base-generation rule does not.
    const composable =
      (loaded.recomposeCount ?? 0) > 0
        ? parsed.composable.map((c) =>
            c.baseGeneration < ctx.baseGeneration
              ? { ...c, baseGeneration: ctx.baseGeneration }
              : c,
          )
        : parsed.composable;
    const policy = await policyOf(ctx.projectId);
    const compatibility = checkCompatibility(ctx.baseGeneration, composable, {
      protectedResources: policy.protectedResources,
    });
    if (!compatibility.ok && compatibility.kind !== "file_conflict") {
      await step.do("record incompatibility", async () =>
        this.recordEvidence(ctx, candidateId, {
          checkId: "composition",
          kind: "composition",
          outcome: {
            status: "fail",
            coverage: "checked_supported",
            summary: `${compatibility.kind}: ${compatibility.detail}`.slice(0, 500),
          },
          startedAt: new Date().toISOString(),
          output: JSON.stringify(compatibility, null, 2),
          sourceRefs: composable.map((c) => c.id),
        }),
      );
      await finish("rejected", `${compatibility.kind}: ${compatibility.detail}`, [
        { checkId: "composition", reason: "failed" },
      ]);
      return { status: "rejected", reason: compatibility.kind };
    }

    let forked: string | Halt;
    try {
      forked = await step.do(
        "fork candidate repo",
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
        () =>
          this.guard(candidateId, async () => {
            const name = await forkCandidate(this.env, ctx.projectId, candidateId);
            await this.env.DB.prepare(
              "UPDATE candidates SET artifact_ref = ?, updated_at = ? WHERE id = ?",
            )
              .bind(`artifacts://${name}@main`, new Date().toISOString(), candidateId)
              .run();
            return name;
          }),
      );
    } catch (error) {
      await finish("rejected", `Could not fork the canonical repo: ${String(error).slice(0, 200)}`);
      return { status: "rejected", reason: "fork_failed" };
    }
    if (isHalt(forked)) return stop(forked);
    const fork = forked;

    // Reserve before the Sandbox opens (ADR 0017). A retried reservation can only over-count.
    const reserved = await step.do("reserve sandbox", () =>
      this.guard(candidateId, async () => ({
        ok: await reserveSandbox(this.env.DB, this.env.SANDBOX_MONTHLY_SECONDS),
        at: Date.now(),
      })),
    );
    if (isHalt(reserved)) return stop(reserved);
    const reservation = reserved;
    if (!reservation.ok) {
      await finish("rejected", "Monthly Sandbox budget reached; no check ran.");
      return { status: "rejected", reason: "sandbox_budget" };
    }

    let lastSandboxAt = reservation.at;
    let plan: VerificationPlan | null = null;
    /** The composed source, for the live preview after the checks. */
    let composedRef: { commit: string; tree: string } | null = null;
    let halt: Halt | null = null;
    try {
      // Step 2: compose the ChangeSets in Work Graph order.
      let composedOrHalt: (Composition & { at: number }) | Halt;
      try {
        composedOrHalt = await step.do(
          "compose candidate",
          {
            retries: { limit: 1, delay: "20 seconds", backoff: "constant" },
            timeout: "10 minutes",
          },
          () =>
            this.guard(candidateId, async () => {
              const result = await composeCandidate(this.env, {
                projectId: ctx.projectId,
                candidateId,
                baseCommit,
                sources,
                commitTime: Math.floor(Date.parse(loaded.createdAt) / 1000),
              });
              return { ...result, at: Date.now() };
            }),
        );
      } catch (error) {
        // No composed source means no Evidence can exist: the Candidate cannot ship.
        await finish("rejected", `Composition did not finish: ${String(error).slice(0, 200)}`, [
          { checkId: "composition", reason: "error" },
        ]);
        return { status: "rejected", reason: "composition_error" };
      }
      if (isHalt(composedOrHalt)) return await stop(composedOrHalt);
      const composed = composedOrHalt;
      lastSandboxAt = composed.at;
      if (!composed.ok) {
        await step.do("record merge conflict", async () =>
          this.recordEvidence(ctx, candidateId, {
            checkId: "composition",
            kind: "composition",
            outcome: {
              status: "fail",
              coverage: "checked_supported",
              summary:
                `file_conflict: ${composed.changeSetId} does not merge (${composed.files.join(", ") || composed.detail})`.slice(
                  0,
                  500,
                ),
            },
            startedAt: new Date().toISOString(),
            output: JSON.stringify(composed, null, 2),
            sourceRefs: [composed.changeSetId],
          }),
        );
        await finish("rejected", `file_conflict: ${composed.changeSetId} does not merge`, [
          { checkId: "composition", reason: "failed" },
        ]);
        return { status: "rejected", reason: "file_conflict" };
      }
      const { commit, tree } = composed;
      composedRef = { commit, tree };

      // Step 3: the risk-based Verification Plan.
      const planned = await step.do("record composition and plan", () =>
        this.guard(candidateId, async () => {
          const files = sources.flatMap((s) => s.files);
          const scope = verificationTouches({
            goal: loaded.goal,
            invariants: loaded.invariants,
            acceptanceCriteria: loaded.acceptanceCriteria,
            files,
            touchesAuthorization: loaded.touchesAuthorization,
          });
          const built: VerificationPlan = buildVerificationPlan({
            candidateId,
            riskTier: loaded.riskTier,
            policy,
            ...scope,
            // App provisioning is automatic with APPS. A missing row is a pending app,
            // not permission to promote without runtime Evidence. Removed apps stay disabled.
            liveAppEnabled:
              Boolean(this.env.APPS) &&
              (await productionRow(this.env, ctx.projectId))?.status !== "removed",
            clientBuild: composed.appBuild !== undefined,
          });
          await this.env.DB.prepare(
            `UPDATE candidates SET status = 'verifying', artifact_ref = ?, composed_commit = ?,
             composed_tree = ?, base_tree = ?, plan_json = ?, updated_at = ?
           WHERE id = ? AND status IN ('composing', 'composed', 'verifying')`,
          )
            .bind(
              `artifacts://${fork}@${commit}`,
              commit,
              tree,
              loaded.canonical?.treeSha ?? null,
              JSON.stringify(built),
              new Date().toISOString(),
              candidateId,
            )
            .run();
          await appendChangeEvents(this.env.RESOURCE_SHARD, ctx, [
            await changeEvent(
              ctx,
              "candidate.composed",
              {
                candidateId,
                artifactRef: `artifacts://${fork}@${commit}`,
                composedTree: tree,
                changeSetIds: composed.merged,
                requiredCheckIds: built.requiredCheckIds,
              },
              { key: candidateId, actor: ACTOR },
            ),
          ]);
          if (this.env.APPS) {
            using candidateRepo = await this.env.ARTIFACTS.get(fork);
            await storeTreeCode(this.env, candidateRepo, {
              projectId: ctx.projectId,
              commit,
              treeSha: tree,
              previousTreeSha: loaded.canonical?.treeSha,
            });
            if (loaded.canonical?.commit && loaded.canonical.treeSha) {
              using baseRepo = await this.env.ARTIFACTS.get(ctx.projectId);
              await storeTreeCode(this.env, baseRepo, {
                projectId: ctx.projectId,
                commit: loaded.canonical.commit,
                treeSha: loaded.canonical.treeSha,
              });
            }
          }
          return built;
        }),
      );
      if (isHalt(planned)) return await stop(planned);
      plan = planned;

      // Contract changes the ChangeSets declared; the contract check fails on any other.
      const declared = loaded.changeSets.flatMap(
        (c) => ChangeSetIntent.parse(JSON.parse(c.intent_json)).expectedContractChanges,
      );

      // Steps 3-8: one step per check, so each has its own timeout, retry, and Evidence.
      for (const check of plan.checks) {
        // Preview smoke runs only after publication, outside the Sandbox work.
        if (check.checkId === "preview-smoke") continue;
        const name = `check ${check.checkId}`;
        try {
          const at = await step.do(
            name,
            {
              retries: { limit: 1, delay: "15 seconds", backoff: "constant" },
              // Room for a Sandbox restore (clone and install) on top of the check timeout.
              timeout: check.timeoutMs + 6 * 60_000,
            },
            () =>
              this.guard(candidateId, async () => {
                if (await this.recordCompositionBuild(ctx, candidateId, composed, check)) {
                  return null;
                }
                if (isAppCheckerEligible(check, Boolean(this.env.APPS))) {
                  const tried = await this.tryAppChecker(
                    ctx,
                    candidateId,
                    {
                      fork,
                      commit,
                      tree,
                      baseCommit,
                      baseTreeSha: loaded.canonical?.treeSha ?? null,
                    },
                    declared,
                    check,
                  );
                  if (tried.handled) return null;
                }
                if (check.kind === "acceptance") {
                  return this.runAcceptance(
                    ctx,
                    candidateId,
                    { fork, commit, tree, files: sources.flatMap((s) => s.files) },
                    [
                      ...acceptanceCriteriaToJudge(loaded.acceptanceCriteria),
                      // Requests that went live while this one ran: their work must still hold.
                      ...acceptanceCriteriaToJudge(
                        await loadKeptCriteria(this.env.DB, ctx.changeId),
                      ).map((criterion) => `${KEEP_PREFIX}${criterion}`),
                    ],
                    check,
                  );
                }
                return check.kind === "contract"
                  ? this.runContract(ctx, candidateId, { commit, baseCommit }, declared, check)
                  : check.kind === "browser"
                    ? this.runBrowser(ctx, candidateId, commit, check)
                    : this.runCheck(ctx, candidateId, commit, check);
              }),
          );
          if (isHalt(at)) {
            halt = at;
            break;
          }
          if (at) lastSandboxAt = at;
        } catch (error) {
          // The check produced no result: record the gap. Never a pass.
          await step.do(`${name} gap`, async () => {
            await this.recordEvidence(ctx, candidateId, {
              checkId: check.checkId,
              kind: check.kind,
              outcome: {
                status: "error",
                coverage: "not_checked",
                summary: `No result: ${String(error).slice(0, 300)}`,
              },
              startedAt: new Date().toISOString(),
              output: String(error),
              sourceRefs: [`artifacts://${fork}@${commit}`],
              runner: "sandbox",
            });
            return null;
          });
        }
      }

      if (halt) return await stop(halt);
    } finally {
      await step.do("settle sandbox", async () => {
        await settleSandbox(this.env.DB, reservation.at);
        if (Date.now() - lastSandboxAt < AWAKE_MS) {
          await removeCandidateDir(this.env, ctx.projectId, candidateId);
        }
        return candidateFork(candidateId);
      });
    }

    if (!plan || !composedRef) return { skipped: "missing_plan" };
    const preview = composedRef;
    const smokeCheck = plan.checks.find((check) => check.checkId === "preview-smoke");
    if (smokeCheck) {
      let published: PreviewOutcome | { status: "skipped" | "error"; reason?: string } | Halt;
      try {
        published = await step.do(
          "publish preview",
          { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "5 minutes" },
          () =>
            this.guard(candidateId, async () => {
              const build = await this.env.DB.prepare(
                `SELECT 1 AS ok FROM evidence_index WHERE candidate_id = ? AND check_id = 'build'
               AND status = 'pass' AND coverage = 'checked_supported' LIMIT 1`,
              )
                .bind(candidateId)
                .first<{ ok: number }>();
              if (!build) return { status: "skipped" as const };
              try {
                return await publishPreview(this.env, ctx, {
                  candidateId,
                  commit: preview.commit,
                  treeSha: preview.tree,
                });
              } catch (error) {
                return { status: "error" as const, reason: String(error).slice(0, 300) };
              }
            }),
        );
      } catch (error) {
        published = { status: "error", reason: String(error).slice(0, 300) };
      }
      if (isHalt(published)) return await stop(published);
      const publication = published;
      const ref = `artifacts://${fork}@${preview.commit}`;
      try {
        const smoked = await step.do(
          "check preview-smoke",
          { retries: { limit: 0, delay: "1 second" }, timeout: smokeCheck.timeoutMs },
          () =>
            this.guard(candidateId, async () => {
              const startedAt = new Date().toISOString();
              const smoke = await runPreviewSmoke(this.env, {
                projectId: ctx.projectId,
                candidateId,
                commit: preview.commit,
                publication,
              });
              await this.recordEvidence(ctx, candidateId, {
                checkId: smokeCheck.checkId,
                kind: smokeCheck.kind,
                outcome: smoke.outcome,
                startedAt,
                output: JSON.stringify(smoke, null, 2),
                sourceRefs: [ref, `app-preview://${ctx.projectId}/${candidateId}`],
                report: { probes: smoke.results },
                runner: "dynamic-worker",
              });
              return null;
            }),
        );
        if (isHalt(smoked)) return await stop(smoked);
      } catch (error) {
        await step.do("check preview-smoke gap", () =>
          this.recordEvidence(ctx, candidateId, {
            checkId: smokeCheck.checkId,
            kind: smokeCheck.kind,
            outcome: {
              status: "error",
              coverage: "not_checked",
              summary: "Preview check could not run: no result from the preview.",
            },
            startedAt: new Date().toISOString(),
            output: String(error),
            sourceRefs: [ref],
            runner: "dynamic-worker",
          }),
        );
      }
    }

    const verificationPlan = plan;
    // Steps 9-10: gate on authoritative Evidence rows.
    const gateStep = await step.do("gate required checks", () =>
      this.guard(candidateId, async () => {
        const rows = await this.env.DB.prepare(
          "SELECT * FROM evidence_index WHERE candidate_id = ?",
        )
          .bind(candidateId)
          .all<EvidenceRow>();
        const records = (rows.results ?? []).map(toRecord);
        const gate = gateRequiredChecks(verificationPlan, records);
        const status = gate.promotable ? "verified" : "rejected";
        const p95 = records.find((r) => r.checkId === "performance")?.metrics?.p95Ms;
        const score = {
          ...gate,
          humanApprovalRequired: verificationPlan.humanApprovalRequired,
          ...(p95 === undefined ? {} : { p95Ms: p95 }),
        };
        const smokeGap = gate.gaps.find((gap) => gap.checkId === "preview-smoke");
        const smokeRecord = records.find((record) => record.checkId === "preview-smoke");
        // A passing probe result can still miss the check deadline. Report the gate gap in
        // that case, never a success summary as the reason for rejecting the Candidate.
        const smokeReason = smokeRecord?.status !== "pass" ? smokeRecord?.summary : undefined;
        // A gated Candidate states why it waits for a person; a rejected one states the gap.
        const waitReason =
          gate.promotable && verificationPlan.humanApprovalRequired
            ? approvalReason({
                policyVersion: verificationPlan.policyVersion,
                riskTier: loaded.riskTier,
                tierGated: policy.humanGateRiskTiers.includes(loaded.riskTier),
                touchesAuthorization: loaded.touchesAuthorization,
              })
            : null;
        const reason = gate.promotable
          ? null
          : smokeGap && smokeReason
            ? smokeReason.replace(/ \(runner: [^)]+\)$/, "")
            : `Required checks not satisfied: ${gate.gaps.map((g) => `${g.checkId} (${g.reason})`).join(", ")}`;
        await this.env.DB.prepare(
          `UPDATE candidates SET status = ?, status_reason = ?, score_json = ?, updated_at = ?
             WHERE id = ? AND status = 'verifying'`,
        )
          .bind(
            status,
            reason ?? waitReason,
            JSON.stringify(score),
            new Date().toISOString(),
            candidateId,
          )
          .run();
        const events: EventEnvelope[] = [
          await changeEvent(
            ctx,
            "verification.completed",
            { candidateId, status, reason, ...score },
            { key: candidateId, actor: ACTOR },
          ),
        ];
        // A gated Candidate waits for a human decision before promotion. With
        // siblings, selection requests the approval for the winner only (ADR 0026).
        if (
          gate.promotable &&
          verificationPlan.humanApprovalRequired &&
          (await groupSize(this.env.DB, candidateId)) <= 1
        ) {
          events.push(
            await changeEvent(
              ctx,
              "approval.requested",
              {
                candidateId,
                riskTier: loaded.riskTier,
                policyVersion: verificationPlan.policyVersion,
                reason: waitReason,
                trigger: "policy",
              },
              { key: candidateId, actor: ACTOR },
            ),
          );
        }
        await appendChangeEvents(this.env.RESOURCE_SHARD, ctx, events);
        return { status, promotable: gate.promotable, gaps: gate.gaps };
      }),
    );
    if (isHalt(gateStep)) return await stop(gateStep);
    return gateStep;
  }

  /**
   * The promotion path of one Candidate: the selection winner, or a Candidate without siblings.
   * Unchanged by selection: policy `autoPromoteRiskTiers`, the approval gate, and the
   * compare-and-swap decide.
   */
  private async promoteWinner(step: WorkflowStep, candidateId: string, policyOf: PolicyOf) {
    const winner = await step.do(`load winner ${candidateId}`, async () => {
      const row = await this.env.DB.prepare(
        `SELECT c.base_generation, c.plan_json, ch.project_id, ch.id AS change_id
         FROM candidates c JOIN changes ch ON ch.id = c.change_id WHERE c.id = ?`,
      )
        .bind(candidateId)
        .first<{
          base_generation: number;
          plan_json: string | null;
          project_id: string;
          change_id: string;
        }>();
      if (!row) return null;
      const plan = row.plan_json ? (JSON.parse(row.plan_json) as VerificationPlan) : null;
      return {
        projectId: row.project_id,
        changeId: row.change_id,
        baseGeneration: row.base_generation,
        humanApprovalRequired: plan?.humanApprovalRequired ?? true,
      };
    });
    if (!winner) return { promotion: "missing" };
    const ctx = winner;
    const plan = { humanApprovalRequired: winner.humanApprovalRequired };

    // After the gate: a gated Candidate waits for a person; a Candidate
    // that policy `autoPromoteRiskTiers` allows promotes through the same path as a manual promote.
    // Canonical moved while the checks ran: this Candidate cannot promote. Mark it stale and
    // recompose it on the new canonical state instead of waiting for a person.
    const moved = await step.do("check canonical", async () => {
      const root = this.env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
      const snapshot = await root.get(root.idFromName(ctx.projectId)).getCanonical();
      const generation = snapshot?.generation ?? ctx.baseGeneration;
      if (generation === ctx.baseGeneration) return null;
      await markCandidateStale(this.env, candidateId, generation);
      return generation;
    });
    if (moved !== null) return { status: "stale", canonicalGeneration: moved };
    const policy = await policyOf(ctx.projectId);

    const decision = await step.do("settle change", async () => {
      // ADR 0026: acceptance gates auto-promotion, not promotability. A shortfall or a gap holds
      // the Candidate for a person, whatever the risk tier.
      // Criteria clearly not met: one repair Task first, then a person (acceptance-repair.ts).
      if (await requestAcceptanceRepair(this.env, { candidateId, trigger: "acceptance" }))
        return { kind: "manual" as const, reason: "acceptance_incomplete" as const };
      const held = await holdForAcceptance(this.env, candidateId);
      if (held) return { kind: "manual" as const, reason: "acceptance_incomplete" as const };
      const [change, candidate] = await Promise.all([
        this.env.DB.prepare("SELECT risk_tier FROM changes WHERE id = ?")
          .bind(ctx.changeId)
          .first<{ risk_tier: string | null }>(),
        this.env.DB.prepare("SELECT status FROM candidates WHERE id = ?")
          .bind(candidateId)
          .first<{ status: string }>(),
      ]);
      const stored = change?.risk_tier ?? null;
      const riskTier = stored === null ? null : RiskTier.catch("medium").parse(stored);
      const decided = autoPromoteDecision({
        candidateStatus: candidate?.status ?? "missing",
        promotable: true,
        plan: { humanApprovalRequired: plan.humanApprovalRequired },
        riskTier,
        policy,
      });
      // The plan has no human gate, but the policy still sends the Candidate to a person: add
      // the gate, state why, and request the approval, so the wait is never silent.
      const policyHold = plan.humanApprovalRequired
        ? null
        : policyHoldReason(decided, { policyVersion: policy.version, riskTier });
      if (policyHold) {
        await holdForPerson(this.env, candidateId, policyHold, "policy", policy.version);
      } else if (decided.kind === "manual" && decided.reason === "approval_required") {
        // The gate step or the selection requested the approval; the Change shows as waiting.
        await this.env.DB.prepare(
          `UPDATE changes SET status = 'awaiting_approval', updated_at = ?
           WHERE id = ? AND status = 'verifying'`,
        )
          .bind(new Date().toISOString(), ctx.changeId)
          .run();
      }
      return decided;
    });
    if (decision.kind !== "auto_promote") return { promotion: decision.reason };
    try {
      // Every promotion precondition is re-checked from authoritative rows inside; a CAS failure
      // marks the Candidate stale. A retried step returns `alreadyPromoted`, never a second advance.
      const outcome = await step.do(
        "auto promote",
        { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" } },
        () =>
          promoteCandidate(this.env, {
            candidateId,
            trigger: "auto",
            actor: AUTO_PROMOTION_ACTOR,
          }),
      );
      return { promotion: outcome.status };
    } catch (error) {
      // The Candidate stays verified; a person can still promote it.
      console.error(
        JSON.stringify({
          event: "promotion.auto_failed",
          candidateId,
          message: String(error).slice(0, 200),
        }),
      );
      return { promotion: "auto_failed" };
    }
  }

  /**
   * Runs `work` unless the Change was cancelled or the Candidate is already final (one indexed D1
   * read). Called at the start of each step, so a cancel stops the run at its next step boundary
   * and spends no more Sandbox or Browser Run time.
   */
  private async guard<T>(candidateId: string, work: () => Promise<T>): Promise<T | Halt> {
    const row = await this.env.DB.prepare(
      `SELECT c.status, ch.status AS change_status
       FROM candidates c JOIN changes ch ON ch.id = c.change_id WHERE c.id = ?`,
    )
      .bind(candidateId)
      .first<{ status: string; change_status: string }>();
    const halted = verificationHalt(row?.change_status ?? null, row?.status ?? null);
    return halted ? { halted } : work();
  }

  /**
   * Attempts to run a build, unit, or contract check with AppChecker over the APPS service binding.
   * Returns handled: true if the check ran and Evidence was recorded (no Sandbox started).
   * Returns handled: false if AppChecker returned supported: false (falling back to Sandbox).
   */
  private async tryAppChecker(
    ctx: ChangeContext,
    candidateId: string,
    source: {
      fork: string;
      commit: string;
      tree: string;
      baseCommit: string;
      baseTreeSha: string | null;
    },
    declared: string[],
    check: VerificationCheck,
  ): Promise<{ handled: boolean }> {
    if (!this.env.APPS?.check) return { handled: false };
    const ref = `artifacts://${source.fork}@${source.commit}`;
    const startedAt = new Date().toISOString();
    const timeoutMs = Math.min(check.timeoutMs, 30_000);

    if (check.kind === "contract") {
      let candidateResult: AppCheckResult;
      try {
        candidateResult = await this.env.APPS.check({
          projectId: ctx.projectId,
          treeSha: source.tree,
          kind: "contract",
          timeoutMs,
        });
      } catch {
        return { handled: false };
      }
      if (!candidateResult.supported) return { handled: false };

      let baseResult: AppCheckResult | null = null;
      if (source.baseTreeSha) {
        let baseHasApp = false;
        try {
          const baseManifestKey = codeManifestKey(ctx.projectId, source.baseTreeSha);
          const baseManifestObj = await this.env.EVIDENCE.get(baseManifestKey);
          if (baseManifestObj) {
            const parsed = CodeManifest.safeParse(await baseManifestObj.json().catch(() => null));
            if (parsed.success) {
              baseHasApp = parsed.data.entries.some((e) => e.path === "package.json");
            }
          }
        } catch {
          baseHasApp = false;
        }

        if (baseHasApp) {
          try {
            baseResult = await this.env.APPS.check({
              projectId: ctx.projectId,
              treeSha: source.baseTreeSha,
              kind: "contract",
              timeoutMs,
            });
          } catch {
            return { handled: false };
          }
          if (!baseResult.supported) return { handled: false };
        }
      }

      const disposition = evaluateContractAppCheck(candidateResult, baseResult, declared);
      if (!disposition.handled) return { handled: false };

      await this.recordEvidence(ctx, candidateId, {
        checkId: check.checkId,
        kind: check.kind,
        outcome: disposition.outcome,
        startedAt,
        completedAt: candidateResult.completedAt || new Date().toISOString(),
        output: [
          `$ CONTRACT_ROOT=<base ${source.baseCommit.slice(0, 12)}> [dynamic-worker] contract`,
          baseResult?.output ?? "(not run: the base is an empty repository with no app)",
          `$ [dynamic-worker] contract`,
          candidateResult.output,
          `declared: ${JSON.stringify(declared)}`,
        ].join("\n"),
        sourceRefs: [ref],
        exitCode: candidateResult.exitCode,
        command: "contract",
        runner: "dynamic-worker",
      });
      return { handled: true };
    }

    let result: AppCheckResult;
    try {
      result = await this.env.APPS.check({
        projectId: ctx.projectId,
        treeSha: source.tree,
        kind: check.kind as "build" | "unit",
        timeoutMs,
      });
    } catch {
      return { handled: false };
    }

    const disposition = evaluateAppCheckOutcome(check.kind, result);
    if (!disposition.handled) return { handled: false };

    await this.recordEvidence(ctx, candidateId, {
      checkId: check.checkId,
      kind: check.kind,
      outcome: disposition.outcome,
      startedAt,
      completedAt: result.completedAt || new Date().toISOString(),
      output: result.output || result.summary,
      sourceRefs: [ref],
      exitCode: result.exitCode,
      command: check.kind === "build" ? "worker-bundler & loader.load" : "bun:test",
      runner: "dynamic-worker",
    });
    return { handled: true };
  }

  /**
   * Evidence that the composition build already decided, with no runner: the `client-assets`
   * freshness rule, and a `build` check whose composition build did not pass (the output tail is
   * the Evidence). A passing composition build leaves the `build` check to its normal runner.
   * Returns false when the check still has to run.
   */
  private async recordCompositionBuild(
    ctx: ChangeContext,
    candidateId: string,
    composed: Extract<Composition, { ok: true }>,
    check: VerificationCheck,
  ): Promise<boolean> {
    const sourceRefs = [`artifacts://${candidateFork(candidateId)}@${composed.commit}`];
    const build = composed.appBuild;
    if (check.checkId === CLIENT_ASSETS_CHECK_ID) {
      const now = new Date().toISOString();
      const outcome = composed.clientAssets ?? {
        status: "error" as const,
        coverage: "not_checked" as const,
        summary: "No composition build result to compare. A gap, never a pass.",
      };
      await this.recordEvidence(ctx, candidateId, {
        checkId: check.checkId,
        kind: check.kind,
        outcome,
        startedAt: now,
        completedAt: now,
        output: [
          `generated by ${APP_BUILD_COMMAND}: ${build?.generated.join(", ") || "(none)"}`,
          outcome.summary,
        ].join("\n"),
        sourceRefs,
        report: { generated: build?.generated ?? [] },
      });
      return true;
    }
    if (check.checkId !== "build" || !build || build.exitCode === 0) return false;
    await this.recordEvidence(ctx, candidateId, {
      checkId: check.checkId,
      kind: check.kind,
      outcome: appBuildOutcome(build),
      startedAt: build.startedAt,
      completedAt: build.completedAt,
      output: `$ ${APP_BUILD_COMMAND}\n${build.output}${build.error ? `\n[error] ${build.error}` : ""}`,
      sourceRefs,
      exitCode: build.exitCode,
      command: APP_BUILD_COMMAND,
      runner: "sandbox",
    });
    return true;
  }

  /**
   * Acceptance check (ADR 0026): one Haiku call over the Change criteria, the Candidate patch, and
   * the relevant composed files, Sonnet once on invalid output. Code validates every citation. No
   * Sandbox and no browser. A Candidate whose earlier check already failed is not judged: it
   * cannot ship, so no model call is spent. A refused or failed call is a gap (`not_checked`),
   * never a pass.
   */
  private async runAcceptance(
    ctx: ChangeContext,
    candidateId: string,
    source: { fork: string; commit: string; tree: string; files: string[] },
    criteria: string[],
    check: VerificationCheck,
  ): Promise<null> {
    const startedAt = new Date().toISOString();
    const sourceRefs = [`artifacts://${source.fork}@${source.commit}`];
    const gap = (summary: string, metrics?: Record<string, number>) =>
      this.recordEvidence(ctx, candidateId, {
        checkId: check.checkId,
        kind: check.kind,
        outcome: {
          status: "error",
          coverage: "not_checked",
          summary,
          ...(metrics ? { metrics } : {}),
        },
        startedAt,
        output: summary,
        sourceRefs,
      });
    const failed = await this.env.DB.prepare(
      `SELECT check_id FROM evidence_index WHERE candidate_id = ? AND check_id != ?
         AND (status != 'pass' OR coverage != 'checked_supported') ORDER BY check_id LIMIT 1`,
    )
      .bind(candidateId, check.checkId)
      .first<{ check_id: string }>();
    if (failed) {
      const summary = `Not run: ${failed.check_id} has no passing result, so this Candidate cannot ship.`;
      await this.recordEvidence(ctx, candidateId, {
        checkId: check.checkId,
        kind: check.kind,
        outcome: { status: "skipped", coverage: "not_checked", summary },
        startedAt,
        output: summary,
        sourceRefs,
      });
      return null;
    }
    if (criteria.length === 0) {
      await gap("No acceptance criteria to judge.");
      return null;
    }
    const spend = await changeModelSpend(this.env.DB, ctx.changeId);
    if (spend.spentUsd >= spend.budgetUsd) {
      await gap(
        `Change budget reached ($${spend.spentUsd.toFixed(2)} of $${spend.budgetUsd.toFixed(2)}); acceptance not checked.`,
      );
      return null;
    }
    const read = await this.acceptanceSource(ctx.projectId, candidateId, source);
    if (read.files.length === 0) {
      await gap("No Candidate patch or composed file to read; acceptance not checked.");
      return null;
    }
    const judged = await judgeAcceptance(criteria, read, async (req) => {
      if (!(await takeDailyCall(this.env.DB))) {
        throw new ModelCallError("spend_limited", "daily model call cap reached", null);
      }
      return this.complete(req, ctx.changeId);
    });
    const costUsd = judged.calls.reduce((sum, call) => sum + call.costUsd, 0);
    const report = {
      source: {
        truncated: read.truncated,
        patch: read.files.filter((f) => f.kind === "patch").map((f) => f.path),
        files: read.files.filter((f) => f.kind === "file").map((f) => f.path),
      },
      calls: judged.calls,
    };
    if (judged.kind === "error") {
      await this.recordEvidence(ctx, candidateId, {
        checkId: check.checkId,
        kind: check.kind,
        outcome: {
          status: "error",
          coverage: "not_checked",
          summary: `No result: ${judged.reason}. A gap, never a pass.`,
          metrics: { costUsd },
        },
        startedAt,
        output: judged.reason,
        sourceRefs,
        report,
      });
      return null;
    }
    const outcome = acceptanceOutcome(judged.results);
    await this.env.DB.prepare(
      "UPDATE candidates SET acceptance_json = ?, updated_at = ? WHERE id = ?",
    )
      .bind(JSON.stringify(judged.results), new Date().toISOString(), candidateId)
      .run();
    await this.recordEvidence(ctx, candidateId, {
      checkId: check.checkId,
      kind: check.kind,
      outcome: { ...outcome, metrics: { ...outcome.metrics, costUsd } },
      startedAt,
      output: acceptanceReport(judged.results),
      sourceRefs: [...sourceRefs, candidatePatchKey(ctx.projectId, candidateId)],
      report: { ...report, acceptance: judged.results },
    });
    return null;
  }

  /**
   * What the acceptance check reads: the Candidate patch stored at composition (when it belongs to
   * this composed commit), then the full text of the relevant files of the composed tree, read
   * from the Candidate fork (`composedFileOrder`; all under ACCEPTANCE_SOURCE_CAP). A criterion
   * that code already in the base satisfies can then be cited from the composed file. When the
   * fork cannot be read, the patch alone is the source.
   */
  private async acceptanceSource(
    projectId: string,
    candidateId: string,
    source: { fork: string; commit: string; tree: string; files: string[] },
  ): Promise<AcceptanceSource> {
    const object = await this.env.EVIDENCE.get(candidatePatchKey(projectId, candidateId));
    const patch =
      object && (object.customMetadata?.head ?? source.commit) === source.commit
        ? { text: await object.text(), truncated: object.customMetadata?.truncated === "true" }
        : null;
    const composed: { path: string; text: string }[] = [];
    try {
      using repo = await this.env.ARTIFACTS.get(source.fork);
      const entries = await walkTree(repo, source.tree);
      const blobs = new Map(entries.map((e) => [e.path, e.blob]));
      const texts = new Map<string, string | null>();
      const read = async (path: string) => {
        if (texts.has(path)) return texts.get(path) ?? null;
        const sha = blobs.get(path);
        const blob = sha ? await repo.readBlob(sha) : null;
        const text =
          blob && blob.size <= ACCEPTANCE_SOURCE_CAP
            ? new TextDecoder().decode(await blob.arrayBuffer())
            : null;
        const usable = text !== null && !text.includes("\u0000") ? text : null;
        texts.set(path, usable);
        return usable;
      };
      const indexHtml = blobs.has("public/index.html") ? await read("public/index.html") : null;
      let room = ACCEPTANCE_SOURCE_CAP - Math.min(patch?.text.length ?? 0, ACCEPTANCE_SOURCE_CAP);
      for (const path of composedFileOrder([...blobs.keys()], source.files, indexHtml)) {
        if (room <= 0) break;
        const text = await read(path);
        if (text === null) continue;
        composed.push({ path, text });
        room -= text.length + path.length;
      }
    } catch {
      // The fork is unreadable: judge the patch alone.
    }
    return buildAcceptanceSource(patch, composed);
  }

  /** Diffs the route table against the base and records contract Evidence. */
  private async runContract(
    ctx: ChangeContext,
    candidateId: string,
    commits: { commit: string; baseCommit: string },
    declared: string[],
    check: VerificationCheck,
  ): Promise<number> {
    const run = await runContractCheck(this.env, {
      projectId: ctx.projectId,
      candidateId,
      ...commits,
      timeoutMs: check.timeoutMs,
    });
    await this.recordEvidence(ctx, candidateId, {
      checkId: check.checkId,
      kind: check.kind,
      outcome: classifyContract(run.base, run.candidate, declared),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      output: [
        `$ CONTRACT_ROOT=<base ${commits.baseCommit.slice(0, 12)}> bun run contract`,
        run.base?.output ?? "(not run: the base is an empty repository with no app)",
        `$ bun run contract`,
        run.candidate.output,
        `declared: ${JSON.stringify(declared)}`,
      ].join("\n"),
      sourceRefs: [`artifacts://${candidateFork(candidateId)}@${commits.commit}`],
      exitCode: run.candidate.exitCode,
      command: "bun run contract",
      runner: "sandbox",
    });
    return Date.now();
  }

  /**
   * Browser check: the composed app in the Sandbox, one capped Browser Run
   * session, screenshots in R2 beside the report. A refused budget, a missing preview, or a
   * session deadline is recorded as a gap, never a pass.
   */
  private async runBrowser(
    ctx: ChangeContext,
    candidateId: string,
    commit: string,
    check: VerificationCheck,
  ): Promise<number | null> {
    const prefix = `evidence/${ctx.projectId}/${ctx.changeId}/${candidateId}/${check.checkId}`;
    const result = await runBrowserCheck(this.env, {
      projectId: ctx.projectId,
      candidateId,
      commit,
      prefix,
    });
    await this.recordEvidence(ctx, candidateId, {
      checkId: check.checkId,
      kind: check.kind,
      outcome: classifyBrowser(result.run),
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      output: result.log,
      sourceRefs: [`artifacts://${candidateFork(candidateId)}@${commit}`],
      report: {
        browser: result.run,
        screenshotKeys: result.screenshotKeys,
      },
      runner: "sandbox",
    });
    return result.run.kind === "refused" ? null : Date.now();
  }

  /** Runs one check and records its Evidence. Returns the Sandbox activity time, if any. */
  private async runCheck(
    ctx: ChangeContext,
    candidateId: string,
    commit: string,
    check: VerificationCheck,
  ): Promise<number | null> {
    const startedAt = new Date().toISOString();
    const ref = `artifacts://${candidateFork(candidateId)}@${commit}`;
    if (!check.command) {
      await this.recordEvidence(ctx, candidateId, {
        checkId: check.checkId,
        kind: check.kind,
        outcome: procedureGap(check),
        startedAt,
        output: check.procedure ?? "",
        sourceRefs: [ref],
        runner: "sandbox",
      });
      return null;
    }
    if (!isAllowedCheckCommand(check.command)) {
      await this.recordEvidence(ctx, candidateId, {
        checkId: check.checkId,
        kind: check.kind,
        outcome: {
          status: "error",
          coverage: "not_checked",
          summary: `Command is not on the check allow-list: ${check.command}`,
        },
        startedAt,
        output: "",
        sourceRefs: [ref],
        runner: "sandbox",
      });
      return null;
    }
    const run = await runCandidateCheck(this.env, {
      projectId: ctx.projectId,
      candidateId,
      commit,
      command: check.command,
      timeoutMs: check.timeoutMs,
    });
    await this.recordEvidence(ctx, candidateId, {
      checkId: check.checkId,
      kind: check.kind,
      // Security: at least one authorization test must run; zero matched is a gap.
      outcome: check.kind === "security" ? classifySecurity(check, run) : classifyCheck(check, run),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      output: `$ ${check.command}\n${run.output}${run.error ? `\n[error] ${run.error}` : ""}`,
      sourceRefs: [ref],
      exitCode: run.exitCode,
      command: check.command,
      runner: "sandbox",
    });
    return Date.now();
  }

  /**
   * Stores one Evidence record: full output and report in R2 under the Evidence key layout, the
   * summary in D1, and `verification.check.completed`. Stable IDs and keys make a retry overwrite.
   */
  private async recordEvidence(
    ctx: ChangeContext,
    candidateId: string,
    input: {
      checkId: string;
      kind: string;
      outcome: CheckOutcome;
      startedAt: string;
      completedAt?: string;
      output: string;
      sourceRefs: string[];
      exitCode?: number | null;
      /** Extra report fields, for example browser steps and screenshot keys. */
      report?: Record<string, unknown>;
      command?: string;
      runner?: CheckRunner;
    },
  ) {
    const completedAt = input.completedAt ?? new Date().toISOString();
    const prefix = `evidence/${ctx.projectId}/${ctx.changeId}/${candidateId}/${input.checkId}`;
    const contentHash = await sha256(input.output);
    const summary = input.runner
      ? `${input.outcome.summary} (runner: ${input.runner})`
      : input.outcome.summary;
    const record: EvidenceRecord = {
      evidenceId: evidenceIdFor(candidateId, input.checkId),
      candidateId,
      checkId: input.checkId,
      kind: input.kind,
      status: input.outcome.status,
      coverage: input.outcome.coverage,
      startedAt: input.startedAt,
      completedAt,
      summary,
      contentHash,
      r2Key: `${prefix}/report.json`,
      ...(input.outcome.metrics ? { metrics: input.outcome.metrics } : {}),
      sourceRefs: input.sourceRefs,
    };
    await this.env.EVIDENCE.put(`${prefix}/stdout.txt`, input.output, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { contentHash, ...(input.runner ? { runner: input.runner } : {}) },
    });
    await this.env.EVIDENCE.put(
      `${prefix}/report.json`,
      JSON.stringify(
        {
          record,
          runner: input.runner ?? null,
          command: input.command ?? null,
          exitCode: input.exitCode ?? null,
          stdoutKey: `${prefix}/stdout.txt`,
          ...input.report,
        },
        null,
        2,
      ),
      { httpMetadata: { contentType: "application/json" } },
    );
    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO evidence_index (id, candidate_id, kind, status, summary, r2_key,
         content_hash, created_at, check_id, coverage, started_at, completed_at, metrics_json,
         source_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        record.evidenceId,
        candidateId,
        record.kind,
        record.status,
        record.summary,
        record.r2Key ?? null,
        contentHash,
        completedAt,
        record.checkId,
        record.coverage,
        record.startedAt,
        record.completedAt,
        record.metrics ? JSON.stringify(record.metrics) : null,
        JSON.stringify(record.sourceRefs),
      )
      .run();
    await appendChangeEvents(this.env.RESOURCE_SHARD, ctx, [
      await changeEvent(
        ctx,
        "verification.check.completed",
        {
          candidateId,
          evidenceId: record.evidenceId,
          checkId: record.checkId,
          kind: record.kind,
          status: record.status,
          coverage: record.coverage,
          summary: record.summary,
          ...(record.metrics ? { metrics: record.metrics } : {}),
        },
        { key: `${candidateId}:${record.checkId}`, actor: ACTOR },
      ),
    ]);
  }
}
