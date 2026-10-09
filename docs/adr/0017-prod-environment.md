# ADR 0017: Prod environment

- Status: Proposed (planned, not applied)
- Date: 2026-10-09
- Decider: Project owner

## Context

AGENTS.md section 10 adds `prod` after the first end-to-end Change works. Prod must use separate
Terraform state, `-prod` names, and the production hostnames. The owner approved replacing the
current `rhumbatron.com` site when prod goes live.

The Cloudflare account is on Workers Paid for other projects. Rhumbatron must stay inside the free
and included limits (AGENTS.md section 7.3, rule 50). Prod adds a second copy of every
environment-scoped resource, so every account-wide limit now has two Rhumbatron consumers.

## Decision

### Layout

- `infrastructure/terraform/envs/prod` mirrors `envs/dev` resource for resource. State key:
  `prod/terraform.tfstate` in `rhumbatron-terraform-state-global`.
- Dev stays inline. A shared environment module would move every dev address (`module.x.*`), and
  dev state must not change. Keep the two `main.tf` files in step by hand. Today prod omits what
  dev also omits (indexer Worker, Vectorize; ADR 0003). Add them to prod when dev adds them.
- Bundles are environment-neutral. `bun run cf:bundle` serves both roots; environment config
  travels in bindings.
- `bun run tf prod …` loads prod credentials from the Keychain. Scripts: `tf:plan:prod`,
  `tf:apply:prod`, `tf:drift:prod`, `smoke:prod` (public checks only).

### Hostnames

| Host | Target |
|---|---|
| `rhumbatron.com` | `rhumbatron-web-prod` custom domain, after the cutover (`attach_apex`) |
| `api.rhumbatron.com` | `rhumbatron-api-prod` custom domain |
| `www.rhumbatron.com` | 301 to `https://rhumbatron.com` (envs/global: placeholder `AAAA 100::` + Single Redirect) |

The redirect is in `envs/global` because the zone's `http_request_dynamic_redirect` entrypoint is a
zone-wide singleton.

### Switches (`envs/prod/main.tf`)

| Switch | Default | Meaning |
|---|---|---|
| `paused` | `false` | `true` removes the cron sweep and sets Sandbox `max_instances = 0`. Data stays. |
| `bootstrap` | `true` | First apply only. Omits the coordinator `EVENT_ROUTER` binding (cycle) and uploads the first Durable Object migrations (`new_tag = v1` with classes). Set `false` after the first apply: migrations become the steady `v1 -> v1`. |
| `attach_apex` | `false` | Adds the apex custom domain to the web Worker. Set `true` only after the cutover below. |

### Prod-only settings

- `model_provider` defaults to `openrouter` (dev keeps `vertex`).
- `CLERK_ALLOW_MISSING_AZP = "false"`. `CLERK_AUTHORIZED_PARTIES = "https://rhumbatron.com"`.
- Clerk production instance: `VITE_CLERK_PUBLISHABLE_KEY` is a `plain_text` binding on the prod web
  Worker. The build inlines the development key, but Clerk's `getEnvVariable` reads `process.env`
  first, and `nodejs_compat` (compatibility date 2026-10-08) fills `process.env` from bindings. So
  one bundle serves both environments. The variable must start with `pk_live_`.
- Clerk DNS records: `var.clerk_dns_records` (label -> CNAME target, DNS only). Empty until the
  instance exists; Clerk shows the five records when the domain is added.

### AI Gateway: separate gateway

Prod gets `rhumbatron-models-prod`. Reasons:

- Destroying or pausing dev must never change prod.
- Logs, the request rate limit, and the spend cap stay per environment.
- The account has one gateway today (`rhumbatron-models-dev`); two is far below the account limit.
  Each stores at most 10,000 logs.

Sharing dev's gateway would give one real Vertex cap, but prod would then depend on a resource in
dev state. Moving the gateway to `envs/global` would move a dev address. Both were rejected.

The cost condition is in "Decisions needed" below: two $9 caps can spend $18 per 30 days.

### K2

- Prod uses 8 streams `rhumbatron_events_NN_prod`, 7-day retention, the same 4 subscriptions.
- Plan time: `data.external.k2_inventory` (read-only `scripts/k2-read.ts`, `mode = inventory`)
  lists every stream on the account. A precondition on `terraform_data.k2_streams` fails the plan
  if the other streams plus prod's 8 exceed 20.
