variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "component" {
  description = "Component name, for example api or web. The Worker is named rhumbatron-<component>-<environment>."
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
  description = "Name of the entry module inside var.modules."
  type        = string
}

variable "modules" {
  description = "Bundled modules from `bun run cf:bundle`. Build before plan."
  type = list(object({
    name         = string
    content_file = string
    content_type = optional(string, "application/javascript+module")
  }))
}

variable "bundle_sha256" {
  description = "Content hash of the bundle. A new hash creates a new Worker version."
  type        = string
}

variable "assets_directory" {
  description = "Static assets directory, or null when the Worker has no assets."
  type        = string
  default     = null
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
  description = "Durable Object migrations, or null."
  type        = any
  default     = null
}

variable "custom_domains" {
  description = "Hostnames to attach as Worker custom domains."
  type = list(object({
    hostname = string
    zone_id  = string
  }))
  default = []
}

variable "enable_workers_dev" {
  description = "Expose the workers.dev subdomain. Keep false for internal Workers."
  type        = bool
  default     = false
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

variable "extra_tags" {
  description = "Additional Worker tags. Standard tags (project, env, component, managed-by) are always set."
  type        = set(string)
  default     = []
}

variable "cron_schedules" {
  description = "Cron Trigger expressions. Keep equal to wrangler.jsonc triggers.crons. Null: no trigger resource; [] clears schedules."
  type        = list(string)
  default     = null
}
