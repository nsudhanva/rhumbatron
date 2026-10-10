import { describe, expect, it } from "vitest";
import { recomposeDecision } from "./app-release-model.ts";
import {
  losingCriterionIds,
  nothingSelected,
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

describe("partial selection keeps only real work", () => {
  const c = (id: string, text: string) => ({ id, text });
  it("treats a quality-gate-only remainder as nothing selected", () => {
    expect(nothingSelected([c("c3", "typecheck, test and contract all pass")])).toBe(true);
    expect(nothingSelected([c("c3", "bun test passes")])).toBe(true);
    expect(nothingSelected([])).toBe(true);
  });
  it("keeps a remainder with a product criterion", () => {
    expect(
      nothingSelected([
        c("c1", "Each day shows a Clear completed button that deletes checked items"),
        c("c3", "typecheck, test and contract all pass"),
      ]),
    ).toBe(false);
    // A product criterion that mentions tests is not a quality gate.
    expect(
      nothingSelected([
        c(
          "c2",
          "Adding a todo with an empty title shows an error and the test for it passes when the user retries",
        ),
      ]),
    ).toBe(false);
  });
});

describe("a losing request keeps nothing that presupposes its conflicting criterion", () => {
  const c = (id: string, text: string) => ({ id, text });
  // Live on prod 2026-10-10 (recipe-app): the review cited only the direct pair.
  const owner = [c("c1", "Home page shows recipes as a table with one row per recipe")];
  const cards = [
    c("c1", "Recipe list renders as a grid of large cards, three per row"),
    c("c2", "Each card shows the recipe title"),
  ];
  const direct = {
    verdict: "conflicting",
    conflicts: [{ a: "c1", b: "c1", why: "Table rows versus a card grid" }],
  };
  it("validates dependents by side and fails closed on any invalid citation", () => {
    const withDependents = (dependentOnConflict: unknown) =>
      validateRequestReview({ ...direct, dependentOnConflict }, owner, cards);
    expect(withDependents([{ side: "b", id: "c2", on: "c1" }]).supported).toBe(true);
    for (const invalid of [
      [{ side: "b", id: "c9", on: "c1" }], // unknown id on that side
      [{ side: "a", id: "c2", on: "c1" }], // id of the other side
      [{ side: "b", id: "c1", on: "c2" }], // on is not a cited conflict
      [
        { side: "b", id: "c2", on: "c3" },
        { side: "b", id: "c3", on: "c2" },
      ], // a cycle that never reaches a conflict
      [{ id: "c2", on: "c1" }], // no side
    ])
      expect(withDependents(invalid)).toMatchObject({ supported: false, verdict: "conflicting" });
    expect(
      validateRequestReview(
        {
          verdict: "compatible",
          conflicts: [],
          dependentOnConflict: [{ side: "b", id: "c2", on: "c1" }],
        },
        owner,
        cards,
      ).supported,
    ).toBe(false);
  });
  it("excludes cited criteria plus transitive dependents of the same side", () => {
    const loser = [
      ...cards,
      c("c3", "The card title links to the recipe"),
      c("c4", "Add a print button"),
    ];
    const review = validateRequestReview(
      {
        ...direct,
        dependentOnConflict: [
          { side: "b", id: "c2", on: "c1" },
          { side: "b", id: "c3", on: "c2" },
        ],
      },
      owner,
      loser,
    );
    expect(losingCriterionIds(review, "b", loser, owner)).toEqual(["c1", "c2", "c3"]);
  });
  it("excludes the prod card criterion without a model dependent, so nothing is selected", () => {
    const review = validateRequestReview(direct, owner, cards);
    const lost = losingCriterionIds(review, "b", cards, owner);
    expect(lost).toEqual(["c1", "c2"]);
    expect(nothingSelected(selectedCriteria(cards, lost))).toBe(true);
  });
  it("keeps an independent criterion and one that names the winner's layout", () => {
    const loser = [
      ...cards,
      c("c3", "Add a print button to each recipe"),
      c("c4", "The recipe list is sorted by title"),
      c("c5", "Each table row and card shows the cook time"),
      c("c6", "typecheck, test and contract all pass"),
    ];
    const review = validateRequestReview(direct, owner, loser);
    const lost = losingCriterionIds(review, "b", loser, owner);
    expect(lost).toEqual(["c1", "c2"]);
    expect(nothingSelected(selectedCriteria(loser, lost))).toBe(false);
  });
  it("applies to the earlier side too, and never to an unsupported or compatible review", () => {
    const review = validateRequestReview(
      { ...direct, conflicts: [{ a: "c1", b: "c1", why: "x" }] },
      cards,
      owner,
    );
    expect(losingCriterionIds(review, "a", cards, owner)).toEqual(["c1", "c2"]);
    expect(
      losingCriterionIds(validateRequestReview(null, owner, cards), "b", cards, owner),
    ).toEqual([]);
    expect(
      losingCriterionIds(
        validateRequestReview({ verdict: "compatible", conflicts: [] }, owner, cards),
        "b",
        cards,
        owner,
      ),
    ).toEqual([]);
  });
});
