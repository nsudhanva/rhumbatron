// The indexes decide what an agent sees first and what the Product Graph
// shows. These tests pin the exact dependency index on a small fixture, the stale
// vector cleanup between trees, and that a tree is built once (idempotent per tree SHA).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EMBEDDING_DIMENSIONS,
  indexKeys,
  type VectorManifest,
  vectorManifestKey,
} from "@rhumbatron/context-compiler";
import { describe, expect, it } from "vitest";
import { buildIndexes } from "./build.ts";
import { buildIndex, type IndexerDeps, purgeIndex, RetryLater } from "./handler.ts";
import type { SourceFile } from "./source.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");

function fakeD1() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const exec = (sql: string, params: unknown[]) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql) || /\breturning\b/i.test(sql)) {
      return { results: statement.all(...(params as never[])), meta: { changes: 0 } };
    }
    return {
      results: [],
      meta: { changes: Number(statement.run(...(params as never[])).changes) },
    };
  };
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => exec(sql, params),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => exec(sql, params),
  });
  const d1 = {
    prepare: (sql: string) => statement(sql),
    batch: async (list: { sql: string; params: unknown[] }[]) =>
      list.map((s) => exec(s.sql, s.params)),
  } as unknown as D1Database;
  return { db, d1 };
}

const blob = (s: string) => `b${s.length}${s.slice(0, 8).replace(/\W/g, "")}`;
const src = (path: string, content: string | null): SourceFile => ({
  path,
  blob: blob(content ?? path),
  content,
});

/** Acme Shop shape: app -> cart, identity, store; store wires catalog; cart -> catalog (type). */
const ACME: SourceFile[] = [
  src(
    "src/app.ts",
    `/** HTTP surface. */
import { Hono } from "hono";
import { addItem, type Cart } from "./cart";
import { resolveUser } from "./identity";
import { getCart, type Store } from "./store";
export function createApp(store: Store) { return new Hono(); }`,
  ),
  src(
    "src/cart.ts",
    `import type { Product } from "./catalog";
const MAX = 99;
export type Cart = readonly string[];
export function addItem(cart: Cart, p: Product) { return cart; }
function helper() {}
export { helper };`,
  ),
  src(
    "src/catalog.ts",
    `export type Product = { id: string };\nexport const SEED_PRODUCTS: Product[] = [];`,
  ),
  src("src/identity.ts", `export function resolveUser(h: string | null) { return h; }`),
  src(
    "src/store.ts",
    `import type { Cart } from "./cart";
import { type Product, SEED_PRODUCTS } from "./catalog";
export type Store = { products: Product[]; carts: Cart[] };
export function getCart() { return []; }`,
  ),
  src("src/worker.ts", `import { createApp } from "./app.js";\nexport default { fetch() {} };`),
  src("test/cart.test.ts", `import { addItem } from "../src/cart";`),
  src(".env", "SECRET=do-not-read"),
  src("README.md", null),
];

