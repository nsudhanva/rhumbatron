import { describe, expect, it } from "vitest";
import { recomposeDecision } from "./app-release-model.ts";
import {
  priorityWins,
  type RequestInput,
  requestsOverlap,
  resourceTokens,
  reviewRequests,
  selectedCriteria,
  validateRequestReview,
} from "./request-policy.ts";

const a: RequestInput = {
  changeId: "a",
  goal: "Newest first",
  requesterUserId: "alice",
  requesterRank: 0,
  criteria: [{ id: "c1", text: "GET /api/products sorts newest first" }],
  resources: ["project:shop:api:product-order"],
  scoped: true,
};
const b: RequestInput = {
  ...a,
  changeId: "b",
  goal: "Oldest first",
  requesterUserId: "bob",
  requesterRank: 10,
  criteria: [{ id: "c1", text: "GET /api/products sorts oldest first" }],
};
describe("request compatibility boundaries", () => {
  it("drops the project prefix and generic tokens, then intersects resources or HTTP routes", () => {
    expect(resourceTokens(["project:shop-name:api:product-order", "ui:cart"])).toEqual(
      new Set(["product", "order", "cart"]),
    );
    expect(requestsOverlap(a, { ...b, resources: ["ui:product-display"] })).toBe(true);
    expect(requestsOverlap(a, { ...b, resources: ["cart:checkout"] })).toBe(true);
    expect(
      requestsOverlap(a, {
        ...b,
        resources: ["cart:checkout"],
        criteria: [{ id: "c1", text: "GET /api/cart works" }],
      }),
    ).toBe(false);
    expect(requestsOverlap(a, { ...b, scoped: false })).toBe(true);
  });
  it("never calls a model for independent requests", async () => {
    let calls = 0;
    const result = await reviewRequests(
      a,
      { ...b, resources: ["cart"], criteria: [] },
      async () => {
        calls++;
        throw Error("must not call");
      },
    );
    expect(calls).toBe(0);
    expect(result.review.verdict).toBe("independent");
  });
  it("validates citations by side and fails closed on malformed, empty, or abstaining output", () => {
    const valid = {
      verdict: "conflicting",
      conflicts: [{ a: "c1", b: "c1", why: "Sort directions differ" }],
    };
    expect(validateRequestReview(valid, a.criteria, b.criteria).supported).toBe(true);
    expect(
      validateRequestReview(
        { verdict: "conflicting", conflicts: [{ a: "b1", b: "a1", why: "wrong side" }] },
        [{ id: "a1", text: "A" }],
        [{ id: "b1", text: "B" }],
      ).supported,
    ).toBe(false);
    for (const raw of [
      null,
      {},
      { verdict: "abstain", conflicts: [] },
      { ...valid, conflicts: [] },
      { ...valid, conflicts: [{ a: "c99", b: "c1", why: "bad" }] },
    ]) {
      expect(validateRequestReview(raw, a.criteria, b.criteria)).toMatchObject({
        verdict: "conflicting",
        supported: false,
        reason: "review could not confirm compatibility",
      });
    }
  });
  it("selects owner priority, supersedes the same requester, and waits on equal ranks", () => {
    expect(priorityWins(a, b)).toEqual({ winner: "a", loser: "b" });
    expect(priorityWins({ ...a, requesterRank: 10 }, { ...b, requesterRank: 0 })).toEqual({
      winner: "b",
      loser: "a",
    });
    expect(priorityWins(a, { ...b, requesterUserId: "alice" })).toEqual({
      winner: "b",
      loser: "a",
    });
    expect(priorityWins(a, { ...b, requesterRank: 0 })).toEqual({ awaitingOwner: true });
    expect(
      selectedCriteria([...b.criteria, { id: "c2", text: "Cart remains available" }], ["c1"]),
    ).toEqual([{ id: "c2", text: "Cart remains available" }]);
  });
  it("refuses recomposition for every blocked status and losing outcome", () => {
    const facts = {
      candidateStatus: "stale",
      recomposeCount: 0,
      changeStatus: "running",
      baseGeneration: 1,
      canonicalGeneration: 2,
      isRollback: false,
      siblingPromoted: false,
    };
    for (const changeStatus of ["not_selected", "cancelled", "awaiting_owner"])
      expect(recomposeDecision({ ...facts, changeStatus })).toEqual({
        kind: "skip",
        reason: "change_closed",
      });
    for (const changeOutcome of ["not_selected", "overridden"])
      expect(recomposeDecision({ ...facts, changeOutcome })).toEqual({
        kind: "skip",
        reason: "change_closed",
      });
  });
});
