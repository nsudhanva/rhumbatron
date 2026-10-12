import { z } from "zod";
import { CanonicalGeneration, Id } from "./common.ts";

/**
 * Release of one promoted Canonical Generation (ADR 0020).
 * One release per Project and generation ("Release -> canonical generation").
 *
 *   queued -> building -> deployed
 *                      -> failed        (no bundle, or the production pointer did not move)
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
 * ReleaseWorkflow died. ReleaseWorkflow builds or copies a bundle, moves the pointer, and smokes the
 * app in a few minutes, so 45 minutes never cuts a live release short. The event router's
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
  versionId: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  /** Evidence ID of the smoke check (same Evidence model as Candidate checks). */
  evidenceId: z.string().nullable(),
  evidenceR2Key: z.string().nullable(),
});
export type ReleaseView = z.infer<typeof ReleaseView>;

/** `GET /v1/projects/:projectId/releases`. */
export const ProjectReleases = z.object({
  releases: z.array(ReleaseView),
});
export type ProjectReleases = z.infer<typeof ProjectReleases>;

/** `POST /v1/projects/:projectId/releases/inject-failure` (P13-12, fixture routes only). */
export const ReleaseInjectionOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("recorded"), release: ReleaseView, repeated: z.boolean() }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum(["no_app", "no_release", "release_in_progress", "not_deployed", "probe_passed"]),
    detail: z.string(),
  }),
]);
export type ReleaseInjectionOutcome = z.infer<typeof ReleaseInjectionOutcome>;
