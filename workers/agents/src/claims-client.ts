import type { ResourceShardDO } from "@rhumbatron/coordinator";
import { shardKey } from "@rhumbatron/coordinator/shard-key";
import { type ChangeContext, qualify } from "@rhumbatron/integration/events";
import { SemanticResource } from "@rhumbatron/protocol";
import type { RecordedContention } from "./conflicts.ts";

/**
 * Advisory Claims for one agent run (ADR 0015, AGENTS.md sections 13.2, 42.3, and 59).
 *
 * A run asks for a Claim on each semantic resource of its Task when it starts, renews each lease
 * at half-life on its existing timers (the one-minute run check and model-call boundaries), and
 * releases every lease when the run ends. A resource that another agent holds does not block the
 * run: the shard records `claim.contended`, and the run keeps the holder as a conflict signal and
 * asks again at its next tick. If the agent dies, nothing renews and the shard expires the lease.
 *
 * This module never throws into the run: a failed shard call is logged and retried at the next tick.
 */

/** Lease length. The renew tick runs about once a minute, so one missed tick does not lose it. */
export const CLAIM_TTL_MS = 120_000;
/** Renew at half-life. */
export const RENEW_AFTER_MS = CLAIM_TTL_MS / 2;
/**
 * A tick up to this much before half-life still renews. The run check reschedules itself a few
 * milliseconds before it renews, so without slack every second check would skip the renewal.
 */
export const TICK_SLACK_MS = 10_000;
/** Retry delay after a shard call failed, so a lease is not lost to one transient error. */
const RETRY_AFTER_MS = 15_000;
/** Resources claimed per run. Bounds Durable Object requests per tick (section 7.3). */
const MAX_CLAIMS_PER_RUN = 8;

export type RunClaim = {
  runId: string;
  /** Qualified resource, for example `project:acme-shop:wishlist:membership`. */
  resource: string;
  /** This run's own Claim. Never the holder's Claim: only the owner renews or releases. */
  claimId: string | null;
  leaseExpiresAt: number | null;
  /** Epoch milliseconds. The next tick at or after this instant renews or asks again. */
  renewAfter: number;
  /** Set once another agent held the resource during this run. Kept until the run ends. */
  holderAgentId: string | null;
  holderClaimId: string | null;
  holderChangeId: string | null;
};

export type ClaimScope = {
  projectId: string;
  changeId: string;
  agentId: string;
  runId: string;
  /** Reference to the Intent this run will declare: `int_<run>`. */
  intentHash: string;
};

type HeldBy = { agentId: string; changeId: string; claimId: string; leaseExpiresAt: number };

export type AcquireOutcome =
  | { ok: true; claim: { claimId: string; leaseExpiresAt: number } }
  | { ok: false; reason: "held"; heldBy: HeldBy };

/** The ResourceShardDO RPC surface this module uses. */
export type ClaimShard = {
  acquireClaim(input: {
    projectId: string;
    changeId: string;
    agentId: string;
    resource: string;
    intentHash: string;
    ttlMs: number;
  }): Promise<AcquireOutcome>;
  renewClaim(input: {
    claimId: string;
    agentId: string;
    ttlMs: number;
  }): Promise<
    | { ok: true; claimId: string; leaseExpiresAt: number }
    | { ok: false; reason: "not_found" | "not_owner" | "expired" }
  >;
  releaseClaim(input: {
    claimId: string;
    agentId: string;
  }): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_owner" }>;
};

export type RunClaimStore = {
  list(runId: string): RunClaim[];
  put(row: RunClaim): void;
  remove(runId: string): void;
};

const log = (line: Record<string, unknown>) => console.warn(JSON.stringify(line));

/** Qualified, valid, unique resources of a Task, at most MAX_CLAIMS_PER_RUN. */
export function claimResources(ctx: ChangeContext, resources: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of resources) {
    const resource = raw.startsWith("project:") ? raw : qualify(ctx, raw);
    if (SemanticResource.safeParse(resource).success) out.add(resource);
  }
  return [...out].sort().slice(0, MAX_CLAIMS_PER_RUN);
}

/**
 * The row after an acquire attempt. Pure. A grant stores this run's own Claim. `held` keeps the
 * row unclaimed and records the holder; it never stores the holder's Claim ID as this run's.
 * `null` (the call failed) keeps the row unclaimed and retries soon.
 */
function applyAcquire(row: RunClaim, outcome: AcquireOutcome | null, now: number): RunClaim {
  if (outcome === null) return { ...row, claimId: null, renewAfter: now + RETRY_AFTER_MS };
  if (outcome.ok) {
    return {
      ...row,
      claimId: outcome.claim.claimId,
      leaseExpiresAt: outcome.claim.leaseExpiresAt,
      renewAfter: now + RENEW_AFTER_MS,
    };
  }
  return {
    ...row,
    claimId: null,
    leaseExpiresAt: null,
    renewAfter: now + RENEW_AFTER_MS,
    holderAgentId: outcome.heldBy.agentId,
    holderClaimId: outcome.heldBy.claimId,
    holderChangeId: outcome.heldBy.changeId,
  };
}

