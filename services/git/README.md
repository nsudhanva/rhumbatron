# Git service

`@rhumbatron/git-service` stores Project source as Git repositories.
It gives the same surface as the Cloudflare Artifacts binding.
The core service uses `client.ts` as `env.ARTIFACTS`.

## Storage

Each repo is a bare repository at `$GIT_ROOT/<name>.git`.
A fork is `git clone --bare --shared`.
A fork borrows the source objects through `objects/info/alternates` and keeps its own `main`.
Before the service deletes a repo, each fork of it copies the borrowed objects into its own pack.
SQLite at `$GIT_ROOT/_meta/git.sqlite` holds repo metadata and tokens.

## Endpoints

| Path | Auth | Use |
|---|---|---|
| `POST /api/<op>` | `Bearer $GIT_ADMIN_TOKEN` | JSON control API for the core service only. |
| `/git/<name>.git/...` | Basic (any user, token as password) or Bearer | Git smart HTTP through `git http-backend`. |
| `GET /healthz` | None | Liveness. |

Control API operations: `create`, `get`, `import`, `list`, `delete`, `info`, `createToken`, `listTokens`, `revokeToken`, `readBlob`, `readTree`, `readCommit`, `readFile`, `log`, `fork`.

The service serves only the smart protocol.
It refuses dumb-protocol paths.

## Tokens

`createToken(scope, ttl)` returns `{ id, plaintext, scope, expiresAt }`.
The plaintext is `<token>?expires=<unix>`.
Callers send the part before `?expires=`.
A token is an HMAC-SHA256 signature over the token ID, the repo name, the scope, and the expiry.
`GIT_TOKEN_SECRET` signs it.

A token grants one repo.
A `read` token allows only `git-upload-pack`.
A `write` token also allows `git-receive-pack`, except on a read-only repo.
The service refuses a token that is expired, revoked, or not in the token table.
Deleting a repo deletes its tokens.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `GIT_ADMIN_TOKEN` | Required, 16+ characters | Bearer token for the control API. |
| `GIT_TOKEN_SECRET` | Required, 32+ characters | HMAC key for repo tokens. |
| `GIT_ROOT` | `/srv/git` | Volume for repos and SQLite. |
| `GIT_PUBLIC_URL` | `http://git:8080` | Origin in `info().remote`. |
| `GIT_NAMESPACE` | `rhumbatron` | The one namespace. The client must send the same value. |
| `PORT` | `8080` | Listen port. |

## Client

```ts
import { GitServiceClient } from "@rhumbatron/git-service/client";

const artifacts = new GitServiceClient({ baseUrl: "http://git:8080", adminToken, namespace: "rhumbatron" });
using repo = await artifacts.get(projectId);
const [head] = await repo.log({ ref: "main", limit: 1 });
```

`client.ts` uses only `fetch`.
Errors are `ArtifactsError` values with the Artifacts `code` strings.

## Commands

```bash
bun services/git/src/server.ts          # run locally; set GIT_ROOT to a writable directory
bunx vitest run services/git            # security and end-to-end checks
docker build -t rhumbatron-git services/git
```

The tests load `isomorphic-git` from `workers/integration`, the same client that the integration code uses.
