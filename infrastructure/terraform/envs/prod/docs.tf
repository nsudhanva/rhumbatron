# Documentation site at docs.rhumbatron.com (apps/docs, Astro Starlight).
# Assets-only Worker: the version has no script, so every request is a static asset request, which
# is free and unlimited and does not count toward the Workers request quota. Unknown paths get the
# Starlight 404 page. The bundle comes from `bun run cf:bundle` (manifest key "docs").
# Kept in its own file and not in modules/worker, which requires a main module and has no assets
# config. Attributes mirror that module so the Worker matches the others.
locals {
  docs = {
    hostname = "docs.${var.zone_name}"
    bundle   = local.bundles.docs
  }
}

resource "cloudflare_worker" "docs" {
  account_id = var.account_id
  name       = "rhumbatron-docs-${local.environment}"
  tags = [
    "project:rhumbatron",
    "env:${local.environment}",
    "component:docs",
    "managed-by:terraform",
  ]

  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  observability = {
    enabled = true
    logs = {
      enabled            = true
      invocation_logs    = true
      head_sampling_rate = 1
    }
  }
}

resource "cloudflare_worker_version" "docs" {
  account_id         = var.account_id
  worker_id          = cloudflare_worker.docs.id
  compatibility_date = local.docs.bundle.compatibility_date

  assets = {
    directory = "${local.repo_root}/${local.docs.bundle.assets_directory}"
    config = {
      html_handling      = "auto-trailing-slash"
      not_found_handling = "404-page"
    }
  }

  annotations = {
    workers_tag     = substr(local.docs.bundle.bundle_sha256, 0, 25)
    workers_message = "terraform bundle ${local.docs.bundle.bundle_sha256}"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_workers_deployment" "docs" {
  account_id  = var.account_id
  script_name = cloudflare_worker.docs.name
  strategy    = "percentage"

  versions = [{
    version_id = cloudflare_worker_version.docs.id
    percentage = 100
  }]

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_workers_custom_domain" "docs" {
  account_id = var.account_id
  hostname   = local.docs.hostname
  zone_id    = module.dns.zone_id
  service    = cloudflare_worker.docs.name

  depends_on = [cloudflare_workers_deployment.docs]
}
