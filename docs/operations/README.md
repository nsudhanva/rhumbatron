# Rhumbatron Operations Guide

These runbooks tell operators how to run Rhumbatron environments, infrastructure, quotas, and deployments.

## Core Policies

1. **Terraform-only remote control plane**: Terraform manages all remote Cloudflare infrastructure and Worker deployments. Do not make manual dashboard changes. Do not run `wrangler deploy` (`AGENTS.md` section 2, [ADR 0004](../adr/0004-resource-organization-and-bootstrap-credentials.md)).
2. **Quota and free-tier discipline**: Stay within Cloudflare free and included limits and within the model spend caps (`AGENTS.md` section 7 and rule 50).
3. **Executable Evidence gates**: Releases and promotions depend on machine-verifiable Evidence. Model confidence and unverified claims never pass a gate.

---

## Runbook Index

| Runbook | Purpose | Primary Commands |
|---|---|---|
| [Deployment](./deploy.md) | Terraform deployments for prod and global; bundle generation; bootstrap/apex switches; D1 migration ordering. | `bun run cf:bundle`<br>`bun run tf:plan:prod` / `tf:apply:prod`<br>`bun run tf global <args>`<br>`bun run tf:drift` / `tf:drift:prod`<br>`bun run smoke:prod` |
| [Pause & Resume](./pause-resume.md) | Global `paused` switch that stops background cron sweeps and container execution to save quota. | `bun run tf:plan:prod` / `tf:apply:prod` |
| [Cleanup & Retention](./cleanup.md) | Smoke-test Project cleanup, the Project archive pipeline, daily fork sweeps, and R2 retention lifecycles. | `bun run cleanup:projects`<br>`bun run cleanup:projects --dry-run` |
| [Costs & Budgets](./costs.md) | Cost reports, guard layers, budget ceilings (Sandbox, Browser Run, Anthropic spend), account budget alerts, call quotas, and recovery after a cap trips. | `bun run cost:report`<br>`bun run cost:report --alerts-only` |
| [Application Releases](./release.md) | Live app releases on prod and release checks. | `bun run e2e prod` |
| [Resource Naming](./naming.md) | Conventions for naming and tagging Cloudflare resources and Workers. | `bun run check:guardrails` |

---

## Related Architecture Decision Records (ADRs)

- [ADR 0004: Resource organization and bootstrap credentials](../adr/0004-resource-organization-and-bootstrap-credentials.md)
- [ADR 0005: Durable Object Worker deploys](../adr/0005-durable-object-worker-deploys.md)
- [ADR 0010: Artifacts project source](../adr/0010-artifacts-project-source.md)
- [ADR 0011: Sandbox workspaces](../adr/0011-sandbox-workspaces.md)
- [ADR 0012: Sandbox worker](../adr/0012-sandbox-worker.md)
- [ADR 0017: Prod environment](../adr/0017-prod-environment.md)
- [ADR 0019: Runaway-billing guards](../adr/0019-runaway-billing-guards.md)
- [ADR 0020: Live apps on Dynamic Workers](../adr/0020-live-apps-dynamic-workers.md)
