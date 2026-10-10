# Module: ai

Owns the AI Gateway `rhumbatron-models-<env>` (`cloudflare_ai_gateway`). The gateway proxies
OpenRouter free models (ADR 0007) and Gemini on Vertex AI (ADR 0016).

| Input | Default | Meaning |
|---|---|---|
| `account_id` | - | Cloudflare account ID. |
| `environment` | - | `dev` or `prod`. |
| `requests_per_minute` | `20` | Gateway rate limit (OpenRouter free-model limit). |
| `max_stored_logs` | `10000` | Stored logs before the oldest are deleted. |
| `vertex_spend_limit_usd` | `9` | Spend cap on `google-vertex-ai` per 30 days. Dev sets 40, prod sets 10 (ADR 0017). |

Output: `gateway_id`.

The gateway stores no provider keys (`byok_only`, no authentication). The OpenRouter key and the
Vertex service account are Worker secrets, never gateway settings. Caching is off.
