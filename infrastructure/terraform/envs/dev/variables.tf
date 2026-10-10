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

variable "anthropic_api_key" {
  description = "Anthropic API key (organization-level) for Claude through the AI Gateway (ADR 0021). Loaded from the Keychain (`rhumbatron-anthropic-api-key`) by `bun run tf dev`."
  type        = string
  sensitive   = true
}

variable "anthropic_workspace_id" {
  description = "Anthropic workspace ID, sent as `anthropic-workspace-id` on every request because the key is organization-level (ADR 0021). Not a secret. Loaded from the Keychain (`rhumbatron-anthropic-workspace-id`)."
  type        = string

  validation {
    condition     = can(regex("^wrkspc_[A-Za-z0-9]+$", var.anthropic_workspace_id))
    error_message = "anthropic_workspace_id must look like wrkspc_..."
  }
}

variable "anthropic_monthly_budget_usd" {
  description = "Anthropic budget in USD per calendar month for this environment, enforced in code on the D1 meter and mirrored to the gateway spend limit. Dev $15 + prod $10 = the approved $25 total (ADR 0021)."
  type        = number
  default     = 15

  validation {
    condition     = var.anthropic_monthly_budget_usd >= 0 && var.anthropic_monthly_budget_usd <= 15
    error_message = "Raising the dev Anthropic budget above $15 needs a new approval (ADR 0021)."
  }
}

variable "model_provider" {
  description = "Model provider for agents and the Root Planner. Only \"anthropic\" exists (ADR 0021); OpenRouter and Gemini on Vertex AI are removed."
  type        = string
  default     = "anthropic"

  validation {
    condition     = var.model_provider == "anthropic"
    error_message = "model_provider must be \"anthropic\"."
  }
}

variable "allow_opus" {
  description = "true lets the opus tier run Claude Opus 5.5; false (default) runs it on Sonnet 5.5 and records the downgrade (ADR 0021)."
  type        = bool
  default     = false
}

variable "builds_api_token" {
  description = "User-scoped token for the release path (ADR 0018): Workers Builds Configuration Edit and Workers Scripts Read. Bound as BUILDS_API_TOKEN on the integration Worker only. Loaded from the Keychain (`rhumbatron-cloudflare-builds-token`) by `bun run tf dev`."
  type        = string
  sensitive   = true
}
