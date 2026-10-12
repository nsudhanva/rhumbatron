// Feed cursor invariant: a reader that follows `after = nextAfter` while
// `hasMore` sees every recorded event exactly once, in any burst size, and `before` pages back
// through older events without gaps. The SQL in the API is `WHERE seq <op> ? ORDER BY seq <order>
// LIMIT <take>`; `read` below is the same selection over an array.
import { describe, expect, it } from "vitest";
import { ClaimFact, FeedQuery, foldClaims, planFeedQuery, toFeedPage } from "./activity.ts";

type Row = { seq: number };

function read(table: Row[], raw: Record<string, unknown>) {
  const query = FeedQuery.parse(raw);
  const plan = planFeedQuery(query);
  const value = plan.value ?? 0;
  const rows = table
    .filter((r) => (plan.op === ">" ? r.seq > value : plan.op === "<" ? r.seq < value : true))
    .sort((a, b) => (plan.order === "ASC" ? a.seq - b.seq : b.seq - a.seq))
    .slice(0, plan.take);
  return toFeedPage(rows, query);
}

describe("feed cursor", () => {
  it("never skips or repeats an event while following `after` through bursts", () => {
    const table: Row[] = [];
    let next = 1;
    const append = (n: number) => {
      for (let i = 0; i < n; i += 1) table.push({ seq: next++ });
    };
    append(7);
    const first = read(table, { limit: 5 });
    expect(first.events.map((e) => e.seq)).toEqual([7, 6, 5, 4, 3]);
    expect(first.hasMore).toBe(true);

    const seen = new Set(first.events.map((e) => e.seq));
    let cursor = first.nextAfter;
    for (const burst of [0, 1, 4, 13, 2, 31]) {
      append(burst);
      let page = read(table, { after: cursor, limit: 5 });
      for (let guard = 0; guard < 20; guard += 1) {
        const seqs = page.events.map((e) => e.seq);
        // Newest first within a page.
        expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
        for (const seq of seqs) {
          expect(seen.has(seq)).toBe(false);
          seen.add(seq);
        }
        cursor = page.nextAfter;
        if (!page.hasMore) break;
        page = read(table, { after: cursor, limit: 5 });
      }
      expect(cursor).toBe(next - 1);
    }
    // Everything after the first page's oldest row was seen exactly once.
    for (let seq = 3; seq < next; seq += 1) expect(seen.has(seq)).toBe(true);
  });

  it("keeps the cursor when nothing new arrived", () => {
    const page = read([{ seq: 1 }, { seq: 2 }], { after: 2 });
    expect(page.events).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextAfter).toBe(2);
  });

  it("pages back with `before` without gaps", () => {
    const table = Array.from({ length: 23 }, (_, i) => ({ seq: i + 1 }));
    const collected: number[] = [];
    let page = read(table, { limit: 10 });
    collected.push(...page.events.map((e) => e.seq));
    while (page.hasMore && page.nextBefore !== null) {
      page = read(table, { before: page.nextBefore, limit: 10 });
      collected.push(...page.events.map((e) => e.seq));
    }
    expect(collected).toEqual(Array.from({ length: 23 }, (_, i) => 23 - i));
  });

  it("rejects after and before together, and caps the limit", () => {
    expect(FeedQuery.safeParse({ after: 1, before: 5 }).success).toBe(false);
    expect(FeedQuery.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("claim fold", () => {
  const fact = (seq: number, action: ClaimFact["action"], at: string, lease: string | null) => ({
    seq,
    eventId: `evt_${seq}`,
    action,
    claimId: "c1",
    agentId: "agent_1",
    resource: "project:acme:cart",
    leaseExpiresAt: lease,
    occurredAt: at,
  });

  it("reports a lapsed active lease as expired before the shard emits claim.expired", () => {
    const facts = [fact(1, "acquired", "2026-10-09T10:00:00.000Z", "2026-10-09T10:05:00.000Z")];
    expect(foldClaims(facts, Date.parse("2026-10-09T10:01:00.000Z"))[0]?.status).toBe("active");
    expect(foldClaims(facts, Date.parse("2026-10-09T10:05:00.000Z"))[0]?.status).toBe("expired");
  });

  it("keeps the latest action and the first acquisition time", () => {
    const [claim] = foldClaims(
      [
        fact(1, "acquired", "2026-10-09T10:00:00.000Z", "2026-10-09T10:05:00.000Z"),
        fact(2, "renewed", "2026-10-09T10:04:00.000Z", "2026-10-09T10:09:00.000Z"),
        fact(3, "released", "2026-10-09T10:06:00.000Z", "2026-10-09T10:09:00.000Z"),
      ],
      Date.parse("2026-10-09T10:07:00.000Z"),
    );
    expect(claim).toMatchObject({
      status: "released",
      acquiredAt: "2026-10-09T10:00:00.000Z",
      leaseExpiresAt: "2026-10-09T10:09:00.000Z",
    });
  });

  const contention = (seq = 2) =>
    ClaimFact.parse({
      ...fact(seq, "contended", "2026-10-09T10:01:00.000Z", "2026-10-09T10:05:00.000Z"),
      agentId: `agent_contender_${seq}`,
      heldByAgentId: "agent_1",
    });

  it("records the contender and holder without changing the holder's lease state", () => {
    const acquired = fact(1, "acquired", "2026-10-09T10:00:00.000Z", "2026-10-09T10:05:00.000Z");
    const facts = [acquired, contention(), contention(3)];
    expect(facts[1]).toMatchObject({
      action: "contended",
      agentId: "agent_contender_2",
      heldByAgentId: "agent_1",
      claimId: "c1",
      resource: "project:acme:cart",
      occurredAt: "2026-10-09T10:01:00.000Z",
    });
    const now = Date.parse("2026-10-09T10:02:00.000Z");
    expect(foldClaims(facts, now)).toEqual(foldClaims([acquired], now));
    expect(foldClaims(facts, Date.parse("2026-10-09T10:05:00.000Z"))[0]?.status).toBe("expired");
  });

  it("does not create a lease from contention alone when lifecycle facts are absent", () => {
    expect(foldClaims([contention()], Date.parse("2026-10-09T10:02:00.000Z"))).toEqual([]);
  });

  it.each(["released", "expired"] as const)(
    "does not revive a %s Claim on contention",
    (action) => {
      const acquired = fact(1, "acquired", "2026-10-09T10:00:00.000Z", "2026-10-09T10:05:00.000Z");
      const ended = fact(2, action, "2026-10-09T10:05:00.000Z", null);
      const contended = {
        ...contention(3),
        occurredAt: "2026-10-09T10:06:00.000Z",
        leaseExpiresAt: "2026-10-09T10:10:00.000Z",
      };
      const now = Date.parse("2026-10-09T10:07:00.000Z");
      expect(foldClaims([acquired, ended, contended], now)).toEqual(
        foldClaims([acquired, ended], now),
      );
    },
  );
});
