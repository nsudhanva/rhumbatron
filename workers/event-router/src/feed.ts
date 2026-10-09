import type { EventEnvelope, FeedData } from "@rhumbatron/protocol";

/**
 * Event feed projection (`project_events`, migration 0010; AGENTS.md sections 16.1 and 39).
 * The projector writes these statements in the same D1 batch as its dedupe claims, so a batch
 * that fails leaves neither and redelivers. `event_id` is UNIQUE and every insert is
 * `INSERT OR IGNORE`, so a redelivered event never becomes a second row.
 * Only an allow-list of scalar payload fields is kept: never a full payload or reasoning.
 */

/** Global row cap. The writer deletes rows below `MAX(seq) - FEED_MAX_ROWS` by primary-key range. */
const FEED_MAX_ROWS = 20_000;

const MAX_TEXT = 200;

/** Payload fields the feed keeps when they are scalars. */
const KEEP = [
  "agentId",
  "approvalId",
  "attempt",
  "buildUuid",
  "candidateId",
  "challengeId",
  "changeSetId",
  "checkId",
  "claimId",
  "commit",
  "coverage",
  "decidedBy",
  "evidenceId",
  "fork",
  "from",
  "fromGeneration",
  "generation",
  "injected",
  "intentId",
  "key",
  "kind",
  "leaseExpiresAt",
  "policyVersion",
  "promotable",
  "reason",
  "releaseId",
  "resolution",
  "riskTier",
  "runId",
  "selectedTier",
  "status",
  "summary",
  "taskCount",
  "tier",
  "title",
  "to",
  "toGeneration",
  "url",
  "versionId",
] as const;

export type FeedRow = {
  eventId: string;
  eventType: string;
  eventVersion: number;
  projectId: string;
  changeId: string | null;
  taskId: string | null;
  candidateId: string | null;
  resource: string | null;
  actorKind: string;
  actorId: string;
  occurredAt: string;
  recordedAt: string;
  summary: string;
  data: FeedData;
};

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

function pickData(payload: unknown): FeedData {
  const data: FeedData = {};
  if (typeof payload !== "object" || payload === null) return data;
  const source = payload as Record<string, unknown>;
  for (const key of KEEP) {
    const value = source[key];
    if (typeof value === "string") data[key] = clip(value);
    else if (typeof value === "number" && Number.isFinite(value)) data[key] = value;
    else if (typeof value === "boolean") data[key] = value;
  }
  // `intent.declared` nests the typed Intent; keep only its one-line summary.
  const intent = source.intent;
  if (data.summary === undefined && typeof intent === "object" && intent !== null) {
    const summary = (intent as { summary?: unknown }).summary;
    if (typeof summary === "string") data.summary = clip(summary);
  }
  return data;
}

/** One plain sentence from the type, resource, and kept fields. */
function summarize(event: EventEnvelope, data: FeedData): string {
  const on = event.resource ? ` on ${event.resource}` : "";
  const s = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : undefined);
  switch (event.eventType) {
    case "claim.acquired":
    case "claim.renewed":
      return `${s("agentId") ?? event.actor.id} ${event.eventType === "claim.acquired" ? "claims" : "renews"}${on}${s("leaseExpiresAt") ? ` until ${s("leaseExpiresAt")}` : ""}`;
    case "claim.released":
      return `${s("agentId") ?? event.actor.id} releases${on}`;
    case "claim.expired":
      return `Claim of ${s("agentId") ?? "an agent"} expired${on}`;
    case "task.created":
      return `${["Task", s("key"), "created"].filter(Boolean).join(" ")}${s("title") ? `: ${s("title")}` : ""}`;
    case "model.route.decided":
      return `Routed to ${s("selectedTier") ?? "a model"} by ${s("decidedBy") ?? "rules"}`;
    case "agent.escalated":
      return `Escalated ${s("from") ?? "?"} → ${s("to") ?? "?"}${s("reason") ? `: ${s("reason")}` : ""}`;
    case "verification.check.completed":
      return `${s("checkId") ?? "check"}: ${s("status") ?? "done"}${s("summary") ? `. ${s("summary")}` : ""}`;
    case "verification.completed":
    case "candidate.stale":
      return `${s("candidateId") ?? "Candidate"} ${s("status") ?? event.eventType.split(".")[1]}${s("reason") ? `: ${s("reason")}` : ""}`;
    case "canonical.advanced":
      return `Canonical S${data.fromGeneration ?? "?"} → S${data.toGeneration ?? "?"}`;
    case "intent.declared":
      return `Intent declared${on}${s("summary") ? `: ${s("summary")}` : ""}`;
    // Release path (ADR 0018).
    case "build.started":
      return `Release of S${data.generation ?? "?"}: Workers Build started`;
    case "build.completed":
      return `Release of S${data.generation ?? "?"}: build ${s("status") ?? "finished"}${s("buildUuid") ? ` (${s("buildUuid")?.slice(0, 8)})` : ""}`;
    case "deployment.completed":
      return `Deployed S${data.generation ?? "?"}${s("versionId") ? ` as version ${s("versionId")?.slice(0, 8)}` : ""}`;
    case "deployment.failed":
      return `Release of S${data.generation ?? "?"} did not deploy${s("reason") ? `: ${s("reason")}` : ""}`;
    case "release.smoke_failed":
      return `Release of S${data.generation ?? "?"} failed its smoke check${data.injected === true ? " (injected)" : ""}${s("reason") ? `: ${s("reason")}` : ""}`;
    default:
      return `${event.eventType}${on}${s("reason") ? `: ${s("reason")}` : ""}`;
  }
}

/** Pure mapping from one envelope to its feed row. */
export function feedRow(event: EventEnvelope, recordedAt: string): FeedRow {
  const data = pickData(event.payload);
  const candidateId = typeof data.candidateId === "string" ? data.candidateId : null;
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    projectId: event.projectId,
    changeId: event.changeId ?? null,
    taskId: event.taskId ?? null,
    candidateId,
    resource: event.resource ?? null,
    actorKind: event.actor.kind,
    actorId: event.actor.id,
    occurredAt: new Date(event.timestamp).toISOString(),
    recordedAt,
    summary: clip(summarize(event, data)),
    data,
  };
}

/**
 * Insert statements in event time order (so `seq` follows time within a batch), then one
 * retention delete. The delete reads one row for MAX(seq) plus only the rows it removes.
 */
export function feedStatements(
  db: D1Database,
  events: readonly EventEnvelope[],
  now: Date = new Date(),
  maxRows: number = FEED_MAX_ROWS,
): D1PreparedStatement[] {
  if (events.length === 0) return [];
  const recordedAt = now.toISOString();
  const ordered = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const inserts = ordered.map((event) => {
    const row = feedRow(event, recordedAt);
    return db
      .prepare(
        `INSERT OR IGNORE INTO project_events (event_id, event_type, event_version, project_id, change_id,
           task_id, candidate_id, resource, actor_kind, actor_id, occurred_at, recorded_at, summary, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.eventId,
        row.eventType,
        row.eventVersion,
        row.projectId,
        row.changeId,
        row.taskId,
        row.candidateId,
        row.resource,
        row.actorKind,
        row.actorId,
        row.occurredAt,
        row.recordedAt,
        row.summary,
        JSON.stringify(row.data),
      );
  });
  const retention = db
    .prepare("DELETE FROM project_events WHERE seq <= (SELECT MAX(seq) FROM project_events) - ?")
    .bind(maxRows);
  return [...inserts, retention];
}
