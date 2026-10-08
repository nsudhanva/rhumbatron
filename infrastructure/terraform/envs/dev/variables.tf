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
