# prod environment root.
# Resources are added phase by phase (see AGENTS.md section 47).
# Keep this root empty until the phase that needs a resource is active.
# Add `variable "account_id"` (read from TF_VAR_account_id) with the first resource.

locals {
  environment = "prod"
  # Every resource name uses this suffix, for example rhumbatron-api-prod.
  name_suffix = "-prod"
}
