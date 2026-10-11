variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "component" {
  description = "Component name. The Worker is named rhumbatron-<component>-<environment>."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*[a-z0-9]$", var.component))
    error_message = "component must be lowercase kebab-case."
  }
}

variable "environment" {
  description = "Environment name (prod)."
  type        = string

  validation {
    condition     = var.environment == "prod"
    error_message = "environment must be prod."
  }
}

variable "main_module" {
  description = "Name of the entry module."
  type        = string
}

variable "modules" {
  description = "Bundled modules from `bun run cf:bundle`. Must include main_module."
  type = list(object({
    name         = string
    content_file = string
    content_type = optional(string, "application/javascript+module")
  }))
}

variable "compatibility_date" {
  description = "Workers compatibility date. Keep equal to wrangler.jsonc."
  type        = string
}

variable "compatibility_flags" {
  description = "Workers compatibility flags. Keep equal to wrangler.jsonc."
  type        = set(string)
  default     = []
}

variable "bindings" {
  description = "Worker bindings. Names must match wrangler.jsonc."
  type        = any
  default     = []
}

variable "migrations" {
  description = "Durable Object migrations. Keep equal to wrangler.jsonc; never edit an applied tag."
  type        = any
}

variable "logs_head_sampling_rate" {
  description = "Fraction of successful invocations to log (0 to 1)."
  type        = number
  default     = 1

  validation {
    condition     = var.logs_head_sampling_rate >= 0 && var.logs_head_sampling_rate <= 1
    error_message = "logs_head_sampling_rate must be between 0 and 1."
  }
}
