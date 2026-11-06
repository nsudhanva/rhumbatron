# Apps host and core: internal HTTP contract

The apps host (`services/apps`, workerd) and the core service talk over two internal HTTP APIs.
Neither API is routed by Caddy. Every request carries `authorization: Bearer <INTERNAL_TOKEN>`.
Both services read the same `INTERNAL_TOKEN` from their environment. A wrong or missing token
gets `401`.

## 1. Core serves the apps host: `http://core:8790`

The apps Worker reaches these through the workerd external service `core` (binding `CORE`).
Loaded apps cannot reach them.

### D1: `POST /internal/d1`

Request body:

```json
{ "statements": [{ "sql": "SELECT ... WHERE slug = ?", "params": ["demo"] }], "batch": false }
```

- `params` are JSON values bound positionally to `?`. The apps host sends booleans as `1`/`0`
  and `undefined` as `null`. It never sends blobs.
- `batch: false`: exactly one statement. The response is one D1Result.
- `batch: true`: one or more statements, run in one transaction (all or none). The response is
  an array of D1Results, one per statement, in order.

D1Result:

```json
{
  "results": [{ "column": "value" }],
  "success": true,
  "meta": { "changes": 0, "last_row_id": 0, "duration": 0.4, "rows_read": 1, "rows_written": 0 }
}
```

`results` holds row objects with keys in column order (an empty array for a write). On a SQL error,
answer a non-2xx status with `{ "error": "<message>" }`; the apps host throws with that text.

The apps host runs one query: the pointer read on `app_deployments` (migration 0018).

### R2

The bucket is the evidence bucket (`EVIDENCE`). Keys look like `apps/<project>/<commit>/bundle.json`.

| Request | Meaning | Success |
| --- | --- | --- |
| `GET /internal/r2/object/<key>` | read | `200`, body = bytes, `x-r2-meta` |
| `HEAD /internal/r2/object/<key>` | metadata | `200`, no body, `x-r2-meta` |
| `PUT /internal/r2/object/<key>` | write (replace) | `200`, `x-r2-meta` of the stored object |
| `DELETE /internal/r2/object/<key>` | delete | `204` (or `200`); a missing key is not an error |
| `GET /internal/r2/list?prefix=&cursor=&limit=&delimiter=` | list | `200`, JSON below |

- `<key>` is the whole key as one `encodeURIComponent` value: `/` is sent as `%2F`. Decode the
  path after `/internal/r2/object/` with `decodeURIComponent`. Do not split it on `/`.
- A missing object answers `404` to `GET` and `HEAD`.
- `x-r2-meta` is JSON. Non-ASCII characters are `\uXXXX` escapes, so the header stays ASCII:

  ```json
  {
    "key": "apps/proj_x/<commit>/bundle.json",
    "size": 1234,
    "etag": "9a0364b9e99bb480dd25e1f0284c8555",
    "uploaded": "2026-11-05T12:00:00.000Z",
    "httpMetadata": { "contentType": "application/json" },
    "customMetadata": {}
  }
  ```

  On `PUT`, the apps host sends only `httpMetadata` and `customMetadata`; the core sets `size`,
  `etag` (hex digest, no quotes), and `uploaded` (ISO 8601). `httpMetadata` uses the R2 field
  names: `contentType`, `contentLanguage`, `contentDisposition`, `contentEncoding`, `cacheControl`.
- List response (`limit` defaults to 1000; `cursor` is opaque and present only when `truncated`):

  ```json
  {
    "objects": [{ "key": "...", "size": 1, "etag": "...", "uploaded": "...", "httpMetadata": {}, "customMetadata": {} }],
    "truncated": false,
    "cursor": "opaque",
    "delimitedPrefixes": []
  }
  ```

Other statuses are errors: answer `{ "error": "<message>" }`.

## 2. The apps host serves core: `http://apps:8789`

`POST /rpc/<Entrypoint>/<method>`. The body is a JSON array of arguments. A `200` body is the
method's JSON result (`null` for no result). An error is `4xx`/`5xx` with `{ "error": "<message>" }`:
`401` bad token, `404` unknown method, `400` bad body, `500` the method threw, `503` the apps
host has no `INTERNAL_TOKEN`.

| Entrypoint | Methods | Notes |
| --- | --- | --- |
| `AppBuilder` | `build`, `probe`, `wipeData`, `check` | Types in `packages/protocol/src/app.ts`. |
| `AppChecker` | `check` | Same as `AppBuilder.check`. |
| `AppData` | `get`, `put`, `delete`, `list` | Needs header `x-rpc-props: {"storeName":"<store>"}`. |

`services/apps/client.ts` (`createAppsClient`) wraps `AppBuilder` with the four methods that the
integration code calls on `env.APPS`.

## 3. Public listener: `:8788`

Caddy sends `*.rhumbatron.localhost` here with the original `Host` header. The router maps the host
to an app (`parseAppHost` with `APPS_DOMAIN`).
