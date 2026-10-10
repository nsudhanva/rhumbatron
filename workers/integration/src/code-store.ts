import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  type CodeEntry,
  CodeManifest,
  codeBlobKey,
  codeManifestKey,
  MAX_CODE_BLOB_BYTES,
  sourceIndexKey,
} from "@rhumbatron/protocol";

/**
 * Code store (P16-16): the bytes of every canonical tree, readable by tree and path from R2.
 * Blobs are content-addressed (`source/<project>/blobs/<blob sha>`), so a file that did not change
 * between generations is never copied twice. A tree's `code.json` maps its paths to blobs.
 *
 * Cost per call: one Artifacts `readTree` per directory (only when no manifest exists yet), one
 * R2 head per blob not known from the previous tree, and one Artifacts `readBlob` plus one R2 put
 * per new blob. A promotion that changes 3 files costs about 3 reads and 3 puts.
 */

/** Bounded per call; the next call (promotion retry or a code read) continues the copy. */
const MAX_BLOB_WRITES = 400;
const PARALLEL = 8;
/** Must match MAX_INDEXED_FILES in provision.ts and workers/api/src/workspace.ts. */
const MAX_FILES = 2000;

type CodeEnv = Pick<Env, "EVIDENCE">;

/** Walks a tree with the binding: one readTree per directory, no blob reads. */
export async function walkTree(repo: ArtifactsRepo, treeSha: string): Promise<CodeEntry[]> {
  const entries: CodeEntry[] = [];
  const pending: [string, string][] = [["", treeSha]];
  while (pending.length > 0 && entries.length < MAX_FILES) {
    const [prefix, hash] = pending.shift() ?? ["", ""];
    for (const entry of (await repo.readTree(hash)) ?? []) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === "tree") pending.push([path, entry.hash]);
      else if (entry.type === "blob" || entry.type === "exec") {
        entries.push({ path, blob: entry.hash, size: null, stored: false });
      }
    }
  }
  return entries.slice(0, MAX_FILES).sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function readManifest(env: CodeEnv, key: string): Promise<CodeManifest | null> {
  const object = await env.EVIDENCE.get(key);
  if (!object) return null;
  const parsed = CodeManifest.safeParse(await object.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/** A blob is done when it is in R2, or when it is too large to copy. */
const settled = (e: CodeEntry) => e.stored || (e.size !== null && e.size > MAX_CODE_BLOB_BYTES);

/**
 * Copies the blobs of one canonical tree to R2 and writes its `code.json`. Safe to repeat: a
 * complete manifest returns at once. `previousTreeSha` names the tree this one replaced; its
 * stored blobs are known, so they need no R2 head.
 */
export async function storeTreeCode(
  env: CodeEnv,
  repo: ArtifactsRepo,
  input: {
    projectId: string;
    commit: string;
    treeSha: string;
    previousTreeSha?: string | undefined;
    /** Entries from a walk the caller already did. */
    entries?: CodeEntry[] | undefined;
  },
): Promise<{ complete: boolean; written: number }> {
  const key = codeManifestKey(input.projectId, input.treeSha);
  const existing = await readManifest(env, key);
  if (existing?.complete) return { complete: true, written: 0 };
  const entries = (existing?.entries ?? input.entries ?? (await walkTree(repo, input.treeSha))).map(
    (e) => ({ ...e }),
  );

  const known = new Map<string, number | null>();
  if (input.previousTreeSha && input.previousTreeSha !== input.treeSha) {
    const previous = await readManifest(
      env,
      codeManifestKey(input.projectId, input.previousTreeSha),
    );
    for (const e of previous?.entries ?? []) if (e.stored) known.set(e.blob, e.size);
  }

  const byBlob = new Map<string, CodeEntry[]>();
  for (const entry of entries) {
    if (settled(entry)) continue;
    const size = known.get(entry.blob);
    if (size !== undefined) {
      entry.size = size;
      entry.stored = true;
      continue;
    }
    byBlob.set(entry.blob, [...(byBlob.get(entry.blob) ?? []), entry]);
  }

  let written = 0;
  const blobs = [...byBlob.keys()];
  for (let i = 0; i < blobs.length && written < MAX_BLOB_WRITES; i += PARALLEL) {
    const batch = blobs.slice(i, i + PARALLEL);
    await Promise.all(
      batch.map(async (blob) => {
        const blobKey = codeBlobKey(input.projectId, blob);
        const head = await env.EVIDENCE.head(blobKey);
        let size: number | null = head?.size ?? null;
        let stored = !!head;
        if (!head) {
          const data = await repo.readBlob(blob);
          if (!data) return;
          size = data.size;
          if (size <= MAX_CODE_BLOB_BYTES) {
            await env.EVIDENCE.put(blobKey, await data.arrayBuffer(), {
              customMetadata: { blob },
            });
            stored = true;
            written += 1;
          }
        }
        for (const entry of byBlob.get(blob) ?? []) {
          entry.size = size;
          entry.stored = stored;
        }
      }),
    );
  }

  const manifest: CodeManifest = {
    commit: input.commit,
    treeSha: input.treeSha,
    entries,
    complete: entries.every(settled),
  };
  await env.EVIDENCE.put(key, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  });
  return { complete: manifest.complete, written };
}

export type CodeBackfill =
  | { status: "complete" | "partial"; written: number }
  | { status: "unknown_tree" };

/**
 * Backfill for a code read (API RPC): makes the code of one canonical tree readable. Only trees
 * that were canonical (they have a file index) or are canonical now are accepted, so a caller
 * cannot make this Worker read arbitrary objects. Repos are named by the Project ID only.
 */
export async function backfillTreeCode(
  env: Pick<Env, "EVIDENCE" | "ARTIFACTS" | "PROJECT_ROOT">,
  input: { projectId: string; treeSha: string },
): Promise<CodeBackfill> {
  const indexObject = await env.EVIDENCE.get(sourceIndexKey(input.projectId, input.treeSha));
  let commit = indexObject
    ? ((await indexObject.json().catch(() => null)) as { commit?: string } | null)?.commit
    : undefined;
  using repo = await env.ARTIFACTS.get(input.projectId);
  if (!commit) {
    const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
    const canonical = await root.get(root.idFromName(input.projectId)).getCanonical();
    if (canonical?.treeSha !== input.treeSha) return { status: "unknown_tree" };
    const [head] = await repo.log({ ref: "main", limit: 1 });
    if (head?.treeHash !== input.treeSha) return { status: "unknown_tree" };
    commit = head.hash;
  }
  const result = await storeTreeCode(env, repo, {
    projectId: input.projectId,
    commit,
    treeSha: input.treeSha,
  });
  return { status: result.complete ? "complete" : "partial", written: result.written };
}
