import {
  areaOfResource,
  type DependencyIndex,
  type FileSymbols,
  INDEX_VERSION,
  normalizeResource,
  type ProductArea,
  type ProductGraphStore,
  type SymbolIndex,
} from "@rhumbatron/context-compiler";
import { extractSymbols, type ParseInput } from "./parse.ts";

/**
 * Builds the exact indexes of one canonical tree. Pure and deterministic:
 * the same files and owner rows give byte-identical JSON, so a rebuild of a tree is a no-op.
 *
 * Product areas follow documented path rules, not inference:
 * - Area files are code files under `src/` (or the repository root when there is no `src/`),
 *   except tests, benchmarks, scripts, and declaration files.
 * - `src/<dir>/...` belongs to area `<dir>`; `src/<name>.ts` belongs to area `<name>`.
 * - `src/app.*` is the HTTP surface and maps to `storefront` (AREA_ALIASES).
 * - Root files named in WIRING (`store`, `server`, `worker`, `index`, `main`, `env`, `config`) are
 *   runtime wiring: they get no node, and an import through them is followed to the real area.
 */

export const MAX_INDEXED_FILES = 500;

const AREA_ALIASES: Record<string, string> = { app: "storefront" };
const WIRING = new Set(["store", "server", "worker", "index", "main", "env", "config"]);
const NOT_AREA =
  /(^|\/)(test|tests|__tests__|bench|benchmarks|scripts|e2e|fixtures)\/|\.(test|spec|bench)\.[a-z]+$|\.d\.ts$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export type OwnerRow = { resources: string[]; files: string[] };

export type BuildInput = {
  projectId: string;
  treeSha: string;
  commit: string;
  truncated: boolean;
  files: ParseInput[];
  /** Resources and files of promoted ChangeSets, oldest first. */
  owners: OwnerRow[];
};

const sorted = (items: Iterable<string>) => [...new Set(items)].sort();

function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** Repository path of a relative import, or null for a package or a path the tree lacks. */
function resolveImport(from: string, source: string, paths: ReadonlySet<string>) {
  if (!source.startsWith("./") && !source.startsWith("../")) return null;
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const base = normalizePath(dir ? `${dir}/${source}` : source);
  if (base === null) return null;
  // TypeScript ESM style: `./cart.js` names `./cart.ts`.
  const stem = base.replace(/\.(m|c)?jsx?$/, "");
  const candidates = [
    base,
    ...EXTENSIONS.map((e) => `${base}${e}`),
    ...(stem !== base ? EXTENSIONS.map((e) => `${stem}${e}`) : []),
    ...EXTENSIONS.map((e) => `${base}/index${e}`),
  ];
  return candidates.find((c) => paths.has(c)) ?? null;
}

function sourceRoot(files: readonly FileSymbols[]): string {
  return files.some((f) => f.lang !== "other" && f.path.startsWith("src/")) ? "src/" : "";
}

/** Area of a code file, `wiring`, or null when the file is not part of any area. */
function areaOfPath(path: string, root: string): string | null | "wiring" {
  if (!path.startsWith(root) || NOT_AREA.test(path)) return null;
  const rel = path.slice(root.length);
  const parts = rel.split("/");
  let key: string;
  if (parts.length > 1) key = parts[0] ?? "";
  else {
    key = rel.replace(/\.[^.]+$/, "");
    if (WIRING.has(key)) return "wiring";
  }
  const area = (AREA_ALIASES[key] ?? key).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return /^[a-z][a-z0-9-]*$/.test(area) ? area : null;
}

const importDetail = (i: FileSymbols["imports"][number]) =>
  `${i.typeOnly ? "type " : ""}${i.names.join(", ") || "side effects"} from ${i.source}`;

