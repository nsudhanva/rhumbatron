# Live apps

This page explains how Rhumbatron serves each Project as a live app, how a Candidate gets a preview, and how a promotion moves the live app (ADR 0020, ADR 0034).

Main source files:

- `workers/apps/src`: the router, `AppBuilder`, `AppChecker`, `AppDataDO`, and the bundle format.
- `workers/apps/src/platform/workerd.ts`: the entry module on workerd, with the shims for `DB` and `EVIDENCE`.
- `services/apps`: the workerd config, the image, and the RPC client for core ([README](../../services/apps/README.md), [CONTRACT](../../services/apps/CONTRACT.md)).
- `workers/integration/src/app-provision.ts`, `app-release.ts`, `app-release-model.ts`, `preview-smoke.ts`, `rollback.ts`
- `workers/integration/src/release-workflow.ts`: the release steps.
- `packages/protocol/src/app.ts`: host rules and limits.

## Hosts

Every app host has one label under `rhumbatron.localhost` (`APPS_DOMAIN`).
One label keeps the hosts inside the wildcard certificate that Caddy issues for `*.rhumbatron.localhost`.

| Host | Serves |
|---|---|
| `<slug>.rhumbatron.localhost` | The production app of the Project. |
| `<previewId>--<slug>.rhumbatron.localhost` | The preview of one Candidate. The preview ID is the first 8 characters after `cand_`. |
| `v0000001--<slug>.rhumbatron.localhost` | One promoted generation. `v` and 7 digits name the generation. |

Rules:

- The label comes from the Project slug. If the slug is taken, the label adds 6 characters of the Project ID.
- A reserved label gets the suffix `-app`. Reserved labels are `www`, `api`, `docs`, `clerk`, other Rhumbatron and Clerk names, and every label that starts with `rhumbatron` (`RESERVED_APP_LABELS`).
- A label has at most 50 characters. A host with a reserved, unknown, or invalid label gets a plain 404.
- A preview host and a version host each have their own data store. They never read or write production data.

## The apps service

The `apps` service runs `workers/apps` on the open-source `workerd` runtime.
Caddy sends every `*.rhumbatron.localhost` host that is not `api` or `docs` to port 8788.
Core calls the RPC entrypoints on port 8789. Caddy does not route port 8789.

