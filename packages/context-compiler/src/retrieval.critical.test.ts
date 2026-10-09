// Retrieval order is a scope boundary (AGENTS.md sections 27.3, 27.5, 40.1): exact indexes decide
// first, Vectorize only adds, and a Vectorize match can never bring in another Project's data or a
// path the canonical tree does not have.
import { describe, expect, it } from "vitest";
import { type CompileInput, compilePacket } from "./compile.ts";
import {
  type DependencyIndex,
  type FileSymbols,
  indexKeys,
  type ProductGraphStore,
  type SymbolIndex,
} from "./index-store.ts";
import { loadRetrieval, type SemanticMatch, selectRetrieval } from "./retrieval.ts";

const TREE = "t".repeat(40);
const file = (path: string, exports: string[] = []): FileSymbols => ({
  path,
  blob: `b-${path}`,
  lang: "ts",
  exports,
  declarations: [],
  imports: [],
  doc: null,
});
const symbols: SymbolIndex = {
  version: 1,
  projectId: "proj_a",
  treeSha: TREE,
  commit: "c".repeat(40),
  truncated: false,
  files: [
    file("src/app.ts", ["createApp"]),
    file("src/cart.ts", ["addItem"]),
    file("src/catalog.ts", ["Product"]),
    file("src/identity.ts", ["resolveUser"]),
    file("src/notes.ts"),
  ],
};
const deps: DependencyIndex = {
  version: 1,
  projectId: "proj_a",
  treeSha: TREE,
  files: {
    "src/app.ts": { imports: ["src/cart.ts", "src/identity.ts"], importedBy: [] },
    "src/cart.ts": { imports: ["src/catalog.ts"], importedBy: ["src/app.ts"] },
    "src/catalog.ts": { imports: [], importedBy: ["src/cart.ts"] },
    "src/identity.ts": { imports: [], importedBy: ["src/app.ts"] },
    "src/notes.ts": { imports: [], importedBy: [] },
  },
  symbols: {},
};
const graph: ProductGraphStore = {
  version: 1,
  projectId: "proj_a",
  treeSha: TREE,
  areas: [{ id: "cart", files: ["src/cart.ts"], resources: ["cart"] }],
  edges: [],
  resourceOwners: { "cart:items": ["src/cart.ts"] },
  wiringFiles: [],
};
const match = (path: string, score: number, projectId = "proj_a"): SemanticMatch => ({
  id: `v-${projectId}-${path}`,
  score,
  metadata: { projectId, treeSha: TREE, path },
});

describe("selectRetrieval", () => {
  it("puts declared files first, then exact neighbors, then Vectorize matches", () => {
    const r = selectRetrieval({
      projectId: "proj_a",
      symbols,
      deps,
      graph,
      declaredFiles: ["src/cart.ts"],
      resources: ["project:acme:cart:items"],
      semantic: { status: "ok", matches: [match("src/notes.ts", 0.9), match("src/cart.ts", 0.95)] },
    });
    expect(r.files.map((f) => [f.tier, f.path])).toEqual([
      ["declared", "src/cart.ts"],
      ["dependency", "src/catalog.ts"],
      ["dependency", "src/app.ts"],
      // The already-declared cart.ts match is refused, not repeated.
      ["semantic", "src/notes.ts"],
    ]);
    expect(r.owners).toEqual([{ resource: "cart:items", files: ["src/cart.ts"] }]);
    expect(r.semantic).toEqual({ status: "ok", returned: 2, refused: 1 });
  });

  it("refuses Vectorize matches from another Project, unknown paths, and weak scores", () => {
    const r = selectRetrieval({
      projectId: "proj_a",
      symbols,
      deps,
      graph: null,
      declaredFiles: [],
      resources: [],
      semantic: {
        status: "ok",
        matches: [
          match("src/secret-of-b.ts", 0.99, "proj_b"),
          match("src/notes.ts", 0.99, "proj_b"),
          match("src/not-in-tree.ts", 0.99),
          match("src/identity.ts", 0.2),
          { id: "no-meta", score: 0.99 },
          match("src/notes.ts", 0.8),
        ],
      },
    });
    expect(r.files.map((f) => f.path)).toEqual(["src/notes.ts"]);
    expect(r.files.every((f) => f.tier === "semantic")).toBe(true);
    expect(r.semantic.refused).toBe(5);
  });

  it("ignores declared paths that the tree does not have", () => {
    const r = selectRetrieval({
      projectId: "proj_a",
      symbols,
      deps,
      graph: null,
      declaredFiles: ["src/ghost.ts", "./src/identity.ts"],
      resources: [],
      semantic: { status: "skipped", matches: [] },
    });
    expect(r.files.map((f) => [f.tier, f.path])).toEqual([
      ["declared", "src/identity.ts"],
      ["dependency", "src/app.ts"],
    ]);
  });
});

