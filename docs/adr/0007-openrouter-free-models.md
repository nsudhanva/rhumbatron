# ADR 0007: OpenRouter free models through AI Gateway

- Status: Accepted
- Date: 2026-10-08
- Decider: Project owner

## Context

AGENTS.md section 5.4 freezes Claude 5.5 through AI Gateway. The project has no Anthropic API
key, and Claude subscriptions do not cover hosted product use. The owner chose OpenRouter with
its free models and kept the original architecture: AgentDO, Pi behind `AgentRuntime`, and
AI Gateway as the model proxy.

## Decision

- Model provider: OpenRouter, called through the AI Gateway `rhumbatron-models-<env>`
  (Terraform `modules/ai`). The gateway uses the OpenRouter provider endpoint.
- Only `:free` model variants. Model spend is $0; OpenRouter reports `cost: 0`.
- The tier names stay `haiku`, `sonnet`, and `opus`, so the routing rules in section 23 do not
  change. `packages/model-router/src/models.ts` maps each tier to an ordered fallback list that
  OpenRouter applies on rate limits or outages:

  | Tier | Primary | Fallbacks |
  |---|---|---|
  | haiku | `poolside/laguna-xs-2.1:free` | `nvidia/nemotron-3.5-lightning:free`, `cohere/north-mini-code:free` |
  | sonnet | `poolside/laguna-s-2.1:free` (Terminal-Bench 2.1: 70.2%) | `cohere/north-mini-code:free`, `nvidia/nemotron-3-super-120b-a12b:free` |
  | opus | `nvidia/nemotron-3-ultra-550b-a55b:free` | `poolside/laguna-s-2.1:free` |

- All tiers passed a live tool-calling check on 2026-10-08 (`bun run smoke:models`).
- The OpenRouter key is in the Keychain (`rhumbatron-openrouter-api-key`) and reaches Workers
  as a `secret_text` binding only. The gateway stores no provider key (`byok_only = true`), so
  Unified Billing cannot charge the account.

## Gateway settings (free tier)

- Rate limit 20 requests per minute, sliding, which matches the OpenRouter free-model limit.
- Logs kept, capped at 10,000 with oldest deleted. No Logpush, guardrails, or DLP (billable).
- Cache off. Two exponential retries for transient upstream errors.
- Authentication off: a caller still needs an OpenRouter key, and the rate limit caps log volume.

## Limits and risks

- OpenRouter free limits: 20 requests per minute; 50 requests per day for accounts with under
  $10 of lifetime credit purchases, 1,000 per day after that. Free-model calls do not spend
  credits. At 50 per day a full demo Change will not fit, so the project needs either the
  one-time $10 purchase or tight call budgets.
- Free capacity is a shared upstream pool. Expect 429s; the fallback lists and the retry policy
  in section 42.8 absorb them.
- Free providers can log or train on prompts. Send only demo fixture code. Do not send customer
  source or secrets through free models.
- The free roster changes. Re-check https://openrouter.ai/collections/free-models before
  changing a tier, and rerun `bun run smoke:models`.

## Consequences

- Section 5.4 model names now mean tiers, not vendors. Decision Receipts record the model that
  actually answered.
- Switching back to Claude needs only a new tier map and a key, because the gateway and the
  router stay the same.
