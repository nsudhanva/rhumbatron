// Release safety: a gap must never look green, an unsupported finding must never move a Candidate,
// and composition must reject what it can prove incompatible (AGENTS.md sections 33, 34).
import type { EvidenceRecord, ProjectPolicy } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { parseBenchOutput } from "./bench.ts";
import { canAffectCandidate, type EvidenceSnapshot, validateCitations } from "./citations.ts";
import { type ComposableChangeSet, checkCompatibility } from "./compatibility.ts";
import { diffContract, parseRouteTable } from "./contract.ts";
import { gateRequiredChecks } from "./gate.ts";
import { buildVerificationPlan } from "./plan.ts";

const policy: ProjectPolicy = {
  version: "policy-1",
  maxCostUsdPerChange: 3,
  maxActiveAgents: 8,
  maxActiveSandboxes: 4,
  maxCandidates: 3,
  humanGateRiskTiers: ["high", "critical"],
  protectedResources: ["cart", "checkout", "identity.auth"],
  networkPolicy: "restricted",
  autoPromoteRiskTiers: ["low"],
  requiredChecksByRisk: {
    low: ["build", "targeted"],
    medium: ["build", "targeted", "contract"],
    high: ["build", "targeted", "contract", "security", "browser"],
  },
};

const touches = {
  authorization: false,
  performanceConstraint: false,
  protectedInvariants: [] as string[],
  ui: false,
};
const plan = (riskTier: ProjectPolicy["humanGateRiskTiers"][number], t: Partial<typeof touches>) =>
  buildVerificationPlan({ candidateId: "cand_b", riskTier, policy, touches: { ...touches, ...t } });
const ids = (p: ReturnType<typeof plan>) => p.requiredCheckIds;

describe("buildVerificationPlan", () => {
  it("high risk with UI requires security, browser, and a human gate", () => {
    const p = plan("high", { ui: true });
    expect(ids(p)).toEqual(
      expect.arrayContaining(["build", "unit", "contract", "security", "browser"]),
    );
    expect(p.humanApprovalRequired).toBe(true);
  });

  it("medium risk requires contract but no browser or security", () => {
    const p = plan("medium", { ui: true });
    expect(ids(p)).toContain("contract");
    expect(ids(p)).not.toContain("browser");
    expect(ids(p)).not.toContain("security");
  });

  it("a tier missing from policy uses the next stricter tier, never fewer checks", () => {
    expect(ids(plan("critical", {}))).toEqual(expect.arrayContaining(["contract", "security"]));
  });

  it("always requires the Cart invariant when a protected invariant names the Cart", () => {
    const invariants = [
      "Existing cart add, remove, quantity, and total behavior must remain unchanged.",
    ];
    for (const tier of ["low", "medium", "high"] as const) {
      const p = plan(tier, { protectedInvariants: invariants });
      const cart = p.checks.find((c) => c.checkId === "protected-invariant-cart");
      expect(cart?.command).toBe("bun test test/cart.invariant.test.ts");
      expect(ids(p)).toContain("protected-invariant-cart");
    }
  });

  it("authorization forces security Evidence and approval even at low risk", () => {
    const p = plan("low", { authorization: true });
    expect(ids(p)).toContain("security");
    expect(p.humanApprovalRequired).toBe(true);
  });
});

const ev = (checkId: string, over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  evidenceId: `ev_${checkId}`,
  candidateId: "cand_b",
  checkId,
  kind: checkId,
  status: "pass",
  coverage: "checked_supported",
  startedAt: "2026-10-08T10:00:00.000Z",
  completedAt: "2026-10-08T10:00:30.000Z",
  summary: "ok",
  contentHash: "sha256:abc",
  sourceRefs: [],
  ...over,
});

