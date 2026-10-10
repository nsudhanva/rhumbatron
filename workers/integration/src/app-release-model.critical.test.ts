import { isVersionPreviewId, previewIdFor, versionPreviewId } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import {
  decidePointerMove,
  decideRollback,
  MAX_RECOMPOSES,
  type PointerState,
  type PreviewSlot,
  planPreview,
  recomposeDecision,
  restorableTarget,
  rollbackRiskTier,
} from "./app-release-model.ts";

const C1 = "a".repeat(40);
const C2 = "b".repeat(40);
const C3 = "c".repeat(40);
const key = (commit: string) => `apps/proj_1/${commit}`;

describe("preview channel selection", () => {
  const cand = (n: number) => `cand_${String(n).repeat(24).slice(0, 24)}`;
  const slot = (n: number, status: string | null, at: string): PreviewSlot => ({
    channel: `preview:${previewIdFor(cand(n))}`,
    candidateId: cand(n),
    candidateStatus: status,
    updatedAt: at,
  });

  it("gives a new Candidate its own channel while the Change has room", () => {
    expect(planPreview({ candidateId: cand(1), previews: [] })).toEqual({
      kind: "new",
      channel: `preview:${previewIdFor(cand(1))}`,
      evict: [],
    });
  });

  it("reuses the Candidate's channel on a retried step", () => {
    const previews = [slot(1, "verifying", "2026-10-01")];
    expect(planPreview({ candidateId: cand(1), previews })).toEqual({
      kind: "reuse",
      channel: previews[0]?.channel,
    });
  });

  it("evicts the oldest preview that can no longer ship when the Change is full", () => {
    const previews = [
      slot(1, "verified", "2026-10-01"),
      slot(2, "stale", "2026-10-03"),
      slot(3, "rejected", "2026-10-02"),
    ];
    const plan = planPreview({ candidateId: cand(4), previews });
    expect(plan).toEqual({
      kind: "new",
      channel: `preview:${previewIdFor(cand(4))}`,
      evict: [slot(3, "rejected", "").channel],
    });
  });

  it("never evicts a preview of a Candidate that can still ship", () => {
    const previews = [
      slot(1, "verified", "2026-10-01"),
      slot(2, "verifying", "2026-10-02"),
      slot(3, "composing", "2026-10-03"),
    ];
    expect(planPreview({ candidateId: cand(4), previews })).toEqual({
      kind: "skip",
      reason: "limit",
    });
  });

  it("names promoted generations with version ids that never collide with Candidate ids", () => {
    expect(versionPreviewId(3)).toBe("v0000003");
    expect(versionPreviewId(1842)).toBe("v0001842");
    expect(versionPreviewId(10_000_000)).toBeNull();
    expect(isVersionPreviewId("v0000003")).toBe(true);
    // Candidate IDs are hex: their preview ids never start with `v`.
    expect(isVersionPreviewId(previewIdFor("cand_0123456789abcdef01234567"))).toBe(false);
  });
});

describe("production pointer transitions", () => {
  const at = (commit: string, generation: number): PointerState => ({
    commit,
    bundleKey: key(commit),
    generation,
    status: "ready",
  });

  it("moves production forward to a promoted generation's bundle", () => {
    expect(
      decidePointerMove(at(C1, 1), {
        kind: "release",
        to: { commit: C2, bundleKey: key(C2), generation: 2 },
      }),
    ).toEqual({ kind: "move", to: { commit: C2, bundleKey: key(C2), generation: 2 } });
  });

  it("never moves production back for a late release of an older generation", () => {
    expect(
      decidePointerMove(at(C3, 3), {
        kind: "release",
        to: { commit: C2, bundleKey: key(C2), generation: 2 },
      }),
    ).toEqual({ kind: "refuse", reason: "newer" });
  });

  it("is a no-op when production already serves the release", () => {
    expect(
      decidePointerMove(at(C2, 2), {
        kind: "release",
        to: { commit: C2, bundleKey: key(C2), generation: 2 },
      }),
    ).toEqual({ kind: "noop", reason: "current" });
  });

  it("refuses a removed or missing app", () => {
    const to = { commit: C2, bundleKey: key(C2), generation: 2 };
    expect(decidePointerMove(null, { kind: "release", to })).toEqual({
      kind: "refuse",
      reason: "no_app",
    });
    const removed: PointerState = {
      ...(at(C1, 1) as NonNullable<PointerState>),
      status: "removed",
    };
    expect(decidePointerMove(removed, { kind: "release", to })).toEqual({
      kind: "refuse",
      reason: "removed",
    });
  });

  it("a smoke failure restores the version that served before, as a new transition", () => {
    const before = at(C1, 1);
    const restore = restorableTarget(before);
    expect(
      decidePointerMove(at(C2, 2), {
        kind: "revert",
        failed: { commit: C2, generation: 2 },
        to: restore,
      }),
    ).toEqual({ kind: "move", to: { commit: C1, bundleKey: key(C1), generation: 1 } });
  });

  it("a revert never undoes a newer release", () => {
    expect(
      decidePointerMove(at(C3, 3), {
        kind: "revert",
        failed: { commit: C2, generation: 2 },
        to: restorableTarget(at(C1, 1)),
      }),
    ).toEqual({ kind: "refuse", reason: "moved_on" });
  });

  it("a first release with no earlier bundle has nothing to restore", () => {
    const building: PointerState = {
      commit: null,
      bundleKey: null,
      generation: null,
      status: "building",
    };
    expect(restorableTarget(building)).toBeNull();
    expect(
      decidePointerMove(at(C2, 2), {
        kind: "revert",
        failed: { commit: C2, generation: 2 },
        to: restorableTarget(building),
      }),
    ).toEqual({ kind: "refuse", reason: "nothing_to_restore" });
  });
});

