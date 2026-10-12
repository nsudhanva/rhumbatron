/**
 * Intents and Challenges owned by a ResourceShardDO.
 * Every write is idempotent on its ID and inserts its event into the outbox in the caller's
 * transaction, so state and event commit together. The store takes SqlStorage, so it runs on
 * node:sqlite in critical tests.
 */
import {
  AnyEventEnvelope,
  CanonicalGeneration,
  Challenge,
  ChallengeResolution,
  type EventEnvelope,
  Id,
  Intent,
  RelativeResource,
  SemanticResource,
  Slug,
} from "@rhumbatron/protocol";
import { z } from "zod";

const Scope = {
  projectId: Id,
  changeId: Id,
  /** Turns plan-relative resources into `project:<slug>:<resource>` on the event envelope. */
  projectSlug: Slug.optional(),
  /** Filled by the caller until the shard reads the Canonical Generation itself. */
  canonicalGeneration: CanonicalGeneration.optional(),
};

export const DeclareIntentInput = z.object({ ...Scope, intent: Intent });
export type DeclareIntentInput = z.infer<typeof DeclareIntentInput>;

export const CreateChallengeInput = z.object({ ...Scope, challenge: Challenge });
export type CreateChallengeInput = z.infer<typeof CreateChallengeInput>;

export const ResolveChallengeInput = z.object({
  challengeId: Id,
  resolution: ChallengeResolution,
});
export type ResolveChallengeInput = z.infer<typeof ResolveChallengeInput>;

/** `duplicate` is a retry with identical content. A reused ID with other content is rejected. */
export type DeclareIntentResult =
  | { ok: true; status: "declared" | "duplicate"; intent: Intent }
  | { ok: false; reason: "id_reused" };

export type CreateChallengeResult =
  | { ok: true; status: "created" | "duplicate"; challenge: Challenge }
  | { ok: false; reason: "id_reused" };

export type ResolveChallengeResult =
  | { ok: true; status: "resolved" | "duplicate" }
  | { ok: false; reason: "not_found" | "already_resolved" };

export type ChallengeView = {
  challenge: Challenge;
  status: "open" | "resolved";
  resolution: ChallengeResolution | null;
};

type IntentRow = { intent_json: string };
type ChallengeRow = {
  challenge_id: string;
  project_id: string;
  change_id: string;
  semantic_resource: string;
  challenge_json: string;
  status: "open" | "resolved";
  resolution_json: string | null;
  project_slug: string | null;
  canonical_generation: number;
};