| Part | Role |
|---|---|
| Router (default `fetch`) | Maps the host to an app, reads the pointer, and runs the app. |
| `AppBuilder` | RPC entrypoint that core reaches as `env.APPS`. Methods: `build` (bundle), `probe` (one request through the router with a fresh pointer read), `check` (runs `AppChecker`), and `wipeData` (deletes app data stores). |
| `AppChecker` | Runs the `build`, `unit`, and `contract` checks in loaded Workers. Only `AppBuilder.check` calls it. See [Source and verification](source-and-verification.md#where-checks-run). |
| `AppDataDO` | One SQLite instance per production app, per preview, and per version host, in a workerd Durable Object namespace on local disk (`/data/do` on the `apps-data` volume). It stores the key-value data of the app. |
| `AppAssets`, `AppData` | The `ASSETS` and `DATA` bindings that the router gives to each app. |
| `LOADER` | The workerd Worker Loader binding. It starts each app as its own isolate. |

The apps service reads the pointer rows and the bundles through core (`core:8790`, the `INTERNAL_TOKEN` bearer token).
`DB` is an HTTP shim to the product database. `EVIDENCE` is an HTTP shim to the object store.
The platform Worker can `fetch` public addresses only. The bundle builder uses this to fetch npm packages.

```mermaid
flowchart LR
  USER["Browser"] --> CADDY["Caddy<br/>*.rhumbatron.localhost"]
  CADDY --> R["Router (workerd)"]
  R -->|"DB shim"| P[("app_deployments<br/>pointer, cached 10 s")]
  R -->|"EVIDENCE shim"| B[("bundle<br/>apps/ or app-previews/")]
  R -->|"LOADER.get(loader ID)"| DW["App isolate"]
  DW -->|"ASSETS"| B
  DW -->|"DATA"| DO[("AppDataDO")]
```

Each request follows these steps:

1. The router parses the host.
2. The router reads the pointer rows of the host from `app_deployments`. Each isolate caches them for 10 s.
3. The router serves a static asset first, unless the bundle sets `runWorkerFirst`. Otherwise it runs the app in its own isolate.
4. The app runs with no network (`globalOutbound: null`). The router passes a limit of 50 ms CPU and 20 subrequests per request. workerd does not verify these limits, so treat them as not enforced. An app error answers 502.
5. The app env holds only `ASSETS` and `DATA`. The router strips cookies of other hosts on the way in and `Domain` cookies on the way out.

The router has a page for each other state: `building` (503), `failed` (503), an app with no code (200), and `removed` (410).
A pointer row keeps the last good bundle while a newer build runs or fails. A failed build never stops a live app.

`DATA` is a string key-value store. A key has at most 512 characters and a value at most 128 KiB. A store holds at most 10,000 keys.

## Builds

The integration code reads the source of one commit from the git service and calls `AppBuilder.build` with the files.
The builder bundles the files with the `@cloudflare/worker-bundler` library (esbuild) in the apps service. It uses no Sandbox time.
It writes the bundle to the object store under `apps/<project>/<commit>/` and reuses a stored bundle of the same commit.
Tests, benchmarks, lockfiles, and Markdown files stay out of the build.
A deterministic failure returns a reason and is not retried. A build that finds real authentication in the app fails.

The cap is 60 app builds per UTC day (`APP_BUILDS_PER_DAY`, counter `app-builds` in `usage_counters`).

### Client assets built by the app

The builder serves the files under `public/` as they are in the commit. It does not run the app's own build.
An app can build its client itself, for example React and Tailwind bundled by `scripts/build.ts` to `public/app.js` and `public/app.css`.
For such an app, Candidate composition runs the app's build in the Sandbox (`workers/integration/src/app-build.ts`):

1. After the ChangeSets merge, composition reads the composed `package.json`. Without a `build` script, no build runs.
2. With a `build` script, composition runs `bun install` and then `bun run build` (120 s timeout).
3. Composition commits the files that the build changed (`Build <candidate>`) on top of the merges. The Candidate commit, the preview, the promotion, and the release then all serve the assets built from the composed sources.
4. A failed build commits nothing. Its exit code and output tail are the `build` Evidence (`fail`, `checked_supported`). A build timeout is a gap.
5. The required `client-assets` check compares the composed commit with the base. See [Source and verification](source-and-verification.md#which-checks-run).

The Sandbox time of the build counts on the reservation of the verification workflow.
Agents edit the client sources. They do not edit the generated files (`APP_CONVENTIONS`). A `bun run build` in an agent workspace does not keep its output, so sibling ChangeSets never conflict on generated files.

## Preview of a Candidate

The verification workflow builds the composed commit of a Candidate and points the preview host at it.
The preview bundle is under `app-previews/<project>/<commit>/`.
A Change has at most 3 previews.
The daily maintenance sweep deletes preview rows older than 7 days, with their data stores (`expirePreviews`). Preview bundles stay in the object store until "Remove app" or the Project deletion clears the prefix.
A failed preview build marks only the preview row. It does not change the verification result.

Every Project with a live app has a required `preview-smoke` check (kind `smoke`).
The check runs the release probes on the exact preview host through `AppBuilder.probe`.
It does not touch production or the production data store.
The home page must answer 2xx or 3xx with the app's own page. Each `GET` route of the contract (no parameters) must answer 2xx, 400, 401, 403, or 422: a route that checks its input or its caller is deployed. A 404 (not deployed) or a 5xx (crashed) fails the check.
A missing or failed preview is a gap, and the Candidate cannot promote.
Sibling Candidates of one Change each get a preview. Only the selection winner promotes and releases (ADR 0026).

## Promotion and release

The promotion runs as in [Source and verification](source-and-verification.md#promotion-preconditions).
Then `ReleaseWorkflow` starts for the Project. It has 6 to 9 steps and uses no Sandbox.
A Project without a live app starts no release.

```mermaid
sequenceDiagram
  autonumber
  participant RW as ReleaseWorkflow
  participant INT as app-release
  participant DB as Product database
  participant APPS as AppBuilder.probe
  participant Router as Router

  RW->>DB: generation still canonical, else superseded
  RW->>INT: ensureProductionBundle (stored, same tree, copied from the preview, or built)
  RW->>INT: movePointer(production, expected row)
  INT->>DB: UPDATE app_deployments WHERE commit, bundle, generation match
  INT->>DB: version host row v<generation>
  RW->>APPS: smoke probes on the production host (second try after 10 s)
  APPS->>Router: request with a fresh pointer read
  alt probes pass
    RW->>DB: release deployed
  else a probe fails
    RW->>INT: movePointer(revert to the replaced version)
    RW->>DB: release smoke_failed
  end
```

- The pointer moves by compare-and-swap on the row that the workflow read. A lost race fails the step, and the retry decides again from the new row.
- A newer generation that is already live makes the release `superseded`.
- A bundle copied from a preview costs only object copies. It does not build again.
- A smoke failure moves the pointer back to the version that it replaced. The failure is a recorded transition with the Event `release.smoke_failed`. The Canonical Generation stays promoted.
- Every promoted generation keeps a version host `v<generation>--<slug>`.

## Rollback

A rollback is a new canonical transition from `Sn` to `Sn+1`. The new tree equals the tree of an earlier generation `Sk` (`requestRollback`).
The request names `expectedGeneration`. Rhumbatron refuses a request from an old page.
Rhumbatron creates a rollback Change and Candidate, writes one commit with the tree of `Sk` in the Candidate fork, and records one required check: the tree of that commit equals the tree of `Sk`.
Policy decides the human gate from the riskiest Change that the rollback undoes.
Then the promotion and the release run as for any Candidate. The release points production at the bundle of `Sk` and does not rebuild it.
No model decides a rollback.

## Remove app and delete Project

"Remove app" keeps the Project. It sets every `app_deployments` row of the Project to `removed`, and every host of the app answers 410 within 10 seconds (the router caches pointer rows for 10 seconds in each isolate).
Cleanup then deletes the previews and bundles and wipes the data stores. The production row stays as a tombstone, so the host keeps its label and keeps answering 410.

Deleting a Project removes all of its data: the live app, the git repositories, the objects, the database rows, and the actor storage.
The list is in [cleanup.md](../operations/cleanup.md).
