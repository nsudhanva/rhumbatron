// Semantic conflict first pass (AGENTS.md section 32): a wrong answer either lets two incompatible
// designs merge silently or forks Candidates for overlaps that only add.
import type { Intent } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { intentFromDeclaration } from "./declaration.ts";
import { detectConflicts, forkDecision } from "./detect.ts";
import { assumptionsContradict, modelFromText } from "./normalize.ts";

const intent = (overrides: Partial<Intent> & Pick<Intent, "intentId" | "taskId">): Intent => ({
  agentId: `agent-${overrides.taskId}`,
  summary: "Change something",
  semanticResources: [],
  expectedFiles: [],
  expectedSymbols: [],
  expectedContractChanges: [],
  expectedDataChanges: [],
  expectedSideEffects: [],
  assumptions: [],
  createdAt: "2026-10-08T00:00:00.000Z",
  ...overrides,
});

const relational = intent({
  intentId: "int-a",
  taskId: "task-a",
  summary: "Store collaborators in a normalized membership table",
  semanticResources: ["wishlist:membership"],
  expectedFiles: ["src/wishlist/membership.ts", "migrations/0005_wishlist_members.sql"],
  expectedContractChanges: [
    {
      target: "POST /v1/wishlists/:id/collaborators",
      kind: "add",
      shape: "{ userId: string }",
      description: "Add a collaborator",
    },
  ],
  expectedDataChanges: [
    {
      entity: "wishlist_members",
      kind: "add",
      model: "mutable_table",
      description: "Create wishlist_members; revoke deletes the row",
    },
  ],
});

const appendOnly = intent({
  intentId: "int-b",
  taskId: "task-b",
  summary: "Record membership as an append-only event log",
  semanticResources: ["project:acme:wishlist:membership"],
  expectedFiles: [
    "src/wishlist/membership-log.ts",
    "migrations/0005_wishlist_membership_events.sql",
  ],
  expectedContractChanges: [
    {
      target: "POST /v1/wishlists/{wishlistId}/collaborators",
      kind: "add",
      shape: "{userId: string;}",
      description: "Add a collaborator",
    },
  ],
  expectedDataChanges: [
    {
      entity: "wishlist_membership_events",
      kind: "add",
      model: "append_only",
      description: "Append join and revoke events",
    },
  ],
});