export function migrateIntents(sql: SqlStorage) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS intents (
      intent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS intent_resources (
      intent_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      PRIMARY KEY (intent_id, resource)
    );
    CREATE INDEX IF NOT EXISTS intent_resources_resource ON intent_resources (resource);
    CREATE TABLE IF NOT EXISTS challenges (
      challenge_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      project_slug TEXT,
      canonical_generation INTEGER NOT NULL DEFAULT 0,
      semantic_resource TEXT NOT NULL,
      kind TEXT NOT NULL,
      challenge_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      resolution_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS challenges_resource ON challenges (semantic_resource, status);
  `);
}

const PROJECT_PREFIX = /^project:[a-z0-9-]+:/;

/** Stored resource key: plan-relative, so relative and absolute inputs match each other. */
function relative(resource: string): string {
  return resource.replace(PROJECT_PREFIX, "");
}

/** Envelope resource: absolute when possible; omitted when it cannot be a SemanticResource. */
function envelopeResource(resource: string | undefined, slug: string | null | undefined) {
  if (resource === undefined) return undefined;
  const absolute = resource.startsWith("project:")
    ? resource
    : slug
      ? `project:${slug}:${resource}`
      : resource;
  return SemanticResource.safeParse(absolute).success ? absolute : undefined;
}

export class IntentStore {
  constructor(private readonly sql: SqlStorage) {}

  /** Records the Intent and `intent.declared`. Call inside a transaction. Throws on invalid input. */
  declare(raw: DeclareIntentInput, now: number): DeclareIntentResult {
    const input = DeclareIntentInput.parse(raw);
    const { intent } = input;
    const json = JSON.stringify(intent);
    const existing = this.sql
      .exec<IntentRow>("SELECT intent_json FROM intents WHERE intent_id = ?", intent.intentId)
      .toArray()[0];
    if (existing) {
      return existing.intent_json === json
        ? { ok: true, status: "duplicate", intent }
        : { ok: false, reason: "id_reused" };
    }
    const timestamp = new Date(now).toISOString();
    this.sql.exec(
      `INSERT INTO intents (intent_id, project_id, change_id, task_id, agent_id, intent_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      intent.intentId,
      input.projectId,
      input.changeId,
      intent.taskId,
      intent.agentId,
      json,
      timestamp,
    );
    for (const resource of new Set(intent.semanticResources.map(relative))) {
      this.sql.exec(
        "INSERT OR IGNORE INTO intent_resources (intent_id, resource) VALUES (?, ?)",
        intent.intentId,
        resource,
      );
    }
    this.enqueue({
      eventType: "intent.declared",
      projectId: input.projectId,
      changeId: input.changeId,
      taskId: intent.taskId,
      actor: { kind: "agent", id: intent.agentId },
      resource: envelopeResource(intent.semanticResources[0], input.projectSlug),
      canonicalGeneration: input.canonicalGeneration ?? 0,
      correlationId: intent.intentId,
      timestamp,
      payload: { intentId: intent.intentId, intent },
    });
    return { ok: true, status: "declared", intent };
  }

  /**
   * Intents oldest first. With `resource`, only Intents on that resource, an ancestor, or a
   * descendant (colon-segment prefix in either direction).
   */
  list(resource?: string): Intent[] {
    const key = resource === undefined ? undefined : relative(RelativeResource.parse(resource));
    const rows =
      key === undefined
        ? this.sql
            .exec<IntentRow>("SELECT intent_json FROM intents ORDER BY created_at, intent_id")
            .toArray()
        : this.sql
            .exec<IntentRow>(
              // Resource keys are kebab-case and colons only, so LIKE needs no escaping.
              `SELECT intent_json FROM intents WHERE intent_id IN (
                 SELECT intent_id FROM intent_resources
                 WHERE resource = ? OR resource LIKE ? || ':%' OR ? LIKE resource || ':%'
               ) ORDER BY created_at, intent_id`,
              key,
              key,
              key,
            )
            .toArray();
    return rows.map((r) => Intent.parse(JSON.parse(r.intent_json)));
  }

  /** Records the Challenge and `challenge.created`. Call inside a transaction. */
  createChallenge(raw: CreateChallengeInput, now: number): CreateChallengeResult {
    const input = CreateChallengeInput.parse(raw);
    const { challenge } = input;
    const json = JSON.stringify(challenge);
    const existing = this.getChallenge(challenge.challengeId);
    if (existing) {
      return existing.challenge_json === json
        ? { ok: true, status: "duplicate", challenge }
        : { ok: false, reason: "id_reused" };
    }
    const timestamp = new Date(now).toISOString();
    this.sql.exec(
      `INSERT INTO challenges (challenge_id, project_id, change_id, project_slug, canonical_generation,
         semantic_resource, kind, challenge_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      challenge.challengeId,
      input.projectId,
      input.changeId,
      input.projectSlug ?? null,
      input.canonicalGeneration ?? 0,
      relative(challenge.semanticResource),
      challenge.kind,
      json,
      timestamp,
    );
    this.enqueue({
      eventType: "challenge.created",
      projectId: input.projectId,
      changeId: input.changeId,
      actor: { kind: "agent", id: challenge.sourceAgentId },
      resource: envelopeResource(challenge.semanticResource, input.projectSlug),
      canonicalGeneration: input.canonicalGeneration ?? 0,
      correlationId: challenge.challengeId,
      timestamp,
      payload: { challengeId: challenge.challengeId, challenge },
    });
    return { ok: true, status: "created", challenge };
  }

  /**
   * Resolves an open Challenge and records `challenge.resolved`. Repeating the same resolution is
   * a no-op success; a different resolution of a resolved Challenge is rejected.
   */
  resolveChallenge(raw: ResolveChallengeInput, now: number): ResolveChallengeResult {
    const input = ResolveChallengeInput.parse(raw);
    const row = this.getChallenge(input.challengeId);
    if (!row) return { ok: false, reason: "not_found" };
    const json = JSON.stringify(input.resolution);
    if (row.status === "resolved") {
      return row.resolution_json === json
        ? { ok: true, status: "duplicate" }
        : { ok: false, reason: "already_resolved" };
    }
    const timestamp = new Date(now).toISOString();
    this.sql.exec(
      "UPDATE challenges SET status = 'resolved', resolution_json = ?, resolved_at = ? WHERE challenge_id = ?",
      json,
      timestamp,
      row.challenge_id,
    );
    this.enqueue({
      eventType: "challenge.resolved",
      projectId: row.project_id,
      changeId: row.change_id,
      actor: input.resolution.resolvedBy,
      resource: envelopeResource(row.semantic_resource, row.project_slug),
      canonicalGeneration: row.canonical_generation,
      correlationId: row.challenge_id,
      timestamp,
      payload: { challengeId: row.challenge_id, resolution: input.resolution },
    });
    return { ok: true, status: "resolved" };
  }

  /** Challenges oldest first, optionally on one exact resource. */
  listChallenges(resource?: string): ChallengeView[] {
    const rows =
      resource === undefined
        ? this.sql.exec<ChallengeRow>("SELECT * FROM challenges ORDER BY created_at").toArray()
        : this.sql
            .exec<ChallengeRow>(
              "SELECT * FROM challenges WHERE semantic_resource = ? ORDER BY created_at",
              relative(RelativeResource.parse(resource)),
            )
            .toArray();
    return rows.map((r) => ({
      challenge: Challenge.parse(JSON.parse(r.challenge_json)),
      status: r.status,
      resolution:
        r.resolution_json === null
          ? null
          : ChallengeResolution.parse(JSON.parse(r.resolution_json)),
    }));
  }

  private getChallenge(challengeId: string): ChallengeRow | undefined {
    return this.sql
      .exec<ChallengeRow>("SELECT * FROM challenges WHERE challenge_id = ?", challengeId)
      .toArray()[0];
  }

  /** Writes one event to the outbox. The caller's transaction commits it with the state change. */
  private enqueue(
    fields: Omit<EventEnvelope, "eventId" | "eventVersion" | "tenantId" | "resource"> & {
      resource: string | undefined;
    },
  ) {
    const { resource, ...rest } = fields;
    const event: EventEnvelope = {
      ...rest,
      eventId: crypto.randomUUID(),
      eventVersion: 1,
      // The tenant is not known to the shard yet. Use the project ID until auth adds an org ID.
      tenantId: fields.projectId,
      ...(resource === undefined ? {} : { resource }),
    };
    AnyEventEnvelope.parse(event);
    this.sql.exec(
      "INSERT INTO outbox (event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
      event.eventId,
      event.eventType,
      JSON.stringify(event),
      event.timestamp,
    );
  }
}
