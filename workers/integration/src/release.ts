import type {
  EventEnvelope,
  EvidenceRecord,
  ReleaseInjectionOutcome,
  ReleaseStatus,
  ReleaseView,
} from "@rhumbatron/protocol";
import { hasLiveApp, probeApp, productionRow } from "./app-release.ts";
import { releaseRequestScope } from "./change-commands.ts";
import { changeAfterRelease, releaseRecovery } from "./change-status.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import {
  ACME_SHOP_LIVE_PROBES,
  addedRoutesFromContract,
  classifySmoke,
  fromStatuses,
  type ProbeResult,
  releaseCheckId,
  releaseIdFor,
  routesFromContract,
  runProbes,
  type SmokeOutcome,
  smokePassed,
  smokeProbes,
} from "./release-model.ts";
import { releaseCommand, requestWorkflowStart } from "./workflow-commands.ts";

/**
 * Release registry and its side effects (AGENTS.md sections 21.3, 37, 42.10, 60; ADR 0018).
 * Promotion starts a release after canonical `main` moved; Workers Builds builds and deploys that
 * push; ReleaseWorkflow observes the build, confirms the deployment, and runs the smoke check.
 * Every write is idempotent: the release ID is the Project plus generation, events have stable
 * IDs, and status changes are guarded by the allowed transitions. Nothing here deletes history.
 */

export type ReleaseParams = { releaseId: string };

export type ReleaseRow = {
  id: string;
  project_id: string;
  change_id: string;
  candidate_id: string;
  generation: number;
  commit_sha: string;
  status: ReleaseStatus;
  build_uuid: string | null;
  version_id: string | null;
  started_at: string;
  finished_at: string | null;
  failure_reason: string | null;
  evidence_id: string | null;
  evidence_r2_key: string | null;
};

export type ReleaseTarget = {
  project_id: string;
  worker_name: string;
  worker_tag: string;
  url: string;
};

/** A release with its target and the event context of its Change. */
export type LoadedRelease = {
  release: ReleaseRow;
  target: ReleaseTarget | null;
  /**
   * The Project's live app (prod, ADR 0020). A Project with an app releases by moving its
   * production pointer; Workers Builds stays only for the legacy dev release target (P16-15).
   */
  app: { label: string } | null;
  ctx: ChangeContext;
};

const ACTOR = { kind: "system", id: "release" } as const;

function toReleaseView(row: ReleaseRow, target: ReleaseTarget | null): ReleaseView {
  return {
    id: row.id,
    projectId: row.project_id,
    changeId: row.change_id,
    candidateId: row.candidate_id,
    generation: row.generation,
    commit: row.commit_sha,
    status: row.status,
    buildUuid: row.build_uuid,
    versionId: row.version_id,
    url: target?.url ?? null,
    workerName: target?.worker_name ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    failureReason: row.failure_reason,
    evidenceId: row.evidence_id,
    evidenceR2Key: row.evidence_r2_key,
  };
}

const loadTarget = (env: Env, projectId: string) =>
  env.DB.prepare("SELECT * FROM release_targets WHERE project_id = ?")
    .bind(projectId)
    .first<ReleaseTarget>();

/**
 * Whether a promotion of this Project starts a release: it has a live app (prod, ADR 0020), or
 * the legacy Workers Builds release target (dev Acme Shop Live, ADR 0018).
 */
export const hasReleaseTarget = async (env: Env, projectId: string) =>
  (await hasLiveApp(env, projectId)) || (await loadTarget(env, projectId)) !== null;

/**
 * The fact that a Change ended after promotion (`change.completed` or `change.failed`), so the
 * live view leaves its `promoting` or `releasing` status (section 13.3). One stable ID per Change:
 * a repeat after a lost reply dedupes in the shard outbox.
 */
export const changeEndedEvent = (
  ctx: ChangeContext,
  status: "completed" | "failed",
  payload: Record<string, unknown>,
) =>
  changeEvent(ctx, status === "completed" ? "change.completed" : "change.failed", {
    status,
    ...payload,
  });

