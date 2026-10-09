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
  description = "Clerk development secret key. Loaded from the Keychain by `bun run tf dev`."
  type        = string
  sensitive   = true
}

variable "k2_consumer_token" {
  description = "K2 Consume-only token for the event router. Loaded from the Keychain by `bun run tf dev`."
  type        = string
  sensitive   = true
}

variable "openrouter_api_key" {
  description = "OpenRouter key for free models (ADR 0007). Loaded from the Keychain by `bun run tf dev`."
  type        = string
  sensitive   = true
}

variable "vertex_service_account" {
  description = "Base64 Vertex AI service account JSON with region (ADR 0007). Loaded from the Keychain."
  type        = string
  sensitive   = true
}

variable "model_provider" {
  description = "Model provider mode for agents and the Root Planner: \"vertex\" sends every call to Gemini (ADR 0016); \"openrouter\" tries free models first."
  type        = string
  default     = "vertex"

  validation {
    condition     = contains(["vertex", "openrouter"], var.model_provider)
    error_message = "model_provider must be \"vertex\" or \"openrouter\"."
  }
}