export function buildIndexes(input: BuildInput): {
  symbols: SymbolIndex;
  deps: DependencyIndex;
  graph: ProductGraphStore;
} {
  const ordered = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const paths = new Set(ordered.map((f) => f.path));
  const files = ordered.map((f) => {
    const symbols = extractSymbols(f);
    return {
      ...symbols,
      imports: symbols.imports.map((i) => ({
        ...i,
        resolved: resolveImport(f.path, i.source, paths),
      })),
    };
  });
  const byPath = new Map(files.map((f) => [f.path, f]));

  // Dependency index: in-repo imports both ways, and symbol -> importing files.
  const depFiles: DependencyIndex["files"] = {};
  const symbolRefs = new Map<string, Set<string>>();
  for (const f of files) {
    if (f.lang === "other") continue;
    depFiles[f.path] ??= { imports: [], importedBy: [] };
  }
  for (const f of files) {
    if (f.lang === "other") continue;
    const entry = depFiles[f.path];
    if (!entry) continue;
    for (const i of f.imports) {
      if (!i.resolved) continue;
      entry.imports.push(i.resolved);
      depFiles[i.resolved] ??= { imports: [], importedBy: [] };
      const target = depFiles[i.resolved] as { imports: string[]; importedBy: string[] };
      target.importedBy.push(f.path);
      for (const name of i.names) {
        if (name === "*" || name === "?") continue;
        const key = `${i.resolved}#${name}`;
        let refs = symbolRefs.get(key);
        if (!refs) {
          refs = new Set();
          symbolRefs.set(key, refs);
        }
        refs.add(f.path);
      }
    }
  }
  for (const entry of Object.values(depFiles)) {
    entry.imports = sorted(entry.imports);
    entry.importedBy = sorted(entry.importedBy);
  }
  const depSymbols: DependencyIndex["symbols"] = {};
  for (const key of [...symbolRefs.keys()].sort())
    depSymbols[key] = sorted(symbolRefs.get(key) ?? []);

  // Product Graph: areas from paths, imports between areas (through wiring files).
  const root = sourceRoot(files);
  const areaFiles = new Map<string, string[]>();
  const fileArea = new Map<string, string | "wiring">();
  for (const f of files) {
    if (f.lang === "other") continue;
    const area = areaOfPath(f.path, root);
    if (!area) continue;
    fileArea.set(f.path, area);
    if (area !== "wiring") areaFiles.set(area, [...(areaFiles.get(area) ?? []), f.path]);
  }
  const edgeMap = new Map<string, Map<string, { file: string; detail: string }>>();
  const addEdge = (from: string, to: string, file: string, detail: string) => {
    if (from === to) return;
    const id = `${from}->${to}`;
    let imports = edgeMap.get(id);
    if (!imports) {
      imports = new Map();
      edgeMap.set(id, imports);
    }
    imports.set(`${file}\0${detail}`, { file, detail });
  };
  for (const [path, area] of fileArea) {
    if (area === "wiring") continue;
    const visited = new Set<string>([path]);
    const walk = (file: string, via: string | null) => {
      for (const i of byPath.get(file)?.imports ?? []) {
        if (!i.resolved || visited.has(i.resolved)) continue;
        const target = fileArea.get(i.resolved);
        if (target === "wiring") {
          visited.add(i.resolved);
          walk(i.resolved, i.resolved);
        } else if (target) {
          addEdge(
            area,
            target,
            file,
            via ? `${importDetail(i)}, reached from ${path}` : importDetail(i),
          );
        }
      }
    };
    walk(path, null);
  }

  // Semantic resources and exact owners from promoted ChangeSets.
  const areaResources = new Map<string, Set<string>>();
  const owners = new Map<string, Set<string>>();
  for (const row of input.owners) {
    const rowFiles = row.files.map((p) => p.replace(/^\.?\//, "")).filter((p) => paths.has(p));
    for (const raw of row.resources) {
      const resource = normalizeResource(raw);
      if (!resource) continue;
      const area = areaOfResource(resource);
      if (area && areaFiles.has(area)) {
        let set = areaResources.get(area);
        if (!set) {
          set = new Set();
          areaResources.set(area, set);
        }
        set.add(resource);
      }
      if (rowFiles.length === 0) continue;
      let set = owners.get(resource);
      if (!set) {
        set = new Set();
        owners.set(resource, set);
      }
      for (const p of rowFiles) set.add(p);
    }
  }
  const resourceOwners: ProductGraphStore["resourceOwners"] = {};
  for (const key of [...owners.keys()].sort()) resourceOwners[key] = sorted(owners.get(key) ?? []);

  const areas: ProductArea[] = [...areaFiles.keys()].sort().map((id) => ({
    id,
    files: sorted(areaFiles.get(id) ?? []),
    resources: sorted(areaResources.get(id) ?? []),
  }));
  const edges = [...edgeMap.keys()].sort().map((id) => {
    const [from = "", to = ""] = id.split("->");
    const imports = [...(edgeMap.get(id)?.values() ?? [])].sort(
      (a, b) => a.file.localeCompare(b.file) || a.detail.localeCompare(b.detail),
    );
    return { from, to, imports };
  });

  const head = {
    version: INDEX_VERSION,
    projectId: input.projectId,
    treeSha: input.treeSha,
  } as const;
  return {
    symbols: { ...head, commit: input.commit, truncated: input.truncated, files },
    deps: { ...head, files: depFiles, symbols: depSymbols },
    graph: {
      ...head,
      areas,
      edges,
      resourceOwners,
      wiringFiles: sorted([...fileArea].filter(([, a]) => a === "wiring").map(([p]) => p)),
    },
  };
}
