resource "cloudflare_worker" "this" {
  account_id = var.account_id
  name       = var.name
  tags       = var.tags

  subdomain = {
    enabled          = var.enable_workers_dev
    previews_enabled = false
  }

  observability = {
    enabled = true
    logs = {
      enabled            = true
      invocation_logs    = true
      head_sampling_rate = var.logs_head_sampling_rate
    }
  }
}

resource "cloudflare_worker_version" "this" {
  account_id          = var.account_id
  worker_id           = cloudflare_worker.this.id
  compatibility_date  = var.compatibility_date
  compatibility_flags = var.compatibility_flags
  main_module         = var.main_module
  bindings            = var.bindings
  migrations          = var.migrations

  modules = [for m in var.modules : {
    name         = m.name
    content_file = m.content_file
    content_type = m.content_type
  }]

  assets = var.assets_directory == null ? null : {
    directory = var.assets_directory
  }

  annotations = {
    workers_tag     = substr(var.bundle_sha256, 0, 25)
    workers_message = "terraform bundle ${var.bundle_sha256}"
  }
}

# Dev uses 100 percent. Add percentage splits only when canary rollout is required.
resource "cloudflare_workers_deployment" "this" {
  account_id  = var.account_id
  script_name = cloudflare_worker.this.name
  strategy    = "percentage"

  versions = [{
    version_id = cloudflare_worker_version.this.id
    percentage = 100
  }]
}

resource "cloudflare_workers_custom_domain" "this" {
  for_each = { for d in var.custom_domains : d.hostname => d }

  account_id = var.account_id
  hostname   = each.value.hostname
  zone_id    = each.value.zone_id
  service    = cloudflare_worker.this.name

  depends_on = [cloudflare_workers_deployment.this]
}
