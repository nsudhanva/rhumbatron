/**
 * Claim lease decisions (AGENTS.md sections 13.2 and 42.3).
 * Pure logic with no I/O. Every function takes `now` (epoch milliseconds) as a parameter.
 * ResourceShardDO reads rows, calls these functions, and applies the decision in one transaction.
 *
 * Claims are advisory (ADR 0015): `held` tells the requester who holds the resource, and the shard
 * records `claim.contended`. It never stops the requester's run. Only the owner renews or releases.
 */

import { fnv1a32 } from "./shard-key.ts";

export const MIN_TTL_MS = 5_000;
export const MAX_TTL_MS = 600_000;

export type ClaimStatus = "active" | "released" | "expired";

export type ClaimRecord = {
  claimId: string;
  projectId: string;
  changeId: string;
  agentId: string;
  resource: string;
  /** Epoch milliseconds. The lease is over at this instant (expiry is inclusive). */
  leaseExpiresAt: number;
  intentHash: string;
  createdAt: number;
  status: ClaimStatus;
};

export type AcquireRequest = {
  projectId: string;
  changeId: string;
  agentId: string;
  resource: string;
  intentHash: string;
  ttlMs: number;
};

export type HeldBy = {
  agentId: string;
  changeId: string;
  claimId: string;
  leaseExpiresAt: number;
};

export type AcquireDecision =
  | { kind: "grant"; leaseExpiresAt: number }
  | { kind: "renew_existing"; claimId: string; leaseExpiresAt: number }
  | { kind: "held"; heldBy: HeldBy };

export type RenewRejection = "not_found" | "not_owner" | "expired";

export type RenewDecision =
  | { kind: "renewed"; leaseExpiresAt: number }
  | { kind: "rejected"; reason: RenewRejection };

export type ReleaseDecision =
  | { kind: "release" }
  | { kind: "noop" }
  | { kind: "rejected"; reason: "not_found" | "not_owner" };

export function isValidTtl(ttlMs: number): boolean {
  return Number.isInteger(ttlMs) && ttlMs >= MIN_TTL_MS && ttlMs <= MAX_TTL_MS;
}

/** A claim is live only while it is active and its lease has not run out. */
function isClaimLive(claim: ClaimRecord, now: number): boolean {
  return claim.status === "active" && claim.leaseExpiresAt > now;
}

/** Active claims whose lease is over. These must become `expired` and emit `claim.expired`. */
export function findOverdue(claims: readonly ClaimRecord[], now: number): ClaimRecord[] {
  return claims.filter((c) => c.status === "active" && c.leaseExpiresAt <= now);
}

/**
 * `holder` is the claim row currently active for the resource, or null.
 * An expired or inactive holder never blocks.
 */
export function decideAcquire(
  holder: ClaimRecord | null,
  request: AcquireRequest,
  now: number,
): AcquireDecision {
  const leaseExpiresAt = now + request.ttlMs;
  if (holder === null || !isClaimLive(holder, now)) {
    return { kind: "grant", leaseExpiresAt };
  }
  if (holder.agentId === request.agentId && holder.changeId === request.changeId) {
    return { kind: "renew_existing", claimId: holder.claimId, leaseExpiresAt };
  }
  return {
    kind: "held",
    heldBy: {
      agentId: holder.agentId,
      changeId: holder.changeId,
      claimId: holder.claimId,
      leaseExpiresAt: holder.leaseExpiresAt,
    },
  };
}

/**
 * Event ID of `claim.contended`: one per holder Claim and contending agent and Change. A contender
 * that asks again on every renewal tick produces no new event while the same Claim holds the lease.
 */
export function contendedEventId(holderClaimId: string, agentId: string, changeId: string): string {
  const id = `cnt_${holderClaimId}_${agentId}_${changeId}`;
  // Event IDs are at most 128 characters. Long inputs fall back to two independent 32-bit hashes.
  if (id.length <= 128) return id;
  const key = `${agentId}\u0000${changeId}`;
  const h1 = fnv1a32(key).toString(16).padStart(8, "0");
  const h2 = fnv1a32(`${key}\u0000salt`).toString(16).padStart(8, "0");
  return `cnt_${holderClaimId.slice(0, 100)}_${h1}${h2}`;
}

/** Only the owning agent can renew, and only while the lease is live. */
export function decideRenew(
  claim: ClaimRecord | null,
  agentId: string,
  ttlMs: number,
  now: number,
): RenewDecision {
  if (claim === null) return { kind: "rejected", reason: "not_found" };
  if (claim.agentId !== agentId) return { kind: "rejected", reason: "not_owner" };
  if (claim.status === "released") return { kind: "rejected", reason: "not_found" };
  if (!isClaimLive(claim, now)) return { kind: "rejected", reason: "expired" };
  return { kind: "renewed", leaseExpiresAt: now + ttlMs };
}

/** Releasing an already released or expired claim is a no-op success for its owner. */
export function decideRelease(claim: ClaimRecord | null, agentId: string): ReleaseDecision {
  if (claim === null) return { kind: "rejected", reason: "not_found" };
  if (claim.agentId !== agentId) return { kind: "rejected", reason: "not_owner" };
  return claim.status === "active" ? { kind: "release" } : { kind: "noop" };
}

/** Earliest lease expiry among active claims, or null when no alarm is needed. */
export function nextAlarmAt(claims: readonly ClaimRecord[]): number | null {
  let earliest: number | null = null;
  for (const c of claims) {
    if (c.status !== "active") continue;
    if (earliest === null || c.leaseExpiresAt < earliest) earliest = c.leaseExpiresAt;
  }
  return earliest;
}