- Apply time: `scripts/k2-sync.ts` refuses to create anything when existing plus missing streams
  exceed 20.
- Measured on 2026-10-09 (prod plan): 8 other streams (dev) + 8 prod = 16 of 20. Four remain for
  other projects.

### Credentials (ADR 0004 pattern, Keychain, never in Git)

| Variable | Keychain service | Status 2026-10-09 |
|---|---|---|
| `TF_VAR_clerk_secret_key` | `rhumbatron-clerk-secret-key-prod` | missing |
| `TF_VAR_clerk_publishable_key` | `rhumbatron-clerk-publishable-key-prod` | missing |
| `TF_VAR_k2_consumer_token` | `rhumbatron-k2-consumer-token-prod` (new `rhumbatron-k2-consumer-prod` token, K2 Consume only) | missing |
| `TF_VAR_openrouter_api_key` | `rhumbatron-openrouter-api-key` (shared with dev) | present |
| `TF_VAR_vertex_service_account` | `rhumbatron-vertex-sa-prod` | missing |

`bun run tf prod …` stops until the missing items exist. That is the gate for the decisions below.

## Cost: what prod adds

Idle means no Change is running.

| Product | Limit used | Prod adds | Notes |
|---|---|---|---|
| Workers requests | 100,000/day (free figure) | ~1,440/day idle (1-minute cron sweep) + traffic | Dev adds the same. ~3,000/day idle together. |
| Durable Objects | 100,000 req/day | sweep and nudges only when events exist | SQLite backend. |
| D1 | 10 databases; 5 M reads, 100 k writes/day | 1 database (3 of 10 on the account) | Reads and writes are account-wide; idle prod writes almost nothing. |
| R2 | 10 GB-month, 1 M Class A/month | 1 bucket | Prod keeps `evidence/` with no expiry and `events/` 365 days. Watch storage. |
| KV | — | 1 namespace | Not read in a hot path yet. |
| Queues | 10,000 ops/day | 6 queues, 3 consumers | 0 ops idle; ~3 ops per woken Task. |
| K2 | 20 streams, 10 GB | 8 streams | 16 of 20. Billing disabled in beta. |
| Workflows | 3,000 steps/day | 2 workflows | ~7 steps per Change, 10–14 per Candidate. Shared with dev. |
| Sandbox / Containers | 25 GiB-h memory, 375 vCPU-min, 200 GB-h disk / month | 1 app, `basic`, `max_instances = 1`, 10 h/month meter in prod D1 | The meter is per environment. Worst case both: 20 h = 20 GiB-h, 300 vCPU-min, 80 GB-h. Inside included usage, but double the approved 10 h (HOM-192). |
| Browser Run | 10 min/day (free figure) | 500 s/day guard in prod D1 | Per environment. Worst case both: 1,000 s/day, above 600 s/day. |
| Workers AI | 10,000 Neurons/day | Clef-flash cap 200 calls/day in prod D1 | Doubles the worst case. |
| AI Gateway | free core features | 1 gateway, 10,000 stored logs | Vertex cap is per gateway (below). |
| Analytics Engine | 100,000 points/day | dataset `rhumbatron_metrics_prod` | Shared limit. |
| Workers Logs | 200,000 events/day | 100 % sampling on 7 Workers | Cron alone is ~1,440 events/day. |
| Artifacts | 10,000 ops/month, 1 GB-month | namespace `rhumbatron-projects-prod` | Account-wide allowance shared with dev. |
| Workers Builds | 3,000 min/month | `rhumbatron-acme-shop-prod` | Needs its own one-time dashboard connection (ADR 0014). |

## Cutover of the current `rhumbatron.com` site

Observed on 2026-10-09 (read-only):

- `rhumbatron.com` resolves to Cloudflare proxy addresses (104.21.15.9, 172.67.160.251,
  2606:4700:3033::6815:f09, 2606:4700:3037::ac43:a0fb): a proxied record. It serves a static
  "Rhumbatron Robotics, coming soon" page.
- No Worker custom domain on the account uses the apex (only `dev.rhumbatron.com` and
  `api-dev.rhumbatron.com`), and no non-dev Rhumbatron Worker script exists.