describe("detectConflicts", () => {
  it("confirms the Wishlist relational vs append-only design conflict and forks Candidates", () => {
    const [report, ...rest] = detectConflicts([appendOnly, relational]);
    expect(rest).toEqual([]);
    expect(report?.intentIds).toEqual(["int-a", "int-b"]);
    expect(report?.resource).toBe("wishlist:membership");
    expect(report?.state).toBe("confirmed");
    expect(report?.recommendedAction).toBe("fork_candidates");
    expect(report?.signals.map((s) => [s.kind, s.severity])).toEqual([
      ["data_model_conflict", "hard"],
      ["contract_overlap", "benign"],
      ["resource_overlap", "benign"],
    ]);
    // No shared file: Git would merge both designs without a textual conflict.
    expect(report?.signals.some((s) => s.kind === "file_overlap")).toBe(false);
    if (!report) throw new Error("expected a report");
    expect(forkDecision(report)).toMatchObject({
      kind: "fork",
      candidateIntentIds: ["int-a", "int-b"],
    });
  });

  it("detects the same conflict from the string Intents an agent declares", () => {
    const meta = (id: string) => ({
      intentId: `int-${id}`,
      taskId: `task-${id}`,
      agentId: `agent-${id}`,
      createdAt: "2026-10-08T00:00:00.000Z",
    });
    const a = intentFromDeclaration(
      {
        summary: "Collaborator membership as a relational table",
        semanticResources: ["wishlist:membership"],
        expectedFiles: ["src/wishlist/members.ts"],
        expectedContractChanges: ["Add POST /v1/wishlists/:id/collaborators {userId}"],
        expectedDataChanges: [
          "Create table wishlist_collaborators (wishlist_id, user_id); rows updated in place on revoke",
        ],
        assumptions: ["Collaborator rows are mutable"],
      },
      meta("a"),
    );
    const b = intentFromDeclaration(
      {
        summary: "Concurrency-safe membership: append-only, no in-place updates",
        semanticResources: ["project:acme:wishlist:membership"],
        expectedFiles: ["src/wishlist/membership-events.ts"],
        expectedContractChanges: ["Add POST /v1/wishlists/{id}/collaborators {userId}"],
        expectedDataChanges: ["Add wishlist_membership_events (wishlist_id, user_id, op, at)"],
        assumptions: ["Collaborator rows are immutable"],
      },
      meta("b"),
    );
    expect(a.expectedDataChanges[0]).toMatchObject({
      entity: "wishlist_collaborators",
      kind: "add",
      model: "mutable_table",
    });
    expect(b.expectedDataChanges[0]).toMatchObject({
      entity: "wishlist_membership_events",
      model: "append_only",
    });
    const [report] = detectConflicts([a, b]);
    expect(report?.state).toBe("confirmed");
    expect(report?.recommendedAction).toBe("fork_candidates");
    expect(report?.signals.map((s) => s.kind)).toEqual([
      "data_model_conflict",
      "assumption_conflict",
      "contract_overlap",
      "resource_overlap",
    ]);
  });

  it("dismisses two additive Intents on one resource", () => {
    const addField = (id: string, column: string) =>
      intent({
        intentId: `int-${id}`,
        taskId: `task-${id}`,
        semanticResources: ["wishlist"],
        expectedFiles: ["./src/wishlist/schema.ts"],
        expectedDataChanges: [
          {
            entity: "wishlists",
            kind: "add",
            model: "mutable_table",
            description: `add column ${column}`,
          },
        ],
      });
    const reports = detectConflicts([addField("a", "note"), addField("b", "color")]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ state: "none", recommendedAction: "dismiss" });
    expect(reports[0]?.signals.every((s) => s.severity === "benign")).toBe(true);
    if (reports[0])
      expect(forkDecision(reports[0])).toEqual({ kind: "no_fork", reason: "benign_overlap" });
    expect(
      detectConflicts([addField("a", "note"), addField("b", "color")], { includeDismissed: false }),
    ).toEqual([]);
  });

  it("keeps an additive overlap on a protected resource in review", () => {
    const addCart = (id: string) =>
      intent({ intentId: `int-${id}`, taskId: `task-${id}`, semanticResources: ["cart:totals"] });
    const [report] = detectConflicts([addCart("a"), addCart("b")], {
      protectedResources: ["project:acme:cart"],
    });
    expect(report).toMatchObject({ state: "suspected", recommendedAction: "review" });
    expect(report?.signals.map((s) => s.kind)).toContain("invariant_reference");
  });

  it("raises a contended pair to at least suspected, and leaves confirmation to the Intents", () => {
    const addField = (id: string, column: string) =>
      intent({
        intentId: `int-${id}`,
        taskId: `task-${id}`,
        semanticResources: ["wishlist"],
        expectedDataChanges: [
          { entity: "wishlists", kind: "add", model: "mutable_table", description: column },
        ],
      });
    const contention = {
      resource: "project:acme:wishlist",
      agentId: "agent-task-b",
      holderAgentId: "agent-task-a",
      holderClaimId: "claim-1",
    };
    // Additive overlap alone is dismissed; the same pair under Claim contention needs review.
    const [report] = detectConflicts([addField("a", "note"), addField("b", "color")], {
      contentions: [contention],
    });
    expect(report).toMatchObject({ state: "suspected", recommendedAction: "review" });
    expect(report?.signals).toContainEqual(
      expect.objectContaining({ severity: "soft", evidenceRefs: ["claim:claim-1"] }),
    );
    // Contention between agents that declared no shared resource is still a signal.
    const apart = detectConflicts(
      [
        intent({ intentId: "int-a", taskId: "task-a", semanticResources: ["cart"] }),
        intent({ intentId: "int-b", taskId: "task-b", semanticResources: ["catalog"] }),
      ],
      { contentions: [contention] },
    );
    expect(apart).toHaveLength(1);
    expect(apart[0]).toMatchObject({ state: "suspected", resource: "wishlist" });
    // A hard Intent conflict stays confirmed; contention of other agents changes nothing.
    const hard = detectConflicts(
      [
        { ...relational, agentId: "agent-task-a" },
        { ...appendOnly, agentId: "agent-task-b" },
      ],
      { contentions: [contention] },
    );
    expect(hard[0]).toMatchObject({ state: "confirmed", recommendedAction: "fork_candidates" });
    expect(
      detectConflicts([addField("a", "note"), addField("b", "color")], {
        includeDismissed: false,
        contentions: [{ ...contention, holderAgentId: "agent-task-z" }],
      }),
    ).toEqual([]);
  });

  it("produces nothing for unrelated resources", () => {
    const wishlist = intent({
      intentId: "int-a",
      taskId: "task-a",
      semanticResources: ["wishlist:membership"],
      expectedFiles: ["src/wishlist.ts"],
    });
    const cart = intent({
      intentId: "int-b",
      taskId: "task-b",
      semanticResources: ["cart"],
      expectedFiles: ["src/cart.ts"],
    });
    // `wish` is not a colon-segment ancestor of `wishlist`.
    const wish = intent({ intentId: "int-c", taskId: "task-c", semanticResources: ["wish"] });
    expect(detectConflicts([wishlist, cart, wish])).toEqual([]);
  });

  it("flags incompatible contract changes that merge cleanly as text", () => {
    const api = intent({
      intentId: "int-api",
      taskId: "task-api",
      semanticResources: ["wishlist:api"],
      expectedFiles: ["src/routes/wishlist.ts"],
      expectedContractChanges: [
        {
          target: "GET /v1/wishlists/:id",
          kind: "modify",
          shape: "{ items: Product[] }",
          description: "Return full products",
        },
      ],
    });
    const web = intent({
      intentId: "int-web",
      taskId: "task-web",
      semanticResources: ["storefront:wishlist-page"],
      expectedFiles: ["src/pages/wishlist.tsx"],
      expectedContractChanges: [
        {
          target: "get /v1/wishlists/{wishlistId}/",
          kind: "modify",
          shape: "{ items: string[] }",
          description: "Expect product IDs",
        },
      ],
    });
    const [report] = detectConflicts([web, api]);
    expect(report?.state).toBe("confirmed");
    expect(report?.signals[0]).toMatchObject({
      kind: "contract_conflict",
      severity: "hard",
      evidenceRefs: ["intent:int-api:contract:0", "intent:int-web:contract:0"],
    });
    expect(report?.signals[0]?.detail).toContain("GET /v1/wishlists/:param");

    // The same shape with different whitespace agrees.
    const agreeing = {
      ...web,
      expectedContractChanges: [
        {
          ...api.expectedContractChanges[0],
          target: "GET /v1/wishlists/[id]",
          shape: "{items:Product[];}",
          description: "",
        },
      ],
    } as Intent;
    expect(detectConflicts([agreeing, api])[0]?.signals).toEqual([
      expect.objectContaining({ kind: "contract_overlap", severity: "benign" }),
    ]);
  });

  it("returns the same reports in the same order for any input order", () => {
    const third = intent({
      intentId: "int-0",
      taskId: "task-0",
      semanticResources: ["wishlist"],
      expectedDataChanges: [
        { entity: "wishlists", kind: "modify", model: "mutable_table", description: "" },
      ],
    });
    const forward = detectConflicts([relational, appendOnly, third]);
    const backward = detectConflicts([third, appendOnly, relational]);
    expect(backward).toEqual(forward);
    expect(forward.map((r) => r.intentIds)).toEqual([
      ["int-0", "int-a"],
      ["int-0", "int-b"],
      ["int-a", "int-b"],
    ]);
    for (const r of forward) expect(r.intentIds[0] < r.intentIds[1]).toBe(true);
  });

  it("never compares two Intents of the same Task", () => {
    expect(detectConflicts([relational, { ...appendOnly, taskId: "task-a" }])).toEqual([]);
  });
});

