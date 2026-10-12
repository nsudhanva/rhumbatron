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
  description = "Clerk secret key. Loaded from the Keychain by `bun run tf prod`. Clerk production instance key (ADR 0017)."
  type        = string
  sensitive   = true
}

variable "clerk_publishable_key" {
  description = "Clerk publishable key (public), set as a runtime binding on the web Worker. The `clerk_production_instance` check warns when it is not a pk_live_ key (ADR 0017)."
  type        = string

  validation {
    condition     = can(regex("^pk_(live|test)_", var.clerk_publishable_key))
    error_message = "clerk_publishable_key must be a Clerk publishable key (pk_live_... or pk_test_...)."
  }
}

variable "clerk_authorized_parties" {
  description = "Origins allowed in the azp claim of Clerk session tokens on the prod API. No localhost."
  type        = list(string)
  default     = ["https://rhumbatron.com"]

  validation {
    condition     = contains(var.clerk_authorized_parties, "https://rhumbatron.com") && alltrue([for o in var.clerk_authorized_parties : startswith(o, "https://")])
    error_message = "clerk_authorized_parties must include https://rhumbatron.com and list only https origins."
  }
}

variable "clerk_dns_records" {
  description = "DNS-only CNAMEs that the Clerk production instance asks for, keyed by host label (from `clerk deploy status`)."
  type        = map(string)
  default = {
    "clerk"           = "frontend-api.clerk.services"
    "accounts"        = "accounts.clerk.services"
    "clkmail"         = "mail.pnpp7hg79vb2.clerk.services"
    "clk._domainkey"  = "dkim1.pnpp7hg79vb2.clerk.services"
    "clk2._domainkey" = "dkim2.pnpp7hg79vb2.clerk.services"
  }
}

variable "k2_consumer_token" {
  description = "K2 Consume-only token for the prod event router. Loaded from the Keychain by `bun run tf prod`."
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key (organization-level) for Claude through the AI Gateway (ADR 0021). Loaded from the Keychain (`rhumbatron-anthropic-api-key`) by `bun run tf prod`."
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
  description = "Anthropic budget in USD per calendar month for this environment, enforced in code on the D1 meter and mirrored to the gateway spend limit (ADR 0021)."
  type        = number
  default     = 100

  validation {
    condition     = var.anthropic_monthly_budget_usd >= 0 && var.anthropic_monthly_budget_usd <= 100
    error_message = "Raising the prod Anthropic budget above $100 needs a new approval (ADR 0021)."
  }
}

variable "allow_opus" {
  description = "true lets the opus tier run Claude Opus 5.5; false (default) runs it on Sonnet 5.5 and records the downgrade (ADR 0021)."
  type        = bool
  default     = false
}
