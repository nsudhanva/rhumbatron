# AGENTS.md section 5.4: AI Gateway is the model proxy. ADR 0007: the provider is OpenRouter.
# Cloudflare free-tier settings only: no Logpush, no guardrails (billed as Workers AI), no DLP, no Unified Billing.
resource "cloudflare_ai_gateway" "this" {
  account_id = var.account_id
  id         = "rhumbatron-models-${var.environment}"

  # The OpenRouter key travels per request from the Worker secret. No stored or billed credentials.
  authentication = false
  byok_only      = true

  collect_logs            = true
  log_management          = var.max_stored_logs
  log_management_strategy = "DELETE_OLDEST"

  # Agent calls are rarely identical, so caching would only hide retries.
  cache_ttl                  = 0
  cache_invalidate_on_update = true

  # Matches the OpenRouter free-model limit of 20 requests per minute.
  rate_limiting_limit     = var.requests_per_minute
  rate_limiting_interval  = 60
  rate_limiting_technique = "sliding"

  # Hard cap on paid Gemini (Vertex AI, billed to GCP credits). OpenRouter :free models cost $0.
  # Window is in seconds (2,592,000 = 30 days); a longer unit would only make the cap stricter.
  spend_limits = {
    enabled = true
    rules = [{
      enabled    = true
      limit_type = "cost"
      limit      = var.vertex_spend_limit_usd
      window     = 2592000
      technique  = "fixed"
      ai_gateway_provider = {
        mode   = "filter"
        values = ["google-vertex-ai"]
      }
    }]
  }

  retry_max_attempts = 2
  retry_delay        = 2000
  retry_backoff      = "exponential"
}
