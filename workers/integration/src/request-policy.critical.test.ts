import { describe, expect, it } from "vitest";
import { recomposeDecision } from "./app-release-model.ts";
import { UNKNOWN_CANONICAL } from "./intake-context.ts";
import {
  arbiterDecision,
  arbiterItemIds,
  arbitrateRequests,
  losingCriterionIds,
  nothingSelected,
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
  criteria: [{ id: "c1", text: "GET /api/products sorts newest first" }],
  resources: ["project:shop:api:product-order"],
  scoped: true,
};
const b: RequestInput = {
  ...a,
  changeId: "b",
  goal: "Oldest first",
  requesterUserId: "bob",
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
  it("accepts a duplicate only when every covered quote is text of the cited earlier criterion", () => {
    const covered = (quote: string, aId = "c1", bId = "c1") => ({
      verdict: "duplicate",
      conflicts: [],
      covered: [{ a: aId, b: bId, quote }],
    });
    expect(
      validateRequestReview(covered("sorts newest first"), a.criteria, b.criteria),
    ).toMatchObject({ verdict: "duplicate", supported: true });
    for (const raw of [
      covered("sorts by price"),
      covered("sorts newest first", "c9"),
      covered("sorts newest first", "c1", "c9"),
      { verdict: "duplicate", conflicts: [] },
      { ...covered("sorts newest first"), verdict: "compatible" },
    ])
      expect(validateRequestReview(raw, a.criteria, b.criteria).supported).toBe(false);
    expect(
      selectedCriteria([...b.criteria, { id: "c2", text: "Cart remains available" }], ["c1"]),
    ).toEqual([{ id: "c2", text: "Cart remains available" }]);
  });
  it("arbitrates only on two agreeing, cited runs in swapped order; anything else asks", async () => {
    const items = arbiterItemIds([{ a: "c1", b: "c1" }], UNKNOWN_CANONICAL);
    expect([...items]).toEqual(["a:goal", "b:goal", "conflict:1"]);
    const vote = (verdict: string, cites = true) => ({
      provider: "anthropic" as const,
      model: "claude-sonnet-5-5",
      tier: "sonnet" as const,
      content: null,
      toolCalls: [
        {
          id: "x",
          type: "function" as const,
          function: {
            name: "arbitrate_requests",
            arguments: JSON.stringify({
              verdict,
              rationale: "Fits the app",
              citedCriteria: cites ? [{ side: "a", id: "c1" }] : [{ side: "a", id: "c9" }],
              citedItems: ["conflict:1"],
            }),
          },
        },
      ],
      message: { role: "assistant" as const, content: null },
      finishReason: "tool_use",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
      latencyMs: 1,
      gatewayLogId: null,
    });
    const run = (first: ReturnType<typeof vote>, second: ReturnType<typeof vote>) => {
      const replies = [first, second];
      return arbitrateRequests(
        a,
        b,
        [{ a: "c1", b: "c1", why: "x" }],
        UNKNOWN_CANONICAL,
        async () => replies.shift() as ReturnType<typeof vote>,
      );
    };
    // The swapped run sees B as "a": prefer_b there is prefer_a in the real frame.
    expect((await run(vote("prefer_a"), vote("prefer_b"))).decision).toBe("prefer_a");
    expect((await run(vote("prefer_b"), vote("prefer_a"))).decision).toBe("prefer_b");
    // Position bias: both runs prefer whatever is shown first. Not an agreement.
    expect((await run(vote("prefer_a"), vote("prefer_a"))).decision).toBe("ask");
    expect((await run(vote("prefer_a"), vote("ask"))).decision).toBe("ask");
    // An invented citation makes the run unsupported, even when both runs agree.
    expect((await run(vote("prefer_a", false), vote("prefer_b"))).decision).toBe("ask");
    expect(
      arbiterDecision(
        { verdict: "prefer_a", rationale: "x", supported: true },
        { verdict: "prefer_b", rationale: "x", supported: false },
      ),
    ).toBe("ask");
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
    for (const changeStatus of ["not_selected", "cancelled", "needs_input"])
      expect(recomposeDecision({ ...facts, changeStatus })).toEqual({
        kind: "skip",
        reason: "change_closed",
      });
    for (const changeOutcome of ["not_selected", "duplicate"])
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
