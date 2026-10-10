import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { RegisterScopeInput } from "./request-scopes.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: DurableObjectState,
      protected env: Env,
    ) {}
  },
}));
const { ProjectRootDO } = await import("./project-root-do.ts");
function root() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...params: unknown[]) {
      const statement = db.prepare(query);
      if (statement.columns().length) {
        const rows = statement.all(...(params as never[]));
        return { toArray: () => rows };
      }
      return {
        toArray: () => [],
        rowsWritten: Number(statement.run(...(params as never[])).changes),
      };
    },
  } as unknown as SqlStorage;
  const storage = {
    sql,
    transactionSync<T>(run: () => T): T {
      db.exec("BEGIN");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const ctx = {
    storage,
    blockConcurrencyWhile: (run: () => Promise<unknown>) => run(),
  } as unknown as DurableObjectState;
  return new ProjectRootDO(ctx, {} as Env);
}
const input = (changeId: string): RegisterScopeInput => ({
  changeId,
  requesterUserId: "alice",
  requesterRank: 0,
  criteria: [{ id: "c1", text: "Sort products" }],
  resources: ["products:sort"],
  registeredAt: "2026-10-10T00:00:00Z",
});

describe("ProjectRootDO request scope serialization", () => {
  it("orders concurrent registrations and retries with the exact original earlier set", async () => {
    const object = root();
    const [a, b] = await Promise.all([
      object.registerScope(input("a")),
      object.registerScope(input("b")),
    ]);
    expect(a).toEqual({ order: 1, earlier: [] });
    expect(b).toEqual({
      order: 2,
      earlier: [{ ...input("a"), registeredAt: undefined, scoped: true }].map(
        ({ registeredAt: _, ...scope }) => scope,
      ),
    });
    await object.release("a");
    expect(await object.registerScope({ ...input("b"), resources: ["changed"] })).toEqual(b);
    expect((await object.registerScope(input("c"))).earlier.map((scope) => scope.changeId)).toEqual(
      ["b"],
    );
  });
  it("includes an admitted but unscoped request and preserves its admission order", async () => {
    const object = root();
    expect(await object.admit("a", { requesterUserId: "bob", requesterRank: 10 })).toBe(1);
    const b = await object.registerScope(input("b"));
    expect(b.earlier).toEqual([
      {
        changeId: "a",
        requesterUserId: "bob",
        requesterRank: 10,
        criteria: [],
        resources: [],
        scoped: false,
      },
    ]);
    const a = await object.registerScope(input("a"));
    expect(a).toEqual({ order: 1, earlier: [] });
    expect(await object.registerScope(input("b"))).toEqual(b);
    expect(await object.getScope("a")).toMatchObject({ scoped: true });
    await object.release("a");
    expect(await object.getScope("a")).toBeNull();
  });
});
