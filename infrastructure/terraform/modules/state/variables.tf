variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "environment" {
  description = "Environment name (dev or prod)."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "evidence_retention_days" {
  description = "Days before R2 objects under each prefix are deleted. Null keeps objects forever."
  type = object({
    events   = optional(number)
    evidence = optional(number)
    tmp      = optional(number, 7)
  })
}
