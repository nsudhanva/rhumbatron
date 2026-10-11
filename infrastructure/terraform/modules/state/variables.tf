variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "environment" {
  description = "Environment name (prod)."
  type        = string

  validation {
    condition     = var.environment == "prod"
    error_message = "environment must be prod."
  }
}

variable "evidence_retention_days" {
  description = "Days before R2 objects under each prefix are deleted. Null keeps objects forever."
  type = object({
    events   = optional(number)
    evidence = optional(number)
    tmp      = optional(number, 7)
    # Live app preview bundles (ADR 0020). Production bundles under apps/ never expire here.
    app-previews = optional(number)
  })
}
