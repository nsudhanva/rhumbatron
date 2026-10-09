# Rhumbatron Operations Guide

Operational runbooks and procedures for managing Rhumbatron environments, infrastructure, quotas, and deployments.

## Core Policies

1. **Terraform-Only Remote Control Plane**: Remote Cloudflare infrastructure and Worker deployments are strictly managed by Terraform. No manual dashboard changes and no `wrangler deploy` (`AGENTS.md` section 2, [ADR 0004](../adr/0004-resource-organization-and-bootstrap-credentials.md)).
2. **Quota and Free-Tier Discipline**: Operate within Cloudflare free/included limits and capped model spend (`AGENTS.md` section 7 and rule 50).
3. **Executable Evidence Gates**: Releases and promotions depend on machine-verifiable evidence, never model confidence or unverified claims.

---

## Runbook Index

| Runbook | Purpose | Primary Commands |
|---|---|---|
| [Deployment](./deploy.md) | Terraform deployments for dev, prod, and global; bundle generation; bootstrap/apex switches; D1 migration ordering. | `bun run cf:bundle`<br>`bun run tf:plan:dev` / `apply:dev`<br>`bun run tf:plan:prod` / `apply:prod`<br>`bun run tf:drift` |
| [Pause & Resume](./pause-resume.md) | Global `paused` switch to halt background cron sweeps and container execution to preserve quota. | `bun run tf:plan:dev` / `apply:dev` |
| [Cleanup & Retention](./cleanup.md) | Purging smoke test projects, project archiving pipeline, daily fork sweeps, and R2 retention lifecycles. | `bun run cleanup:projects`<br>`bun run cleanup:projects --dry-run` |
| [Costs & Budgets](./costs.md) | Cost reporting, budget ceilings (Sandbox, Browser Run, Vertex AI), call quotas, and cap trip remediation. | `bun run cost:report`<br>`bun run cost:report --alerts-only` |
| [Application Releases](./release.md) | Cloudflare Workers Builds releases, smoke verification, one-time dashboard/CLI setup, and failure injection. | `bun run smoke:release`<br>`bun run inject --only=release-smoke-failure` |
| [Resource Naming](./naming.md) | Conventions for naming and tagging Cloudflare resources and Workers. | `bun run check:guardrails` |

---

## Related Architecture Decision Records (ADRs)

- [ADR 0004: Resource organization and bootstrap credentials](../adr/0004-resource-organization-and-bootstrap-credentials.md)
- [ADR 0005: Durable Object Worker deploys](../adr/0005-durable-object-worker-deploys.md)
- [ADR 0007: OpenRouter free models](../adr/0007-openrouter-free-models.md)
- [ADR 0010: Artifacts project source](../adr/0010-artifacts-project-source.md)
- [ADR 0011: Sandbox workspaces](../adr/0011-sandbox-workspaces.md)
- [ADR 0012: Sandbox worker](../adr/0012-sandbox-worker.md)
- [ADR 0014: Workers Builds connection to Artifacts](../adr/0014-workers-builds-artifacts-connection.md)
- [ADR 0016: Gemini overflow](../adr/0016-gemini-overflow.md)
- [ADR 0017: Prod environment](../adr/0017-prod-environment.md)
- [ADR 0018: Release via Workers Builds](../adr/0018-release-via-workers-builds.md)
