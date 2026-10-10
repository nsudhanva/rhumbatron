# Module: ai

Owns the AI Gateway `rhumbatron-models-<env>` (`cloudflare_ai_gateway`). The gateway proxies
Anthropic Claude (ADR 0021).

| Input | Default | Meaning |
|---|---|---|
| `account_id` | - | Cloudflare account ID. |
| `environment` | - | `dev` or `prod`. |
| `requests_per_minute` | `20` | Gateway rate limit. |
| `max_stored_logs` | `10000` | Stored logs before the oldest are deleted. |
| `spend_limit_usd` | `10` | Spend limit on `anthropic` per 30 days. Each env passes its monthly budget: dev 15, prod 10 (ADR 0021). Best effort: the code meter is the stop. |

Output: `gateway_id`.

The gateway stores no provider keys (`byok_only`, no authentication). The Anthropic key is a
Worker secret, never a gateway setting; the `anthropic-workspace-id` header passes through
unchanged. Caching is off.
