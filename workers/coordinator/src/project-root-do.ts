import { DurableObject } from "cloudflare:workers";
import { AnyEventEnvelope, type EventEnvelope } from "@rhumbatron/protocol";
import { AlarmGuard } from "./alarm-guard.ts";
import { migrateOutbox, OutboxPublisher } from "./outbox.ts";
import {
  type CanonicalState,
  decidePromotion,
  type PromotionAttempt,
  type PromotionDecision,
} from "./promotion-cas.ts";
import {
  type RegisterScopeInput,
  type RequestScope,
  RequestScopes,
  type ScopeRegistration,
} from "./request-scopes.ts";

/**
 * Authoritative owner of one Project's cold, project-wide truth (AGENTS.md section 13.1).
 * One instance per Project: `env.PROJECT_ROOT.idFromName(projectId)`.
 * Cold Project truth: canonical state, promotion, and request admission go through here.
 */

export type InitializeInput = {
  projectId: string;
  orgId: string;
  artifactRef: string;
  treeSha: string;
  /** Starting Canonical Generation (the demo starts at 1841). */
  generation?: number;
  policyVersion: string;
};

export type CanonicalSnapshot = {
  projectId: string;
  orgId: string;
  generation: number;
  artifactRef: string;
  treeSha: string;
  policyVersion: string;
  lastPromotedChangeId: string | null;
  /** Candidate that produced the current generation; lets a caller repair a lagging D1 mirror. */
  lastPromotedCandidateId: string | null;
  updatedAt: string;
};

export type PromoteInput = PromotionAttempt & {
  changeId: string;
  actor: { kind: "user" | "system"; id: string };
  correlationId: string;
  /** Evidence the caller gated on (section 36, rules 2 and 3). Recorded in the event for audit. */
  requiredEvidenceIds: string[];
  /** The recorded human approval when the gate applied (rule 4), else null. */
  approvalId: string | null;
};

export type PromoteResult =
  | { ok: true; generation: number; alreadyPromoted: boolean; artifactRef: string; treeSha: string }
  | { ok: false; reason: "stale"; detail: Extract<PromotionDecision, { kind: "stale" }> }
  | { ok: false; reason: "policy_mismatch"; activePolicyVersion: string };

type RootRow = {
  project_id: string;
  org_id: string;
  canonical_generation: number;
  canonical_artifact_ref: string;
  canonical_tree_sha: string;
  active_policy_version: string;
  last_promoted_change_id: string | null;
  last_promoted_candidate_id: string | null;
  updated_at: string;
};

