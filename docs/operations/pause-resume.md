# Pause and Resume Runbook

This runbook pauses and resumes the work that starts automatically. This work is the cron sweep and the Sandbox containers.

The `paused` switch stops the event router cron and every new Sandbox start. It does not destroy infrastructure or delete data ([ADR 0017](../adr/0017-prod-environment.md)).

The switch is `locals { paused = false }` in `infrastructure/terraform/envs/prod/main.tf`.

```mermaid
stateDiagram-v2
  [*] --> Running
  Running --> Paused: paused = true, plan, apply
  Paused --> Running: paused = false, plan, apply, drift check
  note right of Running
    Cron every minute.
    Sandbox max_instances = 1.
  end note
  note right of Paused
    No cron. Sandbox max_instances = 0.
    Web, API, Queues, and data stay up.
  end note
```

## 1. What `paused = true` stops

1. The event router cron.
   ```hcl
   cron_schedules = local.paused ? [] : ["* * * * *"]
   ```
   The cron runs the 1-minute safety-net sweep of the K2 streams. The same cron runs the daily maintenance at 04:17 UTC ([cleanup.md](./cleanup.md)) and the stuck-release sweep every 5 minutes ([release.md](./release.md)). None of them runs while paused.
2. Sandbox containers.
   ```hcl
   max_instances = local.paused ? 0 : 1
   ```
   No container can start ([ADR 0012](../adr/0012-sandbox-worker.md)), so Sandbox time does not increase. Agent Workspaces and Candidate checks that need a container fail.

## 2. What keeps running

- Data: D1, Durable Object storage, R2, KV, K2, and Artifacts repositories stay intact.
- The web Worker (`rhumbatron.com`), the API Worker (`api.rhumbatron.com`), and the live apps serve traffic.
- Queue consumers stay bound and process messages. Workflows continue. Agents can call models within the caps of [costs.md](./costs.md).
- The coordinator signals the event router after each publish, so Events reach the event router.
- Durable Object alarms continue. The alarm guard of [ADR 0019](../adr/0019-runaway-billing-guards.md) limits each object to 2,000 alarm fires per UTC day.

## 3. Pause

1. Set `paused = true` in `infrastructure/terraform/envs/prod/main.tf`.
2. If Worker code changed, run `bun run cf:bundle`.
3. Run `bun run tf:plan:prod`.
4. Make sure that the plan sets `cron_schedules` to empty and `max_instances` to 0.
5. Run `bun run tf:apply:prod`.

## 4. Resume

1. Set `paused = false` in `infrastructure/terraform/envs/prod/main.tf`.
2. Run `bun run tf:plan:prod`.
3. Run `bun run tf:apply:prod`.
4. Run `bun run tf:drift:prod`.
