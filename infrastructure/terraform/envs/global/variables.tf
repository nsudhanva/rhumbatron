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

variable "alert_email" {
  description = "Comma-separated addresses for billing budget alerts. Set with TF_VAR_alert_email (Keychain via scripts/tf.ts)."
  type        = string
  sensitive   = true
}

variable "budget_alert_usd" {
  description = "Account spend levels in USD that send a billing alert. Workers Paid base is $5 per month."
  type        = list(number)
  default     = [10, 25, 100]
}