/**
 * Moves a `releasing` Change to `next` and reports whether the Change is in `next` afterwards.
 * Only `releasing` moves, so a later injected smoke failure (P13-12) never reopens a completed
 * Change. One D1 batch.
 */
async function endReleasingChange(env: Env, changeId: string, next: "completed" | "failed") {
  const [, after] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE changes SET status = ?, updated_at = ? WHERE id = ? AND status = 'releasing'",
    ).bind(next, new Date().toISOString(), changeId),
    env.DB.prepare("SELECT status, project_id FROM changes WHERE id = ?").bind(changeId),
  ]);
  const settled = after?.results?.[0] as { status: string; project_id: string } | undefined;
  if (settled?.status === next) await releaseRequestScope(env, settled.project_id, changeId);
  return settled?.status === next;
}

export async function loadRelease(env: Env, releaseId: string): Promise<LoadedRelease | null> {
  const release = await env.DB.prepare("SELECT * FROM releases WHERE id = ?")
    .bind(releaseId)
    .first<ReleaseRow>();
  if (!release) return null;
  const [target, project, app] = await Promise.all([
    loadTarget(env, release.project_id),
    env.DB.prepare("SELECT org_id, slug FROM projects WHERE id = ?")
      .bind(release.project_id)
      .first<{ org_id: string; slug: string }>(),
    env.APPS ? productionRow(env, release.project_id) : Promise.resolve(null),
  ]);
  if (!project) return null;
  return {
    release,
    target,
    app: app && app.status !== "removed" ? { label: app.slug } : null,
    ctx: {
      projectId: release.project_id,
      orgId: project.org_id,
      projectSlug: project.slug,
      changeId: release.change_id,
      // Release events describe the promoted generation.
      baseGeneration: release.generation,
    },
  };
}

/**
 * Starts the release of a promoted generation when the Project has a release target. Called by
 * promotion after canonical `main` points at the promoted commit, and again on a promotion retry.
 * Never throws: the generation already advanced, and a promotion retry starts a missing release.
 */
export async function startRelease(
  env: Env,
  input: {
    projectId: string;
    changeId: string;
    candidateId: string;
    generation: number;
    commit: string;
  },
): Promise<{ releaseId: string } | null> {
  try {
    if (!(await hasReleaseTarget(env, input.projectId))) return null;
    const releaseId = releaseIdFor(input.projectId, input.generation);
    const now = new Date().toISOString();
    const [, , supersededChanges] = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO releases (id, project_id, change_id, candidate_id, generation,
           commit_sha, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      ).bind(
        releaseId,
        input.projectId,
        input.changeId,
        input.candidateId,
        input.generation,
        input.commit,
        now,
      ),
      // An older release still in flight would deploy an older commit: this generation owns it.
      env.DB.prepare(
        `UPDATE releases SET status = 'superseded', finished_at = ?, failure_reason = ?
         WHERE project_id = ? AND generation < ? AND status IN ('queued', 'building')`,
      ).bind(now, `Superseded by S${input.generation}.`, input.projectId, input.generation),
      // Their Changes still promoted: the newer generation's release owns the deployment.
      env.DB.prepare(
        `UPDATE changes SET status = 'completed', updated_at = ?
         WHERE status = 'releasing' AND id IN (SELECT change_id FROM releases
           WHERE project_id = ? AND generation < ? AND status = 'superseded')
         RETURNING id, base_generation`,
      ).bind(now, input.projectId, input.generation),
    ]);
    // Section 20: the start travels on the release Queue; the instance ID stays the release ID, so
    // an earlier promotion attempt's instance is found, not duplicated. Direct start on send failure.
    await requestWorkflowStart(
      env,
      releaseCommand(releaseId, { projectId: input.projectId, changeId: input.changeId }),
    );
    await recordSupersededChanges(
      env,
      input,
      (supersededChanges?.results ?? []) as { id: string; base_generation: number }[],
    );
    return { releaseId };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "release.start_failed",
        projectId: input.projectId,
        generation: input.generation,
        message: String(error).slice(0, 300),
      }),
    );
    return null;
  }
}

