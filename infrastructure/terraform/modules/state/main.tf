locals {
  suffix = "-${var.environment}"

  # Lifecycle is prefix-based. Writers must put objects under one of these prefixes.
  retention_rules = {
    for prefix, days in var.evidence_retention_days : prefix => days if days != null
  }
}

# Large Evidence and the K2 event archive (AGENTS.md sections 19.1 and 34.4).
resource "cloudflare_r2_bucket" "evidence" {
  account_id    = var.account_id
  name          = "rhumbatron-evidence${local.suffix}"
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket_lifecycle" "evidence" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.evidence.name

  rules = concat(
    [{
      id         = "abort-stale-multipart"
      enabled    = true
      conditions = { prefix = "" }
      abort_multipart_uploads_transition = {
        condition = { type = "Age", max_age = 86400 }
      }
    }],
    [for prefix, days in local.retention_rules : {
      id         = "expire-${prefix}"
      enabled    = true
      conditions = { prefix = "${prefix}/" }
      delete_objects_transition = {
        condition = { type = "Age", max_age = days * 86400 }
      }
    }],
  )
}

# Product metadata (AGENTS.md section 14).
resource "cloudflare_d1_database" "control" {
  account_id = var.account_id
  name       = "rhumbatron-control${local.suffix}"

  # Declared explicitly so config matches the API default and the drift check stays clean.
  read_replication = {
    mode = "disabled"
  }
}

# Read-heavy configuration snapshots.
resource "cloudflare_workers_kv_namespace" "config" {
  account_id = var.account_id
  title      = "rhumbatron-config${local.suffix}"
}
