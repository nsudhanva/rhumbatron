output "environment" {
  description = "Environment name."
  value       = local.environment
}

output "hostnames" {
  description = "Planned public hostnames."
  value       = local.hostnames
}

output "zone_id" {
  description = "Zone ID used for custom domains."
  value       = module.dns.zone_id
}

output "bindings" {
  description = "Storage bindings for Worker modules."
  value       = module.state.bindings
}

output "queues" {
  description = "Queue names and IDs."
  value       = module.async.queues
}
