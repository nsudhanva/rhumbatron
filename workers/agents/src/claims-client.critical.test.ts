// Advisory Claims (ADR 0015) must never block a run, must always leave a contention signal, must
// renew only the run's own Claim, and must release idempotently. A fake shard applies the real
// lease rules from the coordinator, so the client is checked against the shard's decisions.
import { describe, expect, it } from "vitest";
import {
  type ClaimRecord,
  decideAcquire,
  decideRelease,
  decideRenew,
} from "../../coordinator/src/claims.ts";
import {
  type AcquireOutcome,
  acquireRunClaims,
  CLAIM_TTL_MS,
  type ClaimScope,
  type ClaimShard,
  contentionsOf,
  RENEW_AFTER_MS,
  type RunClaim,
  type RunClaimStore,
  releaseRunClaims,
  renewRunClaims,
  TICK_SLACK_MS,
} from "./claims-client.ts";

const RESOURCE = "project:acme-shop:wishlist:membership";
const T0 = 1_000_000;

/** One shard with the coordinator's decision functions and a clock the test moves. */
function fakeShard() {
  const claims = new Map<string, ClaimRecord>();
  const calls: string[] = [];
  let now = T0;
  let seq = 0;
  const active = (resource: string) =>
    [...claims.values()].find((c) => c.resource === resource && c.status === "active") ?? null;
  const shard: ClaimShard = {
    async acquireClaim(input) {
      calls.push(`acquire:${input.agentId}`);
      const holder = active(input.resource);
      if (holder && holder.leaseExpiresAt <= now) holder.status = "expired";
      const decision = decideAcquire(holder, input, now);
      if (decision.kind === "held") return { ok: false, reason: "held", heldBy: decision.heldBy };
      if (decision.kind === "renew_existing") {
        const c = claims.get(decision.claimId) as ClaimRecord;
        c.leaseExpiresAt = decision.leaseExpiresAt;
        return { ok: true, claim: c };
      }
      seq += 1;
      const claim: ClaimRecord = {
        ...input,
        claimId: `claim-${seq}`,
        leaseExpiresAt: decision.leaseExpiresAt,
        createdAt: now,
        status: "active",
      };
      claims.set(claim.claimId, claim);
      return { ok: true, claim };
    },
    async renewClaim(input) {
      calls.push(`renew:${input.claimId}:${input.agentId}`);
      const claim = claims.get(input.claimId) ?? null;
      const decision = decideRenew(claim, input.agentId, input.ttlMs, now);
      if (decision.kind === "rejected" || !claim) {
        return { ok: false, reason: decision.kind === "rejected" ? decision.reason : "not_found" };
      }
      claim.leaseExpiresAt = decision.leaseExpiresAt;
      return { ok: true, claimId: claim.claimId, leaseExpiresAt: decision.leaseExpiresAt };
    },
    async releaseClaim(input) {
      calls.push(`release:${input.claimId}`);
      const claim = claims.get(input.claimId) ?? null;
      const decision = decideRelease(claim, input.agentId);
      if (decision.kind === "rejected") return { ok: false, reason: decision.reason };
      if (decision.kind === "release" && claim) claim.status = "released";
      return { ok: true };
    },
  };
  return {
    shard,
    claims,
    calls,
    setNow: (t: number) => {
      now = t;
    },
  };
}

function memoryStore(): RunClaimStore & { rows: Map<string, RunClaim> } {
  const rows = new Map<string, RunClaim>();
  return {
    rows,
    list: (runId) => [...rows.values()].filter((r) => r.runId === runId),
    put: (row) => {
      rows.set(`${row.runId}\u0000${row.resource}`, row);
    },
    remove: (runId) => {
      for (const [k, r] of rows) if (r.runId === runId) rows.delete(k);
    },
  };
}

const scope = (agent: string): ClaimScope => ({
  projectId: "prj_acme",
  changeId: "chg_1",
  agentId: agent,
  runId: `run_${agent}_1`,
  intentHash: `int_${agent}_1`,
});