/** Rows due at `now`: own Claims to renew, and unclaimed resources to ask for again. Pure. */
function dueRows(rows: readonly RunClaim[], now: number) {
  const due = rows.filter((r) => r.renewAfter <= now + TICK_SLACK_MS);
  return {
    renew: due.filter((r): r is RunClaim & { claimId: string } => r.claimId !== null),
    acquire: due.filter((r) => r.claimId === null),
  };
}

/** Contention this run saw, in the form the Change shard stores for conflict detection. */
export function contentionsOf(rows: readonly RunClaim[], agentId: string): RecordedContention[] {
  return rows.flatMap((r) =>
    r.holderAgentId && r.holderClaimId && r.holderChangeId && r.holderAgentId !== agentId
      ? [
          {
            resource: r.resource,
            agentId,
            holderAgentId: r.holderAgentId,
            holderClaimId: r.holderClaimId,
            holderChangeId: r.holderChangeId,
          },
        ]
      : [],
  );
}

async function tryAcquire(
  shardFor: (resource: string) => ClaimShard,
  scope: ClaimScope,
  row: RunClaim,
  now: number,
): Promise<RunClaim> {
  try {
    const outcome = await shardFor(row.resource).acquireClaim({
      projectId: scope.projectId,
      changeId: scope.changeId,
      agentId: scope.agentId,
      resource: row.resource,
      intentHash: scope.intentHash,
      ttlMs: CLAIM_TTL_MS,
    });
    return applyAcquire(row, outcome, now);
  } catch (error) {
    log({
      event: "agent.claim_acquire_failed",
      runId: scope.runId,
      resource: row.resource,
      message: String(error).slice(0, 200),
    });
    return applyAcquire(row, null, now);
  }
}

/**
 * Asks for a Claim on each resource at run start. Never blocks and never throws. Returns the rows
 * held by another agent, so the caller can count contention.
 */
export async function acquireRunClaims(
  store: RunClaimStore,
  shardFor: (resource: string) => ClaimShard,
  scope: ClaimScope,
  resources: readonly string[],
  now = Date.now(),
): Promise<{ contended: RunClaim[] }> {
  const known = new Set(store.list(scope.runId).map((r) => r.resource));
  const fresh = resources
    .filter((resource) => !known.has(resource))
    .map(
      (resource): RunClaim => ({
        runId: scope.runId,
        resource,
        claimId: null,
        leaseExpiresAt: null,
        renewAfter: now,
        holderAgentId: null,
        holderClaimId: null,
        holderChangeId: null,
      }),
    );
  // Reserve the rows before any await, so a concurrent tick does not ask twice.
  for (const row of fresh) store.put({ ...row, renewAfter: now + RETRY_AFTER_MS });
  const rows = await Promise.all(fresh.map((row) => tryAcquire(shardFor, scope, row, now)));
  return { contended: await persist(store, shardFor, scope, rows) };
}

/**
 * Stores the rows after the shard calls, unless the run ended meanwhile (its rows are gone): then
 * any Claim granted during the calls is released at once instead of left to expire.
 */
async function persist(
  store: RunClaimStore,
  shardFor: (resource: string) => ClaimShard,
  scope: ClaimScope,
  rows: readonly RunClaim[],
): Promise<RunClaim[]> {
  if (store.list(scope.runId).length === 0) {
    const late: RunClaimStore = { list: () => [...rows], put: () => {}, remove: () => {} };
    await releaseRunClaims(late, shardFor, scope);
    return [];
  }
  for (const row of rows) store.put(row);
  return rows.filter((r) => r.claimId === null && r.holderClaimId !== null);
}

/**
 * Renews this run's due Claims and asks again for due unclaimed resources. Makes no request when
 * nothing is due. A renewal the shard rejects (the lease lapsed) becomes a new acquire. Never throws.
 * `contended` lists only rows held by a holder Claim this run had not seen before.
 */