describe("gateRequiredChecks", () => {
  const p = plan("low", { performanceConstraint: true });
  const perf = ev("performance", { metrics: { p95Ms: 42 } });

  it("only checked_supported + pass satisfies every required check", () => {
    expect(gateRequiredChecks(p, [ev("build"), ev("unit"), perf])).toEqual({
      promotable: true,
      gaps: [],
    });
  });

  it("missing, skipped, error, and no-signal results are gaps, never green", () => {
    const cases: [EvidenceRecord[], string][] = [
      [[ev("build"), perf], "missing"],
      [[ev("build"), ev("unit", { status: "skipped", coverage: "not_checked" }), perf], "skipped"],
      [[ev("build"), ev("unit", { status: "error" }), perf], "error"],
      [[ev("build"), ev("unit", { status: "fail" }), perf], "failed"],
      [[ev("build"), ev("unit", { coverage: "checked_no_signal" }), perf], "no_signal"],
      [[ev("build"), ev("unit", { coverage: "not_checked" }), perf], "not_checked"],
    ];
    for (const [records, reason] of cases) {
      expect(gateRequiredChecks(p, records)).toEqual({
        promotable: false,
        gaps: [{ checkId: "unit", reason }],
      });
    }
  });

  it("a pass that ran past its timeout is a gap", () => {
    const late = ev("unit", { completedAt: "2026-10-08T11:00:00.000Z" });
    expect(gateRequiredChecks(p, [ev("build"), late, perf]).gaps).toEqual([
      { checkId: "unit", reason: "timed_out" },
    ]);
  });

  it("Evidence from another Candidate does not count", () => {
    const other = ev("unit", { candidateId: "cand_a" });
    expect(gateRequiredChecks(p, [ev("build"), other, perf]).gaps).toEqual([
      { checkId: "unit", reason: "missing" },
    ]);
  });

  it("a passing p95 record without the metric, or over budget, is a gap", () => {
    for (const metrics of [undefined, { p95Ms: 250 }]) {
      const bad = ev("performance", metrics ? { metrics } : {});
      expect(gateRequiredChecks(p, [ev("build"), ev("unit"), bad]).gaps).toEqual([
        { checkId: "performance", reason: "expectation_not_met" },
      ]);
    }
  });

  it("the latest record decides, so a later failure revokes an earlier pass", () => {
    const later = ev("unit", {
      status: "fail",
      startedAt: "2026-10-08T10:05:00.000Z",
      completedAt: "2026-10-08T10:05:30.000Z",
    });
    expect(gateRequiredChecks(p, [ev("build"), ev("unit"), later, perf]).promotable).toBe(false);
  });
});

describe("validateCitations", () => {
  const snapshot: EvidenceSnapshot = {
    projectId: "proj_acme",
    candidateId: "cand_b",
    evidence: [{ evidenceId: "ev_perf", candidateId: "cand_b" }],
    contextItems: [{ itemId: "ctx_task" }],
  };
  const finding = (citations: string[], over = {}) => ({
    findingId: "f1",
    projectId: "proj_acme",
    candidateId: "cand_b",
    citations,
    ...over,
  });

  it("a finding citing received Evidence and Context items is supported", () => {
    const v = validateCitations(finding(["ev_perf", "ctx_task"]), snapshot);
    expect(v.support).toBe("supported");
    expect(canAffectCandidate(v)).toBe(true);
  });

  it("invalid citations make a finding unsupported and unable to change Candidate state", () => {
    const known = new Set(["ev_perf", "ctx_task", "ev_hidden"]);
    const cases: [ReturnType<typeof finding>, string][] = [
      [finding([]), "no_citations"],
      [finding(["ev_invented"]), "unknown_id"],
      [finding(["ev_hidden"]), "not_in_snapshot"],
      [finding(["ev_perf"], { candidateId: "cand_a" }), "wrong_candidate"],
      [finding(["ev_perf"], { projectId: "proj_other" }), "wrong_project"],
    ];
    for (const [f, reason] of cases) {
      const v = validateCitations(f, snapshot, known);
      expect(v.support).toBe("unsupported");
      expect(v.citationErrors.map((e) => e.reason)).toContain(reason);
      expect(canAffectCandidate(v)).toBe(false);
    }
  });

  it("an unvalidated or forged finding cannot change Candidate state", () => {
    expect(canAffectCandidate(finding(["ev_perf"]))).toBe(false);
    expect(canAffectCandidate({ ...finding([]), support: "supported", citationErrors: [] })).toBe(
      false,
    );
  });
});

const cs = (
  id: string,
  over: {
    base?: number;
    files?: string[];
    contracts?: string[];
    data?: string[];
    dependsOn?: string[];
  } = {},
): ComposableChangeSet => ({
  id,
  baseGeneration: over.base ?? 1841,
  ...(over.dependsOn ? { dependsOn: over.dependsOn } : {}),
  intent: {
    expectedContractChanges: over.contracts ?? [],
    expectedDataChanges: over.data ?? [],
    changeSet: { files: over.files ?? [] },
  },
});