describe("advisory Claims for an agent run", () => {
  it("never blocks on contention and always yields a contention signal", async () => {
    const { shard } = fakeShard();
    const storeA = memoryStore();
    const storeB = memoryStore();
    await acquireRunClaims(storeA, () => shard, scope("a"), [RESOURCE], T0);

    // B's acquire resolves (the run goes on) and B keeps A as the holder.
    const b = await acquireRunClaims(storeB, () => shard, scope("b"), [RESOURCE], T0);
    expect(b.contended).toHaveLength(1);
    expect(contentionsOf(storeB.list("run_b_1"), "b")).toEqual([
      {
        resource: RESOURCE,
        agentId: "b",
        holderAgentId: "a",
        holderClaimId: "claim-1",
        holderChangeId: "chg_1",
      },
    ]);

    // A failing shard also does not block the run; the resource is retried at the next tick.
    const broken: ClaimShard = {
      ...shard,
      acquireClaim: async () => {
        throw new Error("shard unavailable");
      },
    };
    const storeC = memoryStore();
    await expect(
      acquireRunClaims(storeC, () => broken, scope("c"), [RESOURCE], T0),
    ).resolves.toEqual({ contended: [] });
    expect(storeC.list("run_c_1")[0]?.claimId).toBeNull();
  });

  it("renews only the run's own Claim, never the holder's", async () => {
    const fake = fakeShard();
    const storeA = memoryStore();
    const storeB = memoryStore();
    await acquireRunClaims(storeA, () => fake.shard, scope("a"), [RESOURCE], T0);
    await acquireRunClaims(storeB, () => fake.shard, scope("b"), [RESOURCE], T0);

    const tick = T0 + RENEW_AFTER_MS;
    fake.setNow(tick);
    fake.calls.length = 0;
    const again = await renewRunClaims(storeB, () => fake.shard, scope("b"), tick);
    // B asks again (still held, reported once only) and never sends a renewal for A's Claim.
    expect(fake.calls).toEqual(["acquire:b"]);
    expect(again.contended).toEqual([]);
    expect(fake.claims.get("claim-1")?.leaseExpiresAt).toBe(T0 + CLAIM_TTL_MS);

    await renewRunClaims(storeA, () => fake.shard, scope("a"), tick);
    expect(fake.calls).toEqual(["acquire:b", "renew:claim-1:a"]);
    expect(fake.claims.get("claim-1")?.leaseExpiresAt).toBe(tick + CLAIM_TTL_MS);
  });

  it("makes no request well before half-life, and renews a slightly early tick", async () => {
    const fake = fakeShard();
    const store = memoryStore();
    await acquireRunClaims(store, () => fake.shard, scope("a"), [RESOURCE], T0);
    fake.calls.length = 0;
    const early = T0 + RENEW_AFTER_MS - TICK_SLACK_MS - 1;
    await renewRunClaims(store, () => fake.shard, scope("a"), early);
    expect(fake.calls).toEqual([]);
    // The run check can fire a few milliseconds before half-life; it must still renew.
    const tick = T0 + RENEW_AFTER_MS - 5;
    fake.setNow(tick);
    await renewRunClaims(store, () => fake.shard, scope("a"), tick);
    expect(fake.calls).toEqual(["renew:claim-1:a"]);
  });

  it("releases idempotently", async () => {
    const fake = fakeShard();
    const store = memoryStore();
    await acquireRunClaims(store, () => fake.shard, scope("a"), [RESOURCE], T0);
    expect(await releaseRunClaims(store, () => fake.shard, scope("a"))).toBe(1);
    expect(fake.claims.get("claim-1")?.status).toBe("released");
    fake.calls.length = 0;
    expect(await releaseRunClaims(store, () => fake.shard, scope("a"))).toBe(0);
    expect(fake.calls).toEqual([]);
    // The shard side is a no-op success too.
    await expect(fake.shard.releaseClaim({ claimId: "claim-1", agentId: "a" })).resolves.toEqual({
      ok: true,
    });
  });

  it("lets an unrenewed Claim expire and hands the resource to the waiting agent", async () => {
    const fake = fakeShard();
    const storeA = memoryStore();
    const storeB = memoryStore();
    await acquireRunClaims(storeA, () => fake.shard, scope("a"), [RESOURCE], T0);
    await acquireRunClaims(storeB, () => fake.shard, scope("b"), [RESOURCE], T0);

    // Agent A died: it never renews. B's tick after the lease end gets a fresh Claim.
    const late = T0 + CLAIM_TTL_MS;
    fake.setNow(late);
    await renewRunClaims(storeB, () => fake.shard, scope("b"), late);
    expect(fake.claims.get("claim-1")?.status).toBe("expired");
    const [row] = storeB.list("run_b_1");
    expect(row?.claimId).toBe("claim-2");
    // The contention stays recorded for conflict detection.
    expect(row?.holderClaimId).toBe("claim-1");
    // A late renewal from A cannot revive or extend its expired Claim.
    await renewRunClaims(storeA, () => fake.shard, scope("a"), late);
    expect(fake.claims.get("claim-1")?.status).toBe("expired");
    expect(storeA.list("run_a_1")[0]?.claimId).toBeNull();
  });

  it("releases a Claim granted after the run already ended", async () => {
    const fake = fakeShard();
    const store = memoryStore();
    let finish: (v: AcquireOutcome) => void = () => {};
    const slow: ClaimShard = {
      ...fake.shard,
      acquireClaim: (input) =>
        new Promise((resolve) => {
          finish = resolve;
          void fake.shard.acquireClaim(input);
        }),
    };
    const pending = acquireRunClaims(store, () => slow, scope("a"), [RESOURCE], T0);
    await releaseRunClaims(store, () => fake.shard, scope("a"));
    finish({ ok: true, claim: { claimId: "claim-1", leaseExpiresAt: T0 + CLAIM_TTL_MS } });
    await pending;
    expect(fake.claims.get("claim-1")?.status).toBe("released");
    expect(store.list("run_a_1")).toEqual([]);
  });
});
