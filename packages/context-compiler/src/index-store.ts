/**
 * Stored indexes of one canonical tree (AGENTS.md sections 12.7, 27.1, 28; P7-02 to P7-05).
 * The indexer Worker writes them; the Context Compiler and the Product Graph API read them.
 *
 * R2 layout, one prefix per tree (content-addressed by the Git tree SHA, so a tree is built once):
 *   index/<project>/<tree>/symbols.json        exact symbol index
 *   index/<project>/<tree>/deps.json           exact dependency index
 *   index/<project>/<tree>/product-graph.json  semantic areas, resource owners, area imports
 *   index/<project>/vectors.json               the Vectorize entries that exist for the Project
 * D1 `project_indexes` (migration 0013) points at the prefix once all three objects exist.
 *
 * Every object is deterministic for its inputs (no timestamps), so a rebuild writes the same bytes.
 */

export const INDEX_VERSION = 1;

/** Workers AI embedding model and its width. The Vectorize index must use the same dimensions. */
export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBEDDING_DIMENSIONS = 384;

export const indexPrefix = (projectId: string, treeSha: string) => `index/${projectId}/${treeSha}/`;
export const indexKeys = (projectId: string, treeSha: string) => {
  const prefix = indexPrefix(projectId, treeSha);
  return {
    symbols: `${prefix}symbols.json`,
    deps: `${prefix}deps.json`,
    productGraph: `${prefix}product-graph.json`,
  };
};
export const vectorManifestKey = (projectId: string) => `index/${projectId}/vectors.json`;

export type DeclarationKind =
  | "function"
  | "class"
  | "const"
  | "let"
  | "var"
  | "type"
  | "interface"
  | "enum";

export type FileSymbols = {
  path: string;
  /** Git blob ID: unchanged blobs keep their embedding. */
  blob: string;
  lang: "ts" | "js" | "other";
  /** Why the file has no symbols, when it has none on purpose. */
  skipped?: "too_large" | "parse_error" | "sensitive" | "not_code";
  /** Exported names, `default` for a default export. Sorted. */
  exports: string[];
  /** Top-level declarations, in source order. */
  declarations: { name: string; kind: DeclarationKind; exported: boolean; line: number }[];
  /** Import and re-export statements, in source order. */
  imports: {
    source: string;
    names: string[];
    typeOnly: boolean;
    /** Repository path of a relative import, or null for a package or an unresolved path. */
    resolved: string | null;
  }[];
  /** First line of the first leading doc comment (JSDoc or line comment), if any. */
  doc: string | null;
};

export type SymbolIndex = {
  version: typeof INDEX_VERSION;
  projectId: string;
  treeSha: string;
  commit: string;
  /** True when the 500-file cap cut the tree. */
  truncated: boolean;
  files: FileSymbols[];
};

export type DependencyIndex = {
  version: typeof INDEX_VERSION;
  projectId: string;
  treeSha: string;
  /** file -> files it imports (resolved, in-repo only) and files that import it. Sorted. */
  files: Record<string, { imports: string[]; importedBy: string[] }>;
  /** `<path>#<symbol>` -> files that import that symbol by name. Sorted. */
  symbols: Record<string, string[]>;
};

export type ProductArea = {
  /** Area key, for example `cart`. */
  id: string;
  /** Source files whose path maps to the area. Sorted. */
  files: string[];
  /** Semantic resources of promoted ChangeSets that touched the area. Sorted. */
  resources: string[];
};

export type ProductGraphStore = {
  version: typeof INDEX_VERSION;
  projectId: string;
  treeSha: string;
  areas: ProductArea[];
  /** `from` imports `to`; wiring files are followed through, see `wiringFiles`. */
  edges: { from: string; to: string; imports: { file: string; detail: string }[] }[];
  /**
   * Semantic resource -> files of the promoted ChangeSets that declared it and still exist in
   * this tree. Exact ownership for the Context Compiler (section 27.3 step 3).
   */
  resourceOwners: Record<string, string[]>;
  /** Source files that are runtime wiring, not a product area. */
  wiringFiles: string[];
};

/**
 * Vectorize entries that exist for one Project, per path: vector ID and the SHA-256 of the text it
 * embeds. An unchanged text is not embedded again.
 */
export type VectorManifest = {
  version: typeof INDEX_VERSION;
  projectId: string;
  treeSha: string;
  entries: Record<string, { id: string; hash: string }>;
};

/** Metadata stored with each vector. Queries check every field before trusting a match. */
export type VectorMetadata = { projectId: string; treeSha: string; path: string };

/** Lowercase, `project:<slug>:` stripped (same rule as packages/conflict normalizeResource). */
export function normalizeResource(resource: string): string {
  return resource
    .trim()
    .toLowerCase()
    .replace(/^project:[a-z0-9-]+:/, "");
}

/** Area of a semantic resource: its first segment (`wishlist:membership` -> `wishlist`). */
export function areaOfResource(resource: string): string | null {
  const head = normalizeResource(resource).split(/[:./]/)[0] ?? "";
  return /^[a-z][a-z0-9-]*$/.test(head) ? head : null;
}
