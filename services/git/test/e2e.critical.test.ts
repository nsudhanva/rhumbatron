/**
 * End to end through the client and smart HTTP: create, push, read back, fork, push to the fork
 * with isomorphic-git (as the integration worker does), and delete.
 */
import * as fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitCli, type Harness, repoUrl, secretOf, startService, withBearer } from "./harness.ts";

// The integration worker's own isomorphic-git, so the test exercises the client that ships.
const requireFromIntegration = createRequire(
  resolve(import.meta.dirname, "../../../workers/integration/package.json"),
);
type Options = Record<string, unknown>;
const git = requireFromIntegration("isomorphic-git") as {
  clone(o: Options): Promise<void>;
  fetch(o: Options): Promise<unknown>;
  add(o: Options): Promise<void>;
  commit(o: Options): Promise<string>;
  push(o: Options): Promise<{ ok: boolean }>;
};
const http = requireFromIntegration("isomorphic-git/http/node") as unknown;

let h: Harness;

beforeAll(async () => {
  h = await startService();
});

afterAll(async () => {
  await h?.stop();
});

describe("git service end to end", () => {
  it("creates, pushes, reads, forks, pushes to the fork with isomorphic-git, and deletes", async () => {
    const created = await h.client.create("prj-e2e", {
      description: "e2e",
      setDefaultBranch: "main",
    });
    expect(created.remote).toMatch(/\/git\/prj-e2e\.git$/);
    expect(created.token).toContain("?expires=");
    await expect(h.client.create("prj-e2e")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });

    // An empty repo has no history.
    using canonical = await h.client.get("prj-e2e");
    expect(await canonical.log({ ref: "main", limit: 1 })).toEqual([]);

    // Seed with the creation token over Basic auth, as provisioning does.
    const work = join(h.scratch, "seed");
    await mkdir(join(work, "src"), { recursive: true });
    await gitCli(["init", "-q", "-b", "main"], work);
    await writeFile(join(work, "README.md"), "# Acme\n");
    await writeFile(join(work, "src", "index.ts"), "export const answer = 42;\n");
    await gitCli(["add", "."], work);
    await gitCli(["commit", "-q", "-m", "seed\n\nbody line"], work);
    const authed = repoUrl(h, "prj-e2e").replace("://", `://x:${secretOf(created.token)}@`);
    const push = await gitCli(["push", "-q", authed, "HEAD:main"], work);
    expect(push.stderr).toBe("");
    expect(push.code).toBe(0);
    const seedCommit = (await gitCli(["rev-parse", "HEAD"], work)).stdout.trim();

    // Read it back through the binding surface.
    const [head] = await canonical.log({ ref: "main", limit: 1 });
    expect(head?.hash).toBe(seedCommit);
    expect(head?.message).toBe("seed\n\nbody line");
    expect(head?.author).toEqual({ name: "Test", email: "test@example.com" });
    expect(head?.parents).toEqual([]);
    const commit = await canonical.readCommit(seedCommit);
    expect(commit?.treeHash).toBe(head?.treeHash);
    const tree = await canonical.readTree(head?.treeHash ?? "");
    expect(tree?.map((e) => [e.name, e.type, e.mode])).toEqual([
      ["README.md", "blob", "100644"],
      ["src", "tree", "40000"],
    ]);
    const readme = tree?.find((e) => e.name === "README.md")?.hash ?? "";
    expect(await (await canonical.readBlob(readme))?.text()).toBe("# Acme\n");
    const file = await canonical.readFile({ ref: seedCommit, path: "src/index.ts" });
    expect(await file?.text()).toBe("export const answer = 42;\n");
    expect(await canonical.readFile({ ref: "main", path: "missing.ts" })).toBeNull();
    expect(await canonical.readBlob("0".repeat(40))).toBeNull();
    expect(await canonical.readCommit("0".repeat(40))).toBeNull();
    await expect(canonical.readBlob("not-a-hash")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const info = await canonical.info();
    expect(info.lastPushAt).not.toBeNull();
    expect(info.defaultBranch).toBe("main");

    // Fork, then push a second commit to the fork with isomorphic-git and a write token.
    const forked = await canonical.fork("ws-e2e", { description: "fork", defaultBranchOnly: true });
    expect(forked.name).toBe("ws-e2e");
    using fork = await h.client.get("ws-e2e");
    expect((await fork.info()).source).toBe("artifacts:rhumbatron/prj-e2e");
    expect((await fork.log({ ref: "main", limit: 1 }))[0]?.hash).toBe(seedCommit);

    const dir = join(h.scratch, "iso");
    const token = await fork.createToken("write", 600);
    const onAuth = () => ({ username: "x", password: secretOf(token.plaintext) });
    await git.clone({
      fs,
      http,
      dir,
      url: repoUrl(h, "ws-e2e"),
      ref: "main",
      singleBranch: true,
      onAuth,
    });
    await fs.promises.writeFile(join(dir, "src", "wishlist.ts"), "export const wishlist = [];\n");
    await git.add({ fs, dir, filepath: "src/wishlist.ts" });
    const next = await git.commit({
      fs,
      dir,
      message: "add wishlist",
      author: { name: "Agent", email: "agent@example.com" },
    });
    const pushed = await git.push({
      fs,
      http,
      dir,
      url: repoUrl(h, "ws-e2e"),
      ref: "main",
      onAuth,
    });
    expect(pushed.ok).toBe(true);
    await fork.revokeToken(token.id);

    // A read token fetches with isomorphic-git but cannot push.
    const read = await fork.createToken("read", 600);
    const readAuth = () => ({ username: "x", password: secretOf(read.plaintext) });
    await git.fetch({
      fs,
      http,
      dir,
      url: repoUrl(h, "ws-e2e"),
      ref: "main",
      singleBranch: true,
      onAuth: readAuth,
    });
    await expect(
      git.push({
        fs,
        http,
        dir,
        url: repoUrl(h, "ws-e2e"),
        ref: "main",
        force: true,
        onAuth: readAuth,
      }),
    ).rejects.toThrow();

    // The fork moved; the canonical repo did not.
    expect((await fork.log({ ref: "main", limit: 2 })).map((c) => c.hash)).toEqual([
      next,
      seedCommit,
    ]);
    expect((await canonical.log({ ref: "main", limit: 5 })).map((c) => c.hash)).toEqual([
      seedCommit,
    ]);
    expect(await (await fork.readFile({ ref: "main", path: "src/wishlist.ts" }))?.text()).toBe(
      "export const wishlist = [];\n",
    );

    // The Sandbox path: git CLI clone with a Bearer header.
    const cliToken = secretOf((await fork.createToken("read", 600)).plaintext);
    const clone = await gitCli(
      withBearer(cliToken, ["clone", "-q", repoUrl(h, "ws-e2e"), join(h.scratch, "cli")]),
    );
    expect(clone.code).toBe(0);
    expect(fs.existsSync(join(h.scratch, "cli", "src", "wishlist.ts"))).toBe(true);

    // Deleting the source keeps the fork whole: it copies the borrowed objects first.
    expect(await h.client.delete("prj-e2e")).toBe(true);
    expect(await h.client.delete("prj-e2e")).toBe(false);
    await expect(h.client.get("prj-e2e")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await (await fork.readFile({ ref: seedCommit, path: "README.md" }))?.text()).toBe(
      "# Acme\n",
    );
    const fsck = await gitCli(["fsck", "--no-progress"], join(h.root, "ws-e2e.git"));
    expect(fsck.code).toBe(0);

    expect((await h.client.list()).repos.map((r) => r.name)).toEqual(["ws-e2e"]);
    expect(await h.client.delete("ws-e2e")).toBe(true);
    expect((await h.client.list()).total).toBe(0);
  });
});