describe("rollback transition rule", () => {
  const current = { generation: 5, treeSha: "t5" };

  it("rolls back S5 to S3 as the new transition S5 -> S6 with S3's tree", () => {
    expect(
      decideRollback({
        current,
        expectedGeneration: 5,
        targetGeneration: 3,
        target: { generation: 3, treeSha: "t3", commit: C3 },
      }),
    ).toEqual({
      kind: "proceed",
      nextGeneration: 6,
      baseGeneration: 5,
      baseTree: "t5",
      tree: "t3",
      targetCommit: C3,
    });
  });

  it("refuses when canonical moved since the person looked", () => {
    expect(
      decideRollback({
        current,
        expectedGeneration: 4,
        targetGeneration: 3,
        target: { generation: 3, treeSha: "t3", commit: C3 },
      }),
    ).toMatchObject({ kind: "refuse", reason: "stale" });
  });

  it("only rolls back to an earlier, known generation", () => {
    for (const targetGeneration of [5, 6]) {
      expect(
        decideRollback({ current, expectedGeneration: 5, targetGeneration, target: null }),
      ).toMatchObject({ kind: "refuse", reason: "not_earlier" });
    }
    expect(
      decideRollback({ current, expectedGeneration: 5, targetGeneration: 2, target: null }),
    ).toMatchObject({ kind: "refuse", reason: "unknown_target" });
    expect(
      decideRollback({
        current,
        expectedGeneration: 5,
        targetGeneration: 2,
        target: { generation: 3, treeSha: "t3", commit: C3 },
      }),
    ).toMatchObject({ kind: "refuse", reason: "unknown_target" });
  });

  it("refuses a rollback that would not change the tree", () => {
    expect(
      decideRollback({
        current,
        expectedGeneration: 5,
        targetGeneration: 3,
        target: { generation: 3, treeSha: "t5", commit: C3 },
      }),
    ).toMatchObject({ kind: "refuse", reason: "same_tree" });
  });

  it("is as risky as the riskiest Change it undoes", () => {
    expect(rollbackRiskTier(["low", "high", null])).toBe("high");
    expect(rollbackRiskTier(["low"])).toBe("low");
    expect(rollbackRiskTier([])).toBe("medium");
    expect(rollbackRiskTier([null, "unknown"])).toBe("medium");
  });
});

describe("stale Candidate recomposition bound", () => {
  const base = {
    candidateStatus: "stale",
    recomposeCount: 0,
    changeStatus: "verifying",
    baseGeneration: 1,
    canonicalGeneration: 2,
    isRollback: false,
    siblingPromoted: false,
  };

  it("recomposes a stale Candidate on the newer canonical state", () => {
    expect(recomposeDecision(base)).toEqual({ kind: "recompose", nextCount: 1 });
    expect(recomposeDecision({ ...base, recomposeCount: 1 })).toEqual({
      kind: "recompose",
      nextCount: 2,
    });
  });

  it(`blocks the lineage after ${MAX_RECOMPOSES} recompositions`, () => {
    expect(recomposeDecision({ ...base, recomposeCount: MAX_RECOMPOSES })).toEqual({
      kind: "blocked",
    });
  });

  it("never recomposes a closed Change, a rollback, or a Candidate that is not behind", () => {
    expect(recomposeDecision({ ...base, candidateStatus: "verified" })).toMatchObject({
      reason: "not_stale",
    });
    expect(recomposeDecision({ ...base, changeStatus: "completed" })).toMatchObject({
      reason: "change_closed",
    });
    expect(recomposeDecision({ ...base, isRollback: true })).toMatchObject({
      reason: "rollback",
    });
    expect(recomposeDecision({ ...base, siblingPromoted: true })).toMatchObject({
      reason: "promoted_sibling",
    });
    expect(recomposeDecision({ ...base, canonicalGeneration: 1 })).toMatchObject({
      reason: "not_behind",
    });
  });
});
