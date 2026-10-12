// Seeding writes a Project's first commit. The invariant: only a Project whose canonical source is
// unassigned at Generation 0 is ever seeded, so no command can overwrite a real repository.
import { describe, expect, it, vi } from "vitest";
import { needsSourceSeed, seedSourceIfUnassigned } from "./source-seed.ts";

const unassigned = { artifactRef: "unassigned", generation: 0 };
const assigned = { artifactRef: "artifacts://proj_1@main", generation: 0 };
const advanced = { artifactRef: "artifacts://proj_1@main", generation: 7 };

describe("needsSourceSeed", () => {
  it("is true only for unassigned source at Generation 0", () => {
    expect(needsSourceSeed(unassigned)).toBe(true);
    expect(needsSourceSeed(assigned)).toBe(false);
    expect(needsSourceSeed(advanced)).toBe(false);
    expect(needsSourceSeed({ artifactRef: "unassigned", generation: 1 })).toBe(false);
    expect(needsSourceSeed(null)).toBe(false);
  });
});

describe("seedSourceIfUnassigned", () => {
  it("seeds an unassigned Project once per call", async () => {
    const provision = vi.fn(async () => undefined);
    const outcome = await seedSourceIfUnassigned({
      getCanonical: async () => unassigned,
      provision,
    });
    expect(outcome).toBe("seeded");
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("never provisions a Project with source or a missing Project", async () => {
    for (const [canonical, expected] of [
      [assigned, "has_source"],
      [advanced, "has_source"],
      [null, "missing"],
    ] as const) {
      const provision = vi.fn(async () => undefined);
      expect(await seedSourceIfUnassigned({ getCanonical: async () => canonical, provision })).toBe(
        expected,
      );
      expect(provision).not.toHaveBeenCalled();
    }
  });
});
