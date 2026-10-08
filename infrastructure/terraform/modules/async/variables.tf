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

variable "message_retention_seconds" {
  description = "Seconds an unconsumed message is kept. Workers Free allows up to 86400."
  type        = number
  default     = 86400
}
