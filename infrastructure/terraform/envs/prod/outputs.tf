output "environment" {
  description = "Environment name."
  value       = local.environment
}

output "hostnames" {
  description = "Public hostnames."
  value       = local.hostnames
}

output "switches" {
  description = "Environment switches (ADR 0017)."
  value = {
    paused      = local.paused
    bootstrap   = local.bootstrap
    attach_apex = local.attach_apex
  }
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

output "ai_gateway_id" {
  description = "AI Gateway that proxies Anthropic (ADR 0021)."
  value       = module.ai.gateway_id
}

output "k2_account_streams" {
  description = "K2 streams on the account at plan time, and the account limit (ADR 0017)."
  value = {
    other_streams = length(local.k2_other_streams)
    prod_streams  = length(local.k2_stream_names)
    limit         = local.k2_account_stream_limit
  }
}
