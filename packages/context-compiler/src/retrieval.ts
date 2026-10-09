import {
  areaOfResource,
  type DependencyIndex,
  type FileSymbols,
  indexKeys,
  normalizeResource,
  type ProductGraphStore,
  type SymbolIndex,
} from "./index-store.ts";

/**
 * Retrieval order (AGENTS.md section 27.3): exact first, Vectorize last.
 *
 *   1. Task-declared files: paths the Task text names, upstream Intents' expected files, and
 *      files of inherited ChangeSets. Only paths that exist in the indexed tree count.
 *   2. Exact dependency neighbors of those files (dependency index: imports and importers).
 *   3. Exact semantic resource owners (Product Graph store).
 *   4. Recent related events (dependency and nearby Intents, prior failures): compile.ts.
 *   5. Vectorize semantic matches: at most 5, above a score floor, only for the same Project and
 *      only for paths that exist in the indexed tree. Vectorize augments; it never replaces.
 *
 * Deterministic for its inputs. The loader does the I/O; `selectRetrieval` decides.
 */

export const RETRIEVAL_LIMITS = {
  declared: 20,
  dependency: 15,
  owners: 10,
  ownerFiles: 12,
  semantic: 5,
  /** Cosine similarity floor for a Vectorize match (bge-small-en-v1.5). */
  minScore: 0.6,
} as const;

export type RetrievalTier = "declared" | "dependency" | "semantic";

export type RetrievedFile = {
  tier: RetrievalTier;
  path: string;
  /** Why the file is in the packet, for the agent and for replay. */
  reason: string;
  /** Exports, imports, and doc line from the symbol index. Never file contents. */
  summary: string;
  /** Vectorize score, semantic tier only. */
  score?: number;
};

export type SemanticStatus = "ok" | "skipped" | "error";

export type Retrieval = {
  projectId: string;
  treeSha: string;
  commit: string;
  files: RetrievedFile[];
  owners: { resource: string; files: string[] }[];
  semantic: {
    status: SemanticStatus;
    /** Matches Vectorize returned. */
    returned: number;
    /** Matches refused: other Project, unknown path, below the floor, or already included. */
    refused: number;
  };
};

/** One Vectorize match as the binding returns it. Treated as untrusted input. */
export type SemanticMatch = {
  id: string;
  score: number;
  metadata?: Record<string, unknown> | null;
};

const sorted = (items: Iterable<string>) => [...new Set(items)].sort();

/** Paths named literally in Task text that exist in the tree. Exact match only, no guessing. */
export function mentionedPaths(texts: readonly string[], files: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const token of text.match(/[A-Za-z0-9_@.\-/]+\.[A-Za-z0-9]+/g) ?? []) {
      const path = token.replace(/^\.?\//, "").replace(/[.,;:]+$/, "");
      if (files.has(path) && !found.includes(path)) found.push(path);
    }
  }
  return found;
}

/** One short line per fact; the agent reads contents with its file tools. */
export function summarizeFile(file: FileSymbols | undefined): string {
  if (!file) return "Not in the symbol index.";
  if (file.skipped === "sensitive") return "Sensitive file: not indexed.";
  const parts: string[] = [];
  if (file.doc) parts.push(`Doc: ${file.doc}`);
  if (file.exports.length > 0) parts.push(`Exports: ${file.exports.slice(0, 20).join(", ")}`);
  const local = file.imports.filter((i) => i.resolved);
  if (local.length > 0) {
    parts.push(
      `Imports: ${local
        .slice(0, 10)
        .map((i) => `${i.resolved}${i.names.length ? ` (${i.names.slice(0, 6).join(", ")})` : ""}`)
        .join("; ")}`,
    );
  }
  if (file.skipped) parts.push(`Symbols not indexed: ${file.skipped}.`);
  return parts.join("\n") || "No exports or local imports.";
}

export type SelectInput = {
  projectId: string;
  symbols: SymbolIndex;
  deps: DependencyIndex;
  graph: ProductGraphStore | null;
  /** Exact, in priority order. Paths outside the tree are ignored. */
  declaredFiles: readonly string[];
  /** Task semantic resources. */
  resources: readonly string[];
  semantic: { status: SemanticStatus; matches: readonly SemanticMatch[] };
};

