import { describe, expect, it } from "vitest";
import { checkMigrations } from "./check-migrations.ts";
import { guard } from "./plan-guard.ts";

const change = (address: string, actions: string[], before?: unknown, after?: unknown) => {
  const [type = "", name = ""] = address.split(".").slice(-2);
  return { address, type, name, change: { actions, before, after } };
};

describe("plan guard", () => {
  it("allows new Worker versions and adapter replacements", () => {
    const { problems } = guard({
      resource_changes: [
        change("module.api_worker.cloudflare_worker_version.this", ["delete", "create"]),
        change("terraform_data.d1_migrations", ["delete", "create"]),
        change("module.agents_worker.cloudflare_workers_script.this", ["update"], {}, {}),
      ],
    });
    expect(problems).toEqual([]);
  });

  it("blocks deletion of stateful resources and teardown adapters", () => {
    const { problems } = guard({
      resource_changes: [
        change("module.state.cloudflare_d1_database.control", ["delete", "create"]),
        change("terraform_data.vectorize_index_teardown", ["delete"]),
      ],
    });
    expect(problems).toHaveLength(2);
  });

  it("blocks a script upload that deletes a Durable Object class", () => {
    const { problems } = guard({
      resource_changes: [
        change(
          "module.coordinator_worker.cloudflare_workers_script.this",
          ["update"],
          { migrations: { deleted_classes: [] } },
          { migrations: { deleted_classes: ["ProjectViewDO"] } },
        ),
      ],
    });
    expect(problems).toEqual([
      "module.coordinator_worker.cloudflare_workers_script.this: deletes Durable Object class ProjectViewDO",
    ]);
  });
});

describe("migration guard", () => {
  const files = ["0001_init.sql", "0002_more.sql", "README.md"];

  it("refuses an edited migration", () => {
    const errors = checkMigrations({
      changes: [{ status: "M", path: "migrations/d1/0001_init.sql" }],
      files,
      read: () => "",
    });
    expect(errors[0]).toContain("append-only");
  });

  it("refuses an unreviewed DROP and accepts a reviewed one", () => {
    const add = { status: "A", path: "migrations/d1/0003_drop.sql" };
    const all = [...files, "0003_drop.sql"];
    expect(
      checkMigrations({ changes: [add], files: all, read: () => "DROP TABLE x;" }),
    ).toHaveLength(1);
    expect(
      checkMigrations({
        changes: [add],
        files: all,
        read: () => "-- destructive: reviewed\nDROP TABLE x;",
      }),
    ).toEqual([]);
  });

  it("refuses a new migration that sorts before an existing one", () => {
    const errors = checkMigrations({
      changes: [{ status: "A", path: "migrations/d1/0002_late.sql" }],
      files: ["0001_init.sql", "0002_late.sql", "0003_more.sql"],
      read: () => "",
    });
    expect(errors.some((e) => e.includes("sort after 3"))).toBe(true);
  });
});
