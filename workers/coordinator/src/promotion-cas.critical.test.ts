import { describe, expect, it } from "vitest";
import { type CanonicalState, decidePromotion, type PromotionAttempt } from "./promotion-cas.ts";

const s1841: CanonicalState = {
  generation: 1841,
  artifactRef: "acme-shop@main",
  treeSha: "tree-1841",
  lastPromotedCandidateId: "cand-prev",
};

const attempt = (overrides: Partial<PromotionAttempt> = {}): PromotionAttempt => ({
  candidateId: "cand-b",
  expectedGeneration: 1841,
  expectedTreeSha: "tree-1841",
  candidateArtifactRef: "acme-shop@cand-b",
  candidateTreeSha: "tree-cand-b",
  ...overrides,
});

describe("decidePromotion", () => {
  it("advances exactly one generation to the candidate tree", () => {
    expect(decidePromotion(s1841, attempt())).toEqual({
      kind: "advance",
      next: { generation: 1842, artifactRef: "acme-shop@cand-b", treeSha: "tree-cand-b" },
    });
  });

  it("rejects a stale expected generation", () => {
    const decision = decidePromotion(s1841, attempt({ expectedGeneration: 1840 }));
    expect(decision).toMatchObject({ kind: "stale", reason: "generation_mismatch" });
  });

  it("rejects a changed canonical tree when the tree check is enabled", () => {
    const decision = decidePromotion(s1841, attempt({ expectedTreeSha: "tree-other" }));
    expect(decision).toMatchObject({ kind: "stale", reason: "tree_mismatch" });
  });

  it("skips the tree check when no expected tree is given", () => {
    const { expectedTreeSha: _, ...withoutTree } = attempt();
    expect(decidePromotion(s1841, withoutTree).kind).toBe("advance");
  });

  it("treats a retry of the winning promotion as already promoted", () => {
    const s1842: CanonicalState = {
      generation: 1842,
      artifactRef: "acme-shop@cand-b",
      treeSha: "tree-cand-b",
      lastPromotedCandidateId: "cand-b",
    };
    expect(decidePromotion(s1842, attempt())).toEqual({
      kind: "already_promoted",
      generation: 1842,
    });
  });

  it("marks the losing candidate of a race as stale", () => {
    const s1842: CanonicalState = {
      generation: 1842,
      artifactRef: "acme-shop@cand-b",
      treeSha: "tree-cand-b",
      lastPromotedCandidateId: "cand-b",
    };
    const decision = decidePromotion(s1842, attempt({ candidateId: "cand-a" }));
    expect(decision).toMatchObject({ kind: "stale", reason: "generation_mismatch" });
  });
});