export function selectRetrieval(input: SelectInput): Retrieval {
  const byPath = new Map(input.symbols.files.map((f) => [f.path, f]));
  const chosen = new Set<string>();
  const files: RetrievedFile[] = [];
  const add = (tier: RetrievalTier, path: string, reason: string, score?: number) => {
    chosen.add(path);
    files.push({
      tier,
      path,
      reason,
      summary: summarizeFile(byPath.get(path)),
      ...(score === undefined ? {} : { score }),
    });
  };

  // 1. Task-declared files.
  for (const raw of input.declaredFiles) {
    const path = raw.replace(/^\.?\//, "");
    if (!byPath.has(path) || chosen.has(path)) continue;
    if (files.length >= RETRIEVAL_LIMITS.declared) break;
    add("declared", path, "declared by the Task or its upstream work");
  }

  // 2. Exact dependency neighbors of the declared files.
  const declared = [...chosen];
  let neighbors = 0;
  for (const path of declared) {
    const edges = input.deps.files[path];
    if (!edges) continue;
    const candidates: [string, string][] = [
      ...edges.imports.map((p): [string, string] => [p, `imported by ${path}`]),
      ...edges.importedBy.map((p): [string, string] => [p, `imports ${path}`]),
    ];
    for (const [neighbor, reason] of candidates) {
      if (neighbors >= RETRIEVAL_LIMITS.dependency) break;
      if (chosen.has(neighbor) || !byPath.has(neighbor)) continue;
      add("dependency", neighbor, reason);
      neighbors += 1;
    }
  }

  // 3. Exact semantic resource owners.
  const owners: Retrieval["owners"] = [];
  for (const resource of sorted(input.resources.map(normalizeResource))) {
    if (owners.length >= RETRIEVAL_LIMITS.owners || !input.graph) break;
    const exact = input.graph.resourceOwners[resource] ?? [];
    const area = areaOfResource(resource);
    const areaFiles = input.graph.areas.find((a) => a.id === area)?.files ?? [];
    const ownerFiles = sorted([...exact, ...areaFiles].filter((p) => byPath.has(p))).slice(
      0,
      RETRIEVAL_LIMITS.ownerFiles,
    );
    if (ownerFiles.length > 0) owners.push({ resource, files: ownerFiles });
  }

  // 5. Vectorize: same Project, a path of this tree, above the floor, not already included.
  let refused = 0;
  const accepted: { path: string; score: number }[] = [];
  for (const match of input.semantic.matches) {
    const meta = match.metadata ?? {};
    const path = typeof meta.path === "string" ? meta.path : null;
    const sameProject = meta.projectId === input.projectId;
    if (
      !sameProject ||
      !path ||
      !byPath.has(path) ||
      !(match.score >= RETRIEVAL_LIMITS.minScore) ||
      chosen.has(path) ||
      accepted.some((a) => a.path === path)
    ) {
      refused += 1;
      continue;
    }
    accepted.push({ path, score: match.score });
  }
  accepted.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  for (const { path, score } of accepted.slice(0, RETRIEVAL_LIMITS.semantic)) {
    add("semantic", path, `semantic match ${score.toFixed(2)} (Vectorize)`, score);
  }
  refused += Math.max(0, accepted.length - RETRIEVAL_LIMITS.semantic);

  return {
    projectId: input.projectId,
    treeSha: input.symbols.treeSha,
    commit: input.symbols.commit,
    files,
    owners,
    semantic: { status: input.semantic.status, returned: input.semantic.matches.length, refused },
  };
}

export type RetrievalReaders = {
  /** Reads one JSON object from R2, or null when it does not exist. */
  read: (key: string) => Promise<unknown | null>;
  /**
   * Vectorize top-k for the Project (namespace = Project ID). Absent: no semantic step. Called only
   * after the exact indexes loaded.
   */
  search?: (text: string, projectId: string, topK: number) => Promise<SemanticMatch[] | null>;
};

export type LoadInput = {
  projectId: string;
  treeSha: string;
  /** Task title, objective, and acceptance criteria: scanned for exact paths, then embedded. */
  taskTexts: readonly string[];
  /** Upstream Intent expected files and inherited ChangeSet files, in priority order. */
  upstreamFiles: readonly string[];
  resources: readonly string[];
};

/**
 * Loads the stored indexes of the canonical tree and selects context. Returns null when the tree
 * has no index yet: the packet then carries only the exact file list (no Vectorize either).
 */
export async function loadRetrieval(
  readers: RetrievalReaders,
  input: LoadInput,
): Promise<Retrieval | null> {
  const keys = indexKeys(input.projectId, input.treeSha);
  const [symbols, deps, graph] = (await Promise.all([
    readers.read(keys.symbols),
    readers.read(keys.deps),
    readers.read(keys.productGraph),
  ])) as [SymbolIndex | null, DependencyIndex | null, ProductGraphStore | null];
  if (!symbols || !deps || symbols.projectId !== input.projectId) return null;

  const paths = new Set(symbols.files.map((f) => f.path));
  const declaredFiles = [...mentionedPaths(input.taskTexts, paths), ...input.upstreamFiles];

  let semantic: SelectInput["semantic"] = { status: "skipped", matches: [] };
  const query = input.taskTexts.join("\n").trim().slice(0, 2000);
  if (readers.search && query) {
    try {
      const matches = await readers.search(query, input.projectId, RETRIEVAL_LIMITS.semantic * 2);
      semantic = matches ? { status: "ok", matches } : { status: "skipped", matches: [] };
    } catch {
      semantic = { status: "error", matches: [] };
    }
  }

  return selectRetrieval({
    projectId: input.projectId,
    symbols,
    deps,
    graph: graph?.projectId === input.projectId ? graph : null,
    declaredFiles,
    resources: input.resources,
    semantic,
  });
}
