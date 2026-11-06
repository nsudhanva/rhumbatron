/**
 * Repository store. Each repo is a bare Git repository at `<GIT_ROOT>/<name>.git`. A fork is
 * `git clone --bare --shared`: it borrows the source objects through `objects/info/alternates`
 * and keeps its own refs. SQLite at `<GIT_ROOT>/_meta/git.sqlite` holds repo metadata and the
 * token table. The token table is the revocation list: a token is valid only while its row exists
 * and has no `revoked_at`.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ServiceError } from "./errors.ts";
import { git, gitText } from "./git.ts";
import { mintToken, parseToken, type Scope } from "./tokens.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const TTL_MIN = 60;
const TTL_MAX = 31_536_000;
const TTL_DEFAULT = 86_400;
/** Largest object that `readBlob` and `readFile` buffer. Artifacts caps blobs at 32 MB. */
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

type RepoState = "ready" | "creating" | "forking" | "importing";

type RepoRow = {
  name: string;
  id: string;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  last_push_at: string | null;
  source: string | null;
  read_only: number;
  state: RepoState;
};

type TokenRow = {
  id: string;
  repo: string;
  scope: Scope;
  created_at: string;
  expires_at: number;
  revoked_at: string | null;
};

export type RepoInfo = {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  source: string | null;
  readOnly: boolean;
  remote: string;
};

export type CommitMetadata = {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authoredAt: number;
  committedAt: number;
};

export type TreeEntry = {
  name: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
};

export type GitService = "git-upload-pack" | "git-receive-pack";

export type Authorization =
  | { ok: true; tokenId: string }
  | { ok: false; status: 401 | 403 | 404; message: string };

const now = () => new Date().toISOString();
const unix = () => Math.floor(Date.now() / 1000);

function checkName(name: unknown, code: "INVALID_REPO_NAME" = "INVALID_REPO_NAME"): string {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new ServiceError(code, `invalid repository name: ${String(name).slice(0, 80)}`);
  }
  return name;
}

function checkHash(hash: unknown): string {
  const value = typeof hash === "string" ? hash.toLowerCase() : "";
  if (!HASH.test(value)) throw new ServiceError("INVALID_INPUT", "malformed object hash");
  return value;
}

const MIME: Record<string, string> = {
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};
const TEXT = new Set([
  "cjs",
  "html",
  "js",
  "jsx",
  "mjs",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
]);

/** A browser-safe type: active content such as HTML, SVG, and scripts is served as plain text. */
function contentType(path: string) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  if (TEXT.has(ext) || !path.includes(".")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function parseIdentity(line: string) {
  const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  return match
    ? { name: match[1] ?? "", email: match[2] ?? "", at: Number(match[3]) }
    : { name: line, email: "", at: 0 };
}

/** Decodes a raw commit object. */
function parseCommit(hash: string, raw: string): CommitMetadata {
  const split = raw.indexOf("\n\n");
  const head = split === -1 ? raw : raw.slice(0, split);
  let message = split === -1 ? "" : raw.slice(split + 2);
  if (message.endsWith("\n")) message = message.slice(0, -1);
  let treeHash = "";
  const parents: string[] = [];
  let author = parseIdentity("");
  let committer = parseIdentity("");
  for (const line of head.split("\n")) {
    if (line.startsWith(" ")) continue;
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === "tree") treeHash = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author") author = parseIdentity(value);
    else if (key === "committer") committer = parseIdentity(value);
  }
  return {
    hash,
    treeHash,
    message,
    author: { name: author.name, email: author.email },
    committer: { name: committer.name, email: committer.email },
    parents,
    authoredAt: author.at,
    committedAt: committer.at,
  };
}

const TREE_TYPES: Record<string, TreeEntry["type"]> = {
  "040000": "tree",
  "100644": "blob",
  "100755": "exec",
  "120000": "symlink",
  "160000": "gitlink",
};

/** Settings for every repo: never prune objects that forks borrow, and allow authorized pushes. */
const REPO_CONFIG: [string, string][] = [
  ["gc.auto", "0"],
  ["gc.pruneExpire", "never"],
  ["receive.autogc", "false"],
  ["http.receivepack", "true"],
  ["uploadpack.allowFilter", "true"],
];

export class Store {
  private readonly db: Database;

