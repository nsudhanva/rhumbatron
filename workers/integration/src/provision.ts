import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { sourceIndexKey } from "@rhumbatron/protocol";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createFsFromVolume, Volume } from "memfs";
import { storeTreeCode, walkTree } from "./code-store.ts";
import acmeShop from "./fixtures/acme-shop.fixture.gen.ts";

/**
 * Project source provisioning (AGENTS.md sections 29.1 and 54). One Artifacts repo per Project,
 * named by the Project ID. A template seeds the first commit with isomorphic-git over an in-memory
 * file system, then that commit becomes Canonical Generation 0. Safe to repeat.
 */

const TEMPLATES: Record<string, Record<string, string>> = { "acme-shop": acmeShop };

const DIR = "/repo";
const AUTHOR = { name: "Rhumbatron", email: "bot@rhumbatron.com" };

type Provisioned = {
  artifactRef: string;
  commit: string;
  treeSha: string;
  seeded: boolean;
  files: number;
};

/** File index of one canonical tree, stored once per tree in R2 (Context Compiler input, P7-02). */
export type SourceIndex = { commit: string; treeSha: string; files: string[] };

/**
 * Writes the file index of one canonical tree once, then copies its file contents to the code
 * store (P16-16). Readers resolve the canonical commit from the index
 * (`source/<project>/<tree>/index.json`), so it must exist only once that commit is on `main`.
 * `previousTreeSha` is the canonical tree this one replaced: its blobs need no copy check.
 * Returns the number of indexed files, or 0 when the index already existed.
 */
export async function ensureSourceIndex(
  env: Env,
  repo: ArtifactsRepo,
  projectId: string,
  head: { commit: string; treeSha: string },
  previousTreeSha?: string,
): Promise<number> {
  const key = sourceIndexKey(projectId, head.treeSha);
  let written = 0;
  let entries: Awaited<ReturnType<typeof walkTree>> | undefined;
  const existing = await env.EVIDENCE.get(key);
  if (existing) {
    // A rollback (P16-13) makes an earlier tree canonical again under a new commit. Readers resolve
    // the canonical commit from this index, so it must name the commit now on `main`.
    const index = (await existing.json().catch(() => null)) as SourceIndex | null;
    if (index && index.commit !== head.commit) {
      await env.EVIDENCE.put(key, JSON.stringify({ ...index, commit: head.commit }), {
        httpMetadata: { contentType: "application/json" },
      });
    }
  } else {
    entries = await walkTree(repo, head.treeSha);
    const index: SourceIndex = {
      commit: head.commit,
      treeSha: head.treeSha,
      files: entries.map((e) => e.path),
    };
    await env.EVIDENCE.put(key, JSON.stringify(index), {
      httpMetadata: { contentType: "application/json" },
    });
    written = index.files.length;
  }
  // The code store is a read model: a failure here must not fail provisioning or the source
  // sync. The API backfills a missing or partial tree on its first code read.
  try {
    await storeTreeCode(env, repo, { projectId, ...head, previousTreeSha, entries });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "code_store.failed",
        projectId,
        treeSha: head.treeSha,
        error: String(error).slice(0, 200),
      }),
    );
  }
  return written;
}

function isNotFound(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  return code === "NOT_FOUND" || (error instanceof Error && /not.?found/i.test(error.message));
}

/** Pushes the template as one commit on `main`. Tokens live 10 minutes and never leave this call. */
async function seed(remote: string, token: string, files: Record<string, string>): Promise<string> {
  const fs = createFsFromVolume(new Volume()) as unknown as Parameters<typeof git.init>[0]["fs"];
  await git.init({ fs, dir: DIR, defaultBranch: "main" });
  for (const [path, content] of Object.entries(files)) {
    const full = `${DIR}/${path}`;
    await (
      fs as unknown as { promises: { mkdir(p: string, o: object): Promise<void> } }
    ).promises.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await (
      fs as unknown as { promises: { writeFile(p: string, c: string): Promise<void> } }
    ).promises.writeFile(full, content);
    await git.add({ fs, dir: DIR, filepath: path });
  }
  const commit = await git.commit({
    fs,
    dir: DIR,
    message: "Acme Shop baseline (S0)",
    author: AUTHOR,
  });
  const secret = token.split("?expires=")[0] ?? token;
  const result = await git.push({
    fs,
    http,
    dir: DIR,
    url: remote,
    ref: "main",
    onAuth: () => ({ username: "x", password: secret }),
  });
  if (!result.ok) throw new Error(`push failed: ${JSON.stringify(result.refs).slice(0, 200)}`);
  return commit;
}

export async function provisionProject(
  env: Env,
  input: { projectId: string; template: string },
): Promise<Provisioned> {
  const files = TEMPLATES[input.template];
  let seeded = false;
  let repo: ArtifactsRepo;
  try {
    repo = await env.ARTIFACTS.get(input.projectId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const created = await env.ARTIFACTS.create(input.projectId, {
      description: `Rhumbatron project ${input.projectId}`,
      setDefaultBranch: "main",
    });
    if (files) {
      await seed(created.remote, created.token, files);
      seeded = true;
    }
    repo = await env.ARTIFACTS.get(input.projectId);
  }

  let [head] = await repo.log({ ref: "main", limit: 1 });
  if (!head && files) {
    // Created earlier but the seed did not land: push it now with a short-lived token.
    const info = await repo.info();
    const token = await repo.createToken("write", 600);
    await seed(info.remote, token.plaintext, files);
    seeded = true;
    [head] = await repo.log({ ref: "main", limit: 1 });
  }
  if (!head) throw new Error(`repo ${input.projectId} has no commits`);

  const fileCount = await ensureSourceIndex(env, repo, input.projectId, {
    commit: head.hash,
    treeSha: head.treeHash,
  });

  const artifactRef = `artifacts://${input.projectId}@main`;
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  await root
    .get(root.idFromName(input.projectId))
    .assignSource({ artifactRef, treeSha: head.treeHash });
  return { artifactRef, commit: head.hash, treeSha: head.treeHash, seeded, files: fileCount };
}