export class ProjectRootDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly requestScopes: RequestScopes;
  private readonly outbox: OutboxPublisher;
  private readonly alarms: AlarmGuard;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.requestScopes = new RequestScopes(this.sql);
    this.outbox = new OutboxPublisher(this.sql, env);
    this.alarms = new AlarmGuard(this.sql, ctx.storage, "ProjectRootDO");
    // Schema setup runs before any request reaches this instance.
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_root (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        canonical_generation INTEGER NOT NULL CHECK (canonical_generation >= 0),
        canonical_artifact_ref TEXT NOT NULL,
        canonical_tree_sha TEXT NOT NULL,
        active_policy_version TEXT NOT NULL,
        promotion_lock_state TEXT NOT NULL DEFAULT 'unlocked',
        last_promoted_change_id TEXT,
        last_promoted_candidate_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.requestScopes.migrate();
    migrateOutbox(this.sql);
    this.alarms.migrate();
  }

  async admit(
    changeId: string,
    requester?: { requesterUserId: string; requesterRank: number },
  ): Promise<number> {
    return this.ctx.storage.transactionSync(() => this.requestScopes.admit(changeId, requester));
  }

  async registerScope(input: RegisterScopeInput): Promise<ScopeRegistration> {
    return this.ctx.storage.transactionSync(() => this.requestScopes.register(input));
  }

  async updateScope(input: RegisterScopeInput): Promise<void> {
    this.requestScopes.update(input);
  }

  async getScope(changeId: string): Promise<RequestScope | null> {
    return this.requestScopes.scope(changeId);
  }

  async release(changeId: string): Promise<void> {
    this.requestScopes.release(changeId);
  }

  private row(): RootRow | null {
    return this.sql.exec<RootRow>("SELECT * FROM project_root WHERE id = 1").toArray()[0] ?? null;
  }

  private snapshot(row: RootRow): CanonicalSnapshot {
    return {
      projectId: row.project_id,
      orgId: row.org_id,
      generation: row.canonical_generation,
      artifactRef: row.canonical_artifact_ref,
      treeSha: row.canonical_tree_sha,
      policyVersion: row.active_policy_version,
      lastPromotedChangeId: row.last_promoted_change_id,
      lastPromotedCandidateId: row.last_promoted_candidate_id,
      updatedAt: row.updated_at,
    };
  }

  /** Creates the root state once. Repeating the same call returns the existing state. */
  async initialize(input: InitializeInput): Promise<CanonicalSnapshot> {
    const existing = this.row();
    if (existing) {
      if (existing.project_id !== input.projectId) {
        throw new Error("ProjectRootDO already belongs to a different project");
      }
      return this.snapshot(existing);
    }
    const now = new Date().toISOString();
    const generation = input.generation ?? 0;
    const event: EventEnvelope<{ orgId: string; generation: number; policyVersion: string }> = {
      eventId: crypto.randomUUID(),
      eventType: "project.created",
      eventVersion: 1,
      tenantId: input.orgId,
      projectId: input.projectId,
      actor: { kind: "system", id: "project-root-do" },
      canonicalGeneration: generation,
      correlationId: input.projectId,
      timestamp: now,
      payload: { orgId: input.orgId, generation, policyVersion: input.policyVersion },
    };
    AnyEventEnvelope.parse(event);

    // The root row and its project.created event commit together (AGENTS.md section 18).
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO project_root (id, project_id, org_id, canonical_generation, canonical_artifact_ref,
           canonical_tree_sha, active_policy_version, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.projectId,
        input.orgId,
        generation,
        input.artifactRef,
        input.treeSha,
        input.policyVersion,
        now,
        now,
      );
      this.sql.exec(
        "INSERT INTO outbox (event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
        event.eventId,
        event.eventType,
        JSON.stringify(event),
        now,
      );
    });
    await this.scheduleAlarm();
    return this.snapshot(this.requireRow());
  }

  /**
   * Binds the first canonical source (an Artifacts commit) to a Project at generation 0. Allowed
   * once, while the source is still unassigned; a repeat with the same ref is a no-op success.
   */
  async assignSource(input: { artifactRef: string; treeSha: string }): Promise<CanonicalSnapshot> {
    const row = this.requireRow();
    if (
      row.canonical_artifact_ref === input.artifactRef &&
      row.canonical_tree_sha === input.treeSha
    ) {
      return this.snapshot(row);
    }
    if (row.canonical_artifact_ref !== "unassigned" || row.canonical_generation !== 0) {
      throw new Error("Canonical source is already assigned");
    }
    const now = new Date().toISOString();
    const event: EventEnvelope<{ artifactRef: string; treeSha: string }> = {
      eventId: crypto.randomUUID(),
      eventType: "artifact.promoted",
      eventVersion: 1,
      tenantId: row.org_id,
      projectId: row.project_id,
      actor: { kind: "system", id: "project-root-do" },
      canonicalGeneration: 0,
      correlationId: row.project_id,
      timestamp: now,
      payload: input,
    };
    AnyEventEnvelope.parse(event);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE project_root SET canonical_artifact_ref = ?, canonical_tree_sha = ?, updated_at = ?
         WHERE id = 1 AND canonical_artifact_ref = 'unassigned' AND canonical_generation = 0`,
        input.artifactRef,
        input.treeSha,
        now,
      );
      this.sql.exec(
        "INSERT INTO outbox (event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
        event.eventId,
        event.eventType,
        JSON.stringify(event),
        now,
      );
    });
    await this.scheduleAlarm();
    return this.snapshot(this.requireRow());
  }

  async getCanonical(): Promise<CanonicalSnapshot | null> {
    const row = this.row();
    return row ? this.snapshot(row) : null;
  }

  /**
   * Compare-and-swap promotion (section 36). The state update and the `canonical.advanced` outbox
   * row commit in one transaction, so the event exists if and only if the generation advanced.
   * This object decides rules 5 to 7 on its own state: policy version, generation, and tree. The
   * caller (integration Worker, internal bindings only) has already checked status, Evidence,
   * approval, and the Candidate artifact against D1 and Artifacts (ADR 0013).
   */
  async promote(input: PromoteInput): Promise<PromoteResult> {
    const row = this.requireRow();
    const current: CanonicalState = {
      generation: row.canonical_generation,
      artifactRef: row.canonical_artifact_ref,
      treeSha: row.canonical_tree_sha,
      lastPromotedCandidateId: row.last_promoted_candidate_id,
      policyVersion: row.active_policy_version,
    };
    const decision = decidePromotion(current, input);

    if (decision.kind === "stale") return { ok: false, reason: "stale", detail: decision };
    if (decision.kind === "policy_mismatch") {
      return {
        ok: false,
        reason: "policy_mismatch",
        activePolicyVersion: decision.activePolicyVersion,
      };
    }
    if (decision.kind === "already_promoted") {
      return {
        ok: true,
        generation: decision.generation,
        alreadyPromoted: true,
        artifactRef: current.artifactRef,
        treeSha: current.treeSha,
      };
    }

    const now = new Date().toISOString();
    const event: EventEnvelope<{
      fromGeneration: number;
      toGeneration: number;
      candidateId: string;
      artifactRef: string;
      treeSha: string;
      policyVersion: string;
      requiredEvidenceIds: string[];
      approvalId: string | null;
    }> = {
      eventId: crypto.randomUUID(),
      eventType: "canonical.advanced",
      eventVersion: 1,
      tenantId: row.org_id,
      projectId: row.project_id,
      changeId: input.changeId,
      actor: input.actor,
      canonicalGeneration: decision.next.generation,
      correlationId: input.correlationId,
      timestamp: now,
      payload: {
        fromGeneration: current.generation,
        toGeneration: decision.next.generation,
        candidateId: input.candidateId,
        artifactRef: decision.next.artifactRef,
        treeSha: decision.next.treeSha,
        policyVersion: input.policyVersion,
        requiredEvidenceIds: input.requiredEvidenceIds,
        approvalId: input.approvalId,
      },
    };
    AnyEventEnvelope.parse(event);

    this.ctx.storage.transactionSync(() => {
      // The WHERE clause re-checks the generation inside the transaction.
      const updated = this.sql.exec(
        `UPDATE project_root
           SET canonical_generation = ?, canonical_artifact_ref = ?, canonical_tree_sha = ?,
               last_promoted_change_id = ?, last_promoted_candidate_id = ?, updated_at = ?
         WHERE id = 1 AND canonical_generation = ?`,
        decision.next.generation,
        decision.next.artifactRef,
        decision.next.treeSha,
        input.changeId,
        input.candidateId,
        now,
        current.generation,
      );
      if (updated.rowsWritten !== 1)
        throw new Error("Canonical generation changed during promotion");
      this.sql.exec(
        "INSERT INTO outbox (event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
        event.eventId,
        event.eventType,
        JSON.stringify(event),
        now,
      );
    });

    await this.scheduleAlarm();
    return {
      ok: true,
      generation: decision.next.generation,
      alreadyPromoted: false,
      artifactRef: decision.next.artifactRef,
      treeSha: decision.next.treeSha,
    };
  }

  /**
   * Publishes due outbox rows to K2, then schedules the next attempt if any remain. The guard
   * (alarm-guard.ts) counts the fire, defers RPC reschedules while it runs, keeps a retry at least
   * 1 s out, and stops at the daily cap.
   */
  override async alarm(): Promise<void> {
    await this.alarms.run(
      async (now) => (await this.outbox.publishAllDue(now)) > 0,
      () => this.outbox.nextDueAt(),
    );
  }

  private async scheduleAlarm() {
    await this.alarms.schedule(this.outbox.nextDueAt(), Date.now());
  }

  /**
   * Drops all state of an archived Project (`DELETE /v1/projects/:id`). Due outbox events are
   * published first, best effort. Afterwards the instance answers like an uninitialized one:
   * `getCanonical()` returns null, so no Candidate can compose on it. Safe to repeat.
   */
  async purge(projectId: string): Promise<{ purged: boolean }> {
    const existing = this.row();
    if (existing && existing.project_id !== projectId) {
      throw new Error("ProjectRootDO belongs to a different project");
    }
    if (!existing) return { purged: false };
    await this.outbox.publishAllDue(Date.now()).catch(() => 0);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Empty tables keep later calls on this instance working until it is evicted.
    this.migrate();
    return { purged: true };
  }

  /** Unpublished outbox rows (pending or failed), oldest first. */
  async pendingOutbox(limit = 50) {
    return this.outbox.pending(limit);
  }

  private requireRow(): RootRow {
    const row = this.row();
    if (!row) throw new Error("ProjectRootDO is not initialized");
    return row;
  }
}
