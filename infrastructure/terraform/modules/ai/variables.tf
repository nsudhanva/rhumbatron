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

variable "requests_per_minute" {
  description = "Gateway rate limit in requests per minute."
  type        = number
  default     = 20
}

variable "max_stored_logs" {
  description = "Stored gateway logs before the oldest are deleted. Keeps log volume far below free limits."
  type        = number
  default     = 10000
}

variable "spend_limit_usd" {
  description = "Gateway spend limit on Anthropic per 30 days. Each environment passes its monthly budget (ADR 0021: dev 15, prod 10)."
  type        = number
  default     = 10
}
