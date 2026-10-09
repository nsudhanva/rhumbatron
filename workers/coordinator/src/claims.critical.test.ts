import { describe, expect, it } from "vitest";
import {
  type AcquireRequest,
  type ClaimRecord,
  contendedEventId,
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
      heldBy: {
        agentId: "agent-b",
        changeId: "change-1",
        claimId: "claim-b",
        leaseExpiresAt: NOW + 30_000,
      },
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

describe("advisory leases (ADR 0015)", () => {
  it("never extends another agent's Claim: renew and release by a non-owner change nothing", () => {
    const held = claim({ agentId: "agent-b", claimId: "claim-b" });
    expect(decideRenew(held, "agent-a", 120_000, NOW)).toEqual({
      kind: "rejected",
      reason: "not_owner",
    });
    expect(decideRelease(held, "agent-a")).toEqual({ kind: "rejected", reason: "not_owner" });
    // A contender that asks again is told who holds it; it is never granted the holder's lease.
    const again = decideAcquire(held, request({ ttlMs: 120_000 }), NOW + 1_000);
    expect(again).toMatchObject({ kind: "held", heldBy: { leaseExpiresAt: NOW + 30_000 } });
  });

  it("expires a Claim that is not renewed, and then grants the resource to the contender", () => {
    const t0 = NOW;
    const holder = claim({ agentId: "agent-b", leaseExpiresAt: t0 + 120_000 });
    expect(decideAcquire(holder, request(), t0 + 119_999).kind).toBe("held");
    expect(findOverdue([holder], t0 + 119_999)).toEqual([]);
    // No renewal arrived: at the lease end the shard marks it expired and the resource is free.
    expect(findOverdue([holder], t0 + 120_000)).toEqual([holder]);
    expect(decideAcquire(holder, request(), t0 + 120_000).kind).toBe("grant");
    expect(decideRenew(holder, "agent-b", 120_000, t0 + 120_000)).toMatchObject({
      reason: "expired",
    });
  });

  it("gives one stable contention event ID per holder Claim, contender, and Change", () => {
    const id = contendedEventId("claim-b", "agt_1", "chg_1");
    expect(contendedEventId("claim-b", "agt_1", "chg_1")).toBe(id);
    expect(contendedEventId("claim-c", "agt_1", "chg_1")).not.toBe(id);
    expect(contendedEventId("claim-b", "agt_2", "chg_1")).not.toBe(id);
    const long = contendedEventId(crypto.randomUUID(), "a".repeat(120), "c".repeat(120));
    expect(long.length).toBeLessThanOrEqual(128);
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