describe("loadRetrieval", () => {
  const store = new Map<string, unknown>([
    [indexKeys("proj_a", TREE).symbols, symbols],
    [indexKeys("proj_a", TREE).deps, deps],
    [indexKeys("proj_a", TREE).productGraph, graph],
  ]);
  const read = async (key: string) => store.get(key) ?? null;
  const input = {
    projectId: "proj_a",
    treeSha: TREE,
    taskTexts: ["Change src/app.ts to add a wishlist route."],
    upstreamFiles: [],
    resources: [],
  };

  it("does not query Vectorize when the tree has no index", async () => {
    let searched = false;
    const r = await loadRetrieval(
      {
        read: async () => null,
        search: async () => {
          searched = true;
          return [];
        },
      },
      input,
    );
    expect(r).toBeNull();
    expect(searched).toBe(false);
  });

  it("keeps the exact items when Vectorize fails", async () => {
    const r = await loadRetrieval(
      {
        read,
        search: async () => {
          throw new Error("vectorize down");
        },
      },
      input,
    );
    expect(r?.semantic.status).toBe("error");
    expect(r?.files.map((f) => [f.tier, f.path])).toEqual([
      ["declared", "src/app.ts"],
      ["dependency", "src/cart.ts"],
      ["dependency", "src/identity.ts"],
    ]);
  });

  it("refuses an index object that belongs to another Project", async () => {
    const r = await loadRetrieval(
      {
        read: async (k) =>
          k.endsWith("symbols.json") ? { ...symbols, projectId: "proj_b" } : null,
      },
      input,
    );
    expect(r).toBeNull();
  });
});

describe("compilePacket with retrieval", () => {
  const base: CompileInput = {
    projectId: "proj_a",
    canonicalGeneration: 3,
    now: "2026-10-09T00:00:00.000Z",
    change: { id: "chg_1", goal: "g", acceptanceCriteria: [], invariants: [], updatedAt: "v1" },
    task: {
      id: "tsk_1",
      key: "t1",
      kind: "implement",
      title: "t",
      objective: "o",
      riskTier: "low",
      acceptanceCriteria: [],
      semanticResources: ["project:acme:cart:items"],
      updatedAt: "v1",
    },
    dependencyIntents: [],
    nearbyIntents: [
      {
        taskId: "tsk_2",
        taskKey: "t2",
        title: "Other",
        runId: "run_2_1",
        endedAt: "x",
        resources: ["cart:items"],
        intent: { summary: "s" },
      },
    ],
    priorFailures: [],
    allowedTools: [],
    budget: { maxModelCalls: 1, budgetUsd: 1 },
    maxTokens: 10_000,
    retrieval: selectRetrieval({
      projectId: "proj_a",
      symbols,
      deps,
      graph,
      declaredFiles: ["src/cart.ts"],
      resources: ["cart:items"],
      semantic: { status: "ok", matches: [match("src/notes.ts", 0.9)] },
    }),
  };

  it("orders exact items before events and Vectorize last, each with the tree as version", () => {
    const packet = compilePacket(base);
    expect(packet.items.map((i) => i.itemId)).toEqual([
      "change:chg_1",
      "task:tsk_1",
      "file:src/cart.ts",
      "dep:src/catalog.ts",
      "dep:src/app.ts",
      "owner:cart:items",
      "intent:run_2_1",
      "semantic:src/notes.ts",
    ]);
    const indexed = packet.items.filter((i) => /^(file|dep|owner|semantic):/.test(i.itemId));
    expect(indexed.every((i) => i.sourceVersion === TREE)).toBe(true);
  });

  it("trims Vectorize items before exact ones", () => {
    const full = compilePacket(base);
    const last = full.items.at(-1);
    const lastCost = Math.ceil(((last?.title ?? "") + (last?.body ?? "")).length / 4);
    const packet = compilePacket({ ...base, maxTokens: full.tokenEstimate - lastCost });
    expect(packet.items.some((i) => i.itemId.startsWith("semantic:"))).toBe(false);
    expect(packet.items.some((i) => i.itemId === "file:src/cart.ts")).toBe(true);
  });
});
