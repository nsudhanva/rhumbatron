import { describe, expect, it } from "vitest";
import { planMigrations } from "./d1-migrations.ts";

const m = (name: string, sha256 = `sha-${name}`) => ({ name, sha256, sql: "SELECT 1;" });

describe("planMigrations", () => {
  it("returns only unapplied migrations, in name order", () => {
    const plan = planMigrations(
      [m("0002_b.sql"), m("0001_a.sql"), m("0003_c.sql")],
      [{ name: "0001_a.sql", sha256: "sha-0001_a.sql" }],
    );
    expect(plan.errors).toEqual([]);
    expect(plan.pending.map((p) => p.name)).toEqual(["0002_b.sql", "0003_c.sql"]);
  });

  it("is a no-op when everything is applied", () => {
    const plan = planMigrations(
      [m("0001_a.sql")],
      [{ name: "0001_a.sql", sha256: "sha-0001_a.sql" }],
    );
    expect(plan).toEqual({ pending: [], errors: [] });
  });

  it("rejects an applied migration that was edited", () => {
    const plan = planMigrations(
      [m("0001_a.sql", "new-hash")],
      [{ name: "0001_a.sql", sha256: "old-hash" }],
    );
    expect(plan.errors).toEqual(["0001_a.sql: edited after it was applied"]);
  });

  it("rejects an applied migration whose file is missing", () => {
    const plan = planMigrations([], [{ name: "0001_a.sql", sha256: null }]);
    expect(plan.errors).toEqual(["0001_a.sql: applied remotely but missing locally"]);
  });

  it("rejects badly named files", () => {
    const plan = planMigrations([m("init.sql")], []);
    expect(plan.errors).toEqual(["init.sql: name must match NNNN_description.sql"]);
  });
});
