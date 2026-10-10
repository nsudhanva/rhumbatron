import {
  CodeManifest,
  codeBlobKey,
  codeManifestKey,
  MAX_CODE_BLOB_BYTES,
} from "@rhumbatron/protocol";

const MAX_FILES = 400;
const MAX_BYTES = 8 * 1024 * 1024;
const PREFIX = "__rhumbatron_check";

/** Validate before an R2 read; RPC callers cannot choose a bucket key. */
export function validateCheckSource(projectId: string, treeSha: string) {
  if (!/^proj_[a-z0-9-]+$/.test(projectId) || !/^[0-9a-f]{40}$/.test(treeSha)) {
    throw new Error("Invalid project or tree ID.");
  }
}

export function checkSourceManifest(value: unknown, treeSha: string) {
  const manifest = CodeManifest.parse(value);
  if (!manifest.complete || manifest.treeSha !== treeSha)
    throw new Error("Missing or incomplete source tree.");
  if (manifest.entries.length > MAX_FILES) throw new Error("Source tree exceeds 400 files.");
  const paths = new Set<string>();
  let size = 0;
  for (const entry of manifest.entries) {
    const parts = entry.path.split("/");
    if (
      parts.some((p) => !p || p === "." || p === ".." || p.startsWith(PREFIX)) ||
      Array.from(entry.path).some((c) => c === "\\" || c.charCodeAt(0) < 32) ||
      paths.has(entry.path)
    ) {
      throw new Error("Invalid, duplicate, or reserved source path.");
    }
    paths.add(entry.path);
    if (!entry.stored || entry.size === null || entry.size > MAX_CODE_BLOB_BYTES)
      throw new Error(`Unavailable source: ${entry.path}`);
    size += entry.size;
    if (/\.(node|wasm)$/.test(entry.path))
      throw new Error("Native or binary dependencies need Sandbox verification.");
  }
  if (size > MAX_BYTES) throw new Error("Source tree exceeds 8 MB.");
  return manifest;
}

/** Canonical AND Candidate trees must be copied with storeTreeCode before this read. No backfill. */
export async function readCheckSource(
  bucket: Pick<R2Bucket, "get">,
  projectId: string,
  treeSha: string,
) {
  validateCheckSource(projectId, treeSha);
  const object = await bucket.get(codeManifestKey(projectId, treeSha));
  if (!object || object.size > MAX_CODE_BLOB_BYTES)
    throw new Error("Missing or oversized code manifest.");
  const manifest = checkSourceManifest(await object.json(), treeSha);
  const files: Record<string, string> = Object.create(null);
  // Sequential reads bound memory and subrequests; no silent omission of tests or scripts.
  for (const entry of manifest.entries) {
    const blob = await bucket.get(codeBlobKey(projectId, entry.blob));
    if (!blob || blob.size !== entry.size || blob.size > MAX_CODE_BLOB_BYTES)
      throw new Error(`Missing or changed blob: ${entry.path}`);
    const bytes = await blob.arrayBuffer();
    if (new Uint8Array(bytes).includes(0))
      throw new Error(`Binary source needs Sandbox verification: ${entry.path}`);
    files[entry.path] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  return { manifest, files };
}
