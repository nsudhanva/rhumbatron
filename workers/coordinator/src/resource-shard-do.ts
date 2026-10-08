import { DurableObject } from "cloudflare:workers";
import { AnyEventEnvelope, type EventEnvelope, SemanticResource } from "@rhumbatron/protocol";
import {
  type AcquireRequest,
  type ClaimRecord,
  type ClaimStatus,
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

export type AcquireClaimResult =
  | { ok: true; claim: Claim }
  | { ok: false; reason: "held"; heldBy: HeldBy };

export type RenewClaimInput = { claimId: string; agentId: string; ttlMs: number };

export type RenewClaimResult =
  | { ok: true; claimId: string; leaseExpiresAt: number }
  | { ok: false; reason: "not_found" | "not_owner" | "expired" };

export type ReleaseClaimInput = { claimId: string; agentId: string };

export type ReleaseClaimResult = { ok: true } | { ok: false; reason: "not_found" | "not_owner" };

type ClaimEventType = "claim.acquired" | "claim.renewed" | "claim.released" | "claim.expired";

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

const SYSTEM_ACTOR_ID = "resource-shard-do";

export class ResourceShardDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly outbox: OutboxPublisher;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.outbox = new OutboxPublisher(this.sql, env);
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
    `);
    migrateOutbox(this.sql);
  }

  /**
   * Grants the lease on a free resource. The same agent and change asking again gets the existing
   * claim, renewed. Any other agent gets `held` until the lease ends.
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

      if (decision.kind === "held") {
        return { ok: false, reason: "held", heldBy: decision.heldBy };
      }

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

  /** Expires overdue claims, prunes old finished rows, publishes the outbox, sets the next alarm. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.expireOverdue(now);
      this.sql.exec(
        "DELETE FROM claims WHERE status != 'active' AND ended_at IS NOT NULL AND ended_at < ?",
        now - TERMINAL_RETENTION_MS,
      );
    });
    await this.outbox.publishAllDue(now);
    await this.rescheduleAlarm();
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

  /** Writes one claim event to the outbox. Call it in the same transaction as the state change. */
  private enqueue(
    eventType: ClaimEventType,
    claim: ClaimRecord,
    actor: { kind: "agent" | "system"; id: string },
    now: number,
  ) {
    const timestamp = new Date(now).toISOString();
    const event: EventEnvelope<{
      claimId: string;
      agentId: string;
      intentHash: string;
      leaseExpiresAt: string;
    }> = {
      eventId: crypto.randomUUID(),
      eventType,
      eventVersion: 1,
      // The tenant is not known to the shard yet. Use the project ID until auth adds an org ID.
      tenantId: claim.projectId,
      projectId: claim.projectId,
      changeId: claim.changeId,
      actor,
      resource: claim.resource,
      // Filled from ProjectRootDO once the shard reads the Canonical Generation.
      canonicalGeneration: 0,
      correlationId: claim.claimId,
      timestamp,
      payload: {
        claimId: claim.claimId,
        agentId: claim.agentId,
        intentHash: claim.intentHash,
        leaseExpiresAt: new Date(claim.leaseExpiresAt).toISOString(),
      },
    };
    AnyEventEnvelope.parse(event);
    this.sql.exec(
      "INSERT INTO outbox (event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
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
