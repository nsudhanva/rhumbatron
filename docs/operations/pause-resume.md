# Pause and Resume Runbook

Operations guide for pausing and resuming autonomous background operations, cron sweeps, and Sandbox containers.

## Purpose

The `paused` switch immediately halts autonomous background compute and container execution to prevent runaway compute costs and limit exhaustion without destroying infrastructure or deleting data (`AGENTS.md` rule 50, [ADR 0017](../adr/0017-prod-environment.md)).

---

## 1. The `paused` Switch

The pause setting is declared in Terraform environment definitions:

- Dev: `infrastructure/terraform/envs/dev/main.tf` (`locals { paused = false }`)
- Prod: `infrastructure/terraform/envs/prod/main.tf` (`locals { paused = false }`)

---

## 2. What `paused = true` Stops

1. **Event Router Cron Sweep**:
   - `module.event_router_worker`:
     ```hcl
     cron_schedules = local.paused ? [] : ["* * * * *"]
     ```
   - Disables the safety-net 1-minute cron trigger that sweeps K2 event streams.
2. **Sandbox Containers**:
   - `local.sandbox_worker`:
     ```hcl
     max_instances = local.paused ? 0 : 1
     ```
   - Sets maximum container instances to 0 ([ADR 0012](../adr/0012-sandbox-worker.md)).
   - Existing instances stop; new container starts are rejected, capping container runtime to $0.

---

## 3. What Keeps Running

Pausing does not destroy resources or take the application offline:

- **Data Plane**: D1 databases, Durable Object SQLite storage, R2 evidence buckets, KV namespaces, K2 event logs, and Cloudflare Artifacts repositories remain fully intact.
- **Web & API Ingress**: Both the web frontend (`rhumbatron.com` / `dev.rhumbatron.com`) and the API Worker (`api.rhumbatron.com` / `api-dev.rhumbatron.com`) continue serving HTTP traffic.
- **Queues & Direct Triggers**: Queue consumers and low-latency coordinator publish nudges remain bound; existing messages can be processed or held in queues.

---

## 4. How to Pause

1. Edit `locals` in `infrastructure/terraform/envs/<env>/main.tf`:
   ```hcl
   locals {
     paused = true
     # ...
   }
   ```
2. Bundle if worker code was changed, then plan and apply:
   ```sh
   # For dev:
   bun run tf:plan:dev
   bun run tf:apply:dev

   # For prod:
   bun run tf:plan:prod
   bun run tf:apply:prod
   ```
3. Verify that `cron_schedules` is empty and `max_instances` is 0 in the plan output.

---

## 5. How to Resume

1. Edit `locals` in `infrastructure/terraform/envs/<env>/main.tf`:
   ```hcl
   locals {
     paused = false
     # ...
   }
   ```
2. Plan and apply:
   ```sh
   # For dev:
   bun run tf:plan:dev
   bun run tf:apply:dev

   # For prod:
   bun run tf:plan:prod
   bun run tf:apply:prod
   ```
3. Check for drift:
   ```sh
   bun run tf:drift       # for dev
   bun run tf:drift:prod  # for prod
   ```
