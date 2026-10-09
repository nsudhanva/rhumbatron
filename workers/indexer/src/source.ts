import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createFsFromVolume, Volume } from "memfs";
import { MAX_INDEXED_FILES } from "./build.ts";
import { MAX_PARSE_BYTES, needsContent } from "./parse.ts";

/**
 * Reads one canonical commit from the Project's Artifacts repo with isomorphic-git over an
 * in-memory file system (same approach as workers/integration canonical-source.ts). Cost is
 * constant in Artifacts operations: repo lookup, one read token, one fetch (ref advertisement plus
 * upload-pack), and the token revoke. No Sandbox time. Blobs are read from the local pack.
 */

const DIR = "/repo";

/** Paths never listed: vendored or generated trees. */
const IGNORED = /(^|\/)(node_modules|\.git|dist|build|\.turbo|\.wrangler|coverage)\//;

export type SourceFile = { path: string; blob: string; content: string | null };
export type SourceTree = { files: SourceFile[]; truncated: boolean };

type GitFs = Parameters<typeof git.init>[0]["fs"];

async function walk(
  fs: GitFs,
  oid: string,
  prefix: string,
  out: SourceFile[],
  cap: { hit: boolean },
) {
  const { tree } = await git.readTree({ fs, dir: DIR, oid });
  for (const entry of tree) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === "tree") {
      if (!IGNORED.test(`${path}/`)) await walk(fs, entry.oid, path, out, cap);
      continue;
    }
    if (entry.type !== "blob") continue;
    if (out.length >= MAX_INDEXED_FILES) {
      cap.hit = true;
      return;
    }
    let content: string | null = null;
    if (needsContent(path)) {
      const { blob } = await git.readBlob({ fs, dir: DIR, oid: entry.oid });
      content = blob.byteLength > MAX_PARSE_BYTES ? null : new TextDecoder().decode(blob);
    }
    out.push({ path, blob: entry.oid, content });
  }
}

export async function readCanonicalTree(
  artifacts: Artifacts,
  projectId: string,
  commit: string,
  treeSha: string,
): Promise<SourceTree> {
  using repo = await artifacts.get(projectId);
  const info = await repo.info();
  const token = await repo.createToken("read", 600);
  const secret = token.plaintext.split("?expires=")[0] ?? token.plaintext;
  try {
    const fs = createFsFromVolume(new Volume()) as unknown as GitFs;
    await git.init({ fs, dir: DIR, defaultBranch: "main" });
    await git.addRemote({ fs, dir: DIR, remote: "origin", url: info.remote, force: true });
    await git.fetch({
      fs,
      http,
      dir: DIR,
      remote: "origin",
      url: info.remote,
      ref: "main",
      singleBranch: true,
      tags: false,
      onAuth: () => ({ username: "x", password: secret }),
    });
    const { commit: meta } = await git.readCommit({ fs, dir: DIR, oid: commit });
    if (meta.tree !== treeSha) {
      throw new Error(
        `commit ${commit.slice(0, 12)} has tree ${meta.tree.slice(0, 12)}, expected ${treeSha.slice(0, 12)}`,
      );
    }
    const files: SourceFile[] = [];
    const cap = { hit: false };
    await walk(fs, treeSha, "", files, cap);
    return { files, truncated: cap.hit };
  } finally {
    await repo.revokeToken(token.id).catch(() => false);
  }
}
