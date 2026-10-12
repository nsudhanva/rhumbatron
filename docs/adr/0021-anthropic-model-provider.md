# ADR 0021: Anthropic as the model provider

## Context

Rhumbatron uses Claude Haiku, Sonnet, and Opus as its model family. Anthropic serves each tier.
Model spend on prod has a hard limit of $100 per month. Rhumbatron uses no other model provider.

The Anthropic API key is organization-level. Each request must send the header
`anthropic-workspace-id`. The AI Gateway forwards this header unchanged. An invalid workspace ID
gets the Anthropic 400 error "anthropic-workspace-id header must be a valid workspace ID". The
Cloudflare documentation for the Anthropic endpoint does not mention custom headers.

## Decision

- Provider: Anthropic Messages API through the AI Gateway endpoint
  `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic/v1/messages`.
  The key is the `ANTHROPIC_API_KEY` `secret_text` binding. The workspace ID is the
  `ANTHROPIC_WORKSPACE_ID` `plain_text` binding (not a secret). Both come from the Keychain
  (`rhumbatron-anthropic-api-key`, `rhumbatron-anthropic-workspace-id`) through `scripts/tf.ts`.
  Anthropic is the only provider. No fallback to another provider exists.
- Tier mapping (`packages/model-router/src/models.ts`):

  | Tier | Model | Effort |
  |---|---|---|
  | haiku | `claude-haiku-5-5` | thinking off |
  | sonnet | `claude-sonnet-5-5` | adaptive, medium |
  | opus | `claude-sonnet-5-5` unless `ALLOW_OPUS` is `"true"`, then `claude-opus-5-5` | adaptive, high |

  `ALLOW_OPUS` is a `plain_text` binding from `var.allow_opus` (default `false`). An opus decision
  that runs on Sonnet becomes the Sonnet decision. The Decision Receipt records
  `requestedTier: opus`, `downgradeReason: opus_disabled`, and the reason `opus_disabled`.
  Escalation keeps its rules but stops at Sonnet while Opus is off: two failures at Sonnet
  re-plan. Conflict review does not run its Opus pass, and the Sonnet verdict applies.
- Messages API use:
  - Function tools map to Anthropic tools (`input_schema`). `tool_use` blocks map back to tool
    calls. A follow-up turn sends the full assistant turn again, with its thinking blocks.
  - `max_tokens` comes from the per-tier limits (4,000 haiku, 8,000 sonnet and opus).
  - The API never returns thinking text (`display: "omitted"`), so Rhumbatron stores no reasoning.
  - Prompt caching: `complete()` puts `cache_control` on the stable system prompt, which also
    covers the tool definitions. Pi puts it on the system prompt, the tools, and the latest
    message. Rhumbatron uses only the 5-minute TTL.
  - Rhumbatron uses no server-side refusal fallback. A refusal is an invalid output, and the cost
    stays exact.
- Cost: exact per call, from the response `usage` fields: uncached input, output (thinking
  included), cache reads, and 5-minute and 1-hour cache writes, at the prices below (USD per million
  tokens, `ANTHROPIC_PRICES` in `packages/model-router/src/models.ts`). Haiku bills each token of a
  prompt above 100K tokens at its long-prompt rate. An unknown model gets the highest known rates.
  Run cost, the Change budget, Decision Receipts, the Costs page, and the monthly meter all use
  these numbers.

  | Model | Input | Output | Cache read | Cache write 5 min | Cache write 1 h |
  |---|---:|---:|---:|---:|---:|
  | Haiku 5.5 (prompt up to 100K) | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 |
  | Haiku 5.5 (prompt above 100K) | 0.50 | 2.50 | 0.05 | 0.625 | 1.00 |
  | Sonnet 5.5 | 2 | 10 | 0.20 | 2.50 | 4 |
  | Opus 5.5 | 4 | 20 | 0.40 | 5 | 8 |

- Spend safety (ADR 0019):
  - The per-run call cap, the 400 agent calls per day, and the Change budget apply.
  - The monthly Anthropic budget is `ANTHROPIC_MONTHLY_BUDGET_USD`
    (`var.anthropic_monthly_budget_usd`): $100 in prod. Terraform rejects a value above $100.
    Code enforces the budget on the D1 meter `usage_counters` (`day` = `YYYY-MM`, counter
    `anthropic-usd-micro`, micro-USD). Each call first reserves an estimate (full output cap,
    prompt uncached) with one conditional statement. Then the call settles to the exact cost. A Pi run
    settles its share after each call and at the end. A timeout keeps its reservation.
  - A refused reservation, a gateway spend-limit 429, or an Anthropic billing error is
    `spend_limited`. The Task is `blocked`, and the Change is `budget_blocked` with the limit
    `monthly_model_spend`. Nothing retries, and no other provider runs.
  - The AI Gateway `rhumbatron-models-prod` has a spend limit on the `anthropic` provider with the
    same budget per 30 days. Cloudflare documents spend limits for BYOK and Unified Billing models
    with known pricing. A request that carries its own key can be outside that count. So the
    gateway limit is a second line of defense. The code meter is the stop. The gateway rate limit is 20
    requests per minute, and the gateway keeps at most 10,000 logs.

## Consequences

- Each model call costs money. The monthly meter is the hard stop. The gateway limit is a second
  line of defense.
- The Costs page and `bun run cost:report` show the Claude spend of the month against the $100
  budget.
- `bun run smoke:models` checks the workspace header, one tool call per tier, and a prompt cache
  hit, for much less than one cent.
- The readers of stored Decision Receipts and blocked rows also accept the provider names
  `openrouter` and `google-vertex-ai` and the limit name `vertex_spend_limit`.
