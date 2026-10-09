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
  description = "Gateway rate limit. OpenRouter free models allow 20 requests per minute."
  type        = number
  default     = 20
}

variable "max_stored_logs" {
  description = "Stored gateway logs before the oldest are deleted. Keeps log volume far below free limits."
  type        = number
  default     = 10000
}
