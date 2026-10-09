variable "account_id" {
  description = "Cloudflare account ID. Set with TF_VAR_account_id."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "zone_name" {
  description = "Primary DNS zone."
  type        = string
  default     = "rhumbatron.com"
}

variable "clerk_secret_key" {
  description = "Clerk production secret key. Loaded from the Keychain by `bun run tf prod`."
  type        = string
  sensitive   = true
}

variable "clerk_publishable_key" {
  description = "Clerk production publishable key (public). Overrides the build-time development key at runtime (ADR 0017)."
  type        = string

  validation {
    condition     = startswith(var.clerk_publishable_key, "pk_live_")
    error_message = "Prod needs the Clerk production instance key (pk_live_...)."
  }
}

variable "clerk_dns_records" {
  description = "DNS-only CNAMEs that the Clerk production instance asks for, keyed by host label (for example \"clerk\" or \"clk._domainkey\"). Empty until the instance exists."
  type        = map(string)
  default     = {}
}

variable "k2_consumer_token" {
  description = "K2 Consume-only token for the prod event router. Loaded from the Keychain by `bun run tf prod`."
  type        = string
  sensitive   = true
}

variable "openrouter_api_key" {
  description = "OpenRouter key for free models (ADR 0007). Shared with dev. Loaded from the Keychain by `bun run tf prod`."
  type        = string
  sensitive   = true
}

variable "vertex_service_account" {
  description = "Base64 Vertex AI service account JSON with region (ADR 0007). Loaded from the Keychain by `bun run tf prod`."
  type        = string
  sensitive   = true
}

variable "vertex_spend_limit_usd" {
  description = "AI Gateway spend cap on Vertex AI per 30 days for the prod gateway. See ADR 0017 before raising it."
  type        = number
  default     = 9
}

variable "model_provider" {
  description = "Model provider mode for agents and the Root Planner: \"openrouter\" tries free models first, with Gemini on Vertex as overflow (ADR 0016); \"vertex\" sends every call to Gemini."
  type        = string
  default     = "openrouter"

  validation {
    condition     = contains(["vertex", "openrouter"], var.model_provider)
    error_message = "model_provider must be \"vertex\" or \"openrouter\"."
  }
}
