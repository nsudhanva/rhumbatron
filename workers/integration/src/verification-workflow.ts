import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  buildVerificationPlan,
  type CheckGap,
  checkCompatibility,
  gateRequiredChecks,
} from "@rhumbatron/evidence";
import {
  ChangeSetIntent,
  type EventEnvelope,
  type EvidenceRecord,
  RiskTier,
  type VerificationCheck,
  type VerificationPlan,
} from "@rhumbatron/protocol";
import { runBrowserCheck } from "./browser-check.ts";
import {
  type ChangeSetRow,
  type CheckOutcome,
  classifyCheck,
  classifyContract,
  DEFAULT_POLICY,
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
import { classifyBrowser, classifySecurity } from "./check-semantics.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { type EvidenceRow, toRecord } from "./evidence-rows.ts";

/**
 * CandidateVerificationWorkflow (AGENTS.md sections 21.2, 33, 34). One instance per Candidate
 * (instance ID = Candidate ID). It composes the Candidate's ChangeSets on its base commit in an
 * Artifacts fork, runs the Verification Plan in the Project Sandbox, stores Evidence in D1 and R2,
 * and gates the required checks. Every step is idempotent: IDs, R2 keys, and commits are stable.
 * No model calls. Only `checked_supported` + `pass` satisfies a required check.
 */

export type CandidateVerificationParams = { candidateId: string };

const ACTOR = { kind: "system", id: "candidate-verification" } as const;
/** States after which this workflow has nothing to do. */
const FINAL = new Set(["verified", "rejected", "stale", "promoted"]);
/** Remove the checkout only while the Sandbox is still awake; a sleeping one already lost it. */
const AWAKE_MS = 90_000;

type Loaded = {
  ctx: ChangeContext;
  status: string;
  createdAt: string;
  goal: string;
  riskTier: RiskTier;
  invariants: string[];
  acceptanceCriteria: string[];
  touchesAuthorization: boolean;
  canonical: { generation: number; treeSha: string; commit: string | null } | null;
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
  project_id: string;
  goal: string;
  risk_tier: string | null;
  invariants_json: string;
  acceptance_criteria_json: string;
  org_id: string;
  slug: string;
};

const evidenceIdFor = (candidateId: string, checkId: string) =>
  `ev_${candidateId.slice(5)}_${checkId}`;

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
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

    // Step 1: confirm the Candidate and its base generation (section 21.2). Retries cover a
    // promotion whose source sync has not landed yet (see below).
    const loaded = await step.do(
      "load candidate",
      { retries: { limit: 5, delay: "15 seconds", backoff: "exponential" } },
      async (): Promise<Loaded | null> => {
        const row = await this.env.DB.prepare(
          `SELECT c.id, c.change_id, c.base_generation, c.status, c.change_set_ids_json, c.created_at,
                ch.project_id, ch.goal, ch.risk_tier, ch.invariants_json, ch.acceptance_criteria_json,
                p.org_id, p.slug
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
          const commit = index ? ((await index.json()) as { commit?: string }).commit : undefined;
          canonical = {
            generation: snapshot.generation,
            treeSha: snapshot.treeSha,
            commit: commit ?? null,
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
          createdAt: row.created_at,
          goal: row.goal,
          riskTier: RiskTier.catch("medium").parse(row.risk_tier ?? "medium"),
          invariants: JSON.parse(row.invariants_json) as string[],
          acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as string[],
          touchesAuthorization,
          canonical,
          changeSets: (sets?.results ?? []) as ChangeSetRow[],
          changeSetIds: ids,
          edges: (edges?.results ?? []) as TaskEdge[],
        };
      },
    );
    if (!loaded) return { skipped: "missing" };
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

    if (!loaded.canonical?.commit) {
      await finish("rejected", "Project has no canonical source to compose on.");
      return { status: "rejected" };
    }
    // Section 13.1: a Candidate is valid only on the current Canonical Generation.
    if (loaded.canonical.generation !== ctx.baseGeneration) {
      await finish(
        "stale",
        `Base S${ctx.baseGeneration} is behind canonical S${loaded.canonical.generation}.`,
      );
      return { status: "stale" };
    }
    const baseCommit = loaded.canonical.commit;

    // Deterministic compatibility before any Sandbox time (section 33). A shared file is left to
    // the real merge below, which reports an actual source conflict instead of a guess.
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
    const { composable, sources } = parsed;
    const compatibility = checkCompatibility(ctx.baseGeneration, composable, {
      protectedResources: DEFAULT_POLICY.protectedResources,
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

    let fork: string;
    try {
      fork = await step.do(
        "fork candidate repo",
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          const name = await forkCandidate(this.env, ctx.projectId, candidateId);
          await this.env.DB.prepare(
            "UPDATE candidates SET artifact_ref = ?, updated_at = ? WHERE id = ?",
          )
            .bind(`artifacts://${name}@main`, new Date().toISOString(), candidateId)
            .run();
          return name;
        },
      );
    } catch (error) {
      await finish("rejected", `Could not fork the canonical repo: ${String(error).slice(0, 200)}`);
      return { status: "rejected", reason: "fork_failed" };
    }

    // Reserve before the Sandbox opens (HOM-192). A retried reservation can only over-count.
    const reservation = await step.do("reserve sandbox", async () => ({
      ok: await reserveSandbox(this.env.DB),
      at: Date.now(),
    }));
    if (!reservation.ok) {
      await finish("rejected", "Monthly Sandbox budget reached; no check ran.");
      return { status: "rejected", reason: "sandbox_budget" };
    }

    let lastSandboxAt = reservation.at;
    try {
      // Step 2 (P10-03): compose the ChangeSets in Work Graph order.
      let composed: Composition & { at: number };
      try {
        composed = await step.do(
          "compose candidate",
          {
            retries: { limit: 1, delay: "20 seconds", backoff: "constant" },
            timeout: "10 minutes",
          },
          async () => {
            const result = await composeCandidate(this.env, {
              projectId: ctx.projectId,
              candidateId,
              baseCommit,
              sources,
              commitTime: Math.floor(Date.parse(loaded.createdAt) / 1000),
            });
            return { ...result, at: Date.now() };
          },
        );
      } catch (error) {
        // No composed source means no Evidence can exist: the Candidate cannot ship.
        await finish("rejected", `Composition did not finish: ${String(error).slice(0, 200)}`, [
          { checkId: "composition", reason: "error" },
        ]);
        return { status: "rejected", reason: "composition_error" };
      }
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

      // Step 3: the risk-based Verification Plan (sections 34.1, 34.2, 53).
      const plan = await step.do("record composition and plan", async () => {
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
          policy: DEFAULT_POLICY,
          ...scope,
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
        return built;
      });

      // Contract changes the ChangeSets declared; the contract check fails on any other.
      const declared = loaded.changeSets.flatMap(
        (c) => ChangeSetIntent.parse(JSON.parse(c.intent_json)).expectedContractChanges,
      );

      // Steps 3-8: one step per check, so each has its own timeout, retry, and Evidence.
      for (const check of plan.checks) {
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
              check.kind === "contract"
                ? this.runContract(ctx, candidateId, { commit, baseCommit }, declared, check)
                : check.kind === "browser"
                  ? this.runBrowser(ctx, candidateId, commit, check)
                  : this.runCheck(ctx, candidateId, commit, check),
          );
          if (at) lastSandboxAt = at;
        } catch (error) {
          // The check produced no result: record the gap. Never a pass (section 34.4.1).
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
            });
            return null;
          });
        }
      }

      // Steps 9-10: gate on authoritative Evidence rows.
      return await step.do("gate required checks", async () => {
        const rows = await this.env.DB.prepare(
          "SELECT * FROM evidence_index WHERE candidate_id = ?",
        )
          .bind(candidateId)
          .all<EvidenceRow>();
        const records = (rows.results ?? []).map(toRecord);
        const gate = gateRequiredChecks(plan, records);
        const status = gate.promotable ? "verified" : "rejected";
        const p95 = records.find((r) => r.checkId === "performance")?.metrics?.p95Ms;
        const score = {
          ...gate,
          humanApprovalRequired: plan.humanApprovalRequired,
          ...(p95 === undefined ? {} : { p95Ms: p95 }),
        };
        const reason = gate.promotable
          ? null
          : `Required checks not satisfied: ${gate.gaps.map((g) => `${g.checkId} (${g.reason})`).join(", ")}`;
        await this.env.DB.prepare(
          `UPDATE candidates SET status = ?, status_reason = ?, score_json = ?, updated_at = ?
           WHERE id = ? AND status = 'verifying'`,
        )
          .bind(status, reason, JSON.stringify(score), new Date().toISOString(), candidateId)
          .run();
        const events: EventEnvelope[] = [
          await changeEvent(
            ctx,
            "verification.completed",
            { candidateId, status, ...score },
            { key: candidateId, actor: ACTOR },
          ),
        ];
        // Section 36 rule 4: a gated Candidate waits for a human decision before promotion.
        if (gate.promotable && plan.humanApprovalRequired) {
          events.push(
            await changeEvent(
              ctx,
              "approval.requested",
              { candidateId, riskTier: loaded.riskTier, policyVersion: plan.policyVersion },
              { key: candidateId, actor: ACTOR },
            ),
          );
        }
        await appendChangeEvents(this.env.RESOURCE_SHARD, ctx, events);
        return { status, promotable: gate.promotable, gaps: gate.gaps };
      });
    } finally {
      await step.do("settle sandbox", async () => {
        await settleSandbox(this.env.DB, reservation.at);
        if (Date.now() - lastSandboxAt < AWAKE_MS) {
          await removeCandidateDir(this.env, ctx.projectId, candidateId);
        }
        return candidateFork(candidateId);
      });
    }
  }

  /** Diffs the route table against the base and records contract Evidence (section 34.1). */
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
        run.base.output,
        `$ bun run contract`,
        run.candidate.output,
        `declared: ${JSON.stringify(declared)}`,
      ].join("\n"),
      sourceRefs: [`artifacts://${candidateFork(candidateId)}@${commits.commit}`],
      exitCode: run.candidate.exitCode,
      command: "bun run contract",
    });
    return Date.now();
  }

  /**
   * Browser check (section 35, P10-11): the composed app in the Sandbox, one capped Browser Run
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
      // Security: at least one authorization test must run; zero matched is a gap (P10-10).
      outcome: check.kind === "security" ? classifySecurity(check, run) : classifyCheck(check, run),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      output: `$ ${check.command}\n${run.output}${run.error ? `\n[error] ${run.error}` : ""}`,
      sourceRefs: [ref],
      exitCode: run.exitCode,
      command: check.command,
    });
    return Date.now();
  }

  /**
   * Stores one Evidence record: full output and report in R2 under the section 34.4 layout, the
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
    },
  ) {
    const completedAt = input.completedAt ?? new Date().toISOString();
    const prefix = `evidence/${ctx.projectId}/${ctx.changeId}/${candidateId}/${input.checkId}`;
    const contentHash = await sha256(input.output);
    const record: EvidenceRecord = {
      evidenceId: evidenceIdFor(candidateId, input.checkId),
      candidateId,
      checkId: input.checkId,
      kind: input.kind,
      status: input.outcome.status,
      coverage: input.outcome.coverage,
      startedAt: input.startedAt,
      completedAt,
      summary: input.outcome.summary,
      contentHash,
      r2Key: `${prefix}/report.json`,
      ...(input.outcome.metrics ? { metrics: input.outcome.metrics } : {}),
      sourceRefs: input.sourceRefs,
    };
    await this.env.EVIDENCE.put(`${prefix}/stdout.txt`, input.output, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { contentHash },
    });
    await this.env.EVIDENCE.put(
      `${prefix}/report.json`,
      JSON.stringify(
        {
          record,
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
