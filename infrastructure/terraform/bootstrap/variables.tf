variable "account_id" {
  description = "Cloudflare account ID. Set with TF_VAR_account_id."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "state_bucket_name" {
  description = "R2 bucket that stores Terraform state for every environment."
  type        = string
  default     = "rhumbatron-terraform-state-global"
}