/** `change.completed` for older Changes a newer release superseded. Never fails the release. */
async function recordSupersededChanges(
  env: Env,
  input: { projectId: string; generation: number },
  changes: { id: string; base_generation: number }[],
) {
  if (changes.length === 0) return;
  try {
    const project = await env.DB.prepare("SELECT org_id, slug FROM projects WHERE id = ?")
      .bind(input.projectId)
      .first<{ org_id: string; slug: string }>();
    if (!project) return;
    for (const change of changes) {
      await releaseRequestScope(env, input.projectId, change.id);
      const ctx: ChangeContext = {
        projectId: input.projectId,
        orgId: project.org_id,
        projectSlug: project.slug,
        changeId: change.id,
        baseGeneration: change.base_generation,
      };
      await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
        await changeEndedEvent(ctx, "completed", {
          releaseStatus: "superseded",
          reason: `Superseded by the release of S${input.generation}.`,
        }),
      ]);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "release.superseded_events_failed",
        message: String(error).slice(0, 300),
      }),
    );
  }
}

/**
 * Moves a release to `to` when the transition is allowed, then appends `events` if the release is
 * in `to` afterwards. A retry after a lost reply appends the same events again; their stable IDs
 * dedupe in the shard outbox. Returns the status after the write.
 */
export async function transitionRelease(
  env: Env,
  loaded: LoadedRelease,
  to: ReleaseStatus,
  fields: {
    failureReason?: string | null;
    buildUuid?: string | null;
    versionId?: string | null;
    evidenceId?: string | null;
    evidenceR2Key?: string | null;
  },
  events: EventEnvelope[] = [],
): Promise<ReleaseStatus> {
  const allowed = fromStatuses(to);
  const final = to !== "building";
  await env.DB.prepare(
    `UPDATE releases SET status = ?,
       finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
       failure_reason = COALESCE(?, failure_reason),
       build_uuid = COALESCE(?, build_uuid),
       version_id = COALESCE(?, version_id),
       evidence_id = COALESCE(?, evidence_id),
       evidence_r2_key = COALESCE(?, evidence_r2_key)
     WHERE id = ? AND status IN (SELECT value FROM json_each(?))`,
  )
    .bind(
      to,
      final ? 1 : 0,
      new Date().toISOString(),
      fields.failureReason ?? null,
      fields.buildUuid ?? null,
      fields.versionId ?? null,
      fields.evidenceId ?? null,
      fields.evidenceR2Key ?? null,
      loaded.release.id,
      JSON.stringify(allowed),
    )
    .run();
  const after = await env.DB.prepare("SELECT status FROM releases WHERE id = ?")
    .bind(loaded.release.id)
    .first<{ status: ReleaseStatus }>();
  const status = after?.status ?? loaded.release.status;
  // A `releasing` Change ends with its release: `completed` when it deployed or a newer generation
  // superseded it, `failed` when it did not deploy (change-status.ts).
  const next = changeAfterRelease(status);
  const ended = next ? await endReleasingChange(env, loaded.release.change_id, next) : false;
  const all = [
    ...(status === to ? events : []),
    ...(next && ended
      ? [
          await changeEndedEvent(loaded.ctx, next, {
            releaseId: loaded.release.id,
            releaseStatus: status,
            generation: loaded.release.generation,
            ...(loaded.release.failure_reason || fields.failureReason
              ? {
                  reason: (fields.failureReason ?? loaded.release.failure_reason ?? "").slice(
                    0,
                    300,
                  ),
                }
              : {}),
          }),
        ]
      : []),
  ];
  if (all.length > 0) await appendChangeEvents(env.RESOURCE_SHARD, loaded.ctx, all);
  return status;
}

