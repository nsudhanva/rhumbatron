# Operations

These runbooks tell an operator how to deploy, release, pause, clean up, and watch the cost of Rhumbatron on prod. Prod is the only remote environment ([ADR 0024](../adr/0024-single-prod-environment.md)).

## Rules

1. Terraform changes the remote control plane. Do not edit in the Cloudflare dashboard. Do not run `wrangler deploy` (`AGENTS.md` section 2, [ADR 0004](../adr/0004-resource-organization-and-bootstrap-credentials.md)).
2. Stay within the Cloudflare free and included limits and the model spend cap (`AGENTS.md` section 7 and rule 50).
3. Only executable Evidence passes a release or promotion gate. Model confidence never passes a gate.

## Runbooks

| Runbook | Content | Commands |
|---|---|---|
| [Deployment](./deploy.md) | Worker bundles, Terraform plan and apply for `prod` and `global`, configuration switches, D1 migration order. | `bun run cf:bundle`<br>`bun run tf:plan:prod`, `bun run tf:apply:prod`<br>`bun run tf global <args>`<br>`bun run tf:drift`, `bun run tf:drift:prod`<br>`bun run smoke:prod` |
| [Pause and resume](./pause-resume.md) | The `paused` switch: no cron sweep and no Sandbox start. | `bun run tf:plan:prod`, `bun run tf:apply:prod` |
| [Cleanup and retention](./cleanup.md) | Smoke Project cleanup, Project deletion, the daily fork sweep, and R2 retention. | `bun run cleanup:projects`<br>`bun run cleanup:projects --dry-run` |
| [Costs and budgets](./costs.md) | Cost report, guard layers, caps (Sandbox, Browser Run, Anthropic), call quotas, and what to do when a cap trips. | `bun run cost:report`<br>`bun run cost:report --alerts-only` |
| [Application releases](./release.md) | Live app releases, hosts, rollback, stuck releases, and release checks. | `bun run e2e prod` |
| [Resource naming](./naming.md) | Names and tags of Cloudflare resources. | `bun run check:guardrails` |

## Related decisions

- [ADR 0004: Resource organization and bootstrap credentials](../adr/0004-resource-organization-and-bootstrap-credentials.md)
- [ADR 0005: Deploy Durable Object Workers with cloudflare_workers_script](../adr/0005-durable-object-worker-deploys.md)
- [ADR 0010: Artifacts as Project source](../adr/0010-artifacts-project-source.md)
- [ADR 0011: Sandbox workspaces with a prebuilt image](../adr/0011-sandbox-workspaces.md)
- [ADR 0012: Host the Sandbox class in its own Worker](../adr/0012-sandbox-worker.md)
- [ADR 0017: Prod environment](../adr/0017-prod-environment.md)
- [ADR 0019: Runaway-billing guards](../adr/0019-runaway-billing-guards.md)
- [ADR 0020: Live apps on Dynamic Workers](../adr/0020-live-apps-dynamic-workers.md)
- [ADR 0021: Anthropic as the model provider](../adr/0021-anthropic-model-provider.md)
- [ADR 0024: Prod is the only remote environment](../adr/0024-single-prod-environment.md)
