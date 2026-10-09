import { DurableObject } from "cloudflare:workers";
import { AnyEventEnvelope, type EventEnvelope, SemanticResource } from "@rhumbatron/protocol";
import {
  type AcquireRequest,
  type ClaimRecord,
  type ClaimStatus,
  contendedEventId,
  decideAcquire,
  decideRelease,
  decideRenew,
  findOverdue,
  type HeldBy,
  isValidTtl,
  MAX_TTL_MS,
  MIN_TTL_MS,
  nextAlarmAt,
} from "./claims.ts";
import {
  type ChallengeView,
  type CreateChallengeInput,
  type CreateChallengeResult,
  type DeclareIntentInput,
  type DeclareIntentResult,
  IntentStore,
  migrateIntents,
  type ResolveChallengeInput,
  type ResolveChallengeResult,
} from "./intents.ts";
import { migrateOutbox, OutboxPublisher } from "./outbox.ts";

/**
 * Owner of hot claim and lease state for one shard of semantic resources (AGENTS.md section 13.2).
 * One instance per shard key: `env.RESOURCE_SHARD.idFromName(shardKey(projectId, resource))`.
 * Leases are renewable and always expire. There is no permanent lock.
 */

export type Claim = {
  claimId: string;
  projectId: string;
  changeId: string;
  agentId: string;
  resource: string;
  /** Epoch milliseconds. */
  leaseExpiresAt: number;
  intentHash: string;
  /** Epoch milliseconds. */
  createdAt: number;
};

export type AcquireClaimInput = AcquireRequest;

/**
 * `held` is advisory (ADR 0015): the caller keeps working without the lease. The shard has already
 * written `claim.contended` in the same transaction as the decision.
 */
export type AcquireClaimResult =
  | { ok: true; claim: Claim }
  | { ok: false; reason: "held"; heldBy: HeldBy };

/**
 * One agent ran on a resource while another agent held its Claim (ADR 0015). The Change shard
 * stores these so conflict detection can see contention from either side of the pair.
 */
export type ClaimContention = {
  /** Qualified resource, for example `project:acme-shop:wishlist:membership`. */
  resource: string;
  /** The agent that asked for the Claim and ran without it. */
  agentId: string;
  holderAgentId: string;
  holderClaimId: string;
  holderChangeId: string;
};

export type RenewClaimInput = { claimId: string; agentId: string; ttlMs: number };

export type RenewClaimResult =
  | { ok: true; claimId: string; leaseExpiresAt: number }
  | { ok: false; reason: "not_found" | "not_owner" | "expired" };

export type ReleaseClaimInput = { claimId: string; agentId: string };

export type ReleaseClaimResult = { ok: true } | { ok: false; reason: "not_found" | "not_owner" };

type ClaimEventType =
  | "claim.acquired"
  | "claim.renewed"
  | "claim.released"
  | "claim.expired"
  | "claim.contended";

type ClaimRow = {
  claim_id: string;
  project_id: string;
  change_id: string;
  agent_id: string;
  resource: string;
  lease_expires_at: number;
  intent_hash: string;
  created_at: number;
  status: ClaimStatus;
};

/** Finished claim rows stay this long so a repeated release stays a no-op success. */
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Contention rows feed conflict detection of a running Change; a week covers any demo Change. */
const CONTENTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type ContentionRow = {
  resource: string;
  agent_id: string;
  holder_agent_id: string;
  holder_claim_id: string;
  holder_change_id: string;
};

const SYSTEM_ACTOR_ID = "resource-shard-do";

