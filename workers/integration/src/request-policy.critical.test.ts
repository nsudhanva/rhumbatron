import { BudgetStopError, type CompletionResult, ModelCallError } from "@rhumbatron/model-router";
import { describe, expect, it } from "vitest";
import { recomposeDecision } from "./app-release-model.ts";
import {
  nothingSelected,
  type RequestInput,
  requestsOverlap,
  resourceTokens,
  reviewRequests,
  stem,
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
    // Seen on prod: "gifts" and "gifting" named one feature, and the pair was never reviewed.
    expect(
      requestsOverlap(
        { ...a, resources: ["project:quiet-hours:units:gifts"] },
        { ...b, resources: ["project:quiet-hours:minutes:gifting"] },
      ),
    ).toBe(true);
    expect(["votes", "voting", "vote", "swapping", "swaps", "gifted"].map(stem)).toEqual([
      "vot",
      "vot",
      "vot",
      "swap",
      "swap",
      "gift",
    ]);
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
  it("retries a failed review call once, and never retries a budget stop", async () => {
    let calls = 0;
    const reply = {
      toolCalls: [
        {
          function: {
            name: "review_requests",
            arguments: JSON.stringify({ verdict: "compatible", conflicts: [] }),
          },
        },
      ],
      costUsd: 0.01,
      model: "claude-sonnet-5-5",
      inputTokens: 1,
      outputTokens: 1,
      gatewayLogId: null,
    } as unknown as CompletionResult;
    const flaky = await reviewRequests(a, b, async () => {
      calls++;
      if (calls === 1) throw new ModelCallError("transient", "connection reset", null);
      return reply;
    });
    expect(calls).toBe(2);
    expect(flaky.review).toMatchObject({ verdict: "compatible", supported: true });
    calls = 0;
    const stopped = await reviewRequests(a, b, async () => {
      calls++;
      throw new BudgetStopError({ limit: "change_budget" } as never);
    });
    expect(calls).toBe(1);
    expect(stopped.receipt).toMatchObject({ supported: false, failure: "budget:change_budget" });
  }, 10_000);
  it("never shows the review a breakage-guard or quality-gate criterion", async () => {
    let sent = "";
    await reviewRequests(
      {
        ...a,
        criteria: [
          ...a.criteria,
          { id: "g1", text: "Other pages and API routes behave as before" },
        ],
      },
      { ...b, criteria: [...b.criteria, { id: "g2", text: "typecheck, test and contract pass" }] },
      async (req) => {
        sent = JSON.stringify(req.messages);
        throw new BudgetStopError({ limit: "change_budget" } as never);
      },
    );
    expect(sent).not.toContain("behave as before");
    expect(sent).not.toContain("contract pass");
    expect(sent).toContain(a.criteria[0]?.text.slice(0, 20));
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
  it("accepts builds_on only with cited criteria of both sides, and fails closed otherwise", () => {
    const builds = {
      verdict: "builds_on",
      conflicts: [],
      builds: [{ a: "c1", b: "c1", why: "B adds a palette option to the canvas A creates" }],
    };
    expect(validateRequestReview(builds, a.criteria, b.criteria)).toMatchObject({
      verdict: "builds_on",
      supported: true,
    });
    for (const raw of [
      { verdict: "builds_on", conflicts: [] },
      { ...builds, builds: [{ a: "c99", b: "c1", why: "no such criterion" }] },
      { verdict: "compatible", conflicts: [], builds: builds.builds },
    ])
      expect(validateRequestReview(raw, a.criteria, b.criteria).supported).toBe(false);
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

describe("quality-gate criteria", () => {
  const c = (id: string, text: string) => ({ id, text });
  it("treats a quality-gate-only list as nothing selected", () => {
    expect(nothingSelected([c("c3", "typecheck, test and contract all pass")])).toBe(true);
    expect(nothingSelected([c("c3", "bun test passes")])).toBe(true);
    expect(nothingSelected([])).toBe(true);
  });
  it("keeps a list with a product criterion", () => {
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
