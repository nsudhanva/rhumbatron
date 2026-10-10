import { z } from "zod";
import { CanonicalGeneration, Id } from "./common.ts";

/**
 * Release of one promoted Canonical Generation (AGENTS.md sections 21.3, 37, 42.10; ADR 0018).
 * One release per Project and generation (section 60: "Release -> canonical generation").
 *
 *   queued -> building -> deployed
 *                      -> failed        (no build, build failed, or deployment not confirmed)
 *                      -> smoke_failed  (deployed, but the smoke check did not pass)
 *   queued | building -> superseded     (a newer generation was promoted first)
 *
 * A failed release never deletes canonical history. Recovery is a new canonical transition.
 */
export const ReleaseStatus = z.enum([
  "queued",
  "building",
  "deployed",
  "failed",
  "smoke_failed",
  "superseded",
]);
export type ReleaseStatus = z.infer<typeof ReleaseStatus>;

/** Statuses after which nothing about the release changes, except injection (P13-12). */
export const FINAL_RELEASE_STATUSES: readonly ReleaseStatus[] = [
  "deployed",
  "failed",
  "smoke_failed",
  "superseded",
];

/**
 * A `releasing` Change whose release has not finished this long after promotion (or after its
 * release started, whichever is later) is stuck: its source sync or release start failed, or its
 * ReleaseWorkflow died. ReleaseWorkflow polls for at most 15 minutes, then confirms and smokes the
 * deployment in a few more, so 45 minutes never cuts a live release short. The event router's
 * sweep selects with it; the integration Worker re-checks it before it changes anything.
 */
export const RELEASE_STUCK_AFTER_MS = 45 * 60_000;

export const ReleaseView = z.object({
  id: Id,
  projectId: Id,
  changeId: Id,
  candidateId: Id,
  generation: CanonicalGeneration,
  commit: z.string(),
  status: ReleaseStatus,
  buildUuid: z.string().nullable(),
  versionId: z.string().nullable(),
  /** The release target URL (the Worker's workers.dev URL). */
  url: z.string().nullable(),
  workerName: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  /** Evidence ID of the smoke check (same Evidence model as Candidate checks). */
  evidenceId: z.string().nullable(),
  evidenceR2Key: z.string().nullable(),
});
export type ReleaseView = z.infer<typeof ReleaseView>;

export const ReleaseTargetView = z.object({
  projectId: Id,
  workerName: z.string(),
  url: z.string(),
});
export type ReleaseTargetView = z.infer<typeof ReleaseTargetView>;

/** `GET /v1/projects/:projectId/releases`. */
export const ProjectReleases = z.object({
  target: ReleaseTargetView.nullable(),
  releases: z.array(ReleaseView),
});
export type ProjectReleases = z.infer<typeof ProjectReleases>;

/** `POST /v1/projects/:projectId/releases/inject-failure` (P13-12, dev and demo only). */
export const ReleaseInjectionOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("recorded"), release: ReleaseView, repeated: z.boolean() }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum([
      "no_target",
      "no_release",
      "release_in_progress",
      "not_deployed",
      "probe_passed",
    ]),
    detail: z.string(),
  }),
]);
export type ReleaseInjectionOutcome = z.infer<typeof ReleaseInjectionOutcome>;
