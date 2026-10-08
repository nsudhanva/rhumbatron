# The zone is registered with Cloudflare Registrar. Terraform reads it and never manages its
# lifecycle, so no plan can delete the domain.
data "cloudflare_zone" "this" {
  filter = {
    name    = var.zone_name
    account = { id = var.account_id }
  }
}
