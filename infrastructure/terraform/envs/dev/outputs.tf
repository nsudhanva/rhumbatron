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

output "api_worker" {
  description = "API Worker name and deployed version."
  value = {
    name       = module.api_worker.name
    version_id = module.api_worker.version_id
  }
}

output "web_worker" {
  description = "Web Worker name and deployed version."
  value = {
    name       = module.web_worker.name
    version_id = module.web_worker.version_id
  }
}

output "coordinator_worker" {
  description = "Coordinator Worker name."
  value       = module.coordinator_worker.name
}