- The monitor token cannot read DNS records, zone Worker routes, or Pages projects, so the record
  IDs and origin were not read. An earlier inspection found a proxied `A` record at the apex, a
  Google site-verification `TXT` record, and SSL mode Flexible.
- `www`, `api`, `clerk`, and `accounts` have no records. The zone has no `MX` record.

Steps. Each step is a Terraform plan, read, then apply of the saved plan.

1. Create the Clerk production instance for `rhumbatron.com`. Store its keys in the Keychain. Put
   its CNAMEs in the `clerk_dns_records` default in `envs/prod/variables.tf` (the targets are
   not secret, and Git ignores `terraform.tfvars` and `*.auto.tfvars`, so a committed default keeps the plan
   reproducible).
2. Decide the items in "Decisions needed". Create the missing Keychain items.
3. `bun run cf:bundle`, `bun run tf:plan:prod`, read, `bun run tf:apply:prod` (bootstrap = true,
   attach_apex = false). Set `bootstrap = false`, plan, apply again. `tf:drift:prod` must be
   clean. Check `https://api.rhumbatron.com/health`.
4. Apply `envs/global` for the `www` redirect (independent of the cutover).
5. Find the legacy apex record IDs (read-only: dashboard DNS page or `cf` CLI). Also confirm that
   no zone Worker route or Pages custom domain holds `rhumbatron.com`. If one does, handle it the
   same way with its resource type.
6. In `envs/global`, add a `cloudflare_dns_record.legacy_apex` resource that matches the record,
   with an `import` block (`<zone_id>/<record_id>`). Plan must show import only; apply.
7. Remove that resource and its import block from `envs/global`. Plan must show one destroy;
   apply. The apex now has no record: the old site is offline from here to step 8. Keep the
   Google verification `TXT` record.
8. Set `attach_apex = true` in `envs/prod`. Plan, apply. The custom domain creates the apex record
   and its certificate. Prepare this plan before step 7 to keep the gap to minutes.
9. In `envs/global`, add `ssl = "strict"` to `zone_settings` (Workers are the only origins now).
   Plan, apply.
10. `bun run smoke:prod`. Check that `www.rhumbatron.com` returns 301 to the apex. Sign in once.

Rollback is a new transition: set `attach_apex = false`, apply, and recreate the legacy record
in `envs/global` from the values recorded in step 6.

## Decisions needed before the first prod apply

1. **Vertex spend.** Two gateways with a $9 cap each can spend $18 per 30 days; the GCP credit is
   $10. Options: (a) `rhumbatron-vertex-sa-prod` comes from a separate GCP project with its own
   credit; (b) one GCP project, and lower the caps so dev + prod ≤ $9 (for example dev $4, prod
   $5; dev needs a `vertex_spend_limit_usd` argument on its `module.ai`); (c) prod sets
   `model_provider = "openrouter"` and `vertex_spend_limit_usd` near $0, so prod has no overflow.
2. **OpenRouter quota.** The key is shared, so dev and prod share 20 requests/minute and 50 (or
   1,000) requests/day, while each environment's D1 counter allows 45. The second environment then
   gets 429s, marks OpenRouter exhausted, and overflows to Vertex. Options: accept, or a separate
   OpenRouter account for prod.
3. **Sandbox hours.** Prod doubles the approved 10 h/month to a 20 h/month worst case. Options:
   approve 20 h; split the meter (for example 5 h per environment; code constant in
   `workers/api/src/cost.ts` and the agents workspace meter); or keep prod `paused` except for demos.
4. **Browser Run.** Two 500 s/day guards exceed the 600 s/day free figure. Options: lower the guard
   to 300 s per environment (code constant `BROWSER_DAILY_SECONDS`), or accept the Paid allowance
   (10 h/month included; worst case 8.3 h/month).
5. **Demo code paths.** The Wishlist design-conflict fixture routes answer only in `dev` and
   `local`, and the Acme Shop fixture's `wrangler.jsonc` names `rhumbatron-acme-shop-dev`. Either
   run the section 55 demo on dev, or make both environment-aware before a prod demo.

## Consequences

- Prod is a second consumer of every account-wide limit. The cost table must be checked again when
  either environment adds a resource.
- The first prod apply is the first fresh apply of this configuration (dev grew one change at a
  time). The `bootstrap` switch covers the one known cycle.
- `bun run tf:drift` still covers global and dev. Run `tf:drift:prod` after each prod apply.
