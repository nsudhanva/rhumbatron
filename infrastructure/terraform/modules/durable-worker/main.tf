# Workers that host Durable Object classes deploy with a full script upload, because
# Cloudflare rejects Durable Object migrations in version uploads (ADR 0005).

locals {
  name  = "rhumbatron-${var.component}-${var.environment}"
  main  = one([for m in var.modules : m if m.name == var.main_module])
  extra = [for m in var.modules : m if m.name != var.main_module]
}

resource "cloudflare_workers_script" "this" {
  account_id          = var.account_id
  script_name         = local.name
  main_module         = var.main_module
  content_file        = local.main.content_file
  content_sha256      = filesha256(local.main.content_file)
  compatibility_date  = var.compatibility_date
  compatibility_flags = var.compatibility_flags
  bindings            = var.bindings
  migrations          = var.migrations

  files = length(local.extra) == 0 ? null : {
    for m in local.extra : m.name => {
      content_file = m.content_file
      content_type = m.content_type
    }
  }

  # Declared in full so config matches what the API stores (no perpetual diff).
  observability = {
    enabled            = true
    head_sampling_rate = 1
    traces = {
      enabled            = false
      head_sampling_rate = 1
      persist            = true
    }
    logs = {
      enabled            = true
      invocation_logs    = true
      head_sampling_rate = var.logs_head_sampling_rate
    }
  }
}

# Internal Worker: reachable only through bindings, never on workers.dev.
resource "cloudflare_workers_script_subdomain" "this" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.this.script_name
  enabled          = false
  previews_enabled = false
}
