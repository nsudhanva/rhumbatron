# AI Gateway is the model proxy. ADR 0021: the provider is Anthropic.
# Cloudflare free-tier settings only: no Logpush, no guardrails (billed as Workers AI), no DLP, no Unified Billing.
resource "cloudflare_ai_gateway" "this" {
  account_id = var.account_id
  id         = "rhumbatron-models-${var.environment}"

  # The Anthropic key travels per request from the Worker secret, with the anthropic-workspace-id
  # header, which the gateway forwards unchanged. No stored or billed credentials.
  authentication = false
  byok_only      = true

  collect_logs            = true
  log_management          = var.max_stored_logs
  log_management_strategy = "DELETE_OLDEST"

  # Agent calls are rarely identical, so caching would only hide retries.
  cache_ttl                  = 0
  cache_invalidate_on_update = true

  # 20 requests per minute bounds a runaway loop well below the monthly budget's pace.
  rate_limiting_limit     = var.requests_per_minute
  rate_limiting_interval  = 60
  rate_limiting_technique = "sliding"

  # Second line behind the code budget (ADR 0021): the gateway's own cost estimate for Anthropic,
  # per 30 days (2,592,000 s). Cloudflare documents spend limits for BYOK and Unified Billing models
  # with known pricing; requests that carry their own key may not count, so the D1 meter in code
  # is the stop that is relied on. A rejection here is a 429 that code treats as a spend stop.
  spend_limits = {
    enabled = true
    rules = [{
      enabled    = true
      limit_type = "cost"
      limit      = var.spend_limit_usd
      window     = 2592000
      technique  = "fixed"
      ai_gateway_provider = {
        mode   = "filter"
        values = ["anthropic"]
      }
    }]
  }

  retry_max_attempts = 2
  retry_delay        = 2000
  retry_backoff      = "exponential"
}
