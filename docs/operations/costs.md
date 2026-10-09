# Costs, Quotas, and Budget Caps Runbook

Operations guide for cost reporting, infrastructure quotas, AI Gateway budgets, and limit enforcement.

## Principles

Rhumbatron treats cost as a core architecture constraint (`AGENTS.md` section 7 and rule 50). Systems must run within Cloudflare free/included limits and capped external LLM budgets.

---

## 1. Cost Reporting (`cost:report`)

Check current usage and remaining quotas with `scripts/cost-report.ts`:

```sh
bun run cost:report
```

- **Authentication**: Uses read-only `CLOUDFLARE_MONITOR_TOKEN` and `CLOUDFLARE_D1_TOKEN` loaded from Keychain. Never writes or mutates resources.
- **Status Thresholds**:
  - `OK`: < 60% of allowance used.
  - `WARN`: 60% – 84% of allowance used.
  - `ALERT`: >= 85% of allowance used. (Exits with code 1 so scripts can alert).
- **Alerts Only**:
  ```sh
  bun run cost:report --alerts-only
  ```

---

## 2. Infrastructure and Service Caps

### Sandbox Container Usage (`SANDBOX_MONTHLY_SECONDS`)

- **Total Allowance**: 10 container hours/month total (HOM-192, 36,000 seconds).
- **Split across Environments** ([ADR 0017](../adr/0017-prod-environment.md)):
  - Dev: `SANDBOX_MONTHLY_SECONDS = 18000` (5 hours)
  - Prod: `SANDBOX_MONTHLY_SECONDS = 18000` (5 hours)
- **Idle Timeout**: Containers sleep automatically after 2 minutes idle.
- **Instance Count**: `max_instances = 1` per environment.

### Browser Run (`BROWSER_DAILY_SECONDS`)

- **Total Free Allowance**: 10 minutes/day (600 seconds/day). Guarded at 500 seconds/day total.
- **Split across Environments** ([ADR 0017](../adr/0017-prod-environment.md)):
  - Dev: `BROWSER_DAILY_SECONDS = 250` (250 seconds/day)
  - Prod: `BROWSER_DAILY_SECONDS = 250` (250 seconds/day)
- **Per-Session Limits**: 55 seconds maximum per check; at most 2 browser checks per Candidate.

### Vertex AI Spend (`VERTEX_SPEND_LIMIT_USD`)

- **Ceiling**: Enforced at the Cloudflare AI Gateway on the `google-vertex-ai` provider ([ADR 0016](../adr/0016-gemini-overflow.md), [ADR 0017](../adr/0017-prod-environment.md)).
  - Dev gateway (`rhumbatron-models-dev`): **40 USD** per 30 days.
  - Prod gateway (`rhumbatron-models-prod`): **10 USD** per 30 days.
  - Total account Vertex spend cap: ~50 USD per 30 days across the shared GCP project.
- **Worker Binding**: Mirrored via the `VERTEX_SPEND_LIMIT_USD` plain text binding on agents and API Workers for budget-stop text and dashboard reporting.

### Model Call Quotas and Routing (`MODEL_PROVIDER`)

Declared in `packages/model-router/src/budget.ts` and `provider.ts`:

- **Daily Agent Call Cap**: **400 calls/day** across all providers (`AGENT_DAILY_CALL_CAP = 400`).
- **OpenRouter Daily Cap**: **45 calls/day** (`OPENROUTER_DAILY_CALL_CAP = 45`), staying safely under OpenRouter's 50 free daily calls limit ([ADR 0007](../adr/0007-openrouter-free-models.md)).
- **Workers AI Clef-flash**: **200 calls/day** (under the 10,000 daily Neurons allowance).
- **`MODEL_PROVIDER` Switch**:
  - `dev` defaults to `vertex`.
  - `prod` defaults to `openrouter`.
  - Setting `MODEL_PROVIDER=vertex` (or `preferVertex: true`) routes directly to Gemini on Vertex AI.
  - When `openrouter` is active, free models are queried until 45 calls or an upstream rate limit is hit, after which runs overflow to Gemini via Vertex AI ([ADR 0016](../adr/0016-gemini-overflow.md)).

---

## 3. What to Do When a Cap Trips

| Tripped Cap | Observed Behavior | Operator Action |
|---|---|---|
| **OpenRouter 45 calls/day** | OpenRouter returns quota / rate limit. | No action needed. System automatically overflows to Gemini on Vertex AI ([ADR 0016](../adr/0016-gemini-overflow.md)). Resets at 00:00 UTC. |
| **Vertex Spend Cap ($40 dev / $10 prod)** | Gateway returns 429/402. Router halts further model calls (`vertex_spend_limit`). | 1. Check GCP Billing and AI Gateway logs.<br>2. If increased budget is approved by the project owner, update `vertex_spend_limit_usd` in `envs/<env>/main.tf`, plan, and apply. |
| **Agent Daily Calls (400 calls/day)** | Agent runs pause and reject further model invocations. | Check for looping agent tasks or anomalous prompt churn. Normal resets occur at 00:00 UTC. |
| **Sandbox Monthly Seconds (18,000 s)** | Sandbox container allocation is refused. Tasks requiring container execution fail. | Check for unclosed containers or long-running tests. Monthly allowance resets on Cloudflare billing cycle. To preserve budget, set `paused = true`. |
| **Browser Run Daily Seconds (250 s)** | Browser Run sessions fail or are rejected. | Candidate browser checks fail or fall back to non-browser checks. Daily quota resets at 00:00 UTC. |
