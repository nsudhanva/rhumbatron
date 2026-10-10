import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createFsFromVolume, Volume } from "memfs";
import { candidateFork } from "./candidate-sandbox.ts";
import { ensureSourceIndex } from "./provision.ts";

/**
 * Moves the canonical repo to a promoted Candidate (AGENTS.md sections 29, 36; ADR 0013).
 * ProjectRootDO is the authority: this runs only after its compare-and-swap succeeded, and a retry
 * of the promotion runs it again. The push is fast-forward only: the composed commit descends from
 * the base commit, so `main` moves from base to composed or not at all. No force push, ever.
 * Runs in the Worker with isomorphic-git over an in-memory file system: no Sandbox time.
 */

const DIR = "/repo";
const BRANCH = "refs/heads/main";
const LOCAL = "refs/heads/promote";

export type SourceSync =
  | { synced: true; commit: string }
  | { synced: false; commit: null; detail: string };

/** Short-lived repo token as isomorphic-git auth, plus its revoke handle. */
async function repoAccess(env: Env, name: string, scope: "read" | "write") {
  using repo = await env.ARTIFACTS.get(name);
  const info = await repo.info();
  const token = await repo.createToken(scope, 600);
  const secret = token.plaintext.split("?expires=")[0] ?? token.plaintext;
  return {
    remote: info.remote,
    onAuth: () => ({ username: "x", password: secret }),
    revoke: async () => {
      using again = await env.ARTIFACTS.get(name);
      await again.revokeToken(token.id).catch(() => false);
    },
  };
}

/** Fetches the Candidate fork and fast-forwards canonical `main` to the composed commit. */
async function fastForward(env: Env, projectId: string, candidateId: string, commit: string) {
  const fs = createFsFromVolume(new Volume()) as unknown as Parameters<typeof git.init>[0]["fs"];
  await git.init({ fs, dir: DIR, defaultBranch: "main" });
  const source = await repoAccess(env, candidateFork(candidateId), "read");
  const target = await repoAccess(env, projectId, "write");
  try {
    // isomorphic-git needs a configured remote for its fetch refspec.
    await git.addRemote({ fs, dir: DIR, remote: "origin", url: source.remote, force: true });
    await git.fetch({
      fs,
      http,
      dir: DIR,
      remote: "origin",
      url: source.remote,
      ref: "main",
      singleBranch: true,
      tags: false,
      onAuth: source.onAuth,
    });
    // Throws when the fork no longer holds the composed commit.
    await git.readCommit({ fs, dir: DIR, oid: commit });
    await git.writeRef({ fs, dir: DIR, ref: LOCAL, value: commit, force: true });
    // isomorphic-git refuses a non-fast-forward; receive-pack also checks the old `main` value.
    const result = await git.push({
      fs,
      http,
      dir: DIR,
      url: target.remote,
      ref: LOCAL,
      remoteRef: BRANCH,
      onAuth: target.onAuth,
    });
    if (!result.ok) throw new Error(`push rejected: ${JSON.stringify(result.refs).slice(0, 200)}`);
  } finally {
    await source.revoke();
    await target.revoke();
  }
}

/**
 * Makes canonical `main` point at `commit` and writes the file index of `treeSha`. Idempotent: a
 * repo already at the commit is not pushed again, and an existing index is kept. Failures are
 * returned, not thrown: the generation already advanced, and a promotion retry repairs the source.
 */
export async function syncCanonicalSource(
  env: Env,
  input: { projectId: string; candidateId: string; commit: string; treeSha: string },
): Promise<SourceSync> {
  try {
    using canonical = await env.ARTIFACTS.get(input.projectId);
    const [head] = await canonical.log({ ref: "main", limit: 1 });
    // The tree `main` held before this promotion: its stored blobs need no copy check.
    const previousTreeSha = head?.hash !== input.commit ? head?.treeHash : undefined;
    if (head?.hash !== input.commit) {
      await fastForward(env, input.projectId, input.candidateId, input.commit);
    }
    const [moved] = await canonical.log({ ref: "main", limit: 1 });
    if (moved?.hash !== input.commit || moved.treeHash !== input.treeSha) {
      return {
        synced: false,
        commit: null,
        detail: "canonical main is not at the composed commit",
      };
    }
    await ensureSourceIndex(
      env,
      canonical,
      input.projectId,
      { commit: input.commit, treeSha: input.treeSha },
      previousTreeSha,
    );
    return { synced: true, commit: input.commit };
  } catch (error) {
    return { synced: false, commit: null, detail: String(error).slice(0, 300) };
  }
}