describe("forkDecision", () => {
  it("blocks a fork that would pass the Candidate limit", () => {
    const [report] = detectConflicts([relational, appendOnly]);
    if (!report) throw new Error("expected a report");
    expect(forkDecision(report, { activeCandidates: 2, maxCandidates: 3 })).toEqual({
      kind: "blocked",
      reason: "candidate_limit",
      maxCandidates: 3,
    });
    expect(forkDecision({ ...report, state: "resolved" })).toEqual({
      kind: "no_fork",
      reason: "already_resolved",
    });
    expect(forkDecision({ ...report, state: "suspected", recommendedAction: "review" })).toEqual({
      kind: "no_fork",
      reason: "needs_review",
    });
  });
});

describe("text heuristics", () => {
  it("reads negation and antonyms deterministically", () => {
    expect(
      assumptionsContradict(
        "Collaborators can remove products after the link is revoked",
        "Collaborators cannot remove products after the link is revoked",
      ),
    ).toBe(true);
    expect(
      assumptionsContradict("Membership rows are mutable", "Membership rows are immutable"),
    ).toBe(true);
    expect(assumptionsContradict("Owners can share", "Collaborators cannot delete wishlists")).toBe(
      false,
    );
    expect(modelFromText("append-only membership, no in-place updates")).toBe("append_only");
    expect(modelFromText("immutable ledger")).toBe("append_only");
    expect(modelFromText("normalized table updated in place")).toBe("mutable_table");
    expect(modelFromText("mutable table or event log")).toBe("unspecified");
  });
});
