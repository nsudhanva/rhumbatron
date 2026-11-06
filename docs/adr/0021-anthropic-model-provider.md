# ADR 0021: Anthropic as the model provider

## Context

Rhumbatron uses Claude Haiku, Sonnet, and Opus as its model family. Anthropic serves each tier.
Model calls are the only cost of the stack. Model spend has a hard monthly limit, $100 by
default. Rhumbatron uses no other model provider.

The Anthropic API key is organization-level. Each request must send the header
`anthropic-workspace-id`. An invalid workspace ID gets the Anthropic 400 error
"anthropic-workspace-id header must be a valid workspace ID".

## Decision

- Provider: the Anthropic Messages API, called directly at `<base URL>/v1/messages`
  (`packages/model-router/src/gateway-client.ts`). `ANTHROPIC_BASE_URL` sets the base URL; the
  default is `https://api.anthropic.com`. The key is the `ANTHROPIC_API_KEY` setting of the core
  service. The workspace ID is `ANTHROPIC_WORKSPACE_ID` (not a secret). `bun run stack:env`
  (`scripts/local-env.ts`) writes both to `.env` from the environment or from the macOS Keychain
  items `rhumbatron-anthropic-api-key` and `rhumbatron-anthropic-workspace-id`. Anthropic is the
  only provider. No fallback to another provider exists.
- Tier mapping (`packages/model-router/src/models.ts`):

  | Tier | Model | Effort |
  |---|---|---|
  | haiku | `claude-haiku-5-5` | thinking off |
  | sonnet | `claude-sonnet-5-5` | adaptive, medium |
  | opus | `claude-sonnet-5-5` unless `ALLOW_OPUS` is `"true"`, then `claude-opus-5-5` | adaptive, high |

  `ALLOW_OPUS` is a core setting from `.env` (default `false`). An opus decision
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

- Spend safety:
  - The per-run call cap, the 1,000 agent calls per day (`AGENT_DAILY_CALL_CAP`), and the Change
    budget apply.
  - The monthly Anthropic budget is the core setting `ANTHROPIC_MONTHLY_BUDGET_USD`: $100 by
    default (`compose.yaml`). Without the setting, the code uses $10. Code enforces the budget on
    the meter `usage_counters` in the product database (`day` = `YYYY-MM`, counter
    `anthropic-usd-micro`, micro-USD). Each call first reserves an estimate (full output cap,
    prompt uncached) with one conditional statement. Then the call settles to the exact cost. A Pi run
    settles its share after each call and at the end. A timeout keeps its reservation.
  - A refused reservation, a 429 or 402 that is not a rate limit, or an Anthropic billing error
    is `spend_limited`. The Task is `blocked`, and the Change is `budget_blocked` with the limit
    `monthly_model_spend`. Nothing retries, and no other provider runs.
  - Clef and Clef-flash questions go to Claude Haiku through a forced tool call
    (`packages/platform/src/ai/models.ts`). The daily `clef-flash` counter caps them.

## Consequences

- Each model call costs money. The monthly meter is the hard stop. A spend limit in the
  Anthropic Console is a second line of defense.
- The Costs page shows the Claude spend of the month against the monthly budget.
- The readers of stored Decision Receipts and blocked rows also accept the provider names
  `openrouter` and `google-vertex-ai` and the limit name `vertex_spend_limit`.
