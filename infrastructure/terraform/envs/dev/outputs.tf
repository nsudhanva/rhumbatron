output "environment" {
  description = "Environment name for this root."
  value       = local.environment
}

output "name_suffix" {
  description = "Suffix applied to every resource name in this environment."
  value       = local.name_suffix
}