/** One release event with a stable ID per release (and `suffix`, for example an attempt). */
export const releaseEvent = <T extends Record<string, unknown>>(
  loaded: LoadedRelease,
  eventType: EventEnvelope["eventType"],
  payload: T,
  suffix = "",
) =>
  changeEvent(
    loaded.ctx,
    eventType,
    {
      releaseId: loaded.release.id,
      candidateId: loaded.release.candidate_id,
      generation: loaded.release.generation,
      commit: loaded.release.commit_sha,
      ...payload,
    },
    { key: `${loaded.release.id}${suffix}`, actor: ACTOR },
  );

/* ------------------------------------------------------------------------------------------ */
/* Stuck-release recovery (HOM-204)                                                            */
/* ------------------------------------------------------------------------------------------ */

type ReleasingChangeRow = {
  id: string;
  project_id: string;
  status: string;
  updated_at: string;
  base_generation: number;
  org_id: string;
  slug: string;
  has_target: number;
};

/**
 * Recovers one Change stuck in `releasing` (event router sweep, command `release.recover`).
 * Deterministic: `releaseRecovery` decides from D1 rows. A release still in flight is marked
 * failed through the normal guarded transition, so a late ReleaseWorkflow step cannot reopen it.
 * A release that never started is recorded as a failed release row, so its reason shows with
 * the Project's releases. The generation stays promoted (section 42.10): recovery is the next
 * promotion, whose release supersedes or follows this one as usual. Safe to repeat.
 */
export async function recoverStuckRelease(
  env: Env,
  changeId: string,
  now = Date.now(),
): Promise<{ status: string; recovery?: string }> {
  const row = await env.DB.prepare(
    `SELECT c.id, c.project_id, c.status, c.updated_at, c.base_generation, p.org_id, p.slug,
            (EXISTS (SELECT 1 FROM release_targets t WHERE t.project_id = c.project_id)
              OR EXISTS (SELECT 1 FROM app_deployments d WHERE d.project_id = c.project_id
                AND d.channel = 'production' AND d.status != 'removed')) AS has_target
     FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
  )
    .bind(changeId)
    .first<ReleasingChangeRow>();
  if (row?.status !== "releasing") return { status: row?.status ?? "missing" };
  const promotedOf = `SELECT id FROM candidates WHERE change_id = ? AND status = 'promoted'`;
  const [releases, candidates] = await env.DB.batch([
    env.DB.prepare(
      `SELECT * FROM releases WHERE candidate_id IN (${promotedOf})
       ORDER BY generation DESC LIMIT 1`,
    ).bind(changeId),
    env.DB.prepare(
      `SELECT id, promoted_generation, composed_commit FROM candidates
       WHERE change_id = ? AND status = 'promoted' AND promoted_generation IS NOT NULL
       ORDER BY promoted_generation DESC LIMIT 1`,
    ).bind(changeId),
  ]);
  const release = (releases?.results?.[0] as ReleaseRow | undefined) ?? null;
  const decision = releaseRecovery({
    hasReleaseTarget: row.has_target === 1,
    release: release ? { status: release.status, startedAt: release.started_at } : null,
    releasingSince: row.updated_at,
    now,
  });
  const ctx: ChangeContext = {
    projectId: row.project_id,
    orgId: row.org_id,
    projectSlug: row.slug,
    changeId,
    baseGeneration: row.base_generation,
  };
  const end = async (next: "completed" | "failed", payload: Record<string, unknown>) => {
    if (await endReleasingChange(env, changeId, next)) {
      await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
        await changeEndedEvent(ctx, next, { ...payload, recovered: true }),
      ]);
    }
  };

  switch (decision.kind) {
    case "wait":
      break;
    case "settle":
      await end(decision.change, {
        ...(release ? { releaseId: release.id, releaseStatus: release.status } : {}),
      });
      break;
    case "complete":
      await end("completed", { reason: decision.reason });
      break;
    case "fail_release": {
      const loaded = release ? await loadRelease(env, release.id) : null;
      if (!loaded) break;
      // Ends the Change too (transitionRelease), with `change.failed`.
      await transitionRelease(env, loaded, "failed", { failureReason: decision.reason }, [
        await releaseEvent(loaded, "deployment.failed", {
          status: "failed",
          reason: decision.reason,
          recovered: true,
        }),
      ]);
      break;
    }
    case "fail_unstarted": {
      const candidate = candidates?.results?.[0] as
        | { id: string; promoted_generation: number; composed_commit: string | null }
        | undefined;
      if (!candidate) {
        await end("failed", { reason: decision.reason });
        break;
      }
      const releaseId = releaseIdFor(row.project_id, candidate.promoted_generation);
      const at = new Date(now).toISOString();
      // A release row of this generation that appeared meanwhile is left to its own workflow.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO releases (id, project_id, change_id, candidate_id, generation,
           commit_sha, status, started_at, finished_at, failure_reason)
         VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)`,
      )
        .bind(
          releaseId,
          row.project_id,
          changeId,
          candidate.id,
          candidate.promoted_generation,
          candidate.composed_commit ?? "",
          at,
          at,
          decision.reason,
        )
        .run();
      const loaded = await loadRelease(env, releaseId);
      if (!loaded) break;
      if (loaded.release.status !== "failed") {
        // Another release attempt started after the sweep read: the next sweep decides again.
        return { status: row.status, recovery: "wait" };
      }
      await transitionRelease(env, loaded, "failed", {}, [
        await releaseEvent(loaded, "deployment.failed", {
          status: "failed",
          reason: decision.reason,
          recovered: true,
        }),
      ]);
      break;
    }
  }
  const after = await env.DB.prepare("SELECT status FROM changes WHERE id = ?")
    .bind(changeId)
    .first<{ status: string }>();
  return { status: after?.status ?? "missing", recovery: decision.kind };
}

