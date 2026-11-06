# Operations

These runbooks tell an operator how to start, stop, release, and clean up Rhumbatron. They also tell the operator how to monitor its cost. Rhumbatron runs as one Docker Compose stack behind Caddy at `https://rhumbatron.localhost` ([ADR 0034](../adr/0034-docker-compose-stack.md)).

## Rules

1. `compose.yaml` and the files under `services/` define the stack. Change the stack only in these files.
2. Keep secrets in `.env`, `apps/web/.env.local`, or the Keychain. Git never tracks them (`bun run check:guardrails`).
3. Only the Anthropic API costs money. Keep its spend under `ANTHROPIC_MONTHLY_BUDGET_USD`.
4. Only executable Evidence passes a release or promotion gate. Model confidence never passes a gate.

## Runbooks

| Runbook | Content | Commands |
|---|---|---|
| [Local stack](./local-stack.md) | Prerequisites, start, the local CA, hostnames, logs, settings, data volumes, restarts, checks, and a Linux server. | `bun run stack:up`<br>`bun run stack:trust`<br>`bun run stack:logs`<br>`bun run stack:down`<br>`bun run smoke local`<br>`bun run test:ui` |
| [Cleanup and retention](./cleanup.md) | Smoke Project cleanup, Project deletion, the daily fork sweep, and retention. | `bun run cleanup:projects`<br>`bun run cleanup:projects --dry-run` |
| [Costs and budgets](./costs.md) | What costs money, the caps (Anthropic, Sandbox, browser checks), call quotas, and what to do when a cap trips. | `/admin` in the web app |
| [Application releases](./release.md) | Live app releases, hosts, rollback, stuck releases, and release checks. | `bun run e2e local` |
| [Resource naming](./naming.md) | Names of services, volumes, networks, streams, and repositories. | `bun run check:guardrails` |

## Related decisions

- [ADR 0010: The git service as Project source](../adr/0010-artifacts-project-source.md)
- [ADR 0011: Sandbox workspaces with a prebuilt image](../adr/0011-sandbox-workspaces.md)
- [ADR 0020: Live apps on workerd with the Worker Loader](../adr/0020-live-apps-dynamic-workers.md)
- [ADR 0021: Anthropic as the model provider](../adr/0021-anthropic-model-provider.md)
- [ADR 0034: One Docker Compose stack on open-source backends](../adr/0034-docker-compose-stack.md)