describe("checkCompatibility", () => {
  it("accepts disjoint ChangeSets on the same base", () => {
    const r = checkCompatibility(1841, [
      cs("a", { files: ["src/wishlist.ts"], contracts: ["POST /api/wishlists"] }),
      cs("b", { files: ["src/share.ts"], contracts: ["POST /api/wishlists/:id/share"] }),
    ]);
    expect(r).toEqual({ ok: true });
  });

  it("rejects a ChangeSet from another base generation", () => {
    expect(checkCompatibility(1841, [cs("a"), cs("b", { base: 1840 })])).toMatchObject({
      ok: false,
      kind: "base_mismatch",
    });
  });

  it("reports the same file changed by two ChangeSets as a source conflict", () => {
    const r = checkCompatibility(1841, [
      cs("a", { files: ["src/app.ts", "src/wishlist.ts"] }),
      cs("b", { files: ["src/app.ts"] }),
    ]);
    expect(r).toMatchObject({ ok: false, kind: "file_conflict" });
  });

  it("detects incompatible changes to one contract even when files do not overlap", () => {
    const r = checkCompatibility(1841, [
      cs("a", {
        files: ["src/wishlist-members.ts"],
        data: ["Add table wishlist_members (wishlist_id, user_id, role) - mutable rows"],
      }),
      cs("b", {
        files: ["src/wishlist-events.ts"],
        data: ["wishlist_members table: append-only membership events"],
      }),
    ]);
    expect(r).toMatchObject({ ok: false, kind: "contract_conflict" });
  });

  it("treats the same declared change from two ChangeSets as compatible", () => {
    const route = "GET /api/wishlists/:id - returns items";
    expect(
      checkCompatibility(1841, [cs("a", { contracts: [route] }), cs("b", { contracts: [route] })]),
    ).toEqual({ ok: true });
  });

  it("rejects a declared change to a protected resource, not a passing mention", () => {
    const opts = { protectedResources: ["cart"] };
    expect(
      checkCompatibility(
        1841,
        [cs("a", { contracts: ["POST /api/cart/items - adds wishlistId"] })],
        opts,
      ),
    ).toMatchObject({ ok: false, kind: "invariant_violation" });
    expect(
      checkCompatibility(
        1841,
        [cs("a", { contracts: ["POST /api/wishlists/:id/move-to-cart"] })],
        opts,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects a missing dependency and a dependency whose migration runs later", () => {
    expect(checkCompatibility(1841, [cs("a", { dependsOn: ["z"] })])).toMatchObject({
      ok: false,
      kind: "unsatisfied_dependency",
    });
    const r = checkCompatibility(1841, [
      cs("a", { files: ["migrations/0005_members.sql"] }),
      cs("b", { files: ["migrations/0004_share.sql"], dependsOn: ["a"] }),
    ]);
    expect(r).toMatchObject({ ok: false, kind: "migration_order" });
  });
});

describe("parseBenchOutput", () => {
  it("reads the last p95 line and ignores noise", () => {
    expect(parseBenchOutput('$ bun run bench\nwarn: slow\n{"p95Ms": 12.5}\n')).toBe(12.5);
    expect(parseBenchOutput('{"p95Ms": 9}\n{"other": 1}\n{"p95Ms": 31}')).toBe(31);
  });

  it("returns null when no valid p95 exists", () => {
    for (const out of ["", "error: crash", '{"p95Ms": "fast"}', '{"p95Ms": -1}', "{oops"]) {
      expect(parseBenchOutput(out)).toBeNull();
    }
  });
});

describe("diffContract", () => {
  const base = ["GET /api/cart", "POST /api/cart/items"];

  it("passes an unchanged route table", () => {
    expect(diffContract(base, [...base].reverse(), [])).toEqual({
      added: [],
      removed: [],
      undeclared: [],
    });
  });

  it("fails an added route that no ChangeSet declared", () => {
    const diff = diffContract(base, [...base, "POST /api/wishlists"], []);
    expect(diff.added).toEqual(["POST /api/wishlists"]);
    expect(diff.undeclared).toEqual(["POST /api/wishlists"]);
  });

  it("accepts declared changes and still fails an undeclared removal", () => {
    const diff = diffContract(
      base,
      ["GET /api/cart", "POST /api/wishlists/:id/items"],
      ["POST /v1/wishlists/{wishlistId}/items - add a product"],
    );
    expect(diff.added).toEqual(["POST /api/wishlists/:id/items"]);
    expect(diff.undeclared).toEqual(["POST /api/cart/items"]);
  });

  it("reads the last route table line and rejects missing output", () => {
    expect(parseRouteTable('$ bun run contract\n{"routes":["GET /a"]}')).toEqual(["GET /a"]);
    expect(parseRouteTable("error: Script not found")).toBeNull();
  });
});
