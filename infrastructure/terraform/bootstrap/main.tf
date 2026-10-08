# Bootstrap creates only the Terraform state bucket. No application resources belong here.
resource "cloudflare_r2_bucket" "terraform_state" {
  account_id    = var.account_id
  name          = var.state_bucket_name
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}
