import {
  type FileSymbols,
  INDEX_VERSION,
  type VectorManifest,
  type VectorMetadata,
} from "@rhumbatron/context-compiler";

/**
 * Semantic memory (P7-05). One vector per code file, keyed by Project and path, so a Project holds
 * at most one vector per current file however many trees it had. A new tree re-embeds only files
 * whose embedding text changed and deletes the vectors of removed files (stale cleanup).
 *
 * The embedded text is the path, exported symbols, local imports, and the first doc line. Never
 * file contents, and never a sensitive file (parse.ts SENSITIVE): those have no embedding text.
 */

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Vector ID: SHA-256 of `<project>\0<path>` in hex, 64 bytes (the Vectorize ID limit). */
const vectorId = (projectId: string, path: string) => sha256(`${projectId}\0${path}`);

/** Text to embed for a file, or null when the file must not have a vector. */
function embeddingText(file: FileSymbols): string | null {
  if (file.lang === "other" || file.skipped === "sensitive") return null;
  const lines = [file.path];
  if (file.doc) lines.push(file.doc);
  if (file.exports.length > 0) lines.push(`exports ${file.exports.slice(0, 40).join(", ")}`);
  const local = file.imports.filter((i) => i.resolved).map((i) => i.resolved);
  if (local.length > 0) lines.push(`imports ${[...new Set(local)].slice(0, 20).join(", ")}`);
  const decls = file.declarations.filter((d) => !d.exported).map((d) => d.name);
  if (decls.length > 0) lines.push(`declares ${decls.slice(0, 20).join(", ")}`);
  return lines.join("\n").slice(0, 1500);
}

export type VectorPlan = {
  /** Files to embed and upsert (new path or changed text). */
  upsert: { file: FileSymbols; id: string; text: string }[];
  /** Vector IDs of paths that left the tree or lost their embedding text. */
  remove: string[];
  /** The manifest after the plan is applied. */
  next: VectorManifest;
};

export async function planVectors(
  projectId: string,
  treeSha: string,
  previous: VectorManifest | null,
  files: readonly FileSymbols[],
): Promise<VectorPlan> {
  const prev = previous?.projectId === projectId ? previous.entries : {};
  const entries: VectorManifest["entries"] = {};
  const upsert: VectorPlan["upsert"] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const text = embeddingText(file);
    if (text === null) continue;
    const id = prev[file.path]?.id ?? (await vectorId(projectId, file.path));
    const hash = await sha256(text);
    entries[file.path] = { id, hash };
    if (prev[file.path]?.hash !== hash) upsert.push({ file, id, text });
  }
  const remove = Object.keys(prev)
    .filter((path) => !entries[path])
    .sort()
    .map((path) => prev[path]?.id ?? "")
    .filter(Boolean);
  return { upsert, remove, next: { version: INDEX_VERSION, projectId, treeSha, entries } };
}

export const vectorMetadata = (
  projectId: string,
  treeSha: string,
  path: string,
): VectorMetadata => ({
  projectId,
  treeSha,
  path,
});