describe("buildIndexes", () => {
  const built = buildIndexes({
    projectId: "proj_a",
    treeSha: "tree1",
    commit: "c1",
    truncated: false,
    files: ACME,
    owners: [{ resources: ["project:acme:cart:items"], files: ["src/cart.ts", "src/gone.ts"] }],
  });

  it("indexes exact imports both ways and symbol references", () => {
    expect(built.deps.files["src/app.ts"]).toEqual({
      imports: ["src/cart.ts", "src/identity.ts", "src/store.ts"],
      importedBy: ["src/worker.ts"],
    });
    expect(built.deps.files["src/cart.ts"]).toEqual({
      imports: ["src/catalog.ts"],
      importedBy: ["src/app.ts", "src/store.ts", "test/cart.test.ts"],
    });
    expect(built.deps.files["src/catalog.ts"]?.importedBy).toEqual(["src/cart.ts", "src/store.ts"]);
    expect(built.deps.symbols["src/cart.ts#addItem"]).toEqual(["src/app.ts", "test/cart.test.ts"]);
    expect(built.deps.symbols["src/catalog.ts#SEED_PRODUCTS"]).toEqual(["src/store.ts"]);
    // Packages are not repository files.
    expect(Object.keys(built.deps.files).some((p) => p.includes("hono"))).toBe(false);
  });

  it("extracts exports, declarations, and the doc line", () => {
    const cart = built.symbols.files.find((f) => f.path === "src/cart.ts");
    expect(cart?.exports).toEqual(["Cart", "addItem", "helper"]);
    expect(cart?.declarations.map((d) => [d.name, d.kind, d.exported])).toEqual([
      ["MAX", "const", false],
      ["Cart", "type", true],
      ["addItem", "function", true],
      ["helper", "function", true],
    ]);
    expect(built.symbols.files.find((f) => f.path === "src/app.ts")?.doc).toBe("HTTP surface.");
  });

  it("never parses a sensitive file", () => {
    const env = built.symbols.files.find((f) => f.path === ".env");
    expect(env?.skipped).toBe("sensitive");
    expect(env?.exports).toEqual([]);
  });

  it("derives areas from paths and follows imports through wiring files", () => {
    expect(built.graph.areas.map((a) => [a.id, a.files])).toEqual([
      ["cart", ["src/cart.ts"]],
      ["catalog", ["src/catalog.ts"]],
      ["identity", ["src/identity.ts"]],
      ["storefront", ["src/app.ts"]],
    ]);
    expect(built.graph.wiringFiles).toEqual(["src/store.ts", "src/worker.ts"]);
    expect(built.graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      "cart->catalog",
      "storefront->cart",
      "storefront->catalog",
      "storefront->identity",
    ]);
    const viaStore = built.graph.edges.find((e) => e.to === "catalog" && e.from === "storefront");
    expect(viaStore?.imports).toEqual([
      {
        file: "src/store.ts",
        detail: "Product, SEED_PRODUCTS from ./catalog, reached from src/app.ts",
      },
    ]);
    // Owners keep only files that exist in this tree.
    expect(built.graph.resourceOwners).toEqual({ "cart:items": ["src/cart.ts"] });
    expect(built.graph.areas.find((a) => a.id === "cart")?.resources).toEqual(["cart:items"]);
  });

  it("is byte-identical for the same inputs, whatever the input order", () => {
    const again = buildIndexes({
      projectId: "proj_a",
      treeSha: "tree1",
      commit: "c1",
      truncated: false,
      files: [...ACME].reverse(),
      owners: [{ resources: ["project:acme:cart:items"], files: ["src/gone.ts", "src/cart.ts"] }],
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(built));
  });
});

function harness(files: { current: SourceFile[] }, tree: { sha: string }) {
  const { d1 } = fakeD1();
  const objects = new Map<string, string>();
  const vectors = new Map<string, { namespace?: string; metadata?: unknown }>();
  const calls = { readSource: 0, embedded: 0, deleted: [] as string[] };
  let clock = 0;
  const deps: IndexerDeps = {
    db: d1,
    bucket: {
      getJson: async (k) => (objects.has(k) ? JSON.parse(objects.get(k) ?? "null") : null),
      putJson: async (k, v) => void objects.set(k, JSON.stringify(v)),
      list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
      delete: async (keys) => {
        for (const k of keys) objects.delete(k);
      },
    },
    canonical: async () => ({ treeSha: tree.sha, generation: 1 }),
    readSource: async () => {
      calls.readSource += 1;
      return { files: files.current, truncated: false };
    },
    memory: {
      upsert: async (vs) => {
        for (const v of vs) vectors.set(v.id, v);
      },
      deleteByIds: async (ids) => {
        calls.deleted.push(...ids);
        for (const id of ids) vectors.delete(id);
      },
    },
    embed: async (texts) => {
      calls.embedded += texts.length;
      return texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.1));
    },
    now: () => new Date(Date.UTC(2026, 9, 9, 0, 0, clock++)).toISOString(),
  };
  const pointer = (sha: string) =>
    objects.set(
      `source/proj_a/${sha}/index.json`,
      JSON.stringify({ commit: `c-${sha}`, treeSha: sha }),
    );
  return { deps, objects, vectors, calls, pointer };
}

