/**
 * Security boundary of the Git service: a repo token grants one repo, one scope, until it expires
 * or is revoked. The control API needs the admin token.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "../src/tokens.ts";
import {
  gitCli,
  type Harness,
  repoUrl,
  secretOf,
  startService,
  TOKEN_SECRET,
  withBearer,
} from "./harness.ts";

let h: Harness;

const basic = (token: string) => `Basic ${Buffer.from(`x:${token}`).toString("base64")}`;

/** Status of the smart-HTTP ref advertisement for a service. */
async function refs(
  name: string,
  service: string,
  token?: string,
  scheme: "basic" | "bearer" = "basic",
) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = scheme === "basic" ? basic(token) : `Bearer ${token}`;
  const res = await fetch(`${repoUrl(h, name)}/info/refs?service=${service}`, { headers });
  await res.arrayBuffer();
  return res.status;
}

async function writeToken(name: string) {
  using repo = await h.client.get(name);
  return secretOf((await repo.createToken("write", 600)).plaintext);
}

async function readToken(name: string) {
  using repo = await h.client.get(name);
  return secretOf((await repo.createToken("read", 600)).plaintext);
}

/** Commits one file in a fresh local repo and pushes it with the given token. */
async function pushCommit(name: string, token: string, file: string) {
  const dir = join(h.scratch, `${name}-${file}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await gitCli(["init", "-q", "-b", "main"], dir);
  await writeFile(join(dir, file), `${file}\n`);
  await gitCli(["add", "."], dir);
  await gitCli(["commit", "-q", "-m", `add ${file}`], dir);
  return gitCli(withBearer(token, ["push", "-q", repoUrl(h, name), "HEAD:main"]), dir);
}

beforeAll(async () => {
  h = await startService();
  await h.client.create("repo-a");
  await h.client.create("repo-b");
  expect((await pushCommit("repo-a", await writeToken("repo-a"), "a.txt")).code).toBe(0);
  expect((await pushCommit("repo-b", await writeToken("repo-b"), "b.txt")).code).toBe(0);
});

afterAll(async () => {
  await h?.stop();
});

describe("git service security boundary", () => {
  it("requires a credential for smart HTTP and advertises Basic auth", async () => {
    const res = await fetch(`${repoUrl(h, "repo-a")}/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("lets a read token fetch its own repo, with Basic or Bearer", async () => {
    const token = await readToken("repo-a");
    expect(await refs("repo-a", "git-upload-pack", token, "basic")).toBe(200);
    expect(await refs("repo-a", "git-upload-pack", token, "bearer")).toBe(200);
    const ls = await gitCli(withBearer(token, ["ls-remote", repoUrl(h, "repo-a")]));
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain("refs/heads/main");
  });

  it("refuses a token for repo A on repo B", async () => {
    const readA = await readToken("repo-a");
    const writeA = await writeToken("repo-a");
    expect(await refs("repo-b", "git-upload-pack", readA)).toBe(403);
    expect(await refs("repo-b", "git-upload-pack", writeA)).toBe(403);
    expect(await refs("repo-b", "git-receive-pack", writeA)).toBe(403);
    const ls = await gitCli(withBearer(readA, ["ls-remote", repoUrl(h, "repo-b")]));
    expect(ls.code).not.toBe(0);
  });

  it("refuses a push with a read token", async () => {
    const token = await readToken("repo-a");
    expect(await refs("repo-a", "git-receive-pack", token)).toBe(403);
    const post = await fetch(`${repoUrl(h, "repo-a")}/git-receive-pack`, {
      method: "POST",
      headers: {
        authorization: basic(token),
        "content-type": "application/x-git-receive-pack-request",
      },
      body: "0000",
    });
    expect(post.status).toBe(403);
    expect((await pushCommit("repo-a", token, "denied.txt")).code).not.toBe(0);
  });

  it("refuses an expired token", async () => {
    using repo = await h.client.get("repo-a");
    const live = await repo.createToken("write", 600);
    // Same ID and signing secret, expiry in the past.
    const { token } = mintToken(TOKEN_SECRET, {
      id: live.id,
      repo: "repo-a",
      scope: "write",
      exp: Math.floor(Date.now() / 1000) - 5,
    });
    expect(await refs("repo-a", "git-upload-pack", token)).toBe(401);
  });

  it("refuses a forged token", async () => {
    using repo = await h.client.get("repo-a");
    const live = await repo.createToken("write", 600);
    const { token } = mintToken("another-secret-that-is-long-enough-000", {
      id: live.id,
      repo: "repo-a",
      scope: "write",
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    expect(await refs("repo-a", "git-upload-pack", token)).toBe(401);
    // A scope edit breaks the signature.
    const [prefix, body = "", mac] = secretOf(live.plaintext).split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const edited = Buffer.from(JSON.stringify({ ...claims, r: "repo-b" })).toString("base64url");
    expect(await refs("repo-b", "git-upload-pack", `${prefix}.${edited}.${mac}`)).toBe(401);
  });

  it("refuses a revoked token, by ID or by plaintext", async () => {
    using repo = await h.client.get("repo-a");
    const byId = await repo.createToken("write", 600);
    const byPlain = await repo.createToken("read", 600);
    expect(await refs("repo-a", "git-receive-pack", secretOf(byId.plaintext))).toBe(200);
    expect(await repo.revokeToken(byId.id)).toBe(true);
    expect(await repo.revokeToken(byPlain.plaintext)).toBe(true);
    expect(await refs("repo-a", "git-receive-pack", secretOf(byId.plaintext))).toBe(401);
    expect(await refs("repo-a", "git-upload-pack", secretOf(byPlain.plaintext))).toBe(401);
    expect((await pushCommit("repo-a", secretOf(byId.plaintext), "late.txt")).code).not.toBe(0);
    const states = (await repo.listTokens()).tokens.filter((t) => t.id === byId.id);
    expect(states[0]?.state).toBe("revoked");
  });

  it("refuses a token of a deleted repo after the name is reused", async () => {
    await h.client.create("repo-c");
    const old = await writeToken("repo-c");
    expect(await h.client.delete("repo-c")).toBe(true);
    await h.client.create("repo-c");
    expect(await refs("repo-c", "git-upload-pack", old)).toBe(401);
  });

  it("serves no dumb-protocol path, even with a valid token", async () => {
    const token = await writeToken("repo-a");
    for (const path of ["HEAD", "config", "objects/info/packs", "info/refs"]) {
      const res = await fetch(`${repoUrl(h, "repo-a")}/${path}`, {
        headers: { authorization: basic(token) },
      });
      await res.arrayBuffer();
      expect(res.status).toBe(404);
    }
    const outside = await fetch(
      `${h.baseUrl}/git/..%2F_meta.git/info/refs?service=git-upload-pack`,
      {
        headers: { authorization: basic(token) },
      },
    );
    await outside.arrayBuffer();
    expect(outside.status).toBe(404);
  });

  it("requires the admin token for the control API", async () => {
    const none = await fetch(`${h.baseUrl}/api/info`, {
      method: "POST",
      body: JSON.stringify({ name: "repo-a" }),
    });
    expect(none.status).toBe(401);
    const repoToken = await writeToken("repo-a");
    const wrong = await fetch(`${h.baseUrl}/api/createToken`, {
      method: "POST",
      headers: { authorization: `Bearer ${repoToken}` },
      body: JSON.stringify({ name: "repo-a" }),
    });
    expect(wrong.status).toBe(401);
  });

  it("rejects repo names that could leave GIT_ROOT", async () => {
    for (const name of ["../x", "_meta", ".hidden", "a/b", ""]) {
      await expect(h.client.create(name)).rejects.toMatchObject({ code: "INVALID_REPO_NAME" });
    }
  });
});
