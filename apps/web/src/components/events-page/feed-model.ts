import type { FeedEvent, FeedPage } from "../../lib/api";

/**
 * Client model of the event feed (`GET /v1/projects/:projectId/events`,
 * `GET /v1/changes/:changeId/events`; types in lib/api.ts, mirroring `FeedEvent` and `FeedPage`
 * in packages/protocol/src/activity.ts). The feed is an eventually consistent projection:
 * never base a release decision on it.
 */

export type { FeedEvent, FeedPage };

/** Page size the API caps at (`FEED_MAX_LIMIT`). */
export const FEED_PAGE_LIMIT = 100;
/** First page: enough to fill the stream without paging. */
export const FEED_FIRST_LIMIT = 50;

/**
 * Type color role: failure in danger, completion in success, state-changing
 * commits in brand, everything else default. Status words in the kept payload refine the two
 * generic completion types, so a failed check never reads as a success.
 */
export type TypeTone = "danger" | "success" | "brand" | "default";

const FAILURE_STATUS = new Set(["fail", "failed", "error", "rejected", "blocked", "timed_out"]);
const BRAND_TYPES = new Set(["canonical.advanced", "artifact.promoted"]);
const SUCCESS_TYPES = new Set([
  "approval.granted",
  "changeset.accepted",
  "challenge.resolved",
  "preview.ready",
]);

export function typeTone(event: Pick<FeedEvent, "eventType" | "data">): TypeTone {
  const type = event.eventType;
  const status = typeof event.data.status === "string" ? event.data.status.toLowerCase() : "";
  if (BRAND_TYPES.has(type)) return "brand";
  if (type.endsWith(".failed") || type.endsWith(".rejected")) return "danger";
  if (type === "claim.expired" || type === "candidate.stale") return "danger";
  if (FAILURE_STATUS.has(status)) return "danger";
  if (type.endsWith(".completed") || SUCCESS_TYPES.has(type)) return "success";
  return "default";
}

export const TONE_TEXT: Record<TypeTone, string> = {
  danger: "text-kumo-danger",
  success: "text-kumo-success",
  // Brand text at body size uses accent-700 (`text-kumo-accent`), never accent-500.
  brand: "text-kumo-accent",
  default: "text-kumo-default",
};

/** Merges pages into one newest-first list without duplicates. */
export function mergeEvents(current: readonly FeedEvent[], incoming: readonly FeedEvent[]) {
  if (incoming.length === 0) return current as FeedEvent[];
  const bySeq = new Map<number, FeedEvent>();
  for (const event of current) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
}

/** Milliseconds from the fact to its feed row: outbox publish, K2 delivery, projector write. */
export function ingestLagMs(event: Pick<FeedEvent, "occurredAt" | "recordedAt">) {
  const lag = Date.parse(event.recordedAt) - Date.parse(event.occurredAt);
  return Number.isFinite(lag) ? Math.max(0, lag) : null;
}

/*
 * K2 stream shard of a Project. Same rule as `streamIndex` in
 * workers/coordinator/src/outbox.ts (FNV-1a 32 over UTF-8, modulo 8): keep them in step.
 */
const K2_STREAM_COUNT = 8;

function fnv1a32(input: string) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function k2StreamName(projectId: string) {
  const index = fnv1a32(projectId) % K2_STREAM_COUNT;
  return `rhumbatron-events-${String(index).padStart(2, "0")}`;
}

/** Nearest-rank percentile of a list of numbers. Null for an empty list. */
export function percentile(values: readonly number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}
