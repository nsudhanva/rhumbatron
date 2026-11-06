# Apps host (workerd)

Runs `workers/apps` on open-source `workerd` in Docker. It serves every Project app at
`<label>.rhumbatron.localhost` and builds app bundles for the core service.

| Port | Listener | Routed by Caddy |
| --- | --- | --- |
| 8788 | App hosts `*.rhumbatron.localhost` | yes |
| 8789 | `POST /rpc/<Entrypoint>/<method>` for core | no |

## How it maps the Cloudflare Worker

| Worker binding | workerd |
| --- | --- |
| `LOADER` (Dynamic Workers) | `workerLoader` binding (needs `--experimental`) |
| `APP_DATA` (`AppDataDO`, SQLite) | Durable Object namespace, `localDisk` on `/data/do` |
| `DB` (D1) | HTTP shim to core, `workers/apps/src/platform/d1.ts` |
| `EVIDENCE` (R2) | HTTP shim to core, `workers/apps/src/platform/r2.ts` |
| `APPS` service binding | `RpcGateway` on 8789, `services/apps/client.ts` |
| `ctx.exports` entrypoints | native |

The entry module is `workers/apps/src/platform/workerd.ts`. It wraps the normal entrypoints so
`DB` and `EVIDENCE` are the shims. The rest of `workers/apps/src` runs unchanged.

Network:

- The platform Worker reaches core only through the `CORE` external service (`core:8790`).
- Its global `fetch` goes to the `internet` service, public addresses only. The bundle builder
  uses it to fetch npm packages.
- Apps loaded through `LOADER` have `globalOutbound: null`: no network at all.

The wire contract with core is in [CONTRACT.md](CONTRACT.md).

## Files

- `Dockerfile`: bundles the Worker (`build.ts`), installs `workerd@1.20261008.1` (matches the
  compatibility date `2026-10-08`), runs `workerd serve config.capnp --experimental` as a
  non-root user. Build from the repository root: `docker build -f services/apps/Dockerfile .`
- `config.capnp`: the workerd config.
- `build.ts`: `bun services/apps/build.ts [outdir]` writes `worker.js` and `esbuild.wasm`.
- `client.ts`: fetch client for core (`env.APPS`).
- `test/`: stub core and an end-to-end check.

## Environment

| Variable | Default | Use |
| --- | --- | --- |
| `INTERNAL_TOKEN` | none (required) | Bearer token for core calls and RPC callers. |
| `APPS_DOMAIN` | `rhumbatron.localhost` | App host suffix. |
| `ENVIRONMENT` | `local` | Label only. |

Mount a volume on `/data` to keep app data.

## End-to-end check

```sh
export INTERNAL_TOKEN=test-token
docker compose -f services/apps/test/compose.yml up -d --build
bun services/apps/test/verify.ts
docker compose -f services/apps/test/compose.yml down -v
docker image rm rhumbatron-apps:test
```

`verify.ts` builds an app through RPC, points `demo.rhumbatron.localhost` at it, serves it, uses
`DATA`, confirms the app cannot `fetch("https://example.com")`, probes, runs `check` (build and
unit), and wipes the store.

## Limits

- A wiped data store is unusable until its Durable Object instance is evicted (about 10 s idle).
  Callers wipe only removed apps and expired previews, which are not served.
- The per-request `limits` (CPU ms, subrequests) that the router passes for loaded apps are not
  verified on workerd. Treat them as not enforced.
- D1 `raw()` derives column order from row objects; blob parameters are not supported.
