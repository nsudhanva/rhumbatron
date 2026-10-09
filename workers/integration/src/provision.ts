import type { ProjectRootDO } from "@rhumbatron/coordinator";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createFsFromVolume, Volume } from "memfs";
import acmeShop from "./fixtures/acme-shop.fixture.gen.ts";

/**
 * Project source provisioning (AGENTS.md sections 29.1 and 54). One Artifacts repo per Project,
 * named by the Project ID. A template seeds the first commit with isomorphic-git over an in-memory
 * file system, then that commit becomes Canonical Generation 0. Safe to repeat.
 */

const TEMPLATES: Record<string, Record<string, string>> = { "acme-shop": acmeShop };

const DIR = "/repo";
const AUTHOR = { name: "Rhumbatron", email: "bot@rhumbatron.com" };

type Provisioned = { artifactRef: string; commit: string; treeSha: string; seeded: boolean };

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

  const artifactRef = `artifacts://${input.projectId}@main`;
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  await root
    .get(root.idFromName(input.projectId))
    .assignSource({ artifactRef, treeSha: head.treeHash });
  return { artifactRef, commit: head.hash, treeSha: head.treeHash, seeded };
}