/* ------------------------------------------------------------------------------------------ */
/* Builds API (user-scoped token: Workers Builds Configuration Edit + Workers Scripts Read)     */
/* ------------------------------------------------------------------------------------------ */

export function buildsConfigured(env: Env) {
  return !!env.BUILDS_API_TOKEN && !!env.BUILDS_ACCOUNT_ID;
}

/** GET only. Errors name the path and status, never the token. */
export async function cloudflareGet(env: Env, path: string): Promise<unknown> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.BUILDS_ACCOUNT_ID}${path}`,
    {
      headers: { authorization: `Bearer ${env.BUILDS_API_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: { message?: string }[];
  } | null;
  if (!response.ok || body?.success === false) {
    const message = body?.errors?.map((e) => e.message).join("; ") ?? "";
    throw new Error(
      `Cloudflare API ${path.split("?")[0]} returned ${response.status}${message ? `: ${message}` : ""}`.slice(
        0,
        300,
      ),
    );
  }
  return body;
}

/* ------------------------------------------------------------------------------------------ */
/* Smoke check and release Evidence                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * The promoted Candidate's route table and the routes its Change added, from its contract
 * Evidence. Null routes when there is no contract Evidence (for example a rollback Candidate).
 */
async function routeTable(
  env: Env,
  candidateId: string,
): Promise<{ routes: string[] | null; added: string[] }> {
  const row = await env.DB.prepare(
    `SELECT r2_key FROM evidence_index WHERE candidate_id = ? AND kind = 'contract'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(candidateId)
    .first<{ r2_key: string | null }>();
  if (!row?.r2_key) return { routes: null, added: [] };
  const stdout = await env.EVIDENCE.get(row.r2_key.replace(/report\.json$/, "stdout.txt"));
  if (!stdout) return { routes: null, added: [] };
  const output = await stdout.text();
  return { routes: routesFromContract(output), added: addedRoutesFromContract(output) };
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Stores release smoke Evidence in the Candidate Evidence model (section 34.3/34.4 layout): full
 * output in R2, the summary in D1 `evidence_index`. Its check ID starts with `release-`, so it is
 * never a Candidate verification check and never feeds a promotion gate. Stable ID and keys.
 */
async function recordReleaseEvidence(
  env: Env,
  loaded: LoadedRelease,
  input: {
    outcome: SmokeOutcome;
    results: ProbeResult[];
    startedAt: string;
    injected: boolean;
    attempt: number;
  },
): Promise<EvidenceRecord> {
  const { release, ctx } = loaded;
  const checkId = releaseCheckId(release.generation, input.injected);
  const prefix = `evidence/${ctx.projectId}/${ctx.changeId}/${release.candidate_id}/${checkId}`;
  const completedAt = new Date().toISOString();
  const output = [
    `release ${release.id} · S${release.generation} · commit ${release.commit_sha}`,
    loaded.app
      ? `app ${loaded.app.label} (production host, through the apps router) · bundle ${release.version_id ?? "none"}`
      : `target ${loaded.target?.url ?? "none"} · build ${release.build_uuid ?? "none"} · version ${release.version_id ?? "none"}`,
    ...(input.injected ? ["injected: true (P13-12 failure injection)"] : []),
    `attempt ${input.attempt}`,
    ...input.results.map(
      (r) =>
        `${r.ok ? "pass" : "FAIL"}  GET ${r.probe.path}  expect ${r.probe.expect}  -> ${r.status ?? "no response"}  ${r.detail}`,
    ),
  ].join("\n");
  const contentHash = await sha256(output);
  const record: EvidenceRecord = {
    evidenceId: `ev_${release.candidate_id.slice(5)}_${checkId}`,
    candidateId: release.candidate_id,
    checkId,
    kind: "smoke",
    status: input.outcome.status,
    coverage: input.outcome.coverage,
    startedAt: input.startedAt,
    completedAt,
    summary: input.outcome.summary,
    contentHash,
    r2Key: `${prefix}/report.json`,
    metrics: {
      probes: input.results.length,
      probesFailed: input.results.filter((r) => !r.ok).length,
      generation: release.generation,
    },
    sourceRefs: [
      `artifacts://${ctx.projectId}@${release.commit_sha}`,
      ...(release.build_uuid ? [`workers-builds://${release.build_uuid}`] : []),
      ...(release.version_id
        ? [loaded.app ? `r2://${release.version_id}` : `worker-version://${release.version_id}`]
        : []),
    ],
  };
  await env.EVIDENCE.put(`${prefix}/stdout.txt`, output, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { contentHash },
  });
  await env.EVIDENCE.put(
    `${prefix}/report.json`,
    JSON.stringify(
      {
        record,
        releaseId: release.id,
        injected: input.injected,
        attempt: input.attempt,
        url: loaded.target?.url ?? null,
        app: loaded.app?.label ?? null,
        probes: input.results.map((r) => ({
          name: r.probe.name,
          path: r.probe.path,
          expect: r.probe.expect,
          status: r.status,
          ok: r.ok,
          detail: r.detail,
        })),
        stdoutKey: `${prefix}/stdout.txt`,
      },
      null,
      2,
    ),
    { httpMetadata: { contentType: "application/json" } },
  );
  await env.DB.prepare(
    `INSERT OR REPLACE INTO evidence_index (id, candidate_id, kind, status, summary, r2_key,
       content_hash, created_at, check_id, coverage, started_at, completed_at, metrics_json,
       source_refs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      record.evidenceId,
      record.candidateId,
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
      JSON.stringify(record.metrics),
      JSON.stringify(record.sourceRefs),
    )
    .run();
  return record;
}

/**
 * Smoke check plus its Evidence (one attempt). The caller decides the release status from the
 * returned outcome: only a supported pass is a deployment.
 */
export async function smokeRelease(
  env: Env,
  loaded: LoadedRelease,
  options: { injectedPath?: string; attempt: number },
) {
  const startedAt = new Date().toISOString();
  const url = loaded.target?.url;
  // Live apps get generic probes from their own route table; the dev Workers Builds target is
  // the Acme Shop, which also keeps its products API probe.
  const probes = smokeProbes(
    {
      ...(await routeTable(env, loaded.release.candidate_id)),
      fixed: loaded.app ? [] : ACME_SHOP_LIVE_PROBES,
    },
    options.injectedPath,
  );
  // A live app is probed through the apps router (no public route needed); else the release URL.
  const results = loaded.app
    ? await probeApp(env, loaded.app.label, probes)
    : url
      ? await runProbes(url, probes)
      : [];
  const outcome = classifySmoke(results);
  const record = await recordReleaseEvidence(env, loaded, {
    outcome,
    results,
    startedAt,
    injected: !!options.injectedPath,
    attempt: options.attempt,
  });
  return { outcome, record, passed: smokePassed(outcome) };
}

/* ------------------------------------------------------------------------------------------ */
/* Failure injection (P13-12)                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** A path the release app never serves. The probe expects it to exist, so it honestly fails. */
const INJECTED_PATH = "/__rhumbatron/injected-missing-route";

/**
 * Records a real smoke failure on the Project's latest deployed release: the normal smoke probes
 * plus one probe of a route that does not exist, against the live release URL. Same failure path
 * as a real smoke failure (`smoke_failed`, `release.smoke_failed`, Evidence), marked injected.
 * The Canonical Generation does not change; recovery is the next promotion (section 42.10).
 */
export async function injectReleaseFailure(
  env: Env,
  input: { projectId: string; actorUserId: string },
): Promise<ReleaseInjectionOutcome> {
  const target = await loadTarget(env, input.projectId);
  if (!target) {
    return {
      status: "refused",
      reason: "no_target",
      detail: "This Project has no release target.",
    };
  }
  const latest = await env.DB.prepare(
    `SELECT id FROM releases WHERE project_id = ? AND status != 'superseded'
     ORDER BY generation DESC LIMIT 1`,
  )
    .bind(input.projectId)
    .first<{ id: string }>();
  const loaded = latest ? await loadRelease(env, latest.id) : null;
  if (!loaded) {
    return { status: "refused", reason: "no_release", detail: "No release exists yet." };
  }
  const { release } = loaded;
  const injectedCheck = releaseCheckId(release.generation, true);
  if (release.status === "smoke_failed" && release.evidence_id?.endsWith(injectedCheck)) {
    return { status: "recorded", release: toReleaseView(release, target), repeated: true };
  }
  if (release.status === "queued" || release.status === "building") {
    return {
      status: "refused",
      reason: "release_in_progress",
      detail: `Release of S${release.generation} is ${release.status}; inject after it finishes.`,
    };
  }
  if (release.status !== "deployed") {
    return {
      status: "refused",
      reason: "not_deployed",
      detail: `Release of S${release.generation} is ${release.status}; only a deployed release can fail its smoke check.`,
    };
  }
  const smoke = await smokeRelease(env, loaded, { injectedPath: INJECTED_PATH, attempt: 1 });
  if (smoke.passed) {
    return {
      status: "refused",
      reason: "probe_passed",
      detail: "Every probe passed, including the injected one; nothing was recorded as failed.",
    };
  }
  const reason = `Injected (P13-12): ${smoke.outcome.summary}`.slice(0, 500);
  await transitionRelease(
    env,
    loaded,
    "smoke_failed",
    {
      failureReason: reason,
      evidenceId: smoke.record.evidenceId,
      evidenceR2Key: smoke.record.r2Key ?? null,
    },
    [
      await releaseEvent(
        loaded,
        "release.smoke_failed",
        {
          status: "smoke_failed",
          reason,
          evidenceId: smoke.record.evidenceId,
          injected: true,
          requestedBy: input.actorUserId,
        },
        ":injected",
      ),
    ],
  );
  const after = await loadRelease(env, release.id);
  return {
    status: "recorded",
    release: toReleaseView(after?.release ?? release, target),
    repeated: false,
  };
}
