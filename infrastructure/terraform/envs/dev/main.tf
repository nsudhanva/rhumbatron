# dev environment root.
# Resources are added phase by phase (see AGENTS.md section 47).
# Keep this root empty until the phase that needs a resource is active.
# Add `variable "account_id"` (read from TF_VAR_account_id) with the first resource.

locals {
  environment = "dev"
  # Every resource name uses this suffix, for example rhumbatron-api-dev.
  name_suffix = "-dev"
}
