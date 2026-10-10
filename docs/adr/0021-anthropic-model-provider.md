# ADR 0021: Anthropic as the model provider

- Status: Accepted
- Date: 2026-10-09
- Decider: Project owner
- Supersedes: ADR 0007 (OpenRouter free models, Gemini backup) and ADR 0016 (Gemini overflow)

## Context

AGENTS.md sections 5.4 and 22 to 24 name Claude Haiku, Sonnet, and Opus as the model family.
The code used OpenRouter free models with Gemini on Vertex AI as paid overflow (ADR 0007, ADR 0016).
The owner approved Anthropic for every tier on dev and prod, with a hard total of $25 per month of
model spend. No GCP spend is allowed.

The Anthropic API key is organization-level. Every request must send the header
`anthropic-workspace-id`. A live check on 2026-10-09 through the dev gateway showed that the AI
Gateway forwards this header unchanged: a bogus workspace ID got Anthropic's own 400 error
("anthropic-workspace-id header must be a valid workspace ID"). The Cloudflare documentation for the
Anthropic endpoint does not mention custom headers.

## Decision

- Provider: Anthropic Messages API through the AI Gateway endpoint
  `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic/v1/messages`.
  The key is the `ANTHROPIC_API_KEY` `secret_text` binding. The workspace ID is the
  `ANTHROPIC_WORKSPACE_ID` `plain_text` binding (not a secret). Both come from the Keychain
  (`rhumbatron-anthropic-api-key`, `rhumbatron-anthropic-workspace-id`) through `scripts/tf.ts`.
  `MODEL_PROVIDER` is `anthropic` on both environments.
- OpenRouter and Gemini on Vertex AI are removed from code and Terraform, not kept behind a flag.
  Their bindings (`OPENROUTER_API_KEY`, `VERTEX_SERVICE_ACCOUNT`, `VERTEX_SPEND_LIMIT_USD`) go away.
  There is no fallback to another paid provider.
- Tier mapping (`packages/model-router/src/models.ts`):

  | Tier | Model | Effort |
  |---|---|---|
  | haiku | `claude-haiku-5-5` | thinking off |
  | sonnet | `claude-sonnet-5-5` | adaptive, medium |
  | opus | `claude-sonnet-5-5` unless `ALLOW_OPUS` is `"true"`, then `claude-opus-5-5` | adaptive, high |

  `ALLOW_OPUS` is a `plain_text` binding from `var.allow_opus` (default `false`). An opus decision
  that runs on Sonnet becomes the Sonnet decision; the Decision Receipt records `requestedTier: opus`,
  `downgradeReason: opus_disabled`, and the reason `opus_disabled`. Escalation keeps its rules but
  stops at Sonnet while Opus is off: two failures at Sonnet re-plan. Conflict review does not run
  its Opus pass, and the Sonnet verdict applies.
- Messages API use:
  - Function tools map to Anthropic tools (`input_schema`); `tool_use` blocks map back to tool calls.
    A follow-up turn replays the whole assistant turn, thinking blocks included.
  - `max_tokens` comes from the per-tier limits (4,000 haiku, 8,000 sonnet and opus).
  - Thinking text is never returned (`display: "omitted"`), so no reasoning is stored (rule 32).
  - Prompt caching: `cache_control` on the stable system prompt (which covers the tool definitions)
    in `complete()`; Pi adds it on the system prompt, tools, and latest message. 5-minute TTL only.
  - No server-side refusal fallbacks: a refusal is an invalid output, and cost stays exact.
- Cost: exact per call from the response `usage` fields: uncached input, output (thinking
  included), cache reads, and 5-minute and 1-hour cache writes, at the prices below (USD per million
  tokens). Haiku bills every token of a prompt above 100K tokens at its long-prompt rate. An unknown
  model is priced at the highest known rates. Run cost, the Change budget, Decision Receipts, the
  Costs page, and the monthly meter all use these numbers.

  | Model | Input | Output | Cache read | Cache write 5 min | Cache write 1 h |
  |---|---:|---:|---:|---:|---:|
  | Haiku 5.5 (prompt up to 100K) | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 |
  | Haiku 5.5 (prompt above 100K) | 0.50 | 2.50 | 0.05 | 0.625 | 1.00 |
  | Sonnet 5.5 | 2 | 10 | 0.20 | 2.50 | 4 |
  | Opus 5.5 | 4 | 20 | 0.20 | 5 | 8 |

- Spend safety (rule 50, ADR 0019):
  - The per-run call cap, the 400 agent calls per day, and the Change budget stay.
  - New: a monthly Anthropic budget per environment, `ANTHROPIC_MONTHLY_BUDGET_USD`
    (`var.anthropic_monthly_budget_usd`): dev $15, prod $10, so $25 in total. Terraform rejects a
    higher value. Code enforces it on the D1 meter `usage_counters` (`day` = `YYYY-MM`, counter
    `anthropic-usd-micro`, micro-USD). Every call first reserves an estimate (full output cap,
    prompt uncached) with one conditional statement, then settles to the exact cost. A Pi run
    settles its share after each call and at the end. A timeout keeps its reservation.
  - A refused reservation, a gateway spend-limit 429, or an Anthropic billing error is
    `spend_limited`: the Task is `blocked` and the Change `budget_blocked` with limit
    `monthly_model_spend`. Nothing retries, and no other provider is tried.
  - The AI Gateway spend limit moves from `google-vertex-ai` to `anthropic` with the same budget
    per 30 days. Cloudflare documents spend limits for BYOK and Unified Billing models with known
    pricing; a request that carries its own key may not count. It is a second line, not the stop
    that is relied on. The gateway rate limit stays 20 requests per minute.

## Consequences

- Model work costs money on every call. The monthly meter, not the gateway, is the hard stop.
- The Costs page shows Claude spend this month against the budget instead of the OpenRouter meter.
  `bun run cost:report` shows both environments against $15, $10, and the $25 total.
- `bun run smoke:models [dev|prod]` checks the workspace header, one tool call per tier, and a
  prompt cache hit, for well under one cent.
- Old Decision Receipts and blocked rows keep `openrouter`, `google-vertex-ai`, and
  `vertex_spend_limit`; readers accept them.
- The Keychain items `rhumbatron-openrouter-api-key` and `rhumbatron-vertex-sa-dev` are no longer
  read. Deleting them, and the Vertex service account in GCP, is a separate owner action.