describe("buildIndex", () => {
  it("builds a tree once: a repeated command reads nothing and embeds nothing", async () => {
    const files = { current: ACME };
    const tree = { sha: "tree1" };
    const h = harness(files, tree);
    h.pointer("tree1");
    const first = await buildIndex(h.deps, "proj_a", "tree1");
    expect(first).toMatchObject({ result: "built", vectorStatus: "ok" });
    const snapshot = h.objects.get(indexKeys("proj_a", "tree1").symbols);
    const embedded = h.calls.embedded;

    expect(await buildIndex(h.deps, "proj_a", "tree1")).toEqual({ result: "exists" });
    expect(h.calls.readSource).toBe(1);
    expect(h.calls.embedded).toBe(embedded);
    expect(h.objects.get(indexKeys("proj_a", "tree1").symbols)).toBe(snapshot);
  });

  it("waits for the canonical source pointer and skips a superseded tree", async () => {
    const h = harness({ current: ACME }, { sha: "tree2" });
    await expect(buildIndex(h.deps, "proj_a", "tree2")).rejects.toBeInstanceOf(RetryLater);
    expect(await buildIndex(h.deps, "proj_a", "tree1")).toEqual({ result: "superseded" });
    expect(h.calls.readSource).toBe(0);
  });

  it("deletes vectors of removed files and re-embeds only changed files", async () => {
    const files = { current: ACME };
    const tree = { sha: "tree1" };
    const h = harness(files, tree);
    h.pointer("tree1");
    await buildIndex(h.deps, "proj_a", "tree1");
    const before = JSON.parse(h.objects.get(vectorManifestKey("proj_a")) ?? "{}") as VectorManifest;
    // Code files only: no README, no .env.
    expect(Object.keys(before.entries).sort()).toEqual([
      "src/app.ts",
      "src/cart.ts",
      "src/catalog.ts",
      "src/identity.ts",
      "src/store.ts",
      "src/worker.ts",
      "test/cart.test.ts",
    ]);
    expect([...h.vectors.values()].every((v) => v.namespace === "proj_a")).toBe(true);

    // Tree 2: identity.ts removed, catalog.ts changed, wishlist.ts added.
    files.current = [
      ...ACME.filter((f) => f.path !== "src/identity.ts" && f.path !== "src/catalog.ts"),
      src(
        "src/catalog.ts",
        `export type Product = { id: string; name: string };\nexport function find() {}`,
      ),
      src("src/wishlist/model.ts", `export function createWishlist() {}`),
    ];
    tree.sha = "tree2";
    h.pointer("tree2");
    const embeddedBefore = h.calls.embedded;
    const second = await buildIndex(h.deps, "proj_a", "tree2");
    expect(second).toMatchObject({ result: "built", vectorStatus: "ok", removed: 1 });
    expect(h.calls.deleted).toEqual([before.entries["src/identity.ts"]?.id]);
    expect(h.vectors.has(before.entries["src/identity.ts"]?.id ?? "")).toBe(false);
    // catalog.ts and wishlist/model.ts changed; app.ts lost an import edge (identity), so its text changed too.
    expect(h.calls.embedded - embeddedBefore).toBe(3);
    const after = JSON.parse(h.objects.get(vectorManifestKey("proj_a")) ?? "{}") as VectorManifest;
    expect(after.entries["src/identity.ts"]).toBeUndefined();
    expect(h.vectors.size).toBe(Object.keys(after.entries).length);
  });

  it("keeps the newest three tree indexes and deletes older ones", async () => {
    const files = { current: ACME };
    const tree = { sha: "tree1" };
    const h = harness(files, tree);
    for (const sha of ["tree1", "tree2", "tree3", "tree4"]) {
      tree.sha = sha;
      h.pointer(sha);
      await buildIndex(h.deps, "proj_a", sha);
    }
    const kept = [...h.objects.keys()].filter((k) => k.endsWith("/symbols.json")).sort();
    expect(kept).toEqual([2, 3, 4].map((n) => indexKeys("proj_a", `tree${n}`).symbols));
  });

  it("purges every vector and index object of an archived Project", async () => {
    const h = harness({ current: ACME }, { sha: "tree1" });
    h.pointer("tree1");
    await buildIndex(h.deps, "proj_a", "tree1");
    const result = await purgeIndex(h.deps, "proj_a");
    expect(result.vectors).toBe(7);
    expect(h.vectors.size).toBe(0);
    expect([...h.objects.keys()].filter((k) => k.startsWith("index/proj_a/"))).toEqual([]);
  });
});
