import type {
  EventEnvelope,
  EvidenceRecord,
  ReleaseInjectionOutcome,
  ReleaseStatus,
  ReleaseView,
} from "@rhumbatron/protocol";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import {
  addedRoutesFromContract,
  classifySmoke,
  fromStatuses,
  type ProbeResult,
  releaseCheckId,
  releaseIdFor,
  runProbes,
  type SmokeOutcome,
  smokePassed,
  smokeProbes,
} from "./release-model.ts";

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

export async function loadRelease(env: Env, releaseId: string): Promise<LoadedRelease | null> {
  const release = await env.DB.prepare("SELECT * FROM releases WHERE id = ?")
    .bind(releaseId)
    .first<ReleaseRow>();
  if (!release) return null;
  const [target, project] = await Promise.all([
    loadTarget(env, release.project_id),
    env.DB.prepare("SELECT org_id, slug FROM projects WHERE id = ?")
      .bind(release.project_id)
      .first<{ org_id: string; slug: string }>(),
  ]);
  if (!project) return null;
  return {
    release,
    target,
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
    const target = await loadTarget(env, input.projectId);
    if (!target) return null;
    const releaseId = releaseIdFor(input.projectId, input.generation);
    const now = new Date().toISOString();
    await env.DB.batch([
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
    ]);
    try {
      await env.RELEASE_WORKFLOW.create({ id: releaseId, params: { releaseId } });
    } catch (error) {
      // Already started by an earlier promotion attempt: nothing to do.
      const existing = await env.RELEASE_WORKFLOW.get(releaseId).catch(() => null);
      if (!existing) throw error;
    }
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
  if (status === to && events.length > 0) {
    await appendChangeEvents(env.RESOURCE_SHARD, loaded.ctx, events);
  }
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

/** Routes the promoted Candidate added, from its contract Evidence. Empty when there is none. */
async function addedRoutes(env: Env, candidateId: string): Promise<string[]> {
  const row = await env.DB.prepare(
    `SELECT r2_key FROM evidence_index WHERE candidate_id = ? AND kind = 'contract'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(candidateId)
    .first<{ r2_key: string | null }>();
  if (!row?.r2_key) return [];
  const stdout = await env.EVIDENCE.get(row.r2_key.replace(/report\.json$/, "stdout.txt"));
  return stdout ? addedRoutesFromContract(await stdout.text()) : [];
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
    `target ${loaded.target?.url ?? "none"} · build ${release.build_uuid ?? "none"} · version ${release.version_id ?? "none"}`,
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
      ...(release.version_id ? [`worker-version://${release.version_id}`] : []),
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
  const probes = smokeProbes(
    await addedRoutes(env, loaded.release.candidate_id),
    options.injectedPath,
  );
  const results = url ? await runProbes(url, probes) : [];
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
