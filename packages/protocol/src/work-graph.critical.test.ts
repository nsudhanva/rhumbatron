// The scheduler trusts this check: a cycle or a dangling dependency would leave Tasks unreachable.
import { describe, expect, it } from "vitest";
import { checkWorkGraph } from "./work-graph.ts";

const t = (key: string, ...dependsOn: string[]) => ({ key, dependsOn });

describe("checkWorkGraph", () => {
  it("orders a valid DAG with ties in plan order", () => {
    expect(checkWorkGraph([t("t1"), t("t2"), t("t3", "t1", "t2"), t("t4", "t3")])).toEqual({
      ok: true,
      order: ["t1", "t2", "t3", "t4"],
    });
  });

  it("rejects cycles, self-dependencies, unknown and duplicate keys", () => {
    expect(checkWorkGraph([t("t1", "t2"), t("t2", "t1")]).ok).toBe(false);
    expect(checkWorkGraph([t("t1", "t1")]).ok).toBe(false);
    expect(checkWorkGraph([t("t1", "t9")]).ok).toBe(false);
    expect(checkWorkGraph([t("t1"), t("t1")]).ok).toBe(false);
  });
});
