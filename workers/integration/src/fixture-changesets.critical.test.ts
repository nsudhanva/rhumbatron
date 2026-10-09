import { detectConflicts, forkDecision, intentFromDeclaration } from "@rhumbatron/conflict";
import { checkCompatibility } from "@rhumbatron/evidence";
import { describe, expect, it } from "vitest";
import { applyDesign } from "../../../fixtures/wishlist/apply.ts";
import { DESIGNS, fixtureIds, type WishlistDesign } from "../../../fixtures/wishlist/manifest.ts";
import acmeShop from "./fixtures/acme-shop.fixture.gen.ts";
import wishlist from "./fixtures/wishlist.fixture.gen.ts";

// P9-08 demo invariant: both fixture designs apply to the seeded Acme Shop source, compose alone,
// and their declared Intents produce one confirmed, forkable conflict on wishlist membership.

const apply = (design: WishlistDesign) =>
  applyDesign(design, wishlist, (path) => acmeShop[path] ?? null);

describe("wishlist fixture", () => {
  it("applies each design to the Acme Shop baseline", () => {
    for (const design of ["a", "b"] as const) {
      const changes = apply(design);
      expect(changes.modified).toEqual([
        "README.md",
        "package.json",
        "public/index.html",
        "src/app.ts",
        "src/store.ts",
      ]);
      expect(changes.added).toContain("src/wishlist/model.ts");
      expect(changes.files["src/app.ts"]).toContain("registerWishlistRoutes(app, store);");
      // The protected Cart code is never part of a design.
      expect(Object.keys(changes.files).some((f) => /cart/.test(f))).toBe(false);
    }
    expect(apply("a").files["src/wishlist/model.ts"]).not.toBe(
      apply("b").files["src/wishlist/model.ts"],
    );
  });

  it("refuses a base it does not fit", () => {
    expect(() => applyDesign("a", wishlist, () => null)).toThrow(/missing/);
  });

  it("each design passes deterministic compatibility on its own", () => {
    for (const design of ["a", "b"] as const) {
      const { intent, files } = apply(design);
      const result = checkCompatibility(
        4,
        [
          {
            id: "cs_x",
            baseGeneration: 4,
            intent: { ...intent, changeSet: { files: Object.keys(files) } },
          },
        ],
        { protectedResources: ["cart", "checkout", "identity.auth"] },
      );
      expect(result).toEqual({ ok: true });
    }
  });

  it("the two Intents conflict on wishlist:membership and fork Candidates", () => {
    const at = "2026-10-09T00:00:00.000Z";
    const intents = (["a", "b"] as const).map((design) => {
      const ids = fixtureIds("chg_00000000-0000-4000-8000-000000000000", design);
      return intentFromDeclaration(apply(design).intent, {
        intentId: ids.intentId,
        taskId: ids.taskId,
        agentId: DESIGNS[design].agentId,
        createdAt: at,
      });
    });
    const reports = detectConflicts(intents, {
      protectedResources: ["cart", "checkout", "identity"],
      includeDismissed: false,
    });
    expect(reports).toHaveLength(1);
    const [report] = reports;
    expect(report?.resource).toBe("wishlist:membership");
    expect(report?.state).toBe("confirmed");
    expect(report?.signals.some((s) => s.kind === "data_model_conflict")).toBe(true);
    expect(report && forkDecision(report).kind).toBe("fork");
  });
});