export async function renewRunClaims(
  store: RunClaimStore,
  shardFor: (resource: string) => ClaimShard,
  scope: ClaimScope,
  now = Date.now(),
): Promise<{ contended: RunClaim[] }> {
  const { renew, acquire } = dueRows(store.list(scope.runId), now);
  if (renew.length + acquire.length === 0) return { contended: [] };
  // Reserve before any await: the run check and a model call can tick at the same time.
  for (const row of [...renew, ...acquire]) store.put({ ...row, renewAfter: now + RETRY_AFTER_MS });

  const renewed = await Promise.all(
    renew.map(async (row): Promise<RunClaim> => {
      try {
        const result = await shardFor(row.resource).renewClaim({
          claimId: row.claimId,
          agentId: scope.agentId,
          ttlMs: CLAIM_TTL_MS,
        });
        if (result.ok) {
          return {
            ...row,
            leaseExpiresAt: result.leaseExpiresAt,
            renewAfter: now + RENEW_AFTER_MS,
          };
        }
        log({
          event: "agent.claim_lost",
          runId: scope.runId,
          resource: row.resource,
          reason: result.reason,
        });
        return tryAcquire(shardFor, scope, { ...row, claimId: null, leaseExpiresAt: null }, now);
      } catch (error) {
        log({
          event: "agent.claim_renew_failed",
          runId: scope.runId,
          resource: row.resource,
          message: String(error).slice(0, 200),
        });
        return { ...row, renewAfter: now + RETRY_AFTER_MS };
      }
    }),
  );
  const retried = await Promise.all(acquire.map((row) => tryAcquire(shardFor, scope, row, now)));
  const before = new Map([...renew, ...acquire].map((r) => [r.resource, r.holderClaimId]));
  const held = await persist(store, shardFor, scope, [...renewed, ...retried]);
  // Report a contention once per holder Claim, not on every tick that asks again.
  return { contended: held.filter((r) => before.get(r.resource) !== r.holderClaimId) };
}

/**
 * Releases every Claim of the run and forgets the run's rows. Idempotent: a second call finds no
 * rows and makes no request, and the shard treats a repeated release as a no-op. A failed release
 * is only logged: the lease then expires on its own (section 42.3). Never throws.
 */
export async function releaseRunClaims(
  store: RunClaimStore,
  shardFor: (resource: string) => ClaimShard,
  scope: ClaimScope,
): Promise<number> {
  const owned = store.list(scope.runId).filter((r) => r.claimId !== null);
  store.remove(scope.runId);
  const results = await Promise.allSettled(
    owned.map((row) =>
      shardFor(row.resource).releaseClaim({
        claimId: row.claimId as string,
        agentId: scope.agentId,
      }),
    ),
  );
  results.forEach((result, i) => {
    const message =
      result.status === "rejected"
        ? String(result.reason).slice(0, 200)
        : result.value.ok
          ? null
          : result.value.reason;
    if (message !== null) {
      log({
        event: "agent.claim_release_failed",
        runId: scope.runId,
        resource: owned[i]?.resource,
        message,
      });
    }
  });
  return owned.length;
}

/** Shard stub for a resource of the Project: the same shard key as every other producer. */
export function claimShardFor(namespace: DurableObjectNamespace, projectId: string) {
  const ns = namespace as DurableObjectNamespace<ResourceShardDO>;
  return (resource: string): ClaimShard => ns.get(ns.idFromName(shardKey(projectId, resource)));
}

type RunClaimRow = {
  run_id: string;
  resource: string;
  claim_id: string | null;
  lease_expires_at: number | null;
  renew_after: number;
  holder_agent_id: string | null;
  holder_claim_id: string | null;
  holder_change_id: string | null;
};

/** The AgentDO's own SQLite table for the active run's Claims. */
export function sqlRunClaimStore(sql: SqlStorage): RunClaimStore {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS run_claims (
      run_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      claim_id TEXT,
      lease_expires_at INTEGER,
      renew_after INTEGER NOT NULL,
      holder_agent_id TEXT,
      holder_claim_id TEXT,
      holder_change_id TEXT,
      PRIMARY KEY (run_id, resource)
    );
  `);
  return {
    list: (runId) =>
      sql
        .exec<RunClaimRow>("SELECT * FROM run_claims WHERE run_id = ? ORDER BY resource", runId)
        .toArray()
        .map((r) => ({
          runId: r.run_id,
          resource: r.resource,
          claimId: r.claim_id,
          leaseExpiresAt: r.lease_expires_at,
          renewAfter: r.renew_after,
          holderAgentId: r.holder_agent_id,
          holderClaimId: r.holder_claim_id,
          holderChangeId: r.holder_change_id,
        })),
    put: (row) => {
      sql.exec(
        `INSERT OR REPLACE INTO run_claims (run_id, resource, claim_id, lease_expires_at, renew_after,
           holder_agent_id, holder_claim_id, holder_change_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        row.runId,
        row.resource,
        row.claimId,
        row.leaseExpiresAt,
        row.renewAfter,
        row.holderAgentId,
        row.holderClaimId,
        row.holderChangeId,
      );
    },
    remove: (runId) => {
      sql.exec("DELETE FROM run_claims WHERE run_id = ?", runId);
    },
  };
}
