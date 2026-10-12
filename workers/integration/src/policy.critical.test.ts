import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "./candidate-composer.ts";
import { loadProjectPolicy, policyForRun } from "./policy.ts";

/** D1 with one optional `project_policies` row, counting reads. */
function harness(policyJson: string | null, kvBroken = false) {
  let d1Reads = 0;
  const kv = new Map<string, string>();
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            d1Reads += 1;
            return policyJson === null ? null : { policy_json: policyJson };
          },
        }),
      }),
    },
    CONFIG: {
      get: async (key: string) => {
        if (kvBroken) throw new Error("KV unavailable");
        const value = kv.get(key);
        return value === undefined ? null : JSON.parse(value);
      },
      put: async (key: string, value: string) => {
        if (kvBroken) throw new Error("KV unavailable");
        kv.set(key, value);
      },
    },
  } as unknown as Env;
  return { env, kv, d1Reads: () => d1Reads };
}

describe("Project policy snapshot", () => {
  it("uses the default policy without a row and serves the cached copy without D1", async () => {
    const h = harness(null);
    expect(await loadProjectPolicy(h.env, "proj_a")).toEqual(DEFAULT_POLICY);
    expect(await loadProjectPolicy(h.env, "proj_a")).toEqual(DEFAULT_POLICY);
    expect(h.d1Reads()).toBe(1);
  });

  it("protects nothing without a row; a stored row brings its own protected resources", async () => {
    expect((await loadProjectPolicy(harness(null).env, "proj_a")).protectedResources).toEqual([]);
    const stored = { ...DEFAULT_POLICY, protectedResources: ["billing", "identity.auth"] };
    const h = harness(JSON.stringify(stored));
    expect(await loadProjectPolicy(h.env, "proj_a")).toEqual(stored);
  });

  it("reads the policy once per Workflow run", async () => {
    const h = harness(JSON.stringify({ ...DEFAULT_POLICY, protectedResources: ["billing"] }), true);
    const steps: string[] = [];
    const step = {
      do: (name: string, fn: () => Promise<unknown>) => {
        steps.push(name);
        return fn();
      },
    } as unknown as Parameters<typeof policyForRun>[1];
    const policyOf = policyForRun(h.env, step);
    const [first, second] = await Promise.all([policyOf("proj_a"), policyOf("proj_a")]);
    expect(first.protectedResources).toEqual(["billing"]);
    expect(second).toBe(first);
    expect(steps).toHaveLength(1);
    expect(h.d1Reads()).toBe(1);
  });

  it("reads the stored policy from D1 when KV fails", async () => {
    const stored = { ...DEFAULT_POLICY, version: "policy-2", humanGateRiskTiers: ["medium"] };
    const h = harness(JSON.stringify(stored), true);
    expect(await loadProjectPolicy(h.env, "proj_a")).toEqual(stored);
  });

  it("refuses an invalid stored policy instead of passing it off as the default", async () => {
    const h = harness(JSON.stringify({ version: "policy-2" }));
    await expect(loadProjectPolicy(h.env, "proj_a")).rejects.toThrow("invalid");
    expect(h.kv.size).toBe(0);
  });
});