  constructor(
    readonly root: string,
    private readonly secret: string,
    private readonly publicUrl: string,
    readonly namespace: string,
  ) {
    mkdirSync(join(root, "_meta"), { recursive: true });
    this.db = new Database(join(root, "_meta", "git.sqlite"), { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS repos (
      name TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      description TEXT,
      default_branch TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_push_at TEXT,
      source TEXT,
      read_only INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      scope TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at TEXT
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS tokens_repo ON tokens (repo)");
  }

  /** Removes repos that a crash left half-created. Run once at startup. */
  async recover() {
    const stuck = this.db
      .query<{ name: string }, []>("SELECT name FROM repos WHERE state != 'ready'")
      .all();
    for (const { name } of stuck) {
      await rm(this.path(name), { recursive: true, force: true });
      this.db.query("DELETE FROM repos WHERE name = ?").run(name);
      this.db.query("DELETE FROM tokens WHERE repo = ?").run(name);
    }
    this.db.query("DELETE FROM tokens WHERE expires_at < ?").run(unix() - 86_400);
  }

  path(name: string) {
    return join(this.root, `${name}.git`);
  }

  remote(name: string) {
    return `${this.publicUrl}/git/${name}.git`;
  }

  private row(name: string) {
    return this.db.query<RepoRow, [string]>("SELECT * FROM repos WHERE name = ?").get(name);
  }

  /** The ready repo row, or the Artifacts error for a missing or busy repo. */
  private ready(name: unknown): RepoRow {
    const row = this.row(checkName(name));
    if (!row) throw new ServiceError("NOT_FOUND", `repository not found: ${String(name)}`);
    if (row.state === "creating") throw new ServiceError("CREATE_IN_PROGRESS", "repo is creating");
    if (row.state === "forking") throw new ServiceError("FORK_IN_PROGRESS", "repo is forking");
    if (row.state === "importing")
      throw new ServiceError("IMPORT_IN_PROGRESS", "repo is importing");
    return row;
  }

  private toInfo(row: RepoRow): RepoInfo {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      defaultBranch: row.default_branch,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastPushAt: row.last_push_at,
      source: row.source,
      readOnly: row.read_only === 1,
      remote: this.remote(row.name),
    };
  }

  /** Reserves the name. The primary key makes a concurrent create of the same name fail. */
  private reserve(
    name: string,
    state: RepoState,
    fields: {
      description?: string | undefined;
      branch: string;
      source: string | null;
      ro: boolean;
    },
  ) {
    const at = now();
    try {
      this.db
        .query(
          `INSERT INTO repos (name, id, description, default_branch, created_at, updated_at,
             source, read_only, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          name,
          randomUUID(),
          fields.description ?? null,
          fields.branch,
          at,
          at,
          fields.source,
          fields.ro ? 1 : 0,
          state,
        );
    } catch {
      throw new ServiceError("ALREADY_EXISTS", `repository already exists: ${name}`);
    }
  }

  private async finish(name: string, work: () => Promise<void>) {
    try {
      await work();
      for (const [key, value] of REPO_CONFIG) {
        await gitText(["config", key, value], { cwd: this.path(name) });
      }
      this.db.query("UPDATE repos SET state = 'ready' WHERE name = ?").run(name);
    } catch (error) {
      await rm(this.path(name), { recursive: true, force: true });
      this.db.query("DELETE FROM repos WHERE name = ?").run(name);
      throw error;
    }
    const row = this.ready(name);
    const token = this.createToken(name, "write", TTL_DEFAULT);
    const { remote, id, description, defaultBranch } = this.toInfo(row);
    return { id, name, description, defaultBranch, remote, token: token.plaintext };
  }

  async create(
    name: unknown,
    opts: { readOnly?: boolean; description?: string; setDefaultBranch?: string } = {},
  ) {
    const repo = checkName(name);
    const branch = opts.setDefaultBranch ?? "main";
    if (!BRANCH.test(branch) || branch.includes("..")) {
      throw new ServiceError("INVALID_INPUT", "invalid default branch");
    }
    this.reserve(repo, "creating", {
      description: opts.description,
      branch,
      source: null,
      ro: opts.readOnly === true,
    });
    return this.finish(repo, async () => {
      await gitText(["init", "--bare", "--quiet", `--initial-branch=${branch}`, this.path(repo)]);
    });
  }

  async fork(
    sourceName: unknown,
    target: unknown,
    opts: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean } = {},
  ) {
    const source = this.ready(sourceName);
    const name = checkName(target);
    this.reserve(name, "forking", {
      description: opts.description,
      branch: source.default_branch,
      source: `artifacts:${this.namespace}/${source.name}`,
      ro: opts.readOnly === true,
    });
    return this.finish(name, async () => {
      const single = opts.defaultBranchOnly === false ? [] : ["--single-branch"];
      await gitText([
        "clone",
        "--bare",
        "--shared",
        "--quiet",
        ...single,
        "--",
        this.path(source.name),
        this.path(name),
      ]);
      await git(["config", "--unset", "remote.origin.url"], { cwd: this.path(name) });
      await gitText(["symbolic-ref", "HEAD", `refs/heads/${source.default_branch}`], {
        cwd: this.path(name),
      });
    });
  }

  async import(params: {
    source?: { url?: unknown; branch?: unknown; depth?: unknown };
    target?: { name?: unknown; opts?: { description?: string; readOnly?: boolean } };
  }) {
    const url = String(params.source?.url ?? "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ServiceError("INVALID_INPUT", "source URL is not valid");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new ServiceError("INVALID_INPUT", "source URL must be HTTPS without credentials");
    }
    const branch = params.source?.branch;
    if (branch !== undefined && (typeof branch !== "string" || !BRANCH.test(branch))) {
      throw new ServiceError("INVALID_INPUT", "invalid branch");
    }
    const depth = params.source?.depth;
    if (depth !== undefined && (!Number.isInteger(depth) || (depth as number) < 1)) {
      throw new ServiceError("INVALID_INPUT", "invalid depth");
    }
    const name = checkName(params.target?.name);
    this.reserve(name, "importing", {
      description: params.target?.opts?.description,
      branch: (branch as string | undefined) ?? "main",
      source: parsed.toString(),
      ro: params.target?.opts?.readOnly === true,
    });
    return this.finish(name, async () => {
      const result = await git(
        [
          "clone",
          "--bare",
          "--quiet",
          ...(branch ? ["--single-branch", "--branch", branch as string] : []),
          ...(depth ? ["--depth", String(depth)] : []),
          "--",
          parsed.toString(),
          this.path(name),
        ],
        { timeoutMs: 600_000 },
      );
      if (result.code !== 0) {
        const err = result.stderr;
        if (/Authentication|could not read Username|403/i.test(err)) {
          throw new ServiceError("REMOTE_AUTH_REQUIRED", "remote requires authentication");
        }
        if (/not found|404/i.test(err)) throw new ServiceError("NOT_FOUND", "remote not found");
        if (/not a git repository|valid/i.test(err)) {
          throw new ServiceError("INVALID_URL", "source is not a git repository");
        }
        throw new ServiceError("UPSTREAM_UNAVAILABLE", "remote is unavailable");
      }
      const head = (await gitText(["symbolic-ref", "HEAD"], { cwd: this.path(name) })).trim();
      this.db
        .query("UPDATE repos SET default_branch = ? WHERE name = ?")
        .run(head.replace(/^refs\/heads\//, ""), name);
    });
  }

  list(opts: { limit?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
    const rows = this.db
      .query<RepoRow, [string, number]>(
        "SELECT * FROM repos WHERE state = 'ready' AND name > ? ORDER BY name LIMIT ?",
      )
      .all(opts.cursor ?? "", limit + 1);
    const total =
      this.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM repos WHERE state = 'ready'")
        .get()?.n ?? 0;
    const page = rows.slice(0, limit);
    const repos = page.map((row) => {
      const { remote: _remote, ...rest } = this.toInfo(row);
      return rest;
    });
    const last = page.at(-1);
    return rows.length > limit && last ? { repos, total, cursor: last.name } : { repos, total };
  }

  /**
   * Deletes the repo and its tokens. A fork that borrows objects from it first copies them into
   * its own pack, so deleting a source never breaks a fork.
   */
  async delete(name: unknown) {
    const repo = checkName(name);
    const row = this.row(repo);
    if (!row) return false;
    const objects = await realpath(join(this.path(repo), "objects")).catch(() => null);
    if (objects) {
      for (const dependent of await this.dependents(objects)) {
        await gitText(["repack", "-a", "-d", "-q"], { cwd: dependent, timeoutMs: 600_000 });
        await rm(join(dependent, "objects", "info", "alternates"), { force: true });
      }
    }
    this.db.query("DELETE FROM tokens WHERE repo = ?").run(repo);
    this.db.query("DELETE FROM repos WHERE name = ?").run(repo);
    await rm(this.path(repo), { recursive: true, force: true });
    return true;
  }

  /** Bare repos whose alternates point at `objects`. */
  private async dependents(objects: string) {
    const found: string[] = [];
    for (const entry of await readdir(this.root)) {
      if (!entry.endsWith(".git")) continue;
      const dir = join(this.root, entry);
      const alternates = await readFile(join(dir, "objects", "info", "alternates"), "utf8").catch(
        () => "",
      );
      for (const line of alternates.split("\n").filter(Boolean)) {
        const target = await realpath(resolve(dir, "objects", line)).catch(() => null);
        if (target === objects) {
          found.push(dir);
          break;
        }
      }
    }
    return found;
  }

  get(name: unknown) {
    this.ready(name);
    return { ok: true as const };
  }

  info(name: unknown) {
    return this.toInfo(this.ready(name));
  }

  createToken(name: unknown, scope: unknown = "write", ttl: unknown = TTL_DEFAULT) {
    const row = this.ready(name);
    if (scope !== "read" && scope !== "write") {
      throw new ServiceError("INVALID_INPUT", "scope must be read or write");
    }
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < TTL_MIN || ttl > TTL_MAX) {
      throw new ServiceError("INVALID_TTL", `ttl must be ${TTL_MIN} to ${TTL_MAX} seconds`);
    }
    const id = `tok_${randomUUID().replaceAll("-", "")}`;
    const exp = unix() + ttl;
    const createdAt = now();
    this.db
      .query("INSERT INTO tokens (id, repo, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, row.name, scope, createdAt, exp);
    const { plaintext } = mintToken(this.secret, { id, repo: row.name, scope, exp });
    return { id, plaintext, scope, expiresAt: new Date(exp * 1000).toISOString() };
  }

  listTokens(name: unknown) {
    const row = this.ready(name);
    const at = unix();
    const tokens = this.db
      .query<TokenRow, [string]>("SELECT * FROM tokens WHERE repo = ? ORDER BY created_at")
      .all(row.name)
      .map((t) => ({
        id: t.id,
        scope: t.scope,
        state: t.revoked_at ? "revoked" : t.expires_at <= at ? "expired" : "active",
        createdAt: t.created_at,
        expiresAt: new Date(t.expires_at * 1000).toISOString(),
      }));
    return { tokens, total: tokens.length };
  }

  /** Revokes by token ID or plaintext. Returns false when the repo has no such token. */
  revokeToken(name: unknown, tokenOrId: unknown) {
    const row = this.ready(name);
    if (typeof tokenOrId !== "string" || !tokenOrId) {
      throw new ServiceError("INVALID_INPUT", "token or ID is required");
    }
    const id = tokenOrId.startsWith("tok_")
      ? tokenOrId
      : (parseToken(this.secret, tokenOrId)?.id ?? "");
    const result = this.db
      .query("UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND repo = ?")
      .run(now(), id, row.name);
    return result.changes > 0;
  }

  /** Type and size of an object expression, or null when it does not resolve. */
  private async describe(repo: string, expr: string) {
    const result = await git(["cat-file", "--batch-check"], {
      cwd: this.path(repo),
      stdin: `${expr}\n`,
    });
    const line = new TextDecoder().decode(result.stdout).trim();
    const match = /^([0-9a-f]{40}) (\w+) (\d+)$/.exec(line);
    return match ? { hash: match[1] ?? "", type: match[2] ?? "", size: Number(match[3]) } : null;
  }

  private async blobBytes(repo: string, hash: string, size: number) {
    if (size > MAX_OBJECT_BYTES) throw new ServiceError("MEMORY_LIMIT", "object is too large");
    const result = await git(["cat-file", "blob", hash], { cwd: this.path(repo) });
    if (result.code !== 0) throw new ServiceError("INTERNAL_ERROR", "blob read failed");
    return result.stdout;
  }

  async readBlob(name: unknown, hash: unknown) {
    const repo = this.ready(name).name;
    const oid = checkHash(hash);
    const object = await this.describe(repo, oid);
    if (object?.type !== "blob") return null;
    return this.blobBytes(repo, oid, object.size);
  }

  async readTree(name: unknown, hash: unknown): Promise<TreeEntry[] | null> {
    const repo = this.ready(name).name;
    const oid = checkHash(hash);
    const object = await this.describe(repo, oid);
    if (!object) return null;
    if (object.type !== "tree") throw new ServiceError("INTERNAL_ERROR", "object is not a tree");
    const out = await gitText(["ls-tree", "-z", oid], { cwd: this.path(repo) });
    return out
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const tab = record.indexOf("\t");
        const [mode = "", , entryHash = ""] = record.slice(0, tab).split(" ");
        return {
          name: record.slice(tab + 1),
          mode: mode === "040000" ? "40000" : mode,
          hash: entryHash,
          type: TREE_TYPES[mode] ?? "blob",
        };
      });
  }

  async readCommit(name: unknown, hash: unknown) {
    const repo = this.ready(name).name;
    const oid = checkHash(hash);
    const object = await this.describe(repo, oid);
    if (!object) return null;
    if (object.type !== "commit")
      throw new ServiceError("INTERNAL_ERROR", "object is not a commit");
    return parseCommit(oid, await gitText(["cat-file", "commit", oid], { cwd: this.path(repo) }));
  }

  /** Resolves a ref to a commit ID, or null. */
  private async resolve(repo: string, ref: string) {
    if (!ref || ref.startsWith("-") || /[\s\0:]/.test(ref)) return null;
    const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: this.path(repo),
    });
    const value = new TextDecoder().decode(result.stdout).trim();
    return result.code === 0 && HASH.test(value) ? value : null;
  }

  async readFile(name: unknown, args: { ref?: unknown; path?: unknown }) {
    const repo = this.ready(name).name;
    if (typeof args.ref !== "string" || !args.ref || typeof args.path !== "string") {
      throw new ServiceError("INVALID_INPUT", "ref and path are required");
    }
    const path = args.path.replace(/^(\.\/|\/)+/, "");
    if (!path || path.includes("\0") || path.includes("\n")) {
      throw new ServiceError("INVALID_INPUT", "path is required");
    }
    const commit = await this.resolve(repo, args.ref);
    if (!commit) return null;
    const object = await this.describe(repo, `${commit}:${path}`);
    if (object?.type !== "blob") return null;
    return {
      bytes: await this.blobBytes(repo, object.hash, object.size),
      type: contentType(path),
    };
  }

  async log(name: unknown, opts: { ref?: unknown; limit?: unknown; offset?: unknown } = {}) {
    const repo = this.ready(name).name;
    const ref = typeof opts.ref === "string" && opts.ref ? opts.ref : "HEAD";
    const limit = Math.min(Math.max(Math.trunc(Number(opts.limit ?? 50)) || 50, 1), 1000);
    const offset = Math.max(Math.trunc(Number(opts.offset ?? 0)) || 0, 0);
    const start = await this.resolve(repo, ref);
    if (!start) return [];
    const hashes = (
      await gitText(
        ["rev-list", "--first-parent", `--max-count=${limit}`, `--skip=${offset}`, start, "--"],
        { cwd: this.path(repo) },
      )
    )
      .split("\n")
      .filter((h) => HASH.test(h));
    if (hashes.length === 0) return [];
    const batch = await git(["cat-file", "--batch"], {
      cwd: this.path(repo),
      stdin: `${hashes.join("\n")}\n`,
    });
    if (batch.code !== 0) throw new ServiceError("INTERNAL_ERROR", "log read failed");
    const out: CommitMetadata[] = [];
    const bytes = batch.stdout;
    const decoder = new TextDecoder();
    let at = 0;
    while (at < bytes.length) {
      const newline = bytes.indexOf(10, at);
      if (newline === -1) break;
      const [hash = "", type, size = "0"] = decoder.decode(bytes.subarray(at, newline)).split(" ");
      const end = newline + 1 + Number(size);
      if (type === "commit")
        out.push(parseCommit(hash, decoder.decode(bytes.subarray(newline + 1, end))));
      at = end + 1;
    }
    return out;
  }

  /** Checks a smart-HTTP credential against the repo and the Git service it asks for. */
  authorize(raw: string | null, name: string, service: GitService): Authorization {
    if (!raw) return { ok: false, status: 401, message: "authentication required" };
    const claims = parseToken(this.secret, raw);
    if (!claims) return { ok: false, status: 401, message: "invalid token" };
    if (claims.exp <= unix()) return { ok: false, status: 401, message: "token expired" };
    if (claims.repo !== name) {
      return { ok: false, status: 403, message: "token does not grant this repository" };
    }
    const token = this.db
      .query<TokenRow, [string, string]>("SELECT * FROM tokens WHERE id = ? AND repo = ?")
      .get(claims.id, name);
    if (!token || token.revoked_at) return { ok: false, status: 401, message: "token revoked" };
    const row = this.row(name);
    if (row?.state !== "ready") {
      return { ok: false, status: 404, message: "repository not found" };
    }
    if (service === "git-receive-pack" && (claims.scope !== "write" || row.read_only === 1)) {
      return { ok: false, status: 403, message: "token does not allow push" };
    }
    return { ok: true, tokenId: claims.id };
  }

  notePush(name: string) {
    const at = now();
    this.db
      .query("UPDATE repos SET last_push_at = ?, updated_at = ? WHERE name = ?")
      .run(at, at, name);
  }
}
