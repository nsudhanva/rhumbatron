import { describe, expect, it } from "vitest";
import {
  type AcquireRequest,
  type ClaimRecord,
  decideAcquire,
  decideRelease,
  decideRenew,
  findOverdue,
  isValidTtl,
  nextAlarmAt,
} from "./claims.ts";
import { shardKey } from "./shard-key.ts";

const NOW = 1_000_000;
const RESOURCE = "project:acme:wishlist:membership";

const request = (overrides: Partial<AcquireRequest> = {}): AcquireRequest => ({
  projectId: "acme",
  changeId: "change-1",
  agentId: "agent-a",
  resource: RESOURCE,
  intentHash: "hash-1",
  ttlMs: 30_000,
  ...overrides,
});

const claim = (overrides: Partial<ClaimRecord> = {}): ClaimRecord => ({
  claimId: "claim-1",
  projectId: "acme",
  changeId: "change-1",
  agentId: "agent-a",
  resource: RESOURCE,
  leaseExpiresAt: NOW + 30_000,
  intentHash: "hash-1",
  createdAt: NOW - 1_000,
  status: "active",
  ...overrides,
});

describe("decideAcquire", () => {
  it("grants a free resource with a lease of now + ttl", () => {
    expect(decideAcquire(null, request(), NOW)).toEqual({
      kind: "grant",
      leaseExpiresAt: NOW + 30_000,
    });
  });

  it("refuses a held resource and names the holder", () => {
    const holder = claim({ agentId: "agent-b", claimId: "claim-b" });
    expect(decideAcquire(holder, request(), NOW)).toEqual({
      kind: "held",
      heldBy: { agentId: "agent-b", claimId: "claim-b", leaseExpiresAt: NOW + 30_000 },
    });
  });

  it("does not let an expired claim block, and reports it as overdue", () => {
    const expired = claim({ agentId: "agent-b", leaseExpiresAt: NOW });
    expect(decideAcquire(expired, request(), NOW).kind).toBe("grant");
    expect(findOverdue([expired], NOW)).toEqual([expired]);
    expect(findOverdue([claim()], NOW)).toEqual([]);
  });

  it("renews the existing claim for the same agent and change", () => {
    expect(decideAcquire(claim(), request({ ttlMs: 60_000 }), NOW)).toEqual({
      kind: "renew_existing",
      claimId: "claim-1",
      leaseExpiresAt: NOW + 60_000,
    });
  });

  it("holds the same agent when the change differs", () => {
    expect(decideAcquire(claim(), request({ changeId: "change-2" }), NOW).kind).toBe("held");
  });
});

describe("decideRenew", () => {
  it("extends the lease for the owner", () => {
    expect(decideRenew(claim(), "agent-a", 20_000, NOW)).toEqual({
      kind: "renewed",
      leaseExpiresAt: NOW + 20_000,
    });
  });

  it("rejects a non-owner", () => {
    expect(decideRenew(claim(), "agent-b", 20_000, NOW)).toEqual({
      kind: "rejected",
      reason: "not_owner",
    });
  });

  it("rejects renewal after the lease ran out", () => {
    const lapsed = claim({ leaseExpiresAt: NOW });
    expect(decideRenew(lapsed, "agent-a", 20_000, NOW)).toEqual({
      kind: "rejected",
      reason: "expired",
    });
    const marked = claim({ status: "expired" });
    expect(decideRenew(marked, "agent-a", 20_000, NOW)).toMatchObject({ reason: "expired" });
  });

  it("rejects an unknown claim", () => {
    expect(decideRenew(null, "agent-a", 20_000, NOW)).toEqual({
      kind: "rejected",
      reason: "not_found",
    });
  });
});

describe("decideRelease", () => {
  it("releases an active claim once and treats a repeat as a no-op", () => {
    expect(decideRelease(claim(), "agent-a")).toEqual({ kind: "release" });
    expect(decideRelease(claim({ status: "released" }), "agent-a")).toEqual({ kind: "noop" });
    expect(decideRelease(claim({ status: "expired" }), "agent-a")).toEqual({ kind: "noop" });
  });

  it("rejects a non-owner and an unknown claim", () => {
    expect(decideRelease(claim(), "agent-b")).toEqual({ kind: "rejected", reason: "not_owner" });
    expect(decideRelease(null, "agent-a")).toEqual({ kind: "rejected", reason: "not_found" });
  });
});

describe("lease bounds and alarm", () => {
  it("accepts only 5s to 600s integer ttl values", () => {
    expect(isValidTtl(5_000)).toBe(true);
    expect(isValidTtl(600_000)).toBe(true);
    expect(isValidTtl(4_999)).toBe(false);
    expect(isValidTtl(600_001)).toBe(false);
    expect(isValidTtl(10_000.5)).toBe(false);
  });

  it("schedules the alarm at the earliest active lease only", () => {
    const claims = [
      claim({ claimId: "a", leaseExpiresAt: NOW + 50_000 }),
      claim({ claimId: "b", leaseExpiresAt: NOW + 10_000 }),
      claim({ claimId: "c", leaseExpiresAt: NOW + 1_000, status: "released" }),
    ];
    expect(nextAlarmAt(claims)).toBe(NOW + 10_000);
    expect(nextAlarmAt([])).toBeNull();
  });
});

describe("shardKey", () => {
  it("is stable for the same inputs", () => {
    expect(shardKey("acme", RESOURCE)).toBe(shardKey("acme", RESOURCE));
    expect(shardKey("acme", RESOURCE)).toMatch(/^acme:shard-\d{2}$/);
  });

  it("stays within 32 shards and spreads resources across them", () => {
    const shards = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const key = shardKey("acme", `project:acme:resource-${i}`);
      const index = Number(key.slice(key.lastIndexOf("-") + 1));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(32);
      shards.add(key);
    }
    expect(shards.size).toBeGreaterThan(16);
  });
});
