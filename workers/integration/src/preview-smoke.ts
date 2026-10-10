import { previewChannel, previewIdFor } from "@rhumbatron/protocol";
import { type PreviewOutcome, probeApp } from "./app-release.ts";
import { routeTable } from "./release.ts";
import {
  classifySmoke,
  type ProbeResult,
  type SmokeOutcome,
  smokeProbes,
} from "./release-model.ts";

/** Release probes on the exact Candidate preview, never the production host or DATA store. */
export async function runPreviewSmoke(
  env: Env,
  input: {
    projectId: string;
    candidateId: string;
    commit: string;
    publication: PreviewOutcome | { status: "skipped" | "error"; reason?: string };
  },
): Promise<{ outcome: SmokeOutcome; results: ProbeResult[] }> {
  const gap = (reason: string) => ({
    outcome: {
      status: "error" as const,
      coverage: "not_checked" as const,
      summary: `Preview check could not run: ${reason}`.slice(0, 500),
    },
    results: [],
  });
  if (!env.APPS) return gap("live apps are disabled.");
  if (!["ready", "current"].includes(input.publication.status)) {
    return gap(
      "reason" in input.publication
        ? (input.publication.reason ?? input.publication.status)
        : `preview publication is ${input.publication.status}.`,
    );
  }
  const previewId = previewIdFor(input.candidateId);
  const row = await env.DB.prepare(
    `SELECT slug FROM app_deployments WHERE project_id = ? AND channel = ?
     AND candidate_id = ? AND commit_sha = ? AND status = 'ready' AND bundle_key IS NOT NULL`,
  )
    .bind(input.projectId, previewChannel(previewId), input.candidateId, input.commit)
    .first<{ slug: string }>();
  if (!row) return gap("the Candidate preview is unavailable or does not serve its commit.");
  const table = await routeTable(env, input.candidateId);
  if (!table.routes) return gap("the Candidate contract route table is unavailable.");
  const results = await probeApp(env, row.slug, smokeProbes(table), previewId);
  const outcome = classifySmoke(results);
  const failed = results.find((result) => result.status !== null && !result.ok);
  if (failed) {
    outcome.summary = `Preview check failed: GET ${failed.probe.path} returned ${failed.status}${
      failed.detail === String(failed.status) ? "" : ` (${failed.detail})`
    }.`.slice(0, 500);
  } else if (outcome.coverage === "not_checked") {
    outcome.summary = `Preview check could not run: ${outcome.summary}`;
  } else {
    outcome.summary = `Preview check passed: ${results.length} GET probes answered as expected.`;
  }
  return { outcome, results };
}
