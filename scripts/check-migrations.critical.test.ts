import { describe, expect, it } from "vitest";
import { checkMigrations } from "./check-migrations.ts";

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
