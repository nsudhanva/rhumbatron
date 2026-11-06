/**
 * Client for the Rhumbatron Git service. It implements the Cloudflare Artifacts binding surface,
 * so a caller can pass it as `env.ARTIFACTS`. It uses only `fetch`.
 *
 *   const artifacts = new GitServiceClient({ baseUrl, adminToken, namespace });
 *   using repo = await artifacts.get("prj_1");
 */

export type ArtifactsErrorCode =
  | "ALREADY_EXISTS"
  | "NOT_FOUND"
  | "CREATE_IN_PROGRESS"
  | "IMPORT_IN_PROGRESS"
  | "FORK_IN_PROGRESS"
  | "INVALID_INPUT"
  | "INVALID_REPO_NAME"
  | "INVALID_TTL"
  | "INVALID_URL"
  | "REMOTE_AUTH_REQUIRED"
  | "UPSTREAM_UNAVAILABLE"
  | "MEMORY_LIMIT"
  | "INTERNAL_ERROR";

const NUMERIC: Record<ArtifactsErrorCode, number> = {
  ALREADY_EXISTS: 10001,
  NOT_FOUND: 10002,
  CREATE_IN_PROGRESS: 10003,
  IMPORT_IN_PROGRESS: 10004,
  FORK_IN_PROGRESS: 10005,
  INVALID_INPUT: 10006,
  INVALID_REPO_NAME: 10007,
  INVALID_TTL: 10008,
  INVALID_URL: 10009,
  REMOTE_AUTH_REQUIRED: 10010,
  UPSTREAM_UNAVAILABLE: 10011,
  MEMORY_LIMIT: 10012,
  INTERNAL_ERROR: 10013,
};

export class ArtifactsError extends Error {
  override readonly name = "ArtifactsError" as const;
  readonly numericCode: number;
  constructor(
    readonly code: ArtifactsErrorCode,
    message: string,
  ) {
    super(message);
    this.numericCode = NUMERIC[code] ?? NUMERIC.INTERNAL_ERROR;
  }
}

export type ArtifactsRepoInfo = {
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

export type ArtifactsCreateRepoResult = {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  remote: string;
  token: string;
};

export type ArtifactsRepoListResult = {
  repos: Omit<ArtifactsRepoInfo, "remote">[];
  total: number;
  cursor?: string;
};

export type ArtifactsCreateTokenResult = {
  id: string;
  plaintext: string;
  scope: "read" | "write";
  expiresAt: string;
};

export type ArtifactsTokenListResult = {
  tokens: {
    id: string;
    scope: "read" | "write";
    state: "active" | "expired" | "revoked";
    createdAt: string;
    expiresAt: string;
  }[];
  total: number;
};

export type ArtifactsTreeEntry = {
  name: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
};

export type ArtifactsCommitMetadata = {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authoredAt: number;
  committedAt: number;
};

export type GitServiceClientOptions = {
  /** Service origin, for example `http://git:8080`. */
  baseUrl: string;
  /** Bearer token for the control API (`GIT_ADMIN_TOKEN`). */
  adminToken: string;
  /** Must equal the service `GIT_NAMESPACE`. */
  namespace: string;
  /** Optional fetch implementation, for tests or service bindings. */
  fetch?: typeof fetch;
};

type Call = (op: string, body: Record<string, unknown>) => Promise<Response>;

async function fail(res: Response): Promise<never> {
  let code: ArtifactsErrorCode = "INTERNAL_ERROR";
  let message = `git service returned ${res.status}`;
  try {
    const data = (await res.json()) as { error?: { code?: string; message?: string } };
    if (data.error?.code && data.error.code in NUMERIC)
      code = data.error.code as ArtifactsErrorCode;
    if (data.error?.message) message = data.error.message;
  } catch {
    // Body is not JSON: keep the status message.
  }
  throw new ArtifactsError(code, message);
}

async function asJson<T>(res: Promise<Response>): Promise<T> {
  const response = await res;
  if (!response.ok) return fail(response);
  return (await response.json()) as T;
}

async function asBlob(res: Promise<Response>): Promise<Blob | null> {
  const response = await res;
  if (!response.ok) return fail(response);
  if (response.headers.get("x-git-result") === "null") return null;
  const type = response.headers.get("content-type") ?? "application/octet-stream";
  return new Blob([await response.arrayBuffer()], { type });
}

/** Repo handle. It holds no server resource; `dispose` exists for `using`. */
export class GitServiceRepo {
  constructor(
    private readonly call: Call,
    private readonly repo: string,
  ) {}

  private op<T>(op: string, body: Record<string, unknown> = {}) {
    return asJson<T>(this.call(op, { ...body, name: this.repo }));
  }

  createToken(scope: "write" | "read" = "write", ttl = 86_400) {
    return this.op<ArtifactsCreateTokenResult>("createToken", { scope, ttl });
  }

  listTokens() {
    return this.op<ArtifactsTokenListResult>("listTokens");
  }

  async revokeToken(tokenOrId: string) {
    return (await this.op<{ revoked: boolean }>("revokeToken", { tokenOrId })).revoked;
  }

  info() {
    return this.op<ArtifactsRepoInfo>("info");
  }

  readBlob(hash: string) {
    return asBlob(this.call("readBlob", { name: this.repo, hash }));
  }

  readTree(hash: string) {
    return this.op<ArtifactsTreeEntry[] | null>("readTree", { hash });
  }

  readCommit(hash: string) {
    return this.op<ArtifactsCommitMetadata | null>("readCommit", { hash });
  }

  readFile(args: { ref: string; path: string }) {
    return asBlob(this.call("readFile", { name: this.repo, args }));
  }

  log(opts: { ref?: string; limit?: number; offset?: number } = {}) {
    return this.op<ArtifactsCommitMetadata[]>("log", { opts });
  }

  fork(
    name: string,
    opts: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean } = {},
  ) {
    return this.op<ArtifactsCreateRepoResult>("fork", { target: name, opts });
  }

  [Symbol.dispose]() {}
}

/** Namespace-level operations, like the Artifacts binding. */
export class GitServiceClient {
  private readonly call: Call;

  constructor(options: GitServiceClientOptions) {
    const base = options.baseUrl.replace(/\/+$/, "");
    const doFetch = options.fetch ?? fetch;
    this.call = (op, body) =>
      doFetch(`${base}/api/${op}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...body, namespace: options.namespace }),
      });
  }

  create(
    name: string,
    opts: { readOnly?: boolean; description?: string; setDefaultBranch?: string } = {},
  ) {
    return asJson<ArtifactsCreateRepoResult>(this.call("create", { name, opts }));
  }

  async get(name: string) {
    await asJson<{ ok: true }>(this.call("get", { name }));
    return new GitServiceRepo(this.call, name);
  }

  import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: { name: string; opts?: { description?: string; readOnly?: boolean } };
  }) {
    return asJson<ArtifactsCreateRepoResult>(this.call("import", params));
  }

  list(opts: { limit?: number; cursor?: string } = {}) {
    return asJson<ArtifactsRepoListResult>(this.call("list", { opts }));
  }

  async delete(name: string) {
    return (await asJson<{ deleted: boolean }>(this.call("delete", { name }))).deleted;
  }
}