export class ResourceShardDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly outbox: OutboxPublisher;
  private readonly intents: IntentStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.outbox = new OutboxPublisher(this.sql, env);
    this.intents = new IntentStore(this.sql);
    // Schema setup runs before any request reaches this instance.
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        claim_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        change_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        intent_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
        ended_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS claims_one_active_per_resource
        ON claims (project_id, resource) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS claims_status_expiry ON claims (status, lease_expires_at);
      CREATE TABLE IF NOT EXISTS claim_contentions (
        change_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        holder_agent_id TEXT NOT NULL,
        holder_claim_id TEXT NOT NULL,
        holder_change_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        PRIMARY KEY (change_id, resource, agent_id, holder_agent_id)
      );
    `);
    migrateOutbox(this.sql);
    migrateIntents(this.sql);
  }

  /**
   * Grants the lease on a free resource. The same agent and change asking again gets the existing
   * claim, renewed. Any other agent gets `held` until the lease ends, and the shard writes one
   * `claim.contended` per holder Claim and contender in the same transaction (ADR 0015).
   * Throws when `ttlMs` or `resource` is invalid.
   */
  async acquireClaim(input: AcquireClaimInput): Promise<AcquireClaimResult> {
    SemanticResource.parse(input.resource);
    this.assertTtl(input.ttlMs);

    const now = Date.now();
    const result = this.ctx.storage.transactionSync((): AcquireClaimResult => {
      this.expireOverdue(now);
      const holder = this.activeClaimFor(input.projectId, input.resource);
      const decision = decideAcquire(holder, input, now);

      if (decision.kind === "held" && holder !== null) {
        // Advisory lease: the contention is a fact, never a block. A repeat ask is a no-op insert.
        this.enqueue("claim.contended", holder, { kind: "agent", id: input.agentId }, now, {
          eventId: contendedEventId(decision.heldBy.claimId, input.agentId, input.changeId),
          changeId: input.changeId,
          payload: {
            claimId: decision.heldBy.claimId,
            agentId: input.agentId,
            intentHash: input.intentHash,
            leaseExpiresAt: new Date(decision.heldBy.leaseExpiresAt).toISOString(),
            heldByAgentId: decision.heldBy.agentId,
            heldByChangeId: decision.heldBy.changeId,
          },
        });
        return { ok: false, reason: "held", heldBy: decision.heldBy };
      }

      if (decision.kind === "held") throw new Error("held decision without a holder");

      if (decision.kind === "renew_existing") {
        this.sql.exec(
          "UPDATE claims SET lease_expires_at = ?, intent_hash = ? WHERE claim_id = ?",
          decision.leaseExpiresAt,
          input.intentHash,
          decision.claimId,
        );
        const renewed = this.requireClaim(decision.claimId);
        this.enqueue("claim.renewed", renewed, { kind: "agent", id: renewed.agentId }, now);
        return { ok: true, claim: toClaim(renewed) };
      }

      const claimId = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO claims (claim_id, project_id, change_id, agent_id, resource,
           lease_expires_at, intent_hash, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        claimId,
        input.projectId,
        input.changeId,
        input.agentId,
        input.resource,
        decision.leaseExpiresAt,
        input.intentHash,
        now,
      );
      const created = this.requireClaim(claimId);
      this.enqueue("claim.acquired", created, { kind: "agent", id: created.agentId }, now);
      return { ok: true, claim: toClaim(created) };
    });

    await this.rescheduleAlarm();
    return result;
  }

  /** Extends the lease to `now + ttlMs`. Only the owning agent can renew a live claim. */
  async renewClaim(input: RenewClaimInput): Promise<RenewClaimResult> {
    this.assertTtl(input.ttlMs);

    const now = Date.now();
    const result = this.ctx.storage.transactionSync((): RenewClaimResult => {
      this.expireOverdue(now);
      const claim = this.getClaim(input.claimId);
      const decision = decideRenew(claim, input.agentId, input.ttlMs, now);
      if (decision.kind === "rejected" || claim === null) {
        return { ok: false, reason: decision.kind === "rejected" ? decision.reason : "not_found" };
      }
      this.sql.exec(
        "UPDATE claims SET lease_expires_at = ? WHERE claim_id = ?",
        decision.leaseExpiresAt,
        claim.claimId,
      );
      this.enqueue(
        "claim.renewed",
        this.requireClaim(claim.claimId),
        { kind: "agent", id: input.agentId },
        now,
      );
      return { ok: true, claimId: claim.claimId, leaseExpiresAt: decision.leaseExpiresAt };
    });

    await this.rescheduleAlarm();
    return result;
  }

  /** Releases a claim. Repeating the call, or releasing an expired claim, succeeds as a no-op. */
  async releaseClaim(input: ReleaseClaimInput): Promise<ReleaseClaimResult> {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync((): ReleaseClaimResult => {
      this.expireOverdue(now);
      const claim = this.getClaim(input.claimId);
      const decision = decideRelease(claim, input.agentId);
      if (decision.kind === "rejected") return { ok: false, reason: decision.reason };
      if (decision.kind === "release" && claim !== null) {
        this.sql.exec(
          "UPDATE claims SET status = 'released', ended_at = ? WHERE claim_id = ?",
          now,
          claim.claimId,
        );
        this.enqueue(
          "claim.released",
          this.requireClaim(claim.claimId),
          { kind: "agent", id: input.agentId },
          now,
        );
      }
      return { ok: true };
    });

    await this.rescheduleAlarm();
    return result;
  }

  /** Active claims (not expired, not released). Optionally filtered to one resource. */
  async listClaims(resource?: string): Promise<Claim[]> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => this.expireOverdue(now));
    await this.rescheduleAlarm();
    const rows =
      resource === undefined
        ? this.sql
            .exec<ClaimRow>("SELECT * FROM claims WHERE status = 'active' ORDER BY created_at")
            .toArray()
        : this.sql
            .exec<ClaimRow>(
              "SELECT * FROM claims WHERE status = 'active' AND resource = ? ORDER BY created_at",
              resource,
            )
            .toArray();
    return rows.map((r) => toClaim(fromRow(r)));
  }

  /**
   * Records a typed Intent (section 26.1) and writes `intent.declared` in the same transaction.
   * Idempotent on `intentId`: a retry returns `duplicate`; a reused ID with other content is
   * rejected. Throws when the input is invalid.
   */
  async declareIntent(
    input: DeclareIntentInput,
    contentions: readonly ClaimContention[] = [],
  ): Promise<DeclareIntentResult> {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const declared = this.intents.declare(input, now);
      // Contention the declaring run saw goes in with its Intent: no extra request (ADR 0015).
      if (declared.ok) this.recordContentions(input.changeId, contentions, now);
      return declared;
    });
    if (result.ok && result.status === "declared") await this.rescheduleAlarm();
    return result;
  }

  /**
   * Inputs of one Change's conflict pass in one request: every Intent on this shard (the caller
   * keeps its own Tasks) and the Claim contention recorded for the Change.
   */
  async detectionInputs(changeId: string) {
    const contentions = this.sql
      .exec<ContentionRow>(
        `SELECT resource, agent_id, holder_agent_id, holder_claim_id, holder_change_id
         FROM claim_contentions WHERE change_id = ? ORDER BY observed_at, resource`,
        changeId,
      )
      .toArray()
      .map(
        (r): ClaimContention => ({
          resource: r.resource,
          agentId: r.agent_id,
          holderAgentId: r.holder_agent_id,
          holderClaimId: r.holder_claim_id,
          holderChangeId: r.holder_change_id,
        }),
      );
    return { intents: await this.intents.list(), contentions };
  }

  /** Intents oldest first; with `resource`, those on it, its ancestors, or its descendants. */
  async listIntents(resource?: string) {
    return this.intents.list(resource);
  }

  /** Records a typed Challenge (section 26.2) and writes `challenge.created`. Idempotent on ID. */
  async createChallenge(input: CreateChallengeInput): Promise<CreateChallengeResult> {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => this.intents.createChallenge(input, now));
    if (result.ok && result.status === "created") await this.rescheduleAlarm();
    return result;
  }

  /** Resolves an open Challenge and writes `challenge.resolved`. Repeating it is a no-op. */
  async resolveChallenge(
    challengeId: string,
    resolution: ResolveChallengeInput["resolution"],
  ): Promise<ResolveChallengeResult> {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() =>
      this.intents.resolveChallenge({ challengeId, resolution }, now),
    );
    if (result.ok && result.status === "resolved") await this.rescheduleAlarm();
    return result;
  }

  /** Challenges oldest first, optionally on one exact resource, with their resolution. */
  async listChallenges(resource?: string): Promise<ChallengeView[]> {
    return this.intents.listChallenges(resource);
  }

  /** Expires overdue claims, prunes old finished rows, publishes the outbox, sets the next alarm. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.expireOverdue(now);
      this.sql.exec(
        "DELETE FROM claims WHERE status != 'active' AND ended_at IS NOT NULL AND ended_at < ?",
        now - TERMINAL_RETENTION_MS,
      );
      this.sql.exec(
        "DELETE FROM claim_contentions WHERE observed_at < ?",
        now - CONTENTION_RETENTION_MS,
      );
    });
    await this.outbox.publishAllDue(now);
    await this.rescheduleAlarm();
  }

  /**
   * Appends events that another component built, for example Work Graph events from ChangeWorkflow.
   * Idempotent on `eventId`, so a retried caller cannot publish an event twice.
   */
  async appendEvents(events: EventEnvelope[]): Promise<{ inserted: number }> {
    for (const event of events) AnyEventEnvelope.parse(event);
    const now = new Date().toISOString();
    const inserted = this.ctx.storage.transactionSync(() => {
      let count = 0;
      for (const event of events) {
        count += this.sql.exec(
          "INSERT OR IGNORE INTO outbox (event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
          event.eventId,
          event.eventType,
          JSON.stringify(event),
          now,
        ).rowsWritten;
      }
      return count;
    });
    if (inserted > 0) await this.rescheduleAlarm();
    return { inserted };
  }

  /** Unpublished outbox rows (pending or failed), oldest first. */
  async pendingOutbox(limit = 50) {
    return this.outbox.pending(limit);
  }

  private assertTtl(ttlMs: number) {
    if (!isValidTtl(ttlMs)) {
      throw new RangeError(`ttlMs must be an integer from ${MIN_TTL_MS} to ${MAX_TTL_MS}`);
    }
  }

  private getClaim(claimId: string): ClaimRecord | null {
    const row = this.sql
      .exec<ClaimRow>("SELECT * FROM claims WHERE claim_id = ?", claimId)
      .toArray()[0];
    return row ? fromRow(row) : null;
  }

  private requireClaim(claimId: string): ClaimRecord {
    const claim = this.getClaim(claimId);
    if (!claim) throw new Error(`Claim ${claimId} disappeared inside a transaction`);
    return claim;
  }

  private activeClaimFor(projectId: string, resource: string): ClaimRecord | null {
    const row = this.sql
      .exec<ClaimRow>(
        "SELECT * FROM claims WHERE project_id = ? AND resource = ? AND status = 'active'",
        projectId,
        resource,
      )
      .toArray()[0];
    return row ? fromRow(row) : null;
  }

  /**
   * Marks overdue claims expired and writes `claim.expired` to the outbox.
   * Call it inside a transaction so state and events commit together.
   */
  private expireOverdue(now: number) {
    const active = this.sql
      .exec<ClaimRow>("SELECT * FROM claims WHERE status = 'active' AND lease_expires_at <= ?", now)
      .toArray()
      .map(fromRow);
    for (const claim of findOverdue(active, now)) {
      this.sql.exec(
        "UPDATE claims SET status = 'expired', ended_at = ? WHERE claim_id = ?",
        now,
        claim.claimId,
      );
      this.enqueue("claim.expired", claim, { kind: "system", id: SYSTEM_ACTOR_ID }, now);
    }
  }

  /** Idempotent on (Change, resource, agent, holder). Call it inside a transaction. */
  private recordContentions(
    changeId: string,
    contentions: readonly ClaimContention[],
    now: number,
  ) {
    for (const c of contentions.slice(0, 50)) {
      SemanticResource.parse(c.resource);
      this.sql.exec(
        `INSERT OR IGNORE INTO claim_contentions (change_id, resource, agent_id, holder_agent_id,
           holder_claim_id, holder_change_id, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        changeId,
        c.resource,
        c.agentId,
        c.holderAgentId,
        c.holderClaimId,
        c.holderChangeId,
        now,
      );
    }
  }

  private async rescheduleAlarm() {
    const active = this.sql
      .exec<ClaimRow>("SELECT * FROM claims WHERE status = 'active'")
      .toArray()
      .map(fromRow);
    // One alarm serves both lease expiry and outbox publishing: take the earlier of the two.
    const candidates = [nextAlarmAt(active), this.outbox.nextDueAt()].filter(
      (t): t is number => t !== null,
    );
    if (candidates.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), Date.now()));
  }

  /**
   * Writes one claim event to the outbox. Call it in the same transaction as the state change.
   * `override` sets a stable event ID, the Change, and the payload for `claim.contended`, whose
   * subject is the requester, not the holder Claim. A stable ID that is already present is ignored.
   */
  private enqueue(
    eventType: ClaimEventType,
    claim: ClaimRecord,
    actor: { kind: "agent" | "system"; id: string },
    now: number,
    override?: { eventId: string; changeId: string; payload: Record<string, string> },
  ) {
    const timestamp = new Date(now).toISOString();
    const event: EventEnvelope<Record<string, string>> = {
      eventId: override?.eventId ?? crypto.randomUUID(),
      eventType,
      eventVersion: 1,
      // The tenant is not known to the shard yet. Use the project ID until auth adds an org ID.
      tenantId: claim.projectId,
      projectId: claim.projectId,
      changeId: override?.changeId ?? claim.changeId,
      actor,
      resource: claim.resource,
      // Filled from ProjectRootDO once the shard reads the Canonical Generation.
      canonicalGeneration: 0,
      correlationId: claim.claimId,
      timestamp,
      payload: override?.payload ?? {
        claimId: claim.claimId,
        agentId: claim.agentId,
        intentHash: claim.intentHash,
        leaseExpiresAt: new Date(claim.leaseExpiresAt).toISOString(),
      },
    };
    AnyEventEnvelope.parse(event);
    this.sql.exec(
      "INSERT OR IGNORE INTO outbox (event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
      event.eventId,
      event.eventType,
      JSON.stringify(event),
      timestamp,
    );
  }
}

function fromRow(row: ClaimRow): ClaimRecord {
  return {
    claimId: row.claim_id,
    projectId: row.project_id,
    changeId: row.change_id,
    agentId: row.agent_id,
    resource: row.resource,
    leaseExpiresAt: row.lease_expires_at,
    intentHash: row.intent_hash,
    createdAt: row.created_at,
    status: row.status,
  };
}

function toClaim(c: ClaimRecord): Claim {
  return {
    claimId: c.claimId,
    projectId: c.projectId,
    changeId: c.changeId,
    agentId: c.agentId,
    resource: c.resource,
    leaseExpiresAt: c.leaseExpiresAt,
    intentHash: c.intentHash,
    createdAt: c.createdAt,
  };
}
